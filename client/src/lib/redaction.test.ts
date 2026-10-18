// @vitest-environment jsdom
//
// client/src/lib/redaction.test.ts
//
// Unit tests for the Privacy Redactor helpers. These test OUR code (parsing,
// the in-memory store, the download) with fixed model responses. They do not
// test how well the LLM finds PII; that needs the manual Test 1 / Test 2 runs.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearMapping,
  downloadMapping,
  hasMapping,
  parseRedactorResponse,
  setMapping,
} from "./redaction.js";

// ---------- fixtures ----------

const MODEL_RESPONSE = `REDACTED TEXT:
Hi team, NAME_1 can be reached at EMAIL_1. NAME_2 has the same issue.

MAPPING:
{"NAME_1":"Sarah Chen","EMAIL_1":"sarah.chen@example.com","NAME_2":"Michael Brown"}`;

function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

// ---------- parseRedactorResponse ----------

describe("parseRedactorResponse", () => {
  it("splits a well-formed response into redacted text and mapping", () => {
    const { redactedText, mapping } = parseRedactorResponse(MODEL_RESPONSE);

    expect(redactedText).toBe(
      "Hi team, NAME_1 can be reached at EMAIL_1. NAME_2 has the same issue."
    );
    expect(JSON.parse(mapping)).toEqual({
      NAME_1: "Sarah Chen",
      EMAIL_1: "sarah.chen@example.com",
      NAME_2: "Michael Brown",
    });
  });

  it("keeps the mapping out of the redacted text (nothing flows downstream)", () => {
    const { redactedText } = parseRedactorResponse(MODEL_RESPONSE);

    expect(redactedText).not.toContain("MAPPING");
    expect(redactedText).not.toContain("Sarah Chen");
    expect(redactedText).not.toContain("sarah.chen@example.com");
  });

  it("pretty-prints the mapping JSON", () => {
    const { mapping } = parseRedactorResponse(MODEL_RESPONSE);
    expect(mapping).toContain('\n  "NAME_1": "Sarah Chen"');
  });

  it("strips ```json code fences around the mapping", () => {
    const response =
      'REDACTED TEXT:\nHello NAME_1\n\nMAPPING:\n```json\n{"NAME_1":"Sarah"}\n```';
    const { redactedText, mapping } = parseRedactorResponse(response);

    expect(redactedText).toBe("Hello NAME_1");
    expect(JSON.parse(mapping)).toEqual({ NAME_1: "Sarah" });
  });

  it("returns the whole text and an empty mapping when there is no MAPPING marker", () => {
    const { redactedText, mapping } = parseRedactorResponse(
      "REDACTED TEXT:\nNothing sensitive here."
    );

    expect(redactedText).toBe("Nothing sensitive here.");
    expect(mapping).toBe("");
  });

  it("returns an empty mapping when the MAPPING section is blank", () => {
    const { redactedText, mapping } = parseRedactorResponse(
      "REDACTED TEXT:\nhello\n\nMAPPING:\n"
    );

    expect(redactedText).toBe("hello");
    expect(mapping).toBe("");
  });

  it("uses the LAST MAPPING marker, so the word inside the document is preserved", () => {
    const response =
      'REDACTED TEXT:\nThe heading MAPPING: appears in this document.\n\nMAPPING:\n{"NAME_1":"A"}';
    const { redactedText, mapping } = parseRedactorResponse(response);

    expect(redactedText).toBe("The heading MAPPING: appears in this document.");
    expect(JSON.parse(mapping)).toEqual({ NAME_1: "A" });
  });

  it("matches the marker case-insensitively and with a space before the colon", () => {
    const { redactedText, mapping } = parseRedactorResponse(
      'REDACTED TEXT:\nHi NAME_1\n\nmapping :\n{"NAME_1":"Sam"}'
    );

    expect(redactedText).toBe("Hi NAME_1");
    expect(JSON.parse(mapping)).toEqual({ NAME_1: "Sam" });
  });

  it("works when the REDACTED TEXT header is missing", () => {
    const { redactedText, mapping } = parseRedactorResponse(
      'NAME_1 is here\n\nMAPPING:\n{"NAME_1":"Sam"}'
    );

    expect(redactedText).toBe("NAME_1 is here");
    expect(JSON.parse(mapping)).toEqual({ NAME_1: "Sam" });
  });

  it("ignores chatter after the JSON", () => {
    const { mapping } = parseRedactorResponse(
      'REDACTED TEXT:\nHi NAME_1\n\nMAPPING:\n{"NAME_1":"Sam"}\nHope this helps!'
    );

    expect(JSON.parse(mapping)).toEqual({ NAME_1: "Sam" });
  });

  it("keeps malformed JSON as raw text so the user can still recover it", () => {
    const { mapping } = parseRedactorResponse(
      "REDACTED TEXT:\nHi NAME_1\n\nMAPPING:\n{NAME_1: Sam}"
    );

    expect(mapping).toBe("{NAME_1: Sam}");
  });

  it("keeps truncated JSON (no closing brace) as raw text", () => {
    const { mapping } = parseRedactorResponse(
      'REDACTED TEXT:\nHi NAME_1\n\nMAPPING:\n{"NAME_1": "Sam"'
    );

    expect(mapping).toBe('{"NAME_1": "Sam"');
  });

  it("returns an empty-object mapping as '{}' (documents current behaviour)", () => {
    // When no PII is found the model may return {}. The string is non-empty,
    // so the store will hold it and the download button will be enabled.
    const { mapping } = parseRedactorResponse(
      "REDACTED TEXT:\nNothing here.\n\nMAPPING:\n{}"
    );

    expect(mapping).toBe("{}");
  });
});

// ---------- mapping store ----------

describe("mapping store", () => {
  afterEach(() => {
    clearMapping("a");
    clearMapping("b");
  });

  it("starts empty", () => {
    expect(hasMapping("a")).toBe(false);
  });

  it("stores and reports a mapping", () => {
    setMapping("a", '{"NAME_1":"Sam"}');
    expect(hasMapping("a")).toBe(true);
  });

  it("removes a mapping when set to an empty string", () => {
    setMapping("a", '{"NAME_1":"Sam"}');
    setMapping("a", "");
    expect(hasMapping("a")).toBe(false);
  });

  it("clearMapping removes only that box's mapping", () => {
    setMapping("a", "x");
    setMapping("b", "y");
    clearMapping("a");

    expect(hasMapping("a")).toBe(false);
    expect(hasMapping("b")).toBe(true);
  });

  it("keeps boxes independent", () => {
    setMapping("a", "x");
    expect(hasMapping("b")).toBe(false);
  });

  it("never writes the mapping to localStorage or sessionStorage", () => {
    localStorage.clear();
    sessionStorage.clear();

    setMapping("a", '{"NAME_1":"Sarah Chen"}');

    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
});

// ---------- downloadMapping ----------

describe("downloadMapping", () => {
  let createSpy: ReturnType<typeof vi.fn>;
  let revokeSpy: ReturnType<typeof vi.fn>;
  let confirmSpy: ReturnType<typeof vi.spyOn>;
  let clickSpy: ReturnType<typeof vi.spyOn>;
  let downloadedName = "";

  beforeEach(() => {
    downloadedName = "";
    confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    // jsdom does not implement these two.
    createSpy = vi.fn(() => "blob:mock-url");
    revokeSpy = vi.fn();
    (URL as any).createObjectURL = createSpy;
    (URL as any).revokeObjectURL = revokeSpy;

    clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        downloadedName = this.download;
      });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearMapping("box1");
  });

  it("does nothing when the box has no mapping", () => {
    downloadMapping("box1");

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(createSpy).not.toHaveBeenCalled();
    expect(clickSpy).not.toHaveBeenCalled();
  });

  it("warns the user before downloading", () => {
    setMapping("box1", '{"NAME_1":"Sarah Chen"}');
    downloadMapping("box1");

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(String(confirmSpy.mock.calls[0][0])).toMatch(/ORIGINAL personal information/);
  });

  it("does not download when the user cancels the warning", () => {
    confirmSpy.mockReturnValue(false);
    setMapping("box1", '{"NAME_1":"Sarah Chen"}');
    downloadMapping("box1");

    expect(createSpy).not.toHaveBeenCalled();
    expect(clickSpy).not.toHaveBeenCalled();
  });

  it("downloads a dated .txt file containing the mapping", async () => {
    const mapping = '{\n  "NAME_1": "Sarah Chen"\n}';
    setMapping("box1", mapping);
    downloadMapping("box1");

    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(downloadedName).toMatch(/^redaction-mapping-\d{4}-\d{2}-\d{2}\.txt$/);

    const blob = createSpy.mock.calls[0][0] as Blob;
    expect(blob.type).toContain("text/plain");
    expect(await readBlob(blob)).toBe(mapping);
  });

  it("cleans up: revokes the object URL and removes the temporary link", () => {
    setMapping("box1", '{"NAME_1":"Sarah Chen"}');
    downloadMapping("box1");

    expect(revokeSpy).toHaveBeenCalledWith("blob:mock-url");
    expect(document.querySelector("a[download]")).toBeNull();
  });

  it("leaves the mapping in memory after downloading", () => {
    setMapping("box1", '{"NAME_1":"Sarah Chen"}');
    downloadMapping("box1");

    expect(hasMapping("box1")).toBe(true);
  });
});