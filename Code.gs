/**
 * Sirikh backend (Google Apps Script, attached to the expense spreadsheet).
 *
 * Setup (once):
 *   1. Open the spreadsheet > Extensions > Apps Script.
 *   2. Replace everything in Code.gs with this file > Save.
 *   3. Project Settings (gear) > Script properties > Add: SIRIKH_KEY = <your passphrase>.
 *   4. Deploy > New deployment > Web app > Execute as: Me, Who has access: Anyone > Deploy.
 * After changing this file later:
 *   Deploy > Manage deployments > Edit (pencil) > Version: New version > Deploy (the /exec URL stays the same).
 *
 * One tab per calendar month, named like "Sirikh Oct 2026" (created automatically). Each entry goes
 * to the tab of its date's month:
 *   Date | Category | Amount ($) | Card Used | Notes | Type | Joint Left ($) | ID | Expense For | Tag
 * The "Sirikh" tab is an overview with one row per month, rebuilt on every save.
 *
 * Card Used is whose card paid. Expense For is whose expense it is: blank (shared) for Joint, V or K
 * for Personal, and Both (shared, split 50/50; blank on older rows), V or K for Fixed (V's and K's
 * own mobile bills). A one-person expense (Personal or Fixed) paid on the other person's card is
 * owed back in full (K's ramen on V's card: K owes V the whole amount).
 *
 * Type is one of:
 *   Joint            shared day-to-day expense, comes out of the month's joint budget  (no color)
 *   Fixed            rent, utilities and other bills, no budget       (orange: V light, K darker)
 *   Personal         one person's own expense, comes out of that person's budget (blue: V light, K darker)
 *   Set balance      the month's joint budget
 *   Personal budget  the month's personal budget for V or K (Expense For)
 *   Add funds        adds to the month's joint budget (only from hand edits)
 *   Settlement       money one person paid the other to clear what was owed (Splitwise, cash...).
 *                    Card Used = who paid, Expense For = who received. Not an expense: it never
 *                    touches budgets or spending, only the month's Settled / Status lines (green rows).
 * Refunds are entered as negative amounts (shown in green): they lower spending, add back to the
 * budget and reduce what is owed, exactly undoing the original expense.
 * Budgets are per calendar month and reset on the 1st (nothing carries over). The latest budget
 * row in a month sets the amount, and every expense dated in that month counts against it, even
 * one logged before the budget was set. Joint Left ($) is the joint budget minus the joint
 * spending up to that row; the rows and colors are recalculated whenever the tab changes.
 *
 * Tag says where the money went (a dropdown): Groceries, Dining out, Entertainment, Shopping and so on
 * for Joint and Personal, the bill (Rent, Utilities...) for Fixed. A blank Tag is filled with a guess
 * from the Category; pick another from the dropdown to change it. The app's Home charts use the tags,
 * the Sonata categories and the Funds kinds.
 *
 * Columns K onward of each month tab hold that month's tables (who owes whom, fixed bills,
 * personal expenses, budgets with what is left). The script overwrites that area.
 *
 * Income, 401(K), investments, Fam (money sent to the family's investment account), loan payments,
 * savings and the savings goal live in the "Funds" tab:
 * entries on the left, an overview (this month, 401(K), savings, goal, loan payments, month by month)
 * from column J. Two more tabs are rebuilt from it: "Loans" (each loan month by month and every
 * payment) and "VK" (V and K side by side, month over month). See the Funds section at the end of
 * this file. An optional weekly email recap runs from a time-based trigger.
 *
 * Car expenses and fuel tracking live in their own "Sonata" tab (see the Sonata section
 * at the end of this file). They never mix with the monthly tabs, their budgets or their split.
 */

const OVERVIEW_TAB = 'Sirikh';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September',
  'October', 'November', 'December'];
const MONTH_TAB_RE = /^Sirikh (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4})$/;
// The app checks this. Bump it whenever the app starts depending on something new in this file.
const BACKEND_VERSION = 25;
const HEADERS = ['Date', 'Category', 'Amount ($)', 'Card Used', 'Notes', 'Type', 'Joint Left ($)', 'ID', 'Expense For', 'Tag'];
const C = { DATE: 0, CATEGORY: 1, AMOUNT: 2, PAID_BY: 3, NOTES: 4, TYPE: 5, BALANCE: 6, ID: 7, FOR: 8, TAG: 9 };
// Tags for Joint and Personal expenses (the app's dropdown). Fixed bills use their bill as the tag,
// Sonata rows their car category and Funds rows their kind.
const TAGS = ['Groceries', 'Dining out', 'Entertainment', 'Shopping', 'Household items', 'Subscriptions', 'Travel', 'Fuel',
  'Transport', 'Health', 'Personal care', 'Gifts', 'Education', 'Bills', 'Other'];
// Tags of your own: picking Other in the app lets you name one; it is accepted here as typed (up
// to 30 characters) and joins the sheet's dropdown and the app's list.
const TAG_MAX = 30;
const FIXED_TAGS = ['Rent', 'Utilities', 'Electricity', 'Wi-Fi', 'Mobile bill', 'Misc'];
// A blank Tag (older rows, hand-typed rows) is filled with a best guess from the Category.
const TAG_GUESSES = [
  ['Fuel', /\b(gas|fuel|shell|exxon|bp|chevron|sunoco|wawa|sheetz|circle k|speedway)\b/],
  ['Groceries', /\b(ht|harris teeter|costco|walmart|aldi|kroger|lidl|publix|trader joe|whole foods|food lion|wegmans|sam'?s club|grocer|patel|apna|indian store|safeway|giant|sprouts|bj'?s)\b/],
  ['Dining out', /\b(restaurant|cafe|coffee|starbucks|dunkin|pizza|biryani|rice|chipotle|mcdonald|burger|taco|sushi|lunch|dinner|breakfast|doordash|uber ?eats|grubhub|bar|boba|tea|chai|dosa|wendy|subway|panera|chick)\b/],
  ['Bills', /\b(bill|bills|insurance|verizon|t-mobile|at&t|xfinity|spectrum|duke energy)\b/],
  ['Subscriptions', /\b(netflix|spotify|prime|icloud|youtube|hulu|disney|hbo|chatgpt|claude|apple music|subscription|membership|gym)\b/],
  ['Entertainment', /\b(movie|cinema|amc|regal|concert|game|bowling|show|ticket|event|park)\b/],
  ['Travel', /\b(flight|airline|hotel|airbnb|trip|vacation|booking|expedia|delta|united|american airlines|southwest)\b/],
  ['Transport', /\b(uber|lyft|metro|bus|train|amtrak|parking|toll|taxi)\b/],
  ['Health', /\b(pharmacy|cvs|walgreens|doctor|dentist|hospital|medicine|clinic|health|copay)\b/],
  ['Personal care', /\b(salon|haircut|barber|spa|nails|sephora|ulta|cosmetic)\b/],
  ['Household items', /\b(ikea|home depot|lowe'?s|bed bath|detergent|cleaning|furniture|kitchen|household|dollar)\b/],
  ['Shopping', /\b(amazon|target|mall|clothes|shoes|nike|zara|h&m|best buy|apple store|shopping|tj maxx|marshalls|ross)\b/],
  ['Gifts', /\b(gift|birthday|present|wedding)\b/],
  ['Education', /\b(course|book|tuition|udemy|class|exam)\b/],
];
const TYPES = ['Joint', 'Fixed', 'Personal', 'Add funds', 'Set balance', 'Personal budget', 'Settlement'];
const SETTLE_METHODS = ['Splitwise', 'Cash', 'Zelle', 'Venmo', 'Other'];
// Row colors: Personal in blues by whose expense, Fixed bills in oranges by whose card (V lighter, K darker).
const COLORS = {
  personalV: '#dbeafe',
  personalK: '#93c5fd',
  fixedV: '#fed7aa',
  fixedK: '#fb923c',
  settled: '#bbf7d0', // settlement rows and "Cleared"
  open: '#fef3c7',    // "Open" (still owed)
};
const MONEY = '$#,##0.00';
// Entry amounts: a refund (negative amount) shows in green.
const ENTRY_MONEY = '$#,##0.00;[Color10]-$#,##0.00';
const RECENT_COUNT = 10;
// Which rows each page's Recent list shows (Home shows every row). Older rows come from the
// "list" action, a page at a time.
const RECENT_GROUPS = {
  Joint: ['Joint', 'Set balance', 'Add funds', 'Settlement'],
  Fixed: ['Fixed'],
  Personal: ['Personal', 'Personal budget', 'Settlement'],
};
const LIST_MAX = 100;
// Every entry, newest first, from the last state_ / carState_ / fundsState_ call (for the list action).
let MAIN_LIST_CACHE = [];
let CAR_LIST_CACHE = [];
let FUNDS_LIST_CACHE = [];
const SUMMARY_COL = 11; // column K (column J until version 24, before the Tag column)

function doGet() {
  return ContentService.createTextOutput('Sirikh backend is running. Version ' + BACKEND_VERSION + '.');
}

function doPost(e) {
  let result;
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    checkKey_(body.key);
    const lock = LockService.getScriptLock();
    lock.waitLock(15000);
    try {
      migrateLegacy_();
      // The phone's own date decides the current month (its time zone is the user's).
      const today = /^\d{4}-\d{2}-\d{2}$/.test(String(body.today || '')) ? body.today : todayStr_();
      const touched = [today.slice(0, 7)];
      const carSheet = getCarSheet_();
      const isCar = body.table === 'car';
      const isFunds = body.table === 'funds';
      if (body.action === 'add') {
        if (isCar) addCar_(carSheet, validateCar_(body.entry || {}));
        else if (isFunds) addFunds_(validateFunds_(body.entry || {}));
        else {
          const entry = validate_(body.entry || {});
          addEntry_(entry);
          touched.push(entry.month || entry.date.slice(0, 7));
        }
      } else if (body.action === 'update') {
        // An edit from the app: same id, new values (validated before anything is changed).
        if (isCar) updateCar_(carSheet, validateCar_(body.entry || {}));
        else if (isFunds) updateFunds_(validateFunds_(body.entry || {}));
        else {
          const entry = validate_(body.entry || {});
          const old = updateEntry_(entry);
          touched.push(entry.month || entry.date.slice(0, 7));
          if (old) touched.push(old);
        }
      } else if (body.action === 'delete') {
        if (isCar) deleteCar_(carSheet, String(body.id || ''));
        else if (isFunds) deleteFunds_(String(body.id || ''));
        else {
          const key = deleteEntry_(String(body.id || ''));
          if (key) touched.push(key);
        }
      } else if (body.action === 'recap') {
        setRecap_(body);
      } else if (body.action !== 'state' && body.action !== 'list') {
        throw new Error('Unknown action.');
      }
      result = state_(today.slice(0, 7), touched);
      // A new tag of your own: add it to every month tab's Tag dropdown.
      const sent = body.entry && (body.action === 'add' || body.action === 'update') && !isCar && !isFunds ? String(body.entry.tag || '') : '';
      if (sent && TAGS.indexOf(sent) === -1) {
        const props = PropertiesService.getScriptProperties();
        const list = customTags_().join('|');
        if (props.getProperty('SIRIKH_TAG_LIST') !== list) {
          refreshTagDropdowns_();
          props.setProperty('SIRIKH_TAG_LIST', list);
        }
      }
      result.car = carState_(carSheet);
      result.funds = fundsState_(today, MONTHS_CACHE, carSheet);
      result.analytics = analytics_(MONTHS_CACHE, carSheet);
      if (body.action === 'recap' && body.test) result.recapSent = sendRecap_(today);
      if (body.action === 'list') result.list = list_(body);
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    result = { ok: false, error: String((err && err.message) || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

// Simple trigger: keeps a month tab (and the overview) right when it is edited by hand.
function onEdit(e) {
  const sheet = e && e.range && e.range.getSheet();
  if (!sheet) return;
  const key = keyOfTab_(sheet.getName());
  if (key && e.range.getColumn() < SUMMARY_COL) state_(todayStr_().slice(0, 7), [key]);
  if (sheet.getName() === CAR_TAB && e.range.getColumn() < CAR_SUMMARY_COL) carState_(sheet);
  // Funds depend on every tab: refresh them (and Sirikh Overall) after any data edit.
  const dataEdit = (key && e.range.getColumn() < SUMMARY_COL) || (sheet.getName() === CAR_TAB && e.range.getColumn() < CAR_SUMMARY_COL) ||
    (sheet.getName() === FUNDS_TAB && e.range.getColumn() < FUNDS_SUMMARY_COL);
  if (dataEdit) {
    const today = todayStr_();
    if (!key) state_(today.slice(0, 7), []);
    fundsState_(today, MONTHS_CACHE, getCarSheet_());
  }
}

function checkKey_(key) {
  const expected = PropertiesService.getScriptProperties().getProperty('SIRIKH_KEY');
  if (!expected) throw new Error('SIRIKH_KEY is not set in Script properties.');
  if (key !== expected) throw new Error('Wrong key.');
}

function todayStr_() {
  return Utilities.formatDate(new Date(), SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone(), 'yyyy-MM-dd');
}

// '2026-10' <-> 'Sirikh Oct 2026'
function tabName_(key) {
  return 'Sirikh ' + MONTHS[Number(key.slice(5, 7)) - 1] + ' ' + key.slice(0, 4);
}
function keyOfTab_(name) {
  const m = MONTH_TAB_RE.exec(String(name));
  return m ? m[2] + '-' + String(MONTHS.indexOf(m[1]) + 1).padStart(2, '0') : null;
}
function monthLabel_(key) {
  return MONTHS_LONG[Number(key.slice(5, 7)) - 1] + ' ' + key.slice(0, 4);
}
function previousKey_(key) {
  const y = Number(key.slice(0, 4));
  const m = Number(key.slice(5, 7));
  return m === 1 ? (y - 1) + '-12' : y + '-' + String(m - 1).padStart(2, '0');
}

function monthSheet_(key, create) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(tabName_(key));
  if (!sheet) {
    if (!create) return null;
    sheet = ss.insertSheet(tabName_(key));
  }
  upgradeMonthTab_(sheet);
  return sheet;
}

// Writes the header row when it is missing or old. Tabs from before version 24 kept their tables
// from column J, where Tag now goes: those are cleared (and rewritten from K). Returns true then.
function upgradeMonthTab_(sheet) {
  const header = sheet.getRange(1, 1, 1, HEADERS.length);
  const current = header.getValues()[0];
  if (current.join('|') === HEADERS.join('|')) return false;
  const moved = current[C.TAG] !== 'Tag' && sheet.getLastColumn() > C.FOR + 1;
  if (moved) {
    sheet.getRange(1, C.TAG + 1, Math.max(sheet.getLastRow(), 1), sheet.getLastColumn() - C.FOR - 1).clearContent().clearFormat();
  }
  header.setValues([HEADERS]).setFontWeight('bold');
  sheet.setFrozenRows(1);
  sheet.hideColumns(C.ID + 1);
  // A dropdown in the Tag column; other text is still accepted (shown with a warning mark).
  const rule = tagRule_(MONTHS_CACHE.length ? customTags_() : []);
  sheet.getRange(2, C.TAG + 1, Math.max(sheet.getMaxRows() - 1, 1), 1).setDataValidation(rule);
  return moved;
}

// Every month tab, oldest first. upgraded = its layout was just brought up to date.
function monthTabs_() {
  return SpreadsheetApp.getActiveSpreadsheet().getSheets()
    .map((s) => ({ sheet: s, key: keyOfTab_(s.getName()) }))
    .filter((t) => t.key)
    .map((t) => Object.assign(t, { upgraded: upgradeMonthTab_(t.sheet) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

// Earlier versions kept every row in the "Sirikh" tab. Once, move them into their month tabs and
// turn "Sirikh" into the overview.
function migrateLegacy_() {
  const old = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(OVERVIEW_TAB);
  if (!old || old.getLastRow() < 1 || old.getRange(1, 1).getValues()[0][0] !== 'Date') return;
  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  const groups = {};
  readRows_(old).filter((r) => !isEmptyRow_(r)).forEach((r) => {
    const d = formatDate_(r[C.DATE], tz);
    const key = /^\d{4}-\d{2}/.test(d) ? d.slice(0, 7) : todayStr_().slice(0, 7);
    if (!groups[key]) groups[key] = [];
    groups[key].push(r.slice(0, HEADERS.length));
  });
  Object.keys(groups).forEach((key) => {
    const sheet = monthSheet_(key, true);
    const rows = groups[key];
    sheet.getRange(nextRow_(sheet), 1, rows.length, HEADERS.length).setValues(rows);
    sheet.getRange(2, C.DATE + 1, sheet.getLastRow() - 1, 1).setNumberFormat('yyyy-mm-dd');
  });
  old.clear();
  old.setFrozenRows(0);
}

function validate_(b) {
  const type = TYPES.indexOf(b.type) !== -1 ? b.type : 'Joint';
  const isFunds = type === 'Add funds' || type === 'Set balance';
  const isPersonalBudget = type === 'Personal budget';
  const isSettlement = type === 'Settlement';

  const date = String(b.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Invalid date.');

  const amount = Number(b.amount);
  if (!isFinite(amount)) throw new Error('Invalid amount.');
  if (amount === 0 && type !== 'Set balance') throw new Error('Amount cannot be 0.');
  if (isPersonalBudget && amount < 0) throw new Error('A budget cannot be negative.');
  if (isSettlement && amount <= 0) throw new Error('A settlement must be more than 0.');

  // A personal budget belongs to one person; there is no card involved.
  const paidBy = isPersonalBudget ? String(b.expenseFor || '') : String(b.paidBy || '');
  const payers = isFunds ? ['V', 'K', 'Both'] : ['V', 'K'];
  if (payers.indexOf(paidBy) === -1) throw new Error('Card used must be ' + payers.join(', ') + '.');
  // Only Personal expenses belong to one person; older apps send nothing, meaning the card owner.
  let expenseFor = '';
  if (type === 'Personal' || isPersonalBudget) {
    expenseFor = b.expenseFor === undefined || b.expenseFor === '' ? paidBy : String(b.expenseFor);
    if (expenseFor !== 'V' && expenseFor !== 'K') throw new Error('Expense for must be V or K.');
  }
  // A Fixed bill is shared (Both, split 50/50) unless it is one person's own (a mobile line).
  if (type === 'Fixed') {
    expenseFor = String(b.expenseFor || 'Both');
    if (expenseFor === 'Joint' || expenseFor === '') expenseFor = 'Both';
    if (['V', 'K', 'Both'].indexOf(expenseFor) === -1) throw new Error('Expense for must be V, K or Both.');
  }
  // A settlement goes from the payer (Card Used) to the other person (Expense For).
  const method = SETTLE_METHODS.indexOf(b.method) !== -1 ? b.method : 'Splitwise';
  if (isSettlement) expenseFor = paidBy === 'V' ? 'K' : 'V';
  // The month a settlement clears (it may be paid in a later month).
  const month = isSettlement && /^\d{4}-\d{2}$/.test(String(b.month || '')) ? String(b.month) : date.slice(0, 7);

  let category = String(b.category || '').trim();
  if (!category) {
    if (isPersonalBudget) category = expenseFor + "'s personal budget";
    else if (isSettlement) category = 'Settled via ' + method;
    else if (!isFunds) throw new Error('Category is required.');
    else category = type === 'Set balance' ? 'Balance set' : 'Funds added';
  }
  // Joint and Personal take a tag from the list (a guess from the category when none is sent);
  // a Fixed bill is its own tag.
  let tag = '';
  if (type === 'Joint' || type === 'Personal') tag = TAGS.indexOf(b.tag) !== -1 ? b.tag : cleanTag_(b.tag) || guessTag_(category);
  if (type === 'Fixed') tag = fixedTag_(category);

  return {
    id: String(b.id || Utilities.getUuid()).slice(0, 64),
    date: date, // the sheet turns yyyy-mm-dd text into a real date
    category: safeText_(category.slice(0, 200)),
    amount: Math.round(amount * 100) / 100,
    paidBy: paidBy,
    notes: safeText_(String(b.notes || '').trim().slice(0, 500)),
    type: type,
    expenseFor: expenseFor,
    month: month,
    tag: tag,
  };
}

// A tag of your own: trimmed, single spaces, first letter capital, no formula start. '' if unusable.
function cleanTag_(v) {
  const t = String(v || '').replace(/\s+/g, ' ').trim().slice(0, TAG_MAX);
  if (!t || /^[=+\-@]/.test(t)) return '';
  const known = TAGS.concat(FIXED_TAGS).find((x) => x.toLowerCase() === t.toLowerCase());
  return known || t.charAt(0).toUpperCase() + t.slice(1);
}

// Tags of your own used in Joint and Personal rows, in the order first seen.
function customTags_(months) {
  const out = [];
  (months || MONTHS_CACHE).forEach((m) => m.rows.forEach((r) => {
    if (isEmptyRow_(r)) return;
    const type = normalizeType_(r[C.TYPE]);
    if (type !== 'Joint' && type !== 'Personal') return;
    const t = String(r[C.TAG] || '').trim();
    if (t && TAGS.indexOf(t) === -1 && FIXED_TAGS.indexOf(t) === -1 && out.indexOf(t) === -1) out.push(t);
  }));
  return out;
}

// The Tag column's dropdown: the standard tags, the fixed bills and your own tags.
function tagRule_(custom) {
  return SpreadsheetApp.newDataValidation().requireValueInList(TAGS.concat(FIXED_TAGS).concat(custom || []), true).setAllowInvalid(true).build();
}
// Called when a new tag of your own is saved, so every month tab's dropdown offers it.
function refreshTagDropdowns_() {
  const rule = tagRule_(customTags_());
  monthTabs_().forEach((t) => t.sheet.getRange(2, C.TAG + 1, Math.max(t.sheet.getMaxRows() - 1, 1), 1).setDataValidation(rule));
}

function guessTag_(category) {
  const s = String(category || '').toLowerCase();
  for (let i = 0; i < TAG_GUESSES.length; i++) if (TAG_GUESSES[i][1].test(s)) return TAG_GUESSES[i][0];
  return 'Other';
}
function fixedTag_(category) {
  const s = String(category || '').trim().toLowerCase().replace(/[\s-]/g, '');
  if (s === 'mobile' || s === 'phone' || s === 'phonebill' || s === 'mobilebill') return 'Mobile bill';
  for (let i = 0; i < FIXED_TAGS.length; i++) if (FIXED_TAGS[i].toLowerCase().replace(/[\s-]/g, '') === s) return FIXED_TAGS[i];
  return 'Misc';
}
// The tag a row should show: a valid tag typed in the sheet wins, else the guess.
function rowTag_(r, type) {
  const typed = String(r[C.TAG] || '').trim();
  if (type === 'Fixed') return typed ? typed : fixedTag_(r[C.CATEGORY]);
  if (type !== 'Joint' && type !== 'Personal') return typed;
  return typed || guessTag_(r[C.CATEGORY]);
}

// Text starting with = + - @ would be read as a formula.
function safeText_(s) {
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function addEntry_(entry) {
  const sheet = monthSheet_(entry.month || entry.date.slice(0, 7), true);
  // Retries from the phone's offline queue reuse the same id; save once.
  if (ids_(sheet).indexOf(entry.id) !== -1) return;
  const row = nextRow_(sheet);
  sheet.getRange(row, 1, 1, HEADERS.length)
    .setValues([entryRow_(entry)]);
  sheet.getRange(row, C.DATE + 1).setNumberFormat('yyyy-mm-dd');
  sheet.getRange(row, C.AMOUNT + 1).setNumberFormat(ENTRY_MONEY);
}

const entryRow_ = (e) => [e.date, e.category, e.amount, e.paidBy, e.notes, e.type, '', e.id, e.expenseFor, e.tag];

// An edited entry: rewritten in place when it stays in the same month, otherwise moved to the tab
// of its new month. Returns the month it was in before (or null if it was not found, then added).
function updateEntry_(entry) {
  const key = entry.month || entry.date.slice(0, 7);
  const tabs = monthTabs_();
  for (let t = 0; t < tabs.length; t++) {
    const i = ids_(tabs[t].sheet).lastIndexOf(entry.id);
    if (i === -1) continue;
    if (tabs[t].key === key) {
      tabs[t].sheet.getRange(i + 2, 1, 1, HEADERS.length).setValues([entryRow_(entry)]);
      tabs[t].sheet.getRange(i + 2, C.DATE + 1).setNumberFormat('yyyy-mm-dd');
      tabs[t].sheet.getRange(i + 2, C.AMOUNT + 1).setNumberFormat(ENTRY_MONEY);
    } else {
      tabs[t].sheet.deleteRow(i + 2);
      addEntry_(entry);
    }
    return tabs[t].key;
  }
  addEntry_(entry);
  return null;
}

// Deletes the row with this id from whichever month tab holds it; returns that month (or null).
function deleteEntry_(id) {
  if (!id) throw new Error('Missing id.');
  const tabs = monthTabs_();
  for (let t = 0; t < tabs.length; t++) {
    const i = ids_(tabs[t].sheet).lastIndexOf(id);
    if (i !== -1) {
      tabs[t].sheet.deleteRow(i + 2);
      return tabs[t].key;
    }
  }
  return null; // already gone is fine (retried delete)
}

// First empty row under the data in A:J (the tables from column K do not count).
function nextRow_(sheet) {
  const rows = readRows_(sheet);
  for (let i = rows.length - 1; i >= 0; i--) if (!isEmptyRow_(rows[i])) return i + 3;
  return 2;
}

function ids_(sheet) {
  const last = sheet.getLastRow();
  if (last < 2) return [];
  return sheet.getRange(2, C.ID + 1, last - 1, 1).getValues().map((r) => String(r[0]));
}

function readRows_(sheet) {
  const last = sheet.getLastRow();
  if (last < 2) return [];
  return sheet.getRange(2, 1, last - 1, HEADERS.length).getValues();
}

function isEmptyRow_(r) {
  return r[C.DATE] === '' && r[C.CATEGORY] === '' && r[C.AMOUNT] === '';
}

// The month's joint budget: the latest Set balance row (anywhere in the tab) plus any Add funds.
// null when no budget is set for the month.
function jointBudget_(rows) {
  let budget = null;
  let added = 0;
  rows.forEach((r) => {
    if (isEmptyRow_(r)) return;
    const type = normalizeType_(r[C.TYPE]);
    if (type === 'Set balance') budget = toNumber_(r[C.AMOUNT]);
    if (type === 'Add funds') added += toNumber_(r[C.AMOUNT]);
  });
  return budget === null ? null : round2_(budget + added);
}

// Recalculates Type (blank > Joint), Joint Left ($) and row colors; writes only what changed.
function recompute_(sheet) {
  const rows = readRows_(sheet);
  if (!rows.length) return rows;
  const budget = jointBudget_(rows);
  let joint = 0;
  let changed = false;
  let tagsChanged = false;
  rows.forEach((r) => {
    if (isEmptyRow_(r)) {
      if (r[C.BALANCE] !== '') changed = true;
      r[C.BALANCE] = '';
      return;
    }
    const type = normalizeType_(r[C.TYPE]);
    if (type === 'Joint') joint += toNumber_(r[C.AMOUNT]);
    const left = budget === null ? '' : round2_(budget - joint);
    if (r[C.TYPE] !== type || r[C.BALANCE] !== left) changed = true;
    r[C.TYPE] = type;
    r[C.BALANCE] = left;
    const tag = rowTag_(r, type);
    if (r[C.TAG] !== tag) tagsChanged = true;
    r[C.TAG] = tag;
  });
  if (changed) {
    sheet.getRange(2, C.TYPE + 1, rows.length, 2).setValues(rows.map((r) => [r[C.TYPE], r[C.BALANCE]]));
    sheet.getRange(2, C.BALANCE + 1, rows.length, 1).setNumberFormat(MONEY);
  }
  if (tagsChanged) sheet.getRange(2, C.TAG + 1, rows.length, 1).setValues(rows.map((r) => [r[C.TAG]]));
  const key = keyOfTab_(sheet.getName());
  if (key) {
    labelSettlements_(sheet, rows, shares_(period_(rows, key)).owedNet,
      { amount: C.AMOUNT, payer: C.PAID_BY, label: C.CATEGORY }, (r) => normalizeType_(r[C.TYPE]) === 'Settlement');
  }
  colorRows_(sheet, rows);
  return rows;
}

// Numbers settlements in row order against what was owed: "Settlement 1 (partial) via Splitwise",
// ..., "Settlement 3 (final, cleared) via Zelle", or "Settlement (paid in full) via Cash" for one
// payment that clears it. "overpaid" / "extra" flag a payment past what was owed.
function settlementLabels_(items, owedNet) {
  let cum = 0;
  return items.map((it, i) => {
    const delta = it.payer === 'K' ? it.amount : -it.amount;
    const before = round2_(owedNet - cum);
    cum += delta;
    const after = round2_(owedNet - cum);
    let tag;
    if (Math.abs(before) < 0.01) tag = 'extra';
    else if (Math.abs(after) < 0.01) tag = items.length === 1 ? 'paid in full' : 'final, cleared';
    else if (Math.sign(after) !== Math.sign(before)) tag = 'overpaid';
    else tag = 'partial';
    return (tag === 'paid in full' ? 'Settlement' : 'Settlement ' + (i + 1)) + ' (' + tag + ') via ' + it.method;
  });
}

// Rewrites the label cell of each settlement row when its number or status changed.
// cols = 0-based columns of the amount, the payer and the label.
function labelSettlements_(sheet, rows, owedNet, cols, isSettlement) {
  const idx = [];
  rows.forEach((r, i) => { if (!isEmptyRow_(r) && isSettlement(r)) idx.push(i); });
  if (!idx.length) return;
  const items = idx.map((i) => {
    const m = /via (.+)$/.exec(String(rows[i][cols.label]));
    return { amount: toNumber_(rows[i][cols.amount]), payer: String(rows[i][cols.payer]), method: m ? m[1] : 'Splitwise' };
  });
  settlementLabels_(items, owedNet).forEach((label, n) => {
    const r = rows[idx[n]];
    if (r[cols.label] !== label) {
      r[cols.label] = label;
      sheet.getRange(idx[n] + 2, cols.label + 1).setValue(label);
    }
  });
}

function rowColor_(r) {
  if (isEmptyRow_(r)) return null;
  if (r[C.TYPE] === 'Personal') return owner_(r) === 'K' ? COLORS.personalK : COLORS.personalV;
  if (r[C.TYPE] === 'Fixed') return r[C.PAID_BY] === 'K' ? COLORS.fixedK : COLORS.fixedV;
  if (r[C.TYPE] === 'Settlement') return COLORS.settled;
  return null; // Joint and budget rows stay plain
}

// Whose Personal expense this is (rows saved before Expense For existed belong to the card owner).
function owner_(r) {
  const f = String(r[C.FOR] || '').trim().toUpperCase();
  return f === 'V' || f === 'K' ? f : String(r[C.PAID_BY]);
}
// Whose Fixed bill this is: V or K for one person's own bill, Both (shared) otherwise, blank included.
function fixedOwner_(r) {
  const f = String(r[C.FOR] || '').trim().toUpperCase();
  return f === 'V' || f === 'K' ? f : 'Both';
}

function colorRows_(sheet, rows) {
  const range = sheet.getRange(2, 1, rows.length, HEADERS.length);
  const current = range.getBackgrounds();
  let changed = false;
  const wanted = rows.map((r, i) => {
    const color = rowColor_(r);
    const have = String(current[i][0]).toLowerCase();
    if ((color || '#ffffff') !== have) changed = true;
    return new Array(HEADERS.length).fill(color);
  });
  if (changed) range.setBackgrounds(wanted);
}

function emptyPeriod_(key) {
  // personal: net of Personal expenses paid on the other's card (positive = K owes V)
  // pv / pk: Personal expenses for V / K in the month
  // kOnK / vOnV on their own card (nothing owed), kOnV / vOnK on the other's card (owed in full)
  return { month: key || '', since: key ? key + '-01' : '', hasBudget: false, start: 0, added: 0, spent: 0,
    // fixed: all Fixed bills; fv / fk what each card paid. fShared: shared bills (fsv / fsk by card);
    // fOwnV / fOwnK each person's own bills (mobile lines); fixedOwed: own bills on the other's card
    // (positive = K owes V)
    v: 0, k: 0, fixed: 0, fv: 0, fk: 0, fShared: 0, fsv: 0, fsk: 0, fOwnV: 0, fOwnK: 0, fixedOwed: 0, personal: 0, pv: 0, pk: 0, kOnK: 0, kOnV: 0, vOnV: 0, vOnK: 0,
    // settlements: total paid, and the net that clears "K owes V" (positive = K paid V)
    settled: 0, settledNet: 0 };
}

// Totals for one month tab. Every row in the tab belongs to that month.
function period_(rows, key) {
  const p = emptyPeriod_(key);
  let budget = null;
  rows.filter((r) => !isEmptyRow_(r)).forEach((r) => {
    const amount = toNumber_(r[C.AMOUNT]);
    const type = normalizeType_(r[C.TYPE]);
    if (type === 'Set balance') budget = amount;
    if (type === 'Add funds') p.added += amount;
    if (type === 'Joint') {
      p.spent += amount;
      if (r[C.PAID_BY] === 'V') p.v += amount;
      if (r[C.PAID_BY] === 'K') p.k += amount;
    }
    if (type === 'Fixed') {
      p.fixed += amount;
      if (r[C.PAID_BY] === 'V') p.fv += amount;
      if (r[C.PAID_BY] === 'K') p.fk += amount;
      const who = fixedOwner_(r);
      if (who === 'Both') {
        p.fShared += amount;
        if (r[C.PAID_BY] === 'V') p.fsv += amount;
        if (r[C.PAID_BY] === 'K') p.fsk += amount;
      } else {
        p['fOwn' + who] += amount;
        p.fixedOwed += personalOwed_(who, r[C.PAID_BY], amount);
      }
    }
    if (type === 'Settlement') {
      p.settled += amount;
      p.settledNet += r[C.PAID_BY] === 'K' ? amount : -amount;
    }
    if (type === 'Personal') {
      p.personal += personalOwed_(owner_(r), r[C.PAID_BY], amount);
      const slot = { KK: 'kOnK', KV: 'kOnV', VV: 'vOnV', VK: 'vOnK' }[owner_(r) + r[C.PAID_BY]];
      if (slot) p[slot] += amount;
      if (owner_(r) === 'V') p.pv += amount;
      if (owner_(r) === 'K') p.pk += amount;
    }
  });
  p.hasBudget = budget !== null;
  p.start = budget || 0;
  Object.keys(p).forEach((k) => { if (typeof p[k] === 'number') p[k] = round2_(p[k]); });
  return p;
}

// Each person's personal budget for the month: the latest "Personal budget" row in the tab sets it,
// and every Personal expense for that person in the month counts, whoever's card paid.
function personalBudgets_(rows, key) {
  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  const data = rows.filter((r) => !isEmptyRow_(r));
  const out = { V: null, K: null };
  data.forEach((r) => {
    const who = owner_(r);
    if (normalizeType_(r[C.TYPE]) !== 'Personal budget' || (who !== 'V' && who !== 'K')) return;
    const date = formatDate_(r[C.DATE], tz);
    if (!out[who] || date >= out[who].setOn) {
      out[who] = { month: key, since: key + '-01', setOn: date, budget: toNumber_(r[C.AMOUNT]), spent: 0 };
    }
  });
  data.forEach((r) => {
    if (normalizeType_(r[C.TYPE]) !== 'Personal') return;
    const b = out[owner_(r)];
    if (b) b.spent += toNumber_(r[C.AMOUNT]);
  });
  ['V', 'K'].forEach((who) => {
    const b = out[who];
    if (!b) return;
    b.spent = round2_(b.spent);
    b.remaining = round2_(b.budget - b.spent);
  });
  return out;
}

// A one-person expense paid on the other's card is owed back in full. Positive = K owes V.
function personalOwed_(owner, card, amount) {
  if (owner === 'K' && card === 'V') return amount;
  if (owner === 'V' && card === 'K') return -amount;
  return 0;
}

function settleText_(vShare, kShare) {
  if (vShare <= -0.01) return 'V owes K $' + (-vShare).toFixed(2);
  if (kShare <= -0.01) return 'K owes V $' + (-kShare).toFixed(2);
  return 'Even';
}

// Share = what each paid minus half of the total (same as the monthly blocks in the other tabs).
function shares_(p) {
  const split = round2_(p.spent / 2);
  // Fixed: shared bills split 50/50; a person's own bill on the other's card is owed in full.
  const fSplit = round2_(p.fShared / 2);
  const s = {
    split: split,
    vShare: round2_(p.v - split),
    kShare: round2_(p.k - split),
    fSplit: fSplit,
    fvShare: round2_(p.fsv - fSplit + p.fixedOwed),
    fkShare: round2_(p.fsk - fSplit - p.fixedOwed),
    // Each person's fixed bills: half the shared ones plus their own.
    fixedV: round2_(fSplit + p.fOwnV),
    fixedK: round2_(fSplit + p.fOwnK),
  };
  const pn = round2_(p.personal || 0);
  s.settle = settleText_(s.vShare, s.kShare);
  s.fixedSettle = settleText_(s.fvShare, s.fkShare);
  s.personalSettle = settleText_(pn, -pn);
  s.overall = settleText_(round2_(s.vShare + s.fvShare + pn), round2_(s.kShare + s.fkShare - pn));
  // What is left after settlements (positive = K owes V).
  s.owedNet = round2_(s.vShare + s.fvShare + pn);
  s.remaining = round2_(s.owedNet - (p.settledNet || 0));
  s.stillOwed = settleText_(s.remaining, -s.remaining);
  s.settledText = !p.settled ? 'None yet'
    : p.settledNet > 0 ? 'K paid V $' + p.settledNet.toFixed(2)
    : p.settledNet < 0 ? 'V paid K $' + (-p.settledNet).toFixed(2) : '$' + p.settled.toFixed(2) + ' both ways';
  s.status = Math.abs(s.remaining) < 0.01 ? (p.settled ? 'Cleared' : 'Even') : 'Open: ' + s.stillOwed;
  return s;
}

// Columns K onward of a month tab: who owes whom (with settlements and status), fixed bills,
// personal expenses, and the month's budgets with what is left, plus a color legend.
function writeMonthSummary_(sheet, key, p, pb) {
  const WIDTH = 5; // K:O
  const s = shares_(p);
  const budget = round2_(p.start + p.added);
  const line = (...cells) => cells.concat(new Array(WIDTH - cells.length).fill(''));
  const blank = () => line();
  const pbLine = (who) => {
    const b = pb[who];
    return b ? line(who + ' personal', b.budget, b.spent, b.remaining) : line(who + ' personal', 'not set', who === 'V' ? p.pv : p.pk, '');
  };
  const out = [
    line('Who owes whom', '', '', monthLabel_(key)),                                  // 1
    line('V paid', 'K paid', 'Total'),                                                // 2
    line(p.v, p.k, p.spent),                                                          // 3
    line("V's share", "K's share", 'Equal split'),                                    // 4
    line(s.vShare, s.kShare, s.split),                                                // 5
    line('Settle up (joint)', s.settle),                                              // 6
    line("Personal on other's card", s.personalSettle),                               // 7
    line('Overall (joint + fixed + personal)', s.overall),                            // 8
    line('Settled (Splitwise, cash...)', s.settledText),                              // 9
    line('Status', s.status),                                                         // 10
    blank(),                                                                          // 11
    line('Fixed bills'),                                                              // 12
    line('V paid', 'K paid', 'Total'),                                                // 13
    line(p.fv, p.fk, p.fixed),                                                        // 14
    line('Shared (half each)', "V's own", "K's own", "V's fixed", "K's fixed"),       // 15
    line(p.fShared, p.fOwnV, p.fOwnK, s.fixedV, s.fixedK),                            // 16
    line('Settle up', s.fixedSettle),                                                 // 17
    blank(),                                                                          // 18
    line('Personal expenses'),                                                        // 19
    line('', 'Own card', "Other's card (owed in full)"),                              // 20
    line("K's expenses", p.kOnK, p.kOnV),                                             // 21
    line("V's expenses", p.vOnV, p.vOnK),                                             // 22
    line('Settle up', s.personalSettle),                                              // 23
    line('Overall (joint + fixed + personal)', s.overall),                            // 24
    blank(),                                                                          // 25
    line('Budgets for ' + monthLabel_(key)),                                          // 26
    line('Budget for', 'Budget', 'Spent', 'Left'),                                    // 27
    p.hasBudget ? line('Joint', budget, p.spent, round2_(budget - p.spent)) : line('Joint', 'not set', p.spent, ''), // 28
    pbLine('V'),                                                                      // 29
    pbLine('K'),                                                                      // 30
    blank(),                                                                          // 31
    line('Colors'),                                                                   // 32
    line('Joint', 'no color'),                                                        // 33
    line('Personal V', 'expense for V'),                                              // 34
    line('Personal K', 'expense for K'),                                              // 35
    line('Fixed V', "V's card"),                                                      // 36
    line('Fixed K', "K's card"),                                                      // 37
    line('Settlement', 'paid back'),                                                  // 38
  ];
  // Clear the whole area first: rows deleted near the top can shift old values and colors into it.
  const area = sheet.getRange(1, SUMMARY_COL, Math.max(sheet.getLastRow(), out.length), WIDTH);
  area.clearContent();
  area.clearFormat();
  sheet.getRange(1, SUMMARY_COL, out.length, WIDTH).setValues(out);

  const cell = (row, col, rows, cols) => sheet.getRange(row, SUMMARY_COL + col, rows || 1, cols || 1);
  [3, 5, 14].forEach((row) => cell(row, 0, 1, 3).setNumberFormat(MONEY));
  cell(16, 0, 1, 5).setNumberFormat(MONEY);
  cell(21, 1, 2, 2).setNumberFormat(MONEY);
  cell(28, 1, 3, 3).setNumberFormat(MONEY);
  [1, 12, 19, 26, 32].forEach((row) => cell(row, 0).setFontWeight('bold').setFontSize(12));
  [2, 4, 13, 20].forEach((row) => cell(row, 0, 1, 3).setFontWeight('bold').setBackground('#f3f4f6'));
  cell(15, 0, 1, 5).setFontWeight('bold').setBackground('#f3f4f6');
  cell(27, 0, 1, 4).setFontWeight('bold').setBackground('#f3f4f6');
  cell(28, 3, 3, 1).setFontWeight('bold');
  cell(21, 0, 2, 1).setFontWeight('bold');
  [6, 7, 8, 9, 10, 17, 23, 24].forEach((row) => cell(row, 0, 1, 2).setFontWeight('bold'));
  // Status: green once cleared, amber while something is still owed.
  if (s.status === 'Cleared') cell(10, 0, 1, 2).setBackground(COLORS.settled);
  else if (s.status !== 'Even') cell(10, 0, 1, 2).setBackground(COLORS.open);
  cell(34, 0).setBackground(COLORS.personalV);
  cell(35, 0).setBackground(COLORS.personalK);
  cell(36, 0).setBackground(COLORS.fixedV);
  cell(37, 0).setBackground(COLORS.fixedK);
  cell(38, 0).setBackground(COLORS.settled);
}

// The "Sirikh" tab: one row per month, newest first. Settled and Status show whether the month's
// owing has been paid back; the last column is what was left of the month's joint budget.
function writeOverview_(months) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(OVERVIEW_TAB) || ss.insertSheet(OVERVIEW_TAB, 0);
  const HEAD = ['Month', 'Tab', 'Joint budget', 'Joint spent', 'Fixed bills', 'V fixed', 'K fixed', 'V personal spent', 'K personal spent',
    'V personal left', 'K personal left', 'Joint settle', 'Fixed settle', 'Personal settle', 'Overall settle',
    'Settled', 'Status', 'Joint left'];
  const W = HEAD.length;
  const line = (...cells) => cells.concat(new Array(W - cells.length).fill(''));
  const out = [
    line('Sirikh: month by month'),
    line('Each month has its own tab. Budgets reset on the 1st. Status turns green (Cleared) once the month is settled. This tab is rebuilt on every save; do not type here.'),
    line(),
    HEAD,
  ];
  const statuses = [];
  months.slice().reverse().forEach((m) => {
    const p = m.p;
    const s = shares_(p);
    const budget = round2_(p.start + p.added);
    const left = (b) => (b ? b.remaining : 'not set');
    statuses.push(s.status);
    out.push([monthLabel_(m.key), tabName_(m.key), p.hasBudget ? budget : 'not set', p.spent, p.fixed, s.fixedV, s.fixedK, p.pv, p.pk,
      left(m.pb.V), left(m.pb.K), s.settle, s.fixedSettle, s.personalSettle, s.overall, s.settledText, s.status,
      p.hasBudget ? round2_(budget - p.spent) : 'not set']);
  });
  const area = sheet.getRange(1, 1, Math.max(sheet.getLastRow(), out.length, 4), W);
  area.clearContent();
  area.clearFormat();
  sheet.getRange(1, 1, out.length, W).setValues(out);
  sheet.getRange(1, 1).setFontWeight('bold').setFontSize(14);
  sheet.getRange(4, 1, 1, W).setFontWeight('bold').setBackground('#f3f4f6');
  sheet.setFrozenRows(4);
  if (months.length) {
    sheet.getRange(5, 3, months.length, 9).setNumberFormat(MONEY);
    sheet.getRange(5, W, months.length, 1).setNumberFormat(MONEY).setFontWeight('bold');
    statuses.forEach((st, i) => {
      if (st === 'Cleared') sheet.getRange(5 + i, W - 1).setBackground(COLORS.settled).setFontWeight('bold');
      else if (st !== 'Even') sheet.getRange(5 + i, W - 1).setBackground(COLORS.open);
    });
  }
}

// Recalculates the touched months (and writes their tables), rebuilds the overview, and returns
// what the app shows for the current month.
// The monthly tabs' totals from the last state_ call, reused by the Funds tab.
let MONTHS_CACHE = [];

function state_(current, touched) {
  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  const months = monthTabs_().map((t) => {
    const hit = touched.indexOf(t.key) !== -1 || t.upgraded;
    const rows = hit ? recompute_(t.sheet) : readRows_(t.sheet);
    const p = period_(rows, t.key);
    const pb = personalBudgets_(rows, t.key);
    if (hit) writeMonthSummary_(t.sheet, t.key, p, pb);
    return { key: t.key, rows: rows, p: p, pb: pb };
  });
  writeOverview_(months);
  MONTHS_CACHE = months;
  const cur = months.find((m) => m.key === current) || { key: current, rows: [], p: emptyPeriod_(current), pb: { V: null, K: null } };
  const prev = months.find((m) => m.key === previousKey_(current));

  // Latest entries across every month: newest date first, then most recently added.
  const all = [];
  months.forEach((m) => m.rows.forEach((r, i) => { if (!isEmptyRow_(r)) all.push({ r: r, key: m.key, i: i, d: formatDate_(r[C.DATE], tz) }); }));
  all.sort((a, b) => (a.d !== b.d ? (a.d < b.d ? 1 : -1) : a.key !== b.key ? (a.key < b.key ? 1 : -1) : b.i - a.i));

  MAIN_LIST_CACHE = all.map((x) => mainItem_(x));
  const recentBy = {};
  const recentTotal = { All: MAIN_LIST_CACHE.length };
  Object.keys(RECENT_GROUPS).forEach((g) => {
    const rows = MAIN_LIST_CACHE.filter((e) => RECENT_GROUPS[g].indexOf(e.type) !== -1);
    recentBy[g] = rows.slice(0, RECENT_COUNT);
    recentTotal[g] = rows.length;
  });

  const budget = round2_(cur.p.start + cur.p.added);
  return {
    ok: true,
    version: BACKEND_VERSION,
    month: current,
    balance: cur.p.hasBudget ? round2_(budget - cur.p.spent) : 0,
    hasBalance: cur.p.hasBudget,
    period: cur.p,
    personalBudgets: cur.pb,
    // Months with money still owed, newest first (the settle form offers these).
    unsettled: months.slice().reverse().map((m) => ({ month: m.key, label: monthLabel_(m.key), remaining: shares_(m.p).remaining }))
      .filter((u) => Math.abs(u.remaining) >= 0.01).slice(0, 12),
    // Start-of-month prompt: the joint budget, and personal budgets that existed last month.
    needsBudget: {
      joint: !cur.p.hasBudget,
      V: !cur.pb.V && !!(prev && prev.pb.V),
      K: !cur.pb.K && !!(prev && prev.pb.K),
    },
    recent: MAIN_LIST_CACHE.slice(0, RECENT_COUNT),
    recentBy: recentBy,
    recentTotal: recentTotal,
  };
}

// One month-tab row as the app's Recent list shows it.
function mainItem_(x) {
  const type = normalizeType_(x.r[C.TYPE]);
  return {
    id: String(x.r[C.ID]),
    date: x.d,
    category: String(x.r[C.CATEGORY]),
    amount: toNumber_(x.r[C.AMOUNT]),
    paidBy: String(x.r[C.PAID_BY]),
    notes: String(x.r[C.NOTES]),
    type: type,
    balance: x.r[C.BALANCE],
    expenseFor: type === 'Personal' || type === 'Personal budget' ? owner_(x.r) : type === 'Fixed' ? fixedOwner_(x.r) : '',
    tag: rowTag_(x.r, type),
  };
}

// Older entries for a Recent list: body.table ('main', 'car' or 'funds'), body.group (main only:
// All, Joint, Fixed or Personal), body.offset and body.limit (up to LIST_MAX).
function list_(body) {
  const table = body.table === 'car' || body.table === 'funds' ? body.table : 'main';
  const group = RECENT_GROUPS[body.group] ? body.group : 'All';
  let rows = table === 'car' ? CAR_LIST_CACHE : table === 'funds' ? FUNDS_LIST_CACHE : MAIN_LIST_CACHE;
  if (table === 'main' && group !== 'All') rows = rows.filter((e) => RECENT_GROUPS[group].indexOf(e.type) !== -1);
  const offset = Math.max(0, Math.floor(Number(body.offset) || 0));
  const limit = Math.min(LIST_MAX, Math.max(1, Math.floor(Number(body.limit) || 25)));
  return { table: table, group: group, offset: offset, total: rows.length, rows: rows.slice(offset, offset + limit) };
}

// Spending across every month tab and the Sonata tab, summed by month, group, tag and person, for
// the app's charts (it filters by year and month itself). Refunds count as negative spending;
// budgets and settlements are not spending. Funds rows (income, 401(K), investments, Fam, loans,
// savings used) come separately, by month, kind and person.
//   spend: [month 'YYYY-MM', group (Joint, Fixed, Personal, Sonata), tag, who (V, K, Both), amount]
//   funds: [month, kind, who, amount]
const ANALYTICS_FUND_KINDS = ['Income', '401(K)', 'Investment', 'Fam', 'Loan payment', 'Use savings'];
function analytics_(months, carSheet) {
  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  const spend = {};
  const add = (bucket, key, parts, amount) => {
    if (!bucket[key]) bucket[key] = parts.concat(0);
    bucket[key][parts.length] += amount;
  };
  months.forEach((m) => m.rows.forEach((r) => {
    if (isEmptyRow_(r)) return;
    const type = normalizeType_(r[C.TYPE]);
    if (type !== 'Joint' && type !== 'Fixed' && type !== 'Personal') return;
    const who = type === 'Personal' ? owner_(r) : type === 'Fixed' ? fixedOwner_(r) : 'Both';
    const tag = rowTag_(r, type) || 'Other';
    add(spend, [m.key, type, tag, who].join('|'), [m.key, type, tag, who], toNumber_(r[C.AMOUNT]));
  }));
  readCarRows_(carSheet).forEach((r) => {
    if (isEmptyCarRow_(r) || String(r[K.CATEGORY]).trim() === 'Settlement') return;
    const d = formatDate_(r[K.DATE], tz);
    if (!/^\d{4}-\d{2}/.test(d)) return;
    const owner = carOwner_(r);
    const who = owner === 'V' || owner === 'K' ? owner : 'Both';
    const tag = String(r[K.CATEGORY]).trim() || 'Misc';
    add(spend, [d.slice(0, 7), 'Sonata', tag, who].join('|'), [d.slice(0, 7), 'Sonata', tag, who], toNumber_(r[K.AMOUNT]));
  });
  const funds = {};
  readFundsRows_(fundsSheet_(false)).forEach((r) => {
    const kind = fundKind_(r[F.KIND]);
    const d = formatDate_(r[F.DATE], tz);
    if (ANALYTICS_FUND_KINDS.indexOf(kind) === -1 || !/^\d{4}-\d{2}/.test(d)) return;
    const who = String(r[F.PERSON] || 'Both');
    add(funds, [d.slice(0, 7), kind, who].join('|'), [d.slice(0, 7), kind, who], toNumber_(r[F.AMOUNT]));
  });
  const done = (bucket) => Object.keys(bucket).sort().map((k) => {
    const row = bucket[k];
    row[row.length - 1] = round2_(row[row.length - 1]);
    return row;
  }).filter((row) => row[row.length - 1] !== 0);
  return { spend: done(spend), funds: done(funds), tags: TAGS.concat(customTags_(months)), customTags: customTags_(months), fixedTags: FIXED_TAGS, carTags: CAR_CATEGORIES };
}

function normalizeType_(v) {
  const s = String(v).trim().toLowerCase();
  for (let i = 0; i < TYPES.length; i++) if (TYPES[i].toLowerCase() === s) return TYPES[i];
  return 'Joint';
}

// Accepts numbers and text such as "$1,234.50", "-$7.00" or "10,72".
function toNumber_(v) {
  if (typeof v === 'number') return v;
  let s = String(v).replace(/[$\s]/g, '');
  s = /^-?\d+,\d{1,2}$/.test(s) ? s.replace(',', '.') : s.replace(/,/g, '');
  const n = Number(s);
  return isFinite(n) ? n : 0;
}

function round2_(n) {
  return Math.round(n * 100) / 100;
}

function formatDate_(v, tz) {
  return v instanceof Date ? Utilities.formatDate(v, tz, 'yyyy-MM-dd') : String(v);
}

// ======================================================================================
// Sonata: car expenses and fuel tracking, kept in its own tab and table.
//
//   Date | Category | Station / Vendor | Amount ($) | Card Used | Odometer | Miles Driven |
//   Range Left | Effective Range | Gallons | Price/Gal | MPG | Cost/Mile | Notes | ID |
//   Expense For | Fill | Missed Before
//
// Expense For says whose turn or cost it is: V, K or Joint (blank = the card owner's own turn).
// V and K take turns (V three tanks, K the fourth), so their own turns create nothing owed.
//   Joint (a trip fill-up, a shared repair): split 50/50, the other person owes half to the card owner.
//   A turn paid on the other person's card: owed back in full.
//   Settlement rows (Category "Settlement", green): money paid back; Card Used = who paid. They are
//   not car costs: left out of spending, categories and fuel math, they only reduce what is owed.
//
// Fuel math (Fuel rows in odometer order). Fill is Full (default; stopping at the pump click counts)
// or Partial. Missed Before = Yes when a fill-up before this one was never logged.
//   Miles Driven     = this odometer - previous fill-up's odometer
//   Gallons          = as entered, or Amount / Price per gallon when left blank
//   Full-to-full stretch: from one Full fill to the next Full fill. The tank is full at both ends,
//                    so every gallon added in between (partials included) is exactly what those
//                    miles burned.
//   MPG              = stretch miles / stretch gallons     (shown on the Full fill that closes it)
//   Cost/Mile        = stretch amount / stretch miles      (same row)
//   Effective Range  = Miles Driven + Range Left, only when the previous fill was Full
//   Rolling MPG      = miles over the last 5 fills / gallons of those fills (works with any fills)
//   Overall MPG      = all stretch miles / all stretch gallons
// A stretch gets no MPG if it has a missed fill-up or a fill with unknown gallons. A fill covering
// more than 1.6x a typical tank is treated as Missed Before even if not marked.
// Columns T onward hold spending, fuel stats, spend by category, chart data and charts.
// The script overwrites that area.
// ======================================================================================

const CAR_TAB = 'Sonata';
const CAR_HEADERS = ['Date', 'Category', 'Station / Vendor', 'Amount ($)', 'Card Used', 'Odometer', 'Miles Driven',
  'Range Left', 'Effective Range', 'Gallons', 'Price/Gal', 'MPG', 'Cost/Mile', 'Notes', 'ID', 'Expense For',
  'Fill', 'Missed Before'];
const K = { DATE: 0, CATEGORY: 1, VENDOR: 2, AMOUNT: 3, PAID_BY: 4, ODO: 5, MILES: 6, RANGE: 7, EFF: 8,
  GAL: 9, PPG: 10, MPG: 11, CPM: 12, NOTES: 13, ID: 14, FOR: 15, FILL: 16, MISSED: 17 };
const CAR_CATEGORIES = ['Fuel', 'Servicing', 'Repairs', 'Mods', 'Insurance', 'Registration/Tax',
  'Tolls/Parking', 'Car wash', 'Misc'];
const CAR_SUMMARY_COL = 20; // column T
const CAR_DATA_ROW = 40;    // monthly and fuel-log blocks used by the charts start here
const CAR_CHART_ROWS = 300; // rows the charts read (room for years of fill-ups)
const CAR_CHARTS_VERSION = '2';
const TANK_GALLONS = 13.2;  // 2026 Sonata Hybrid
const ROLLING_FILLS = 5;
const OLD_CAR_TAB = 'HyundaiSonata2026';

function getCarSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(CAR_TAB);
  if (!sheet) sheet = ss.insertSheet(CAR_TAB);
  const isEmpty = readCarRows_(sheet).every(isEmptyCarRow_);
  const header = sheet.getRange(1, 1, 1, CAR_HEADERS.length);
  const current = header.getValues()[0];
  if (current.join('|') !== CAR_HEADERS.join('|')) {
    // Earlier versions kept their summary from column Q, where Fill and Missed Before now go.
    if (current[K.FILL] !== 'Fill') {
      const lastCol = sheet.getLastColumn();
      if (lastCol > K.FOR + 1) {
        sheet.getRange(1, K.FOR + 2, Math.max(sheet.getLastRow(), 1), lastCol - K.FOR - 1).clearContent().clearFormat();
      }
      sheet.getCharts().forEach((c) => sheet.removeChart(c));
    }
    header.setValues([CAR_HEADERS]).setFontWeight('bold').setBackground('#f3f4f6');
    sheet.setFrozenRows(1);
    sheet.hideColumns(K.ID + 1);
  }
  const props = PropertiesService.getScriptProperties();
  if (isEmpty && !props.getProperty('SONATA_IMPORTED')) {
    importOldFuelLog_(sheet);
    props.setProperty('SONATA_IMPORTED', new Date().toISOString());
  }
  return sheet;
}

// Once, while the Sonata tab has no entries: copies the fuel log from the HyundaiSonata2026 tab.
// HyundaiSonata2026 is only read, never changed
// (the block whose header row reads Date | Category | Amount ($) | Paid by | Miles before refueling ...).
function importOldFuelLog_(sheet) {
  const old = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(OLD_CAR_TAB);
  if (!old || old.getLastRow() < 2) return;
  const all = old.getRange(1, 1, old.getLastRow(), Math.max(old.getLastColumn(), 1)).getValues();
  let top = -1;
  let left = -1;
  for (let r = 0; r < Math.min(all.length, 15) && top === -1; r++) {
    for (let c = 0; c + 4 < all[r].length; c++) {
      if (String(all[r][c]).trim() === 'Date' && /^miles before refuel/i.test(String(all[r][c + 4]).trim())) {
        top = r;
        left = c;
        break;
      }
    }
  }
  if (top === -1) return;
  const num = (v) => (v === '' || v === null || isNaN(toNumber_(v)) ? '' : toNumber_(v));
  const rows = [];
  all.slice(top + 1).forEach((r) => {
    const cells = r.slice(left, left + 11);
    const date = cells[0];
    const amount = cells[2];
    if (date === '' || amount === '' || toNumber_(amount) === 0) return;
    const paidBy = String(cells[3]).trim().toUpperCase();
    rows.push([date, 'Fuel', String(cells[1]).trim(), toNumber_(amount), paidBy === 'K' ? 'K' : paidBy === 'V' ? 'V' : '',
      num(cells[4]), '', num(cells[6]), '', num(cells[8]), num(cells[9]), '', '', String(cells[10]).trim(),
      Utilities.getUuid(), '', 'Full', '']);
  });
  if (rows.length) sheet.getRange(2, 1, rows.length, CAR_HEADERS.length).setValues(rows);
}

function validateCar_(b) {
  const date = String(b.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Invalid date.');
  const isSettlement = b.category === 'Settlement';
  const category = CAR_CATEGORIES.indexOf(b.category) !== -1 || isSettlement ? b.category : '';
  if (!category) throw new Error('Pick a car category.');
  const paidBy = String(b.paidBy || '');
  if (paidBy !== 'V' && paidBy !== 'K') throw new Error('Card used must be V or K.');
  // A settlement goes from the payer to the other person.
  const expenseFor = isSettlement ? (paidBy === 'V' ? 'K' : 'V')
    : b.expenseFor === undefined || b.expenseFor === '' ? paidBy : String(b.expenseFor);
  if (['V', 'K', 'Joint'].indexOf(expenseFor) === -1) throw new Error('Expense for must be V, K or Joint.');
  if (isSettlement && !(Number(b.amount) > 0)) throw new Error('A settlement must be more than 0.');
  const method = SETTLE_METHODS.indexOf(b.method) !== -1 ? b.method : 'Splitwise';
  const opt = (v, name) => {
    if (v === '' || v === null || v === undefined) return '';
    const n = Number(v);
    if (!isFinite(n) || n < 0) throw new Error('Invalid ' + name + '.');
    return n;
  };
  const fuel = category === 'Fuel';
  const gallons = opt(b.gallons, 'gallons');
  if (fuel && gallons !== '' && gallons > TANK_GALLONS + 0.2) {
    throw new Error('Gallons can not be more than the tank holds (' + TANK_GALLONS + ' gal).');
  }
  const ppg = opt(b.pricePerGallon, 'price per gallon');
  let amount = b.amount === '' || b.amount === undefined || b.amount === null ? NaN : Number(b.amount);
  if (!isFinite(amount) && gallons !== '' && ppg !== '') amount = gallons * ppg;
  if (!isFinite(amount) || amount === 0) throw new Error('Invalid amount.');
  return {
    id: String(b.id || Utilities.getUuid()).slice(0, 64),
    date: date,
    category: category,
    vendor: isSettlement ? 'Settled via ' + method : safeText_(String(b.vendor || '').trim().slice(0, 200)),
    amount: round2_(amount),
    paidBy: paidBy,
    odometer: fuel ? opt(b.odometer, 'odometer') : '',
    rangeLeft: fuel ? opt(b.rangeLeft, 'range left') : '',
    gallons: fuel ? gallons : '',
    pricePerGallon: fuel ? ppg : '',
    notes: safeText_(String(b.notes || '').trim().slice(0, 500)),
    expenseFor: expenseFor,
    fill: fuel ? (b.fill === 'Partial' ? 'Partial' : 'Full') : '',
    missedBefore: fuel && b.missedBefore ? 'Yes' : '',
  };
}

function readCarRows_(sheet) {
  const last = sheet.getLastRow();
  if (last < 2) return [];
  return sheet.getRange(2, 1, last - 1, CAR_HEADERS.length).getValues();
}

function isEmptyCarRow_(r) {
  return r[K.DATE] === '' && r[K.CATEGORY] === '' && r[K.AMOUNT] === '';
}

function carIds_(sheet) {
  return readCarRows_(sheet).map((r) => String(r[K.ID]));
}

function addCar_(sheet, e) {
  if (carIds_(sheet).indexOf(e.id) !== -1) return; // retried from the offline queue
  const rows = readCarRows_(sheet);
  let row = 2;
  for (let i = rows.length - 1; i >= 0; i--) if (!isEmptyCarRow_(rows[i])) { row = i + 3; break; }
  sheet.getRange(row, 1, 1, CAR_HEADERS.length).setValues([carRow_(e)]);
}

const carRow_ = (e) => [e.date, e.category, e.vendor, e.amount, e.paidBy, e.odometer, '', e.rangeLeft, '', e.gallons,
  e.pricePerGallon, '', '', e.notes, e.id, e.expenseFor, e.fill, e.missedBefore];

// An edited car entry, rewritten in its row (miles, MPG and the rest are recalculated after).
function updateCar_(sheet, e) {
  const i = carIds_(sheet).lastIndexOf(e.id);
  if (i === -1) return addCar_(sheet, e);
  sheet.getRange(i + 2, 1, 1, CAR_HEADERS.length).setValues([carRow_(e)]);
}

function deleteCar_(sheet, id) {
  if (!id) throw new Error('Missing id.');
  const i = carIds_(sheet).lastIndexOf(id);
  if (i !== -1) sheet.deleteRow(i + 2);
}

const blankIfNot_ = (v) => (v === '' || v === null || v === undefined ? '' : v);
const isPartial_ = (r) => String(r[K.FILL]).trim().toLowerCase() === 'partial';
const isCarSettlement_ = (r) => String(r[K.CATEGORY]) === 'Settlement';
const isMarkedMissed_ = (r) => /^(y|yes|true|x|1)$/i.test(String(r[K.MISSED]).trim());

// Gallons as entered, or worked out from amount / price per gallon. null when unknown.
function gallonsOf_(r) {
  const g = r[K.GAL] === '' ? 0 : toNumber_(r[K.GAL]);
  if (g > 0) return g;
  const ppg = r[K.PPG] === '' ? 0 : toNumber_(r[K.PPG]);
  const amount = toNumber_(r[K.AMOUNT]);
  return ppg > 0 && amount > 0 ? amount / ppg : null;
}

// Works out the fuel numbers for every Fuel row. See the header comment for the formulas.
function fuelMath_(rows) {
  const fuel = [];
  rows.forEach((r, i) => {
    if (!isEmptyCarRow_(r) && r[K.CATEGORY] === 'Fuel' && r[K.ODO] !== '' && isFinite(toNumber_(r[K.ODO]))) fuel.push(i);
  });
  fuel.sort((a, b) => toNumber_(rows[a][K.ODO]) - toNumber_(rows[b][K.ODO]));
  const odo = fuel.map((i) => toNumber_(rows[i][K.ODO]));
  const miles = fuel.map((i, n) => (n === 0 ? 0 : round2_(odo[n] - odo[n - 1])));
  const sorted = miles.filter((m) => m > 0).sort((a, b) => a - b);
  const typical = sorted.length >= 3 ? sorted[Math.floor(sorted.length / 2)] : 0;
  const broken = fuel.map((i, n) => n > 0 && (isMarkedMissed_(rows[i]) || (typical > 0 && miles[n] > typical * 1.6)));

  const perRow = rows.map(() => ({ miles: '', eff: '', mpg: '', cpm: '', rolling: '', autoMissed: false }));
  const stretches = [];
  let start = null;
  let gal = 0;
  let amt = 0;
  let known = true;
  let fills = 0;
  fuel.forEach((idx, n) => {
    const r = rows[idx];
    const full = !isPartial_(r);
    const out = perRow[idx];
    if (n > 0) out.miles = miles[n];
    if (broken[n] && !isMarkedMissed_(r)) out.autoMissed = true;
    if (n > 0 && !broken[n] && !isPartial_(rows[fuel[n - 1]]) && r[K.RANGE] !== '') {
      out.eff = round2_(miles[n] + toNumber_(r[K.RANGE]));
    }
    // Rolling MPG over the last ROLLING_FILLS fills (any kind of fill).
    if (n >= ROLLING_FILLS) {
      let g = 0;
      let ok = true;
      for (let j = n - ROLLING_FILLS + 1; j <= n; j++) {
        const gj = gallonsOf_(rows[fuel[j]]);
        if (gj === null || broken[j]) { ok = false; break; }
        g += gj;
      }
      if (ok && g > 0) out.rolling = round2_((odo[n] - odo[n - ROLLING_FILLS]) / g);
    }
    if (n === 0 || broken[n]) {
      start = full ? n : null;
      gal = 0; amt = 0; known = true; fills = 0;
      return;
    }
    if (start === null) {
      if (full) { start = n; gal = 0; amt = 0; known = true; fills = 0; }
      return;
    }
    const g = gallonsOf_(r);
    if (g === null) known = false; else gal += g;
    amt += toNumber_(r[K.AMOUNT]);
    fills++;
    if (!full) return;
    const stretchMiles = round2_(odo[n] - odo[start]);
    if (known && gal > 0 && stretchMiles > 0) {
      out.mpg = round2_(stretchMiles / gal);
      out.cpm = Math.round((amt / stretchMiles) * 1000) / 1000;
      stretches.push({ row: idx, odo: odo[n], miles: stretchMiles, gallons: gal, amount: amt, fills: fills, mpg: out.mpg, cpm: out.cpm });
    }
    start = n; gal = 0; amt = 0; known = true; fills = 0;
  });
  const open = start === null ? null : { startOdo: odo[start], gallons: round2_(gal), amount: round2_(amt), known: known };
  return { fuel: fuel, odo: odo, perRow: perRow, stretches: stretches, open: open, typical: typical };
}

// Fills Miles Driven, Effective Range, MPG and Cost/Mile; writes only if something changed.
function recomputeCar_(sheet) {
  const rows = readCarRows_(sheet);
  if (!rows.length) return { rows: rows, math: fuelMath_(rows) };
  const math = fuelMath_(rows);
  let changed = false;
  const block = rows.map((r, i) => {
    const c = math.perRow[i];
    const out = [c.miles, blankIfNot_(r[K.RANGE]), c.eff, blankIfNot_(r[K.GAL]), blankIfNot_(r[K.PPG]), c.mpg, c.cpm];
    if (r[K.MILES] !== c.miles || r[K.EFF] !== c.eff || r[K.MPG] !== c.mpg || r[K.CPM] !== c.cpm) changed = true;
    r[K.MILES] = c.miles;
    r[K.EFF] = c.eff;
    r[K.MPG] = c.mpg;
    r[K.CPM] = c.cpm;
    return out;
  });
  if (changed) sheet.getRange(2, K.MILES + 1, rows.length, 7).setValues(block);
  rows.forEach((r, i) => {
    if (isCarSettlement_(r)) sheet.getRange(i + 2, 1, 1, CAR_HEADERS.length).setBackground(COLORS.settled);
  });
  sheet.getRange(2, K.AMOUNT + 1, rows.length, 1).setNumberFormat(MONEY);
  sheet.getRange(2, K.PPG + 1, rows.length, 1).setNumberFormat('$0.000');
  sheet.getRange(2, K.MPG + 1, rows.length, 1).setNumberFormat('0.00');
  sheet.getRange(2, K.CPM + 1, rows.length, 1).setNumberFormat('$0.000');
  sheet.getRange(2, K.DATE + 1, rows.length, 1).setNumberFormat('yyyy-mm-dd');
  return { rows: rows, math: math };
}

// Whose turn or cost: V, K or Joint. Blank means the card owner's own turn.
// ("Both", written by an earlier version, means Joint.)
function carOwner_(r) {
  const f = String(r[K.FOR] || '').trim().toUpperCase();
  if (f === 'V' || f === 'K') return f;
  if (f === 'JOINT' || f === 'BOTH') return 'Joint';
  return String(r[K.PAID_BY]);
}

// What one car cost leaves owed. Positive = K owes V.
function carOwed_(owner, card, amount) {
  if (owner === 'Joint') return card === 'V' ? amount / 2 : card === 'K' ? -amount / 2 : 0;
  return personalOwed_(owner, card, amount);
}

function carStats_(rows, math) {
  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  const data = rows.filter((r) => !isEmptyCarRow_(r));
  const s = {
    v: 0, k: 0, total: 0, owed: 0, settled: 0, settledNet: 0, turns: { V: 0, K: 0, Joint: 0 },
    fills: 0, partials: 0, missed: 0, gallons: 0, fuelSpend: 0, avgPpg: 0,
    mpg: 0, rollingMpg: 0, bestMpg: 0, worstMpg: 0, avgMilesPerTank: 0, avgEffRange: 0,
    fuelCpm: 0, totalCpm: 0, milesTracked: 0, lastOdometer: 0, tankGallons: TANK_GALLONS,
    lastFill: null, open: math.open, byCategory: {}, monthly: [], stretches: [], fills_log: [], recent: [],
  };
  const months = {};
  const monthOf = (r) => formatDate_(r[K.DATE], tz).slice(0, 7);
  let ppgSpend = 0, ppgGallons = 0;
  data.forEach((r) => {
    const amount = toNumber_(r[K.AMOUNT]);
    if (isCarSettlement_(r)) {
      s.settled += amount;
      s.settledNet += r[K.PAID_BY] === 'K' ? amount : -amount;
      return; // money paid back, not a car cost
    }
    s.total += amount;
    if (r[K.PAID_BY] === 'V') s.v += amount;
    if (r[K.PAID_BY] === 'K') s.k += amount;
    const owner = carOwner_(r);
    s.owed += carOwed_(owner, r[K.PAID_BY], amount);
    s.byCategory[r[K.CATEGORY]] = (s.byCategory[r[K.CATEGORY]] || 0) + amount;
    const month = monthOf(r);
    const m = months[month] || (months[month] = { month: month, fuel: 0, other: 0, total: 0, miles: 0, gallons: 0 });
    m.total += amount;
    if (r[K.CATEGORY] !== 'Fuel') { m.other += amount; return; }
    m.fuel += amount;
    s.fills++;
    s.fuelSpend += amount;
    if (s.turns[owner] !== undefined) s.turns[owner]++;
    if (isPartial_(r)) s.partials++;
    const g = gallonsOf_(r);
    if (g !== null) { s.gallons += g; ppgSpend += amount; ppgGallons += g; }
  });

  // Stretch-based numbers: exact, whatever mix of full and partial fills.
  let sMiles = 0, sGallons = 0, sAmount = 0, tankMiles = 0, tanks = 0, effSum = 0, effCount = 0;
  math.stretches.forEach((st) => {
    sMiles += st.miles; sGallons += st.gallons; sAmount += st.amount;
    if (st.fills === 1) { tankMiles += st.miles; tanks++; }
    const r = rows[st.row];
    const m = months[monthOf(r)];
    if (m) { m.miles += st.miles; m.gallons += st.gallons; }
    s.stretches.push({ date: formatDate_(r[K.DATE], tz), odo: st.odo, mpg: st.mpg, cpm: st.cpm, miles: st.miles,
      gallons: round2_(st.gallons), fills: st.fills });
  });
  math.fuel.forEach((idx) => {
    const r = rows[idx];
    const c = math.perRow[idx];
    if (c.eff !== '') { effSum += c.eff; effCount++; }
    if (isMarkedMissed_(r) || c.autoMissed) s.missed++;
    const g = gallonsOf_(r);
    const ppg = r[K.PPG] !== '' && toNumber_(r[K.PPG]) > 0 ? toNumber_(r[K.PPG]) : g ? toNumber_(r[K.AMOUNT]) / g : '';
    s.fills_log.push({ date: formatDate_(r[K.DATE], tz), odo: toNumber_(r[K.ODO]), rolling: c.rolling,
      ppg: ppg === '' ? '' : Math.round(ppg * 1000) / 1000, partial: isPartial_(r) });
  });
  const mpgs = math.stretches.map((st) => st.mpg);
  s.mpg = sGallons ? sMiles / sGallons : 0;
  s.fuelCpm = sMiles ? sAmount / sMiles : 0;
  s.bestMpg = mpgs.length ? Math.max.apply(null, mpgs) : 0;
  s.worstMpg = mpgs.length ? Math.min.apply(null, mpgs) : 0;
  s.avgMilesPerTank = tanks ? tankMiles / tanks : 0;
  s.avgEffRange = effCount ? effSum / effCount : 0;
  const rolling = s.fills_log.filter((f) => f.rolling !== '');
  s.rollingMpg = rolling.length ? rolling[rolling.length - 1].rolling : 0;
  s.avgPpg = ppgGallons ? ppgSpend / ppgGallons : 0;

  const odos = math.odo;
  s.lastOdometer = odos.length ? odos[odos.length - 1] : 0;
  s.milesTracked = odos.length > 1 ? odos[odos.length - 1] - odos[0] : 0;
  // Fuel bought at or before the first odometer reading drove miles before tracking started.
  const firstOdo = odos.length ? odos[0] : null;
  const firstFill = math.fuel.length ? rows[math.fuel[0]] : null;
  let before = 0;
  if (firstFill) {
    const firstDate = formatDate_(firstFill[K.DATE], tz);
    data.forEach((r) => {
      if (r[K.CATEGORY] !== 'Fuel') return;
      const o = r[K.ODO] === '' ? null : toNumber_(r[K.ODO]);
      if ((o !== null && o <= firstOdo) || (o === null && formatDate_(r[K.DATE], tz) <= firstDate)) before += toNumber_(r[K.AMOUNT]);
    });
  }
  s.totalCpm = s.milesTracked ? (s.total - before) / s.milesTracked : 0;

  if (math.fuel.length) {
    const lastIdx = math.fuel[math.fuel.length - 1];
    const r = rows[lastIdx];
    const c = math.perRow[lastIdx];
    s.lastFill = { date: formatDate_(r[K.DATE], tz), odometer: toNumber_(r[K.ODO]), miles: c.miles, mpg: c.mpg,
      eff: c.eff, station: String(r[K.VENDOR]), partial: isPartial_(r) };
  }
  s.monthly = Object.keys(months).sort().map((k) => {
    const m = months[k];
    return { month: k, fuel: round2_(m.fuel), other: round2_(m.other), total: round2_(m.total), miles: round2_(m.miles),
      mpg: m.gallons ? round2_(m.miles / m.gallons) : '' };
  });
  ['v', 'k', 'total', 'owed', 'settled', 'settledNet', 'gallons', 'fuelSpend', 'mpg', 'bestMpg', 'worstMpg', 'avgMilesPerTank', 'avgEffRange', 'milesTracked']
    .forEach((key) => { s[key] = round2_(s[key]); });
  ['avgPpg', 'fuelCpm', 'totalCpm'].forEach((key) => { s[key] = Math.round(s[key] * 1000) / 1000; });
  Object.keys(s.byCategory).forEach((key) => { s.byCategory[key] = round2_(s.byCategory[key]); });
  // What is still owed after settlements (positive = K owes V).
  s.remaining = round2_(s.owed - s.settledNet);
  s.settle = settleText_(s.remaining, -s.remaining);
  s.settledText = !s.settled ? 'None yet'
    : s.settledNet > 0 ? 'K paid V $' + s.settledNet.toFixed(2)
    : s.settledNet < 0 ? 'V paid K $' + (-s.settledNet).toFixed(2) : '$' + s.settled.toFixed(2) + ' both ways';
  s.status = Math.abs(s.remaining) < 0.01 ? (s.settled ? 'Cleared' : 'Even') : 'Open: ' + s.settle;
  CAR_LIST_CACHE = data.slice().reverse().map((r) => ({
    id: String(r[K.ID]), date: formatDate_(r[K.DATE], tz), category: String(r[K.CATEGORY]), vendor: String(r[K.VENDOR]),
    amount: toNumber_(r[K.AMOUNT]), paidBy: String(r[K.PAID_BY]), notes: String(r[K.NOTES]),
    odometer: r[K.ODO], miles: r[K.MILES], mpg: r[K.MPG], eff: r[K.EFF], gallons: r[K.GAL], ppg: r[K.PPG], rangeLeft: r[K.RANGE],
    expenseFor: carOwner_(r), fill: r[K.CATEGORY] === 'Fuel' ? (isPartial_(r) ? 'Partial' : 'Full') : '',
    missedBefore: isMarkedMissed_(r),
  }));
  s.recent = CAR_LIST_CACHE.slice(0, RECENT_COUNT);
  s.recentTotal = CAR_LIST_CACHE.length;
  return s;
}

// Columns T onward: what V and K have paid, fuel stats, spend by category, and the data the charts read.
function writeCarSummary_(sheet, s) {
  const WIDTH = 14; // T:AG
  const line = (...cells) => cells.concat(new Array(WIDTH - cells.length).fill(''));
  const blank = () => line();
  const out = [
    line('Spent so far'),                                               // 1
    line('V paid', 'K paid', 'Total spent'),                            // 2
    line(s.v, s.k, s.total),                                            // 3
    line('Owed (after settlements)', s.status, 'Settled', s.settledText), // 4
    line('Fuel stats'),                                                 // 5
    line('Overall MPG (full-to-full)', s.mpg),                          // 6
    line('Rolling MPG (last ' + ROLLING_FILLS + ' fills)', s.rollingMpg), // 7
    line('Best / worst MPG', s.bestMpg, s.worstMpg),                    // 8
    line('Average price per gallon', s.avgPpg),                         // 9
    line('Fuel cost per mile', s.fuelCpm),                              // 10
    line('Total car cost per mile', s.totalCpm),                        // 11
    line('Average miles per full tank', s.avgMilesPerTank),             // 12
    line('Average effective range', s.avgEffRange),                     // 13
    line('Fill-ups / partial / missed', s.fills, s.partials, s.missed), // 14
    line('Gallons bought', s.gallons),                                  // 15
    line('Fuel spend', s.fuelSpend),                                    // 16
    line('Miles tracked', s.milesTracked),                              // 17
    line('Last odometer', s.lastOdometer),                              // 18
    line('Fill-ups by turn', 'V ' + s.turns.V, 'K ' + s.turns.K, 'Joint ' + s.turns.Joint), // 19
    line('Spend by category'),                                          // 20
  ];
  CAR_CATEGORIES.forEach((c) => out.push(line(c, s.byCategory[c] || 0))); // 21-29
  out.push(line('Total car spend', s.total));                            // 30
  while (out.length < CAR_DATA_ROW - 1) out.push(blank());
  out.push(line('Month', 'Fuel', 'Other', 'Total', 'Miles', 'MPG', '',
    'Full tank date', 'MPG', 'Cost/Mile', '', 'Fill date', 'Rolling MPG', 'Price/Gal')); // 40
  const rowsNeeded = Math.max(s.monthly.length, s.stretches.length, s.fills_log.length);
  for (let i = 0; i < rowsNeeded; i++) {
    const m = s.monthly[i];
    const st = s.stretches[i];
    const f = s.fills_log[i];
    out.push(line(m ? m.month : '', m ? m.fuel : '', m ? m.other : '', m ? m.total : '', m ? m.miles : '', m ? m.mpg : '', '',
      st ? st.date : '', st ? st.mpg : '', st ? st.cpm : '', '',
      f ? f.date : '', f ? f.rolling : '', f ? f.ppg : ''));
  }

  const last = Math.max(sheet.getLastRow(), out.length, CAR_DATA_ROW + CAR_CHART_ROWS);
  const area = sheet.getRange(1, CAR_SUMMARY_COL, last, WIDTH);
  area.clearContent();
  area.clearFormat();
  sheet.getRange(1, CAR_SUMMARY_COL, out.length, WIDTH).setValues(out);
  // Month labels stay text (2026-06), not dates.
  if (s.monthly.length) {
    sheet.getRange(CAR_DATA_ROW + 1, CAR_SUMMARY_COL, s.monthly.length, 1).setNumberFormat('@')
      .setValues(s.monthly.map((m) => [m.month]));
  }

  const cell = (row, col, rows, cols) => sheet.getRange(row, CAR_SUMMARY_COL + col, rows || 1, cols || 1);
  [1, 5, 20].forEach((row) => cell(row, 0).setFontWeight('bold').setFontSize(12));
  cell(2, 0, 1, 3).setFontWeight('bold').setBackground('#f3f4f6');
  cell(40, 0, 1, WIDTH).setFontWeight('bold').setBackground('#f3f4f6');
  cell(3, 0, 1, 3).setNumberFormat(MONEY);
  [4, 6].forEach((row) => cell(row, 0, 1, 2).setFontWeight('bold'));
  if (s.status === 'Cleared') cell(4, 0, 1, 2).setBackground(COLORS.settled);
  else if (s.status !== 'Even') cell(4, 0, 1, 2).setBackground(COLORS.open);
  [9, 10, 11].forEach((row) => cell(row, 1).setNumberFormat('$0.000'));
  cell(16, 1).setNumberFormat(MONEY);
  cell(21, 1, CAR_CATEGORIES.length + 1, 1).setNumberFormat(MONEY);
  cell(30, 0, 1, 2).setFontWeight('bold');
  ensureCarCharts_(sheet);
}

// Charts read fixed ranges, so they grow as rows are added. They are rebuilt when the layout changes.
function ensureCarCharts_(sheet) {
  const props = PropertiesService.getScriptProperties();
  const current = props.getProperty('SONATA_CHARTS') === CAR_CHARTS_VERSION;
  if (current && sheet.getCharts().length) return;
  sheet.getCharts().forEach((c) => sheet.removeChart(c));
  const col = (offset) => sheet.getRange(CAR_DATA_ROW, CAR_SUMMARY_COL + offset, CAR_CHART_ROWS, 1);
  const chartCol = CAR_SUMMARY_COL + 15; // column AI
  const charts = [
    { type: Charts.ChartType.LINE, x: 7, y: 8, title: 'MPG per full tank (full-to-full)', row: 1 },
    { type: Charts.ChartType.LINE, x: 11, y: 12, title: 'Rolling MPG (last ' + ROLLING_FILLS + ' fills)', row: 20 },
    { type: Charts.ChartType.LINE, x: 11, y: 13, title: 'Price per gallon', row: 39 },
    { type: Charts.ChartType.LINE, x: 7, y: 9, title: 'Fuel cost per mile', row: 58 },
    { type: Charts.ChartType.COLUMN, x: 0, y: 3, title: 'Car spend per month', row: 77 },
  ];
  charts.forEach((c) => {
    sheet.insertChart(sheet.newChart()
      .setChartType(c.type)
      .addRange(col(c.x))
      .addRange(col(c.y))
      .setNumHeaders(1)
      .setOption('title', c.title)
      .setOption('legend', { position: 'none' })
      .setOption('interpolateNulls', true)
      .setPosition(c.row, chartCol, 0, 0)
      .build());
  });
  props.setProperty('SONATA_CHARTS', CAR_CHARTS_VERSION);
}

function carState_(sheet) {
  const res = recomputeCar_(sheet);
  labelSettlements_(sheet, res.rows, carStats_(res.rows, res.math).owed, { amount: K.AMOUNT, payer: K.PAID_BY, label: K.VENDOR }, isCarSettlement_);
  const stats = carStats_(res.rows, res.math); // after labelling, so Recent shows the new labels
  writeCarSummary_(sheet, stats);
  return stats;
}

// ======================================================================================
// Funds: what comes in and what goes out, in its own "Funds" tab (like Sonata: entries on the
// left, the overview from column J).
//
//   Date | Kind | Category | Amount ($) | Person | Notes | ID | From
//
// Kind:
//   Income            money in hand (after 401(K), insurance, taxes). Person V or K; Both = shared income
//                     such as profit from something run together (half each)
//   401(K)            taken by the employer before pay; logged per paycheck. Person V or K. Not part
//                     of income, spending or savings (it never reaches the bank); counts toward the goal
//   Investment        401(K), India, USA... Person V or K. From: Income (this month) or Savings
//   Fam               money sent to the family's investment account; Category = which Fam account
//                     (optional). Person V, K or Both (half each). From: Income or Savings. Put away
//                     like an investment (not spending), but it never counts toward the V & K goal
//   Loan payment      a payment sent toward a loan; Category = which loan. Person V, K or Both
//   Use savings       spending from savings kept in earlier months. Person V or K only: savings are
//                     individual (V's from V's income, K's from K's income), never pooled
//   Prior investment  invested before tracking (counts toward the goal)
//   Goal              Amount = target, Category = deadline month (yyyy-mm, stored as text)
//   Savings target    no longer used (older rows are kept and ignored)
//
// Each month, per person; shared costs count half each and settlements are ignored:
//   Spent    = Joint/2 + shared Fixed/2 + own Fixed bills + Personal + Sonata (half of joint, own turns) + loan payments
//   Invested = Investment rows from this month's income
//   Fam      = Fam rows from this month's income
//   Savings  = Income - Spent - Invested - Fam     (the month's savings, not decided yet)
//   Kept     = Invested + Fam + Savings = Income - Spent   Savings rate = Kept / Income
// The month's savings already include any unspent joint budget (half each) and unspent personal
// budget; the overview shows that breakdown, it is not added again.
// Savings available = every earlier month's savings - savings used - invested or sent to Fam from savings.
// Goal (investments only, 401(K) included, Fam never): each person aims for half the target; needed per month =
// still to go / months left including this one.
// Generated tabs (never type in them): "Loans" and "VK", rebuilt with the Funds overview.
// ======================================================================================

const FUNDS_TAB = 'Funds';
const LOANS_TAB = 'Loans';
const VK_TAB = 'VK';
const FUNDS_HEADERS = ['Date', 'Kind', 'Category', 'Amount ($)', 'Person', 'Notes', 'ID', 'From'];
const F = { DATE: 0, KIND: 1, CATEGORY: 2, AMOUNT: 3, PERSON: 4, NOTES: 5, ID: 6, FROM: 7 };
const FUND_KINDS = ['Income', '401(K)', 'Investment', 'Fam', 'Loan payment', 'Use savings', 'Prior investment', 'Goal', 'Savings target'];
const FUNDS_SUMMARY_COL = 10; // column J
const FUNDS_SUMMARY_WIDTH = 8; // J:Q
const FUND_COLORS = {
  'Income': '#dcfce7', '401(K)': '#ddd6fe', 'Investment': '#e9d5ff', 'Fam': '#ccfbf1', 'Prior investment': '#f3e8ff', 'Loan payment': '#fecaca',
  'Use savings': '#fef9c3', 'Goal': '#e0f2fe', 'Savings target': '#e0f2fe',
};
const RECAP_PROP = 'SIRIKH_RECAP_TO';

function fundKind_(v) {
  const s = String(v).trim().toLowerCase();
  if (s === 'use surplus') return 'Use savings';
  if (s === '401k' || s === '401 (k)' || s === '401(k)') return '401(K)';
  if (s === 'fams' || s === 'family' || s === 'fam.') return 'Fam';
  for (let i = 0; i < FUND_KINDS.length; i++) if (FUND_KINDS[i].toLowerCase() === s) return FUND_KINDS[i];
  return '';
}

function fundsSheet_(create) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(FUNDS_TAB);
  if (!sheet) {
    if (!create) return null;
    sheet = ss.insertSheet(FUNDS_TAB);
  }
  const header = sheet.getRange(1, 1, 1, FUNDS_HEADERS.length).getValues()[0];
  if (header.join('|') !== FUNDS_HEADERS.join('|')) {
    // Version 19 kept its overview from column I; clear it before adding the From column.
    const width = sheet.getLastColumn();
    if (width > 7) sheet.getRange(1, 8, Math.max(sheet.getLastRow(), 1), width - 7).clearContent().clearFormat();
    sheet.getRange(1, 1, 1, FUNDS_HEADERS.length).setValues([FUNDS_HEADERS]).setFontWeight('bold').setBackground('#f3f4f6');
    sheet.setFrozenRows(1);
    sheet.hideColumns(F.ID + 1);
  }
  return sheet;
}

const isMonthKey_ = (s) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(s));

function validateFunds_(b) {
  const kind = fundKind_(b.kind);
  if (!kind) throw new Error('Pick Income, Invest, Fam, Loan or Savings.');
  const date = String(b.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Invalid date.');
  const amount = Number(b.amount);
  if (!isFinite(amount) || amount < 0 || (amount === 0 && kind !== 'Savings target')) throw new Error('Invalid amount.');
  if (kind === 'Savings target' && amount > 95) throw new Error('Savings target is a percent of income (0 to 95).');
  let person = String(b.person || '').trim();
  if (person === 'Joint') person = 'Both';
  const allowed = { 'Income': ['V', 'K', 'Both'], '401(K)': ['V', 'K'], 'Investment': ['V', 'K'], 'Fam': ['V', 'K', 'Both'], 'Loan payment': ['V', 'K', 'Both'], 'Use savings': ['V', 'K'],
    'Prior investment': ['V', 'K'] }[kind];
  if (allowed && allowed.indexOf(person) === -1) throw new Error('Person must be ' + allowed.join(', ').replace(/, ([^,]*)$/, ' or $1') + '.');
  if (!allowed) person = 'Both';
  let category = String(b.category || '').trim();
  if (kind === 'Goal' && !isMonthKey_(category)) throw new Error('Pick a deadline month.');
  if (!category) {
    category = { 'Income': 'Salary', '401(K)': '401(K)', 'Investment': 'Investment', 'Fam': 'Fam', 'Loan payment': 'Loan', 'Use savings': 'Savings used',
      'Prior investment': 'Before tracking', 'Savings target': 'Savings target' }[kind] || '';
  }
  const from = String(b.from || '').trim();
  return {
    id: String(b.id || Utilities.getUuid()).slice(0, 64), date: date, kind: kind, category: safeText_(category.slice(0, 200)),
    amount: round2_(amount), person: person, notes: safeText_(String(b.notes || '').trim().slice(0, 500)),
    from: kind === 'Investment' || kind === 'Fam' ? (from === 'Savings' || from === 'Surplus' ? 'Savings' : 'Income') : '',
  };
}

function readFundsRows_(sheet) {
  if (!sheet) return [];
  const last = sheet.getLastRow();
  if (last < 2) return [];
  return sheet.getRange(2, 1, last - 1, FUNDS_HEADERS.length).getValues()
    .filter((r) => !(r[F.DATE] === '' && r[F.KIND] === '' && r[F.AMOUNT] === ''));
}

function addFunds_(e) {
  const sheet = fundsSheet_(true);
  const all = sheet.getLastRow() < 2 ? [] : sheet.getRange(2, 1, sheet.getLastRow() - 1, FUNDS_HEADERS.length).getValues();
  if (all.some((r) => String(r[F.ID]) === e.id)) return; // retried from the offline queue
  let row = 2;
  for (let i = all.length - 1; i >= 0; i--) if (all[i][F.DATE] !== '' || all[i][F.KIND] !== '') { row = i + 3; break; }
  writeFundsRow_(sheet, row, e);
}

// The Category cell is plain text first: otherwise the sheet turns a goal deadline like 2028-07 into a date.
function writeFundsRow_(sheet, row, e) {
  sheet.getRange(row, F.CATEGORY + 1).setNumberFormat('@');
  sheet.getRange(row, 1, 1, FUNDS_HEADERS.length).setValues([[e.date, e.kind, e.category, e.amount, e.person, e.notes, e.id, e.from]]);
  sheet.getRange(row, F.DATE + 1).setNumberFormat('yyyy-mm-dd');
  sheet.getRange(row, F.AMOUNT + 1).setNumberFormat(MONEY);
}

function updateFunds_(e) {
  const sheet = fundsSheet_(true);
  const all = sheet.getLastRow() < 2 ? [] : sheet.getRange(2, 1, sheet.getLastRow() - 1, FUNDS_HEADERS.length).getValues();
  let i = -1;
  for (let k = all.length - 1; k >= 0; k--) if (String(all[k][F.ID]) === e.id) { i = k; break; }
  if (i === -1) return addFunds_(e);
  writeFundsRow_(sheet, i + 2, e);
}

// Only the entry columns move up; the overview on the right is rebuilt anyway.
function deleteFunds_(id) {
  const sheet = fundsSheet_(false);
  if (!sheet || !id || sheet.getLastRow() < 2) return;
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, FUNDS_HEADERS.length).getValues();
  let i = -1;
  for (let k = rows.length - 1; k >= 0; k--) if (String(rows[k][F.ID]) === id) { i = k; break; }
  if (i === -1) return;
  const rest = rows.slice(i + 1).concat([new Array(FUNDS_HEADERS.length).fill('')]);
  sheet.getRange(i + 2, 1, rest.length, FUNDS_HEADERS.length).setValues(rest);
}

function colorFunds_(sheet) {
  const last = sheet.getLastRow();
  if (last < 2) return;
  const kinds = sheet.getRange(2, F.KIND + 1, last - 1, 1).getValues();
  sheet.getRange(2, 1, last - 1, FUNDS_HEADERS.length)
    .setBackgrounds(kinds.map((k) => new Array(FUNDS_HEADERS.length).fill(FUND_COLORS[fundKind_(k[0])] || null)));
}

const monthIndex_ = (key) => Number(key.slice(0, 4)) * 12 + Number(key.slice(5, 7)) - 1;
const keyOfIndex_ = (n) => Math.floor(n / 12) + '-' + String((n % 12) + 1).padStart(2, '0');
const split_ = (person, amount) => (person === 'Both' || person === 'Joint' ? { V: amount / 2, K: amount / 2 }
  : person === 'V' ? { V: amount, K: 0 } : person === 'K' ? { V: 0, K: amount } : { V: 0, K: 0 });
const vk_ = (o) => ({ V: round2_(o.V), K: round2_(o.K), total: round2_(o.V + o.K) });
const usd0_ = (x) => (x < 0 ? '-$' : '$') + Math.round(Math.abs(x)).toLocaleString('en-US');
const daysInMonth_ = (key) => new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)), 0).getDate();

function parseFunds_(fundsRows, tz) {
  return fundsRows.map((r, i) => {
    const p = String(r[F.PERSON]).trim().toUpperCase();
    // A deadline the sheet already turned into a date (before version 23) reads back as yyyy-mm.
    const cat = r[F.CATEGORY] instanceof Date ? Utilities.formatDate(r[F.CATEGORY], tz, 'yyyy-MM') : String(r[F.CATEGORY]).trim();
    return { i: i, date: formatDate_(r[F.DATE], tz), kind: fundKind_(r[F.KIND]), category: cat,
      amount: toNumber_(r[F.AMOUNT]), person: p === 'BOTH' || p === 'JOINT' ? 'Both' : p, notes: String(r[F.NOTES]), id: String(r[F.ID]),
      from: /^(savings|surplus)$/i.test(String(r[F.FROM]).trim()) ? 'Savings' : 'Income' };
  });
}

// The whole money picture. months = the monthly tabs' totals (from state_), carRows = Sonata rows.
function fundsModel_(today, fundsRows, months, carRows) {
  const current = today.slice(0, 7);
  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  const rows = parseFunds_(fundsRows, tz);
  const incomeMonths = rows.filter((r) => r.kind === 'Income').map((r) => r.date.slice(0, 7)).sort();
  const start = incomeMonths.length && incomeMonths[0] < current ? incomeMonths[0] : current;
  const blank = () => ({ income: { V: 0, K: 0 }, joint: 0, fixed: 0, fixedOwn: { V: 0, K: 0 }, personal: { V: 0, K: 0 }, carShared: 0, car: { V: 0, K: 0 },
    invest: { V: 0, K: 0 }, investSaved: { V: 0, K: 0 }, fam: { V: 0, K: 0 }, famSaved: { V: 0, K: 0 }, loan: { V: 0, K: 0 }, used: { V: 0, K: 0 }, k401: { V: 0, K: 0 }, jointBudget: null, pb: { V: null, K: null } });
  const byMonth = {};
  for (let n = monthIndex_(start); n <= monthIndex_(current); n++) byMonth[keyOfIndex_(n)] = blank();
  const at = (key) => byMonth[key] || null;
  const add = (o, s) => { o.V += s.V; o.K += s.K; };

  rows.forEach((r) => {
    const m = at(r.date.slice(0, 7));
    if (!m) return;
    if (r.kind === 'Income') add(m.income, split_(r.person, r.amount));
    if (r.kind === 'Investment') add(r.from === 'Savings' ? m.investSaved : m.invest, split_(r.person, r.amount));
    if (r.kind === 'Fam') add(r.from === 'Savings' ? m.famSaved : m.fam, split_(r.person, r.amount));
    if (r.kind === 'Use savings') add(m.used, split_(r.person, r.amount));
    if (r.kind === 'Loan payment') add(m.loan, split_(r.person, r.amount));
    if (r.kind === '401(K)') add(m.k401, split_(r.person, r.amount));
  });
  months.forEach((mt) => {
    const m = at(mt.key);
    if (!m) return;
    m.joint += mt.p.spent;
    // Shared bills half each; own bills (mobile lines) to their owner. Older periods have no split.
    m.fixed += mt.p.fShared === undefined ? mt.p.fixed : mt.p.fShared;
    m.fixedOwn.V += mt.p.fOwnV || 0;
    m.fixedOwn.K += mt.p.fOwnK || 0;
    m.personal.V += mt.p.pv;
    m.personal.K += mt.p.pk;
    if (mt.p.hasBudget) m.jointBudget = mt.p.start + mt.p.added;
    m.pb = { V: mt.pb.V ? mt.pb.V.budget : null, K: mt.pb.K ? mt.pb.K.budget : null };
  });
  carRows.forEach((r) => {
    if (isEmptyCarRow_(r) || isCarSettlement_(r)) return;
    const m = at(formatDate_(r[K.DATE], tz).slice(0, 7));
    if (!m) return;
    const owner = carOwner_(r);
    const amount = toNumber_(r[K.AMOUNT]);
    if (owner === 'Joint') m.carShared += amount;
    else if (owner === 'V' || owner === 'K') m.car[owner] += amount;
  });

  let carry = { V: 0, K: 0 };
  const history = Object.keys(byMonth).sort().map((key) => {
    const m = byMonth[key];
    const who = (fn) => vk_({ V: fn('V'), K: fn('K') });
    const spent = who((w) => m.joint / 2 + m.fixed / 2 + m.fixedOwn[w] + m.personal[w] + m.carShared / 2 + m.car[w] + m.loan[w]);
    const savings = who((w) => m.income[w] - spent[w] - m.invest[w] - m.fam[w]);
    const kept = who((w) => m.income[w] - spent[w]);
    const rateOf = (k, i) => (i > 0 ? round2_((k / i) * 100) : null);
    // Where the month's savings came from: unspent budgets first, the rest is unbudgeted income.
    const jointLeft = m.jointBudget === null ? null : round2_(m.jointBudget - m.joint);
    const personalLeft = { V: m.pb.V === null ? null : round2_(m.pb.V - m.personal.V), K: m.pb.K === null ? null : round2_(m.pb.K - m.personal.K) };
    const fromJoint = who(() => (jointLeft === null ? 0 : jointLeft / 2));
    const fromPersonal = who((w) => personalLeft[w] || 0);
    const before = vk_(carry);
    carry = { V: carry.V + savings.V - m.used.V - m.investSaved.V - m.famSaved.V, K: carry.K + savings.K - m.used.K - m.investSaved.K - m.famSaved.K };
    return {
      month: key, label: monthLabel_(key), income: vk_(m.income), joint: round2_(m.joint), fixed: round2_(m.fixed),
      sonataShared: round2_(m.carShared), shared: who((w) => m.joint / 2 + m.fixed / 2 + m.fixedOwn[w]), personal: vk_(m.personal),
      jointHalf: who(() => m.joint / 2), fixedEach: who((w) => m.fixed / 2 + m.fixedOwn[w]),
      sonata: who((w) => m.carShared / 2 + m.car[w]), loan: vk_(m.loan), spent: spent, invest: vk_(m.invest), savings: savings, kept: kept,
      rate: { V: rateOf(kept.V, m.income.V), K: rateOf(kept.K, m.income.K), total: rateOf(kept.total, m.income.V + m.income.K) },
      budgets: { jointBudget: m.jointBudget === null ? null : round2_(m.jointBudget), jointLeft: jointLeft, personalLeft: personalLeft,
        fromJoint: fromJoint, fromPersonal: fromPersonal, rest: vk_({ V: savings.V - fromJoint.V - fromPersonal.V, K: savings.K - fromJoint.K - fromPersonal.K }) },
      investSaved: vk_(m.investSaved), used: vk_(m.used), fam: vk_(m.fam), famSaved: vk_(m.famSaved),
      famAll: vk_({ V: m.fam.V + m.famSaved.V, K: m.fam.K + m.famSaved.K }), savedBefore: before, savedAfter: vk_(carry), k401: vk_(m.k401),
      putAway: vk_({ V: m.k401.V + m.invest.V + m.investSaved.V, K: m.k401.K + m.invest.K + m.investSaved.K }),
    };
  });
  const now = history[history.length - 1];
  // Savings you can use now: earlier months' savings minus what was used or invested from them (this month included).
  const available = vk_({ V: now.savedBefore.V - now.used.V - now.investSaved.V - now.famSaved.V,
    K: now.savedBefore.K - now.used.K - now.investSaved.K - now.famSaved.K });

  // ---- goal (investments only)
  const goalRow = rows.filter((r) => r.kind === 'Goal').sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.i - b.i)).pop();
  let goal = null;
  if (goalRow) {
    const invested = { V: 0, K: 0 };
    rows.forEach((r) => { if (r.kind === 'Investment' || r.kind === 'Prior investment' || r.kind === '401(K)') add(invested, split_(r.person, r.amount)); });
    const target = goalRow.amount;
    const deadline = goalRow.category;
    const monthsLeft = Math.max(0, monthIndex_(deadline) - monthIndex_(current) + 1);
    const togo = { V: Math.max(0, target / 2 - invested.V), K: Math.max(0, target / 2 - invested.K) };
    const div = monthsLeft || 1;
    const tracked = history.length || 1;
    const avg = { V: history.reduce((s, h) => s + h.putAway.V, 0) / tracked, K: history.reduce((s, h) => s + h.putAway.K, 0) / tracked };
    const togoTotal = togo.V + togo.K;
    const avgTotal = avg.V + avg.K;
    const finishIn = togoTotal <= 0 ? 0 : avgTotal > 0 ? Math.ceil(togoTotal / avgTotal) : null;
    const finishKey = finishIn === null ? null : keyOfIndex_(monthIndex_(current) + Math.max(finishIn - 1, 0));
    goal = {
      target: round2_(target), deadline: deadline, deadlineLabel: monthLabel_(deadline), monthsLeft: monthsLeft,
      invested: vk_(invested), togo: vk_(togo), need: vk_({ V: togo.V / div, K: togo.K / div }), avg: vk_(avg),
      thisMonth: now.putAway,
      percent: target ? Math.min(100, round2_(((invested.V + invested.K) / target) * 100)) : 0,
      finishKey: finishKey, finishLabel: finishKey ? monthLabel_(finishKey) : '',
      onTrack: togoTotal <= 0 || (finishKey !== null && finishKey <= deadline),
    };
    goal.suggestions = goalSuggestions_(goal, now, available);
  }

  // ---- loan payments, by loan (simple logs)
  const loanMap = {};
  rows.filter((r) => r.kind === 'Loan payment').forEach((r) => {
    const k = r.category.toLowerCase();
    const l = loanMap[k] || (loanMap[k] = { name: r.category, thisMonth: 0, total: 0, V: 0, K: 0, last: '' });
    const s = split_(r.person, r.amount);
    l.total += r.amount; l.V += s.V; l.K += s.K;
    if (r.date.slice(0, 7) === current) l.thisMonth += r.amount;
    if (r.date > l.last) l.last = r.date;
  });
  const loans = Object.keys(loanMap).map((k) => {
    const l = loanMap[k];
    return { name: l.name, thisMonth: round2_(l.thisMonth), total: round2_(l.total), V: round2_(l.V), K: round2_(l.K), last: l.last };
  }).sort((a, b) => b.total - a.total);
  // Each person's usual loan payments a month (last 3 months that had one), for the payday plan.
  const recentLoan = history.slice(-4, -1).filter((h) => h.loan.total > 0);
  const loanUsual = vk_({ V: recentLoan.length ? recentLoan.reduce((s, h) => s + h.loan.V, 0) / recentLoan.length : now.loan.V,
    K: recentLoan.length ? recentLoan.reduce((s, h) => s + h.loan.K, 0) / recentLoan.length : now.loan.K });

  // Fam: money sent to the family's investment account, by account (never part of the goal).
  const famMap = {};
  const famTotal = { V: 0, K: 0 };
  rows.filter((r) => r.kind === 'Fam').forEach((r) => {
    const k = r.category.toLowerCase();
    const a = famMap[k] || (famMap[k] = { name: r.category, thisMonth: 0, total: 0, V: 0, K: 0, last: '' });
    const s = split_(r.person, r.amount);
    a.total += r.amount; a.V += s.V; a.K += s.K;
    add(famTotal, s);
    if (r.date.slice(0, 7) === current) a.thisMonth += r.amount;
    if (r.date > a.last) a.last = r.date;
  });
  const fams = Object.keys(famMap).map((k) => {
    const a = famMap[k];
    return { name: a.name, thisMonth: round2_(a.thisMonth), total: round2_(a.total), V: round2_(a.V), K: round2_(a.K), last: a.last };
  }).sort((a, b) => b.total - a.total);

  // 401(K) so far, and each person's latest contribution (prefilled in the app; it can change any time).
  const k401Total = { V: 0, K: 0 };
  const k401Last = { V: null, K: null };
  rows.filter((r) => r.kind === '401(K)').sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.i - b.i)).forEach((r) => {
    add(k401Total, split_(r.person, r.amount));
    if (r.person === 'V' || r.person === 'K') k401Last[r.person] = r.amount;
  });
  const loanPayments = rows.filter((r) => r.kind === 'Loan payment')
    .sort((a, b) => (a.date !== b.date ? (a.date < b.date ? 1 : -1) : b.i - a.i))
    .map((r) => ({ date: r.date, loan: r.category, amount: r.amount, person: r.person, notes: r.notes }));
  return { month: current, today: today, start: start, now: now, available: available, history: history, goal: goal,
    loans: loans, loanUsual: loanUsual, fams: fams, famTotal: vk_(famTotal),
    k401Total: vk_(k401Total), k401Last: k401Last, loanPayments: loanPayments };
}

function goalSuggestions_(g, now, available) {
  const out = [];
  if (g.togo.total <= 0) return ['Goal reached. Set a new goal to keep going.'];
  if (g.monthsLeft > 0) {
    out.push('Invest ' + usd0_(g.need.total) + ' a month together (V ' + usd0_(g.need.V) + ', K ' + usd0_(g.need.K) + ') for the next ' +
      g.monthsLeft + ' month' + (g.monthsLeft === 1 ? '' : 's') + ' to reach ' + usd0_(g.target) + ' by ' + g.deadlineLabel + '.');
  } else {
    out.push('The deadline has passed with ' + usd0_(g.togo.total) + ' to go. Set a new deadline to get a monthly target.');
  }
  if (g.avg.total > 0 && g.finishLabel) {
    out.push('At your average of ' + usd0_(g.avg.total) + ' a month you would reach it around ' + g.finishLabel + (g.onTrack ? ', on time.' : ', after the deadline.'));
  }
  if (Math.abs(g.invested.V - g.invested.K) >= 1) {
    const ahead = g.invested.V > g.invested.K ? 'V' : 'K';
    out.push(ahead + ' has invested ' + usd0_(Math.abs(g.invested.V - g.invested.K)) + ' more so far; ' + (ahead === 'V' ? 'K' : 'V') + ' needs that much extra to match.');
  }
  const gap = Math.max(0, g.need.total - g.thisMonth.total);
  if (now && gap > 0 && now.savings.total > 0) {
    out.push(now.savings.total >= gap
      ? 'This month\'s savings are ' + usd0_(now.savings.total) + '; investing ' + usd0_(gap) + ' of it would hit this month\'s target.'
      : 'This month\'s savings are ' + usd0_(now.savings.total) + '; investing all of it still leaves you ' + usd0_(gap - now.savings.total) + ' short of this month\'s ' + usd0_(g.need.total) + ' target.');
  }
  if (available.total > 0 && g.monthsLeft > 1) {
    out.push('Investing your ' + usd0_(available.total) + ' savings from earlier months would bring the monthly target down to ' +
      usd0_(Math.max(0, g.togo.total - available.total) / g.monthsLeft) + '.');
  }
  return out;
}

// One list of the most useful next steps, for the overview, the app and the weekly email.
function suggestions_(model) {
  const out = [];
  if (model.goal) out.push.apply(out, model.goal.suggestions);
  return out;
}

// Number format for one written cell: money for numbers, dates and percents as such, text otherwise.
function cellFormat_(v) {
  if (typeof v === 'number') return MONEY;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(v))) return 'yyyy-mm-dd';
  if (/^-?\d+(\.\d+)?%$/.test(String(v))) return '0.0%';
  return '@';
}

// Writes a block of rows at (row, col): values, formats in one call, bold shaded header rows.
function writeBlock_(sheet, row, col, out, heads) {
  if (!out.length) return;
  const width = out[0].length;
  const range = sheet.getRange(row, col, out.length, width);
  range.setValues(out);
  range.setNumberFormats(out.map((r) => r.map(cellFormat_)));
  heads.forEach((r) => sheet.getRange(row + r - 1, col, 1, width).setFontWeight('bold').setBackground('#e0f2fe'));
}

// Overview in columns J to P of the Funds tab, rebuilt on every save.
function writeFundsSummary_(sheet, model) {
  const W = FUNDS_SUMMARY_WIDTH;
  const out = [];
  const heads = [];
  const moneyRows = [];
  const line = (cells, kind) => {
    out.push(cells.concat(new Array(W - cells.length).fill('')));
    if (kind === 'head') heads.push(out.length);
    if (kind === 'money') moneyRows.push(out.length);
  };
  const gap = () => line([]);
  const pct = (x) => (x === null || x === undefined ? '' : x.toFixed(1) + '%');
  const n = model.now;
  const trio = (label, o) => line([label, o.V, o.K, o.total], 'money');

  line(['This month: ' + n.label, 'V', 'K', 'Total'], 'head');
  trio('Income (in hand)', n.income);
  trio('Joint (half each)', n.jointHalf);
  trio('Fixed (half of shared + own bills)', n.fixedEach);
  trio('Personal', n.personal);
  trio('Sonata (own turns + half joint)', n.sonata);
  trio('Loan payments', n.loan);
  trio('Spent (all inclusive)', n.spent);
  trio('Invested', n.invest);
  trio('Fam (family account, not toward goal)', n.fam);
  trio('Savings this month', n.savings);
  line(['Savings rate (invested + Fam + savings)', pct(n.rate.V), pct(n.rate.K), pct(n.rate.total)]);
  gap();
  line(['401(K) (taken before pay)', 'V', 'K', 'Total'], 'head');
  trio('This month', n.k401);
  trio('So far', model.k401Total);
  line(['Latest per paycheck', model.k401Last.V === null ? '' : model.k401Last.V, model.k401Last.K === null ? '' : model.k401Last.K], 'money');
  trio('Put away this month (401(K) + invested)', n.putAway);
  const b = n.budgets;
  if (b.jointLeft !== null || b.personalLeft.V !== null || b.personalLeft.K !== null) {
    gap();
    line(['Where this month\'s savings come from', 'V', 'K', 'Total'], 'head');
    if (b.jointLeft !== null) trio('Joint budget left (half each)', b.fromJoint);
    if (b.personalLeft.V !== null || b.personalLeft.K !== null) trio('Personal budget left', b.fromPersonal);
    trio('Rest of income (not budgeted)', b.rest);
    trio('Savings this month', n.savings);
  }
  gap();
  line(['Savings (to decide)', 'V', 'K', 'Total'], 'head');
  trio('From earlier months', n.savedBefore);
  trio('Used this month', n.used);
  trio('Invested from savings', n.investSaved);
  trio('Sent to Fam from savings', n.famSaved);
  trio('Available now', model.available);
  trio('After this month', n.savedAfter);
  const g = model.goal;
  if (g) {
    gap();
    line(['Goal: ' + usd0_(g.target) + ' by ' + g.deadlineLabel, 'V', 'K', 'Total'], 'head');
    trio('Invested so far', g.invested);
    trio('Still to go', g.togo);
    trio('Needed per month', g.need);
    trio('Invested this month', g.thisMonth);
    trio('Average per month', g.avg);
    line(['Months left (incl. this one)', g.monthsLeft + ' months']);
    line(['Projected finish', g.finishLabel || 'Invest to see']);
    line(['Status', g.onTrack ? 'On track' : 'Behind', g.percent.toFixed(2) + '% done']);
  }
  if (model.loans.length) {
    gap();
    line(['Loan payments', 'This month', 'Total', 'V', 'K', 'Last paid'], 'head');
    model.loans.forEach((l) => line([l.name, l.thisMonth, l.total, l.V, l.K, l.last], 'money'));
  }
  if (model.fams.length) {
    gap();
    line(['Fam (family investment, not toward goal)', 'This month', 'Total', 'V', 'K', 'Last sent'], 'head');
    model.fams.forEach((a) => line([a.name, a.thisMonth, a.total, a.V, a.K, a.last], 'money'));
    line(['All Fam', n.famAll.total, model.famTotal.total, model.famTotal.V, model.famTotal.K], 'money');
  }
  gap();
  line(['Month by month', 'Income', '401(K)', 'Spent', 'Invested', 'Fam', 'Savings', 'Savings total'], 'head');
  model.history.slice().reverse().forEach((h) => line([h.label, h.income.total, h.k401.total, h.spent.total, h.invest.total, h.famAll.total, h.savings.total, h.savedAfter.total], 'money'));
  const tips = suggestions_(model);
  if (tips.length) {
    gap();
    line(['Suggestions'], 'head');
    tips.forEach((t) => line([t]));
  }
  const clearRows = Math.max(sheet.getLastRow(), out.length);
  sheet.getRange(1, FUNDS_SUMMARY_COL, clearRows, W).clearContent().clearFormat();
  writeBlock_(sheet, 1, FUNDS_SUMMARY_COL, out, heads);
}

// Builds a fresh generated tab (Loans, VK): cleared and rewritten on every save.
function generatedTab_(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  sheet.clear();
  return sheet;
}

// "Loans": every loan's payments month by month, and every payment. Data stays in the Funds tab.
function writeLoansTab_(model) {
  const pays = model.loanPayments;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!pays.length && !ss.getSheetByName(LOANS_TAB)) return;
  const sheet = generatedTab_(LOANS_TAB);
  const names = model.loans.map((l) => l.name);
  const W = Math.max(6, names.length + 2);
  const out = [];
  const heads = [];
  const line = (cells, head) => { out.push(cells.concat(new Array(W - cells.length).fill(''))); if (head) heads.push(out.length); };
  line(['Loans (built from the Funds tab; log payments in the app. Do not type here.)']);
  line([]);
  line(['Loan', 'This month', 'Total paid', 'V', 'K', 'Last paid'], true);
  model.loans.forEach((l) => line([l.name, l.thisMonth, l.total, l.V, l.K, l.last]));
  if (!model.loans.length) line(['No loan payments yet']);
  line([]);
  line(['Month by month'].concat(names).concat(['Total']), true);
  const byMonth = {};
  pays.forEach((p) => {
    const m = p.date.slice(0, 7);
    const row = byMonth[m] || (byMonth[m] = {});
    const k = p.loan.toLowerCase();
    row[k] = (row[k] || 0) + p.amount;
  });
  Object.keys(byMonth).sort().reverse().forEach((m) => {
    const row = byMonth[m];
    const vals = names.map((nm) => round2_(row[nm.toLowerCase()] || 0));
    line([monthLabel_(m)].concat(vals).concat([round2_(vals.reduce((x, y) => x + y, 0))]));
  });
  line([]);
  line(['All payments', 'Loan', 'Amount', 'Paid by', 'Notes'], true);
  pays.forEach((p) => line([p.date, p.loan, p.amount, p.person === 'Both' ? 'V + K' : p.person, p.notes]));
  writeBlock_(sheet, 1, 1, out, heads);
  sheet.getRange(1, 1).setFontWeight('bold');
  sheet.setFrozenRows(0);
}

// "VK": V and K side by side, one row per month (newest first), everything for each person.
function writeVkTab_(model) {
  const sheet = generatedTab_(VK_TAB);
  const cols = ['Month', 'Income (in hand)', '401(K)', 'Joint (half)', 'Fixed (half shared + own)', 'Personal', 'Sonata', 'Loan payments', 'Spent',
    'Invested', 'Fam (not toward goal)', 'Savings', 'Savings rate', 'Savings total', 'Put away (401(K) + invested)'];
  const W = cols.length;
  const out = [];
  const heads = [];
  const pct = (x) => (x === null || x === undefined ? '' : x.toFixed(1) + '%');
  const line = (cells, head) => { out.push(cells.concat(new Array(W - cells.length).fill(''))); if (head) heads.push(out.length); };
  line(['V and K month by month (built from the Funds, month and Sonata tabs. Do not type here.)']);
  line(['Shared costs count half each. Savings = income - spent - invested - Fam (Fam includes what was sent from savings). 401(K) is taken before pay, so it is not in income or savings.']);
  ['V', 'K'].forEach((w) => {
    line([]);
    line([w === 'V' ? 'V' : 'K'], true);
    line(cols, true);
    const sum = { income: 0, k401: 0, jointHalf: 0, fixedEach: 0, personal: 0, sonata: 0, loan: 0, spent: 0, invest: 0, famAll: 0, savings: 0, putAway: 0 };
    model.history.slice().reverse().forEach((h) => {
      line([h.label, h.income[w], h.k401[w], h.jointHalf[w], h.fixedEach[w], h.personal[w], h.sonata[w], h.loan[w], h.spent[w], h.invest[w], h.famAll[w], h.savings[w],
        pct(h.rate[w]), h.savedAfter[w], h.putAway[w]]);
      Object.keys(sum).forEach((k) => { sum[k] += h[k][w]; });
    });
    const rate = sum.income > 0 ? ((sum.income - sum.spent) / sum.income) * 100 : null;
    line(['All months', round2_(sum.income), round2_(sum.k401), round2_(sum.jointHalf), round2_(sum.fixedEach), round2_(sum.personal), round2_(sum.sonata), round2_(sum.loan),
      round2_(sum.spent), round2_(sum.invest), round2_(sum.famAll), round2_(sum.savings), pct(rate), model.now.savedAfter[w], round2_(sum.putAway)], true);
  });
  writeBlock_(sheet, 1, 1, out, heads);
  sheet.getRange(1, 1).setFontWeight('bold');
}

function fundsState_(today, months, carSheet) {
  const sheet = fundsSheet_(false);
  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  const raw = readFundsRows_(sheet);
  const model = fundsModel_(today, raw, months, readCarRows_(carSheet));
  if (sheet) {
    colorFunds_(sheet);
    writeFundsSummary_(sheet, model);
    writeLoansTab_(model);
    writeVkTab_(model);
  }
  model.suggestions = suggestions_(model);
  model.hasEntries = raw.length > 0;
  FUNDS_LIST_CACHE = parseFunds_(raw, tz).sort((a, b) => (a.date !== b.date ? (a.date < b.date ? 1 : -1) : b.i - a.i))
    .map((r) => ({ id: r.id, date: r.date, kind: r.kind, category: r.category, amount: r.amount, person: r.person,
      notes: r.notes, from: r.kind === 'Investment' || r.kind === 'Fam' ? r.from : '' }));
  model.recent = FUNDS_LIST_CACHE.slice(0, RECENT_COUNT);
  model.recentTotal = FUNDS_LIST_CACHE.length;
  model.recap = recapConfig_();
  return model;
}

// ---- Weekly email recap (Sunday evening), optional.
function recapConfig_() {
  const to = PropertiesService.getScriptProperties().getProperty(RECAP_PROP) || '';
  return { to: to, on: !!to };
}

function setRecap_(body) {
  const props = PropertiesService.getScriptProperties();
  const list = String(body.to || '').split(/[,;\s]+/).filter(Boolean);
  if (body.on) {
    if (!list.length || list.some((x) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x))) throw new Error('Enter one or two email addresses.');
    if (list.length > 5) throw new Error('Up to 5 email addresses.');
    props.setProperty(RECAP_PROP, list.join(','));
  } else {
    props.setProperty(RECAP_PROP, '');
  }
  ScriptApp.getProjectTriggers().forEach((t) => { if (t.getHandlerFunction() === 'weeklyRecap') ScriptApp.deleteTrigger(t); });
  if (body.on) ScriptApp.newTrigger('weeklyRecap').timeBased().onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(18).create();
}

// Household spending (Joint, Fixed, Personal, Sonata) per day of a month, from the cached month rows.
function spendByDay_(key, carRows, tz) {
  const days = new Array(32).fill(0);
  const mt = MONTHS_CACHE.find((m) => m.key === key);
  if (mt) mt.rows.forEach((r) => {
    if (isEmptyRow_(r)) return;
    const type = normalizeType_(r[C.TYPE]);
    if (type !== 'Joint' && type !== 'Fixed' && type !== 'Personal') return;
    days[Number(formatDate_(r[C.DATE], tz).slice(8, 10))] += toNumber_(r[C.AMOUNT]);
  });
  carRows.forEach((r) => {
    if (isEmptyCarRow_(r) || isCarSettlement_(r)) return;
    const d = formatDate_(r[K.DATE], tz);
    if (d.slice(0, 7) === key) days[Number(d.slice(8, 10))] += toNumber_(r[K.AMOUNT]);
  });
  return days;
}

function recapText_(today, model, carRows) {
  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  const key = today.slice(0, 7);
  const day = Number(today.slice(8, 10));
  const cur = spendByDay_(key, carRows, tz);
  const prev = spendByDay_(previousKey_(key), carRows, tz);
  const sum = (a, from, to) => a.slice(from, to + 1).reduce((s, x) => s + x, 0);
  const soFar = sum(cur, 1, day);
  const lastSame = sum(prev, 1, Math.min(day, 31));
  let week = sum(cur, Math.max(1, day - 6), day);
  if (day < 7) week += sum(prev, daysInMonth_(previousKey_(key)) - (6 - day), 31);
  const lines = [];
  const n = model.now;
  lines.push('Spent in ' + n.label + ' so far: ' + usd0_(soFar) + (lastSame > 0 ? ' (last month by the same day: ' + usd0_(lastSame) + ', ' +
    (soFar <= lastSame ? usd0_(lastSame - soFar) + ' less' : usd0_(soFar - lastSame) + ' more') + ')' : '') + '.');
  lines.push('Last 7 days: ' + usd0_(week) + '.');
  if (n.income.total > 0) lines.push('Income ' + usd0_(n.income.total) + ', invested ' + usd0_(n.invest.total) + ', savings ' + usd0_(n.savings.total) + (n.rate.total !== null ? ' (' + Math.round(n.rate.total) + '% kept)' : '') + '.');
  if (n.famAll.total > 0) lines.push('Fam this month: ' + usd0_(n.famAll.total) + ' (V ' + usd0_(n.famAll.V) + ', K ' + usd0_(n.famAll.K) + '), not part of the goal.');
  if (n.k401.total > 0) lines.push('401(K) this month: ' + usd0_(n.k401.total) + ' (V ' + usd0_(n.k401.V) + ', K ' + usd0_(n.k401.K) + ').');
  lines.push('Savings available from earlier months: ' + usd0_(model.available.total) + '.');
  if (model.goal) lines.push('Goal ' + usd0_(model.goal.target) + ' by ' + model.goal.deadlineLabel + ': ' + model.goal.percent.toFixed(1) + '% done, ' + usd0_(model.goal.need.total) + ' a month needed (' + (model.goal.onTrack ? 'on track' : 'behind') + ').');
  if (n.loan.total > 0) lines.push('Loan payments this month: ' + usd0_(n.loan.total) + ' (' + model.loans.filter((l) => l.thisMonth > 0).map((l) => l.name + ' ' + usd0_(l.thisMonth)).join(', ') + ').');
  return { subject: 'Sirikh weekly: ' + usd0_(soFar) + ' spent in ' + n.label.split(' ')[0], lines: lines };
}

// Runs from the weekly trigger (and "Send a test" in the app).
function weeklyRecap() {
  sendRecap_(todayStr_());
}

function sendRecap_(today) {
  const to = recapConfig_().to;
  if (!to) return false;
  state_(today.slice(0, 7), []);
  const carSheet = getCarSheet_();
  const model = fundsState_(today, MONTHS_CACHE, carSheet);
  const r = recapText_(today, model, readCarRows_(carSheet));
  const tips = model.suggestions.slice(0, 4);
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const html = '<div style="font-family:-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.5">' +
    '<h2 style="color:#0f766e;margin:0 0 8px">Sirikh weekly</h2><ul>' + r.lines.map((l) => '<li>' + esc(l) + '</li>').join('') + '</ul>' +
    (tips.length ? '<p><b>Next steps</b></p><ul>' + tips.map((l) => '<li>' + esc(l) + '</li>').join('') + '</ul>' : '') + '</div>';
  MailApp.sendEmail({ to: to, subject: r.subject, body: r.lines.concat(tips.length ? ['', 'Next steps:'].concat(tips) : []).join('\n'), htmlBody: html });
  return true;
}
