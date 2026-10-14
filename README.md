# Sirikh

A small expense logger for V and K. It runs from the iPhone home screen, writes each expense to the **Sirikh** tab of our Google Sheet, and keeps a main balance that joint expenses are deducted from.

## Features

- **Entry form:** Date (calendar, defaults to today), Category (store name, with suggestions), Amount, Paid By (V or K), Type (Joint or Personal), Notes.
- **Main balance:**
  - **Set balance** sets it to an exact amount and starts a new period, for example at the start of a month.
  - **Add funds** adds to it.
  - **Joint** expenses are deducted; **Personal** expenses are logged only.
  - A negative amount is a refund and is added back.
- **Period summary:** joint spending since the last Set balance, the amount V and K each paid, and who owes whom for an even split.
- **Recent list:** the last 5 entries with the running balance. Tap **x** to delete one.
- **Offline:** entries saved without signal are kept on the phone and synced later. An hourglass marks unsynced entries.
- **Security:** a shared key protects writes. The repo contains no sheet ID, key, or data.

## Files

Keep all files at the top level of the repo.

| File | Purpose |
|---|---|
| `index.html` | App screen |
| `styles.css` | Styling, light and dark mode |
| `app.js` | Form, balance, offline queue, sync |
| `sw.js` | Lets the app open offline |
| `manifest.webmanifest` | Home screen name, colors, icons |
| `icon-180.png`, `icon-192.png`, `icon-512.png` | Icons |
| `Code.gs` | Backend. Paste it into the spreadsheet's Apps Script; it does not run on GitHub |

## How the sheet is chosen

The app never uses the Google Sheets URL. It talks to the **Apps Script web app** you deploy from inside the spreadsheet, and that script writes to whichever spreadsheet you opened it from.

- **Tab:** set by `TAB_NAME` at the top of `Code.gs` (default `Sirikh`). The tab is created if it does not exist.
- **Changing the tab:** edit `TAB_NAME`, then deploy a new version.
- **Existing tabs:** do not point it at a tab you already use for something else. The script rewrites row 1 as its header and fills the Type and Balance columns.

## Sirikh tab layout

| Date | Category | Amount ($) | Paid By | Notes | Type | Balance ($) | ID (hidden) |
|---|---|---|---|---|---|---|---|
| 2026-10-01 | Balance set | $650.00 | Both | October budget | Set balance | $650.00 | |
| 2026-10-02 | Costco | $45.20 | K | Paneer, grapes | Joint | $604.80 | |
| 2026-10-02 | Haircut | $20.00 | V | | Personal | $604.80 | |

- **Type** is one of `Joint`, `Personal`, `Add funds`, `Set balance`. Blank counts as Joint.
- **Balance ($)** is recalculated top to bottom by the script, including after hand edits to Amount or Type.
- **ID** prevents duplicates and identifies rows to delete. Do not edit it.

## Setup

### 1. Backend (once)

1. Open the spreadsheet, then go to **Extensions > Apps Script**.
2. Replace everything in `Code.gs` with this repo's `Code.gs`, then click **Save**.
3. Go to **Project Settings > Script properties > Add script property**. Set Property to `SIRIKH_KEY` and Value to a passphrase of your choice.
4. Go to **Deploy > New deployment**, select type **Web app**, and set:
   - Execute as: **Me**
   - Who has access: **Anyone**
5. Click **Deploy** and approve access. Google will warn that the app is unverified: choose **Advanced > Go to (project name) > Allow**. It is your own script.
6. Copy the **Web app URL**. It starts with `https://script.google.com/macros/s/` and ends with `/exec`. This URL, not the sheet URL, goes into the app.

### 2. Each iPhone

1. Open the site in **Safari**, tap **Share > Add to Home Screen > Add**.
2. Open Sirikh from the home screen, tap the gear icon, and enter the Web app URL and the passphrase. You should see "Connected". Do this in the home screen app, not in Safari, because the two keep separate storage.
3. Tap **Set balance** and enter the starting amount.

## Updating

- **App files:** upload the new versions to GitHub. Phones get them the next time the app opens online.
- **`Code.gs`:** paste the new code, then go to **Deploy > Manage deployments > Edit (pencil) > Version: New version > Deploy**. The URL stays the same. An older Sirikh tab is upgraded in place, and its old rows count as Joint.

## Troubleshooting

| Problem | Fix |
|---|---|
| Site shows 404 | `index.html` must be at the top level and Pages set to main, root. Make any commit to trigger a build. |
| "Wrong key" | The app key must match `SIRIKH_KEY` exactly, including case. |
| "Web app URL did not answer correctly" | Use the `/exec` URL from Apps Script, not the sheet URL or a `/dev` URL. Access must be **Anyone**. |
| "SIRIKH_KEY is not set" | Add the script property (Backend, step 3). |
| `Code.gs` changes have no effect | Deploy a new version of the existing deployment. |
| Balance looks wrong | Check the Type column in the Sirikh tab. Fixing a row recalculates the balance. |
| Old home screen icon | Remove it and add it again from Safari. |
