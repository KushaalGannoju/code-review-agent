import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const apiBaseUrl = process.env.PUBLIC_API_BASE_URL || process.env.API_BASE_URL || "";
const configPath = resolve("apps/web/config.js");

await writeFile(
  configPath,
  `window.CODE_REVIEW_CONFIG = {\n  apiBaseUrl: ${JSON.stringify(apiBaseUrl)}\n};\n`
);

console.log(`Wrote apps/web/config.js with apiBaseUrl=${apiBaseUrl || "(same origin)"}`);
