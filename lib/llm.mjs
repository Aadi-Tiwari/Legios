// Model client for the AI users. Three providers, chosen with LEGIOS_PROVIDER:
//   ollama    (default) local model on this machine, no key, works offline
//   groq      hosted open models, needs GROQ_API_KEY
//   anthropic Claude, needs ANTHROPIC_API_KEY (optional)
// Keys come only from the environment or the gitignored .env file in the project root, and are never logged.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
try {
  for (const line of readFileSync(join(here, "..", ".env"), "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch { /* no .env: Ollama only */ }

export const PROVIDER = (process.env.LEGIOS_PROVIDER || "ollama").toLowerCase();
const DEFAULTS = { ollama: "qwen3:14b", groq: "llama-3.3-70b-versatile", anthropic: "claude-opus-5-5" };
export const MODEL = process.env.LEGIOS_MODEL || DEFAULTS[PROVIDER] || DEFAULTS.ollama;
export const MODEL_LABEL = `${MODEL} (${PROVIDER === "ollama" ? "local" : PROVIDER})`;

const OLLAMA_URL = process.env.OLLAMA_URL || "http://127.0.0.1:11434";

// Pulls the first JSON object out of a reply, in case a hosted model wraps it in prose or a code fence.
function parseJSON(text) {
  const raw = String(text || "").trim();
  try { return JSON.parse(raw); } catch { /* fall through */ }
  const start = raw.indexOf("{"), end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));
  throw new Error("The model did not return JSON");
}

async function ollama(system, user, signal) {
  const res = await fetch(OLLAMA_URL + "/api/chat", {
    method: "POST", signal, headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL, stream: false, format: "json", think: false,
      options: { temperature: 0.4, num_ctx: 8192 },
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    }),
  });
  if (!res.ok) throw new Error(`Model request failed (${res.status})`);
  return parseJSON((await res.json()).message?.content);
}

async function groq(system, user, signal) {
  if (!process.env.GROQ_API_KEY) throw new Error("GROQ_API_KEY is not set");
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST", signal,
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    body: JSON.stringify({
      model: MODEL, temperature: 0.4, response_format: { type: "json_object" },
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    }),
  });
  if (!res.ok) throw new Error(`Groq request failed (${res.status})`);
  return parseJSON((await res.json()).choices?.[0]?.message?.content);
}

let anthropicClient = null;
async function anthropic(system, user, signal) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");
  if (!anthropicClient) {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    anthropicClient = new Anthropic();
  }
  const response = await anthropicClient.messages.create({
    model: MODEL,
    max_tokens: 16000,
    output_config: { effort: process.env.LEGIOS_EFFORT || "low" },
    system: `${system}\nReply with a single JSON object and nothing else.`,
    messages: [{ role: "user", content: user }],
  }, { signal });
  if (response.stop_reason === "refusal") throw new Error("The model declined this step");
  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  return parseJSON(text);
}

export async function chooseJSON(system, user, { timeoutMs = 60_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    if (PROVIDER === "groq") return await groq(system, user, controller.signal);
    if (PROVIDER === "anthropic") return await anthropic(system, user, controller.signal);
    return await ollama(system, user, controller.signal);
  } finally {
    clearTimeout(timer);
  }
}
