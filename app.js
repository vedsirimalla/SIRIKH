(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const APP_VERSION = 17; // shown at the bottom of the app; matches the cache name in sw.js
  // Fixed bills are picked from this list (no typing); each has its own orange, same as the sheet.
  const FIXED_CATEGORIES = ['Rent', 'Utilities', 'Electricity', 'Wi-Fi', 'Misc'];
  const TYPE_LABELS = { 'Joint': 'Joint', 'Fixed': 'Fixed', 'Personal': 'Personal', 'Car': 'Sonata', 'Add funds': 'Funds added', 'Set balance': 'Budget set', 'Personal budget': 'Budget set' };
  const TYPE_HINTS = {
    Joint: 'Joint: shared day-to-day spending. Comes out of the monthly budget and counts in who owes whom.',
    Fixed: 'Fixed: a monthly bill. Pick Rent, Utilities, Electricity, Wi-Fi or Misc. Not taken from the monthly budget; tracked under Fixed bills.',
    Personal: "Personal: one person's own expense, not in the budget. If it goes on the other person's card, they are owed the full amount.",
    Car: "Sonata: car costs and fuel, saved to the Sonata tab. Expense for: whose turn it is (V or K), or Joint to split 50/50.",
  };

  // Matches the row colors in the sheet: Personal blues and Fixed oranges, lighter for V, darker for K.
  function colorClass(r) {
    if (r.type === 'Personal') return (r.expenseFor || r.paidBy) === 'K' ? 'c-personal-k' : 'c-personal-v';
    if (r.type === 'Fixed') return r.paidBy === 'K' ? 'c-fixed-k' : 'c-fixed-v';
    return '';
  }

  // Older copies of Code.gs save unknown types as Joint, so Fixed bills wait on the phone until
  // the sheet's script is redeployed with at least this version.
  // Fixed bills need version 7 (older scripts save them as Joint). Sonata entries and Personal
  // expenses need version 9, which stores whose expense it is separately from whose card paid.
  const requiredVersion = (op) => {
    if (op.table === 'car') return op.op === 'add' ? 15 : 9;
    if (op.op !== 'add') return 0;
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

  // Sonata: own turns owe nothing, Joint splits 50/50, a turn on the other's card is owed in full.
  function carOwed(owner, card, amount) {
    if (owner === 'Joint') return card === 'V' ? amount / 2 : card === 'K' ? -amount / 2 : 0;
    return owedInFull(owner, card, amount);
  }

  // Starts from what the sheet last reported and applies changes not synced yet,
  // so the budget and the split update the moment an expense is saved, even offline.
  function estimate() {
    const state = getState();
    const recent = state ? state.recent || [] : [];
    const p = { since: '', start: 0, added: 0, spent: 0, v: 0, k: 0, fixed: 0, fv: 0, fk: 0, personal: 0, kOnK: 0, kOnV: 0, vOnV: 0, vOnK: 0, ...(state && state.period) };
    let balance = state ? Number(state.balance) || 0 : 0;
    let hasBalance = state ? !!state.hasBalance : false;

    const apply = (e, sign) => {
      const amt = sign * e.amount;
      if (e.type === 'Add funds') { balance += amt; p.added += amt; }
      if (e.type === 'Joint') {
        balance -= amt;
        p.spent += amt;
        if (e.paidBy === 'V') p.v += amt;
        if (e.paidBy === 'K') p.k += amt;
      }
      if (e.type === 'Fixed') {
        p.fixed += amt;
        if (e.paidBy === 'V') p.fv += amt;
        if (e.paidBy === 'K') p.fk += amt;
      }
      if (e.type === 'Personal') {
        const owner = e.expenseFor || e.paidBy;
        p.personal += owedInFull(owner, e.paidBy, amt);
        const key = { KK: 'kOnK', KV: 'kOnV', VV: 'vOnV', VK: 'vOnK' }[owner + e.paidBy];
        if (key) p[key] += amt;
      }
    };

    const queue = getQueue();
    for (const op of queue) {
      if (op.op === 'add' && op.entry.type === 'Set balance') {
        balance = op.entry.amount;
        hasBalance = true;
        Object.assign(p, { since: op.entry.date, start: op.entry.amount, added: 0, spent: 0, v: 0, k: 0, fixed: 0, fv: 0, fk: 0, personal: 0, kOnK: 0, kOnV: 0, vOnV: 0, vOnK: 0 });
      } else if (op.op === 'add' && op.table !== 'car') {
        apply(op.entry, 1);
      } else {
        const e = recent.find((r) => r.id === op.id);
        if (e) apply(e, -1);
      }
    }
    for (const k of ['start', 'added', 'spent', 'v', 'k', 'fixed', 'fv', 'fk', 'personal', 'kOnK', 'kOnV', 'vOnV', 'vOnK']) p[k] = round2(p[k] || 0);
    return { balance: round2(balance), hasBalance, unsynced: queue.length, period: p };
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

    const fSplit = round2(p.fixed / 2);
    const fvShare = round2(p.fv - fSplit);
    const fkShare = round2(p.fk - fSplit);
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
    if (!hasFixed) return;
    $('fixedV').textContent = money(p.fv);
    $('fixedK').textContent = money(p.fk);
    $('fixedTotal').textContent = money(p.fixed);
    $('fixedSettle').textContent = settleText(fvShare, fkShare);
  }

  function settleText(vShare, kShare) {
    if (vShare <= -0.01) return `V owes K ${money(-vShare)}`;
    if (kShare <= -0.01) return `K owes V ${money(-kShare)}`;
    return 'V and K are even';
  }

  const isCarMode = () => selectedType() === 'Car';

  function renderRecent() {
    const state = getState();
    const isCar = isCarMode();
    const queue = getQueue().filter((op) => (op.table === 'car') === isCar);
    const deleting = new Set(queue.filter((op) => op.op === 'delete').map((op) => op.id));
    const pending = queue.filter((op) => op.op === 'add').map((op) => ({ ...op.entry, pending: true })).reverse();
    const source = state ? (isCar ? (state.car && state.car.recent) || [] : state.recent || []) : [];
    const saved = source.filter((r) => !deleting.has(r.id));
    const rows = [...pending, ...saved];

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
      li.className = [isCar ? 'c-car' : colorClass(r), r.pending ? 'pending' : ''].filter(Boolean).join(' ');

      const body = document.createElement('div');
      body.className = 'body';
      const top = document.createElement('div');
      top.className = 'top';
      const name = document.createElement('span');
      name.textContent = isCar ? r.vendor || r.category : r.category;
      const amt = document.createElement('span');
      amt.textContent = (r.type === 'Add funds' ? '+' : '') + money(r.amount);
      top.append(name, amt);

      const sub = document.createElement('div');
      sub.className = 'sub';
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = isCar ? r.category : TYPE_LABELS[r.type] || r.type || 'Joint';
      const owner = r.expenseFor && r.expenseFor !== 'Both' ? r.expenseFor : '';
      const parts = [prettyDate(r.date)];
      if (isCar && r.expenseFor === 'Joint') parts.push('Joint');
      else if (owner && (r.type === 'Personal' || (isCar && owner !== r.paidBy))) parts.push(`for ${owner}`);
      if (r.paidBy === 'V' || r.paidBy === 'K') parts.push(`${r.paidBy}'s card`);
      else if (r.paidBy) parts.push(`by ${r.paidBy}`);
      if (isCar && r.category === 'Fuel') {
        if (r.fill === 'Partial') parts.push('partial');
        if (r.missedBefore) parts.push('after missed fill-up');
        if (r.miles !== undefined && r.miles !== '') parts.push(`${num(r.miles)} mi`);
        if (r.mpg !== undefined && r.mpg !== '') parts.push(`${Number(r.mpg).toFixed(1)} MPG`);
        if (r.gallons !== undefined && r.gallons !== '') parts.push(`${r.gallons} gal`);
      }
      parts.push(r.notes);
      if (!isCar && r.balance !== undefined && r.balance !== '') parts.push('Bal ' + money(r.balance));
      sub.append(tag, document.createTextNode(parts.filter(Boolean).join(' · ')));
      body.append(top, sub);
      li.appendChild(body);

      if (r.id) {
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'del';
        del.setAttribute('aria-label', `Delete ${r.category}`);
        del.textContent = '×';
        del.addEventListener('click', () => removeEntry(r, isCar));
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
    const type = selectedType();
    const isCar = type === 'Car';
    $('mainDash').hidden = isCar;
    $('carDash').hidden = !isCar;
    renderBalance();
    renderPersonalBudgets();
    $('jointCard').hidden = type !== 'Joint';
    $('personalBudgetCard').hidden = type !== 'Personal';
    const hasBalance = estimate().hasBalance;
    $('splitCard').hidden = !hasBalance || type === 'Personal';
    $('personalSplitCard').hidden = !hasBalance || type !== 'Personal';
    if (type === 'Fixed') $('fixedCard').hidden = false;
    if (type === 'Personal') $('fixedCard').hidden = true;
    if (isCar) renderCar();
    renderRecent();
  }

  // ---------- Personal budgets
  // What the sheet reported, plus changes not synced yet.
  function estimatePersonal() {
    const st = getState();
    const recent = st ? st.recent || [] : [];
    const pb = { V: null, K: null };
    for (const who of ['V', 'K']) {
      const b = st && st.personalBudgets && st.personalBudgets[who];
      if (b) pb[who] = { month: b.month || String(b.since).slice(0, 7), since: b.since, budget: b.budget, spent: b.spent };
    }
    // A personal budget covers a calendar month: every Personal expense for that person dated in
    // that month counts, whoever's card paid, even one logged before the budget was set.
    const inMonth = (b, date) => b && String(date).slice(0, 7) === b.month;
    for (const op of getQueue()) {
      if (op.table === 'car') continue;
      if (op.op === 'add' && op.entry.type === 'Personal budget') {
        const month = op.entry.date.slice(0, 7);
        const prev = pb[op.entry.expenseFor];
        pb[op.entry.expenseFor] = { month, since: month + '-01', budget: op.entry.amount, spent: prev && prev.month === month ? prev.spent : 0 };
      } else if (op.op === 'add' && op.entry.type === 'Personal') {
        const b = pb[op.entry.expenseFor || op.entry.paidBy];
        if (inMonth(b, op.entry.date)) b.spent += op.entry.amount;
      } else if (op.op === 'delete') {
        const e = recent.find((r) => r.id === op.id && r.type === 'Personal');
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
    const turns = { V: 0, K: 0, Joint: 0, ...((c && c.turns) || {}) };
    for (const op of getQueue()) {
      if (op.table !== 'car' || op.op !== 'add') continue;
      const e = op.entry;
      if (e.paidBy === 'V') v += e.amount;
      if (e.paidBy === 'K') k += e.amount;
      const owner = e.expenseFor || e.paidBy;
      owed += carOwed(owner, e.paidBy, e.amount);
      if (e.category === 'Fuel' && turns[owner] !== undefined) turns[owner]++;
    }
    owed = round2(owed);
    $('carPaidV').textContent = money(round2(v));
    $('carPaidK').textContent = money(round2(k));
    $('carPaidTotal').textContent = money(round2(v + k));
    $('carSettle').textContent = Math.abs(owed) < 0.01 ? 'Nothing owed for the car' : settleText(owed, -owed);
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
        body: JSON.stringify({ ...payload, key: s.key }),
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
      version: data.version || 0,
      car: data.car || null,
      personalBudgets: data.personalBudgets || null,
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
          const data = await call(op.op === 'add'
            ? { action: 'add', table: op.table, entry: op.entry }
            : { action: 'delete', table: op.table, id: op.id });
          saveState(data);
          sent = true;
        } catch (err) {
          if (err.kind !== 'server') throw err;
          // The sheet refused this change (bad data); drop it so it does not block the rest.
          rejected = true;
          const what = op.op === 'add' ? `${op.entry.category} ${money(op.entry.amount)}` : 'delete';
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

  // Shows the description for the selected type, and swaps the Category typing field
  // for the fixed bill buttons when Fixed is selected.
  function updateTypeHint() {
    const type = selectedType();
    $('typeHint').textContent = TYPE_HINTS[type];
    const fixed = type === 'Fixed';
    const car = type === 'Car';
    $('category').hidden = fixed;
    $('fixedPicker').hidden = !fixed;
    $('categoryField').hidden = car;
    $('carFields').hidden = !car;
    $('categoryLabel').textContent = fixed ? 'Fixed bill' : 'Category';
    $('saveBtn').textContent = car ? 'Save car expense' : 'Save expense';
    setupExpenseFor(type);
    updateCarFields();
    render();
  }

  // Whose expense it is: only asked for Personal (V or K).
  const FOR_OPTIONS = {
    Personal: [['V', 'V'], ['K', 'K']],
    Car: [['V', 'V'], ['K', 'K'], ['Joint', 'Joint']],
  };
  function setupExpenseFor(type) {
    const options = FOR_OPTIONS[type];
    $('forField').hidden = !options;
    $('payGrid').classList.toggle('grid2', !!options);
    if (options) {
      const select = $('expenseFor');
      // Sonata starts on the card owner's own turn; Personal remembers the last choice.
      const keep = type === 'Car' ? $('paidBy').value : store.get('for.' + type, options[0][0]);
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

  function selectedFor() {
    return $('forField').hidden ? '' : $('expenseFor').value;
  }

  // "K owes V the full $20.00" when one person's expense goes on the other's card.
  function updateOwedHint() {
    const owner = selectedFor();
    const card = $('paidBy').value;
    const hint = $('owedHint');
    const amount = parseAmount($('amount').value);
    if (owner === 'Joint') {
      const other = card === 'V' ? 'K' : 'V';
      hint.textContent = `Joint, split 50/50: ${other} owes ${card} half` + (amount ? ` (${money(amount / 2)}).` : '.');
      hint.hidden = false;
      return;
    }
    if ((owner !== 'V' && owner !== 'K') || owner === card) { hint.hidden = true; return; }
    hint.textContent = `${owner}'s expense on ${card}'s card: ${owner} owes ${card} the full ` +
      (amount ? money(amount) : 'amount') + '.';
    hint.hidden = false;
  }
  $('expenseFor').addEventListener('change', () => {
    store.set('for.' + selectedType(), $('expenseFor').value);
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

  function selectedCarCat() {
    const checked = document.querySelector('input[name="carCat"]:checked');
    return checked ? checked.value : 'Fuel';
  }

  // Fuel shows odometer, range, gallons and price; other car categories just need a vendor and amount.
  let amountTyped = false;
  function updateCarFields() {
    const fuel = selectedCarCat() === 'Fuel';
    $('fuelFields').hidden = !fuel;
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
  $('fixedPicker').addEventListener('change', () => $('fixedPicker').classList.remove('invalid'));

  function clearInvalid(form) {
    form.querySelectorAll('.invalid').forEach((el) => el.classList.remove('invalid'));
  }

  function markInvalid(input, message) {
    input.classList.add('invalid');
    input.focus();
    showBanner(message, 'err');
  }
  for (const id of ['date', 'category', 'amount', 'odometer', 'fundsAmount', 'fundsDate', 'pbAmountV', 'pbAmountK', 'pbDate', 'scriptUrl', 'secretKey']) {
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
    if (fuel && odometer !== '' && last && odometer <= last) {
      return markInvalid($('odometer'), `Odometer should be above the last fill-up (${num(last)} mi).`);
    }
    let amount = parseAmount($('amount').value);
    if ((amount === null || amount === 0) && gallons && ppg) amount = round2(gallons * ppg);
    if (amount === null || amount === 0) return markInvalid($('amount'), 'Enter the amount.');
    const partial = fuel && $('fillPartial').checked;
    const missedBefore = fuel && $('missedBefore').checked;
    const open = openStretch();
    let tankMpg = 0;
    if (fuel && !partial && !missedBefore && open && open.known && odometer !== '' && gallons) {
      tankMpg = (odometer - open.startOdo) / (open.gallons + gallons);
    }
    const entry = {
      id: uuid(), date, category, vendor: $('vendor').value.trim(), amount, paidBy: $('paidBy').value,
      notes: $('notes').value.trim(), odometer, rangeLeft, gallons, pricePerGallon: ppg,
      expenseFor: selectedFor() || $('paidBy').value,
      fill: fuel ? (partial ? 'Partial' : 'Full') : '',
      missedBefore,
    };
    enqueue({ op: 'add', table: 'car', entry });
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
    report(status, `Saved ✓ ${category} ${money(amount)}` +
      (partial ? ' · partial, MPG comes with the next full fill' : tankMpg > 0 ? ` · ${tankMpg.toFixed(1)} MPG` : '') +
      (owes ? ` · ${owes > 0 ? 'K owes V' : 'V owes K'} ${money(Math.abs(owes))}` : ''));
  }

  $('expenseForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const date = $('date').value;
    const type = selectedType();
    if (type === 'Car') {
      if (!date) return markInvalid($('date'), 'Pick a date.');
      return saveCar(date);
    }
    const category = type === 'Fixed' ? selectedFixed() : $('category').value.trim();
    const amount = parseAmount($('amount').value);
    if (!date) return markInvalid($('date'), 'Pick a date.');
    if (!category && type === 'Fixed') {
      $('fixedPicker').classList.add('invalid');
      return showBanner('Pick which fixed bill this is.', 'err');
    }
    if (!category) return markInvalid($('category'), 'Enter where you spent it.');
    if (amount === null || amount === 0) return markInvalid($('amount'), 'Enter a valid amount.');

    const entry = {
      id: uuid(),
      date,
      category,
      amount,
      paidBy: $('paidBy').value,
      notes: $('notes').value.trim(),
      type,
      expenseFor: type === 'Personal' ? selectedFor() : '',
    };
    enqueue({ op: 'add', entry });
    store.set('paidBy', entry.paidBy);

    $('expenseForm').reset();
    clearInvalid($('expenseForm'));
    amountTyped = false;
    $('date').value = today();
    $('paidBy').value = entry.paidBy;
    updateTypeHint();

    $('saveBtn').disabled = true;
    const status = await sync();
    $('saveBtn').disabled = false;
    const left = estimate();
    const owes = owedInFull(entry.expenseFor, entry.paidBy, amount);
    const pb = entry.type === 'Personal' ? estimatePersonal()[entry.expenseFor] : null;
    report(status, `Saved ✓ ${category} ${money(amount)}` +
      (entry.type === 'Fixed' ? ' · Fixed bill' : '') +
      (pb ? ` · ${entry.expenseFor} personal: ${pb.remaining < 0 ? money(-pb.remaining) + ' over' : money(pb.remaining) + ' left'}` : '') +
      (owes ? ` · ${owes > 0 ? 'K owes V' : 'V owes K'} ${money(Math.abs(owes))}` : '') +
      (entry.type === 'Joint' && left.hasBalance
        ? left.balance < 0 ? ` · ${money(-left.balance)} over budget` : ` · ${money(left.balance)} left`
        : ''));
  });

  // ---------- Delete from Recent
  async function removeEntry(item, isCar) {
    const name = isCar ? item.vendor || item.category : item.category;
    if (!confirm(`Delete "${name}" ${money(item.amount)} from ${prettyDate(item.date)}?`)) return;
    const queue = getQueue();
    const queued = queue.find((op) => op.op === 'add' && op.entry.id === item.id);
    if (queued) {
      // Not sent yet: just drop it from this phone.
      setQueue(queue.filter((op) => op !== queued));
      render();
      showBanner('Removed.', 'ok');
      return;
    }
    enqueue(isCar ? { op: 'delete', table: 'car', id: item.id } : { op: 'delete', id: item.id });
    const status = await sync();
    if (status === 'ok') showBanner('Deleted ✓', 'ok');
    if (status === 'offline') showBanner('Will delete when you are back online.', 'warn');
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
  updateTypeHint();
  render();

  if (!getSettings()) openSettings();
  else sync().then((s) => report(s, null));

  window.addEventListener('online', () => sync());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    // The app can stay open in the background for days; keep the date on today if nothing is typed yet.
    if (!$('category').value && !$('amount').value) $('date').value = today();
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
