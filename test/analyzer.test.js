import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { analyzeRepository } from "../packages/analyzer/index.js";

test("analyzes Python and JavaScript security findings", async () => {
  const root = await mkdtemp(join(tmpdir(), "code-review-agent-test-"));
  try {
    await mkdir(join(root, "src"));
    await writeFile(
      join(root, "src", "app.py"),
      [
        "def lookup(cursor, user_id):",
        "    query = f\"SELECT * FROM users WHERE id = {user_id}\"",
        "    cursor.execute(query)",
        "    try:",
        "        return eval(user_id)",
        "    except:",
        "        pass"
      ].join("\n")
    );
    await writeFile(
      join(root, "src", "view.js"),
      [
        "function render(input) {",
        "  document.body.innerHTML = input;",
        "  const apiKey = 'abcdefghijklmnop';",
        "}"
      ].join("\n")
    );

    const review = await analyzeRepository(root, {
      repository: { owner: "test", name: "repo", url: "" }
    });

    const titles = review.files.flatMap((file) => file.findings.map((finding) => finding.title));
    assert.equal(review.summary.filesReviewed, 2);
    assert.ok(titles.includes("Unsafe dynamic code execution"));
    assert.ok(titles.includes("Possible SQL injection"));
    assert.ok(titles.includes("Bare exception handler"));
    assert.ok(titles.includes("Unsafe HTML injection sink"));
    assert.ok(titles.includes("Possible hardcoded secret"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
