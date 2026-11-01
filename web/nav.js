'use strict';
// Left side: quick access, drives and the folder tree.

const NAV = { open: new Set(), kids: new Map(), loading: new Set() };
const DRAG = { paths: [] };

const placeIcon = (n) => ({ home: 'home', desktop: 'desktop', download: 'download', doc: 'doc', image: 'image', video: 'video', music: 'music' })[n] || 'folder';
const samePathUI = (a, b) => (S.os === 'windows' ? (a || '').toLowerCase() === (b || '').toLowerCase() : a === b);

function ancestry(p) {
  const out = [];
  let cur = p;
  for (let i = 0; i < 64; i++) {
    out.unshift(cur);
    const up = dirOf(cur);
    if (up === cur) break;
    cur = up;
  }
  return out;
}

// ---------------------------------------------------------------- drag & drop targets
function canDropOn(dest) {
  if (!DRAG.paths.length) return false;
  for (const p of DRAG.paths) {
    if (samePathUI(p, dest)) return false;
    if (samePathUI(dirOf(p), dest) && !DRAG.copy) return false;
    const pre = p.endsWith('\\') || p.endsWith('/') ? p : p + S.sep;
    if ((S.os === 'windows' ? dest.toLowerCase() : dest).startsWith(S.os === 'windows' ? pre.toLowerCase() : pre)) return false;
  }
  return true;
}
function dropTarget(el, getPath) {
  el.addEventListener('dragover', (e) => {
    if (!DRAG.paths.length) return;
    DRAG.copy = e.ctrlKey;
    const dest = getPath();
    if (!dest || !canDropOn(dest)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = e.ctrlKey ? 'copy' : 'move';
    el.classList.add('drop');
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop'));
  el.addEventListener('drop', (e) => {
    el.classList.remove('drop');
    const dest = getPath();
    if (!DRAG.paths.length || !dest) return;
    e.preventDefault();
    const paths = DRAG.paths.slice();
    DRAG.paths = [];
    fsTransfer(paths, dest, e.ctrlKey);
  });
}

// ---------------------------------------------------------------- tree data
async function loadKids(path, force) {
  if (!force && (NAV.kids.has(path) || NAV.loading.has(path))) return;
  NAV.loading.add(path);
  try {
    const r = await api('/api/tree?path=' + enc(path) + (S.hidden ? '&hidden=1' : ''));
    NAV.kids.set(path, r.children || []);
  } catch (e) { NAV.kids.set(path, []); }
  NAV.loading.delete(path);
}
async function toggleNode(path) {
  if (NAV.open.has(path)) { NAV.open.delete(path); renderNav(); return; }
  NAV.open.add(path);
  renderNav();
  if (!NAV.kids.has(path)) { await loadKids(path); renderNav(); }
}
async function invalidateTree(dir) {
  if (NAV.kids.has(dir) || NAV.open.has(dir)) { await loadKids(dir, true); renderNav(); }
}
async function revealInTree(path) {
  const chain = ancestry(path);
  let changed = false;
  for (const a of chain.slice(0, -1)) {
    if (!NAV.open.has(a)) { NAV.open.add(a); changed = true; }
  }
  renderNav();
  for (const a of chain.slice(0, -1)) {
    if (!NAV.kids.has(a)) { await loadKids(a); changed = true; }
  }
  if (!NAV.kids.has(path) && NAV.open.has(path)) await loadKids(path);
  if (changed) renderNav();
  const row = $('#nav .trow.active');
  if (row) row.scrollIntoView({ block: 'nearest' });
}

// ---------------------------------------------------------------- rendering
function treeMenu(e, node) {
  e.preventDefault();
  const pinned = S.pins.some((p) => samePathUI(p, node.path));
  menu(e.clientX, e.clientY, [
    { label: 'Open', icon: 'folder', fn: () => go(node.path) },
    { label: 'Show in Explorer', icon: 'ext', fn: () => api('/api/open', { Path: node.path, Reveal: true }).catch(fail) },
    '-',
    { label: pinned ? 'Unpin from quick access' : 'Pin to quick access', icon: 'pin', fn: () => pinFolder(node.path, !pinned) },
    { label: 'New folder here…', icon: 'newfolder', fn: () => newFolderIn(node.path) },
    { label: 'Refresh', icon: 'refresh', fn: () => invalidateTree(node.path) },
  ]);
}
async function pinFolder(path, on) {
  try { await api('/api/pin', { Path: path, On: on }); } catch (e) { fail(e); return; }
  S.pins = on ? [...S.pins.filter((p) => !samePathUI(p, path)), path] : S.pins.filter((p) => !samePathUI(p, path));
  renderNav();
}

function treeNode(node, depth) {
  const open = NAV.open.has(node.path);
  const kids = NAV.kids.get(node.path);
  const noKids = kids && kids.length === 0;
  const row = h('div', {
    class: 'trow' + (samePathUI(node.path, S.path) ? ' active' : ''), dataset: { path: node.path }, style: { paddingLeft: depth * 0 + 'px' },
    onclick: () => go(node.path), ondblclick: () => toggleNode(node.path), oncontextmenu: (e) => treeMenu(e, node), title: node.path,
  },
  h('span', { class: 'chev' + (noKids ? ' empty' : ''), onclick: (e) => { e.stopPropagation(); toggleNode(node.path); } }, icon(open ? 'chevD' : 'chevR', 14)),
  icon(node.root ? 'drive' : open ? 'folder' : 'folder', 16), h('span', { class: 'tn' }, node.name));
  dropTarget(row, () => node.path);
  const wrap = h('div', { class: 'tnode' }, row);
  if (open) {
    if (!kids) wrap.append(h('div', { class: 'tmore' }, 'Loading…'));
    else if (kids.length) {
      const box = h('div', { class: 'tkids' });
      const MAX = 400;
      for (const k of kids.slice(0, MAX)) box.append(treeNode(k, depth + 1));
      if (kids.length > MAX) box.append(h('div', { class: 'tmore' }, `… and ${kids.length - MAX} more (use the address bar)`));
      wrap.append(box);
    }
  }
  return wrap;
}

function quickRow(item) {
  const row = h('div', {
    class: 'trow' + (samePathUI(item.path, S.path) ? ' active' : ''), onclick: () => go(item.path), title: item.path,
    oncontextmenu: (e) => treeMenu(e, item),
  }, h('span', { class: 'chev empty' }, icon('chevR', 14)), icon(item.icon, 16), h('span', { class: 'tn' }, item.name));
  dropTarget(row, () => item.path);
  return row;
}

function renderNav() {
  const nav = $('#nav');
  if (!nav) return;
  const st = nav.scrollTop;
  const kids = [h('div', { class: 'brand' }, h('span', { class: 'logo' }, icon('tag', 15)), 'TagShelf')];
  const quick = (S.locs.quick || []).map((p) => ({ name: p.name, path: p.path, icon: placeIcon(p.icon) }));
  const have = new Set(quick.map((q) => q.path.toLowerCase()));
  for (const p of S.pins) if (!have.has(p.toLowerCase())) quick.push({ name: baseName(p), path: p, icon: 'pin', pinned: true });
  kids.push(h('div', { class: 'nsec' }, 'Quick access'));
  for (const q of quick) kids.push(quickRow(q));
  kids.push(h('div', { class: 'nsec' }, S.os === 'windows' ? 'This PC' : 'Computer'));
  for (const d of S.locs.drives || []) kids.push(treeNode({ name: d.name, path: d.path, root: true }, 0));
  kids.push(h('div', { class: 'sp' }));
  kids.push(h('div', { class: 'nsec' }, 'Tools'));
  kids.push(h('div', { class: 'nrow', onclick: () => openDownloads() }, icon('download', 16), 'New downloads', S.pending ? h('span', { class: 'badge' }, S.pending) : null));
  kids.push(h('div', { class: 'nrow', onclick: () => openTagManager() }, icon('tag', 16), 'Manage tags'));
  if (S.missing) kids.push(h('div', { class: 'nrow', onclick: () => openMissing() }, icon('alert', 16), 'Missing files', h('span', { class: 'badge' }, S.missing)));
  kids.push(h('div', { class: 'nrow', onclick: () => openSettings() }, icon('settings', 16), 'Settings'));
  kids.push(h('div', { class: 'nrow', onclick: quitApp }, icon('x', 16), 'Quit TagShelf'));
  nav.replaceChildren(...kids);
  nav.scrollTop = st;
}

async function quitApp() {
  const bg = S.prefs && S.prefs.background;
  const ok = await confirmBox('Quit TagShelf?', bg ? 'This stops TagShelf completely, including the download watcher that runs in the background.' : 'TagShelf will close.', 'Quit', false);
  if (!ok) return;
  try { await api('/api/quit', {}); } catch (e) { /* already gone */ }
  document.body.replaceChildren(h('div', { class: 'empty', style: { height: '100vh' } }, h('b', {}, 'TagShelf has quit'), h('span', {}, 'You can close this window. Start TagShelf.exe again any time.')));
  setTimeout(() => window.close(), 400);
}
