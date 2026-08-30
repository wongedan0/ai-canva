# Box types reference

This document describes every box type. Metadata lives in `client/src/types.ts`
(`BOX_TYPES`), rendering in `client/src/components/BoxNode.tsx`, and the "run" behavior in
`client/src/store/boardStore.ts` (`runBox`).

Boxes fall into three categories:

- **Input boxes** (`category: "input"`) — no AI. They seed data into a pipeline.
- **Worker boxes** (`category: "worker"`) — run an AI step (Ollama, fal.ai, or Google Stitch).
- **Collaboration boxes** (`category: "collab"`) — standalone annotation tools with no AI, no
  Run button, no settings panel, and no connection handles.

> A fourth `custom` category is reserved in the sidebar but has no boxes yet ("Add Custom" is
> disabled).

---

## Input boxes

### 💡 Idea — `idea`

Free-text input. No AI. The seed of most pipelines. Its content becomes the output sent to
downstream boxes.

- **Inputs:** none (no target handle).
- **Outputs:** its text content.
- **Settings:** none (input box).

### 🖼️ Image — `image`

Upload an image. It's auto-resized to ≤1024px, compressed to JPEG, and uploaded to Firebase
Storage (if a board is loaded) so it syncs to collaborators. Downstream boxes receive a fetchable
URL.

- **Inputs:** none (no target handle).
- **Outputs:** an image URL (used as `imageData` input by Cartoon boxes).
- **Settings:** none (input box).

### 📎 Documents — `documents`

Upload one or more documents (click or drag & drop; PDF, DOCX, TXT, MD, CSV, JSON). Text is
extracted **in the browser** — plain-text formats are read directly, PDFs via pdf.js and Word
files via mammoth (both loaded on demand, so they don't slow down the app until needed). The
combined, filename-labeled text becomes the box's output, so any connected AI box can use it via
`{{inputs}}`, `{{Box Name}}`, or `{{input_N}}` — e.g. connect Documents → Summarize to condense a
report, or Documents → PRD to turn a spec into a product doc.

- **Inputs:** none (no target handle).
- **Outputs:** every document's extracted text, each labeled `=== filename ===`. Extraction is
  capped at 100k chars per file and 400k chars per box (oversized files are marked *truncated*)
  so boards stay within Firestore's 1MB document limit.
- **Persistence:** the extracted text lives in the board itself (syncs to collaborators and
  survives reloads). The original file is also uploaded to Firebase Storage when signed in
  ("Open original ↗" link); when signed out, only the text is kept.
- **Settings:** none (input box).

---

## Worker boxes

### 🤖 Agent — `agent`

Give the agent a **task** (typed in its box) and click Run: it autonomously completes the task
by using the board as its workspace. Each turn the model returns one structured action —
`add_box` (create a new AI box with a task-specific prompt), `connect` (wire two boxes),
`run_box` (run a box through the normal pipeline and read its output back), or `finish`
(write the final Markdown answer into the box). The step-by-step transcript is shown live in
the box (and synced to collaborators); the boxes it creates are ordinary boxes you can inspect,
rerun, and take over. Runs entirely client-side on top of the regular boxes/`runBox` machinery
— no backend endpoints were added.

- **AI:** Ollama, multiple controller turns (default system prompt = the JSON action protocol).
- **Budget:** 12 controller turns (`MAX_AGENT_TURNS` in `client/src/lib/agent.ts`); the final
  turn forces a wrap-up. Unparseable replies are coached and retried (2×), then the raw reply is
  kept as the answer so the run never hangs. ⏹ Stop halts the loop between turns.
- **Can create:** `idea`, `research`, `summarize`, `prd`, `devplan`, `slides`, `code`, `ui` —
  never upload boxes (Image/Documents), `cartoon`/`stitch` (image/async paths), other agents,
  or itself.
- **Inputs:** connected boxes flow into the agent's context (like `{{inputs}}`); its `content`
  field is the task.
- **Output:** the final Markdown answer (also usable by downstream boxes).
- **Settings:** "Extra guidance for the agent" (the prompt field) + the protocol system prompt
  (advanced). The step transcript persists in `boxData.agentSteps`.
- **Code:** parsing/inventory/layout in `client/src/lib/agent.ts` (unit-tested); the loop in
  `boardStore.ts` (`runAgentLoop`); UI in `BoxNode.tsx` (the `isAgent` branch).
- **Caveat:** the controller is only as good as the model behind `/api/generate` — strict-JSON
  adherence varies by local model, which is why the loop is defensive (retry → coach → salvage).

### 🔍 Research — `research`

Runs an AI prompt over connected inputs and returns structured research findings.

- **AI:** Ollama (text).
- **Inputs:** any connected box; defaults to `{{input_1}}`.
- **Output:** Markdown text.

### 📋 Summarize — `summarize`

Combines multiple upstream inputs into a concise AI summary.

- **AI:** Ollama (text).
- **Inputs:** multiple; defaults to `{{inputs}}`.
- **Output:** Markdown text.

### 📄 PRD — `prd`

Generates a Product Requirements Document — product overview, problem statement, target users,
core features with priorities, user stories, UI/UX guidelines, technical requirements, and
success metrics. Ideal input for the Code box.

- **AI:** Ollama (text).
- **Inputs:** typically Research; defaults to `{{inputs}}`.
- **Output:** Markdown document.

### 🗺️ Dev Plan — `devplan`

Transforms a PRD into a short, pragmatic development plan: components to build, state variables,
key functions, and a build order. Best fed by a PRD box, then fed into a Code box.

- **AI:** Ollama (text).
- **Inputs:** typically a PRD; defaults to `{{inputs}}`.
- **Output:** Markdown list.

### 🎨 Cartoon Profile — `cartoon`

Generates a cartoon avatar via fal.ai.

- **AI:** fal.ai (image).
- **Inputs:**
  - An **Image** box connected → image-to-image (`fal-ai/qwen-image-edit`).
  - Otherwise, an **Idea** box → text-to-image fallback (`fal-ai/flux/schnell`).
- **Output:** a generated image URL (`outputImage`).
- **Settings:** a "Prompt Template (text-to-image fallback)" — only used when no image is
  connected. No system prompt.

### 📊 Slides — `slides`

Generates a visual pitch deck. Ollama returns a JSON array; the app parses it into navigable
slides with prev/next and speaker notes.

- **AI:** Ollama (text).
- **Inputs:** `{{inputs}}`.
- **Output:** slides parsed from a JSON array of
  `{ title, bullets: string[], notes? }`.
- **Settings:** the prompt defines the slide structure; the model must output only a valid JSON
  array.

### 💻 Code — `code`

Generates a working React prototype. Output is validated to contain a `ReactDOM.createRoot(...)`
render call, wrapped in a self-contained HTML page, and previewed in a sandboxed iframe with
Code/Preview tabs, Copy, and Save (download).

- **AI:** Ollama (text).
- **Inputs:** `{{inputs}}` (best from PRD / Dev Plan).
- **Output:** `code` (the JSX) + `output` (the raw response).
- **Constraints:** no imports; use the `React.*` API; define an `App` component; keep mock data
  small (3–5 items).

### ✨ UI Design — `ui`

Generates polished, production-quality React UIs using **Tailwind CSS classes** + Google Fonts
(production-quality, Google Stitch style). Previewed in an iframe with Tailwind loaded.

- **AI:** Ollama (text).
- **Inputs:** `{{inputs}}`.
- **Output:** `code` (Tailwind-based JSX) + preview.
- **Settings:** same as Code box; system prompt emphasizes visual polish.

### 🧵 Stitch UI — `stitch`

Generates a UI screen using **Google Stitch** and returns polished, production-quality HTML
directly.

- **AI:** Google Stitch.
- **Inputs:** `{{inputs}}`.
- **Output:** `output` + `code` (the raw HTML), previewed directly in the iframe.

---

## Collaboration boxes

Standalone annotation tools shown in the sidebar's "Collaboration" section. They have **no AI,
no Run button, no ⚙ settings panel, and no connection handles** — they never join a pipeline.
`runBox` early-returns for them as a guard. Their content lives in the regular `boxData` and syncs
to every viewer through the board document snapshot, like all boxes.

### 🗒️ Note — `note`

A post-it style note for team communication. Anyone can write; everyone on the board sees edits
live. Notes render as **annotation paper, not a box card** — no header bar or border chrome, just
a slightly rotated yellow sticky with a hover/selected ✕ delete button.

- **Fields:** `content` (the note text), `authorEmail` / `authorName` (captured once at creation,
  shown under the note).
- **Interaction:** type in the note; edits save through the normal debounced board save.

### 🏷️ Label — `label`

A small colored text pill for annotating areas of the board. Labels render as a **floating chip
with no card frame at all** — the pill *is* the node, with a hover/selected ✕ delete button.

- **Fields:** `content` (label text), `labelColor` (one of `LABEL_COLORS` in `types.ts`).
- **Interaction:** click the pill to edit the text; select the box to reveal five color dots.

### ⏱️ Timer — `timer`

A shared countdown clock. Anyone can start/pause/stop/reset it; every viewer sees the same time.

- **Fields:** `timerDurationMs`, `timerStatus` (`idle` / `running` / `paused` / `stopped`),
  `timerStartedAt` (epoch ms), `timerRemainingMs` (frozen on pause/stop), `timerStartedBy`.
- **Sync design (important):** only state *transitions* write to the store. While running, every
  viewer locally computes `remaining = timerRemainingMs − (now − timerStartedAt)` on a 250ms
  interval — there are **zero Firestore writes per tick**. The pure logic lives in
  `client/src/lib/timer.ts` (`parseDurationInput`, `formatTimer`, `computeRemainingMs`,
  `isTimerFinished`) and is unit-tested in `timer.test.ts`.
- **At zero:** the digits turn red and pulse with a "⏰ Time's up" banner (visual only — no sound).

---

## Custom boxes

The `custom` type is not a built-in — it is what **user-created templates** instantiate as.
Users build their own reusable AI boxes ("✨ New Custom Box" in the sidebar): a name, emoji,
color, and the prompt/system-prompt templates (with the same `{{input_1}}` variables as the
built-ins). Definitions are saved to the user's profile (`users/{uid}/boxes/{boxId}` in
Firestore) and appear in the palette on every board.

- **Semantics:** adding one to a board COPIES the template's prompt, system prompt, icon, and
  color onto the box — so deleting a saved template never affects boxes already on boards.
- **Runtime:** a custom box is a normal AI text box (Run → Ollama → markdown output) with a ⚙
  settings panel for tweaking the instance's prompts.
- **Cleanup:** hover a template in the palette and press ✕ to remove it from your profile.

---

## Prompt template variables

All AI boxes support these in their prompt templates (see `lib/prompts.ts`):

| Variable | Meaning |
|----------|---------|
| `{{Box Name}}` | Output of a connected box matched by its name (case-insensitive). |
| `{{input_1}}` … `{{input_N}}` | Nth connected input, positional. |
| `{{input}}` | Alias for the first input. |
| `{{inputs}}` | All connected inputs, labeled and concatenated. |

## Role tags & the palette filter

Every box type carries `roles: BoxRole[]` (`"everyone" | "designer" | "developer" | "product"`)
used by the sidebar role chips in `client/src/components/Sidebar.tsx`. This is a **discovery-only
label**, not a permission:

- Boxes tagged `"everyone"` (Idea, Research, Summarize) are shared pipeline scaffolding and appear
  in every role view.
- Selecting the **Designer**, **Developer**, or **Product** chip filters the palette to boxes
  tagged with that role — plus all `"everyone"` boxes.
- The selection is persisted per user in `localStorage` (`ai-canva:sidebar-role`) so it acts like a
  lightweight profile. Filtering never hides boxes already on the canvas — it only declutters which
  ones you can add.
- Give a box multiple roles when it spans personas (e.g. `slides: ["product", "designer"]`).

Tagging a box does not affect collaboration, the canvas, or `runBox` — it is purely a UI filter.

## Adding a new box type

1. Add a `BoxType` union member and a `BOX_TYPES` entry in `client/src/types.ts` (including its
   `roles` tags — see above).
2. Register it in `Canvas.tsx` (`nodeTypes`) and the MiniMap color map.
3. Add a render/output branch in `BoxNode.tsx`.
4. Add run behavior in `boardStore.ts` `runBox()` (or route to an existing branch).
5. Add any new backend endpoint in `server/src/index.ts` **and** `functions/src/index.ts`.
6. Update the box-type tables in the README and this document.
