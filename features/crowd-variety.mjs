// Makes the crowd varied: one model call per recorded journey writes different content for each
// crowd user (different note text, amounts, searches), so 150 users are not 150 identical copies.
// Variants keep the same kind of value (a comma amount stays a comma amount), so the journey still
// exercises the same path. Credentials are never varied here; crowd mode gives each user its own account.
import { chooseJSON } from "../lib/llm.mjs";

const CREDENTIAL = /pass|e-?mail|user ?name|^name$|login|account/i;

// Returns { [stepN]: [variant 1, variant 2, ...] } for the content fields of one journey.
export async function contentVariants(journey, count) {
  const fields = journey.steps.filter((s) => s.action === "type" && !s.secretField && !CREDENTIAL.test(s.target?.name || "") && String(s.text || "").trim());
  if (!fields.length) return {};
  const answer = await chooseJSON(
    `You write realistic test data. For each field, write ${count} different values a different real person might type.
Keep the same kind and format as the example (a date stays a date, "12,50" stays a comma decimal, a search for an exact phrase stays a search for a phrase that person saved).
Reply with JSON only: {"fields": [{"step": <step number>, "values": ["...", ...]}]}`,
    fields.map((s) => `step ${s.n}, field "${s.target?.name}", example: ${JSON.stringify(s.text)}`).join("\n"),
    { timeoutMs: 120_000 });
  const out = {};
  for (const f of Array.isArray(answer.fields) ? answer.fields : []) {
    const values = (Array.isArray(f.values) ? f.values : []).map((v) => String(v).slice(0, 400)).filter(Boolean);
    if (fields.some((s) => s.n === Number(f.step)) && values.length) out[Number(f.step)] = values;
  }
  return out;
}

// Picks the text crowd user k types at a step: a variant if one exists, otherwise the original.
// Searches must still find what that same user saved, so a search step reuses the variant of the
// field it was copied from when the original search text came from that field.
export function textFor(journey, variants, step, k) {
  const pool = variants[step.n];
  if (!pool?.length) return step.text;
  const source = journey.steps.find((s) => s.n < step.n && s.action === "type" && String(s.text || "").includes(String(step.text || "")) && s !== step);
  if (source && variants[source.n]?.length && /search|query|find/i.test(step.target?.name || "")) {
    const v = variants[source.n][k % variants[source.n].length];
    return v.split(/\s+/).slice(0, 3).join(" ");
  }
  return pool[k % pool.length];
}
