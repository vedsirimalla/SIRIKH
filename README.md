# Sirikh

A small expense logger for V and K. It runs from the iPhone home screen, writes each expense to the **Sirikh** tab of our Google Sheet, and tracks a monthly budget that joint expenses are deducted from.

The site is live at: https://vedsirimalla.github.io/SIRIKH/

## Features

- **Entry form:** Date (calendar, defaults to today), Type (Joint, Fixed or Personal), Category, Amount, Paid By (V or K), Notes.
  - **Joint and Personal:** Category is a plain typing field (no dropdown).
  - **Fixed:** Category is replaced by buttons for exactly five bills: Rent, Utilities, Electricity, Wi-Fi, Misc.
  - The text under Type explains the selected type.
- **Monthly budget:**
  - **Set monthly budget** starts a new budget, for example $705 on the 1st.
  - **Joint** expenses are deducted the moment they are saved.
  - **Fixed** bills (rent, utilities) and **Personal** expenses are not taken from the budget.
  - The card shows how much is left, a progress bar, budget, spent, and how much you can spend per day for the rest of the month.
  - A negative amount is a refund and is added back.
- **Who owes whom:** the same block as the monthly tabs, for joint expenses since the budget was set:
  - V paid, K paid, Total.
  - V's share and K's share (what each paid minus half the total), and the Equal split.
  - A plain line such as "V owes K $140.50", plus an overall line that includes fixed bills.
- **Fixed bills:** tracked separately from the monthly budget, with V paid, K paid, Total, and who owes whom for fixed bills.
- **Color coding** (in the app and the sheet):

  | Type | Color |
  |---|---|
  | Joint | No color |
  | Personal, V | Light blue |
  | Personal, K | Darker blue |
  | Fixed: Rent | Orange (strongest) |
  | Fixed: Utilities, Electricity, Wi-Fi, Misc | Lighter shades of orange, one per bill |
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
- **Existing tabs:** do not point it at a tab you already use for something else. The script rewrites row 1 as its header, fills the Type and Balance columns, and writes its tables from column J onward.

## Sirikh tab layout

| Date | Category | Amount ($) | Paid By | Notes | Type | Balance ($) | ID (hidden) |
|---|---|---|---|---|---|---|---|
| 2026-10-01 | Balance set | $705.00 | Both | October budget | Set balance | $705.00 | |
| 2026-10-02 | Costco | $45.20 | K | Paneer, grapes | Joint | $659.80 | |
| 2026-10-02 | Haircut | $20.00 | V | | Personal | $659.80 | |
| 2026-10-01 | Rent | $1,800.00 | V | | Fixed | $659.80 | |

- **Type** is one of `Joint`, `Fixed`, `Personal`, `Set balance` (or `Add funds` typed by hand). Blank counts as Joint.
- **Row colors** are set by the script from Type, Paid By and Category, and update after hand edits.
- **Balance ($)** is recalculated top to bottom by the script, including after hand edits to Amount or Type.
- **ID** prevents duplicates and identifies rows to delete. Do not edit it.
- **Set balance** rows start a new budget. Everything below the most recent one belongs to the current month.

### Tables in the sheet (column J onward)

The script rebuilds these on every save, so the sheet always shows the same numbers as the app:

1. **Who owes whom** (current budget, joint expenses):

   | V paid | K paid | Total |
   |---|---|---|
   | 211.43 | 484.41 | 695.84 |
   | **V's share** | **K's share** | **Equal split** |
   | -136.49 | 136.49 | 347.92 |

   Followed by "Settle up: V owes K $136.49" and "Including fixed bills: ...".
2. **Fixed bills:** V paid, K paid, Total, and Settle up for fixed bills.
3. **Monthly budget:** Budget, Spent, Remaining.
4. **Colors:** a legend of the row colors.
5. **History:** one row per budget period, newest first: Since, Budget, Joint spent, V paid, K paid, V's share, K's share, Settle up, Fixed total, Fixed settle, Overall. Past months stay on record here.

Do not type in columns J onward; the script overwrites them.

## Setup

### 1. Backend (once)

Do this on a computer, in your Google Sheet.

**Step 1. Copy the code**
- Go to https://github.com/VedSirimalla/SIRIKH/blob/main/Code.gs.
- Click the **Copy raw file** icon at the top right of the code box.

**Step 2. Open Apps Script from your sheet**
- Open your spreadsheet (the one with "Groceries 2026").
- Click **Extensions > Apps Script**. A new tab opens.

**Step 3. Paste the code**
- In the editor, select everything in `Code.gs` (Ctrl+A) and delete it.
- Paste the code (Ctrl+V).
- Click the **Save** icon (floppy disk) or press Ctrl+S.
- Optional: rename the project at the top left from "Untitled project" to `Sirikh`.

**Step 4. Set your passphrase**
- In the left sidebar, click **Project Settings** (the gear icon).
- Scroll to **Script properties**, click **Add script property**, and enter:
  - Property: `SIRIKH_KEY`
  - Value: any passphrase, for example `costco-2026`. You and K will each type it into the app once.
- Click **Save script properties**.

**Step 5. Deploy**
- At the top right, click **Deploy > New deployment**.
- Click the gear next to "Select type" and choose **Web app**.
- Set:
  - Description: `Sirikh`
  - Execute as: **Me**
  - Who has access: **Anyone**
- Click **Deploy**.

**Step 6. Approve access**
- Click **Authorize access** and choose your Google account.
- If you see "Google hasn't verified this app", click **Advanced**, then **Go to Sirikh (unsafe)**. It's your own script.
- Click **Allow**.

**Step 7. Copy the URL**
- Copy the **Web app URL**. It looks like `https://script.google.com/macros/s/AKfy.../exec`.
- To test it, open the URL in a browser tab. It should say "Sirikh backend is running."

**Step 8. Connect the app**
- On your iPhone, open Sirikh from the home screen and tap the gear icon. (To install it, see section 2.)
- Paste the URL, enter the passphrase, and tap **Save**. You should see "Connected".
- Tap **Set monthly budget** and enter this month's budget. A **Sirikh** tab appears in your sheet.

### 2. Install on each iPhone

Open https://vedsirimalla.github.io/SIRIKH/ in **Safari**, then tap **Share > Add to Home Screen > Add**. Then do Step 8 above inside the home screen app, not in Safari, because the two keep separate storage.

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
