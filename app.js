(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const APP_VERSION = 30; // shown at the bottom of the app; matches the cache name in sw.js
  // Fixed bills are picked from this list (no typing); each has its own orange, same as the sheet.
  const FIXED_CATEGORIES = ['Rent', 'Utilities', 'Electricity', 'Wi-Fi', 'Mobile bill', 'Misc'];
  // Tags for Joint and Personal expenses (same list as Code.gs). Fixed bills are their own tag.
  const TAGS = ['Groceries', 'Dining out', 'Entertainment', 'Shopping', 'Household items', 'Subscriptions', 'Travel', 'Fuel',
    'Transport', 'Health', 'Personal care', 'Gifts', 'Education', 'Bills', 'Other'];
  // A first guess from the category (same rules as Code.gs); a tag picked for a category is remembered.
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
  const TYPE_LABELS = { 'Joint': 'Joint', 'Fixed': 'Fixed', 'Personal': 'Personal', 'Car': 'Sonata', 'Add funds': 'Funds added', 'Set balance': 'Budget set', 'Personal budget': 'Budget set', 'Settlement': 'Settled' };
  const TYPE_HINTS = {
    Joint: 'Joint: shared day-to-day spending. Comes out of the monthly budget and counts in who owes whom.',
    Fixed: "Fixed: a monthly bill (Rent, Utilities, Electricity, Wi-Fi, Mobile bill, Misc). Expense for: Both splits it 50/50; V or K is that person's own bill (each mobile line), owed in full if it goes on the other's card. Not taken from the monthly budget.",
    Personal: "Personal: one person's own expense, not in the budget. If it goes on the other person's card, they are owed the full amount.",
    Car: "Sonata: car costs and fuel, saved to the Sonata tab. Expense for: whose turn it is (V or K), or Joint to split 50/50.",
    Funds: 'Funds: what comes in and what goes out (income, 401(K), investments, Fam, loan payments, savings), saved to the Funds tab with its overview.',
  };

  // Matches the row colors in the sheet: Personal blues and Fixed oranges, lighter for V, darker for K.
  function colorClass(r) {
    if (r.type === 'Settlement' || r.category === 'Settlement') return 'c-settled';
    if (r.type === 'Personal') return (r.expenseFor || r.paidBy) === 'K' ? 'c-personal-k' : 'c-personal-v';
    if (r.type === 'Fixed') return r.paidBy === 'K' ? 'c-fixed-k' : 'c-fixed-v';
    return '';
  }

  // Older copies of Code.gs save unknown types as Joint, so Fixed bills wait on the phone until
  // the sheet's script is redeployed with at least this version.
  // Fixed bills need version 7 (older scripts save them as Joint). Sonata entries and Personal
  // expenses need version 9, which stores whose expense it is separately from whose card paid.
  const requiredVersion = (op) => {
    // version 25: Fixed bills for one person (Expense for V or K), Mobile bill, custom tags
    if (op.op !== 'delete' && !op.table && op.entry && op.entry.type === 'Fixed' && (op.entry.expenseFor === 'V' || op.entry.expenseFor === 'K' || op.entry.category === 'Mobile bill')) return 25;
    if (op.op !== 'delete' && !op.table && op.entry && op.entry.tag) return 24; // tags (version 24 adds the Tag column)
    if (op.op === 'update') return 23; // editing an entry
    if (op.table === 'funds') return op.op !== 'delete' && op.entry.kind === 'Fam' ? 25 : op.op === 'add' && op.entry.kind === '401(K)' ? 21 : 20;
    if (op.table === 'car') return op.op !== 'add' ? 9 : op.entry.category === 'Settlement' ? 18 : 15;
    if (op.op !== 'add') return 0;
    if (op.entry.type === 'Settlement') return 18;
    if (op.entry.type === 'Personal budget') return 10;
    if (op.entry.type === 'Personal') return 9;
    return op.entry.type === 'Fixed' ? 7 : 0;
  };
  const OUTDATED_MESSAGE = 'Some entries are waiting on this phone (hourglass) because the Apps Script in your sheet ' +
    'is an older version. In Apps Script: paste the latest Code.gs, then ' +
    'Deploy > Manage deployments > pencil > Version: New version > Deploy. They will send automatically.';

  // ---------- Storage (this phone only)
  const store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem('sirikh.' + key);
        return v === null ? fallback : JSON.parse(v);
      } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem('sirikh.' + key, JSON.stringify(value)); } catch {}
    },
    remove(key) {
      try { localStorage.removeItem('sirikh.' + key); } catch {}
    },
  };
  const getSettings = () => store.get('settings', null);
  const getQueue = () => store.get('queue', []);
  const setQueue = (q) => store.set('queue', q);
  const getState = () => store.get('state', null);
  // An edit waits in the queue as one 'update'. For the live numbers it counts as taking the old
  // entry out and putting the new one in.
  const pendingOps = () => getQueue().flatMap((op) => (op.op === 'update' ? [{ ...op, op: 'delete', id: op.entry.id }, { ...op, op: 'add' }] : [op]));
  let editing = null; // the Recent entry being edited: { id, table }

  // Older rows loaded with "Show more", per list ('main|Joint', 'car|All', 'funds|All'...). Kept only
  // in memory: cleared whenever the sheet changes, so they are never stale.
  let loadedMore = {};
  // Which rows each page's Recent shows (same as RECENT_GROUPS in Code.gs). Home shows everything.
  const RECENT_GROUPS = {
    Joint: ['Joint', 'Set balance', 'Add funds', 'Settlement'],
    Fixed: ['Fixed'],
    Personal: ['Personal', 'Personal budget', 'Settlement'],
  };
  // Every row this phone knows for a table (latest lists plus older rows loaded), to undo an edit or
  // delete in the live numbers before it syncs.
  function findRow(table, id) {
    const st = getState() || {};
    const lists = table === 'car' ? [(st.car && st.car.recent) || []]
      : table === 'funds' ? [(st.funds && st.funds.recent) || []]
        : [st.recent || [], ...Object.values(st.recentBy || {})];
    for (const [key, rows] of Object.entries(loadedMore)) if (key.startsWith((table || 'main') + '|')) lists.push(rows);
    for (const rows of lists) { const hit = rows.find((r) => r.id === id); if (hit) return hit; }
    return undefined;
  }

  // ---------- Helpers
  function today() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  const round2 = (n) => Math.round(n * 100) / 100;
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

  // Accepts "45.2", "$1,234.50", "-7" (refund) and "10,72".
  function parseAmount(raw) {
    let s = String(raw).replace(/[$\s]/g, '');
    if (!s) return null;
    s = /^-?\d+,\d{1,2}$/.test(s) ? s.replace(',', '.') : s.replace(/,/g, '');
    const n = Number(s);
    return isFinite(n) ? round2(n) : null;
  }

  function money(n) {
    const v = Number(n);
    if (!isFinite(v)) return String(n);
    const abs = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return (v < 0 ? '-$' : '$') + abs;
  }

  function prettyDate(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    if (!m) return iso || '';
    return new Date(+m[1], m[2] - 1, +m[3]).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  const banner = $('banner');
  let bannerTimer;
  function showBanner(text, kind, sticky) {
    clearTimeout(bannerTimer);
    banner.textContent = text;
    banner.className = 'banner ' + kind;
    banner.hidden = false;
    if (!sticky) bannerTimer = setTimeout(() => { banner.hidden = true; }, 3500);
  }

  // ---------- Rendering
  function monthName(iso) {
    const m = /^(\d{4})-(\d{2})/.exec(iso || '');
    return m ? new Date(+m[1], m[2] - 1, 1).toLocaleDateString('en-US', { month: 'long' }) : '';
  }

  function daysLeftInMonth() {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate() - d.getDate() + 1;
  }

  const signed = (n) => (n > 0 ? '+' : '') + money(n);

  // A one-person expense paid on the other person's card is owed back in full. Positive = K owes V.
  function owedInFull(owner, card, amount) {
    if (owner === 'K' && card === 'V') return amount;
    if (owner === 'V' && card === 'K') return -amount;
    return 0;
  }

  // Fixed bills: shared ones split 50/50, each person's own bill (a mobile line) owed in full when it
  // goes on the other's card. Positive fvShare = K owes V. Older sheets send no split: all shared.
  function fixedShares(p) {
    const shared = p.fShared === undefined ? p.fixed : p.fShared;
    const sv = p.fsv === undefined ? p.fv : p.fsv;
    const sk = p.fsk === undefined ? p.fk : p.fsk;
    const split = round2(shared / 2);
    const owed = p.fixedOwed || 0;
    return { shared: round2(shared), fvShare: round2(sv - split + owed), fkShare: round2(sk - split - owed),
      ownV: round2(p.fOwnV || 0), ownK: round2(p.fOwnK || 0), fixedV: round2(split + (p.fOwnV || 0)), fixedK: round2(split + (p.fOwnK || 0)) };
  }

  // Sonata: own turns owe nothing, Joint splits 50/50, a turn on the other's card is owed in full.
  function carOwed(owner, card, amount) {
    if (owner === 'Joint') return card === 'V' ? amount / 2 : card === 'K' ? -amount / 2 : 0;
    return owedInFull(owner, card, amount);
  }

  // Starts from what the sheet last reported and applies changes not synced yet,
  // so the budget and the split update the moment an expense is saved, even offline.
  // The month the app is in (the phone's date) and whether the last sync was for that month.
  // On the 1st the budgets reset right away, before the next sync.
  const currentMonth = () => today().slice(0, 7);
  function stateForMonth() {
    const st = getState();
    return st && (st.month || (st.period && String(st.period.since).slice(0, 7))) === currentMonth() ? st : null;
  }

  // The month's numbers: what the sheet last reported plus changes not synced yet. A budget covers
  // the whole calendar month, so setting it (or changing it) counts every expense already logged.
  function estimate() {
    const state = stateForMonth();
    const month = currentMonth();
    const p = { month, since: month + '-01', start: 0, added: 0, spent: 0, v: 0, k: 0, fixed: 0, fv: 0, fk: 0, personal: 0,
      kOnK: 0, kOnV: 0, vOnV: 0, vOnK: 0, ...(state && state.period) };
    // Sheets older than version 25 do not split Fixed bills: treat them all as shared.
    if (p.fShared === undefined) Object.assign(p, { fShared: p.fixed, fsv: p.fv, fsk: p.fk, fOwnV: 0, fOwnK: 0, fixedOwed: 0 });
    let hasBalance = state ? !!state.hasBalance : false;
    const sameMonth = (e) => e && String(e.month || e.date).slice(0, 7) === month;

    const apply = (e, sign) => {
      const amt = sign * e.amount;
      if (e.type === 'Add funds') p.added += amt;
      if (e.type === 'Settlement') {
        p.settled = (p.settled || 0) + amt;
        p.settledNet = (p.settledNet || 0) + (e.paidBy === 'K' ? amt : -amt);
      }
      if (e.type === 'Joint') {
        p.spent += amt;
        if (e.paidBy === 'V') p.v += amt;
        if (e.paidBy === 'K') p.k += amt;
      }
      if (e.type === 'Fixed') {
        p.fixed += amt;
        if (e.paidBy === 'V') p.fv += amt;
        if (e.paidBy === 'K') p.fk += amt;
        const who = e.expenseFor === 'V' || e.expenseFor === 'K' ? e.expenseFor : 'Both';
        if (who === 'Both') {
          p.fShared += amt;
          if (e.paidBy === 'V') p.fsv += amt;
          if (e.paidBy === 'K') p.fsk += amt;
        } else {
          p['fOwn' + who] += amt;
          p.fixedOwed += owedInFull(who, e.paidBy, amt);
        }
      }
      if (e.type === 'Personal') {
        const owner = e.expenseFor || e.paidBy;
        p.personal += owedInFull(owner, e.paidBy, amt);
        const key = { KK: 'kOnK', KV: 'kOnV', VV: 'vOnV', VK: 'vOnK' }[owner + e.paidBy];
        if (key) p[key] += amt;
      }
    };

    for (const op of pendingOps()) {
      if (op.table) continue; // Sonata and Funds have their own numbers
      if (op.op === 'add') {
        if (!sameMonth(op.entry)) continue;
        if (op.entry.type === 'Set balance') { p.start = op.entry.amount; hasBalance = true; }
        else apply(op.entry, 1);
      } else {
        const e = findRow('main', op.id);
        if (sameMonth(e)) apply(e, -1);
      }
    }
    for (const k of ['start', 'added', 'spent', 'v', 'k', 'fixed', 'fv', 'fk', 'fShared', 'fsv', 'fsk', 'fOwnV', 'fOwnK', 'fixedOwed', 'personal', 'kOnK', 'kOnV', 'vOnV', 'vOnK', 'settled', 'settledNet']) p[k] = round2(p[k] || 0);
    const balance = hasBalance ? round2(p.start + p.added - p.spent) : 0;
    return { balance, hasBalance, unsynced: getQueue().length, period: p };
  }

  // Which budgets the start-of-month prompt asks for.
  function missingBudgets() {
    const st = getState();
    const fresh = stateForMonth();
    const need = fresh && fresh.needsBudget
      ? { ...fresh.needsBudget }
      : { joint: true, V: !!(st && st.personalBudgets && st.personalBudgets.V), K: !!(st && st.personalBudgets && st.personalBudgets.K) };
    // Budgets set on this phone but not synced yet.
    for (const op of pendingOps()) {
      if (op.op !== 'add' || op.table || String(op.entry.date).slice(0, 7) !== currentMonth()) continue;
      if (op.entry.type === 'Set balance') need.joint = false;
      if (op.entry.type === 'Personal budget') need[op.entry.expenseFor] = false;
    }
    return need;
  }

  function renderMonthPrompt() {
    const card = $('monthPrompt');
    const need = missingBudgets();
    const dismissed = store.get('promptDismissed', '') === currentMonth();
    const personal = ['V', 'K'].filter((w) => need[w]);
    const show = !dismissed && !!getSettings() && (need.joint || personal.length > 0);
    card.hidden = !show || view === 'Car' || view === 'Funds';
    if (!show) return;
    const name = monthName(currentMonth());
    const parts = [];
    if (need.joint) parts.push('the joint budget');
    if (personal.length) parts.push(personal.join(' and ') + "'s personal budget");
    $('monthPromptText').textContent = `Set up ${name}: ${parts.join(' and ')} ${parts.length > 1 || personal.length > 1 ? 'are' : 'is'} not set yet. Budgets reset on the 1st; nothing carries over.`;
    $('promptJoint').hidden = !need.joint;
    $('promptPersonal').hidden = !personal.length;
  }

  function renderBalance() {
    const { balance, hasBalance, unsynced, period: p } = estimate();
    const el = $('balanceAmount');
    el.textContent = hasBalance ? money(Math.abs(balance)) : balance !== 0 ? money(balance) : '—';
    el.classList.toggle('neg', balance < 0);
    $('leftWord').hidden = !hasBalance;
    $('leftWord').textContent = balance < 0 ? 'over budget' : 'left';
    $('budgetDetails').hidden = !hasBalance;
    $('balanceLabel').textContent = hasBalance ? `${monthName(p.since)} budget` : 'Monthly budget';

    const notes = [];
    if (hasBalance) {
      const budget = round2(p.start + p.added);
      const used = budget > 0 ? Math.min(100, Math.max(0, (p.spent / budget) * 100)) : p.spent > 0 ? 100 : 0;
      const fill = $('meterFill');
      fill.style.width = used + '%';
      fill.className = 'meter-fill' + (balance < 0 ? ' over' : used >= 80 ? ' warn' : '');
      fill.parentElement.setAttribute('aria-valuenow', String(Math.round(used)));
      $('statBudget').textContent = money(budget);
      $('statSpent').textContent = money(p.spent);

      if (p.since.slice(0, 7) === today().slice(0, 7)) {
        const days = daysLeftInMonth();
        const dayWord = `${days} day${days > 1 ? 's' : ''}`;
        const perDay = balance > 0 ? balance / days : 0;
        $('statPerDay').textContent = balance > 0 ? money(perDay) : '—';
        $('paceLine').textContent = balance < 0
          ? `Over budget by ${money(-balance)} with ${dayWord} left.`
          : `${dayWord} left in ${monthName(today())}. About ${money(perDay)} a day keeps you within budget.`;
      } else {
        $('statPerDay').textContent = '—';
        $('paceLine').textContent = `This budget started ${prettyDate(p.since)}. Set a new one for ${monthName(today())}.`;
      }
    } else {
      notes.push("Set this month's budget to start tracking.");
    }

    if (unsynced) notes.push(`Includes ${unsynced} change${unsynced > 1 ? 's' : ''} not synced yet.`);
    const syncedAt = store.get('syncedAt', null);
    if (syncedAt && !unsynced) {
      notes.push('Updated ' + new Date(syncedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }));
    }
    $('balanceNote').textContent = notes.join(' ');
    renderSplit(p, hasBalance);
  }

  // Same math as the sheet: share = what each paid minus half the joint total.
  function renderSplit(p, hasBalance) {
    $('splitCard').hidden = !hasBalance;
    if (!hasBalance) return;
    const split = round2(p.spent / 2);
    const vShare = round2(p.v - split);
    const kShare = round2(p.k - split);
    $('paidV').textContent = money(p.v);
    $('paidK').textContent = money(p.k);
    $('paidTotal').textContent = money(p.spent);
    $('equalSplit').textContent = money(split);
    for (const [id, n] of [['shareV', vShare], ['shareK', kShare]]) {
      $(id).textContent = signed(n);
      $(id).className = n >= 0.01 ? 'pos' : n <= -0.01 ? 'neg' : '';
    }
    $('splitSince').textContent = 'Since ' + prettyDate(p.since);
    $('settleLine').textContent = settleText(vShare, kShare);

    const fx = fixedShares(p);
    const { fvShare, fkShare } = fx;
    const hasFixed = p.fixed !== 0 || p.fv !== 0 || p.fk !== 0;
    const pn = round2(p.personal || 0);
    const overall = 'Overall (joint + fixed + personal): ' + settleText(round2(vShare + fvShare + pn), round2(kShare + fkShare - pn));
    $('fixedCard').hidden = !hasFixed;
    $('overallLine').hidden = !hasFixed && Math.abs(pn) < 0.01;
    $('overallLine').textContent = overall;

    // Personal mode shows its own table: personal expenses paid on the other person's card.
    for (const key of ['kOnK', 'kOnV', 'vOnV', 'vOnK']) $(key).textContent = money(p[key] || 0);
    $('pSplitSince').textContent = 'Since ' + prettyDate(p.since);
    $('pSettle').textContent = settleText(pn, -pn);
    $('pOverall').textContent = overall;

    // After settlements (Splitwise, cash...): what is still owed, or Cleared.
    const net = round2(vShare + fvShare + pn);
    const status = statusOf(net, p.settledNet || 0, p.settled || 0);
    for (const id of ['statusLine', 'pStatus']) {
      $(id).textContent = status.text;
      $(id).className = 'status ' + status.kind;
    }
    renderOlderOpen();
    if (!hasFixed) return;
    $('fixedV').textContent = money(p.fv);
    $('fixedK').textContent = money(p.fk);
    $('fixedTotal').textContent = money(p.fixed);
    $('fixedShared').textContent = money(fx.shared);
    $('fixedOwnV').textContent = money(fx.ownV);
    $('fixedOwnK').textContent = money(fx.ownK);
    $('fixedEachV').textContent = money(fx.fixedV);
    $('fixedEachK').textContent = money(fx.fixedK);
    $('fixedSettle').textContent = settleText(fvShare, fkShare);
  }

  // net: what is owed before settlements (positive = K owes V); settledNet: positive = K paid V.
  function statusOf(net, settledNet, settled) {
    const remaining = round2(net - settledNet);
    const paid = settled ? (settledNet > 0 ? `K paid V ${money(settledNet)}` : settledNet < 0 ? `V paid K ${money(-settledNet)}` : `${money(settled)} both ways`) : '';
    if (Math.abs(remaining) < 0.01) {
      return settled ? { kind: 'cleared', text: `Cleared · ${paid}`, remaining: 0 } : { kind: 'even', text: 'Nothing owed', remaining: 0 };
    }
    return { kind: 'open', text: `Still owed: ${settleText(remaining, -remaining)}` + (paid ? ` (after ${paid})` : ''), remaining };
  }

  // Earlier months that still have money owed.
  function renderOlderOpen() {
    const st = getState();
    const older = ((st && st.unsettled) || []).filter((u) => u.month !== currentMonth());
    const el = $('olderOpen');
    el.hidden = !older.length;
    el.textContent = older.map((u) => `${u.label} still open: ${settleText(u.remaining, -u.remaining)}`).join(' · ');
  }

  function settleText(vShare, kShare) {
    if (vShare <= -0.01) return `V owes K ${money(-vShare)}`;
    if (kShare <= -0.01) return `K owes V ${money(-kShare)}`;
    return 'V and K are even';
  }

  const isCarMode = () => selectedType() === 'Car';

  // ---------- Navigation: Home (summaries) or one type's page. The form adds to the page's type;
  // on Home a small Add picker chooses the type.
  const VIEWS = ['Home', 'Joint', 'Fixed', 'Personal', 'Car', 'Funds'];
  const VIEW_LABELS = { Home: 'Home', Joint: 'Joint', Fixed: 'Fixed', Personal: 'Personal', Car: 'Sonata', Funds: 'Funds' };
  let view = VIEWS.includes(store.get('view', 'Home')) ? store.get('view', 'Home') : 'Home';
  function restoreType(type) {
    const el = document.querySelector(`input[name="type"][value="${type}"]`);
    if (el) el.checked = true;
  }
  function setView(v) {
    if (editing) cancelEdit();
    view = VIEWS.includes(v) ? v : 'Home';
    store.set('view', view);
    restoreType(view === 'Home' ? store.get('quickType', 'Joint') : view);
    $('navLabel').textContent = VIEW_LABELS[view];
    document.querySelectorAll('#navMenu button').forEach((b) => b.setAttribute('aria-current', b.dataset.view === view ? 'page' : 'false'));
    closeNav();
    updateTypeHint();
    window.scrollTo(0, 0);
  }
  function closeNav() {
    $('navMenu').hidden = true;
    $('navBtn').setAttribute('aria-expanded', 'false');
  }
  $('navBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    const open = $('navMenu').hidden;
    $('navMenu').hidden = !open;
    $('navBtn').setAttribute('aria-expanded', String(open));
  });
  $('navMenu').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-view]');
    if (b) setView(b.dataset.view);
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('.nav')) closeNav(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeNav(); });
  $('typeSeg').addEventListener('change', () => { if (view === 'Home') store.set('quickType', selectedType()); });

  // What the Recent list on this page shows: its table, its group (Joint, Fixed, Personal, or All on
  // Home), the latest rows from the sheet, how many the sheet has in all, and older rows loaded.
  function recentSource() {
    const st = getState() || {};
    if (isMoneyMode()) {
      const f = st.funds || {};
      return { table: 'funds', group: 'All', saved: f.recent || [], total: f.recentTotal };
    }
    if (isCarMode()) {
      const c = st.car || {};
      return { table: 'car', group: 'All', saved: c.recent || [], total: c.recentTotal };
    }
    const group = RECENT_GROUPS[view] ? view : 'All';
    const inGroup = (r) => group === 'All' || RECENT_GROUPS[group].includes(r.type || 'Joint');
    const saved = group === 'All' ? st.recent || [] : st.recentBy ? st.recentBy[group] || [] : (st.recent || []).filter(inGroup);
    return { table: 'main', group, inGroup, saved, total: st.recentTotal ? st.recentTotal[group] : undefined };
  }

  // Pending changes first, then the sheet's latest rows, then older rows loaded with Show more.
  function recentRows(src) {
    const queue = pendingOps().filter((op) => (op.table || 'main') === src.table);
    const deleting = new Set(queue.filter((op) => op.op === 'delete').map((op) => op.id));
    const pending = queue.filter((op) => op.op === 'add' && (!src.inGroup || src.inGroup(op.entry)))
      .map((op) => ({ ...op.entry, pending: true })).reverse();
    const more = loadedMore[`${src.table}|${src.group}`] || [];
    const seen = new Set();
    const saved = [...src.saved, ...more].filter((r) => {
      if (deleting.has(r.id) || seen.has(r.id)) return false;
      seen.add(r.id);
      return true;
    });
    return [...pending, ...saved];
  }

  // "Show more": the next page of older rows from the sheet (needs a connection).
  function renderMoreButton(src) {
    const btn = $('moreBtn');
    const loaded = src.saved.length + (loadedMore[`${src.table}|${src.group}`] || []).length;
    const left = src.total === undefined ? 0 : src.total - loaded;
    btn.hidden = left <= 0;
    btn.textContent = left > 0 ? `Show more (${left} older)` : '';
    btn.dataset.key = `${src.table}|${src.group}`;
    $('recentTitle').textContent = view === 'Home' ? 'Recent' : `Recent ${VIEW_LABELS[view]}`;
  }
  let loadingMore = false;
  $('moreBtn').addEventListener('click', async () => {
    if (loadingMore) return;
    const src = recentSource();
    const key = `${src.table}|${src.group}`;
    const have = loadedMore[key] || [];
    loadingMore = true;
    $('moreBtn').textContent = 'Loading…';
    try {
      const data = await call({ action: 'list', table: src.table, group: src.group, offset: src.saved.length + have.length, limit: 25 });
      saveState(data);
      if (data.list && data.list.rows) loadedMore[key] = have.concat(data.list.rows);
    } catch (err) {
      showBanner(err.kind === 'network' ? 'Connect to the internet to load older entries.' : err.message, 'err', true);
    } finally {
      loadingMore = false;
      render();
    }
  });

  function renderRecent() {
    if (isMoneyMode()) return renderMoneyRecent();
    const isCar = isCarMode();
    const src = recentSource();
    const rows = recentRows(src);
    renderMoreButton(src);

    const list = $('recentList');
    list.innerHTML = '';
    if (!rows.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'Nothing yet.';
      list.appendChild(li);
    }
    for (const r of rows) {
      const li = document.createElement('li');
      li.className = [isCar && r.category !== 'Settlement' ? 'c-car' : colorClass(r), r.pending ? 'pending' : '',
        editing && editing.id === r.id ? 'editing' : ''].filter(Boolean).join(' ');

      const body = document.createElement('div');
      body.className = 'body';
      const top = document.createElement('div');
      top.className = 'top';
      const name = document.createElement('span');
      name.textContent = isCar ? r.vendor || r.category : r.category;
      const amt = document.createElement('span');
      amt.textContent = (r.type === 'Add funds' ? '+' : '') + money(r.amount);
      const isSettlement = r.type === 'Settlement' || r.category === 'Settlement';
      const refundRow = r.amount < 0 && !isSettlement && (isCar || ['Joint', 'Fixed', 'Personal'].includes(r.type));
      if (refundRow) amt.className = 'refund-amt';
      top.append(name, amt);

      const sub = document.createElement('div');
      sub.className = 'sub';
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = isCar ? r.category : TYPE_LABELS[r.type] || r.type || 'Joint';
      const owner = r.expenseFor && r.expenseFor !== 'Both' ? r.expenseFor : '';
      const parts = [prettyDate(r.date)];
      if (!isCar && r.tag && (r.type === 'Joint' || r.type === 'Personal')) parts.push(r.tag);
      if (refundRow) parts.push('refund');
      if (isSettlement) parts.push(`${r.paidBy} paid ${r.paidBy === 'V' ? 'K' : 'V'}`);
      else if (isCar && r.expenseFor === 'Joint') parts.push('Joint');
      else if (owner && (r.type === 'Personal' || r.type === 'Fixed' || (isCar && owner !== r.paidBy))) parts.push(`for ${owner}`);
      else if (r.type === 'Fixed') parts.push('shared');
      if (isSettlement) { /* who paid whom is already shown */ }
      else if (r.paidBy === 'V' || r.paidBy === 'K') parts.push(`${r.paidBy}'s card`);
      else if (r.paidBy) parts.push(`by ${r.paidBy}`);
      if (isCar && r.category === 'Fuel') {
        if (r.fill === 'Partial') parts.push('partial');
        if (r.missedBefore) parts.push('after missed fill-up');
        if (r.miles !== undefined && r.miles !== '') parts.push(`${num(r.miles)} mi`);
        if (r.mpg !== undefined && r.mpg !== '') parts.push(`${Number(r.mpg).toFixed(1)} MPG`);
        if (r.gallons !== undefined && r.gallons !== '') parts.push(`${r.gallons} gal`);
      }
      parts.push(r.notes);
      if (!isCar && !isSettlement && r.balance !== undefined && r.balance !== '') parts.push('joint left ' + money(r.balance));
      sub.append(tag, document.createTextNode(parts.filter(Boolean).join(' · ')));
      body.append(top, sub);
      li.appendChild(body);

      const editable = isCar ? !isSettlement : ['Joint', 'Fixed', 'Personal'].includes(r.type);
      if (r.id && editable) li.appendChild(editButton(r, isCar ? 'car' : '', name.textContent));
      if (r.id) {
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'del';
        del.setAttribute('aria-label', `Delete ${r.category}`);
        del.textContent = '×';
        del.addEventListener('click', () => removeEntry(r, isCar ? 'car' : ''));
        li.appendChild(del);
      }
      list.appendChild(li);
    }

    const n = getQueue().length;
    $('syncNote').textContent = n ? `${n} waiting to sync` : '';
  }

  // Each type shows its own budget: Joint the joint monthly budget, Personal the two personal
  // budgets, Fixed and Sonata none (bills get paid regardless; the car has its own stats).
  function render() {
    const type = view;
    const isCar = type === 'Car';
    const isMoney = type === 'Funds';
    const isHome = type === 'Home';
    $('mainDash').hidden = isCar || isMoney || isHome;
    $('carDash').hidden = !isCar;
    $('moneyDash').hidden = !isMoney;
    $('homeDash').hidden = !isHome;
    $('typeField').hidden = !isHome;
    fillTags(); // tags of your own learned from the sheet
    renderBalance();
    renderPersonalBudgets();
    renderMonthPrompt();
    $('jointCard').hidden = type !== 'Joint';
    $('personalBudgetCard').hidden = type !== 'Personal';
    const hasBalance = estimate().hasBalance;
    $('splitCard').hidden = !hasBalance || type === 'Personal';
    $('personalSplitCard').hidden = !hasBalance || type !== 'Personal';
    if (type === 'Fixed') $('fixedCard').hidden = false;
    if (type === 'Personal') $('fixedCard').hidden = true;
    if (isCar) renderCar();
    if (isMoney) renderMoney();
    if (isHome) renderHome();
    renderRecent();
  }

  // ---------- Personal budgets
  // What the sheet reported, plus changes not synced yet.
  function estimatePersonal() {
    const st = stateForMonth();
    const pb = { V: null, K: null };
    for (const who of ['V', 'K']) {
      const b = st && st.personalBudgets && st.personalBudgets[who];
      if (b) pb[who] = { month: b.month || String(b.since).slice(0, 7), since: b.since, budget: b.budget, spent: b.spent };
    }
    // A personal budget covers a calendar month: every Personal expense for that person dated in
    // that month counts, whoever's card paid, even one logged before the budget was set.
    const inMonth = (b, date) => b && String(date).slice(0, 7) === b.month;
    for (const op of pendingOps()) {
      if (op.table) continue;
      if (op.op === 'add' && op.entry.type === 'Personal budget') {
        const month = op.entry.date.slice(0, 7);
        if (month !== currentMonth()) continue;
        const prev = pb[op.entry.expenseFor];
        pb[op.entry.expenseFor] = { month, since: month + '-01', budget: op.entry.amount, spent: prev && prev.month === month ? prev.spent : 0 };
      } else if (op.op === 'add' && op.entry.type === 'Personal') {
        const b = pb[op.entry.expenseFor || op.entry.paidBy];
        if (inMonth(b, op.entry.date)) b.spent += op.entry.amount;
      } else if (op.op === 'delete') {
        const e0 = findRow('main', op.id);
        const e = e0 && e0.type === 'Personal' ? e0 : undefined;
        const b = e && pb[e.expenseFor || e.paidBy];
        if (inMonth(b, e && e.date)) b.spent -= e.amount;
      }
    }
    for (const who of ['V', 'K']) {
      const b = pb[who];
      if (!b) continue;
      b.spent = round2(b.spent);
      b.remaining = round2(b.budget - b.spent);
    }
    return pb;
  }

  function renderPersonalBudgets() {
    const pb = estimatePersonal();
    for (const who of ['V', 'K']) {
      const row = $('pb' + who);
      const b = pb[who];
      const left = row.querySelector('.pb-left');
      const fill = row.querySelector('.meter-fill');
      const sub = row.querySelector('.pb-sub');
      if (!b) {
        left.textContent = 'Not set';
        left.className = 'pb-left unset';
        fill.style.width = '0%';
        sub.textContent = 'No personal budget yet.';
        continue;
      }
      const used = b.budget > 0 ? Math.min(100, Math.max(0, (b.spent / b.budget) * 100)) : b.spent > 0 ? 100 : 0;
      left.textContent = b.remaining < 0 ? `${money(-b.remaining)} over` : `${money(b.remaining)} left`;
      left.className = 'pb-left' + (b.remaining < 0 ? ' neg' : '');
      fill.style.width = used + '%';
      fill.className = 'meter-fill' + (b.remaining < 0 ? ' over' : used >= 80 ? ' warn' : '');
      row.querySelector('.meter').setAttribute('aria-valuenow', String(Math.round(used)));
      let text = `Spent ${money(b.spent)} of ${money(b.budget)} in ${monthName(b.since)}, any card`;
      if (b.month === today().slice(0, 7) && b.remaining > 0) {
        text += ` · about ${money(b.remaining / daysLeftInMonth())} a day`;
      } else if (b.month !== today().slice(0, 7)) {
        text += ` · set a new one for ${monthName(today())}`;
      }
      sub.textContent = text;
    }
    $('pbNote').textContent = pb.V || pb.K ? '' : "Set a monthly personal budget for V, K or both. Each person's Personal expenses come out of their own budget.";
  }

  $('promptJoint').addEventListener('click', () => $('setBalanceBtn').click());
  $('promptPersonal').addEventListener('click', () => $('setPersonalBtn').click());
  $('promptLater').addEventListener('click', () => { store.set('promptDismissed', currentMonth()); renderMonthPrompt(); });

  // ---------- Record a settlement (Splitwise, cash...)
  const settleDialog = $('settleDialog');
  let settleTable = 'main';

  // What is still owed for a month (positive = K owes V), including changes not synced yet.
  function remainingFor(month) {
    if (settleTable === 'car') {
      const c = (getState() || {}).car || {};
      let r = c.remaining !== undefined ? c.remaining : c.owed || 0;
      for (const { e, sign } of carChanges()) {
        if (e.category === 'Settlement') r -= sign * (e.paidBy === 'K' ? e.amount : -e.amount);
        else r += sign * carOwed(e.expenseFor || e.paidBy, e.paidBy, e.amount);
      }
      return round2(r);
    }
    if (month === currentMonth()) {
      const p = estimate().period;
      const split = round2(p.spent / 2);
      return round2((p.v - split) + fixedShares(p).fvShare + (p.personal || 0) - (p.settledNet || 0));
    }
    const u = (((getState() || {}).unsettled) || []).find((x) => x.month === month);
    let r = u ? u.remaining : 0;
    for (const op of pendingOps()) {
      if (op.op === 'add' && !op.table && op.entry.type === 'Settlement' && op.entry.month === month) {
        r -= op.entry.paidBy === 'K' ? op.entry.amount : -op.entry.amount;
      }
    }
    return round2(r);
  }

  function fillSettleAmount() {
    const r = remainingFor($('settleMonth').value);
    $('settleWho').value = r < 0 ? 'V' : 'K';
    $('settleAmount').value = Math.abs(r) >= 0.01 ? Math.abs(r).toFixed(2) : '';
    updateSettleOwed();
  }

  // What is left after the payment being typed: partial, cleared, or more than is owed.
  function settleAfter() {
    const r = remainingFor($('settleMonth').value);
    const amt = parseAmount($('settleAmount').value) || 0;
    return { r, amt, after: round2(r - ($('settleWho').value === 'K' ? amt : -amt)) };
  }
  const overpaid = ({ r, after }) => Math.abs(after) >= 0.01 && (Math.abs(r) < 0.01 || Math.sign(after) !== Math.sign(r));

  function updateSettleOwed() {
    const x = settleAfter();
    let text = Math.abs(x.r) >= 0.01 ? `Still owed: ${settleText(x.r, -x.r)}.` : 'Nothing is owed for this right now.';
    if (x.amt) {
      if (Math.abs(x.after) < 0.01) text += ' This payment clears it.';
      else if (overpaid(x)) text += ` That is more than is owed: afterwards ${settleText(x.after, -x.after)}.`;
      else text += ` After this: ${settleText(x.after, -x.after)} (partial).`;
    }
    $('settleOwed').textContent = text;
    $('settleOwed').classList.toggle('warn', !!x.amt && overpaid(x));
  }

  function openSettle(table) {
    settleTable = table;
    $('settleForm').reset();
    clearInvalid($('settleForm'));
    $('settleDate').value = today();
    const select = $('settleMonth');
    select.innerHTML = '';
    if (table === 'car') {
      const opt = document.createElement('option');
      opt.value = 'car';
      opt.textContent = 'Sonata (car costs)';
      select.appendChild(opt);
    } else {
      const open = ((getState() || {}).unsettled || []).map((u) => u.month);
      const months = [currentMonth(), ...open.filter((m) => m !== currentMonth())];
      for (const m of months) {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = monthName(m) + ' ' + m.slice(0, 4);
        select.appendChild(opt);
      }
      // Default: the oldest month still owed, else this month.
      const older = open.filter((m) => m !== currentMonth());
      select.value = older.length ? older[older.length - 1] : currentMonth();
    }
    $('settleMonthField').hidden = table === 'car';
    fillSettleAmount();
    settleDialog.showModal();
  }
  $('settleBtn').addEventListener('click', () => openSettle('main'));
  $('pSettleBtn').addEventListener('click', () => openSettle('main'));
  $('carSettleBtn').addEventListener('click', () => openSettle('car'));
  $('settleMonth').addEventListener('change', fillSettleAmount);
  $('settleWho').addEventListener('change', updateSettleOwed);
  $('settleAmount').addEventListener('input', () => { $('settleAmount').classList.remove('invalid'); updateSettleOwed(); });

  $('settleForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (e.submitter && e.submitter.value === 'cancel') return settleDialog.close();
    const amount = parseAmount($('settleAmount').value);
    if (amount === null || amount <= 0) return $('settleAmount').classList.add('invalid');
    const date = $('settleDate').value;
    if (!date) return $('settleDate').classList.add('invalid');
    // Overpay guard: a payment past what is owed would flip the debt to the other person.
    const x = settleAfter();
    if (overpaid(x)) {
      const owedText = Math.abs(x.r) < 0.01 ? 'Nothing is owed' : `Only ${money(Math.abs(x.r))} is owed`;
      if (!confirm(`${owedText}. Recording ${money(amount)} would leave ${settleText(x.after, -x.after)}. Record it anyway?`)) return;
    }
    settleDialog.close();
    const who = $('settleWho').value;
    const method = $('settleMethod').value;
    const notes = $('settleNotes').value.trim();
    if (settleTable === 'car') {
      enqueue({ op: 'add', table: 'car', entry: { id: uuid(), date, category: 'Settlement', vendor: '', amount, paidBy: who, method, notes,
        odometer: '', rangeLeft: '', gallons: '', pricePerGallon: '', fill: '', missedBefore: false } });
    } else {
      enqueue({ op: 'add', entry: { id: uuid(), date, month: $('settleMonth').value, category: '', amount, paidBy: who,
        expenseFor: who === 'V' ? 'K' : 'V', method, notes, type: 'Settlement' } });
    }
    const status = await sync();
    report(status, `Settlement recorded ✓ ${who === 'K' ? 'K paid V' : 'V paid K'} ${money(amount)} via ${method}` +
      (Math.abs(x.after) < 0.01 ? ' · cleared' : ` · still owed: ${settleText(x.after, -x.after)}`));
  });

  const personalDialog = $('personalDialog');
  $('setPersonalBtn').addEventListener('click', () => {
    $('personalForm').reset();
    clearInvalid($('personalForm'));
    $('pbDate').value = today();
    personalDialog.showModal();
    $('pbAmountV').focus();
  });

  $('personalForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (e.submitter && e.submitter.value === 'cancel') return personalDialog.close();
    const date = $('pbDate').value;
    if (!date) return $('pbDate').classList.add('invalid');
    const entries = [];
    for (const who of ['V', 'K']) {
      const input = $('pbAmount' + who);
      if (!input.value.trim()) continue;
      const amount = parseAmount(input.value);
      if (amount === null || amount <= 0) return input.classList.add('invalid');
      entries.push({ id: uuid(), date, category: '', amount, paidBy: who, expenseFor: who, notes: '', type: 'Personal budget' });
    }
    if (!entries.length) {
      $('pbAmountV').classList.add('invalid');
      $('pbAmountK').classList.add('invalid');
      return;
    }
    personalDialog.close();
    entries.forEach((entry) => enqueue({ op: 'add', entry }));
    const status = await sync();
    report(status, 'Personal budget set ✓ ' + entries.map((x) => `${x.expenseFor} ${money(x.amount)}`).join(', '));
  });

  // ---------- Sonata (car)
  const num = (n, digits = 0) => Number(n).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const per = (n) => '$' + Number(n).toFixed(3);

  // Sonata changes not synced yet, each with +1 (added) or -1 (deleted, or the old side of an edit).
  function carChanges() {
    return pendingOps().filter((op) => op.table === 'car').map((op) => (op.op === 'add'
      ? { e: op.entry, sign: 1 } : { e: findRow('car', op.id), sign: -1 })).filter((x) => x.e);
  }

  // Highest odometer known, including fill-ups still waiting to sync.
  function lastOdometer() {
    const st = getState();
    let odo = st && st.car ? Number(st.car.lastOdometer) || 0 : 0;
    for (const op of getQueue()) {
      if (op.table === 'car' && op.op === 'add' && op.entry.category === 'Fuel' && op.entry.odometer !== '') {
        odo = Math.max(odo, Number(op.entry.odometer));
      }
    }
    return odo;
  }

  const TANK_GALLONS = 13.2; // 2026 Sonata Hybrid

  // The stretch since the last Full fill: where it started and the gallons and dollars added since.
  // The next Full fill closes it: MPG = stretch miles / all those gallons (partials included).
  function openStretch() {
    const st = getState();
    const base = st && st.car && st.car.open;
    let open = base ? { ...base } : null;
    for (const op of getQueue()) {
      if (op.table !== 'car' || op.op !== 'add' || op.entry.category !== 'Fuel' || op.entry.odometer === '') continue;
      const e = op.entry;
      const g = e.gallons ? e.gallons : e.pricePerGallon ? e.amount / e.pricePerGallon : null;
      if (e.missedBefore) open = null;
      if (e.fill === 'Partial') {
        if (open) { open.gallons += g || 0; open.amount += e.amount; open.known = open.known && g !== null; }
      } else {
        open = { startOdo: Number(e.odometer), gallons: 0, amount: 0, known: true };
      }
    }
    return open;
  }

  function renderCar() {
    const st = getState();
    const c = (st && st.car) || null;
    const dash = (v, f) => (c && v ? f(v) : '—');
    $('carMpg').textContent = dash(c && c.mpg, (v) => Number(v).toFixed(1));
    $('carRolling').textContent = c && c.rollingMpg
      ? `Rolling MPG (last 5 fills): ${Number(c.rollingMpg).toFixed(1)}` +
        (c.partials || c.missed ? ` · ${c.partials} partial, ${c.missed} missed fill-up${c.missed === 1 ? '' : 's'} handled` : '')
      : 'Overall MPG counts full-to-full tanks; partial fills roll into the next full one.';
    $('carPpg').textContent = dash(c && c.avgPpg, per);
    $('carFuelCpm').textContent = dash(c && c.fuelCpm, per);
    $('carTotalCpm').textContent = dash(c && c.totalCpm, per);
    $('carMiles').textContent = dash(c && c.milesTracked, (v) => num(v));
    $('carPerTank').textContent = dash(c && c.avgMilesPerTank, (v) => num(v));
    $('carEff').textContent = dash(c && c.avgEffRange, (v) => num(v));
    const lf = c && c.lastFill;
    $('carLastFill').textContent = lf
      ? `Last fill-up ${prettyDate(lf.date)} at ${num(lf.odometer)} mi` +
        (lf.partial ? ' (partial; its MPG comes with the next full fill)' : '') +
        (lf.miles !== '' ? `: ${num(lf.miles)} mi` : '') +
        (lf.mpg !== '' ? `, ${Number(lf.mpg).toFixed(1)} MPG for that tank` : '') +
        (lf.eff !== '' ? `, effective range ${num(lf.eff)} mi` : '') +
        (c.fills ? `. ${c.fills} fill-ups, ${money(c.fuelSpend)} on fuel.` : '')
      : 'No fill-ups yet. Pick Fuel below to log one.';

    // What each has paid (by card) and what joint or other-card costs leave owed,
    // plus car entries not synced yet.
    let v = c ? c.v : 0;
    let k = c ? c.k : 0;
    let owed = c ? c.owed || 0 : 0;
    let settledNet = c ? c.settledNet || 0 : 0;
    let settled = c ? c.settled || 0 : 0;
    const turns = { V: 0, K: 0, Joint: 0, ...((c && c.turns) || {}) };
    for (const { e, sign } of carChanges()) {
      const amt = sign * e.amount;
      if (e.category === 'Settlement') {
        settled += amt;
        settledNet += e.paidBy === 'K' ? amt : -amt;
        continue;
      }
      if (e.paidBy === 'V') v += amt;
      if (e.paidBy === 'K') k += amt;
      const owner = e.expenseFor || e.paidBy;
      owed += carOwed(owner, e.paidBy, amt);
      if (e.category === 'Fuel' && turns[owner] !== undefined) turns[owner] += sign;
    }
    owed = round2(owed);
    $('carPaidV').textContent = money(round2(v));
    $('carPaidK').textContent = money(round2(k));
    $('carPaidTotal').textContent = money(round2(v + k));
    const carStatus = statusOf(owed, round2(settledNet), round2(settled));
    $('carSettle').textContent = carStatus.text;
    $('carSettle').className = 'settle status ' + carStatus.kind;
    $('carTurns').textContent = `Fill-ups by turn: V ${turns.V} · K ${turns.K} · Joint ${turns.Joint}`;

    const cats = $('carCategories');
    cats.innerHTML = '';
    const byCat = (c && c.byCategory) || {};
    const names = Object.keys(byCat).filter((n) => byCat[n]).sort((a, b) => byCat[b] - byCat[a]);
    if (!names.length) {
      const li = document.createElement('li');
      li.className = 'muted';
      li.textContent = 'Nothing yet.';
      cats.appendChild(li);
    }
    for (const n of names) {
      const li = document.createElement('li');
      const a = document.createElement('span');
      a.textContent = n;
      const b = document.createElement('span');
      b.textContent = money(byCat[n]);
      li.append(a, b);
      cats.appendChild(li);
    }

    const charts = $('carCharts');
    charts.innerHTML = '';
    const tanks = (c && c.stretches) || [];
    const fills = (c && c.fills_log) || [];
    const monthly = (c && c.monthly) || [];
    const rolling = fills.filter((f) => f.rolling !== '');
    const prices = fills.filter((f) => f.ppg !== '');
    if (tanks.length < 2 && prices.length < 2 && monthly.length < 1) {
      charts.textContent = 'Charts appear after a few fill-ups with odometer and gallons.';
      charts.className = 'muted';
      return;
    }
    charts.className = 'charts';
    if (tanks.length >= 2) {
      charts.appendChild(lineChart('MPG per full tank (full-to-full)', tanks.map((p) => ({ x: p.date, y: p.mpg })), (y) => y.toFixed(1)));
    }
    if (rolling.length >= 2) {
      charts.appendChild(lineChart('Rolling MPG (last 5 fills)', rolling.map((p) => ({ x: p.date, y: p.rolling })), (y) => y.toFixed(1)));
    }
    if (prices.length >= 2) {
      charts.appendChild(lineChart('Price per gallon (every fill)', prices.map((p) => ({ x: p.date, y: p.ppg })), (y) => '$' + y.toFixed(2)));
    }
    if (tanks.length >= 2) {
      charts.appendChild(lineChart('Fuel cost per mile', tanks.filter((p) => p.cpm).map((p) => ({ x: p.date, y: p.cpm })), (y) => '$' + y.toFixed(3)));
    }
    if (monthly.length) {
      charts.appendChild(barChart('Car spend per month', monthly.map((m) => ({ x: m.month, y: m.total }))));
    }
  }

  // Small dependency-free SVG charts.
  const SVG = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs, text) {
    const el = document.createElementNS(SVG, tag);
    for (const k of Object.keys(attrs || {})) el.setAttribute(k, attrs[k]);
    if (text !== undefined) el.textContent = text;
    return el;
  }

  function chartFrame(title) {
    const fig = document.createElement('figure');
    fig.className = 'chart';
    const cap = document.createElement('figcaption');
    cap.textContent = title;
    fig.appendChild(cap);
    const svg = svgEl('svg', { viewBox: '0 0 320 130', role: 'img', 'aria-label': title });
    fig.appendChild(svg);
    return { fig, svg };
  }

  const shortDate = (iso) => (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? prettyDate(iso) : iso);
  const shortMonth = (ym) => {
    const m = /^(\d{4})-(\d{2})$/.exec(ym || '');
    return m ? new Date(+m[1], m[2] - 1, 1).toLocaleDateString('en-US', { month: 'short' }) : ym;
  };

  function lineChart(title, points, fmt) {
    const { fig, svg } = chartFrame(title);
    if (points.length < 2) return fig;
    const L = 40, R = 312, T = 10, B = 104;
    const ys = points.map((p) => p.y);
    let min = Math.min(...ys), max = Math.max(...ys);
    if (min === max) { min -= 1; max += 1; }
    const pad = (max - min) * 0.1;
    min -= pad; max += pad;
    const x = (i) => L + (i * (R - L)) / (points.length - 1);
    const y = (v) => B - ((v - min) / (max - min)) * (B - T);
    [max - pad, min + pad].forEach((v) => {
      svg.appendChild(svgEl('line', { x1: L, x2: R, y1: y(v), y2: y(v), class: 'grid' }));
      svg.appendChild(svgEl('text', { x: L - 4, y: y(v) + 4, 'text-anchor': 'end', class: 'axis' }, fmt(v)));
    });
    svg.appendChild(svgEl('polyline', { points: points.map((p, i) => `${x(i)},${y(p.y)}`).join(' '), class: 'line' }));
    points.forEach((p, i) => {
      const dot = svgEl('circle', { cx: x(i), cy: y(p.y), r: 3, class: 'dot' });
      dot.appendChild(svgEl('title', {}, `${shortDate(p.x)}: ${fmt(p.y)}`));
      svg.appendChild(dot);
    });
    svg.appendChild(svgEl('text', { x: L, y: 124, class: 'axis' }, shortDate(points[0].x)));
    svg.appendChild(svgEl('text', { x: R, y: 124, 'text-anchor': 'end', class: 'axis' }, shortDate(points[points.length - 1].x)));
    const last = points[points.length - 1];
    svg.appendChild(svgEl('text', { x: x(points.length - 1) - 6, y: y(last.y) - 8, 'text-anchor': 'end', class: 'value' }, fmt(last.y)));
    return fig;
  }

  function barChart(title, points) {
    const { fig, svg } = chartFrame(title);
    const L = 8, R = 312, T = 18, B = 104;
    const max = Math.max(...points.map((p) => p.y), 1);
    const slot = (R - L) / points.length;
    const w = Math.min(36, slot * 0.7);
    points.forEach((p, i) => {
      const h = (p.y / max) * (B - T);
      const cx = L + slot * i + slot / 2;
      const bar = svgEl('rect', { x: cx - w / 2, y: B - h, width: w, height: Math.max(h, 1), rx: 3, class: 'bar' });
      bar.appendChild(svgEl('title', {}, `${shortMonth(p.x)}: ${money(p.y)}`));
      svg.appendChild(bar);
      svg.appendChild(svgEl('text', { x: cx, y: B - h - 4, 'text-anchor': 'middle', class: 'value' }, '$' + Math.round(p.y)));
      svg.appendChild(svgEl('text', { x: cx, y: 122, 'text-anchor': 'middle', class: 'axis' }, shortMonth(p.x)));
    });
    return fig;
  }

  // ---------- Talking to the Apps Script web app (text/plain avoids a CORS preflight)
  function failure(kind, message) {
    return Object.assign(new Error(message), { kind });
  }

  async function call(payload) {
    const s = getSettings();
    if (!s) throw failure('setup', 'Open ⚙︎ Settings to connect your sheet.');
    let res;
    try {
      res = await fetch(s.url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ ...payload, key: s.key, today: today() }),
      });
    } catch {
      throw failure('network', 'No connection.');
    }
    let data;
    try {
      data = await res.json();
    } catch {
      throw failure('config', 'The web app URL did not answer correctly. Check ⚙︎ Settings.');
    }
    if (!data.ok) {
      const kind = /key/i.test(data.error || '') ? 'config' : 'server';
      throw failure(kind, kind === 'config' ? `${data.error} Check ⚙︎ Settings.` : data.error || 'Server error.');
    }
    return data;
  }

  function saveState(data) {
    store.set('state', {
      balance: data.balance,
      hasBalance: data.hasBalance,
      period: data.period,
      recent: data.recent || [],
      recentBy: data.recentBy || null,
      recentTotal: data.recentTotal || null,
      version: data.version || 0,
      car: data.car || null,
      personalBudgets: data.personalBudgets || null,
      month: data.month || '',
      needsBudget: data.needsBudget || null,
      funds: data.funds || null,
      analytics: data.analytics || null,
      unsettled: data.unsettled || [],
    });
    store.set('syncedAt', Date.now());
  }

  const heldBack = (op) => {
    const st = getState();
    return !!st && st.version < requiredVersion(op);
  };
  const nextOp = () => getQueue().find((op) => !heldBack(op));

  // Sends queued changes in order, then refreshes.
  // Returns 'ok', 'rejected', 'outdated', 'offline', 'config' or 'setup'.
  let syncing = null;
  function sync() {
    if (!syncing) syncing = runSync().finally(() => { syncing = null; });
    return syncing;
  }

  async function runSync() {
    let rejected = false;
    try {
      // Learn the script's version before sending anything that depends on it, and check again
      // while Fixed bills are being held (the script may have been redeployed since).
      const st = getState();
      if (!st || st.version === undefined || getQueue().some(heldBack)) saveState(await call({ action: 'state' }));
      let sent = false;
      for (let op = nextOp(); op; op = nextOp()) {
        try {
          const data = await call(op.op === 'delete'
            ? { action: 'delete', table: op.table, id: op.id }
            : { action: op.op, table: op.table, entry: op.entry });
          saveState(data);
          sent = true;
          loadedMore = {}; // the sheet changed: older rows are loaded again when asked
        } catch (err) {
          if (err.kind !== 'server') throw err;
          // The sheet refused this change (bad data); drop it so it does not block the rest.
          rejected = true;
          const what = op.op === 'delete' ? 'delete' : `${op.op === 'update' ? 'edit of ' : ''}${op.entry.category || op.entry.kind} ${money(op.entry.amount)}`;
          showBanner(`Not saved (${what}): ${err.message}`, 'err', true);
        }
        setQueue(getQueue().filter((o) => o.opId !== op.opId));
        render();
      }
      if (!sent) saveState(await call({ action: 'state' }));
      render();
      if (getQueue().some(heldBack)) {
        showBanner(OUTDATED_MESSAGE, 'err', true);
        return 'outdated';
      }
      return rejected ? 'rejected' : 'ok';
    } catch (err) {
      render();
      if (err.kind === 'network') return 'offline';
      showBanner(err.message, 'err', true);
      return err.kind;
    }
  }

  function enqueue(op) {
    setQueue([...getQueue(), { opId: uuid(), ...op }]);
    render();
  }

  // Shows the result of a sync started by the user. okMessage null = stay quiet on success.
  function report(status, okMessage) {
    if (status === 'ok' && okMessage) showBanner(okMessage, 'ok');
    if (status === 'offline' && okMessage) showBanner('Saved on this phone. It will sync when you are back online.', 'warn');
    if (status === 'setup') openSettings();
  }

  // ---------- Expense form
  function selectedType() {
    const checked = document.querySelector('input[name="type"]:checked');
    return checked ? checked.value : 'Joint';
  }

  function selectedFixed() {
    const checked = document.querySelector('input[name="fixedCat"]:checked');
    return checked ? checked.value : '';
  }

  // ---------- Tags
  let tagPicked = false; // true once the tag was chosen by hand (then typing the category leaves it alone)
  // Tags of your own: made by picking Other and typing a name. Saved on this phone and learned back
  // from the sheet, so both phones offer them.
  const cleanTag = (v) => {
    const t = String(v || '').replace(/\s+/g, ' ').trim().slice(0, 30);
    if (!t || /^[=+\-@]/.test(t)) return '';
    const known = allTags().find((x) => x.toLowerCase() === t.toLowerCase());
    return known || t.charAt(0).toUpperCase() + t.slice(1);
  };
  function customTags() {
    const fromSheet = (((getState() || {}).analytics) || {}).customTags || [];
    const out = [];
    for (const t of [...store.get('customTags', []), ...fromSheet]) if (t && !TAGS.includes(t) && !out.includes(t)) out.push(t);
    return out;
  }
  // Standard tags, then your own, with Other last.
  const allTags = () => [...TAGS.filter((t) => t !== 'Other'), ...customTags(), 'Other'];
  let tagList = '';
  function fillTags() {
    const tags = allTags();
    if (tags.join('|') === tagList) return;
    tagList = tags.join('|');
    const select = $('tag');
    const keep = select.value;
    select.length = 1; // keep "Pick a tag"
    for (const t of tags) select.add(new Option(t === 'Other' ? 'Other (make your own…)' : t, t));
    select.value = tags.includes(keep) ? keep : keep ? 'Other' : '';
  }
  function addCustomTag(t) {
    if (!t || TAGS.includes(t)) return;
    const mine = store.get('customTags', []);
    if (!mine.includes(t)) store.set('customTags', [...mine, t]);
    fillTags();
  }
  fillTags();
  function updateTagNew() {
    const show = !$('tagField').hidden && $('tag').value === 'Other';
    $('tagNewField').hidden = !show;
    if (!show) $('tagNew').value = '';
  }
  // The tag to save: a new tag of your own when one is typed under Other.
  function chosenTag() {
    if ($('tag').value !== 'Other') return $('tag').value;
    return cleanTag($('tagNew').value) || 'Other';
  }
  function suggestTag(category) {
    const c = String(category || '').trim().toLowerCase();
    if (!c) return '';
    const known = store.get('tagMemory', {})[c];
    if (allTags().includes(known)) return known;
    const hit = TAG_GUESSES.find(([, re]) => re.test(c));
    return hit ? hit[0] : 'Other';
  }
  function rememberTag(category, tag) {
    const memory = store.get('tagMemory', {});
    memory[String(category).trim().toLowerCase()] = tag;
    const keys = Object.keys(memory);
    if (keys.length > 300) delete memory[keys[0]];
    store.set('tagMemory', memory);
  }
  $('category').addEventListener('input', () => { if (!tagPicked) { $('tag').value = suggestTag($('category').value); updateTagNew(); } });
  $('tag').addEventListener('change', () => {
    tagPicked = !!$('tag').value;
    $('tag').classList.remove('invalid');
    updateTagNew();
    if ($('tag').value === 'Other') $('tagNew').focus();
  });

  // Shows the description for the selected type, and swaps the Category typing field
  // for the fixed bill buttons when Fixed is selected.
  function updateTypeHint() {
    const type = selectedType();
    $('typeHint').textContent = TYPE_HINTS[type];
    const fixed = type === 'Fixed';
    const car = type === 'Car';
    const moneyType = type === 'Funds';
    $('category').hidden = fixed;
    $('fixedPicker').hidden = !fixed;
    $('categoryField').hidden = car || moneyType;
    $('tagField').hidden = !(type === 'Joint' || type === 'Personal');
    fillTags();
    updateTagNew();
    $('carFields').hidden = !car;
    $('moneyFields').hidden = !moneyType;
    $('payGrid').hidden = moneyType;
    $('owedHint').hidden = true;
    $('categoryLabel').textContent = fixed ? 'Fixed bill' : 'Category';
    $('saveBtn').textContent = editing ? 'Save changes' : car ? 'Save car expense' : moneyType ? 'Save to Funds' : 'Save expense';
    if (moneyType) setupMoneyFields();
    setupExpenseFor(type);
    updateCarFields();
    render();
  }

  // Whose expense it is: only asked for Personal (V or K).
  const FOR_OPTIONS = {
    Personal: [['V', 'V'], ['K', 'K']],
    Fixed: [['Both', 'Both (split)'], ['V', 'V'], ['K', 'K']],
    Car: [['V', 'V'], ['K', 'K'], ['Joint', 'Joint']],
  };
  function setupExpenseFor(type) {
    const options = FOR_OPTIONS[type];
    $('forField').hidden = !options;
    $('payGrid').classList.toggle('grid2', !!options);
    if (options) {
      const select = $('expenseFor');
      // Sonata starts on the card owner's own turn; Personal remembers the last choice.
      const keep = type === 'Car' ? $('paidBy').value : type === 'Fixed' ? fixedForDefault() : store.get('for.' + type, options[0][0]);
      select.innerHTML = '';
      for (const [value, label] of options) {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = label;
        select.appendChild(opt);
      }
      select.value = options.some(([v]) => v === keep) ? keep : options[0][0];
    }
    lastCard = $('paidBy').value;
    updateOwedHint();
  }

  // Fixed: each bill remembers whose it was last time; a mobile bill starts as the card owner's own.
  function fixedForDefault() {
    const bill = selectedFixed();
    if (!bill) return 'Both';
    return store.get('fixedFor.' + bill, bill === 'Mobile bill' ? $('paidBy').value : 'Both');
  }

  function selectedFor() {
    return $('forField').hidden ? '' : $('expenseFor').value;
  }

  // "K owes V the full $20.00" when one person's expense goes on the other's card.
  function updateOwedHint() {
    const owner = selectedFor();
    const card = $('paidBy').value;
    const hint = $('owedHint');
    const amount = parseAmount($('amount').value);
    const refund = isRefund();
    const amt = amount === null ? null : Math.abs(amount);
    if (owner === 'Joint' || owner === 'Both') {
      const other = card === 'V' ? 'K' : 'V';
      hint.textContent = refund
        ? `Joint refund back on ${card}'s card: ${other} owes ${card} half of it less` + (amt ? ` (${money(amt / 2)}).` : '.')
        : `Joint, split 50/50: ${other} owes ${card} half` + (amt ? ` (${money(amt / 2)}).` : '.');
      hint.hidden = false;
      return;
    }
    if ((owner !== 'V' && owner !== 'K') || owner === card || isMoneyMode()) { hint.hidden = true; return; }
    hint.textContent = refund
      ? `${owner}'s refund back on ${card}'s card: ${owner} owes ${card} ` + (amt ? money(amt) : 'that much') + ' less.'
      : `${owner}'s expense on ${card}'s card: ${owner} owes ${card} the full ` + (amt ? money(amt) : 'amount') + '.';
    hint.hidden = false;
  }
  $('expenseFor').addEventListener('change', () => {
    store.set('for.' + selectedType(), $('expenseFor').value);
    if (selectedType() === 'Fixed' && selectedFixed()) store.set('fixedFor.' + selectedFixed(), $('expenseFor').value);
    updateOwedHint();
  });
  // In Sonata, Expense for follows the card (the usual own turn) unless set to something else.
  let lastCard = $('paidBy').value;
  $('paidBy').addEventListener('change', () => {
    if (selectedType() === 'Car' && $('expenseFor').value === lastCard) $('expenseFor').value = $('paidBy').value;
    lastCard = $('paidBy').value;
    updateOwedHint();
  });
  $('amount').addEventListener('input', updateOwedHint);

  // Refund: money back on a card. Saved as a negative amount, so it undoes the expense everywhere
  // (budget, spending, who owes whom). Not for Funds or fuel fill-ups.
  function updateRefundField() {
    const type = selectedType();
    $('refundField').hidden = type === 'Funds' || (type === 'Car' && selectedCarCat() === 'Fuel');
  }
  function isRefund() { return !$('refundField').hidden && $('isRefund').checked; }
  $('isRefund').addEventListener('change', () => {
    $('amountLabel').textContent = isRefund() ? 'Refund amount ($)' : 'Amount ($)';
    updateOwedHint();
  });

  function selectedCarCat() {
    const checked = document.querySelector('input[name="carCat"]:checked');
    return checked ? checked.value : 'Fuel';
  }

  // Fuel shows odometer, range, gallons and price; other car categories just need a vendor and amount.
  let amountTyped = false;
  function updateCarFields() {
    const fuel = selectedCarCat() === 'Fuel';
    $('fuelFields').hidden = !fuel;
    updateRefundField();
    $('vendorLabel').textContent = fuel ? 'Gas station' : 'Vendor or description';
    $('vendor').placeholder = fuel ? 'Shell, Costco…' : 'Hyundai dealer, oil change…';
    updateFuelPreview();
  }

  // Live preview of what this fill-up will calculate, from the last odometer reading.
  function updateFuelPreview() {
    const preview = $('fuelPreview');
    if (!isCarMode() || selectedCarCat() !== 'Fuel') { preview.hidden = true; return; }
    const gal = parseAmount($('gallons').value);
    const price = parseAmount($('ppg').value);
    if (!amountTyped && gal && price) { $('amount').value = (Math.round(gal * price * 100) / 100).toFixed(2); updateOwedHint(); }
    const odo = parseAmount($('odometer').value);
    const range = parseAmount($('rangeLeft').value);
    const amt = parseAmount($('amount').value);
    const partial = $('fillPartial').checked;
    const missed = $('missedBefore').checked;
    const last = lastOdometer();
    const open = openStretch();
    const st = getState();
    const overall = st && st.car && st.car.mpg ? Number(st.car.mpg) : 0;
    const parts = [];
    let warn = false;
    if (gal && gal > TANK_GALLONS + 0.2) {
      parts.push(`${gal} gal is more than the ${TANK_GALLONS} gal tank holds. Check the number.`);
      warn = true;
    } else if (odo && last && odo <= last) {
      parts.push(`Odometer should be above the last fill-up (${num(last)} mi).`);
      warn = true;
    } else if (odo && last) {
      parts.push(`${num(round2(odo - last))} mi since last fill-up`);
      // A fill that leaves the tank well short of 13.2 gal was probably partial.
      const inTank = gal && range !== null && overall ? gal + range / overall : 0;
      const looksPartial = !partial && !missed && inTank && inTank < TANK_GALLONS * 0.85;
      if (looksPartial) {
        parts.push(`looks partial: ${gal} gal + about ${(range / overall).toFixed(1)} gal left = ${inTank.toFixed(1)} of ${TANK_GALLONS} gal. Tap Partial if you stopped early`);
        warn = true;
      }
      if (missed) {
        parts.push('missed fill-up: no MPG for this stretch; tracking restarts here');
      } else if (partial) {
        parts.push('partial fill: its gallons count toward the next full fill\'s MPG');
      } else if (open && open.known && gal) {
        const miles = round2(odo - open.startOdo);
        const g = open.gallons + gal;
        parts.push((looksPartial ? 'if it really was full: ' : '') + `${(miles / g).toFixed(1)} MPG` +
          (open.gallons ? ` (full-to-full: ${num(miles)} mi ÷ ${g.toFixed(2)} gal incl. partials)` : ''));
        if (amt) parts.push(`${per((open.amount + amt) / miles)}/mi`);
        if (range !== null && !open.gallons) parts.push(`effective range ${num(round2(odo - last) + range)} mi`);
      } else if (!open) {
        parts.push('MPG starts with the next full fill');
      }
    } else if (last) {
      parts.push(`Last fill-up odometer: ${num(last)} mi.`);
    }
    preview.textContent = parts.join(' · ');
    preview.classList.toggle('warn', warn);
    preview.hidden = !parts.length;
  }
  $('fillSeg').addEventListener('change', updateFuelPreview);
  $('missedBefore').addEventListener('change', updateFuelPreview);
  $('carPicker').addEventListener('change', updateCarFields);
  for (const id of ['odometer', 'rangeLeft', 'gallons', 'ppg']) $(id).addEventListener('input', updateFuelPreview);
  $('amount').addEventListener('input', () => { amountTyped = $('amount').value.trim() !== ''; updateFuelPreview(); });

  // Update on both change and click so the description always follows the tapped option.
  $('typeSeg').addEventListener('change', updateTypeHint);
  $('typeSeg').addEventListener('click', () => setTimeout(updateTypeHint, 0));
  $('fixedPicker').addEventListener('change', () => {
    $('fixedPicker').classList.remove('invalid');
    $('expenseFor').value = fixedForDefault();
    updateOwedHint();
  });

  function clearInvalid(form) {
    form.querySelectorAll('.invalid').forEach((el) => el.classList.remove('invalid'));
  }

  function markInvalid(input, message) {
    input.classList.add('invalid');
    input.focus();
    showBanner(message, 'err');
  }
  for (const id of ['date', 'category', 'amount', 'odometer', 'fundsAmount', 'fundsDate', 'pbAmountV', 'pbAmountK', 'pbDate', 'settleAmount', 'settleDate', 'scriptUrl', 'secretKey']) {
    $(id).addEventListener('input', () => $(id).classList.remove('invalid'));
  }

  async function saveCar(date) {
    const category = selectedCarCat();
    const fuel = category === 'Fuel';
    const optNum = (id) => {
      const v = $(id).value.trim();
      return v === '' ? '' : parseAmount(v);
    };
    const odometer = fuel ? optNum('odometer') : '';
    const rangeLeft = fuel ? optNum('rangeLeft') : '';
    const gallons = fuel ? optNum('gallons') : '';
    const ppg = fuel ? optNum('ppg') : '';
    for (const [id, v, label] of [['odometer', odometer, 'odometer'], ['rangeLeft', rangeLeft, 'range left'], ['gallons', gallons, 'gallons'], ['ppg', ppg, 'price per gallon']]) {
      if (v === null || (v !== '' && v < 0)) return markInvalid($(id), `Enter a valid ${label}.`);
    }
    if (fuel && gallons && gallons > TANK_GALLONS + 0.2) {
      return markInvalid($('gallons'), `That is more than the ${TANK_GALLONS} gal tank holds.`);
    }
    const last = lastOdometer();
    // An edited fill-up may be an older one, so only new fill-ups must be above the last reading.
    if (fuel && odometer !== '' && last && odometer <= last && !editing) {
      return markInvalid($('odometer'), `Odometer should be above the last fill-up (${num(last)} mi).`);
    }
    let amount = parseAmount($('amount').value);
    if ((amount === null || amount === 0) && gallons && ppg) amount = round2(gallons * ppg);
    if (amount === null || amount === 0) return markInvalid($('amount'), 'Enter the amount.');
    if (isRefund()) amount = -Math.abs(amount);
    const partial = fuel && $('fillPartial').checked;
    const missedBefore = fuel && $('missedBefore').checked;
    const open = openStretch();
    let tankMpg = 0;
    if (fuel && !partial && !missedBefore && open && open.known && odometer !== '' && gallons && !editing) {
      tankMpg = (odometer - open.startOdo) / (open.gallons + gallons);
    }
    const entry = {
      id: uuid(), date, category, vendor: $('vendor').value.trim(), amount, paidBy: $('paidBy').value,
      notes: $('notes').value.trim(), odometer, rangeLeft, gallons, pricePerGallon: ppg,
      expenseFor: selectedFor() || $('paidBy').value,
      fill: fuel ? (partial ? 'Partial' : 'Full') : '',
      missedBefore,
    };
    const edited = queueSave('car', entry);
    store.set('paidBy', entry.paidBy);

    $('expenseForm').reset();
    clearInvalid($('expenseForm'));
    amountTyped = false;
    $('date').value = today();
    $('paidBy').value = entry.paidBy;
    $('typeCar').checked = true; // stay on Sonata for the next entry
    updateTypeHint();

    $('saveBtn').disabled = true;
    const status = await sync();
    $('saveBtn').disabled = false;
    const owes = round2(carOwed(entry.expenseFor, entry.paidBy, amount));
    report(status, `${edited ? 'Updated' : amount < 0 ? 'Refund saved' : 'Saved'} ✓ ${category} ${money(amount)}` +
      (partial ? ' · partial, MPG comes with the next full fill' : tankMpg > 0 ? ` · ${tankMpg.toFixed(1)} MPG` : '') +
      owesText(owes, amount < 0));
  }

  $('expenseForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const date = $('date').value;
    const type = selectedType();
    if (type === 'Car') {
      if (!date) return markInvalid($('date'), 'Pick a date.');
      return saveCar(date);
    }
    if (type === 'Funds') {
      if (!date) return markInvalid($('date'), 'Pick a date.');
      return saveMoney(date);
    }
    const category = type === 'Fixed' ? selectedFixed() : $('category').value.trim();
    const amount = parseAmount($('amount').value);
    if (!date) return markInvalid($('date'), 'Pick a date.');
    if (!category && type === 'Fixed') {
      $('fixedPicker').classList.add('invalid');
      return showBanner('Pick which fixed bill this is.', 'err');
    }
    if (!category) return markInvalid($('category'), 'Enter where you spent it.');
    const tagged = type === 'Joint' || type === 'Personal';
    if (tagged && !$('tag').value) return markInvalid($('tag'), 'Pick a tag (where the money went).');
    if (amount === null || amount === 0) return markInvalid($('amount'), 'Enter a valid amount.');

    const entry = {
      id: uuid(),
      date,
      category,
      amount: isRefund() ? -Math.abs(amount) : amount,
      paidBy: $('paidBy').value,
      notes: $('notes').value.trim(),
      type,
      expenseFor: type === 'Personal' || type === 'Fixed' ? selectedFor() : '',
      tag: tagged ? chosenTag() : type === 'Fixed' ? category : '',
    };
    if (tagged) { addCustomTag(entry.tag); rememberTag(category, entry.tag); }
    const edited = queueSave('', entry);
    store.set('paidBy', entry.paidBy);

    $('expenseForm').reset();
    clearInvalid($('expenseForm'));
    amountTyped = false;
    $('date').value = today();
    $('paidBy').value = entry.paidBy;
    restoreType(type);
    updateTypeHint();

    $('saveBtn').disabled = true;
    const status = await sync();
    $('saveBtn').disabled = false;
    const left = estimate();
    const owes = owedInFull(entry.expenseFor, entry.paidBy, entry.amount);
    const pb = entry.type === 'Personal' ? estimatePersonal()[entry.expenseFor] : null;
    report(status, `${edited ? 'Updated' : entry.amount < 0 ? 'Refund saved' : 'Saved'} ✓ ${category} ${money(entry.amount)}` +
      (entry.type === 'Fixed' ? ' · Fixed bill' : '') +
      (pb ? ` · ${entry.expenseFor} personal: ${pb.remaining < 0 ? money(-pb.remaining) + ' over' : money(pb.remaining) + ' left'}` : '') +
      owesText(owes, entry.amount < 0) +
      (entry.type === 'Joint' && left.hasBalance
        ? left.balance < 0 ? ` · ${money(-left.balance)} over budget` : ` · ${money(left.balance)} left`
        : ''));
  });

  // ---------- Delete from Recent
  async function removeEntry(item, table) {
    const isCar = table === 'car';
    const name = isCar ? item.vendor || item.category : item.category || item.kind;
    if (!confirm(`Delete "${name}" ${money(item.amount)} from ${prettyDate(item.date)}?`)) return;
    const queue = getQueue();
    const queued = queue.find((op) => op.op === 'add' && op.entry.id === item.id);
    if (editing && editing.id === item.id) cancelEdit();
    if (queued) {
      // Not sent yet: just drop it from this phone.
      setQueue(queue.filter((op) => op !== queued));
      render();
      showBanner('Removed.', 'ok');
      return;
    }
    // An edit waiting to sync is dropped; the delete replaces it.
    setQueue(queue.filter((op) => !(op.op === 'update' && op.entry.id === item.id)));
    enqueue(table ? { op: 'delete', table, id: item.id } : { op: 'delete', id: item.id });
    const status = await sync();
    if (status === 'ok') showBanner('Deleted ✓', 'ok');
    if (status === 'offline') showBanner('Will delete when you are back online.', 'warn');
  }

  // " · K owes V $20.00" for one entry. A refund (negative amount) lowers what is owed instead:
  // " · K owes V $10.00 less".
  const owesText = (owes, refund) => (!owes ? ''
    : refund ? ` · ${owes < 0 ? 'K owes V' : 'V owes K'} ${money(Math.abs(owes))} less`
      : ` · ${owes > 0 ? 'K owes V' : 'V owes K'} ${money(Math.abs(owes))}`);

  // ---------- Edit from Recent: the form fills with the entry; saving writes over it (same id).
  const MONEY_EDITABLE = ['Income', '401(K)', 'Investment', 'Fam', 'Loan payment', 'Use savings', 'Use surplus', 'Goal'];
  function editButton(r, table, name) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'edit';
    b.setAttribute('aria-label', `Edit ${name}`);
    b.textContent = '✎';
    b.addEventListener('click', () => startEdit(r, table, name));
    return b;
  }

  // Saves a new entry, or the one being edited. An edit of something not synced yet just replaces
  // it on this phone. Returns true for an edit.
  function queueSave(table, entry) {
    const extra = table ? { table } : {};
    if (!editing) { enqueue({ op: 'add', ...extra, entry }); return false; }
    entry.id = editing.id;
    const q = getQueue();
    const waiting = q.find((op) => (op.op === 'add' || op.op === 'update') && op.entry && op.entry.id === entry.id);
    stopEdit();
    if (waiting) { waiting.entry = entry; setQueue(q); render(); } else enqueue({ op: 'update', ...extra, entry });
    return true;
  }

  function stopEdit() {
    editing = null;
    $('editBar').hidden = true;
  }
  function cancelEdit() {
    stopEdit();
    $('expenseForm').reset();
    clearInvalid($('expenseForm'));
    amountTyped = false;
    $('date').value = today();
    $('paidBy').value = store.get('paidBy', 'V');
    $('amountLabel').textContent = 'Amount ($)';
    restoreType(view === 'Home' ? store.get('quickType', 'Joint') : view);
    updateTypeHint();
  }
  $('editCancel').addEventListener('click', cancelEdit);
  // A cleared form always starts as a normal amount, not a refund.
  $('expenseForm').addEventListener('reset', () => { $('amountLabel').textContent = 'Amount ($)'; tagPicked = false; });

  function startEdit(r, table, name) {
    if (table === 'funds' && r.kind === 'Goal') return $('goalBtn').click();
    const type = table === 'car' ? 'Car' : table === 'funds' ? 'Funds' : r.type;
    setView(type);
    editing = { id: r.id, table };
    const form = $('expenseForm');
    form.reset();
    clearInvalid(form);
    restoreType(type);
    const pick = (name, value) => { const x = document.querySelector(`input[name="${name}"][value="${value}"]`); if (x) x.checked = true; return x; };
    const text = (v) => (v === '' || v === undefined || v === null ? '' : String(v));
    if (table === 'funds') {
      const kind = r.kind === 'Use surplus' ? 'Use savings' : r.kind;
      pick('moneyKind', kind);
      updateTypeHint();
      $('moneyPerson').value = r.person;
      if (kind === 'Investment' || kind === 'Fam') $('moneyFrom').value = r.from === 'Savings' || r.from === 'Surplus' ? 'Savings' : 'Income';
      const cat = kind === 'Fam' && r.category === 'Fam' ? '' : r.category; // "Fam" is the default when no account was named
      const chips = [...document.querySelectorAll('input[name="moneyCat"]')];
      const chip = chips.find((c) => c.value.toLowerCase() === String(cat).toLowerCase()) || chips.find((c) => c.value === 'Other');
      if (chip) chip.checked = true;
      if (!chip || chip.value === 'Other') $('moneyOther').value = cat || '';
      updateMoneyOther();
      k401Prefilled = false;
    } else if (table === 'car') {
      pick('carCat', r.category);
      updateTypeHint();
      $('vendor').value = r.vendor || '';
      $('odometer').value = text(r.odometer);
      $('rangeLeft').value = text(r.rangeLeft);
      $('gallons').value = text(r.gallons);
      $('ppg').value = text(r.ppg);
      $(r.fill === 'Partial' ? 'fillPartial' : 'fillFull').checked = true;
      $('missedBefore').checked = !!r.missedBefore;
      $('paidBy').value = r.paidBy;
      $('expenseFor').value = r.expenseFor || r.paidBy;
      lastCard = r.paidBy;
      amountTyped = true;
    } else {
      updateTypeHint();
      if (type === 'Fixed') { pick('fixedCat', r.category); $('expenseFor').value = r.expenseFor === 'V' || r.expenseFor === 'K' ? r.expenseFor : 'Both'; }
      else $('category').value = r.category;
      if (type === 'Joint' || type === 'Personal') {
        if (r.tag && !TAGS.includes(r.tag)) addCustomTag(r.tag);
        $('tag').value = r.tag && allTags().includes(r.tag) ? r.tag : suggestTag(r.category);
        tagPicked = true;
        updateTagNew();
      }
      $('paidBy').value = r.paidBy;
      if (type === 'Personal') $('expenseFor').value = r.expenseFor || r.paidBy;
    }
    $('date').value = r.date;
    $('amount').value = Math.abs(r.amount).toFixed(2);
    $('isRefund').checked = r.amount < 0 && table !== 'funds';
    $('amountLabel').textContent = isRefund() ? 'Refund amount ($)' : 'Amount ($)';
    $('notes').value = r.notes || '';
    updateOwedHint();
    updateFuelPreview();
    $('editText').textContent = `Editing ${name} ${money(r.amount)} from ${prettyDate(r.date)}`;
    $('editBar').hidden = false;
    $('saveBtn').textContent = 'Save changes';
    render();
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ---------- Set monthly budget
  const fundsDialog = $('fundsDialog');

  function openBudget() {
    $('fundsForm').reset();
    clearInvalid($('fundsForm'));
    $('fundsDate').value = today();
    $('fundsNotes').placeholder = `${monthName(today())} budget`;
    fundsDialog.showModal();
    $('fundsAmount').focus();
  }
  $('setBalanceBtn').addEventListener('click', openBudget);

  // Dialog buttons are handled on submit (not on the dialog's close event) so saving never depends on timing.
  $('fundsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (e.submitter && e.submitter.value === 'cancel') return fundsDialog.close();
    const amount = parseAmount($('fundsAmount').value);
    if (amount === null || amount <= 0) return $('fundsAmount').classList.add('invalid');
    if (!$('fundsDate').value) return $('fundsDate').classList.add('invalid');
    fundsDialog.close();
    const date = $('fundsDate').value;
    enqueue({
      op: 'add',
      entry: {
        id: uuid(),
        date,
        category: '',
        amount,
        paidBy: 'Both',
        notes: $('fundsNotes').value.trim() || `${monthName(date)} budget`,
        type: 'Set balance',
      },
    });
    const status = await sync();
    report(status, `Budget set ✓ ${money(amount)} for ${monthName(date)}`);
  });

  // ---------- Funds: what comes in and what goes out (income, investments, loan payments, savings)
  const isMoneyMode = () => selectedType() === 'Funds';
  const MONEY_KINDS = {
    'Income': { label: 'Source', chips: () => ['Salary', 'Tax refund', 'Bonus', 'Other'], persons: ['V', 'K', 'Both'], otherHint: 'Where it came from' },
    '401(K)': { label: '', chips: null, persons: ['V', 'K'] },
    'Investment': { label: 'Where', chips: () => ['India', 'USA', 'Other'], persons: ['V', 'K'], fromLabel: 'From',
      from: [['Income', "This month's income"], ['Savings', 'Savings']], otherHint: 'Brokerage, HSA...' },
    'Fam': { label: 'Fam account (optional)', chips: () => (famNames().length ? famNames().concat(['Other']) : null), persons: ['V', 'K', 'Both'], fromLabel: 'From',
      from: [['Income', "This month's income"], ['Savings', 'Savings']], otherHint: 'Which account (optional): Mom SIP, Dad PPF...' },
    'Loan payment': { label: 'Loan', chips: () => loanNames().concat(['Other']), persons: ['V', 'K', 'Both'], otherHint: 'Which loan (V education...)' },
    'Use savings': { label: 'What for', chips: null, persons: ['V', 'K'], otherHint: 'Flight to India, laptop...' },
  };
  const MONEY_HINTS = {
    'Income': "Income: in hand after 401(K), insurance and taxes (salary, tax refund, bonus). Pick V or K for salaries; Both is for shared income, like profit from something you run together (half each).",
    '401(K)': '401(K): what the employer took from this paycheck before pay. Not part of income or savings; counts toward the goal. Starts at the last amount; change it when the contribution changes.',
    'Investment': 'Invest: money you put away from pay (India, USA...). Counts toward the goal. From savings moves money kept in earlier months.',
    'Fam': "Fam: money sent to the family's investment account. Counts as that person's investment (it lowers savings, it is not spending), but never toward the V & K goal. Both splits it half each.",
    'Loan payment': 'Loan: what you sent toward a loan. Counts as spending for the month. Both splits it half each.',
    'Use savings': "Savings: spend from your own savings kept in earlier months (V's or K's, never shared). Leaves this month alone.",
  };
  const KIND_TAGS = { 'Income': 'Income', '401(K)': '401(K)', 'Investment': 'Invested', 'Fam': 'Fam', 'Loan payment': 'Loan', 'Use savings': 'Savings used',
    'Use surplus': 'Savings used', 'Prior investment': 'Invested before', 'Goal': 'Goal', 'Savings target': 'Savings target' };
  const KIND_CLASS = { 'Income': 'c-income', '401(K)': 'c-k401', 'Investment': 'c-invest', 'Prior investment': 'c-invest', 'Fam': 'c-fam', 'Loan payment': 'c-loan',
    'Use savings': 'c-surplus', 'Use surplus': 'c-surplus', 'Goal': 'c-goal', 'Savings target': 'c-goal' };

  const trio = () => ({ V: 0, K: 0, total: 0 });
  const usd0 = (n) => (n < 0 ? '-$' : '$') + Math.round(Math.abs(n)).toLocaleString('en-US');
  const ymLabel = (ym) => (ym ? monthName(ym + '-01') + ' ' + ym.slice(0, 4) : '');
  const monthsBetween = (a, b) => (+b.slice(0, 4) - +a.slice(0, 4)) * 12 + (+b.slice(5, 7) - +a.slice(5, 7));
  const pctText = (x) => (x === null || x === undefined ? '—' : `${Math.round(x)}%`);
  const tone = (v) => (v <= -0.01 ? 'neg' : v >= 0.01 ? 'pos' : '');
  // Loans you have paid toward before, most paid first (they become buttons).
  const loanNames = () => (fundsEstimate().loans || []).map((l) => l.name).slice(0, 4);
  // Fam accounts sent to before (named ones only), most sent first.
  const famNames = () => (fundsEstimate().fams || []).map((a) => a.name).filter((x) => x && x !== 'Fam').slice(0, 4);

  function selectedKind() {
    const checked = document.querySelector('input[name="moneyKind"]:checked');
    return checked ? checked.value : 'Income';
  }

  // Fields follow the kind: chips, person and "From".
  function setupMoneyFields() {
    const kind = selectedKind();
    const cfg = MONEY_KINDS[kind];
    $('typeHint').textContent = MONEY_HINTS[kind];
    $('moneyCatField').hidden = !cfg.label;
    $('moneyCatLabel').textContent = cfg.label;
    const picker = $('moneyPicker');
    const keep = (document.querySelector('input[name="moneyCat"]:checked') || {}).value;
    const chips = cfg.chips ? cfg.chips() : null;
    picker.innerHTML = '';
    picker.hidden = !chips;
    (chips || []).forEach((c, i) => {
      const input = document.createElement('input');
      Object.assign(input, { type: 'radio', name: 'moneyCat', id: 'mc' + i, value: c });
      input.checked = c === keep || (!chips.includes(keep) && i === 0);
      const label = document.createElement('label');
      label.htmlFor = 'mc' + i;
      label.textContent = c === 'Other' && kind === 'Loan payment' ? (chips.length > 1 ? 'Another loan' : 'Name the loan')
        : c === 'Other' && kind === 'Fam' ? 'Another / none' : c;
      picker.append(input, label);
    });
    updateMoneyOther();
    const person = $('moneyPerson');
    const was = person.value || store.get('moneyPerson', 'V');
    person.innerHTML = '';
    for (const v of cfg.persons) person.add(new Option(v === 'Both' ? 'Both (half each)' : v, v));
    person.value = cfg.persons.includes(was) ? was : 'V';
    const from = $('moneyFrom');
    $('moneyFromField').hidden = !cfg.from;
    if (cfg.from) {
      $('moneyFromLabel').textContent = cfg.fromLabel;
      const prev = from.value;
      from.innerHTML = '';
      for (const [v, label] of cfg.from) from.add(new Option(label, v));
      from.value = cfg.from.some(([v]) => v === prev) ? prev : cfg.from[0][0];
    }
    $('moneyGrid').classList.toggle('grid2', !!cfg.from);
    prefill401();
    $('amount').placeholder = kind === 'Income' ? '3,138.18' : kind === '401(K)' ? 'Per paycheck' : '0.00';
    $('notes').placeholder = kind === 'Income' ? 'After 401(K) and insurance' : 'Optional';
  }

  // 401(K) starts at that person's last contribution (until the amount is typed over).
  let k401Prefilled = false;
  function prefill401() {
    if (selectedKind() !== '401(K)') {
      if (k401Prefilled) { $('amount').value = ''; k401Prefilled = false; }
      return;
    }
    if ($('amount').value.trim() !== '' && !k401Prefilled) return;
    const last = (fundsEstimate().k401Last || {})[$('moneyPerson').value];
    $('amount').value = last ? last.toFixed(2) : '';
    k401Prefilled = !!last;
  }
  $('moneyPerson').addEventListener('change', () => { if (selectedKind() === '401(K)') prefill401(); });
  $('amount').addEventListener('input', () => { k401Prefilled = false; });

  function updateMoneyOther() {
    const cfg = MONEY_KINDS[selectedKind()];
    const chip = (document.querySelector('input[name="moneyCat"]:checked') || {}).value;
    $('moneyOther').hidden = !(cfg.label && (!(cfg.chips && cfg.chips()) || chip === 'Other'));
    $('moneyOther').placeholder = cfg.otherHint || '';
  }
  $('kindSeg').addEventListener('change', setupMoneyFields);
  $('moneyPicker').addEventListener('change', updateMoneyOther);
  $('moneyPerson').addEventListener('change', () => store.set('moneyPerson', $('moneyPerson').value));

  function moneyCategory() {
    const cfg = MONEY_KINDS[selectedKind()];
    if (!cfg.label) return '';
    const chip = (document.querySelector('input[name="moneyCat"]:checked') || {}).value;
    const typed = $('moneyOther').value.trim();
    if (!(cfg.chips && cfg.chips())) return typed;
    return chip === 'Other' ? typed : chip || '';
  }

  async function saveMoney(date) {
    const kind = selectedKind();
    const amount = parseAmount($('amount').value);
    if (amount === null || amount <= 0) return markInvalid($('amount'), 'Enter a valid amount.');
    const category = moneyCategory();
    if (kind === 'Loan payment' && !category) return markInvalid($('moneyOther'), 'Which loan is this for?');
    const entry = { id: uuid(), date, kind, category, amount, person: $('moneyPerson').value, notes: $('notes').value.trim() };
    if (kind === 'Investment' || kind === 'Fam') entry.from = $('moneyFrom').value;
    const edited = queueSave('funds', entry);

    const keepFrom = $('moneyFrom').value;
    $('expenseForm').reset();
    clearInvalid($('expenseForm'));
    $('date').value = today();
    $('paidBy').value = store.get('paidBy', 'V');
    restoreType(view === 'Home' ? store.get('quickType', 'Funds') : 'Funds');
    document.querySelector(`input[name="moneyKind"][value="${kind}"]`).checked = true;
    k401Prefilled = false;
    updateTypeHint();
    $('moneyPerson').value = entry.person;
    if (kind === '401(K)') { k401Prefilled = true; prefill401(); }
    if (kind === 'Investment' || kind === 'Fam') $('moneyFrom').value = keepFrom;

    $('saveBtn').disabled = true;
    const status = await sync();
    $('saveBtn').disabled = false;
    const f = fundsEstimate();
    let extra = '';
    if (kind === 'Use savings' || entry.from === 'Savings') extra = ` · ${money(f.available.total)} savings from earlier left`;
    if ((kind === 'Investment' || kind === '401(K)') && f.goal) extra += ` · goal ${f.goal.percent}% done`;
    if (kind === '401(K)') extra += ` · ${money(f.now.k401.total)} 401(K) this month`;
    if (kind === 'Fam') extra += ` · ${money(f.now.famAll.total)} to Fam this month (not toward the goal)`;
    if (String(date).slice(0, 7) === currentMonth()) extra += ` · ${money(f.now.savings.total)} savings this month`;
    report(status, `${edited ? 'Updated' : 'Saved'} ✓ ${category || KIND_TAGS[kind]} ${money(amount)}${extra}`);
    if (!edited && kind === 'Income' && category === 'Salary' && (entry.person === 'V' || entry.person === 'K') && status !== 'outdated') openPayday(entry);
  }

  // ---- Live estimate: what the sheet last reported plus every change not synced yet
  // (Funds entries and new expenses), so the picture updates the moment something is saved.
  const blankNow = (month) => ({
    month, label: ymLabel(month), income: trio(), shared: trio(), personal: trio(), sonata: trio(), loan: trio(), spent: trio(),
    invest: trio(), savings: trio(), kept: trio(), rate: { V: null, K: null, total: null }, investSaved: trio(), used: trio(),
    savedBefore: trio(), savedAfter: trio(), joint: 0, fixed: 0, sonataShared: 0, budgets: null, k401: trio(), putAway: trio(),
    fam: trio(), famSaved: trio(), famAll: trio(), jointHalf: trio(), fixedEach: trio(),
  });
  const shares = (who, amt) => (who === 'Both' || who === 'Joint' ? { V: amt / 2, K: amt / 2 } : who === 'K' ? { V: 0, K: amt } : who === 'V' ? { V: amt, K: 0 } : { V: 0, K: 0 });
  const bump = (o, who, amt) => { const x = shares(who, amt); o.V += x.V; o.K += x.K; if ('total' in o) o.total += x.V + x.K; };

  function fundsEstimate() {
    const st = getState() || {};
    const month = currentMonth();
    // Only use what the sheet sent if it has the current shape (version 20 or later). An older
    // script sends Funds data in another shape; the page then starts empty instead of breaking.
    const usable = !!(st.funds && st.funds.now && st.funds.now.savings && st.funds.now.spent && st.funds.available);
    const base = usable ? JSON.parse(JSON.stringify(st.funds)) : null;
    let f;
    if (base && base.month === month && base.now) {
      f = base;
    } else {
      // Nothing synced for this month yet (or a new month began): last month's savings carry forward.
      const prev = base && base.now;
      f = { month, now: blankNow(month), history: base ? base.history || [] : [], goal: base ? base.goal : null, loans: base ? base.loans || [] : [],
        recent: base ? base.recent || [] : [],
        available: prev ? { ...prev.savedAfter } : trio(), loanUsual: base ? base.loanUsual : trio(), recap: base ? base.recap : null,
        suggestions: base ? base.suggestions || [] : [], hasEntries: base ? base.hasEntries : false,
        k401Total: base ? base.k401Total : null, k401Last: base ? base.k401Last : null,
        fams: base ? (base.fams || []).map((a) => ({ ...a, thisMonth: 0 })) : [], famTotal: base ? base.famTotal : null };
      f.now.savedBefore = { ...f.available };
    }
    const n = f.now;
    n.k401 = n.k401 || trio();
    f.k401Total = f.k401Total ? { ...f.k401Total } : trio();
    f.k401Last = f.k401Last ? { ...f.k401Last } : { V: null, K: null };
    // A script older than version 25 sends no Fam numbers.
    n.fam = n.fam || trio();
    if (!n.jointHalf) { const h = round2((n.joint || 0) / 2); n.jointHalf = { V: h, K: h, total: round2(n.joint || 0) }; }
    if (!n.fixedEach) { const h = round2((n.fixed || 0) / 2); n.fixedEach = { V: h, K: h, total: round2(n.fixed || 0) }; }
    n.famSaved = n.famSaved || trio();
    f.fams = f.fams || [];
    f.famTotal = f.famTotal ? { ...f.famTotal } : trio();
    let changed = false;
    const firstMonth = f.history.length ? f.history[0].month : month;
    // Spending this month lowers savings; spending in an earlier tracked month lowers savings carried over.
    const spend = (date, cat, who, amt) => {
      const m = String(date).slice(0, 7);
      if (m > month || m < firstMonth) return;
      changed = true;
      if (m < month) { bump(f.available, who, -amt); return; }
      if (cat === 'joint') { n.joint += amt; bump(n.shared, 'Both', amt); bump(n.jointHalf, 'Both', amt); }
      if (cat === 'fixed') { if (who === 'Both') n.fixed += amt; bump(n.shared, who, amt); bump(n.fixedEach, who, amt); }
      if (cat === 'sonata') { bump(n.sonata, who, amt); if (who === 'Joint') n.sonataShared += amt; }
      if (cat === 'personal') bump(n.personal, who, amt);
      if (cat === 'loan') bump(n.loan, who, amt);
      bump(n.spent, who, amt);
      bump(n.savings, who, -amt);
      bump(n.kept, who, -amt);
    };
    const applyFund = (e, sign) => {
      const amt = sign * e.amount;
      const m = String(e.date).slice(0, 7);
      changed = true;
      if (e.kind === 'Income' && m <= month) {
        if (m === month) { bump(n.income, e.person, amt); bump(n.savings, e.person, amt); bump(n.kept, e.person, amt); } else bump(f.available, e.person, amt);
      }
      if (e.kind === 'Investment' && m <= month) {
        if (e.from === 'Savings' || e.from === 'Surplus') { bump(f.available, e.person, -amt); if (m === month) bump(n.investSaved, e.person, amt); }
        else if (m === month) { bump(n.invest, e.person, amt); bump(n.savings, e.person, -amt); }
        else bump(f.available, e.person, -amt);
      }
      if (e.kind === 'Fam') {
        if (m <= month) {
          if (e.from === 'Savings') { bump(f.available, e.person, -amt); if (m === month) bump(n.famSaved, e.person, amt); }
          else if (m === month) { bump(n.fam, e.person, amt); bump(n.savings, e.person, -amt); }
          else bump(f.available, e.person, -amt);
        }
        bump(f.famTotal, e.person, amt);
        const name = e.category || 'Fam';
        let a = f.fams.find((x) => x.name.toLowerCase() === name.toLowerCase());
        if (!a && sign > 0) { a = { name, thisMonth: 0, total: 0, V: 0, K: 0, last: '' }; f.fams.push(a); }
        if (a) { bump(a, e.person, amt); if (m === month) a.thisMonth += amt; if (sign > 0 && e.date > a.last) a.last = e.date; }
      }
      if ((e.kind === 'Use savings' || e.kind === 'Use surplus') && m <= month) { bump(f.available, e.person, -amt); if (m === month) bump(n.used, e.person, amt); }
      if ((e.kind === 'Investment' || e.kind === 'Prior investment' || e.kind === '401(K)') && f.goal) bump(f.goal.invested, e.person, amt);
      if (e.kind === '401(K)') {
        if (m === month) bump(n.k401, e.person, amt);
        bump(f.k401Total, e.person, amt);
        if (sign > 0 && (e.person === 'V' || e.person === 'K')) f.k401Last[e.person] = e.amount;
      }
      if (e.kind === 'Loan payment') {
        spend(e.date, 'loan', e.person, amt);
        let l = (f.loans || []).find((x) => x.name.toLowerCase() === String(e.category).toLowerCase());
        if (!l && sign > 0) { l = { name: e.category, thisMonth: 0, total: 0, V: 0, K: 0, last: '' }; f.loans.push(l); }
        if (l) { bump(l, e.person, amt); if (m === month) l.thisMonth += amt; if (sign > 0 && e.date > l.last) l.last = e.date; }
      }
      if (e.kind === 'Goal' && sign > 0) {
        f.goal = f.goal || { invested: trio(), avg: trio(), suggestions: [] };
        Object.assign(f.goal, { target: e.amount, deadline: e.category, deadlineLabel: ymLabel(e.category) });
      }
    };
    for (const op of pendingOps()) {
      const e = op.op === 'add' ? op.entry : op.table === 'funds' ? (f.recent || []).find((r) => r.id === op.id) || findRow('funds', op.id) : findRow(op.table || 'main', op.id);
      if (!e) continue;
      const sign = op.op === 'add' ? 1 : -1;
      if (op.table === 'funds') { f.hasEntries = true; applyFund(e, sign); continue; }
      if (op.table === 'car') { if (e.category !== 'Settlement') spend(e.date, 'sonata', e.expenseFor || e.paidBy, sign * e.amount); continue; }
      if (e.type === 'Joint') spend(e.date, 'joint', 'Both', sign * e.amount);
      if (e.type === 'Fixed') spend(e.date, 'fixed', e.expenseFor === 'V' || e.expenseFor === 'K' ? e.expenseFor : 'Both', sign * e.amount);
      if (e.type === 'Personal') spend(e.date, 'personal', e.expenseFor || e.paidBy, sign * e.amount);
    }
    const r2 = (o) => { if (!o) return o; for (const k of Object.keys(o)) if (typeof o[k] === 'number') o[k] = round2(o[k]); return o; };
    ['income', 'shared', 'jointHalf', 'fixedEach', 'personal', 'sonata', 'loan', 'spent', 'invest', 'savings', 'kept', 'investSaved', 'used', 'k401', 'fam', 'famSaved'].forEach((k) => { n[k] = r2(n[k] || trio()); });
    n.famAll = r2({ V: n.fam.V + n.famSaved.V, K: n.fam.K + n.famSaved.K, total: n.fam.total + n.famSaved.total });
    r2(f.famTotal);
    for (const a of f.fams) r2(a);
    f.fams.sort((a, b) => b.total - a.total);
    r2(f.k401Total);
    n.putAway = r2({ V: n.k401.V + n.invest.V + n.investSaved.V, K: n.k401.K + n.invest.K + n.investSaved.K, total: n.k401.total + n.invest.total + n.investSaved.total });
    r2(f.available);
    for (const k of ['joint', 'fixed', 'sonataShared']) n[k] = round2(n[k]);
    const rateOf = (k, inc) => (inc > 0 ? round2((k / inc) * 100) : null);
    n.rate = { V: rateOf(n.kept.V, n.income.V), K: rateOf(n.kept.K, n.income.K), total: rateOf(n.kept.total, n.income.total) };
    n.savedAfter = r2({ V: f.available.V + n.savings.V, K: f.available.K + n.savings.K, total: f.available.total + n.savings.total });
    for (const l of f.loans || []) r2(l);

    // Where this month's savings come from, from the live joint and personal budgets.
    const jb = estimate();
    const pb = estimatePersonal();
    const jointLeft = jb.hasBalance ? jb.balance : null;
    const personalLeft = { V: pb.V ? pb.V.remaining : null, K: pb.K ? pb.K.remaining : null };
    const fromJoint = r2({ V: jointLeft === null ? 0 : jointLeft / 2, K: jointLeft === null ? 0 : jointLeft / 2, total: jointLeft || 0 });
    const fromPersonal = r2({ V: personalLeft.V || 0, K: personalLeft.K || 0, total: (personalLeft.V || 0) + (personalLeft.K || 0) });
    n.budgets = { jointLeft, personalLeft, fromJoint, fromPersonal,
      rest: r2({ V: n.savings.V - fromJoint.V - fromPersonal.V, K: n.savings.K - fromJoint.K - fromPersonal.K, total: n.savings.total - fromJoint.total - fromPersonal.total }) };

    if (f.goal) {
      const g = f.goal;
      r2(g.invested);
      g.invested.total = round2(g.invested.V + g.invested.K);
      g.monthsLeft = Math.max(0, monthsBetween(month, g.deadline) + 1);
      g.togo = { V: round2(Math.max(0, g.target / 2 - g.invested.V)), K: round2(Math.max(0, g.target / 2 - g.invested.K)) };
      g.togo.total = round2(g.togo.V + g.togo.K);
      const div = g.monthsLeft || 1;
      g.need = { V: round2(g.togo.V / div), K: round2(g.togo.K / div) };
      g.need.total = round2(g.need.V + g.need.K);
      g.percent = g.target ? Math.min(100, round2((g.invested.total / g.target) * 100)) : 0;
      g.thisMonth = { ...n.putAway };
      if (changed || !base || base.month !== month) {
        const first = g.togo.total <= 0 ? 'Goal reached. Set a new goal to keep going.'
          : g.monthsLeft > 0
            ? `Invest ${usd0(g.need.total)} a month together (V ${usd0(g.need.V)}, K ${usd0(g.need.K)}) for the next ${g.monthsLeft} month${g.monthsLeft === 1 ? '' : 's'} to reach ${usd0(g.target)} by ${g.deadlineLabel}.`
            : `The deadline has passed with ${usd0(g.togo.total)} to go. Set a new deadline to get a monthly target.`;
        g.suggestions = [first, ...(g.suggestions || []).slice(1)];
      }
    }
    return f;
  }
  const hasFunds = () => !!((getState() || {}).funds || {}).hasEntries || getQueue().some((op) => op.table === 'funds');
  // Funds needs the sheet's script at version 20; older ones are told apart by the version in the last reply.
  const fundsOutdated = () => { const st = getState(); return !!st && st.version !== undefined && st.version < 20; };

  function cell(tr, text, cls, tag) {
    const td = document.createElement(tag || 'td');
    td.textContent = text;
    if (tag === 'th') td.scope = 'row';
    if (cls) td.className = cls;
    tr.appendChild(td);
    return td;
  }
  function tableRows(body, rows) {
    body.innerHTML = '';
    for (const [name, a, b, c, cls, fmt] of rows) {
      const tr = document.createElement('tr');
      if (cls) tr.className = cls;
      cell(tr, name, '', 'th');
      for (const x of [a, b, c]) cell(tr, (fmt || money)(x), cls === 'left-row' ? tone(x) : '');
      body.appendChild(tr);
    }
  }
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function renderMoney() {
    const st0 = getState();
    $('mOutdated').hidden = !fundsOutdated();
    if (fundsOutdated()) {
      $('mOutdated').textContent = `Funds needs the sheet's script at version 20; yours is version ${st0.version}. In Apps Script: paste the latest Code.gs, ` +
        'run weeklyRecap once to approve, then Deploy > Manage deployments > pencil > New version > Deploy. Anything you save here waits on this phone (hourglass) and sends by itself after that.';
    }
    const f = fundsEstimate();
    const n = f.now;
    const ready = hasFunds();
    const monthWord = monthName(f.month + '-01');


    // This month
    $('mMonthTitle').textContent = `${monthWord} money`;
    $('mSaved').textContent = ready ? money(Math.abs(n.savings.total)) : '—';
    $('mSaved').classList.toggle('neg', n.savings.total < 0);
    $('mSavedWord').textContent = n.savings.total < 0 ? 'short this month' : 'savings this month';
    tableRows($('mTable'), [
      ['Income', n.income.V, n.income.K, n.income.total],
      ['Joint (half each)', n.jointHalf.V, n.jointHalf.K, n.jointHalf.total],
      ['Fixed (half shared + own)', n.fixedEach.V, n.fixedEach.K, n.fixedEach.total],
      ['Personal', n.personal.V, n.personal.K, n.personal.total],
      ['Sonata', n.sonata.V, n.sonata.K, n.sonata.total],
      ['Loan payments', n.loan.V, n.loan.K, n.loan.total],
      ['Spent', n.spent.V, n.spent.K, n.spent.total, 'total'],
      ['Invested', n.invest.V, n.invest.K, n.invest.total],
      ['Fam (not toward goal)', n.fam.V, n.fam.K, n.fam.total],
      ['Savings', n.savings.V, n.savings.K, n.savings.total, 'left-row'],
      ['Kept (invested + Fam + savings)', n.rate.V, n.rate.K, n.rate.total, '', pctText],
    ]);
    // 401(K)
    $('mK401').textContent = money(n.k401.total);
    $('mK401V').textContent = money(n.k401.V);
    $('mK401K').textContent = money(n.k401.K);
    $('mK401All').textContent = money(f.k401Total.total);
    const kb = $('mK401Table');
    kb.innerHTML = '';
    const krows = f.history.filter((h) => h.month !== f.month && h.k401).concat([{ month: f.month, k401: n.k401 }]).slice(-6).reverse();
    for (const h of krows) {
      const tr = document.createElement('tr');
      if (h.month === f.month) tr.className = 'current';
      cell(tr, shortMonth(h.month) + (h.month.slice(0, 4) !== f.month.slice(0, 4) ? ' ' + h.month.slice(2, 4) : ''), '', 'th');
      for (const x of [h.k401.V, h.k401.K, h.k401.total]) cell(tr, money(x));
      kb.appendChild(tr);
    }
    const last = f.k401Last || {};
    $('mK401Note').textContent = 'Taken by the employer before pay, so it is not in income or savings; it counts toward the goal.' +
      (last.V || last.K ? ` Latest per paycheck: V ${last.V ? money(last.V) : '—'}, K ${last.K ? money(last.K) : '—'}.` : ' Log it per paycheck with 401(K) below.');

    const b = n.budgets;
    const anyBudget = b.jointLeft !== null || b.personalLeft.V !== null || b.personalLeft.K !== null;
    $('mFromCard').hidden = !anyBudget || !ready;
    if (anyBudget) {
      const rows = [];
      if (b.jointLeft !== null) rows.push(['Joint budget left (half each)', b.fromJoint.V, b.fromJoint.K, b.fromJoint.total]);
      if (b.personalLeft.V !== null || b.personalLeft.K !== null) rows.push(['Personal budget left', b.fromPersonal.V, b.fromPersonal.K, b.fromPersonal.total]);
      rows.push(['Rest of income (not budgeted)', b.rest.V, b.rest.K, b.rest.total]);
      rows.push(['Savings this month', n.savings.V, n.savings.K, n.savings.total, 'total']);
      tableRows($('mFrom'), rows);
    }

    // Savings from earlier months
    $('mSurplus').textContent = money(f.available.total);
    $('mSurplus').classList.toggle('neg', f.available.total < 0);
    $('mSurplusV').textContent = money(f.available.V);
    $('mSurplusK').textContent = money(f.available.K);
    $('mSurplusAfter').textContent = money(n.savedAfter.total);
    const moved = [n.used.total ? `${money(n.used.total)} spent from it` : '', n.investSaved.total ? `${money(n.investSaved.total)} invested from it` : '',
      n.famSaved.total ? `${money(n.famSaved.total)} sent to Fam from it` : ''].filter(Boolean);
    $('mSurplusNote').textContent = (moved.length ? `This month: ${moved.join(', ')}. ` : '') +
      `Kept in earlier months and not decided yet; your call. ${monthWord}'s savings join it on the 1st. Invest it (Invest > From: Savings) or spend it (Savings).`;

    // Goal
    const g = f.goal;
    $('mGoalBody').hidden = !g;
    $('mGoalEmpty').hidden = !!g;
    $('goalBtn').textContent = g ? 'Edit goal' : 'Set goal';
    if (g) {
      $('mGoalTitle').textContent = `Goal: ${usd0(g.target)} by ${g.deadlineLabel}`;
      $('mGoalPct').textContent = `${g.percent}%`;
      $('mGoalOf').textContent = `${money(g.invested.total)} of ${usd0(g.target)}`;
      $('mGoalFill').style.width = g.percent + '%';
      $('mGoalFill').parentElement.setAttribute('aria-valuenow', String(Math.round(g.percent)));
      tableRows($('mGoalTable'), [['Invested', g.invested.V, g.invested.K, g.invested.total, '', usd0], ['To go', g.togo.V, g.togo.K, g.togo.total, '', usd0],
        ['Needed / month', g.need.V, g.need.K, g.need.total, '', usd0], ['This month', g.thisMonth.V, g.thisMonth.K, g.thisMonth.total, '', usd0]]);
      const pace = $('mGoalPace');
      if (g.togo.total <= 0) { pace.textContent = 'Goal reached'; pace.className = 'status cleared'; }
      else if (!g.monthsLeft) { pace.textContent = `Deadline passed · ${usd0(g.togo.total)} to go`; pace.className = 'status open'; }
      else {
        const gap = round2(g.need.total - g.thisMonth.total);
        pace.textContent = `${g.monthsLeft} month${g.monthsLeft === 1 ? '' : 's'} left (incl. ${monthWord}) · ` +
          (gap > 0 ? `${money(gap)} more to invest this month to stay on pace` : 'On pace this month');
        pace.className = 'status ' + (gap > 0 ? 'open' : 'cleared');
      }
      const ul = $('mSuggest');
      ul.innerHTML = '';
      for (const t of g.suggestions || []) ul.appendChild(el('li', '', t));
    } else {
      $('mGoalTitle').textContent = 'Savings goal';
    }

    // Loan payments (simple logs)
    const loans = f.loans || [];
    $('mLoansTable').hidden = !loans.length;
    $('mLoansEmpty').hidden = loans.length > 0;
    const lb = $('mLoans');
    lb.innerHTML = '';
    for (const l of loans) {
      const tr = document.createElement('tr');
      cell(tr, l.name, '', 'th');
      cell(tr, money(l.thisMonth));
      cell(tr, money(l.total));
      cell(tr, `${usd0(l.V)} / ${usd0(l.K)}`);
      lb.appendChild(tr);
    }

    // Fam: money sent to the family's investment account (counted as invested, never toward the goal)
    const fams = f.fams || [];
    $('mFam').textContent = money(n.famAll.total);
    $('mFamV').textContent = money(n.famAll.V);
    $('mFamK').textContent = money(n.famAll.K);
    $('mFamAll').textContent = money(f.famTotal.total);
    $('mFamTable').hidden = !fams.length;
    const fb = $('mFams');
    fb.innerHTML = '';
    for (const a of fams) {
      const tr = document.createElement('tr');
      cell(tr, a.name === 'Fam' ? 'Not named' : a.name, '', 'th');
      cell(tr, money(a.thisMonth));
      cell(tr, money(a.total));
      cell(tr, `${usd0(a.V)} / ${usd0(a.K)}`);
      fb.appendChild(tr);
    }
    const famMonths = f.history.filter((h) => h.month !== f.month && h.famAll && h.famAll.total);
    $('mFamNote').textContent = (n.famSaved.total ? `${money(n.famSaved.total)} of this month's came from savings. ` : '') +
      (famMonths.length ? `Last month with Fam: ${usd0(famMonths[famMonths.length - 1].famAll.total)} in ${ymLabel(famMonths[famMonths.length - 1].month)}. ` : '') +
      "Counted as V's or K's investment (it lowers savings, it is not spending) but never toward the V & K goal. Log it with Fam below.";

    // Month by month (latest first; this month from the live estimate)
    const hb = $('mHistory');
    hb.innerHTML = '';
    const hist = f.history.filter((h) => h.month !== f.month).concat(ready ? [{ ...n, month: f.month }] : []);
    if (!hist.length) {
      const tr = document.createElement('tr');
      cell(tr, 'Log income to start the monthly picture.', 'muted').colSpan = 6;
      hb.appendChild(tr);
    }
    for (const h of hist.slice(-12).reverse()) {
      const tr = document.createElement('tr');
      if (h.month === f.month) tr.className = 'current';
      cell(tr, shortMonth(h.month) + (h.month.slice(0, 4) !== f.month.slice(0, 4) ? ' ' + h.month.slice(2, 4) : ''));
      cell(tr, usd0(h.income.total));
      cell(tr, usd0(h.spent.total));
      cell(tr, usd0(h.invest.total));
      cell(tr, usd0(h.famAll ? h.famAll.total : 0));
      cell(tr, usd0(h.savings.total), tone(h.savings.total));
      hb.appendChild(tr);
    }

    const rc = f.recap;
    renderRecapStatus(rc);
    $('mRecapNote').textContent = rc && rc.on ? `Sending to ${rc.to.split(',').join(', ')} ${recapWhen(rc)}.` :
      'A short email on the schedule you pick (daily, weekly, every 2 weeks or monthly): spending vs last month, savings, Fam, goal and loan payments.';
    $('recapBtn').textContent = rc && rc.on ? 'Change email recap' : 'Set up email recap';
  }

  function renderMoneyRecent() {
    const src = recentSource();
    const rows = recentRows(src);
    renderMoreButton(src);
    const list = $('recentList');
    list.innerHTML = '';
    if (!rows.length) list.appendChild(el('li', 'empty', 'Nothing yet.'));
    for (const r of rows) {
      const li = el('li', [KIND_CLASS[r.kind] || '', r.pending ? 'pending' : '', editing && editing.id === r.id ? 'editing' : ''].filter(Boolean).join(' '));
      const body = el('div', 'body');
      const top = el('div', 'top');
      const title = r.kind === 'Goal' ? `Goal by ${ymLabel(r.category)}` : r.kind === 'Savings target' ? 'Savings target' : r.category || KIND_TAGS[r.kind];
      top.append(el('span', '', title), el('span', '', r.kind === 'Savings target' ? `${r.amount}%` : (r.kind === 'Income' ? '+' : '') + money(r.amount)));
      const sub = el('div', 'sub');
      const parts = [prettyDate(r.date)];
      if (r.person && r.kind !== 'Goal' && r.kind !== 'Savings target') parts.push(r.person === 'Both' ? 'V + K' : r.person);
      if ((r.kind === 'Investment' || r.kind === 'Fam') && (r.from === 'Savings' || r.from === 'Surplus')) parts.push('from savings');
      if (r.kind === 'Fam') parts.push('not toward goal');
      parts.push(r.notes);
      sub.append(el('span', 'tag', KIND_TAGS[r.kind] || r.kind), document.createTextNode(parts.filter(Boolean).join(' · ')));
      body.append(top, sub);
      li.appendChild(body);
      if (r.id && MONEY_EDITABLE.includes(r.kind)) li.appendChild(editButton(r, 'funds', title));
      if (r.id) {
        const del = el('button', 'del', '×');
        del.type = 'button';
        del.setAttribute('aria-label', `Delete ${title}`);
        del.addEventListener('click', () => removeEntry({ ...r, category: title }, 'funds'));
        li.appendChild(del);
      }
      list.appendChild(li);
    }
    const qn = getQueue().length;
    $('syncNote').textContent = qn ? `${qn} waiting to sync` : '';
  }

  // ---------- Home: one glance at everything; each tile opens its page
  function owedStatus(p) {
    const vShare = round2(p.v - p.spent / 2);
    const fvShare = fixedShares(p).fvShare;
    return statusOf(round2(vShare + fvShare + round2(p.personal || 0)), p.settledNet || 0, p.settled || 0);
  }

  function renderHome() {
    const f = fundsEstimate();
    const ready = hasFunds();
    const e = estimate();
    const p = e.period;
    const pb = estimatePersonal();
    const st = getState() || {};
    const monthWord = monthName(currentMonth() + '-01');

    // Hero: this month's savings (what is left of income after spending and investing), else the joint budget.
    const meter = $('hHeroMeter');
    meter.hidden = true;
    let label = `${monthWord}`, amt = '—', word = '', note = 'Log income in Funds and set budgets in Joint and Personal to see your month here.', neg = false;
if (ready && f.now.income.total > 0) {
      label = `Savings in ${monthWord}`;
      amt = money(Math.abs(f.now.savings.total));
      neg = f.now.savings.total < 0;
      word = neg ? 'short' : `so far (${pctText(f.now.rate.total)} kept)`;
      note = `V ${money(f.now.savings.V)} · K ${money(f.now.savings.K)}: what is left of each income after spending and investing.`;
    } else if (e.hasBalance) {
      label = `${monthWord} joint budget`;
      amt = money(Math.abs(e.balance));
      neg = e.balance < 0;
      word = neg ? 'over budget' : 'left';
      note = `About ${money(Math.max(0, e.balance) / daysLeftInMonth())} a day for the rest of ${monthWord}.`;
    }
    $('hHeroLabel').textContent = label;
    $('hHeroAmt').textContent = amt;
    $('hHeroAmt').classList.toggle('neg', neg);
    $('hHeroWord').textContent = word;
    $('hHeroNote').textContent = note;

    const tiles = [];
    const tile = (target, color, labelText, value, subText, kind) => tiles.push({ target, color, labelText, value, subText, kind });
    if (e.hasBalance) {
      const budget = round2(p.start + p.added);
      tile('Joint', 'var(--accent)', 'Joint budget', e.balance < 0 ? `${money(-e.balance)} over` : `${money(e.balance)} left`, `of ${money(budget)} · spent ${money(p.spent)}`, e.balance < 0 ? 'neg' : '');
    } else {
      tile('Joint', 'var(--accent)', 'Joint budget', 'Not set', `Spent ${money(p.spent)} so far`);
    }
    const pbText = (b) => (b ? (b.remaining < 0 ? `${usd0(-b.remaining)} over` : `${usd0(b.remaining)} left`) : 'not set');
    tile('Personal', '#3b82f6', 'Personal', `V ${pb.V ? usd0(pb.V.remaining) : '—'} · K ${pb.K ? usd0(pb.K.remaining) : '—'}`, `V ${pbText(pb.V)}, K ${pbText(pb.K)}`,
      (pb.V && pb.V.remaining < 0) || (pb.K && pb.K.remaining < 0) ? 'neg' : '');
    const os = owedStatus(p);
    tile('Joint', '#22c55e', 'Who owes whom', os.kind === 'open' ? settleText(os.remaining, -os.remaining) : os.kind === 'cleared' ? 'Cleared' : 'Even',
      os.kind === 'open' ? 'Joint + Fixed + Personal, this month' : 'Nothing owed this month', os.kind === 'cleared' ? 'good' : '');
    const fxh = fixedShares(p);
    tile('Fixed', '#fb923c', 'Fixed bills', money(p.fixed), `${monthWord} · V's fixed ${money(fxh.fixedV)}, K's ${money(fxh.fixedK)}`);
    const c = st.car;
    const carMonth = c && (c.monthly || []).find((m) => m.month === currentMonth());
    tile('Car', '#818cf8', 'Sonata', c && c.mpg ? `${Number(c.mpg).toFixed(1)} MPG` : '—', `${money(carMonth ? carMonth.total : 0)} on the car in ${monthWord}`);
    if (ready) {
      tile('Funds', '#22c55e', 'Savings this month', money(f.now.savings.total), `${money(f.now.invest.total)} invested · ${pctText(f.now.rate.total)} of income kept`, f.now.savings.total < 0 ? 'neg' : '');
      tile('Funds', '#eab308', 'Savings from earlier', money(f.available.total), `Not decided yet · ${money(f.now.savedAfter.total)} after ${monthWord}`);
    }
    if (f.now.k401.total > 0 || f.k401Total.total > 0) {
      tile('Funds', '#8b5cf6', '401(K)', money(f.now.k401.total), `${monthWord} · V ${usd0(f.now.k401.V)}, K ${usd0(f.now.k401.K)} · ${usd0(f.k401Total.total)} so far`);
    }
    if (f.now.famAll.total > 0 || f.famTotal.total > 0) {
      tile('Funds', '#14b8a6', 'Fam', money(f.now.famAll.total), `${monthWord} · V ${usd0(f.now.famAll.V)}, K ${usd0(f.now.famAll.K)} · ${usd0(f.famTotal.total)} so far · not in goal`);
    }
    if (f.goal) tile('Funds', '#a855f7', 'Goal', `${f.goal.percent}%`, `${usd0(f.goal.need.total)} a month to reach ${usd0(f.goal.target)} by ${f.goal.deadlineLabel}`);
    if (f.now.loan.total > 0 || (f.loans || []).length) {
      tile('Funds', '#f87171', 'Loan payments', money(f.now.loan.total), `${monthWord} · ` + ((f.loans || []).filter((l) => l.thisMonth > 0).map((l) => l.name).join(', ') || 'none yet this month'));
    }
    const box = $('hTiles');
    box.innerHTML = '';
    for (const t of tiles) {
      const btn = el('button', 'tile' + (t.kind ? ' ' + t.kind : ''));
      btn.type = 'button';
      btn.style.setProperty('--tile', t.color);
      btn.append(el('span', 't-label', t.labelText), el('span', 't-value', t.value), el('span', 't-sub', t.subText));
      btn.addEventListener('click', () => setView(t.target));
      box.appendChild(btn);
    }
    const tips = ready ? (f.suggestions || []).slice(0, 3) : [];
    $('hTipsCard').hidden = !tips.length;
    $('hTips').innerHTML = '';
    for (const t of tips) $('hTips').appendChild(el('li', '', t));
    renderAnalytics();
  }

  // ---------- Analytics (Home): where the money goes, by tag and type, month over month and year over year.
  // Rows come from the sheet (state.analytics): spend [month, group, tag, who, amount], funds [month, kind, who, amount].
  // Series keep their color whatever the filter: Joint, Fixed, Personal V, Personal K, Sonata.
  const SERIES = ['Joint', 'Fixed', 'Personal V', 'Personal K', 'Sonata'];
  const SERIES_CLASS = { 'Joint': 's1', 'Fixed': 's2', 'Personal V': 's3', 'Personal K': 's4', 'Sonata': 's5' };
  const AN_GROUPS = [['all', 'All'], ['Joint', 'Joint'], ['Fixed', 'Fixed'], ['Personal', 'Personal'],
    ['Personal V', 'Personal V'], ['Personal K', 'Personal K'], ['Sonata', 'Sonata']];
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const seriesOf = (row) => (row[1] === 'Personal' ? 'Personal ' + row[3] : row[1]);
  const ymLabelShort = (ym) => `${MON[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
  const addMonths = (ym, n) => {
    const d = new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1 + n, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  };
  const sum = (rows) => round2(rows.reduce((t, r) => t + r[r.length - 1], 0));
  let anFilter = store.get('an', null);

  function groupMatches(row, group) {
    if (group === 'all') return true;
    if (group === 'Personal') return row[1] === 'Personal';
    return seriesOf(row) === group;
  }

  // The selected period and what it is compared with. Each comparison has its own test for the
  // earlier period, and nowTest for the part of the selected period it is compared with.
  // have = months with any spending logged.
  function anPeriods(f, cur, have) {
    const inYM = (y, m) => (k) => (y === 'all' || k.slice(0, 4) === y) && (m === 'all' || k.slice(5, 7) === m);
    const main = { test: inYM(f.year, f.month), label: '' };
    const out = { main, compare: [] };
    if (f.year !== 'all' && f.month !== 'all') {
      const ym = `${f.year}-${f.month}`;
      main.label = ymLabelShort(ym);
      const prev = addMonths(ym, -1);
      out.compare.push({ test: (k) => k === prev, label: `vs ${ymLabelShort(prev)}`, short: MON[Number(prev.slice(5, 7)) - 1] });
      const ly = `${Number(f.year) - 1}-${f.month}`;
      out.compare.push({ test: (k) => k === ly, label: `vs ${ymLabelShort(ly)}`, short: ymLabelShort(ly) });
      out.days = ym === cur ? Number(today().slice(8, 10)) : new Date(Number(f.year), Number(f.month), 0).getDate();
    } else if (f.year !== 'all') {
      // A whole year: compared month for month with the same months of last year, only the months
      // logged in both (tracking may have started partway through last year).
      const ytd = f.year === cur.slice(0, 4);
      const lastM = ytd ? cur.slice(5, 7) : '12';
      main.label = ytd ? `${f.year} so far` : f.year;
      const py = String(Number(f.year) - 1);
      const both = MON.map((_, i) => String(i + 1).padStart(2, '0'))
        .filter((m) => m <= lastM && have.has(`${py}-${m}`) && have.has(`${f.year}-${m}`));
      if (both.length) {
        const span = both.length === 12 ? '' : both.length === 1 ? ` ${MON[Number(both[0]) - 1]}` : ` ${MON[Number(both[0]) - 1]} to ${MON[Number(both[both.length - 1]) - 1]}`;
        out.compare.push({ test: (k) => k.slice(0, 4) === py && both.includes(k.slice(5, 7)),
          nowTest: (k) => k.slice(0, 4) === f.year && both.includes(k.slice(5, 7)),
          label: `vs${span} ${py}`, short: py, partial: both.length < Number(lastM) });
      }
      out.months = Number(lastM);
    } else if (f.month !== 'all') {
      main.label = `Every ${MON[Number(f.month) - 1]}`;
    } else {
      main.label = 'All time';
    }
    return out;
  }

  function anDelta(now, before, label) {
    if (!before) return { text: `nothing ${label.replace(/^vs /, 'in ')}`, kind: '' };
    const diff = round2(now - before);
    const pct = Math.round((diff / Math.abs(before)) * 100);
    const arrow = diff > 0 ? '▲' : diff < 0 ? '▼' : '';
    return { text: `${arrow} ${usd0(Math.abs(diff))} (${Math.abs(pct)}%) ${label}`.trim(), kind: diff > 0 ? 'up' : diff < 0 ? 'down' : '' };
  }

  // A readout line under a chart: what the touched mark stands for (hover or tap).
  function readout(fig, text) {
    let out = fig.querySelector('.readout');
    if (!out) { out = el('div', 'readout'); out.setAttribute('aria-live', 'polite'); fig.appendChild(out); }
    out.textContent = text;
  }
  function touch(mark, fig, text) {
    const show = () => {
      fig.querySelectorAll('.on').forEach((x) => x.classList.remove('on'));
      mark.classList.add('on');
      readout(fig, text);
    };
    mark.addEventListener('pointerenter', show);
    mark.addEventListener('click', show);
    mark.setAttribute('tabindex', '0');
    mark.addEventListener('focus', show);
    mark.appendChild(svgEl('title', {}, text));
  }

  function legend(names) {
    const box = el('div', 'legend');
    for (const n of names) {
      const item = el('span', 'legend-item');
      item.append(el('span', 'swatch ' + (SERIES_CLASS[n] || n)), document.createTextNode(n));
      box.appendChild(item);
    }
    return box;
  }

  // Donut: share of each type in the period, total in the middle.
  function donut(title, parts, total) {
    const fig = el('figure', 'chart an-donut');
    fig.appendChild(el('figcaption', '', title));
    const wrap = el('div', 'donut-wrap');
    const svg = svgEl('svg', { viewBox: '0 0 120 120', role: 'img', 'aria-label': title });
    const R = 50, r = 33, cx = 60, cy = 60;
    let a0 = -Math.PI / 2;
    const positive = parts.filter((p) => p.value > 0);
    const whole = positive.reduce((t, p) => t + p.value, 0) || 1;
    for (const p of positive) {
      const a1 = a0 + (p.value / whole) * Math.PI * 2;
      const big = a1 - a0 > Math.PI ? 1 : 0;
      const pt = (rad, a) => `${cx + rad * Math.cos(a)},${cy + rad * Math.sin(a)}`;
      const d = positive.length === 1
        ? `M${cx},${cy - R}A${R},${R} 0 1 1 ${cx - 0.01},${cy - R}L${cx - 0.01},${cy - r}A${r},${r} 0 1 0 ${cx},${cy - r}Z`
        : `M${pt(R, a0)}A${R},${R} 0 ${big} 1 ${pt(R, a1)}L${pt(r, a1)}A${r},${r} 0 ${big} 0 ${pt(r, a0)}Z`;
      const seg = svgEl('path', { d, class: 'seg ' + SERIES_CLASS[p.name] });
      touch(seg, fig, `${p.name}: ${money(p.value)} (${Math.round((p.value / whole) * 100)}%)`);
      svg.appendChild(seg);
      a0 = a1;
    }
    svg.appendChild(svgEl('text', { x: cx, y: cy - 2, 'text-anchor': 'middle', class: 'donut-total' }, usd0(total)));
    svg.appendChild(svgEl('text', { x: cx, y: cy + 12, 'text-anchor': 'middle', class: 'axis' }, 'spent'));
    wrap.appendChild(svg);
    const list = el('ul', 'donut-legend');
    for (const p of parts) {
      const li = el('li');
      li.append(el('span', 'swatch ' + SERIES_CLASS[p.name]), el('span', 'dl-name', p.name),
        el('span', 'dl-amt', money(p.value)), el('span', 'dl-pct', `${whole ? Math.round((Math.max(p.value, 0) / whole) * 100) : 0}%`));
      list.appendChild(li);
    }
    wrap.appendChild(list);
    fig.appendChild(wrap);
    readout(fig, 'Tap a slice for its amount.');
    return fig;
  }

  // Stacked columns, one per month, by type. The selected month is outlined.
  function stackedMonths(title, keys, rows, names, selected) {
    const fig = el('figure', 'chart');
    fig.appendChild(el('figcaption', '', title));
    if (names.length > 1) fig.appendChild(legend(names));
    const svg = svgEl('svg', { viewBox: '0 0 320 150', role: 'img', 'aria-label': title });
    const L = 34, R = 316, T = 12, B = 124;
    const totals = keys.map((k) => names.map((n) => sum(rows.filter((x) => x[0] === k && seriesOf(x) === n))));
    const max = Math.max(1, ...totals.map((t) => t.reduce((a, b) => a + Math.max(b, 0), 0)));
    const y = (v) => B - (v / max) * (B - T);
    svg.appendChild(svgEl('line', { x1: L, x2: R, y1: y(max), y2: y(max), class: 'grid' }));
    svg.appendChild(svgEl('text', { x: L - 4, y: y(max) + 3, 'text-anchor': 'end', class: 'axis' }, usd0(max)));
    svg.appendChild(svgEl('line', { x1: L, x2: R, y1: B, y2: B, class: 'base' }));
    const slot = (R - L) / keys.length;
    const w = Math.min(18, slot - 4);
    keys.forEach((k, i) => {
      const x = L + slot * i + (slot - w) / 2;
      const g = svgEl('g', { class: 'col' + (k === selected ? ' sel' : '') });
      let top = B;
      const parts = [];
      names.forEach((n, j) => {
        const v = totals[i][j];
        if (v <= 0) return;
        const h = (v / max) * (B - T);
        g.appendChild(svgEl('rect', { x, y: top - h, width: w, height: Math.max(h - 1, 0.5), rx: 2, class: 'seg ' + SERIES_CLASS[n] }));
        top -= h;
        parts.push(`${n} ${usd0(v)}`);
      });
      const total = round2(totals[i].reduce((a, b) => a + b, 0));
      // A wide invisible target, bigger than the column.
      g.insertBefore(svgEl('rect', { x: L + slot * i, y: T, width: slot, height: B - T, class: 'hit' }), g.firstChild);
      if (k === selected) g.appendChild(svgEl('rect', { x: x - 2, y: top - 2, width: w + 4, height: B - top + 2, rx: 3, class: 'sel-ring' }));
      touch(g, fig, `${ymLabelShort(k)}: ${money(total)}${names.length > 1 && parts.length ? ' · ' + parts.join(', ') : ''}`);
      svg.appendChild(g);
      if (keys.length <= 12 || i % 2 === 0) {
        svg.appendChild(svgEl('text', { x: x + w / 2, y: 140, 'text-anchor': 'middle', class: 'axis' + (k === selected ? ' axis-sel' : '') }, MON[Number(k.slice(5, 7)) - 1]));
      }
    });
    fig.appendChild(svg);
    const sel = keys.indexOf(selected) !== -1 ? selected : keys[keys.length - 1];
    const si = keys.indexOf(sel);
    readout(fig, `${ymLabelShort(sel)}: ${money(round2(totals[si].reduce((a, b) => a + b, 0)))}. Tap a month for its breakdown.`);
    return fig;
  }

  // This year against last year, month by month (two columns per month).
  function yearOverYear(title, year, rows, selectedMonth, lastMonth) {
    const fig = el('figure', 'chart');
    fig.appendChild(el('figcaption', '', title));
    const py = String(Number(year) - 1);
    const box = el('div', 'legend');
    const item = (cls, text) => { const s = el('span', 'legend-item'); s.append(el('span', 'swatch ' + cls), document.createTextNode(text)); box.appendChild(s); };
    item('yoy-now', year);
    item('yoy-prev', py);
    fig.appendChild(box);
    const svg = svgEl('svg', { viewBox: '0 0 320 150', role: 'img', 'aria-label': title });
    const L = 34, R = 316, T = 12, B = 124;
    const val = (y, m) => sum(rows.filter((x) => x[0] === `${y}-${m}`));
    const months = MON.map((_, i) => String(i + 1).padStart(2, '0'));
    const now = months.map((m) => (Number(m) <= lastMonth ? val(year, m) : null));
    const prev = months.map((m) => val(py, m));
    const max = Math.max(1, ...now.filter((v) => v !== null), ...prev);
    const y = (v) => B - (Math.max(v, 0) / max) * (B - T);
    svg.appendChild(svgEl('line', { x1: L, x2: R, y1: y(max), y2: y(max), class: 'grid' }));
    svg.appendChild(svgEl('text', { x: L - 4, y: y(max) + 3, 'text-anchor': 'end', class: 'axis' }, usd0(max)));
    svg.appendChild(svgEl('line', { x1: L, x2: R, y1: B, y2: B, class: 'base' }));
    const slot = (R - L) / 12;
    const w = Math.min(8, (slot - 4) / 2);
    months.forEach((m, i) => {
      const x0 = L + slot * i + slot / 2 - w - 1;
      const g = svgEl('g', { class: 'col' + (m === selectedMonth ? ' sel' : '') });
      g.appendChild(svgEl('rect', { x: L + slot * i, y: T, width: slot, height: B - T, class: 'hit' }));
      if (prev[i] > 0) g.appendChild(svgEl('rect', { x: x0, y: y(prev[i]), width: w, height: Math.max(B - y(prev[i]), 0.5), rx: 2, class: 'seg yoy-prev' }));
      if (now[i] > 0) g.appendChild(svgEl('rect', { x: x0 + w + 2, y: y(now[i]), width: w, height: Math.max(B - y(now[i]), 0.5), rx: 2, class: 'seg yoy-now' }));
      const d = now[i] !== null && prev[i] ? ` (${now[i] >= prev[i] ? '+' : '-'}${Math.abs(Math.round(((now[i] - prev[i]) / prev[i]) * 100))}%)` : '';
      touch(g, fig, `${MON[i]}: ${year} ${now[i] === null ? 'not yet' : money(now[i])} · ${py} ${money(prev[i])}${d}`);
      svg.appendChild(g);
      svg.appendChild(svgEl('text', { x: L + slot * i + slot / 2, y: 140, 'text-anchor': 'middle', class: 'axis' + (m === selectedMonth ? ' axis-sel' : '') }, MON[i].slice(0, 1)));
    });
    fig.appendChild(svg);
    // Totals over the months logged in both years.
    const both = months.map((_, i) => i).filter((i) => now[i] && prev[i]);
    const nowSame = round2(both.reduce((t, i) => t + now[i], 0));
    const prevSame = round2(both.reduce((t, i) => t + prev[i], 0));
    const span = both.length ? (both.length === 1 ? MON[both[0]] : `${MON[both[0]]} to ${MON[both[both.length - 1]]}`) : '';
    readout(fig, both.length
      ? `${span}: ${year} ${money(nowSame)} · ${py} ${money(prevSame)}. Tap a month to compare.`
      : 'Tap a month to compare.');
    return fig;
  }

  function renderAnalytics() {
    const st = getState() || {};
    const a = st.analytics;
    const card = $('anCard');
    card.hidden = !getSettings();
    if (!a) {
      $('anBody').hidden = true;
      $('anEmpty').hidden = false;
      $('anEmpty').textContent = st.version && st.version < 24
        ? 'Charts need the Apps Script at version 24. Paste the latest Code.gs and deploy a new version.'
        : 'Charts appear after the first sync.';
      return;
    }
    const cur = currentMonth();
    const spendAll = a.spend || [];
    const years = [...new Set(spendAll.map((r) => r[0].slice(0, 4)).concat(cur.slice(0, 4)))].sort().reverse();
    if (!anFilter || (anFilter.year !== 'all' && !years.includes(anFilter.year))) anFilter = { year: cur.slice(0, 4), month: cur.slice(5, 7), group: 'all', table: false };
    const f = anFilter;
    const fill = (select, options, value) => {
      select.innerHTML = '';
      for (const [v, label] of options) { const o = document.createElement('option'); o.value = v; o.textContent = label; select.appendChild(o); }
      select.value = value;
    };
    fill($('anYear'), [['all', 'All years'], ...years.map((y) => [y, y])], f.year);
    fill($('anMonth'), [['all', f.year === 'all' ? 'All months' : 'Whole year'], ...MON.map((m, i) => [String(i + 1).padStart(2, '0'), m])], f.month);
    fill($('anGroup'), AN_GROUPS, f.group);
    $('anTableBtn').setAttribute('aria-pressed', String(!!f.table));
    $('anTableBtn').textContent = f.table ? 'Charts' : 'Table';

    const spend = spendAll.filter((r) => groupMatches(r, f.group));
    const periods = anPeriods(f, cur, new Set(spendAll.map((r) => r[0])));
    const inMain = spend.filter((r) => periods.main.test(r[0]));
    const total = sum(inMain);
    $('anEmpty').hidden = !!spendAll.length;
    $('anEmpty').textContent = 'Nothing logged yet. Charts fill in as you save expenses.';
    $('anBody').hidden = !spendAll.length;
    if (!spendAll.length) return;

    // Headline numbers.
    const kpis = $('anKpis');
    kpis.innerHTML = '';
    const kpi = (label, value, subs) => {
      const box = el('div', 'kpi');
      box.append(el('span', 'k-label', label), el('span', 'k-value', value));
      for (const s of subs) if (s) box.appendChild(el('span', 'k-sub' + (s.kind ? ' ' + s.kind : ''), s.text));
      kpis.appendChild(box);
    };
    const nowFor = (c) => (c.nowTest ? sum(spend.filter((r) => c.nowTest(r[0]))) : total);
    kpi(`Spent · ${periods.main.label}`, money(total), periods.compare.map((c) => anDelta(nowFor(c), sum(spend.filter((r) => c.test(r[0]))), c.label)));
    const funds = (a.funds || []).filter((r) => periods.main.test(r[0]));
    const income = sum(funds.filter((r) => r[1] === 'Income'));
    if (periods.days) kpi('Per day', money(total / periods.days), [{ text: `over ${periods.days} day${periods.days === 1 ? '' : 's'}` }]);
    else {
      const monthsWithData = new Set(inMain.map((r) => r[0])).size || 1;
      kpi('Per month', money(total / (periods.months || monthsWithData)), [{ text: `average of ${periods.months || monthsWithData} month${(periods.months || monthsWithData) === 1 ? '' : 's'}` }]);
    }
    if (income > 0 && f.group === 'all') kpi('Income', money(income), [{ text: `${Math.round((total / income) * 100)}% of it spent` }]);

    // By tag: ranked, with the change against the first comparison period.
    const cmp = periods.compare[0];
    const tagTotals = {};
    const tagBefore = {};
    const tagNow = {};
    for (const r of inMain) tagTotals[r[2]] = round2((tagTotals[r[2]] || 0) + r[4]);
    if (cmp) {
      for (const r of spend.filter((x) => cmp.test(x[0]))) tagBefore[r[2]] = round2((tagBefore[r[2]] || 0) + r[4]);
      for (const r of spend.filter((x) => (cmp.nowTest || periods.main.test)(x[0]))) tagNow[r[2]] = round2((tagNow[r[2]] || 0) + r[4]);
    }
    const tags = Object.keys(tagTotals).filter((t) => tagTotals[t] !== 0).sort((x, y) => tagTotals[y] - tagTotals[x]);
    const tagMax = Math.max(1, ...tags.map((t) => tagTotals[t]));

    // By type (donut) and month by month.
    const names = SERIES.filter((n) => spend.some((r) => seriesOf(r) === n));
    const parts = names.map((n) => ({ name: n, value: sum(inMain.filter((r) => seriesOf(r) === n)) }));
    let keys;
    if (f.year !== 'all' && f.month === 'all') {
      const last = f.year === cur.slice(0, 4) ? Number(cur.slice(5, 7)) : 12;
      keys = Array.from({ length: last }, (_, i) => `${f.year}-${String(i + 1).padStart(2, '0')}`);
    } else {
      const end = f.year !== 'all' && f.month !== 'all' ? `${f.year}-${f.month}` : cur;
      keys = Array.from({ length: 12 }, (_, i) => addMonths(end, i - 11));
      const first = spendAll.length ? spendAll.reduce((m, r) => (r[0] < m ? r[0] : m), cur) : cur;
      while (keys.length > 3 && keys[0] < first) keys.shift();
    }
    const selected = f.year !== 'all' && f.month !== 'all' ? `${f.year}-${f.month}` : '';
    const yoyYear = f.year !== 'all' ? f.year : cur.slice(0, 4);
    const hasLastYear = spend.some((r) => r[0].slice(0, 4) === String(Number(yoyYear) - 1));

    const charts = $('anCharts');
    const table = $('anTable');
    charts.innerHTML = '';
    table.innerHTML = '';
    charts.hidden = !!f.table;
    table.hidden = !f.table;

    const tagFig = el('figure', 'chart');
    tagFig.appendChild(el('figcaption', '', `By tag · ${periods.main.label}${cmp ? ` (change ${cmp.label})` : ''}`));
    const list = el('ul', 'tag-bars');
    if (!tags.length) list.appendChild(el('li', 'muted', 'Nothing spent in this period.'));
    for (const t of tags) {
      const v = tagTotals[t];
      const li = el('li');
      const head = el('div', 'tb-head');
      head.append(el('span', 'tb-name', t), el('span', 'tb-amt', `${money(v)} · ${total > 0 ? Math.round((v / total) * 100) : 0}%`));
      const track = el('div', 'tb-track');
      const bar = el('div', 'tb-fill');
      bar.style.width = `${Math.max(0, (v / tagMax) * 100)}%`;
      track.appendChild(bar);
      li.append(head, track);
      if (cmp) {
        const d = round2((tagNow[t] || 0) - (tagBefore[t] || 0));
        li.appendChild(el('span', 'tb-delta', !tagBefore[t] ? `new ${cmp.label.replace(/^vs /, 'since ')}` : d === 0 ? 'no change' : `${d > 0 ? '▲' : '▼'} ${usd0(Math.abs(d))} ${cmp.label}`));
      }
      list.appendChild(li);
    }
    tagFig.appendChild(list);
    charts.appendChild(tagFig);
    if (names.length > 1 && total > 0) charts.appendChild(donut(`By type · ${periods.main.label}`, parts, total));
    charts.appendChild(stackedMonths(f.year !== 'all' && f.month === 'all' ? `Month by month · ${f.year}` : 'Month by month · last 12 months', keys, spend, names, selected));
    if (hasLastYear) {
      const lastMonth = yoyYear === cur.slice(0, 4) ? Number(cur.slice(5, 7)) : 12;
      charts.appendChild(yearOverYear(`Year over year · ${yoyYear} vs ${Number(yoyYear) - 1}`, yoyYear, spend, f.month !== 'all' ? f.month : '', lastMonth));
    }
    // Funds in the same period (income, 401(K), investments, Fam, loans, savings used).
    if (funds.length && f.group === 'all') {
      const ff = el('figure', 'chart');
      ff.appendChild(el('figcaption', '', `Funds · ${periods.main.label}`));
      const ul = el('ul', 'fund-rows');
      for (const kind of ['Income', '401(K)', 'Investment', 'Fam', 'Loan payment', 'Use savings']) {
        const v = sum(funds.filter((r) => r[1] === kind));
        if (!v) continue;
        const li = el('li');
        const byWho = ['V', 'K', 'Both'].map((w) => [w, sum(funds.filter((r) => r[1] === kind && r[2] === w))]).filter(([, x]) => x);
        li.append(el('span', '', kind === 'Use savings' ? 'Savings used' : kind === 'Fam' ? 'Fam (not in goal)' : kind), el('span', 'fr-amt', money(v)),
          el('span', 'fr-sub', byWho.map(([w, x]) => `${w === 'Both' ? 'Joint' : w} ${usd0(x)}`).join(' · ')));
        ul.appendChild(li);
      }
      ff.appendChild(ul);
      charts.appendChild(ff);
    }

    // Table view: the same numbers as text.
    const mk = (headers, rows) => {
      const tb = document.createElement('table');
      tb.className = 'data';
      const tr = document.createElement('tr');
      for (const h of headers) { const th = document.createElement('th'); th.textContent = h; th.scope = 'col'; tr.appendChild(th); }
      tb.appendChild(tr);
      for (const r of rows) {
        const row = document.createElement('tr');
        r.forEach((c, i) => { const td = document.createElement(i ? 'td' : 'th'); if (!i) td.scope = 'row'; td.textContent = c; row.appendChild(td); });
        tb.appendChild(row);
      }
      return tb;
    };
    table.append(el('h3', '', `By tag · ${periods.main.label}`),
      mk(['Tag', 'Spent', 'Share'].concat(cmp ? [cmp.short] : []), tags.map((t) => [t, money(tagTotals[t]), `${total > 0 ? Math.round((tagTotals[t] / total) * 100) : 0}%`]
        .concat(cmp ? [money(tagBefore[t] || 0)] : []))));
    table.append(el('h3', '', 'Month by month'),
      mk(['Month'].concat(names.length > 1 ? names : [], ['Total']), keys.map((k) => {
        const per = names.map((n) => sum(spend.filter((r) => r[0] === k && seriesOf(r) === n)));
        return [ymLabelShort(k)].concat(names.length > 1 ? per.map(money) : [], [money(round2(per.reduce((x, y) => x + y, 0)))]);
      }).reverse()));

    $('anNote').textContent = 'Spending is Joint, Fixed, Personal and Sonata. Refunds lower it; budgets and settlements are not spending. ' +
      'Change a tag from the pencil in Recent or in the Tag column of the month tab. Updates after each sync.';
  }
  const anChange = () => {
    anFilter = { ...(anFilter || {}), year: $('anYear').value, month: $('anMonth').value, group: $('anGroup').value };
    store.set('an', anFilter);
    renderAnalytics();
  };
  ['anYear', 'anMonth', 'anGroup'].forEach((id) => $(id).addEventListener('change', anChange));
  $('anTableBtn').addEventListener('click', () => {
    anFilter = { ...(anFilter || {}), table: !(anFilter && anFilter.table) };
    store.set('an', anFilter);
    renderAnalytics();
  });

  // ---- Goal dialog (target, deadline, investments from before tracking)
  const goalDialog = $('goalDialog');
  // From the Fam. tab: V 401(K) 243.60; K 401(K) 225 + India 4,100 + 2,084.
  const PRIOR_DEFAULT = { V: 243.6, K: 6409 };
  const hasPrior = () => {
    const f = (getState() || {}).funds;
    return !!(f && f.goal) || getQueue().some((op) => op.table === 'funds' && op.op === 'add' && (op.entry.kind === 'Prior investment' || op.entry.kind === 'Goal'));
  };
  $('goalBtn').addEventListener('click', () => {
    $('goalForm').reset();
    clearInvalid($('goalForm'));
    const g = fundsEstimate().goal;
    $('goalTarget').value = g ? String(g.target) : '150000';
    $('goalDeadline').value = g && /^\d{4}-\d{2}$/.test(String(g.deadline)) ? g.deadline : '2027-07';
    const first = !hasPrior();
    $('priorFields').hidden = !first;
    if (first) { $('priorV').value = PRIOR_DEFAULT.V.toFixed(2); $('priorK').value = PRIOR_DEFAULT.K.toFixed(2); }
    goalDialog.showModal();
  });
  for (const id of ['goalTarget', 'goalDeadline', 'priorV', 'priorK', 'recapTo', 'payInvest', 'payLoan', 'payK401', 'moneyOther']) {
    $(id).addEventListener('input', () => $(id).classList.remove('invalid'));
  }
  $('goalForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (e.submitter && e.submitter.value === 'cancel') return goalDialog.close();
    const target = parseAmount($('goalTarget').value);
    const deadline = $('goalDeadline').value;
    if (target === null || target <= 0) return $('goalTarget').classList.add('invalid');
    if (!/^\d{4}-\d{2}$/.test(deadline) || deadline < currentMonth()) return $('goalDeadline').classList.add('invalid');
    const prior = {};
    if (!$('priorFields').hidden) {
      for (const who of ['V', 'K']) {
        const raw = $('prior' + who).value.trim();
        const v = raw === '' ? 0 : parseAmount(raw);
        if (v === null || v < 0) return $('prior' + who).classList.add('invalid');
        prior[who] = v;
      }
    }
    goalDialog.close();
    const date = today();
    for (const who of ['V', 'K']) {
      if (prior[who] > 0) enqueue({ op: 'add', table: 'funds', entry: { id: uuid(), date, kind: 'Prior investment', category: 'Before tracking', amount: prior[who], person: who, notes: 'From the Fam. tab' } });
    }
    enqueue({ op: 'add', table: 'funds', entry: { id: uuid(), date, kind: 'Goal', category: deadline, amount: target, person: 'Both', notes: '' } });
    const status = await sync();
    const g = fundsEstimate().goal;
    report(status, `Goal set ✓ ${usd0(target)} by ${ymLabel(deadline)}` + (g && g.monthsLeft ? ` · ${usd0(g.need.total)} a month` : ''));
  });


  // ---- Email recap (needs a connection: it changes the sheet's script settings directly).
  // Daily, weekly, every 2 weeks or monthly, at a chosen hour (script version 26; older scripts send
  // weekly on Sunday evening whatever is picked).
  const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const hourText = (h) => `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`;
  const ordinal = (n) => n + (n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th');
  // "every Sunday around 6 PM", "on the 1st of each month around 8 AM"...
  function recapWhen(rc) {
    const freq = rc.freq || 'weekly';
    const hour = rc.hour === undefined ? 18 : rc.hour;
    const day = rc.day === undefined ? 0 : rc.day;
    const at = `around ${hourText(hour)}`;
    if (freq === 'daily') return `every day ${at}`;
    if (freq === 'monthly') return `on the ${ordinal(day)} of each month ${at}`;
    return `${freq === 'biweekly' ? 'every other' : 'every'} ${WEEKDAY_NAMES[day] || 'Sunday'} ${at}`;
  }
  // Whether it is working: last send (or its error), and a missing schedule.
  function renderRecapStatus(rc) {
    const el = $('mRecapStatus');
    const parts = [];
    let kind = '';
    if (rc && rc.on && rc.triggers === 0) { parts.push('The schedule is missing in the script: tap Change email recap and Save.'); kind = 'open'; }
    if (rc && rc.last && rc.last.at) {
      const when = new Date(rc.last.at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      const what = rc.last.kind === 'test' ? 'test' : 'recap';
      if (rc.last.ok) { parts.push(`Last ${what} sent ${when}.`); kind = kind || 'cleared'; }
      else { parts.push(`Last ${what} failed ${when}: ${rc.last.error || 'unknown error'}`); kind = 'open'; }
    } else if (rc && rc.on && rc.last === null) {
      parts.push('Nothing sent yet. Use Save + send test to check it works.');
    }
    el.hidden = !parts.length;
    el.textContent = parts.join(' ');
    el.className = 'status' + (kind ? ' ' + kind : '');
  }

  const recapDialog = $('recapDialog');
  for (let h = 0; h < 24; h++) $('recapHour').add(new Option(hourText(h), String(h)));
  function setupRecapDay(freq, day) {
    const field = $('recapDayField');
    const select = $('recapDay');
    field.hidden = freq === 'daily';
    select.innerHTML = '';
    if (freq === 'monthly') {
      $('recapDayLabel').textContent = 'Day of month';
      for (let d = 1; d <= 28; d++) select.add(new Option(ordinal(d), String(d)));
      select.value = String(day >= 1 && day <= 28 ? day : 1);
    } else {
      $('recapDayLabel').textContent = 'Day';
      WEEKDAY_NAMES.forEach((n, i) => select.add(new Option(n, String(i))));
      select.value = String(day >= 0 && day <= 6 ? day : 0);
    }
  }
  $('recapFreq').addEventListener('change', () => setupRecapDay($('recapFreq').value, $('recapFreq').value === 'monthly' ? 1 : 0));
  $('recapBtn').addEventListener('click', () => {
    $('recapForm').reset();
    clearInvalid($('recapForm'));
    const rc = fundsEstimate().recap;
    $('recapTo').value = rc && rc.to ? rc.to.split(',').join(', ') : '';
    $('recapOn').checked = rc ? rc.on || !rc.to : true;
    const freq = (rc && rc.freq) || 'weekly';
    $('recapFreq').value = freq;
    setupRecapDay(freq, rc && rc.day !== undefined ? rc.day : freq === 'monthly' ? 1 : 0);
    $('recapHour').value = String(rc && rc.hour !== undefined ? rc.hour : 18);
    $('recapTz').textContent = rc && rc.tz ? `In ${rc.tz} (the script's time zone). Google sends it some time within that hour.` : 'Google sends it some time within that hour.';
    recapDialog.showModal();
  });
  $('recapForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const action = e.submitter ? e.submitter.value : 'save';
    if (action === 'cancel') return recapDialog.close();
    const on = $('recapOn').checked || action === 'test';
    const to = $('recapTo').value.trim();
    if (on && !/@/.test(to)) return markInvalid($('recapTo'), 'Enter one or two email addresses.');
    const st = getState();
    if (st && st.version < 20) return showBanner(OUTDATED_MESSAGE, 'err', true);
    const plan = { freq: $('recapFreq').value, day: Number($('recapDay').value || 0), hour: Number($('recapHour').value) };
    recapDialog.close();
    try {
      const data = await call({ action: 'recap', on, to, test: action === 'test', ...plan });
      saveState(data);
      render();
      const old = (data.version || 0) < 26 && (plan.freq !== 'weekly' || plan.day !== 0 || plan.hour !== 18);
      if (action === 'test' && data.recapError) {
        showBanner(`Schedule saved, but the test email failed: ${data.recapError} In Apps Script, select weeklyRecap, click Run and approve the permissions, then try again.`, 'err', true);
      } else if (old) {
        showBanner('Saved, but the sheet\'s script is older than version 26, so it still sends weekly on Sunday evening. Paste the latest Code.gs and deploy a new version.', 'err', true);
      } else {
        const rc = (data.funds && data.funds.recap) || plan;
        showBanner(action === 'test' ? (data.recapSent ? `Saved ✓ Test email sent to ${to}. Check spam if it is not in the inbox.` : 'Saved ✓')
          : on ? `Email recap on ✓ ${recapWhen({ ...plan, ...rc })}` : 'Email recap off', 'ok');
      }
    } catch (err) {
      showBanner(err.kind === 'network' ? 'Needs a connection. Try again when online.' : err.message, 'err', true);
    }
  });

  // ---- Payday plan: after a salary is logged, suggest how to split it and log it in one tap.
  // It always leaves room for spending: at least 30% of the paycheck, or last month's spending per
  // paycheck, whichever is more.
  const paydayDialog = $('paydayDialog');
  let payday = null;
  function openPayday(income) {
    const f = fundsEstimate();
    const who = income.person;
    const salaries = (f.recent || []).concat(pendingOps().filter((op) => op.table === 'funds' && op.op === 'add').map((op) => op.entry))
      .filter((r) => r.kind === 'Income' && r.person === who && r.category === 'Salary' && String(r.date).slice(0, 7) === currentMonth())
      .filter((r, i, a) => a.findIndex((x) => x.id === r.id) === i).length;
    const checksLeft = salaries >= 2 ? 1 : 2; // usually two paychecks a month
    const last = f.history.filter((h) => h.month !== f.month).pop();
    const spendPerCheck = Math.max(0, (last ? last.spent[who] - last.loan[who] : 0) / 2);
    const floorKeep = Math.max(spendPerCheck, income.amount * 0.3);
    const loanSug = Math.round(Math.max(0, ((f.loanUsual || {})[who] || 0) - f.now.loan[who]) / checksLeft);
    const k401Sug = (f.k401Last || {})[who] || 0;
    let investSug = f.goal ? Math.max(0, (f.goal.need[who] - f.goal.thisMonth[who]) / checksLeft - k401Sug) : 0;
    investSug = Math.round(Math.max(0, Math.min(investSug, income.amount - loanSug - floorKeep)));
    payday = { who, income, floorKeep };
    $('paydayTitle').textContent = `${who}'s payday plan`;
    $('paydayIntro').textContent = `${money(income.amount)} came in. A split that keeps you on track` +
      (f.goal ? ` for ${usd0(f.goal.target)} by ${f.goal.deadlineLabel}` : '') + ' and leaves room to spend. Change the amounts, or Skip.';
    $('payInvest').value = investSug ? String(investSug) : '';
    $('payK401').value = k401Sug ? k401Sug.toFixed(2) : '';
    $('payWhere').value = who === 'K' ? 'India' : 'USA';
    const names = (f.loans || []).map((l) => l.name);
    $('loanNames').innerHTML = '';
    for (const nm of names) $('loanNames').appendChild(new Option(nm));
    const lastLoan = (f.loans || []).filter((l) => l[who] > 0).sort((a, b) => (a.last < b.last ? 1 : -1))[0];
    $('payLoanName').value = lastLoan ? lastLoan.name : names[0] || '';
    $('payLoan').value = loanSug ? String(loanSug) : '';
    updatePaydayKeep();
    paydayDialog.showModal();
  }
  function updatePaydayKeep() {
    if (!payday) return;
    const inv = parseAmount($('payInvest').value) || 0;
    const loan = parseAmount($('payLoan').value) || 0;
    const keep = round2(payday.income.amount - inv - loan);
    $('paydayKeep').textContent = `Leaves ${money(keep)} for spending and savings` + (payday.floorKeep ? ` (suggested at least ${money(payday.floorKeep)}).` : '.');
    $('paydayKeep').classList.toggle('warn', keep < payday.floorKeep - 0.5);
  }
  $('payInvest').addEventListener('input', updatePaydayKeep);
  $('payLoan').addEventListener('input', updatePaydayKeep);
  $('paydayForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (e.submitter && e.submitter.value === 'cancel') { paydayDialog.close(); payday = null; return; }
    const inv = $('payInvest').value.trim() === '' ? 0 : parseAmount($('payInvest').value);
    const loan = $('payLoan').value.trim() === '' ? 0 : parseAmount($('payLoan').value);
    const k401 = $('payK401').value.trim() === '' ? 0 : parseAmount($('payK401').value);
    const loanName = $('payLoanName').value.trim();
    if (k401 === null || k401 < 0) return $('payK401').classList.add('invalid');
    if (inv === null || inv < 0) return $('payInvest').classList.add('invalid');
    if (loan === null || loan < 0) return $('payLoan').classList.add('invalid');
    if (loan > 0 && !loanName) return $('payLoanName').classList.add('invalid');
    paydayDialog.close();
    const { who } = payday;
    const date = payday.income.date;
    const logged = [];
    if (k401 > 0) { enqueue({ op: 'add', table: 'funds', entry: { id: uuid(), date, kind: '401(K)', category: '401(K)', amount: k401, person: who, notes: 'Payday plan' } }); logged.push(`401(K) ${money(k401)}`); }
    if (inv > 0) { enqueue({ op: 'add', table: 'funds', entry: { id: uuid(), date, kind: 'Investment', category: $('payWhere').value, amount: inv, person: who, from: 'Income', notes: 'Payday plan' } }); logged.push(`invested ${money(inv)}`); }
    if (loan > 0) { enqueue({ op: 'add', table: 'funds', entry: { id: uuid(), date, kind: 'Loan payment', category: loanName, amount: loan, person: who, notes: 'Payday plan' } }); logged.push(`${money(loan)} to ${loanName}`); }
    payday = null;
    if (!logged.length) return;
    const status = await sync();
    report(status, `Logged ✓ ${logged.join(', ')}`);
  });

  // ---------- Settings
  const settingsDialog = $('settingsDialog');
  function openSettings() {
    const s = getSettings() || {};
    $('scriptUrl').value = s.url || '';
    $('secretKey').value = s.key || '';
    clearInvalid($('settingsForm'));
    if (!settingsDialog.open) settingsDialog.showModal();
  }
  $('settingsBtn').addEventListener('click', openSettings);

  $('settingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (e.submitter && e.submitter.value === 'cancel') return settingsDialog.close();
    const url = $('scriptUrl').value.trim();
    const key = $('secretKey').value;
    if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(url)) return markInvalid($('scriptUrl'), 'The URL should start with https://script.google.com and end with /exec.');
    if (!key) return markInvalid($('secretKey'), 'Enter the key.');
    settingsDialog.close();
    store.set('settings', { url, key });
    banner.hidden = true;
    const status = await sync();
    if (status === 'ok') showBanner('Connected ✓', 'ok');
    if (status === 'offline') showBanner('Saved. Could not reach the sheet right now.', 'warn');
  });

  // ---------- Start
  // Entries saved offline by the first version of the app.
  const legacy = store.get('pending', null);
  if (Array.isArray(legacy)) {
    setQueue([...getQueue(), ...legacy.map((entry) => ({ opId: uuid(), op: 'add', entry: { type: 'Joint', ...entry } }))]);
    store.remove('pending');
    store.remove('recent');
  }
  store.remove('categories');

  $('date').value = today();
  $('paidBy').value = store.get('paidBy', 'V');
  setView(view);

  if (!getSettings()) openSettings();
  else sync().then((s) => report(s, null));

  window.addEventListener('online', () => sync());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    // The app can stay open in the background for days; keep the date on today if nothing is typed yet.
    if (!$('category').value && !$('amount').value) $('date').value = today();
    if (view === 'Funds' || view === 'Home') render(); // a new month moves this month's savings forward
    if (getSettings()) sync();
    if (swReg) swReg.update().catch(() => {});
  });

  // Updates: check for a new version on every open, and reload once when it takes over,
  // so a home-screen app that stays open in the background still picks up new files.
  let swReg = null;
  $('appVersion').textContent = `Sirikh app v${APP_VERSION}`;
  if ('serviceWorker' in navigator) {
    const hadController = !!navigator.serviceWorker.controller;
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController && !reloading) { reloading = true; location.reload(); }
    });
    navigator.serviceWorker.register('sw.js').then((reg) => { swReg = reg; reg.update().catch(() => {}); }).catch(() => {});
  }
})();
