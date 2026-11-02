'use strict';
// The middle: toolbar, address bar, filter bar, file grid/list, selection, drag & drop, file operations.

const AIS = { done: 0, total: 0 };
const R = { groups: [], gi: 0, ii: 0, host: null, io: null, path: null, done: true };
const CHUNK = 240;
const isMedia = (e) => !e.d && (e.k === 'image' || e.k === 'video');
const trashWord = () => (S.os === 'windows' ? 'Recycle Bin' : 'Trash');

function renderAll() { renderNav(); renderTop(); renderFilterbar(); renderContent(); renderSide(); renderStatus(); }

// ---------------------------------------------------------------- toolbar
function segLabel(p, i) { return i === 0 ? (p.replace(/[\\/]+$/, '') || p) : baseName(p); }

function crumbsEl() {
  const box = h('div', { class: 'crumbs', onclick: (e) => { if (e.target === box || e.target.classList.contains('segs')) editAddress(); } });
  const segs = h('div', { class: 'segs' });
  if (S.path) {
    ancestry(S.path).forEach((p, i, arr) => {
      if (i) segs.append(h('span', { class: 'sep' }, icon('chevR', 13)));
      const b = h('button', { class: 'seg', title: p, onclick: () => go(p) }, segLabel(p, i));
      dropTarget(b, () => p);
      segs.append(b);
    });
  }
  box.append(segs);
  return box;
}
function editAddress() {
  const box = $('.crumbs');
  if (!box) return;
  const inp = h('input', { type: 'text', value: S.path, spellcheck: 'false' });
  let done = false;
  const finish = (commit) => {
    if (done) return; done = true;
    const v = inp.value.trim();
    renderTop();
    if (commit && v && v !== S.path) go(v);
  };
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); e.stopPropagation(); });
  inp.addEventListener('blur', () => finish(false));
  box.replaceChildren(inp);
  inp.focus(); inp.select();
}

const GROUPS = [['none', 'No grouping'], ['tag', 'Group by tag'], ['type', 'Group by type'], ['year', 'Group by year'], ['month', 'Group by month'], ['rating', 'Group by rating'], ['folder', 'Group by subfolder']];
const SORTS = [['name', 'Name'], ['date', 'Date modified'], ['size', 'Size'], ['type', 'Type'], ['rating', 'Rating']];

function renderTop() {
  const t = $('#top');
  const search = h('input', { class: 'txt', type: 'text', id: 'search', placeholder: S.sub ? 'Search here and in subfolders…' : 'Search this folder…', value: S.f.q, spellcheck: 'false' });
  search.addEventListener('input', debounce(() => { S.f.q = search.value; filterChangedLite(); }, 120));
  search.addEventListener('keydown', (e) => { if (e.key === 'Escape') { search.value = ''; S.f.q = ''; filterChangedLite(); search.blur(); } e.stopPropagation(); });
  const sel = (opts, val, fn, title) => {
    const s = h('select', { class: 'txt tsel', title }, opts.map(([v, l]) => h('option', { value: v, selected: v === val }, l)));
    s.addEventListener('change', () => fn(s.value));
    return s;
  };
  t.replaceChildren(
    h('button', { class: 'ibtn', title: 'Back (Alt+←)', disabled: S.hi <= 0, onclick: goBack }, icon('back', 18)),
    h('button', { class: 'ibtn', title: 'Forward (Alt+→)', disabled: S.hi >= S.hist.length - 1, onclick: goForward }, icon('forward', 18)),
    h('button', { class: 'ibtn', title: 'Up one level (Alt+↑)', disabled: !S.parent, onclick: goUp }, icon('up', 18)),
    h('button', { class: 'ibtn', title: 'Refresh (F5)', onclick: () => { refresh(); NAV.kids.clear(); NAV.open.forEach((p) => loadKids(p, true).then(renderNav)); } }, icon('refresh', 17)),
    crumbsEl(),
    h('div', { class: 'searchbox' }, icon('search', 15), search),
    sel(GROUPS, S.group, (v) => { S.group = v; saveSettingsSoon(); renderContent(); }, 'Group files'),
    sel(SORTS, S.sort, (v) => { S.sort = v; saveSettingsSoon(); recompute(); renderContent(); }, 'Sort by'),
    h('button', { class: 'ibtn', title: S.desc ? 'Descending' : 'Ascending', onclick: () => { S.desc = !S.desc; saveSettingsSoon(); recompute(); renderTop(); renderContent(); } }, icon(S.desc ? 'chevD' : 'up', 16)),
    h('div', { class: 'seg2' },
      h('button', { class: S.view === 'grid' ? 'on' : '', title: 'Thumbnails', onclick: () => setView('grid') }, icon('grid', 15)),
      h('button', { class: S.view === 'list' ? 'on' : '', title: 'Details', onclick: () => setView('list') }, icon('list', 15))),
    h('input', { class: 'sizer', type: 'range', min: 110, max: 420, step: 10, value: S.size, title: 'Thumbnail size', oninput: (e) => { S.size = +e.target.value; applyLook(); saveSettingsSoon(); } }),
    h('button', { class: 'ibtn' + (S.sub ? ' on' : ''), title: 'Include subfolders (search and tag filters then cover every folder below this one)', onclick: toggleSub }, icon('folder', 17)),
    h('button', { class: 'ibtn' + (S.hidden ? ' on' : ''), title: 'Show hidden files', onclick: () => { S.hidden = !S.hidden; saveSettingsSoon(); NAV.kids.clear(); refresh(); renderTop(); renderNav(); } }, icon('eye', 17)),
    h('button', { class: 'ibtn', title: 'More…', onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); toolsMenu(r.right - 220, r.bottom + 4); } }, icon('settings', 17)),
  );
}
function setView(v) { S.view = v; saveSettingsSoon(); renderTop(); renderContent(); }
async function toggleSub() {
  S.sub = !S.sub;
  renderTop();
  await go(S.path, { push: false, keepSel: true, keepFilter: true });
}
function filterChangedLite() { recompute(); renderFilterbar(); renderContent(); renderSide(); renderStatus(); }

function toolsMenu(x, y) {
  menu(x, y, [
    { label: 'New folder', icon: 'newfolder', key: 'Ctrl+Shift+N', fn: () => newFolderIn(S.path) },
    { label: 'Select all', key: 'Ctrl+A', fn: selectAll },
    { label: 'Invert selection', key: 'Ctrl+I', fn: invertSel },
    '-',
    { label: 'Suggest tags for the untagged files here…', icon: 'sparkle', fn: () => openReview() },
    { label: 'Find duplicate files…', icon: 'copy', fn: () => openDuplicates() },
    { label: 'Batch rename selected…', icon: 'edit', disabled: S.sel.size < 2, fn: () => openBatchRename(selEntries()) },
    { label: 'Undo ' + (S.undo.length ? S.undo[S.undo.length - 1].label : ''), icon: 'undo', key: 'Ctrl+Z', disabled: !S.undo.length, fn: undo },
    '-',
    { label: 'Keyboard shortcuts', icon: 'info', key: 'F1', fn: openHelp },
    { label: 'Settings', icon: 'settings', fn: openSettings },
  ]);
}

// ---------------------------------------------------------------- filter bar & status
function renderFilterbar() {
  const bar = $('#filterbar');
  if (!filterActive()) { bar.hidden = true; bar.replaceChildren(); return; }
  const f = S.f, kids = [h('span', { class: 'muted' }, S.sub ? 'Filtering this folder and its subfolders:' : 'Filtering this folder:')];
  const chip = (label, color, cls, onx) => h('span', { class: 'fchip ' + (cls || ''), style: color ? { '--c': color } : null }, label, h('button', { title: 'Remove', onclick: onx }, icon('x', 11)));
  if (f.q) kids.push(chip('“' + f.q + '”', null, '', () => { f.q = ''; afterFilterChange(); }));
  if (f.inc.length > 1) kids.push(h('span', { class: 'muted' }, f.any ? 'any of' : 'all of'));
  for (const t of f.inc) kids.push(chip(t, tagColor(t), '', () => toggleInc(t)));
  for (const t of f.exc) kids.push(chip('not ' + t, tagColor(t), 'not', () => toggleExc(t)));
  for (const k of f.kinds) kids.push(chip(k, null, '', () => { f.kinds = f.kinds.filter((x) => x !== k); afterFilterChange(); }));
  if (f.minRating) kids.push(chip('★ ' + f.minRating + '+', null, '', () => { f.minRating = 0; afterFilterChange(); }));
  if (f.untagged) kids.push(chip('untagged', null, '', () => { f.untagged = false; afterFilterChange(); }));
  kids.push(h('button', { class: 'btn small', onclick: clearFilters }, 'Clear all'));
  kids.push(h('span', { class: 'sp' }), h('span', { class: 'muted' }, `${S.vis.length} of ${S.entries.length} shown`));
  bar.replaceChildren(...kids);
  bar.hidden = false;
}

function renderStatus() {
  const st = $('#status');
  const n = S.vis.length;
  const kids = [h('span', {}, `${n} item${n === 1 ? '' : 's'}` + (S.vis.length !== S.entries.length ? ` (of ${S.entries.length})` : ''))];
  if (S.sel.size) {
    const es = selEntries();
    const bytes = es.reduce((a, e) => a + (e.d ? 0 : e.s), 0);
    kids.push(h('span', {}, `${S.sel.size} selected` + (bytes ? ' · ' + fmtSize(bytes) : '')));
  }
  if (S.truncated) kids.push(h('span', { class: 'warn' }, 'Very large folder: only the first part is shown. Turn off subfolders or narrow the search.'));
  if (AIS.total && AIS.done < AIS.total) kids.push(h('span', { class: 'ai-badge' }, icon('sparkle', 13), `Learning from your images… ${AIS.done}/${AIS.total}`));
  kids.push(h('span', { class: 'sp' }));
  if (S.undo.length) kids.push(h('button', { class: 'toast-act', onclick: undo }, 'Undo ' + S.undo[S.undo.length - 1].label));
  st.replaceChildren(...kids);
}

// ---------------------------------------------------------------- grouping
const KIND_LABEL = { folder: 'Folders', image: 'Images', video: 'Videos', audio: 'Audio', other: 'Other files' };
function makeGroups() {
  const items = S.vis, mode = S.group;
  if (mode === 'none') return [{ label: '', items }];
  const folders = items.filter((e) => e.d), files = items.filter((e) => !e.d);
  const out = [];
  if (folders.length) out.push({ label: 'Folders', items: folders });
  const bucket = (keyFn, order, labelFn) => {
    const m = new Map();
    for (const e of files) for (const k of [].concat(keyFn(e))) { if (!m.has(k)) m.set(k, []); m.get(k).push(e); }
    const keys = Array.from(m.keys()).sort(order);
    for (const k of keys) out.push({ label: labelFn(k), items: m.get(k), color: mode === 'tag' && k !== '' ? tagColor(k) : null });
  };
  if (mode === 'tag') bucket((e) => (e.t && e.t.length ? e.t : ['']), (a, b) => (a === '' ? 1 : b === '' ? -1 : collator.compare(a, b)), (k) => k || 'Untagged');
  else if (mode === 'type') bucket((e) => e.k, (a, b) => collator.compare(KIND_LABEL[a], KIND_LABEL[b]), (k) => KIND_LABEL[k] || k);
  else if (mode === 'year') bucket((e) => new Date(e.m * 1000).getFullYear(), (a, b) => b - a, (k) => String(k));
  else if (mode === 'month') bucket((e) => { const d = new Date(e.m * 1000); return d.getFullYear() * 100 + d.getMonth(); }, (a, b) => b - a,
    (k) => new Date(Math.floor(k / 100), k % 100, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }));
  else if (mode === 'rating') bucket((e) => e.r || 0, (a, b) => b - a, (k) => (k ? '★'.repeat(k) : 'Unrated'));
  else if (mode === 'folder') bucket((e) => { const r = e.rel || ''; const i = Math.max(r.lastIndexOf('/'), r.lastIndexOf('\\')); return i > 0 ? r.slice(0, i) : ''; }, (a, b) => collator.compare(a, b), (k) => k || '(this folder)');
  return out.length ? out : [{ label: '', items }];
}

// ---------------------------------------------------------------- tiles & rows
const vio = new IntersectionObserver((es) => {
  for (const e of es) {
    if (!e.isIntersecting) continue;
    const v = e.target;
    if (v.dataset.src) { v.src = v.dataset.src; delete v.dataset.src; }
    vio.unobserve(v);
  }
}, { rootMargin: '400px' });

function entryIcon(e) { return e.d ? 'folder' : e.k === 'image' ? 'image' : e.k === 'video' ? 'video' : e.k === 'audio' ? 'music' : 'doc'; }
function typeLabel(e) { return e.d ? 'Folder' : e.x ? e.x.slice(1).toUpperCase() + ' file' : 'File'; }

function tileMedia(e) {
  if (e.d) return h('div', { class: 'big' }, icon('folder', 54));
  if (e.k === 'image') return h('img', { src: THUMB_EXT.has(e.x) ? thumbUrl(e.p, e.m) : fileUrl(e.p), loading: 'lazy', decoding: 'async', alt: '', draggable: 'false' });
  if (e.k === 'video') {
    const v = h('video', { muted: true, preload: 'metadata', playsinline: true, draggable: 'false' });
    v.dataset.src = fileUrl(e.p) + '#t=0.1';
    vio.observe(v);
    return [v, h('span', { class: 'play' }, icon('play', 12))];
  }
  return h('div', { class: 'big' }, icon(entryIcon(e), 40), h('span', {}, e.x ? e.x.slice(1).toUpperCase() : ''));
}
function tagMinis(e, max) {
  const t = e.t || [];
  if (S.tagShow === 'none' || !t.length) return [];
  if (S.tagShow === 'dots') return t.map((x) => h('span', { class: 'dotz', style: { background: tagColor(x) }, title: x }));
  const shown = t.slice(0, max || 6);
  return [...shown.map((x) => h('span', { class: 'mini', style: chipStyle(tagColor(x)) }, x)), t.length > shown.length ? h('span', { class: 'more' }, '+' + (t.length - shown.length)) : null];
}
const isCut = (p) => S.clip && S.clip.mode === 'cut' && S.clip.paths.includes(p);

function tileEl(e) {
  const t = tileEl0(e);
  if (e.d) coverWatch(t, e);
  return t;
}
function tileEl0(e) {
  return h('div', { class: 'tile' + (e.d ? ' folder' : '') + (S.sel.has(e.p) ? ' sel' : '') + (isCut(e.p) ? ' cut' : ''), dataset: e.d ? { p: e.p, dir: '1' } : { p: e.p }, draggable: true, title: e.p },
    h('div', { class: 'thumb' }, tileMedia(e),
      h('button', { class: 'chk', title: 'Select' }, icon('check', 13)),
      e.r ? h('span', { class: 'stars' }, '★' + e.r) : null),
    h('div', { class: 'cap' }, h('div', { class: 'nm' }, e.n), e.rel && S.sub ? h('div', { class: 'relp' }, dirOf(e.rel) === e.rel ? '' : dirOf(e.rel)) : null,
      h('div', { class: 'tg' }, tagMinis(e))));
}
function rowEl(e) {
  const t = rowEl0(e);
  if (e.d) coverWatch(t, e);
  return t;
}
function rowEl0(e) {
  return h('div', { class: 'lrow' + (e.d ? ' folder' : '') + (S.sel.has(e.p) ? ' sel' : '') + (isCut(e.p) ? ' cut' : ''), dataset: e.d ? { p: e.p, dir: '1' } : { p: e.p }, draggable: true, title: e.p },
    h('div', { class: 'c1' }, icon(entryIcon(e), 16), h('span', {}, e.n)),
    h('div', { class: 'c2' }, tagMinis(e, 4)),
    h('div', { class: 'c3' }, e.d ? '' : fmtSize(e.s)),
    h('div', { class: 'c4' }, fmtDate(e.m)),
    h('div', { class: 'c5' }, typeLabel(e)));
}
function listHead() {
  const b = (label, key) => h('button', { onclick: () => { if (S.sort === key) S.desc = !S.desc; else { S.sort = key; S.desc = false; } saveSettingsSoon(); recompute(); renderTop(); renderContent(); } },
    label + (S.sort === key ? (S.desc ? ' ▼' : ' ▲') : ''));
  return h('div', { class: 'lhead' }, b('Name', 'name'), h('span', {}, 'Tags'), b('Size', 'size'), b('Modified', 'date'), b('Type', 'type'));
}

// ---------------------------------------------------------------- rendering (in chunks, so huge folders stay fast)
function appendChunk() {
  const c = $('#content');
  let budget = CHUNK;
  while (budget > 0 && R.gi < R.groups.length) {
    const g = R.groups[R.gi];
    if (R.ii === 0) {
      if (g.label) c.append(h('div', { class: 'ghead', style: g.color ? { '--c': g.color } : null }, g.color ? h('i', { class: 'gdot' }) : null, h('span', {}, g.label), h('em', {}, g.items.length),
        h('button', { class: 'toast-act', onclick: () => { for (const e of g.items) S.sel.add(e.p); paintSel(); renderSide(); renderStatus(); } }, 'select')));
      R.host = h('div', { class: S.view === 'list' ? 'list' : 'grid' });
      c.append(R.host);
    }
    const end = Math.min(g.items.length, R.ii + budget);
    const frag = document.createDocumentFragment();
    for (let i = R.ii; i < end; i++) frag.append(S.view === 'list' ? rowEl(g.items[i]) : tileEl(g.items[i]));
    R.host.append(frag);
    budget -= end - R.ii;
    R.ii = end;
    if (R.ii >= g.items.length) { R.gi++; R.ii = 0; }
  }
  R.done = R.gi >= R.groups.length;
  const old = $('.sentinel', c); if (old) old.remove();
  if (!R.done) {
    const s = h('div', { class: 'sentinel', style: { height: '4px' } });
    c.append(s);
    if (R.io) R.io.disconnect();
    R.io = new IntersectionObserver((es) => { if (es.some((x) => x.isIntersecting)) appendChunk(); }, { root: c, rootMargin: '900px' });
    R.io.observe(s);
  }
}
function renderAllChunks() { while (!R.done) appendChunk(); }

function renderContent() {
  const c = $('#content');
  if (S.loading) {
    if (!c.children.length) c.append(h('div', { class: 'loading' }, 'Loading…'));
    c.classList.add('busy');
    return;
  }
  c.classList.remove('busy');
  const keep = R.path === S.path ? c.scrollTop : 0;
  R.path = S.path;
  if (R.io) { R.io.disconnect(); R.io = null; }
  c.replaceChildren();
  if (S.error) { c.append(h('div', { class: 'err-box' }, S.error)); return; }
  if (!S.path) { c.append(h('div', { class: 'empty' }, h('b', {}, 'Pick a folder on the left'))); return; }
  if (!S.vis.length) {
    c.append(h('div', { class: 'empty' }, h('b', {}, filterActive() ? 'Nothing here matches your filters' : 'This folder is empty'),
      filterActive() ? h('button', { class: 'btn', onclick: clearFilters }, 'Clear filters') : h('span', {}, 'Drop files here from another folder to move them in.')));
    return;
  }
  R.groups = makeGroups(); R.gi = 0; R.ii = 0; R.host = null; R.done = false;
  if (S.view === 'list') c.append(listHead());
  appendChunk();
  if (keep) {
    while (!R.done && c.scrollHeight < keep + c.clientHeight + 300) appendChunk();
    c.scrollTop = keep;
  }
}

// ---------------------------------------------------------------- selection
function paintSel() {
  for (const el of $$('#content [data-p]')) el.classList.toggle('sel', S.sel.has(el.dataset.p));
}
function paintCut() {
  for (const el of $$('#content [data-p]')) el.classList.toggle('cut', !!isCut(el.dataset.p));
}
function selectionChanged() { paintSel(); renderSide(); renderStatus(); }
function selectOnly(p) { S.sel = new Set(p ? [].concat(p) : []); S.anchor = S.focus = [].concat(p || [])[0] || null; selectionChanged(); }
function selectAll() { S.sel = new Set(S.vis.map((e) => e.p)); selectionChanged(); }
function invertSel() { const n = new Set(); for (const e of S.vis) if (!S.sel.has(e.p)) n.add(e.p); S.sel = n; selectionChanged(); }
function scrollToSelected() {
  const p = S.focus && S.sel.has(S.focus) ? S.focus : S.sel.values().next().value;
  if (!p) return;
  let el = $$('#content [data-p]').find((x) => x.dataset.p === p);
  if (!el && !R.done) { renderAllChunks(); el = $$('#content [data-p]').find((x) => x.dataset.p === p); }
  if (el) el.scrollIntoView({ block: 'nearest' });
}
function clickEntry(p, ev) {
  const idx = (x) => S.vis.findIndex((e) => e.p === x);
  if (ev.shiftKey && S.anchor && S.byPath.has(S.anchor)) {
    const a = idx(S.anchor), b = idx(p);
    if (a >= 0 && b >= 0) {
      const [lo, hi] = a < b ? [a, b] : [b, a];
      if (!(ev.ctrlKey || ev.metaKey)) S.sel = new Set();
      for (let i = lo; i <= hi; i++) S.sel.add(S.vis[i].p);
    }
  } else if (ev.ctrlKey || ev.metaKey) {
    if (S.sel.has(p)) S.sel.delete(p); else S.sel.add(p);
    S.anchor = p;
  } else { S.sel = new Set([p]); S.anchor = p; }
  S.focus = p;
  selectionChanged();
}
function gridCols() {
  if (S.view === 'list') return 1;
  const tiles = $$('#content .tile');
  if (!tiles.length) return 1;
  const top = tiles[0].offsetTop;
  let n = 0;
  while (n < tiles.length && tiles[n].offsetTop === top) n++;
  return Math.max(1, n);
}
function moveFocus(delta, extend) {
  if (!S.vis.length) return;
  let i = S.vis.findIndex((e) => e.p === S.focus);
  if (i < 0) i = delta > 0 ? -1 : S.vis.length;
  const ni = Math.max(0, Math.min(S.vis.length - 1, i + delta));
  const p = S.vis[ni].p;
  if (extend) clickEntry(p, { shiftKey: true });
  else { S.sel = new Set([p]); S.anchor = p; S.focus = p; selectionChanged(); }
  scrollToSelected();
}
let typeBuf = '', typeTimer;
function typeAhead(ch) {
  typeBuf += ch.toLowerCase();
  clearTimeout(typeTimer); typeTimer = setTimeout(() => { typeBuf = ''; }, 800);
  const e = S.vis.find((x) => x.n.toLowerCase().startsWith(typeBuf));
  if (e) { S.sel = new Set([e.p]); S.anchor = S.focus = e.p; selectionChanged(); scrollToSelected(); }
}

// ---------------------------------------------------------------- opening
function openEntry(e) {
  if (e.d) { go(e.p); return; }
  if (S.dbl === 'viewer' && (e.k === 'image' || e.k === 'video' || e.k === 'audio')) { openViewer(e.p); return; }
  api('/api/open', { Path: e.p }).catch(fail);
}
function previewSel() {
  const es = selEntries();
  const e = es.find((x) => x.k === 'image' || x.k === 'video' || x.k === 'audio');
  if (e) openViewer(e.p);
}

// ---------------------------------------------------------------- file operations
const afterFsDirs = (dirs) => { for (const d of new Set(dirs)) invalidateTree(d); };
async function fsTransfer(paths, dest, copy) {
  if (!paths.length) return;
  try {
    const r = await api(copy ? '/api/copy' : '/api/move', { Paths: paths, Dest: dest });
    const done = r.done || [];
    if (r.errors && r.errors.length) toast(r.errors[0] + (r.errors.length > 1 ? ` (and ${r.errors.length - 1} more)` : ''), { error: true });
    else if (done.length) toast(`${copy ? 'Copied' : 'Moved'} ${done.length} item${done.length > 1 ? 's' : ''} to “${baseName(dest)}”`);
    if (!copy && done.length) {
      pushUndo('move', async () => { for (const pr of done) await api('/api/move', { Paths: [pr.to], Dest: dirOf(pr.from) }); await refresh(); afterFsDirs([dest, ...done.map((d) => dirOf(d.from))]); });
    }
    S.sel = new Set();
    await refresh();
    afterFsDirs([dest, S.path, ...done.map((d) => dirOf(d.from))]);
    if (S.sel.size === 0) renderSide();
  } catch (e) { fail(e); }
}
async function doRename(e) {
  const nv = await prompt(e.d ? 'Rename folder' : 'Rename', 'New name', e.n, { selectStem: !e.d });
  if (nv == null || nv.trim() === '' || nv === e.n) return;
  try {
    const r = await api('/api/rename', { Path: e.p, Name: nv });
    pushUndo('rename', async () => { await api('/api/rename', { Path: r.path, Name: e.n }); await refresh(); afterFsDirs([dirOf(e.p)]); });
    S.sel = new Set(); await refresh();
    selectOnly(r.path); scrollToSelected();
    afterFsDirs([dirOf(e.p)]);
  } catch (err) { fail(err); }
}
async function doTrash(es) {
  if (!es.length) return;
  if (S.confirmDelete) {
    const what = es.length === 1 ? `“${es[0].n}”` : `${es.length} items`;
    if (!(await confirmBox('Delete', `Move ${what} to the ${trashWord()}?`, 'Delete', true))) return;
  }
  try { await api('/api/trash', { Paths: es.map((e) => e.p) }); } catch (err) { fail(err); return; }
  S.sel = new Set();
  toast(`Moved ${es.length} item${es.length > 1 ? 's' : ''} to the ${trashWord()}`);
  await refresh();
  afterFsDirs([S.path]);
  renderSide();
}
async function newFolderIn(parent) {
  const name = await prompt('New folder', 'Name', 'New folder');
  if (name == null || !name.trim()) return;
  try {
    const r = await api('/api/mkdir', { Parent: parent, Name: name });
    if (samePathUI(parent, S.path)) { await refresh(); selectOnly(r.path); scrollToSelected(); }
    afterFsDirs([parent]);
    if (!NAV.open.has(parent)) { NAV.open.add(parent); await loadKids(parent, true); renderNav(); }
  } catch (e) { fail(e); }
}
function copySel(cut) {
  const es = selEntries();
  if (!es.length) return;
  S.clip = { mode: cut ? 'cut' : 'copy', paths: es.map((e) => e.p) };
  paintCut();
  toast(`${es.length} item${es.length > 1 ? 's' : ''} ${cut ? 'cut' : 'copied'} - open a folder and press Ctrl+V`);
}
async function pasteHere(dest) {
  if (!S.clip) { toast('Nothing to paste'); return; }
  const c = S.clip;
  if (c.mode === 'cut') S.clip = null;
  await fsTransfer(c.paths, dest || S.path, c.mode === 'copy');
  paintCut();
}

// ---------------------------------------------------------------- context menus
function entryMenu(x, y) {
  const es = selEntries(), one = es.length === 1 ? es[0] : null;
  const media = es.some((e) => e.k === 'image' || e.k === 'video' || e.k === 'audio');
  const pinned = one && one.d && S.pins.some((p) => samePathUI(p, one.p));
  menu(x, y, [
    one ? { label: one.d ? 'Open folder' : 'Open', icon: one.d ? 'folder' : 'ext', key: 'Enter', fn: () => openEntry(one) } : null,
    media ? { label: 'Preview', icon: 'eye', key: 'Space', fn: previewSel } : null,
    one && isMedia(one) ? { label: 'Find similar images', icon: 'sparkle', fn: () => openSimilar(one) } : null,
    { label: 'Show in Explorer', icon: 'ext', fn: () => api('/api/open', { Path: (one || es[0]).p, Reveal: true }).catch(fail) },
    '-',
    { label: 'Add tags…', icon: 'tag', fn: () => { setRightTab('tags'); setTimeout(() => { const i = $('#side .tag-in'); if (i) i.focus(); }, 50); } },
    '-',
    { label: 'Cut', icon: 'cut', key: 'Ctrl+X', fn: () => copySel(true) },
    { label: 'Copy', icon: 'copy', key: 'Ctrl+C', fn: () => copySel(false) },
    { label: one && one.d ? 'Paste into folder' : 'Paste', icon: 'paste', key: 'Ctrl+V', disabled: !S.clip, fn: () => pasteHere(one && one.d ? one.p : S.path) },
    '-',
    one ? { label: 'Rename', icon: 'edit', key: 'F2', fn: () => doRename(one) } : { label: 'Batch rename…', icon: 'edit', fn: () => openBatchRename(es) },
    { label: 'Delete', icon: 'trash', key: 'Del', danger: true, fn: () => doTrash(es) },
    '-',
    one && one.d ? { label: 'Folder preview…', icon: 'image', fn: () => folderPreviewMenu(x, y, one) } : null,
    one && !one.d && (one.k === 'image' || one.k === 'video') ? { label: 'Use as folder preview', icon: 'image', fn: () => setCover(dirOf(one.p), one.p) } : null,
    one && one.d ? { label: pinned ? 'Unpin from quick access' : 'Pin to quick access', icon: 'pin', fn: () => pinFolder(one.p, !pinned) } : null,
    { label: 'Copy path', icon: 'copy', fn: async () => { toast((await copyText(es.map((e) => e.p).join('\n'))) ? 'Path copied' : 'Could not copy'); } },
  ].filter((x) => x !== null));
}
function emptyMenu(x, y) {
  menu(x, y, [
    { label: 'New folder', icon: 'newfolder', key: 'Ctrl+Shift+N', fn: () => newFolderIn(S.path) },
    { label: 'Paste', icon: 'paste', key: 'Ctrl+V', disabled: !S.clip, fn: () => pasteHere(S.path) },
    '-',
    { label: 'Select all', key: 'Ctrl+A', fn: selectAll },
    { label: 'Refresh', icon: 'refresh', key: 'F5', fn: () => refresh() },
    { label: 'Show in Explorer', icon: 'ext', fn: () => api('/api/open', { Path: S.path }).catch(fail) },
    { label: 'Suggest tags for the untagged files here…', icon: 'sparkle', fn: () => openReview() },
  ]);
}

// ---------------------------------------------------------------- content event wiring (once)
function initContent() {
  const c = $('#content');
  const pathOf = (el) => { const t = el.closest('[data-p]'); return t ? t.dataset.p : null; };
  c.addEventListener('click', (ev) => {
    if (MARQUEE.justDragged) return; // the click that ends a rubber-band drag must not clear the selection
    if (ev.target.closest('.ghead') || ev.target.closest('.lhead')) return;
    const p = pathOf(ev.target);
    if (!p) { if (!ev.target.closest('.empty, .err-box')) { S.sel = new Set(); S.anchor = null; selectionChanged(); } return; }
    if (ev.target.closest('.chk')) { clickEntry(p, { ctrlKey: true }); return; }
    clickEntry(p, ev);
  });
  c.addEventListener('dblclick', (ev) => {
    const p = pathOf(ev.target);
    const e = p && S.byPath.get(p);
    if (e && !ev.target.closest('.chk')) openEntry(e);
  });
  c.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    const p = pathOf(ev.target);
    if (p) { if (!S.sel.has(p)) { S.sel = new Set([p]); S.anchor = S.focus = p; selectionChanged(); } entryMenu(ev.clientX, ev.clientY); }
    else { if (S.sel.size) selectOnly(null); emptyMenu(ev.clientX, ev.clientY); }
  });
  // drag & drop of files onto folders
  c.addEventListener('dragstart', (ev) => {
    const p = pathOf(ev.target);
    if (!p) return;
    if (!S.sel.has(p)) { S.sel = new Set([p]); S.anchor = S.focus = p; selectionChanged(); }
    DRAG.paths = selPaths();
    ev.dataTransfer.setData('text/plain', DRAG.paths.join('\n'));
    ev.dataTransfer.effectAllowed = 'copyMove';
  });
  const clearDrop = () => $$('#content .drop').forEach((x) => x.classList.remove('drop'));
  c.addEventListener('dragover', (ev) => {
    clearDrop();
    const t = ev.target.closest('[data-dir="1"]');
    if (!t || !DRAG.paths.length) return;
    DRAG.copy = ev.ctrlKey;
    if (!canDropOn(t.dataset.p)) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = ev.ctrlKey ? 'copy' : 'move';
    t.classList.add('drop');
  });
  c.addEventListener('drop', (ev) => {
    const t = ev.target.closest('[data-dir="1"]');
    clearDrop();
    if (!t || !DRAG.paths.length) return;
    ev.preventDefault();
    const paths = DRAG.paths.slice(); DRAG.paths = [];
    fsTransfer(paths, t.dataset.p, ev.ctrlKey);
  });
  document.addEventListener('dragend', () => { DRAG.paths = []; clearDrop(); $$('.drop').forEach((x) => x.classList.remove('drop')); });
  initMarquee(c);
}

// rubber-band selection from empty space
const MARQUEE = { justDragged: false };
function initMarquee(c) {
  let box = null, sx = 0, sy = 0, base = null, active = false, raf = 0, last = null;
  const update = () => {
    raf = 0;
    if (!box || !last) return;
    const x1 = Math.min(sx, last.clientX), x2 = Math.max(sx, last.clientX), y1 = Math.min(sy, last.clientY), y2 = Math.max(sy, last.clientY);
    Object.assign(box.style, { left: x1 + 'px', top: y1 + 'px', width: x2 - x1 + 'px', height: y2 - y1 + 'px' });
    const cr = c.getBoundingClientRect();
    const next = new Set(base);
    for (const el of $$('#content [data-p]')) {
      const r = el.getBoundingClientRect();
      if (r.bottom < cr.top || r.top > cr.bottom) continue;
      if (r.left < x2 && r.right > x1 && r.top < y2 && r.bottom > y1) next.add(el.dataset.p);
    }
    S.sel = next; paintSel();
  };
  c.addEventListener('mousedown', (ev) => {
    if (ev.button !== 0 || ev.target.closest('[data-p], .lhead, .ghead, button, a')) return;
    if (ev.offsetX > c.clientWidth || ev.target !== c && !ev.target.matches('.grid, .list, .sentinel')) return;
    ev.preventDefault(); // no text selection while rubber-banding
    c.focus({ preventScroll: true });
    active = true; sx = ev.clientX; sy = ev.clientY;
    base = ev.ctrlKey || ev.metaKey ? new Set(S.sel) : new Set();
  });
  addEventListener('mousemove', (ev) => {
    if (!active) return;
    if (!box) {
      if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < 6) return;
      box = h('div', { class: 'marquee' }); document.body.append(box);
    }
    last = ev;
    if (!raf) raf = requestAnimationFrame(update);
  });
  addEventListener('mouseup', () => {
    if (!active) return;
    active = false;
    if (box) { if (raf) cancelAnimationFrame(raf); update(); box.remove(); box = null; MARQUEE.justDragged = true; setTimeout(() => { MARQUEE.justDragged = false; }, 50); S.anchor = S.focus = S.sel.values().next().value || null; renderSide(); renderStatus(); }
  });
}

// ---------------------------------------------------------------- keyboard (called from main.js)
function contentKey(e) {
  const k = e.key, ctrl = e.ctrlKey || e.metaKey;
  if (k === 'F5') { refresh(); return true; }
  if (e.altKey && k === 'ArrowLeft') { goBack(); return true; }
  if (e.altKey && k === 'ArrowRight') { goForward(); return true; }
  if (e.altKey && k === 'ArrowUp') { goUp(); return true; }
  if (e.altKey && /^[0-5]$/.test(k)) { if (S.sel.size) ratePaths(selPaths(), +k); return true; }
  if (ctrl && k.toLowerCase() === 'a') { selectAll(); return true; }
  if (ctrl && k.toLowerCase() === 'i') { invertSel(); return true; }
  if (ctrl && k.toLowerCase() === 'c') { copySel(false); return true; }
  if (ctrl && k.toLowerCase() === 'x') { copySel(true); return true; }
  if (ctrl && k.toLowerCase() === 'v') { pasteHere(S.path); return true; }
  if (ctrl && k.toLowerCase() === 'z') { undo(); return true; }
  if (ctrl && k.toLowerCase() === 'f') { const s = $('#search'); if (s) { s.focus(); s.select(); } return true; }
  if ((ctrl && k.toLowerCase() === 'l') || k === 'F4') { editAddress(); return true; }
  if (ctrl && e.shiftKey && k.toLowerCase() === 'n') { newFolderIn(S.path); return true; }
  if (ctrl || e.altKey) return false;
  switch (k) {
    case 'ArrowRight': moveFocus(1, e.shiftKey); return true;
    case 'ArrowLeft': moveFocus(-1, e.shiftKey); return true;
    case 'ArrowDown': moveFocus(gridCols(), e.shiftKey); return true;
    case 'ArrowUp': moveFocus(-gridCols(), e.shiftKey); return true;
    case 'Home': if (S.vis.length) { selectOnly(S.vis[0].p); scrollToSelected(); } return true;
    case 'End': if (S.vis.length) { selectOnly(S.vis[S.vis.length - 1].p); scrollToSelected(); } return true;
    case 'Enter': { const es = selEntries(); if (es.length === 1) openEntry(es[0]); else es.filter((x) => x.d).slice(0, 1).forEach(openEntry); return true; }
    case ' ': previewSel(); return true;
    case 'Delete': doTrash(selEntries()); return true;
    case 'F2': { const es = selEntries(); if (es.length === 1) doRename(es[0]); else if (es.length > 1) openBatchRename(es); return true; }
    case 'Backspace': goUp(); return true;
    case 'Escape':
      if (S.sel.size) { selectOnly(null); return true; }
      if (filterActive()) { clearFilters(); return true; }
      return false;
    default:
  }
  if (/^[1-9]$/.test(k)) { toggleQuickTag(+k - 1); return true; }
  if (k.length === 1 && /\S/.test(k)) { typeAhead(k); return true; }
  return false;
}
