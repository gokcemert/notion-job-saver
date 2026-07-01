// Notion Job Saver — content script.
// Injects a "Save to Notion" button on supported job sites; on click it scrapes
// the job in-page and hands it to the background worker to write to Notion.
//
// Multi-platform via ADAPTERS: to support a new site, add one adapter object
// below and add its host to manifest.json "content_scripts".matches.

(() => {
  if (window.__notionJobSaverLoaded) return;
  window.__notionJobSaverLoaded = true;

  const BTN_CLASS = "notion-save-button";
  const PEN_CLASS = "notion-cover-button";
  const PANEL_ID = "notion-cover-panel";
  let coverEnabled = false; // true once an AI API key is configured
  let panelJob = null; // last job used for generation (PDF filename)
  // Session cache of generated letters, keyed by job id:
  //   jobId -> { letter, messages, title }
  const coverLetters = new Map();
  const clean = (s) => (s || "").replace(/\u00a0/g, " ").trim();
  const textOf = (sel, root = document) => {
    const el = root.querySelector(sel);
    return el ? clean(el.innerText) : "";
  };

  // =========================================================================
  // Platform adapters
  //
  //   name         value written to the Notion "Platform" column
  //   hostMatch    RegExp tested against location.hostname
  //   pathAllowed  (optional) () => boolean — only inject on job pages
  //   findAnchors  () => element(s) to place the button next to (e.g. Save btn)
  //   jobId        () => stable id for the current job (dedup / reset)
  //   scrape       async () => job | null
  //                job = { page_url, job_url, job_title, company_name, job_details }
  // =========================================================================

  // ---- LinkedIn -----------------------------------------------------------
  const LinkedInAdapter = {
    name: "Linkedin",
    hostMatch: /(^|\.)linkedin\.com$/i,
    pathAllowed: () => location.pathname.startsWith("/jobs"),
    jobId: () =>
      (location.href.match(/currentJobId=(\d+)/) ||
        location.href.match(/\/jobs\/view\/(\d+)/) ||
        [])[1] || location.pathname,
    findAnchors() {
      let a = document.querySelectorAll(".jobs-save-button");
      if (!a.length) a = document.querySelectorAll('[aria-label^="Save the job"]');
      if (!a.length) a = document.querySelectorAll(".jobs-apply-button");
      return a;
    },
    scrape() {
      return /\/jobs\/view\/\d+/.test(location.pathname)
        ? linkedInStandalone()
        : linkedInCard();
    },
  };

  // LinkedIn — card / split-view layout (collections, search).
  function linkedInCard() {
    const details = {
      page_url: location.href,
      job_url: "",
      job_title: "",
      company_name: "",
      job_details: "",
    };
    try {
      const titleEl = document.querySelector(
        ".job-details-jobs-unified-top-card__job-title"
      );
      const titleLink = titleEl ? titleEl.querySelector("a") : null;
      details.job_url = titleLink
        ? titleLink.href.split("?")[0]
        : location.href.split("?")[0];
      const companyEl = document.querySelector(
        ".job-details-jobs-unified-top-card__company-name"
      );
      details.company_name = companyEl ? clean(companyEl.innerText) : "";
      details.job_title = titleEl ? clean(titleEl.innerText) : "";
      const container = document.querySelector(".jobs-description__container");
      const descEl =
        (container && container.querySelector(".mt4")) ||
        document.querySelector(".jobs-description-content__text") ||
        document.querySelector(".jobs-box__html-content") ||
        container;
      details.job_details = descEl ? clean(descEl.innerText) : "";
      return details.job_title ? details : null;
    } catch (e) {
      console.error("[Notion Job Saver] linkedInCard error:", e);
      return null;
    }
  }

  // LinkedIn — standalone layout (/jobs/view/<id>).
  async function linkedInStandalone() {
    try {
      const jobId = (location.href.match(/\/jobs\/view\/(\d+)/) || [])[1] || null;

      // Title + company FIRST, before touching the DOM — a stray click can spawn
      // the "Did you finish applying?" dialog and collapse header line breaks.
      const banner = document.querySelector(
        '[componentkey^="JobDetails_ManageJobBanner_"]'
      );
      const header = banner ? banner.nextElementSibling : null;
      let company = "";
      let lines = [];
      if (header) {
        company =
          [...header.querySelectorAll('a[href*="/company/"]')]
            .map((a) => clean(a.innerText))
            .find(Boolean) || "";
        if (!company) {
          const aria = [...header.querySelectorAll('[aria-label^="Company,"]')].map(
            (e) => e.getAttribute("aria-label")
          )[0];
          if (aria) {
            company = clean(aria.replace(/^Company,\s*/i, "").replace(/\.$/, ""));
          }
        }
        lines = clean(header.innerText)
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean);
      }
      let title = company ? lines.find((l) => l && l !== company) || "" : "";
      if (!title) title = lines[1] || lines[0] || "";

      // Description — expand ONLY <button>s inside the description container.
      const descEl =
        (jobId &&
          document.querySelector(
            `[componentkey="JobDetails_AboutTheJob_${jobId}"]`
          )) ||
        document.querySelector('[componentkey^="JobDetails_AboutTheJob_"]');
      const moreRe = /^(?:…|\.\.\.)?\s*(?:see more|show more|more)$/i;
      if (descEl) {
        descEl.querySelectorAll("button").forEach((b) => {
          if (moreRe.test((b.innerText || "").trim())) {
            try {
              b.click();
            } catch (_) {}
          }
        });
        await new Promise((r) => setTimeout(r, 400));
      }
      const job_details = clean(descEl ? descEl.innerText : "")
        .replace(/^About the job\s*/i, "")
        .replace(/\n?(?:show less|see less)\s*$/i, "")
        .trim();

      if (!title) return null;
      return {
        page_url: location.href,
        job_url: jobId
          ? `https://www.linkedin.com/jobs/view/${jobId}/`
          : location.href.split("?")[0],
        job_title: title,
        company_name: company,
        job_details,
      };
    } catch (e) {
      console.error("[Notion Job Saver] linkedInStandalone error:", e);
      return null;
    }
  }

  // ---- StepStone ----------------------------------------------------------
  // Stable `data-at` hooks make this one straightforward.
  const StepStoneAdapter = {
    name: "Stepstone",
    hostMatch: /(^|\.)stepstone\.[a-z.]+$/i,
    findAnchors: () =>
      document.querySelectorAll('[data-at="header-save-button"]'),
    jobId: () => location.pathname,
    scrape() {
      const title = textOf('[data-at="header-job-title"]');
      if (!title) return null;
      return {
        page_url: location.href,
        job_url: location.href.split("?")[0],
        job_title: title,
        company_name: textOf('[data-at="metadata-company-name"]'),
        job_details: textOf('[data-at="job-ad-content"]'),
      };
    },
  };

  // ---- Registry -----------------------------------------------------------
  const ADAPTERS = [LinkedInAdapter, StepStoneAdapter];
  const activeAdapter = () =>
    ADAPTERS.find((a) => a.hostMatch.test(location.hostname));

  // =========================================================================
  // Button
  // =========================================================================
  function createButton() {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `${BTN_CLASS} artdeco-button artdeco-button--2 artdeco-button--secondary`;
    // Self-contained pill styling so it looks right regardless of the container.
    btn.style.cssText =
      "margin-left:8px;padding:6px 16px;min-height:32px;border-radius:16px;" +
      "border:1px solid;background:transparent;font-weight:600;font-size:14px;" +
      "line-height:20px;white-space:nowrap;box-sizing:border-box;";
    setState(btn, "idle");
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onSave(btn);
    });
    return btn;
  }

  function setState(btn, state, msg) {
    const styles = {
      idle: ["+ Save to Notion", "#0a66c2", "#0a66c2", false],
      loading: ["Saving…", "#666", "#666", true],
      success: ["✓ Saved to Notion", "#057642", "#057642", true],
      error: [msg || "Retry — Save to Notion", "#b91c1c", "#b91c1c", false],
    };
    const [text, color, border, disabled] = styles[state];
    btn.textContent = text;
    btn.disabled = disabled;
    btn.style.color = color;
    btn.style.borderColor = border;
    btn.style.cursor = disabled ? "default" : "pointer";
    btn.dataset.state = state;
  }

  async function onSave(btn) {
    setState(btn, "loading");
    try {
      const adapter = activeAdapter();
      const job = adapter ? await adapter.scrape() : null;
      if (!job) {
        setState(btn, "error");
        toast("Couldn't read the job — open it fully, then click again.", true);
        return;
      }
      job.platform = adapter.name; // record which site it came from
      const res = await chrome.runtime.sendMessage({ type: "SAVE_JOB", job });
      if (res && res.ok) {
        savedJobs.add(currentJobId());
        // Sync every button for this job to "saved".
        document
          .querySelectorAll(`.${BTN_CLASS}`)
          .forEach((b) => setState(b, "success"));
        toast(`Saved: ${job.job_title}`);
      } else {
        setState(btn, "error");
        toast(`Save failed: ${(res && res.error) || "unknown error"}`, true);
      }
    } catch (e) {
      setState(btn, "error");
      const m = /context invalidated/i.test(e.message || "")
        ? "Reload this tab (the extension was updated)."
        : e.message || String(e);
      toast(`Save failed: ${m}`, true);
    }
  }

  // =========================================================================
  // Toast
  // =========================================================================
  function toast(message, isError) {
    const el = document.createElement("div");
    el.textContent = message;
    el.style.cssText = `
      position: fixed; top: 20px; right: 20px; z-index: 99999;
      max-width: 340px; padding: 12px 16px; border-radius: 8px;
      color: #fff; font: 14px/1.4 -apple-system, BlinkMacSystemFont, sans-serif;
      box-shadow: 0 6px 18px rgba(0,0,0,.22);
      background: ${isError ? "#b91c1c" : "#057642"};
    `;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), isError ? 6000 : 3000);
  }

  // =========================================================================
  // Cover letter — pen button + side panel
  // =========================================================================
  function createPenButton() {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `${PEN_CLASS} artdeco-button artdeco-button--2 artdeco-button--secondary`;
    btn.title = "Generate a cover letter";
    btn.textContent = "✎";
    btn.style.cssText =
      "margin-left:8px;padding:6px 12px;min-height:32px;border-radius:16px;" +
      "border:1px solid #0a66c2;background:transparent;color:#0a66c2;" +
      "font-weight:600;font-size:15px;line-height:20px;cursor:pointer;box-sizing:border-box;";
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openPanel();
    });
    return btn;
  }

  function openPanel() {
    let panel = document.getElementById(PANEL_ID);
    if (!panel) panel = buildPanel();
    panel.style.transform = "translateX(0)";
    populatePanel(); // restore this job's letter if we have one
    const prefs = panel.querySelector('[data-njs="prefs"]');
    if (prefs) prefs.focus();
  }

  // Load the current job's cached letter (if any) into the panel and set the
  // Generate/Update mode accordingly.
  function populatePanel() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    const cached = coverLetters.get(currentJobId());
    panel.querySelector('[data-njs="output"]').value = cached ? cached.letter : "";
    if (cached) panelJob = { job_title: cached.title, company_name: cached.company };
    updatePanelMode(panel);
  }

  // Toggle between "Generate" (no letter yet) and "Update" (refine an existing
  // letter) based on whether the current job already has one this session.
  function updatePanelMode(panel) {
    panel = panel || document.getElementById(PANEL_ID);
    if (!panel) return;
    const has = coverLetters.has(currentJobId());
    const genBtn = panel.querySelector('[data-njs="generate"]');
    const regenBtn = panel.querySelector('[data-njs="regen"]');
    const prefs = panel.querySelector('[data-njs="prefs"]');
    const hint = panel.querySelector('[data-njs="hint"]');
    genBtn.textContent = has ? "Update letter" : "Generate";
    regenBtn.style.display = has ? "" : "none";
    prefs.placeholder = has
      ? "Refine it — e.g. “make it shorter”, “add my Python experience”, “warmer tone”."
      : "e.g. This role is in e-commerce; highlight my e-commerce experience.";
    hint.textContent = has
      ? "Type an instruction, then Update to refine. ↻ starts a fresh letter."
      : "";
  }

  function closePanel() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    panel.style.transform = "translateX(100%)";
    setTimeout(() => panel.remove(), 250);
  }

  function panelStatus(msg, isError) {
    const el = document.querySelector(`#${PANEL_ID} [data-njs="status"]`);
    if (!el) return;
    el.textContent = msg || "";
    el.style.color = isError ? "#b91c1c" : "#057642";
  }

  function buildPanel() {
    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.style.cssText =
      "position:fixed;top:0;right:0;width:420px;max-width:92vw;height:100vh;" +
      "background:#fff;color:#1a1a1a;box-shadow:-2px 0 16px rgba(0,0,0,.18);" +
      "z-index:2147483647;display:flex;flex-direction:column;" +
      "font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;" +
      "transform:translateX(100%);transition:transform .25s ease;";
    panel.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:16px 18px;border-bottom:1px solid #eee">
        <strong style="font-size:16px">Cover letter</strong>
        <button data-njs="close" title="Close" style="border:0;background:transparent;font-size:22px;line-height:1;cursor:pointer;color:#666">&times;</button>
      </div>
      <div style="padding:16px 18px;overflow:auto;display:flex;flex-direction:column;gap:12px;flex:1">
        <div>
          <label style="font-weight:600;display:block;margin-bottom:6px">Emphasize in this letter</label>
          <textarea data-njs="prefs" rows="4" placeholder="e.g. This role is in e-commerce; highlight my e-commerce experience." style="width:100%;box-sizing:border-box;padding:10px;border:1px solid #ddd;border-radius:8px;font:inherit;resize:vertical"></textarea>
        </div>
        <div style="display:flex;gap:8px">
          <button data-njs="generate" style="flex:1;padding:10px;border:0;border-radius:8px;background:#0a66c2;color:#fff;font-weight:600;cursor:pointer">Generate</button>
          <button data-njs="regen" title="Start a fresh letter" style="display:none;padding:10px 12px;border:1px solid #ddd;border-radius:8px;background:#f5f5f5;color:#333;font-weight:600;cursor:pointer">&#8635;</button>
        </div>
        <div data-njs="hint" style="font-size:12px;color:#666"></div>
        <div data-njs="status" style="font-size:13px;color:#b91c1c;white-space:pre-wrap"></div>
        <div style="position:relative;flex:1;display:flex;flex-direction:column">
          <label style="font-weight:600;display:block;margin-bottom:6px">Cover letter</label>
          <button data-njs="copy" title="Copy to clipboard" style="position:absolute;top:26px;right:8px;border:0;background:#f0f0f0;border-radius:6px;padding:4px 8px;cursor:pointer;font-size:12px;z-index:1">Copy</button>
          <textarea data-njs="output" placeholder="Your generated cover letter will appear here." style="width:100%;flex:1;min-height:220px;box-sizing:border-box;padding:12px;border:1px solid #ddd;border-radius:8px;font:inherit;resize:none"></textarea>
        </div>
      </div>
      <div style="padding:14px 18px;border-top:1px solid #eee;display:flex;justify-content:flex-end">
        <button data-njs="pdf" style="padding:10px 16px;border:0;border-radius:8px;background:#057642;color:#fff;font-weight:600;cursor:pointer">Save as PDF</button>
      </div>`;
    document.body.appendChild(panel);
    const q = (n) => panel.querySelector(`[data-njs="${n}"]`);
    q("close").addEventListener("click", closePanel);
    // Generate (first time) or Update (refine) depending on session state.
    q("generate").addEventListener("click", () =>
      runGeneration({ refine: coverLetters.has(currentJobId()) })
    );
    q("regen").addEventListener("click", onRegenerate);
    q("copy").addEventListener("click", () => onCopy(q("copy"), q("output")));
    q("pdf").addEventListener("click", () => onSavePdf(q("output")));
    requestAnimationFrame(() => (panel.style.transform = "translateX(0)"));
    return panel;
  }

  async function runGeneration({ refine }) {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    const genBtn = panel.querySelector('[data-njs="generate"]');
    const regenBtn = panel.querySelector('[data-njs="regen"]');
    const output = panel.querySelector('[data-njs="output"]');
    const prefsEl = panel.querySelector('[data-njs="prefs"]');
    const instruction = prefsEl.value.trim();

    const adapter = activeAdapter();
    const job = adapter ? await adapter.scrape() : null;
    if (!job) {
      panelStatus("Couldn't read this job — open it fully and retry.", true);
      return;
    }
    panelJob = job;
    const jobId = currentJobId();
    const existing = coverLetters.get(jobId);

    let payload;
    if (refine && existing && existing.messages) {
      if (!instruction) {
        panelStatus("Type an instruction above (e.g. “make it shorter”) to update.", true);
        return;
      }
      payload = {
        type: "GENERATE_COVER_LETTER",
        messages: existing.messages,
        instruction,
      };
    } else {
      payload = { type: "GENERATE_COVER_LETTER", job, preferences: instruction };
    }

    genBtn.disabled = true;
    regenBtn.disabled = true;
    genBtn.textContent = refine ? "Updating…" : "Generating…";
    panelStatus("", false);
    try {
      const res = await chrome.runtime.sendMessage(payload);
      if (res && res.ok) {
        coverLetters.set(jobId, {
          letter: res.text,
          messages: res.messages,
          title: job.job_title,
          company: job.company_name,
        });
        output.value = res.text;
        prefsEl.value = ""; // clear so the box is ready for the next refinement
      } else {
        panelStatus((res && res.error) || "Generation failed.", true);
      }
    } catch (e) {
      panelStatus(
        /context invalidated/i.test(e.message || "")
          ? "Reload this tab (the extension was updated)."
          : e.message || String(e),
        true
      );
    } finally {
      genBtn.disabled = false;
      regenBtn.disabled = false;
      updatePanelMode(panel); // resets button label to Generate/Update
    }
  }

  // Start a fresh letter for this job (discard the conversation).
  async function onRegenerate() {
    const panel = document.getElementById(PANEL_ID);
    coverLetters.delete(currentJobId());
    if (panel) panel.querySelector('[data-njs="output"]').value = "";
    await runGeneration({ refine: false });
  }

  function onCopy(btn, output) {
    navigator.clipboard
      .writeText(output.value || "")
      .then(() => {
        const t = btn.textContent;
        btn.textContent = "Copied!";
        setTimeout(() => (btn.textContent = t), 1500);
      })
      .catch(() => panelStatus("Copy failed.", true));
  }

  async function onSavePdf(output) {
    const text = (output.value || "").trim();
    if (!text) {
      panelStatus("Generate a letter first.", true);
      return;
    }
    try {
      // Lazily load jsPDF into this tab the first time it's needed.
      if (!(window.jspdf && window.jspdf.jsPDF)) {
        const r = await chrome.runtime.sendMessage({ type: "INJECT_JSPDF" });
        if (!r || !r.ok) throw new Error((r && r.error) || "Could not load PDF library.");
      }
      const jsPDF = window.jspdf && window.jspdf.jsPDF;
      if (!jsPDF) throw new Error("PDF library unavailable.");

      const doc = new jsPDF({ unit: "pt", format: "a4" });
      doc.setFont("times", "normal").setFontSize(12);
      const margin = 56;
      const maxW = doc.internal.pageSize.getWidth() - margin * 2;
      const pageH = doc.internal.pageSize.getHeight() - margin;
      const lineH = 16;
      let y = margin;
      text.split(/\n/).forEach((para) => {
        const wrapped = para.length ? doc.splitTextToSize(para, maxW) : [""];
        wrapped.forEach((ln) => {
          if (y > pageH) {
            doc.addPage();
            y = margin;
          }
          doc.text(ln, margin, y);
          y += lineH;
        });
      });
      // Name it "<Company> Cover Letter.pdf" (fall back to the job title).
      const who =
        (panelJob && (panelJob.company_name || panelJob.job_title)) || "";
      const base =
        `${who ? who + " " : ""}Cover Letter`
          .replace(/[\\/:*?"<>|]+/g, "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 100) || "Cover Letter";
      doc.save(`${base}.pdf`);
      panelStatus("Saved PDF ✓", false);
    } catch (e) {
      panelStatus(e.message || String(e), true);
    }
  }

  // =========================================================================
  // Injection + SPA handling
  // =========================================================================
  function ensureButton() {
    const adapter = activeAdapter();
    if (!adapter) return;
    if (adapter.pathAllowed && !adapter.pathAllowed()) return;

    const anchors = adapter.findAnchors();
    const keep = new Set();
    anchors.forEach((rawAnchor) => {
      // Resolve to the real <button> so we insert a sibling next to it, not a
      // child inside it (some sites put the aria/data hook on an inner span).
      const anchor = rawAnchor.closest("button") || rawAnchor;
      const parent = anchor.parentElement;
      if (!parent) return;

      // Some layouts (e.g. LinkedIn standalone) lay actions out in a CSS grid
      // with fixed cells; adding a child overlaps. Insert after the grid then.
      const inGrid = getComputedStyle(parent).display === "grid";
      const host = inGrid ? parent.parentElement : parent;
      if (!host) return;

      let btn = host.querySelector(`:scope > .${BTN_CLASS}`);
      if (!btn) {
        btn = createButton();
        if (inGrid) {
          parent.insertAdjacentElement("afterend", btn);
          btn.style.alignSelf = "center";
        } else {
          anchor.insertAdjacentElement("afterend", btn);
        }
        if (savedJobs.has(currentJobId())) setState(btn, "success");
      }
      keep.add(btn);

      // Cover-letter pen, just left of the Save-to-Notion button. Only when an
      // AI key is configured.
      if (coverEnabled) {
        let pen = host.querySelector(`:scope > .${PEN_CLASS}`);
        if (!pen) {
          pen = createPenButton();
          if (inGrid) pen.style.alignSelf = "center";
          btn.insertAdjacentElement("beforebegin", pen);
        }
        keep.add(pen);
      }
    });

    // Drop stray *idle* buttons no longer tied to a current anchor (so an
    // in-progress / saved button is never yanked mid-action).
    document.querySelectorAll(`.${BTN_CLASS}`).forEach((b) => {
      if (!keep.has(b) && b.dataset.state === "idle") b.remove();
    });
    // Drop stray/disabled pens.
    document.querySelectorAll(`.${PEN_CLASS}`).forEach((p) => {
      if (!keep.has(p)) p.remove();
    });
  }

  function currentJobId() {
    const a = activeAdapter();
    return a ? a.jobId() : location.pathname;
  }

  let lastJobId = currentJobId();
  const savedJobs = new Set(); // job ids saved during this session

  function tick() {
    const id = currentJobId();
    if (id !== lastJobId) {
      // Switched jobs: drop stale buttons so fresh idle ones get added, and
      // refresh the cover-letter panel to this job's letter (if open).
      lastJobId = id;
      document.querySelectorAll(`.${BTN_CLASS}`).forEach((b) => b.remove());
      if (document.getElementById(PANEL_ID)) populatePanel();
    }
    ensureButton();
  }

  let scheduled = false;
  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      tick();
    }, 400);
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // Show the pen only when an AI key is configured; react to settings changes.
  chrome.storage.local.get(["aiApiKey"], (s) => {
    coverEnabled = !!(s && s.aiApiKey);
    tick();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.aiApiKey) return;
    coverEnabled = !!changes.aiApiKey.newValue;
    if (!coverEnabled) {
      document.querySelectorAll(`.${PEN_CLASS}`).forEach((p) => p.remove());
      closePanel();
    }
    tick();
  });

  tick();
})();
