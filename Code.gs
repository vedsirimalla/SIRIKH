/**
 * Sirikh backend — paste into the Balance_Tracker spreadsheet:
 *   Extensions → Apps Script → replace Code.gs with this file → Save.
 * Then set the secret key (Project Settings → Script properties):
 *   Property: SIRIKH_KEY   Value: any passphrase you and K will type into the app once.
 * Deploy → New deployment → Web app → Execute as: Me, Who has access: Anyone.
 */

const TAB_NAME = 'Sirikh';
const HEADERS = ['Date', 'Category', 'Amount ($)', 'Paid By', 'Notes'];
const RECENT_COUNT = 5;

function doGet() {
  return ContentService.createTextOutput('Sirikh backend is running.');
}

function doPost(e) {
  return handle_(e, (body) => {
    if (body.action === 'recent') return { ok: true, recent: recent_() };
    const row = validate_(body);
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const sheet = getSheet_();
      // Skip resubmits of an entry that was already saved (offline queue retries).
      if (row.id && seenIds_().indexOf(row.id) !== -1) {
        return { ok: true, duplicate: true, recent: recent_() };
      }
      sheet.appendRow([row.date, row.category, row.amount, row.paidBy, row.notes]);
      const last = sheet.getLastRow();
      sheet.getRange(last, 1).setNumberFormat('yyyy-mm-dd');
      sheet.getRange(last, 3).setNumberFormat('$#,##0.00');
      if (row.id) rememberId_(row.id);
    } finally {
      lock.releaseLock();
    }
    return { ok: true, recent: recent_() };
  });
}

function handle_(e, fn) {
  let result;
  try {
    const body = e.postData && e.postData.contents ? JSON.parse(e.postData.contents) : {};
    const key = body.key;
    const expected = PropertiesService.getScriptProperties().getProperty('SIRIKH_KEY');
    if (!expected) throw new Error('SIRIKH_KEY is not set in Script properties.');
    if (key !== expected) throw new Error('Wrong key.');
    result = fn(body);
  } catch (err) {
    result = { ok: false, error: String(err.message || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

function validate_(b) {
  const date = String(b.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Invalid date.');
  const category = String(b.category || '').trim();
  if (!category) throw new Error('Category is required.');
  const amount = Number(b.amount);
  if (!isFinite(amount) || amount === 0) throw new Error('Invalid amount.');
  const paidBy = String(b.paidBy || '');
  if (paidBy !== 'V' && paidBy !== 'K') throw new Error('Paid By must be V or K.');
  const [y, m, d] = date.split('-').map(Number);
  return {
    id: b.id ? String(b.id).slice(0, 64) : '',
    date: new Date(y, m - 1, d),
    category: category.slice(0, 200),
    amount: Math.round(amount * 100) / 100,
    paidBy: paidBy,
    notes: String(b.notes || '').trim().slice(0, 500),
  };
}

function getSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(TAB_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(TAB_NAME);
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function recent_() {
  const sheet = getSheet_();
  const last = sheet.getLastRow();
  if (last < 2) return [];
  const start = Math.max(2, last - RECENT_COUNT + 1);
  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  return sheet.getRange(start, 1, last - start + 1, HEADERS.length).getValues()
    .reverse()
    .map((r) => ({
      date: r[0] instanceof Date ? Utilities.formatDate(r[0], tz, 'yyyy-MM-dd') : String(r[0]),
      category: r[1],
      amount: r[2],
      paidBy: r[3],
      notes: r[4],
    }));
}

function seenIds_() {
  const raw = PropertiesService.getScriptProperties().getProperty('SIRIKH_IDS');
  return raw ? JSON.parse(raw) : [];
}

function rememberId_(id) {
  const ids = seenIds_();
  ids.push(id);
  PropertiesService.getScriptProperties().setProperty('SIRIKH_IDS', JSON.stringify(ids.slice(-50)));
}
