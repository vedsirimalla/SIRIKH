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
 *   Settlement       money one person paid the other to clear what was owed (Splitwise, cash...).
 *                    Card Used = who paid, Expense For = who received. Not an expense: it never
 *                    touches budgets or spending, only the month's Settled / Status lines (green rows).
 * Budgets are per calendar month and reset on the 1st (nothing carries over). The latest budget
 * row in a month sets the amount, and every expense dated in that month counts against it, even
 * one logged before the budget was set. Joint Left ($) is the joint budget minus the joint
 * spending up to that row; the rows and colors are recalculated whenever the tab changes.
 *
 * Columns J onward of each month tab hold that month's tables (who owes whom, fixed bills,
 * personal expenses, budgets with what is left). The script overwrites that area.
 *
 * Income, investments, loan payments, savings and the savings goal live in the "Funds" tab: entries
 * on the left, an overview (this month, savings, goal, loan payments, month by month) from column J
 * (see the Funds section at the end of this file). An optional weekly email recap runs from a trigger.
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
const BACKEND_VERSION = 20;
const HEADERS = ['Date', 'Category', 'Amount ($)', 'Card Used', 'Notes', 'Type', 'Joint Left ($)', 'ID', 'Expense For'];
const C = { DATE: 0, CATEGORY: 1, AMOUNT: 2, PAID_BY: 3, NOTES: 4, TYPE: 5, BALANCE: 6, ID: 7, FOR: 8 };
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
      const isFunds = body.table === 'funds';
      if (body.action === 'add') {
        if (isCar) addCar_(carSheet, validateCar_(body.entry || {}));
        else if (isFunds) addFunds_(validateFunds_(body.entry || {}));
        else {
          const entry = validate_(body.entry || {});
          addEntry_(entry);
          touched.push(entry.month || entry.date.slice(0, 7));
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
      } else if (body.action !== 'state') {
        throw new Error('Unknown action.');
      }
      result = state_(today.slice(0, 7), touched);
      result.car = carState_(carSheet);
      result.funds = fundsState_(today, MONTHS_CACHE, carSheet);
      if (body.action === 'recap' && body.test) result.recapSent = sendRecap_(today);
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
  };
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
    v: 0, k: 0, fixed: 0, fv: 0, fk: 0, personal: 0, pv: 0, pk: 0, kOnK: 0, kOnV: 0, vOnV: 0, vOnK: 0,
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

// Columns J onward of a month tab: who owes whom (with settlements and status), fixed bills,
// personal expenses, and the month's budgets with what is left, plus a color legend.
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
    line('Settled (Splitwise, cash...)', s.settledText),                              // 9
    line('Status', s.status),                                                         // 10
    blank(),                                                                          // 11
    line('Fixed bills'),                                                              // 12
    line('V paid', 'K paid', 'Total'),                                                // 13
    line(p.fv, p.fk, p.fixed),                                                        // 14
    line('Settle up', s.fixedSettle),                                                 // 15
    blank(),                                                                          // 16
    line('Personal expenses'),                                                        // 17
    line('', 'Own card', "Other's card (owed in full)"),                              // 18
    line("K's expenses", p.kOnK, p.kOnV),                                             // 19
    line("V's expenses", p.vOnV, p.vOnK),                                             // 20
    line('Settle up', s.personalSettle),                                              // 21
    line('Overall (joint + fixed + personal)', s.overall),                            // 22
    blank(),                                                                          // 23
    line('Budgets for ' + monthLabel_(key)),                                          // 24
    line('Budget for', 'Budget', 'Spent', 'Left'),                                    // 25
    p.hasBudget ? line('Joint', budget, p.spent, round2_(budget - p.spent)) : line('Joint', 'not set', p.spent, ''), // 26
    pbLine('V'),                                                                      // 27
    pbLine('K'),                                                                      // 28
    blank(),                                                                          // 29
    line('Colors'),                                                                   // 30
    line('Joint', 'no color'),                                                        // 31
    line('Personal V', 'expense for V'),                                              // 32
    line('Personal K', 'expense for K'),                                              // 33
    line('Fixed V', "V's card"),                                                      // 34
    line('Fixed K', "K's card"),                                                      // 35
    line('Settlement', 'paid back'),                                                  // 36
  ];
  // Clear the whole area first: rows deleted near the top can shift old values and colors into it.
  const area = sheet.getRange(1, SUMMARY_COL, Math.max(sheet.getLastRow(), out.length), WIDTH);
  area.clearContent();
  area.clearFormat();
  sheet.getRange(1, SUMMARY_COL, out.length, WIDTH).setValues(out);

  const cell = (row, col, rows, cols) => sheet.getRange(row, SUMMARY_COL + col, rows || 1, cols || 1);
  [3, 5, 14].forEach((row) => cell(row, 0, 1, 3).setNumberFormat(MONEY));
  cell(19, 1, 2, 2).setNumberFormat(MONEY);
  cell(26, 1, 3, 3).setNumberFormat(MONEY);
  [1, 12, 17, 24, 30].forEach((row) => cell(row, 0).setFontWeight('bold').setFontSize(12));
  [2, 4, 13, 18].forEach((row) => cell(row, 0, 1, 3).setFontWeight('bold').setBackground('#f3f4f6'));
  cell(25, 0, 1, 4).setFontWeight('bold').setBackground('#f3f4f6');
  cell(26, 3, 3, 1).setFontWeight('bold');
  cell(19, 0, 2, 1).setFontWeight('bold');
  [6, 7, 8, 9, 10, 15, 21, 22].forEach((row) => cell(row, 0, 1, 2).setFontWeight('bold'));
  // Status: green once cleared, amber while something is still owed.
  if (s.status === 'Cleared') cell(10, 0, 1, 2).setBackground(COLORS.settled);
  else if (s.status !== 'Even') cell(10, 0, 1, 2).setBackground(COLORS.open);
  cell(32, 0).setBackground(COLORS.personalV);
  cell(33, 0).setBackground(COLORS.personalK);
  cell(34, 0).setBackground(COLORS.fixedV);
  cell(35, 0).setBackground(COLORS.fixedK);
  cell(36, 0).setBackground(COLORS.settled);
}

// The "Sirikh" tab: one row per month, newest first. Settled and Status show whether the month's
// owing has been paid back; the last column is what was left of the month's joint budget.
function writeOverview_(months) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(OVERVIEW_TAB) || ss.insertSheet(OVERVIEW_TAB, 0);
  const HEAD = ['Month', 'Tab', 'Joint budget', 'Joint spent', 'Fixed bills', 'V personal spent', 'K personal spent',
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
    out.push([monthLabel_(m.key), tabName_(m.key), p.hasBudget ? budget : 'not set', p.spent, p.fixed, p.pv, p.pk,
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
    sheet.getRange(5, 3, months.length, 7).setNumberFormat(MONEY);
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
    const hit = touched.indexOf(t.key) !== -1;
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
//   Income            money in hand (after 401(K), insurance, taxes). Person V, K or Both (half each)
//   Investment        401(K), India, USA... Person V or K. From: Income (this month) or Savings
//   Loan payment      a payment sent toward a loan; Category = which loan. Person V, K or Both
//   Use savings       spending from savings kept in earlier months. Person V, K or Both
//   Prior investment  invested before tracking (counts toward the goal)
//   Goal              Amount = target, Category = deadline month (yyyy-mm)
//   Savings target    Amount = percent of income to keep (invested + saved) each month
//
// Each month, per person; shared costs count half each and settlements are ignored:
//   Spent    = Joint/2 + Fixed/2 + Personal + Sonata (half of joint, own turns) + loan payments
//   Invested = Investment rows from this month's income
//   Savings  = Income - Spent - Invested           (the month's savings, not decided yet)
//   Kept     = Invested + Savings = Income - Spent  Savings rate = Kept / Income
// The month's savings already include any unspent joint budget (half each) and unspent personal
// budget; the overview shows that breakdown, it is not added again.
// Savings available = every earlier month's savings - savings used - invested from savings.
// Goal (investments only): each person aims for half the target; needed per month = still to go /
// months left including this one.
// ======================================================================================

const FUNDS_TAB = 'Funds';
const FUNDS_HEADERS = ['Date', 'Kind', 'Category', 'Amount ($)', 'Person', 'Notes', 'ID', 'From'];
const F = { DATE: 0, KIND: 1, CATEGORY: 2, AMOUNT: 3, PERSON: 4, NOTES: 5, ID: 6, FROM: 7 };
const FUND_KINDS = ['Income', 'Investment', 'Loan payment', 'Use savings', 'Prior investment', 'Goal', 'Savings target'];
const FUNDS_SUMMARY_COL = 10; // column J
const FUNDS_SUMMARY_WIDTH = 6; // J:O
const FUND_COLORS = {
  'Income': '#dcfce7', 'Investment': '#e9d5ff', 'Prior investment': '#f3e8ff', 'Loan payment': '#fecaca',
  'Use savings': '#fef9c3', 'Goal': '#e0f2fe', 'Savings target': '#e0f2fe',
};
const RECAP_PROP = 'SIRIKH_RECAP_TO';

function fundKind_(v) {
  const s = String(v).trim().toLowerCase();
  if (s === 'use surplus') return 'Use savings';
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
  if (!kind) throw new Error('Pick Income, Invest, Loan or Savings.');
  const date = String(b.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Invalid date.');
  const amount = Number(b.amount);
  if (!isFinite(amount) || amount < 0 || (amount === 0 && kind !== 'Savings target')) throw new Error('Invalid amount.');
  if (kind === 'Savings target' && amount > 95) throw new Error('Savings target is a percent of income (0 to 95).');
  let person = String(b.person || '').trim();
  if (person === 'Joint') person = 'Both';
  const allowed = { 'Income': ['V', 'K', 'Both'], 'Investment': ['V', 'K'], 'Loan payment': ['V', 'K', 'Both'], 'Use savings': ['V', 'K', 'Both'],
    'Prior investment': ['V', 'K'] }[kind];
  if (allowed && allowed.indexOf(person) === -1) throw new Error('Person must be ' + allowed.join(', ').replace(/, ([^,]*)$/, ' or $1') + '.');
  if (!allowed) person = 'Both';
  let category = String(b.category || '').trim();
  if (kind === 'Goal' && !isMonthKey_(category)) throw new Error('Pick a deadline month.');
  if (!category) {
    category = { 'Income': 'Salary', 'Investment': 'Investment', 'Loan payment': 'Loan', 'Use savings': 'Savings used',
      'Prior investment': 'Before tracking', 'Savings target': 'Savings target' }[kind] || '';
  }
  const from = String(b.from || '').trim();
  return {
    id: String(b.id || Utilities.getUuid()).slice(0, 64), date: date, kind: kind, category: safeText_(category.slice(0, 200)),
    amount: round2_(amount), person: person, notes: safeText_(String(b.notes || '').trim().slice(0, 500)),
    from: kind === 'Investment' ? (from === 'Savings' || from === 'Surplus' ? 'Savings' : 'Income') : '',
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
  sheet.getRange(row, 1, 1, FUNDS_HEADERS.length).setValues([[e.date, e.kind, e.category, e.amount, e.person, e.notes, e.id, e.from]]);
  sheet.getRange(row, F.DATE + 1).setNumberFormat('yyyy-mm-dd');
  sheet.getRange(row, F.AMOUNT + 1).setNumberFormat(MONEY);
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
    return { i: i, date: formatDate_(r[F.DATE], tz), kind: fundKind_(r[F.KIND]), category: String(r[F.CATEGORY]).trim(),
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
  const blank = () => ({ income: { V: 0, K: 0 }, joint: 0, fixed: 0, personal: { V: 0, K: 0 }, carShared: 0, car: { V: 0, K: 0 },
    invest: { V: 0, K: 0 }, investSaved: { V: 0, K: 0 }, loan: { V: 0, K: 0 }, used: { V: 0, K: 0 }, jointBudget: null, pb: { V: null, K: null } });
  const byMonth = {};
  for (let n = monthIndex_(start); n <= monthIndex_(current); n++) byMonth[keyOfIndex_(n)] = blank();
  const at = (key) => byMonth[key] || null;
  const add = (o, s) => { o.V += s.V; o.K += s.K; };

  rows.forEach((r) => {
    const m = at(r.date.slice(0, 7));
    if (!m) return;
    if (r.kind === 'Income') add(m.income, split_(r.person, r.amount));
    if (r.kind === 'Investment') add(r.from === 'Savings' ? m.investSaved : m.invest, split_(r.person, r.amount));
    if (r.kind === 'Use savings') add(m.used, split_(r.person, r.amount));
    if (r.kind === 'Loan payment') add(m.loan, split_(r.person, r.amount));
  });
  months.forEach((mt) => {
    const m = at(mt.key);
    if (!m) return;
    m.joint += mt.p.spent;
    m.fixed += mt.p.fixed;
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
    const spent = who((w) => m.joint / 2 + m.fixed / 2 + m.personal[w] + m.carShared / 2 + m.car[w] + m.loan[w]);
    const savings = who((w) => m.income[w] - spent[w] - m.invest[w]);
    const kept = who((w) => m.income[w] - spent[w]);
    const rateOf = (k, i) => (i > 0 ? round2_((k / i) * 100) : null);
    // Where the month's savings came from: unspent budgets first, the rest is unbudgeted income.
    const jointLeft = m.jointBudget === null ? null : round2_(m.jointBudget - m.joint);
    const personalLeft = { V: m.pb.V === null ? null : round2_(m.pb.V - m.personal.V), K: m.pb.K === null ? null : round2_(m.pb.K - m.personal.K) };
    const fromJoint = who(() => (jointLeft === null ? 0 : jointLeft / 2));
    const fromPersonal = who((w) => personalLeft[w] || 0);
    const before = vk_(carry);
    carry = { V: carry.V + savings.V - m.used.V - m.investSaved.V, K: carry.K + savings.K - m.used.K - m.investSaved.K };
    return {
      month: key, label: monthLabel_(key), income: vk_(m.income), joint: round2_(m.joint), fixed: round2_(m.fixed),
      sonataShared: round2_(m.carShared), shared: who(() => m.joint / 2 + m.fixed / 2), personal: vk_(m.personal),
      sonata: who((w) => m.carShared / 2 + m.car[w]), loan: vk_(m.loan), spent: spent, invest: vk_(m.invest), savings: savings, kept: kept,
      rate: { V: rateOf(kept.V, m.income.V), K: rateOf(kept.K, m.income.K), total: rateOf(kept.total, m.income.V + m.income.K) },
      budgets: { jointBudget: m.jointBudget === null ? null : round2_(m.jointBudget), jointLeft: jointLeft, personalLeft: personalLeft,
        fromJoint: fromJoint, fromPersonal: fromPersonal, rest: vk_({ V: savings.V - fromJoint.V - fromPersonal.V, K: savings.K - fromJoint.K - fromPersonal.K }) },
      investSaved: vk_(m.investSaved), used: vk_(m.used), savedBefore: before, savedAfter: vk_(carry),
    };
  });
  const now = history[history.length - 1];
  // Savings you can use now: earlier months' savings minus what was used or invested from them (this month included).
  const available = vk_({ V: now.savedBefore.V - now.used.V - now.investSaved.V, K: now.savedBefore.K - now.used.K - now.investSaved.K });

  // ---- safe to spend
  const targetRow = rows.filter((r) => r.kind === 'Savings target').pop();
  let safe = null;
  if (targetRow) {
    const pct = targetRow.amount;
    const past = history.slice(0, -1).filter((h) => h.income.total > 0).slice(-3);
    const avg = (w) => (past.length ? past.reduce((s, h) => s + h.income[w], 0) / past.length : 0);
    const expected = vk_({ V: Math.max(now.income.V, avg('V')), K: Math.max(now.income.K, avg('K')) });
    const allowance = vk_({ V: expected.V * (1 - pct / 100), K: expected.K * (1 - pct / 100) });
    const left = vk_({ V: allowance.V - now.spent.V, K: allowance.K - now.spent.K });
    const daysLeft = daysInMonth_(current) - Number(today.slice(8, 10)) + 1;
    const used = allowance.total > 0 ? round2_((now.spent.total / allowance.total) * 100) : now.spent.total > 0 ? 100 : 0;
    safe = { percent: pct, expected: expected, allowance: allowance, spent: now.spent, left: left, daysLeft: daysLeft,
      perDay: round2_(Math.max(0, left.total) / daysLeft), used: used,
      status: used > 100 ? 'over' : used >= 80 ? 'warn' : 'ok', estimated: expected.total > now.income.total + 0.005 };
  }

  // ---- goal (investments only)
  const goalRow = rows.filter((r) => r.kind === 'Goal').sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.i - b.i)).pop();
  let goal = null;
  if (goalRow) {
    const invested = { V: 0, K: 0 };
    rows.forEach((r) => { if (r.kind === 'Investment' || r.kind === 'Prior investment') add(invested, split_(r.person, r.amount)); });
    const target = goalRow.amount;
    const deadline = goalRow.category;
    const monthsLeft = Math.max(0, monthIndex_(deadline) - monthIndex_(current) + 1);
    const togo = { V: Math.max(0, target / 2 - invested.V), K: Math.max(0, target / 2 - invested.K) };
    const div = monthsLeft || 1;
    const tracked = history.length || 1;
    const avg = { V: history.reduce((s, h) => s + h.invest.V + h.investSaved.V, 0) / tracked, K: history.reduce((s, h) => s + h.invest.K + h.investSaved.K, 0) / tracked };
    const togoTotal = togo.V + togo.K;
    const avgTotal = avg.V + avg.K;
    const finishIn = togoTotal <= 0 ? 0 : avgTotal > 0 ? Math.ceil(togoTotal / avgTotal) : null;
    const finishKey = finishIn === null ? null : keyOfIndex_(monthIndex_(current) + Math.max(finishIn - 1, 0));
    goal = {
      target: round2_(target), deadline: deadline, deadlineLabel: monthLabel_(deadline), monthsLeft: monthsLeft,
      invested: vk_(invested), togo: vk_(togo), need: vk_({ V: togo.V / div, K: togo.K / div }), avg: vk_(avg),
      thisMonth: vk_({ V: now.invest.V + now.investSaved.V, K: now.invest.K + now.investSaved.K }),
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

  return { month: current, today: today, start: start, now: now, available: available, history: history, safe: safe, goal: goal,
    loans: loans, loanUsual: loanUsual, savingsTarget: targetRow ? targetRow.amount : null };
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
  const s = model.safe;
  if (s && s.status === 'over') out.push('Spending is ' + usd0_(-s.left.total) + ' past what keeps ' + s.percent + '% of income this month.');
  else if (s && s.status === 'warn') out.push(Math.round(s.used) + '% of this month\'s spending room is used; about ' + usd0_(s.perDay) + ' a day keeps ' + s.percent + '%.');
  if (model.goal) out.push.apply(out, model.goal.suggestions);
  return out;
}

// Overview in columns J to O of the Funds tab, rebuilt on every save.
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
  trio('Income', n.income);
  trio('Joint + Fixed (half each)', n.shared);
  trio('Personal', n.personal);
  trio('Sonata (own turns + half joint)', n.sonata);
  trio('Loan payments', n.loan);
  trio('Spent (all inclusive)', n.spent);
  trio('Invested', n.invest);
  trio('Savings this month', n.savings);
  line(['Savings rate (invested + savings)', pct(n.rate.V), pct(n.rate.K), pct(n.rate.total)]);
  if (model.safe) {
    const s = model.safe;
    trio('Can spend (keeping ' + s.percent + '%)', s.allowance);
    trio('Safe to spend left', s.left);
    line(['Per day for ' + s.daysLeft + ' days', '', '', s.perDay], 'money');
  }
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
  gap();
  line(['Month by month', 'Income', 'Spent', 'Invested', 'Savings', 'Savings total'], 'head');
  model.history.slice().reverse().forEach((h) => line([h.label, h.income.total, h.spent.total, h.invest.total, h.savings.total, h.savedAfter.total], 'money'));
  const tips = suggestions_(model);
  if (tips.length) {
    gap();
    line(['Suggestions'], 'head');
    tips.forEach((t) => line([t]));
  }
  const clearRows = Math.max(sheet.getLastRow(), out.length);
  sheet.getRange(1, FUNDS_SUMMARY_COL, clearRows, W).clearContent().clearFormat();
  sheet.getRange(1, FUNDS_SUMMARY_COL, out.length, W).setValues(out);
  heads.forEach((r) => sheet.getRange(r, FUNDS_SUMMARY_COL, 1, W).setFontWeight('bold').setBackground('#e0f2fe'));
  moneyRows.forEach((r) => sheet.getRange(r, FUNDS_SUMMARY_COL + 1, 1, W - 2).setNumberFormat(MONEY));
}

function fundsState_(today, months, carSheet) {
  const sheet = fundsSheet_(false);
  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  const raw = readFundsRows_(sheet);
  const model = fundsModel_(today, raw, months, readCarRows_(carSheet));
  if (sheet) {
    colorFunds_(sheet);
    writeFundsSummary_(sheet, model);
  }
  model.suggestions = suggestions_(model);
  model.hasEntries = raw.length > 0;
  model.recent = parseFunds_(raw, tz).sort((a, b) => (a.date !== b.date ? (a.date < b.date ? 1 : -1) : b.i - a.i))
    .slice(0, RECENT_COUNT).map((r) => ({ id: r.id, date: r.date, kind: r.kind, category: r.category, amount: r.amount, person: r.person,
      notes: r.notes, from: r.kind === 'Investment' ? r.from : '' }));
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
  if (model.safe) lines.push('Safe to spend: ' + (model.safe.left.total >= 0 ? usd0_(model.safe.left.total) + ' left, about ' + usd0_(model.safe.perDay) + ' a day' : usd0_(-model.safe.left.total) + ' over') + ' to keep ' + model.safe.percent + '% of income.');
  if (n.income.total > 0) lines.push('Income ' + usd0_(n.income.total) + ', invested ' + usd0_(n.invest.total) + ', savings ' + usd0_(n.savings.total) + (n.rate.total !== null ? ' (' + Math.round(n.rate.total) + '% kept)' : '') + '.');
  lines.push('Savings available from earlier months: ' + usd0_(model.available.total) + '.');
  if (model.goal) lines.push('Goal ' + usd0_(model.goal.target) + ' by ' + model.goal.deadlineLabel + ': ' + model.goal.percent.toFixed(1) + '% done, ' + usd0_(model.goal.need.total) + ' a month needed (' + (model.goal.onTrack ? 'on track' : 'behind') + ').');
  if (n.loan.total > 0) lines.push('Loan payments this month: ' + usd0_(n.loan.total) + ' (' + model.loans.filter((l) => l.thisMonth > 0).map((l) => l.name + ' ' + usd0_(l.thisMonth)).join(', ') + ').');
  return { subject: 'Sirikh weekly: ' + usd0_(soFar) + ' spent in ' + n.label.split(' ')[0] + (model.safe ? ', ' + usd0_(Math.max(0, model.safe.left.total)) + ' safe to spend' : ''), lines: lines };
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
