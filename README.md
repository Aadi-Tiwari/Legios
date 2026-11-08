# Legios

You tested your app as yourself. Legios tests what happens when other people use it.

Legios sends independent AI users into a web app you are building, records everything they do, turns suspicious observations into confirmed findings, drafts a code fix for a finding, and proves the fix by replaying the same journey against the patched app. Recorded journeys can then be repeated as a crowd of 150 simultaneous browser users.

## Built at Zero to Demo (November 7, 2026)

Track: Automate.

**Built during the event:** everything in this repository: the AI user runner, the evidence checks, model-free replay and verification, the repair pipeline, crowd mode, memory and feedback for the AI users, test-user generation, regression-test and report export, the benchmark, the dashboard, and the test apps in `targets/`:
- **Notely** and **Ledgerly** were written today with deliberate, disclosed bugs, so results can be checked against known answers.
- **Pantry Share** (`targets/promptbuilt`) was built today by an AI coding agent from one plain prompt (`PROMPT.txt`) and is tested unmodified (`FINGERPRINT.json`). Nobody planted bugs in it.

## How it compares

AI testing products such as Momentic, QA.tech and Checksum already write, run and maintain end-to-end tests with AI, and some explore apps on their own. Legios is not trying to replace them. What it does differently:
- **Privacy between real accounts.** Each AI user has its own account, and Legios checks whether one person's saved data reaches another person or a signed-out visitor, by replaying the owner's own requests from the other sessions.
- **A fix only counts with proof.** Fixes are verified by replaying the recorded journey on a separate patched copy without any model calls, and the verifier itself is tested against fake fixes.
- **From explorers to a crowd.** The paths the AI users found become a crowd of up to 300 simultaneous browser users with their own accounts.
- **Runs on your machine** with a local model by default.

## What I learned

- A small local model is a weak navigator. Rules that reject invented addresses and repeated actions mattered more than prompt wording. In a side-by-side benchmark, users on a hosted model finished their goals far more often than users on the local model, while both found the same planted bugs.
- "Fixed" has to mean positive evidence. My first verifier called a correct fix "failing" because the replay could not reach one later step. Not reached is now "blocked", never "failing" or "fixed".
- Planted bugs alone prove little. The healthy copy (false alarms) and an app nobody planted bugs in were what made the results believable, and that unplanted app exposed two bugs in Legios itself (fields wrapped in labels, and stale element numbers after a form was hidden).

## How it works

1. **Describe the app.** A target (`targets/<id>/target.json`) says how to start the app, what it does, who may see what, which files a fix may change, and optionally how to check who is signed in. Test users can be written by hand or drafted by the local model from the description.
2. **Explorers.** Each AI user gets its own browser session, account, goal and memory. A local model (Ollama, default `qwen3:14b`) picks every click and keystroke from what is on screen. Invalid actions, such as made-up addresses or repeating the same action, are rejected without side effects.
3. **Recording.** Every action is saved with the account that did it, a screenshot, API requests and responses, notifications and page errors.
4. **Findings, for any app.**
   - *Server errors*: any 5xx response, repeated immediately in the same session to confirm it.
   - *False success*: the app showed a success message while the save request behind it failed.
   - *Private data exposure*: a user's private content is what they typed into a content field and saved successfully (never passwords or login names). If another user, or a signed-out visitor, receives it, that is a leak. Legios checks the other user's own traffic, has the other user's session repeat the owner's reads, and repeats them with no account at all.
   - A finding is **confirmed** only when it happens again on request; otherwise it stays **uncertain**. Denied requests (401, 403, 404) are expected behavior, not bugs. Every finding records how it was found.
5. **Repair.** The Codex CLI drafts the smallest fix from the evidence, allowed to edit only the files the target lists. The fix goes into a separate candidate copy. Fixes stack: each repair starts from the latest verified version.
6. **Verification.** The candidate runs on its own port with a fresh database, and the recorded journey is replayed in a browser without any model calls. "Fixed" needs positive evidence: the failing request is sent again and now succeeds, or for a leak, the other user and a signed-out visitor are denied while the owner can still read, create and edit. Everything that worked before must still work. If the replay cannot reach the failing step, the result is **blocked**, never fixed.
7. **Crowd.** Recorded journeys are repeated as up to 300 simultaneous browser users, each with its own account. No model calls. Peak simultaneous sessions, completed journeys, errors and response times are measured in that run.

A green result means the tested failure was corrected and the checked workflow still works. It does not certify the whole app.

## AI users that remember and give feedback

- **Traits.** A user can carry traits (patience, comfort with technology, careful or messy typing) that change how they act (`features/traits.mjs`).
- **Memory across visits.** After each visit a user keeps a few durable facts, such as what they saved and what broke (`features/memory.mjs`). Every run starts the app from a clean database, so returning users are told their old data is gone; they use what they learned to retry what broke or confused them last time. `POST /api/memory/forget` resets them.
- **Feedback.** After each visit a user says what confused, frustrated or pleased them, citing the step it is about (`features/reflection.mjs`). This is shown as UX feedback, separate from confirmed bugs. Points that cite a step that did not happen are marked ungrounded.
- **Varied crowd.** Before a crowd run, the local model writes different content for each crowd user, so 150 users do not all type the same note (`features/crowd-variety.mjs`). Actions are still replayed; only the typed content varies.

## An app nobody planted bugs in

Pantry Share was generated from one plain prompt and tested unmodified. On it, four AI users signed up, saved private and shared items, edited them, signed out and back in, and searched (4 sign-ups, 2 sign-ins, 4 saves, 2 edits). Legios confirmed **no bugs** and raised no false leak: items marked shared are declared public in its target (`publicContent`), so housemates seeing them is expected. The AI users' feedback still found real rough edges, for example that the price field rejects "7,50" written with a comma.

## Exports

```powershell
node tools/export-tests.mjs runs\<run folder>            # one regression test per confirmed finding
node tools/check-regression-tests.mjs runs\<run folder>  # each must fail on the original app and pass on the fixed one
node tools/report.mjs runs\<run folder>                  # legios-report.html (offline, screenshots embedded) and patches/*.patch
```

## Model providers

The AI users run on a local model through Ollama by default. `LEGIOS_PROVIDER=anthropic` (or `groq`) switches to a hosted model; keys are read only from the environment or a gitignored `.env`, never logged, and `LEGIOS_BUDGET_USD` sets a hard spending stop per process.

Side-by-side benchmark on November 7 (same apps and checks; 3 buggy runs, 3 healthy runs and 1 run on the AI-built app per model):

| | claude-opus-5-5 (hosted) | qwen3:14b (local) |
| --- | --- | --- |
| All three planted bugs confirmed | 3 of 3 runs | 3 of 3 runs |
| False alarms on the healthy copy | 0 | 0 |
| Confirmed findings on the AI-built app | 0 | 0 |
| Users who finished their goal | 22 of 28 | 2 of 28 |
| Users stopped after repeated invalid actions | 0 of 28 | 14 of 28 |
| Rejected (wasted) actions | 1 of 255 | 62 of 520 |
| Average seconds per run | 43 | 43 |
| Measured cost | $1.60 for all 7 runs | none |

Both models confirmed the same bugs; the hosted model's users behaved far more like real people. The local model needs no internet and keeps the app's data on the machine.

## Cached fixes

Every fix that passes verification is saved in `fix-cache/`. If the live drafting step fails or takes longer than 90 seconds (for example, with no internet), Legios applies the saved patch for the same finding, labels it "cached draft from an earlier verified run", and still runs the full verification live. `node tools/fix-cache.mjs test runs\<run>` applies each cached patch to the original app and verifies it (3 of 3 on Notely).

## Outcomes and the final combined version

Targets can declare `outcomes` independently of the source files a repair may change. Notely checks that submitted note content survives an independent read and that search returns known matching notes. Ledgerly checks that expense descriptions and amounts survive a read of the expense list. A successful HTTP status alone cannot pass these checks. Missing checkpoints remain blocked. Repeated reads that confirm missing content can produce an `outcome_failure` finding, even if the original request returned 200.

After each repair, Legios rechecks every original finding on the combined candidate. A candidate is rejected if the selected finding or an earlier verified fix fails that sweep. The dashboard's **Recheck all findings** button reruns the sweep on demand, showing fixed, still failing, and blocked results separately. Other observations remain visible. The before-and-after view distinguishes the selected patch from the final combined version.

**Download developer report** exports a local JSON package containing readable Markdown, reproduction steps, request evidence, the patch diff, verification checks, and a journey screenshot when available. Passwords captured in the recording are redacted. Reports are downloaded locally; nothing is published or sent.

```powershell
node tools/recheck.mjs runs\<run folder>
node tests/outcomes-and-recheck.mjs runs\<Notely run with all three findings>
node tests/dashboard-flow.mjs runs\<Notely run with all three findings>
```

The outcome controls reject a save that returns 200 but discards edits, a search that returns 200 with missing results, and a search endpoint changed to return 403. A healthy copy must pass the complete sweep.

## Trying an existing local app

For a static frontend, `tools/trial-static.mjs` snapshots an existing compiled `dist` directory into an ignored run folder. Give it the entry path, a plain app description, and a goal using fictional content. The explorer receives the rendered page and goal, without the app's source or bug hints. Browser HTTP requests are restricted to the local target. The generated target configuration stays local and is ignored by Git.

```powershell
node tools/trial-static.mjs C:\path\to\app\dist /index.html "A public prototype" "Explore the main feature using fictional content. Stop if it is unavailable."
```

This trial supports public static prototypes. It does not demonstrate authenticated backend coverage or guarantee that a bug will be found. Existing server apps use the normal target configuration and must have their data isolated before testing.

## Accuracy

`tools/benchmark.mjs` runs the explorers several times on Notely (three planted bugs) and on a hand-fixed healthy copy (no planted bugs), and reports how often each bug was confirmed and how many false alarms appeared. Results are written to `runs/benchmark-*/RESULTS.md`.

Measured on November 7 with the local model (qwen3:14b), across two benchmarks (one before and one after the final engine changes):

| | Result |
| --- | --- |
| All three planted bugs confirmed in the same run | 6 of 6 runs |
| Confirmed findings on the healthy copy (false alarms) | 0 in 6 runs |
| Pantry Share (AI-built, no planted bugs) | 0 confirmed findings, 0 server errors in 1 run |
| Verifier controls (UI-only fix, deny-everyone fix, correct fix) | 3 of 3 judged correctly |
| Exported regression tests (fail before, pass after) | 6 of 6 |
| Crowd on the fully fixed Notely | 150 of 150 journeys, peak 150 at once, 0 server errors, 412 distinct model-written texts |

These are small samples from one day; they show the method works on these apps, not a general detection rate.

`tests/verifier-integrity.mjs` checks that the verifier cannot be fooled: a UI-only patch (the page hides other people's data but the server still sends it) and a deny-everyone patch (the owner loses access too) must both be rejected, and a correct ownership check must pass. These hand-written patches are controls for the verifier, not repairs.

## Run it

Requirements: Node.js 22 or newer, Ollama with `qwen3:14b`, and the Codex CLI signed in (`codex login`) for repairs.

```powershell
npm install
npx playwright install chromium
node server.mjs            # dashboard at http://127.0.0.1:4000
```

Command line:

```powershell
node run.mjs --target=notely --headless          # explorers only
node loop.mjs runs\<run folder> data_leak         # replay, repair, verify one finding
node tests\verifier-integrity.mjs runs\<run folder>
node tools\benchmark.mjs --runs=3
```

To test your own app, add `targets/<your app>/target.json` modeled on `targets/ledgerly/target.json`.

## Limits

- Live AI users vary between runs, so one run can miss a bug. Replay and crowd mode are deterministic.
- Repairs are drafts. Review the diff before applying it to a real project.
- Mobile layout problems are not detected yet.
- Private data is recognized from what users type and save; data an app generates on its own (for example, server-made IDs) is not tracked.
- Everything runs on loopback (127.0.0.1). Only test apps you own.
