'use strict';
// Full-screen viewer for images, videos and audio, with the tag editor underneath.

const V = { open: false, list: [], i: 0, zoom: false, refocus: false };
const viewerOpen = () => V.open;

function openViewer(path) {
  const list = S.vis.filter((e) => !e.d && (e.k === 'image' || e.k === 'video' || e.k === 'audio'));
  const i = list.findIndex((e) => e.p === path);
  if (i < 0) return;
  V.list = list; V.i = i; V.open = true; V.zoom = false;
  const root = $('#viewer');
  root.hidden = false;
  root.replaceChildren(
    h('div', { class: 'vtop' }, h('span', { class: 'nm', id: 'vname' }), h('span', { class: 'muted', id: 'vpos' }),
      h('button', { class: 'ibtn', title: 'Open with the default app', onclick: () => api('/api/open', { Path: V.list[V.i].p }).catch(fail) }, icon('ext', 17)),
      h('button', { class: 'ibtn', title: 'Show in Explorer', onclick: () => api('/api/open', { Path: V.list[V.i].p, Reveal: true }).catch(fail) }, icon('folder', 17)),
      h('button', { class: 'ibtn', title: 'Close (Esc)', onclick: closeViewer }, icon('x', 20))),
    h('div', { class: 'vstage', id: 'vstage' }),
    h('div', { class: 'vfoot', id: 'vfoot' }));
  showCurrent();
}

function closeViewer() {
  if (!V.open) return;
  V.open = false;
  const root = $('#viewer');
  $$('video, audio', root).forEach((m) => { m.pause(); m.removeAttribute('src'); m.load(); });
  root.hidden = true; root.replaceChildren();
  renderSide();
  scrollToSelected();
}

function stepViewer(d) {
  const n = V.i + d;
  if (n < 0 || n >= V.list.length) return;
  V.i = n; V.zoom = false;
  showCurrent();
}

function showCurrent() {
  const e = V.list[V.i];
  if (!e) return;
  $('#vname').textContent = e.n;
  $('#vpos').textContent = `${V.i + 1} / ${V.list.length}`;
  const stage = $('#vstage');
  $$('video, audio', stage).forEach((m) => { m.pause(); m.removeAttribute('src'); m.load(); });
  stage.classList.remove('zoomed');
  let media;
  if (e.k === 'image') {
    media = h('img', { src: fileUrl(e.p), alt: e.n, draggable: 'false', onclick: (ev) => { V.zoom = !V.zoom; ev.target.classList.toggle('actual', V.zoom); stage.classList.toggle('zoomed', V.zoom); } });
    media.onerror = () => { stage.replaceChildren(h('div', { class: 'empty' }, h('b', {}, 'This picture can\'t be shown'), h('span', {}, 'The browser doesn\'t support this image format. Use “Open with the default app”.'))); };
  } else if (e.k === 'video') {
    media = h('video', { controls: true, autoplay: true, loop: true, src: fileUrl(e.p) });
    media.onerror = () => { stage.replaceChildren(h('div', { class: 'empty' }, h('b', {}, 'This video can\'t be played here'), h('span', {}, 'The browser doesn\'t support its format. Use “Open with the default app”.'))); };
  } else {
    media = h('div', { class: 'empty' }, icon('music', 64), h('audio', { controls: true, autoplay: true, src: fileUrl(e.p) }));
  }
  stage.replaceChildren(media,
    V.i > 0 ? h('button', { class: 'vnav l', title: 'Previous (←)', onclick: () => stepViewer(-1) }, icon('back', 24)) : null,
    V.i < V.list.length - 1 ? h('button', { class: 'vnav r', title: 'Next (→)', onclick: () => stepViewer(1) }, icon('forward', 24)) : null);
  // keep the file selected in the browser behind
  S.sel = new Set([e.p]); S.anchor = S.focus = e.p; paintSel(); renderStatus();
  // warm the neighbours
  for (const d of [1, -1]) { const nb = V.list[V.i + d]; if (nb && nb.k === 'image') new Image().src = fileUrl(nb.p); }
  renderViewerFoot();
}

function refreshViewerTags() { if (V.open) renderViewerFoot(); }

function renderViewerFoot() {
  const foot = $('#vfoot');
  const e = V.list[V.i];
  if (!foot || !e) return;
  const cur = S.byPath.get(e.p) || e;
  const tags = cur.t || [];
  const chips = h('div', { class: 'chips' }, tags.map((t) => tagChip(t, { onremove: () => tagPaths([e.p], [], [t], 'remove tag') })));
  const input = tagInput((list) => { V.refocus = true; tagPaths([e.p], list, [], 'add tags'); }, { exclude: () => tags, placeholder: 'Add a tag…' });
  const quick = h('div', { class: 'chips' }, quickTags().map((t, i) => {
    const on = tags.includes(t);
    return h('span', { class: 'chip quick ' + (on ? 'on' : 'off'), style: chipStyle(tagColor(t)), title: `Press ${i + 1}` },
      h('span', { class: 'chip-t', onclick: () => tagPaths([e.p], on ? [] : [t], on ? [t] : [], on ? 'remove tag' : 'add tag') }, h('kbd', {}, i + 1), t));
  }));
  foot.replaceChildren(
    h('div', {}, h('div', { class: 'sh' }, 'Tags'), tags.length ? chips : h('p', { class: 'none' }, 'No tags yet.'), input),
    S.ai ? h('div', {}, h('div', { class: 'sh' }, h('span', { class: 'ai-badge' }, icon('sparkle', 13), 'Suggestions')), h('div', { id: 'vsugbox' })) : null,
    h('div', {}, h('div', { class: 'sh' }, 'Quick tags (keys 1–9)'), quick),
    h('div', {}, h('div', { class: 'sh' }, 'Rating'), starsRow([e.p], cur.r || 0, renderViewerFoot)));
  if (S.ai) renderSuggestions($('#vsugbox'), [e.p]);
  if (V.refocus) { V.refocus = false; const i = $('.tag-in', foot); if (i) i.focus(); }
}

// returns true when the key was used
function viewerKey(e) {
  const k = e.key;
  if (k === 'Escape') { closeViewer(); return true; }
  if (k === 'ArrowLeft') { stepViewer(-1); return true; }
  if (k === 'ArrowRight') { stepViewer(1); return true; }
  if (k === 'Home') { V.i = 0; showCurrent(); return true; }
  if (k === 'End') { V.i = V.list.length - 1; showCurrent(); return true; }
  if (k === ' ') { const m = $('#vstage video, #vstage audio'); if (m) { if (m.paused) m.play(); else m.pause(); return true; } stepViewer(1); return true; }
  if (k.toLowerCase() === 'f') { const img = $('#vstage img'); if (img) img.click(); return true; }
  if (e.altKey && /^[0-5]$/.test(k)) { ratePaths([V.list[V.i].p], +k).then(renderViewerFoot); return true; }
  if (!e.ctrlKey && !e.altKey && /^[1-9]$/.test(k)) { toggleQuickTag(+k - 1); return true; }
  return false;
}
