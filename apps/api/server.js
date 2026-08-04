import { createServer } from "node:http";
import { readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { analyzeRepository } from "../../packages/analyzer/index.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(__dirname, "../..");
const webRoot = join(repoRoot, "apps/web");
const port = Number(process.env.PORT || 5173);
const host = process.env.HOST || "127.0.0.1";

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host}`);

    if (request.method === "GET" && url.pathname === "/api/health") {
      return sendJson(response, 200, { ok: true });
    }

    if (request.method === "POST" && url.pathname === "/api/reviews") {
      return handleCreateReview(request, response);
    }

    if (request.method === "POST" && url.pathname === "/api/login") {
      return sendJson(response, 200, {
        user: { id: "demo-student", name: "Demo Student" }
      });
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

  if (!parsedRepo) {
    return sendJson(response, 400, {
      error: "Enter a valid GitHub repository URL like https://github.com/owner/repo."
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
    review.durationMs = Date.now() - startedAt;
    return sendJson(response, 200, { review });
  } catch (error) {
    return sendJson(response, 422, {
      error: error.message || "Could not review this repository."
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
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
    return "Repository is private or does not exist. Version 1 supports public repositories only.";
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
