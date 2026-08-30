# AI Canva — Project Memory

This file is auto-loaded into the AI agent's context at the start of every session (DeepSeek
Harness reads `AGENTS.md` / `CLAUDE.md` from the project root). It captures durable project
knowledge so it survives across sessions. Keep it current — it is the first thing an agent reads.

**Session bootstrap:** after this file, read `docs/DEVLOG.md` (newest entries first) to pick up
the current in-flight state without re-exploring the codebase. When you finish a unit of work,
append a short entry there — and a new session should be able to cold-start from these two files
alone.

## What this project is

**AI Canva** is a collaborative, AI-powered whiteboard for building visual AI pipelines. Users
place "boxes" on a React Flow canvas, connect them, and run AI prompts that flow content from box
to box — from an Idea, through Research, to PRD / Slides / Code / UI Design / Stitch UI.

- **Client:** React + Vite + React Flow canvas, Zustand store, Tailwind CSS.
- **Backend:** Node/Express for local dev; the same API packaged as a Firebase Cloud Function for
  production.
- **AI providers:** Ollama (LLM text), fal.ai (image generation), Google Stitch (UI screens).
- **Persistence & collaboration:** Firebase — Google Auth, Firestore (boards, presence, live
  cursors), Storage (board images). localStorage is an offline cache.

## Repository layout

| Path | Purpose |
|------|---------|
| `client/` | React + Vite frontend. Entry `client/src/`, store at `client/src/store/boardStore.ts`. |
| `server/` | Local Express dev backend (`/api/generate`, `/api/generate-image`, `/api/stitch-generate`, `/api/health`). |
| `functions/` | Same API as a Firebase Cloud Function (`onRequest`) for production. Also hosts `src/stitchJobs.ts` (the async Stitch Cloud Task worker). |
| `scripts/deploy.sh` | One-command production deploy (build client, build Functions, deploy Hosting + Functions + rules). |
| `docs/` | Guides: `OVERVIEW`, `ONBOARDING`, `ARCHITECTURE`, `BOX_TYPES`, `API`, `DEPLOYMENT`, `OSS_READINESS`, plus `docs/course/` teaching materials. `docs/DEVLOG.md` is the session journal (read at session start, append after finishing work). |
| `firebase.json`, `firestore.rules`, `storage.rules` | Firebase config and security rules. |
| `dsh-plugins/` | Out-of-tree plugins for the DeepSeek Harness Web GUI (not part of the app). See "dsh GUI plugins" below. |

## Key commands

```bash
npm run dev            # run server + client together (concurrently)
npm run dev:server     # local Express backend only
npm run dev:client     # Vite client only
npm run install:all    # npm install in both server/ and client/
npm test               # run server + client unit tests (Vitest)
npm run test:watch    # watch mode for both server and client tests
npm run deploy         # = bash scripts/deploy.sh (production Firebase deploy)
```

## Architecture notes

- **Two backends, one API surface.** The API logic is duplicated in `server/` (local Express) and
  `functions/` (Cloud Function) because Cloud Functions runs in the Firebase environment while the
  local server runs in Node. Both use the same SDKs. Keep them in sync when changing endpoints.
- **Single Zustand store** (`client/src/store/boardStore.ts`) owns the whole board: `nodes`/`edges`
  (React Flow graph), `boxData` (per-box content/prompts/status/output — kept separate from the
  graph objects so it serializes cleanly to Firestore), and board/collaboration metadata.
- **`runBox(id)`** is the orchestrator: gathers upstream inputs from incoming edges, builds
  `NamedInput[]` for prompt templating, then branches by box type (cartoon → fal.ai, stitch →
  Google Stitch, slides → Ollama + JSON parsing, code/ui → Ollama + code extraction, else Ollama
  text).
- **Stitch is asynchronous.** Stitch generation is slow (40s+) and exceeded the ~60s Firebase
  Hosting rewrite timeout, so the deployed box previously reported "Request failed" even though the
  screen was created in Stitch. `POST /api/stitch-generate` now returns a `jobId` immediately; the
  client polls `GET /api/stitch-status/:jobId` until the job is `done`/`error`. The client-side
  `generateStitchUI(prompt)` in `client/src/lib/api.ts` hides this (start + poll). Local dev uses an
  in-memory job store in `server/src/app.ts`; production uses Firestore (`stitchJobs/{jobId}`, no
  client access) plus a Cloud Task worker `processStitchJob` in `functions/src/stitchJobs.ts`.
  `stitch.ts` caps prompt length (6000) and uses the fast `GEMINI_3_FLASH` model (`STITCH_MODEL`).
  Keep the two backends' stitch endpoints in sync.
- **Local server is split for testability.** `server/src/app.ts` exports `createApp()` (the Express
  app + all routes + the in-memory stitch job store) with **no side effects at import**;
  `server/src/index.ts` is the bootstrap that calls `createApp()`, finds a port, writes
  `.server-port`, and listens. Write route tests against `createApp()` via supertest instead of
  starting the server.
- **Client pure logic lives in `client/src/lib/`** and is unit-tested: prompt templating
  (`prompts.ts`), code/HTML wrapping (`code.ts`), slides JSON parsing (`slides.ts`), Firestore
  save serialization (`serialization.ts`), Documents-box text handling (`documents.ts`), and the
  Agent box action protocol (`agent.ts`). `boardStore.ts` imports these rather than inlining them.
- **Prompt templating** references connected inputs by name: `{{Box Name}}`, `{{input_1}}`,
  `{{inputs}}`.
- **16 built-in box types** plus user-created custom boxes: Agent, Idea, Image, Documents,
  Research, Summarize, PRD, Dev Plan, Cartoon Profile, Slides, Code, UI Design, Stitch UI, three
  collaboration boxes (Note, Label, Timer), and the `custom` runtime type (see "Custom boxes"
  below). Categories: `input`, `worker`, `collab` (standalone annotation tools: no AI, no Run, no
  handles), and `custom` (the user's saved templates). See `docs/BOX_TYPES.md`.

## UI design system

The app chrome (header, sidebar, canvas tools) follows a consistent "enterprise but
modern" language, built on two shared primitives:

- **`client/src/components/ui/Button.tsx`** — the only button styling in the chrome.
  Variants: `primary` (indigo-600 — the single loud color, used for Share and the
  area tool's active state), `secondary` (white + 1px slate border — the default),
  `ghost` (transparent, for role-gated views), `danger`; sizes `xs/sm/md`; `active`
  renders the pressed state (dark). Every button gets a keyboard focus ring. Use it
  instead of hand-rolled Tailwind button class strings.
- **`client/src/components/ui/Menu.tsx`** — dropdown primitive (`Menu` + `MenuItem`
  + `MenuDivider`/`MenuLabel`). Closes on outside click + Escape; pass children as
  a function `(close) => …` so items can dismiss the menu after acting. Used by the
  Boards menu and the account menu; the presence roster popover follows the same
  outside-click/Escape contract.

Design rules: one accent (indigo) over slate neutrals; 1px borders + layered soft
shadows (no `border-2`/`shadow-lg` in the chrome); h-14 app bar (`.app-bar`, blurred
white); box cards are `.box-node` (1px type-colored border set inline, indigo
selection ring); `.logo-tile` is the only gradient; `.save-dot` states map
`saveStatus`; thin scrollbars and rounded React Flow controls/minimap styling live
in `client/src/index.css`. Palette rows use a 28×28 icon tile tinted with the box
color at ~12% alpha (`color + "1F"`) instead of the old left border-rail.

**`components/Header.tsx` owns its store subscriptions** (boardTitle, saveStatus,
boardList, currentBoardId) and is `memo`-ized. App must NOT subscribe to those
slices — otherwise every keystroke in the board-title input re-renders the whole
Canvas tree (this was the case before the header extraction). App passes only
stable `useCallback` handlers across the memo boundary. Destructive/rare actions
(Clear/Delete board, Sign out) live inside the header menus, not on the bar; the
visible bar is ~5 controls for a regular user (roster, Share, + Add Box, Boards,
account) plus role-gated Admin/Facilitator buttons.

## Admin board

Admins can view system-wide usage (total users, active users, new users/boards in 7 days, storage
used) via an "Admin" button in the header.

- **Admin designation:** a doc at `admins/{uid}` marks a user as admin (add it manually via the
  Firebase console or a script). The client reads `admins/{uid}` (rules allow self-read) to show the
  Admin button; the server re-verifies.
- **User tracking:** the client writes `users/{uid}` on login (email, displayName, photoURL,
  `createdAt`, `lastActive`) and heartbeats `lastActive` every ~60s. This powers the "active now"
  metric.
- **Stats endpoint:** `GET /api/admin/stats` (see `docs/API.md`). It verifies the caller's ID token
  + admin role, then computes: total/new users from **Firebase Auth** (`listUsers`), active users
  from the `users` collection heartbeat, board counts via Firestore `count()`, and storage usage
  via the Admin SDK.
- **User management:** the admin board also lists all users and can block/unblock accounts:
  `GET /api/admin/users` (paginated) and `POST /api/admin/users/:uid/status` (`{ disabled }`),
  which call `auth.listUsers` / `auth.updateUser`. An admin cannot block their own account.
- **Admin auth helper:** `requireAdmin(req)` in `functions/src/index.ts` verifies the ID token +
  admin role for all `/api/admin/*` routes.

## Token usage tracking

The app reports per-call LLM token usage and tracks cumulative usage per user and across the system.

- **Source:** Ollama's non-streaming `/api/chat` response includes `prompt_eval_count` (input) and
  `eval_count` (output). `generateContent` in both `server/src/ollama.ts` and `functions/src/ollama.ts`
  returns `{ content, model, promptTokens, completionTokens, totalTokens }`, and `/api/generate`
  returns those counts under `usage`.
- **Per-box display:** each text AI box stores `tokens` in its `BoxData` and shows "in · out / total
  tok" in the box footer after running.
- **Persistence (client-side):** after each successful generate, the client writes a detailed
  `tokenUsage/{autoId}` doc (userId, boardId, boxId, boxType, model, prompt/completion/total,
  createdAt) and atomically bumps the user's rolling total in `usageTotals/{uid}` via Firestore
  `increment` (so concurrent calls don't lose updates).
- **Cumulative in the header:** `client/src/store/tokenStore.ts` (non-persisted) holds the logged-in
  user's session total, seeded from `usageTotals/{uid}` on login and incremented as calls run. A ⚡
  badge in the header shows it.
- **Admin aggregate:** `/api/admin/stats` sums `usageTotals` across all users and returns
  `tokens: { promptTokens, completionTokens, totalTokens }`, shown as a card in the AdminBoard
  Overview.
- **Per-user admin view:** `GET /api/admin/users` joins each user with their `usageTotals` doc and
  returns per-user `tokens`. The AdminBoard Users tab shows "Tokens ⬆" (input / `promptTokens`) and
  "Tokens ⬇" (output / `completionTokens`) columns — kept separate because they cost differently.
- **Rules:** a user can create/read their own `tokenUsage` docs and read/write their own
  `usageTotals` doc; the admin function reads aggregates via the Admin SDK.
- **Production-only:** the endpoint is implemented in `functions/` (uses `firebase-admin`). The
  local `server/` returns `501` because it has no service account — this is an **intentional
  deviation** from the server/functions duplication rule.
- **Client files:** `client/src/lib/admin.ts` (isAdmin/profile/heartbeat/fetchAdminStats) and
  `client/src/components/AdminBoard.tsx` (the dashboard UI).

## Testing (Vitest)

- **Run all:** `npm test` (server then client). **Watch:** `npm run test:watch`.
- **Server tests** (`server/src/*.test.ts`, supertest + Vitest): hit `createApp()` from
  `server/src/app.ts` with the AI modules (`ollama`/`fal`/`stitch`) mocked via `vi.mock`; they cover
  route validation, response shaping, the stitch job flow, and `generateContent` token parsing.
  Server test files are excluded from the `tsc` build via `exclude` in `server/tsconfig.json` — do
  not remove that.
- **Client tests** (`client/src/lib/*.test.ts`): pure functions only (prompts, code, slides,
  serialization) — no DOM, no Firebase. `client/vitest.config.ts` (node env) loads instead of
  `vite.config.ts` to avoid the dev-server proxy + build chunks.
- **No functions/ tests yet** — they need the Firebase emulator / Admin SDK; keep API logic in sync
  between `server` and `functions` by hand and cover the shared logic via `server` tests.
- **E2E suite:** `client/e2e.mjs` (playwright-core + system Chrome) drives the **real dev app** on
  `localhost:5173` with the real backend. Part 1 (fake user via dev-only `window.__dsh` store hooks
  in `main.tsx`, `import.meta.env.DEV`-guarded, stripped from prod): landing → login → palette adds
  → note/label/timer flows → a real `/api/generate` run (Ollama) with markdown output + token badge.
  Part 2 (**real auth + real Firestore, two users in separate contexts**): real email/password
  sign-in via `createTestAccount`/`signInTestAccount` in `client/src/lib/auth.ts` (unused by the
  app UI → tree-shaken from prod), real board creation, persistence across a page reload,
  a second user opening the board via `?board=<id>`, and live cross-user sync (note edits A→B,
  timer start/stop B→A with attribution, presence). Requires the **Email/Password provider**
  enabled in Firebase Auth — done once via the Identity Toolkit admin API
  (`PATCH .../admin/v2/projects/carbondocs/config?updateMask=signIn.email` with the firebase-tools
  access token from `~/.config/configstore/firebase-tools.json`); it can be re-disabled in the
  console, but the suite needs it. Test accounts (`e2e-a@/e2e-b@test.local`) are auto-created
  (reused if present) and deleted afterwards via `accounts:lookup` + `accounts:delete`; test
  boards are deleted at start and end of each run (self-cleaning). The single
  "Missing or insufficient permissions" page error from Part 1's fake user is expected noise.
  Run with `node e2e.mjs` from `client/` while `npm run dev` is up. Playwright clicks inside
  React Flow's transform can misfire (rotated post-its especially) — prefer `page.evaluate` JS
  clicks/native value setters over coordinate clicks. Part 3 (facilitator + guest): the suite
  grants the facilitator role to a test user via the Firestore admin REST API (OAuth token from
  firebase-tools), then drives the dashboard (workshop → template → team → seat codes), joins as
  a guest in a fresh context (code → profile modal → team board → own board → team board visible
  in the list), and cleans everything up. Result at time of writing: **80/80 passed** (75 base
  + 5 "TD" Documents-box tests).
- **E2E environment gotchas:** (1) The firebase-tools access token
  (`~/.config/configstore/firebase-tools.json`) **expires ~hourly**; a stale token makes the
  facilitator PATCH silently 401 → the "TF facilitator button appears after grant" check FAILS.
  Refresh by running any `firebase` CLI command (e.g. `firebase projects:list`) before the suite.
  (2) **Never run the E2E while another session is editing `client/src`** — Vite HMR/full reloads
  mid-run cause scattered, different failures each run (missing buttons, empty outputs,
  `window.__dsh` undefined). Run it in a quiet window (no src writes for ~2 min). (3) Deps used
  only by the suite must be in `client/package.json` — an ad-hoc `npm install` without `--save`
  gets pruned by the next install (that silently removed `playwright-core` once).
- **UI text markers the E2E clicks by** (keep these EXACT strings when restyling — the suite
  finds buttons by `textContent`, not selectors): header `Boards (` and `New Board` (capital B)
  and `🧑‍🏫 Facilitator`; palette rows keep the box label as the button's trailing text
  (`textContent.trim().endsWith(label)` — a leading icon tile is fine); the help card keeps the
  text `How to use` inside a div whose class includes `rounded-xl`; canvas buttons `▶ Run`,
  `▶ Start`, `⏹ Stop`, and `▭ Area` (exact suffix match when inactive); the join modal's `Join`
  button (`trim() === "Join"`), the landing pill `Have a workshop code?`, and `Join my team`;
  the roster test ids `roster-popover`/`roster-row`/`you-chip`; the idea textarea placeholder
  contains `your idea`; the box footer token text contains `tok`. All were re-verified after the
  enterprise UI makeover (76/75-equivalent behavior — header extraction kept every marker).

## Conventions & gotchas

- **Adding a new box type:** see `docs/BOX_TYPES.md` and `docs/course/05_how_to_build_a_box.md`.
- **Agent box (🤖, first worker in the palette):** users type a task and Run — the LLM acts as an
  autonomous controller that manipulates the BOARD: each controller turn returns exactly ONE JSON
  action (`add_box` / `connect` / `run_box` / `finish`), executed with the regular store actions,
  so the boxes an agent creates are ordinary boxes everyone can edit afterwards. Loop lives in
  `boardStore.ts` (`runAgentLoop`, invoked from the `boxType === "agent"` branch of `runBox` — it
  manages its own status/inputs and bypasses the shared gathering); protocol/inventory/layout in
  `client/src/lib/agent.ts` (pure, unit-tested; `AGENT_CREATABLE_TYPES` whitelist = idea research
  summarize prd devplan slides code ui — never image/documents/cartoon/stitch/agent); UI (task
  textarea + live `agentSteps` timeline + ⏹ Stop so the loop halts between turns) in `BoxNode.tsx`.
  Running a box from the agent is a plain `await runBox(boxId)` — the target box's status/output is
  read back after. Budget: `MAX_AGENT_TURNS` (12) with a forced wrap-up on the last turn; 2
  consecutive unparseable replies are coached then the raw reply is salvaged as the answer, so a
  weak model degrades to "honest free text" instead of hanging. Stop is cooperative:
  `agentCancelled` module Set checked before each turn — an in-flight LLM call/run always
  completes. Steps persist in `boxData.agentSteps` (Firestore-safe: no `undefined` values —
  `detail`/`boxId` optional only when present). Token accounting reuses the standard ledger with
  `boxType: "agent"` (cumulative on the box). Multiplayer: another client sees the log grow via
  snapshots but a mid-run reload of the runner just stops the loop (run-like other boxes).
- **Collaboration boxes (note / label / timer) are standalone:** category `"collab"`, `hasAI:
  false`, and no connection handles, no Run button, no ⚙ panel — gate all of those in
  `BoxNode.tsx` on `!isUtility` and keep the `runBox` early-return guard in `boardStore.ts`.
  **Note and label render as annotations, not box cards:** BoxNode early-returns custom JSX for
  them (post-it paper `.note-node` / floating chip `.label-node`, styles in `client/src/index.css`,
  hover/selected ✕ delete instead of the header ✕). The timer is the only collab box that still
  uses the standard card. Early returns sit after all hooks — keep every hook above them.
  **Timer sync rule:** only state *transitions* (start/pause/resume/stop/reset) write to the
  store; the countdown display is always derived locally from `timerStartedAt`/`timerRemainingMs`
  (see `client/src/lib/timer.ts`) on a per-box 250ms interval — **never write per tick** or the
  save/snapshot machinery will flood. **Editor surfaces inside nodes** (the note textarea, label
  input, idea textarea) must carry the `nodrag` (+ `nowheel` where scrollable) class or React
  Flow drags the node while the user types. **Canvas zoom vs. box scroll:** the `<ReactFlow>`
  in `Canvas.tsx` sets `noWheelClassName="react-flow__node"`, so React Flow treats every node as a
  no-wheel zone — trackpad scroll/pinch over a box never zooms the canvas (it would fight the
  box's own scrolling); zooming still works over empty canvas space. Keep this prop if you add
  scrollable surfaces inside nodes.
- **Role filter (palette profiles):** each box type carries `roles: BoxRole[]`
  (`everyone`/`designer`/`developer`/`product`) in `client/src/types.ts`; the role chips in
  `Sidebar.tsx` filter which boxes appear in the "Add Box" palette. This is a discovery-only label —
  a pure UI filter, never a permission. Add sensible `roles` tags when adding a box; see
  `docs/BOX_TYPES.md`.
- **Documents box (📎, input category):** multi-file upload (click or drag & drop) whose extracted
  text becomes the box's output for downstream prompts. All logic lives in
  `client/src/lib/documents.ts` (unit-tested): txt/md/csv/json are read as text directly; **PDF**
  uses `pdfjs-dist` and **DOCX** uses `mammoth`, both **lazy-imported** so neither (~0.5MB each)
  touches the main bundle until that file type is uploaded. pdf.js's worker is loaded via
  `import("pdfjs-dist/build/pdf.worker.min.mjs?url")` — that needs `client/src/vite-env.d.ts`
  (`/// <reference types="vite/client" />`) for TS and works in both dev and build. **Budgets:**
  extracted text is capped at 100k chars per document and 400k chars per box (`clampDocText` /
  `remainingDocBudget`) so the board doc stays under Firestore's 1MB limit; entries that fail
  extraction are kept with an `error` message instead of being dropped. **`BoxDocument` fields are
  always defined** (no `undefined`) — Firestore rejects `undefined` nested anywhere in a value.
  The raw file is uploaded best-effort to Storage at `boards/{boardId}/documents/{boxId}/…`
  (`uploadDocumentToStorage`, rules added to `storage.rules` — **deploy rules** for it to work);
  the extracted text always lives in `boxData.documents`, so prompts, persistence, and cross-user
  sync work even when the upload fails (signed-out local mode). Downstream integration is one line
  in `runBox`: a source box with documents contributes `buildDocumentsOutput()` (each doc labeled
  `=== filename ===`) instead of `getBoxOutput()` — reference with `{{inputs}}`, `{{Box Name}}`, or
  `{{input_N}}` like any input. The E2E "TD" tests cover the flow, using a page-level fetch
  intercept of `/api/generate` to assert the labeled doc text reaches the connected box's prompt
  deterministically (mocked response — restore `window.fetch` afterwards so later tests hit the
  real API).
- **Landing page:** the logged-out entry is a full marketing page in
  `client/src/components/landing/` (`LandingPage.tsx` composes `LandingNav`, `LandingHero`,
  `LandingHowItWorks`, `LandingFeatures`, `LandingBoxes`, `LandingRoles`, `LandingCTA`,
  `LandingFooter`). It reuses `BOX_TYPES` for the box showcase, uses a `Reveal` scroll-fade wrapper
  (`useReveal.ts`), and keeps the dark indigo/cyan theme from `index.css` (`.landing-bg`,
  `.gradient-text`, `.glass-card`). `App.tsx` renders it when `!user`.
- **Code editor:** the Code / UI / Stitch boxes use an editable CodeMirror 6 editor
  (`client/src/components/CodeEditor.tsx`, `@uiw/react-codemirror` + `@codemirror/lang-javascript`
  + `@uiw/codemirror-theme-vscode`). It is **lazy-loaded** via `React.lazy` in `BoxNode.tsx` so
  CodeMirror (~500KB) is only fetched when a code box's Code tab opens. Edits call
  `updateBoxData(id, { code })` (Firestore save is already debounced 1s in `boardStore.ts`), so
  edits persist and the iframe preview reflects them live. A **⛶ Maximise** button on code boxes
  opens `client/src/components/CodeModal.tsx` — a full-screen split view (editable code left, live
  preview right) rendered via `createPortal` to `document.body` so it escapes React Flow's
  transformed node container. Both `CodeEditor` and `CodeModal` are lazy-loaded.
- **Real-project preview (Code box):** the `code` box type previews generated code as a **real
  React project** via Sandpack (`@codesandbox/sandpack-react`, `client/src/components/SandpackPreview.tsx`,
  lazy-loaded) using the lightweight **`react` template** (runtime environment — the heavier
  `vite-react` template fails to connect its bundler on localhost). `client/src/lib/project.ts`
  transforms the single generated JSX into a multi-file project: `toSandpackFiles` (for Sandpack:
  `/App.js`, `/index.js`, `/public/index.html`, `/package.json`, `/styles.css`) and `toReactProject`
  (a Vite project for StackBlitz). Both strip the `ReactDOM.createRoot` render call and add a React
  import. The `ui`/`stitch` boxes still use the lightweight CDN iframe preview. An **⚡ Open in
  StackBlitz** button (`@stackblitz/sdk`, `sdk.openProject`) opens the same project in a full IDE.
  `project.ts` is unit-tested in `client/src/lib/project.test.ts`. Note: Sandpack only sizes its
  inner preview to the provider wrapper's height — pass `style={{ height }}` to `SandpackProvider`
  in `SandpackPreview.tsx` (not just to `SandpackPreviewView`), or the preview collapses to a small
  default and the app is clipped to the top of the box. StackBlitz note: `toReactProject` (used by
  `toStackBlitzProject`) must use **non-leading-slash** file paths (`"App.jsx"`, `"index.jsx"`, …)
  because WebContainers throws `path should be a path.relative()'d string, but got "/"` on leading-slash
  keys, which made StackBlitz open blank (code never imported). Sandpack's `toSandpackFiles` still uses
  leading slashes (`/App.js`) — keep the two transforms' path conventions separate.
  **Sandpack stability contract:** `SandpackPreview.tsx` must stay `React.memo`-ized with
  `useMemo`-derived `files`/`options` (keyed on the code string) plus `key={code}` on
  `SandpackProvider`. BoxNode's parents re-render on every store update (presence/cursor snapshots
  ~5/s while the mouse moves, board snapshot echoes, token badges); recreating `files`/`options`
  objects per render made Sandpack restart its bundler in an endless loop under dev StrictMode
  ("preview forever loading", box unstable). Conversely, under StrictMode Sandpack's in-place
  update-on-files-change is broken (after the double effect mount, later updates never reach the
  live sandbox and the preview goes stale), hence `key={code}` remounts the sandbox only when the
  code actually changed. Keep both: the memo for stability, the key for update correctness.
  `CodeModal` additionally debounces the code it feeds the preview (~400ms) so typing doesn't
  re-bundle per keystroke. The preview-loading overlay in BoxNode only applies to the iframe-based
  ui/stitch previews (they post "preview-ready"); Sandpack shows its own loading state.
- **Code box: generated code MUST end up with a default export.** The box's system prompt makes the
  model "define a component called App" but never ask for an `export`. If the generated `App.js`
  has no default export, the Sandpack/StackBlitz entry's `import App from "./App"` resolves to
  `undefined`, and the preview iframe shows Sandpack's overlay **"Element type is invalid ...
  got: object ... mixed up default and named imports"**. `ensureDefaultExport()` in
  `client/src/lib/project.ts` appends `export default App;` (deduped) in both `toSandpackFiles` and
  `toReactProject` so the preview always resolves. Keep that guarantee when changing the transforms.
- **Lazy-load gotcha (shared chunks):** `SandpackPreview.tsx` is lazy-imported from **two** places
  (`BoxNode.tsx` and `CodeModal.tsx`), so Vite bundles it as a **shared chunk** whose module-namespace
  object is re-exported and picked up by the lazy transform as
  `import("./SandpackPreview-<hash>.js").then(c => c.k)` where `c.k` is `{ default: SandpackPreview }`.
  React 19 **always evaluates a lazy to the resolved value's `.default`** (`React.lazy` returns
  `payload._result.default`), so the **bare form is the correct one**:
  `lazy(() => import("./SandpackPreview.js"))`. It resolves to `{ default: Component }` and React
  unwraps the component fine. **Do NOT** wrap the import in `.then((m) => m.default)` — that resolves
  to the *bare component*, and React then reads `{Component}.default` → `undefined`, crashing with
  `"Element type is invalid. Received a promise that resolves to: undefined."` and a white/render-broken
  screen. This `.then()` "fix" regresses BOTH dev and prod even though the pre-fix bundle looked broken
  for other reasons. When a lazy import misbehaves, verify the resolved chunk export (`c.<named>` is
  `{ default: Comp }`) before assuming you must unwrap by hand — a bare `lazy(() => import("..."))`
  is the safe default.
- **Areas (drawn rectangles):** the "▭ Area" tool (floating top-left in `Canvas.tsx`) lets users
  drag a rectangle on empty canvas to create a background grouping region. Areas are React Flow
  nodes of type `"area"` (`AreaNode.tsx`, registered in `Canvas.tsx` nodeTypes) with **`zIndex: -1`
  so they render BELOW all boxes** (React Flow honors per-node zIndex; the selected node is
  elevated +1000, so a selected area's color dots stay reachable). They live in the `nodes` array
  (color in `node.data.fill/border`) — persistence and cross-user sync come free via the normal
  board save/snapshot; `deleteBox(id)` deletes them (no boxData entry). While the tool is active,
  `panOnDrag`/`nodesDraggable` are off and drags on `.react-flow__pane` become a draft rectangle
  (`lib/areas.ts` `normalizeRect`/`isValidAreaSize`, unit-tested; drags <24 units are ignored).
  The palette (`AREA_COLORS` in `types.ts`) is intentionally **very light** (Tailwind -100 fills,
  -200/-300 borders) so areas never compete with boxes on top; the minimap shows areas in their
  border shade. `noWheelClassName="react-flow__node"` covers area nodes too — scroll over an area
  zooms the canvas as over any node.
- **Custom boxes (user-created templates):** users create reusable AI box templates ("✨ New
  Custom Box" in the sidebar) — name, emoji, color, prompt template, system prompt. Definitions
  are saved per-user at `users/{uid}/boxes/{boxId}` (owner-only rules; `userBoxesStore.ts` loads
  them on login, `lib/customBoxes.ts` holds the pure validation/normalization, unit-tested).
  **Instantiation copies, not references:** `addCustomBox(def)` in `boardStore` creates a
  `custom`-type node whose `data.customLabel/customIcon/customColor` and `boxData.prompt/
  systemPrompt` are copied from the definition — so deleting a saved template never affects boxes
  already on boards, and runBox falls through to the normal text-AI branch (no special casing).
  BoxNode merges the static `BOX_TYPES.custom` fallback with the per-node overrides; the Sidebar
  excludes the static `custom` entry from the palette and renders the user's definitions instead.
  Firestore rules for the `boxes` subcollection live under `match /users/{uid}/boxes/{boxId}` —
  remember to deploy rules (`firebase deploy --only firestore:rules`) when they change; the E2E
  writes were denied until the rules were live.
- **Workshops / facilitator / guests:** `facilitators/{uid}` marker docs mirror `admins/{uid}`
  (self-read only; granted via `POST /api/admin/roles`, admin-only, functions — 501 locally).
  The Facilitator Dashboard (`FacilitatorBoard.tsx`, header button for admins+facilitators) has
  Templates / Workshops / Teams tabs: templates are ordinary boards flagged `isTemplate`
  (`listBoards` excludes them from the regular board list), workshops live at `workshops/{id}`,
  and a team is created by COPYING a template board (`buildTeamBoard` in `lib/workshop.ts`) with
  `{workshopId, boardId, facilitatorUid, maxMembers: 5}` at `teams/{id}`. Seat codes live at the
  **top-level `codes/{code}`** (`{code, teamId, workshopId, uid?, claimed?}`) — top level so the
  join endpoint fetches by id with NO query/index (a collection-group query would need an index
  you cannot create without the console). **Guests:** the landing shows "🎟️ Have a workshop
  code?" → `POST /api/workshop/join { code }` (functions only) mints a Firebase **custom token**
  for a durable uid — first use creates the auth user and claims the code, later uses return a
  token for the SAME uid (codes are effectively bearer credentials), so guests keep their
  identity/boards across devices. Guests then pick a name (email optional, never for login) via
  `GuestProfileModal`, get added to the team board via `memberUids` (new BoardDoc field;
  `listSharedBoards(email, uid)` merges the email and memberUids queries), and can create their
  own boards (guests skip the auto-"My First Board" creation — no auth email). The local dev
  server PROXIES `/api/workshop/join` to the deployed function (Admin SDK needed). **Critical
  IAM gotcha:** custom-token minting failed with `iam.serviceAccounts.signBlob` denied until the
  project granted `roles/iam.serviceAccountTokenCreator` to the functions runtime service accounts
  (done once via `cloudresourcemanager setIamPolicy`; `saveBoard` must also carry
  `isTemplate`/`teamId`/`memberUids` or template flags are silently dropped).
- **Presence & the board roster:** `boards/{id}/presence/{uid}` docs power live cursors
  (`Cursors.tsx`) and the header roster (`PresenceRoster.tsx`). Cursor moves are throttled to one
  write per 200ms; a **heartbeat in `boardStore.ts` re-stamps `lastActive` every 15s** while a
  board is open (started in `subscribeToBoardUpdates`, cleared in `unsubscribeFromBoard`) so users
  who are online but idle stay listed — `subscribeToPresence` filters out entries stale for >30s,
  so without the heartbeat idle users would vanish from the roster. Heartbeat-only users carry
  `hasCursor: false` (PresenceUser) and `Cursors.tsx` skips them, so no stray cursor renders at
  (0,0). The roster popover (`PresenceRoster.tsx`, test ids `roster-popover`/`roster-row`/
  `you-chip`) shows online users (with a "you" marker) plus board collaborators who are offline —
  grouping logic is the pure `groupRoster()` in `client/src/lib/presence.ts` (unit-tested).
- **Client Firebase config** lives in `client/src/lib/firebase.ts` (hardcoded `firebaseConfig`).
  For open hosting, prefer `VITE_FIREBASE_*` env vars at build time (see `docs/OSS_READINESS.md`).
- **Deploying:** follow `docs/DEPLOYMENT.md` or the `ai-canva-deploy` skill
  (`.dsh/skills/ai-canva-deploy/SKILL.md`). Requires Firebase CLI logged in and real API keys
  (Ollama, optionally fal.ai + Google Stitch).
- **Keep `server/` and `functions/` API logic in sync** — they are intentionally duplicated.

## dsh GUI plugins

`dsh-plugins/` hosts out-of-tree plugins for the **DeepSeek Harness Web GUI** (the harness this
agent runs in — `dsh web`, profile at `~/.dsh/profiles/web`). These are NOT part of the ai-canva
app; the directory just lives in this repo so the plugins stay under version control.

- **`dsh-plugins/session-monitor/`** — floating **Sessions Monitor** window (contributed into the
  harness's additive `shell.overlay` slot): live list of every open session with pulsing blue dots
  + sweeping underlines for running sessions (subagent sessions included, grouped under their
  parent — the sidebar hides those), amber pulsing dots for sessions blocked on the user
  (approval / plan review / question), green pop-in for finished-but-unopened sessions, todo
  progress bars, a completion chime + attention sound (Web Audio, armed on first click, mutable
  via the header speaker button), collapse to a status pill, and click-to-open navigation.
- **Anatomy of a client plugin** (hand-written, no build step): `package.json` with
  `dsh.client: {platform: "web", inject: [...]}` + `exports["./client"]`; `lib/index.js` = node
  half (empty `apply()` so the row exists in the host Loader); `lib/client.js` = browser bundle in
  the `window.__ModuleLoader__.load({id, factory})` classic-script format, requiring only shell
  externals (`react`, `@deepseek-ai/dsh-client-runtime/client`); zh/en dictionaries registered via
  `ctx.locale.register(<ns>, {zh, en})` and handed to the component as `t` through the slot
  register option `locale: <ns>`.
- **Installation into the web profile** (new plugins need ALL of these):
  1. symlink the package into `~/.dsh/profiles/node_modules/<pkg>` (the hoisted store the profile
     resolves from — `baseUrl` anchors at the profile dir);
  2. add a row to `~/.dsh/profiles/web/cordis.patch.yml` under `- insert:` (`id: ui-session-monitor`,
     `name: dsh-plugin-session-monitor`);
  3. **restart `dsh web`** (the launcher used here is `ollama launch dsh`, which runs
     `dsh web --patch ~/.ollama/launch/dsh/ollama.cordis.yml`) — the client-modules scan caches
     package verdicts, so plugin-set changes only take effect on restart.
- **Verify without booting:** `node scripts/smoke.mjs` from the plugin dir (registers the factory
  like the browser module loader, runs `apply()` against a fake ctx, server-renders with the real
  React from the dsh install).
- **Editing an installed plugin:** `lib/client.js` content edits hot-reload into open browsers via
  the always-on client-plugin reload chain (it stat-polls the served bundle file); a plain page
  refresh also picks it up (`/plugins/<id>/client.js` is served no-cache). Restart is only for
  adding/removing plugins or package.json/`dsh.client` changes.

## Docs to keep in mind

- `docs/DEVLOG.md` — **session journal**: newest-first dated entries of what changed, what's in
  flight, next steps. Read at session start (after this file); append an entry per finished unit
  of work. State lives here, knowledge lives in this file.
- `docs/ARCHITECTURE.md` — deep dive into client, backend, and Firebase layers.
- `docs/API.md` — backend endpoints and environment variables.
- `docs/DEPLOYMENT.md` — production deploy steps.
- `docs/course/` — teaching/learning materials (briefs + how-to guides, each also as an HTML
  handout for print/PDF).

## Maintenance rule (IMPORTANT)

**Update this file whenever a feature is implemented or the architecture/conventions change.**
This file is the durable project memory that agents load at the start of every session. When you
add, change, or remove a feature, keep this file in sync in the same change:

- Add/update the box type, endpoint, directory, or command that changed.
- Update the box-type list, architecture notes, or conventions if they changed.
- Keep the "Repository layout" and "Key commands" tables accurate.
- Append a short entry to `docs/DEVLOG.md` (Done / In flight / Next steps).

If a change is too small to warrant a doc update, at least note it here so the knowledge is not
lost. Treat this file as living documentation, not a static snapshot.
