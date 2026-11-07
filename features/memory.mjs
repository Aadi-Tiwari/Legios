// Memory across visits, in the spirit of persistent simulated people: each test user keeps a short,
// durable memory of earlier visits to the same app, and a returning user acts on it.
// Stored per target and user under targets/<id>/memory/<user>.json. Plain data, no model calls.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const LIMIT = 12; // remembered facts per user

const fileFor = (target, userId) => join(target.dir, "memory", `${userId}.json`);

export async function loadMemory(target, userId) {
  try { return JSON.parse(await readFile(fileFor(target, userId), "utf8")); }
  catch { return { userId, visits: 0, facts: [], lastVisit: null }; }
}

// Turns one recorded visit into a few durable facts a person would remember next time.
export function factsFromVisit(record) {
  const facts = [];
  const steps = record.steps || [];
  const created = steps.filter((s) => s.action === "type" && !s.secretField && String(s.text || "").length >= 10);
  for (const s of created.slice(0, 3)) facts.push(`I wrote "${String(s.text).slice(0, 60)}" in "${s.target?.name}".`);
  for (const s of steps.filter((x) => x.toast).slice(0, 2)) facts.push(`The app told me "${String(s.toast).slice(0, 60)}".`);
  const failures = steps.filter((s) => (s.network || []).some((n) => n.status >= 500) || (s.pageErrors || []).length);
  if (failures.length) facts.push(`Something broke when I did step ${failures[0].n} (${failures[0].action} "${failures[0].target?.name || failures[0].target?.path || ""}").`);
  const credentialField = steps.find((s) => s.action === "type" && /e-?mail|name|user/i.test(s.target?.name || ""));
  if (credentialField) facts.push(`My account is ${credentialField.text}.`);
  return facts;
}

export async function rememberVisit(target, userId, record, reflection) {
  const memory = await loadMemory(target, userId);
  const fresh = factsFromVisit(record);
  if (reflection?.summary) fresh.push(`Last time: ${reflection.summary}`);
  memory.facts = [...fresh, ...memory.facts.filter((f) => !fresh.includes(f))].slice(0, LIMIT);
  memory.visits += 1;
  memory.lastVisit = new Date().toISOString();
  await mkdir(join(target.dir, "memory"), { recursive: true });
  await writeFile(fileFor(target, userId), JSON.stringify(memory, null, 2));
  return memory;
}

// Text to add to the user's prompt. Empty on a first visit. Every Legios run starts the app from a clean
// database, so the user is told their old data is gone; what carries over is what they learned.
export function memoryPrompt(memory) {
  if (!memory?.visits) return "";
  return `You have tested this app ${memory.visits} time(s) before. It has been reset since, so your old data is gone, but you remember:\n- ${memory.facts.join("\n- ")}\nUse that: early in this visit, try again the things that broke or confused you last time, then continue your goal.`;
}

export async function forgetAll(target, userIds) {
  for (const id of userIds) await writeFile(fileFor(target, id), JSON.stringify({ userId: id, visits: 0, facts: [], lastVisit: null }, null, 2)).catch(() => {});
}
