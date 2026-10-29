# Sirikh

A small expense logger for V and K. It runs from the iPhone home screen, writes each expense to the **Sirikh** tab of our Google Sheet, and tracks a monthly budget that joint expenses are deducted from.

The site is live at: https://vedsirimalla.github.io/SIRIKH/

## Features

- **Pages:** the button at the top (next to the gear) opens a menu: **Home**, **Joint**, **Fixed**, **Personal**, **Sonata**, **Funds**. The app remembers the last page.
  - **Home** shows a summary of everything: this month's savings (or the joint budget), then tiles for the joint budget, personal budgets, who owes whom, fixed bills, Sonata, savings this month, savings from earlier months, the goal and loan payments, plus the top 3 next steps and **Where the money goes** (below). Tap a tile to open its page. The form on Home has a small **Add** picker to log any type without leaving Home.
  - Every other page shows its own cards and a form for that type only.
- **Entry form:** Category, Tag, Amount, Refund, Expense for, Card used, Date (calendar, defaults to today), Notes. The type comes from the page.
  - **Card used:** whose card paid (V's card or K's card).
  - **Expense for:** whose expense it is. Personal: V or K. Fixed: Both (shared, split 50/50), V or K (that person's own bill, like each mobile line). Sonata: V or K (whose turn) or Joint. Joint is always shared.
  - **Owed in full:** a one-person expense (Personal or Fixed) on the other person's card is owed back in full. Example: K orders ramen for herself and it goes on V's card, so K owes V the whole amount. The app shows this before you save.
  - **Joint and Personal:** Category is a plain typing field (no dropdown). **Tag** is a dropdown that says where the money went: Groceries, Dining out, Entertainment, Shopping, Household items, Subscriptions, Travel, Fuel, Transport, Health, Personal care, Gifts, Education, Bills, Other. It is picked for you as you type the Category (Costco: Groceries, Netflix: Subscriptions, Verizon bill: Bills); change it if it is wrong, and the app remembers your choice for that Category next time.
  - **Your own tags:** pick **Other** and a box appears to name your own tag (for example Pet care). It is saved with the entry, added to the dropdown on both phones and to the sheet's Tag dropdown, and shows up in the charts like any other tag. Leave the box empty to keep plain Other.
  - **Fixed:** Category is replaced by buttons for six bills: Rent, Utilities, Electricity, Wi-Fi, Mobile bill, Misc. The bill is also its tag. **Expense for** says whose bill it is: Both (rent, utilities: split 50/50) or V or K for one person's own bill (each mobile line). Each bill remembers its last choice; a mobile bill starts as the card owner's.
  - **Sonata and Funds** keep their own options as tags: the car category (Fuel, Servicing, Repairs...) and the Funds kind (Income, 401(K), Investment, Fam, Loan payment, Savings used).
  - The text under Type explains the selected type.
  - **Refund:** tick it for money back (a return, a price adjustment, a bill credit). It is saved as a negative amount, so it undoes the original expense everywhere: the budget goes back up, spending goes down, and what is owed goes down. Works for Joint, Fixed, Personal and Sonata (not fuel fill-ups or Funds). Typing a minus sign works too. Refunds show in green with the word "refund" in Recent and in green in the sheet.
- **Budgets by page:** the budget card follows the page.
  - **Joint:** the joint monthly budget (below).
  - **Personal:** a personal budget for V and one for K, for a calendar month. **Set personal budget** sets either or both for the month of its start date. Every Personal expense for that person dated in that month comes out of it, whoever's card paid and even if it was logged before the budget was set (K's ramen on V's card reduces K's budget, and K still owes V).
  - **Fixed and Sonata:** no budget. Fixed bills get paid regardless; Sonata shows car stats instead.
  - **Funds:** the monthly money picture instead of a budget (see "Funds tab" below).
- **Joint monthly budget:**
  - **Set monthly budget** sets the budget for the current month, for example $705. Expenses already logged that month count right away.
  - **Joint** expenses are deducted the moment they are saved.
  - **Fixed** bills (rent, utilities) and **Personal** expenses are not taken from the budget.
  - The card shows how much is left, a progress bar, budget, spent, and how much you can spend per day for the rest of the month.
  - A refund (negative amount) is added back.
- **Who owes whom:** the same block as the monthly tabs, for joint expenses since the budget was set:
  - V paid, K paid, Total.
  - V's share and K's share (what each paid minus half the total), and the Equal split.
  - A plain line such as "V owes K $140.50", plus an overall line that includes fixed bills.
- **Fixed bills:** tracked separately from the monthly budget, with V paid, K paid, Total; Shared, V's own and K's own; **V's fixed** and **K's fixed** (half the shared bills plus their own bills, so you see what each person spends on fixed); and who owes whom for fixed bills (shared bills half each, an own bill on the other's card in full).
- **Sonata (car):** the fourth Type option. Car costs and fuel go to their own **Sonata** tab. V and K take turns paying (V three tanks, K the fourth), so own turns owe nothing; Joint costs split 50/50. See "Sonata tab" below.
- **Funds:** what comes in and what goes out: income, 401(K), investments, Fam (money sent to the family's investment account), loan payments, savings, a savings goal, a payday plan and an optional email recap (daily, weekly, every 2 weeks or monthly). Kept in its own **Funds** tab, with two generated tabs: **Loans** and **VK**. See "Funds tab" below.
- **Where the money goes (Home):** spending analytics for any period.
  - **Filters:** Year (or All years), Month (or Whole year / All months) and Spending (All, Joint, Fixed, Personal, Personal V, Personal K, Sonata).
  - **Headline:** total spent, compared with the month before and the same month last year (a whole year is compared with the same months of last year, only months logged in both years), spending per day or per month, and income with the share of it spent.
  - **By tag:** every tag ranked, with its amount, share of the total and change against the comparison period.
  - **By type:** a donut of Joint, Fixed, Personal V, Personal K and Sonata, total in the middle.
  - **Month by month:** stacked columns by type for the last 12 months (or the chosen year), the chosen month outlined.
  - **Year over year:** this year and last year side by side, month by month (shown once there is data from last year).
  - **Funds:** income, 401(K), investments, loan payments and savings used in the period, by person.
  - Tap a slice or a column to read its numbers. **Table** shows the same numbers as tables. Spending is Joint, Fixed, Personal and Sonata; refunds lower it; budgets and settlements are not spending. Charts update after each sync.
- **Color coding** (in the app and the sheet):

  | Type | Color |
  |---|---|
  | Joint | No color |
  | Personal, V | Light blue |
  | Personal, K | Darker blue |
  | Fixed, V | Light orange |
  | Fixed, K | Darker orange |
- **Recent list:** each page shows only its own entries: Joint shows Joint rows (plus budgets and settlements), Fixed only Fixed bills, Personal only Personal rows (plus personal budgets and settlements), Sonata only car entries, Funds only Funds entries; Home shows everything. The latest 10 show first; **Show more** loads 25 older ones at a time from the sheet (needs a connection), all the way back, and you can edit or delete any of them. Tap **x** to delete one.
- **Edit:** tap the pencil on an entry in Recent. The form fills with it (a bar on top says what is being edited, with Cancel); change anything, including the date, type, card or amount, and tap **Save changes**. The same row in the sheet is rewritten and every total is recalculated. Moving the date to another month moves the row to that month's tab. Works offline too (the edit syncs later). Settlements and budgets are not edited this way: delete and record them again. Editing the goal opens the goal form.
- **Offline:** entries saved without signal are kept on the phone and synced later. An hourglass marks unsynced entries.
- **Security:** a shared key protects writes. The repo contains no sheet ID, key, or data.

## Settling up (Splitwise, cash)

When you pay each other back, tap **Record settlement** on a Who owes whom card (Joint or Personal) or on the Sonata spending card:

- **Settles:** the month it clears (defaults to the oldest month still owed); Sonata has no month.
- **Who paid / Amount:** filled in from what is still owed; change them for a part payment.
- **Method:** Splitwise, Cash, Zelle, Venmo or Other. **Date paid:** when the money moved.

A settlement is **not an expense**: it never touches budgets, spending or categories.

- **Sheet:** a green **Settlement** row in that month's tab (Card Used = who paid, Expense For = who received; Sonata: Category "Settlement").
- **Status:** each month tab shows **Settled** and **Status** under Who owes whom. Status is amber "Open: K owes V $x" while something is owed and turns green **Cleared** once it is paid back. The overview has the same **Settled** and **Status** columns (Joint left stays last), and the Sonata summary row 4 shows the car's status.
- **App:** each Who owes whom card shows "Still owed: ..." in amber or "Cleared" in green, and lists earlier months that are still open.
- **Pay in parts or in one go:** each payment is its own row. Labels are automatic: "Settlement 1 (partial) via Splitwise", "Settlement 2 (final, cleared) via Cash", or "Settlement (paid in full) via Zelle" for a single payment; deleting a payment renumbers the rest. The form shows what is left after the payment you type.
- **Overpay guard:** a payment above what is owed asks for confirmation, so a typo cannot flip the debt to the other person.

## Funds tab

Open **Funds** from the menu. It tracks what comes in and what goes out, apart from the expense tabs (Sirikh and Sirikh Mon YYYY), and updates the moment anything is saved, including Joint, Fixed, Personal and Sonata expenses.

**Kinds (buttons on the form):**

| Kind | What to log | Person |
|---|---|---|
| Income | Money in hand after 401(K), insurance and taxes: Salary, Tax refund, Bonus, Other | V, K, or Both (half each) |
| 401(K) | What the employer took from that paycheck before pay. Starts at the last amount logged for that person; change it when the contribution changes | V or K |
| Invest | Money you put away from pay: India, USA, Other. **From:** this month's income, or Savings (money kept in earlier months) | V or K |
| Fam | Money sent to the family's investment account. Optional: which Fam account (buttons appear after the first one you name). **From:** this month's income, or Savings. Counted as that person's investment (it lowers savings, it is not spending) but **never toward the V & K goal** | V, K, or Both (half each) |
| Loan | What you sent toward a loan. Pick the loan (buttons appear after the first payment) or name a new one | V, K, or Both (half each) |
| Savings | Spending from savings kept in earlier months, with what it was for | V or K only (savings are individual: V's from V's income, K's from K's) |

Log each paycheck as it arrives (V 3,138.18 and K 2,958.70 at the moment). Salary comes every two weeks; each paycheck counts in the month of its date, so two October paychecks both count in October (three when a month has three paydays). The Date field can be changed to log a paycheck or expense on the day it really happened.

**401(K):** taken by the employer before the paycheck, so it never reaches the bank. It is kept out of income, spending and savings, tracked in its own table (this month, so far, latest per paycheck, month by month) and counted toward the goal. The payday plan fills it in with the last amount, so logging a paycheck also logs its 401(K) in one tap.

**This month (V, K, Total):**

| Line | Formula |
|---|---|
| Income | Income entries dated this month |
| Joint | the month's Joint spending, half each |
| Fixed | half of the shared Fixed bills, plus each person's own bills (mobile line) |
| Personal | each person's own Personal spending (Expense For), whoever's card paid |
| Sonata | joint car costs half each; V's and K's turns to their owner |
| Loan payments | Loan entries this month (Both = half each) |
| **Spent** | Joint/2 + shared Fixed/2 + own Fixed + Personal + Sonata + Loan payments |
| Invested | Invest entries from this month's income (401(K) is separate) |
| Fam | Fam entries from this month's income (not toward the goal) |
| **Savings** | Income - Spent - Invested - Fam: money kept but not decided on yet |
| Kept | (Invested + Fam + Savings) / Income, the savings rate |

Settlements are ignored: they move money between V and K, not out of the household. Splitting shared costs half each also means whose card paid does not matter here.

**Where this month's savings come from** (shown when a budget is set): unspent joint budget (half each), unspent personal budget, and the rest of income that was never budgeted. These already sit inside Savings; the table only explains them and never adds them again.

Example (October): income 6,096.88; spent 650 (joint 100, personal 50, loan 500); invested 2,327.60; savings 3,119.28 = joint budget left 605 + personal budget left 300 + rest of income 2,214.28.

**Savings from earlier months:** every earlier month's savings, minus Savings entries (spent from it), minus Invest and Fam entries from Savings. Kept apart from this month; on the 1st, last month's savings join it. Your call whether to invest it or spend it.

**Goal:** **Set goal** asks for a target, a deadline month and, the first time only, what each person had invested before tracking (prefilled V 243.60 and K 6,409.00 from the Fam. tab). The goal is split equally: each person aims for half. Only investments count; savings count once you invest them.

| Number | Formula |
|---|---|
| Invested | 401(K) entries, Invest entries (from income or savings) and the before-tracking amounts. Fam never counts |
| To go | half the target minus what that person has invested (never below 0) |
| Months left | months from this month through the deadline month, both included |
| Needed per month | To go / Months left, per person |
| Average | invested per tracked month |
| Finish estimate | To go / Average, counted from this month |

Suggestions: the monthly amount for each person, when your average would reach the goal, who is ahead and by how much, how much of this month's savings would hit this month's target, and what investing earlier savings would do.

**Loan payments:** simple logs. The card lists each loan with this month, total paid, and V / K.

**Fam (family investment):** its own card shows what went to Fam this month (V, K and so far) and each Fam account with this month, total and V / K, so you can keep it steady month to month. Fam also has its own column in Month by month, the VK tab and the email recap. Example: K has 1,500 of savings this month and sends 500 to her family's investment account: log Fam, K, From this month's income. K's savings drop to 1,000; K's goal progress does not change.

**Payday plan:** after a Salary is logged for V or K, a short form shows that paycheck's 401(K) (the last amount) and suggests what to invest and what to send to a loan, then logs them in one tap (or Skip). It always leaves room to spend: at least 30% of the paycheck, or last month's spending per paycheck, whichever is more.

**Email recap (optional):** **Set up email recap** on the Funds page, enter one or two addresses, pick **How often** (Daily, Weekly, Every 2 weeks, Monthly), the **Day** (a weekday, or a day of the month from 1 to 28) and the **Time**, then Save (or Save + send test).

- What it says: spending so far this month vs last month by the same day, the recent days (today, last 7 or last 14 days), income, invested, Fam, savings, savings from earlier months, the goal, loan payments and the top next steps. A monthly email starts with last month's full picture (spent, invested, Fam, savings, % kept).
- When it arrives: Google runs it some time within the chosen hour, in the script's time zone (Apps Script > Project Settings > Time zone; set it to America/New_York).
- Is it working: the card on the Funds page shows **Last recap sent ...** or **Last recap failed ...: the reason**, and warns if the schedule is missing from the script. Save + send test sends one right away and shows any error.
- It is sent from the Google account that owns the script; the addresses and schedule are kept in the script's settings, not in the app. Turning it off removes the trigger.

**Getting it to work the first time**

1. Paste the latest `Code.gs` and deploy a New version of the existing deployment. Opening the `/exec` link should say Version 26.
2. In the Apps Script editor, pick `weeklyRecap` in the function list and click **Run**. Approve every permission it asks for (send email as you, run when you are not present). Without this step Google blocks the email and nothing arrives.
3. In the app, open Funds > Set up email recap, enter the addresses, pick the schedule and tap **Save + send test**. The card should say "Last test sent ...".
4. Check the inbox and the spam folder. Mark the first one as Not spam.
5. In Apps Script > **Triggers** (the clock icon) there should be one `weeklyRecap` trigger with your schedule; **Executions** lists every run and its error, if any.

**Funds tab in the sheet:** Date | Kind | Category | Amount ($) | Person | Notes | ID (hidden) | From. Rows are colored by Kind (Income green, 401(K) violet, Invest purple, Fam teal, Loan red, Savings yellow, Goal blue). Columns J onward, rebuilt on every save, like the Sonata summary: This month (V, K, Total), 401(K), Where this month's savings come from, Savings (from earlier months, used, invested from, sent to Fam from, available now, after this month), Goal, Fam (each account), Loan payments, Month by month (Income, 401(K), Spent, Invested, Fam, Savings, Savings total) and Suggestions. Do not type in columns J onward. Hand edits to entries in columns A to H recalculate everything.

**Loans tab (generated):** each loan with this month, total paid, V and K, and last paid; a month-by-month table with one column per loan; and every payment, newest first. Payments are logged in the app (Funds > Loan) and stored in the Funds tab; this tab only shows them. It appears with the first loan payment.

**VK tab (generated):** V and K separately, one row per month (newest first) plus an All months row: Income (in hand), 401(K), Joint (half), Fixed (half shared + own), Personal, Sonata, Loan payments, Spent, Invested, Fam, Savings, Savings rate, Savings total, Put away (401(K) + invested; Fam is not included because it is not part of the goal).

Do not type in the Loans or VK tabs; they are rebuilt on every save.

Tracking starts with the first month that has an Income entry. The **श्री. Fam.** tab is never read or changed.

## Files

Keep all files at the top level of the repo.

| File | Purpose |
|---|---|
| `index.html` | App screen |
| `styles.css` | Styling, light and dark mode |
| `app.js` | Pages and menu, Home, forms, budgets, Funds picture, offline queue, sync |
| `sw.js` | Lets the app open offline |
| `manifest.webmanifest` | Home screen name, colors, icons |
| `icon-180.png`, `icon-192.png`, `icon-512.png` | Icons |
| `Code.gs` | Backend. Paste it into the spreadsheet's Apps Script; it does not run on GitHub |

## How the sheet is chosen

The app never uses the Google Sheets URL. It talks to the **Apps Script web app** you deploy from inside the spreadsheet, and that script writes to whichever spreadsheet you opened it from. Joint, Fixed and Personal entries go to **one tab per month**; car entries go to the **Sonata** tab; income, 401(K), investments and loan payments go to the **Funds** tab, which also feeds the **Loans** and **VK** tabs.

## Monthly tabs

Each calendar month has its own tab, named like **Sirikh Oct 2026**, created automatically the first time an entry is dated in that month. An entry always goes to the tab of its date's month (an October receipt logged in November goes to October).

| Date | Category | Amount ($) | Card Used | Notes | Type | Joint Left ($) | ID (hidden) | Expense For | Tag |
|---|---|---|---|---|---|---|---|---|---|
| 2026-10-03 | Costco | $40.00 | V | | Joint | $560.00 | | | Groceries |
| 2026-10-05 | Walmart | $60.00 | K | | Joint | $500.00 | | | Household items |
| 2026-10-10 | Balance set | $600.00 | Both | October budget | Set balance | $500.00 | | | |
| 2026-10-12 | Haircut | $20.00 | V | | Personal | $500.00 | | V | Personal care |

- **Budgets are per calendar month and reset on the 1st.** Nothing carries over.
- **Set it any time:** the latest Set balance row in a month is that month's joint budget, and every Joint expense dated in the month counts against it, even ones logged before it (the Costco row above). The same goes for Personal budget rows and each person's Personal expenses.
- **Joint Left ($)** = the month's joint budget minus joint spending up to that row. Blank until a budget is set for the month.
- **Type** is one of `Joint`, `Fixed`, `Personal`, `Set balance`, `Personal budget`, `Settlement` (or `Add funds` typed by hand). Blank counts as Joint.
- **Expense For** is filled for Personal rows (V or K; rows without it count as the card owner's) and Fixed rows (Both, V or K; a blank Fixed row counts as shared).
- **Tag** (a dropdown in the sheet too, including your own tags) is filled for Joint, Personal and Fixed rows. A blank Tag, such as on rows from before version 24 or rows typed by hand, is filled with a guess from the Category (anything unknown becomes Other). Pick another tag from the dropdown to change it; the charts follow.
- **Row colors** come from Type, Expense For and Card Used, and update after hand edits.
- **ID** prevents duplicates and identifies rows to delete. Do not edit it.

**Tables in each month tab (column K onward)**, rebuilt on every save:

1. **Who owes whom** for the month: V paid, K paid, Total; V's share, K's share, Equal split; Settle up (joint); Personal on other's card; Overall (joint + fixed + personal); **Settled**; **Status** (green Cleared or amber Open).
2. **Fixed bills:** V paid, K paid, Total; Shared, V's own, K's own, V's fixed, K's fixed; Settle up.
3. **Personal expenses:** each person's Personal spending on their own card (nothing owed) and on the other's card (owed in full), Settle up, Overall.
4. **Budgets for the month:** Budget, Spent and **Left** for Joint, V personal and K personal.
5. **Colors:** a legend of the row colors.

Do not type in columns K onward; the script overwrites them. (Before version 24 the tables started at column J; version 24 clears that area once, adds Tag in J and writes the tables from K.)

## Sirikh tab (overview)

The **Sirikh** tab is a month-by-month overview, newest month first, rebuilt on every save:

Month | Tab | Joint budget | Joint spent | Fixed bills | V fixed | K fixed | V personal spent | K personal spent | V personal left | K personal left | Joint settle | Fixed settle | Personal settle | Overall settle | Settled | Status | **Joint left**

The last column is what was left of that month's joint budget. Do not type in this tab.

**Start of the month:** when the current month has no joint budget (or a personal budget that existed last month), the app shows a prompt with **Set joint budget**, **Set personal budgets** and **Later**.

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
- **Version 20 and later ask for permission once:** the email recap needs "Send email as you" and "Allow this application to run when you are not present". Run any function once in the editor (for example select `weeklyRecap` and click Run) and approve, or approve when Apps Script prompts during deploy. Nothing is emailed until you set it up in the app.

## Troubleshooting

| Problem | Fix |
|---|---|
| Site shows 404 | `index.html` must be at the top level and Pages set to main, root. Make any commit to trigger a build. |
| "Wrong key" | The app key must match `SIRIKH_KEY` exactly, including case. |
| "Web app URL did not answer correctly" | Use the `/exec` URL from Apps Script, not the sheet URL or a `/dev` URL. Access must be **Anyone**. |
| Fixed, Personal, Sonata or Funds entries, or edits, stay on the phone with an hourglass, or Fixed shows as Joint in the sheet | The sheet's Apps Script is an older version. Paste the latest `Code.gs`, then Deploy > Manage deployments > pencil > Version: New version > Deploy. Opening the `/exec` link should say "Version 25" or higher. If you made a New deployment instead, paste its new `/exec` URL into the app's settings. |
| "SIRIKH_KEY is not set" | Add the script property (Backend, step 3). |
| `Code.gs` changes have no effect | Deploy a new version of the existing deployment. |
| Balance looks wrong | Check the Type column in the Sirikh tab. Fixing a row recalculates the balance. |
| No charts on Home, or "Charts need the Apps Script at version 24" | Paste the latest `Code.gs` and deploy a New version, then open the app online once. Entries with a tag wait on the phone (hourglass) until then. |
| Old home screen icon | Remove it and add it again from Safari. |
| Email recap: "You do not have permission", "Last recap failed", or no email | In Apps Script, select `weeklyRecap`, click Run and approve the permissions. Then open Set up email recap in the app and tap Save + send test. Check the spam folder for the first one. |
| Email recap: the card says the schedule is missing | Open Set up email recap and tap Save; that creates the trigger again. |
| Email recap comes at the wrong hour | Set the script's time zone in Apps Script > Project Settings, then save the recap again in the app. |
| Picked daily or monthly but it still comes on Sunday | The script is older than version 26. Paste the latest `Code.gs` and deploy a New version, then save the recap again. |
