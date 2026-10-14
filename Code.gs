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
 * J1:O7 holds a summary of the current period (since the last "Set balance" row), with a
 * color legend below it. The script overwrites that area.
 */

const TAB_NAME = 'Sirikh';
const HEADERS = ['Date', 'Category', 'Amount ($)', 'Paid By', 'Notes', 'Type', 'Balance ($)', 'ID'];
const C = { DATE: 0, CATEGORY: 1, AMOUNT: 2, PAID_BY: 3, NOTES: 4, TYPE: 5, BALANCE: 6, ID: 7 };
const TYPES = ['Joint', 'Fixed', 'Personal', 'Add funds', 'Set balance'];
const COLORS = {
  personalV: '#dbeafe', // light blue
  personalK: '#93c5fd', // darker blue
  rent: '#fdba74',      // strongest orange
  fixed: ['#fed7aa', '#ffe0c2', '#fcc896', '#ffedd5'], // other fixed bills, one shade per category
};
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
  writeSummary_(sheet, period_(recompute_(sheet)));
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
    if (/\brent\b/.test(name)) return COLORS.rent;
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) % 997;
    return COLORS.fixed[hash % COLORS.fixed.length];
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
  const period = period_(rows);
  writeSummary_(sheet, period);
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

// Totals for the current period, which starts at the most recent "Set balance" row.
function period_(rows) {
  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  const data = rows.filter((r) => !isEmptyRow_(r));
  let start = -1;
  data.forEach((r, i) => { if (r[C.TYPE] === 'Set balance') start = i; });

  const p = { since: '', start: 0, added: 0, spent: 0, v: 0, k: 0, fixed: 0, fv: 0, fk: 0 };
  if (start !== -1) {
    p.since = formatDate_(data[start][C.DATE], tz);
    p.start = toNumber_(data[start][C.AMOUNT]);
  }
  data.slice(start + 1).forEach((r) => {
    const amount = toNumber_(r[C.AMOUNT]);
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
  Object.keys(p).forEach((k) => { if (typeof p[k] === 'number') p[k] = round2_(p[k]); });
  return p;
}

function settleText_(vShare, kShare) {
  if (vShare <= -0.01) return 'V owes K $' + (-vShare).toFixed(2);
  if (kShare <= -0.01) return 'K owes V $' + (-kShare).toFixed(2);
  return 'Even';
}

// Same layout as the monthly blocks in the other tabs: share = paid minus half of the total.
function writeSummary_(sheet, p) {
  const budget = round2_(p.start + p.added);
  const split = round2_(p.spent / 2);
  const vShare = round2_(p.v - split);
  const kShare = round2_(p.k - split);
  const fSplit = round2_(p.fixed / 2);
  const fvShare = round2_(p.fv - fSplit);
  const fkShare = round2_(p.fk - fSplit);

  const area = sheet.getRange(1, SUMMARY_COL, 14, 6);
  area.clearFormat(); // rows deleted near the top can shift old formatting into this area
  area.setValues([
    ['V', 'K', 'Total', '', 'Budget', budget],
    [p.v, p.k, p.spent, '', 'Remaining', round2_(budget - p.spent)],
    ["V's Share", "K's Share", 'Equal Split', '', 'Since', p.since],
    [vShare, kShare, split, '', 'Settle up', settleText_(vShare, kShare)],
    ['', '', '', '', '', ''],
    ['Fixed V', 'Fixed K', 'Fixed Total', '', 'Fixed settle', settleText_(fvShare, fkShare)],
    [p.fv, p.fk, p.fixed, '', 'Overall', settleText_(round2_(vShare + fvShare), round2_(kShare + fkShare))],
    ['', '', '', '', '', ''],
    ['Colors', '', '', '', '', ''],
    ['Joint', 'no color', '', '', '', ''],
    ['Personal V', '', '', '', '', ''],
    ['Personal K', '', '', '', '', ''],
    ['Fixed: Rent', '', '', '', '', ''],
    ['Fixed: other', '', '', '', '', ''],
  ]);
  [[2, 1, 3], [4, 1, 3], [7, 1, 3], [1, 6, 1], [2, 6, 1]].forEach(([row, offset, width]) => {
    sheet.getRange(row, SUMMARY_COL + offset - 1, 1, width).setNumberFormat('$#,##0.00');
  });
  [1, 3, 6, 9].forEach((row) => sheet.getRange(row, SUMMARY_COL, 1, 3).setFontWeight('bold'));
  sheet.getRange(11, SUMMARY_COL).setBackground(COLORS.personalV);
  sheet.getRange(12, SUMMARY_COL).setBackground(COLORS.personalK);
  sheet.getRange(13, SUMMARY_COL).setBackground(COLORS.rent);
  sheet.getRange(14, SUMMARY_COL).setBackground(COLORS.fixed[0]);
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
