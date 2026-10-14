(() => {
  const $ = (id) => document.getElementById(id);
  const DEFAULT_CATEGORIES = [
    'Costco', 'Walmart', 'Harris Teeter', "Trader Joe's", 'Target', 'Shell',
    'Indian Store', 'Whole Foods', 'Amazon', 'Taco Bell', 'Subway', 'Dollar Tree',
  ];

  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem('sirikh.' + key); return v === null ? fallback : JSON.parse(v); }
      catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem('sirikh.' + key, JSON.stringify(value)); } catch {}
    },
  };

  const form = $('expenseForm');
  const banner = $('banner');
  let bannerTimer;
  let flushing = false;

  function today() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function showBanner(text, kind, sticky) {
    clearTimeout(bannerTimer);
    banner.textContent = text;
    banner.className = 'banner ' + kind;
    banner.hidden = false;
    if (!sticky) bannerTimer = setTimeout(() => { banner.hidden = true; }, 3500);
  }

  function settings() { return store.get('settings', null); }

  function parseAmount(raw) {
    const n = Number(String(raw).replace(/[$,\s]/g, ''));
    return isFinite(n) && n !== 0 ? Math.round(n * 100) / 100 : null;
  }

  function money(n) {
    const v = Number(n);
    if (!isFinite(v)) return String(n);
    return (v < 0 ? '-$' : '$') + Math.abs(v).toFixed(2);
  }

  // ---- Categories: defaults plus whatever this phone has typed before, most used first.
  function renderCategories() {
    const counts = store.get('categories', {});
    const names = new Set([...Object.keys(counts).sort((a, b) => counts[b] - counts[a]), ...DEFAULT_CATEGORIES]);
    $('categoryList').innerHTML = '';
    for (const name of names) {
      const opt = document.createElement('option');
      opt.value = name;
      $('categoryList').appendChild(opt);
    }
  }

  function learnCategory(name) {
    const counts = store.get('categories', {});
    const existing = Object.keys(counts).find((k) => k.toLowerCase() === name.toLowerCase()) || name;
    counts[existing] = (counts[existing] || 0) + 1;
    store.set('categories', counts);
    renderCategories();
  }

  // ---- Recent list: rows from the sheet, with unsynced entries on top.
  function renderRecent() {
    const list = $('recentList');
    const pending = store.get('pending', []);
    const recent = store.get('recent', []);
    list.innerHTML = '';
    const rows = [...pending.slice().reverse().map((r) => ({ ...r, pending: true })), ...recent].slice(0, 5 + pending.length);
    if (!rows.length) {
      list.innerHTML = '<li class="muted">Nothing yet.</li>';
    }
    for (const r of rows) {
      const li = document.createElement('li');
      if (r.pending) li.className = 'pending';
      const top = document.createElement('div');
      top.className = 'top';
      const cat = document.createElement('span');
      cat.textContent = r.category;
      const amt = document.createElement('span');
      amt.textContent = money(r.amount);
      top.append(cat, amt);
      const sub = document.createElement('div');
      sub.className = 'sub';
      sub.textContent = [r.date, 'Paid by ' + r.paidBy, r.notes].filter(Boolean).join(' · ');
      li.append(top, sub);
      list.appendChild(li);
    }
    $('pendingNote').textContent = pending.length ? `${pending.length} waiting to sync` : '';
  }

  // ---- Talking to the Apps Script web app. text/plain avoids a CORS preflight.
  async function call(payload) {
    const s = settings();
    if (!s) throw Object.assign(new Error('Not set up'), { setup: true });
    const res = await fetch(s.url, {
      method: 'POST',
      body: JSON.stringify({ ...payload, key: s.key }),
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    });
    const data = await res.json();
    if (!data.ok) throw Object.assign(new Error(data.error || 'Server error'), { server: true });
    return data;
  }

  async function flush() {
    if (flushing) return 'busy';
    flushing = true;
    try {
      let pending = store.get('pending', []);
      while (pending.length) {
        const entry = pending[0];
        try {
          const data = await call(entry);
          store.set('recent', data.recent || []);
        } catch (err) {
          if (err.server && !/key/i.test(err.message)) {
            // The sheet rejected this entry; drop it so it doesn't block the queue.
            showBanner(`Not saved (${entry.category}): ${err.message}`, 'err', true);
          } else {
            if (err.server || err.setup) {
              showBanner(err.setup ? 'Open settings to connect your sheet.' : err.message + ' Check settings.', 'err', true);
            }
            renderRecent();
            return err.server || err.setup ? 'error' : 'offline';
          }
        }
        pending = store.get('pending', []).filter((p) => p.id !== entry.id);
        store.set('pending', pending);
        renderRecent();
      }
      return 'ok';
    } finally {
      flushing = false;
    }
  }

  async function refreshRecent() {
    try {
      const data = await call({ action: 'recent' });
      store.set('recent', data.recent || []);
      renderRecent();
    } catch {}
  }

  // ---- Form
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const amount = parseAmount($('amount').value);
    if (amount === null) {
      showBanner('Enter a valid amount.', 'err');
      $('amount').focus();
      return;
    }
    const entry = {
      id: (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random()).toString(),
      date: $('date').value,
      category: $('category').value.trim(),
      amount,
      paidBy: $('paidBy').value,
      notes: $('notes').value.trim(),
    };
    store.set('pending', [...store.get('pending', []), entry]);
    store.set('paidBy', entry.paidBy);
    learnCategory(entry.category);

    form.reset();
    $('date').value = today();
    $('paidBy').value = entry.paidBy;
    renderRecent();

    $('saveBtn').disabled = true;
    const status = await flush();
    $('saveBtn').disabled = false;
    if (status === 'ok') showBanner(`Saved ✓ ${entry.category} ${money(entry.amount)}`, 'ok');
    else if (status !== 'error') showBanner('Saved on this phone. It will sync when you are back online.', 'warn');
  });

  // ---- Settings
  const dialog = $('settingsDialog');
  function openSettings() {
    const s = settings() || {};
    $('scriptUrl').value = s.url || '';
    $('secretKey').value = s.key || '';
    dialog.showModal();
  }
  $('settingsBtn').addEventListener('click', openSettings);
  dialog.addEventListener('close', async () => {
    if (dialog.returnValue !== 'save') return;
    store.set('settings', { url: $('scriptUrl').value.trim(), key: $('secretKey').value });
    banner.hidden = true;
    await flush();
    await refreshRecent();
  });

  // ---- Start
  $('date').value = today();
  $('paidBy').value = store.get('paidBy', 'V');
  renderCategories();
  renderRecent();
  if (!settings()) openSettings();
  else flush().then(refreshRecent);

  window.addEventListener('online', () => flush().then(refreshRecent));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if ($('date').value === '') $('date').value = today();
      flush();
    }
  });

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
