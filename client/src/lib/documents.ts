import type { BoxDocument } from "../types.js";

/**
 * Documents box logic: which files are supported, how their text is
 * extracted, how the text is budgeted (Firestore's 1MB board-doc limit), and
 * how a box's documents become a single labeled output for prompts.
 *
 * Pure helpers here are unit-tested (`documents.test.ts`); the PDF and DOCX
 * extractors lazy-load their heavy libraries (pdf.js ~400KB, mammoth
 * ~200KB) so they stay out of the main bundle until a user actually uploads
 * that file type — same pattern as the lazy CodeMirror/Sandpack imports.
 */

/** File extensions the Documents box accepts (lowercase, no dot). */
export const SUPPORTED_DOC_EXTS = ["pdf", "txt", "md", "csv", "json", "docx"] as const;

/** Max extracted characters kept per document (~25k tokens). */
export const MAX_DOC_CHARS = 100_000;

/**
 * Max total extracted characters per Documents box. The board doc (with all
 * boxData) must stay under Firestore's 1MB limit, so a box's documents share
 * this budget; later uploads are trimmed to what's left.
 */
export const MAX_BOX_DOC_CHARS = 400_000;

/** Lowercase extension of a filename, without the dot ("" if none). */
export function docExt(name: string): string {
  const i = name.lastIndexOf(".");
  return i === -1 ? "" : name.slice(i + 1).toLowerCase();
}

/** True when the Documents box can handle this filename. */
export function isSupportedDocument(name: string): boolean {
  return (SUPPORTED_DOC_EXTS as readonly string[]).includes(docExt(name));
}

/** Human-readable file size ("1.2 MB"). */
export function formatBytes(n: number): string {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  return (n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + " " + units[i];
}

/** Palette-style icon for a document extension. */
export function documentIcon(ext: string): string {
  switch (ext) {
    case "pdf":
      return "📕";
    case "docx":
      return "📘";
    case "csv":
      return "📈";
    case "json":
      return "🧾";
    case "md":
      return "📝";
    default:
      return "📄";
  }
}

/**
 * Builds the text a Documents box contributes as a downstream input: every
 * successfully extracted document, labeled by filename so prompts can cite
 * sources. Documents that failed extraction (or have no text) are skipped —
 * they would only add noise to a prompt.
 */
export function buildDocumentsOutput(docs: BoxDocument[] | undefined): string {
  if (!docs || docs.length === 0) return "";
  const parts: string[] = [];
  for (const d of docs) {
    if (d.error || !d.text) continue;
    parts.push(`=== ${d.name} ===\n${d.text}`);
  }
  return parts.join("\n\n");
}

/** Characters still available in a box's document budget. */
export function remainingDocBudget(docs: BoxDocument[] | undefined): number {
  const used = (docs || []).reduce((sum, d) => sum + (d.chars || 0), 0);
  return Math.max(0, MAX_BOX_DOC_CHARS - used);
}

/**
 * Caps extracted text to the per-document limit and to the remaining box
 * budget. Returns empty text (truncated) when the budget is already spent.
 */
export function clampDocText(
  text: string,
  budget: number
): { text: string; truncated: boolean } {
  const limit = Math.min(MAX_DOC_CHARS, Math.max(0, budget));
  if (text.length <= limit) return { text, truncated: false };
  return { text: text.slice(0, limit).trimEnd(), truncated: true };
}

/** Stable id for a document entry (filename + size + time). */
export function makeDocId(name: string, size: number): string {
  return `doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}-${size}-${name.replace(/[^a-z0-9]/gi, "").slice(0, 8).toLowerCase()}`;
}

/**
 * Extracts the text content of a supported file, client-side.
 * - txt / md / csv / json — read directly as text.
 * - pdf — pdf.js (lazy-loaded), page by page.
 * - docx — mammoth (lazy-loaded), raw text.
 * Throws on unsupported types or extraction failure; the caller turns the
 * error into a BoxDocument entry so the failure is visible and synced.
 */
export async function extractDocumentText(file: File): Promise<string> {
  const ext = docExt(file.name);
  if (!isSupportedDocument(file.name)) {
    throw new Error(`Unsupported file type ".${ext}" — expected ${SUPPORTED_DOC_EXTS.join(", ")}`);
  }
  if (ext === "pdf") return extractPdfText(file);
  if (ext === "docx") return extractDocxText(file);
  return await file.text();
}

/** PDF text via pdf.js. The worker is loaded as a Vite `?url` asset. */
async function extractPdfText(file: File): Promise<string> {
  const pdfjs = await import("pdfjs-dist");
  const { default: workerUrl } = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

  const data = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    // pdf.js text items carry `hasEOL` — join into real lines so paragraphs
    // survive instead of one long space-less string.
    let line = "";
    const lines: string[] = [];
    for (const item of content.items as Array<{ str?: string; hasEOL?: boolean }>) {
      if (typeof item.str !== "string") continue;
      line += item.str;
      if (item.hasEOL) {
        lines.push(line);
        line = "";
      }
    }
    if (line) lines.push(line);
    pages.push(lines.join("\n"));
    page.cleanup();
  }
  return pages.join("\n\n").trim();
}

/** DOCX text via mammoth's raw-text extraction (lazy-loaded). */
async function extractDocxText(file: File): Promise<string> {
  const mammoth = await import("mammoth");
  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer });
  return result.value.trim();
}