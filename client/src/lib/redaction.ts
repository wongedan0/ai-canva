// client/src/lib/redaction.ts
//
// Helpers for the Privacy Redactor box.
//
// Design (see research report, "Output Format"):
//   - The REDACTED TEXT flows downstream as the box's normal `output`.
//   - The MAPPING (placeholder -> original PII) never leaves this module's
//     memory: it is NOT written to boxData, Firestore or localStorage.
//   - The user can download the mapping once as a .txt file.
//
// Trade-off: the mapping lives only in this browser tab. If the page is
// reloaded or the box is re-run, the previous mapping is gone.

export interface RedactorResult {
  /** The text with PII replaced by placeholders (safe to pass downstream). */
  redactedText: string;
  /** Pretty-printed JSON mapping, or "" when the model returned none. */
  mapping: string;
}

/** In-memory only. Keyed by box id. Never persisted. */
const mappingStore = new Map<string, string>();

/**
 * Split the model's response into redacted text and mapping.
 * Expected format:
 *   REDACTED TEXT:
 *   <text>
 *
 *   MAPPING:
 *   <json>
 * The LAST "MAPPING:" marker is used, so the phrase appearing inside the
 * document itself does not confuse the split.
 */
export function parseRedactorResponse(content: string): RedactorResult {
  const markers = [...content.matchAll(/MAPPING\s*:/gi)];
  const last = markers[markers.length - 1];

  const head = last ? content.slice(0, last.index) : content;
  const tail = last ? content.slice((last.index ?? 0) + last[0].length) : "";

  const redactedText = head.replace(/^\s*REDACTED TEXT\s*:/i, "").trim();
  return { redactedText, mapping: tidyMapping(tail) };
}

/** Strip code fences and pretty-print the JSON; fall back to the raw text. */
function tidyMapping(raw: string): string {
  const cleaned = raw.replace(/```(?:json)?/gi, "").trim();
  if (!cleaned) return "";

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      return JSON.stringify(JSON.parse(cleaned.slice(start, end + 1)), null, 2);
    } catch {
      // Malformed JSON: keep the raw text so the user can still recover it.
    }
  }
  return cleaned;
}

export function setMapping(boxId: string, mapping: string): void {
  if (mapping) mappingStore.set(boxId, mapping);
  else mappingStore.delete(boxId);
}

export function hasMapping(boxId: string): boolean {
  return mappingStore.has(boxId);
}

export function clearMapping(boxId: string): void {
  mappingStore.delete(boxId);
}

/**
 * Download the mapping as a .txt file. Warns the user first because the file
 * contains the original PII.
 */
export function downloadMapping(boxId: string): void {
  const mapping = mappingStore.get(boxId);
  if (!mapping) return;

  const ok = window.confirm(
    "This file contains the ORIGINAL personal information. " +
      "Store it somewhere safe and do not share it. Download now?"
  );
  if (!ok) return;

  const blob = new Blob([mapping], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `redaction-mapping-${new Date().toISOString().slice(0, 10)}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}