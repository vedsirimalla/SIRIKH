# Sirikh

A small expense logger for V and K. It runs from the iPhone home screen, writes each expense to the **Sirikh** tab of our Google Sheet, and tracks a monthly budget that joint expenses are deducted from.

The site is live at: https://vedsirimalla.github.io/SIRIKH/

## Features

- **Entry form:** Date (calendar, defaults to today), Type (Joint, Fixed, Personal or Sonata), Category, Amount, Expense for, Card used, Notes.
  - **Card used:** whose card paid (V's card or K's card).
  - **Expense for:** whose expense it is. Personal: V or K. Sonata: V or K (whose turn) or Joint. Joint and Fixed are always shared.
  - **Owed in full:** a one-person expense on the other person's card is owed back in full. Example: K orders ramen for herself and it goes on V's card, so K owes V the whole amount. The app shows this before you save.
  - **Joint and Personal:** Category is a plain typing field (no dropdown).
  - **Fixed:** Category is replaced by buttons for exactly five bills: Rent, Utilities, Electricity, Wi-Fi, Misc.
  - The text under Type explains the selected type.
- **Budgets by type:** the budget card follows the selected Type.
  - **Joint:** the joint monthly budget (below).
  - **Personal:** a personal budget for V and one for K, for a calendar month. **Set personal budget** sets either or both for the month of its start date. Every Personal expense for that person dated in that month comes out of it, whoever's card paid and even if it was logged before the budget was set (K's ramen on V's card reduces K's budget, and K still owes V).
  - **Fixed and Sonata:** no budget. Fixed bills get paid regardless; Sonata shows car stats instead.
- **Joint monthly budget:**
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
- **Sonata (car):** the fourth Type option. Car costs and fuel go to their own **Sonata** tab. V and K take turns paying (V three tanks, K the fourth), so own turns owe nothing; Joint costs split 50/50. See "Sonata tab" below.
- **Color coding** (in the app and the sheet):

  | Type | Color |
  |---|---|
  | Joint | No color |
  | Personal, V | Light blue |
  | Personal, K | Darker blue |
  | Fixed, V | Light orange |
  | Fixed, K | Darker orange |
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

| Date | Category | Amount ($) | Card Used | Notes | Type | Balance ($) | ID (hidden) | Expense For |
|---|---|---|---|---|---|---|---|---|
| 2026-10-01 | Balance set | $705.00 | Both | October budget | Set balance | $705.00 | | |
| 2026-10-02 | Costco | $45.20 | K | Paneer, grapes | Joint | $659.80 | |
| 2026-10-02 | Haircut | $20.00 | V | | Personal | $659.80 | |
| 2026-10-01 | Rent | $1,800.00 | V | | Fixed | $659.80 | |

- **Type** is one of `Joint`, `Fixed`, `Personal`, `Set balance`, `Personal budget` (or `Add funds` typed by hand). Blank counts as Joint.
- **Personal budget** rows set the personal budget for the person in Expense For, for the month of the row's date (the latest one in a month wins).
- **Expense For** is filled for Personal rows (V or K). Personal rows saved before this column existed count as the card owner's.
- **Row colors** are set by the script from Type, Expense For and Card Used, and update after hand edits.
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

   Followed by "Settle up (joint)", "Personal on other's card" (owed in full), and "Overall (joint + fixed + personal)".
2. **Fixed bills:** V paid, K paid, Total, and Settle up for fixed bills.
3. **Personal expenses:** a grid of each person's Personal spending on their own card (nothing owed) and on the other's card (owed in full), then Settle up and Overall (joint + fixed + personal). The app shows the same grid when Personal is selected.
4. **Monthly budgets:** Budget, Spent, Remaining for Joint, V personal and K personal.
5. **Colors:** a legend of the row colors.
6. **History:** one row per budget period, newest first: Since, Budget, Joint spent, V paid, K paid, V's share, K's share, Settle up, Fixed total, Fixed settle, Personal settle, Overall, V personal spent, K personal spent. Past months stay on record here.

Do not type in columns J onward; the script overwrites them.

## Sonata tab

Pick **Sonata** under Type. The form switches to car fields and the dashboard shows car stats, charts, and what V and K have each paid. Nothing here touches the monthly budget or the Sirikh tab.

- **Categories (buttons):** Fuel, Servicing, Repairs, Mods, Insurance, Registration/Tax, Tolls/Parking, Car wash, Misc.
- **Fuel entry:** gas station, odometer, range left, gallons, price per gallon, **Fill** (Full or Partial) and **"I missed logging a fill-up before this one"**. Amount fills in from gallons x price. A live preview shows miles, MPG and cost per mile before you save.
  - **Full** = you filled until the pump clicked (the default). **Partial** = you stopped early.
  - Checks: gallons above the 13.2 gal tank are rejected; an odometer lower than the last fill-up is rejected; a "Full" fill that leaves the tank well short of 13.2 gal gets a "looks partial" warning.
- **Other categories:** vendor or description and amount.

Columns: Date | Category | Station / Vendor | Amount ($) | Card Used | Odometer | Miles Driven | Range Left | Effective Range | Gallons | Price/Gal | MPG | Cost/Mile | Notes | ID (hidden) | Expense For | Fill | Missed Before

Fuel math (Fuel rows in odometer order). It stays correct whatever mix of full and partial fills you log:

| Number | Formula |
|---|---|
| Miles Driven | this odometer minus the previous fill-up's odometer |
| Gallons | as entered, or Amount / Price per gallon when left blank |
| MPG | full-to-full: miles from one Full fill to the next / **all** gallons added in between (partials included). The tank is full at both ends, so those gallons are exactly what the miles burned. Shown on the Full fill that closes the stretch; Partial rows have none |
| Cost/Mile | stretch amount / stretch miles (same row) |
| Effective Range | Miles Driven + Range Left, only when the previous fill was Full |
| Overall MPG (headline) | all stretch miles / all stretch gallons |
| Rolling MPG | miles over the last 5 fills / gallons of those fills (any fills) |
| Average price per gallon | fuel spend / gallons (every fill) |

- **Missed fill-ups:** a stretch with a missed fill-up gets no MPG and tracking restarts there. Mark it with the switch, or type Yes in **Missed Before**; a fill covering more than 1.6x a typical tank is also caught automatically.
- **Unknown gallons:** a stretch with a fill that has neither gallons nor price is skipped.
- **Fixing history:** type **Partial** in the **Fill** column of any row (for example Oct 5) and everything recalculates.

Columns T onward (rebuilt on every save):

1. **Spent so far:** V paid, K paid, Total spent (all car costs, by whose card paid), then "Owed from joint or other-card costs":
   - Own turn (Expense For matches the card, or blank): nothing owed.
   - Joint (for example a trip fill-up): split 50/50, the other person owes half to the card owner.
   - A turn paid on the other person's card: owed in full.
   Fuel stats also show fill-ups by turn (V, K, Joint).
2. **Fuel stats:** overall and rolling MPG, best and worst MPG, average price per gallon, fuel and total cost per mile, average miles per full tank, average effective range, fill-ups / partial / missed, gallons, fuel spend, miles tracked, last odometer, fill-ups by turn.
3. **Spend by category** and total car spend.
4. **Monthly table and fuel log** (from row 40), which feed five charts: MPG per full tank, rolling MPG, price per gallon (every fill), fuel cost per mile, and car spend per month.

The first time the app loads with an empty Sonata tab (yours, or one it creates), the 15 fill-ups from the closed HyundaiSonata2026 tab are copied in once. HyundaiSonata2026 is only read, never edited. All new car entries go to the Sonata tab.

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
| Fixed, Personal or Sonata entries stay on the phone with an hourglass, or Fixed shows as Joint in the sheet | The sheet's Apps Script is an older version. Paste the latest `Code.gs`, then Deploy > Manage deployments > pencil > Version: New version > Deploy. Opening the `/exec` link should say "Version 16" or higher. If you made a New deployment instead, paste its new `/exec` URL into the app's settings. |
| "SIRIKH_KEY is not set" | Add the script property (Backend, step 3). |
| `Code.gs` changes have no effect | Deploy a new version of the existing deployment. |
| Balance looks wrong | Check the Type column in the Sirikh tab. Fixing a row recalculates the balance. |
| Old home screen icon | Remove it and add it again from Safari. |
