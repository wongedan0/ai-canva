import type { Edge, Node } from "@xyflow/react";
import type { BoxData, NamedInput } from "../types.js";

/**
 * Pure helpers for the Agent box (client/src/store/boardStore.ts runs the loop).
 *
 * The agent completes a task by taking one structured action per LLM turn:
 * create boxes on the board, wire them, run them, and finish with a summary.
 * Everything here is deterministic so it can be unit-tested — the store only
 * orchestrates the loop around these functions.
 */

/** Box types an Agent may create. Upload-based (image/documents), image
 * generation (cartoon), the slow async Stitch path, collaboration boxes, and
 * the agent box itself are all excluded deliberately. */
export const AGENT_CREATABLE_TYPES = [
  "idea",
  "research",
  "summarize",
  "prd",
  "devplan",
  "slides",
  "code",
  "ui",
] as const;
export type AgentCreatableType = (typeof AGENT_CREATABLE_TYPES)[number];

export function isAgentCreatableType(t: unknown): t is AgentCreatableType {
  return (
    typeof t === "string" &&
    (AGENT_CREATABLE_TYPES as readonly string[]).includes(t)
  );
}

/** The one action the agent may take per turn. */
export type AgentAction =
  | {
      action: "add_box";
      /** Ref the model will use for later connect/run actions ("" if omitted —
       * the store then synthesizes one like "r1"). */
      ref: string;
      boxType: AgentCreatableType;
      title?: string;
      prompt?: string;
      content?: string;
    }
  | { action: "connect"; from: string; to: string }
  | { action: "run_box"; box: string }
  | { action: "finish"; answer?: string };

export type ParsedAgentAction =
  | { ok: true; action: AgentAction }
  | { ok: false; error: string };

/** Max controller turns (LLM actions) per agent run. */
export const MAX_AGENT_TURNS = 12;
/** Consecutive unparseable replies tolerated before the agent gives up. */
export const MAX_PARSE_RETRIES = 2;
/** How many chars of a box's output are fed back to the controller. */
export const AGENT_OUTPUT_CLIP = 1200;
/** How many chars of an existing box's output appear in the board inventory. */
export const AGENT_INVENTORY_CLIP = 160;
/** How many chars of each connected input appear in the agent's context. */
export const AGENT_INPUT_CLIP = 600;

/** Collapses whitespace and clips a string with an ellipsis. */
export function clip(text: string, max: number): string {
  const flat = (text || "").replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max) + "…" : flat;
}

/**
 * Pulls the first JSON object out of a model reply. Tolerates markdown fences,
 * prose before/after, and JSON nested inside the text.
 */
export function extractActionJson(text: string): unknown | null {
  let jsonText = (text || "").trim();

  // Prefer a ```json / ``` fenced block if present.
  const fence = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) jsonText = fence[1].trim();

  // Otherwise take the outermost {...} span.
  const start = jsonText.indexOf("{");
  const end = jsonText.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  jsonText = jsonText.slice(start, end + 1);

  try {
    const parsed = JSON.parse(jsonText);
    // A one-element array like [{"action":...}] is tolerated — take the
    // first object in it (small models sometimes wrap the action anyway).
    if (Array.isArray(parsed)) {
      return (
        parsed.find((v) => v && typeof v === "object" && !Array.isArray(v)) ??
        null
      );
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Validates + normalizes a model reply into one AgentAction.
 * Never throws — failures come back as { ok: false, error }.
 */
export function parseAgentAction(text: string): ParsedAgentAction {
  const raw = extractActionJson(text);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "Reply was not a JSON object." };
  }
  const obj = raw as Record<string, unknown>;
  const kind = typeof obj.action === "string" ? obj.action : "";
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

  if (kind === "add_box") {
    if (!isAgentCreatableType(obj.boxType)) {
      return {
        ok: false,
        error:
          "add_box needs a supported boxType (one of: " +
          AGENT_CREATABLE_TYPES.join(", ") +
          ").",
      };
    }
    return {
      ok: true,
      action: {
        action: "add_box",
        // Missing/blank ref is tolerated — the store synthesizes one.
        ref: str(obj.ref),
        boxType: obj.boxType,
        title: str(obj.title) || undefined,
        prompt: typeof obj.prompt === "string" ? obj.prompt.trim() : undefined,
        content:
          typeof obj.content === "string" ? obj.content.trim() : undefined,
      },
    };
  }

  if (kind === "connect") {
    const from = str(obj.from);
    const to = str(obj.to);
    if (!from || !to) {
      return { ok: false, error: "connect needs both 'from' and 'to'." };
    }
    return { ok: true, action: { action: "connect", from, to } };
  }

  if (kind === "run_box") {
    const box = str(obj.box);
    if (!box) return { ok: false, error: "run_box needs a 'box' ref or title." };
    return { ok: true, action: { action: "run_box", box } };
  }

  if (kind === "finish") {
    return { ok: true, action: { action: "finish", answer: str(obj.answer) } };
  }

  return {
    ok: false,
    error:
      "Unknown action '" +
      (kind || "(missing)") +
      "'. Expected add_box, connect, run_box or finish.",
  };
}

/** Short human label for the action (shown as the step log line). */
export function describeAction(a: AgentAction): string {
  switch (a.action) {
    case "add_box":
      return `Create ${a.boxType} box` + (a.title ? ` "${a.title}"` : "");
    case "connect":
      return `Connect "${a.from}" → "${a.to}"`;
    case "run_box":
      return `Run box "${a.box}"`;
    case "finish":
      return "Finish";
  }
}

/** Snapshot of the board shown to the agent each turn (compact text). */
export function buildBoardInventory(
  nodes: Node[],
  edges: Edge[],
  boxData: Record<string, BoxData>
): string {
  const lines: string[] = [];
  const titleOf = (n: Node) => (n.data?.title as string) || "Unnamed";

  for (const n of nodes) {
    // Areas aren't boxes; other agents are off-limits and would only tempt
    // the model to run them — leave both out of the inventory.
    if (n.type === "area" || n.type === "agent") continue;
    const d = boxData[n.id];
    if (!d) continue;
    const out = clip(d.output || d.content, AGENT_INVENTORY_CLIP);
    lines.push(
      `- "${titleOf(n)}" [${n.type}] status=${d.status || "idle"}` +
        (out ? ` — out: ${out}` : "")
    );
  }

  const edgeLines = edges
    .map((e) => {
      const s = nodes.find((n) => n.id === e.source);
      const t = nodes.find((n) => n.id === e.target);
      if (!s || !t || s.type === "agent" || t.type === "agent") return null;
      return `- "${titleOf(s)}" → "${titleOf(t)}"`;
    })
    .filter((l): l is string => !!l);

  if (lines.length === 0) return "(the board is empty)";
  if (edgeLines.length > 0) {
    lines.push("Connections:", ...edgeLines.slice(0, 16));
  }
  return lines.join("\n");
}

export interface AgentTurnContext {
  task: string;
  /** Optional extra guidance typed by the user in the agent's prompt field. */
  guidance?: string;
  /** Upstream boxes wired into the agent (same NamedInput gathering as boxes). */
  inputs: NamedInput[];
  inventory: string;
  /** Refs the agent currently knows about: ref → "title" (type). */
  refs: Record<string, string>;
  /** Human-readable lines of the steps taken so far. */
  steps: string[];
  /** Result of the previous action (or a startup note). */
  lastResult: string;
  /** When true the budget is spent — force a finish. */
  wrapUp?: boolean;
}

/** Builds the user message for one controller turn. */
export function buildTurnPrompt(ctx: AgentTurnContext): string {
  const parts: string[] = [];
  parts.push(`## Task\n${ctx.task.trim()}`);
  if (ctx.guidance && ctx.guidance.trim()) {
    parts.push(`## Extra guidance from the user\n${ctx.guidance.trim()}`);
  }
  if (ctx.inputs.length > 0) {
    parts.push(
      "## Content from boxes connected to you\n" +
        ctx.inputs
          .map((i) => `- ${i.name}: ${clip(i.output, AGENT_INPUT_CLIP)}`)
          .join("\n")
    );
  }
  parts.push(`## Current board\n${ctx.inventory}`);
  if (Object.keys(ctx.refs).length > 0) {
    parts.push(
      "## Boxes you created this run (ref → box)\n" +
        Object.entries(ctx.refs)
          .map(([ref, label]) => `- ${ref} → ${label}`)
          .join("\n")
    );
  }
  if (ctx.steps.length > 0) {
    parts.push(`## Steps taken so far\n${ctx.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`);
  }
  parts.push(`## Result of your last action\n${ctx.lastResult}`);
  if (ctx.wrapUp) {
    parts.push(
      'You have reached the action budget. Respond with ONLY {"action":"finish","answer":"..."} and summarize what was built and the key results.'
    );
  } else {
    parts.push(
      "Respond with the next single JSON action (exactly one JSON object, nothing else)."
    );
  }
  return parts.join("\n\n");
}

/** Layout for boxes the agent creates: a grid to the right of the agent box. */
export const AGENT_CHILD_W = 440;
export const AGENT_CHILD_H = 440;
export const AGENT_CHILD_GAP = 48;
export const AGENT_CHILD_COLS = 3;

export function nextAgentChildPosition(
  agentPos: { x: number; y: number },
  agentWidth: number,
  index: number
): { x: number; y: number } {
  const col = index % AGENT_CHILD_COLS;
  const row = Math.floor(index / AGENT_CHILD_COLS);
  return {
    x: agentPos.x + agentWidth + AGENT_CHILD_GAP + col * (AGENT_CHILD_W + AGENT_CHILD_GAP),
    y: agentPos.y + row * (AGENT_CHILD_H + AGENT_CHILD_GAP),
  };
}