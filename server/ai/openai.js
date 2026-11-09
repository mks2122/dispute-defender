// OpenAI provider (integration layer): the only module that talks to OpenAI.
// Chat Completions with a strict JSON schema; images as data URLs. Analysis is read-only, so one retry on
// timeout / 429 / 5xx is safe.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { analysisSchema } from "./schema.js";
import { SYSTEM_PROMPT, buildUserPrompt } from "./prompt.js";

const TIMEOUT_MS = 30_000;
const STORE_DIR = fileURLToPath(new URL("../../web/public/store/", import.meta.url));
const MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };

export class AiError extends Error {
  constructor(code, message, { status = null } = {}) { super(message); this.name = "AiError"; this.code = code; this.status = status; }
}

/** Reads a /store/... image the seller or buyer supplied; returns null if it isn't on disk. */
async function imageDataUrl(publicPath) {
  const name = publicPath.replace(/^\/store\//, "");
  if (!/^[\w.-]+$/.test(name)) return null; // no path traversal: plain file names only
  const ext = name.split(".").pop().toLowerCase();
  if (!MIME[ext]) return null;
  try { return `data:${MIME[ext]};base64,${(await readFile(STORE_DIR + name)).toString("base64")}`; }
  catch { return null; } // missing file: analyse without it
}

async function callOnce(body) {
  const res = await fetch(`${config.openaiBase}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.openaiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = data?.error?.code ?? data?.error?.type ?? "http_error";
    throw new AiError(code === "model_not_found" ? "model_unavailable" : "api_error", `OpenAI ${res.status} ${code}`, { status: res.status });
  }
  return data;
}

/**
 * @param {object} input see buildUserPrompt; input.imagePaths = [{path, label, trusted}]
 * @returns {Promise<{analysis: object, model: string, usage: object|null}>}
 */
export async function openaiAnalyze(input) {
  const images = [];
  for (const im of input.imagePaths ?? []) {
    const url = await imageDataUrl(im.path);
    if (url) images.push({ ...im, url });
  }
  const body = {
    model: config.aiModel,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: [
        { type: "text", text: buildUserPrompt({ ...input, images }) },
        ...images.map((im) => ({ type: "image_url", image_url: { url: im.url, detail: "low" } })),
      ] },
    ],
    response_format: { type: "json_schema", json_schema: { name: "dispute_analysis", strict: true, schema: analysisSchema } },
    max_completion_tokens: 4000,
  };

  let data;
  try { data = await callOnce(body); }
  catch (e) {
    const retryable = e.name === "TimeoutError" || e.name === "AbortError" || e.status === 429 || (e.status >= 500) || e instanceof TypeError;
    if (!retryable) throw e;
    data = await callOnce(body);
  }
  const msg = data?.choices?.[0]?.message;
  if (msg?.refusal) throw new AiError("refusal", "The model declined to analyse this dispute.");
  let analysis;
  try { analysis = JSON.parse(msg?.content ?? ""); }
  catch { throw new AiError("bad_json", "The model returned malformed JSON."); }
  return { analysis, model: data.model ?? config.aiModel, usage: data.usage ? { input: data.usage.prompt_tokens, output: data.usage.completion_tokens } : null };
}
