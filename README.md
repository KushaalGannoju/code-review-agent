# Code Review Agent

AI-ready code review website for student GitHub projects. Version 1 is intentionally free to run: it uses deterministic static analysis for Python and JavaScript/TypeScript, then presents review findings, code quality scoring, test suggestions, and quiz questions in a dashboard.

## Version 1

What works now:

- Demo login state in the browser
- Paste a public GitHub repository URL
- Backend clones the repository with `git clone --depth=1`
- Python AST analysis for complexity, unsafe calls, broad exceptions, SQL injection patterns, and hardcoded secrets
- JavaScript/TypeScript heuristic analysis for complexity, risky browser/node patterns, SQL injection patterns, and hardcoded secrets
- Duplicate code detection across supported files
- Quality score, severity counts, file summaries, findings, test suggestions, and code understanding quiz questions

## Run Locally

```bash
npm run dev
```

Open `http://localhost:5173`.

Requirements:

- Node.js 20+
- Python 3.11+
- Git installed and available on `PATH`

## Roadmap

### V1: Static Review MVP

Goal: prove the core workflow without cost.

- Build a web app where the student can log in locally and paste a public GitHub repo URL.
- Clone the repo into a temporary workspace.
- Parse Python with `ast`.
- Analyze JavaScript/TypeScript with lightweight heuristics first.
- Detect complexity, hardcoded secrets, unsafe execution, unsafe HTML injection, SQL string interpolation, duplicate code, and missing test signals.
- Generate a quality score, file-level results, test suggestions, and educational quiz questions.
- Keep everything free and locally runnable.

What you should understand:

- How repository ingestion works.
- Why static analysis should run before LLM analysis.
- How AST-based analysis differs from regex scanning.
- How severity scoring turns raw findings into a useful dashboard.
- Why V1 should avoid paid APIs until the product loop is proven.

### V2: Real Auth, Persistence, and Better Analysis

Goal: turn the demo into a real product-shaped app.

- Replace demo login with GitHub OAuth.
- Let the user review public repos by URL and private repos through authorization.
- Store users, repos, review jobs, files, and findings in PostgreSQL.
- Move repo cloning and analysis into a background worker.
- Add job states: queued, cloning, analyzing, complete, failed.
- Add review history.
- Add per-language analyzers behind a common interface.
- Replace JS heuristics with `tree-sitter` or Babel parsing.
- Add coverage/test framework detection.
- Add a safer sandbox strategy for cloned repos.

What you should understand:

- OAuth flow and token storage.
- Background jobs vs request/response work.
- Database schema design for review results.
- Why analyzing untrusted repositories needs careful isolation.
- How parser adapters make multi-language support maintainable.

### V3: Free-Tier LLM Reasoning and PR Reviews

Goal: add the AI layer without making the app depend on expensive usage.

- Add a provider interface: `StaticOnlyProvider`, `GeminiProvider`, and later `OpenAIProvider`.
- Use Gemini free tier as the default student-friendly option.
- Send the LLM only selected snippets and structured static facts.
- Ask for strict JSON output with title, severity, category, line, explanation, and suggested fix.
- Generate PR summaries.
- Post comments to GitHub pull requests.
- Deduplicate repeated comments between review runs.
- Generate patch diffs for simple issues.
- Add rate limits and token budgeting.

What you should understand:

- Prompt design for structured review output.
- Context selection and token budgeting.
- Why the LLM should explain static findings instead of scanning the whole repo blindly.
- GitHub review APIs and inline PR comments.
- Cost controls, caching, and graceful fallback when the LLM quota is exhausted.

### V4: Feature-Loaded Resume Version

Goal: make it stand out as a serious developer tool.

- Add a code quality score trend over time.
- Add dependency graph visualization.
- Add duplicate code clusters with side-by-side snippets.
- Add time complexity classification for key functions.
- Add generated tests for `pytest`, `jest`, and `vitest`.
- Add “Explain your own code” quiz mode with answer evaluation.
- Add team/classroom mode for instructors.
- Add repository risk profile: security, maintainability, performance, testing.
- Add automatic patch PR creation.
- Add deployment with Docker, hosted frontend, hosted API, database, and worker.
- Add strong README, demo video, architecture diagram, and resume-ready metrics.

What you should understand:

- Product polish and demo storytelling.
- Evaluation: measuring whether AI comments are useful.
- Security review limitations and false positives.
- Scalable architecture for long-running code analysis.
- How to explain this project as static analysis plus LLM reasoning, not just a chatbot.

## Provider Choice

If the project must be completely free for you, start with Gemini as the optional LLM provider in V3 and keep V1/V2 useful without any LLM. OpenAI is excellent for code reasoning, but API usage is billed separately from ChatGPT subscriptions. Gemini currently has a documented free tier for the Developer API, with the tradeoff that free-tier data may be used to improve Google products.
