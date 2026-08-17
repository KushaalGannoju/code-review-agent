import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const pythonAnalyzerPath = join(__dirname, "python_ast_analyzer.py");

const supportedExtensions = new Map([
  [".py", "Python"],
  [".js", "JavaScript"],
  [".jsx", "JavaScript"],
  [".ts", "TypeScript"],
  [".tsx", "TypeScript"]
]);

const ignoredDirectories = new Set([
  ".git",
  ".github",
  ".next",
  ".turbo",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "__pycache__",
  ".pytest_cache",
  "venv",
  ".venv"
]);

const maxFiles = 120;
const maxFileBytes = 180_000;

export async function analyzeRepository(root, context = {}) {
  const repository = context.repository || { owner: "local", name: "repository", url: "" };
  const files = await collectSupportedFiles(root);
  const analyzedFiles = [];

  for (const file of files.slice(0, maxFiles)) {
    const source = await readFile(file.absolutePath, "utf8");
    if (file.language === "Python") {
      analyzedFiles.push(analyzePythonFile(file, source));
    } else {
      analyzedFiles.push(analyzeJavaScriptFile(file, source));
    }
  }

  const duplicateClusters = detectDuplicateCode(analyzedFiles);
  for (const duplicate of duplicateClusters) {
    const targetFile = analyzedFiles.find((file) => file.path === duplicate.path);
    if (targetFile) {
      targetFile.findings.push(duplicate.finding);
    }
  }

  const summary = buildSummary(analyzedFiles);
  const insights = buildInsights(analyzedFiles, duplicateClusters);
  return {
    id: cryptoRandomId(),
    repository,
    reviewedAt: new Date().toISOString(),
    summary,
    insights,
    files: analyzedFiles,
    testSuggestions: buildTestSuggestions(analyzedFiles),
    generatedTests: buildGeneratedTests(analyzedFiles),
    quiz: buildQuiz(analyzedFiles),
    reportMarkdown: buildMarkdownReport(repository, summary, insights, analyzedFiles)
  };
}

async function collectSupportedFiles(root) {
  const results = [];

  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) {
          await walk(join(directory, entry.name));
        }
        continue;
      }

      const extension = getSupportedExtension(entry.name);
      if (!extension) continue;

      const absolutePath = join(directory, entry.name);
      const fileStat = await stat(absolutePath);
      if (fileStat.size > maxFileBytes) continue;

      results.push({
        absolutePath,
        path: relative(root, absolutePath),
        language: supportedExtensions.get(extension)
      });
    }
  }

  await walk(root);
  return results.sort((left, right) => left.path.localeCompare(right.path));
}

function getSupportedExtension(filename) {
  return [...supportedExtensions.keys()].find((extension) => filename.endsWith(extension));
}

function analyzePythonFile(file, source) {
  const result = spawnSync("python3", [pythonAnalyzerPath, file.absolutePath], {
    encoding: "utf8",
    maxBuffer: 2_000_000,
    timeout: 5000
  });

  if (result.status !== 0) {
    return baseFileResult(file, source, [
      finding({
        title: "Python file could not be parsed",
        severity: "medium",
        category: "correctness",
        line: 1,
        message: "The Python AST parser failed on this file, so deeper Python analysis was skipped.",
        recommendation: "Run the file through Python formatting and syntax checks, then review again."
      })
    ]);
  }

  const parsed = JSON.parse(result.stdout);
  return {
    ...baseFileResult(file, source, parsed.findings),
    imports: parsed.imports,
    functions: parsed.functions,
    maxComplexity: parsed.maxComplexity,
    summary: summarizeFile(file, source, parsed.functions, parsed.findings)
  };
}

function analyzeJavaScriptFile(file, source) {
  const findings = [];
  const lines = source.split(/\r?\n/);
  const functions = extractJavaScriptFunctions(source);

  scanCommonSecrets(source, findings);
  scanJavaScriptSecurity(lines, findings);

  const maxComplexity = functions.reduce((max, item) => Math.max(max, item.complexity), 0);
  for (const fn of functions) {
    if (fn.complexity >= 12) {
      findings.push(
        finding({
          title: "High function complexity",
          severity: fn.complexity >= 18 ? "high" : "medium",
          category: "maintainability",
          line: fn.line,
          message: `${fn.name} has an estimated complexity of ${fn.complexity}.`,
          recommendation: "Split the function into smaller units and move branching rules into named helpers."
        })
      );
    }
  }

  return {
    ...baseFileResult(file, source, findings),
    functions,
    imports: extractJavaScriptImports(source),
    maxComplexity,
    summary: summarizeFile(file, source, functions, findings)
  };
}

function baseFileResult(file, source, findings = []) {
  return {
    path: file.path,
    language: file.language,
    loc: source.split(/\r?\n/).filter((line) => line.trim()).length,
    isTest: isTestFile(file.path),
    imports: [],
    functions: [],
    maxComplexity: 0,
    findings,
    summary: summarizeFile(file, source, [], findings)
  };
}

function extractJavaScriptFunctions(source) {
  const lines = source.split(/\r?\n/);
  const functions = [];
  const patterns = [
    /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?[A-Za-z_$][\w$]*\s*=>/,
    /^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/
  ];

  lines.forEach((line, index) => {
    const match = patterns.map((pattern) => line.match(pattern)).find(Boolean);
    if (match) {
      const block = lines.slice(index, Math.min(lines.length, index + 80)).join("\n");
      functions.push({
        name: match[1],
        line: index + 1,
        complexity: estimateComplexity(block)
      });
    }
  });

  return functions;
}

function estimateComplexity(source) {
  const keywords = source.match(/\b(if|for|while|case|catch|switch)\b|\?\s*|&&|\|\|/g) || [];
  return 1 + keywords.length;
}

function extractJavaScriptImports(source) {
  const imports = new Set();
  const importMatches = source.matchAll(/import\s+.*?\s+from\s+["']([^"']+)["']/g);
  const requireMatches = source.matchAll(/require\(["']([^"']+)["']\)/g);
  for (const match of importMatches) imports.add(match[1]);
  for (const match of requireMatches) imports.add(match[1]);
  return [...imports].sort();
}

function scanJavaScriptSecurity(lines, findings) {
  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    if (/\beval\s*\(/.test(line) || /new\s+Function\s*\(/.test(line)) {
      findings.push(
        finding({
          title: "Unsafe dynamic code execution",
          severity: "critical",
          category: "security",
          line: lineNumber,
          message: "Dynamic code execution can run attacker-controlled input.",
          recommendation: "Replace dynamic execution with explicit parsing, validation, or a safe command map."
        })
      );
    }

    if (/\.innerHTML\s*=|document\.write\s*\(/.test(line)) {
      findings.push(
        finding({
          title: "Unsafe HTML injection sink",
          severity: "high",
          category: "security",
          line: lineNumber,
          message: "Writing raw HTML can introduce cross-site scripting when data is not sanitized.",
          recommendation: "Use textContent or a vetted sanitizer before assigning HTML."
        })
      );
    }

    if (/\bexec\s*\([^)]*\$\{|\bexec\s*\([^)]*\+/.test(line)) {
      findings.push(
        finding({
          title: "Possible command injection",
          severity: "high",
          category: "security",
          line: lineNumber,
          message: "Shell commands built from dynamic values can execute unintended commands.",
          recommendation: "Use execFile or spawn with argument arrays and strict input validation."
        })
      );
    }

    if (/(SELECT|INSERT|UPDATE|DELETE).*(\+|\$\{)/i.test(line)) {
      findings.push(
        finding({
          title: "Possible SQL injection",
          severity: "high",
          category: "security",
          line: lineNumber,
          message: "SQL appears to be built through string interpolation or concatenation.",
          recommendation: "Use parameterized queries from your database driver."
        })
      );
    }
  });
}

function scanCommonSecrets(source, findings) {
  const secretPatterns = [
    {
      pattern: /(api[_-]?key|secret|password|token)\s*[:=]\s*["'][^"']{12,}["']/i,
      title: "Possible hardcoded secret"
    },
    {
      pattern: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/,
      title: "Private key committed to source"
    }
  ];

  const lines = source.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const secret of secretPatterns) {
      if (secret.pattern.test(line)) {
        findings.push(
          finding({
            title: secret.title,
            severity: "critical",
            category: "security",
            line: index + 1,
            message: "Sensitive credentials should not be stored in source code.",
            recommendation: "Move the value into environment variables and rotate the exposed credential."
          })
        );
      }
    }
  });
}

function detectDuplicateCode(files) {
  const seen = new Map();
  const duplicates = [];

  for (const file of files) {
    const normalizedLines = file.summary.normalizedLines || [];
    for (let index = 0; index <= normalizedLines.length - 6; index += 1) {
      const chunk = normalizedLines.slice(index, index + 6).join("\n");
      if (chunk.length < 120) continue;

      if (seen.has(chunk)) {
        const first = seen.get(chunk);
        duplicates.push({
          path: file.path,
          finding: finding({
            title: "Duplicate code block",
            severity: "medium",
            category: "maintainability",
            line: index + 1,
            message: `This block looks similar to code in ${first.path}:${first.line}.`,
            recommendation: "Extract the repeated logic into a shared helper or module."
          })
        });
      } else {
        seen.set(chunk, { path: file.path, line: index + 1 });
      }
    }
  }

  return duplicates.slice(0, 20);
}

function summarizeFile(file, source, functions, findings) {
  const normalizedLines = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("//") && !line.startsWith("#"));

  return {
    purpose: inferPurpose(file.path, functions),
    findingCount: findings.length,
    functionCount: functions.length,
    normalizedLines
  };
}

function inferPurpose(path, functions) {
  if (isTestFile(path)) return "Test coverage file";
  if (/route|controller|api/i.test(path)) return "Request handling or API logic";
  if (/model|schema/i.test(path)) return "Data model or schema logic";
  if (/util|helper|lib/i.test(path)) return "Shared utility logic";
  if (functions.length > 0) return `Contains ${functions.length} detected function${functions.length === 1 ? "" : "s"}`;
  return "Source file";
}

function buildSummary(files) {
  const severity = { critical: 0, high: 0, medium: 0, low: 0 };
  const languages = {};
  let findingsCount = 0;
  let testsDetected = 0;

  for (const file of files) {
    languages[file.language] = (languages[file.language] || 0) + 1;
    if (file.isTest) testsDetected += 1;
    for (const item of file.findings) {
      severity[item.severity] += 1;
      findingsCount += 1;
    }
  }

  const score = clamp(
    100 -
      severity.critical * 14 -
      severity.high * 9 -
      severity.medium * 4 -
      severity.low * 1 -
      Math.max(0, files.filter((file) => !file.isTest).length - testsDetected) * 1,
    0,
    100
  );

  return {
    score,
    filesReviewed: files.length,
    findingsCount,
    severity,
    languages,
    testsDetected
  };
}

function buildInsights(files, duplicateClusters) {
  const security = countFindings(files, "security");
  const maintainability = countFindings(files, "maintainability");
  const correctness = countFindings(files, "correctness");
  const testingGap = files.some((file) => file.isTest) ? 20 : 75;

  return {
    riskProfile: {
      security,
      maintainability,
      correctness,
      testing: testingGap
    },
    complexityHotspots: files
      .flatMap((file) =>
        file.functions.map((fn) => ({
          file: file.path,
          name: fn.name,
          line: fn.line,
          complexity: fn.complexity,
          label: complexityLabel(fn.complexity)
        }))
      )
      .sort((left, right) => right.complexity - left.complexity)
      .slice(0, 8),
    dependencyGraph: files
      .filter((file) => file.imports.length > 0)
      .slice(0, 18)
      .map((file) => ({
        file: file.path,
        imports: file.imports.slice(0, 10)
      })),
    duplicateClusters: duplicateClusters.slice(0, 8)
  };
}

function buildTestSuggestions(files) {
  const hasAnyTests = files.some((file) => file.isTest);
  const suggestions = [];

  for (const file of files.filter((item) => !item.isTest).slice(0, 10)) {
    const riskyFindings = file.findings.filter((item) =>
      ["critical", "high", "medium"].includes(item.severity)
    );
    if (riskyFindings.length > 0 || !hasAnyTests) {
      suggestions.push({
        title: `Add tests for ${file.path}`,
        description:
          riskyFindings.length > 0
            ? `Cover behavior around: ${riskyFindings
                .slice(0, 2)
                .map((item) => item.title.toLowerCase())
                .join(", ")}.`
            : "No test files were detected in the reviewed source set."
      });
    }
  }

  return suggestions;
}

function buildGeneratedTests(files) {
  return files
    .filter((file) => !file.isTest && file.functions.length > 0)
    .slice(0, 4)
    .map((file) => {
      const fn = file.functions[0];
      const isPython = file.language === "Python";
      return {
        file: file.path,
        framework: isPython ? "pytest" : "vitest",
        title: `Starter test for ${fn.name}`,
        code: isPython
          ? [
              `def test_${fn.name}_handles_edge_input():`,
              "    # Arrange: import the function and build a boundary input",
              "    # Act: call the function",
              "    # Assert: verify the expected result or error path",
              "    assert True"
            ].join("\n")
          : [
              `test('${fn.name} handles edge input', () => {`,
              "  // Arrange: import the function and build a boundary input",
              "  // Act: call the function",
              "  // Assert: verify the expected result or error path",
              "  expect(true).toBe(true);",
              "});"
            ].join("\n")
      };
    });
}

function buildQuiz(files) {
  const questions = [];
  const complexFile = files.find((file) => file.maxComplexity >= 8);
  const securityFile = files.find((file) =>
    file.findings.some((findingItem) => findingItem.category === "security")
  );
  const untestedFile = files.find((file) => !file.isTest && file.functions.length > 0);

  if (complexFile) {
    questions.push({
      question: `Why is ${complexFile.path} harder to maintain than a simple file?`,
      answerHint: "Look at branching, loops, and the highest complexity function."
    });
  }

  if (securityFile) {
    questions.push({
      question: `What input could make ${securityFile.path} unsafe?`,
      answerHint: "Trace whether user-controlled data reaches execution, HTML, SQL, or secrets."
    });
  }

  if (untestedFile) {
    questions.push({
      question: `Which edge case should be tested first in ${untestedFile.path}?`,
      answerHint: "Start with empty inputs, invalid inputs, and boundary values."
    });
  }

  return questions;
}

function buildMarkdownReport(repository, summary, insights, files) {
  const topFindings = files
    .flatMap((file) => file.findings.map((item) => ({ ...item, path: file.path })))
    .slice(0, 8);

  return [
    `# Code Review Summary for ${repository.owner}/${repository.name}`,
    "",
    `Score: ${summary.score}/100`,
    `Files reviewed: ${summary.filesReviewed}`,
    `Findings: ${summary.findingsCount}`,
    "",
    "## Top Findings",
    ...(topFindings.length
      ? topFindings.map((item) => `- ${item.severity.toUpperCase()}: ${item.title} in ${item.path}:${item.line || 1}`)
      : ["- No static-analysis findings in supported files."]),
    "",
    "## Complexity Hotspots",
    ...(insights.complexityHotspots.length
      ? insights.complexityHotspots.map(
          (item) => `- ${item.name} in ${item.file}:${item.line} has ${item.label} complexity (${item.complexity}).`
        )
      : ["- No function complexity hotspots detected."]),
    "",
    "## Next Steps",
    "- Fix critical and high severity findings first.",
    "- Add tests for risky files and boundary inputs.",
    "- Re-run the review after changes."
  ].join("\n");
}

function countFindings(files, category) {
  const raw = files.flatMap((file) => file.findings).filter((item) => item.category === category).length;
  return Math.min(100, raw * 18);
}

function complexityLabel(value) {
  if (value >= 18) return "very high";
  if (value >= 12) return "high";
  if (value >= 8) return "moderate";
  return "low";
}

function finding({ title, severity, category, line, message, recommendation }) {
  return {
    id: cryptoRandomId(),
    title,
    severity,
    category,
    line,
    message,
    recommendation
  };
}

function isTestFile(path) {
  return /(^|\/)(tests?|__tests__)(\/|$)|\.(test|spec)\.[jt]sx?$|test_.*\.py$|.*_test\.py$/.test(path);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function cryptoRandomId() {
  return Math.random().toString(36).slice(2, 10);
}
