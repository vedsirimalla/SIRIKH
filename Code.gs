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
 *   Date | Category | Amount ($) | Card Used | Notes | Type | Joint Left ($) | ID | Expense For
 * The "Sirikh" tab is an overview with one row per month, rebuilt on every save.
 *
 * Card Used is whose card paid. Expense For is whose expense it is: blank (shared) for Joint and
 * Fixed, V or K for Personal. A Personal expense paid on the other person's card is owed back in
 * full (K's ramen on V's card: K owes V the whole amount).
 *
 * Type is one of:
 *   Joint            shared day-to-day expense, comes out of the month's joint budget  (no color)
 *   Fixed            rent, utilities and other bills, no budget       (orange: V light, K darker)
 *   Personal         one person's own expense, comes out of that person's budget (blue: V light, K darker)
 *   Set balance      the month's joint budget
 *   Personal budget  the month's personal budget for V or K (Expense For)
 *   Add funds        adds to the month's joint budget (only from hand edits)
 * Budgets are per calendar month and reset on the 1st (nothing carries over). The latest budget
 * row in a month sets the amount, and every expense dated in that month counts against it, even
 * one logged before the budget was set. Joint Left ($) is the joint budget minus the joint
 * spending up to that row; the rows and colors are recalculated whenever the tab changes.
 *
 * Columns J onward of each month tab hold that month's tables (who owes whom, fixed bills,
 * personal expenses, budgets with what is left). The script overwrites that area.
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
const BACKEND_VERSION = 17;
const HEADERS = ['Date', 'Category', 'Amount ($)', 'Card Used', 'Notes', 'Type', 'Joint Left ($)', 'ID', 'Expense For'];
const C = { DATE: 0, CATEGORY: 1, AMOUNT: 2, PAID_BY: 3, NOTES: 4, TYPE: 5, BALANCE: 6, ID: 7, FOR: 8 };
const TYPES = ['Joint', 'Fixed', 'Personal', 'Add funds', 'Set balance', 'Personal budget'];
// Row colors: Personal in blues by whose expense, Fixed bills in oranges by whose card (V lighter, K darker).
const COLORS = {
  personalV: '#dbeafe',
  personalK: '#93c5fd',
  fixedV: '#fed7aa',
  fixedK: '#fb923c',
};
const MONEY = '$#,##0.00';
const RECENT_COUNT = 5;
const SUMMARY_COL = 10; // column J

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
      if (body.action === 'add') {
        if (isCar) addCar_(carSheet, validateCar_(body.entry || {}));
        else {
          const entry = validate_(body.entry || {});
          addEntry_(entry);
          touched.push(entry.date.slice(0, 7));
        }
      } else if (body.action === 'delete') {
        if (isCar) deleteCar_(carSheet, String(body.id || ''));
        else {
          const key = deleteEntry_(String(body.id || ''));
          if (key) touched.push(key);
        }
      } else if (body.action !== 'state') {
        throw new Error('Unknown action.');
      }
      result = state_(today.slice(0, 7), touched);
      result.car = carState_(carSheet);
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
  const header = sheet.getRange(1, 1, 1, HEADERS.length);
  if (header.getValues()[0].join('|') !== HEADERS.join('|')) {
    header.setValues([HEADERS]).setFontWeight('bold');
    sheet.setFrozenRows(1);
    sheet.hideColumns(C.ID + 1);
  }
  return sheet;
}

// Every month tab, oldest first.
function monthTabs_() {
  return SpreadsheetApp.getActiveSpreadsheet().getSheets()
    .map((s) => ({ sheet: s, key: keyOfTab_(s.getName()) }))
    .filter((t) => t.key)
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

  const date = String(b.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Invalid date.');

  const amount = Number(b.amount);
  if (!isFinite(amount)) throw new Error('Invalid amount.');
  if (amount === 0 && type !== 'Set balance') throw new Error('Amount cannot be 0.');
  if (isPersonalBudget && amount < 0) throw new Error('A budget cannot be negative.');

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

  let category = String(b.category || '').trim();
  if (!category) {
    if (isPersonalBudget) category = expenseFor + "'s personal budget";
    else if (!isFunds) throw new Error('Category is required.');
    else category = type === 'Set balance' ? 'Balance set' : 'Funds added';
  }

  return {
    id: String(b.id || Utilities.getUuid()).slice(0, 64),
    date: date, // the sheet turns yyyy-mm-dd text into a real date
    category: safeText_(category.slice(0, 200)),
    amount: Math.round(amount * 100) / 100,
    paidBy: paidBy,
    notes: safeText_(String(b.notes || '').trim().slice(0, 500)),
    type: type,
    expenseFor: expenseFor,
  };
}

// Text starting with = + - @ would be read as a formula.
function safeText_(s) {
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function addEntry_(entry) {
  const sheet = monthSheet_(entry.date.slice(0, 7), true);
  // Retries from the phone's offline queue reuse the same id; save once.
  if (ids_(sheet).indexOf(entry.id) !== -1) return;
  const row = nextRow_(sheet);
  sheet.getRange(row, 1, 1, HEADERS.length)
    .setValues([[entry.date, entry.category, entry.amount, entry.paidBy, entry.notes, entry.type, '', entry.id, entry.expenseFor]]);
  sheet.getRange(row, C.DATE + 1).setNumberFormat('yyyy-mm-dd');
  sheet.getRange(row, C.AMOUNT + 1).setNumberFormat(MONEY);
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

// First empty row under the data in A:I (the tables from column J do not count).
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
  });
  if (changed) {
    sheet.getRange(2, C.TYPE + 1, rows.length, 2).setValues(rows.map((r) => [r[C.TYPE], r[C.BALANCE]]));
    sheet.getRange(2, C.BALANCE + 1, rows.length, 1).setNumberFormat(MONEY);
  }
  colorRows_(sheet, rows);
  return rows;
}

function rowColor_(r) {
  if (isEmptyRow_(r)) return null;
  if (r[C.TYPE] === 'Personal') return owner_(r) === 'K' ? COLORS.personalK : COLORS.personalV;
  if (r[C.TYPE] === 'Fixed') return r[C.PAID_BY] === 'K' ? COLORS.fixedK : COLORS.fixedV;
  return null; // Joint and budget rows stay plain
}

// Whose Personal expense this is (rows saved before Expense For existed belong to the card owner).
function owner_(r) {
  const f = String(r[C.FOR] || '').trim().toUpperCase();
  return f === 'V' || f === 'K' ? f : String(r[C.PAID_BY]);
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
    v: 0, k: 0, fixed: 0, fv: 0, fk: 0, personal: 0, pv: 0, pk: 0, kOnK: 0, kOnV: 0, vOnV: 0, vOnK: 0 };
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
  const fSplit = round2_(p.fixed / 2);
  const s = {
    split: split,
    vShare: round2_(p.v - split),
    kShare: round2_(p.k - split),
    fSplit: fSplit,
    fvShare: round2_(p.fv - fSplit),
    fkShare: round2_(p.fk - fSplit),
  };
  const pn = round2_(p.personal || 0);
  s.settle = settleText_(s.vShare, s.kShare);
  s.fixedSettle = settleText_(s.fvShare, s.fkShare);
  s.personalSettle = settleText_(pn, -pn);
  s.overall = settleText_(round2_(s.vShare + s.fvShare + pn), round2_(s.kShare + s.fkShare - pn));
  return s;
}

// Columns J onward of a month tab: who owes whom, fixed bills, personal expenses, and the month's
// budgets with what is left, plus a color legend.
function writeMonthSummary_(sheet, key, p, pb) {
  const WIDTH = 5; // J:N
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
    blank(),                                                                          // 9
    line('Fixed bills'),                                                              // 10
    line('V paid', 'K paid', 'Total'),                                                // 11
    line(p.fv, p.fk, p.fixed),                                                        // 12
    line('Settle up', s.fixedSettle),                                                 // 13
    blank(),                                                                          // 14
    line('Personal expenses'),                                                        // 15
    line('', 'Own card', "Other's card (owed in full)"),                              // 16
    line("K's expenses", p.kOnK, p.kOnV),                                             // 17
    line("V's expenses", p.vOnV, p.vOnK),                                             // 18
    line('Settle up', s.personalSettle),                                              // 19
    line('Overall (joint + fixed + personal)', s.overall),                            // 20
    blank(),                                                                          // 21
    line('Budgets for ' + monthLabel_(key)),                                          // 22
    line('Budget for', 'Budget', 'Spent', 'Left'),                                    // 23
    p.hasBudget ? line('Joint', budget, p.spent, round2_(budget - p.spent)) : line('Joint', 'not set', p.spent, ''), // 24
    pbLine('V'),                                                                      // 25
    pbLine('K'),                                                                      // 26
    blank(),                                                                          // 27
    line('Colors'),                                                                   // 28
    line('Joint', 'no color'),                                                        // 29
    line('Personal V', 'expense for V'),                                              // 30
    line('Personal K', 'expense for K'),                                              // 31
    line('Fixed V', "V's card"),                                                      // 32
    line('Fixed K', "K's card"),                                                      // 33
  ];
  // Clear the whole area first: rows deleted near the top can shift old values and colors into it.
  const area = sheet.getRange(1, SUMMARY_COL, Math.max(sheet.getLastRow(), out.length), WIDTH);
  area.clearContent();
  area.clearFormat();
  sheet.getRange(1, SUMMARY_COL, out.length, WIDTH).setValues(out);

  const cell = (row, col, rows, cols) => sheet.getRange(row, SUMMARY_COL + col, rows || 1, cols || 1);
  [3, 5, 12].forEach((row) => cell(row, 0, 1, 3).setNumberFormat(MONEY));
  cell(17, 1, 2, 2).setNumberFormat(MONEY);
  cell(24, 1, 3, 3).setNumberFormat(MONEY);
  [1, 10, 15, 22, 28].forEach((row) => cell(row, 0).setFontWeight('bold').setFontSize(12));
  [2, 4, 11, 16].forEach((row) => cell(row, 0, 1, 3).setFontWeight('bold').setBackground('#f3f4f6'));
  cell(23, 0, 1, 4).setFontWeight('bold').setBackground('#f3f4f6');
  cell(24, 3, 3, 1).setFontWeight('bold');
  cell(17, 0, 2, 1).setFontWeight('bold');
  [6, 7, 8, 13, 19, 20].forEach((row) => cell(row, 0, 1, 2).setFontWeight('bold'));
  cell(30, 0).setBackground(COLORS.personalV);
  cell(31, 0).setBackground(COLORS.personalK);
  cell(32, 0).setBackground(COLORS.fixedV);
  cell(33, 0).setBackground(COLORS.fixedK);
}

// The "Sirikh" tab: one row per month, newest first. The last column is what was left of the
// month's joint budget.
function writeOverview_(months) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(OVERVIEW_TAB) || ss.insertSheet(OVERVIEW_TAB, 0);
  const HEAD = ['Month', 'Tab', 'Joint budget', 'Joint spent', 'Fixed bills', 'V personal spent', 'K personal spent',
    'V personal left', 'K personal left', 'Joint settle', 'Fixed settle', 'Personal settle', 'Overall settle', 'Joint left'];
  const W = HEAD.length;
  const line = (...cells) => cells.concat(new Array(W - cells.length).fill(''));
  const out = [
    line('Sirikh: month by month'),
    line('Each month has its own tab. Budgets reset on the 1st. This tab is rebuilt on every save; do not type here.'),
    line(),
    HEAD,
  ];
  months.slice().reverse().forEach((m) => {
    const p = m.p;
    const s = shares_(p);
    const budget = round2_(p.start + p.added);
    const left = (b) => (b ? b.remaining : 'not set');
    out.push([monthLabel_(m.key), tabName_(m.key), p.hasBudget ? budget : 'not set', p.spent, p.fixed, p.pv, p.pk,
      left(m.pb.V), left(m.pb.K), s.settle, s.fixedSettle, s.personalSettle, s.overall,
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
    sheet.getRange(5, 3, months.length, 7).setNumberFormat(MONEY);
    sheet.getRange(5, W, months.length, 1).setNumberFormat(MONEY).setFontWeight('bold');
  }
}

// Recalculates the touched months (and writes their tables), rebuilds the overview, and returns
// what the app shows for the current month.
function state_(current, touched) {
  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  const months = monthTabs_().map((t) => {
    const hit = touched.indexOf(t.key) !== -1;
    const rows = hit ? recompute_(t.sheet) : readRows_(t.sheet);
    const p = period_(rows, t.key);
    const pb = personalBudgets_(rows, t.key);
    if (hit) writeMonthSummary_(t.sheet, t.key, p, pb);
    return { key: t.key, rows: rows, p: p, pb: pb };
  });
  writeOverview_(months);
  const cur = months.find((m) => m.key === current) || { key: current, rows: [], p: emptyPeriod_(current), pb: { V: null, K: null } };
  const prev = months.find((m) => m.key === previousKey_(current));

  // Latest entries across every month: newest date first, then most recently added.
  const all = [];
  months.forEach((m) => m.rows.forEach((r, i) => { if (!isEmptyRow_(r)) all.push({ r: r, key: m.key, i: i, d: formatDate_(r[C.DATE], tz) }); }));
  all.sort((a, b) => (a.d !== b.d ? (a.d < b.d ? 1 : -1) : a.key !== b.key ? (a.key < b.key ? 1 : -1) : b.i - a.i));

  const budget = round2_(cur.p.start + cur.p.added);
  return {
    ok: true,
    version: BACKEND_VERSION,
    month: current,
    balance: cur.p.hasBudget ? round2_(budget - cur.p.spent) : 0,
    hasBalance: cur.p.hasBudget,
    period: cur.p,
    personalBudgets: cur.pb,
    // Start-of-month prompt: the joint budget, and personal budgets that existed last month.
    needsBudget: {
      joint: !cur.p.hasBudget,
      V: !cur.pb.V && !!(prev && prev.pb.V),
      K: !cur.pb.K && !!(prev && prev.pb.K),
    },
    recent: all.slice(0, RECENT_COUNT).map((x) => ({
      id: String(x.r[C.ID]),
      date: x.d,
      category: String(x.r[C.CATEGORY]),
      amount: toNumber_(x.r[C.AMOUNT]),
      paidBy: String(x.r[C.PAID_BY]),
      notes: String(x.r[C.NOTES]),
      type: normalizeType_(x.r[C.TYPE]),
      balance: x.r[C.BALANCE],
      expenseFor: ['Personal', 'Personal budget'].indexOf(normalizeType_(x.r[C.TYPE])) !== -1 ? owner_(x.r) : '',
    })),
  };
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
  const category = CAR_CATEGORIES.indexOf(b.category) !== -1 ? b.category : '';
  if (!category) throw new Error('Pick a car category.');
  const paidBy = String(b.paidBy || '');
  if (paidBy !== 'V' && paidBy !== 'K') throw new Error('Card used must be V or K.');
  const expenseFor = b.expenseFor === undefined || b.expenseFor === '' ? paidBy : String(b.expenseFor);
  if (['V', 'K', 'Joint'].indexOf(expenseFor) === -1) throw new Error('Expense for must be V, K or Joint.');
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
    vendor: safeText_(String(b.vendor || '').trim().slice(0, 200)),
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
  sheet.getRange(row, 1, 1, CAR_HEADERS.length).setValues([[e.date, e.category, e.vendor, e.amount, e.paidBy,
    e.odometer, '', e.rangeLeft, '', e.gallons, e.pricePerGallon, '', '', e.notes, e.id, e.expenseFor,
    e.fill, e.missedBefore]]);
}

function deleteCar_(sheet, id) {
  if (!id) throw new Error('Missing id.');
  const i = carIds_(sheet).lastIndexOf(id);
  if (i !== -1) sheet.deleteRow(i + 2);
}

const blankIfNot_ = (v) => (v === '' || v === null || v === undefined ? '' : v);
const isPartial_ = (r) => String(r[K.FILL]).trim().toLowerCase() === 'partial';
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
    v: 0, k: 0, total: 0, owed: 0, turns: { V: 0, K: 0, Joint: 0 },
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
  ['v', 'k', 'total', 'owed', 'gallons', 'fuelSpend', 'mpg', 'bestMpg', 'worstMpg', 'avgMilesPerTank', 'avgEffRange', 'milesTracked']
    .forEach((key) => { s[key] = round2_(s[key]); });
  ['avgPpg', 'fuelCpm', 'totalCpm'].forEach((key) => { s[key] = Math.round(s[key] * 1000) / 1000; });
  Object.keys(s.byCategory).forEach((key) => { s.byCategory[key] = round2_(s.byCategory[key]); });
  s.settle = settleText_(s.owed, -s.owed);
  s.recent = data.slice(-RECENT_COUNT).reverse().map((r) => ({
    id: String(r[K.ID]), date: formatDate_(r[K.DATE], tz), category: String(r[K.CATEGORY]), vendor: String(r[K.VENDOR]),
    amount: toNumber_(r[K.AMOUNT]), paidBy: String(r[K.PAID_BY]), notes: String(r[K.NOTES]),
    odometer: r[K.ODO], miles: r[K.MILES], mpg: r[K.MPG], eff: r[K.EFF], gallons: r[K.GAL], ppg: r[K.PPG],
    expenseFor: carOwner_(r), fill: r[K.CATEGORY] === 'Fuel' ? (isPartial_(r) ? 'Partial' : 'Full') : '',
    missedBefore: isMarkedMissed_(r),
  }));
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
    line('Owed from joint or other-card costs', s.settle),              // 4
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
  const stats = carStats_(res.rows, res.math);
  writeCarSummary_(sheet, stats);
  return stats;
}
