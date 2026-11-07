// Traits that change how a test user behaves, so a crowd of testers is not a crowd of identical robots.
// Each trait becomes concrete instructions for the model plus limits the runner can enforce.

export const TRAITS = {
  patience: {
    low: { prompt: "You are impatient. If something does not work the first time, you try once more and then give up on that part.", maxRetries: 1 },
    high: { prompt: "You are patient and methodical. You read messages carefully and retry things in different ways.", maxRetries: 3 },
  },
  techComfort: {
    low: { prompt: "You are not comfortable with technology. You read labels literally, sometimes press buttons before filling everything in, and do not know developer tricks.", explores: false },
    high: { prompt: "You are very comfortable with technology. You notice how addresses and numbers in the page change, and you poke at edge cases.", explores: true },
  },
  input: {
    careful: { prompt: "You type exactly what you mean, with normal punctuation." },
    messy: { prompt: "You type the way people really do: extra spaces, symbols, emoji, long text, local number formats like 12,50." },
  },
};

const pick = (obj, key) => obj[key] ? key : Object.keys(obj)[0];

// persona.traits like { patience: "low", techComfort: "high", input: "messy" }
export function traitsPrompt(persona) {
  const t = persona.traits || {};
  return Object.entries(TRAITS).filter(([name]) => t[name]).map(([name, levels]) => levels[pick(levels, t[name])].prompt).join(" ");
}

export function traitLimits(persona) {
  const t = persona.traits || {};
  return { maxRetries: TRAITS.patience[t.patience]?.maxRetries ?? 2 };
}

// A spread of traits for N users, so a generated group covers different kinds of people.
export function spreadTraits(n) {
  const combos = [
    { patience: "high", techComfort: "low", input: "careful" },
    { patience: "low", techComfort: "high", input: "careful" },
    { patience: "high", techComfort: "high", input: "messy" },
    { patience: "low", techComfort: "low", input: "messy" },
  ];
  return Array.from({ length: n }, (_, i) => combos[i % combos.length]);
}
