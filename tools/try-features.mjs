// Exercises the features/ modules on a saved recording, without changing lib/.
// node tools/try-features.mjs <runDir>
import { readFile, mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { reflectOnVisit, summarizeFeedback } from "../features/reflection.mjs";
import { contentVariants, textFor } from "../features/crowd-variety.mjs";
import { factsFromVisit, rememberVisit, loadMemory, memoryPrompt } from "../features/memory.mjs";
import { traitsPrompt, spreadTraits } from "../features/traits.mjs";

const runDir = resolve(process.argv[2]);
const rec = JSON.parse(await readFile(join(runDir, "recording.json"), "utf8"));
const personas = Object.fromEntries((rec.personas || []).map((p) => [p.name, p]));

console.log("== Memory (no model)");
const scratch = { dir: await mkdtemp(join(tmpdir(), "legios-mem-")) };
for (const r of rec.records) {
  await rememberVisit(scratch, r.id, r, null);
  console.log(`${r.name}: ${factsFromVisit(r).join(" ")}`);
}
console.log("\nReturning-user prompt for", rec.records[0].name, ":\n" + memoryPrompt(await loadMemory(scratch, rec.records[0].id)));

console.log("\n== Traits");
spreadTraits(4).forEach((t, i) => console.log(`user ${i + 1}:`, JSON.stringify(t), "->", traitsPrompt({ traits: t }).slice(0, 110) + "..."));

console.log("\n== Feedback after each visit (local model)");
const reflections = [];
for (const r of rec.records) {
  const t = Date.now();
  const refl = await reflectOnVisit(personas[r.name] || { name: r.name, goal: r.goal }, r);
  reflections.push(refl);
  console.log(`${r.name} (${Math.round((Date.now() - t) / 1000)}s): ${refl?.summary}`);
  for (const p of refl?.points || []) console.log(`   [${p.kind}] step ${p.step}${p.grounded ? "" : " (UNGROUNDED)"}: ${p.text}`);
}
console.log("\nSummary:", JSON.stringify(summarizeFeedback(reflections), null, 1).slice(0, 900));

console.log("\n== AI-varied crowd content (local model)");
const journey = { ...rec.records[0], steps: rec.records[0].steps.filter((s) => !s.error) };
const t = Date.now();
const variants = await contentVariants(journey, 5);
console.log(`${journey.name}: variants for ${Object.keys(variants).length} field(s) in ${Math.round((Date.now() - t) / 1000)}s`);
for (const step of journey.steps.filter((s) => variants[s.n])) for (let k = 0; k < 5; k++) console.log(`  crowd user ${k + 1}, "${step.target?.name}": ${textFor(journey, variants, step, k)}`);
