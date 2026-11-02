'use strict';
// Folder previews: folders show the pictures/videos inside them (mosaic of up to four, or one picture),
// or a picture the user chose.  Loaded lazily for the folders that are actually on screen.

const COVERS = new Map();            // folder path -> { m: folder mtime, info }
let coverQueue = new Map();          // element -> entry waiting for its preview
let coverTimer = 0;

const coverObs = new IntersectionObserver((es) => {
  for (const x of es) {
    if (!x.isIntersecting) continue;
    coverObs.unobserve(x.target);
    const p = x.target.dataset.p, e = S.byPath.get(p);
    if (e) coverQueue.set(x.target, e);
  }
  if (coverQueue.size && !coverTimer) coverTimer = setTimeout(flushCovers, 40);
}, { rootMargin: '300px' });

function coverWatch(el, e) {
  if (!e.d || S.folderPrev === 'off') return;
  const c = COVERS.get(e.p);
  if (c && c.m === e.m) { queueMicrotask(() => paintCover(el, c.info)); return; }
  coverObs.observe(el);
}

async function flushCovers() {
  coverTimer = 0;
  const batch = [...coverQueue.entries()].slice(0, 60);
  for (const [el] of batch) coverQueue.delete(el);
  if (coverQueue.size) coverTimer = setTimeout(flushCovers, 40);
  if (!batch.length) return;
  let r;
  try { r = await api('/api/covers', { Folders: batch.map(([, e]) => e.p) }); } catch (e) { return; }
  for (const [el, e] of batch) {
    const info = (r.covers || {})[e.p];
    if (!info) continue;
    COVERS.set(e.p, { m: e.m, info });
    if (el.isConnected) paintCover(el, info);
  }
}

// ---------------------------------------------------------------- video stills
const posterFailed = new Set();
const posterBusy = new Map();
let posterRunning = 0; const posterWait = [];
function ensurePoster(it) {
  if (posterBusy.has(it.p)) return posterBusy.get(it.p);
  const run = () => new Promise((resolve) => {
    posterRunning++;
    (async () => {
      const v = document.createElement('video');
      v.muted = true; v.preload = 'auto';
      const ready = new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(new Error('video not readable')); });
      v.src = fileUrl(it.p);
      await withTimeout(ready, 15000, 'video');
      const seeked = new Promise((res) => { v.onseeked = res; });
      try { v.currentTime = Math.min((v.duration || 2) * 0.25, 20); await withTimeout(seeked, 8000, 'seek'); } catch (e) { /* first frame */ }
      const w = v.videoWidth || 320, hh = v.videoHeight || 240, sc = Math.min(1, 360 / Math.max(w, hh));
      const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w * sc)); c.height = Math.max(1, Math.round(hh * sc));
      c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
      v.removeAttribute('src'); v.load();
      const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.82));
      if (!blob) throw new Error('no frame');
      const r = await fetch('/api/poster?p=' + enc(it.p), { method: 'POST', headers: { 'X-TagShelf': '1', 'Content-Type': 'image/jpeg' }, body: blob });
      if (!r.ok) throw new Error('poster not saved');
    })().then(() => true, () => { posterFailed.add(it.p); return false; }).then((okk) => {
      posterRunning--; resolve(okk);
      const n = posterWait.shift(); if (n) n();
    });
  });
  const pr = new Promise((resolve) => {
    const go = () => run().then(resolve);
    if (posterRunning < 2) go(); else posterWait.push(go);
  }).finally(() => posterBusy.delete(it.p));
  posterBusy.set(it.p, pr);
  return pr;
}

// one picture of a preview
function coverCell(it, withPlay) {
  const cell = h('div', { class: 'cc' });
  const src = it.k === 'video' ? thumbUrl(it.p, it.m) : (THUMB_EXT.has(it.x) ? thumbUrl(it.p, it.m) : fileUrl(it.p));
  const img = h('img', { src, loading: 'lazy', decoding: 'async', alt: '', draggable: 'false' });
  img.addEventListener('error', async () => {
    if (it.k !== 'video' || posterFailed.has(it.p)) { cell.replaceChildren(h('div', { class: 'cc-ico' }, icon(it.k === 'video' ? 'video' : 'image', 20))); return; }
    if (await ensurePoster(it)) img.src = src + '&r=1';
    else cell.replaceChildren(h('div', { class: 'cc-ico' }, icon('video', 20)));
  });
  cell.append(img);
  if (it.k === 'video' && withPlay) cell.append(h('span', { class: 'play' }, icon('play', 11)));
  return cell;
}

function paintCover(el, info) {
  const isRow = el.classList.contains('lrow');
  const old = el.querySelector('.fcov, .rcov'); if (old) old.remove();
  const thumb = el.querySelector('.thumb');
  if (thumb) thumb.classList.remove('hascov');
  if (!info || info.none || !info.items || !info.items.length || S.folderPrev === 'off') return;
  const single = S.folderPrev === 'single' || info.custom;
  const items = single ? info.items.slice(0, 1) : info.items.slice(0, 4);
  const n = items.length;
  if (isRow) {
    const box = h('span', { class: 'rcov n' + n }, ...items.map((it) => coverCell(it, false)));
    const c1 = el.querySelector('.c1'); const ic = c1 && c1.querySelector('.ico');
    if (ic) ic.replaceWith(box);
    return;
  }
  if (!thumb) return;
  const box = h('div', { class: 'fcov n' + n }, ...items.map((it) => coverCell(it, true)));
  thumb.append(box);
  if (info.custom) box.append(h('span', { class: 'pin', title: 'Preview chosen by you' }, '★'));
  if (info.n >= 0) box.append(h('span', { class: 'fbadge', title: info.n + (info.n === 1 ? ' item' : ' items') }, icon('folder', 12), String(info.n)));
  thumb.classList.add('hascov');
}

// repaint every visible folder (after the setting changed)
function resetCovers() {
  COVERS.clear();
  coverQueue.clear();
  renderContent();
}

// ---------------------------------------------------------------- choosing
async function setCover(folder, image) {
  try { await api('/api/folder/cover', { Folder: folder, Image: image }); } catch (e) { fail(e); return; }
  COVERS.delete(folder);
  const e = S.byPath.get(folder);
  const el = e && document.querySelector(`#content [data-p="${CSS.escape(folder)}"]`);
  if (el) { paintCover(el, null); coverObs.observe(el); }
  toast(image === '' ? 'Folder preview is automatic again' : image === '-' ? 'Folder preview turned off for this folder' : 'Folder preview set');
}

async function openCoverPicker(folder) {
  let r;
  try { r = await api('/api/list?path=' + enc(folder.p)); } catch (e) { fail(e); return; }
  const pics = (r.entries || []).filter((e) => !e.d && (e.k === 'image' || e.k === 'video')).slice(0, 400);
  if (!pics.length) { toast('There are no pictures or videos directly inside this folder'); return; }
  let chosen = null;
  const grid = h('div', { class: 'pickgrid' });
  const use = async () => { if (!chosen) return false; await setCover(folder.p, chosen); };
  for (const e of pics) {
    const t = h('button', { class: 'pk', title: e.n, onclick: () => { chosen = e.p; for (const x of grid.children) x.classList.toggle('on', x === t); },
      ondblclick: async () => { chosen = e.p; await use(); closeTop(); } }, coverCell({ p: e.p, k: e.k, x: e.x, m: e.m }, true));
    grid.append(t);
  }
  const m = modal('Choose a preview for “' + folder.n + '”', h('div', {}, h('p', { class: 'hint' }, 'Click a picture or video, then “Use this picture”.'), grid),
    [{ label: 'Cancel' }, { label: 'Use this picture', primary: true, fn: use }], { wide: true });
  function closeTop() { if (m && m.close) m.close(); }
}

function folderPreviewMenu(x, y, folder) {
  menu(x, y, [
    { label: 'Choose picture…', icon: 'image', fn: () => openCoverPicker(folder) },
    { label: 'Back to automatic', icon: 'refresh', fn: () => setCover(folder.p, '') },
    '-',
    { label: 'No preview (folder icon)', icon: 'folder', fn: () => setCover(folder.p, '-') },
  ]);
}
