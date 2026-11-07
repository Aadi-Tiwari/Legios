import assert from "node:assert/strict";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadTarget, ROOT } from "../lib/config.mjs";
import { verifyFinding } from "../lib/replay.mjs";
import { recheckFindings } from "../lib/recheck.mjs";
import { findingReport } from "../lib/report.mjs";

if (!process.argv[2]) throw new Error("Usage: node tests/outcomes-and-recheck.mjs <Notely recording folder containing all three findings>");
const source = process.argv[2];
const { records } = JSON.parse(await readFile(join(source, "recording.json"), "utf8"));
const findings = JSON.parse(await readFile(join(source, "findings.json"), "utf8"));
const target = await loadTarget("notely");
const healthy = await loadTarget("notely-healthy");
const dir = join(ROOT, "runs", `outcome-controls-${Date.now()}`);
await mkdir(dir, { recursive: true });
const controls = [
  { id: "discarded-edit", finding: "false_success", expect: "failing", edit: (s) => s.replace('if (title !== undefined) note.title = String(title);', '').replace('if (body !== undefined) note.body = String(body);', '') },
  { id: "empty-search", finding: "crash", expect: "failing", edit: (s) => s.replace('db.notes.filter((n) => n.ownerId === user.id && (pattern.test(n.title) || pattern.test(n.body))).map(publicNote)', '[]') },
  { id: "denied-search", finding: "crash", expect: "failing", edit: (s) => s.replace('if (method === "GET" && pathname === "/api/search") {', 'if (method === "GET" && pathname === "/api/search") { return send(res, 403, { error: "Disabled" });') },
];
const results = [];
for (const control of controls) {
  const appDir = join(dir, control.id);
  await cp(healthy.appDir, appDir, { recursive: true, filter: (src) => !src.endsWith("data.json") });
  const path = join(appDir, "server.mjs"), original = await readFile(path, "utf8"), edited = control.edit(original);
  assert.notEqual(edited, original, `Control ${control.id} must change the app`);
  await writeFile(path, edited);
  const result = await verifyFinding({ target, appDir, port: 4135, records, finding: findings.find((f) => f.kind === control.finding) });
  results.push({ control: control.id, ...result });
  assert.equal(result.status, control.expect, JSON.stringify(result.contract));
  console.log(`PASS ${control.id}: ${result.status}`);
}
const sweep = await recheckFindings({ target, appDir: healthy.appDir, records, findings, port: 4135 });
assert.equal(sweep.counts.fixed, findings.length, JSON.stringify(sweep.results.map((r) => ({ title: r.title, status: r.status, checks: r.contract?.checks }))));
assert.equal(sweep.counts.blocked, 0);
assert.equal(sweep.counts.failing, 0);
console.log(`PASS combined healthy app: ${sweep.counts.fixed} findings rechecked`);
const report = await findingReport({ state: { runId: "test", app: { id: target.id }, fixes: {}, recheck: sweep }, finding: findings[0], records, runDir: source });
assert.equal(report.format, "legios-finding-v1");
assert.equal(report.finalVerification.status, "fixed");
for (const rec of records) for (const step of rec.steps.filter((s) => s.secretField)) assert.ok(!JSON.stringify(report).includes(step.text), "Report must omit synthetic passwords");
console.log("PASS developer report includes final verification and excludes passwords");
await writeFile(join(dir, "results.json"), JSON.stringify({ results, sweep }, null, 2));
console.log(`Evidence: ${dir}`);
