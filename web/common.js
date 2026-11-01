'use strict';
// ---------------------------------------------------------------- tiny helpers
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') { for (const [sk, sv] of Object.entries(v)) { if (sv == null) continue; if (sk.startsWith('--')) el.style.setProperty(sk, sv); else el.style[sk] = sv; } }
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'selected' || k === 'disabled' || k === 'hidden' || k === 'draggable') el[k] = v === true || v === 'true' ? true : v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const ICONS = {
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m21 16-5-5-8 8"/>',
  video: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9 5 3-5 3z"/>',
  music: '<path d="M9 18V6l11-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>',
  back: '<path d="m15 6-6 6 6 6"/>', forward: '<path d="m9 6 6 6-6 6"/>', up: '<path d="m6 15 6-6 6 6"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4-4"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
  settings: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  tag: '<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1.3"/>',
  star: '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>',
  x: '<path d="m6 6 12 12M18 6 6 18"/>', check: '<path d="m5 12 5 5 9-10"/>', plus: '<path d="M12 5v14M5 12h14"/>',
  chevR: '<path d="m9 6 6 6-6 6"/>', chevD: '<path d="m6 9 6 6 6-6"/>',
  drive: '<rect x="3" y="13" width="18" height="7" rx="2"/><path d="M5 13l2-8h10l2 8M17 16.5h.01"/>',
  home: '<path d="m3 11 9-8 9 8"/><path d="M5 10v10h5v-6h4v6h5V10"/>',
  desktop: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  download: '<path d="M12 4v11m-5-4 5 5 5-5M4 20h16"/>',
  doc: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
  pin: '<path d="m9 4h6l-1 6 3 3H7l3-3z"/><path d="M12 13v7"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  cut: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><path d="M20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12"/>',
  paste: '<rect x="5" y="5" width="14" height="16" rx="2"/><path d="M9 5V3h6v2"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z"/>',
  filter: '<path d="M4 5h16l-6 8v6l-4-2v-4z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  ext: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-4"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  alert: '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17h.01"/>',
  play: '<path d="m8 5 11 7-11 7z"/>',
  newfolder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 10v6M9 13h6"/>',
};
function icon(name, size = 16) {
  const s = h('span', { class: 'ico' });
  s.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ICONS.file}</svg>`;
  return s;
}

// ---------------------------------------------------------------- api
async function api(path, body) {
  const opt = body === undefined ? {} : { method: 'POST', headers: { 'X-TagShelf': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  let r;
  try { r = await fetch(path, opt); } catch (e) { throw new Error('TagShelf is not running any more - please start it again.'); }
  let j = null;
  try { j = await r.json(); } catch (e) { /* not json */ }
  if (!r.ok) throw new Error((j && j.error) || `Something went wrong (${r.status})`);
  return j;
}
const enc = encodeURIComponent;
const fileUrl = (p) => '/file?p=' + enc(p);
const thumbUrl = (p, m) => '/thumb?p=' + enc(p) + '&v=' + (m || 0);

function fmtSize(n) {
  if (n == null) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n : n < 10 ? n.toFixed(1) : Math.round(n)) + ' ' + u[i];
}
function fmtDate(sec) {
  if (!sec) return '';
  const d = new Date(sec * 1000);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
const baseName = (p) => p.split(/[\\/]/).filter(Boolean).pop() || p;
function stem(n) { const i = n.lastIndexOf('.'); return i > 0 ? n.slice(0, i) : n; }
function dirOf(p) {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  if (i < 0) return p;
  const d = p.slice(0, i);
  return /^[A-Za-z]:$/.test(d) ? d + '\\' : d || '/';
}
function joinPath(a, b) { return a.endsWith('\\') || a.endsWith('/') ? a + b : a + (a.includes('\\') ? '\\' : '/') + b; }
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- the small "AI": image fingerprints
// 48 colour-layout + 64 colour-histogram + 32 edge-direction + 8 global numbers = 152.
const FD = 152;
function fingerprint(ctx, aspect) {
  const N = 32, d = ctx.getImageData(0, 0, N, N).data;
  const Y = new Float32Array(N * N), CB = new Float32Array(N * N), CR = new Float32Array(N * N);
  const hist = new Float32Array(64);
  let sumY = 0, sumS = 0, dark = 0, bright = 0;
  for (let i = 0; i < N * N; i++) {
    const r = d[i * 4] / 255, g = d[i * 4 + 1] / 255, b = d[i * 4 + 2] / 255;
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    Y[i] = y; CB[i] = (b - y) * 0.564; CR[i] = (r - y) * 0.713;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    sumY += y; sumS += mx > 0 ? (mx - mn) / mx : 0;
    if (y < 0.15) dark++; if (y > 0.85) bright++;
    hist[(Math.min(3, (r * 4) | 0) << 4) | (Math.min(3, (g * 4) | 0) << 2) | Math.min(3, (b * 4) | 0)]++;
  }
  const A = new Float32Array(48);
  for (let cy = 0; cy < 4; cy++) for (let cx = 0; cx < 4; cx++) {
    let a = 0, b = 0, c = 0;
    for (let y = cy * 8; y < cy * 8 + 8; y++) for (let x = cx * 8; x < cx * 8 + 8; x++) { const i = y * N + x; a += Y[i]; b += CB[i]; c += CR[i]; }
    const o = (cy * 4 + cx) * 3; A[o] = a / 64; A[o + 1] = b / 64; A[o + 2] = c / 64;
  }
  const B = new Float32Array(64);
  for (let i = 0; i < 64; i++) B[i] = Math.sqrt(hist[i] / (N * N));
  const C = new Float32Array(32);
  let totMag = 0;
  for (let y = 1; y < N - 1; y++) for (let x = 1; x < N - 1; x++) {
    const p = (yy, xx) => Y[yy * N + xx];
    const gx = (p(y - 1, x + 1) + 2 * p(y, x + 1) + p(y + 1, x + 1)) - (p(y - 1, x - 1) + 2 * p(y, x - 1) + p(y + 1, x - 1));
    const gy = (p(y + 1, x - 1) + 2 * p(y + 1, x) + p(y + 1, x + 1)) - (p(y - 1, x - 1) + 2 * p(y - 1, x) + p(y - 1, x + 1));
    const mag = Math.hypot(gx, gy);
    let ang = Math.atan2(gy, gx); if (ang < 0) ang += Math.PI;
    const bin = Math.min(7, Math.floor(ang / Math.PI * 8));
    C[((y < 16 ? 0 : 1) * 2 + (x < 16 ? 0 : 1)) * 8 + bin] += mag; totMag += mag;
  }
  for (let c = 0; c < 4; c++) { let s = 0; for (let k = 0; k < 8; k++) s += C[c * 8 + k]; for (let k = 0; k < 8; k++) C[c * 8 + k] /= s + 2; }
  const meanY = sumY / (N * N);
  let varY = 0, mcb = 0, mcr = 0;
  for (let i = 0; i < N * N; i++) { varY += (Y[i] - meanY) ** 2; mcb += CB[i]; mcr += CR[i]; }
  mcb /= N * N; mcr /= N * N;
  let vc = 0; for (let i = 0; i < N * N; i++) vc += (CB[i] - mcb) ** 2 + (CR[i] - mcr) ** 2;
  const D = Float32Array.from([
    Math.max(-1, Math.min(1, Math.log2(aspect || 1) / 2)), meanY, Math.sqrt(varY / (N * N)), sumS / (N * N),
    Math.min(1, totMag / ((N - 2) * (N - 2)) / 2), dark / (N * N), bright / (N * N), Math.min(1, Math.sqrt(vc / (N * N)) * 2),
  ]);
  const out = [];
  for (const [blk, w] of [[A, 1], [B, 1], [C, 0.9], [D, 0.6]]) {
    let n = 0; for (const x of blk) n += x * x; n = Math.sqrt(n) || 1;
    for (const x of blk) out.push(x / n * w);
  }
  let n = 0; for (const x of out) n += x * x; n = Math.sqrt(n) || 1;
  return out.map((x) => x / n);
}
function withTimeout(p, ms, what) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(what + ' timed out')), ms))]);
}
async function mediaVector(path, kind, mtime) {
  const c = document.createElement('canvas'); c.width = c.height = 32;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  if (kind === 'video') {
    const v = document.createElement('video');
    v.muted = true; v.preload = 'auto'; v.crossOrigin = 'anonymous';
    const ready = new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(new Error('video not readable')); });
    v.src = fileUrl(path);
    await withTimeout(ready, 15000, 'video');
    const seeked = new Promise((res) => { v.onseeked = res; });
    try { v.currentTime = Math.min((v.duration || 2) * 0.25, 20); await withTimeout(seeked, 8000, 'seek'); } catch (e) { /* use first frame */ }
    ctx.drawImage(v, 0, 0, 32, 32);
    const asp = v.videoWidth / (v.videoHeight || 1);
    v.removeAttribute('src'); v.load();
    return fingerprint(ctx, asp);
  }
  const img = new Image();
  img.src = thumbUrl(path, mtime);
  await withTimeout(img.decode(), 20000, 'image');
  ctx.drawImage(img, 0, 0, 32, 32);
  return fingerprint(ctx, img.naturalWidth / (img.naturalHeight || 1));
}
// Fingerprints the given files (in the background) and sends them to the app.
const aiFailed = new Set();
async function indexFiles(items, onProgress) {
  const todo = items.filter((x) => (x.kind === 'image' || x.kind === 'video') && !aiFailed.has(x.path));
  let done = 0, i = 0;
  const batch = [];
  const flush = async () => { if (batch.length) { const b = batch.splice(0); try { await api('/api/ai/vec', { Items: b }); } catch (e) { /* retry later */ } } };
  const worker = async () => {
    while (i < todo.length) {
      const it = todo[i++];
      try { batch.push({ Path: it.path, Vec: await mediaVector(it.path, it.kind, it.mtime) }); }
      catch (e) { aiFailed.add(it.path); }
      done++; if (onProgress) onProgress(done, todo.length);
      if (batch.length >= 8) await flush();
    }
  };
  await Promise.all([worker(), worker()]);
  await flush();
  return done;
}

// ---------------------------------------------------------------- misc helpers
const IMG_EXT = new Set(['.jpg', '.jpeg', '.jfif', '.png', '.gif', '.webp', '.bmp', '.svg', '.avif']);
const VID_EXT = new Set(['.mp4', '.webm', '.mov', '.mkv', '.avi', '.m4v', '.wmv']);
const AUD_EXT = new Set(['.mp3', '.flac', '.wav', '.ogg', '.m4a', '.aac', '.opus', '.wma']);
function extOf(p) { const n = baseName(p); const i = n.lastIndexOf('.'); return i > 0 ? n.slice(i).toLowerCase() : ''; }
function kindFromPath(p) { const x = extOf(p); return IMG_EXT.has(x) ? 'image' : VID_EXT.has(x) ? 'video' : AUD_EXT.has(x) ? 'audio' : 'other'; }
const THUMB_EXT = new Set(['.jpg', '.jpeg', '.jfif', '.png', '.gif']);
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); return true; } catch (e) { return false; }
}
