// Starts a copy of the app under test from a clean, controlled state on its own port.
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function startTarget(target, appDir, port) {
  const dataDir = await mkdtemp(join(tmpdir(), "legios-data-"));
  const [cmd, ...args] = target.start;
  const env = { ...process.env, [target.env.port || "PORT"]: String(port) };
  if (target.env.dataFile) env[target.env.dataFile] = join(dataDir, "data.json");
  if (target.env.dataDir) env[target.env.dataDir] = dataDir;
  const child = spawn(cmd === "node" ? process.execPath : cmd, args, { cwd: appDir, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const log = [];
  child.stdout.on("data", (d) => log.push(String(d)));
  child.stderr.on("data", (d) => log.push(String(d)));
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15_000;
  let up = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try { await fetch(url + (target.healthPath || "/")); up = true; break; } catch { await new Promise((r) => setTimeout(r, 150)); }
  }
  if (!up) { child.kill(); throw new Error(`${target.name} did not start on port ${port}: ` + log.join("").slice(-400)); }
  return {
    url, log, pid: child.pid,
    async stop() {
      child.kill();
      await new Promise((r) => (child.exitCode !== null ? r() : child.once("exit", r)));
      await rm(dataDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}
