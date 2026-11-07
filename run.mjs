// Command-line run: node run.mjs [--target=notely] [--only=maria,kevin] [--headless]
import { join } from "node:path";
import { runCrowd } from "./lib/crowd.mjs";
import { loadTarget, ROOT } from "./lib/config.mjs";

const arg = (k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
const target = await loadTarget(arg("target") || "notely");
const only = arg("only")?.split(",");
const personas = only ? target.users.filter((u) => only.includes(u.id)) : target.users;
const runDir = join(ROOT, "runs", `cli-${target.id}-` + new Date().toISOString().replace(/[:.]/g, "-"));
const started = Date.now();
const { records, findings } = await runCrowd({
  target, port: 4101, personas, runDir, headed: !process.argv.includes("--headless"),
  onUpdate: () => {}, log: console.log,
});
console.log(`\nFinished in ${Math.round((Date.now() - started) / 1000)} s. Run folder: ${runDir}`);
for (const r of records) console.log(`${r.name}: ${r.status}, ${r.steps.length} steps, ${r.rejected || 0} rejected\n  ${r.memory.slice(-24).join("\n  ")}`);
console.log(`\nFindings (${findings.length}):`);
for (const f of findings) console.log(`- [${f.status}] ${f.kind}: ${f.title}\n    ${f.observed}\n    found by: ${f.evidence.discovery}`);
