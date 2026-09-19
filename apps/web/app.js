const reviewForm = document.querySelector("#reviewForm");
const reviewButton = document.querySelector("#reviewButton");
const statusText = document.querySelector("#statusText");
const severityFilter = document.querySelector("#severityFilter");

const scoreValue = document.querySelector("#scoreValue");
const scoreMeta = document.querySelector("#scoreMeta");
const filesMetric = document.querySelector("#filesMetric");
const findingsMetric = document.querySelector("#findingsMetric");
const highMetric = document.querySelector("#highMetric");
const testsMetric = document.querySelector("#testsMetric");
const reviewsLeft = document.querySelector("#reviewsLeft");
const aiLeft = document.querySelector("#aiLeft");
const tokensLeft = document.querySelector("#tokensLeft");
const providerBadge = document.querySelector("#providerBadge");
const reviewOverview = document.querySelector("#reviewOverview");
const priorityList = document.querySelector("#priorityList");
const nextStepsList = document.querySelector("#nextStepsList");

const findingsList = document.querySelector("#findingsList");
const languageList = document.querySelector("#languageList");
const testsList = document.querySelector("#testsList");
const hotspotsList = document.querySelector("#hotspotsList");
const generatedTestsList = document.querySelector("#generatedTestsList");
const quizList = document.querySelector("#quizList");
const reportMarkdown = document.querySelector("#reportMarkdown");
const tabButtons = document.querySelectorAll(".tab-button");
const reviewSections = document.querySelectorAll(".review-section");

const apiBaseUrl = normalizeApiBaseUrl(
  new URLSearchParams(window.location.search).get("api") ||
    window.CODE_REVIEW_CONFIG?.apiBaseUrl ||
    localStorage.getItem("codeReviewApiBaseUrl") ||
    ""
);

const sessionId = getOrCreateSessionId();
let latestReview = null;

if (apiBaseUrl) {
  localStorage.setItem("codeReviewApiBaseUrl", apiBaseUrl);
}

loadLimits();

reviewForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(reviewForm);
  const repoUrl = String(formData.get("repoUrl") || "").trim();

  setLoading(true, "Cloning the repo and reading the code paths that matter...");
  try {
    const response = await fetch(`${apiBaseUrl}/api/reviews`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Review-Session": sessionId
      },
      body: JSON.stringify({ repoUrl, useGemini: true })
    });

    const payload = await readJsonResponse(response);
    updateLimits(payload.limits);
    if (!response.ok) {
      throw new Error(payload.error || "Review failed.");
    }

    latestReview = payload.review;
    renderReview(latestReview);
    statusText.textContent = reviewStatus(latestReview);
  } catch (error) {
    statusText.textContent = error.message;
  } finally {
    setLoading(false);
  }
});

severityFilter.addEventListener("change", () => {
  if (latestReview) {
    renderFindings(latestReview);
  }
});

tabButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const target = button.dataset.target;
    tabButtons.forEach((item) => item.classList.toggle("is-active", item === button));
    reviewSections.forEach((section) => section.classList.toggle("is-active", section.id === target));
  });
});

async function loadLimits() {
  try {
    const response = await fetch(`${apiBaseUrl}/api/limits`, {
      headers: { "X-Review-Session": sessionId }
    });
    const payload = await readJsonResponse(response);
    updateLimits(payload.limits);
  } catch {
    updateLimits();
  }
}

function setLoading(isLoading, message = "") {
  reviewButton.disabled = isLoading;
  reviewButton.querySelector("span:last-child").textContent = isLoading ? "Reviewing" : "Review";
  if (message) {
    statusText.textContent = message;
  }
}

function renderReview(review) {
  scoreValue.textContent = review.summary.score;
  scoreMeta.textContent = qualityLabel(review.summary.score);
  filesMetric.textContent = review.summary.filesReviewed;
  findingsMetric.textContent = review.summary.findingsCount;
  highMetric.textContent = review.summary.severity.critical + review.summary.severity.high;
  testsMetric.textContent = review.summary.testsDetected;
  providerBadge.textContent = review.narrative.providerLabel;
  reviewOverview.textContent = review.narrative.overview;

  renderPriorities(review.narrative.priorities);
  renderNextSteps(review.narrative.nextSteps);
  renderFindings(review);
  renderLanguages(review.summary.languages);
  renderTests(review.testSuggestions);
  renderHotspots(review.insights?.complexityHotspots || []);
  renderGeneratedTests(review.generatedTests || []);
  renderQuiz(review.quiz);
  reportMarkdown.textContent = review.reportMarkdown || "No markdown report generated.";
}

function renderNextSteps(steps = []) {
  nextStepsList.innerHTML = steps.length
    ? `<span class="next-label">Next steps</span><div class="next-step-list">${steps
        .slice(0, 4)
        .map((step) => `<strong>${escapeHtml(step)}</strong>`)
        .join("")}</div>`
    : "";
}

function renderPriorities(priorities = []) {
  priorityList.innerHTML = priorities
    .slice(0, 4)
    .map(
      (priority) => `
        <article class="priority-item">
          <span class="priority-dot ${priority.severity || "medium"}"></span>
          <div>
            <strong>${escapeHtml(priority.title)}</strong>
            <p>${escapeHtml(priority.detail)}</p>
          </div>
        </article>
      `
    )
    .join("");
}

function renderFindings(review) {
  const severity = severityFilter.value;
  const findings = review.files
    .flatMap((file) =>
      file.findings.map((finding) => ({
        ...finding,
        path: file.path,
        language: file.language
      }))
    )
    .filter((finding) => severity === "all" || finding.severity === severity);

  if (findings.length === 0) {
    findingsList.className = "findings-list empty-state";
    findingsList.textContent = "No findings match the current filter.";
    return;
  }

  findingsList.className = "findings-list";
  findingsList.innerHTML = findings
    .map(
      (finding) => `
        <article class="finding">
          <div class="finding-header">
            <div>
              <p class="finding-title">${escapeHtml(finding.title)}</p>
              <div class="finding-path">${escapeHtml(finding.path)}:${finding.line || 1}</div>
            </div>
            <span class="badge ${finding.severity}">${escapeHtml(finding.severity)}</span>
          </div>
          <div class="badge-row">
            <span class="badge">${escapeHtml(finding.category)}</span>
            <span class="badge">${escapeHtml(finding.language)}</span>
          </div>
          <p class="finding-copy">${escapeHtml(finding.message)}</p>
          <p class="finding-copy"><strong>Fix:</strong> ${escapeHtml(finding.recommendation)}</p>
        </article>
      `
    )
    .join("");
}

function renderLanguages(languages) {
  const entries = Object.entries(languages);
  if (entries.length === 0) {
    languageList.className = "compact-list empty-state";
    languageList.textContent = "No repository analyzed.";
    return;
  }

  languageList.className = "compact-list";
  languageList.innerHTML = entries
    .map(
      ([language, count]) => `
        <div class="compact-item">
          <strong>${escapeHtml(language)}</strong>
          <span>${count} supported file${count === 1 ? "" : "s"}</span>
        </div>
      `
    )
    .join("");
}

function renderTests(suggestions) {
  if (!suggestions.length) {
    testsList.className = "compact-list empty-state";
    testsList.textContent = "No missing-test signals found.";
    return;
  }

  testsList.className = "compact-list";
  testsList.innerHTML = suggestions
    .slice(0, 6)
    .map(
      (suggestion) => `
        <div class="compact-item">
          <strong>${escapeHtml(suggestion.title)}</strong>
          <p>${escapeHtml(suggestion.description)}</p>
        </div>
      `
    )
    .join("");
}

function renderHotspots(hotspots) {
  if (!hotspots.length) {
    hotspotsList.className = "compact-list empty-state";
    hotspotsList.textContent = "No complexity hotspots detected.";
    return;
  }
  hotspotsList.className = "compact-list";
  hotspotsList.innerHTML = hotspots
    .slice(0, 5)
    .map(
      (item) => `
        <div class="compact-item">
          <strong>${escapeHtml(item.name)} (${escapeHtml(item.label)})</strong>
          <p>${escapeHtml(item.file)}:${item.line} · complexity ${item.complexity}</p>
        </div>
      `
    )
    .join("");
}

function renderGeneratedTests(tests) {
  if (!tests.length) {
    generatedTestsList.className = "compact-list empty-state";
    generatedTestsList.textContent = "No generated test starters yet.";
    return;
  }
  generatedTestsList.className = "compact-list";
  generatedTestsList.innerHTML = tests
    .slice(0, 3)
    .map(
      (test) => `
        <div class="compact-item">
          <strong>${escapeHtml(test.title)}</strong>
          <p>${escapeHtml(test.framework)} · ${escapeHtml(test.file)}</p>
          <pre class="code-snippet">${escapeHtml(test.code)}</pre>
        </div>
      `
    )
    .join("");
}

function renderQuiz(questions) {
  if (!questions.length) {
    quizList.className = "compact-list empty-state";
    quizList.textContent = "No questions yet.";
    return;
  }

  quizList.className = "compact-list";
  quizList.innerHTML = questions
    .slice(0, 5)
    .map(
      (question) => `
        <div class="compact-item">
          <strong>${escapeHtml(question.question)}</strong>
          <span>${escapeHtml(question.answerHint)}</span>
        </div>
      `
    )
    .join("");
}

function updateLimits(limits = {}) {
  reviewsLeft.textContent = limits.reviewsRemaining ?? 5;
  aiLeft.textContent = limits.geminiRemaining ?? 3;
  tokensLeft.textContent = compactNumber(limits.tokensRemaining ?? 12000);
}

function qualityLabel(score) {
  if (score >= 85) return "Strong";
  if (score >= 70) return "Healthy";
  if (score >= 50) return "Needs work";
  return "High risk";
}

function getOrCreateSessionId() {
  const existing = localStorage.getItem("codeReviewSessionId");
  if (existing) return existing;
  const next = crypto.randomUUID();
  localStorage.setItem("codeReviewSessionId", next);
  return next;
}

function normalizeApiBaseUrl(value) {
  return String(value || "").replace(/\/$/, "");
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text.trim()) {
    throw new Error(
      response.ok
        ? "The server returned an empty response."
        : `The backend returned ${response.status} with no JSON body. Check Railway logs, CORS, and PUBLIC_API_BASE_URL.`
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `The backend did not return JSON (${response.status}). Check Railway deployment, CORS, and PUBLIC_API_BASE_URL.`
    );
  }
}

function reviewStatus(review) {
  const base = `Reviewed ${review.repository.name} in ${review.durationMs} ms.`;
  if (review.ai?.used) return `${base} Gemini wrote the reviewer notes.`;
  if (review.ai?.skippedReason) return `${base} Static mode: ${review.ai.skippedReason}`;
  return base;
}

function compactNumber(value) {
  const number = Number(value);
  if (number >= 1000) return `${Math.floor(number / 1000)}k`;
  return String(number);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
