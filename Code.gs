/**
 * Sirikh backend (Google Apps Script, attached to the expense spreadsheet).
 *
 * Setup (once):
 *   1. Open the spreadsheet → Extensions → Apps Script.
 *   2. Replace everything in Code.gs with this file → Save.
 *   3. Project Settings (gear) → Script properties → Add: SIRIKH_KEY = <your passphrase>.
 *   4. Deploy → New deployment → Web app → Execute as: Me, Who has access: Anyone → Deploy.
 * After changing this file later:
 *   Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy (the /exec URL stays the same).
 *
 * Tab "Sirikh" (created automatically):
 *   Date | Category | Amount ($) | Paid By | Notes | Type | Balance ($) | ID
 *
 * Type is one of:
 *   Joint        shared expense, deducted from the main balance
 *   Personal     logged only, balance unchanged
 *   Add funds    money added to the main balance
 *   Set balance  balance becomes exactly this amount (for example at the start of a month)
 * Balance ($) is recalculated by this script from top to bottom, so edits made by hand
 * in the tab (amount or type) are picked up automatically. Negative amounts are refunds.
 */

const TAB_NAME = 'Sirikh';
const HEADERS = ['Date', 'Category', 'Amount ($)', 'Paid By', 'Notes', 'Type', 'Balance ($)', 'ID'];
const C = { DATE: 0, CATEGORY: 1, AMOUNT: 2, PAID_BY: 3, NOTES: 4, TYPE: 5, BALANCE: 6, ID: 7 };
const TYPES = ['Joint', 'Personal', 'Add funds', 'Set balance'];
const RECENT_COUNT = 5;

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
  if (sheet && sheet.getName() === TAB_NAME) recompute_(sheet);
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
  sheet.appendRow([entry.date, entry.category, entry.amount, entry.paidBy, entry.notes, entry.type, '', entry.id]);
  const row = sheet.getLastRow();
  sheet.getRange(row, C.DATE + 1).setNumberFormat('yyyy-mm-dd');
  sheet.getRange(row, C.AMOUNT + 1).setNumberFormat('$#,##0.00');
}

function deleteEntry_(sheet, id) {
  if (!id) throw new Error('Missing id.');
  const i = ids_(sheet).lastIndexOf(id);
  if (i !== -1) sheet.deleteRow(i + 2); // already gone is fine (retried delete)
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

// Recalculates Type (blank → Joint) and Balance ($) for every row; writes only if something changed.
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
  return rows;
}

function state_(sheet) {
  const rows = recompute_(sheet);
  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  const data = rows.filter((r) => !isEmptyRow_(r));

  // The current period starts at the most recent "Set balance" row.
  let start = -1;
  data.forEach((r, i) => { if (r[C.TYPE] === 'Set balance') start = i; });

  const period = { since: '', start: 0, added: 0, spent: 0, v: 0, k: 0 };
  if (start !== -1) {
    period.since = formatDate_(data[start][C.DATE], tz);
    period.start = toNumber_(data[start][C.AMOUNT]);
  }
  data.slice(start + 1).forEach((r) => {
    const amount = toNumber_(r[C.AMOUNT]);
    if (r[C.TYPE] === 'Add funds') period.added += amount;
    if (r[C.TYPE] === 'Joint') {
      period.spent += amount;
      if (r[C.PAID_BY] === 'V') period.v += amount;
      if (r[C.PAID_BY] === 'K') period.k += amount;
    }
  });
  Object.keys(period).forEach((k) => { if (typeof period[k] === 'number') period[k] = round2_(period[k]); });

  return {
    ok: true,
    balance: data.length ? data[data.length - 1][C.BALANCE] : 0,
    hasBalance: start !== -1,
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
