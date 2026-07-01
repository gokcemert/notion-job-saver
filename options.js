const NOTION_VERSION = "2022-06-28";
const $ = (id) => document.getElementById(id);

// Restore saved values.
chrome.storage.sync.get(["notionToken", "databaseId"], (s) => {
  if (s.notionToken) $("token").value = s.notionToken;
  if (s.databaseId) $("db").value = s.databaseId;
});

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
  if (!token || !databaseId) {
    setStatus("Both fields are required.", "err");
    return;
  }
  chrome.storage.sync.set({ notionToken: token, databaseId }, () => {
    $("db").value = databaseId;
    setStatus("Saved. ✓", "ok");
  });
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
