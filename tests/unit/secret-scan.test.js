// Fails if any real secret value from .env, or anything shaped like an API key, appears in a file that
// git would commit, or in the client bundle. Enforces ENGINEERING-PRACTICES §5.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const SECRET_KEYS = /(SECRET|KEY|PASSCODE|TOKEN|CLIENT_ID)$/;
const KEY_PATTERNS = [/sk-(proj-)?[A-Za-z0-9_-]{20,}/, /access_token\$[a-z]+\$[A-Za-z0-9]+/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/];
const TEXT = /\.(js|mjs|jsx|json|md|yaml|yml|html|css|txt|example|gitignore)$|^LICENSE$/;

function secretValues() {
  const envPath = join(root, ".env");
  if (!existsSync(envPath)) return [];
  return readFileSync(envPath, "utf8").split(/\r?\n/)
    .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/))
    .filter((m) => m && SECRET_KEYS.test(m[1]) && m[2].length >= 8)
    .map((m) => ({ key: m[1], value: m[2].replace(/^["']|["']$/g, "") }));
}

/** Files git would commit: tracked + untracked-but-not-ignored. */
function committableFiles() {
  const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" });
  return out.split("\n").filter((f) => f && TEXT.test(f.split("/").pop()) && existsSync(join(root, f)));
}

function* distFiles(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* distFiles(p); else yield p;
  }
}

test(".env is git-ignored", () => {
  const ignored = execFileSync("git", ["check-ignore", ".env"], { cwd: root, encoding: "utf8" }).trim();
  assert.equal(ignored, ".env");
});

test("no secret value or API-key-shaped string in any committable file", () => {
  const secrets = secretValues();
  const hits = [];
  for (const f of committableFiles()) {
    const text = readFileSync(join(root, f), "utf8");
    for (const { key, value } of secrets) if (text.includes(value)) hits.push(`${f} contains the value of ${key}`);
    for (const re of KEY_PATTERNS) if (re.test(text)) hits.push(`${f} matches ${re}`);
  }
  assert.deepEqual(hits, []);
});

test("the client bundle contains no secret values or server-only env names", { skip: !existsSync(join(root, "web/dist")) && "web/dist not built" }, () => {
  const secrets = secretValues();
  const hits = [];
  for (const file of distFiles(join(root, "web/dist"))) {
    const text = readFileSync(file, "latin1");
    for (const { key, value } of secrets) if (text.includes(value)) hits.push(`${file} contains ${key}`);
    if (/PAYPAL_CLIENT|OPENAI_API_KEY|SESSION_SECRET|DEMO_PASSCODE/.test(text)) hits.push(`${file} names a server-only variable`);
  }
  assert.deepEqual(hits, []);
});
