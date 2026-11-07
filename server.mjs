// Legios dashboard server. Loopback only. Every run's state is saved to disk, so closing
// and reopening the dashboard shows the same run.
import { createServer } from "node:http";
import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { join, dirname, resolve, relative, isAbsolute, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { runCrowd } from "./lib/crowd.mjs";
import { verifyFinding } from "./lib/replay.mjs";
import { draftFix } from "./lib/repair.mjs";
import { MODEL_LABEL as MODEL } from "./lib/llm.mjs";
import { runScale } from "./lib/scale.mjs";
import { loadTarget, listTargets } from "./lib/config.mjs";
import { draftPersonas } from "./lib/personas.mjs";
import { forgetAll, loadMemory } from "./features/memory.mjs";
import { recheckFindings } from "./lib/recheck.mjs";
import { findingReport } from "./lib/report.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4000);
const RUNS = process.env.LEGIOS_RUNS || join(here, "runs");
await mkdir(RUNS, { recursive: true });

let target = await loadTarget(process.env.LEGIOS_TARGET || "notely");
let state = null;
let busy = false;
let records = null;
const appInfo = (t) => ({ id: t.id, name: t.name, description: t.description, label: t.label });

const runDir = () => join(RUNS, state.runId);
const persist = () => state && writeFile(join(runDir(), "state.json"), JSON.stringify(state, null, 2)).catch(() => {});
const log = (msg) => { state.log.push({ at: new Date().toISOString(), msg }); persist(); };

async function loadLatest() {
  const dirs = (await readdir(RUNS, { withFileTypes: true })).filter((d) => d.isDirectory() && d.name.startsWith("run-")).map((d) => d.name).sort();
  for (const name of dirs.reverse()) {
    try {
      state = JSON.parse(await readFile(join(RUNS, name, "state.json"), "utf8"));
      if (["exploring", "checking"].includes(state.phase)) { state.phase = "interrupted"; }
      for (const fix of Object.values(state.fixes || {})) if (["drafting", "verifying", "replaying"].includes(fix.status)) fix.status = "interrupted";
      try { records = JSON.parse(await readFile(join(RUNS, name, "recording.json"), "utf8")).records; } catch { records = null; }
      if (state.app?.id) target = await loadTarget(state.app.id).catch(() => target);
      return;
    } catch { /* try older */ }
  }
}
await loadLatest();

async function startRun({ headed = true, only, generated = false } = {}) {
  const pool = generated ? target.generatedUsers : target.users;
  const personas = only ? pool.filter((u) => only.includes(u.id)) : pool;
  state = { runId: "run-" + new Date().toISOString().replace(/[:.]/g, "-"), phase: "exploring", startedAt: new Date().toISOString(),
    app: appInfo(target), model: MODEL, users: {}, findings: [], fixes: {}, log: [] };
  for (const p of personas) state.users[p.id] = { id: p.id, name: p.name, goal: p.goal, status: "waiting", current: "Waiting to start", viewport: p.viewport || null, steps: 0, errors: 0, memory: [] };
  await mkdir(runDir(), { recursive: true });
  log(`Started ${personas.length} AI users (${MODEL}, local) on a fresh copy of ${target.name}`);
  const started = Date.now();
  try {
    const result = await runCrowd({ target, port: 4101, personas, runDir: runDir(), headed,
      onUpdate: (e) => { state.users[e.user.id] = e.user; }, log: (m) => { if (m.startsWith("All users")) state.phase = "checking"; log(m); } });
    records = result.records;
    state.findings = result.findings;
    state.feedback = result.feedback || null;
    state.phase = "done";
    state.seconds = Math.round((Date.now() - started) / 1000);
    log(`Run finished in ${state.seconds}s with ${result.findings.length} findings (${result.findings.filter((f) => f.status === "confirmed").length} confirmed)`);
  } catch (error) {
    state.phase = "failed";
    log("Run failed: " + error.message);
  }
}

async function fixFinding(index, { headed = false } = {}) {
  const finding = state.findings[index];
  if (!finding || !records) throw new Error("Unknown finding");
  const target = await loadTarget(state.app.id || "notely");
  // Fixes stack: each repair starts from the latest verified version of the app.
  const baseDir = state.latestFixed || target.appDir;
  const fix = state.fixes[finding.signature] = { status: "replaying", startedAt: new Date().toISOString(), base: state.latestFixed ? "latest verified version" : "original app" };
  try {
    log(`Replaying "${finding.title}" on the ${fix.base} from a clean start, no model calls`);
    fix.before = await verifyFinding({ target, appDir: baseDir, port: 4102, records, finding, headed });
    if (fix.before.status === "fixed") {
      // An earlier verified fix already corrected this. The replay above is the verification.
      fix.status = "already_fixed";
      fix.after = fix.before;
      fix.summary = "An earlier verified fix already corrected this. Replaying the journey on the latest version passed every check.";
      log(`"${finding.title}" was already corrected by an earlier fix; the replay passed every check`);
      await recheckRun();
      return;
    }
    if (fix.before.status === "blocked") log("The replay could not reach the failing step on this version; continuing with the recorded evidence");
    else log(`${fix.base === "original app" ? "Original app" : "Latest version"}: the failure reproduced`);
    fix.status = "drafting";
    persist();
    log("Codex is drafting a fix from the evidence");
    const candidateDir = join(runDir(), "candidate-" + index);
    Object.assign(fix, await draftFix({ target, appDir: baseDir, finding, candidateDir }));
    log(`Fix proposed in ${fix.seconds}s: ${fix.applied.map((a) => a.path).join(", ") || "no change"}`);
    if (fix.status === "no_change") return;
    fix.status = "verifying";
    persist();
    log("Running the patched copy on its own port and replaying the same journey");
    fix.after = await verifyFinding({ target, appDir: candidateDir, port: 4103, records, finding, headed });
    fix.status = fix.after.status;
    if (fix.status === "fixed") {
      const previous = state.latestFixed;
      state.recheck = { status: "running", appDir: candidateDir, results: [] };
      log("Rechecking every original finding against the combined repairs");
      const sweep = await recheckFindings({ target, appDir: candidateDir, records, findings: state.findings,
        onResult: (row) => { state.recheck.results.push(row); persist(); } });
      const formerlyFixed = new Set(Object.entries(state.fixes).filter(([signature, item]) => signature !== finding.signature && ["fixed", "already_fixed"].includes(item.status)).map(([signature]) => signature));
      formerlyFixed.add(finding.signature);
      const regressed = sweep.results.filter((r) => formerlyFixed.has(r.signature) && r.status !== "fixed");
      if (regressed.length) {
        fix.status = "failing";
        fix.error = "Candidate did not preserve every earlier verified fix";
        state.rejectedRecheck = sweep;
        state.recheck = previous ? await recheckFindings({ target, appDir: previous, records, findings: state.findings }) : null;
      } else {
        state.latestFixed = candidateDir;
        state.fixedCount = (state.fixedCount || 0) + 1;
        state.recheck = sweep;
      }
    }
    log(fix.status === "fixed" ? `Verified: "${finding.title}" no longer happens and the normal flow still works` : `Not verified: ${fix.status}`);
  } catch (error) {
    fix.status = "error";
    fix.error = error.message;
    log("Repair failed: " + error.message);
  } finally {
    fix.finishedAt = new Date().toISOString();
    persist();
  }
}

async function crowdRun(users, which) {
  const target = await loadTarget(state.app.id || "notely");
  let appDir = target.appDir;
  if (which === "fixed") {
    if (!state.latestFixed) { log("No verified fix yet, so the crowd runs against the original app"); which = "original"; }
    else { appDir = state.latestFixed; which = `fixed (${state.fixedCount} verified fix${state.fixedCount === 1 ? "" : "es"})`; }
  }
  state.crowd = { status: "running", which, requested: users };
  log(`Crowd: replaying the recorded journeys as ${users} simultaneous browser users on the ${which} app, no model calls`);
  try {
    state.crowd = { which, ...(await runScale({ target, appDir, port: 4104, records, users, onProgress: (p) => { state.crowd = { which, ...p }; } })) };
    log(`Crowd finished: ${state.crowd.completed}/${users} journeys completed, peak ${state.crowd.peakSimultaneous} simultaneous, ${state.crowd.serverErrors} server errors, p95 ${state.crowd.p95ms} ms`);
  } catch (error) {
    state.crowd = { which, status: "error", error: error.message };
    log("Crowd failed: " + error.message);
  }
}

async function recheckRun() {
  const runTarget = await loadTarget(state.app.id || "notely");
  const appDir = state.latestFixed || runTarget.appDir;
  state.recheck = { status: "running", appDir, results: [] };
  try {
    state.recheck = await recheckFindings({ target: runTarget, appDir, records, findings: state.findings,
      onResult: (row) => { state.recheck.results.push(row); persist(); } });
    log(`Final checks: ${state.recheck.counts.fixed} fixed, ${state.recheck.counts.failing} still failing, ${state.recheck.counts.blocked} blocked`);
  } catch (error) { state.recheck.status = "error"; state.recheck.error = error.message; }
}

const exclusive = (job) => {
  if (busy) return false;
  busy = true;
  job().finally(() => { busy = false; persist(); });
  return true;
};

const TYPES = { ".html": "text/html; charset=utf-8", ".jpg": "image/jpeg", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const json = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  try {
    if (req.method === "GET" && url.pathname === "/api/state") return json(200, { busy, state, target: appInfo(target) });
    if (req.method === "GET" && url.pathname === "/api/targets") return json(200, (await listTargets()).map(appInfo));
    if (req.method === "GET" && url.pathname === "/api/users") return json(200, { target: target.id, users: target.users, generated: target.generatedUsers || null });
    if (req.method === "POST" && url.pathname === "/api/users/generate") {
      if (busy) return json(409, { error: "Busy" });
      busy = true;
      try {
        const drafted = await draftPersonas({ name: target.name, description: target.description });
        target.generatedUsers = drafted;
        await writeFile(join(target.dir, "users.generated.json"), JSON.stringify(drafted, null, 2));
        return json(200, { users: drafted });
      } finally { busy = false; }
    }
    if (req.method === "POST" && url.pathname === "/api/memory/forget") {
      if (busy) return json(409, { error: "Busy" });
      await forgetAll(target, [...target.users, ...(target.generatedUsers || [])].map((u) => u.id));
      return json(200, { ok: true, forgotten: target.users.length });
    }
    if (req.method === "GET" && url.pathname === "/api/memory") {
      const all = await Promise.all(target.users.map((u) => loadMemory(target, u.id)));
      return json(200, all);
    }
    if (req.method === "POST" && url.pathname === "/api/target") {
      if (busy) return json(409, { error: "Busy" });
      target = await loadTarget(String(url.searchParams.get("id") || "").replace(/[^\w-]/g, ""));
      return json(200, appInfo(target));
    }
    if (req.method === "POST" && url.pathname === "/api/run") {
      const headed = url.searchParams.get("headed") !== "0";
      const only = url.searchParams.get("only")?.split(",");
      const generated = url.searchParams.get("users") === "generated";
      if (generated && !target.generatedUsers) return json(400, { error: "Generate users first" });
      return exclusive(() => startRun({ headed, only, generated })) ? json(202, { ok: true }) : json(409, { error: "Busy" });
    }
    if (req.method === "POST" && url.pathname === "/api/crowd") {
      if (!records) return json(400, { error: "Run the explorers first" });
      const users = Math.min(300, Math.max(1, Number(url.searchParams.get("users") || 150)));
      const which = url.searchParams.get("target") === "fixed" ? "fixed" : "original";
      return exclusive(() => crowdRun(users, which)) ? json(202, { ok: true }) : json(409, { error: "Busy" });
    }
    if (req.method === "POST" && url.pathname === "/api/recheck") {
      if (!records || !state?.findings.length) return json(400, { error: "Run explorers and collect findings first" });
      return exclusive(recheckRun) ? json(202, { ok: true }) : json(409, { error: "Busy" });
    }
    const exported = /^\/api\/findings\/(\d+)\/export$/.exec(url.pathname);
    if (req.method === "GET" && exported) {
      const finding = state?.findings[Number(exported[1])];
      if (!finding) return json(404, { error: "Unknown finding" });
      const report = await findingReport({ state, finding, records: records || [], runDir: runDir() });
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename="legios-finding-${Number(exported[1])}.json"` });
      return res.end(JSON.stringify(report, null, 2));
    }
    const m = /^\/api\/findings\/(\d+)\/fix$/.exec(url.pathname);
    if (req.method === "POST" && m) {
      if (!state?.findings[Number(m[1])] || !records) return json(404, { error: "Unknown finding" });
      return exclusive(() => fixFinding(Number(m[1]), { headed: url.searchParams.get("headed") === "1" })) ? json(202, { ok: true }) : json(409, { error: "Busy" });
    }
    if (req.method === "GET" && url.pathname.startsWith("/runs/")) {
      const file = resolve(RUNS, decodeURIComponent(url.pathname.slice("/runs/".length)));
      const rel = relative(resolve(RUNS), file);
      if (!rel || rel.startsWith("..") || isAbsolute(rel)) return json(403, { error: "Forbidden" });
      const body = await readFile(file);
      res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" });
      return res.end(body);
    }
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      res.writeHead(200, { "content-type": TYPES[".html"] });
      return res.end(await readFile(join(here, "public", "index.html")));
    }
    json(404, { error: "Not found" });
  } catch (error) {
    json(500, { error: error.message });
  }
}).listen(PORT, "127.0.0.1", () => console.log(`Legios dashboard: http://127.0.0.1:${PORT}`));
