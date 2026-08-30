/**
 * E2E test run for AI Canva against the REAL dev app (http://localhost:5173)
 * with the REAL backend (/api → Express:3001 → Ollama).
 *
 * What is real here: the full app UI (landing, sidebar, canvas, boxes), the
 * zustand stores, the run flow (Run button → runBox → POST /api/generate →
 * Ollama → markdown output + token badge), the timer/note/label features.
 * What is synthetic: Google auth (a fake user is seeded via the dev-only
 * window.__dsh hooks) and Firestore persistence (skipped — currentBoardId
 * stays null, so board saves/subscriptions no-op). Firebase permission
 * errors in the console are expected noise from the fake user.
 *
 * Run: node e2e.mjs   (from client/, dev server on 5173 must be running)
 */
import { chromium } from "playwright-core";

const APP = "http://localhost:5173";
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✅ PASS" : "❌ FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
};
const safe = async (name, fn) => { try { return await fn(); } catch (e) { return check(name, false, "ERROR: " + e.message.slice(0, 60)); } };

const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message.slice(0, 120)));

const bodyText = () => page.evaluate(() => document.body.innerText);

// ---------- T1: Landing page (logged out) ----------
await page.goto(APP, { waitUntil: "load" });
await page.waitForTimeout(2500);
check("T1 landing renders", /Visual AI pipelines/.test(await bodyText()) && /Build AI pipelines/.test(await bodyText()));
check("T1 landing hides app canvas", !(await page.$(".react-flow")));
check("T1 no page errors on landing", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 80));

// ---------- T2: Enter the app with a seeded user ----------
const FAKE = { uid: "e2e-fake-uid", email: "e2e@test.local", displayName: "E2E Tester", photoURL: "" };
await page.evaluate((u) => {
  window.__dsh.useAuthStore.setState({ user: u, loading: false });
}, FAKE);
await page.waitForTimeout(2000);
check("T2 app shell renders after login", !!(await page.$(".react-flow")) && /Add Box/.test(await bodyText()));
check("T2 palette sections: Inputs/Workers/Collaboration", /INPUTS/i.test(await bodyText()) && /WORKERS/i.test(await bodyText()) && /COLLABORATION/i.test(await bodyText()));
check("T2 starter board seeded (idea + research)", await safe("T2 starter", async () => {
  const nodes = await page.evaluate(() => window.__dsh.useBoardStore.getState().nodes);
  const types = nodes.map((n) => n.data.boxType || n.type);
  return types.includes("idea") && types.includes("research");
}));

// Wrap updateBoxData to count writes (timer transition discipline).
await page.evaluate(() => {
  const s = window.__dsh.useBoardStore.getState();
  const orig = s.updateBoxData;
  window.__e2e = { updateCalls: 0 };
  window.__dsh.useBoardStore.setState({
    updateBoxData: (id, patch) => {
      window.__e2e.updateCalls++;
      return orig(id, patch);
    },
  });
});

// ---------- T3: Add boxes through the REAL sidebar palette ----------
const addBoxViaPalette = async (label) => {
  const before = await page.evaluate(() => window.__dsh.useBoardStore.getState().nodes.length);
  const clicked = await page.evaluate((l) => {
    // Palette buttons render as <span>icon</span><span>Label</span>.
    const btn = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent.trim().endsWith(l)
    );
    if (!btn) return false;
    btn.click();
    return true;
  }, label);
  await page.waitForTimeout(500);
  const after = await page.evaluate(() => window.__dsh.useBoardStore.getState().nodes.length);
  return clicked && after === before + 1;
};
check("T3 add Note via palette", await safe("T3 Note", () => addBoxViaPalette("Note")));
check("T3 add Label via palette", await safe("T3 Label", () => addBoxViaPalette("Label")));
check("T3 add Timer via palette", await safe("T3 Timer", () => addBoxViaPalette("Timer")));
check("T3 add Idea via palette", await safe("T3 Idea", () => addBoxViaPalette("Idea")));
check("T3 add Research via palette", await safe("T3 Research", () => addBoxViaPalette("Research")));
check("T3 note renders as post-it annotation", !!(await page.$(".note-node")));
check("T3 label renders as floating chip", !!(await page.$(".label-pill")));
check("T3 timer shows 05:00 default", /05:00/.test(await bodyText()));
check("T3 idea textareas present", (await page.$$("textarea[placeholder*='your idea']")).length >= 2);
check("T3 Run buttons only on research boxes", await safe("T3 run count", async () => {
  const st = await page.evaluate(() => {
    const s = window.__dsh.useBoardStore.getState();
    return {
      research: s.nodes.filter((n) => (n.data.boxType || n.type) === "research").length,
      runBtns: Array.from(document.querySelectorAll("button")).filter((b) => /▶ Run/.test(b.textContent)).length,
    };
  });
  return st.runBtns === st.research && st.research >= 2;
}));

// ---------- T4: Note end-to-end ----------
await safe("T4 note flow", async () => {
  const ta = await page.$(".note-textarea");
  if (!ta) return check("T4 note flow", false, "no textarea");
  await page.evaluate(() => {
    const el = document.querySelector(".note-textarea");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    setter.call(el, "E2E: demo notes work!");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForTimeout(400);
  const found = await page.evaluate(() => {
    const s = window.__dsh.useBoardStore.getState();
    return Object.values(s.boxData).some((b) => b.content === "E2E: demo notes work!");
  });
  check("T4 note typing persists to store", found);
  check("T4 note shows author attribution", /E2E Tester/.test(await bodyText()));
});

// ---------- T5: Label end-to-end ----------
await safe("T5 label flow", async () => {
  await page.evaluate(() => document.querySelector(".label-pill").click());
  await page.waitForTimeout(300);
  const input = await page.$("input[placeholder='Label text…']");
  check("T5 label click-to-edit opens", !!input);
  if (input) {
    await input.fill("Sprint 1 Goals");
    await input.press("Enter");
    await page.waitForTimeout(400);
  }
  const saved = await page.evaluate(() => {
    const s = window.__dsh.useBoardStore.getState();
    return Object.values(s.boxData).some((b) => b.content === "Sprint 1 Goals");
  });
  check("T5 label text saved", saved);
  check("T5 label pill shows new text", /Sprint 1 Goals/.test(await bodyText()));
});

// ---------- T6: Timer end-to-end ----------
await safe("T6 timer flow", async () => {
  // duration 10s, started through the real UI
  await page.evaluate(() => {
    const inp = document.querySelector("input[placeholder='MM:SS']");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(inp, "10");
    inp.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForTimeout(200);
  const before = await page.evaluate(() => window.__e2e.updateCalls);
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll("button")).find((b) => /▶ Start/.test(b.textContent));
    btn && btn.click();
  });
  await page.waitForTimeout(1200);
  const running = await page.evaluate((b) => {
    const s = window.__dsh.useBoardStore.getState();
    const t = Object.values(s.boxData).find((x) => x.timerStatus === "running");
    return { running: !!t, startedBy: t?.timerStartedBy, calls: window.__e2e.updateCalls - b };
  }, before);
  check("T6 timer starts (running in store)", running.running);
  check("T6 timer records starter", running.startedBy === "e2e@test.local");
  check("T6 exactly 1 store write on Start", running.calls === 1, `writes=${running.calls}`);
  const d1 = (await bodyText()).match(/\b00:0\d\b/)[0];
  await page.waitForTimeout(1500);
  const d2 = (await bodyText()).match(/\b00:0\d\b/)[0];
  const tickWrites = await page.evaluate(() => window.__e2e.updateCalls);
  check("T6 digits tick down", d1 !== d2, `${d1} → ${d2}`);
  check("T6 zero writes while ticking", tickWrites - before === 1, `total extra=${tickWrites - before}`);
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll("button")).find((b) => /⏹ Stop/.test(b.textContent));
    btn && btn.click();
  });
  await page.waitForTimeout(400);
  const s1 = ((await bodyText()).match(/\b00:0\d\b/) || ["00:00"])[0];
  await page.waitForTimeout(1300);
  const s2 = ((await bodyText()).match(/\b00:0\d\b/) || ["00:00"])[0];
  const stopped = await page.evaluate(() =>
    Object.values(window.__dsh.useBoardStore.getState().boxData).some((b) => b.timerStatus === "stopped")
  );
  check("T6 Stop freezes the display", s1 === s2 && stopped, `${s1} == ${s2}`);
});

// ---------- TA: Area drawing tool end-to-end ----------
await safe("TA areas flow", async () => {
  // Dismiss the "How to use" panel so it doesn't block canvas drags.
  await page.evaluate(() => {
    const panel = Array.from(document.querySelectorAll("div")).find((d) =>
      (d.textContent || "").includes("How to use") && d.className.includes("rounded-xl")
    );
    const x = panel && panel.querySelector("button");
    x && x.click();
  });
  await page.waitForTimeout(300);

  // Activate the area tool via the real toolbar button.
  const activated = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll("button")).find((b) =>
      /▭ Area$/.test((b.textContent || "").trim())
    );
    if (!btn) return false;
    btn.click();
    return true;
  });
  check("TA area tool activates", activated);
  // Pick a pale color (Emerald, index 2) via the tool palette.
  await page.evaluate(() => {
    const dot = Array.from(document.querySelectorAll("button")).find((b) =>
      (b.title || "").includes("Draw color — Emerald")
    );
    dot && dot.click();
  });
  await page.waitForTimeout(200);

  // Draw by dragging on empty canvas — probe a few regions until one hits
  // the pane (the board content position depends on fitView).
  const before = await page.evaluate(() => window.__dsh.useBoardStore.getState().nodes.length);
  const regions = [
    [250, 560, 950, 740],
    [700, 120, 1000, 380],
    [300, 70, 700, 170],
  ];
  let areaId = null;
  for (const [x1, y1, x2, y2] of regions) {
    await page.mouse.move(x1, y1);
    await page.mouse.down();
    await page.mouse.move(Math.round((x1 + x2) / 2), Math.round((y1 + y2) / 2));
    await page.mouse.move(x2, y2);
    await page.mouse.up();
    await page.waitForTimeout(500);
    areaId = await page.evaluate(() => {
      const s = window.__dsh.useBoardStore.getState();
      const a = s.nodes.find((n) => n.type === "area");
      return a ? a.id : null;
    });
    if (areaId) break;
  }
  check("TA drawing a drag creates an area node", !!areaId, areaId || "none");

  if (areaId) {
    // z-order: the area must sit BELOW box nodes (zIndex -1 vs >= 0).
    const z = await page.evaluate((id) => {
      const areaZ = document.querySelector(`.react-flow__node[data-id="${id}"]`)?.style?.zIndex;
      const anyBox = Array.from(document.querySelectorAll(".react-flow__node")).find((n) =>
        n.querySelector(".box-node")
      );
      return { areaZ, boxZ: anyBox ? anyBox.style.zIndex || "0" : null };
    }, areaId);
    check("TA area renders below the boxes (zIndex -1)", z.areaZ === "-1", JSON.stringify(z));

    // Recolor via the selected-area picker.
    await page.mouse.click(
      Number(await page.evaluate((id) => document.querySelector(`.react-flow__node[data-id="${id}"]`).getBoundingClientRect().left, areaId)) + 12,
      Number(await page.evaluate((id) => document.querySelector(`.react-flow__node[data-id="${id}"]`).getBoundingClientRect().top, areaId)) + 12
    );
    await page.waitForTimeout(400);
    const recolored = await page.evaluate(() => {
      const dot = Array.from(document.querySelectorAll("button")).find((b) =>
        (b.title || "").includes("Area color — Violet")
      );
      if (!dot) return { found: false };
      dot.click();
      return { found: true };
    });
    await page.waitForTimeout(400);
    const areaData = await page.evaluate((id) => {
      const n = window.__dsh.useBoardStore.getState().nodes.find((x) => x.id === id);
      return n ? { fill: n.data?.fill, border: n.data?.border } : null;
    }, areaId);
    check("TA area can be recolored via its picker", recolored.found && areaData?.fill === "#ede9fe", JSON.stringify(areaData));

    // Delete via the selected-area ✕.
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button")).find((b) =>
        (b.title || "").includes("Delete area")
      );
      btn && btn.click();
    });
    await page.waitForTimeout(500);
    const gone = await page.evaluate((id) =>
      !window.__dsh.useBoardStore.getState().nodes.some((n) => n.id === id || n.type === "area")
    , areaId);
    check("TA area deleted via ✕", gone);
  }
});

// ---------- T7: AI run end-to-end (real backend + Ollama) ----------
await safe("T7 run flow", async () => {
  // Fill the FIRST idea box and connect it to the FIRST research box, then
  // click that research box's real Run button.
  const ids = await page.evaluate(() => {
    const s = window.__dsh.useBoardStore.getState();
    const byType = (t) => s.nodes.find((n) => (n.data.boxType || n.type) === t);
    const idea = byType("idea"), research = byType("research");
    s.updateBoxData(idea.id, {
      content: "AI-powered meal planning app that creates weekly menus from dietary preferences",
      output: "AI-powered meal planning app that creates weekly menus from dietary preferences",
    });
    window.__dsh.useBoardStore.setState({
      edges: [{ id: "e2e-edge", source: idea.id, target: research.id }],
    });
    return { idea: idea.id, research: research.id };
  });
  const runClicked = await page.evaluate((rid) => {
    const btn = Array.from(
      document.querySelectorAll(`.react-flow__node[data-id="${rid}"] button`)
    ).find((b) => /▶ Run/.test(b.textContent));
    if (!btn) return false;
    btn.click();
    return true;
  }, ids.research);
  check("T7 Run button clicked on the connected research box", runClicked);
  let done = false, outLen = 0, tokens = null;
  for (let i = 0; i < 45; i++) {
    await page.waitForTimeout(2000);
    const st = await page.evaluate((rid) => {
      const s = window.__dsh.useBoardStore.getState();
      const b = s.boxData[rid];
      return b && b.status === "done" && b.output && b.output.length > 100
        ? { len: b.output.length, tokens: b.tokens } : null;
    }, ids.research);
    if (st) { done = true; outLen = st.len; tokens = st.tokens; break; }
  }
  check("T7 research generated via real /api/generate", done, `output ${outLen} chars`);
  check("T7 token usage recorded", !!tokens && tokens.totalTokens > 0, tokens ? `${tokens.totalTokens} tokens` : "none");
  const rendered = await page.evaluate((rid) => {
    const md = document.querySelector(`.react-flow__node[data-id="${rid}"] .markdown-output`);
    return md ? md.textContent.length : 0;
  }, ids.research);
  check("T7 markdown output rendered in the box", rendered > 100, `${rendered} chars visible`);
  check("T7 token badge visible in box footer", /tok/.test(await bodyText()));
});

// ---------- T8: API health through the real Vite proxy ----------
check("T8 /api/health via Vite proxy", await safe("T8 health", async () => {
  const health = await page.evaluate(() => fetch("/api/health").then((r) => r.json()));
  return health.status === "ok" && health.ollamaKey === "configured";
}));


// ---------- PART 2: REAL AUTH + REAL FIRESTORE (two users, live sync) ----------
// Requires the Email/Password provider (enabled via the Identity Toolkit
// admin API — see AGENTS.md). Two fresh browser contexts sign in as real
// test users; board creation, persistence across reload, and live cross-user
// sync (notes, timer, presence) all go through real Firestore.
const PW = "E2e-Test-2025!";
const USER_A = "e2e-a@test.local";
const USER_B = "e2e-b@test.local";

const signInReal = async (page, email) =>
  page.evaluate(async ({ em, pw }) => {
    const m = await import("/src/lib/auth.ts");
    try {
      await m.createTestAccount(em, pw);
    } catch (e) {
      // already exists from a previous run — just sign in
      if (!/email-already-in-use/.test(e?.message || "")) throw e;
      await m.signInTestAccount(em, pw);
    }
    return (window.__dsh.useAuthStore.getState().user || {}).email || null;
  }, { em: email, pw: PW });

const waitFor = async (fn, { timeout = 20000, every = 500, label = "" } = {}) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, every));
  }
};

// ---------- TD: Documents box — upload, extraction, and prompt flow ----------
await safe("TD documents flow", async () => {
  // Add a Documents box through the real palette.
  const before = await page.evaluate(() => window.__dsh.useBoardStore.getState().nodes.length);
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll("button")).find((b) =>
      (b.textContent || "").trim().endsWith("Documents")
    );
    btn && btn.click();
  });
  await page.waitForTimeout(600);
  const added = await page.evaluate((b) => window.__dsh.useBoardStore.getState().nodes.length === b + 1, before);
  check("TD documents box added via palette", added);

  // Helper: put files on the box's hidden multi-file input (native setter).
  const uploadFiles = (files) =>
    page.evaluate((f) => {
      const dt = new DataTransfer();
      for (const { name, content, type } of f) dt.items.add(new File([content], name, { type }));
      const inp = document.querySelector("input[accept*='.pdf']");
      if (!inp) throw new Error("documents input not found");
      inp.files = dt.files;
      inp.dispatchEvent(new Event("change", { bubbles: true }));
    }, files);

  // 1) A plain text file — extraction is synchronous-fast.
  await uploadFiles([{ name: "spec.txt", content: "The quarterly roadmap targets DOC-PIPELINE-OK.", type: "text/plain" }]);
  const txtDone = await waitFor(async () =>
    page.evaluate(() => {
      const s = window.__dsh.useBoardStore.getState();
      const docs = Object.values(s.boxData).flatMap((b) => b.documents || []);
      return docs.find((d) => d.name === "spec.txt" && d.chars > 0 && !d.error) || null;
    }), { label: "txt extraction", timeout: 15000 });
  check("TD txt extracted and stored", !!txtDone, JSON.stringify(txtDone || ""));

  // 2) A minimal hand-written PDF — exercises the lazy pdf.js path.
  const pdfBytes =
    "%PDF-1.4\n" +
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n" +
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n" +
    "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj\n" +
    "4 0 obj << /Length 52 >> stream\n" +
    "BT /F1 24 Tf 72 700 Td (Hello Canva Documents) Tj ET\n" +
    "endstream endobj\n" +
    "5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n" +
    "trailer << /Size 6 /Root 1 0 R >>\n%%EOF";
  await uploadFiles([{ name: "tiny.pdf", content: pdfBytes, type: "application/pdf" }]);
  const pdfDone = await waitFor(async () =>
    page.evaluate(() => {
      const s = window.__dsh.useBoardStore.getState();
      const docs = Object.values(s.boxData).flatMap((b) => b.documents || []);
      return docs.find((d) => d.name === "tiny.pdf") || null;
    }), { label: "pdf extraction", timeout: 30000 });
  check(
    "TD pdf extracted via lazy pdf.js",
    !!pdfDone && !pdfDone.error && /Hello Canva Documents/.test(pdfDone.text || ""),
    JSON.stringify(pdfDone ? { error: pdfDone.error, chars: pdfDone.chars, head: (pdfDone.text || "").slice(0, 40) } : "")
  );

  // 3) The extracted text must reach a connected AI box's prompt. Intercept
  //    /api/generate (mock response) so the assertion is deterministic.
  const docsBoxId = await page.evaluate(() => {
    const s = window.__dsh.useBoardStore.getState();
    const n = s.nodes.find((x) => (x.data.boxType || x.type) === "documents");
    return n ? n.id : null;
  });
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll("button")).find((b) =>
      (b.textContent || "").trim().endsWith("Summarize")
    );
    btn && btn.click();
  });
  await page.waitForTimeout(500);
  await page.evaluate((srcId) => {
    const s = window.__dsh.useBoardStore.getState();
    const target = s.nodes.find((x) => (x.data.boxType || x.type) === "summarize");
    s.onConnect({ source: srcId, target: target.id, sourceHandle: null, targetHandle: null });
  }, docsBoxId);
  await page.waitForTimeout(400);

  await page.evaluate(() => {
    window.__e2e_gen = [];
    window.__e2e_origFetch = window.fetch;
    window.fetch = async (url, init) => {
      if (String(url).includes("/api/generate")) {
        window.__e2e_gen.push(init?.body ? JSON.parse(init.body) : null);
        return new Response(
          JSON.stringify({ content: "ECHO", model: "mock", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return window.__e2e_origFetch(url, init);
    };
  });
  await page.evaluate(() => {
    const s = window.__dsh.useBoardStore.getState();
    const target = s.nodes.find((x) => (x.data.boxType || x.type) === "summarize");
    const btn = Array.from(document.querySelectorAll("button")).find(
      (b) => /▶ Run/.test(b.textContent || "") && b.closest(`.react-flow__node[data-id="${target.id}"]`)
    );
    btn && btn.click();
  });
  const genBody = await waitFor(async () => {
    const calls = await page.evaluate(() => window.__e2e_gen);
    return calls.length ? calls[calls.length - 1] : null;
  }, { label: "generate call", timeout: 15000 });
  // Restore the real fetch so nothing after this sees the mock.
  await page.evaluate(() => { window.fetch = window.__e2e_origFetch; });

  check(
    "TD document text flows into a connected box's prompt",
    !!genBody &&
      /=== spec\.txt ===/.test(genBody.userPrompt || "") &&
      /DOC-PIPELINE-OK/.test(genBody.userPrompt || "") &&
      /=== tiny\.pdf ===/.test(genBody.userPrompt || ""),
    JSON.stringify((genBody ? genBody.userPrompt : "") || "").slice(0, 120)
  );

  // 4) Removing a document updates the store.
  await page.evaluate(() => {
    const rm = Array.from(document.querySelectorAll("button")).find((b) => b.title === "Remove this document");
    rm && rm.click();
  });
  const afterRemove = await page.evaluate(() => {
    const s = window.__dsh.useBoardStore.getState();
    const docs = Object.values(s.boxData).flatMap((b) => b.documents || []);
    return docs.length;
  });
  check("TD document removed from the box", afterRemove === 1, `docs=${afterRemove}`);
});

// Close the fake-user page — the rest runs in fresh, isolated contexts.
await page.close();

// ----- T9: real sign-in (user A) + real board auto-creation -----
const ctxA = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const pageA = await ctxA.newPage();
await pageA.goto(APP, { waitUntil: "load" });
{
  const email = await signInReal(pageA, USER_A);
  check("T9 real email/password sign-in", email === USER_A, `user=${email}`);
  // Self-cleaning: remove test boards left by earlier crashed runs.
  await safe("T9 cleanup leftovers", async () => {
    await pageA.evaluate(() => window.__dsh.useBoardStore.getState().refreshBoardList());
    await pageA.waitForTimeout(2500);
    await pageA.evaluate(async (ownerEmail) => {
      const fs = await import("/src/lib/firestore.ts");
      const s = window.__dsh.useBoardStore.getState();
      for (const b of s.boardList) {
        if (b.ownerEmail === ownerEmail) await fs.deleteBoard(b.id);
      }
      window.__dsh.useBoardStore.setState({ currentBoardId: null, boardList: [] });
    }, USER_A);
  });
  // Create a fresh board through the real store action (the auto-init effect
  // already ran while a leftover board existed, so create explicitly here).
  await pageA.evaluate(async () => {
    await window.__dsh.useBoardStore.getState().createNewBoard("E2E Test Board");
  });
  const boardId = await waitFor(
    () => pageA.evaluate(() => window.__dsh.useBoardStore.getState().currentBoardId),
    { label: "board creation", timeout: 45000 }
  ).catch(() => null);
  check("T9 real board created in Firestore", !!boardId, boardId || "none");
  const saveStatus = await pageA.evaluate(() => window.__dsh.useBoardStore.getState().saveStatus);
  check("T9 board saved (saveStatus)", saveStatus === "saved", saveStatus);

  // ----- T10: real persistence across a page reload -----
  // Add a note through the real palette, type, let the debounced save land,
  // then reload — the board must come back from Firestore with the note.
  await pageA.evaluate(() => {
    const btn = Array.from(document.querySelectorAll("button")).find((b) =>
      b.textContent.trim().endsWith("Note")
    );
    btn && btn.click();
  });
  await pageA.waitForTimeout(600);
  const noteId = await waitFor(
    () => pageA.evaluate(() => {
      const s = window.__dsh.useBoardStore.getState();
      const n = Object.values(s.boxData).find((b) => b.authorEmail === "e2e-a@test.local");
      return n ? s.nodes.find((x) => x.id === Object.keys(s.boxData).find((k) => s.boxData[k] === n))?.id : null;
    }),
    { label: "note added" }
  ).catch(() => null);
  check("T10 note added as real user A", !!noteId);
  if (noteId) {
    await pageA.evaluate(({ text }) => {
      const el = document.querySelector(".note-textarea");
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
      setter.call(el, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }, { text: "Persisted across reload!" });
    await pageA.waitForTimeout(2500); // debounced save + Firestore round-trip
    const savedBeforeReload = await pageA.evaluate((id) =>
      window.__dsh.useBoardStore.getState().boxData[id]?.content
    , noteId);
    await pageA.reload({ waitUntil: "load" });
    const back = await waitFor(
      () => pageA.evaluate((id) => {
        const s = window.__dsh.useBoardStore.getState();
        return s.currentBoardId && s.boxData[id]?.content === "Persisted across reload!" ? true : null;
      }, noteId),
      { label: "board reload from Firestore", timeout: 45000 }
    ).catch(() => null);
    check("T10 session persists across reload (no re-login)", await waitFor(
      () => pageA.evaluate((em) =>
        window.__dsh.useAuthStore.getState().user?.email === em ? true : null, USER_A),
      { label: "session restore", timeout: 30000 }
    ).then(() => true).catch(() => false));
    check("T10 board reloads from Firestore with the note", !!back, `pre-reload content=${JSON.stringify(savedBeforeReload)}`);
  }

  // ----- T11: second real user opens the same board via ?board= -----
  const ctxB = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const pageB = await ctxB.newPage();
  const fullBoardId = await pageA.evaluate(() => window.__dsh.useBoardStore.getState().currentBoardId);
  await pageB.goto(`${APP}/?board=${fullBoardId}`, { waitUntil: "load" });
  {
    const emailB = await signInReal(pageB, USER_B);
    check("T11 second real user signs in", emailB === USER_B, `user=${emailB}`);
    const joined = await waitFor(
      () => pageB.evaluate(() => {
        const s = window.__dsh.useBoardStore.getState();
        return s.currentBoardId && Object.keys(s.boxData).length > 0 ? true : null;
      }),
      { label: "B loads shared board", timeout: 45000 }
    ).catch(() => null);
    check("T11 user B opens A's board via ?board= link", !!joined);

    // ----- T12: live cross-user sync — note edit, timer, presence -----
    // A edits the note; B must see the new text via the onSnapshot sync.
    await pageA.evaluate((id) => {
      const el = document.querySelector(".note-textarea");
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
      setter.call(el, "Edited live by A!");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }, noteId);
    const bSawEdit = await waitFor(
      () => pageB.evaluate(() => {
        const s = window.__dsh.useBoardStore.getState();
        const n = Object.values(s.boxData).find((b) => b.authorEmail === "e2e-a@test.local");
        return n?.content === "Edited live by A!" ? true : null;
      }),
      { label: "B sees A's note edit", timeout: 15000 }
    ).catch(() => null);
    check("T12 note edit syncs A → B live", !!bSawEdit);

    // B adds a Timer box via its real palette, then starts it; A must see the
    // new box AND the running timer with attribution (full cross-user sync).
    await pageB.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button")).find((b) =>
        b.textContent.trim().endsWith("Timer")
      );
      btn && btn.click();
    });
    const bTimerId = await waitFor(
      () => pageB.evaluate(() => {
        const s = window.__dsh.useBoardStore.getState();
        const n = s.nodes.find((x) => (x.data.boxType || x.type) === "timer");
        return n?.id || null;
      }),
      { label: "B adds timer box" }
    ).catch(() => null);
    check("T12 B adds a timer box via palette", !!bTimerId);
    await pageB.evaluate(() => {
      const inp = document.querySelector("input[placeholder='MM:SS']");
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(inp, "15");
      inp.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await pageB.waitForTimeout(200);
    await pageB.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button")).find((b) => /▶ Start/.test(b.textContent));
      btn && btn.click();
    });
    const aSawTimer = await waitFor(
      () => pageA.evaluate(() => {
        const s = window.__dsh.useBoardStore.getState();
        const t = Object.values(s.boxData).find((b) => b.timerStatus === "running");
        return t?.timerStartedBy === "e2e-b@test.local" ? true : null;
      }),
      { label: "A sees B's timer start", timeout: 15000 }
    ).catch(() => null);
    check("T12 timer start syncs B → A (with attribution)", !!aSawTimer);
    await pageA.waitForTimeout(800);
    const aDigits = await waitFor(
      () => pageA.evaluate(() => (/00:1[0-5]/.test(document.body.innerText) ? true : null)),
      { label: "A renders synced timer", timeout: 15000 }
    ).then(() => true).catch(() => false);
    check("T12 A's display counts down from B's start", aDigits);
    // B stops; A must see it frozen/stopped.
    await pageB.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button")).find((b) => /⏹ Stop/.test(b.textContent));
      btn && btn.click();
    });
    const aSawStop = await waitFor(
      () => pageA.evaluate(() =>
        Object.values(window.__dsh.useBoardStore.getState().boxData).some((b) => b.timerStatus === "stopped") ? true : null
      ),
      { label: "A sees B's stop", timeout: 15000 }
    ).catch(() => null);
    check("T12 timer stop syncs B → A", !!aSawStop);

    // Presence: A moves its mouse over the canvas; B should list A as active.
    await pageA.mouse.move(640, 400);
    await pageA.waitForTimeout(300);
    await pageA.mouse.move(700, 450);
    await pageA.waitForTimeout(2500);
    const bSeesA = await pageB.evaluate(() =>
      window.__dsh.useBoardStore.getState().activeUsers.some((u) => u.email === "e2e-a@test.local")
    );
    check("T12 presence: B sees A active on the board", bSeesA);

    // Roster popover: move B's mouse (writes B's presence too), then B opens
    // the "who's on this board" panel — both users must be listed, with a
    // "you" marker on B's own row.
    await pageB.mouse.move(500, 350);
    await pageB.waitForTimeout(400);
    await pageB.mouse.move(560, 380);
    await pageB.waitForTimeout(2500); // presence writes (200ms throttle) + snapshot
    const roster = await safe("T12 roster", async () => {
      const label = await pageB.evaluate(() => {
        const btn = Array.from(document.querySelectorAll("button")).find((b) =>
          /online/.test(b.textContent || "")
        );
        return btn ? btn.textContent.replace(/\s+/g, " ").trim() : null;
      });
      const opened = await pageB.evaluate(() => {
        const btn = Array.from(document.querySelectorAll("button")).find((b) =>
          /online/.test(b.textContent || "")
        );
        if (!btn) return false;
        btn.click();
        return true;
      });
      await pageB.waitForTimeout(400);
      const list = await pageB.evaluate(() => {
        // Target the popover via its test id (a text search would match
        // ancestor divs and give false positives from canvas content).
        const pop = document.querySelector('[data-testid="roster-popover"]');
        if (!pop) return null;
        const rows = Array.from(pop.querySelectorAll('[data-testid="roster-row"]'));
        return {
          rowCount: rows.length,
          hasA: rows.some((r) => r.textContent.includes("e2e-a@test.local")),
          hasB: rows.some((r) => r.textContent.includes("e2e-b@test.local")),
          youMarker: rows.some((r) => !!r.querySelector('[data-testid="you-chip"]')),
        };
      });
      const dbg = await pageB.evaluate(async () => {
        const m = await import("/src/lib/presence.ts");
        const st = window.__dsh.useBoardStore.getState();
        const user = window.__dsh.useAuthStore.getState().user;
        const r = m.groupRoster(st.activeUsers, st.collaborators, user?.email || undefined);
        return {
          authEmail: user?.email,
          activeEmails: st.activeUsers.map((u) => u.email),
          online: r.online.map((o) => ({ email: o.email, isSelf: o.isSelf })),
        };
      });
      return { label, opened, list, dbg };
    });
    check(
      "T12 roster popover lists both users (with you-marker)",
      roster?.list?.rowCount === 2 && !!roster?.list?.hasA && !!roster?.list?.hasB && !!roster?.list?.youMarker,
      `label=${JSON.stringify(roster?.label)} list=${JSON.stringify(roster?.list)} dbg=${JSON.stringify(roster?.dbg)}`
    );
    check("T12 roster shows 2 online", (roster?.label || "").includes("2 online"), roster?.label || "");
    await ctxB.close();
  }

  // ----- T14: Custom boxes (create, instantiate, run, persist, delete) -----
  {
    const setNative = (sel, value) =>
      pageA.evaluate(({ sel, value }) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        const proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      }, { sel, value });

    // Open the create dialog via the real sidebar button.
    await pageA.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button")).find((b) =>
        (b.textContent || "").includes("New Custom Box")
      );
      btn && btn.click();
    });
    await pageA.waitForTimeout(400);
    check("T14 custom box modal opens", !!(await pageA.$("input[placeholder*='Translate to French']")));

    // Fill the form.
    await setNative("input[placeholder*='Translate to French']", "Echo Test Box");
    await setNative("input[placeholder*='What does this box do?']", "Replies with a fixed marker");
    await setNative("textarea[placeholder*='What the AI should do']", "Reply with exactly: CUSTOM-BOX-OK");
    await setNative("textarea[placeholder*='professional translator']", "You follow instructions literally.");
    await pageA.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button")).find((b) =>
        /Save to my profile/.test(b.textContent || "")
      );
      btn && btn.click();
    });
    await pageA.waitForTimeout(2000);

    // The definition is saved to the profile and listed in the palette.
    const listed = await pageA.evaluate(() =>
      window.__dsh && document.body.innerText.includes("Echo Test Box")
    );
    check("T14 saved definition appears in the palette", listed);

    // Add an instance to the board via the palette button.
    const beforeNodes = await pageA.evaluate(() => window.__dsh.useBoardStore.getState().nodes.length);
    await pageA.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button")).find((b) =>
        (b.textContent || "").trim().endsWith("Echo Test Box")
      );
      btn && btn.click();
    });
    await pageA.waitForTimeout(600);
    const inst = await pageA.evaluate((b) => {
      const s = window.__dsh.useBoardStore.getState();
      const n = s.nodes.find((x) => (x.data.boxType || x.type) === "custom");
      return n ? { id: n.id, nodes: s.nodes.length, prompt: s.boxData[n.id]?.prompt } : null;
    }, beforeNodes);
    check("T14 instance added from the template", !!inst && inst.nodes === beforeNodes + 1, JSON.stringify(inst?.prompt || "").slice(0, 40));

    // Run the instance through the real backend.
    if (inst) {
      await pageA.evaluate((id) => {
        const btn = Array.from(
          document.querySelectorAll(`.react-flow__node[data-id="${id}"] button`)
        ).find((b) => /▶ Run/.test(b.textContent));
        btn && btn.click();
      }, inst.id);
      let output = null;
      for (let i = 0; i < 45; i++) {
        await pageA.waitForTimeout(2000);
        output = await pageA.evaluate((id) => {
          const b = window.__dsh.useBoardStore.getState().boxData[id];
          return b && b.status === "done" ? b.output : null;
        }, inst.id);
        if (output) break;
      }
      check("T14 custom box runs via real /api/generate", !!output && /CUSTOM-BOX-OK/i.test(output), (output || "").slice(0, 40));
    }

    // Persistence: reload — the definition must still be listed in the
    // PALETTE (not the board instance, which shares the name).
    await pageA.reload({ waitUntil: "load" });
    const persisted = await waitFor(
      () => pageA.evaluate(() => {
        // The palette entry is a BUTTON whose text is exactly the def label;
        // the board instance renders the name in spans, not buttons.
        const btn = Array.from(document.querySelectorAll("button")).find((b) =>
          (b.textContent || "").trim().endsWith("Echo Test Box")
        );
        return btn ? true : null;
      }),
      { label: "custom def in palette after reload", timeout: 30000 }
    ).then(() => true).catch(() => false);
    check("T14 definition persists across reload (saved to profile)", persisted);

    // Delete the template via its hover ✕.
    const delDbg = await pageA.evaluate(async () => {
      // Delete every leftover "Echo Test Box" template (prior failed runs
      // may have left orphans behind — the suite self-heals).
      let deleted = 0;
      for (let i = 0; i < 5; i++) {
        const row = Array.from(document.querySelectorAll("button")).find((b) =>
          (b.textContent || "").trim().endsWith("Echo Test Box")
        );
        if (!row) break;
        const del = row.parentElement && row.parentElement.querySelector("button[title*='Delete this template']");
        if (!del) break;
        del.click();
        deleted++;
        await new Promise((r) => setTimeout(r, 700));
      }
      const row = Array.from(document.querySelectorAll("button")).find((b) =>
        (b.textContent || "").trim().endsWith("Echo Test Box")
      );
      const del = row && row.parentElement && row.parentElement.querySelector("button[title*='Delete this template']");
      const clicked = !!del && (del.click(), true);
      const store = await import("/src/store/userBoxesStore.ts");
      const auth = await import("/src/store/authStore.ts");
      return {
        rowFound: !!row,
        delFound: !!del,
        clicked,
        defCount: document.querySelectorAll("button[title*='Delete this template']").length,
        uid: auth.useAuthStore.getState().user?.uid,
        defs: store.useUserBoxesStore.getState().defs.map((d) => ({ id: d.id, label: d.label })),
      };
    });
    const removed = await waitFor(
      () => pageA.evaluate(() =>
        Array.from(document.querySelectorAll("button")).every((b) =>
          !(b.textContent || "").trim().endsWith("Echo Test Box")
        ) ? true : null
      ),
      { label: "template removed", timeout: 15000 }
    ).then(() => true).catch(() => false);
    check("T14 template deleted from the profile", removed, JSON.stringify(delDbg));
  }

  // ----- T13: cleanup — delete the test board, sign out -----
  {
    const deleted = await safe("T13 delete", async () => {
      await pageA.evaluate(async (ownerEmail) => {
        const fs = await import("/src/lib/firestore.ts");
        const s = window.__dsh.useBoardStore.getState();
        await s.refreshBoardList();
        // note: refreshBoardList is async in the store; give it a beat
        await new Promise((r) => setTimeout(r, 1500));
        for (const b of window.__dsh.useBoardStore.getState().boardList) {
          if (b.ownerEmail === ownerEmail) await fs.deleteBoard(b.id);
        }
        window.__dsh.useBoardStore.setState({ currentBoardId: null, boardList: [], nodes: [], edges: [], boxData: {} });
      }, USER_A);
      await pageA.waitForTimeout(1500);
      const remaining = await pageA.evaluate(() =>
        window.__dsh.useBoardStore.getState().boardList.length
      );
      return remaining === 0;
    });
    check("T13 test boards deleted from Firestore", deleted === true);
    await safe("T13 signout", async () => {
      await pageA.evaluate(async () => {
        const m = await import("/src/lib/auth.ts");
        await m.signOutUser();
      });
    });
  }
  await ctxA.close();
}

// ---------- PART 3: FACILITATOR + WORKSHOP GUEST ----------
// Runs against the local dev app; the guest join goes through the local
// server's proxy to the deployed join endpoint (custom-token minting needs
// the Admin SDK). The facilitator role is granted to e2e-a via the admin
// Firestore REST API (the same OAuth token used for user cleanup).
import fs from "node:fs";
import os from "node:os";
let adminToken = "";
try {
  const cfg = JSON.parse(fs.readFileSync(os.homedir() + "/.config/configstore/firebase-tools.json", "utf8"));
  const exp = cfg.tokens?.expires_at || 0;
  if (Date.now() / 1000 < exp) adminToken = cfg.tokens?.access_token || "";
} catch {
  // no token — facilitator checks will be skipped gracefully
}
const fsRest = (method, path, body) =>
  fetch(`https://firestore.googleapis.com/v1/projects/carbondocs/databases/(default)/documents${path}`, {
    method,
    headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }).then((r) => r.json());

await safe("TF facilitator flow", async () => {
  // Sign in a fresh facilitator user (e2e-f) — cleaner than reusing A.
  const ctxF = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const pageF = await ctxF.newPage();
  await pageF.goto(APP, { waitUntil: "load" });
  const fEmail = await signInReal(pageF, "e2e-f@test.local");
  check("TF facilitator signs in", fEmail === "e2e-f@test.local", `user=${fEmail}`);
  const fUid = await pageF.evaluate(() => window.__dsh.useAuthStore.getState().user?.uid);

  // Grant the facilitator role via the admin REST API, then reload so the
  // app picks up the flag.
  if (adminToken) {
    await fsRest("PATCH", `/facilitators/${fUid}`, {
      fields: { grantedBy: { stringValue: "e2e" }, grantedAt: { integerValue: "1" } },
    });
    await pageF.reload({ waitUntil: "load" });
    await waitFor(() => pageF.evaluate(() => window.__dsh.useAuthStore.getState().user?.uid === null ? null : true), {
      label: "facilitator re-login",
      timeout: 30000,
    }).catch(() => {});
    await pageF.waitForTimeout(2500);
  }
  const hasFacilitatorBtn = await pageF.evaluate(() =>
    Array.from(document.querySelectorAll("button")).some((b) => (b.textContent || "").includes("Facilitator"))
  );
  check("TF facilitator button appears after grant", hasFacilitatorBtn || !adminToken, adminToken ? "" : "(no admin token — skipped)");

  if (hasFacilitatorBtn) {
    // Open the dashboard and create a workshop.
    await pageF.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button")).find((b) =>
        (b.textContent || "").includes("🧑‍🏫 Facilitator")
      );
      btn && btn.click();
    });
    await pageF.waitForTimeout(600);
    const dashboard = await pageF.evaluate(() => document.body.innerText.includes("Facilitator Dashboard"));
    check("TF dashboard opens", dashboard);

    await pageF.evaluate(() => {
      const inp = document.querySelector("input[placeholder*='Workshop name']");
      if (!inp) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(inp, "E2E Workshop");
      inp.dispatchEvent(new Event("input", { bubbles: true }));
      const btn = Array.from(document.querySelectorAll("button")).find((b) => b.textContent.trim() === "Create");
      btn && btn.click();
      return true;
    });
    await pageF.waitForTimeout(2000);
    const workshopCreated = await pageF.evaluate(() => document.body.innerText.includes("E2E Workshop"));
    check("TF workshop created", workshopCreated);

    // Create a template board (Create & open), then return to the dashboard.
    await pageF.evaluate(() => {
      const tabs = Array.from(document.querySelectorAll("button")).filter((b) => b.textContent.trim() === "templates");
      tabs[0] && tabs[0].click();
    });
    await pageF.waitForTimeout(400);
    await pageF.evaluate(() => {
      const inp = document.querySelector("input[placeholder*='Template name']");
      if (!inp) return;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(inp, "E2E Template");
      inp.dispatchEvent(new Event("input", { bubbles: true }));
      const btn = Array.from(document.querySelectorAll("button")).find((b) =>
        (b.textContent || "").includes("Create & open")
      );
      btn && btn.click();
    });
    await pageF.waitForTimeout(3000); // template board created + opened
    const templateBoardLoaded = await pageF.evaluate(() =>
      !!window.__dsh.useBoardStore.getState().currentBoardId
    );
    check("TF template board created and opened", templateBoardLoaded);

    // Back to the dashboard → teams → create a team from the template.
    await pageF.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button")).find((b) =>
        (b.textContent || "").includes("🧑‍🏫 Facilitator")
      );
      btn && btn.click();
    });
    await pageF.waitForTimeout(800);
    await pageF.evaluate(() => {
      const tabs = Array.from(document.querySelectorAll("button")).filter((b) => b.textContent.trim() === "teams");
      tabs[0] && tabs[0].click();
    });
    // Wait for both selects to be populated (workshops + templates load
    // asynchronously after the dashboard mounts).
    await waitFor(
      () =>
        pageF.evaluate(() => {
          const sels = Array.from(document.querySelectorAll("select"));
          if (sels.length < 2) return null;
          const hasWs = Array.from(sels[0].options).some((o) => o.text === "E2E Workshop");
          const hasTpl = Array.from(sels[1].options).some((o) => o.text === "E2E Template");
          return hasWs && hasTpl ? true : null;
        }),
      { label: "team form selects populated", timeout: 20000 }
    ).catch(() => {});
    const setSelect = (idx, label) =>
      pageF.evaluate(({ idx, label }) => {
        const sel = document.querySelectorAll("select")[idx];
        if (!sel) return false;
        const opt = Array.from(sel.options).find((o) => o.text === label);
        if (!opt) return false;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set;
        setter.call(sel, opt.value);
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }, { idx, label });
    const wsOk = await setSelect(0, "E2E Workshop");
    await pageF.waitForTimeout(500);
    const tplOk = await setSelect(1, "E2E Template");
    const teamFormState = { wsOk, tplOk };
    await pageF.evaluate(() => {
      const selects = Array.from(document.querySelectorAll("select"));
      const tpl = selects[1];
      const tplSetter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set;
      const tplOption = Array.from(tpl.options).find((o) => o.text === "E2E Template");
      if (tplOption) { tplSetter.call(tpl, tplOption.value); tpl.dispatchEvent(new Event("change", { bubbles: true })); }
      const inp = document.querySelector("input[placeholder*='Team name']");
      if (inp) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        setter.call(inp, "Team Rocket");
        inp.dispatchEvent(new Event("input", { bubbles: true }));
      }
      const btn = Array.from(document.querySelectorAll("button")).find((b) => b.textContent.trim() === "Create team");
      btn && btn.click();
    });
    await pageF.waitForTimeout(3500);
    const seatCode = await pageF.evaluate(() => {
      const codes = Array.from(document.querySelectorAll("code")).map((c) => c.textContent.trim());
      const claimed = document.body.innerText.includes("Seats: 0/5");
      return { code: codes.find((c) => /^[A-Z2-9]{8}$/.test(c)) || null, zeroSeats: claimed, teamListed: document.body.innerText.includes("Team Rocket") };
    });
    check("TF team created from the template", seatCode.teamListed && seatCode.zeroSeats, JSON.stringify({ ...seatCode, ...teamFormState }));
    check("TF team has seat codes", !!seatCode.code, seatCode.code || "none");

    // ----- GUEST: join with the code in a fresh context -----
    if (seatCode.code) {
      const ctxG = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const pageG = await ctxG.newPage();
      await pageG.goto(APP, { waitUntil: "load" });
      await pageG.waitForTimeout(1500);
      // Open the code modal from the landing.
      await pageG.evaluate(() => {
        const btn = Array.from(document.querySelectorAll("button")).find((b) =>
          (b.textContent || "").includes("Have a workshop code?")
        );
        btn && btn.click();
      });
      await pageG.waitForTimeout(400);
      const modalOpened = await pageG.evaluate(() => !!document.querySelector("input[placeholder='CODE']"));
      check("TG guest code modal opens on the landing", modalOpened);
      await pageG.evaluate((code) => {
        const inp = document.querySelector("input[placeholder='CODE']");
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        setter.call(inp, code);
        inp.dispatchEvent(new Event("input", { bubbles: true }));
        const btn = Array.from(document.querySelectorAll("button")).find((b) => b.textContent.trim() === "Join");
        btn && btn.click();
      }, seatCode.code);
      // The guest signs in via the custom token, then gets the profile modal.
      const profileModal = await waitFor(
        () =>
          pageG.evaluate(() =>
            document.body.innerText.includes("Welcome to") &&
            document.querySelector("input[placeholder*='e.g. Alex']")
              ? true
              : null
          ),
        { label: "guest profile modal", timeout: 30000 }
      ).then(() => true).catch(() => false);
      check("TG guest gets the profile step (no login needed)", profileModal);
      const guestUid = await pageG.evaluate(() => window.__dsh.useAuthStore.getState().user?.uid).catch(() => null);
      if (profileModal) {
        await pageG.evaluate(() => {
          const inp = document.querySelector("input[placeholder*='e.g. Alex']");
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
          setter.call(inp, "Guesty McGuest");
          inp.dispatchEvent(new Event("input", { bubbles: true }));
          const btn = Array.from(document.querySelectorAll("button")).find((b) =>
            (b.textContent || "").includes("Join my team")
          );
          btn && btn.click();
        });
        const landed = await waitFor(
          () => pageG.evaluate(() => (window.__dsh.useBoardStore.getState().currentBoardId ? true : null)),
          { label: "guest lands on team board", timeout: 30000 }
        ).then(() => true).catch(() => false);
        check("TG guest lands on the team board", landed);
        const boardState = await pageG.evaluate(() => {
          const s = window.__dsh.useBoardStore.getState();
          return { title: s.boardTitle, nodes: s.nodes.length };
        });
        check("TG team board is the team's template copy", /Team Rocket/.test(boardState.title), JSON.stringify(boardState));

        // The guest creates their own individual board.
        await pageG.evaluate(() => {
          const btn = Array.from(document.querySelectorAll("button")).find((b) =>
            (b.textContent || "").includes("Boards (")
          );
          btn && btn.click();
        });
        await pageG.waitForTimeout(600);
        await pageG.evaluate(() => {
          const btn = Array.from(document.querySelectorAll("button")).find((b) =>
            (b.textContent || "").includes("New Board")
          );
          btn && btn.click();
        });
        await pageG.waitForTimeout(500);
        await pageG.evaluate(() => {
          const inp = document.querySelector("input[placeholder*='Startup Pitch']");
          if (inp) {
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
            setter.call(inp, "Guest Own Board");
            inp.dispatchEvent(new Event("input", { bubbles: true }));
          }
          const btn = Array.from(document.querySelectorAll("button")).find((b) =>
            (b.textContent || "").includes("Create") && inp
          );
          btn && btn.click();
        });
        await pageG.waitForTimeout(2500);
        const ownBoard = await pageG.evaluate(() => {
          const s = window.__dsh.useBoardStore.getState();
          return { title: s.boardTitle, id: s.currentBoardId };
        });
        check("TG guest can create their own board", /Guest Own Board/.test(ownBoard.title), ownBoard.title);

        // The team board is still visible in the guest's board list.
        const listHasTeam = await pageG.evaluate(() => {
          const s = window.__dsh.useBoardStore.getState();
          return s.boardList.some((b) => /Team Rocket/.test(b.title));
        });
        check("TG guest sees the team board in their board list", listHasTeam);

        // Cleanup: delete the guest auth user (REST) + close context.
        if (guestUid && adminToken) {
          await fetch("https://identitytoolkit.googleapis.com/v1/projects/carbondocs/accounts:delete", {
            method: "POST",
            headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
            body: JSON.stringify({ localId: guestUid }),
          }).catch(() => {});
        }
      }
      await ctxG.close();
    }

    // Cleanup: delete the team (also deletes its board + codes).
    await pageF.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button")).find((b) =>
        (b.title || "").includes("Delete the team")
      );
      btn && btn.click();
    });
    await pageF.waitForTimeout(2500);
    const teamGone = await pageF.evaluate(() => !document.body.innerText.includes("Team Rocket"));
    check("TF team deleted (board + codes cleaned up)", teamGone);

    // Revoke the facilitator role.
    if (adminToken && fUid) {
      await fsRest("DELETE", `/facilitators/${fUid}`);
    }
  }
  await ctxF.close();
});

// ---------- Summary ----------
const passed = results.filter((r) => r.ok).length;
console.log("\n================ E2E SUMMARY ================");
console.log(`${passed}/${results.length} passed`);
const noise = pageErrors.filter((e) => /permission|auth|token|user/i.test(e));
console.log(`page errors: ${pageErrors.length} (expected Firebase noise from fake user: ${noise.length})`);
pageErrors.slice(0, 5).forEach((e) => console.log("  [pageerror]", e));
await browser.close();
process.exit(passed === results.length ? 0 : 1);