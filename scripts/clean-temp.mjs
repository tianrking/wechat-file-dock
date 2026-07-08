import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const targets = [
  ".playwright-cli",
  "output",
  "dev.log",
  "dist",
  "dist-electron",
  "release"
];

for (const target of targets) {
  const absolute = path.join(root, target);
  try {
    fs.rmSync(absolute, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : "unknown";
    console.warn(`Skipped ${target}: ${String(code)}`);
  }
}
