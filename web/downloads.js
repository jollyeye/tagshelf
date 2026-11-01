'use strict';
// "Tag these downloads": every freshly downloaded picture or video waiting for tags, shown as a grid you can
// select from (click, Ctrl/Shift+click, drag a box, Select all) and tag together.  Used by the small popup
// window (popup.html) and by the "New downloads" dialog inside the main window.

function mountDownloads(root, opt = {}) {
  const D = { items: [], sel: new Set(), anchor: null, tags: [], moveTo: '', sug: null, seq: 0, busy: false, built: false, firstLoad: true, sigIds: '' };
  let timer = 0, stopped = false, sugTimer = 0, justDragged = false;
  const el = {};                       // handles to the parts of the panel
  const byId = () => new Map(D.items.map((i) => [i.id, i]));
  const selItems = () => D.items.filter((i) => D.sel.has(i.id));

  // ---------------------------------------------------------------- data
  async function poll() {
    let items;
    try { items = (await api('/api/downloads')).items || []; } catch (e) { return; }
    if (stopped) return;
    const was = D.items.length;
    D.items = items; S.pending = items.length;
    if (typeof renderNav === 'function' && document.getElementById('nav') && was !== items.length) renderNav();
    if (!items.length) {
      D.built = false; D.sel.clear();
      draw();
      if (opt.onEmpty) opt.onEmpty();
      return;
    }
    const ids = new Set(items.map((i) => i.id));
    for (const id of [...D.sel]) if (!ids.has(id)) D.sel.delete(id);
    if (D.firstLoad) { D.firstLoad = false; items.forEach((i) => D.sel.add(i.id)); }   // a fresh batch starts fully selected
    else if (items.length === 1 && !D.sel.size) D.sel.add(items[0].id);
    if (!D.built) { build(); return; }
    const sig = items.map((i) => i.id).join(',');
    if (sig !== D.sigIds) { drawGrid(); onSel(); }
    else updateCount();
  }

  // ---------------------------------------------------------------- suggestions for the selection
  function sugSoon() { clearTimeout(sugTimer); sugTimer = setTimeout(sugNow, 250); }
  function sugNow() {
    if (!S.ai) { D.sug = null; return; }
    const paths = selItems().slice(0, 30).map((i) => i.path);
    const seq = ++D.seq;
    if (!paths.length) { D.sug = { items: [], empty: true }; drawSuggestions(); return; }
    D.sug = { loading: true, items: [] }; drawSuggestions();
    (async () => {
      let r = await api('/api/ai/suggest', { Paths: paths });
      if (r.need && r.need.length) {
        await indexFiles(r.need.map((p) => ({ path: p, kind: kindFromPath(p), mtime: 0 })));
        r = await api('/api/ai/suggest', { Paths: paths });
      }
      if (seq !== D.seq || stopped) return;
      D.sug = { loading: false, ready: r.ready, trained: r.trained, items: r.items || [] };
      drawSuggestions();
    })().catch(() => { if (seq === D.seq) { D.sug = { loading: false, items: [] }; drawSuggestions(); } });
  }

  // ---------------------------------------------------------------- actions
  function toggle(t) { D.tags = D.tags.includes(t) ? D.tags.filter((x) => x !== t) : [...D.tags, t]; refreshTagParts(); }
  function addTags(list) { for (const t of list) if (!D.tags.includes(t)) D.tags.push(t); refreshTagParts(); const i = root.querySelector('.tag-in'); if (i) i.focus(); }
  function refreshTagParts() { drawTags(); drawSuggestions(); drawQuick(); updateApply(); }

  async function apply() {
    const ids = selItems().map((i) => i.id);
    if (!ids.length || D.busy || (!D.tags.length && !D.moveTo.trim())) return;
    D.busy = true; updateApply();
    try {
      const r = await api('/api/downloads/done', { IDs: ids, Tags: D.tags, MoveTo: D.moveTo.trim() });
      if (r.all) setTags(r.all);
      if (opt.onApplied) opt.onApplied(r);
      D.tags = []; D.moveTo = ''; if (el.moveIn) el.moveIn.value = '';
      refreshTagParts();
    } catch (e) { fail(e); }
    D.busy = false;
    await poll();
  }
  async function skip(all) {
    const ids = all ? [] : selItems().map((i) => i.id);
    if (!all && !ids.length) return;
    try { await api('/api/downloads/skip', { IDs: ids, All: !!all }); } catch (e) { fail(e); }
    await poll();
  }

  // ---------------------------------------------------------------- selection
  function onSel() {
    D.sigIds = D.items.map((i) => i.id).join(',');
    if (el.grid) for (const t of el.grid.querySelectorAll('.dtile')) t.classList.toggle('on', D.sel.has(t.dataset.id));
    drawSelInfo(); updateApply(); updateCount(); sugSoon();
  }
  function clickTile(id, ev) {
    if (ev.shiftKey && D.anchor) {
      const a = D.items.findIndex((i) => i.id === D.anchor), b = D.items.findIndex((i) => i.id === id);
      const [lo, hi] = a < b ? [a, b] : [b, a];
      const next = ev.ctrlKey || ev.metaKey ? new Set(D.sel) : new Set();
      for (let k = lo; k <= hi; k++) next.add(D.items[k].id);
      D.sel = next;
    } else if (ev.ctrlKey || ev.metaKey) {
      if (D.sel.has(id)) D.sel.delete(id); else D.sel.add(id);
      D.anchor = id;
    } else { D.sel = new Set([id]); D.anchor = id; }
    onSel();
  }
  const selectAll = () => { D.sel = new Set(D.items.map((i) => i.id)); onSel(); };
  const selectNone = () => { D.sel = new Set(); onSel(); };

  // rubber-band selection inside the grid
  function marquee(grid) {
    let box = null, sx = 0, sy = 0, base = null, active = false, last = null, raf = 0;
    const upd = () => {
      raf = 0; if (!box || !last) return;
      const x1 = Math.min(sx, last.clientX), x2 = Math.max(sx, last.clientX), y1 = Math.min(sy, last.clientY), y2 = Math.max(sy, last.clientY);
      Object.assign(box.style, { left: x1 + 'px', top: y1 + 'px', width: x2 - x1 + 'px', height: y2 - y1 + 'px' });
      const gr = grid.getBoundingClientRect(), next = new Set(base);
      for (const t of grid.querySelectorAll('.dtile')) {
        const r = t.getBoundingClientRect();
        if (r.bottom < gr.top || r.top > gr.bottom) continue;
        if (r.left < x2 && r.right > x1 && r.top < y2 && r.bottom > y1) next.add(t.dataset.id);
      }
      D.sel = next; onSel();
    };
    grid.addEventListener('mousedown', (ev) => {
      if (ev.button !== 0 || ev.target.closest('.dtile') || ev.offsetX > grid.clientWidth) return;
      ev.preventDefault();
      active = true; sx = ev.clientX; sy = ev.clientY; base = ev.ctrlKey || ev.metaKey ? new Set(D.sel) : new Set();
    });
    addEventListener('mousemove', (ev) => {
      if (!active) return;
      if (!box) { if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < 6) return; box = h('div', { class: 'marquee' }); document.body.append(box); }
      last = ev; if (!raf) raf = requestAnimationFrame(upd);
    });
    addEventListener('mouseup', () => {
      if (!active) return;
      active = false;
      if (box) { if (raf) cancelAnimationFrame(raf); upd(); box.remove(); box = null; justDragged = true; setTimeout(() => { justDragged = false; }, 50); }
      else { selectNone(); }
    });
  }

  // ---------------------------------------------------------------- drawing
  function build() {
    D.built = true;
    const moveIn = h('input', { class: 'txt', type: 'text', placeholder: 'Leave empty to keep them where they are', value: D.moveTo, spellcheck: 'false' });
    moveIn.addEventListener('input', () => { D.moveTo = moveIn.value; updateApply(); });
    moveIn.addEventListener('keydown', (e) => e.stopPropagation());
    el.moveIn = moveIn;
    el.count = h('span', { class: 'muted dl-count' });
    el.grid = h('div', { class: 'dl-grid' });
    el.gridBar = h('div', { class: 'dl-gridbar' },
      h('button', { class: 'btn small', onclick: selectAll }, 'Select all'), h('button', { class: 'btn small', onclick: selectNone }, 'Select none'),
      h('span', { class: 'muted', style: { fontSize: '12px' } }, 'Click, Ctrl/Shift+click or drag a box'));
    el.info = h('div', { class: 'dl-info' });
    el.tags = h('div', { class: 'chips dl-tags' });
    el.sug = h('div', { class: 'dl-sug' });
    el.quick = h('div', { class: 'chips dl-quick' });
    el.apply = h('button', { class: 'btn primary dl-apply', onclick: apply }, 'Apply');
    el.skipSel = h('button', { class: 'btn', onclick: () => skip(false) }, 'Skip selected');
    el.skipAll = h('button', { class: 'btn', onclick: () => skip(true) }, 'Skip all');
    el.open = h('button', { class: 'btn', title: 'Open the file', onclick: () => { const s = selItems(); if (s.length === 1) api('/api/open', { Path: s[0].path }).catch(fail); } }, 'Open');
    const input = tagInput(addTags, { exclude: () => D.tags, placeholder: 'Type a tag and press Enter…' });
    const recent = (S.recent || []).slice(0, 4);
    root.replaceChildren(h('div', { class: 'dl' },
      h('div', { class: 'dl-head' }, h('b', {}, 'New downloads'), el.count),
      el.gridBar, el.grid, el.info,
      h('div', { class: 'sh' }, 'Tags for the selected files'), el.tags, input,
      S.ai ? h('div', { class: 'sh', style: { marginTop: '14px' } }, h('span', { class: 'ai-badge' }, icon('sparkle', 13), 'Suggested for you'), h('span', { class: 'none' }, 'click to use')) : null,
      S.ai ? el.sug : null,
      h('div', { class: 'sh', style: { marginTop: '14px' } }, 'Your usual tags'), el.quick,
      h('div', { class: 'sh', style: { marginTop: '14px' } }, 'Move them to a folder (optional)'),
      h('div', { class: 'row' }, moveIn, S.os === 'windows' ? h('button', { class: 'btn', onclick: async () => {
        try { const r = await api('/api/pick', {}); if (r.path) { D.moveTo = r.path; moveIn.value = r.path; updateApply(); } } catch (e) { fail(e); }
      } }, 'Browse…') : null),
      recent.length ? h('div', { class: 'chips', style: { marginTop: '6px' } }, recent.map((d) => h('button', { class: 'btn small', title: d, onclick: () => { D.moveTo = d; moveIn.value = d; updateApply(); } }, baseName(d)))) : null,
      h('div', { class: 'dl-foot' }, el.skipSel, el.skipAll, h('span', { class: 'sp' }), el.open, el.apply)));
    marquee(el.grid);
    drawGrid(); drawTags(); drawQuick(); onSel();
    const first = root.querySelector('.tag-in'); if (first) setTimeout(() => first.focus(), 30);
  }

  function drawGrid() {
    D.sigIds = D.items.map((i) => i.id).join(',');
    const many = D.items.length > 1;
    el.grid.hidden = !many; el.gridBar.hidden = !many;
    el.grid.replaceChildren(...D.items.slice(0, 1500).map((it) => {
      const pic = it.kind === 'video'
        ? h('div', { class: 'vid' }, icon('video', 26))
        : h('img', { src: THUMB_EXT.has(extOf(it.path)) ? thumbUrl(it.path, it.at) : fileUrl(it.path), loading: 'lazy', decoding: 'async', alt: '', draggable: 'false' });
      return h('div', { class: 'dtile' + (D.sel.has(it.id) ? ' on' : ''), dataset: { id: it.id }, title: it.name,
        onclick: (ev) => { if (!justDragged) clickTile(it.id, ev); } }, pic, h('i', { class: 'tick' }, icon('check', 12)));
    }));
  }

  function updateCount() {
    if (el.count) el.count.textContent = D.items.length > 1 ? `${D.sel.size} of ${D.items.length} selected` : '';
  }
  function drawSelInfo() {
    if (!el.info) return;
    const s = selItems();
    if (!s.length) { el.info.replaceChildren(h('p', { class: 'none' }, 'Select the pictures you want to tag together.')); return; }
    if (s.length === 1) {
      const it = s[0];
      const pv = it.kind === 'video' ? h('video', { src: fileUrl(it.path), controls: true, muted: true, loop: true }) : h('img', { src: fileUrl(it.path), alt: '' });
      el.info.replaceChildren(h('div', { class: 'dl-pv' }, pv),
        h('div', { class: 'dl-name' }, h('b', { title: it.path }, it.name), h('span', { class: 'muted' }, fmtSize(it.size) + ' · ' + dirOf(it.path))));
      return;
    }
    const bytes = s.reduce((a, i) => a + (i.size || 0), 0);
    el.info.replaceChildren(h('div', { class: 'dl-name' }, h('b', {}, `${s.length} files selected`), h('span', { class: 'muted' }, fmtSize(bytes) + ' in total')));
  }
  function drawTags() {
    if (!el.tags) return;
    el.tags.replaceChildren(...(D.tags.length ? D.tags.map((t) => tagChip(t, { onremove: () => toggle(t) })) : [h('span', { class: 'none' }, 'No tags chosen yet')]));
  }
  function drawSuggestions() {
    if (!el.sug) return;
    if (!S.ai) { el.sug.replaceChildren(); return; }
    const s = D.sug;
    if (!s || s.loading) { el.sug.replaceChildren(h('span', { class: 'none' }, 'Looking at the picture…')); return; }
    const items = s.items.filter((x) => !D.tags.includes(x.tag));
    const kids = [];
    if (s.empty) { el.sug.replaceChildren(); return; }
    if (!s.ready) kids.push(h('div', { class: 'ai-note' }, `Still learning from your tagging (${Math.min(s.trained, 6)} of 6 needed). Tag some pictures yourself and suggestions will appear here.`));
    if (items.length) kids.push(h('div', { class: 'chips' }, items.map((x) => h('span', { class: 'chip quick off', style: chipStyle(tagColor(x.tag)), title: (x.why || []).join(' · ') || 'Click to use this tag' },
      h('span', { class: 'chip-t', onclick: () => toggle(x.tag) }, x.tag, h('em', {}, Math.round(x.score * 100) + '%'))))));
    else if (s.ready) kids.push(h('span', { class: 'none' }, 'No suggestion for these.'));
    el.sug.replaceChildren(...kids);
  }
  function drawQuick() {
    if (!el.quick) return;
    const names = S.tags.slice().sort((a, b) => (b.used || 0) - (a.used || 0) || b.count - a.count).slice(0, 14).map((t) => t.name).filter((t) => !D.tags.includes(t));
    el.quick.replaceChildren(...names.map((t) => h('span', { class: 'chip quick off', style: chipStyle(tagColor(t)) }, h('span', { class: 'chip-t', onclick: () => toggle(t) }, t))));
  }
  function updateApply() {
    if (!el.apply) return;
    const n = D.sel.size, moving = D.moveTo.trim() !== '';
    el.apply.disabled = D.busy || !n || (!D.tags.length && !moving);
    const files = n > 1 ? ` to ${n} files` : '';
    el.apply.textContent = D.tags.length ? `Apply ${D.tags.length} tag${D.tags.length > 1 ? 's' : ''}${files}` + (moving ? ' and move' : '') : moving ? (n > 1 ? `Move ${n} files` : 'Move') : 'Apply';
    el.skipSel.disabled = !n;
    el.skipAll.hidden = D.items.length < 2;
    el.skipSel.textContent = D.items.length < 2 ? 'Skip' : 'Skip selected';
    el.open.hidden = n !== 1;
  }
  function draw() {
    root.replaceChildren(h('div', { class: 'empty', style: { height: '260px' } }, icon('check', 40), h('b', {}, 'All done'), h('span', {}, opt.popup ? 'This window will close.' : 'No new downloads waiting for tags.')));
  }

  const onKey = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); apply(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && !/INPUT|TEXTAREA/.test((e.target || {}).tagName || '')) { e.preventDefault(); selectAll(); }
  };
  document.addEventListener('keydown', onKey);
  poll();
  timer = setInterval(poll, 2000);
  return { stop() { stopped = true; clearInterval(timer); clearTimeout(sugTimer); document.removeEventListener('keydown', onKey); } };
}
