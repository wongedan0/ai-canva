import { describe, expect, it } from "vitest";
import {
  AGENT_CHILD_GAP,
  AGENT_INVENTORY_CLIP,
  buildBoardInventory,
  buildTurnPrompt,
  clip,
  describeAction,
  extractActionJson,
  isAgentCreatableType,
  MAX_AGENT_TURNS,
  nextAgentChildPosition,
  parseAgentAction,
} from "./agent.js";
import type { BoxData, BoxType, NamedInput } from "../types.js";
import { BOX_TYPES } from "../types.js";
import type { Edge, Node } from "@xyflow/react";

function node(id: string, type: string, title: string, extra: Partial<Node> = {}): Node {
  return { id, type, position: { x: 0, y: 0 }, data: { title, boxType: type }, ...extra };
}

function emptyData(): BoxData {
  return {
    content: "",
    prompt: "",
    systemPrompt: "",
    output: "",
    status: "idle",
  };
}

describe("extractActionJson", () => {
  it("parses a bare JSON object", () => {
    const out = extractActionJson('{"action":"finish","answer":"done"}');
    expect(out).toEqual({ action: "finish", answer: "done" });
  });

  it("parses JSON inside a markdown fence", () => {
    const out = extractActionJson('```json\n{"action":"finish"}\n```');
    expect((out as { action: string }).action).toBe("finish");
  });

  it("parses JSON wrapped in prose", () => {
    const out = extractActionJson('Sure! Here is my action:\n{"action":"run_box","box":"r1"}\nThanks.');
    expect((out as { action: string; box: string }).box).toBe("r1");
  });

  it("returns null for non-JSON text", () => {
    expect(extractActionJson("I will research this tomorrow.")).toBeNull();
    expect(extractActionJson("")).toBeNull();
  });

  it("tolerates a one-element array of actions, rejects multi/broken JSON", () => {
    expect(extractActionJson('[{"action":"finish"}]')).toEqual({ action: "finish" });
    expect(extractActionJson('[{"a":1},{"b":2}]')).toBeNull();
    expect(extractActionJson('{"action": "finish", ')).toBeNull();
  });
});

describe("parseAgentAction", () => {
  it("accepts add_box with all fields", () => {
    const parsed = parseAgentAction(
      '{"action":"add_box","ref":"r1","boxType":"research","title":"Market research","prompt":"Research {{inputs}}"}'
    );
    expect(parsed).toEqual({
      ok: true,
      action: {
        action: "add_box",
        ref: "r1",
        boxType: "research",
        title: "Market research",
        prompt: "Research {{inputs}}",
        content: undefined,
      },
    });
  });

  it("tolerates a missing ref on add_box", () => {
    const parsed = parseAgentAction('{"action":"add_box","boxType":"code"}');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.action.action).toBe("add_box");
      expect((parsed.action as { ref: string }).ref).toBe("");
    }
  });

  it("rejects add_box with a non-whitelisted boxType", () => {
    expect(parseAgentAction('{"action":"add_box","boxType":"agent"}').ok).toBe(false);
    expect(parseAgentAction('{"action":"add_box","boxType":"stitch"}').ok).toBe(false);
    expect(parseAgentAction('{"action":"add_box","boxType":"cartoon"}').ok).toBe(false);
    expect(parseAgentAction('{"action":"add_box"}').ok).toBe(false);
  });

  it("validates connect endpoints", () => {
    expect(parseAgentAction('{"action":"connect","from":"r1","to":"r2"}').ok).toBe(true);
    expect(parseAgentAction('{"action":"connect","from":"r1"}').ok).toBe(false);
  });

  it("validates run_box and unknown actions", () => {
    expect(parseAgentAction('{"action":"run_box","box":"Ideas"}').ok).toBe(true);
    expect(parseAgentAction('{"action":"run_box"}').ok).toBe(false);
    const unknown = parseAgentAction('{"action":"delete_everything"}');
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error).toContain("Unknown action");
  });

  it("accepts finish with an answer and reports unparseable replies", () => {
    expect(parseAgentAction('{"action":"finish","answer":"Done!"}')).toEqual({
      ok: true,
      action: { action: "finish", answer: "Done!" },
    });
    const bad = parseAgentAction("no json at all");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("not a JSON object");
  });
});

describe("describeAction", () => {
  it("labels each action type", () => {
    expect(
      describeAction({ action: "add_box", ref: "r1", boxType: "slides", title: "Deck" })
    ).toBe('Create slides box "Deck"');
    expect(describeAction({ action: "connect", from: "r1", to: "r2" })).toBe('Connect "r1" → "r2"');
    expect(describeAction({ action: "run_box", box: "r1" })).toBe('Run box "r1"');
    expect(describeAction({ action: "finish" })).toBe("Finish");
  });
});

describe("buildBoardInventory", () => {
  it("returns a placeholder for an empty board", () => {
    expect(buildBoardInventory([], [], {})).toBe("(the board is empty)");
  });

  it("lists boxes with type, status and a clipped output", () => {
    const data = emptyData();
    data.output = "A".repeat(300);
    data.status = "done";
    const inv = buildBoardInventory([node("n1", "research", "Research Box")], [], { n1: data });
    expect(inv).toContain('"Research Box" [research] status=done');
    expect(inv).toContain("…");
    expect(inv.length).toBeLessThan("A".repeat(300).length);
  });

  it("hides area and other agent boxes and lists connections", () => {
    const nodes: Node[] = [
      node("a1", "idea", "Idea Box"),
      node("ar", "area", "Zone"),
      node("ag", "agent", "Agent Box"),
      node("r1", "research", "Research Box"),
    ];
    const edges: Edge[] = [
      { id: "e1", source: "a1", target: "r1" } as Edge,
    ];
    const data = emptyData();
    data.content = "hello";
    const inv = buildBoardInventory(nodes, edges, {
      a1: data,
      ar: emptyData(),
      ag: emptyData(),
      r1: emptyData(),
    });
    expect(inv).toContain("Idea Box");
    expect(inv).toContain("Research Box");
    expect(inv).not.toContain("Zone");
    expect(inv).not.toContain("Agent Box");
    expect(inv).toContain('"Idea Box" → "Research Box"');
  });
});

describe("buildTurnPrompt", () => {
  const base = {
    task: "Build a landing page pitch",
    inputs: [] as NamedInput[],
    inventory: "(empty)",
    refs: {} as Record<string, string>,
    steps: [] as string[],
    lastResult: "(none)",
  };

  it("includes the task and the next-action instruction", () => {
    const p = buildTurnPrompt({ ...base });
    expect(p).toContain("Build a landing page pitch");
    expect(p).toContain("Respond with the next single JSON action");
    expect(p).not.toContain("action budget");
  });

  it("includes guidance, connected inputs, refs and step history", () => {
    const p = buildTurnPrompt({
      ...base,
      guidance: "Keep it playful",
      inputs: [{ name: "Idea Box", output: "Coffee shop" }],
      refs: { r1: '"Research" (research)' },
      steps: ['Create research box "Research"', 'Run box "r1"'],
      lastResult: "Output (521 chars): ….start of output…",
    });
    expect(p).toContain("Keep it playful");
    expect(p).toContain("Idea Box: Coffee shop");
    expect(p).toContain("r1 → ");
    expect(p).toContain("1. Create research box");
    expect(p).toContain("521 chars");
  });

  it("forces a finish when wrapping up", () => {
    const p = buildTurnPrompt({ ...base, wrapUp: true });
    expect(p).toContain('"action":"finish"');
    expect(p).not.toContain("Respond with the next single JSON action");
  });
});

describe("nextAgentChildPosition", () => {
  it("lays children out in a grid to the right of the agent", () => {
    const pos = { x: 100, y: 200 };
    const first = nextAgentChildPosition(pos, 400, 0);
    expect(first.x).toBe(100 + 400 + AGENT_CHILD_GAP);
    expect(first.y).toBe(200);

    const second = nextAgentChildPosition(pos, 400, 1);
    expect(second.x).toBeGreaterThan(first.x);
    expect(second.y).toBe(first.y);

    const fourth = nextAgentChildPosition(pos, 400, 3); // wraps to a new row
    expect(fourth.y).toBeGreaterThan(first.y);
    expect(fourth.x).toBe(first.x);
  });
});

describe("clip + constants sanity", () => {
  it("clips long text with an ellipsis", () => {
    const long = "  a ".repeat(100);
    expect(clip(long, 10)).toBe("a a a a a …");
    expect(clip("short", 10)).toBe("short");
  });

  it("keeps the inventory clip smaller than the feedback clip", () => {
    expect(AGENT_INVENTORY_CLIP).toBeLessThan(1200);
    expect(MAX_AGENT_TURNS).toBeGreaterThan(0);
  });

  it("every creatable box type exists in BOX_TYPES", () => {
    const types = [
      "idea", "research", "summarize", "prd", "devplan", "slides", "code", "ui",
    ] as BoxType[];
    for (const t of types) {
      expect(isAgentCreatableType(t)).toBe(true);
      expect(BOX_TYPES[t as BoxType]).toBeDefined();
    }
  });
});