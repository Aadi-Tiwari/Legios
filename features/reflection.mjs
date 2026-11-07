// After a visit, each AI user says what confused or frustrated them, in their own words.
// This is UX feedback, kept separate from confirmed bugs: it is an opinion, not a reproduced failure.
// Every point must cite the step it is about, so feedback can be traced to what actually happened.
import { chooseJSON } from "../lib/llm.mjs";

export async function reflectOnVisit(persona, record) {
  // Only what the app did. Legios's own guardrails (rejected actions, stopping) are not app behavior.
  const visit = (record.memory || []).filter((l) => !/rejected \(|stopped after|could not decide/.test(l)).slice(-24).join("\n");
  if (!visit) return null;
  const answer = await chooseJSON(
    `You are ${persona.name}. ${persona.about || ""} You just finished using a web app with this goal: ${persona.goal}
Reply with JSON only: {"summary": "<one sentence about how the visit went>", "goalMet": true | false,
"points": [{"kind": "confusing" | "frustrating" | "missing" | "liked", "text": "<one sentence in your own words>", "step": <step number it is about>}],
"wouldReturn": true | false}
Give at most 4 points. Only mention things the app did in the visit below, and describe them as a person would see them on screen. Cite the step number for each point.`,
    `What you did and what happened:\n${visit}`);
  const steps = new Set((record.steps || []).map((s) => s.n));
  const points = (Array.isArray(answer.points) ? answer.points : [])
    .filter((p) => p && typeof p.text === "string" && ["confusing", "frustrating", "missing", "liked"].includes(p.kind))
    .map((p) => ({ kind: p.kind, text: p.text.slice(0, 240), step: Number(p.step), grounded: steps.has(Number(p.step)) }))
    .slice(0, 4);
  return {
    user: persona.name, summary: String(answer.summary || "").slice(0, 240), goalMet: Boolean(answer.goalMet),
    wouldReturn: Boolean(answer.wouldReturn), points,
    // Points that cite a step that did not happen are kept but marked, never presented as evidence.
    ungrounded: points.filter((p) => !p.grounded).length,
  };
}

// Groups feedback across users so repeated complaints stand out.
export function summarizeFeedback(reflections) {
  const all = reflections.filter(Boolean);
  return {
    users: all.length,
    goalMet: all.filter((r) => r.goalMet).length,
    wouldReturn: all.filter((r) => r.wouldReturn).length,
    byKind: ["confusing", "frustrating", "missing", "liked"].map((kind) => ({
      kind, points: all.flatMap((r) => r.points.filter((p) => p.kind === kind && p.grounded).map((p) => ({ user: r.user, text: p.text, step: p.step }))),
    })).filter((g) => g.points.length),
  };
}
