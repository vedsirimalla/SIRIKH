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
 *   Date | Category | Amount ($) | Paid By | Notes | Type | Balance ($) | ID
 *
 * Type is one of:
 *   Joint        shared day-to-day expense, deducted from the monthly budget      (no color)
 *   Fixed        rent, utilities and other bills, tracked separately from the budget (orange)
 *   Personal     logged only                                                     (blue: V light, K darker)
 *   Set balance  starts a new monthly budget
 *   Add funds    adds to the budget (only from hand edits; the app no longer offers it)
 * Balance ($) and the row colors are recalculated by this script from top to bottom, so edits
 * made by hand in the tab are picked up automatically. Negative amounts are refunds.
 *
 * Columns J onward hold the same tables as the app, rebuilt on every save:
 *   Who owes whom, Fixed bills and Monthly budget for the current period (since the last
 *   "Set balance" row), a color legend, and a History table with one row per budget period.
 * The script overwrites that area, so do not type in it.
 */

const TAB_NAME = 'Sirikh';
const HEADERS = ['Date', 'Category', 'Amount ($)', 'Paid By', 'Notes', 'Type', 'Balance ($)', 'ID'];
const C = { DATE: 0, CATEGORY: 1, AMOUNT: 2, PAID_BY: 3, NOTES: 4, TYPE: 5, BALANCE: 6, ID: 7 };
const TYPES = ['Joint', 'Fixed', 'Personal', 'Add funds', 'Set balance'];
// The app offers only these fixed bills; each has its own shade of orange (Rent strongest).
const FIXED_COLORS = {
  'Rent': '#fdba74',
  'Utilities': '#fed7aa',
  'Electricity': '#fcc896',
  'Wi-Fi': '#ffe0c2',
  'Misc': '#ffedd5',
};
const COLORS = {
  personalV: '#dbeafe', // light blue
  personalK: '#93c5fd', // darker blue
  fixedOther: '#ffedd5', // a fixed bill typed by hand with another name
};
const MONEY = '$#,##0.00';
const RECENT_COUNT = 5;
const SUMMARY_COL = 10; // column J

function doGet() {
  return ContentService.createTextOutput('Sirikh backend is running.');
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
      if (body.action === 'add') addEntry_(sheet, validate_(body.entry || {}));
      else if (body.action === 'delete') deleteEntry_(sheet, String(body.id || ''));
      else if (body.action !== 'state') throw new Error('Unknown action.');
      result = state_(sheet);
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
  if (!sheet || sheet.getName() !== TAB_NAME || e.range.getColumn() >= SUMMARY_COL) return;
  writeSummary_(sheet, periods_(recompute_(sheet)));
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

  const date = String(b.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Invalid date.');

  const amount = Number(b.amount);
  if (!isFinite(amount)) throw new Error('Invalid amount.');
  if (amount === 0 && type !== 'Set balance') throw new Error('Amount cannot be 0.');

  const paidBy = String(b.paidBy || '');
  const payers = isFunds ? ['V', 'K', 'Both'] : ['V', 'K'];
  if (payers.indexOf(paidBy) === -1) throw new Error('Paid By must be ' + payers.join(', ') + '.');

  let category = String(b.category || '').trim();
  if (!category) {
    if (!isFunds) throw new Error('Category is required.');
    category = type === 'Set balance' ? 'Balance set' : 'Funds added';
  }

  return {
    id: String(b.id || Utilities.getUuid()).slice(0, 64),
    date: date, // the sheet turns yyyy-mm-dd text into a real date
    category: safeText_(category.slice(0, 200)),
    amount: Math.round(amount * 100) / 100,
    paidBy: paidBy,
    notes: safeText_(String(b.notes || '').trim().slice(0, 500)),
    type: type,
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
    .setValues([[entry.date, entry.category, entry.amount, entry.paidBy, entry.notes, entry.type, '', entry.id]]);
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
  if (r[C.TYPE] === 'Personal') return r[C.PAID_BY] === 'K' ? COLORS.personalK : COLORS.personalV;
  if (r[C.TYPE] === 'Fixed') {
    const name = String(r[C.CATEGORY]).trim().toLowerCase();
    const key = Object.keys(FIXED_COLORS).find((k) => k.toLowerCase() === name);
    return key ? FIXED_COLORS[key] : COLORS.fixedOther;
  }
  return null; // Joint and budget rows stay plain
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
  writeSummary_(sheet, all);
  return {
    ok: true,
    balance: data.length ? data[data.length - 1][C.BALANCE] : 0,
    hasBalance: period.since !== '',
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
    })),
  };
}

function emptyPeriod_() {
  return { since: '', start: 0, added: 0, spent: 0, v: 0, k: 0, fixed: 0, fv: 0, fk: 0 };
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
  });
  list.forEach((x) => Object.keys(x).forEach((k) => { if (typeof x[k] === 'number') x[k] = round2_(x[k]); }));
  return list;
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
  s.settle = settleText_(s.vShare, s.kShare);
  s.fixedSettle = settleText_(s.fvShare, s.fkShare);
  s.overall = settleText_(round2_(s.vShare + s.fvShare), round2_(s.kShare + s.fkShare));
  return s;
}

// Rebuilds the tables in columns J onward: the same "Who owes whom" and "Fixed bills" tables
// as the app, the monthly budget, a color legend, and a history row for every budget period.
function writeSummary_(sheet, periods) {
  const WIDTH = 11; // J:T
  const p = periods.length ? periods[periods.length - 1] : emptyPeriod_();
  const s = shares_(p);
  const budget = round2_(p.start + p.added);
  const blank = () => new Array(WIDTH).fill('');
  const line = (...cells) => cells.concat(new Array(WIDTH - cells.length).fill(''));

  const out = [
    line('Who owes whom', '', '', p.since ? 'Since ' + p.since : 'No budget set'),    // 1
    line('V paid', 'K paid', 'Total'),                                                // 2
    line(p.v, p.k, p.spent),                                                          // 3
    line("V's share", "K's share", 'Equal split'),                                    // 4
    line(s.vShare, s.kShare, s.split),                                                // 5
    line('Settle up', s.settle),                                                      // 6
    line('Including fixed bills', s.overall),                                         // 7
    blank(),                                                                          // 8
    line('Fixed bills'),                                                              // 9
    line('V paid', 'K paid', 'Total'),                                                // 10
    line(p.fv, p.fk, p.fixed),                                                        // 11
    line('Settle up', s.fixedSettle),                                                 // 12
    blank(),                                                                          // 13
    line('Monthly budget'),                                                           // 14
    line('Budget', 'Spent', 'Remaining'),                                             // 15
    line(budget, p.spent, round2_(budget - p.spent)),                                 // 16
    blank(),                                                                          // 17
    line('Colors'),                                                                   // 18
    line('Joint', 'no color'),                                                        // 19
    line('Personal V'),                                                               // 20
    line('Personal K'),                                                               // 21
  ];
  const legendStart = out.length + 1;
  Object.keys(FIXED_COLORS).forEach((name) => out.push(line('Fixed: ' + name)));
  out.push(blank());
  const historyTitle = out.length + 1;
  out.push(line('History'));
  out.push(line('Since', 'Budget', 'Joint spent', 'V paid', 'K paid', "V's share", "K's share",
    'Settle up', 'Fixed total', 'Fixed settle', 'Overall'));
  const historyStart = out.length + 1;
  periods.slice().reverse().forEach((x) => {
    const h = shares_(x);
    out.push([x.since, round2_(x.start + x.added), x.spent, x.v, x.k, h.vShare, h.kShare,
      h.settle, x.fixed, h.fixedSettle, h.overall]);
  });

  // Clear the whole area first: rows deleted near the top can shift old values and colors into it.
  const last = Math.max(sheet.getLastRow(), out.length);
  const area = sheet.getRange(1, SUMMARY_COL, last, WIDTH);
  area.clearContent();
  area.clearFormat();
  sheet.getRange(1, SUMMARY_COL, out.length, WIDTH).setValues(out);

  const cell = (row, col, rows, cols) => sheet.getRange(row, SUMMARY_COL + col, rows || 1, cols || 1);
  [3, 5, 11, 16].forEach((row) => cell(row, 0, 1, 3).setNumberFormat(MONEY));
  [1, 9, 14, 18, historyTitle].forEach((row) => cell(row, 0).setFontWeight('bold').setFontSize(12));
  [2, 4, 10, 15, historyTitle + 1].forEach((row) => cell(row, 0, 1, row === historyTitle + 1 ? WIDTH : 3)
    .setFontWeight('bold').setBackground('#f3f4f6'));
  [6, 7, 12].forEach((row) => cell(row, 0, 1, 2).setFontWeight('bold'));
  cell(20, 0).setBackground(COLORS.personalV);
  cell(21, 0).setBackground(COLORS.personalK);
  Object.keys(FIXED_COLORS).forEach((name, i) => cell(legendStart + i, 0).setBackground(FIXED_COLORS[name]));
  if (periods.length) {
    cell(historyStart, 1, periods.length, 6).setNumberFormat(MONEY);
    cell(historyStart, 8, periods.length, 1).setNumberFormat(MONEY);
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
