import test from "node:test";
import assert from "node:assert/strict";
import { buildStaticNarrative, enrichReviewWithGemini, estimateTokens } from "../packages/ai/geminiReview.js";

const review = {
  repository: { owner: "student", name: "demo", url: "https://github.com/student/demo" },
  summary: {
    score: 61,
    filesReviewed: 2,
    findingsCount: 2,
    severity: { critical: 0, high: 1, medium: 1, low: 0 },
    languages: { Python: 1, JavaScript: 1 },
    testsDetected: 0
  },
  files: [
    {
      path: "src/app.py",
      language: "Python",
      findings: [
        {
          title: "Possible SQL injection",
          severity: "high",
          category: "security",
          line: 8,
          message: "SQL appears dynamic.",
          recommendation: "Use parameterized queries."
        }
      ]
    }
  ],
  testSuggestions: []
};

test("builds a static narrative when Gemini is unavailable", async () => {
  const enriched = await enrichReviewWithGemini(structuredClone(review), { apiKey: "" });

  assert.equal(enriched.ai.used, false);
  assert.equal(enriched.narrative.provider, "static");
  assert.match(enriched.narrative.overview, /2 supported files/);
  assert.equal(enriched.narrative.priorities[0].severity, "high");
});

test("estimates prompt tokens and builds fallback priorities", () => {
  const narrative = buildStaticNarrative(structuredClone(review));

  assert.ok(estimateTokens("abcd") >= 1);
  assert.equal(narrative.priorities[0].title, "Possible SQL injection");
});
