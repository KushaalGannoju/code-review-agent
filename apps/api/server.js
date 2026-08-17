import { createServer } from "node:http";
import { readFile, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { analyzeRepository } from "../../packages/analyzer/index.js";
import { enrichReviewWithGemini } from "../../packages/ai/geminiReview.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(__dirname, "../..");
loadLocalEnv(join(repoRoot, ".env"));
loadLocalEnv(join(repoRoot, ".env.local"));
const webRoot = join(repoRoot, "apps/web");
const port = Number(process.env.PORT || 5173);
const host = process.env.HOST || (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");
const allowedOrigins = String(
  process.env.ALLOWED_ORIGINS || "http://127.0.0.1:5173,http://localhost:5173"
)
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const limitsConfig = {
  reviews: Number(process.env.SESSION_REVIEW_LIMIT || 5),
  gemini: Number(process.env.SESSION_GEMINI_LIMIT || 3),
  tokens: Number(process.env.SESSION_TOKEN_LIMIT || 12000),
  promptTokens: Number(process.env.REVIEW_PROMPT_TOKEN_LIMIT || 4500)
};
const sessions = new Map();

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

const server = createServer(async (request, response) => {
  try {
    applyCors(request, response);
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      return response.end();
    }

    const url = new URL(request.url || "/", `http://${request.headers.host}`);

    if (request.method === "GET" && url.pathname === "/api/health") {
      return sendJson(response, 200, { ok: true });
    }

    if (request.method === "GET" && url.pathname === "/api/limits") {
      const state = getSessionState(request);
      return sendJson(response, 200, { limits: serializeLimits(state) });
    }

    if (request.method === "POST" && url.pathname === "/api/reviews") {
      return handleCreateReview(request, response);
    }

    return serveStatic(url.pathname, response);
  } catch (error) {
    console.error(error);
    return sendJson(response, 500, {
      error: "Unexpected server error.",
      detail: process.env.NODE_ENV === "production" ? undefined : error.message
    });
  }
});

server.listen(port, host, () => {
  console.log(`Code Review Agent running at http://${host}:${port}`);
});

async function handleCreateReview(request, response) {
  const body = await readJsonBody(request);
  const repoUrl = String(body.repoUrl || "").trim();
  const parsedRepo = parseGitHubUrl(repoUrl);
  const state = getSessionState(request);

  if (!parsedRepo) {
    return sendJson(response, 400, {
      error: "Enter a valid GitHub repository URL like https://github.com/owner/repo.",
      limits: serializeLimits(state)
    });
  }

  if (state.reviewsUsed >= limitsConfig.reviews) {
    return sendJson(response, 429, {
      error: "This demo session has used its review limit. Start a fresh browser session to keep testing.",
      limits: serializeLimits(state)
    });
  }

  const jobId = randomUUID();
  const workspace = join(tmpdir(), "code-review-agent", jobId);
  const startedAt = Date.now();

  try {
    await cloneRepository(parsedRepo.cloneUrl, workspace);
    const review = await analyzeRepository(workspace, {
      repository: {
        owner: parsedRepo.owner,
        name: parsedRepo.name,
        url: parsedRepo.htmlUrl
      },
      startedAt
    });

    state.reviewsUsed += 1;
    await maybeAddGeminiReview(review, body, state);
    review.durationMs = Date.now() - startedAt;
    return sendJson(response, 200, { review, limits: serializeLimits(state) });
  } catch (error) {
    return sendJson(response, 422, {
      error: error.message || "Could not review this repository.",
      limits: serializeLimits(state)
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function maybeAddGeminiReview(review, body, state) {
  const wantsGemini = body.useGemini !== false;
  const hasGeminiBudget =
    state.geminiUsed < limitsConfig.gemini && state.tokensUsed < limitsConfig.tokens;
  const enhanced = await enrichReviewWithGemini(review, {
    enabled: wantsGemini && hasGeminiBudget,
    apiKey: process.env.GEMINI_API_KEY,
    model: process.env.GEMINI_MODEL || "gemini-flash-latest",
    promptTokenLimit: Math.min(
      limitsConfig.promptTokens,
      Math.max(0, limitsConfig.tokens - state.tokensUsed)
    )
  });

  if (enhanced.ai.used) {
    state.geminiUsed += 1;
    state.tokensUsed += enhanced.ai.estimatedInputTokens;
  }

  if (wantsGemini && !hasGeminiBudget) {
    enhanced.ai.skippedReason = "This session has used its demo AI budget.";
  }

  return enhanced;
}

function getSessionState(request) {
  const sessionId = String(request.headers["x-review-session"] || "anonymous").slice(0, 80);
  const now = Date.now();
  const existing = sessions.get(sessionId);
  if (existing) {
    existing.lastSeen = now;
    return existing;
  }

  const state = {
    id: sessionId,
    reviewsUsed: 0,
    geminiUsed: 0,
    tokensUsed: 0,
    createdAt: now,
    lastSeen: now
  };
  sessions.set(sessionId, state);
  pruneSessions(now);
  return state;
}

function serializeLimits(state) {
  return {
    reviewsUsed: state.reviewsUsed,
    reviewsRemaining: Math.max(0, limitsConfig.reviews - state.reviewsUsed),
    reviewsLimit: limitsConfig.reviews,
    geminiUsed: state.geminiUsed,
    geminiRemaining: Math.max(0, limitsConfig.gemini - state.geminiUsed),
    geminiLimit: limitsConfig.gemini,
    tokensUsed: state.tokensUsed,
    tokensRemaining: Math.max(0, limitsConfig.tokens - state.tokensUsed),
    tokenLimit: limitsConfig.tokens
  };
}

function pruneSessions(now) {
  const maxAgeMs = 1000 * 60 * 60 * 8;
  for (const [sessionId, state] of sessions) {
    if (now - state.lastSeen > maxAgeMs) {
      sessions.delete(sessionId);
    }
  }
}

function applyCors(request, response) {
  const origin = request.headers.origin;
  const allowOrigin =
    !origin || allowedOrigins.includes("*") || allowedOrigins.includes(origin) ? origin || "*" : allowedOrigins[0];

  response.setHeader("Access-Control-Allow-Origin", allowOrigin);
  response.setHeader("Vary", "Origin");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Review-Session");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
}

function parseGitHubUrl(value) {
  try {
    const url = new URL(value);
    if (url.hostname !== "github.com") return null;
    const [owner, rawName] = url.pathname.split("/").filter(Boolean);
    if (!owner || !rawName) return null;

    const name = rawName.replace(/\.git$/, "");
    if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(name)) {
      return null;
    }

    return {
      owner,
      name,
      htmlUrl: `https://github.com/${owner}/${name}`,
      cloneUrl: `https://github.com/${owner}/${name}.git`
    };
  } catch {
    return null;
  }
}

async function cloneRepository(cloneUrl, destination) {
  await runCommand("git", ["clone", "--depth=1", cloneUrl, destination], {
    timeoutMs: 45000
  });
}

function runCommand(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Repository clone timed out. Try a smaller public repository."));
    }, options.timeoutMs || 30000);

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolvePromise();
      } else {
        reject(new Error(cleanGitError(stderr)));
      }
    });
  });
}

function cleanGitError(stderr) {
  if (/Authentication failed|Repository not found/i.test(stderr)) {
    return "Repository is private or does not exist. This version supports public repositories only.";
  }
  if (/Could not resolve host|Failed to connect/i.test(stderr)) {
    return "Could not reach GitHub from this machine.";
  }
  return "Git could not clone this repository.";
}

async function serveStatic(pathname, response) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = normalize(join(webRoot, safePath));

  if (!filePath.startsWith(webRoot)) {
    return sendText(response, 403, "Forbidden");
  }

  if (!existsSync(filePath)) {
    return sendText(response, 404, "Not found");
  }

  const extension = extname(filePath);
  const contentType = mimeTypes[extension] || "application/octet-stream";
  response.writeHead(200, { "Content-Type": contentType });
  const contents = await readFile(filePath);
  response.end(contents);
}

function readJsonBody(request) {
  return new Promise((resolvePromise, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Request body is too large."));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolvePromise(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Request body must be valid JSON."));
      }
    });
  });
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function sendText(response, statusCode, message) {
  response.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
  response.end(message);
}

function loadLocalEnv(envPath) {
  if (!existsSync(envPath)) return;
  const contents = readFileSync(envPath, "utf8");
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    const rawValue = trimmed.slice(separator + 1).trim();
    const value = rawValue.replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
