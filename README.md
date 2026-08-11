# Code Review Agent

Code Review Agent is a web reviewer for student GitHub projects. Paste a public GitHub repository URL and the app clones it, analyzes supported Python and JavaScript/TypeScript files, scores the repository, and produces practical review notes.

Version 2 combines deterministic static analysis with an optional Gemini free-tier review layer. The app still works without a Gemini key, but when `GEMINI_API_KEY` is configured the reviewer notes become more natural and mentor-like.

Repository: `KushaalGannoju/code-review-agent`

## What V2 Does

- No login flow
- Public GitHub repo URL review
- Python AST analysis
- JavaScript/TypeScript heuristic analysis
- Security checks for secrets, unsafe dynamic execution, unsafe HTML injection, command injection, SQL injection, and unsafe deserialization
- Complexity scoring
- Duplicate code detection
- Test suggestions
- Code-understanding quiz questions
- Gemini-generated reviewer notes when `GEMINI_API_KEY` is available
- Static fallback when Gemini is not configured or the demo token budget is exhausted
- Visible demo limits for reviews, Gemini calls, and estimated input tokens
- Frontend-ready Netlify config
- Backend-ready Dockerfile for Railway or similar platforms

## Run Locally

```bash
npm run dev
```

Open `http://127.0.0.1:5173`.

Requirements:

- Node.js 20+
- Python 3.11+
- Git installed and available on `PATH`

## Gemini Setup

Create a `.env` file locally:

```bash
cp .env.example .env
```

Add your key:

```bash
GEMINI_API_KEY=your_key_here
GEMINI_MODEL=gemini-2.5-flash
```

Keep the key server-side only. Do not put it in `apps/web/config.js`, browser code, screenshots, README examples, or GitHub commits.

## Demo Limits

The limits are intentionally lightweight and in-memory for V2:

```bash
SESSION_REVIEW_LIMIT=5
SESSION_GEMINI_LIMIT=3
SESSION_TOKEN_LIMIT=12000
REVIEW_PROMPT_TOKEN_LIMIT=4500
```

These limits reset when the backend process restarts or when a user starts with a new browser session id. They are good enough for a resume/demo version, but not a production abuse-prevention system.

## Deployment

You can keep this as a monorepo. You do not need separate frontend and backend repositories.

### Backend on Railway

Deploy the repository root as a Railway service. Railway can use the included `Dockerfile`.

Set environment variables:

```bash
HOST=0.0.0.0
NODE_ENV=production
GEMINI_API_KEY=your_key_here
GEMINI_MODEL=gemini-2.5-flash
ALLOWED_ORIGINS=https://your-netlify-site.netlify.app
SESSION_REVIEW_LIMIT=5
SESSION_GEMINI_LIMIT=3
SESSION_TOKEN_LIMIT=12000
REVIEW_PROMPT_TOKEN_LIMIT=4500
```

After deployment, copy the Railway backend URL.

### Frontend on Netlify

Connect the same GitHub repo to Netlify.

Use:

```text
Build command: npm run build:web
Publish directory: apps/web
```

Set this Netlify environment variable:

```bash
PUBLIC_API_BASE_URL=https://your-railway-backend.up.railway.app
```

Netlify runs `scripts/build-web-config.js`, which writes `apps/web/config.js` with the backend URL.

## Roadmap

### V1: Static Review MVP

- Build a basic web app.
- Paste a public repo URL.
- Clone the repo locally.
- Analyze Python and JavaScript/TypeScript files.
- Show findings, score, test suggestions, and quiz questions.

### V2: Gemini Review and Polished Demo

- Remove login entirely.
- Improve the UI into a modern developer-tool dashboard.
- Add visible review/session/token limits.
- Add Gemini review notes through a backend-only API key.
- Keep a static fallback when Gemini is unavailable.
- Prepare deployment for Netlify frontend plus Railway backend.

### V3: Persistence and Better Language Intelligence

- Add PostgreSQL for review history.
- Move analysis jobs into a background worker.
- Add job status states.
- Replace JS/TS heuristics with a real parser such as tree-sitter or Babel.
- Add dependency graph extraction.
- Add review caching to reduce Gemini usage.

### V4: Resume-Grade Product

- Add PR comment generation.
- Add patch suggestions.
- Add generated tests for `pytest`, `jest`, and `vitest`.
- Add duplicate-code cluster views.
- Add score trends over time.
- Add deployment docs, architecture diagram, demo video, and ATS-focused resume bullets.

## Why This Project Stands Out

This is not just an LLM wrapper. Static analysis produces grounded findings first, then Gemini improves prioritization and wording. That makes the system cheaper, more explainable, and more reliable than sending an entire repository directly to a model.
