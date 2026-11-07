// Loads a target: the app under test, how to start it, what may be edited, and its test users.
import { readFile, readdir } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const TARGETS = join(ROOT, "targets");

export async function listTargets() {
  const out = [];
  for (const d of await readdir(TARGETS, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    try { out.push(await loadTarget(d.name)); } catch { /* not a target */ }
  }
  return out;
}

export async function loadTarget(id) {
  const dir = join(TARGETS, id);
  const t = JSON.parse(await readFile(join(dir, "target.json"), "utf8"));
  let generatedUsers = null;
  try { generatedUsers = JSON.parse(await readFile(join(dir, "users.generated.json"), "utf8")); } catch { /* none yet */ }
  return {
    publicPaths: [], editable: [], users: [], auth: null, env: { port: "PORT" },
    ...t, generatedUsers, dir, appDir: resolve(dir, t.app || "app"),
  };
}
