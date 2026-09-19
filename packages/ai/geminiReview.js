const defaultModel = "gemini-flash-latest";
const fallbackModels = ["gemini-flash-latest", "gemini-flash-lite-latest", "gemini-2.5-flash-lite"];

export async function enrichReviewWithGemini(review, options = {}) {
  const apiKey = normalizeApiKey(options.apiKey || "");
  const model = options.model || defaultModel;
  const promptLimit = Number(options.promptTokenLimit || 4500);
  const staticNarrative = buildStaticNarrative(review);

  review.narrative = staticNarrative;
  review.ai = {
    provider: "static",
    model: null,
    used: false,
    skippedReason: apiKey ? null : "GEMINI_API_KEY is not configured.",
    estimatedInputTokens: 0
  };

  if (!apiKey || options.enabled === false) {
    return review;
  }

  const prompt = buildPrompt(review);
  const estimatedInputTokens = estimateTokens(prompt);

  if (estimatedInputTokens > promptLimit) {
    review.ai.skippedReason = "Review was too large for the configured per-review token budget.";
    review.ai.estimatedInputTokens = estimatedInputTokens;
    return review;
  }

  try {
    const result = await callGeminiWithFallback({ apiKey, model, prompt });
    const payload = result.payload;
    const narrative = normalizeNarrative(payload, staticNarrative);
    review.narrative = {
      ...narrative,
      providerLabel: `Gemini review`,
      provider: "gemini"
    };
    review.ai = {
      provider: "gemini",
      model: result.model,
      used: true,
      skippedReason: null,
      estimatedInputTokens
    };
  } catch (error) {
    review.ai.skippedReason = error.message;
    review.ai.estimatedInputTokens = estimatedInputTokens;
  }

  return review;
}

export function buildStaticNarrative(review) {
  const { score, filesReviewed, findingsCount, severity, testsDetected } = review.summary;
  const riskCount = severity.critical + severity.high;
  const priorities = collectTopFindings(review).slice(0, 4).map((item) => ({
    title: item.title,
    severity: item.severity,
    detail: `${item.path}:${item.line || 1} should be handled before polishing lower-risk cleanup.`
  }));

  if (priorities.length === 0 && filesReviewed > 0) {
    priorities.push({
      title: "No major static-analysis issues",
      severity: "low",
      detail: "The supported files look clean from the current rule set. Manual review should still check behavior and requirements."
    });
  }

  return {
    provider: "static",
    providerLabel: "Static review",
    headline: score >= 80 ? "Solid first pass" : "Needs attention before submission",
    overview:
      filesReviewed === 0
        ? "I did not find supported Python or JavaScript files in this repository, so there is not enough code to score yet."
        : `I reviewed ${filesReviewed} supported file${filesReviewed === 1 ? "" : "s"} and found ${findingsCount} issue${findingsCount === 1 ? "" : "s"}. ${
            riskCount > 0
              ? `${riskCount} of them are high-priority security or correctness risks, so start there.`
              : "Nothing high-risk showed up in the current static checks."
          } ${testsDetected > 0 ? "There is at least some test code present." : "I did not see test files in the supported set."}`,
    priorities,
    nextSteps: [
      "Fix critical and high severity findings first.",
      "Add tests around the files called out in the suggestions.",
      "Run the project test suite after making changes."
    ]
  };
}

function buildPrompt(review) {
  const compactReview = {
    repository: review.repository,
    summary: review.summary,
    topFindings: collectTopFindings(review).slice(0, 16),
    files: review.files.slice(0, 28).map((file) => ({
      path: file.path,
      language: file.language,
      loc: file.loc,
      maxComplexity: file.maxComplexity,
      purpose: file.summary.purpose,
      functions: file.functions
        .slice()
        .sort((left, right) => right.complexity - left.complexity)
        .slice(0, 4),
      findings: file.findings.slice(0, 5).map((finding) => ({
        title: finding.title,
        severity: finding.severity,
        category: finding.category,
        line: finding.line,
        message: finding.message,
        recommendation: finding.recommendation
      }))
    })),
    testSuggestions: review.testSuggestions.slice(0, 8)
  };

  return [
    "You are reviewing a college programming project. Write like a practical senior student mentor, not like a generic AI assistant.",
    "Use only the static-analysis facts below. Do not invent files, line numbers, vulnerabilities, dependencies, or runtime behavior.",
    "Be direct, natural, and specific. The overview should be 5-7 useful sentences with enough detail for a student to understand what to fix first.",
    "Avoid phrases like 'as an AI', 'it is important to note', 'delve', 'leverage', or 'potentially'.",
    "Return strict JSON with this shape:",
    '{"headline":"short title","overview":"3-5 natural sentences","priorities":[{"title":"short","severity":"critical|high|medium|low","detail":"one practical sentence"}],"nextSteps":["short step","short step","short step"]}',
    JSON.stringify(compactReview)
  ].join("\n\n");
}

async function callGeminiWithFallback({ apiKey, model, prompt }) {
  const candidates = [...new Set([model, ...fallbackModels])];
  let lastError;

  for (const candidate of candidates) {
    try {
      return { model: candidate, payload: await callGemini({ apiKey, model: candidate, prompt }) };
    } catch (error) {
      lastError = error;
      if (!/404|429|503|not found|not available|high demand|quota/i.test(error.message)) {
        throw error;
      }
    }
  }

  throw lastError;
}

async function callGemini({ apiKey, model, prompt }) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey
    },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }]
        }
      ],
      generationConfig: {
        temperature: 0.45,
        maxOutputTokens: 1400,
        responseMimeType: "application/json"
      }
    })
  });

  if (!response.ok) {
    const text = await response.text();
    if (/API key not valid|API_KEY_INVALID|invalid api key/i.test(text)) {
      throw new Error(
        "Gemini review skipped: the backend GEMINI_API_KEY is invalid. Copy the full key from Google AI Studio and update Railway."
      );
    }
    throw new Error(`Gemini review skipped: ${response.status} ${text.slice(0, 120)}`);
  }

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") || "";
  return parseJsonText(text);
}

function parseJsonText(text) {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("Gemini returned an empty response.");
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("Gemini response was not valid JSON.");
    return JSON.parse(match[0]);
  }
}

function normalizeNarrative(payload, fallback) {
  return {
    headline: stringOr(payload.headline, fallback.headline).slice(0, 90),
    overview: stringOr(payload.overview, fallback.overview).slice(0, 1400),
    priorities: Array.isArray(payload.priorities)
      ? payload.priorities.slice(0, 4).map((priority) => ({
          title: stringOr(priority.title, "Review priority").slice(0, 90),
          severity: normalizeSeverity(priority.severity),
          detail: stringOr(priority.detail, "Check this before merging.").slice(0, 240)
        }))
      : fallback.priorities,
    nextSteps: Array.isArray(payload.nextSteps)
      ? payload.nextSteps.slice(0, 4).map((step) => stringOr(step, "Review the changed code.").slice(0, 160))
      : fallback.nextSteps
  };
}

function collectTopFindings(review) {
  const weight = { critical: 4, high: 3, medium: 2, low: 1 };
  return review.files
    .flatMap((file) =>
      file.findings.map((finding) => ({
        ...finding,
        path: file.path,
        language: file.language
      }))
    )
    .sort((left, right) => weight[right.severity] - weight[left.severity] || left.path.localeCompare(right.path));
}

function normalizeSeverity(value) {
  return ["critical", "high", "medium", "low"].includes(value) ? value : "medium";
}

function stringOr(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

export function estimateTokens(text) {
  return Math.ceil(String(text).length / 4);
}

function normalizeApiKey(value) {
  return String(value)
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/^GEMINI_API_KEY=/, "")
    .trim();
}
