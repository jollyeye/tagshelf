'use strict';
// Scene / story player: the pictures and videos of a scene or story as one continuous slideshow.
// The progress bar covers the whole thing: (pictures × seconds per picture) + the length of every video.
// Hovering the bar previews that moment (the picture, or the video frame); chapters mark the scenes of a story.

const PL = { open: false, data: null, items: [], starts: [], total: 0, i: 0, t: 0, playing: true, last: 0, raf: 0, el: null, media: null, hideT: 0, seq: 0, muted: false };
const PL_UNKNOWN = 10000; // a video's length until it has been measured
const imgMs = () => Math.max(1, S.imgSecs || 4) * 1000;
const itemMs = (it) => (it.k === 'video' ? (it.dur || PL_UNKNOWN) : imgMs());

function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000)), hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  return (hh ? hh + ':' + String(mm).padStart(2, '0') : mm) + ':' + String(ss).padStart(2, '0');
}

function plTimeline() {
  let t = 0;
  PL.starts = PL.items.map((it) => { const s = t; t += itemMs(it); return s; });
  PL.total = t;
}
function plIndexAt(ms) {
  let lo = 0, hi = PL.items.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (PL.starts[mid] <= ms) lo = mid; else hi = mid - 1; }
  return lo;
}
const plNow = () => (PL.starts[PL.i] || 0) + PL.t;
// a chapter's name; the loose pictures of the story itself have none
const plChName = (c) => (c && !(c.c === '' && c.p === PL.data.p) ? c.name : '');
function plChapterAt(i) {
  const ch = (PL.data && PL.data.chapters) || [];
  let cur = null;
  for (const c of ch) if (c.start <= i) cur = c; else break;
  return cur;
}

async function openPlayer(path) {
  const seq = ++PL.seq;
  let r;
  try { r = await api('/api/play', { Path: path }); } catch (e) { fail(e); return; }
  if (seq !== PL.seq) return;
  if (!r.items || !r.items.length) { toast('Nothing to play here: no pictures or videos (subfolders only play when they are marked as scenes)'); return; }
  closeMenu();
  const t = $('#toast'); if (t) t.hidden = true;
  PL.data = r; PL.items = r.items; PL.i = 0; PL.t = 0; PL.playing = true; PL.open = true;
  plTimeline();
  plBuild();
  plShow(0, 0);
  plMeasure(seq);
}

function closePlayer() {
  if (!PL.open) return;
  PL.open = false; PL.seq++;
  cancelAnimationFrame(PL.raf);
  if (PL.media && PL.media.tagName === 'VIDEO') { PL.media.pause(); PL.media.removeAttribute('src'); PL.media.load(); }
  if (PL.scrub) { PL.scrub.removeAttribute('src'); PL.scrub.load(); PL.scrub = null; }
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  if (PL.el) PL.el.remove();
  PL.el = PL.media = null;
}

// ---------------------------------------------------------------- building the window
function plBuild() {
  if (PL.el) PL.el.remove();
  const d = PL.data;
  const c = CT[d.c] || CT.scene;
  const stage = h('div', { class: 'plstage', onclick: () => plToggle(), oncontextmenu: (e) => { e.preventDefault(); plMenu(e.clientX, e.clientY); } });
  const marks = h('div', { class: 'plmarks' });
  const fill = h('div', { class: 'plfill' });
  const knob = h('div', { class: 'plknob' });
  const tip = h('div', { class: 'pltip', hidden: true }, h('div', { class: 'pltipic' }), h('div', { class: 'pltipt' }));
  const bar = h('div', { class: 'plbar' }, h('div', { class: 'pltrack' }, fill, marks), knob, tip);
  const strip = h('div', { class: 'plstrip', hidden: true });
  const secs = h('select', { class: 'txt small plsecs', title: 'How long each picture stays', onchange: (e) => { S.imgSecs = +e.target.value; saveSettingsSoon(); const at = PL.t; plTimeline(); PL.t = Math.min(at, itemMs(PL.items[PL.i])); plPaint(); } },
    [1, 2, 3, 4, 5, 6, 8, 10, 15, 20, 30].map((v) => h('option', { value: v, selected: v === (S.imgSecs || 4) }, v + ' s per picture')));
  const el = h('div', { id: 'player', class: 'pl', tabindex: '-1' },
    h('div', { class: 'pltop' },
      h('span', { class: 'ctb', style: { '--ct': c.color } }, icon(c.icon, 12), h('span', {}, c.label)),
      h('b', { class: 'plname' }, d.name), h('span', { class: 'plch' }),
      h('span', { class: 'sp' }),
      h('span', { class: 'plcount' }),
      h('button', { class: 'ibtn', title: 'Show in Files', onclick: () => { const p = PL.items[PL.i].p; closePlayer(); setMode('files', { noRefresh: true }).then(() => go(dirOf(p), { select: p })); } }, icon('folder', 17)),
      h('button', { class: 'ibtn', title: 'Close (Esc)', onclick: closePlayer }, icon('x', 19))),
    stage,
    h('div', { class: 'plctl' }, strip, bar,
      h('div', { class: 'plbtns' },
        h('button', { class: 'ibtn', title: 'Previous (←)', onclick: () => plStep(-1) }, icon('back', 18)),
        h('button', { class: 'ibtn plpp', title: 'Play / pause (Space)', onclick: () => plToggle() }, icon('play', 18)),
        h('button', { class: 'ibtn', title: 'Next (→)', onclick: () => plStep(1) }, icon('forward', 18)),
        h('span', { class: 'pltime' }),
        h('span', { class: 'sp' }),
        secs,
        h('button', { class: 'ibtn plmute', title: 'Sound on / off (M)', onclick: () => { PL.muted = !PL.muted; if (PL.media && PL.media.tagName === 'VIDEO') PL.media.muted = PL.muted; plPaint(); } }, icon('music', 17)),
        h('button', { class: 'ibtn', title: 'Full screen (F)', onclick: () => plFull() }, icon('grid', 17)))));
  document.body.append(el);
  PL.el = el;
  // the progress bar: click / drag to jump, hover to preview
  const at = (ev) => { const r = bar.getBoundingClientRect(); return Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * PL.total; };
  let drag = false;
  bar.addEventListener('pointerdown', (ev) => { drag = true; bar.setPointerCapture(ev.pointerId); plSeek(at(ev)); });
  bar.addEventListener('pointermove', (ev) => { plTip(ev, at(ev)); if (drag) plSeek(at(ev), true); });
  bar.addEventListener('pointerup', (ev) => { if (drag) { drag = false; plSeek(at(ev)); } });
  bar.addEventListener('pointerleave', () => { tip.hidden = true; strip.hidden = true; });
  // controls fade out while playing and the mouse rests
  el.addEventListener('mousemove', plWake);
  el.addEventListener('wheel', (ev) => { ev.preventDefault(); plStep(ev.deltaY > 0 ? 1 : -1); }, { passive: false });
  plMarks();
  plWake();
  el.focus();
}

function plWake() {
  if (!PL.el) return;
  PL.el.classList.remove('idle');
  clearTimeout(PL.hideT);
  PL.hideT = setTimeout(() => { if (PL.el && PL.playing && !PL.el.querySelector('.plbar:hover')) PL.el.classList.add('idle'); }, 2500);
}

function plFull() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else if (PL.el) PL.el.requestFullscreen().catch(() => {});
}

// chapter marks (a story's scenes)
function plMarks() {
  const box = PL.el && PL.el.querySelector('.plmarks');
  if (!box) return;
  const ch = (PL.data.chapters || []).filter((c) => c.start > 0);
  box.replaceChildren(...ch.map((c) => h('i', { style: { left: (PL.starts[c.start] / PL.total * 100) + '%' }, title: plChName(c) })));
}

// ---------------------------------------------------------------- showing one item
function plShow(i, offset) {
  if (!PL.open) return;
  i = Math.max(0, Math.min(PL.items.length - 1, i));
  const it = PL.items[i];
  const stage = PL.el.querySelector('.plstage');
  const same = PL.media && PL.i === i && PL.media.dataset.p === it.p;
  PL.i = i; PL.t = Math.max(0, offset || 0);
  if (!same) {
    if (PL.media && PL.media.tagName === 'VIDEO') { PL.media.pause(); PL.media.removeAttribute('src'); PL.media.load(); }
    let m;
    if (it.k === 'video') {
      m = h('video', { class: 'plmedia', playsinline: true, preload: 'auto' });
      m.muted = PL.muted;
      m.src = fileUrl(it.p);
      m.addEventListener('loadedmetadata', () => {
        const ms = Math.round(m.duration * 1000);
        if (isFinite(ms) && ms > 0 && ms !== it.dur) { plSetDur(it, ms); plSaveDur([it]); }
        if (PL.t > 0) m.currentTime = PL.t / 1000;
      }, { once: true });
      m.addEventListener('ended', () => { if (PL.media === m) plStep(1, true); });
      m.addEventListener('error', () => { if (PL.media === m) setTimeout(() => PL.media === m && plStep(1, true), 800); });
      if (PL.playing) m.play().catch(() => {});
    } else {
      m = h('img', { class: 'plmedia', alt: '', decoding: 'async', draggable: 'false' });
      m.src = fileUrl(it.p);
    }
    m.dataset.p = it.p;
    stage.replaceChildren(m);
    PL.media = m;
    // have the next picture ready
    const nx = PL.items[i + 1];
    if (nx && nx.k === 'image') { const pre = new Image(); pre.src = fileUrl(nx.p); }
  } else if (it.k === 'video') {
    PL.media.currentTime = PL.t / 1000;
    if (PL.playing) PL.media.play().catch(() => {});
  }
  PL.last = performance.now();
  cancelAnimationFrame(PL.raf);
  PL.raf = requestAnimationFrame(plTick);
  plPaint();
}

function plTick(now) {
  if (!PL.open) return;
  const it = PL.items[PL.i];
  if (it.k === 'video') {
    if (PL.media && PL.media.tagName === 'VIDEO' && PL.media.readyState > 0) PL.t = PL.media.currentTime * 1000;
  } else if (PL.playing) {
    PL.t += now - PL.last;
    if (PL.t >= imgMs()) { PL.last = now; plStep(1, true); return; }
  }
  PL.last = now;
  plPaint();
  PL.raf = requestAnimationFrame(plTick);
}

function plStep(d, auto) {
  const j = PL.i + d;
  if (j >= PL.items.length) {
    // the end: stay on the last one, paused
    PL.playing = false; PL.t = itemMs(PL.items[PL.i]);
    if (PL.media && PL.media.tagName === 'VIDEO') PL.media.pause();
    plPaint(); if (PL.el) PL.el.classList.remove('idle');
    return;
  }
  if (j < 0) { plShow(0, 0); return; }
  plShow(j, 0);
  if (!auto) plWake();
}

function plSeek(ms, light) {
  ms = Math.max(0, Math.min(PL.total - 1, ms));
  const i = plIndexAt(ms);
  const off = ms - PL.starts[i];
  if (light && i === PL.i && PL.items[i].k !== 'video') { PL.t = off; plPaint(); return; }
  plShow(i, off);
}

function plToggle(force) {
  PL.playing = force != null ? force : !PL.playing;
  if (PL.playing && PL.i === PL.items.length - 1 && PL.t >= itemMs(PL.items[PL.i]) - 50) { plShow(0, 0); return; } // replay
  if (PL.media && PL.media.tagName === 'VIDEO') { if (PL.playing) PL.media.play().catch(() => {}); else PL.media.pause(); }
  PL.last = performance.now();
  plPaint(); plWake();
}

function plPaint() {
  if (!PL.el) return;
  const now = Math.min(plNow(), PL.total);
  const pct = PL.total ? now / PL.total * 100 : 0;
  PL.el.querySelector('.plfill').style.width = pct + '%';
  PL.el.querySelector('.plknob').style.left = pct + '%';
  const unknown = PL.items.some((it) => it.k === 'video' && !it.dur);
  PL.el.querySelector('.pltime').textContent = fmtClock(now) + ' / ' + (unknown ? '~' : '') + fmtClock(PL.total);
  PL.el.querySelector('.plcount').textContent = `${PL.i + 1} / ${PL.items.length}`;
  const ch = plChapterAt(PL.i);
  PL.el.querySelector('.plch').textContent = plChName(ch) && (PL.data.chapters || []).length > 1 ? '· ' + plChName(ch) : '';
  const pp = PL.el.querySelector('.plpp');
  const st = PL.playing ? 'pause' : 'play';
  if (pp.dataset.st !== st) { pp.dataset.st = st; pp.replaceChildren(PL.playing ? h('span', { class: 'ico pause' }, h('i'), h('i')) : icon('play', 18)); }
  PL.el.querySelector('.plmute').classList.toggle('off', PL.muted);
  PL.el.classList.toggle('paused', !PL.playing);
}

// ---------------------------------------------------------------- hover preview on the bar
function plTip(ev, ms) {
  if (PL.items.length > 1) { plStrip(ev, ms); return; }
  const tip = PL.el.querySelector('.pltip');
  tip.classList.remove('stripmode');
  const bar = PL.el.querySelector('.plbar').getBoundingClientRect();
  tip.hidden = false;
  const x = Math.max(90, Math.min(bar.width - 90, ev.clientX - bar.left));
  tip.style.left = x + 'px';
  const i = plIndexAt(ms), it = PL.items[i], off = ms - PL.starts[i];
  const ch = plChapterAt(i);
  tip.querySelector('.pltipt').textContent = fmtClock(ms) + (plChName(ch) && (PL.data.chapters || []).length > 1 ? ' · ' + plChName(ch) : '');
  const pic = tip.querySelector('.pltipic');
  if (it.k === 'image') {
    if (pic.dataset.p !== it.p) { pic.dataset.p = it.p; pic.replaceChildren(h('img', { src: THUMB_EXT.has(it.x) ? thumbUrl(it.p, it.m) : fileUrl(it.p), alt: '' })); }
  } else plFrame(it, off, pic);
}

// ---------------------------------------------------------------- the filmstrip (several items at once)
// One cell per picture or clip; the strip slides with the mouse so the moment under it sits under the
// pointer. Only the cells that fit on screen exist (a few dozen, reused), so 1000 items cost the same as 10.
const PL_CELL_W = 172, PL_CELL_GAP = 4;
function plStrip(ev, ms) {
  const strip = PL.el.querySelector('.plstrip'), tip = PL.el.querySelector('.pltip');
  strip.hidden = false;
  const sr = strip.getBoundingClientRect();
  const W = sr.width, step = PL_CELL_W + PL_CELL_GAP;
  const mx = Math.max(0, Math.min(W, ev.clientX - sr.left));
  const i = plIndexAt(ms), it = PL.items[i];
  const frac = Math.max(0, Math.min(0.999, (ms - PL.starts[i]) / itemMs(it)));
  // the left edge of item j is at mx + (j - i - frac) * step
  const first = Math.max(0, Math.floor(i + frac - mx / step));
  const n = Math.ceil(W / step) + 2;
  // a fixed pool; item j always uses cell j % n, so sliding only refills the cells that come into view
  if (strip.children.length !== n) strip.replaceChildren(...Array.from({ length: n }, () => h('div', { class: 'plcell' }, h('div', { class: 'plcbox' }), h('span', { class: 'plcn' }))));
  for (let k = 0; k < n; k++) {
    const j = first + k, cell = strip.children[j % n];
    if (j >= PL.items.length) { cell.hidden = true; continue; }
    cell.hidden = false;
    const x = mx + (j - i - frac) * step;
    cell.style.transform = `translateX(${x.toFixed(1)}px)`;
    const jt = PL.items[j];
    const box = cell.firstChild;
    if (cell.dataset.j !== String(j)) {
      cell.dataset.j = j;
      box.dataset.p = '';
      box.replaceChildren(coverCell({ p: jt.p, k: jt.k, x: jt.x, m: jt.m }, true));
      cell.lastChild.textContent = j + 1;
    }
    cell.classList.toggle('on', j === i);
  }
  // the clip under the pointer shows its frame at that exact moment
  if (it.k === 'video') {
    const cell = [...strip.children].find((c) => c.dataset.j === String(i));
    if (cell) plFrame(it, ms - PL.starts[i], cell.firstChild);
  }
  // the time (and scene) under the pointer
  tip.hidden = false;
  tip.classList.add('stripmode');
  const br = PL.el.querySelector('.plbar').getBoundingClientRect();
  tip.style.left = Math.max(40, Math.min(br.width - 40, ev.clientX - br.left)) + 'px';
  const ch = plChapterAt(i);
  tip.querySelector('.pltipt').textContent = fmtClock(ms) + (plChName(ch) && (PL.data.chapters || []).length > 1 ? ' · ' + plChName(ch) : '');
}

// a video's frame at a moment: one hidden video does the seeking; frames are kept (per second)
const PL_FRAMES = new Map();
function plFrame(it, off, pic) {
  const sec = Math.floor(off / 1000);
  const key = it.p + '|' + sec;
  const show = (url) => { pic.dataset.p = key; pic.replaceChildren(h('img', { src: url, alt: '' })); };
  if (PL_FRAMES.has(key)) { show(PL_FRAMES.get(key)); return; }
  if (pic.dataset.p !== key && !pic.querySelector('img')) pic.replaceChildren(h('img', { src: thumbUrl(it.p, it.m), alt: '' }));
  PL.want = { it, sec, key, pic };
  if (PL.grabbing) return;
  plGrab();
}
function plGrab() {
  const w = PL.want; PL.want = null;
  if (!w || !PL.open) { PL.grabbing = false; return; }
  PL.grabbing = true;
  let v = PL.scrub;
  if (!v) { v = PL.scrub = h('video', { muted: true, preload: 'auto', playsinline: true }); v.muted = true; }
  const done = () => {
    try {
      const cw = 192, ch = Math.round(cw * (v.videoHeight || 9) / (v.videoWidth || 16));
      const cv = h('canvas', { width: cw, height: ch });
      cv.getContext('2d').drawImage(v, 0, 0, cw, ch);
      const url = cv.toDataURL('image/jpeg', 0.7);
      if (PL_FRAMES.size > 600) PL_FRAMES.clear();
      PL_FRAMES.set(w.key, url);
      if (w.pic.isConnected && (!PL.want || PL.want.key === w.key)) w.pic.dataset.p = w.key, w.pic.replaceChildren(h('img', { src: url, alt: '' }));
    } catch (e) { /* a frame we can't read */ }
    plGrab();
  };
  const seek = () => { v.addEventListener('seeked', done, { once: true }); v.currentTime = Math.min(w.sec + 0.05, Math.max(0, (v.duration || 1) - 0.05)); };
  if (v.dataset.p !== w.it.p) {
    v.dataset.p = w.it.p;
    v.addEventListener('loadeddata', seek, { once: true });
    v.addEventListener('error', () => { PL.grabbing = false; }, { once: true });
    v.src = fileUrl(w.it.p);
  } else seek();
}

// ---------------------------------------------------------------- video lengths
function plSetDur(it, ms) {
  it.dur = ms;
  const at = plNow();
  const cur = PL.items[PL.i];
  plTimeline();
  PL.t = Math.min(PL.t, itemMs(cur));
  plMarks();
  plPaint();
  return at;
}
function plSaveDur(list) {
  api('/api/durations', { Items: list.map((it) => ({ P: it.p, M: it.m, S: it.s, Ms: it.dur })) }).catch(() => {});
}
// videos whose length isn't known yet: read it from their metadata, a few at a time
async function plMeasure(seq) {
  const todo = PL.items.filter((it) => it.k === 'video' && !it.dur);
  if (!todo.length) return;
  const got = [];
  const one = (it) => new Promise((resolve) => {
    const v = document.createElement('video');
    v.preload = 'metadata'; v.muted = true;
    const end = () => { v.removeAttribute('src'); v.load(); resolve(); };
    v.addEventListener('loadedmetadata', () => { const ms = Math.round(v.duration * 1000); if (isFinite(ms) && ms > 0) { it.dur = ms; got.push(it); } end(); }, { once: true });
    v.addEventListener('error', end, { once: true });
    setTimeout(end, 8000);
    v.src = fileUrl(it.p);
  });
  let k = 0;
  const worker = async () => { while (k < todo.length && seq === PL.seq) await one(todo[k++]); };
  await Promise.all([worker(), worker(), worker()]);
  if (seq !== PL.seq) return;
  plTimeline(); plMarks(); plPaint();
  if (got.length) plSaveDur(got);
}

// keys while the player is open (before anything else sees them)
window.addEventListener('keydown', (e) => {
  if (!PL.open) return;
  if (e.target.closest && e.target.closest('select')) return;
  const k = e.key;
  let used = true;
  if (k === 'Escape') { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); else closePlayer(); }
  else if (k === ' ' || k === 'k') plToggle();
  else if (k === 'ArrowRight') { if (e.shiftKey) plChapter(1); else plStep(1); }
  else if (k === 'ArrowLeft') { if (e.shiftKey) plChapter(-1); else plStep(-1); }
  else if (k === 'PageDown') plChapter(1);
  else if (k === 'PageUp') plChapter(-1);
  else if (k === 'Home') plShow(0, 0);
  else if (k === 'f' || k === 'F') plFull();
  else if (k === 'm' || k === 'M') { PL.muted = !PL.muted; if (PL.media && PL.media.tagName === 'VIDEO') PL.media.muted = PL.muted; plPaint(); }
  else used = false;
  if (used) { e.preventDefault(); e.stopPropagation(); plWake(); }
}, true);

function plChapter(d) {
  const ch = (PL.data.chapters || []).map((c) => c.start);
  if (!ch.length) { plStep(d); return; }
  if (d > 0) { const n = ch.find((s) => s > PL.i); if (n != null) plShow(n, 0); }
  else {
    // back to the start of this chapter, or (already there) to the previous one
    const cur = [...ch].reverse().find((s) => s <= PL.i) || 0;
    if (PL.i > cur || PL.t > 1500) plShow(cur, 0);
    else plShow([...ch].reverse().find((s) => s < cur) || 0, 0);
  }
}

// right-click on the picture: use what is on screen as the scene's / story's preview
function plMenu(x, y) {
  const it = PL.items[PL.i], d = PL.data;
  if (!it) return;
  const name = d.name;
  menu(x, y, [
    it.k === 'video'
      ? { label: `Use this frame as preview of “${name}”`, icon: 'image', fn: () => { if (PL.playing) plToggle(false); useFrameAsPreview(PL.media, d.p, name); } }
      : { label: `Use this picture as preview of “${name}”`, icon: 'image', fn: () => setItemCover(d.p, it.p) },
    { label: 'Automatic preview', icon: 'refresh', fn: () => setItemCover(d.p, '') },
    '-',
    { label: PL.playing ? 'Pause' : 'Play', icon: 'play', fn: () => plToggle() },
  ]);
}
