(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  // Fixed bills are picked from this list (no typing); each has its own orange, same as the sheet.
  const FIXED_CATEGORIES = ['Rent', 'Utilities', 'Electricity', 'Wi-Fi', 'Misc'];
  const TYPE_LABELS = { 'Joint': 'Joint', 'Fixed': 'Fixed', 'Personal': 'Personal', 'Car': 'Sonata', 'Add funds': 'Funds added', 'Set balance': 'Budget set' };
  const TYPE_HINTS = {
    Joint: 'Joint: shared day-to-day spending. Comes out of the monthly budget and counts in who owes whom.',
    Fixed: 'Fixed: a monthly bill. Pick Rent, Utilities, Electricity, Wi-Fi or Misc. Not taken from the monthly budget; tracked under Fixed bills.',
    Personal: 'Personal: only for the person who paid. Not in the budget or who owes whom.',
    Car: 'Sonata: car costs and fuel, saved to the Sonata tab. Has its own split; not in the monthly budget.',
  };

  // Matches the row colors in the sheet: Personal blues and Fixed oranges, lighter for V, darker for K.
  function colorClass(r) {
    if (r.type === 'Personal') return r.paidBy === 'K' ? 'c-personal-k' : 'c-personal-v';
    if (r.type === 'Fixed') return r.paidBy === 'K' ? 'c-fixed-k' : 'c-fixed-v';
    return '';
  }

  // Older copies of Code.gs save unknown types as Joint, so Fixed bills wait on the phone until
  // the sheet's script is redeployed with at least this version.
  // Fixed bills need version 7 (older scripts save them as Joint); Sonata entries need version 8.
  const requiredVersion = (op) => (op.table === 'car' ? 8 : op.op === 'add' && op.entry.type === 'Fixed' ? 7 : 0);
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

  // Starts from what the sheet last reported and applies changes not synced yet,
  // so the budget and the split update the moment an expense is saved, even offline.
  function estimate() {
    const state = getState();
    const recent = state ? state.recent || [] : [];
    const p = { since: '', start: 0, added: 0, spent: 0, v: 0, k: 0, fixed: 0, fv: 0, fk: 0, ...(state && state.period) };
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
    };

    const queue = getQueue();
    for (const op of queue) {
      if (op.op === 'add' && op.entry.type === 'Set balance') {
        balance = op.entry.amount;
        hasBalance = true;
        Object.assign(p, { since: op.entry.date, start: op.entry.amount, added: 0, spent: 0, v: 0, k: 0, fixed: 0, fv: 0, fk: 0 });
      } else if (op.op === 'add' && op.table !== 'car') {
        apply(op.entry, 1);
      } else {
        const e = recent.find((r) => r.id === op.id);
        if (e) apply(e, -1);
      }
    }
    for (const k of ['start', 'added', 'spent', 'v', 'k', 'fixed', 'fv', 'fk']) p[k] = round2(p[k]);
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
    $('fixedCard').hidden = !hasFixed;
    $('overallLine').hidden = !hasFixed;
    if (!hasFixed) return;
    $('fixedV').textContent = money(p.fv);
    $('fixedK').textContent = money(p.fk);
    $('fixedTotal').textContent = money(p.fixed);
    $('fixedSettle').textContent = settleText(fvShare, fkShare);
    $('overallLine').textContent = 'Including fixed bills: ' + settleText(round2(vShare + fvShare), round2(kShare + fkShare));
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
      const parts = [prettyDate(r.date), r.paidBy ? 'by ' + r.paidBy : ''];
      if (isCar && r.category === 'Fuel') {
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

  function render() {
    const isCar = isCarMode();
    $('mainDash').hidden = isCar;
    $('carDash').hidden = !isCar;
    renderBalance();
    if (isCar) renderCar();
    renderRecent();
  }

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

  function renderCar() {
    const st = getState();
    const c = (st && st.car) || null;
    const dash = (v, f) => (c && v ? f(v) : '—');
    $('carMpg').textContent = dash(c && c.mpg, (v) => Number(v).toFixed(1));
    $('carPpg').textContent = dash(c && c.avgPpg, per);
    $('carFuelCpm').textContent = dash(c && c.fuelCpm, per);
    $('carTotalCpm').textContent = dash(c && c.totalCpm, per);
    $('carMiles').textContent = dash(c && c.milesTracked, (v) => num(v));
    $('carPerTank').textContent = dash(c && c.avgMilesPerTank, (v) => num(v));
    $('carEff').textContent = dash(c && c.avgEffRange, (v) => num(v));
    const lf = c && c.lastFill;
    $('carLastFill').textContent = lf
      ? `Last fill-up ${prettyDate(lf.date)} at ${num(lf.odometer)} mi` +
        (lf.miles !== '' ? `: ${num(lf.miles)} mi, ` : '') +
        (lf.mpg !== '' ? `${Number(lf.mpg).toFixed(1)} MPG` : '') +
        (lf.eff !== '' ? `, effective range ${num(lf.eff)} mi` : '') +
        (c.fills ? `. ${c.fills} fill-ups, ${money(c.fuelSpend)} on fuel.` : '')
      : 'No fill-ups yet. Pick Fuel below to log one.';

    // Split: what the sheet reported plus car entries not synced yet.
    let v = c ? c.v : 0;
    let k = c ? c.k : 0;
    for (const op of getQueue()) {
      if (op.table !== 'car' || op.op !== 'add') continue;
      if (op.entry.paidBy === 'V') v += op.entry.amount;
      if (op.entry.paidBy === 'K') k += op.entry.amount;
    }
    v = round2(v);
    k = round2(k);
    const total = round2(v + k);
    const split = round2(total / 2);
    const vShare = round2(v - split);
    const kShare = round2(k - split);
    $('carPaidV').textContent = money(v);
    $('carPaidK').textContent = money(k);
    $('carPaidTotal').textContent = money(total);
    $('carEqualSplit').textContent = money(split);
    for (const [id, n] of [['carShareV', vShare], ['carShareK', kShare]]) {
      $(id).textContent = signed(n);
      $(id).className = n >= 0.01 ? 'pos' : n <= -0.01 ? 'neg' : '';
    }
    $('carOwedV').textContent = money(vShare < 0 ? -vShare : 0);
    $('carOwedK').textContent = money(kShare < 0 ? -kShare : 0);
    $('carSettle').textContent = settleText(vShare, kShare);

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
    const series = (c && c.series) || [];
    const monthly = (c && c.monthly) || [];
    if (series.length < 2 && monthly.length < 1) {
      charts.textContent = 'Charts appear after two fill-ups with odometer and gallons.';
      charts.className = 'muted';
      return;
    }
    charts.className = 'charts';
    if (series.length >= 2) {
      charts.appendChild(lineChart('MPG per fill-up', series.map((p) => ({ x: p.date, y: p.mpg })), (y) => y.toFixed(1)));
      charts.appendChild(lineChart('Price per gallon', series.filter((p) => p.ppg).map((p) => ({ x: p.date, y: p.ppg })), (y) => '$' + y.toFixed(2)));
      charts.appendChild(lineChart('Fuel cost per mile', series.filter((p) => p.cpm).map((p) => ({ x: p.date, y: p.cpm })), (y) => '$' + y.toFixed(3)));
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
    updateCarFields();
    if (car !== !$('carDash').hidden) render();
  }

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
    if (!amountTyped && gal && price) $('amount').value = (Math.round(gal * price * 100) / 100).toFixed(2);
    const odo = parseAmount($('odometer').value);
    const range = parseAmount($('rangeLeft').value);
    const last = lastOdometer();
    const parts = [];
    if (odo && last && odo > last) {
      const miles = round2(odo - last);
      parts.push(`${num(miles)} mi since last fill-up`);
      if (gal) parts.push(`${(miles / gal).toFixed(1)} MPG`);
      if (range !== null) parts.push(`effective range ${num(miles + range)} mi`);
      const amt = parseAmount($('amount').value);
      if (amt) parts.push(`${per(amt / miles)}/mi`);
    } else if (odo && last && odo <= last) {
      parts.push(`Odometer should be above the last fill-up (${num(last)} mi).`);
    } else if (last) {
      parts.push(`Last fill-up odometer: ${num(last)} mi.`);
    }
    preview.textContent = parts.join(' · ');
    preview.hidden = !parts.length;
  }
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
  for (const id of ['date', 'category', 'amount', 'odometer', 'fundsAmount', 'fundsDate', 'scriptUrl', 'secretKey']) {
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
    const last = lastOdometer();
    if (fuel && odometer !== '' && last && odometer <= last) {
      return markInvalid($('odometer'), `Odometer should be above the last fill-up (${num(last)} mi).`);
    }
    let amount = parseAmount($('amount').value);
    if ((amount === null || amount === 0) && gallons && ppg) amount = round2(gallons * ppg);
    if (amount === null || amount === 0) return markInvalid($('amount'), 'Enter the amount.');
    const miles = fuel && odometer !== '' && last ? round2(odometer - last) : 0;
    const entry = {
      id: uuid(), date, category, vendor: $('vendor').value.trim(), amount, paidBy: $('paidBy').value,
      notes: $('notes').value.trim(), odometer, rangeLeft, gallons, pricePerGallon: ppg,
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
    report(status, `Saved ✓ ${category} ${money(amount)}` +
      (miles > 0 && gallons ? ` · ${(miles / gallons).toFixed(1)} MPG` : ''));
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
    report(status, `Saved ✓ ${category} ${money(amount)}` +
      (entry.type === 'Fixed' ? ' · Fixed bill' : '') +
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
  });

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
