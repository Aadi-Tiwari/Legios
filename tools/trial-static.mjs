import { cp, mkdir, writeFile } from "node:fs/promises";
import { join, resolve, basename } from "node:path";
import { ROOT } from "../lib/config.mjs";
import { runCrowd } from "../lib/crowd.mjs";

const [build, entry, description, goal] = process.argv.slice(2);
if (!build || !entry || !description || !goal) throw new Error('Usage: node tools/trial-static.mjs <build folder> <entry path> "<app description>" "<fictional user goal>"');
const source = resolve(build);
if (basename(source).toLowerCase() !== "dist") throw new Error("Point this tool at a compiled dist folder, not a source or data folder");
const runDir = join(ROOT, "runs", `unfamiliar-static-${Date.now()}`);
const appDir = join(runDir, "app");
await cp(source, appDir, { recursive: true, filter: (path) => !/\.env(?:\.|$)|[\\/]\.git(?:[\\/]|$)|\.map$/.test(path) });
const target = { id: "local-static-trial", name: "Existing local app trial", label: "Existing compiled app, isolated copy, no bugs planted for this trial", description,
  app: appDir, appDir, start: ["node", join(ROOT, "tools", "serve-static.mjs"), entry], env: { port: "PORT" }, editable: [], publicPaths: ["^/"], offline: true,
  users: [{ id: "trial", name: "Trial user", about: "Use only fictional text. Do not use microphone, uploads, or external links.", goal }] };
const dir = join(ROOT, "targets", target.id);
await mkdir(dir, { recursive: true });
await writeFile(join(dir, "target.json"), JSON.stringify(target, null, 2));
const result = await runCrowd({ target, port: 4145, runDir, headed: false, log: console.log });
await writeFile(join(runDir, "trial-summary.json"), JSON.stringify({ sourceBuild: source, sourceReadByExplorer: false, plantedBugs: false,
  limits: "Static public app trial only. It does not establish backend or authenticated-app coverage.",
  users: result.records.map((r) => ({ name: r.name, status: r.status, goalStatus: r.goalStatus, steps: r.steps.length, rejected: r.rejected || 0 })),
  findings: result.findings.map((f) => ({ title: f.title, status: f.status })) }, null, 2));
console.log(`Trial evidence: ${runDir}`);
