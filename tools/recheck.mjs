import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadTarget } from "../lib/config.mjs";
import { recheckFindings } from "../lib/recheck.mjs";

if (!process.argv[2]) throw new Error("Usage: node tools/recheck.mjs <run folder> [candidate folder] [port]");
const runDir = resolve(process.argv[2]);
const recording = JSON.parse(await readFile(join(runDir, "recording.json"), "utf8"));
const target = await loadTarget(recording.target || "notely");
const findings = JSON.parse(await readFile(join(runDir, "findings.json"), "utf8"));
let state = null;
try { state = JSON.parse(await readFile(join(runDir, "state.json"), "utf8")); } catch { /* CLI recordings have no dashboard state. */ }
const appDir = process.argv[3] ? resolve(process.argv[3]) : state?.latestFixed || target.appDir;
const result = await recheckFindings({ target, records: recording.records, findings, appDir, port: Number(process.argv[4] || 4125),
  onResult: (row) => console.log(`${row.status.toUpperCase()}: ${row.title}`) });
await writeFile(join(runDir, "final-verification.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result.counts));
process.exitCode = result.counts.failing || result.counts.blocked ? 1 : 0;
