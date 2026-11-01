'use strict';
// "Tag this download": one card per freshly downloaded picture or video.  Used by the small popup window
// (popup.html) and by the "New downloads" dialog inside the main window.

function mountDownloads(root, opt = {}) {
  const D = { items: [], cur: null, tags: [], moveTo: '', sug: null, seq: 0, busy: false };
  let timer = 0, stopped = false;

  function sugFor(it) {
    if (!S.ai || !it) { D.sug = null; return; }
    const seq = ++D.seq;
    D.sug = { loading: true, items: [] };
    (async () => {
      let r = await api('/api/ai/suggest', { Paths: [it.path] });
      if (r.need && r.need.length) {
        await indexFiles([{ path: it.path, kind: it.kind, mtime: 0 }]);
        r = await api('/api/ai/suggest', { Paths: [it.path] });
      }
      if (seq !== D.seq || stopped) return;
      D.sug = { loading: false, ready: r.ready, trained: r.trained, items: r.items || [] };
      drawSuggestions();
    })().catch(() => { if (seq === D.seq) { D.sug = { loading: false, items: [] }; drawSuggestions(); } });
  }

  async function poll(first) {
    let items;
    try { items = (await api('/api/downloads')).items || []; } catch (e) { return; }
    if (stopped) return;
    const was = D.items.length;
    D.items = items; S.pending = items.length;
    if (typeof renderNav === 'function' && document.getElementById('nav') && was !== items.length) renderNav();
    if (!items.length) { D.cur = null; draw(); if (opt.onEmpty) opt.onEmpty(); return; }
    if (!D.cur || !items.find((i) => i.id === D.cur.id)) {
      D.cur = items[0]; D.tags = []; D.moveTo = '';
      sugFor(D.cur);
      draw();
    } else if (first || was !== items.length) updateHead();
  }

  function updateHead() {
    const el = root.querySelector('.dl-count');
    if (el && D.cur) el.textContent = `${D.items.findIndex((i) => i.id === D.cur.id) + 1} of ${D.items.length}`;
  }

  function toggle(t) { D.tags = D.tags.includes(t) ? D.tags.filter((x) => x !== t) : [...D.tags, t]; drawTags(); drawSuggestions(); drawQuick(); updateApply(); }
  function addTags(list) { for (const t of list) if (!D.tags.includes(t)) D.tags.push(t); drawTags(); drawSuggestions(); drawQuick(); updateApply(); const i = root.querySelector('.tag-in'); if (i) i.focus(); }

  function drawTags() {
    const box = root.querySelector('.dl-tags');
    if (!box) return;
    box.replaceChildren(...(D.tags.length ? D.tags.map((t) => tagChip(t, { onremove: () => toggle(t) })) : [h('span', { class: 'none' }, 'No tags chosen yet')]));
  }
  function drawSuggestions() {
    const box = root.querySelector('.dl-sug');
    if (!box) return;
    if (!S.ai) { box.replaceChildren(); return; }
    const s = D.sug;
    if (!s || s.loading) { box.replaceChildren(h('span', { class: 'none' }, 'Looking at the picture…')); return; }
    const items = s.items.filter((x) => !D.tags.includes(x.tag));
    const kids = [];
    if (!s.ready) kids.push(h('div', { class: 'ai-note' }, `Still learning from your tagging (${Math.min(s.trained, 6)} of 6 needed). Tag some pictures yourself and suggestions will appear here.`));
    if (items.length) kids.push(h('div', { class: 'chips' }, items.map((x) => h('span', { class: 'chip quick off', style: chipStyle(tagColor(x.tag)), title: (x.why || []).join(' · ') || 'Click to use this tag' },
      h('span', { class: 'chip-t', onclick: () => toggle(x.tag) }, x.tag, h('em', {}, Math.round(x.score * 100) + '%'))))));
    else if (s.ready) kids.push(h('span', { class: 'none' }, 'No suggestion for this one.'));
    box.replaceChildren(...kids);
  }
  function drawQuick() {
    const box = root.querySelector('.dl-quick');
    if (!box) return;
    const names = S.tags.slice().sort((a, b) => (b.used || 0) - (a.used || 0) || b.count - a.count).slice(0, 14).map((t) => t.name).filter((t) => !D.tags.includes(t));
    box.replaceChildren(...names.map((t) => h('span', { class: 'chip quick off', style: chipStyle(tagColor(t)) }, h('span', { class: 'chip-t', onclick: () => toggle(t) }, t))));
  }
  function updateApply() {
    const b = root.querySelector('.dl-apply');
    if (!b) return;
    const moving = D.moveTo.trim() !== '';
    b.disabled = D.busy || (!D.tags.length && !moving);
    b.textContent = D.tags.length ? `Apply ${D.tags.length} tag${D.tags.length > 1 ? 's' : ''}` + (moving ? ' and move' : '') : moving ? 'Move' : 'Apply';
  }

  async function apply() {
    const it = D.cur;
    if (!it || D.busy) return;
    D.busy = true; updateApply();
    try {
      const r = await api('/api/downloads/done', { ID: it.id, Tags: D.tags, MoveTo: D.moveTo.trim() });
      if (r.all) setTags(r.all);
      if (opt.onApplied) opt.onApplied(r);
    } catch (e) { fail(e); }
    D.busy = false; D.cur = null;
    await poll();
  }
  async function skip(all) {
    const it = D.cur;
    if (!it) return;
    try { await api('/api/downloads/skip', { ID: it.id, All: !!all }); } catch (e) { fail(e); }
    D.cur = null;
    await poll();
  }

  function draw() {
    if (!D.cur) {
      root.replaceChildren(h('div', { class: 'empty', style: { height: '260px' } }, icon('check', 40), h('b', {}, 'All done'), h('span', {}, opt.popup ? 'This window will close.' : 'No new downloads waiting for tags.')));
      return;
    }
    const it = D.cur;
    const pv = it.kind === 'video'
      ? h('video', { src: fileUrl(it.path), controls: true, muted: true, loop: true, autoplay: true })
      : h('img', { src: fileUrl(it.path), alt: '' });
    const moveIn = h('input', { class: 'txt', type: 'text', placeholder: 'Leave empty to keep it where it is', value: D.moveTo, spellcheck: 'false' });
    moveIn.addEventListener('input', () => { D.moveTo = moveIn.value; updateApply(); });
    moveIn.addEventListener('keydown', (e) => e.stopPropagation());
    const recent = (S.recent || []).slice(0, 4);
    const input = tagInput(addTags, { exclude: () => D.tags, placeholder: 'Type a tag and press Enter…' });
    root.replaceChildren(
      h('div', { class: 'dl' },
        h('div', { class: 'dl-head' }, h('b', {}, 'New download'), h('span', { class: 'muted dl-count' })),
        h('div', { class: 'dl-pv' }, pv),
        h('div', { class: 'dl-name' }, h('b', { title: it.path }, it.name), h('span', { class: 'muted' }, fmtSize(it.size) + ' · ' + dirOf(it.path))),
        h('div', { class: 'sh' }, 'Tags for this file'), h('div', { class: 'chips dl-tags' }), input,
        S.ai ? h('div', { class: 'sh', style: { marginTop: '14px' } }, h('span', { class: 'ai-badge' }, icon('sparkle', 13), 'Suggested for you'), h('span', { class: 'none' }, 'click to use')) : null,
        S.ai ? h('div', { class: 'dl-sug' }) : null,
        h('div', { class: 'sh', style: { marginTop: '14px' } }, 'Your usual tags'), h('div', { class: 'chips dl-quick' }),
        h('div', { class: 'sh', style: { marginTop: '14px' } }, 'Move it to a folder (optional)'),
        h('div', { class: 'row' }, moveIn, S.os === 'windows' ? h('button', { class: 'btn', onclick: async () => {
          try { const r = await api('/api/pick', {}); if (r.path) { D.moveTo = r.path; moveIn.value = r.path; updateApply(); } } catch (e) { fail(e); }
        } }, 'Browse…') : null),
        recent.length ? h('div', { class: 'chips', style: { marginTop: '6px' } }, recent.map((d) => h('button', { class: 'btn small', title: d, onclick: () => { D.moveTo = d; moveIn.value = d; updateApply(); } }, baseName(d)))) : null,
        h('div', { class: 'dl-foot' },
          h('button', { class: 'btn', onclick: () => skip(false) }, 'Skip'),
          D.items.length > 1 ? h('button', { class: 'btn', onclick: () => skip(true) }, 'Skip all') : null,
          h('span', { class: 'sp' }),
          h('button', { class: 'btn', title: 'Open the file', onclick: () => api('/api/open', { Path: it.path }).catch(fail) }, 'Open'),
          h('button', { class: 'btn primary dl-apply', onclick: apply }, 'Apply'))));
    drawTags(); drawSuggestions(); drawQuick(); updateApply(); updateHead();
    const first = root.querySelector('.tag-in'); if (first) setTimeout(() => first.focus(), 30);
  }

  const onKey = (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); apply(); } };
  document.addEventListener('keydown', onKey);
  poll(true);
  timer = setInterval(() => poll(false), 2000);
  return { stop() { stopped = true; clearInterval(timer); document.removeEventListener('keydown', onKey); } };
}
