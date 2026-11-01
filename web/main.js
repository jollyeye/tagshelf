'use strict';
// Start-up, keyboard, window plumbing and the quiet background work (watching for changes, learning).

// ---------------------------------------------------------------- learning in the background
let aiRun = 0;
const onFolderLoaded = debounce(() => aiBackground(), 1500);
async function aiBackground() {
  if (!S.ai) return;
  const run = ++aiRun, startPath = S.path;
  const live = () => run === aiRun && S.ai;
  const doBatch = async (paths) => {
    const items = paths.filter((p) => !aiFailed.has(p)).map((p) => ({ path: p, kind: kindFromPath(p), mtime: 0 }));
    if (!items.length) return 0;
    const base = AIS.done;
    AIS.total += items.length;
    await indexFiles(items, (d) => { AIS.done = base + d; if (live()) renderStatus(); });
    AIS.done = base + items.length;
    return items.length;
  };
  try {
    AIS.done = 0; AIS.total = 0;
    // 1) files you tagged elsewhere: they are what it learns from
    for (let round = 0; round < 40 && live(); round++) {
      const q = await api('/api/ai/queue', { Limit: 30 });
      const fresh = (q.paths || []).filter((p) => !aiFailed.has(p));
      if (!fresh.length) break;
      await doBatch(fresh);
    }
    // 2) the pictures and videos in the folder you are looking at
    if (live() && S.path === startPath) {
      const media = S.entries.filter(isMedia).slice(0, 500).map((e) => e.p);
      for (let i = 0; i < media.length && live() && S.path === startPath; i += 40) {
        const need = (await api('/api/ai/need', { Paths: media.slice(i, i + 40) })).need || [];
        await doBatch(need);
      }
    }
  } catch (e) { /* learning is optional */ }
  if (run === aiRun) {
    AIS.total = 0; AIS.done = 0; renderStatus(); aiForget();
    // suggestions asked for while it was still learning are out of date: ask again, in place
    const box = viewerOpen() ? $('#vsugbox') : $('#sugbox');
    if (box && S.ai) renderSuggestions(box, viewerOpen() ? [V.list[V.i].p] : undefined);
  }
}

// ---------------------------------------------------------------- keyboard
function onKey(e) {
  const t = e.target, typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  if (!$('#menu').hidden && e.key === 'Escape') { closeMenu(); e.preventDefault(); return; }
  if (isModalOpen()) {
    if (e.key === 'Escape') { const b = $$('#modal .dlg-h .ibtn').pop(); if (b) b.click(); e.preventDefault(); }
    return;
  }
  if (viewerOpen()) { if (!typing && viewerKey(e)) e.preventDefault(); return; }
  if (e.key === 'F1') { openHelp(); e.preventDefault(); return; }
  if (typing) return;
  if (contentKey(e)) e.preventDefault();
}

// ---------------------------------------------------------------- resizable side panels
function initGutters() {
  const mk = (which) => {
    const g = h('div', { class: 'gutter ' + which, title: 'Drag to resize' });
    const place = () => { if (which === 'nav') g.style.left = S.navw - 3 + 'px'; else g.style.right = S.sidew - 3 + 'px'; };
    g.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      const move = (e) => {
        if (which === 'nav') S.navw = Math.max(180, Math.min(520, e.clientX)); else S.sidew = Math.max(260, Math.min(620, innerWidth - e.clientX));
        applyLook(); place();
      };
      const up = () => { removeEventListener('mousemove', move); removeEventListener('mouseup', up); document.body.classList.remove('resizing'); saveSettingsSoon(); };
      document.body.classList.add('resizing');
      addEventListener('mousemove', move); addEventListener('mouseup', up);
    });
    place(); document.body.append(g);
  };
  mk('nav'); mk('side');
}

// ---------------------------------------------------------------- start
async function pickStartFolder() {
  const quick = S.locs.quick || [];
  const pics = quick.find((q) => q.name === 'Pictures');
  return S.lastPath || (pics && pics.path) || S.home || (quick[0] && quick[0].path) || ((S.locs.drives || [])[0] || {}).path || '/';
}

async function init() {
  initContent();
  addEventListener('keydown', onKey);
  addEventListener('mouseup', (e) => { if (e.button === 3) { goBack(); e.preventDefault(); } else if (e.button === 4) { goForward(); e.preventDefault(); } });
  $('#content').addEventListener('wheel', (e) => {
    if (!e.ctrlKey || S.view !== 'grid') return;
    e.preventDefault();
    S.size = Math.max(110, Math.min(420, S.size + (e.deltaY < 0 ? 20 : -20))); applyLook(); saveSettingsSoon();
    const r = $('.sizer'); if (r) r.value = S.size;
  }, { passive: false });
  addEventListener('pagehide', () => { try { navigator.sendBeacon('/api/bye'); } catch (e) { /* closing anyway */ } });
  addEventListener('dragover', (e) => e.preventDefault());
  addEventListener('drop', (e) => e.preventDefault());

  try { await loadState(); } catch (e) {
    $('#content').replaceChildren(h('div', { class: 'err-box' }, e.message));
    return;
  }
  try { S.locs = await api('/api/locations'); } catch (e) { S.locs = { quick: [], drives: [] }; }
  initGutters();
  renderAll();
  const start = await pickStartFolder();
  await go(start, { initial: true });
  if (S.error && start !== S.home && S.home) await go(S.home, { initial: true });
  if (!S.welcomed) openWelcome(); else if (!S.bgAsked) openBackgroundAsk();

  // keep in touch with the program, and notice changes made outside of it
  api('/api/ping').catch(() => {});
  setInterval(() => api('/api/ping').catch(() => {}), 3000);
  setInterval(() => { if (!document.hidden && !isModalOpen() && !viewerOpen() && !S.loading) refresh({ silent: true }); }, 4000);
  setInterval(async () => {
    try { const n = ((await api('/api/downloads')).items || []).length; if (n !== S.pending) { S.pending = n; renderNav(); } } catch (e) { /* ignore */ }
  }, 3000);
  // tags created elsewhere (for example in the download window) show up here too
  setInterval(async () => {
    if (document.hidden) return;
    try {
      const st = await api('/api/state');
      const sig = (l) => l.map((t) => t.name + t.color + t.count).join('|');
      if (sig(st.tags) !== sig(S.tags)) {
        setTags(st.tags); S.views = st.views || S.views; S.missing = st.missing || 0;
        const typing = document.activeElement && document.activeElement.closest && document.activeElement.closest('#side');
        if (!typing && !isModalOpen()) renderSide();
        renderNav();
      }
    } catch (e) { /* ignore */ }
  }, 5000);
}
init();
