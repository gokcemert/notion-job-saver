# Job Saver → Notion

A lightweight Chrome (Manifest V3) extension that adds a **“Save to Notion”**
button to job posts. One click saves the job — title, company, URL, detected
language, and the full description — straight into your Notion jobs database.

**Supported sites:** LinkedIn, StepStone. New sites plug in as small
[adapters](#supported-sites--adding-a-new-one) — no core changes needed.

<!-- Add a screenshot here once you have one:
![Save to Notion button on a LinkedIn job](docs/screenshot.png)
-->

---

## Features

- **One-click save** from a button injected right next to the site’s *Save* button.
- **Multi-platform** via a tiny adapter per site (LinkedIn + StepStone today).
- Works on **both** LinkedIn job layouts:
  - the split-view (`/jobs/collections/`, `/jobs/search/`), and
  - the standalone job page (`/jobs/view/<id>`).
- The **Platform** column is set from the source site automatically
  (`Linkedin`, `Stepstone`, …).
- **Full description** captured into the Notion page body (auto-expands
  “…see more”, and split into Notion-safe blocks).
- **Language auto-detection** (English / German / …) via Chrome’s built-in
  detector — no API key, no external calls.
- **Sensible defaults** on every new entry: `Status = Applied`,
  `Platform = Linkedin`, `Type = Full Time`, `Application Date = today`.
- **Schema-aware**: reads your database’s columns and adapts to whether a
  column is a *Select* or *Status* type, matching existing options.
- Per-session **duplicate guard** in the UI (all buttons for a saved job turn
  green so you don’t save the same job twice).

---

## How it works

A content script waits (via `MutationObserver`) for LinkedIn to finish
rendering, then injects the button. On click it scrapes the job **in-page**
(the only reliable moment, since LinkedIn loads content dynamically and is
aggressive about anti-scraping) and sends the data to the background service
worker, which calls the Notion API. Your Notion token never touches the page,
and there are no network calls from the job-site tab.

---

## Supported sites & adding a new one

Each site is a small **adapter** object in [`content.js`](content.js); the
button injection, saving, language detection and Notion write are all shared.
An adapter looks like this:

```js
const StepStoneAdapter = {
  name: "Stepstone",                          // → the Notion "Platform" value
  hostMatch: /(^|\.)stepstone\.[a-z.]+$/i,    // which hostnames it handles
  findAnchors: () =>                          // element(s) to place the button by
    document.querySelectorAll('[data-at="header-save-button"]'),
  jobId: () => location.pathname,             // stable id for dedup / reset
  scrape() {                                  // return the job, or null
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
```

**To add a site (e.g. Indeed):**

1. Add an adapter object to the `ADAPTERS` array in [`content.js`](content.js).
2. Add its host to `content_scripts[].matches` in [`manifest.json`](manifest.json).
3. Add a matching option to your Notion **Platform** select (or let it be
   auto-created on first save).

`scrape()` may be `async` if the page needs expanding/awaiting (see the
LinkedIn standalone adapter, which clicks “…see more” first).

---

## Notion database setup

You need two things: an **integration token** and your **database ID**.

### 1. Create your jobs database (if you don’t have one)

Create a Notion database (full-page) with these columns. The extension is
tolerant — extra columns are fine, and column *types* are auto-detected — but it
looks for these names by default:

| Column             | Type                         | Filled with                    |
| ------------------ | ---------------------------- | ------------------------------ |
| *(title column)*   | Title                        | Job title (found automatically) |
| `Company`          | Text                         | Company name                   |
| `Application Date` | Date                         | Today’s date                   |
| `Status`           | Select **or** Status         | `Applied` (default)            |
| `Platform`         | Select                       | `Linkedin` (default)           |
| `Post Language`    | Select                       | Auto-detected (e.g. `English`) |
| `URL`              | URL                          | Clean job URL                  |
| `Type`             | Select                       | `Full Time` (default)          |

> The **full job description** goes into the **page body** (with a bookmark to
> the post), not into a column.

If you renamed any of these columns, update the `PROP` map at the top of
[`background.js`](background.js) to match.

### 2. Create the integration token

1. Go to **https://www.notion.so/my-integrations**.
2. Click **New integration** → give it a name (e.g. “Job Saver”) → choose
   **Internal** → select your workspace → **Submit**.
3. On the integration page, copy the **Internal Integration Secret**. It looks
   like `ntn_…` (older ones start with `secret_…`). This is your **token**.

> Keep this token private — anyone with it can access the databases you’ve
> shared with the integration.

### 3. Share your database with the integration

The token alone can’t see anything until you connect it to the database:

1. Open your jobs database in Notion (as a full page).
2. Click the **•••** menu (top-right) → **Connections** →
   **Connect to** → pick your integration.
   (On some Notion versions this is **Add connections**.)

### 4. Get the database ID

1. Open the database as a full page.
2. Copy the URL from the address bar. It looks like:

   ```
   https://www.notion.so/yourworkspace/1a2b3c4d5e6f7890abcdef1234567890?v=...
   ```

3. The **database ID** is the 32-character hex string before the `?`
   (`1a2b3c4d5e6f7890abcdef1234567890` above).

You don’t have to extract it by hand — you can paste the **whole URL** into the
extension’s settings and it pulls out the ID automatically.

---

## Install the extension

This is an unpacked extension (not on the Chrome Web Store):

1. Download / clone this repo:
   ```bash
   git clone https://github.com/gokcemert/linkedin-notion-job-saver.git
   ```
2. Open **`chrome://extensions`** in Chrome.
3. Toggle **Developer mode** (top-right) **on**.
4. Click **Load unpacked** and select the project folder.
5. The **Settings** page opens automatically (or right-click the extension
   icon → **Options**).

### Configure it

1. Paste your **integration token** and your **database URL/ID**.
2. Click **Test connection** — it confirms access and lists your columns so you
   can verify the names match.
3. Click **Save**.

---

## Usage

1. Open any LinkedIn job.
2. Click the **“+ Save to Notion”** button next to LinkedIn’s *Save* button.
3. It shows `Saving… → ✓ Saved to Notion`, and a toast confirms with the job
   title. A red toast shows the reason if anything fails.
4. The new entry appears in your Notion database.

> After you update the extension code and **reload** it at `chrome://extensions`,
> **hard-refresh** any open LinkedIn tabs (Cmd/Ctrl+Shift+R) so the new content
> script is injected.

---

## Configuration reference

Everything lives at the top of [`background.js`](background.js):

```js
// Map a logical field -> the exact Notion column name.
const PROP = {
  company: "Company",
  applicationDate: "Application Date",
  status: "Status",
  platform: "Platform",
  language: "Post Language",
  url: "URL",
  type: "Type",
};

// Values written on every new entry.
const DEFAULTS = {
  status: "Applied",
  platform: "Linkedin",
  type: "Full Time",
};
```

---

## Notes & limitations

- **Status column type:** if `Status` is Notion’s dedicated *Status* type (not a
  plain *Select*), the value `Applied` must already exist as an option — the
  Notion API can’t create *Status* options on the fly. Regular *Select* options
  (like a new language) are created automatically.
- **No cross-session duplicate detection:** the green “already saved” state is
  per browser session. Reloading the extension/tab resets it. (Clicking the same
  job twice in one session is blocked; across sessions it isn’t.)
- **LinkedIn markup can change.** The scraper targets current selectors and
  stable `componentkey` attributes, but a future LinkedIn redesign may require
  selector updates in [`content.js`](content.js).
- Your credentials are stored in `chrome.storage.sync` (your browser profile
  only) and are never sent anywhere except `api.notion.com`.

---

## Project structure

```
manifest.json    MV3 config (content script + background worker)
content.js       Injects the button; scrapes the job in-page on click
background.js    Language detection + all Notion API calls
options.html/js  Settings page (token + database ID, with a connection test)
icons/           Extension icons
```

---

## License

MIT — do what you like.
