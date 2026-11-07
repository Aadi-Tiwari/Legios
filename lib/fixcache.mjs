// Fallback for the repair step. Every fix that passed verification is saved as a patch. If the
// live drafting step fails (no internet, Codex unavailable, too slow), the saved patch for the same
// finding is applied instead and clearly labelled as a cached draft. Verification still runs live
// on the result, so a cached patch that no longer applies or no longer works is never shown as fixed.
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { ROOT } from "./config.mjs";
import { makeCandidate } from "./repair.mjs";

const DIR = join(ROOT, "fix-cache");
const keyOf = (target, finding) => createHash("sha256").update(`${target.id}|${finding.signature}`).digest("hex").slice(0, 16);

export async function saveVerifiedFix(target, finding, fix) {
  if (!fix?.diff) return;
  await mkdir(DIR, { recursive: true });
  await writeFile(join(DIR, `${target.id}-${keyOf(target, finding)}.json`), JSON.stringify({
    target: target.id, signature: finding.signature, title: finding.title, savedAt: new Date().toISOString(),
    summary: fix.summary, applied: fix.applied, diff: fix.diff, model: fix.model,
  }, null, 2));
}

export async function loadVerifiedFix(target, finding) {
  try { return JSON.parse(await readFile(join(DIR, `${target.id}-${keyOf(target, finding)}.json`), "utf8")); } catch { return null; }
}

function gitApply(cwd, patch) {
  return new Promise((resolve) => {
    const child = spawn("git", ["-c", "core.autocrlf=false", "apply", "--whitespace=nowarn", "-"], { cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => { err += d; });
    child.on("close", (code) => resolve({ ok: code === 0, err }));
    child.stdin.end(patch);
  });
}

// Builds the candidate from the base version and applies the cached patch to it.
export async function applyCachedFix({ target, baseDir, candidateDir, cached }) {
  await makeCandidate(baseDir, candidateDir);
  const result = await gitApply(candidateDir, cached.diff);
  if (!result.ok) {
    await rm(candidateDir, { recursive: true, force: true }).catch(() => {});
    throw new Error("The cached patch no longer applies to this version: " + result.err.split("\n")[0]);
  }
  return {
    status: "fix_proposed", cached: true, summary: `Cached draft from an earlier verified run (${cached.savedAt.slice(0, 16).replace("T", " ")}): ${cached.summary}`,
    applied: cached.applied, diff: cached.diff, model: `${cached.model || "Codex CLI"}, cached`, seconds: 0,
  };
}
