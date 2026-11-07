// Drafts test users from a plain description of the app, with the local model.
// The roles are fixed so every run covers privacy, unusual input, small screens and returning use;
// the model fills in who they are and what they try. Credentials are generated, never invented by the model.
import { chooseJSON } from "./llm.mjs";

const ROLES = [
  { key: "owner", brief: "stores something private and personal in the app (use specific, realistic details), then reopens and edits it" },
  { key: "second", brief: "a different person with their own account who uses the main feature normally and looks around the app" },
  { key: "unusual", brief: "uses a phone and enters realistic but unusual input (punctuation, symbols, a comma as decimal separator, very long text) into the main feature", phone: true },
  { key: "returning", brief: "creates something, signs out, signs back in, and checks that it is still there and can be changed" },
];

export async function draftPersonas({ name, description }) {
  const out = [];
  const used = new Set();
  for (const role of ROLES) {
    const draft = await chooseJSON(
      "You write realistic test users for a web app. Reply with JSON only: {\"name\": \"<first name>\", \"about\": \"<one sentence: who they are>\", \"goal\": \"<2-3 sentences: concrete steps they take in this app, including the exact text they type>\"}",
      `App: ${name}\nWhat it does and its rules: ${description}\nThis user ${role.brief}.\nDo not reuse these names: ${[...used].join(", ") || "none"}.`);
    const first = String(draft.name || `User${out.length + 1}`).replace(/[^A-Za-z]/g, "").slice(0, 12) || `User${out.length + 1}`;
    used.add(first);
    const id = first.toLowerCase();
    out.push({
      id, name: first, role: role.key, generated: true,
      about: `${String(draft.about || "").slice(0, 300)} If the app asks for an email, use ${id}@example.com; if it asks for a name or username, use ${id}. Your password is ${id}-pass-1.`,
      goal: `Create an account. ${String(draft.goal || "").slice(0, 500)}`,
      ...(role.phone ? { viewport: { width: 390, height: 844 } } : {}),
    });
  }
  return out;
}
