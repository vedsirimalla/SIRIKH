# Sirikh

A tiny expense logger for V and K. It sits on the iPhone home screen and writes every expense to the **Sirikh** tab of our Google Sheet. It also keeps a **main balance**: joint expenses are deducted from it automatically.

## Features

- **Quick entry:** Date (calendar picker, today by default), Category (type the store; it suggests ones you've used), Amount, Paid By (V / K), Type (Joint / Personal), Notes.
- **Main balance:**
  - **Set balance** starts a new budget (for example $650 at the start of the month).
  - **Add funds** tops it up.
  - Each **Joint** expense is deducted. **Personal** expenses are logged without touching the balance.
  - Negative amounts are refunds and add back to the balance.
- **Period summary:** joint spending since the last "Set balance", how much V and K each paid, and who owes whom for an even split.
- **Recent list:** the last 5 entries with the running balance. Tap **×** to delete one; the balance recalculates.
- **Works offline:** with no signal, entries are kept on the phone and synced automatically later. ⏳ marks entries waiting to sync.
- **Safe:** writes are protected by a shared key. The repo contains no sheet ID, key or data.

## Files

All files sit at the top level of the repo (no folders), so a drag-and-drop upload to GitHub works as-is.

| File | What it is |
|---|---|
| `index.html` | The app screen |
| `styles.css` | Look and feel (light and dark mode) |
| `app.js` | App logic: form, balance, offline queue, sync |
| `sw.js` | Service worker, so the app opens offline |
| `manifest.webmanifest` | Home-screen app name, colors and icons |
| `icon-180.png`, `icon-192.png`, `icon-512.png` | App icons |
| `Code.gs` | Google Apps Script backend. Paste it into the sheet; it does not run on GitHub |
| `README.md` | This file |

## The Sirikh tab

The script creates it automatically:

| Date | Category | Amount ($) | Paid By | Notes | Type | Balance ($) | ID (hidden) |
|---|---|---|---|---|---|---|---|
| 2026-10-01 | Balance set | $650.00 | Both | October budget | Set balance | $650.00 | … |
| 2026-10-02 | Costco | $45.20 | K | Paneer, grapes | Joint | $604.80 | … |
| 2026-10-02 | Haircut | $20.00 | V | | Personal | $604.80 | … |

- **Balance ($)** is recalculated from top to bottom by the script. If you edit an Amount or Type by hand in the sheet, the balances update by themselves.
- **Type** must be one of `Joint`, `Personal`, `Add funds` or `Set balance`. A blank Type counts as Joint.
- The hidden **ID** column lets the app avoid duplicates and delete the right row. Don't edit it.

## Setup

### 1. Backend (Google Apps Script), once
1. Open the spreadsheet → **Extensions → Apps Script**.
2. Delete everything in `Code.gs`, paste in this repo's [`Code.gs`](Code.gs), and click **Save** 💾.
3. **Project Settings** ⚙️ → **Script properties** → **Add script property**:
   - Property: `SIRIKH_KEY`
   - Value: a passphrase of your choice. V and K each type it into the app once.
4. **Deploy → New deployment** → ⚙️ **Select type → Web app**:
   - Execute as: **Me**
   - Who has access: **Anyone**
5. Click **Deploy**. Approve access: choose your account, click **Advanced → Go to … (unsafe) → Allow**. This is your own script.
6. Copy the **Web app URL** (it ends in `/exec`).

**Already deployed the earlier version?** Replace the code (step 2), then go to **Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy**. The URL stays the same, and the existing Sirikh tab is upgraded in place: the Type, Balance and ID columns are added, and old rows count as Joint.

### 2. Website (GitHub Pages), once
1. In the repo: **Add file → Upload files**, drag in all the files, and click **Commit changes**.
2. **Settings → Pages** → Source: **Deploy from a branch**, Branch: **main**, folder **/ (root)**, then **Save**.
   (If Save is grayed out, it is already set up.)
3. Wait 1–2 minutes (watch the **Actions** tab for a green ✓). The app is at `https://<username>.github.io/<repo>/`.

### 3. Each iPhone
1. Open the Pages link in **Safari** → **Share → Add to Home Screen → Add**.
2. Open **Sirikh** from the home screen → ⚙︎ → paste the Web app URL and the key → **Save**. You should see "Connected ✓".
   (The home-screen app has its own storage, separate from Safari, so do this inside the installed app.)
3. Tap **Set balance** and enter the starting amount.

## Updating

- **App files** (`index.html`, `app.js`, …): upload the new versions to GitHub. Phones pick them up the next time the app opens with a connection.
- **`Code.gs`**: paste the new version into Apps Script, then **Manage deployments → Edit → New version**.

## Troubleshooting

| Problem | Fix |
|---|---|
| Site shows 404 | Check that `index.html` is at the top level of the repo and Pages is set to main / root. Make any new commit to start a build, then wait 1–2 min. |
| "Wrong key" | The key in ⚙︎ must match `SIRIKH_KEY` exactly (it's case-sensitive). |
| "The web app URL did not answer correctly" | Use the URL that ends in `/exec` (not `/dev`), and make sure access is set to **Anyone**. |
| "SIRIKH_KEY is not set" | Add the script property (Setup 1, step 3). |
| Changes to `Code.gs` don't apply | Deploy a **New version** of the existing deployment. |
| Balance looks wrong | Check the Type column in the Sirikh tab; it recalculates as soon as you fix a row. |
| Old icon on the home screen | Delete the icon and add it again from Safari. |
