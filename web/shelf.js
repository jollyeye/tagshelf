'use strict';
// Shelf: the media-center mode. Tags become pages (every file with that tag, from every folder),
// grouped into categories whose layout preset decides how their cards and pages look.

const SH = { view: 'home', cat: '', tag: '', tab: 'all', home: null, page: null, hist: [], byPath: new Map(), shown: 0, q: '', seq: 0 };
const PRESET_SHAPE = { banner: 'land', profile: 'port', gallery: 'sq', timeline: 'land' };
const PRESET_NAMES = { banner: 'Banner', profile: 'Profile', gallery: 'Gallery', timeline: 'Timeline' };
const PAGE_CHUNK = 240;

function catById(id) { return (S.categories || []).find((c) => c.id === id); }
function shapeOfCat(id) { const c = catById(id); return PRESET_SHAPE[(c && c.preset) || 'banner'] || 'land'; }

// ---------------------------------------------------------------- switching modes
function modeSwitch() {
  const b = (m, ic, label, key) => h('button', { class: 'mode-b' + (S.mode === m ? ' on' : ''), title: `${label} (Ctrl+${key})`, onclick: () => setMode(m) }, icon(ic, 15), label);
  return h('div', { class: 'mode-sw' }, b('files', 'folder', 'Files', 1), b('shelf', 'grid', 'Shelf', 2));
}

async function setMode(m, opt = {}) {
  if (m !== 'files' && m !== 'shelf') return;
  const changed = S.mode !== m;
  S.mode = m;
  if (changed) saveSettingsSoon();
  document.body.classList.toggle('mode-shelf', m === 'shelf');
  if (m === 'shelf') {
    closeMenu();
    renderNav();
    if (opt.tag) { await openTagPage(opt.tag, { push: changed || SH.view !== 'tag' }); refreshHomeQuiet(); }
    else await shelfLoad(SH.view === 'home' || !SH.home);
  } else {
    renderNav();
    if (changed && !opt.noRefresh) refresh({ silent: true });
    $('#content').focus({ preventScroll: true });
  }
}

// ---------------------------------------------------------------- navigation inside the Shelf
function shelfPush() { SH.hist.push({ view: SH.view, cat: SH.cat, tag: SH.tag, tab: SH.tab }); if (SH.hist.length > 50) SH.hist.shift(); }
async function shelfBack() {
  const p = SH.hist.pop();
  if (!p) return;
  Object.assign(SH, p);
  if (SH.view === 'tag') await openTagPage(SH.tag, { push: false, tab: SH.tab }); else await shelfLoad(true);
}
async function shelfHome() { if (SH.view !== 'home') shelfPush(); SH.view = 'home'; SH.q = ''; await shelfLoad(true); }
async function shelfCategory(id) { if (SH.view !== 'cat' || SH.cat !== id) shelfPush(); SH.view = 'cat'; SH.cat = id; SH.q = ''; await shelfLoad(true); }

async function shelfLoad(fetchHome) {
  if (fetchHome || !SH.home) {
    const seq = ++SH.seq;
    try {
      const r = await api('/api/shelf/home');
      if (seq !== SH.seq) return;
      SH.home = r;
      S.categories = r.categories.map(({ id, name, color, preset }) => ({ id, name, color, preset }));
    } catch (e) { fail(e); return; }
  }
  renderNav();
  renderShelf();
}

async function openTagPage(name, opt = {}) {
  const seq = ++SH.seq;
  let r;
  try { r = await api('/api/shelf/tag', { Name: name }); } catch (e) { fail(e); return; }
  if (seq !== SH.seq) return;
  if (opt.push !== false && !(SH.view === 'tag' && SH.tag === r.name)) shelfPush();
  SH.view = 'tag'; SH.tag = r.name; SH.page = r; SH.tab = opt.tab || (opt.keepTab && SH.tab) || 'all'; SH.shown = PAGE_CHUNK;
  SH.byPath = new Map(r.files.map((f) => [f.p, f]));
  if (S.mode !== 'shelf') { S.mode = 'shelf'; saveSettingsSoon(); document.body.classList.add('mode-shelf'); }
  renderNav();
  renderShelf();
  $('#shelf .sbody').scrollTop = 0;
}

// the home data also feeds the counts in the left panel: keep it fresh while a tag page is open
async function refreshHomeQuiet() {
  try { const r = await api('/api/shelf/home'); SH.home = r; S.categories = r.categories.map(({ id, name, color, preset }) => ({ id, name, color, preset })); renderNav(); } catch (e) { /* next time */ }
}

// refresh what is on screen (after tags changed somewhere)
async function shelfRefresh() {
  if (S.mode !== 'shelf') { SH.home = null; return; }
  const top = ($('#shelf .sbody') || {}).scrollTop || 0;
  if (SH.view === 'tag') { await openTagPage(SH.tag, { push: false, keepTab: true }); refreshHomeQuiet(); } else await shelfLoad(true);
  const b = $('#shelf .sbody'); if (b) b.scrollTop = top;
}
const shelfRefreshSoon = debounce(shelfRefresh, 400);

// ---------------------------------------------------------------- left panel in Shelf mode
function shelfNavItems() {
  const kids = [];
  const row = (ic, label, on, fn, extra = {}) => h('div', { class: 'nrow' + (on ? ' active' : ''), onclick: fn, ...extra }, ic, h('span', { class: 'nlabel' }, label), extra.count != null ? h('span', { class: 'ncount' }, extra.count) : null);
  kids.push(row(icon('home', 16), 'Home', SH.view === 'home', shelfHome));
  kids.push(h('div', { class: 'nsec' }, 'Categories', h('button', { class: 'ibtn', title: 'New category', style: { width: '22px', height: '22px' }, onclick: () => newCategory() }, icon('plus', 13))));
  const home = SH.home || { categories: [], uncategorized: [] };
  for (const c of S.categories || []) {
    const n = ((home.categories.find((x) => x.id === c.id) || {}).tags || []).length;
    kids.push(h('div', { class: 'nrow' + (SH.view === 'cat' && SH.cat === c.id ? ' active' : ''), onclick: () => shelfCategory(c.id),
      oncontextmenu: (e) => { e.preventDefault(); categoryMenu(e.clientX, e.clientY, c); } },
      h('span', { class: 'cdot', style: { background: c.color } }), h('span', { class: 'nlabel' }, c.name), h('span', { class: 'ncount' }, n)));
  }
  kids.push(h('div', { class: 'nrow' + (SH.view === 'cat' && SH.cat === '' ? ' active' : ''), onclick: () => shelfCategory('') },
    h('span', { class: 'cdot', style: { background: '#9aa5b8' } }), h('span', { class: 'nlabel' }, 'Uncategorized'), h('span', { class: 'ncount' }, (home.uncategorized || []).length)));
  kids.push(h('div', { class: 'nrow add', onclick: () => newCategory() }, icon('plus', 15), 'New category'));
  if (SH.view === 'tag' && SH.page) {
    kids.push(h('div', { class: 'nsec' }, 'Open page'));
    kids.push(h('div', { class: 'nrow active' }, h('span', { class: 'cdot round', style: { background: SH.page.color } }), h('span', { class: 'nlabel' }, SH.page.name)));
  }
  return kids;
}

// ---------------------------------------------------------------- categories
async function newCategory(thenTags) {
  const name = await prompt('New category', 'Name', '', { help: 'For example “Topics”, “Characters” or “Places”. You choose its layout afterwards.', ok: 'Create' });
  if (name == null || !name.trim()) return null;
  try {
    const r = await api('/api/category/create', { Name: name, Preset: 'banner' });
    S.categories = r.categories;
    if (thenTags && thenTags.length) await setTagCategory(thenTags, r.category.id, true);
    await shelfLoad(true);
    toast(`Category “${r.category.name}” created`);
    return r.category;
  } catch (e) { fail(e); return null; }
}

async function setTagCategory(names, id, quiet) {
  try {
    const r = await api('/api/tag/category', { Names: names, Category: id });
    if (r.all) setTags(r.all);
  } catch (e) { fail(e); return; }
  const c = catById(id);
  if (!quiet) toast(names.length === 1 ? `“${names[0]}” is now in ${c ? '“' + c.name + '”' : 'no category'}` : `${names.length} tags moved`);
  if (S.mode === 'shelf') shelfRefresh();
}

function categoryMenu(x, y, c) {
  menu(x, y, [
    { label: 'Open', icon: 'grid', fn: () => shelfCategory(c.id) },
    { label: 'Rename…', icon: 'edit', fn: async () => {
      const n = await prompt('Rename category', 'Name', c.name);
      if (n == null || !n.trim()) return;
      try { S.categories = (await api('/api/category/update', { ID: c.id, Name: n })).categories; await shelfLoad(true); } catch (e) { fail(e); }
    } },
    { label: 'Layout…', icon: 'grid', fn: () => categoryLayout(c) },
    { label: 'Colour…', icon: 'tag', fn: () => pickColor(c.color, async (v) => { try { S.categories = (await api('/api/category/update', { ID: c.id, Color: v })).categories; await shelfLoad(true); } catch (e) { fail(e); } }) },
    '-',
    { label: 'Move up', icon: 'up', fn: () => moveCategory(c.id, -1) },
    { label: 'Move down', icon: 'down', fn: () => moveCategory(c.id, 1) },
    '-',
    { label: 'Delete category', icon: 'trash', danger: true, fn: async () => {
      if (!(await confirmBox('Delete category', `Delete “${c.name}”? Its tags stay; they just become uncategorized.`, 'Delete', true))) return;
      try { const r = await api('/api/category/delete', { ID: c.id }); S.categories = r.categories; if (r.all) setTags(r.all); if (SH.cat === c.id) SH.view = 'home'; await shelfLoad(true); } catch (e) { fail(e); }
    } },
  ]);
}

async function moveCategory(id, d) {
  const ids = (S.categories || []).map((c) => c.id);
  const i = ids.indexOf(id), j = i + d;
  if (i < 0 || j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  try { S.categories = (await api('/api/category/order', { IDs: ids })).categories; await shelfLoad(true); } catch (e) { fail(e); }
}

function pickColor(value, fn) {
  const inp = h('input', { type: 'color', value: /^#[0-9a-f]{6}$/i.test(value) ? value : '#7c9cff', style: { position: 'fixed', left: '-100px' } });
  inp.addEventListener('change', () => { fn(inp.value); inp.remove(); });
  document.body.append(inp);
  inp.click();
}

// Layout preset of a category (step 1: the preset; tabs and sections come with the full editor)
function categoryLayout(c) {
  let preset = c.preset || 'banner';
  const sketches = {
    banner: [['0', '0', '100%', '40%'], ['8%', '50%', '45%', '8%'], ['8%', '66%', '84%', '18%', .25]],
    profile: [['8%', '10%', '26%', '78%'], ['42%', '18%', '45%', '10%'], ['42%', '38%', '35%', '7%']],
    gallery: [0, 1, 2, 3, 4, 5, 6, 7].map((i) => [8 + (i % 4) * 22 + '%', 10 + Math.floor(i / 4) * 44 + '%', '18%', '36%']),
    timeline: [['8%', '10%', '5%', '80%'], ['20%', '12%', '65%', '14%'], ['20%', '42%', '65%', '14%'], ['20%', '72%', '65%', '14%']],
  };
  const what = { banner: 'Wide banner picture on top. Wide cards.', profile: 'Poster picture beside the name, like a profile. Poster cards.', gallery: 'Just the pictures, as big square tiles. Square cards.', timeline: 'Files grouped by month, newest first. Wide cards.' };
  const grid = h('div', { class: 'presets' });
  const info = h('p', { class: 'hint' });
  const draw = () => {
    grid.replaceChildren(...Object.keys(PRESET_NAMES).map((p) => h('button', { class: 'pre' + (p === preset ? ' on' : ''), onclick: () => { preset = p; draw(); } },
      h('div', { class: 'sk' }, sketches[p].map(([l, t, w, hh, o]) => h('i', { style: { left: l, top: t, width: w, height: hh, opacity: o || .5 } }))), PRESET_NAMES[p])));
    info.textContent = what[preset];
  };
  draw();
  modal(`“${c.name}” layout`, h('div', {}, h('p', { class: 'hint', style: { marginTop: 0 } }, 'Applies to every tag page in this category and to its cards on the Shelf home.'), grid, info),
    [{ label: 'Cancel' }, { label: 'Save', primary: true, fn: async () => {
      try { S.categories = (await api('/api/category/update', { ID: c.id, Preset: preset })).categories; await shelfLoad(true); } catch (e) { fail(e); return false; }
    } }]);
}

// right-click on any tag chip or tag card
function tagMenu(x, y, name) {
  const t = S.tagMap[name];
  const cur = t && t.category || '';
  const items = [{ label: 'Open tag page', icon: 'grid', fn: () => setMode('shelf', { tag: name }) }, '-'];
  for (const c of S.categories || []) items.push({ label: (c.id === cur ? '✓ ' : '') + 'Category: ' + c.name, fn: () => setTagCategory([name], c.id) });
  if (cur) items.push({ label: 'No category', fn: () => setTagCategory([name], '') });
  items.push({ label: 'New category…', icon: 'plus', fn: () => newCategory([name]) });
  menu(x, y, items);
}

// ---------------------------------------------------------------- drawing
function renderShelf() {
  const root = $('#shelf');
  if (!root || S.mode !== 'shelf') return;
  let title = 'Home', body;
  if (SH.view === 'tag' && SH.page) { title = SH.page.name; body = tagPageEl(SH.page); }
  else if (SH.view === 'cat') { const c = catById(SH.cat); title = c ? c.name : 'Uncategorized'; body = categoryEl(); }
  else body = homeEl();
  const search = h('input', { class: 'txt ssearch', type: 'search', placeholder: 'Find a tag…', value: SH.q, spellcheck: 'false' });
  search.addEventListener('input', debounce(() => { SH.q = search.value; const b = $('#shelf .sbody'); const nb = SH.view === 'tag' ? null : (SH.view === 'cat' ? categoryEl() : homeEl()); if (b && nb) b.replaceChildren(nb); }, 150));
  search.addEventListener('keydown', (e) => { if (e.key === 'Escape') { search.value = ''; SH.q = ''; search.dispatchEvent(new Event('input')); } e.stopPropagation(); });
  root.replaceChildren(
    h('header', { class: 'stop' },
      h('button', { class: 'ibtn', title: 'Back (Alt+←)', disabled: !SH.hist.length, onclick: shelfBack }, icon('back', 18)),
      h('b', { class: 'stitle' }, title),
      SH.view !== 'tag' ? search : null),
    h('div', { class: 'sbody', tabindex: '-1' }, body));
}

function cardEl(t, shape, opt = {}) {
  const pic = t.cover ? coverCell(t.cover, false) : h('div', { class: 'cc' }, h('div', { class: 'cc-ico' }, icon('tag', 28)));
  const sub = opt.sub || `${t.count} file${t.count === 1 ? '' : 's'}`;
  return h('div', { class: 'scard ' + shape, title: `${t.name} · ${sub}`, dataset: { tag: t.name },
    onclick: () => openTagPage(t.name), oncontextmenu: (e) => { e.preventDefault(); e.stopPropagation(); (opt.menu || tagMenu)(e.clientX, e.clientY, t.name); } },
    pic, h('div', { class: 'slbl' }, h('b', {}, t.name), h('span', {}, sub)));
}

const matchQ = (t) => !SH.q || t.name.toLowerCase().includes(SH.q.toLowerCase());

function homeEl() {
  const H = SH.home;
  if (!H) return h('div', { class: 'empty' }, 'Loading…');
  const kids = [];
  if (SH.q) {
    const all = H.categories.flatMap((c) => c.tags.map((t) => [t, c.id])).concat((H.uncategorized || []).map((t) => [t, ''])).filter(([t]) => matchQ(t));
    kids.push(h('div', { class: 'shead' }, h('h2', {}, `Tags matching “${SH.q}”`)),
      all.length ? h('div', { class: 'sgrid land' }, all.map(([t]) => cardEl(t, 'land'))) : h('p', { class: 'none' }, 'No tag matches.'));
    return h('div', { class: 'spad' }, kids);
  }
  if (H.recent && H.recent.length) {
    kids.push(h('div', { class: 'shead' }, h('h2', {}, 'Recently tagged')),
      h('div', { class: 'srow' }, H.recent.map((p, i) => h('div', { class: 'scard mini', onclick: () => openViewer(p.p, H.recent.map((x) => ({ n: baseName(x.p), p: x.p, k: x.k, x: x.x, m: x.m }))) }, coverCell(p, true)))));
  }
  for (const c of H.categories) {
    const shape = PRESET_SHAPE[c.preset] || 'land';
    kids.push(h('div', { class: 'shead' }, h('span', { class: 'cdot', style: { background: c.color } }), h('h2', {}, c.name),
      h('em', {}, `${c.tags.length} tag${c.tags.length === 1 ? '' : 's'}`), h('a', { class: 'more', onclick: () => shelfCategory(c.id) }, 'See all ›')));
    kids.push(c.tags.length ? h('div', { class: 'srow ' + shape }, c.tags.slice(0, 30).map((t) => cardEl(t, shape)))
      : h('p', { class: 'none' }, 'No tags in this category yet. Right-click a tag (here, in Files or anywhere) and choose “Category: ' + c.name + '”.'));
  }
  const loose = H.uncategorized || [];
  if (loose.length) {
    kids.push(h('div', { class: 'shead' }, h('span', { class: 'cdot', style: { background: '#9aa5b8' } }), h('h2', {}, 'Uncategorized'),
      h('em', {}, `${loose.length} tag${loose.length === 1 ? '' : 's'} · right-click one to give it a category`), h('a', { class: 'more', onclick: () => shelfCategory('') }, 'See all ›')));
    kids.push(h('div', { class: 'srow land small' }, loose.slice(0, 30).map((t) => cardEl(t, 'land'))));
  }
  if (!H.categories.length) {
    kids.unshift(h('div', { class: 'scallout' }, h('b', {}, 'Welcome to the Shelf'),
      h('span', {}, 'Every tag can have its own page with all its files, from every folder. Group your tags into categories such as “Topics” or “Characters” to give each kind its own look.'),
      h('button', { class: 'btn primary', onclick: () => newCategory() }, icon('plus', 15), 'Create a category')));
  }
  if (!H.categories.length && !loose.length && !(H.recent || []).length) kids.push(h('p', { class: 'none' }, 'No tags yet. Tag some files in Files mode first.'));
  return h('div', { class: 'spad' }, kids);
}

function categoryEl() {
  const H = SH.home;
  if (!H) return h('div', { class: 'empty' }, 'Loading…');
  const c = catById(SH.cat);
  const tags = (c ? (H.categories.find((x) => x.id === c.id) || {}).tags : H.uncategorized) || [];
  const shape = c ? shapeOfCat(c.id) : 'land';
  const shown = tags.filter(matchQ);
  return h('div', { class: 'spad' },
    h('div', { class: 'shead' }, h('span', { class: 'cdot', style: { background: c ? c.color : '#9aa5b8' } }), h('h2', {}, c ? c.name : 'Uncategorized'),
      h('em', {}, `${tags.length} tag${tags.length === 1 ? '' : 's'}` + (c ? ` · ${PRESET_NAMES[c.preset] || 'Banner'} layout` : '')),
      c ? h('span', { class: 'sacts' },
        h('button', { class: 'btn small', onclick: () => categoryLayout(c) }, icon('grid', 14), 'Layout'),
        h('button', { class: 'btn small', onclick: () => addTagsToCategory(c) }, icon('plus', 14), 'Add tags'),
        h('button', { class: 'ibtn', title: 'More', onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); categoryMenu(r.left, r.bottom + 4, c); } }, icon('more', 16))) : null),
    shown.length ? h('div', { class: 'sgrid ' + shape }, shown.map((t) => cardEl(t, shape)))
      : h('p', { class: 'none' }, tags.length ? 'No tag matches.' : (c ? 'No tags here yet. Use “Add tags”, or right-click any tag.' : 'Every tag has a category.')));
}

function addTagsToCategory(c) {
  const picked = new Set();
  const q = h('input', { class: 'txt', type: 'text', placeholder: 'Find a tag…', spellcheck: 'false' });
  const list = h('div', { class: 'chips', style: { maxHeight: '46vh', overflow: 'auto' } });
  const draw = () => {
    const needle = q.value.trim().toLowerCase();
    const tags = S.tags.filter((t) => t.category !== c.id && (!needle || t.name.toLowerCase().includes(needle)));
    list.replaceChildren(...(tags.length ? tags.map((t) => {
      const other = t.category && catById(t.category);
      return h('span', { class: 'chip quick ' + (picked.has(t.name) ? 'on' : 'off'), style: chipStyle(t.color), title: other ? `Now in “${other.name}”` : 'Uncategorized' },
        h('span', { class: 'chip-t', onclick: () => { if (picked.has(t.name)) picked.delete(t.name); else picked.add(t.name); draw(); } }, t.name, h('em', {}, t.count)));
    }) : [h('span', { class: 'none' }, 'No tag to add.')]));
  };
  q.addEventListener('input', draw);
  q.addEventListener('keydown', (e) => e.stopPropagation());
  draw();
  modal(`Add tags to “${c.name}”`, h('div', {}, h('p', { class: 'hint', style: { marginTop: 0 } }, 'Click the tags to add, then “Add”. A tag can be in one category; tags from another category move here.'), q, h('div', { style: { height: '10px' } }), list),
    [{ label: 'Cancel' }, { label: 'Add', primary: true, fn: async () => { if (picked.size) await setTagCategory([...picked], c.id); } }], { wide: true });
  setTimeout(() => q.focus(), 30);
}

// ---------------------------------------------------------------- a tag page
function pageTabs(P) {
  const f = P.files;
  const n = (fn) => f.filter(fn).length;
  const tabs = [
    { id: 'all', label: 'All', fn: () => true },
    { id: 'pics', label: 'Pictures', fn: (x) => x.k === 'image' },
    { id: 'videos', label: 'Videos', fn: (x) => x.k === 'video' },
    { id: 'other', label: 'Other files', fn: (x) => x.k !== 'image' && x.k !== 'video', hideEmpty: true },
  ].map((t) => ({ ...t, count: n(t.fn) })).filter((t) => !t.hideEmpty || t.count > 0);
  for (const t of P.tabs || []) tabs.push({ id: 't:' + t.id, label: t.label, count: t.items.length, custom: t });
  return tabs;
}

// ---------------------------------------------------------------- your own tabs (a category's tags that share files)
function addTabMenu(x, y, P) {
  const have = new Set((P.tabs || []).map((t) => t.category && t.category.id));
  const items = (S.categories || []).map((c) => ({ label: (have.has(c.id) ? '＋ ' : '') + c.name + (c.id === (P.category && P.category.id) ? ' (same category)' : ''), icon: 'grid',
    fn: () => addTab(P, c.id) }));
  if (!items.length) items.push({ label: 'No categories yet', disabled: true });
  items.push('-', { label: 'New category…', icon: 'plus', fn: async () => { const c = await newCategory(); if (c) addTab(P, c.id); } });
  menu(x, y, items);
}

async function addTab(P, catId) {
  try {
    const r = await api('/api/shelf/tab/add', { Name: P.name, Category: catId });
    await openTagPage(P.name, { push: false, tab: 't:' + r.id });
  } catch (e) { fail(e); }
}

async function updateTab(P, tab, changes) {
  try { await api('/api/shelf/tab/update', { Name: P.name, ID: tab.id, ...changes }); } catch (e) { fail(e); return; }
  await openTagPage(P.name, { push: false, keepTab: true });
}

function tabMenu(x, y, P, tab) {
  const i = P.tabs.findIndex((t) => t.id === tab.id);
  menu(x, y, [
    { label: 'Rename tab…', icon: 'edit', fn: async () => { const n = await prompt('Rename tab', 'Name', tab.label); if (n && n.trim()) updateTab(P, tab, { Label: n }); } },
    { label: 'Move left', icon: 'back', disabled: i <= 0, fn: async () => { await api('/api/shelf/tab/move', { Name: P.name, ID: tab.id, Dir: -1 }).catch(fail); openTagPage(P.name, { push: false, keepTab: true }); } },
    { label: 'Move right', icon: 'forward', disabled: i >= P.tabs.length - 1, fn: async () => { await api('/api/shelf/tab/move', { Name: P.name, ID: tab.id, Dir: 1 }).catch(fail); openTagPage(P.name, { push: false, keepTab: true }); } },
    '-',
    { label: 'Remove tab', icon: 'trash', danger: true, fn: async () => {
      try { await api('/api/shelf/tab/delete', { Name: P.name, ID: tab.id }); } catch (e) { fail(e); return; }
      SH.tab = 'all'; openTagPage(P.name, { push: false, keepTab: true });
    } },
  ]);
}

function tabView(P, tab) {
  const cat = tab.category;
  const shape = cat ? (PRESET_SHAPE[cat.preset] || 'land') : 'land';
  const pageCat = P.category;
  const hide = (name) => updateTab(P, tab, { Hidden: [...tab.hidden, name] });
  const cardMenu = (x, y, name) => menu(x, y, [
    { label: 'Open tag page', icon: 'grid', fn: () => openTagPage(name) },
    { label: 'Hide from this tab', icon: 'x', fn: () => hide(name) },
  ]);
  const cross = h('label', { class: 'tchk' + (pageCat ? '' : ' off'), title: pageCat ? '' : `Put “${P.name}” in a category to use this` },
    h('input', { type: 'checkbox', checked: tab.crossover && !!pageCat, disabled: !pageCat, onchange: (e) => updateTab(P, tab, { Crossover: e.target.checked }) }),
    h('span', {}, h('b', {}, 'Ignore crossovers'), h('em', {}, pageCat
      ? `skip files that also have another ${pageCat.name} tag` + (tab.crossover && tab.skipped ? ` · ${tab.skipped} file${tab.skipped === 1 ? '' : 's'} skipped` : '')
      : `needs “${P.name}” to be in a category`)));
  const minSel = h('select', { class: 'txt small', onchange: (e) => updateTab(P, tab, { Min: +e.target.value }) },
    [1, 2, 3, 5, 10, 20].map((n) => h('option', { value: n, selected: n === tab.min }, n === 1 ? 'any number of' : 'at least ' + n)));
  const bar = h('div', { class: 'tbar' }, cross,
    h('label', { class: 'tmin' }, 'Show tags in ', minSel, ' shared files'),
    h('button', { class: 'ibtn', title: 'Tab options', onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); tabMenu(r.left, r.bottom + 4, P, tab); } }, icon('more', 16)));
  const hidden = tab.hidden.length ? h('div', { class: 'thidden' }, h('span', { class: 'muted' }, 'Hidden from this tab:'),
    tab.hidden.map((n) => h('span', { class: 'chip', style: chipStyle(tagColor(n)) }, h('span', { class: 'chip-t' }, n),
      h('button', { class: 'chip-x', title: 'Show again', onclick: () => updateTab(P, tab, { Hidden: tab.hidden.filter((x) => x !== n) }) }, icon('x', 11))))) : null;
  const body = tab.items.length
    ? h('div', { class: 'sgrid ' + shape }, tab.items.map((t) => cardEl(t, shape, { sub: `${t.shared} shared file${t.shared === 1 ? '' : 's'}`, menu: cardMenu })))
    : h('p', { class: 'none' }, cat ? `No ${cat.name} tag shares files with “${P.name}”` + (tab.hidden.length || tab.min > 1 || (tab.crossover && tab.skipped) ? ' with these filters.' : ' yet.') : 'This tab\'s category was deleted.');
  return h('div', { class: 'tview' }, bar, hidden, body, h('p', { class: 'hint' }, 'Right-click a card to hide it from this tab.'));
}

function tagPageEl(P) {
  const cat = P.category;
  const preset = (cat && cat.preset) || 'banner';
  const tabs = pageTabs(P);
  if (!tabs.find((t) => t.id === SH.tab)) SH.tab = 'all';
  const tab = tabs.find((t) => t.id === SH.tab);
  const list = tab.custom ? P.files : P.files.filter(tab.fn);
  const pics = P.files.filter((x) => x.k === 'image').length, vids = P.files.filter((x) => x.k === 'video').length;
  const stats = [`${P.files.length} file${P.files.length === 1 ? '' : 's'}`, pics ? `${pics} picture${pics === 1 ? '' : 's'}` : null, vids ? `${vids} video${vids === 1 ? '' : 's'}` : null,
    (() => { const n = new Set(P.files.map((x) => dirOf(x.p))).size; return n > 1 ? `in ${n} folders` : null; })()].filter(Boolean).join(' · ');
  const catChip = h('button', { class: 'catchip', title: 'Change category', onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); tagMenu(r.left, r.bottom + 4, P.name); } },
    h('span', { class: 'cdot', style: { background: cat ? cat.color : '#9aa5b8' } }), cat ? cat.name : 'No category', icon('down', 12));
  const actions = h('div', { class: 'pacts' },
    P.files.some((x) => x.k === 'image' || x.k === 'video') ? h('button', { class: 'btn primary', onclick: () => slideshow(tab.custom ? P.files : list) }, icon('play', 14), 'Slideshow') : null,
    h('button', { class: 'btn', onclick: () => showTagInFiles(P) }, icon('folder', 14), 'Show in Files'),
    h('button', { class: 'ibtn', title: 'More', onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); tagPageMenu(r.left, r.bottom + 4, P); } }, icon('more', 16)));
  const coverPic = P.cover ? heroPic(P.cover) : null;
  let hero;
  if (preset === 'profile') {
    hero = h('div', { class: 'phero profile' }, h('div', { class: 'poster' }, coverPic || h('div', { class: 'cc-ico' }, icon('tag', 40))),
      h('div', { class: 'pinfo' }, catChip, h('h1', {}, P.name), h('div', { class: 'pstats' }, stats), actions));
  } else if (preset === 'banner' && coverPic) {
    hero = h('div', { class: 'phero banner' }, h('div', { class: 'bpic' }, coverPic), h('div', { class: 'bshade' }),
      h('div', { class: 'pinfo' }, catChip, h('h1', {}, P.name), h('div', { class: 'pstats' }, stats), actions));
  } else {
    hero = h('div', { class: 'phero plain' }, h('div', { class: 'pinfo' }, catChip, h('h1', {}, P.name), h('div', { class: 'pstats' }, stats), actions));
  }
  const tabBar = h('div', { class: 'ptabs' }, tabs.map((t) => h('button', { class: 'ptab' + (t.id === SH.tab ? ' on' : '') + (t.custom ? ' custom' : ''), dataset: { tab: t.id },
    onclick: () => { SH.tab = t.id; SH.shown = PAGE_CHUNK; renderShelf(); },
    oncontextmenu: t.custom ? (e) => { e.preventDefault(); tabMenu(e.clientX, e.clientY, P, t.custom); } : null },
    t.custom && t.custom.category ? h('span', { class: 'cdot', style: { background: t.custom.category.color } }) : null, t.label, h('em', {}, t.count))),
    h('button', { class: 'ptab add', title: 'Add a tab that lists the tags of a category', onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); addTabMenu(r.left, r.bottom + 4, P); } }, icon('plus', 14), 'Add tab'));
  const content = tab.custom ? tabView(P, tab.custom) : h('div', {}, h('div', { class: 'shead' }, h('h3', {}, tab.label), h('em', {}, `${list.length} file${list.length === 1 ? '' : 's'} · ${preset === 'timeline' ? 'by month' : 'newest first'}`)),
    filesGrid(list, preset === 'timeline'));
  return h('div', { class: 'tagpage preset-' + preset }, hero, tabBar, h('div', { class: 'spad' }, content));
}

// the banner / poster picture: the full image (a thumbnail would look blurry that big)
function heroPic(c) {
  if (c.k !== 'image') return coverCell(c, false);
  const img = h('img', { src: fileUrl(c.p), alt: '', decoding: 'async', draggable: 'false' });
  const cell = h('div', { class: 'cc' }, img);
  img.addEventListener('error', () => cell.replaceChildren(...coverCell(c, false).childNodes));
  return cell;
}

function fileTile(f, list) {
  return h('div', { class: 'stile', title: f.n, dataset: { p: f.p },
    onclick: () => openViewer(f.p, list.filter((x) => x.k === 'image' || x.k === 'video' || x.k === 'audio')),
    oncontextmenu: (e) => { e.preventDefault(); e.stopPropagation(); fileMenu(e.clientX, e.clientY, f); } },
    (f.k === 'image' || f.k === 'video') ? coverCell({ p: f.p, k: f.k, x: f.x, m: f.m }, true) : h('div', { class: 'cc' }, h('div', { class: 'cc-ico' }, icon(f.k === 'audio' ? 'music' : 'file', 26))),
    (f.r || 0) > 0 ? h('span', { class: 'srating' }, '★'.repeat(f.r)) : null);
}

function filesGrid(list, byMonth) {
  if (!list.length) return h('p', { class: 'none' }, 'Nothing here.');
  const shown = list.slice(0, SH.shown);
  const parts = [];
  if (byMonth) {
    const fmt = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });
    let key = null, cur = null;
    for (const f of shown) {
      const k = fmt.format(new Date((f.a || f.m) * 1000));
      if (k !== key) { key = k; cur = h('div', { class: 'sgrid files' }); parts.push(h('div', { class: 'shead' }, h('h3', {}, k)), cur); }
      cur.append(fileTile(f, list));
    }
  } else parts.push(h('div', { class: 'sgrid files' }, shown.map((f) => fileTile(f, list))));
  if (list.length > shown.length) {
    const more = h('button', { class: 'btn smore', onclick: () => { SH.shown += PAGE_CHUNK * 2; const top = $('#shelf .sbody').scrollTop; renderShelf(); $('#shelf .sbody').scrollTop = top; } }, `Show more (${list.length - shown.length} left)`);
    parts.push(more);
    // load more automatically when the button scrolls into view
    const io = new IntersectionObserver((es) => { if (es.some((x) => x.isIntersecting)) { io.disconnect(); more.click(); } }, { rootMargin: '600px' });
    setTimeout(() => io.observe(more), 50);
  }
  return h('div', {}, parts);
}

function fileMenu(x, y, f) {
  menu(x, y, [
    { label: 'Open in viewer', icon: 'image', fn: () => openViewer(f.p, SH.page ? SH.page.files.filter((z) => z.k === 'image' || z.k === 'video' || z.k === 'audio') : [f]) },
    { label: 'Open with the default app', icon: 'ext', fn: () => api('/api/open', { Path: f.p }).catch(fail) },
    { label: 'Show in Files', icon: 'folder', fn: () => showFileInFiles(f.p) },
    { label: 'Show in Explorer', icon: 'folder', fn: () => api('/api/open', { Path: f.p, Reveal: true }).catch(fail) },
    '-',
    (f.k === 'image' || f.k === 'video') && SH.page ? { label: `Use as “${SH.page.name}” picture`, icon: 'image', fn: () => setTagCover(SH.page.name, f.p) } : null,
  ].filter(Boolean));
}

function tagPageMenu(x, y, P) {
  menu(x, y, [
    P.chosen ? { label: 'Automatic picture again', icon: 'refresh', fn: () => setTagCover(P.name, '') } : null,
    { label: 'Choose picture: right-click a file below', icon: 'image', disabled: true },
    '-',
    { label: 'Rename tag…', icon: 'edit', fn: async () => {
      const nv = await prompt('Rename tag', 'New name', P.name, { help: 'If another tag already has this name, the two are merged.' });
      if (nv == null || !nv.trim() || nv === P.name) return;
      try { const r = await api('/api/tag/rename', { From: P.name, To: nv }); if (r.all) setTags(r.all); await openTagPage(nv.trim(), { push: false }); } catch (e) { fail(e); }
    } },
    { label: 'Tag colour…', icon: 'tag', fn: () => pickColor(P.color, async (v) => { try { const r = await api('/api/tag/color', { Name: P.name, Color: v }); if (r.all) setTags(r.all); shelfRefresh(); } catch (e) { fail(e); } }) },
  ].filter(Boolean));
}

async function setTagCover(name, path) {
  try { await api('/api/tag/cover', { Name: name, Image: path }); } catch (e) { fail(e); return; }
  toast(path ? 'Picture set' : 'Picture is automatic again');
  shelfRefresh();
}

// ---------------------------------------------------------------- bridges back to Files
async function showFileInFiles(p) {
  await setMode('files', { noRefresh: true });
  await go(dirOf(p), { select: [p] });
}

// Opens the folder that holds the tag's files, filtered to the tag. When the files are spread over
// several folders, opens their common parent with "include subfolders" on.
async function showTagInFiles(P) {
  if (!P.files.length) { toast('No files with this tag'); return; }
  const dirs = [...new Set(P.files.map((f) => dirOf(f.p)))];
  let target = dirs[0], sub = false;
  if (dirs.length > 1) {
    const split = (d) => d.split(/[\\/]+/).filter(Boolean);
    const parts = dirs.map(split);
    let n = 0;
    while (parts.every((x) => x[n] !== undefined && x[n].toLowerCase() === parts[0][n].toLowerCase())) n++;
    const common = parts[0].slice(0, n);
    if (n >= 2) {
      const lead = dirs[0].startsWith('\\\\') ? '\\\\' : (dirs[0].startsWith('/') ? '/' : '');
      target = lead + common.join(S.sep) + (common.length === 1 && /:$/.test(common[0]) ? S.sep : '');
      sub = true;
    } else {
      // no useful common folder (different drives): the folder with most of them
      const count = new Map(); for (const f of P.files) count.set(dirOf(f.p), (count.get(dirOf(f.p)) || 0) + 1);
      target = [...count.entries()].sort((a, b) => b[1] - a[1])[0][0];
    }
  }
  await setMode('files', { noRefresh: true });
  S.sub = sub;
  await go(target, { keepFilter: false });
  S.f = defaultFilter(); S.f.inc = [P.name];
  afterFilterChange();
  if (sub) toast(`Showing “${P.name}” in ${baseName(target)} and its subfolders`);
}

// ---------------------------------------------------------------- slideshow
let slideTimer = 0;
function slideshow(list) {
  const media = list.filter((x) => x.k === 'image' || x.k === 'video');
  if (!media.length) return;
  openViewer(media[0].p, media);
  clearInterval(slideTimer);
  let last = Date.now();
  slideTimer = setInterval(() => {
    if (!viewerOpen()) { clearInterval(slideTimer); return; }
    const v = $('#vstage video');
    if (v) { v.loop = false; if (!v.ended) { last = Date.now(); return; } }
    if (Date.now() - last < 4500) return;
    last = Date.now();
    if (V.i < V.list.length - 1) stepViewer(1); else clearInterval(slideTimer);
  }, 250);
  toast('Slideshow - Esc to stop, ← → to skip');
}

// ---------------------------------------------------------------- keys & hooks
function shelfKey(e) {
  if ((e.altKey && e.key === 'ArrowLeft') || (e.key === 'Backspace' && !e.ctrlKey)) { shelfBack(); return true; }
  if (e.key === '/' || (e.ctrlKey && e.key.toLowerCase() === 'f')) { const s = $('#shelf .ssearch'); if (s) { s.focus(); return true; } }
  return false;
}

// tags changed while a Shelf page is showing (from the viewer, for example)
function shelfTagsChanged(changed) {
  for (const [p, tags] of Object.entries(changed || {})) { const f = SH.byPath.get(p); if (f) f.t = tags || []; }
  if (S.mode === 'shelf' && !viewerOpen()) shelfRefreshSoon();
}

// right-click on any tag chip anywhere: tag page and category
document.addEventListener('contextmenu', (e) => {
  const chip = e.target.closest && e.target.closest('.chip[data-tag]');
  if (!chip || e.defaultPrevented || viewerOpen()) return;
  e.preventDefault();
  tagMenu(e.clientX, e.clientY, chip.dataset.tag);
});
