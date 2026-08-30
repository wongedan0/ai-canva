# DEVLOG — Session Journal

Durable record of what each working session changed and what is in flight, so a **new session
can pick up cold in one read** (`AGENTS.md` first for durable knowledge, then this file for
current state).

> This file is about **state**, not knowledge. Conventions, architecture, and gotchas belong in
> `AGENTS.md`; "what were we doing / what's half-done / what's next" belongs here.

## How to use

- **Newest entries at the top** (directly below this guide).
- Append one entry per finished unit of work (feature, fix, deploy, investigation with a durable
  outcome) — not per chat message.
- Keep entries short. Use the template:

```markdown
## YYYY-MM-DD — short title

- **Done:** one to three lines, outcome-focused. Files/filesystems touched if non-obvious.
- **In flight:** partial work, uncommitted state, things deliberately left half-done (or "—").
- **Next steps:** what the next session should pick up first (or "—").
```

- Prune as you go: collapse entries older than ~a month to one line each — unless they describe
  work still in flight.
- If an entry reveals a durable convention or gotcha, promote it into `AGENTS.md` (per its
  maintenance rule) and keep only the state here.

---

## 2026-08-30 — Agent box: a real task-driven agent on the board

- **Done:** Added the 🤖 **Agent** box (16th box type, first in Workers): the user types a task and
  Runs; an LLM controller loop (client-side, reusing `/api/generate`) manipulates the BOARD — each
  turn it returns ONE JSON action (`add_box` / `connect` / `run_box` / `finish`) executed with the
  regular store actions, so agent-created pipelines are ordinary boxes collaborators can take over.
  New `client/src/lib/agent.ts` (pure: action parsing, board inventory, turn prompts, child layout;
  22 unit tests) + `runAgentLoop` in `boardStore.ts` + `isAgent` UI in `BoxNode.tsx` (task textarea,
  live step timeline, final answer, ⏹ Stop) + `connectBoxes`/`stopAgent` store actions. Budget 12
  turns with forced wrap-up, 2× parse-retry with coaching, raw-text salvage; token ledger reused
  with `boxType: "agent"`. Verified end-to-end against the real dev app + Ollama (Playwright smoke:
  agent created/wired/ran boxes and finished with a markdown answer; steps rendered live).
- **In flight:** —
- **Next steps:** optionally let the agent `delete_box`/restyle boxes, or persist per-run cost
  summaries; E2E could add an agent-flow test with a mocked `/api/generate` for determinism.

## 2026-08-30 — Documents box (📎 upload files as AI inputs)

- **Done:** New `documents` input box — multi-file upload (click or drag & drop) whose extracted
  text becomes downstream prompt input. `lib/documents.ts` (unit-tested, 16 tests) holds the
  logic: txt/md/csv/json read directly, PDF via lazy `pdfjs-dist`, DOCX via lazy `mammoth`
  (both stay out of the main bundle); text capped 100k/file, 400k/box. Raw files upload
  best-effort to Storage (`storage.rules` gained a `documents/` path — **rules not deployed
  yet**). `runBox` gathering now uses `buildDocumentsOutput()` for document sources. E2E "TD"
  tests added (upload .txt + a hand-written minimal PDF through the real UI, assert the labeled
  text reaches a connected box's prompt via a fetch intercept).
- **In flight:** —
- **Gotchas hit (durable, see AGENTS.md E2E section):** (1) the firebase-tools access token
  expires ~hourly — a 401 on the facilitator PATCH surfaces as the "TF facilitator button"
  FAIL; refresh by running any `firebase` CLI command before the suite. (2) Running the E2E
  while another session edits `client/src` breaks it via HMR/full reloads (scattered flaky
  failures each run) — run it in a quiet window; my first "crash" theory (Vite re-optimizing
  pdfjs-dist) was wrong, it was the concurrent Agent-box session. (3) `npm install <pkg>`
  pruned `playwright-core` (never in package.json) — now a devDependency. Final state on the
  combined tree (Documents + Agent boxes): **build ✓, unit 128 ✓, E2E 80/80 ✓**.
- **Next steps:** consider a per-document preview/expand in the box UI.
- **Shipped:** committed as `81b0752` (Documents + Agent boxes together) and deployed via
  `scripts/deploy.sh` — hosting + storage rules (documents path live) + firestore rules
  released; functions unchanged (both features are client-only). Verified live:
  `https://carbondocs.web.app` 200, `/api/health` all keys configured, `/api/generate`
  returns real output, and the deployed bundle contains the Documents box code.

## 2026-08-30 — DEVLOG created

- **Done:** Added this session journal (`docs/DEVLOG.md`) and pointer sections in `AGENTS.md`
  (bootstrap note, docs layout table, docs list, maintenance checklist), so future sessions read
  current state here instead of re-exploring the codebase.
- **In flight:** —
- **Next steps:** —