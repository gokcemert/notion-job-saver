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
// Messaging: content script asks us to save a job.
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "SAVE_JOB") {
    handleSave(msg.job).then(sendResponse);
    return true; // keep the channel open for the async response
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
});

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
