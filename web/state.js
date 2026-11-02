'use strict';
// ---------------------------------------------------------------- state
const defaultFilter = () => ({ q: '', inc: [], exc: [], any: false, untagged: false, kinds: [], minRating: 0 });
const S = {
  path: '', parent: '', hist: [], hi: -1, entries: [], vis: [], byPath: new Map(), truncated: false, loading: false, error: '', navSeq: 0,
  sub: false, hidden: false,
  sel: new Set(), anchor: null,
  f: defaultFilter(),
  sort: 'name', desc: false, group: 'none', folderPrev: 'mosaic', dirsFirst: true, view: 'grid', size: 190, fit: 'cover', theme: 'dark',
  dbl: 'system', tagShow: 'names', ai: true, confirmDelete: true, welcomed: false, bgAsked: false, lastPath: '', navw: 270, sidew: 340,
  tags: [], tagMap: {}, pins: [], views: [], prefs: {}, locs: { quick: [], drives: [] }, recent: [], missing: 0,
  os: '', sep: '\\', home: '', downloads: '', autostart: false, vectors: 0,
  clip: null, undo: [], tagClip: [], rightTab: 'tags', pending: 0,
};
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const SAVED = ['folderPrev', 'group', 'view', 'size', 'fit', 'theme', 'sort', 'desc', 'dirsFirst', 'dbl', 'tagShow', 'ai', 'confirmDelete', 'hidden', 'welcomed', 'bgAsked', 'lastPath', 'navw', 'sidew', 'rightTab'];
const saveSettingsSoon = debounce(() => {
  const o = {}; for (const k of SAVED) o[k] = S[k];
  api('/api/settings', o).catch(() => {});
}, 600);

function setTags(list) {
  S.tags = list || [];
  S.tagMap = {};
  for (const t of S.tags) S.tagMap[t.name] = t;
}

async function loadState() {
  const st = await api('/api/state');
  const set = st.settings || {};
  for (const k of SAVED) if (set[k] !== undefined) S[k] = set[k];
  setTags(st.tags);
  Object.assign(S, { pins: st.pins || [], views: st.views || [], prefs: st.prefs || {}, recent: st.recent || [], missing: st.missing || 0,
    os: st.os, sep: st.sep, home: st.home || '', downloads: st.downloads || '', autostart: !!st.autostart, vectors: st.vectors || 0, pending: st.pending || 0 });
  applyLook();
}
function applyLook() {
  document.documentElement.dataset.theme = S.theme;
  document.documentElement.style.setProperty('--tile', S.size + 'px');
  document.documentElement.style.setProperty('--fit', S.fit);
  document.documentElement.style.setProperty('--navw', S.navw + 'px');
  document.documentElement.style.setProperty('--sidew', S.sidew + 'px');
}

// ---------------------------------------------------------------- filtering & sorting
function filterActive() { const f = S.f; return !!(f.q || f.inc.length || f.exc.length || f.untagged || f.kinds.length || f.minRating); }
function passes(e) {
  const f = S.f, t = e.t || [];
  if (f.q) {
    const q = f.q.toLowerCase();
    if (!(e.n.toLowerCase().includes(q) || (e.rel || '').toLowerCase().includes(q) || t.some((x) => x.toLowerCase().includes(q)))) return false;
  }
  if (f.kinds.length && !f.kinds.includes(e.d ? 'folder' : e.k)) return false;
  if (f.minRating && (e.r || 0) < f.minRating) return false;
  if (f.untagged && t.length) return false;
  for (const x of f.exc) if (t.includes(x)) return false;
  if (f.inc.length) return f.any ? f.inc.some((x) => t.includes(x)) : f.inc.every((x) => t.includes(x));
  return true;
}
function cmpEntries(a, b) {
  if (S.dirsFirst && !!a.d !== !!b.d) return a.d ? -1 : 1;
  let r = 0;
  switch (S.sort) {
    case 'date': r = a.m - b.m; break;
    case 'size': r = a.s - b.s; break;
    case 'type': r = collator.compare(a.d ? '' : a.x || '', b.d ? '' : b.x || ''); break;
    case 'rating': r = (a.r || 0) - (b.r || 0); break;
    default: r = 0;
  }
  if (!r) r = collator.compare(a.n, b.n);
  return S.desc ? -r : r;
}
function recompute() {
  S.vis = S.entries.filter(passes).sort(cmpEntries);
  const keep = new Set(S.vis.map((e) => e.p));
  for (const p of S.sel) if (!keep.has(p)) S.sel.delete(p);
}
function indexEntries() { S.byPath = new Map(S.entries.map((e) => [e.p, e])); }
const selPaths = () => Array.from(S.sel);
const selEntries = () => selPaths().map((p) => S.byPath.get(p)).filter(Boolean);

// ---------------------------------------------------------------- navigation
function listUrl(path) { return '/api/list?path=' + enc(path) + (S.sub ? '&sub=1' : '') + (S.hidden ? '&hidden=1' : ''); }

async function go(path, opt = {}) {
  if (!path) return;
  const seq = ++S.navSeq;
  S.loading = true; S.error = '';
  renderContent();
  let r;
  try { r = await api(listUrl(path)); }
  catch (e) {
    if (seq !== S.navSeq) return;
    S.loading = false;
    if (opt.initial) { S.path = ''; S.entries = []; indexEntries(); S.error = e.message; recompute(); renderAll(); return; }
    toast(e.message, { error: true }); renderContent(); return;
  }
  if (seq !== S.navSeq) return;
  S.loading = false;
  const changedFolder = r.path !== S.path;
  if (opt.push !== false && changedFolder) { S.hist = S.hist.slice(0, S.hi + 1); S.hist.push(r.path); S.hi = S.hist.length - 1; }
  S.path = r.path; S.parent = r.parent; S.entries = r.entries; S.truncated = r.truncated;
  indexEntries();
  if (!opt.keepSel) { S.sel.clear(); S.anchor = null; }
  if (opt.select) { for (const p of [].concat(opt.select)) if (S.byPath.has(p)) S.sel.add(p); S.anchor = [].concat(opt.select)[0]; }
  if (changedFolder && !opt.keepFilter) { S.f = defaultFilter(); }
  recompute();
  if (r.relinked) toast(`${r.relinked} file${r.relinked > 1 ? 's' : ''} found again after being moved - tags restored`);
  if (S.lastPath !== r.path) { S.lastPath = r.path; saveSettingsSoon(); }
  renderAll();
  if (changedFolder) { $('#content').scrollTop = 0; revealInTree(r.path); }
  if (opt.select) scrollToSelected();
  if (typeof onFolderLoaded === 'function') onFolderLoaded();
}
const goBack = () => { if (S.hi > 0) { S.hi--; go(S.hist[S.hi], { push: false }); } };
const goForward = () => { if (S.hi < S.hist.length - 1) { S.hi++; go(S.hist[S.hi], { push: false }); } };
const goUp = () => { if (S.parent) go(S.parent, { select: [S.path] }); };

async function refresh(opt = {}) {
  if (!S.path) return;
  const seq = S.navSeq;
  let r;
  try { r = await api(listUrl(S.path)); } catch (e) { if (!opt.silent) fail(e); return; }
  if (seq !== S.navSeq || r.path !== S.path) return;
  if (opt.silent) {
    const sig = (arr) => arr.map((e) => e.p + '|' + e.s + '|' + e.m + '|' + (e.t || []).join(',') + '|' + (e.r || 0)).join('\n');
    if (sig(r.entries) === sig(S.entries)) return;
  }
  S.entries = r.entries; S.truncated = r.truncated; indexEntries(); recompute();
  if (r.relinked) toast(`${r.relinked} file${r.relinked > 1 ? 's' : ''} found again after being moved - tags restored`);
  renderContent(); renderSide(); renderStatus(); renderFilterbar();
}

// ---------------------------------------------------------------- undo
function pushUndo(label, fn) { S.undo.push({ label, fn }); if (S.undo.length > 30) S.undo.shift(); }
async function undo() {
  const u = S.undo.pop();
  if (!u) { toast('Nothing to undo'); return; }
  try { await u.fn(); toast('Undone: ' + u.label); } catch (e) { fail(e); }
}

// ---------------------------------------------------------------- tags
function applyTagResult(r) {
  if (r.all) setTags(r.all);
  for (const [p, tags] of Object.entries(r.tags || {})) {
    const e = S.byPath.get(p);
    if (e) { e.t = tags && tags.length ? tags : undefined; }
  }
}
function afterTagChange() {
  recompute();
  renderContent(); renderSide(); renderFilterbar(); renderStatus();
  if (typeof viewerTagsChanged === 'function') viewerTagsChanged();
}
async function tagPaths(paths, add, remove, label) {
  paths = paths.filter(Boolean);
  if (!paths.length) return;
  const before = {};
  for (const p of paths) { const e = S.byPath.get(p); before[p] = e && e.t ? e.t.slice() : []; }
  try {
    const r = await api('/api/tags/apply', { Paths: paths, Add: add, Remove: remove });
    applyTagResult(r);
  } catch (e) { fail(e); return; }
  pushUndo(label || 'tag change', async () => { applyTagResult(await api('/api/tags/set', { Items: before })); afterTagChange(); });
  afterTagChange();
  if (add.length) aiForget();
}
async function ratePaths(paths, rating) {
  try { await api('/api/rate', { Paths: paths, Rating: rating }); } catch (e) { fail(e); return; }
  for (const p of paths) { const e = S.byPath.get(p); if (e) e.r = rating || undefined; }
  recompute(); renderContent(); renderSide(); renderStatus();
}

// ---------------------------------------------------------------- filters
function toggleInc(name) {
  const f = S.f;
  f.exc = f.exc.filter((x) => x !== name);
  f.inc = f.inc.includes(name) ? f.inc.filter((x) => x !== name) : [...f.inc, name];
  afterFilterChange();
}
function toggleExc(name) {
  const f = S.f;
  f.inc = f.inc.filter((x) => x !== name);
  f.exc = f.exc.includes(name) ? f.exc.filter((x) => x !== name) : [...f.exc, name];
  afterFilterChange();
}
function clearFilters() { S.f = defaultFilter(); afterFilterChange(); }
function afterFilterChange() { recompute(); renderTop(); renderContent(); renderSide(); renderFilterbar(); renderStatus(); }
function folderTagCounts() {
  const m = new Map();
  for (const e of S.entries) for (const t of e.t || []) m.set(t, (m.get(t) || 0) + 1);
  return m;
}
