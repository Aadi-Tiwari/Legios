// Checks that the verifier cannot be fooled. Two hand-written bad "fixes" must be rejected,
// and one hand-written correct fix must pass. These are verifier controls, not repairs.
// node tests/verifier-integrity.mjs <runDir with recording.json and findings.json>
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyFinding } from "../lib/replay.mjs";
import { makeCandidate } from "../lib/repair.mjs";
import { loadTarget } from "../lib/config.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const runDir = resolve(process.argv[2]);
const rec = JSON.parse(await readFile(join(runDir, "recording.json"), "utf8"));
const records = rec.records;
const target = await loadTarget(rec.target || "notely");
const finding = JSON.parse(await readFile(join(runDir, "findings.json"), "utf8")).find((f) => f.kind === "data_leak");
if (!finding) throw new Error("This run has no data leak finding");

const LEAKY = 'if (!note) return send(res, 404, { error: "Note not found." });';
const controls = [
  { name: "UI-only patch (hides other people's notes in the page, server unchanged)", expect: "failing",
    edit: async (dir) => {
      const p = join(dir, "public", "index.html");
      const html = await readFile(p, "utf8");
      await writeFile(p, html.replace("const n = r.data;", "const n = r.data;\n  if (me && n.ownerId !== me.id) { app.innerHTML = '<p>Not found</p>'; return; }"));
    } },
  { name: "Deny-everyone patch (nobody can open any note, including the owner)", expect: "failing",
    edit: async (dir) => {
      const p = join(dir, "server.mjs");
      await writeFile(p, (await readFile(p, "utf8")).replace(LEAKY, 'if (true) return send(res, 404, { error: "Note not found." });'));
    } },
  { name: "Correct ownership check (control that should pass)", expect: "fixed",
    edit: async (dir) => {
      const p = join(dir, "server.mjs");
      await writeFile(p, (await readFile(p, "utf8")).replace(LEAKY, 'if (!note || note.ownerId !== user.id) return send(res, 404, { error: "Note not found." });'));
    } },
];

let failures = 0;
const controlsDir = join(runDir, `verifier-controls-${Date.now()}`);
await mkdir(controlsDir, { recursive: true });
for (const [i, c] of controls.entries()) {
  const dir = join(controlsDir, `control-${i}`);
  await makeCandidate(target.appDir, dir);
  await c.edit(dir);
  const result = await verifyFinding({ target, appDir: dir, port: 4110 + i, records, finding });
  const ok = result.status === c.expect;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.name}: verifier said "${result.status}", expected "${c.expect}"`);
  for (const chk of result.contract?.checks || []) if (!chk.pass) console.log(`        failed check: ${chk.name} (${chk.detail})`);
}
process.exitCode = failures ? 1 : 0;
