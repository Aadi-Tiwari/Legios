// Full loop for one recorded finding: replay on the original, draft a fix, verify the candidate.
// node loop.mjs <runDir> [kind=data_leak]
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { verifyFinding } from "./lib/replay.mjs";
import { draftFix } from "./lib/repair.mjs";
import { loadTarget } from "./lib/config.mjs";

const runDir = resolve(process.argv[2]);
const kind = process.argv[3] || "data_leak";
const rec = JSON.parse(await readFile(join(runDir, "recording.json"), "utf8"));
const target = await loadTarget(rec.target || "notely");
const findings = JSON.parse(await readFile(join(runDir, "findings.json"), "utf8"));
const finding = findings.find((f) => f.kind === kind);
if (!finding) throw new Error("No finding of kind " + kind);
const show = (label, v) => console.log(`\n== ${label}: ${v.status}\n` + (v.contract?.checks || []).map((c) => `  [${c.pass ? "PASS" : "FAIL"}] ${c.name} (${c.detail})`).join("\n") + (v.blocked.length ? `\n  blocked: ${JSON.stringify(v.blocked)}` : ""));

const before = await verifyFinding({ target, appDir: target.appDir, port: 4102, records: rec.records, finding });
show("Replay on the original app (no model calls)", before);
const candidateDir = join(runDir, "candidate-" + finding.kind);
console.log("\nDrafting a fix with Codex...");
const fix = await draftFix({ target, appDir: target.appDir, finding, candidateDir });
console.log(`${fix.status} in ${fix.seconds}s: ${fix.summary}\n${fix.diff}`);
const after = await verifyFinding({ target, appDir: candidateDir, port: 4103, records: rec.records, finding });
show("Replay on the patched candidate", after);
await writeFile(join(runDir, `loop-${finding.kind}.json`), JSON.stringify({ finding, before, fix, after }, null, 2));
