// Notion Job Saver — "Answer with AI" panel.
// Injected on demand (via the context menu) into any page. Exposes
// window.__njsAnswerOpen(question), which opens a small panel that drafts an
// answer to the selected application question using your stored background and
// (optionally) a recently saved job, with copy + refine.
//
// Rendered inside a Shadow DOM so the host page's CSS can't leak in (arbitrary
// ATS portals have aggressive global styles that otherwise garble the panel).

(() => {
  // Injected fresh on every context-menu click — initialize only once so the
  // panel's listeners and state stay bound to a single closure.
  if (window.__njsAnswerInit) return;
  window.__njsAnswerInit = true;

  const HOST_ID = "njs-answer-host";
  const ICON_HOST_ID = "njs-answer-icon-host";
  let shadow = null;
  let question = "";
  let messages = null; // conversation so far (for refine); null until generated
  let recentJobs = [];
  let pendingSelection = ""; // text under the floating icon
  let iconEnabled = false; // floating icon on/off (from settings)
  let keyPresent = false; // an AI key is configured

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; text-shadow: none; letter-spacing: normal;
        word-spacing: normal; }
    .panel {
      position: fixed; top: 0; right: 0; width: 400px; max-width: 92vw;
      height: 100vh; background: #fff; color: #1a1a1a;
      box-shadow: -2px 0 16px rgba(0,0,0,.18); display: flex;
      flex-direction: column; z-index: 2147483647;
      font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      transform: translateX(100%); transition: transform .25s ease;
    }
    .panel * { font-family: inherit; }
    .head { display: flex; align-items: center; justify-content: space-between;
      padding: 16px 18px; border-bottom: 1px solid #eee; }
    .title { font-size: 16px; font-weight: 700; }
    .x { border: 0; background: transparent; font-size: 22px; line-height: 1;
      cursor: pointer; color: #666; padding: 0; }
    .body { padding: 16px 18px; overflow: auto; display: flex;
      flex-direction: column; gap: 12px; flex: 1; }
    label { font-size: 14px; font-weight: 600; display: block; margin-bottom: 6px; }
    .q { max-height: 120px; overflow: auto; padding: 10px; border: 1px solid #eee;
      border-radius: 8px; background: #fafafa; white-space: pre-wrap;
      font-size: 14px; }
    select, textarea { width: 100%; padding: 9px 10px; border: 1px solid #ddd;
      border-radius: 8px; background: #fff; color: #1a1a1a; font: inherit;
      line-height: 1.5; }
    textarea { resize: vertical; padding: 10px; }
    .row { display: flex; gap: 8px; }
    .gen { flex: 1; padding: 10px; border: 0; border-radius: 8px;
      background: #0a66c2; color: #fff; font-weight: 600; font-size: 14px;
      cursor: pointer; }
    .gen:disabled { opacity: .6; cursor: default; }
    .regen { display: none; padding: 10px 12px; border: 1px solid #ddd;
      border-radius: 8px; background: #f5f5f5; color: #333; font-weight: 600;
      cursor: pointer; }
    .hint { font-size: 12px; color: #666; }
    .status { font-size: 13px; color: #b91c1c; white-space: pre-wrap; }
    .out-wrap { position: relative; flex: 1; display: flex; flex-direction: column; }
    .copy { position: absolute; top: 26px; right: 8px; border: 0;
      background: #f0f0f0; border-radius: 6px; padding: 4px 8px; cursor: pointer;
      font-size: 12px; color: #1a1a1a; z-index: 1; }
    .out { flex: 1; min-height: 180px; resize: none; }
  `;

  const HTML = `
    <div class="panel">
      <div class="head">
        <span class="title">Answer with AI</span>
        <button id="close" class="x" title="Close">&times;</button>
      </div>
      <div class="body">
        <div>
          <label>Question</label>
          <div id="q" class="q"></div>
        </div>
        <div>
          <label>Use job context</label>
          <select id="job"></select>
        </div>
        <div>
          <label>Adjust (optional)</label>
          <textarea id="prefs" rows="4" placeholder="e.g. keep it under 100 words; mention my dbt experience."></textarea>
        </div>
        <div class="row">
          <button id="gen" class="gen">Generate</button>
          <button id="regen" class="regen" title="Start a fresh answer">&#8635;</button>
        </div>
        <div id="hint" class="hint"></div>
        <div id="status" class="status"></div>
        <div class="out-wrap">
          <label>Answer</label>
          <button id="copy" class="copy" title="Copy to clipboard">Copy</button>
          <textarea id="out" class="out" placeholder="Your answer will appear here."></textarea>
        </div>
      </div>
    </div>`;

  const el = (sel) => (shadow ? shadow.querySelector(sel) : null);

  function status(msg, isError) {
    const s = el("#status");
    if (!s) return;
    s.textContent = msg || "";
    s.style.color = isError ? "#b91c1c" : "#057642";
  }

  function build() {
    const host = document.createElement("div");
    host.id = HOST_ID;
    shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `<style>${CSS}</style>${HTML}`;
    document.body.appendChild(host);

    el("#close").addEventListener("click", close);
    el("#gen").addEventListener("click", () => generate({ refine: !!messages }));
    el("#regen").addEventListener("click", () => {
      messages = null;
      el("#out").value = "";
      generate({ refine: false });
    });
    el("#copy").addEventListener("click", onCopy);
    requestAnimationFrame(() => (el(".panel").style.transform = "translateX(0)"));
  }

  function close() {
    const host = document.getElementById(HOST_ID);
    if (!host) return;
    el(".panel").style.transform = "translateX(100%)";
    setTimeout(() => host.remove(), 250);
  }

  function updateMode() {
    const gen = el("#gen");
    if (!gen) return;
    gen.textContent = messages ? "Update answer" : "Generate";
    el("#regen").style.display = messages ? "" : "none";
    el("#hint").textContent = messages
      ? "Type an instruction above, then Update to refine. ↻ starts fresh."
      : "";
  }

  async function loadJobs() {
    const sel = el("#job");
    if (!sel) return;
    try {
      const { recentJobs: rj = [] } = await chrome.storage.local.get(["recentJobs"]);
      recentJobs = rj;
    } catch {
      recentJobs = [];
    }
    sel.innerHTML =
      '<option value="-1">No specific job</option>' +
      recentJobs
        .map((j, i) => {
          const label = [j.title, j.company].filter(Boolean).join(" — ").slice(0, 80);
          return `<option value="${i}">${escapeHtml(label)}</option>`;
        })
        .join("");
    sel.value = recentJobs.length ? "0" : "-1";
  }

  function escapeHtml(s) {
    return (s || "").replace(/[&<>"]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
    );
  }

  async function generate({ refine }) {
    const out = el("#out");
    const gen = el("#gen");
    const regen = el("#regen");
    const preferences = el("#prefs").value.trim();

    let payload;
    if (refine && messages) {
      if (!preferences) {
        status("Type an instruction above (e.g. “make it shorter”) to update.", true);
        return;
      }
      payload = { type: "ANSWER_QUESTION", messages, instruction: preferences };
    } else {
      const idx = parseInt(el("#job").value, 10);
      const job = idx >= 0 ? recentJobs[idx] : null;
      payload = { type: "ANSWER_QUESTION", question, job, preferences };
    }

    gen.disabled = true;
    regen.disabled = true;
    gen.textContent = refine ? "Updating…" : "Generating…";
    status("", false);
    try {
      const res = await chrome.runtime.sendMessage(payload);
      if (res && res.ok) {
        messages = res.messages;
        out.value = res.text;
        el("#prefs").value = "";
      } else {
        status((res && res.error) || "Generation failed.", true);
      }
    } catch (e) {
      status(
        /context invalidated/i.test(e.message || "")
          ? "Reload this tab (the extension was updated)."
          : e.message || String(e),
        true
      );
    } finally {
      gen.disabled = false;
      regen.disabled = false;
      updateMode();
    }
  }

  function onCopy() {
    const btn = el("#copy");
    navigator.clipboard
      .writeText(el("#out").value || "")
      .then(() => {
        const t = btn.textContent;
        btn.textContent = "Copied!";
        setTimeout(() => (btn.textContent = t), 1500);
      })
      .catch(() => status("Copy failed.", true));
  }

  // --- Floating "Answer with AI" icon on text selection --------------------
  function isOurNode(node) {
    return !!(
      node &&
      node.closest &&
      (node.closest(`#${ICON_HOST_ID}`) || node.closest(`#${HOST_ID}`))
    );
  }

  function iconShadow() {
    let host = document.getElementById(ICON_HOST_ID);
    if (host) return host.__njsShadow;
    host = document.createElement("div");
    host.id = ICON_HOST_ID;
    const sh = host.attachShadow({ mode: "open" });
    sh.innerHTML = `
      <style>
        :host { all: initial; }
        .btn { position: fixed; z-index: 2147483647; display: inline-flex;
          align-items: center; gap: 6px; padding: 5px 11px; border: 0;
          border-radius: 16px; cursor: pointer; background: #0a66c2; color: #fff;
          font: 600 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          box-shadow: 0 2px 8px rgba(0,0,0,.25); white-space: nowrap; }
        .btn svg { display: block; }
      </style>
      <button class="btn" title="Answer with AI">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff"
          stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg>
        Answer with AI
      </button>`;
    document.body.appendChild(host);
    host.__njsShadow = sh;
    const btn = sh.querySelector(".btn");
    // Don't let the click clear the selection before we use it.
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const text = pendingSelection;
      hideIcon();
      window.__njsAnswerOpen(text);
    });
    return sh;
  }

  function showIcon(rect, text) {
    pendingSelection = text;
    const btn = iconShadow().querySelector(".btn");
    btn.style.display = "inline-flex";
    const gap = 6;
    const w = btn.offsetWidth || 140; // measurable now that it's displayed
    const h = btn.offsetHeight || 26;
    let top = rect.top - h - gap;
    if (top < 4) top = rect.bottom + gap; // below if no room above
    // Align the pill's right edge to the right end of the selection.
    const left = Math.max(4, Math.min(rect.right - w, window.innerWidth - w - 4));
    btn.style.top = top + "px";
    btn.style.left = left + "px";
  }

  function hideIcon() {
    const host = document.getElementById(ICON_HOST_ID);
    if (host && host.__njsShadow) {
      host.__njsShadow.querySelector(".btn").style.display = "none";
    }
  }

  function onMouseUp(e) {
    if (!iconEnabled || !keyPresent || isOurNode(e.target)) return;
    setTimeout(() => {
      const sel = window.getSelection();
      const text = sel ? sel.toString().trim() : "";
      if (!text) return hideIcon();
      let rect;
      try {
        rect = sel.getRangeAt(0).getBoundingClientRect();
      } catch {
        return;
      }
      if (!rect || (!rect.width && !rect.height)) return;
      showIcon(rect, text);
    }, 10);
  }

  document.addEventListener("mouseup", onMouseUp, true);
  document.addEventListener("selectionchange", () => {
    const t = ((window.getSelection() || "").toString && window.getSelection().toString()) || "";
    if (!t.trim()) hideIcon();
  });
  window.addEventListener("scroll", hideIcon, true);

  async function loadSettings() {
    try {
      const s = await chrome.storage.local.get(["aiApiKey", "answerIconEnabled"]);
      keyPresent = !!s.aiApiKey;
      iconEnabled = s.answerIconEnabled !== false; // default on
    } catch {
      /* ignore */
    }
  }
  loadSettings();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.aiApiKey) keyPresent = !!changes.aiApiKey.newValue;
    if (changes.answerIconEnabled)
      iconEnabled = changes.answerIconEnabled.newValue !== false;
    if (!iconEnabled || !keyPresent) hideIcon();
  });

  // Public entry point (called by the background after injection).
  window.__njsAnswerOpen = async function (selectedText) {
    hideIcon();
    question = (selectedText || "").trim();
    messages = null;
    if (!document.getElementById(HOST_ID)) build();
    el(".panel").style.transform = "translateX(0)";
    el("#q").textContent = question || "(no text selected)";
    el("#out").value = "";
    el("#prefs").value = "";
    await loadJobs();
    updateMode();
  };
})();
