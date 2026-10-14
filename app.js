(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const DEFAULT_CATEGORIES = [
    'Costco', 'Walmart', 'Harris Teeter', "Trader Joe's", 'Target', 'Shell',
    'Indian Store', 'Whole Foods', 'Amazon', 'Taco Bell', 'Subway', 'Dollar Tree',
  ];
  const TYPE_LABELS = { 'Joint': 'Joint', 'Personal': 'Personal', 'Add funds': 'Funds added', 'Set balance': 'Balance set' };

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

  // ---------- Categories: defaults plus what this phone has typed before, most used first
  function renderCategories() {
    const counts = store.get('categories', {});
    const names = new Set([...Object.keys(counts).sort((a, b) => counts[b] - counts[a]), ...DEFAULT_CATEGORIES]);
    const list = $('categoryList');
    list.innerHTML = '';
    for (const name of names) {
      const opt = document.createElement('option');
      opt.value = name;
      list.appendChild(opt);
    }
  }

  function learnCategory(name) {
    const counts = store.get('categories', {});
    const key = Object.keys(counts).find((k) => k.toLowerCase() === name.toLowerCase()) || name;
    counts[key] = (counts[key] || 0) + 1;
    store.set('categories', counts);
    renderCategories();
  }

  // ---------- Rendering
  // Starts from the last balance the sheet reported and applies changes not synced yet.
  function estimate() {
    const state = getState();
    const recent = state ? state.recent || [] : [];
    let balance = state ? Number(state.balance) || 0 : 0;
    let hasBalance = state ? !!state.hasBalance : false;
    let unsynced = 0;
    for (const op of getQueue()) {
      unsynced++;
      if (op.op === 'add') {
        const e = op.entry;
        if (e.type === 'Set balance') { balance = e.amount; hasBalance = true; }
        else if (e.type === 'Add funds') balance += e.amount;
        else if (e.type === 'Joint') balance -= e.amount;
      } else {
        const e = recent.find((r) => r.id === op.id);
        if (e && e.type === 'Joint') balance += e.amount;
        if (e && e.type === 'Add funds') balance -= e.amount;
      }
    }
    return { balance: round2(balance), hasBalance, unsynced };
  }

  function renderBalance() {
    const state = getState();
    const { balance, hasBalance, unsynced } = estimate();
    const el = $('balanceAmount');
    el.textContent = hasBalance || balance !== 0 ? money(balance) : '—';
    el.classList.toggle('neg', balance < 0);

    const notes = [];
    if (!hasBalance) notes.push('Tap “Set balance” to start tracking.');
    if (unsynced) notes.push(`Includes ${unsynced} change${unsynced > 1 ? 's' : ''} not synced yet.`);
    const syncedAt = store.get('syncedAt', null);
    if (syncedAt && !unsynced) {
      notes.push('Updated ' + new Date(syncedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }));
    }
    $('balanceNote').textContent = notes.join(' ');

    const p = state && state.hasBalance ? state.period : null;
    $('periodSummary').hidden = !p;
    if (!p) return;
    const added = p.added ? ` + ${money(p.added)} added` : '';
    $('periodLine1').textContent = `Since ${prettyDate(p.since)}: ${money(p.start)} start${added}`;
    $('periodLine2').textContent = `Joint spent ${money(p.spent)} · V paid ${money(p.v)} · K paid ${money(p.k)}`;
    const diff = round2((p.v - p.k) / 2); // what one owes the other for an even split
    $('settleLine').textContent =
      Math.abs(diff) < 0.01 ? 'V and K are even' : diff > 0 ? `K owes V ${money(diff)}` : `V owes K ${money(-diff)}`;
  }

  function renderRecent() {
    const state = getState();
    const queue = getQueue();
    const deleting = new Set(queue.filter((op) => op.op === 'delete').map((op) => op.id));
    const pending = queue.filter((op) => op.op === 'add').map((op) => ({ ...op.entry, pending: true })).reverse();
    const saved = (state ? state.recent || [] : []).filter((r) => !deleting.has(r.id));
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
      if (r.pending) li.className = 'pending';

      const body = document.createElement('div');
      body.className = 'body';
      const top = document.createElement('div');
      top.className = 'top';
      const name = document.createElement('span');
      name.textContent = r.category;
      const amt = document.createElement('span');
      amt.textContent = (r.type === 'Add funds' ? '+' : '') + money(r.amount);
      top.append(name, amt);

      const sub = document.createElement('div');
      sub.className = 'sub';
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = TYPE_LABELS[r.type] || r.type || 'Joint';
      const parts = [prettyDate(r.date), r.paidBy ? 'by ' + r.paidBy : '', r.notes];
      if (r.balance !== undefined && r.balance !== '') parts.push('Bal ' + money(r.balance));
      sub.append(tag, document.createTextNode(parts.filter(Boolean).join(' · ')));
      body.append(top, sub);
      li.appendChild(body);

      if (r.id) {
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'del';
        del.setAttribute('aria-label', `Delete ${r.category}`);
        del.textContent = '×';
        del.addEventListener('click', () => removeEntry(r));
        li.appendChild(del);
      }
      list.appendChild(li);
    }

    const n = queue.length;
    $('syncNote').textContent = n ? `${n} waiting to sync` : '';
  }

  function render() {
    renderBalance();
    renderRecent();
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
    });
    store.set('syncedAt', Date.now());
  }

  // Sends queued changes in order, then refreshes. Returns 'ok', 'rejected', 'offline', 'config' or 'setup'.
  let syncing = null;
  function sync() {
    if (!syncing) syncing = runSync().finally(() => { syncing = null; });
    return syncing;
  }

  async function runSync() {
    let rejected = false;
    try {
      let sent = false;
      for (let op = getQueue()[0]; op; op = getQueue()[0]) {
        try {
          const data = await call(op.op === 'add' ? { action: 'add', entry: op.entry } : { action: 'delete', id: op.id });
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
    return $('typePersonal').checked ? 'Personal' : 'Joint';
  }

  function updateTypeHint() {
    $('typeHint').textContent = selectedType() === 'Joint'
      ? 'Joint expenses come out of the main balance.'
      : 'Personal expenses are logged but do not change the balance.';
  }
  $('typeJoint').addEventListener('change', updateTypeHint);
  $('typePersonal').addEventListener('change', updateTypeHint);

  function clearInvalid(form) {
    form.querySelectorAll('.invalid').forEach((el) => el.classList.remove('invalid'));
  }

  function markInvalid(input, message) {
    input.classList.add('invalid');
    input.focus();
    showBanner(message, 'err');
  }
  for (const id of ['date', 'category', 'amount', 'fundsAmount', 'fundsDate', 'scriptUrl', 'secretKey']) {
    $(id).addEventListener('input', () => $(id).classList.remove('invalid'));
  }

  $('expenseForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const date = $('date').value;
    const category = $('category').value.trim();
    const amount = parseAmount($('amount').value);
    if (!date) return markInvalid($('date'), 'Pick a date.');
    if (!category) return markInvalid($('category'), 'Enter where you spent it.');
    if (amount === null || amount === 0) return markInvalid($('amount'), 'Enter a valid amount.');

    const entry = {
      id: uuid(),
      date,
      category,
      amount,
      paidBy: $('paidBy').value,
      notes: $('notes').value.trim(),
      type: selectedType(),
    };
    enqueue({ op: 'add', entry });
    store.set('paidBy', entry.paidBy);
    learnCategory(category);

    $('expenseForm').reset();
    clearInvalid($('expenseForm'));
    $('date').value = today();
    $('paidBy').value = entry.paidBy;
    updateTypeHint();

    $('saveBtn').disabled = true;
    const status = await sync();
    $('saveBtn').disabled = false;
    report(status, `Saved ✓ ${category} ${money(amount)}` + (entry.type === 'Joint' ? ` · Balance ${money(estimate().balance)}` : ''));
  });

  // ---------- Delete from Recent
  async function removeEntry(item) {
    if (!confirm(`Delete "${item.category}" ${money(item.amount)} from ${prettyDate(item.date)}?`)) return;
    const queue = getQueue();
    const queued = queue.find((op) => op.op === 'add' && op.entry.id === item.id);
    if (queued) {
      // Not sent yet: just drop it from this phone.
      setQueue(queue.filter((op) => op !== queued));
      render();
      showBanner('Removed.', 'ok');
      return;
    }
    enqueue({ op: 'delete', id: item.id });
    const status = await sync();
    if (status === 'ok') showBanner('Deleted ✓', 'ok');
    if (status === 'offline') showBanner('Will delete when you are back online.', 'warn');
  }

  // ---------- Add funds / Set balance
  const fundsDialog = $('fundsDialog');
  let fundsMode = 'Add funds';

  function openFunds(mode) {
    fundsMode = mode;
    const isSet = mode === 'Set balance';
    $('fundsTitle').textContent = isSet ? 'Set balance' : 'Add funds';
    $('fundsHelp').textContent = isSet
      ? 'The main balance becomes exactly this amount, for example at the start of a month. Joint expenses after this are deducted from it.'
      : 'This amount is added on top of the current main balance.';
    $('fundsForm').reset();
    clearInvalid($('fundsForm'));
    $('fundsDate').value = today();
    fundsDialog.showModal();
    $('fundsAmount').focus();
  }
  $('addFundsBtn').addEventListener('click', () => openFunds('Add funds'));
  $('setBalanceBtn').addEventListener('click', () => openFunds('Set balance'));

  // Dialog buttons are handled on submit (not on the dialog's close event) so saving never depends on timing.
  $('fundsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (e.submitter && e.submitter.value === 'cancel') return fundsDialog.close();
    const amount = parseAmount($('fundsAmount').value);
    if (amount === null || (amount === 0 && fundsMode !== 'Set balance')) return $('fundsAmount').classList.add('invalid');
    if (!$('fundsDate').value) return $('fundsDate').classList.add('invalid');
    fundsDialog.close();
    enqueue({
      op: 'add',
      entry: {
        id: uuid(),
        date: $('fundsDate').value,
        category: '',
        amount,
        paidBy: $('fundsPaidBy').value,
        notes: $('fundsNotes').value.trim(),
        type: fundsMode,
      },
    });
    const status = await sync();
    report(status, `${fundsMode === 'Set balance' ? 'Balance set' : 'Funds added'} ✓ Balance ${money(estimate().balance)}`);
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

  $('date').value = today();
  $('paidBy').value = store.get('paidBy', 'V');
  updateTypeHint();
  renderCategories();
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
