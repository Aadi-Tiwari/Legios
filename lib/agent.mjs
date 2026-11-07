// One AI user: an isolated browser session with a goal and a memory of what it has done.
// Every action is recorded with the evidence a developer needs to inspect and rerun it.
import { chooseJSON } from "./llm.mjs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { checkOutcomes } from "./outcomes.mjs";
import { loadMemory, memoryPrompt, rememberVisit } from "../features/memory.mjs";
import { traitsPrompt } from "../features/traits.mjs";
import { reflectOnVisit } from "../features/reflection.mjs";

const API_BODY_LIMIT = 4000;

// Watches a browser context and records API traffic, page errors and console errors.
export function attachRecorder(context, page, sink) {
  page.on("pageerror", (err) => sink.pageErrors.push({ at: Date.now(), message: String(err.message || err).slice(0, 300) }));
  page.on("console", (msg) => { if (msg.type() === "error") sink.consoleErrors.push({ at: Date.now(), message: msg.text().slice(0, 300) }); });
  page.on("response", async (response) => {
    const url = new URL(response.url());
    const request = response.request();
    // Every call the page makes to its own server (fetch or XHR), wherever the app puts its API.
    if (!["fetch", "xhr"].includes(request.resourceType()) && !url.pathname.startsWith("/api/")) return;
    if (sink.baseUrl && url.origin !== new URL(sink.baseUrl).origin) return;
    let body = "";
    try { body = (await response.text()).slice(0, API_BODY_LIMIT); } catch { /* body unavailable */ }
    sink.network.push({
      at: Date.now(), method: request.method(), path: url.pathname + url.search, status: response.status(),
      requestBody: (request.postData() || "").slice(0, API_BODY_LIMIT), body,
    });
  });
}

// Lists what a person could interact with, and tags each element so the model can refer to it by number.
async function observe(page) {
  return page.evaluate(() => {
    const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
    // Elements hidden since the last look must not keep their old numbers.
    document.querySelectorAll("[data-legios]").forEach((el) => el.removeAttribute("data-legios"));
    const nameOf = (el) => {
      if (el.id) { const label = document.querySelector(`label[for="${el.id}"]`); if (label) return label.innerText.trim(); }
      // Fields wrapped inside their <label>, a common pattern in generated apps.
      const wrapped = el.labels?.[0] || el.closest("label");
      if (wrapped && !["BUTTON", "A"].includes(el.tagName)) {
        const text = [...wrapped.childNodes].filter((n) => n !== el && !(n.contains && n.contains(el))).map((n) => n.textContent).join(" ").replace(/\s+/g, " ").trim();
        if (text) return text.slice(0, 60);
      }
      return (el.getAttribute("aria-label") || el.innerText || el.getAttribute("placeholder") || el.value || "").trim().slice(0, 60);
    };
    const els = [...document.querySelectorAll("a, button, input, textarea, select")].filter((el) => visible(el) && !el.disabled && !["file", "hidden"].includes(el.type));
    const elements = els.map((el, i) => {
      el.setAttribute("data-legios", String(i + 1));
      const tag = el.tagName.toLowerCase();
      const kind = tag === "a" ? "link" : tag === "button" || ["submit", "button", "checkbox", "radio"].includes(el.type) ? "button" : tag === "select" ? "dropdown" : "field";
      const options = tag === "select" ? [...el.options].map((o) => o.label).slice(0, 12) : undefined;
      const selector = el.id ? `#${CSS.escape(el.id)}` : null;
      return { n: i + 1, kind, name: nameOf(el), selector, secret: el.type === "password" || undefined, topBar: Boolean(el.closest("nav, header")) || undefined, options,
        value: kind === "field" && el.type !== "password" ? (el.value || "").slice(0, 60) : undefined, href: tag === "a" ? el.getAttribute("href") : undefined };
    });
    // Notifications: live regions, alerts and status messages, wherever the app puts them.
    const notices = [...document.querySelectorAll('[role="status"], [role="alert"], [aria-live], .toast, .notification, .alert')]
      .filter(visible).map((el) => el.innerText.trim()).filter(Boolean);
    const body = document.body.innerText;
    return {
      url: location.pathname + location.hash,
      text: body.replace(/\n{2,}/g, "\n").slice(0, 1500),
      lines: [...new Set(body.split("\n").map((l) => l.trim()).filter((l) => l && l.length <= 80))],
      toast: notices.join(" | "),
      elements,
    };
  });
}

function describeElements(elements) {
  return elements.map((e) => `[${e.n}] ${e.kind} "${e.name}"${e.topBar ? " (top bar)" : ""}${e.secret ? " (password)" : ""}${e.options ? ` options: ${e.options.map((o) => `"${o}"`).join(", ")}` : ""}${e.kind === "dropdown" ? "" : e.value !== undefined ? ` (current value: "${e.value}")` : ""}${e.href ? ` -> ${e.href}` : ""}`).join("\n");
}

const GOAL_ADDRESS = /#?\/[\w\-/]*\d[\w\-/]*/g;
const canGoto = (persona) => GOAL_ADDRESS.test(persona.goal) && !(GOAL_ADDRESS.lastIndex = 0);
const SYSTEM = (persona, extra = "") => `You are ${persona.name}, a real person using a web app. ${persona.about}
Your goal: ${persona.goal}${extra ? `\n${extra}` : ""}
Behave like a normal person pursuing that goal, using the page's own buttons, links and fields. Each turn choose exactly ONE action.
Reply with JSON only: {"thought": "<one short sentence>", "action": "click" | "type" | "choose"${canGoto(persona) ? ' | "goto"' : ""} | "done", "element": <number>, "text": "<text to type, or the option to choose>"${canGoto(persona) ? ', "path": "<for goto: the address from your goal>"' : ""}}
- "click" presses a button or link element by its number.
- "type" replaces the content of a field element with "text". Fill the fields of a form before pressing its button.
- "choose" picks the option named in "text" from a dropdown element. Dropdowns already have a choice selected; only change one if your goal needs it.
${canGoto(persona) ? '- "goto" opens an address named in your goal, like "#/note/1".\n' : ""}- Do not repeat an action that already worked; move on to the next part of your goal.
- Use "done" when your goal is complete or you are truly stuck.`;

export async function runUser({ browser, baseUrl, persona, target = {}, runDir, onUpdate, maxSteps = 24, remember = true, reflect = true }) {
  const context = await browser.newContext({ viewport: persona.viewport || { width: 1100, height: 800 } });
  if (target.offline) await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    return ["data:", "blob:"].includes(url.protocol) || url.origin === new URL(baseUrl).origin ? route.continue() : route.abort();
  });
  const page = await context.newPage();
  const record = { id: persona.id, baseUrl, name: persona.name, goal: persona.goal, viewport: persona.viewport || null, steps: [], network: [], pageErrors: [], consoleErrors: [], status: "running", memory: [] };
  attachRecorder(context, page, record);
  const shotDir = join(runDir, "shots");
  await mkdir(shotDir, { recursive: true });
  const update = (patch) => { Object.assign(record, patch); onUpdate?.(record); };

  try {
    // Memory of earlier visits and personality traits (features/memory.mjs, features/traits.mjs).
    const memory = target?.dir && remember ? await loadMemory(target, persona.id) : null;
    const extra = [traitsPrompt(persona), memoryPrompt(memory)].filter(Boolean).join("\n");
    if (memory?.visits) record.rememberedVisits = memory.visits;
    await page.goto(baseUrl);
    await page.waitForTimeout(500);
    const recentKeys = [];
    let rejectStreak = 0;
    for (let i = 1; i <= maxSteps; i++) {
      const view = await observe(page);
      const memory = record.memory.slice(-8).join("\n") || "(nothing yet)";
      let decision;
      try {
        decision = await chooseJSON(SYSTEM(persona, extra),
          `Page address: ${view.url}\nVisible text:\n${view.text}\n\nNotification on screen: ${view.toast || "(none)"}\n\nInteractive elements:\n${describeElements(view.elements)}\n\nWhat you have done so far:\n${memory}`);
      } catch (error) {
        record.memory.push(`step ${i}: could not decide (${error.message})`);
        continue;
      }
      const action = String(decision.action || "").toLowerCase();
      update({ current: decision.thought || action });
      if (action === "done") { record.goalStatus = "model_stopped"; record.memory.push(`step ${i}: model stopped: ${decision.thought || ""}`); break; }

      const element = view.elements.find((e) => e.n === Number(decision.element));
      // Invalid actions are rejected without side effects, and the user is told why.
      const key = action === "goto" ? `goto ${decision.path}` : `${action} ${element?.name} ${decision.text ?? ""}`;
      const allowedPaths = new Set(["/", ...view.elements.map((e) => e.href).filter(Boolean), ...(persona.goal.match(GOAL_ADDRESS) || [])]);
      let rejection = null;
      if (action === "goto" && !canGoto(persona)) rejection = "there is no address bar here; use the page's buttons, links and fields";
      else if (action === "goto" && !allowedPaths.has(String(decision.path || "").replace(/^\/(?=#)/, ""))) rejection = `the address ${decision.path} is not on this page or in your goal; use the page's buttons, links and fields instead`;
      else if (!["goto", "click", "type", "choose"].includes(action)) rejection = `unknown action "${action}"`;
      else if (action !== "goto" && !element) rejection = `there is no element number ${decision.element} on this page`;
      else if (action === "type" && element.kind !== "field") rejection = `element ${element.n} is a ${element.kind}, not a field you can type into`;
      else if (action === "choose" && element.kind !== "dropdown") rejection = `element ${element.n} is not a dropdown`;
      else if (action === "choose" && !element.options.includes(String(decision.text))) rejection = `the dropdown has no option "${decision.text}"; its options are ${element.options.join(", ")}`;
      else if (action === "click" && element.kind === "dropdown") rejection = `element ${element.n} is a dropdown; use "choose" with one of its options, or move on`;
      else if (recentKeys.slice(-2).includes(key)) rejection = "you just did exactly this; try the next part of your goal";
      if (rejection) {
        record.memory.push(`step ${i}: rejected (${rejection})`);
        record.rejected = (record.rejected || 0) + 1;
        if (++rejectStreak >= 3) { record.goalStatus = "blocked"; record.memory.push(`step ${i}: stopped after 3 rejected actions in a row`); break; }
        continue;
      }
      rejectStreak = 0;
      recentKeys.push(key);
      const step = { n: i, at: Date.now(), action, thought: String(decision.thought || "").slice(0, 200), url: view.url };
      const netBefore = record.network.length, errBefore = record.pageErrors.length;
      try {
        if (action === "goto") {
          const path = String(decision.path || "/");
          step.target = { path: path.replace(/^\/(?=#)/, "") };
          await page.goto(new URL(path, baseUrl).href);
        } else if (!element) {
          throw new Error("no such element " + decision.element);
        } else {
          step.target = { kind: element.kind, name: element.name, selector: element.selector, href: element.href };
          const loc = page.locator(`[data-legios="${element.n}"]`);
          if (element.secret) step.secretField = true;
          if (action === "type") { step.text = String(decision.text ?? ""); await loc.fill(step.text); }
          else if (action === "choose") { step.text = String(decision.text); await loc.selectOption({ label: step.text }); }
          else await loc.click();
        }
        await page.waitForTimeout(700);
        await page.waitForLoadState("networkidle").catch(() => {});
      } catch (error) {
        step.error = String(error.message).split("\n")[0].slice(0, 200);
      }
      const after = await observe(page).catch(() => ({ url: "?", toast: "" }));
      step.resultUrl = after.url;
      // What the app told the user: notifications, plus short lines of text that just appeared.
      const appeared = (after.lines || []).filter((l) => !(view.lines || []).includes(l));
      step.toast = (after.toast && after.toast !== view.toast ? after.toast : "") || appeared.filter((l) => /\b(saved|success|updated|created|done|added|deleted)\b/i.test(l)).join(" | ");
      step.appeared = appeared.slice(0, 10);
      step.network = record.network.slice(netBefore).map(({ method, path, status }) => ({ method, path, status }));
      step.pageErrors = record.pageErrors.slice(errBefore).map((e) => e.message);
      step.outcomes = await checkOutcomes({ target, record, rows: record.network.slice(netBefore), request: context.request, baseUrl, step: step.n });
      // Repeat a crashing request right away, in the same session and with the same data, to confirm it
      // reproduces. Legios always tests a disposable copy with its own database, so repeating a save is safe.
      for (const r of record.network.slice(netBefore).filter((n) => n.status >= 500)) {
        try {
          r.repeatStatus = (await context.request.fetch(new URL(r.path, baseUrl).href, { method: r.method, data: r.requestBody || undefined,
            headers: r.requestBody ? { "content-type": "application/json" } : undefined })).status();
        } catch { r.repeatStatus = null; }
      }
      step.shot = `shots/${persona.id}-${String(i).padStart(2, "0")}.jpg`;
      await page.screenshot({ path: join(runDir, step.shot), type: "jpeg", quality: 60 }).catch(() => {});
      record.steps.push(step);
      const outcome = step.error ? `failed: ${step.error}` : [step.toast && `notification "${step.toast}"`, step.network.map((r) => `${r.method} ${r.path} -> ${r.status}`).join(", "), step.pageErrors.length && "page error"].filter(Boolean).join("; ") || "ok";
      const what = action === "choose" ? `chose "${step.text}" in "${step.target?.name}"` : action === "type" ? `typed "${step.text}" into "${step.target?.name}"` : action === "goto" ? `opened ${step.target?.path}` : `clicked ${step.target?.kind} "${step.target?.name}"`;
      record.memory.push(`step ${i}: ${what} -> ${outcome}`);
      update({ lastShot: step.shot });
    }
    record.goalStatus ||= "step_limit";
    // After the visit: the user's own feedback (an opinion, separate from confirmed bugs), then remember it.
    if (reflect) {
      update({ current: "Writing feedback on the visit" });
      try { record.reflection = await reflectOnVisit(persona, record); } catch { record.reflection = null; }
    }
    if (target?.dir && remember) await rememberVisit(target, persona.id, record, record.reflection).catch(() => {});
    update({ status: "finished", current: record.goalStatus === "blocked" ? "Stopped after repeated invalid actions" : record.goalStatus === "step_limit" ? "Stopped at the step limit" : "Explorer stopped; see outcome checks" });
  } catch (error) {
    update({ status: "failed", goalStatus: "blocked", current: "Stopped: " + String(error.message).split("\n")[0] });
  }
  return { record, context };
}
