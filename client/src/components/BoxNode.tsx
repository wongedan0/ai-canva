import { memo, useState, useRef, useEffect, lazy, Suspense } from "react";
import { Handle, Position, NodeResizer, type NodeProps } from "@xyflow/react";
import ReactMarkdown from "react-markdown";
import { useBoardStore } from "../store/boardStore.js";
import { useAuthStore } from "../store/authStore.js";
import { BOX_TYPES, LABEL_COLORS } from "../types.js";
import type { BoxType } from "../types.js";
import { wrapCodeInHtml, wrapUIInHtml, downloadHtml, copyToClipboard } from "../lib/code.js";
import {
  DEFAULT_TIMER_MS,
  computeRemainingMs,
  formatTimer,
  isTimerFinished,
  parseDurationInput,
} from "../lib/timer.js";
import { uploadImageToStorage, uploadDocumentToStorage } from "../lib/storage.js";
import {
  SUPPORTED_DOC_EXTS,
  buildDocumentsOutput,
  clampDocText,
  docExt,
  documentIcon,
  extractDocumentText,
  formatBytes,
  isSupportedDocument,
  makeDocId,
  remainingDocBudget,
} from "../lib/documents.js";
import type { BoxDocument } from "../types.js";
import sdk from "@stackblitz/sdk";
import { toStackBlitzProject } from "../lib/project.js";
// Lazy-load the code editor so CodeMirror (~500KB) is only fetched when a
// code box's Code tab is actually opened, keeping the initial bundle small.
const CodeEditor = lazy(() => import("./CodeEditor.js"));
// The split-view modal also pulls in CodeMirror, so lazy-load it too.
const CodeModal = lazy(() => import("./CodeModal.js"));
// Sandpack (in-browser bundler) is heavy, so lazy-load it for the real-project
// preview of Code boxes. This module is also lazy-imported by CodeModal. React
// lazy always resolves a dynamic import to its `.default` export, so a bare
// `lazy(() => import("./SandpackPreview.js"))` is the correct form — do NOT
// wrap the import in `.then((m) => m.default)`, which resolves to the bare
// component and makes React return `undefined` (white screen / "resolves to
// undefined"). See AGENTS.md "Lazy-load gotcha (shared chunks)".
const SandpackPreview = lazy(() => import("./SandpackPreview.js"));

/**
 * Reads an image File, resizes it to max 1024px, and returns a compressed
 * JPEG data URL. Keeps localStorage and API payloads small.
 */
function resizeImage(file: File, maxSize = 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        let width = img.width;
        let height = img.height;
        if (width > height) {
          if (width > maxSize) {
            height = Math.round((height * maxSize) / width);
            width = maxSize;
          }
        } else {
          if (height > maxSize) {
            width = Math.round((width * maxSize) / height);
            height = maxSize;
          }
        }
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) { reject(new Error("Canvas not supported")); return; }
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", 0.85));
      };
      img.onerror = () => reject(new Error("Could not load image"));
      img.src = e.target?.result as string;
    };
    reader.onerror = () => reject(new Error("Could not read file"));
    reader.readAsDataURL(file);
  });
}

function BoxNode({ id, data, selected, type }: NodeProps) {
  const boxType = (data.boxType || type) as BoxType;
  // Custom boxes: the base meta is a fallback — instances carry their own
  // icon/color/label copied from the user's saved definition (node.data).
  const baseMeta = BOX_TYPES[boxType];
  const meta =
    boxType === "custom"
      ? {
          ...baseMeta,
          icon: (data.customIcon as string) || baseMeta.icon,
          color: (data.customColor as string) || baseMeta.color,
          label: (data.customLabel as string) || baseMeta.label,
        }
      : baseMeta;
  const boxData = useBoardStore((s) => s.boxData[id]);
  const updateBoxData = useBoardStore((s) => s.updateBoxData);
  const deleteBox = useBoardStore((s) => s.deleteBox);
  const runBox = useBoardStore((s) => s.runBox);
  const stopAgent = useBoardStore((s) => s.stopAgent);
  const edges = useBoardStore((s) => s.edges);
  const allNodes = useBoardStore((s) => s.nodes);
  const setBoxName = useBoardStore((s) => s.setBoxName);

  const [showSettings, setShowSettings] = useState(false);
  const [slideIndex, setSlideIndex] = useState(0);
  const [codeTab, setCodeTab] = useState<"code" | "preview">("preview");
  const [codeMaximized, setCodeMaximized] = useState(false);
  const [copied, setCopied] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  // Documents box: how many files are mid-extraction right now (transient UI
  // state — the durable results live in boxData.documents).
  const [docBusy, setDocBusy] = useState(0);
  const [docDragOver, setDocDragOver] = useState(false);
  const [isEditingName, setIsEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  // Label box: click-to-edit text (same pattern as the box-name editor).
  const [isEditingLabel, setIsEditingLabel] = useState(false);
  const [labelDraft, setLabelDraft] = useState("");
  // Timer box: duration input draft. null = show the stored duration.
  const [durationDraft, setDurationDraft] = useState<string | null>(null);
  // Timer box: live clock. Only this box instance ticks, and only while its
  // timer runs — the display is always derived from the synced
  // startedAt/remaining fields, never written to the store per tick.
  const timerRunning = boxType === "timer" && boxData?.timerStatus === "running";
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!timerRunning) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [timerRunning]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  // Find connected upstream box names for the settings panel
  const connectedInputs = edges
    .filter((e) => e.target === id)
    .map((e) => {
      const sourceNode = allNodes.find((n) => n.id === e.source);
      return {
        name: (sourceNode?.data?.title as string) || "Unnamed",
        id: e.source,
      };
    });

  // Insert a variable into the prompt at cursor position
  const insertVariable = (varName: string) => {
    const textarea = promptRef.current;
    if (!textarea) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const currentPrompt = boxData.prompt;
    const newPrompt = currentPrompt.slice(0, start) + "{{" + varName + "}}" + currentPrompt.slice(end);
    updateBoxData(id, { prompt: newPrompt });
    // Restore cursor position after the inserted text
    setTimeout(() => {
      textarea.focus();
      textarea.setSelectionRange(start + varName.length + 4, start + varName.length + 4);
    }, 0);
  };

  // ALL hooks must be called before any early return (Rules of Hooks)
  // Listen for "preview-ready" message from the iframe
  useEffect(() => {
    if (!boxData || boxType !== "code") return;
    const handler = (e: MessageEvent) => {
      if (e.data && e.data.type === "preview-ready") {
        setPreviewLoading(false);
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [boxData, boxType]);

  // Show the loading overlay for iframe-based previews (ui/stitch) when their
  // code changes, with a timeout fallback in case the iframe's "preview-ready"
  // message is lost. Keyed on the code string — boxData object identity changes
  // on every store patch (presence, tokens, snapshots) and must not re-trigger
  // this. The Sandpack preview (boxType "code") shows its own loading state.
  useEffect(() => {
    if ((boxType !== "ui" && boxType !== "stitch") || !boxData?.code || boxData.status !== "done") return;
    setPreviewLoading(true);
    const timeout = setTimeout(() => setPreviewLoading(false), 8000);
    return () => clearTimeout(timeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boxData?.code, boxType]);

  if (!boxData) return null;

  const isIdea = boxType === "idea";
  const isAgent = boxType === "agent";
  const isImage = boxType === "image";
  const isDocuments = boxType === "documents";
  const isCartoon = boxType === "cartoon";
  const isSlides = boxType === "slides";
  const isCode = boxType === "code" || boxType === "ui" || boxType === "stitch";
  const isStitch = boxType === "stitch";
  const isInputBox = isIdea || isImage || isDocuments;
  // Collaboration boxes (note / label / timer) are standalone annotations:
  // no AI, no Run button, no settings panel, and no connection handles.
  const isNote = boxType === "note";
  const isLabel = boxType === "label";
  const isTimer = boxType === "timer";
  const isUtility = isNote || isLabel || isTimer;

  // ===== Collaboration annotations render WITHOUT the standard box card =====
  // (no header bar, no border/footer chrome) so they read as canvas
  // annotations, not pipeline boxes. Early returns are safe here: every hook
  // is called above.

  // Note: a post-it paper.
  if (isNote) {
    return (
      <>
        <NodeResizer minWidth={160} minHeight={140} isVisible={!!selected} />
        <div className={"note-node" + (selected ? " selected" : "")}>
          <button
            className="note-delete nodrag"
            onClick={() => deleteBox(id)}
            title="Delete note"
          >
            ✕
          </button>
          <textarea
            className="nodrag nowheel note-textarea"
            placeholder="Write a note for the team…"
            value={boxData.content}
            onChange={(e) => updateBoxData(id, { content: e.target.value })}
          />
          <p className="note-author">
            — {boxData.authorName || "Someone"}
            {boxData.authorEmail ? ` (${boxData.authorEmail})` : ""}
          </p>
        </div>
      </>
    );
  }

  // Label: a floating text chip.
  if (isLabel) {
    return (
      <div className={"label-node" + (selected ? " selected" : "")}>
        <div className="label-row">
          {isEditingLabel ? (
            <input
              autoFocus
              className="nodrag w-44 rounded-full border border-slate-300 bg-white px-3 py-1.5 text-center text-[13px] font-bold text-slate-700 shadow-md focus:outline-none focus:ring-2 focus:ring-slate-300"
              value={labelDraft}
              placeholder="Label text…"
              onChange={(e) => setLabelDraft(e.target.value)}
              onBlur={() => {
                if (labelDraft.trim()) updateBoxData(id, { content: labelDraft.trim() });
                setIsEditingLabel(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  if (labelDraft.trim()) updateBoxData(id, { content: labelDraft.trim() });
                  setIsEditingLabel(false);
                }
                if (e.key === "Escape") setIsEditingLabel(false);
              }}
            />
          ) : (
            <div
              className="label-pill nodrag cursor-text"
              style={{ backgroundColor: boxData.labelColor || LABEL_COLORS[0] }}
              onClick={() => {
                setLabelDraft(boxData.content);
                setIsEditingLabel(true);
              }}
              title="Click to edit the label text"
            >
              {boxData.content || (
                <span className="text-slate-400 font-medium">Click to add text…</span>
              )}
            </div>
          )}
          <button
            className="label-delete nodrag"
            style={{ left: "calc(100% + 6px)", top: "50%", transform: "translateY(-50%)" }}
            onClick={() => deleteBox(id)}
            title="Delete label"
          >
            ✕
          </button>
        </div>
        {selected && (
          <div className="nodrag flex gap-1.5">
            {LABEL_COLORS.map((c) => (
              <button
                key={c}
                onClick={() => updateBoxData(id, { labelColor: c })}
                className={
                  "w-4 h-4 rounded-full border transition " +
                  ((boxData.labelColor || LABEL_COLORS[0]) === c
                    ? "border-slate-700 scale-125"
                    : "border-slate-300")
                }
                style={{ backgroundColor: c }}
                title="Set label color"
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  const isRunning = boxData.status === "running";
  const hasError = boxData.status === "error";
  const hasTextOutput = boxData.output && boxData.output.trim().length > 0;
  const hasImageOutput = boxData.outputImage && boxData.outputImage.length > 0;
  const hasUploadedImage = boxData.imageData && boxData.imageData.length > 0;
  const slides = boxData.slides || [];
  const hasSlides = slides.length > 0;
  const currentSlide = Math.min(slideIndex, slides.length - 1);
  const slide = hasSlides ? slides[currentSlide] : null;

  const handleImageUpload = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const dataUrl = await resizeImage(file);
      // Upload to Firebase Storage so other users can see it via Firestore sync
      const boardId = useBoardStore.getState().currentBoardId;
      if (boardId) {
        const imageUrl = await uploadImageToStorage(boardId, id, dataUrl);
        updateBoxData(id, { imageData: imageUrl });
      } else {
        // Fallback: store base64 locally (no board loaded)
        updateBoxData(id, { imageData: dataUrl });
      }
    } catch (err) {
      console.error("Image upload failed:", err);
    }
  };

  // ===== Documents box =====

  /**
   * Processes uploaded/dropped files one at a time: extract text client-side,
   * trim it to the box's remaining budget, best-effort upload the raw file to
   * Storage, then append the entry to boxData.documents so it syncs and
   * persists. Failed extractions become entries with an error message (never
   * thrown away silently).
   */
  const handleDocumentsUpload = async (files: FileList | File[] | null) => {
    if (!files || files.length === 0) return;
    const boardId = useBoardStore.getState().currentBoardId;
    const list = Array.from(files).slice(0, 10); // sane per-batch cap
    setDocBusy((n) => n + list.length);
    for (const file of list) {
      let entry: BoxDocument;
      try {
        const raw = await extractDocumentText(file);
        const budget = remainingDocBudget(
          useBoardStore.getState().boxData[id]?.documents
        );
        const { text, truncated } = clampDocText(raw, budget);
        // Best-effort raw-file upload so the original stays downloadable.
        let url = "";
        if (boardId) {
          try {
            url = await uploadDocumentToStorage(boardId, id, file);
          } catch (err) {
            console.warn("Document upload to storage failed (text is kept):", err);
          }
        }
        entry = {
          id: makeDocId(file.name, file.size),
          name: file.name,
          size: file.size,
          ext: docExt(file.name),
          url,
          text,
          chars: text.length,
          truncated,
          error: text
            ? ""
            : "This box's document-text budget is used up — remove other files first.",
        };
      } catch (err: any) {
        entry = {
          id: makeDocId(file.name, file.size),
          name: file.name,
          size: file.size,
          ext: docExt(file.name),
          url: "",
          text: "",
          chars: 0,
          truncated: false,
          error: err?.message || "Could not extract text from this file.",
        };
      }
      const existing = useBoardStore.getState().boxData[id]?.documents || [];
      updateBoxData(id, { documents: [...existing, entry] });
      setDocBusy((n) => Math.max(0, n - 1));
    }
  };

  const removeDocument = (docId: string) => {
    const existing = useBoardStore.getState().boxData[id]?.documents || [];
    updateBoxData(id, { documents: existing.filter((d) => d.id !== docId) });
  };

  const handleCopyCode = async () => {
    if (!boxData.code) return;
    const ok = await copyToClipboard(boxData.code);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleDownloadCode = () => {
    if (!boxData.code) return;
    const html = wrapCodeInHtml(boxData.code);
    downloadHtml(html);
  };

  const handleOpenStackBlitz = () => {
    if (!boxData.code) return;
    sdk.openProject(toStackBlitzProject(boxData.code));
  };

  return (
    <>
      <NodeResizer
        minWidth={220}
        minHeight={isTimer ? 150 : 160}
        isVisible={!!selected}
      />
      <div
        className={"box-node" + (selected ? " selected" : "")}
        style={{ borderColor: meta.color }}
      >
      {/* Target handle (input) — AI boxes only (not input/utility boxes) */}
      {!isInputBox && !isUtility && (
        <Handle
          type="target"
          position={Position.Left}
          style={{ background: meta.color, width: 10, height: 10 }}
        />
      )}

      {/* Header */}
      <div
        className="flex items-center justify-between px-3 py-2 rounded-t-[10px]"
        style={{ backgroundColor: meta.color + "20" }}
      >
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <span className="text-base flex-shrink-0">{meta.icon}</span>
          {isEditingName ? (
            <input
              autoFocus
              type="text"
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={() => {
                setBoxName(id, nameDraft.trim() || meta.label + " Box");
                setIsEditingName(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  setBoxName(id, nameDraft.trim() || meta.label + " Box");
                  setIsEditingName(false);
                }
                if (e.key === "Escape") setIsEditingName(false);
              }}
              className="font-semibold text-slate-700 text-sm bg-white rounded px-1 py-0.5 border border-slate-300 focus:outline-none focus:ring-1 focus:ring-blue-400 flex-1 min-w-0"
            />
          ) : (
            <span
              onClick={() => {
                setNameDraft(data.title as string || meta.label + " Box");
                setIsEditingName(true);
              }}
              className="font-semibold text-slate-700 text-sm truncate cursor-text hover:bg-white/40 rounded px-1 py-0.5 transition"
              title="Click to rename"
            >
              {(data.title as string) || meta.label + " Box"}
            </span>
          )}
          <span className="text-xs text-slate-400 flex-shrink-0">{meta.label}</span>
        </div>
        <button
          onClick={() => deleteBox(id)}
          className="text-slate-400 hover:text-red-500 transition text-sm w-5 h-5 flex items-center justify-center rounded hover:bg-red-50"
          title="Delete box"
        >
          ✕
        </button>
      </div>

      {/* Body */}
      <div className="px-3 py-2 flex-1 min-h-0 overflow-y-auto">
        {/* Timer box (collab) — the only collaboration box rendered inside the
            standard card; note/label early-return above as annotations. */}
        {/* Timer box — shared countdown clock, synced via the board doc */}
        {isTimer && (() => {
          const duration = boxData.timerDurationMs ?? DEFAULT_TIMER_MS;
          const remaining = computeRemainingMs(boxData, now);
          const finished = isTimerFinished(boxData, now);
          const status = boxData.timerStatus || "idle";
          const draft = durationDraft ?? formatTimer(duration);
          const parsedDraft = parseDurationInput(draft);
          const progress = duration > 0 ? remaining / duration : 0;
          const email = useAuthStore.getState().user?.email || "";
          return (
            <div className="nodrag h-full rounded-lg border border-slate-700 bg-slate-900 p-3 flex flex-col items-center justify-center gap-2.5">
              {/* Digits */}
              <div
                className={
                  "font-mono tabular-nums text-4xl font-bold tracking-wider " +
                  (finished
                    ? "text-rose-400 animate-pulse"
                    : timerRunning && remaining <= 10_000
                      ? "text-amber-300"
                      : "text-cyan-300")
                }
              >
                {formatTimer(remaining)}
              </div>
              {/* Progress bar */}
              <div className="w-full h-1.5 rounded-full bg-slate-700 overflow-hidden">
                <div
                  className={"h-full transition-[width] duration-300 " + (finished ? "bg-rose-500" : "bg-cyan-400")}
                  style={{ width: `${Math.round(progress * 100)}%` }}
                />
              </div>
              {finished && (
                <div className="text-xs font-semibold text-rose-400 animate-pulse">⏰ Time's up</div>
              )}
              {/* Controls */}
              <div className="flex items-center gap-1.5">
                {(status === "idle" || status === "stopped") && (
                  <>
                    <input
                      className="w-[70px] rounded-lg border border-slate-600 bg-slate-800 px-2 py-1 text-center font-mono text-sm text-slate-200 focus:outline-none focus:ring-2 focus:ring-cyan-500"
                      value={draft}
                      placeholder="MM:SS"
                      title="Duration — e.g. 5:30 or 90"
                      onChange={(e) => setDurationDraft(e.target.value)}
                    />
                    <button
                      onClick={() => {
                        const ms = parsedDraft ?? duration;
                        setDurationDraft(null);
                        updateBoxData(id, {
                          timerDurationMs: ms,
                          timerRemainingMs: ms,
                          timerStatus: "running",
                          timerStartedAt: Date.now(),
                          timerStartedBy: email,
                        });
                      }}
                      disabled={parsedDraft === null}
                      className="px-3 py-1 rounded-lg bg-cyan-500 text-white text-sm font-medium hover:bg-cyan-400 transition disabled:opacity-40"
                    >
                      ▶ Start
                    </button>
                  </>
                )}
                {status === "running" && (
                  <>
                    <button
                      onClick={() =>
                        updateBoxData(id, {
                          timerStatus: "paused",
                          timerRemainingMs: computeRemainingMs(boxData, Date.now()),
                        })
                      }
                      className="px-3 py-1 rounded-lg bg-slate-700 text-slate-100 text-sm font-medium hover:bg-slate-600 transition"
                    >
                      ⏸ Pause
                    </button>
                    <button
                      onClick={() =>
                        updateBoxData(id, {
                          timerStatus: "stopped",
                          timerRemainingMs: computeRemainingMs(boxData, Date.now()),
                        })
                      }
                      className="px-3 py-1 rounded-lg bg-rose-500 text-white text-sm font-medium hover:bg-rose-400 transition"
                    >
                      ⏹ Stop
                    </button>
                  </>
                )}
                {status === "paused" && (
                  <>
                    <button
                      onClick={() =>
                        updateBoxData(id, {
                          timerStatus: "running",
                          timerStartedAt: Date.now(),
                        })
                      }
                      className="px-3 py-1 rounded-lg bg-cyan-500 text-white text-sm font-medium hover:bg-cyan-400 transition"
                    >
                      ▶ Resume
                    </button>
                    <button
                      onClick={() =>
                        updateBoxData(id, {
                          timerStatus: "stopped",
                        })
                      }
                      className="px-3 py-1 rounded-lg bg-rose-500 text-white text-sm font-medium hover:bg-rose-400 transition"
                    >
                      ⏹ Stop
                    </button>
                  </>
                )}
                {status !== "idle" && (
                  <button
                    onClick={() => {
                      setDurationDraft(null);
                      updateBoxData(id, {
                        timerStatus: "idle",
                        timerStartedAt: undefined,
                        timerRemainingMs: undefined,
                        timerStartedBy: undefined,
                      });
                    }}
                    className="px-3 py-1 rounded-lg bg-slate-700 text-slate-100 text-sm font-medium hover:bg-slate-600 transition"
                    title="Reset to the full duration"
                  >
                    ↺ Reset
                  </button>
                )}
              </div>
              {/* Attribution */}
              {boxData.timerStartedBy && status !== "idle" && (
                <p className="text-[10px] text-slate-400 truncate max-w-full">
                  started by {boxData.timerStartedBy}
                </p>
              )}
            </div>
          );
        })()}

        {/* ===== AI / input boxes ===== */}

        {/* Idea box — editable textarea */}
        {isIdea && (
          <textarea
            className="nodrag nowheel w-full min-h-[100px] resize-y rounded-lg border border-slate-200 p-2 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-amber-300"
            placeholder="Write your idea here..."
            value={boxData.content}
            onChange={(e) =>
              updateBoxData(id, { content: e.target.value, output: e.target.value })
            }
          />
        )}

        {/* Agent box — task + live step timeline + final answer */}
        {isAgent && (() => {
          const stepsList = boxData.agentSteps || [];
          const stepIcon: Record<string, string> = {
            plan: "🧠",
            add_box: "➕",
            connect: "🔗",
            run: "▶️",
            finish: "✅",
            stopped: "⏹️",
            error: "⚠️",
          };
          const stepColor: Record<string, string> = {
            finish: "text-emerald-600",
            stopped: "text-amber-600",
            error: "text-red-600",
          };
          return (
            <div className="flex flex-col gap-2 min-h-[140px]">
              <textarea
                className="nodrag nowheel w-full min-h-[64px] resize-y rounded-lg border border-indigo-200 p-2 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-300"
                placeholder="Describe the task for the agent, e.g. “Turn this idea into a full pitch: research it, write a PRD, and build a landing page prototype”"
                value={boxData.content}
                onChange={(e) => updateBoxData(id, { content: e.target.value })}
              />
              {isRunning && stepsList.length === 0 && (
                <div className="flex items-center gap-2 text-indigo-500 text-sm py-2 justify-center">
                  <span className="animate-spin">🤖</span>
                  <span>Planning…</span>
                </div>
              )}
              {stepsList.length > 0 && (
                <div className="rounded-lg border border-slate-200 bg-slate-50/80 px-2.5 py-2 max-h-[190px] overflow-y-auto nowheel space-y-1">
                  {stepsList.map((s) => (
                    <div key={s.id} className="flex items-start gap-1.5 text-[11px] leading-snug">
                      <span className="flex-shrink-0 mt-[1px]">{stepIcon[s.type] || "•"}</span>
                      <div className="min-w-0">
                        <span className={"font-medium " + (stepColor[s.type] || "text-slate-600")}>
                          {s.label}
                        </span>
                        {s.detail && (
                          <span
                            className="text-slate-400"
                            title={s.detail}
                          >
                            {" — "}
                            {s.detail.length > 60 ? s.detail.slice(0, 60) + "…" : s.detail}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {hasTextOutput && (
                <div className="markdown-output text-slate-700 text-sm">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-indigo-500 mb-0.5">
                    Agent answer
                  </div>
                  <ReactMarkdown>{boxData.output}</ReactMarkdown>
                </div>
              )}
              {!hasTextOutput && !isRunning && stepsList.length === 0 && !hasError && (
                <div className="text-slate-400 text-sm py-4 text-center">
                  Type a task above and click <strong>Run</strong>. The agent will create and
                  run boxes on this board, then report back here.
                </div>
              )}
            </div>
          );
        })()}

        {/* Image upload box */}
        {isImage && (
          <div>
            {hasUploadedImage ? (
              <div>
                <img
                  src={boxData.imageData}
                  alt="Uploaded"
                  className="w-full rounded-lg border border-slate-200"
                />
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="mt-2 w-full text-xs py-1.5 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 transition"
                >
                  📁 Change Image
                </button>
              </div>
            ) : (
              <div
                onClick={() => fileInputRef.current?.click()}
                className="cursor-pointer border-2 border-dashed border-slate-300 rounded-lg p-6 text-center hover:border-emerald-400 hover:bg-emerald-50 transition"
              >
                <div className="text-3xl mb-2">🖼️</div>
                <div className="text-sm text-slate-500 font-medium">
                  Click to upload
                </div>
                <div className="text-xs text-slate-400 mt-1">
                  PNG, JPG, WebP — max 1024px
                </div>
              </div>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleImageUpload}
            />
          </div>
        )}

        {/* Documents upload box — multi-file, drag & drop, extracted text
            becomes the box's output for downstream prompt templating. */}
        {isDocuments &&
          (() => {
            const docs = boxData.documents || [];
            const totalChars = docs.reduce((s, d) => s + d.chars, 0);
            const usable = docs.filter((d) => !d.error && d.text).length;
            return (
              <div className="nodrag space-y-2">
                <div
                  onClick={() => fileInputRef.current?.click()}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDocDragOver(true);
                  }}
                  onDragLeave={() => setDocDragOver(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDocDragOver(false);
                    handleDocumentsUpload(e.dataTransfer.files);
                  }}
                  className={
                    "cursor-pointer border-2 border-dashed rounded-lg p-4 text-center transition " +
                    (docDragOver
                      ? "border-slate-500 bg-slate-100"
                      : "border-slate-300 hover:border-slate-400 hover:bg-slate-50")
                  }
                >
                  <div className="text-2xl mb-1">📎</div>
                  <div className="text-sm text-slate-500 font-medium">
                    Click or drop files
                  </div>
                  <div className="text-[11px] text-slate-400 mt-1">
                    PDF, DOCX, TXT, MD, CSV, JSON
                  </div>
                </div>

                {docBusy > 0 && (
                  <div className="flex items-center justify-center gap-2 text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-lg py-2">
                    <span className="animate-spin inline-block">⏳</span>
                    Extracting text from {docBusy} file{docBusy > 1 ? "s" : ""}…
                  </div>
                )}

                {docs.length > 0 && (
                  <div className="space-y-1.5">
                    {docs.map((d) => (
                      <div
                        key={d.id}
                        className="group flex items-start gap-2 rounded-lg border border-slate-200 bg-white px-2.5 py-2"
                      >
                        <span className="text-sm flex-shrink-0 mt-0.5">
                          {documentIcon(d.ext)}
                        </span>
                        <div className="flex-1 min-w-0">
                          <div
                            className="text-[13px] font-medium text-slate-700 truncate"
                            title={d.name}
                          >
                            {d.name}
                          </div>
                          <div className="text-[11px] text-slate-400">
                            {formatBytes(d.size)}
                            {d.error ? (
                              <span className="text-red-500"> — {d.error}</span>
                            ) : (
                              <>
                                {" · "}
                                {d.chars.toLocaleString()} chars
                                {d.truncated ? " (truncated)" : ""}
                              </>
                            )}
                          </div>
                          {d.url && (
                            <a
                              href={d.url}
                              target="_blank"
                              rel="noreferrer"
                              className="text-[11px] text-indigo-500 hover:underline"
                            >
                              Open original ↗
                            </a>
                          )}
                        </div>
                        <button
                          onClick={() => removeDocument(d.id)}
                          className="w-5 h-5 rounded-full text-[10px] text-slate-400 hover:text-red-500 hover:bg-red-50 flex items-center justify-center flex-shrink-0 opacity-0 group-hover:opacity-100 transition"
                          title="Remove this document"
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {docs.length > 0 && (
                  <p className="text-[11px] text-slate-400 leading-snug px-0.5">
                    {usable} of {docs.length} usable ·{" "}
                    {totalChars.toLocaleString()} chars total — flows into
                    connected boxes via {"{{inputs}}"}.
                  </p>
                )}

                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept={SUPPORTED_DOC_EXTS.map((e) => "." + e).join(",")}
                  className="hidden"
                  onChange={(e) => {
                    handleDocumentsUpload(e.target.files);
                    e.target.value = ""; // allow re-uploading the same file
                  }}
                />
              </div>
            );
          })()}

        {/* AI box output — cartoon (image) */}
        {!isInputBox && isCartoon && (
          <div className="min-h-[120px]">
            {isRunning && (
              <div className="flex flex-col items-center gap-2 text-slate-400 text-sm py-8 justify-center">
                <span className="animate-spin text-2xl">🎨</span>
                <span>Generating cartoon...</span>
              </div>
            )}
            {hasError && !isRunning && (
              <div className="text-red-500 text-sm p-2 bg-red-50 rounded-lg">
                ⚠️ {boxData.error}
              </div>
            )}
            {hasImageOutput && !isRunning && (
              <div>
                <img
                  src={boxData.outputImage}
                  alt="Generated cartoon profile"
                  className="w-full rounded-lg border border-slate-200"
                />
                <a
                  href={boxData.outputImage}
                  download="cartoon-profile.jpg"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block mt-2 text-xs text-center text-slate-400 hover:text-slate-600"
                >
                  Open image ↗
                </a>
              </div>
            )}
            {!hasImageOutput && !isRunning && !hasError && (
              <div className="text-slate-400 text-sm py-8 text-center">
                No image yet. Connect an Image or Idea box and click <strong>Run</strong>.
              </div>
            )}
          </div>
        )}

        {/* AI box output — text (research, summarize) */}
        {!isInputBox && !isCartoon && !isSlides && !isCode && !isAgent && (
          <div className="min-h-[80px]">
            {isRunning && (
              <div className="flex items-center gap-2 text-slate-400 text-sm py-4 justify-center">
                <span className="animate-spin">⏳</span>
                <span>Generating...</span>
              </div>
            )}
            {hasError && !isRunning && (
              <div className="text-red-500 text-sm p-2 bg-red-50 rounded-lg">
                ⚠️ {boxData.error}
              </div>
            )}
            {hasTextOutput && !isRunning && (
              <div className="markdown-output text-slate-700 text-sm">
                <ReactMarkdown>{boxData.output}</ReactMarkdown>
              </div>
            )}
            {!hasTextOutput && !isRunning && !hasError && (
              <div className="text-slate-400 text-sm py-4 text-center">
                No output yet. Click <strong>Run</strong> to generate.
              </div>
            )}
          </div>
        )}

        {/* AI box output — slides (pitch deck) */}
        {!isInputBox && isSlides && (
          <div className="min-h-[120px]">
            {isRunning && (
              <div className="flex flex-col items-center gap-2 text-slate-400 text-sm py-8 justify-center">
                <span className="animate-spin text-2xl">📊</span>
                <span>Creating slides...</span>
              </div>
            )}
            {hasError && !isRunning && (
              <div className="text-red-500 text-sm p-2 bg-red-50 rounded-lg">
                ⚠️ {boxData.error}
              </div>
            )}
            {hasSlides && !isRunning && slide && (
              <div>
                {/* Slide card */}
                <div className="rounded-lg border border-slate-200 overflow-hidden shadow-sm">
                  {/* Title bar */}
                  <div
                    className="px-3 py-2 text-white font-bold text-sm"
                    style={{ backgroundColor: meta.color }}
                  >
                    {currentSlide + 1}. {slide.title}
                  </div>
                  {/* Bullets */}
                  <div className="p-3 bg-white">
                    <ul className="space-y-1.5">
                      {slide.bullets.map((bullet, i) => (
                        <li
                          key={i}
                          className="text-xs text-slate-700 flex gap-1.5 leading-relaxed"
                        >
                          <span
                            className="flex-shrink-0 w-1.5 h-1.5 rounded-full mt-1.5"
                            style={{ backgroundColor: meta.color }}
                          />
                          <span>{bullet}</span>
                        </li>
                      ))}
                    </ul>
                    {/* Speaker notes */}
                    {slide.notes && (
                      <div className="mt-2 pt-2 border-t border-slate-100">
                        <div className="text-xs text-slate-400 italic">
                          📝 {slide.notes}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
                {/* Navigation */}
                <div className="flex items-center justify-center gap-3 mt-2">
                  <button
                    onClick={() => setSlideIndex(Math.max(0, currentSlide - 1))}
                    disabled={currentSlide === 0}
                    className="w-7 h-7 rounded-lg border border-slate-200 text-slate-500 text-sm flex items-center justify-center hover:bg-slate-50 disabled:opacity-30 disabled:cursor-not-allowed transition"
                    title="Previous slide"
                  >
                    ◀
                  </button>
                  <span className="text-xs text-slate-500 font-medium tabular-nums">
                    {currentSlide + 1} / {slides.length}
                  </span>
                  <button
                    onClick={() => setSlideIndex(Math.min(slides.length - 1, currentSlide + 1))}
                    disabled={currentSlide === slides.length - 1}
                    className="w-7 h-7 rounded-lg border border-slate-200 text-slate-500 text-sm flex items-center justify-center hover:bg-slate-50 disabled:opacity-30 disabled:cursor-not-allowed transition"
                    title="Next slide"
                  >
                    ▶
                  </button>
                </div>
              </div>
            )}
            {!hasSlides && !isRunning && !hasError && (
              <div className="text-slate-400 text-sm py-8 text-center">
                No slides yet. Connect a Research or Idea box and click <strong>Run</strong>.
              </div>
            )}
          </div>
        )}

        {/* AI box output — code (React prototype) */}
        {!isInputBox && isCode && (
          <div className="flex flex-col h-full min-h-[150px]">
            {isRunning && (
              <div className="flex flex-col items-center gap-2 text-slate-400 text-sm py-8 justify-center">
                <span className="animate-spin text-2xl">💻</span>
                <span>Writing code...</span>
              </div>
            )}
            {hasError && !isRunning && (
              <div className="text-red-500 text-sm p-2 bg-red-50 rounded-lg">
                ⚠️ {boxData.error}
              </div>
            )}
            {boxData.code && !isRunning && (
              <div className="flex flex-col h-full">
                {/* Tab buttons */}
                <div className="flex items-center justify-between mb-2">
                  <div className="flex gap-1">
                    <button
                      onClick={() => setCodeTab("code")}
                      className={"px-3 py-1 rounded-lg text-xs font-medium transition " + (codeTab === "code" ? "bg-slate-700 text-white" : "bg-slate-100 text-slate-500 hover:bg-slate-200")}
                    >
                      📝 Code
                    </button>
                    <button
                      onClick={() => { setCodeTab("preview"); setPreviewLoading(true); }}
                      className={"px-3 py-1 rounded-lg text-xs font-medium transition " + (codeTab === "preview" ? "bg-cyan-500 text-white" : "bg-slate-100 text-slate-500 hover:bg-slate-200")}
                    >
                      👁 Preview
                    </button>
                  </div>
                  <button
                    onClick={() => setCodeMaximized(true)}
                    className="px-2.5 py-1 rounded-lg text-xs font-medium text-slate-500 bg-slate-100 hover:bg-slate-200 transition"
                    title="Maximise — open code and preview side by side"
                  >
                    ⛶ Maximise
                  </button>
                </div>
                {/* Code tab */}
                {codeTab === "code" && (
                  <div className="flex-1 min-h-0 flex flex-col">
                    <Suspense
                      fallback={
                        <div className="flex-1 flex items-center justify-center text-xs text-slate-400 bg-slate-900 rounded-lg">
                          Loading editor…
                        </div>
                      }
                    >
                      <CodeEditor
                        value={boxData.code}
                        onChange={(next) => updateBoxData(id, { code: next })}
                        height="100%"
                      />
                    </Suspense>
                    <p className="mt-1 text-[10px] text-slate-400">
                      ✏️ Editable — changes save to the box and update the preview.
                    </p>
                  </div>
                )}
                {/* Preview tab */}
                {codeTab === "preview" && (
                  <div className="flex-1 min-h-0 relative rounded-lg overflow-hidden border border-slate-200 bg-white">
                    {boxType === "code" ? (
                      <Suspense
                        fallback={
                          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-slate-400 text-sm bg-white z-10">
                            <span className="animate-spin text-2xl">⚙️</span>
                            <span>Loading preview…</span>
                          </div>
                        }
                      >
                        <SandpackPreview code={boxData.code || ""} height="100%" />
                      </Suspense>
                    ) : (
                      <>
                        {previewLoading && (
                          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-slate-400 text-sm bg-white z-10">
                            <span className="animate-spin text-2xl">⚙️</span>
                            <span>Loading preview...</span>
                          </div>
                        )}
                        <iframe
                          srcDoc={isStitch ? (boxData.code || "") : (boxType === "ui" ? wrapUIInHtml : wrapCodeInHtml)(boxData.code || "")}
                          className="absolute inset-0 w-full h-full border-0"
                          sandbox="allow-scripts allow-popups allow-forms allow-same-origin allow-modals"
                          title="React Preview"
                        />
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
            {!boxData.code && !isRunning && !hasError && (
              <div className="flex flex-col gap-2">
                <textarea
                  placeholder="Describe what you want to build... (e.g. a counter app with increment/decrement buttons)"
                  value={boxData.content}
                  onChange={(e) => updateBoxData(id, { content: e.target.value })}
                  className="w-full min-h-[80px] resize-y rounded-lg border border-slate-200 p-2 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-cyan-300"
                />
                <p className="text-xs text-slate-400">
                  Type a description above and click Run, or connect a Research/PRD/Idea box.
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Token usage from the last LLM call */}
      {boxData.tokens && (
        <div className="px-3 py-1.5 border-t border-slate-100 flex items-center justify-end gap-2 text-[10px] text-slate-400">
          <span title="Input → output tokens used by this call">
            ⚡ <span className="tabular-nums">{boxData.tokens.promptTokens} in · {boxData.tokens.completionTokens} out</span>
          </span>
          <span className="font-semibold text-slate-500 tabular-nums">
            {boxData.tokens.totalTokens} tok
          </span>
        </div>
      )}

      {/* Footer — AI boxes only */}
      {!isInputBox && !isUtility && (
        <div className="px-3 py-2 border-t border-slate-100 flex items-center gap-2">
          <button
            onClick={() => runBox(id)}
            disabled={isRunning}
            className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium text-white transition disabled:opacity-50"
            style={{ backgroundColor: meta.color }}
          >
            {isRunning ? (isAgent ? "⏳ Working…" : "⏳ Running...") : ("▶ Run")}
          </button>
          {isAgent && isRunning && (
            <button
              onClick={() => stopAgent(id)}
              className="px-2.5 py-1.5 rounded-lg text-sm transition bg-slate-100 text-slate-600 hover:bg-rose-50 hover:text-rose-600"
              title="Ask the agent to stop after its current step"
            >
              ⏹ Stop
            </button>
          )}
          <button
            onClick={() => setShowSettings(!showSettings)}
            className={"px-2.5 py-1.5 rounded-lg text-sm transition " + (showSettings ? "bg-slate-200 text-slate-700" : "bg-slate-100 text-slate-500 hover:bg-slate-200")}
            title="Prompt settings"
          >
            ⚙
          </button>
          {isCode && boxData.code && !isRunning && (
            <>
              <button
                onClick={handleCopyCode}
                className="px-2.5 py-1.5 rounded-lg text-xs font-medium transition bg-slate-100 text-slate-600 hover:bg-slate-200 whitespace-nowrap"
                title="Copy code"
              >
                {copied ? "✅ Copied" : "📋 Copy"}
              </button>
              <button
                onClick={handleDownloadCode}
                className="px-2.5 py-1.5 rounded-lg text-xs font-medium transition bg-slate-100 text-slate-600 hover:bg-slate-200 whitespace-nowrap"
                title="Download as HTML"
              >
                💾 Save
              </button>
              <button
                onClick={handleOpenStackBlitz}
                className="px-2.5 py-1.5 rounded-lg text-xs font-medium transition bg-slate-100 text-slate-600 hover:bg-slate-200 whitespace-nowrap"
                title="Open this prototype in StackBlitz (full IDE)"
              >
                ⚡ Open in StackBlitz
              </button>
            </>
          )}
        </div>
      )}

      {/* Settings panel — collapsible (AI boxes only) */}
      {!isInputBox && !isUtility && showSettings && (
        <div className="px-3 py-3 border-t border-slate-100 bg-slate-50 space-y-2">
          {/* System prompt — text AI boxes only (not cartoon) */}
          {!isCartoon && (
            <div>
              <label className="text-xs font-medium text-slate-500 block mb-1">
                {isAgent
                  ? "Agent Protocol Prompt (advanced — the JSON action spec)"
                  : "System Prompt (role / behavior)"}
              </label>
              <textarea
                className="w-full text-xs rounded-lg border border-slate-200 p-2 font-mono text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-300 min-h-[60px] resize-y"
                value={boxData.systemPrompt}
                onChange={(e) =>
                  updateBoxData(id, { systemPrompt: e.target.value })
                }
              />
            </div>
          )}
          <div>
            <label className="text-xs font-medium text-slate-500 block mb-1">
              {isCartoon
                ? "Prompt Template (text-to-image fallback)"
                : isAgent
                  ? "Extra guidance for the agent (optional)"
                  : "Prompt Template"}
            </label>
            <textarea
              ref={promptRef}
              className={"w-full text-xs rounded-lg border border-slate-200 p-2 font-mono text-slate-700 focus:outline-none focus:ring-2" + (isCartoon ? " focus:ring-pink-300" : " focus:ring-blue-300") + " min-h-[80px] resize-y"}
              value={boxData.prompt}
              onChange={(e) =>
                updateBoxData(id, { prompt: e.target.value })
              }
            />
            {isCartoon && (
              <p className="text-xs text-slate-400 mt-1">
                Used when input is text (no image connected). If an Image box is connected, image-to-image is used instead.
              </p>
            )}
            {isSlides && (
              <p className="text-xs text-slate-400 mt-1">
                Defines the slide structure. The model outputs JSON — the app parses it into visual slides.
              </p>
            )}
            <div className="mt-2">
              <p className="text-xs font-medium text-slate-500 mb-1">Available inputs (click to insert):</p>
              {connectedInputs.length === 0 ? (
                <p className="text-xs text-slate-400">No boxes connected. Connect an input box to reference it by name.</p>
              ) : (
                <div className="flex flex-wrap gap-1">
                  {connectedInputs.map((inp) => (
                    <button
                      key={inp.id}
                      onClick={() => insertVariable(inp.name)}
                      className="text-xs px-2 py-1 rounded-md bg-blue-50 text-blue-600 hover:bg-blue-100 transition font-mono"
                      title={"Insert {{" + inp.name + "}} into prompt"}
                    >
                      {"{{" + inp.name + "}}"}
                    </button>
                  ))}
                  <button
                    onClick={() => insertVariable("inputs")}
                    className="text-xs px-2 py-1 rounded-md bg-slate-100 text-slate-600 hover:bg-slate-200 transition font-mono"
                    title="Insert {{inputs}} — all inputs combined"
                  >
                    {"{{inputs}}"}
                  </button>
                </div>
              )}
              <p className="text-xs text-slate-400 mt-1">
                Also supports: <code className="bg-slate-200 px-1 rounded">{"{{input_1}}"}</code> (positional)
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Source handle (output) — pipeline boxes only; collaboration boxes
          (note/label/timer) are standalone annotations with no handles. */}
      {!isUtility && (
        <Handle
          type="source"
          position={Position.Right}
          style={{ background: meta.color, width: 10, height: 10 }}
        />
      )}

      {/* Maximised split view (code + preview) */}
      {codeMaximized && (
        <Suspense fallback={null}>
          <CodeModal
            onClose={() => setCodeMaximized(false)}
            boxType={boxType}
            code={boxData.code || ""}
            onChange={(next) => updateBoxData(id, { code: next })}
            title={meta.label + (boxData.content ? " — " + boxData.content : "")}
          />
        </Suspense>
      )}
    </div>
    </>
  );
}

export default memo(BoxNode);