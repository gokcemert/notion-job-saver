const NOTION_VERSION = "2022-06-28";
const $ = (id) => document.getElementById(id);

// Keep this in sync with DEFAULT_SYSTEM_PROMPT in background.js.
const DEFAULT_SYSTEM_PROMPT =
  "You are an expert career writer. Write a concise, compelling, one-page " +
  "cover letter tailored to the specific job. Use ONLY facts from the " +
  "candidate's background — never invent experience, employers, or metrics. " +
  "Write it ready to send: no placeholders like '[Your Name]' unless the " +
  "background lacks a name.";

// Restore saved values. Notion settings live in sync; cover-letter settings in
// local (the "About you" text can exceed sync's per-item size limit).
chrome.storage.sync.get(["notionToken", "databaseId"], (s) => {
  if (s.notionToken) $("token").value = s.notionToken;
  if (s.databaseId) $("db").value = s.databaseId;
});
chrome.storage.local.get(
  ["aiProvider", "aiApiKey", "aiModel", "aiBackground", "aiSystemPrompt"],
  (s) => {
    if (s.aiProvider) $("aiProvider").value = s.aiProvider;
    if (s.aiApiKey) $("aiApiKey").value = s.aiApiKey;
    if (s.aiModel) $("aiModel").value = s.aiModel;
    if (s.aiBackground) $("aiBackground").value = s.aiBackground;
    // Prefill with the default so it's visible and editable.
    $("aiSystemPrompt").value = s.aiSystemPrompt || DEFAULT_SYSTEM_PROMPT;
  }
);

$("resetPrompt").addEventListener("click", (e) => {
  e.preventDefault();
  $("aiSystemPrompt").value = DEFAULT_SYSTEM_PROMPT;
});

function readCover() {
  return {
    aiProvider: $("aiProvider").value,
    aiApiKey: $("aiApiKey").value.trim(),
    aiModel: $("aiModel").value.trim(),
    aiBackground: $("aiBackground").value,
    aiSystemPrompt: $("aiSystemPrompt").value.trim() || DEFAULT_SYSTEM_PROMPT,
  };
}

// Extract a 32-char hex database ID from a pasted URL or raw ID.
function extractDatabaseId(input) {
  const matches = (input || "").replace(/-/g, "").match(/[0-9a-fA-F]{32}/g);
  return matches ? matches[0] : (input || "").trim();
}

function setStatus(msg, cls) {
  const el = $("status");
  el.textContent = msg;
  el.className = cls || "";
}

function readForm() {
  const token = $("token").value.trim();
  const databaseId = extractDatabaseId($("db").value);
  return { token, databaseId };
}

$("save").addEventListener("click", () => {
  const { token, databaseId } = readForm();

  // Cover-letter settings are always saved (all fields optional).
  chrome.storage.local.set(readCover());

  // Notion needs both fields together, but is optional overall.
  if (token && databaseId) {
    chrome.storage.sync.set({ notionToken: token, databaseId });
    $("db").value = databaseId;
  } else if (token || databaseId) {
    setStatus(
      "Saved cover-letter settings. Notion needs BOTH a token and a database ID.",
      "err"
    );
    return;
  }
  setStatus("Saved. ✓", "ok");
});

$("test").addEventListener("click", async () => {
  const { token, databaseId } = readForm();
  if (!token || !databaseId) {
    setStatus("Enter a token and database ID first.", "err");
    return;
  }
  setStatus("Testing…");
  try {
    const res = await fetch(`https://api.notion.com/v1/databases/${databaseId}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_VERSION,
      },
    });
    const data = await res.json();
    if (!res.ok) {
      setStatus(`Failed (${res.status}): ${data.message || "check token & sharing"}`, "err");
      return;
    }
    const title = (data.title || []).map((t) => t.plain_text).join("") || "(untitled)";
    const cols = Object.entries(data.properties)
      .map(([name, p]) => `  • ${name} (${p.type})`)
      .join("\n");
    setStatus(`Connected to "${title}".\nColumns found:\n${cols}`, "ok");
    // Persist on a successful test too, for convenience.
    chrome.storage.sync.set({ notionToken: token, databaseId });
  } catch (e) {
    setStatus(`Error: ${e.message || e}`, "err");
  }
});
