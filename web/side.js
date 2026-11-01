'use strict';
// Right side: tags of the selected files (with AI suggestions) and the tag filter for the current folder.

const SUG = { key: '', seq: 0, data: null };
function aiForget() { SUG.key = ''; SUG.data = null; }

function setRightTab(t) { S.rightTab = t; saveSettingsSoon(); renderSide(); }

function quickTags() {
  return S.tags.slice().sort((a, b) => (b.used || 0) - (a.used || 0) || b.count - a.count || collator.compare(a.name, b.name)).slice(0, 9).map((t) => t.name);
}
function toggleQuickTag(i) {
  const name = quickTags()[i];
  if (!name || !S.sel.size) return;
  const es = selEntries();
  const all = es.every((e) => (e.t || []).includes(name));
  tagPaths(selPaths(), all ? [] : [name], all ? [name] : [], all ? 'remove tag' : 'add tag');
}

function activeFilterCount() { const f = S.f; return (f.q ? 1 : 0) + f.inc.length + f.exc.length + f.kinds.length + (f.minRating ? 1 : 0) + (f.untagged ? 1 : 0); }

function renderSide() {
  const side = $('#side');
  if (!side) return;
  const prev = $('.sidebody', side);
  const st = prev ? prev.scrollTop : 0;
  const n = S.sel.size, fc = activeFilterCount();
  const tab = (id, label, ic, dot) => h('button', { class: 'tab' + (S.rightTab === id ? ' on' : ''), onclick: () => setRightTab(id) }, icon(ic, 15), label, dot ? h('span', { class: 'dot' }, dot) : null);
  const body = h('div', { class: 'sidebody' }, S.rightTab === 'filter' ? filterTab() : tagsTab());
  side.replaceChildren(h('div', { class: 'tabs' }, tab('tags', 'Tags', 'tag', n || 0), tab('filter', 'Filter', 'filter', fc || 0)), body);
  body.scrollTop = st;
  if (S.rightTab !== 'filter' && !viewerOpen()) renderSuggestions($('#sugbox'));
  if (S._refocus) { S._refocus = false; const i = $('#side .tag-in'); if (i) i.focus(); }
}

// ---------------------------------------------------------------- tags of the selection
function starsRow(paths, current, after) {
  return h('div', { class: 'stars-row' }, [1, 2, 3, 4, 5].map((k) => h('button', {
    class: 'starb' + (k <= current ? ' on' : ''), title: k + (k === 1 ? ' star' : ' stars') + ' (Alt+' + k + ')',
    onclick: async () => { await ratePaths(paths, k === current ? 0 : k); if (after) after(); },
  }, icon('star', 20))));
}

function previewBox(es) {
  if (es.length > 1) return h('div', { class: 'pv' }, h('b', {}, es.length));
  const e = es[0];
  if (e.d) return h('div', { class: 'pv' }, icon('folder', 30));
  if (e.k === 'image') return h('div', { class: 'pv' }, h('img', { src: THUMB_EXT.has(e.x) ? thumbUrl(e.p, e.m) : fileUrl(e.p), alt: '' }));
  if (e.k === 'video') { const v = h('video', { muted: true, preload: 'metadata' }); v.src = fileUrl(e.p) + '#t=0.1'; return h('div', { class: 'pv' }, v); }
  return h('div', { class: 'pv' }, icon(entryIcon(e), 28));
}

function tagsTab() {
  const es = selEntries();
  const kids = [];
  if (!es.length) {
    const total = S.entries.length, tagged = S.entries.filter((e) => (e.t || []).length).length, media = S.entries.filter(isMedia).length;
    kids.push(h('div', {}, h('div', { class: 'sh' }, h('span', {}, 'Nothing selected')),
      h('p', { class: 'none' }, 'Click a file to see and edit its tags here. Select several files (Ctrl or Shift, or drag a box) to tag them all at once.')));
    kids.push(h('div', {}, h('div', { class: 'sh' }, h('span', {}, 'This folder')),
      h('dl', { class: 'kv' }, h('dt', {}, 'Items'), h('dd', {}, total), h('dt', {}, 'Tagged'), h('dd', {}, tagged), h('dt', {}, 'Untagged'), h('dd', {}, total - tagged))));
    if (S.ai && media) kids.push(h('div', {}, h('button', { class: 'btn', onclick: () => openReview() }, icon('sparkle', 14), ' Suggest tags for untagged files…')));
    kids.push(quickSection(es));
    return kids;
  }
  const paths = es.map((e) => e.p), n = es.length;
  const one = n === 1 ? es[0] : null;
  const counts = new Map();
  for (const e of es) for (const t of e.t || []) counts.set(t, (counts.get(t) || 0) + 1);
  const bytes = es.reduce((a, e) => a + (e.d ? 0 : e.s), 0);

  kids.push(h('div', { class: 'card' }, previewBox(es), h('div', { class: 'meta' },
    h('b', { title: one ? one.p : '' }, one ? one.n : `${n} items selected`),
    h('span', {}, one ? (one.d ? 'Folder' : fmtSize(one.s) + ' · ' + typeLabel(one)) : (bytes ? fmtSize(bytes) + ' in total' : 'folders')))));

  // current tags
  const chips = h('div', { class: 'chips' });
  const names = Array.from(counts.keys()).sort((a, b) => counts.get(b) - counts.get(a) || collator.compare(a, b));
  for (const t of names) {
    const c = counts.get(t), partial = c < n;
    chips.append(tagChip(t, {
      partial, count: partial ? `${c}/${n}` : '', title: partial ? `On ${c} of ${n} selected files - click to add it to all` : 'Remove with the ×',
      onclick: partial ? () => tagPaths(paths, [t], [], 'add tag') : null,
      onremove: () => tagPaths(paths, [], [t], 'remove tag'),
    }));
  }
  const input = tagInput((list) => { S._refocus = true; tagPaths(paths, list, [], 'add tags'); }, { exclude: () => names.filter((t) => counts.get(t) === n), placeholder: 'Add a tag and press Enter…' });
  kids.push(h('div', {}, h('div', { class: 'sh' }, h('span', {}, 'Tags'), h('div', { class: 'acts' },
    names.length ? h('button', { class: 'ibtn', title: 'Copy these tags', onclick: () => { S.tagClip = names.slice(); toast('Tags copied - select other files and use “Paste tags”'); } }, icon('copy', 14)) : null,
    S.tagClip.length ? h('button', { class: 'btn small', title: S.tagClip.join(', '), onclick: () => tagPaths(paths, S.tagClip, [], 'paste tags') }, 'Paste tags') : null)),
  names.length ? chips : h('p', { class: 'none' }, 'No tags yet.'), input));

  // AI suggestions (filled in asynchronously)
  if (S.ai) kids.push(h('div', {}, h('div', { class: 'sh' }, h('span', { class: 'ai-badge' }, icon('sparkle', 13), 'Suggestions'),
    h('span', { class: 'none', title: 'Learns from the files you tag. It never changes anything by itself.' }, 'you decide')), h('div', { id: 'sugbox' })));

  kids.push(quickSection(es));

  // rating
  const ratings = new Set(es.map((e) => e.r || 0));
  kids.push(h('div', {}, h('div', { class: 'sh' }, h('span', {}, 'Rating')), starsRow(paths, ratings.size === 1 ? [...ratings][0] : 0)));

  // details & actions
  const dl = h('dl', { class: 'kv' });
  if (one) {
    dl.append(h('dt', {}, 'Type'), h('dd', {}, typeLabel(one)));
    if (!one.d) dl.append(h('dt', {}, 'Size'), h('dd', {}, fmtSize(one.s)));
    dl.append(h('dt', {}, 'Modified'), h('dd', {}, fmtDate(one.m)), h('dt', {}, 'Location'), h('dd', {}, dirOf(one.p)));
  } else {
    dl.append(h('dt', {}, 'Files'), h('dd', {}, es.filter((e) => !e.d).length), h('dt', {}, 'Folders'), h('dd', {}, es.filter((e) => e.d).length), h('dt', {}, 'Total size'), h('dd', {}, fmtSize(bytes)));
  }
  const acts = h('div', { class: 'btnrow' });
  if (one) {
    acts.append(h('button', { class: 'btn small', onclick: () => openEntry(one) }, one.d ? 'Open folder' : 'Open'));
    if ((one.k === 'image' || one.k === 'video' || one.k === 'audio')) acts.append(h('button', { class: 'btn small', onclick: () => openViewer(one.p) }, 'Preview'));
    acts.append(h('button', { class: 'btn small', onclick: () => api('/api/open', { Path: one.p, Reveal: true }).catch(fail) }, 'Show in Explorer'));
    if (isMedia(one)) acts.append(h('button', { class: 'btn small', onclick: () => openSimilar(one) }, 'Find similar'));
    acts.append(h('button', { class: 'btn small', onclick: () => doRename(one) }, 'Rename'));
  } else {
    acts.append(h('button', { class: 'btn small', onclick: () => openBatchRename(es) }, 'Batch rename…'));
  }
  kids.push(h('div', {}, h('div', { class: 'sh' }, h('span', {}, 'Details')), dl, h('div', { style: { height: '10px' } }), acts));
  return kids;
}

function quickSection(es) {
  const names = quickTags();
  if (!names.length) return h('div', {});
  const n = es.length;
  const chips = h('div', { class: 'chips' });
  names.forEach((t, i) => {
    const c = es.filter((e) => (e.t || []).includes(t)).length;
    const state = n && c === n ? 'on' : c > 0 ? 'partial' : 'off';
    chips.append(h('span', { class: 'chip quick ' + state, style: chipStyle(tagColor(t)), title: n ? `Press ${i + 1} to toggle` : 'Select files first' },
      h('span', { class: 'chip-t', onclick: () => { if (n) tagPaths(es.map((e) => e.p), state === 'on' ? [] : [t], state === 'on' ? [t] : [], state === 'on' ? 'remove tag' : 'add tag'); } },
        h('kbd', {}, i + 1), t)));
  });
  return h('div', {}, h('div', { class: 'sh' }, h('span', {}, 'Quick tags'), h('span', { class: 'none' }, 'keys 1–9')), chips);
}

// ---------------------------------------------------------------- AI suggestions
function renderSuggestions(box, given) {
  if (!box) return;
  const paths = (given || selPaths()).filter((p) => { const e = S.byPath.get(p); return e && !e.d; });
  if (!paths.length) { box.replaceChildren(h('p', { class: 'none' }, 'Suggestions are for files, not folders.')); return; }
  if (paths.length > 60) { box.replaceChildren(h('p', { class: 'none' }, 'Select up to 60 files to see suggestions.')); return; }
  const key = paths.slice().sort().join('|');
  if (SUG.key === key && SUG.data) { drawSuggestions(box, SUG.data, paths); return; }
  box.replaceChildren(h('p', { class: 'none' }, 'Looking…'));
  const boxId = box.id;
  const seq = ++SUG.seq;
  (async () => {
    let r = await api('/api/ai/suggest', { Paths: paths });
    if (r.need && r.need.length) {
      if (seq === SUG.seq && $('#' + boxId)) $('#' + boxId).replaceChildren(h('p', { class: 'none' }, `Reading ${r.need.length} image${r.need.length > 1 ? 's' : ''}…`));
      await indexFiles(r.need.map((p) => ({ path: p, kind: kindFromPath(p), mtime: 0 })));
      r = await api('/api/ai/suggest', { Paths: paths });
    }
    if (seq !== SUG.seq) return;
    SUG.key = key; SUG.data = r;
    const b = $('#' + boxId);
    if (b) drawSuggestions(b, r, paths);
  })().catch((e) => { const b = $('#' + boxId); if (b) b.replaceChildren(h('p', { class: 'none' }, 'Suggestions are not available right now.')); });
}

function drawSuggestions(box, r, paths) {
  const kids = [];
  const items = r.items || [];
  if (!r.ready) {
    kids.push(h('div', { class: 'ai-note' }, `Still learning: it needs about ${6} tagged pictures or videos to start (${Math.min(r.trained, 6)} so far). The more you tag, the better it gets.`,
      h('div', { class: 'bar', style: { marginTop: '6px' } }, h('i', { style: { width: Math.min(100, r.trained / 6 * 100) + '%' } }))));
  }
  if (!items.length) {
    if (AIS.total && AIS.done < AIS.total) kids.push(h('p', { class: 'none' }, 'Still looking at your other pictures - suggestions will appear in a moment.'));
    else if (r.ready) kids.push(h('p', { class: 'none' }, 'No suggestion for this one yet.'));
  } else {
    const list = h('div', { class: 'sug' });
    for (const s of items) {
      list.append(h('div', { class: 'sug-i', style: chipStyle(tagColor(s.tag)) },
        h('button', { class: 'sname', title: 'Add this tag', onclick: () => { S._refocus = false; tagPaths(paths, [s.tag], [], 'accept suggestion'); } },
          h('i'), h('span', {}, h('span', {}, s.tag), s.why && s.why.length ? h('span', { class: 'why' }, s.why.join(' · ')) : null), h('span', { class: 'pct' }, Math.round(s.score * 100) + '%')),
        h('button', { class: 'ibtn', title: 'Wrong - don\'t suggest this tag here again', onclick: async () => {
          try { await api('/api/ai/reject', { Paths: paths, Tag: s.tag }); } catch (e) { fail(e); return; }
          SUG.data.items = SUG.data.items.filter((x) => x.tag !== s.tag);
          drawSuggestions(box, SUG.data, paths);
        } }, icon('x', 14))));
    }
    kids.push(list);
  }
  box.replaceChildren(...kids);
}

// ---------------------------------------------------------------- filter tab (current folder only)
function filterTab() {
  const f = S.f;
  const kids = [];
  const folderName = S.path ? baseName(S.path) : '';
  kids.push(h('div', {}, h('div', { class: 'sh' }, h('span', {}, 'Filter “' + folderName + '”'), h('div', { class: 'acts' }, activeFilterCount() ? h('button', { class: 'btn small', onclick: clearFilters }, 'Clear') : null)),
    h('div', { class: 'checks' },
      h('label', {}, h('input', { type: 'checkbox', checked: S.sub, onchange: () => toggleSub() }), 'Include subfolders'),
      h('label', {}, h('input', { type: 'checkbox', checked: f.untagged, onchange: (e) => { f.untagged = e.target.checked; afterFilterChange(); } }), 'Only files without tags')),
    h('p', { class: 'hint' }, S.sub ? 'Filters cover this folder and everything below it.' : 'Filters only look at files directly in this folder.')));

  // tags in this folder
  const counts = folderTagCounts();
  const box = h('div', { class: 'views' });
  const q = h('input', { class: 'txt', type: 'text', placeholder: 'Find a tag…', value: S.tagq || '', spellcheck: 'false' });
  const fill = () => {
    const needle = (S.tagq || '').toLowerCase();
    const list = Array.from(counts.keys()).filter((t) => !needle || t.toLowerCase().includes(needle))
      .sort((a, b) => (S.tagSort === 'name' ? collator.compare(a, b) : counts.get(b) - counts.get(a) || collator.compare(a, b)));
    for (const t of f.inc.concat(f.exc)) if (!counts.has(t) && (!needle || t.toLowerCase().includes(needle))) list.unshift(t);
    box.replaceChildren(...(list.length ? list.map((t) => {
      const st = f.inc.includes(t) ? 'inc' : f.exc.includes(t) ? 'exc' : '';
      return h('div', { class: 'frow ' + st, style: chipStyle(tagColor(t)), title: 'Click to show only files with this tag', onclick: () => toggleInc(t) },
        h('span', { class: 'mark' }, st === 'inc' ? icon('check', 14) : st === 'exc' ? icon('x', 14) : h('i')), h('span', {}, t), h('em', {}, counts.get(t) || 0),
        h('button', { class: 'notbtn', title: 'Hide files with this tag', onclick: (e) => { e.stopPropagation(); toggleExc(t); } }, icon('x', 13)));
    }) : [h('p', { class: 'none' }, counts.size ? 'No tag matches.' : 'No file in this folder has a tag yet.')]));
  };
  q.addEventListener('input', () => { S.tagq = q.value; fill(); });
  q.addEventListener('keydown', (e) => e.stopPropagation());
  fill();
  kids.push(h('div', {}, h('div', { class: 'sh' }, h('span', {}, 'Tags in this folder'), h('div', { class: 'acts' },
    h('div', { class: 'seg2' },
      h('button', { class: f.any ? '' : 'on', title: 'Files must have all selected tags', onclick: () => { f.any = false; afterFilterChange(); } }, 'All'),
      h('button', { class: f.any ? 'on' : '', title: 'Files need at least one of the selected tags', onclick: () => { f.any = true; afterFilterChange(); } }, 'Any')))),
  q, h('div', { style: { height: '6px' } }), box));

  // type & rating
  const kinds = [['folder', 'Folders'], ['image', 'Images'], ['video', 'Videos'], ['audio', 'Audio'], ['other', 'Other']];
  kids.push(h('div', {}, h('div', { class: 'sh' }, h('span', {}, 'Show')),
    h('div', { class: 'checks' }, kinds.map(([k, l]) => h('label', {}, h('input', { type: 'checkbox', checked: f.kinds.includes(k), onchange: (e) => {
      f.kinds = e.target.checked ? [...f.kinds, k] : f.kinds.filter((x) => x !== k); afterFilterChange();
    } }), l)),
    h('label', {}, 'Minimum rating ', h('select', { class: 'txt', onchange: (e) => { f.minRating = +e.target.value; afterFilterChange(); } },
      [[0, 'any'], [1, '★ 1+'], [2, '★ 2+'], [3, '★ 3+'], [4, '★ 4+'], [5, '★ 5']].map(([v, l]) => h('option', { value: v, selected: f.minRating === v }, l)))))));

  // saved filters
  const views = h('div', { class: 'views' }, S.views.length ? S.views.map((v) => h('div', { class: 'vrow', onclick: () => applyView(v) }, icon('filter', 14), h('span', {}, v.name),
    h('button', { class: 'ibtn', title: 'Delete', onclick: async (e) => { e.stopPropagation(); try { S.views = (await api('/api/views/delete', { ID: v.id })).views; renderSide(); } catch (er) { fail(er); } } }, icon('x', 13))))
    : h('p', { class: 'none' }, 'Save the current filters, grouping and sorting under a name to reuse them in any folder.'));
  kids.push(h('div', {}, h('div', { class: 'sh' }, h('span', {}, 'Saved filters'), h('div', { class: 'acts' }, h('button', { class: 'btn small', onclick: saveView }, 'Save current'))), views));
  return kids;
}

async function saveView() {
  const name = await prompt('Save filter', 'Name', '');
  if (!name || !name.trim()) return;
  try {
    const r = await api('/api/views', { Name: name.trim(), State: { f: S.f, group: S.group, sort: S.sort, desc: S.desc, view: S.view, sub: S.sub } });
    S.views = r.views; renderSide(); toast('Filter saved');
  } catch (e) { fail(e); }
}
async function applyView(v) {
  const st = v.state || {};
  S.f = Object.assign(defaultFilter(), st.f || {});
  if (st.group) S.group = st.group;
  if (st.sort) S.sort = st.sort;
  if (st.desc !== undefined) S.desc = st.desc;
  if (st.view) S.view = st.view;
  saveSettingsSoon();
  if (st.sub !== undefined && st.sub !== S.sub) { S.sub = st.sub; await go(S.path, { push: false, keepFilter: true, keepSel: true }); renderTop(); return; }
  renderTop(); afterFilterChange();
}

// ---------------------------------------------------------------- tags tab hook used by the state module
function viewerTagsChanged() { if (typeof refreshViewerTags === 'function') refreshViewerTags(); }
