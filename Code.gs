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
 * Tab "Sirikh" (created automatically):
 *   Date | Category | Amount ($) | Card Used | Notes | Type | Balance ($) | ID | Expense For
 *
 * Card Used is whose card paid. Expense For is whose expense it is: blank (shared) for Joint and
 * Fixed, V or K for Personal. A Personal expense paid on the other person's card is owed back in
 * full (K's ramen on V's card: K owes V the whole amount).
 *
 * Type is one of:
 *   Joint        shared day-to-day expense, deducted from the monthly budget      (no color)
 *   Fixed        rent, utilities and other bills, tracked separately (orange: V light, K darker)
 *   Personal     logged only                                                     (blue: V light, K darker)
 *   Set balance      starts a new joint monthly budget (only Joint expenses come out of it)
 *   Personal budget  starts a new personal budget for V or K (Expense For); that person's Personal
 *                    expenses come out of it, whoever's card paid. Fixed and Sonata have no budget.
 *   Add funds    adds to the budget (only from hand edits; the app no longer offers it)
 * Balance ($) and the row colors are recalculated by this script from top to bottom, so edits
 * made by hand in the tab are picked up automatically. Negative amounts are refunds.
 *
 * Columns J onward hold the same tables as the app, rebuilt on every save:
 *   Who owes whom, Fixed bills and Monthly budget for the current period (since the last
 *   "Set balance" row), a color legend, and a History table with one row per budget period.
 * The script overwrites that area, so do not type in it.
 *
 * Car expenses and fuel tracking live in their own "Sonata" tab (see the Sonata section
 * at the end of this file). They never mix with the Sirikh tab, its budget or its split.
 */

const TAB_NAME = 'Sirikh';
// The app checks this. Bump it whenever the app starts depending on something new in this file.
const BACKEND_VERSION = 12;
const HEADERS = ['Date', 'Category', 'Amount ($)', 'Card Used', 'Notes', 'Type', 'Balance ($)', 'ID', 'Expense For'];
const C = { DATE: 0, CATEGORY: 1, AMOUNT: 2, PAID_BY: 3, NOTES: 4, TYPE: 5, BALANCE: 6, ID: 7, FOR: 8 };
const TYPES = ['Joint', 'Fixed', 'Personal', 'Add funds', 'Set balance', 'Personal budget'];
// Row colors by who paid: Personal in blues, Fixed bills in oranges (V lighter, K darker).
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
      const sheet = getSheet_();
      const carSheet = getCarSheet_();
      const isCar = body.table === 'car';
      if (body.action === 'add') {
        if (isCar) addCar_(carSheet, validateCar_(body.entry || {}));
        else addEntry_(sheet, validate_(body.entry || {}));
      } else if (body.action === 'delete') {
        if (isCar) deleteCar_(carSheet, String(body.id || ''));
        else deleteEntry_(sheet, String(body.id || ''));
      } else if (body.action !== 'state') {
        throw new Error('Unknown action.');
      }
      result = state_(sheet);
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

// Simple trigger: keeps Balance ($) correct when the tab is edited by hand.
function onEdit(e) {
  const sheet = e && e.range && e.range.getSheet();
  if (!sheet) return;
  if (sheet.getName() === TAB_NAME && e.range.getColumn() < SUMMARY_COL) {
    const rows = recompute_(sheet);
    writeSummary_(sheet, periods_(rows), personalBudgets_(rows));
  }
  if (sheet.getName() === CAR_TAB && e.range.getColumn() < CAR_SUMMARY_COL) carState_(sheet);
}

function checkKey_(key) {
  const expected = PropertiesService.getScriptProperties().getProperty('SIRIKH_KEY');
  if (!expected) throw new Error('SIRIKH_KEY is not set in Script properties.');
  if (key !== expected) throw new Error('Wrong key.');
}

function getSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(TAB_NAME) || ss.insertSheet(TAB_NAME);
  const header = sheet.getRange(1, 1, 1, HEADERS.length);
  if (header.getValues()[0].join('|') !== HEADERS.join('|')) {
    header.setValues([HEADERS]).setFontWeight('bold');
    sheet.setFrozenRows(1);
    sheet.hideColumns(C.ID + 1);
  }
  return sheet;
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

function addEntry_(sheet, entry) {
  // Retries from the phone's offline queue reuse the same id; save once.
  if (ids_(sheet).indexOf(entry.id) !== -1) return;
  const row = nextRow_(sheet);
  sheet.getRange(row, 1, 1, HEADERS.length)
    .setValues([[entry.date, entry.category, entry.amount, entry.paidBy, entry.notes, entry.type, '', entry.id, entry.expenseFor]]);
  sheet.getRange(row, C.DATE + 1).setNumberFormat('yyyy-mm-dd');
  sheet.getRange(row, C.AMOUNT + 1).setNumberFormat('$#,##0.00');
}

function deleteEntry_(sheet, id) {
  if (!id) throw new Error('Missing id.');
  const i = ids_(sheet).lastIndexOf(id);
  if (i !== -1) sheet.deleteRow(i + 2); // already gone is fine (retried delete)
}

// First empty row under the data in A:H (the summary block in J:O does not count).
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

// Recalculates Type (blank > Joint), Balance ($) and row colors; writes only what changed.
function recompute_(sheet) {
  const rows = readRows_(sheet);
  if (!rows.length) return rows;
  let balance = 0;
  let changed = false;
  rows.forEach((r) => {
    if (isEmptyRow_(r)) {
      if (r[C.BALANCE] !== '') changed = true;
      r[C.BALANCE] = '';
      return;
    }
    const type = normalizeType_(r[C.TYPE]);
    const amount = toNumber_(r[C.AMOUNT]);
    if (type === 'Set balance') balance = amount;
    else if (type === 'Add funds') balance += amount;
    else if (type === 'Joint') balance -= amount;
    balance = round2_(balance);
    if (r[C.TYPE] !== type || r[C.BALANCE] !== balance) changed = true;
    r[C.TYPE] = type;
    r[C.BALANCE] = balance;
  });
  if (changed) {
    sheet.getRange(2, C.TYPE + 1, rows.length, 2).setValues(rows.map((r) => [r[C.TYPE], r[C.BALANCE]]));
    sheet.getRange(2, C.BALANCE + 1, rows.length, 1).setNumberFormat('$#,##0.00');
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

function state_(sheet) {
  const rows = recompute_(sheet);
  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  const data = rows.filter((r) => !isEmptyRow_(r));
  const all = periods_(rows);
  const period = all.length ? all[all.length - 1] : emptyPeriod_();
  writeSummary_(sheet, all, personalBudgets_(rows));
  return {
    ok: true,
    version: BACKEND_VERSION,
    balance: data.length ? data[data.length - 1][C.BALANCE] : 0,
    hasBalance: period.since !== '',
    personalBudgets: personalBudgets_(rows),
    period: period,
    recent: data.slice(-RECENT_COUNT).reverse().map((r) => ({
      id: String(r[C.ID]),
      date: formatDate_(r[C.DATE], tz),
      category: String(r[C.CATEGORY]),
      amount: toNumber_(r[C.AMOUNT]),
      paidBy: String(r[C.PAID_BY]),
      notes: String(r[C.NOTES]),
      type: r[C.TYPE],
      balance: r[C.BALANCE],
      expenseFor: r[C.TYPE] === 'Personal' || r[C.TYPE] === 'Personal budget' ? owner_(r) : '',
    })),
  };
}

// Each person's current personal budget: starts at their latest "Personal budget" row; every
// Personal expense for that person after it (whoever's card paid) comes out of it.
function personalBudgets_(rows) {
  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  const out = { V: null, K: null };
  rows.filter((r) => !isEmptyRow_(r)).forEach((r) => {
    const who = owner_(r);
    if (who !== 'V' && who !== 'K') return;
    if (r[C.TYPE] === 'Personal budget') {
      out[who] = { since: formatDate_(r[C.DATE], tz), budget: toNumber_(r[C.AMOUNT]), spent: 0 };
    } else if (r[C.TYPE] === 'Personal' && out[who]) {
      out[who].spent += toNumber_(r[C.AMOUNT]);
    }
  });
  ['V', 'K'].forEach((who) => {
    const b = out[who];
    if (!b) return;
    b.spent = round2_(b.spent);
    b.remaining = round2_(b.budget - b.spent);
  });
  return out;
}

function emptyPeriod_() {
  // personal: net of Personal expenses paid on the other's card (positive = K owes V)
  // pv / pk: Personal expenses for V / K during the period (for History)
  return { since: '', start: 0, added: 0, spent: 0, v: 0, k: 0, fixed: 0, fv: 0, fk: 0, personal: 0, pv: 0, pk: 0 };
}

// One entry per budget period. A period starts at a "Set balance" row and runs until the next one.
function periods_(rows) {
  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  const list = [];
  let p = null;
  rows.filter((r) => !isEmptyRow_(r)).forEach((r) => {
    const amount = toNumber_(r[C.AMOUNT]);
    if (r[C.TYPE] === 'Set balance') {
      p = emptyPeriod_();
      p.since = formatDate_(r[C.DATE], tz);
      p.start = amount;
      list.push(p);
      return;
    }
    if (!p) return; // rows before the first budget are not part of any period
    if (r[C.TYPE] === 'Add funds') p.added += amount;
    if (r[C.TYPE] === 'Joint') {
      p.spent += amount;
      if (r[C.PAID_BY] === 'V') p.v += amount;
      if (r[C.PAID_BY] === 'K') p.k += amount;
    }
    if (r[C.TYPE] === 'Fixed') {
      p.fixed += amount;
      if (r[C.PAID_BY] === 'V') p.fv += amount;
      if (r[C.PAID_BY] === 'K') p.fk += amount;
    }
    if (r[C.TYPE] === 'Personal') {
      p.personal += personalOwed_(owner_(r), r[C.PAID_BY], amount);
      if (owner_(r) === 'V') p.pv += amount;
      if (owner_(r) === 'K') p.pk += amount;
    }
  });
  list.forEach((x) => Object.keys(x).forEach((k) => { if (typeof x[k] === 'number') x[k] = round2_(x[k]); }));
  return list;
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

// Rebuilds the tables in columns J onward: the same "Who owes whom" and "Fixed bills" tables
// as the app, the monthly budget, a color legend, and a history row for every budget period.
function writeSummary_(sheet, periods, personal) {
  const WIDTH = 14; // J:W
  const p = periods.length ? periods[periods.length - 1] : emptyPeriod_();
  const s = shares_(p);
  const budget = round2_(p.start + p.added);
  const pb = personal || { V: null, K: null };
  const pbLine = (who) => {
    const b = pb[who];
    return b ? line(who + ' personal', b.budget, b.spent, b.remaining, 'Since ' + b.since) : line(who + ' personal', 'not set');
  };
  const blank = () => new Array(WIDTH).fill('');
  const line = (...cells) => cells.concat(new Array(WIDTH - cells.length).fill(''));

  const out = [
    line('Who owes whom', '', '', p.since ? 'Since ' + p.since : 'No budget set'),    // 1
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
    line('Monthly budgets'),                                                          // 15
    line('Budget for', 'Budget', 'Spent', 'Remaining'),                               // 16
    line('Joint', budget, p.spent, round2_(budget - p.spent)),                        // 17
    pbLine('V'),                                                                      // 18
    pbLine('K'),                                                                      // 19
    blank(),                                                                          // 20
    line('Colors'),                                                                   // 21
    line('Joint', 'no color'),                                                        // 22
    line('Personal V', 'expense for V'),                                              // 23
    line('Personal K', 'expense for K'),                                              // 24
    line('Fixed V', "V's card"),                                                      // 25
    line('Fixed K', "K's card"),                                                      // 26
    blank(),                                                                          // 27
  ];
  const historyTitle = out.length + 1;
  out.push(line('History'));
  out.push(line('Since', 'Budget', 'Joint spent', 'V paid', 'K paid', "V's share", "K's share",
    'Settle up', 'Fixed total', 'Fixed settle', 'Personal settle', 'Overall', 'V personal spent', 'K personal spent'));
  const historyStart = out.length + 1;
  periods.slice().reverse().forEach((x) => {
    const h = shares_(x);
    out.push([x.since, round2_(x.start + x.added), x.spent, x.v, x.k, h.vShare, h.kShare,
      h.settle, x.fixed, h.fixedSettle, h.personalSettle, h.overall, x.pv, x.pk]);
  });

  // Clear the whole area first: rows deleted near the top can shift old values and colors into it.
  const last = Math.max(sheet.getLastRow(), out.length);
  const area = sheet.getRange(1, SUMMARY_COL, last, WIDTH);
  area.clearContent();
  area.clearFormat();
  sheet.getRange(1, SUMMARY_COL, out.length, WIDTH).setValues(out);

  const cell = (row, col, rows, cols) => sheet.getRange(row, SUMMARY_COL + col, rows || 1, cols || 1);
  [3, 5, 12].forEach((row) => cell(row, 0, 1, 3).setNumberFormat(MONEY));
  cell(17, 1, 3, 3).setNumberFormat(MONEY);
  [1, 10, 15, 21, historyTitle].forEach((row) => cell(row, 0).setFontWeight('bold').setFontSize(12));
  [2, 4, 11, historyTitle + 1].forEach((row) => cell(row, 0, 1, row === historyTitle + 1 ? WIDTH : 3)
    .setFontWeight('bold').setBackground('#f3f4f6'));
  cell(16, 0, 1, 4).setFontWeight('bold').setBackground('#f3f4f6');
  [6, 7, 8, 13].forEach((row) => cell(row, 0, 1, 2).setFontWeight('bold'));
  cell(23, 0).setBackground(COLORS.personalV);
  cell(24, 0).setBackground(COLORS.personalK);
  cell(25, 0).setBackground(COLORS.fixedV);
  cell(26, 0).setBackground(COLORS.fixedK);
  if (periods.length) {
    cell(historyStart, 1, periods.length, 6).setNumberFormat(MONEY);
    cell(historyStart, 8, periods.length, 1).setNumberFormat(MONEY);
    cell(historyStart, 12, periods.length, 2).setNumberFormat(MONEY);
  }
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
//   Range Left | Effective Range | Gallons | Price/Gal | MPG | Cost/Mile | Notes | ID | Expense For
//
// Expense For says whose turn or cost it is: V, K or Joint (blank = the card owner's own turn).
// V and K take turns (V three tanks, K the fourth), so their own turns create nothing owed.
//   Joint (a trip fill-up, a shared repair): split 50/50, the other person owes half to the card owner.
//   A turn paid on the other person's card: owed back in full.
//
// Calculated by this script for Fuel rows (ordered by odometer):
//   Miles Driven    = this odometer - previous fill-up's odometer
//   Effective Range = Miles Driven + Range Left (how far that tank would have gone)
//   MPG             = Miles Driven / Gallons of this fill-up
//   Cost/Mile       = Amount / Miles Driven
// A fill-up covering more than 1.6x a typical tank (a missed fill-up in between) keeps its miles
// but is left out of MPG, Cost/Mile and Effective Range.
// Columns Q onward hold the car split (owed by V / K), fuel stats, spend by category,
// monthly totals and charts. The script overwrites that area.
// ======================================================================================

const CAR_TAB = 'Sonata';
const CAR_HEADERS = ['Date', 'Category', 'Station / Vendor', 'Amount ($)', 'Card Used', 'Odometer', 'Miles Driven',
  'Range Left', 'Effective Range', 'Gallons', 'Price/Gal', 'MPG', 'Cost/Mile', 'Notes', 'ID', 'Expense For'];
const K = { DATE: 0, CATEGORY: 1, VENDOR: 2, AMOUNT: 3, PAID_BY: 4, ODO: 5, MILES: 6, RANGE: 7, EFF: 8,
  GAL: 9, PPG: 10, MPG: 11, CPM: 12, NOTES: 13, ID: 14, FOR: 15 };
const CAR_CATEGORIES = ['Fuel', 'Servicing', 'Repairs', 'Mods', 'Insurance', 'Registration/Tax',
  'Tolls/Parking', 'Car wash', 'Misc'];
const CAR_SUMMARY_COL = 17; // column Q
const CAR_DATA_ROW = 40;    // monthly and fuel-log blocks used by the charts start here
const CAR_CHART_ROWS = 300; // rows the charts read (room for years of fill-ups)
const OLD_CAR_TAB = 'HyundaiSonata2026';

function getCarSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(CAR_TAB);
  if (!sheet) sheet = ss.insertSheet(CAR_TAB);
  const isEmpty = readCarRows_(sheet).every(isEmptyCarRow_);
  const header = sheet.getRange(1, 1, 1, CAR_HEADERS.length);
  if (header.getValues()[0].join('|') !== CAR_HEADERS.join('|')) {
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
      num(cells[4]), '', num(cells[6]), '', num(cells[8]), num(cells[9]), '', '', String(cells[10]).trim(), Utilities.getUuid(), '']);
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
  const gallons = opt(b.gallons, 'gallons');
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
    odometer: category === 'Fuel' ? opt(b.odometer, 'odometer') : '',
    rangeLeft: category === 'Fuel' ? opt(b.rangeLeft, 'range left') : '',
    gallons: category === 'Fuel' ? gallons : '',
    pricePerGallon: category === 'Fuel' ? ppg : '',
    notes: safeText_(String(b.notes || '').trim().slice(0, 500)),
    expenseFor: expenseFor,
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
    e.odometer, '', e.rangeLeft, '', e.gallons, e.pricePerGallon, '', '', e.notes, e.id, e.expenseFor]]);
}

function deleteCar_(sheet, id) {
  if (!id) throw new Error('Missing id.');
  const i = carIds_(sheet).lastIndexOf(id);
  if (i !== -1) sheet.deleteRow(i + 2);
}

const blankIfNot_ = (v) => (v === '' || v === null || v === undefined ? '' : v);

// Fills Miles Driven, Effective Range, MPG and Cost/Mile; writes only if something changed.
function recomputeCar_(sheet) {
  const rows = readCarRows_(sheet);
  if (!rows.length) return rows;
  const fuel = [];
  rows.forEach((r, i) => {
    if (!isEmptyCarRow_(r) && r[K.CATEGORY] === 'Fuel' && r[K.ODO] !== '' && isFinite(toNumber_(r[K.ODO]))) fuel.push(i);
  });
  fuel.sort((a, b) => toNumber_(rows[a][K.ODO]) - toNumber_(rows[b][K.ODO]));
  const calc = rows.map(() => ({ miles: '', eff: '', mpg: '', cpm: '' }));
  const milesOf = fuel.map((idx, n) => (n === 0 ? 0 : round2_(toNumber_(rows[idx][K.ODO]) - toNumber_(rows[fuel[n - 1]][K.ODO]))));
  // A fill-up that was never logged makes the next one cover two tanks. Those (more than 1.6x a typical
  // tank) keep their miles but are left out of MPG, cost per mile and effective range.
  const sorted = milesOf.filter((m) => m > 0).sort((a, b) => a - b);
  const typical = sorted.length >= 3 ? sorted[Math.floor(sorted.length / 2)] : 0;
  fuel.forEach((idx, n) => {
    const miles = milesOf[n];
    if (n === 0 || miles <= 0) return; // first fill-up has nothing to compare with
    const r = rows[idx];
    if (typical && miles > typical * 1.6) {
      calc[idx] = { miles: miles, eff: '', mpg: '', cpm: '' };
      return;
    }
    const gal = r[K.GAL] === '' ? 0 : toNumber_(r[K.GAL]);
    const amount = toNumber_(r[K.AMOUNT]);
    calc[idx] = {
      miles: miles,
      eff: r[K.RANGE] === '' ? '' : round2_(miles + toNumber_(r[K.RANGE])),
      mpg: gal > 0 ? round2_(miles / gal) : '',
      cpm: amount > 0 ? Math.round((amount / miles) * 1000) / 1000 : '',
    };
  });
  let changed = false;
  const block = rows.map((r, i) => {
    const c = calc[i];
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
  return rows;
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

function carStats_(rows) {
  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  const data = rows.filter((r) => !isEmptyCarRow_(r));
  const n = (v) => (v === '' ? 0 : toNumber_(v));
  const s = {
    v: 0, k: 0, total: 0, owed: 0, turns: { V: 0, K: 0, Joint: 0 },
    fills: 0, gallons: 0, fuelSpend: 0, avgPpg: 0,
    mpg: 0, bestMpg: 0, worstMpg: 0, avgMilesPerTank: 0, avgEffRange: 0,
    fuelCpm: 0, totalCpm: 0, milesTracked: 0, lastOdometer: 0,
    lastFill: null, byCategory: {}, monthly: [], series: [], recent: [],
  };
  const months = {};
  let mpgMiles = 0, mpgGallons = 0, cpmMiles = 0, cpmSpend = 0, effSum = 0, effCount = 0, ppgSpend = 0, ppgGallons = 0;
  let minOdo = Infinity, maxOdo = -Infinity;
  const mpgs = [];
  data.forEach((r) => {
    const amount = toNumber_(r[K.AMOUNT]);
    const date = formatDate_(r[K.DATE], tz);
    s.total += amount;
    if (r[K.PAID_BY] === 'V') s.v += amount;
    if (r[K.PAID_BY] === 'K') s.k += amount;
    const owner = carOwner_(r);
    s.owed += carOwed_(owner, r[K.PAID_BY], amount);
    if (r[K.CATEGORY] === 'Fuel' && s.turns[owner] !== undefined) s.turns[owner]++;
    s.byCategory[r[K.CATEGORY]] = (s.byCategory[r[K.CATEGORY]] || 0) + amount;
    const month = date.slice(0, 7);
    const m = months[month] || (months[month] = { month: month, fuel: 0, other: 0, total: 0, miles: 0, gallons: 0 });
    m.total += amount;
    if (r[K.CATEGORY] !== 'Fuel') { m.other += amount; return; }
    m.fuel += amount;
    s.fills++;
    s.fuelSpend += amount;
    if (r[K.GAL] !== '' && n(r[K.GAL]) > 0) { s.gallons += n(r[K.GAL]); ppgSpend += amount; ppgGallons += n(r[K.GAL]); }
    if (r[K.ODO] !== '') { minOdo = Math.min(minOdo, n(r[K.ODO])); maxOdo = Math.max(maxOdo, n(r[K.ODO])); }
    if (r[K.MILES] !== '') m.miles += n(r[K.MILES]);
    if (r[K.CPM] !== '') { cpmMiles += n(r[K.MILES]); cpmSpend += amount; }
    if (r[K.EFF] !== '') { effSum += n(r[K.EFF]); effCount++; }
    if (r[K.MPG] !== '') {
      mpgMiles += n(r[K.MILES]); mpgGallons += n(r[K.GAL]); m.gallons += n(r[K.GAL]);
      mpgs.push(n(r[K.MPG]));
      s.series.push({ date: date, odo: n(r[K.ODO]), mpg: n(r[K.MPG]), ppg: n(r[K.PPG]), cpm: n(r[K.CPM]) });
    }
  });
  s.series.sort((a, b) => a.odo - b.odo);
  const fuelByOdo = data.filter((r) => r[K.CATEGORY] === 'Fuel' && r[K.ODO] !== '')
    .sort((a, b) => n(a[K.ODO]) - n(b[K.ODO]));
  const last = fuelByOdo[fuelByOdo.length - 1];
  if (last) {
    s.lastFill = { date: formatDate_(last[K.DATE], tz), odometer: n(last[K.ODO]), miles: last[K.MILES], mpg: last[K.MPG],
      eff: last[K.EFF], station: String(last[K.VENDOR]) };
  }
  s.avgPpg = ppgGallons ? ppgSpend / ppgGallons : 0;
  s.mpg = mpgGallons ? mpgMiles / mpgGallons : 0;
  s.bestMpg = mpgs.length ? Math.max.apply(null, mpgs) : 0;
  s.worstMpg = mpgs.length ? Math.min.apply(null, mpgs) : 0;
  s.avgMilesPerTank = cpmMiles && s.series.length ? mpgMiles / s.series.length : 0;
  s.avgEffRange = effCount ? effSum / effCount : 0;
  s.fuelCpm = cpmMiles ? cpmSpend / cpmMiles : 0;
  s.milesTracked = maxOdo > minOdo ? maxOdo - minOdo : 0;
  s.lastOdometer = maxOdo > -Infinity ? maxOdo : 0;
  s.totalCpm = s.milesTracked ? s.total / s.milesTracked : 0;
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
    expenseFor: carOwner_(r),
  }));
  return s;
}

// Columns Q onward: what V and K have paid, fuel stats, spend by category, and the data the charts read.
function writeCarSummary_(sheet, s) {
  const WIDTH = 11; // Q:AA
  const line = (...cells) => cells.concat(new Array(WIDTH - cells.length).fill(''));
  const blank = () => line();
  const out = [
    line('Spent so far'),                                               // 1
    line('V paid', 'K paid', 'Total spent'),                            // 2
    line(s.v, s.k, s.total),                                            // 3
    line('Owed from joint or other-card costs', s.settle),              // 4
    line('Fuel stats'),                                                 // 5
    line('Average MPG', s.mpg),                                         // 6
    line('Best / worst MPG', s.bestMpg, s.worstMpg),                    // 7
    line('Average price per gallon', s.avgPpg),                         // 8
    line('Fuel cost per mile', s.fuelCpm),                              // 9
    line('Total car cost per mile', s.totalCpm),                        // 10
    line('Average miles per tank', s.avgMilesPerTank),                  // 11
    line('Average effective range', s.avgEffRange),                     // 12
    line('Fill-ups', s.fills),                                          // 13
    line('Gallons bought', s.gallons),                                  // 14
    line('Fuel spend', s.fuelSpend),                                    // 15
    line('Miles tracked', s.milesTracked),                              // 16
    line('Last odometer', s.lastOdometer),                              // 17
    line('Fill-ups by turn', 'V ' + s.turns.V, 'K ' + s.turns.K, 'Joint ' + s.turns.Joint), // 18
    line('Spend by category'),                                          // 19
  ];
  CAR_CATEGORIES.forEach((c) => out.push(line(c, s.byCategory[c] || 0))); // 20-28
  out.push(line('Total car spend', s.total));                            // 29
  while (out.length < CAR_DATA_ROW - 1) out.push(blank());
  out.push(line('Month', 'Fuel', 'Other', 'Total', 'Miles', 'MPG', '', 'Date', 'MPG', 'Price/Gal', 'Cost/Mile')); // 40
  const rowsNeeded = Math.max(s.monthly.length, s.series.length);
  for (let i = 0; i < rowsNeeded; i++) {
    const m = s.monthly[i];
    const f = s.series[i];
    out.push(line(m ? m.month : '', m ? m.fuel : '', m ? m.other : '', m ? m.total : '', m ? m.miles : '', m ? m.mpg : '', '',
      f ? f.date : '', f ? f.mpg : '', f ? f.ppg : '', f ? f.cpm : ''));
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
  [1, 5, 19].forEach((row) => cell(row, 0).setFontWeight('bold').setFontSize(12));
  cell(2, 0, 1, 3).setFontWeight('bold').setBackground('#f3f4f6');
  cell(40, 0, 1, WIDTH).setFontWeight('bold').setBackground('#f3f4f6');
  cell(3, 0, 1, 3).setNumberFormat(MONEY);
  cell(4, 0, 1, 2).setFontWeight('bold');
  [8, 9, 10].forEach((row) => cell(row, 1).setNumberFormat('$0.000'));
  cell(15, 1).setNumberFormat(MONEY);
  cell(20, 1, CAR_CATEGORIES.length + 1, 1).setNumberFormat(MONEY);
  cell(29, 0, 1, 2).setFontWeight('bold');
  ensureCarCharts_(sheet);
}

// Charts are created once and read fixed ranges, so they grow as rows are added.
function ensureCarCharts_(sheet) {
  if (sheet.getCharts().length) return;
  const col = (offset) => sheet.getRange(CAR_DATA_ROW, CAR_SUMMARY_COL + offset, CAR_CHART_ROWS, 1);
  const chartCol = CAR_SUMMARY_COL + 12; // column AC
  const charts = [
    { type: Charts.ChartType.LINE, x: 7, y: 8, title: 'MPG per fill-up', row: 1 },
    { type: Charts.ChartType.LINE, x: 7, y: 9, title: 'Price per gallon', row: 20 },
    { type: Charts.ChartType.LINE, x: 7, y: 10, title: 'Fuel cost per mile', row: 39 },
    { type: Charts.ChartType.COLUMN, x: 0, y: 3, title: 'Car spend per month', row: 58 },
  ];
  charts.forEach((c) => {
    sheet.insertChart(sheet.newChart()
      .setChartType(c.type)
      .addRange(col(c.x))
      .addRange(col(c.y))
      .setNumHeaders(1)
      .setOption('title', c.title)
      .setOption('legend', { position: 'none' })
      .setPosition(c.row, chartCol, 0, 0)
      .build());
  });
}

function carState_(sheet) {
  const rows = recomputeCar_(sheet);
  const stats = carStats_(rows);
  writeCarSummary_(sheet, stats);
  return stats;
}
