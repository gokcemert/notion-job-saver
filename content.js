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
    });

    // Drop stray *idle* buttons no longer tied to a current anchor (so an
    // in-progress / saved button is never yanked mid-action).
    document.querySelectorAll(`.${BTN_CLASS}`).forEach((b) => {
      if (!keep.has(b) && b.dataset.state === "idle") b.remove();
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
      // Switched jobs: drop stale buttons so fresh idle ones get added.
      lastJobId = id;
      document.querySelectorAll(`.${BTN_CLASS}`).forEach((b) => b.remove());
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
  tick();
})();
