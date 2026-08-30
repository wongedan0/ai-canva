import { describe, expect, it } from "vitest";
import type { BoxDocument } from "../types.js";
import {
  MAX_BOX_DOC_CHARS,
  MAX_DOC_CHARS,
  buildDocumentsOutput,
  clampDocText,
  docExt,
  documentIcon,
  extractDocumentText,
  formatBytes,
  isSupportedDocument,
  makeDocId,
  remainingDocBudget,
} from "./documents.js";

function doc(overrides: Partial<BoxDocument> = {}): BoxDocument {
  return {
    id: "d1",
    name: "spec.txt",
    size: 100,
    ext: "txt",
    url: "",
    text: "hello world",
    chars: 11,
    truncated: false,
    error: "",
    ...overrides,
  };
}

describe("docExt / isSupportedDocument", () => {
  it("extracts lowercase extensions", () => {
    expect(docExt("Report.PDF")).toBe("pdf");
    expect(docExt("notes.md")).toBe("md");
    expect(docExt("noext")).toBe("");
  });

  it("accepts exactly the supported types", () => {
    for (const name of ["a.pdf", "b.txt", "c.md", "d.csv", "e.json", "f.docx"]) {
      expect(isSupportedDocument(name)).toBe(true);
    }
    expect(isSupportedDocument("virus.exe")).toBe(false);
    expect(isSupportedDocument("archive.zip")).toBe(false);
    expect(isSupportedDocument("noext")).toBe(false);
  });
});

describe("formatBytes / documentIcon", () => {
  it("formats human-readable sizes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  it("maps extensions to icons", () => {
    expect(documentIcon("pdf")).toBe("📕");
    expect(documentIcon("docx")).toBe("📘");
    expect(documentIcon("txt")).toBe("📄");
  });
});

describe("buildDocumentsOutput", () => {
  it("returns empty for no documents", () => {
    expect(buildDocumentsOutput(undefined)).toBe("");
    expect(buildDocumentsOutput([])).toBe("");
  });

  it("labels each document by filename", () => {
    const out = buildDocumentsOutput([
      doc({ name: "a.txt", text: "AAA" }),
      doc({ name: "b.md", text: "BBB" }),
    ]);
    expect(out).toBe("=== a.txt ===\nAAA\n\n=== b.md ===\nBBB");
  });

  it("skips documents that failed extraction or have no text", () => {
    const out = buildDocumentsOutput([
      doc({ name: "bad.pdf", text: "", error: "Could not extract" }),
      doc({ name: "good.txt", text: "GOOD" }),
      doc({ name: "empty.txt", text: "" }),
    ]);
    expect(out).toBe("=== good.txt ===\nGOOD");
  });
});

describe("remainingDocBudget / clampDocText", () => {
  it("starts at the box budget and subtracts kept characters", () => {
    expect(remainingDocBudget(undefined)).toBe(MAX_BOX_DOC_CHARS);
    expect(remainingDocBudget([doc({ chars: 400 })])).toBe(MAX_BOX_DOC_CHARS - 400);
  });

  it("never goes below zero", () => {
    expect(remainingDocBudget([doc({ chars: MAX_BOX_DOC_CHARS * 10 })])).toBe(0);
  });

  it("keeps text under the per-document limit untouched", () => {
    const r = clampDocText("short", MAX_BOX_DOC_CHARS);
    expect(r).toEqual({ text: "short", truncated: false });
  });

  it("truncates to the per-document cap", () => {
    const big = "x".repeat(MAX_DOC_CHARS + 5000);
    const r = clampDocText(big, MAX_BOX_DOC_CHARS);
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBe(MAX_DOC_CHARS);
  });

  it("truncates to a smaller remaining budget", () => {
    const r = clampDocText("x".repeat(5000), 1000);
    expect(r).toEqual({ text: "x".repeat(1000), truncated: true });
  });

  it("returns empty text when the budget is spent", () => {
    const r = clampDocText("anything", 0);
    expect(r).toEqual({ text: "", truncated: true });
  });
});

describe("makeDocId", () => {
  it("embeds a sanitized filename and is unique per call", () => {
    const a = makeDocId("My Report!.pdf", 10);
    const b = makeDocId("My Report!.pdf", 10);
    expect(a).not.toBe(b);
    expect(a).toMatch(/myreport/);
  });
});

describe("extractDocumentText", () => {
  it("reads plain text formats directly", async () => {
    for (const [name, content] of [
      ["note.txt", "plain text"],
      ["readme.md", "# Heading"],
      ["data.csv", "a,b\n1,2"],
      ["cfg.json", '{"x":1}'],
    ] as const) {
      const file = new File([content], name);
      expect(await extractDocumentText(file)).toBe(content);
    }
  });

  it("throws a descriptive error for unsupported types", async () => {
    const file = new File([new Uint8Array([1, 2])], "app.exe");
    await expect(extractDocumentText(file)).rejects.toThrow(/Unsupported file type/);
  });
});