'use strict';
// Shelf: the media-center mode. Tags become pages (every file with that tag, from every folder),
// grouped into categories whose layout preset decides how their cards and pages look.

const SH = { view: 'home', cat: '', tag: '', tab: 'all', home: null, page: null, hist: [], byPath: new Map(), shown: 0, q: '', seq: 0, pf: { q: '', inc: [], exc: [] } };
const PRESET_SHAPE = { banner: 'land', profile: 'port', gallery: 'sq', timeline: 'land' };
const PRESET_NAMES = { banner: 'Banner', profile: 'Profile', gallery: 'Gallery', timeline: 'Timeline' };
const PAGE_CHUNK = 240;
// the Slideshow button is hidden for now; the slideshow itself still works (set to true to bring it back)
const SHOW_SLIDESHOW = false;
// what scrolls: on a tag page only the files, elsewhere the whole Shelf
const scrollBox = () => $('#shelf .pscroll') || $('#shelf .sbody');

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
function shelfPush() { SH.hist.push({ view: SH.view, cat: SH.cat, tag: SH.tag, tab: SH.tab, ctype: SH.ctype, item: SH.item }); if (SH.hist.length > 50) SH.hist.shift(); }
async function shelfBack() {
  const p = SH.hist.pop();
  if (!p) return;
  Object.assign(SH, p);
  if (SH.view === 'tag') await openTagPage(SH.tag, { push: false, tab: SH.tab });
  else if (SH.view === 'type') await shelfType(SH.ctype, { push: false });
  else if (SH.view === 'item') await openItemPage(SH.item, { push: false });
  else await shelfLoad(true);
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
  if (SH.tag !== r.name) SH.pf = { q: '', inc: [], exc: [] }; // the search and tag filter belong to one page
  SH.view = 'tag'; SH.tag = r.name; SH.page = r; SH.tab = opt.tab || (opt.keepTab && SH.tab) || 'all'; SH.shown = PAGE_CHUNK;
  SH.byPath = new Map(r.files.map((f) => [f.p, f]));
  if (!SH.home) refreshHomeQuiet(); // the left panel's category counts
  if (S.mode !== 'shelf') { S.mode = 'shelf'; saveSettingsSoon(); document.body.classList.add('mode-shelf'); }
  renderNav();
  renderShelf();
  const sb = scrollBox(); if (sb) sb.scrollTop = 0;
}

// the home data also feeds the counts in the left panel: keep it fresh while a tag page is open
async function refreshHomeQuiet() {
  try { const r = await api('/api/shelf/home'); SH.home = r; S.categories = r.categories.map(({ id, name, color, preset }) => ({ id, name, color, preset })); renderNav(); } catch (e) { /* next time */ }
}

// refresh what is on screen (after tags changed somewhere)
async function shelfRefresh() {
  if (S.mode !== 'shelf') { SH.home = null; return; }
  const top = (scrollBox() || {}).scrollTop || 0;
  if (SH.view === 'tag') { await openTagPage(SH.tag, { push: false, keepTab: true }); refreshHomeQuiet(); }
  else if (SH.view === 'type') { await shelfType(SH.ctype, { push: false }); refreshHomeQuiet(); }
  else if (SH.view === 'item') { await openItemPage(SH.item, { push: false }); refreshHomeQuiet(); }
  else await shelfLoad(true);
  const b = scrollBox(); if (b) b.scrollTop = top;
}
const shelfRefreshSoon = debounce(shelfRefresh, 400);

// ---------------------------------------------------------------- left panel in Shelf mode
function shelfNavItems() {
  const kids = [];
  const row = (ic, label, on, fn, extra = {}) => h('div', { class: 'nrow' + (on ? ' active' : ''), onclick: fn, ...extra }, ic, h('span', { class: 'nlabel' }, label), extra.count != null ? h('span', { class: 'ncount' }, extra.count) : null);
  kids.push(row(icon('home', 16), 'Home', SH.view === 'home', shelfHome));
  const tc = (SH.home && SH.home.types) || {};
  kids.push(h('div', { class: 'nsec' }, 'Content'));
  for (const c of CT_ORDER) {
    kids.push(h('div', { class: 'nrow ctrow-n' + (SH.view === 'type' && SH.ctype === c ? ' active' : ''), style: { '--ct': CT[c].color }, dataset: { ctype: c }, onclick: () => shelfType(c) },
      h('span', { class: 'ctico' }, icon(CT[c].icon, 14)), h('span', { class: 'nlabel' }, CT[c].many), h('span', { class: 'ncount' }, tc[c] || 0)));
  }
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
  if (SH.view === 'item' && SH.idata) {
    const it = SH.idata.item;
    kids.push(h('div', { class: 'nsec' }, 'Open page'));
    kids.push(h('div', { class: 'nrow active' }, h('span', { class: 'ctico', style: { '--ct': CT[it.c].color } }, icon(CT[it.c].icon, 14)), h('span', { class: 'nlabel' }, it.n)));
  }
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
  else if (SH.view === 'type') { title = CT[SH.ctype].many; body = typePageEl(); }
  else if (SH.view === 'item' && SH.idata) { title = SH.idata.item.n; body = itemPageEl(); }
  else if (SH.view === 'cat') { const c = catById(SH.cat); title = c ? c.name : 'Uncategorized'; body = categoryEl(); }
  else body = homeEl();
  const search = h('input', { class: 'txt ssearch', type: 'search', placeholder: 'Find a tag…', value: SH.q, spellcheck: 'false', dataset: { focus: 'ssearch' } });
  search.addEventListener('input', debounce(() => { SH.q = search.value; const b = $('#shelf .sbody'); const nb = SH.view === 'tag' ? null : (SH.view === 'cat' ? categoryEl() : homeEl()); if (b && nb) b.replaceChildren(nb); }, 150));
  search.addEventListener('keydown', (e) => { if (e.key === 'Escape') { search.value = ''; SH.q = ''; search.dispatchEvent(new Event('input')); } e.stopPropagation(); });
  root.replaceChildren(
    h('header', { class: 'stop' },
      h('button', { class: 'ibtn', title: 'Back (Alt+←)', disabled: !SH.hist.length, onclick: shelfBack }, icon('back', 18)),
      h('b', { class: 'stitle' }, title),
      SH.view === 'home' || SH.view === 'cat' ? search : null),
    h('div', { class: 'sbody' + ((SH.view === 'tag' && SH.page) || SH.view === 'type' || SH.view === 'item' ? ' tagview' : ''), tabindex: '-1' }, body));
}

// ---------------------------------------------------------------- chosen icons and banners
// a picture the user chose, at full quality (the icon of a banner page keeps its transparency)
function chosenPic(c, cls) {
  const img = h('img', { src: fileUrl(c.p), alt: '', decoding: 'async', draggable: 'false' });
  const cell = h('div', { class: 'cc' + (cls ? ' ' + cls : '') }, img);
  img.addEventListener('error', () => { cell.className = 'cc'; cell.replaceChildren(...coverCell(c, false).childNodes); });
  return cell;
}
// the picture for a tag card (normal cards): wide cards prefer the banner, poster and square cards the icon
function cardPic(t, shape) {
  const chosen = shape === 'land' ? t.banner : t.icon;
  if (chosen) return { el: coverCell(chosen, false) };
  if (t.cover) return { el: coverCell(t.cover, false) };
  return { el: h('div', { class: 'cc' }, h('div', { class: 'cc-ico' }, icon('tag', 28))) };
}

async function setTagPicture(name, kind, path) {
  try { await api('/api/tag/picture', { Name: name, Kind: kind, Image: path }); } catch (e) { fail(e); return; }
  toast(path ? (kind === 'icon' ? 'Icon set' : 'Banner set') : (kind === 'icon' ? 'Icon removed' : 'Banner removed'));
  if (S.mode === 'shelf') shelfRefresh(); else SH.home = null;
}

// "which tag?" with autocomplete over all tags
function promptTagName(title, help, initial) {
  return new Promise((resolve) => {
    let done = false;
    const dl = h('datalist', { id: 'tagnames' }, S.tags.map((t) => h('option', { value: t.name })));
    const inp = h('input', { class: 'txt', type: 'text', value: initial || '', list: 'tagnames', spellcheck: 'false', placeholder: 'Tag name' });
    const ok = () => {
      const v = inp.value.trim().toLowerCase();
      const t = S.tags.find((x) => x.name.toLowerCase() === v);
      if (!t) { toast(v ? `There is no tag “${inp.value.trim()}”` : 'Type a tag name', { error: true }); return false; }
      done = true; resolve(t.name);
    };
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); if (ok() !== false) m.close(); }
      else if (e.key === 'Escape') { e.preventDefault(); m.close(); }
      e.stopPropagation();
    });
    const m = modal(title, h('div', {}, h('p', { class: 'hint', style: { marginTop: 0 } }, help), inp, dl),
      [{ label: 'Cancel' }, { label: 'Use', primary: true, fn: ok }], { onclose: () => { if (!done) resolve(null); } });
    setTimeout(() => { inp.focus(); inp.select(); }, 30);
  });
}

// Files mode: right-click a picture -> use it as a tag's icon or banner
async function usePictureForTag(e, kind) {
  const name = await promptTagName(kind === 'icon' ? 'Use as Shelf icon' : 'Use as Shelf banner',
    kind === 'icon' ? 'Which tag gets this picture as its icon? Profile pages show it as their poster; Banner pages show it as a logo above the name (transparent pictures keep their shape).' : 'Which tag gets this picture as the banner at the top of its page?',
    (e.t && e.t.length === 1) ? e.t[0] : '');
  if (name) setTagPicture(name, kind, e.p);
}

function cardEl(t, shape, opt = {}) {
  const pk = cardPic(t, shape), pic = pk.el;
  const sub = opt.sub || `${t.count} file${t.count === 1 ? '' : 's'}`;
  return h('div', { class: 'scard ' + shape, title: `${t.name} · ${sub}`, dataset: { tag: t.name },
    onclick: () => openTagPage(t.name), oncontextmenu: (e) => { e.preventDefault(); e.stopPropagation(); (opt.menu || tagMenu)(e.clientX, e.clientY, t.name); } },
    pic, h('div', { class: 'slbl' }, h('b', {}, t.name), h('span', {}, sub)));
}

const matchQ = (t) => !SH.q || t.name.toLowerCase().includes(SH.q.toLowerCase());
function sortCards(list) {
  const dir = S.catDesc ? -1 : 1;
  const val = { recent: (t) => t.last || 0, count: (t) => t.count || 0 }[S.catSort];
  // equal values are always listed A to Z
  return list.slice().sort((a, b) => (val ? (val(a) - val(b)) * dir : collator.compare(a.name, b.name) * dir) || collator.compare(a.name, b.name));
}

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
  const shown = sortCards(tags.filter(matchQ));
  const sortBtn = (v, l) => h('button', { class: 'tmb' + (S.catSort === v ? ' on' : ''), onclick: () => { if (S.catSort === v) S.catDesc = !S.catDesc; else { S.catSort = v; S.catDesc = v !== 'name'; } saveSettingsSoon(); redrawPage(); } },
    l, S.catSort === v ? icon(S.catDesc ? 'down' : 'up', 13) : null);
  const sortBar = tags.length > 1 ? h('div', { class: 'csort' }, h('span', { class: 'muted' }, 'Sort'),
    h('div', { class: 'tmode' }, sortBtn('name', 'Name'), sortBtn('recent', 'Recently tagged'), sortBtn('count', 'Most files'))) : null;
  return h('div', { class: 'spad' },
    h('div', { class: 'shead' }, h('span', { class: 'cdot', style: { background: c ? c.color : '#9aa5b8' } }), h('h2', {}, c ? c.name : 'Uncategorized'),
      h('em', {}, `${tags.length} tag${tags.length === 1 ? '' : 's'}` + (c ? ` · ${PRESET_NAMES[c.preset] || 'Banner'} layout` : '')),
      c ? h('span', { class: 'sacts' },
        h('button', { class: 'btn small', onclick: () => categoryLayout(c) }, icon('grid', 14), 'Layout'),
        h('button', { class: 'btn small', onclick: () => addTagsToCategory(c) }, icon('plus', 14), 'Add tags'),
        h('button', { class: 'ibtn', title: 'More', onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); categoryMenu(r.left, r.bottom + 4, c); } }, icon('more', 16))) : null),
    sortBar,
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
  q.addEventListener('keydown', (e) => { if (e.key !== 'Escape') e.stopPropagation(); }); // Esc still closes the dialog
  draw();
  modal(`Add tags to “${c.name}”`, h('div', {}, h('p', { class: 'hint', style: { marginTop: 0 } }, 'Click the tags to add, then “Add”. A tag can be in one category; tags from another category move here.'), q, h('div', { style: { height: '10px' } }), list),
    [{ label: 'Cancel' }, { label: 'Add', primary: true, fn: async () => { if (picked.size) await setTagCategory([...picked], c.id); } }], { wide: true });
  setTimeout(() => q.focus(), 30);
}

// ---------------------------------------------------------------- a tag page
function pageTabs(P) {
  const f = P.files.filter(pfPass);
  const n = (fn) => f.filter(fn).length;
  const tabs = [
    { id: 'all', label: 'All', fn: () => true },
    { id: 'pics', label: 'Pictures', fn: (x) => x.k === 'image' },
    { id: 'videos', label: 'Videos', fn: (x) => x.k === 'video' },
    { id: 'other', label: 'Other files', fn: (x) => x.k !== 'image' && x.k !== 'video', hideEmpty: true },
  ].map((t) => ({ ...t, count: n(t.fn) })).filter((t) => !t.hideEmpty || t.count > 0);
  for (const t of P.tabs || []) tabs.push({ id: 't:' + t.id, label: t.label, count: t.ctype === 'panel' ? panelsOf(P).filter(pfPass).length : t.ctype ? t.items.filter(pfPass).length : t.items.length, custom: t });
  return tabs;
}

// ---------------------------------------------------------------- search, tag filter and order for the file tabs
const PAGE_SORTS = [['added', 'Date added'], ['name', 'Name'], ['mtime', 'Date modified'], ['size', 'Size']];
const pfActive = () => !!(SH.pf.q || SH.pf.inc.length || SH.pf.exc.length);
function pfPass(x) {
  const pf = SH.pf, t = x.t || [];
  if (pf.q) {
    const q = pf.q.toLowerCase();
    if (!(x.n.toLowerCase().includes(q) || t.some((y) => y.toLowerCase().includes(q)))) return false;
  }
  for (const y of pf.exc) if (t.includes(y)) return false;
  return pf.inc.every((y) => t.includes(y));
}
function sortFiles(list) {
  const k = S.pageSort, dir = S.pageDesc ? -1 : 1;
  const val = { added: (x) => x.a || 0, mtime: (x) => x.m || 0, size: (x) => x.s || 0 }[k];
  // equal values are always listed A to Z
  return list.slice().sort((a, b) => (val ? (val(a) - val(b)) * dir : collator.compare(a.n, b.n) * dir) || collator.compare(a.n, b.n));
}

// re-draw the page but keep the cursor in the search box and the scroll position
function redrawPage() {
  const act = document.activeElement, key = act && act.dataset && act.dataset.focus;
  const pos = key ? [act.selectionStart, act.selectionEnd] : null;
  const body = scrollBox(), top = body ? body.scrollTop : 0;
  SH.shown = PAGE_CHUNK;
  renderShelf();
  const nb = scrollBox(); if (nb) nb.scrollTop = top;
  if (key) { const el = $(`#shelf [data-focus="${key}"]`); if (el) { el.focus(); try { el.setSelectionRange(pos[0], pos[1]); } catch (e) { /* not a text box */ } } }
}

function pageFilterBar(P, opt = {}) {
  const pf = SH.pf;
  const search = h('input', { class: 'txt small pfq', type: 'search', placeholder: 'Search these files…', value: pf.q, spellcheck: 'false', dataset: { focus: 'pfq' } });
  search.addEventListener('input', debounce(() => { pf.q = search.value.trim(); redrawPage(); }, 180));
  search.addEventListener('keydown', (e) => { if (e.key === 'Escape' && search.value) { search.value = ''; pf.q = ''; redrawPage(); } e.stopPropagation(); });
  // tags that occur on this page's files (with counts), for the tag filter
  const counts = new Map();
  for (const f of P.files) for (const t of f.t || []) if (t !== P.name) counts.set(t, (counts.get(t) || 0) + 1);
  const used = new Set([...pf.inc, ...pf.exc]);
  const dl = h('datalist', { id: 'pftags' }, [...counts.entries()].filter(([t]) => !used.has(t)).sort((a, b) => b[1] - a[1]).map(([t, n]) => h('option', { value: t }, `${n} file${n === 1 ? '' : 's'}`)));
  const tagIn = h('input', { class: 'txt small pft', type: 'text', placeholder: '+ Filter by tag…', list: 'pftags', spellcheck: 'false', dataset: { focus: 'pft' } });
  const addTag = () => {
    const v = tagIn.value.trim().toLowerCase();
    const hit = [...counts.keys()].find((t) => t.toLowerCase() === v);
    if (hit) { if (!pf.inc.includes(hit) && !pf.exc.includes(hit)) pf.inc.push(hit); tagIn.value = ''; redrawPage(); }
    else if (v) toast(`No file here has the tag “${tagIn.value.trim()}”`, { error: true });
  };
  tagIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } e.stopPropagation(); });
  tagIn.addEventListener('change', () => { if (counts.has([...counts.keys()].find((t) => t.toLowerCase() === tagIn.value.trim().toLowerCase()))) addTag(); });
  const chip = (t, not) => h('span', { class: 'chip pfchip' + (not ? ' not' : ''), style: chipStyle(tagColor(t)), dataset: { tag: t } },
    h('span', { class: 'chip-t', title: not ? 'Showing files WITHOUT this tag - click to require it instead' : 'Showing only files WITH this tag - click to exclude it instead',
      onclick: () => { if (not) { pf.exc = pf.exc.filter((y) => y !== t); pf.inc.push(t); } else { pf.inc = pf.inc.filter((y) => y !== t); pf.exc.push(t); } redrawPage(); } }, (not ? '− ' : '+ ') + t),
    h('button', { class: 'chip-x', title: 'Remove from the filter', onclick: () => { pf.inc = pf.inc.filter((y) => y !== t); pf.exc = pf.exc.filter((y) => y !== t); redrawPage(); } }, icon('x', 11)));
  const sortSel = h('select', { class: 'txt small', title: 'Order', onchange: (e) => { S.pageSort = e.target.value; saveSettingsSoon(); redrawPage(); } },
    PAGE_SORTS.map(([v, l]) => h('option', { value: v, selected: v === S.pageSort }, l)));
  const dirBtn = h('button', { class: 'ibtn', title: S.pageDesc ? 'Descending (newest / Z / biggest first) - click to reverse' : 'Ascending - click to reverse',
    onclick: () => { S.pageDesc = !S.pageDesc; saveSettingsSoon(); redrawPage(); } }, icon(S.pageDesc ? 'down' : 'up', 16));
  return h('div', { class: 'pfbar' },
    h('div', { class: 'pfsearch' }, icon('search', 15), search),
    h('div', { class: 'pftags' }, pf.inc.map((t) => chip(t, false)), pf.exc.map((t) => chip(t, true)), tagIn, dl),
    pfActive() ? h('button', { class: 'btn small', onclick: () => { SH.pf = { q: '', inc: [], exc: [] }; redrawPage(); } }, 'Clear') : null,
    opt.noSort ? h('div', { class: 'pfsort' }) : h('div', { class: 'pfsort' }, h('span', { class: 'muted' }, 'Order'), sortSel, dirBtn),
    layoutPicker(P),
    h('label', { class: 'pfsize', title: 'Tile size (Ctrl + mouse wheel)' }, icon('image', 14),
      h('input', { class: 'sizer', type: 'range', min: 110, max: 420, step: 10, value: S.shelfSize || 190, oninput: (e) => setShelfSize(+e.target.value) })));
}

// ---------------------------------------------------------------- how a page shows its files: grid, rows or masonry
// remembered per category (tags without a category share one choice)
const LOOK_DEFAULT = { v: 'grid', shape: 'sq', fit: false };
function lookKey(P) { return (P && P.lk) || (P && P.category && P.category.id) || '_'; }
function pageLook(P) { return Object.assign({}, LOOK_DEFAULT, P && P.shape ? { shape: P.shape } : {}, (S.pageLayouts || {})[lookKey(P)]); }
function setPageLook(P, change) {
  S.pageLayouts = Object.assign({}, S.pageLayouts || {}, { [lookKey(P)]: Object.assign(pageLook(P), change) });
  saveSettingsSoon(); redrawPage();
}
function layoutPicker(P) {
  const L = pageLook(P);
  const seg = h('div', { class: 'tmode lseg', title: 'Layout' }, [['grid', 'grid', 'Grid - same-size tiles'], ['rows', 'rows', 'Rows - every picture keeps its shape, rows fill the width'], ['masonry', 'masonry', 'Masonry - columns, every picture keeps its shape']]
    .map(([v, ic, tip]) => h('button', { class: 'tmb' + (L.v === v ? ' on' : ''), title: tip, dataset: { look: v }, onclick: () => setPageLook(P, { v }) }, icon(ic, 15), h('span', {}, v[0].toUpperCase() + v.slice(1)))));
  const extra = L.v !== 'grid' ? [] : [
    h('select', { class: 'txt small lshape', title: 'Tile shape', onchange: (e) => setPageLook(P, { shape: e.target.value }) },
      [['sq', 'Square'], ['port', 'Portrait'], ['land', 'Landscape']].map(([v, l]) => h('option', { value: v, selected: v === L.shape }, l))),
    h('button', { class: 'ibtn lfit' + (L.fit ? ' on' : ''), title: L.fit ? 'Showing the whole picture - click to fill the tiles' : 'Tiles are filled (edges cut off) - click to show the whole picture',
      onclick: () => setPageLook(P, { fit: !L.fit }) }, icon('fit', 16)),
  ];
  return h('div', { class: 'pflook' }, seg, ...extra);
}

function setShelfSize(v) {
  S.shelfSize = Math.max(110, Math.min(420, v));
  applyLook();
  saveSettingsSoon();
  layoutMasonry();
  const r = $('#shelf .pfsize .sizer'); if (r && +r.value !== S.shelfSize) r.value = S.shelfSize;
}

// ---------------------------------------------------------------- your own tabs (a category's tags that share files)
function addTabMenu(x, y, P) {
  const have = new Set((P.tabs || []).map((t) => t.category && t.category.id));
  const items = (S.categories || []).map((c) => ({ label: (have.has(c.id) ? '＋ ' : '') + c.name + (c.id === (P.category && P.category.id) ? ' (same category)' : ''), icon: 'grid',
    fn: () => addTab(P, c.id) }));
  if (!items.length) items.push({ label: 'No categories yet', disabled: true });
  items.push('-', { label: 'New category…', icon: 'plus', fn: async () => { const c = await newCategory(); if (c) addTab(P, c.id); } });
  const haveT = new Set((P.tabs || []).map((t) => t.ctype).filter(Boolean));
  menu(x, y, [...CT_ORDER.map((c) => ({ label: (haveT.has(c) ? '＋ ' : '') + CT[c].many, icon: CT[c].icon, fn: () => addTab(P, '', c) })), '-', ...items]);
}

async function addTab(P, catId, ctype) {
  try {
    const r = await api('/api/shelf/tab/add', { Name: P.name, Category: catId, Type: ctype || '' });
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

// order and size for the cards of a category tab
const TAB_SORTS = [['shared', 'Most shared files'], ['name', 'Name'], ['count', 'Most files'], ['recent', 'Recently tagged']];
// "Show only" tabs keep your own list order by default; they remember their own choice
function tabSortKey(only) { return only ? (S.tabSortOnly || 'list') : (S.tabSort && S.tabSort !== 'list' ? S.tabSort : 'shared'); }
function sortTabItems(items, only) {
  const k = tabSortKey(only);
  if (k === 'list') return items; // your own order ("Show only" mode)
  const dir = S.tabDesc ? -1 : 1;
  const val = { shared: (t) => t.shared || 0, count: (t) => t.count || 0, recent: (t) => t.last || 0 }[k];
  return items.slice().sort((a, b) => (val ? (val(a) - val(b)) * dir : collator.compare(a.name, b.name) * dir) || collator.compare(a.name, b.name));
}
function tabOrderBar(only) {
  const k = tabSortKey(only);
  const opts = (only ? [['list', 'Your list order']] : []).concat(TAB_SORTS);
  const sel = h('select', { class: 'txt small', title: 'Order', onchange: (e) => { if (only) S.tabSortOnly = e.target.value; else S.tabSort = e.target.value; S.tabDesc = e.target.value !== 'name'; saveSettingsSoon(); redrawPage(); } },
    opts.map(([v, l]) => h('option', { value: v, selected: v === k }, l)));
  const dir = k === 'list' ? null : h('button', { class: 'ibtn', title: S.tabDesc ? 'Descending - click to reverse' : 'Ascending - click to reverse',
    onclick: () => { S.tabDesc = !S.tabDesc; saveSettingsSoon(); redrawPage(); } }, icon(S.tabDesc ? 'down' : 'up', 16));
  return h('div', { class: 'tsort' }, h('span', { class: 'muted' }, 'Order'), sel, dir,
    h('label', { class: 'pfsize', title: 'Card size (Ctrl + mouse wheel)' }, icon('image', 14),
      h('input', { class: 'sizer csizer', type: 'range', min: 110, max: 360, step: 10, value: S.cardSize || 180, oninput: (e) => setCardSize(+e.target.value) })));
}
function setCardSize(v) {
  S.cardSize = Math.max(110, Math.min(360, v));
  applyLook();
  saveSettingsSoon();
  const r = $('#shelf .csizer'); if (r && +r.value !== S.cardSize) r.value = S.cardSize;
}

function tabView(P, tab) {
  const cat = tab.category;
  const shape = cat ? (PRESET_SHAPE[cat.preset] || 'land') : 'land';
  const only = tab.mode === 'only';
  const list = only ? tab.only : tab.exclude;
  const setList = (l) => updateTab(P, tab, only ? { Only: l } : { Exclude: l });
  const add = (names) => { const n = names.filter((x) => !list.includes(x)); if (n.length) setList([...list, ...n]); };
  const known = new Map(tab.pick.map((x) => [x.name.toLowerCase(), x]));

  // which list: everything except… / only…
  const seg = h('div', { class: 'tmode' },
    h('button', { class: 'tmb' + (only ? '' : ' on'), onclick: () => only && updateTab(P, tab, { Mode: 'exclude' }) }, 'Show all except…'),
    h('button', { class: 'tmb' + (only ? ' on' : ''), onclick: () => !only && updateTab(P, tab, { Mode: 'only' }) }, 'Show only…'));
  const chips = list.map((n) => h('span', { class: 'chip', style: chipStyle(tagColor(n)), dataset: { tag: n } }, h('span', { class: 'chip-t' }, n),
    h('button', { class: 'chip-x', title: only ? 'Remove from the list' : 'Show it again', onclick: () => setList(list.filter((x) => x !== n)) }, icon('x', 11))));
  // type a tag of this category (autocomplete)
  const dl = h('datalist', { id: 'tabpick-' + tab.id }, tab.pick.filter((x) => !list.includes(x.name)).map((x) => h('option', { value: x.name }, x.shared ? `${x.shared} shared` : '')));
  const inp = h('input', { class: 'txt small tadd', type: 'text', placeholder: only ? `Add ${cat ? cat.name.toLowerCase() : 'tags'}…` : 'Add a tag to leave out…', list: dl.id, spellcheck: 'false' });
  const commit = () => {
    const hit = known.get(inp.value.trim().toLowerCase());
    if (hit) add([hit.name]); else if (inp.value.trim()) toast(`“${inp.value.trim()}” isn't in ${cat ? cat.name : 'this category'}`, { error: true });
  };
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } e.stopPropagation(); });
  inp.addEventListener('change', () => { if (known.has(inp.value.trim().toLowerCase())) commit(); });
  const bar = h('div', { class: 'tbar' }, seg, tabOrderBar(only),
    h('div', { class: 'tlist' }, chips.length ? chips : h('span', { class: 'none' }, only ? 'Nothing listed yet.' : 'Nothing left out.'), inp, dl),
    h('button', { class: 'ibtn', title: 'Tab options', onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); tabMenu(r.left, r.bottom + 4, P, tab); } }, icon('more', 16)));
  // in "only" mode: one-click suggestions from the tags that share files with this page
  const sugg = only ? tab.pick.filter((x) => x.shared > 0 && !list.includes(x.name)).slice(0, 24) : [];
  const suggest = sugg.length ? h('div', { class: 'tsugg' }, h('span', { class: 'muted' }, 'Sharing files with this page:'),
    sugg.map((x) => h('button', { class: 'chip quick off', style: chipStyle(tagColor(x.name)), title: 'Add to the list', onclick: () => add([x.name]) }, h('span', { class: 'chip-t' }, '＋ ' + x.name, h('em', {}, x.shared))))) : null;

  const move = (name, d) => { const l = [...list]; const i = l.indexOf(name), j = i + d; if (i < 0 || j < 0 || j >= l.length) return; [l[i], l[j]] = [l[j], l[i]]; setList(l); };
  const cardMenu = (x, y, name) => menu(x, y, [
    { label: 'Open tag page', icon: 'grid', fn: () => openTagPage(name) },
    '-',
    only ? { label: 'Remove from this tab', icon: 'x', fn: () => setList(list.filter((z) => z !== name)) } : { label: 'Hide from this tab', icon: 'x', fn: () => add([name]) },
    only ? { label: 'Move earlier', icon: 'back', disabled: list.indexOf(name) <= 0, fn: () => move(name, -1) } : null,
    only ? { label: 'Move later', icon: 'forward', disabled: list.indexOf(name) >= list.length - 1, fn: () => move(name, 1) } : null,
  ].filter(Boolean));
  const shared = (n) => n ? `${n} shared file${n === 1 ? '' : 's'}` : 'no shared files yet';
  const body = tab.items.length
    ? h('div', { class: 'sgrid cards ' + shape }, sortTabItems(tab.items, only).map((t) => cardEl(t, shape, { sub: shared(t.shared), menu: cardMenu })))
    : h('p', { class: 'none' }, !cat ? 'This tab\'s category was deleted.'
      : only ? `List the ${cat.name.toLowerCase()} you want to see here.`
      : `No ${cat.name} tag shares files with “${P.name}”` + (list.length ? ' apart from the ones you left out.' : ' yet.'));
  // [the bar that stays in place, the cards that scroll]
  return [h('div', { class: 'tview' }, bar, suggest), h('div', { class: 'tview' }, body,
    h('p', { class: 'hint' }, only ? 'Only the tags in your list appear, in your order. Right-click a card to remove or move it.'
      : `Every ${cat ? cat.name.toLowerCase() : 'tag'} sharing files with “${P.name}” appears, except the ones listed. Right-click a card to hide it.`))];
}

function tagPageEl(P) {
  const cat = P.category;
  const preset = (cat && cat.preset) || 'banner';
  const tabs = pageTabs(P);
  if (!tabs.find((t) => t.id === SH.tab)) SH.tab = 'all';
  const tab = tabs.find((t) => t.id === SH.tab);
  const list = tab.custom ? P.files : sortFiles(P.files.filter(tab.fn).filter(pfPass));
  if (tab.custom && tab.custom.ctype) SH.byPath = new Map(P.files.map((f) => [f.p, f]));
  const pics = P.files.filter((x) => x.k === 'image').length, vids = P.files.filter((x) => x.k === 'video').length;
  const stats = [`${P.files.length} file${P.files.length === 1 ? '' : 's'}`, pics ? `${pics} picture${pics === 1 ? '' : 's'}` : null, vids ? `${vids} video${vids === 1 ? '' : 's'}` : null,
    (() => { const n = new Set(P.files.map((x) => dirOf(x.p))).size; return n > 1 ? `in ${n} folders` : null; })()].filter(Boolean).join(' · ');
  const catChip = h('button', { class: 'catchip', title: 'Change category', onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); tagMenu(r.left, r.bottom + 4, P.name); } },
    h('span', { class: 'cdot', style: { background: cat ? cat.color : '#9aa5b8' } }), cat ? cat.name : 'No category', icon('down', 12));
  const actions = h('div', { class: 'pacts' },
    SHOW_SLIDESHOW && P.files.some((x) => x.k === 'image' || x.k === 'video') ? h('button', { class: 'btn primary', onclick: () => slideshow(tab.custom ? P.files : list) }, icon('play', 14), 'Slideshow') : null,
    h('button', { class: 'btn', onclick: () => showTagInFiles(P) }, icon('folder', 14), 'Show in Files'),
    h('button', { class: 'ibtn', title: 'More', onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); tagPageMenu(r.left, r.bottom + 4, P); } }, icon('more', 16)));
  const bannerPic = P.banner ? heroPic(P.banner) : null;
  // banner layout: your icon (if any) above the name, always shown as a transparent logo
  const logo = preset === 'banner' && P.icon ? h('div', { class: 'hlogo' }, chosenPic(P.icon, 'logo')) : null;
  const info = h('div', { class: 'pinfo' }, logo, h('div', { class: 'pname' }, h('h1', {}, P.name), catChip, h('div', { class: 'pstats' }, stats)), actions);
  let hero;
  if (preset === 'profile') {
    // the icon: your picture (transparent ones keep their shape) or, if none, the automatic one
    const poster = P.icon
      ? h('div', { class: 'poster chosen' }, chosenPic(P.icon))
      : h('div', { class: 'poster' }, P.cover ? heroPic(P.cover) : h('div', { class: 'cc-ico' }, icon('tag', 40)));
    hero = bannerPic
      ? h('div', { class: 'phero profile withbanner' }, h('div', { class: 'bpic' }, bannerPic), h('div', { class: 'bshade' }), poster, info)
      : h('div', { class: 'phero profile' }, poster, info);
  } else if (preset === 'banner' && (bannerPic || P.cover)) {
    hero = h('div', { class: 'phero banner' }, h('div', { class: 'bpic' }, bannerPic || heroPic(P.cover)), h('div', { class: 'bshade' }), info);
  } else {
    hero = h('div', { class: 'phero plain' }, info);
  }
  const tabBar = h('div', { class: 'ptabs' }, tabs.map((t) => h('button', { class: 'ptab' + (t.id === SH.tab ? ' on' : '') + (t.custom ? ' custom' : ''), dataset: { tab: t.id },
    onclick: () => { SH.tab = t.id; SH.shown = PAGE_CHUNK; renderShelf(); },
    oncontextmenu: t.custom ? (e) => { e.preventDefault(); tabMenu(e.clientX, e.clientY, P, t.custom); } : null },
    t.custom && t.custom.ctype ? h('span', { class: 'ctico', style: { '--ct': CT[t.custom.ctype].color } }, icon(CT[t.custom.ctype].icon, 13)) : null,
    t.custom && t.custom.category ? h('span', { class: 'cdot', style: { background: t.custom.category.color } }) : null, t.label, h('em', {}, t.count))),
    h('button', { class: 'ptab add', title: 'Add a tab that lists the tags of a category', onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); addTabMenu(r.left, r.bottom + 4, P); } }, icon('plus', 14), 'Add tab'));
  const byMonth = preset === 'timeline' && S.pageSort === 'added';
  // the banner, the tabs and the bar stay in place; only the files (or cards) scroll
  let fixed, scrolling;
  if (tab.custom && tab.custom.ctype) {
    const c = tab.custom.ctype;
    const all = c === 'panel' ? panelsOf(P) : tab.custom.items;
    [fixed, scrolling] = typeListView({ name: P.name, files: all, lk: typeLookKey(c), shape: CT_SHAPE[c] }, c, all);
    fixed = h('div', {}, fixed, h('div', { class: 'ttabnote' }, h('span', { class: 'muted' }, `${CT[c].many} with the tag “${P.name}”`),
      h('button', { class: 'ibtn', title: 'Tab options', onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); tabMenu(r.left, r.bottom + 4, P, tab.custom); } }, icon('more', 16))));
  } else if (tab.custom) [fixed, scrolling] = tabView(P, tab.custom);
  else {
    fixed = pageFilterBar(P);
    scrolling = h('div', {}, h('div', { class: 'shead' }, h('h3', {}, tab.label), h('em', {}, `${list.length} file${list.length === 1 ? '' : 's'}` + (pfActive() ? ' match' : '') + (byMonth ? ' · by month' : ''))),
      filesGrid(list, byMonth, pageLook(P)));
  }
  const scroller = h('div', { class: 'pscroll', tabindex: '-1' }, h('div', { class: 'spad' }, scrolling));
  // Ctrl + mouse wheel changes the tile size, like in Files
  scroller.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const d = e.deltaY < 0 ? 20 : -20;
    if (tab.custom && !tab.custom.ctype) setCardSize((S.cardSize || 180) + d); else setShelfSize((S.shelfSize || 190) + d);
  }, { passive: false });
  return h('div', { class: 'tagpage preset-' + preset }, hero, tabBar, h('div', { class: 'pfixed' }, fixed), scroller);
}

// the banner / poster picture: the full image (a thumbnail would look blurry that big)
function heroPic(c) {
  if (c.k !== 'image') return coverCell(c, false);
  const img = h('img', { src: fileUrl(c.p), alt: '', decoding: 'async', draggable: 'false' });
  const cell = h('div', { class: 'cc' }, img);
  img.addEventListener('error', () => cell.replaceChildren(...coverCell(c, false).childNodes));
  return cell;
}

// a file's shape (width / height), kept within sensible limits so odd panoramas don't take over a row
function fileRatio(f) { return f.w && f.h ? Math.max(0.35, Math.min(3.2, f.w / f.h)) : 1; }

function fileTile(f, list, look) {
  const r = fileRatio(f);
  const dpr = window.devicePixelRatio || 1;
  // bigger previews when the tile is shown big (high-DPI screens, big sizes, tall pictures in masonry)
  const big = (S.shelfSize || 190) * 1.25 * dpr * (look.v === 'grid' && look.fit ? 1 : Math.max(r, 1 / r)) > 400;
  const tile = h('div', { class: 'stile', title: f.n, dataset: { p: f.p },
    onclick: () => openViewer(f.p, list.filter((x) => x.k === 'image' || x.k === 'video' || x.k === 'audio')),
    oncontextmenu: (e) => { e.preventDefault(); e.stopPropagation(); fileMenu(e.clientX, e.clientY, f); } },
    (f.k === 'image' || f.k === 'video') ? coverCell({ p: f.p, k: f.k, x: f.x, m: f.m, big }, true) : h('div', { class: 'cc' }, h('div', { class: 'cc-ico' }, icon(f.k === 'audio' ? 'music' : 'file', 26))),
    (f.r || 0) > 0 ? h('span', { class: 'srating' }, '★'.repeat(f.r)) : null);
  if (look.v !== 'grid') {
    shapeTile(tile, r, look);
    // a shape we didn't know yet (new picture, video): learn it from the preview
    const img = tile.querySelector('img');
    if (img && !(f.w && f.h)) img.addEventListener('load', () => {
      if (!img.naturalWidth || !img.naturalHeight) return;
      f.w = img.naturalWidth; f.h = img.naturalHeight;
      shapeTile(tile, fileRatio(f), look);
      if (look.v === 'masonry') layoutMasonry();
    });
  }
  return tile;
}

function shapeTile(tile, r, look) {
  tile.dataset.r = r;
  // rows: every tile grows in proportion to its width, so a row ends up with one height
  if (look.v === 'rows') tile.style.flex = `${r} ${r} calc(var(--stile, 190px) * ${r})`;
  tile.style.setProperty('--r', r);
}

function filesBox(look) {
  if (look.v === 'rows') return h('div', { class: 'jrows' });
  if (look.v === 'masonry') return h('div', { class: 'masonry' });
  return h('div', { class: 'sgrid files shape-' + look.shape + (look.fit ? ' fit' : '') });
}

// masonry: columns of equal width; each picture goes to the shortest column, so the order reads left to right
let masonryRO = null;
function layoutMasonry() {
  for (const box of document.querySelectorAll('#shelf .masonry')) {
    const W = box.clientWidth; if (!W) continue;
    const gap = box.classList.contains('items') ? 16 : 8, min = S.shelfSize || 190;
    const n = Math.max(1, Math.floor((W + gap) / (min + gap)));
    const cw = (W - gap * (n - 1)) / n;
    const hs = new Array(n).fill(0);
    for (const t of box.children) {
      let c = 0; for (let i = 1; i < n; i++) if (hs[i] < hs[c] - 1) c = i;
      const th = Math.round(cw / (+t.dataset.r || 1));
      t.style.left = (c * (cw + gap)) + 'px'; t.style.top = hs[c] + 'px'; t.style.width = cw + 'px'; t.style.height = th + 'px';
      hs[c] += th + gap;
    }
    box.style.height = Math.max(0, Math.max(...hs) - gap) + 'px';
  }
}
const layoutMasonrySoon = (() => { let q = false; return () => { if (q) return; q = true; requestAnimationFrame(() => { q = false; layoutMasonry(); }); }; })();

function filesGrid(list, byMonth, look) {
  if (!list.length) return h('p', { class: 'none' }, 'Nothing here.');
  look = look || LOOK_DEFAULT;
  const shown = list.slice(0, SH.shown);
  const parts = [];
  if (byMonth) {
    const fmt = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });
    let key = null, cur = null;
    for (const f of shown) {
      const k = fmt.format(new Date((f.a || f.m) * 1000));
      if (k !== key) { key = k; cur = filesBox(look); parts.push(h('div', { class: 'shead' }, h('h3', {}, k)), cur); }
      cur.append(fileTile(f, list, look));
    }
  } else { const box = filesBox(look); box.append(...shown.map((f) => fileTile(f, list, look))); parts.push(box); }
  if (look.v === 'masonry') {
    // lay out once the boxes are on screen, and again whenever the window changes size
    requestAnimationFrame(layoutMasonry);
    if (!masonryRO) masonryRO = new ResizeObserver(layoutMasonrySoon);
    masonryRO.disconnect();
    setTimeout(() => { for (const b of document.querySelectorAll('#shelf .masonry')) masonryRO.observe(b); }, 0);
  }
  if (list.length > shown.length) {
    const more = h('button', { class: 'btn smore', onclick: () => { SH.shown += PAGE_CHUNK * 2; const top = scrollBox().scrollTop; renderShelf(); scrollBox().scrollTop = top; } }, `Show more (${list.length - shown.length} left)`);
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
    f.k === 'image' && SH.page ? { label: `Use as “${SH.page.name}” icon`, icon: 'image', fn: () => setTagPicture(SH.page.name, 'icon', f.p) } : null,
    f.k === 'image' && SH.page ? { label: `Use as “${SH.page.name}” banner`, icon: 'image', fn: () => setTagPicture(SH.page.name, 'banner', f.p) } : null,
  ].filter(Boolean));
}

function tagPageMenu(x, y, P) {
  menu(x, y, [
    P.icon ? { label: 'Remove the icon (automatic again)', icon: 'refresh', fn: () => setTagPicture(P.name, 'icon', '') } : null,
    P.banner ? { label: 'Remove the banner', icon: 'refresh', fn: () => setTagPicture(P.name, 'banner', '') } : null,
    P.chosen ? { label: 'Automatic picture again', icon: 'refresh', fn: () => setTagCover(P.name, '') } : null,
    { label: 'Icon / banner: right-click a picture below, or any picture in Files', icon: 'image', disabled: true },
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

// pictures and videos with the page's tag that are not marked as something else
const panelsOf = (P) => P.files.filter((f) => (f.k === 'image' || f.k === 'video') && !f.c);

// ---------------------------------------------------------------- content types in the Shelf
// Content pages (all panels / scenes / stories / series), a series' (or story's) own page, and the tiles
// that show them: a coloured type badge, a stacked look for folders and what is inside them.

async function shelfType(c, opt = {}) {
  const seq = ++SH.seq;
  let r;
  try { r = await api('/api/ctype/page', { Type: c }); } catch (e) { fail(e); return; }
  if (seq !== SH.seq) return;
  if (opt.push !== false && !(SH.view === 'type' && SH.ctype === c)) shelfPush();
  if (SH.view !== 'type' || SH.ctype !== c) SH.pf = { q: '', inc: [], exc: [] };
  SH.view = 'type'; SH.ctype = c; SH.tdata = r; SH.shown = PAGE_CHUNK; SH.q = '';
  if (r.files) SH.byPath = new Map(r.files.map((f) => [f.p, f]));
  if (S.mode !== 'shelf') { S.mode = 'shelf'; saveSettingsSoon(); document.body.classList.add('mode-shelf'); }
  renderNav(); renderShelf();
  const sb = scrollBox(); if (sb) sb.scrollTop = 0;
}

async function openItemPage(path, opt = {}) {
  const seq = ++SH.seq;
  let r;
  try { r = await api('/api/ctype/children', { Path: path }); } catch (e) { fail(e); return; }
  if (seq !== SH.seq) return;
  if (opt.push !== false && !(SH.view === 'item' && SH.item === path)) shelfPush();
  SH.view = 'item'; SH.item = r.item.p; SH.idata = r; SH.shown = PAGE_CHUNK; SH.q = '';
  if (S.mode !== 'shelf') { S.mode = 'shelf'; saveSettingsSoon(); document.body.classList.add('mode-shelf'); closeMenu(); }
  renderNav(); renderShelf();
  const sb = scrollBox(); if (sb) sb.scrollTop = 0;
}

// what a tile says under its name
function itemSub(it) {
  const parts = [];
  const n = (k, one, many) => (k ? `${k} ${k === 1 ? one : many}` : null);
  if (it.c === 'series') parts.push(n(it.stories, 'story', 'stories'), n(it.scenes, 'scene', 'scenes'));
  else if (it.c === 'story') parts.push(n(it.scenes, 'scene', 'scenes'), n(it.media, 'panel', 'panels'));
  else parts.push(n(it.media, 'panel', 'panels'));
  if (!it.d) parts.push((it.x || '').replace('.', '').toUpperCase() + ' file');
  if ((it.paths || []).length > 1) parts.push(`${it.paths.length} folders`);
  return parts.filter(Boolean).join(' · ') || (it.d ? 'empty folder' : '');
}

// open a scene / story / series the way it works best
function openItem(it) {
  if (it.c === 'series') { if (it.d) openItemPage(it.p); else api('/api/open', { Path: it.p }).catch(fail); return; }
  if (it.d || it.k === 'image' || it.k === 'video') openPlayer(it.p);
  else api('/api/open', { Path: it.p }).catch(fail); // a PDF, an HTML page...: its own app
}

function itemMenu(x, y, it) {
  const e = { p: it.p, d: it.d, c: it.c, k: it.k, x: it.x, n: it.n, t: it.t };
  menu(x, y, [
    { label: it.c === 'series' ? 'Open' : (it.d || it.k === 'image' || it.k === 'video') ? 'Play' : 'Open', icon: it.c === 'series' ? 'stack' : 'play', fn: () => openItem(it) },
    it.d && it.c === 'story' ? { label: 'Open story page', icon: 'book', fn: () => openItemPage(it.p) } : null,
    it.parent ? { label: 'Go to ' + CT[it.parent.c].label.toLowerCase() + ' “' + it.parent.n + '”', icon: CT[it.parent.c].icon, fn: () => openItemPage(it.parent.p) } : null,
    '-',
    { label: 'Choose preview…', icon: 'image', fn: () => openItemCoverPicker(e) },
    it.custom ? { label: 'Automatic preview', icon: 'refresh', fn: () => setItemCover(it.p, '') } : null,
    { label: 'Content type…', icon: 'film', fn: () => ctypeMenu(x, y, [e]) },
    '-',
    ...((it.paths || []).length > 1
      ? it.paths.map((q) => ({ label: 'Show in Files: ' + q, icon: 'folder', fn: async () => { await setMode('files', { noRefresh: true }); go(q); } }))
      : [{ label: 'Show in Files', icon: 'folder', fn: async () => { await setMode('files', { noRefresh: true }); go(it.d ? it.p : dirOf(it.p), it.d ? {} : { select: it.p }); } }]),
    { label: 'Show in Explorer', icon: 'ext', fn: () => api('/api/open', { Path: it.p, Reveal: true }).catch(fail) },
  ].filter(Boolean));
}

function itemTile(it, look, opt = {}) {
  const c = CT[it.c] || CT.scene;
  const pic = it.cover ? coverCell({ ...it.cover, big: (S.shelfSize || 190) * (window.devicePixelRatio || 1) > 300 }, it.cover.k === 'video')
    : h('div', { class: 'cc' }, h('div', { class: 'cc-ico' }, icon(it.d ? c.icon : 'file', 34), it.d ? null : h('em', {}, (it.x || '').replace('.', '').toUpperCase())));
  const playable = it.c !== 'series' && (it.d || it.k === 'image' || it.k === 'video');
  const tile = h('div', { class: 'stile itile ct-' + it.c + (it.d ? ' stack' : ''), style: { '--ct': c.color }, title: it.n, dataset: { p: it.p, ct: it.c },
    onclick: () => openItem(it), oncontextmenu: (e) => { e.preventDefault(); e.stopPropagation(); itemMenu(e.clientX, e.clientY, it); } },
    pic,
    h('span', { class: 'ctb' }, icon(c.icon, 12), h('span', {}, c.label)),
    playable ? h('span', { class: 'iplay' }, icon('play', 22)) : null,
    (it.r || 0) > 0 ? h('span', { class: 'srating' }, '★'.repeat(it.r)) : null,
    h('div', { class: 'ilbl' }, h('b', {}, it.n), h('span', {}, itemSub(it)), it.parent && !opt.noParent ? h('span', { class: 'ipar' }, icon(CT[it.parent.c].icon, 11), it.parent.n) : null));
  if (look && look.v !== 'grid') {
    shapeTile(tile, 1, look);
    const img = tile.querySelector('img');
    if (img) img.addEventListener('load', () => {
      if (!img.naturalWidth || !img.naturalHeight) return;
      shapeTile(tile, Math.max(0.5, Math.min(2.4, img.naturalWidth / img.naturalHeight)), look);
      if (look.v === 'masonry') layoutMasonrySoon();
    });
  }
  return tile;
}

function itemsGrid(list, look, opt = {}) {
  if (!list.length) return h('p', { class: 'none' }, 'Nothing here.');
  const shown = list.slice(0, SH.shown);
  const box = filesBox(look);
  box.classList.add('items');
  box.append(...shown.map((it) => itemTile(it, look, opt)));
  const parts = [box];
  if (look.v === 'masonry') {
    requestAnimationFrame(layoutMasonry);
    if (!masonryRO) masonryRO = new ResizeObserver(layoutMasonrySoon);
    masonryRO.disconnect();
    setTimeout(() => { for (const b of document.querySelectorAll('#shelf .masonry')) masonryRO.observe(b); }, 0);
  }
  if (list.length > shown.length) parts.push(h('button', { class: 'btn smore', onclick: () => { SH.shown += PAGE_CHUNK * 2; const top = scrollBox().scrollTop; renderShelf(); scrollBox().scrollTop = top; } }, `Show more (${list.length - shown.length} left)`));
  return h('div', {}, parts);
}

// the default tile shape per type (until you pick another)
const CT_SHAPE = { scene: 'land', story: 'port', series: 'port', panel: 'sq' };
function typeLookKey(c) { return 'type:' + c; }

// a list of panels or of marked items with the usual bar (search, tag filter, order, layout, size)
function typeListView(P, c, all) {
  const files = c === 'panel';
  const list = sortFiles(all.filter(pfPass));
  const fixed = pageFilterBar(P);
  const look = pageLook(P);
  const what = (k) => `${k} ${k === 1 ? CT[c].label.toLowerCase() : CT[c].many.toLowerCase()}`;
  const scrolling = h('div', {}, h('div', { class: 'shead' }, ctBadge(c, { panel: true }), h('h3', {}, CT[c].many), h('em', {}, what(list.length) + (pfActive() ? ' match' : ''))),
    files ? filesGrid(list, false, look) : itemsGrid(list, look));
  return [fixed, scrolling];
}

function typePageEl() {
  const r = SH.tdata, c = SH.ctype;
  if (!r) return h('div', { class: 'empty' }, 'Loading…');
  const all = r.files || r.items || [];
  const P = { name: '', files: all, lk: typeLookKey(c), shape: CT_SHAPE[c] };
  const t = CT[c];
  const hero = h('div', { class: 'phero plain ctypehero', style: { '--ct': t.color } }, h('div', { class: 'pinfo' },
    h('div', { class: 'ctbig' }, icon(t.icon, 30)),
    h('div', { class: 'pname' }, h('h1', {}, t.many), h('div', { class: 'pstats' }, t.help + (c === 'panel' ? ' Shows the tagged or rated ones that are not marked as something else.' : ''))),
    h('div', { class: 'pacts' }, c !== 'panel' ? h('button', { class: 'btn', title: 'Mark folders by their names', onclick: () => openTypeFinder(S.path || '') }, icon('search', 14), 'Find by folder name…') : null)));
  if (!all.length) {
    return h('div', { class: 'tagpage' }, hero, h('div', { class: 'pscroll' }, h('div', { class: 'spad' }, h('p', { class: 'none' }, c === 'panel'
      ? 'No tagged pictures or videos yet.'
      : `Nothing is marked as a ${t.label.toLowerCase()} yet. In Files, right-click a folder or file → Content type → ${t.label}, or pick it in the panel on the right.`))));
  }
  const [fixed, scrolling] = typeListView(P, c, all);
  return typedPage(hero, null, fixed, scrolling);
}

// a series' or story's page: its scenes and stories in order
function itemPageEl() {
  const r = SH.idata;
  if (!r) return h('div', { class: 'empty' }, 'Loading…');
  const it = r.item, c = CT[it.c] || CT.series;
  const poster = h('div', { class: 'poster' }, it.cover ? heroPic(it.cover) : h('div', { class: 'cc-ico' }, icon(c.icon, 40)));
  const playable = it.c !== 'series' && (it.d || it.k === 'image' || it.k === 'video');
  const info = h('div', { class: 'pinfo' }, h('div', { class: 'pname' }, h('h1', {}, it.n), h('span', { class: 'ctb', style: { '--ct': c.color } }, icon(c.icon, 12), h('span', {}, c.label)),
    h('div', { class: 'pstats', title: (it.paths || [it.p]).join('\n') }, [itemSub(it), it.parent ? 'in ' + it.parent.n : null].filter(Boolean).join(' · ')),
    (it.t || []).length ? h('div', { class: 'chips' }, it.t.map((t) => h('span', { class: 'chip', style: chipStyle(tagColor(t)), dataset: { tag: t }, onclick: () => openTagPage(t) }, h('span', { class: 'chip-t' }, t)))) : null),
  h('div', { class: 'pacts' },
    playable ? h('button', { class: 'btn primary', onclick: () => openPlayer(it.p) }, icon('play', 14), 'Play') : null,
    !it.d ? h('button', { class: 'btn', onclick: () => api('/api/open', { Path: it.p }).catch(fail) }, icon('ext', 14), 'Open') : null,
    h('button', { class: 'ibtn', title: 'More', onclick: (e) => { const b = e.currentTarget.getBoundingClientRect(); itemMenu(b.left, b.bottom + 4, it); } }, icon('more', 16))));
  const hero = h('div', { class: 'phero profile ctypehero', style: { '--ct': c.color } }, poster, info);
  const P = { name: '', files: r.items, lk: 'item:' + it.c, shape: 'land' };
  const list = sortItemsByName(r.items.filter(pfPass));
  const fixed = r.items.length ? pageFilterBar(P, { noSort: true }) : null;
  const scrolling = r.items.length
    ? h('div', {}, h('div', { class: 'shead' }, h('h3', {}, it.c === 'series' ? 'In this series' : 'Scenes'), h('em', {}, `${list.length}`)), itemsGrid(list, pageLook(P), { noParent: true }))
    : h('p', { class: 'none' }, it.d ? `Nothing inside is marked yet. Mark its subfolders (or files) as ${it.c === 'series' ? 'stories or scenes' : 'scenes'} in Files.` : 'A single file: open it with the button above.');
  return typedPage(hero, null, fixed, scrolling);
}
// a series lists its parts in their name order (1, 2, ... 10), unless you search
const sortItemsByName = (l) => l.slice().sort((a, b) => collator.compare(a.p, b.p));

function typedPage(hero, tabs, fixed, scrolling) {
  const scroller = h('div', { class: 'pscroll', tabindex: '-1' }, h('div', { class: 'spad' }, scrolling));
  scroller.addEventListener('wheel', (e) => { if (!e.ctrlKey) return; e.preventDefault(); setShelfSize((S.shelfSize || 190) + (e.deltaY < 0 ? 20 : -20)); }, { passive: false });
  return h('div', { class: 'tagpage' }, hero, tabs, fixed ? h('div', { class: 'pfixed' }, fixed) : null, scroller);
}
