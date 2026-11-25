'use strict';
// Content types. Every picture or video is a Panel; Scene, Story and Series are set by you on a folder
// or a single file (a comic page, a PDF, an ISO...). What a folder belongs to follows from where it sits.

const CT = {
  panel: { label: 'Panel', many: 'Panels', icon: 'image', color: '#6f8fff', help: 'A single picture or video: one action, a loop.' },
  scene: { label: 'Scene', many: 'Scenes', icon: 'film', color: '#1fb39d', help: 'A few actions in one place and time: a folder of panels or one file.' },
  story: { label: 'Story', many: 'Stories', icon: 'book', color: '#e3972b', help: 'Scenes that make a full story: a folder or one file.' },
  series: { label: 'Series', many: 'Series', icon: 'stack', color: '#a479ff', help: 'Stories (or scenes) that belong together: usually a folder.' },
};
const CT_ORDER = ['panel', 'scene', 'story', 'series'];
const CT_MARKS = ['scene', 'story', 'series'];

// what an entry is: its mark, else Panel for pictures and videos
function ctypeOf(e) { return e.c || (!e.d && (e.k === 'image' || e.k === 'video') ? 'panel' : ''); }
const canPlay = (e) => (e.c === 'scene' || e.c === 'story') && (e.d || e.k === 'image' || e.k === 'video');

function ctBadge(c, opt = {}) {
  const t = CT[c];
  if (!t || (c === 'panel' && !opt.panel)) return null;
  return h('span', { class: 'ctb' + (opt.small ? ' small' : ''), style: { '--ct': t.color }, title: t.label }, icon(t.icon, opt.small ? 11 : 12), opt.small ? null : h('span', {}, t.label));
}

// ---------------------------------------------------------------- marking
async function setCtype(paths, c, opt = {}) {
  paths = paths.filter(Boolean);
  if (!paths.length) return;
  const before = {};
  for (const p of paths) { const e = S.byPath.get(p); before[p] = (e && e.c) || ''; }
  let r;
  try { r = await api('/api/ctype/set', { Paths: paths, Type: c }); } catch (e) { fail(e); return; }
  applyCtypes(r.types || {});
  if (!opt.quiet) {
    const n = Object.keys(r.types || {}).length;
    toast(c ? `${n === 1 ? 'Marked' : n + ' items marked'} as ${CT[c].label.toLowerCase()}` : (n === 1 ? 'Mark removed' : `${n} marks removed`));
    pushUndo('content type', async () => {
      const groups = {};
      for (const [p, v] of Object.entries(before)) (groups[v] = groups[v] || []).push(p);
      for (const [v, ps] of Object.entries(groups)) applyCtypes((await api('/api/ctype/set', { Paths: ps, Type: v })).types || {});
    });
  }
}
function applyCtypes(map) {
  for (const [p, c] of Object.entries(map)) {
    const e = S.byPath.get(p);
    if (e) e.c = c || undefined;
    if (typeof COVERS !== 'undefined') COVERS.delete(p);
  }
  if (S.mode === 'shelf') { if (typeof shelfRefreshSoon === 'function') shelfRefreshSoon(); }
  else { SH.home = null; recompute(); renderContent(); renderSide(); renderFilterbar(); renderStatus(); }
}

async function setNoplay(paths, on) {
  try { await api('/api/ctype/noplay', { Paths: paths, On: on }); } catch (e) { fail(e); return; }
  for (const p of paths) { const e = S.byPath.get(p); if (e) e.np = on || undefined; }
  toast(on ? 'Left out when its scene or story plays' : 'Plays with its scene or story again');
  if (S.mode !== 'shelf') { renderContent(); renderSide(); }
}

// right-click menu: "Content type…" opens this second menu at the same spot
function ctypeMenu(x, y, es) {
  const cur = new Set(es.map((e) => e.c || ''));
  const one = cur.size === 1 ? [...cur][0] : null;
  const paths = es.map((e) => e.p);
  menu(x, y, [
    ...CT_MARKS.map((c) => ({ label: (one === c ? '✓ ' : '') + CT[c].label, icon: CT[c].icon, fn: () => setCtype(paths, one === c ? '' : c) })),
    '-',
    { label: es.some((e) => !e.d) && es.every((e) => !e.d && (e.k === 'image' || e.k === 'video')) ? 'None (panel)' : 'None', icon: 'x', disabled: one === '', fn: () => setCtype(paths, '') },
  ]);
}

// menu entries for Files and the Shelf
function ctypeMenuItems(es, x, y) {
  const one = es.length === 1 ? es[0] : null;
  const media = es.filter((e) => !e.d && (e.k === 'image' || e.k === 'video'));
  return [
    { label: 'Content type…', icon: 'film', fn: () => ctypeMenu(x, y, es) },
    one && canPlay(one) ? { label: 'Play ' + CT[one.c].label.toLowerCase(), icon: 'play', fn: () => openPlayer(one.p) } : null,
    one && one.c === 'series' ? { label: 'Open series page', icon: 'stack', fn: () => openItemPage(one.p) } : null,
    one && one.c && !one.d ? { label: 'Choose preview…', icon: 'image', fn: () => openItemCoverPicker(one) } : null,
    one && one.c && !one.d ? { label: 'Automatic preview', icon: 'refresh', fn: () => setItemCover(one.p, '') } : null,
    media.length && media.length === es.length ? (media.every((e) => e.np)
      ? { label: 'Play with its scene again', icon: 'play', fn: () => setNoplay(media.map((e) => e.p), false) }
      : { label: 'Leave out when playing', icon: 'eye', fn: () => setNoplay(media.map((e) => e.p), true) }) : null,
  ].filter(Boolean);
}

// ---------------------------------------------------------------- chosen previews (scenes, stories and series)
async function setItemCover(p, image) {
  try { await api('/api/folder/cover', { Folder: p, Image: image }); } catch (e) { fail(e); return; }
  if (typeof COVERS !== 'undefined') COVERS.delete(p);
  toast(image ? 'Preview set' : 'Preview is automatic again');
  if (S.mode === 'shelf') shelfRefresh(); else renderContent();
}

// pick a picture or video from inside the folder (and its subfolders), or next to a single file
async function openItemCoverPicker(it) {
  const dir = it.d ? it.p : dirOf(it.p);
  let r;
  try { r = await api('/api/list?path=' + enc(dir) + '&sub=1'); } catch (e) { fail(e); return; }
  const pics = (r.entries || []).filter((e) => !e.d && (e.k === 'image' || e.k === 'video')).slice(0, 600);
  if (!pics.length) { toast(it.d ? 'There are no pictures or videos in this folder' : 'There are no pictures or videos next to this file - put one in its folder first'); return; }
  let chosen = null;
  const grid = h('div', { class: 'pickgrid' });
  const use = async () => { if (!chosen) return false; await setItemCover(it.p, chosen); };
  for (const e of pics) {
    const t = h('button', { class: 'pk', title: e.rel || e.n, onclick: () => { chosen = e.p; for (const x of grid.children) x.classList.toggle('on', x === t); },
      ondblclick: async () => { chosen = e.p; await use(); m.close(); } }, coverCell({ p: e.p, k: e.k, x: e.x, m: e.m }, true));
    grid.append(t);
  }
  const name = it.d ? baseName(it.p) : (it.n || baseName(it.p));
  const m = modal('Choose a preview for “' + name + '”', h('div', {}, h('p', { class: 'hint' }, it.d ? 'Pictures and videos inside it (subfolders too). Click one, then “Use this picture”.' : 'Pictures and videos in the same folder. Click one, then “Use this picture”.'), grid),
    [{ label: 'Cancel' }, { label: 'Use this picture', primary: true, fn: use }], { wide: true });
}

// ---------------------------------------------------------------- finding folders by their names
async function openTypeFinder(root) {
  root = root || S.path;
  if (!root) return;
  const wait = modal('Find scenes, stories and series', h('p', { class: 'hint' }, 'Looking through “' + baseName(root) + '” and its subfolders…'), []);
  let r;
  try { r = await api('/api/ctype/detect', { Path: root }); } catch (e) { wait.close(); fail(e); return; }
  wait.close();
  const items = (r.items || []).filter((x) => x.cur !== x.c);
  if (!items.length) {
    toast((r.items || []).length ? 'Everything found is already marked' : 'No folder here has “scene”, “story”, “novel” or “series” in its name');
    return;
  }
  const pick = new Map(items.map((x) => [x.p, x.c]));
  const list = h('div', { class: 'tfind' });
  const draw = () => list.replaceChildren(...items.map((x) => {
    const c = pick.get(x.p);
    const sel = h('select', { class: 'txt small', onchange: (e) => { if (e.target.value) pick.set(x.p, e.target.value); else pick.delete(x.p); draw(); } },
      h('option', { value: '' }, 'Skip'), CT_MARKS.map((v) => h('option', { value: v, selected: v === c }, CT[v].label)));
    return h('div', { class: 'tfrow' + (c ? '' : ' off') }, h('input', { type: 'checkbox', checked: !!c, onchange: (e) => { if (e.target.checked) pick.set(x.p, x.c); else pick.delete(x.p); draw(); } }),
      c ? ctBadge(c, { small: true }) : h('span', { class: 'ctb small none' }),
      h('span', { class: 'tfname', title: x.p }, h('b', {}, x.n), h('em', {}, dirOf(x.p))),
      x.cur ? h('span', { class: 'muted' }, 'now ' + CT[x.cur].label) : null, sel);
  }));
  draw();
  const counts = () => CT_MARKS.map((c) => [c, [...pick.values()].filter((v) => v === c).length]).filter(([, n]) => n).map(([c, n]) => `${n} ${n === 1 ? CT[c].label.toLowerCase() : CT[c].many.toLowerCase()}`).join(', ');
  modal('Found by folder name', h('div', {}, h('p', { class: 'hint', style: { marginTop: 0 } },
    `${items.length} folder${items.length === 1 ? '' : 's'} in “${baseName(root)}” ${items.length === 1 ? 'has' : 'have'} a name that says what ${items.length === 1 ? 'it is' : 'they are'}. Untick or change any that are wrong, then apply.` + (r.partial ? ' (The folder is very big: only part of it was searched.)' : '')), list),
  [{ label: 'Cancel' }, { label: 'Apply', primary: true, fn: async () => {
    const groups = {};
    for (const [p, c] of pick) (groups[c] = groups[c] || []).push(p);
    for (const [c, ps] of Object.entries(groups)) await setCtype(ps, c, { quiet: true });
    toast(counts() ? 'Marked ' + counts() : 'Nothing marked');
  } }], { wide: true });
}
