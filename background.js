// Notion Job Saver — background service worker (MV3).
// Receives scraped job data from the content script and writes it to Notion.

const NOTION_VERSION = "2022-06-28";

// Map a logical field -> the EXACT property (column) name in your Notion DB.
// If you rename a column in Notion, update it here. The title column is found
// automatically by type, so it isn't listed.
const PROP = {
  company: "Company",
  applicationDate: "Application Date",
  status: "Status",
  platform: "Platform",
  language: "Post Language",
  url: "URL",
  type: "Type",
};

// Values written automatically on every new entry.
const DEFAULTS = {
  status: "Applied",
  platform: "Linkedin",
  type: "Full Time",
};

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === "SAVE_JOB") {
    handleSave(msg.job).then(sendResponse);
    return true; // keep the channel open for the async response
  }
  if (msg.type === "GENERATE_COVER_LETTER") {
    handleGenerateCoverLetter(msg).then(sendResponse);
    return true;
  }
  if (msg.type === "INJECT_JSPDF") {
    injectJsPdf(sender.tab && sender.tab.id).then(sendResponse);
    return true;
  }
  if (msg.type === "DOWNLOAD_PDF") {
    handleDownloadPdf(msg).then(sendResponse);
    return true;
  }
  if (msg.type === "ANSWER_QUESTION") {
    handleAnswerQuestion(msg).then(sendResponse);
    return true;
  }
});

async function handleSave(job) {
  try {
    const { notionToken, databaseId } = await chrome.storage.sync.get([
      "notionToken",
      "databaseId",
    ]);
    if (!notionToken || !databaseId) {
      chrome.runtime.openOptionsPage();
      return { ok: false, error: "Add your Notion token & database ID in settings." };
    }
    if (!job || !job.job_title) {
      return { ok: false, error: "Could not read the job details." };
    }

    const language = await detectLanguageName(job.job_details || job.job_title);
    const schema = await fetchSchema(notionToken, databaseId);
    const { properties, children } = buildPayload(schema, job, language);
    await createPage(notionToken, databaseId, properties, children);
    addRecentJob(job); // remember it for the "Answer with AI" job-context dropdown
    return { ok: true };
  } catch (err) {
    console.error("[Notion Job Saver]", err);
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

// Toolbar icon opens settings (saving happens from the in-page button).
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") chrome.runtime.openOptionsPage();
  refreshContextMenu();
});
chrome.runtime.onStartup.addListener(refreshContextMenu);
refreshContextMenu();

// Show the "Answer with AI" context menu only when an AI key is configured.
async function refreshContextMenu() {
  try {
    const { aiApiKey, answerMenuEnabled } = await chrome.storage.local.get([
      "aiApiKey",
      "answerMenuEnabled",
    ]);
    await chrome.contextMenus.removeAll();
    if (aiApiKey && answerMenuEnabled !== false) {
      chrome.contextMenus.create({
        id: "answer-with-ai",
        title: "Answer with AI",
        contexts: ["selection"],
      });
    }
  } catch (err) {
    console.error("[Notion Job Saver] context menu:", err);
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.aiApiKey || changes.answerMenuEnabled)) {
    refreshContextMenu();
  }
});

// Right-click a selected question -> inject the answer panel (activeTab granted
// by the menu click, so no host permissions needed) and open it.
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "answer-with-ai" || !tab || !tab.id) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["answer.js"],
    });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (q) => window.__njsAnswerOpen && window.__njsAnswerOpen(q),
      args: [info.selectionText || ""],
    });
  } catch (err) {
    console.error("[Notion Job Saver] answer inject:", err);
  }
});

// Keep the last few saved jobs for the answer feature's job-context dropdown.
async function addRecentJob(job) {
  try {
    if (!job || !job.job_title) return;
    const { recentJobs = [] } = await chrome.storage.local.get(["recentJobs"]);
    const entry = {
      title: job.job_title,
      company: job.company_name || "",
      details: (job.job_details || "").slice(0, 6000),
      url: job.job_url || "",
      platform: job.platform || "",
      ts: Date.now(),
    };
    const next = [entry, ...recentJobs.filter((j) => j.url !== entry.url)].slice(0, 8);
    await chrome.storage.local.set({ recentJobs: next });
  } catch (err) {
    console.error("[Notion Job Saver] recentJobs:", err);
  }
}

// ---------------------------------------------------------------------------
// Cover letter — pluggable AI providers
//
// To add a provider (e.g. Anthropic): add an entry here, add its host to
// manifest host_permissions, and add it to the settings dropdown.
// ---------------------------------------------------------------------------
// Default cover-letter instructions. Editable in settings (aiSystemPrompt).
// Keep in sync with the default shown in options.js.
const DEFAULT_SYSTEM_PROMPT =
  "You are an expert career writer. Write a concise, compelling, one-page " +
  "cover letter tailored to the specific job. Use ONLY facts from the " +
  "candidate's background — never invent experience, employers, or metrics. " +
  "Write it ready to send: no placeholders like '[Your Name]' unless the " +
  "background lacks a name.";

const AI_PROVIDERS = {
  openai: {
    label: "OpenAI",
    endpoint: "https://api.openai.com/v1/chat/completions",
    defaultModel: "gpt-4o-mini",
    headers: (key) => ({
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    }),
    body: (model, messages) => ({ model, messages, temperature: 0.7 }),
    parse: (json) => json.choices?.[0]?.message?.content?.trim() || "",
    errorMessage: (json) => json.error?.message,
  },
};

async function handleGenerateCoverLetter(msg) {
  try {
    const cfg = await chrome.storage.local.get([
      "aiProvider",
      "aiApiKey",
      "aiModel",
      "aiBackground",
      "aiSystemPrompt",
    ]);
    const provider = AI_PROVIDERS[cfg.aiProvider || "openai"];
    if (!provider) return { ok: false, error: "Unknown AI provider." };
    if (!cfg.aiApiKey) {
      return { ok: false, error: "Add your API key in the extension settings." };
    }
    const model = ((msg.model || cfg.aiModel || provider.defaultModel) || "").trim();

    // Two modes:
    //  - refine:  msg.messages (prior conversation) + msg.instruction
    //  - initial: msg.job + msg.preferences
    let messages;
    if (Array.isArray(msg.messages) && msg.messages.length) {
      const instruction = (msg.instruction || "").trim() || "Please improve the letter.";
      messages = [
        ...msg.messages,
        {
          role: "user",
          content:
            `Revise the cover letter based on this instruction:\n${instruction}\n\n` +
            "Return the complete updated letter only.",
        },
      ];
    } else {
      const job = msg.job || {};
      if (!job.job_title) return { ok: false, error: "Could not read the job details." };
      const language =
        msg.language || (await detectLanguageName(job.job_details || job.job_title));
      const { system, user } = buildCoverLetterPrompt(
        cfg.aiSystemPrompt,
        cfg.aiBackground || "",
        job,
        msg.preferences || "",
        language
      );
      messages = [
        { role: "system", content: system },
        { role: "user", content: user },
      ];
    }

    const res = await fetch(provider.endpoint, {
      method: "POST",
      headers: provider.headers(cfg.aiApiKey),
      body: JSON.stringify(provider.body(model, messages)),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        ok: false,
        error: `Generation failed (${res.status}): ${
          provider.errorMessage(json) || "check your API key and model"
        }`,
      };
    }
    const text = provider.parse(json);
    if (!text) return { ok: false, error: "The model returned an empty response." };
    // Return the full conversation so the panel can continue refining.
    return { ok: true, text, messages: [...messages, { role: "assistant", content: text }] };
  } catch (err) {
    console.error("[Notion Job Saver] cover letter:", err);
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

function buildCoverLetterPrompt(systemBase, background, job, preferences, language) {
  const base = (systemBase && systemBase.trim()) || DEFAULT_SYSTEM_PROMPT;
  // The posting's language is always enforced, regardless of the custom prompt.
  const system = base + (language ? `\n\nWrite the letter in ${language}.` : "");

  const user = [
    "=== CANDIDATE BACKGROUND ===",
    background || "(none provided)",
    "",
    "=== JOB ===",
    `Title: ${job.job_title || ""}`,
    `Company: ${job.company_name || ""}`,
    "Description:",
    (job.job_details || "").slice(0, 8000),
    "",
    "=== EMPHASIZE IN THIS LETTER ===",
    preferences || "(no specific instructions)",
  ].join("\n");

  return { system, user };
}

// ---------------------------------------------------------------------------
// Answer application questions (context-menu feature)
// ---------------------------------------------------------------------------
const ANSWER_SYSTEM_PROMPT =
  "You are helping a job candidate answer a question on an application form. " +
  "Write a clear, specific, first-person answer using ONLY facts from the " +
  "candidate's background — never invent experience, employers, or metrics. " +
  "Be concise and ready to paste. Match the language of the question.";

async function handleAnswerQuestion(msg) {
  try {
    let messages;
    if (Array.isArray(msg.messages) && msg.messages.length) {
      const instruction = (msg.instruction || "").trim() || "Please improve the answer.";
      messages = [
        ...msg.messages,
        {
          role: "user",
          content:
            `Revise your previous answer based on this instruction:\n${instruction}\n\n` +
            "Return only the updated answer.",
        },
      ];
    } else {
      const question = (msg.question || "").trim();
      if (!question) return { ok: false, error: "No question text was selected." };
      const { aiBackground } = await chrome.storage.local.get(["aiBackground"]);
      const language = await detectLanguageName(question);
      messages = [
        {
          role: "system",
          content:
            ANSWER_SYSTEM_PROMPT + (language ? `\n\nWrite the answer in ${language}.` : ""),
        },
        {
          role: "user",
          content: buildAnswerUser(aiBackground || "", msg.job, question, msg.preferences || ""),
        },
      ];
    }
    return await chatComplete(messages, msg.model);
  } catch (err) {
    console.error("[Notion Job Saver] answer:", err);
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

function buildAnswerUser(background, job, question, preferences) {
  const parts = ["=== CANDIDATE BACKGROUND ===", background || "(none provided)", ""];
  if (job && (job.title || job.details)) {
    parts.push(
      "=== JOB (for context) ===",
      `Title: ${job.title || ""}`,
      `Company: ${job.company || ""}`,
      "Description:",
      (job.details || "").slice(0, 4000),
      ""
    );
  }
  parts.push("=== APPLICATION QUESTION ===", question, "");
  if (preferences) parts.push("=== EXTRA INSTRUCTIONS ===", preferences);
  return parts.join("\n");
}

// Shared chat call: resolves the provider/key/model, sends the messages, and
// returns the reply plus the full conversation (for refining).
async function chatComplete(messages, modelOverride) {
  const cfg = await chrome.storage.local.get(["aiProvider", "aiApiKey", "aiModel"]);
  const provider = AI_PROVIDERS[cfg.aiProvider || "openai"];
  if (!provider) return { ok: false, error: "Unknown AI provider." };
  if (!cfg.aiApiKey) return { ok: false, error: "Add your API key in the extension settings." };
  const model = ((modelOverride || cfg.aiModel || provider.defaultModel) || "").trim();

  const res = await fetch(provider.endpoint, {
    method: "POST",
    headers: provider.headers(cfg.aiApiKey),
    body: JSON.stringify(provider.body(model, messages)),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    return {
      ok: false,
      error: `Generation failed (${res.status}): ${
        provider.errorMessage(json) || "check your API key and model"
      }`,
    };
  }
  const text = provider.parse(json);
  if (!text) return { ok: false, error: "The model returned an empty response." };
  return { ok: true, text, messages: [...messages, { role: "assistant", content: text }] };
}

// Download a cover-letter PDF (data URL from the content script) into an
// optional subfolder of the user's Downloads folder.
async function handleDownloadPdf(msg) {
  try {
    if (!msg.dataUrl) return { ok: false, error: "No PDF data to download." };
    const { aiPdfFolder } = await chrome.storage.local.get(["aiPdfFolder"]);
    const folder = sanitizeSubfolder(aiPdfFolder);
    const name =
      (msg.filename || "Cover Letter.pdf").replace(/[<>:"|?*\\/]+/g, " ").trim() ||
      "Cover Letter.pdf";
    const filename = folder ? `${folder}/${name}` : name;
    const id = await chrome.downloads.download({
      url: msg.dataUrl,
      filename,
      conflictAction: "uniquify",
      saveAs: false,
    });
    return { ok: true, id };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

// Chrome only allows download paths relative to the Downloads folder: no
// absolute paths, no "..". Keep clean segment names only.
function sanitizeSubfolder(input) {
  return (input || "")
    .replace(/\\/g, "/")
    .split("/")
    .map((seg) => seg.trim().replace(/[<>:"|?*]+/g, "").replace(/^\.+$/, ""))
    .filter(Boolean)
    .join("/");
}

// Lazily inject jsPDF into the tab's isolated world (only when a PDF is first
// requested) so we don't load ~350KB on every job page.
async function injectJsPdf(tabId) {
  if (!tabId) return { ok: false, error: "No tab to inject into." };
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["vendor/jspdf.umd.min.js"],
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// Notion
// ---------------------------------------------------------------------------
function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };
}

async function fetchSchema(token, databaseId) {
  const res = await fetch(`https://api.notion.com/v1/databases/${databaseId}`, {
    headers: authHeaders(token),
  });
  if (!res.ok) {
    throw new Error(`Read DB failed (${res.status}). ${await safeText(res)}`);
  }
  const db = await res.json();
  return db.properties; // { "Name": { id, type, ... }, ... }
}

function buildPayload(schema, job, language) {
  const properties = {};

  const titleName = Object.keys(schema).find((n) => schema[n].type === "title");
  if (titleName) properties[titleName] = { title: richText(job.job_title) };

  setProp(properties, schema, PROP.company, job.company_name);
  setProp(properties, schema, PROP.applicationDate, today());
  setProp(properties, schema, PROP.url, job.job_url);
  setOption(properties, schema, PROP.status, DEFAULTS.status);
  setOption(properties, schema, PROP.platform, job.platform || DEFAULTS.platform);
  setOption(properties, schema, PROP.type, DEFAULTS.type);
  if (language) setOption(properties, schema, PROP.language, language);

  return { properties, children: bodyBlocks(job) };
}

// Generic property setter — formats the value based on the column's real type.
function setProp(properties, schema, name, value) {
  const def = schema[name];
  if (!def || value == null || value === "") return;
  switch (def.type) {
    case "title":
      properties[name] = { title: richText(value) };
      break;
    case "rich_text":
      properties[name] = { rich_text: richText(value) };
      break;
    case "url":
      properties[name] = { url: String(value) };
      break;
    case "email":
      properties[name] = { email: String(value) };
      break;
    case "date":
      properties[name] = { date: { start: String(value) } };
      break;
    case "number":
      properties[name] = { number: Number(value) };
      break;
    case "checkbox":
      properties[name] = { checkbox: Boolean(value) };
      break;
    case "select":
    case "status":
    case "multi_select":
      setOption(properties, schema, name, value);
      break;
    default:
      console.warn(`[Notion Job Saver] Unhandled type "${def.type}" for "${name}"`);
  }
}

// Select / Status / Multi-select setter that reuses an existing option when the
// names match (case-insensitive), so we don't create near-duplicate options.
function setOption(properties, schema, name, value) {
  const def = schema[name];
  if (!def || value == null || value === "") return;
  const type = def.type; // select | status | multi_select
  if (!["select", "status", "multi_select"].includes(type)) {
    return setProp(properties, schema, name, value);
  }
  const options = (def[type] && def[type].options) || [];
  const match = options.find(
    (o) => o.name.toLowerCase() === String(value).toLowerCase()
  );
  const finalName = match ? match.name : String(value);
  properties[name] =
    type === "multi_select"
      ? { multi_select: [{ name: finalName }] }
      : { [type]: { name: finalName } };
}

async function createPage(token, databaseId, properties, children) {
  const res = await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({
      parent: { database_id: databaseId },
      properties,
      children,
    }),
  });
  if (!res.ok) {
    throw new Error(`Create page failed (${res.status}). ${await safeText(res)}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Page body — full job description goes here (not in a property)
// ---------------------------------------------------------------------------
function bodyBlocks(job) {
  const blocks = [];
  if (job.job_url) {
    blocks.push({ object: "block", type: "bookmark", bookmark: { url: job.job_url } });
  }
  blocks.push({
    object: "block",
    type: "heading_2",
    heading_2: { rich_text: richText("Post Description") },
  });
  for (const chunk of chunkText((job.job_details || "").trim(), 1900)) {
    blocks.push({
      object: "block",
      type: "paragraph",
      paragraph: { rich_text: richText(chunk) },
    });
  }
  return blocks.slice(0, 100); // Notion allows 100 child blocks per request
}

// A rich-text value is capped at 2000 chars per item.
function richText(str) {
  return [{ type: "text", text: { content: String(str).slice(0, 2000) } }];
}

// Today's date as YYYY-MM-DD in local time.
function today() {
  const d = new Date();
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

// Split long text into <= max-char chunks, preferring paragraph boundaries.
function chunkText(str, max) {
  if (!str) return [];
  const out = [];
  for (let para of str.split(/\n{2,}/)) {
    para = para.trim();
    if (!para) continue;
    while (para.length > max) {
      out.push(para.slice(0, max));
      para = para.slice(max);
    }
    out.push(para);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Language detection (Chrome built-in) -> human-readable name
// ---------------------------------------------------------------------------
async function detectLanguageName(sampleText) {
  const sample = (sampleText || "").slice(0, 4000);
  if (!sample.trim()) return null;

  const code = await new Promise((resolve) => {
    try {
      chrome.i18n.detectLanguage(sample, (r) => {
        if (chrome.runtime.lastError || !r || !r.languages || !r.languages.length) {
          return resolve(null);
        }
        const top = [...r.languages].sort((a, b) => b.percentage - a.percentage)[0];
        resolve(top && top.language ? top.language : null);
      });
    } catch {
      resolve(null);
    }
  });
  if (!code) return null;

  const base = code.split("-")[0];
  try {
    const name = new Intl.DisplayNames(["en"], { type: "language" }).of(base);
    if (name) return name.charAt(0).toUpperCase() + name.slice(1);
  } catch {
    /* ignore */
  }
  return null;
}

async function safeText(res) {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "";
  }
}
