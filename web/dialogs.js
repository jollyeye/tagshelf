'use strict';
// Dialogs: settings, tag manager, missing files, duplicates, batch rename, AI review, similar images, help.

const seg = (opts, val, fn) => {
  const box = h('div', { class: 'seg2' });
  const draw = (v) => box.replaceChildren(...opts.map(([k, l]) => h('button', { class: k === v ? 'on' : '', onclick: () => { fn(k); draw(k); } }, l)));
  draw(val);
  return box;
};
const chk = (label, val, fn, hint) => h('div', {}, h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: !!val, onchange: (e) => fn(e.target.checked) }), label), hint ? h('p', { class: 'hint', style: { marginLeft: '23px' } }, hint) : null);
const line = (label, ctl) => h('div', { class: 'row', style: { justifyContent: 'space-between' } }, h('span', {}, label), ctl);

// ---------------------------------------------------------------- settings
async function setPrefs(patch) {
  try {
    const r = await api('/api/prefs', patch);
    S.prefs = r.prefs; S.autostart = r.autostart;
    if (r.warning) toast(r.warning, { error: true });
    return r;
  } catch (e) { fail(e); }
}

function openSettings() {
  const look = (k, v, after) => { S[k] = v; saveSettingsSoon(); applyLook(); if (after) after(); };
  const aiInfo = h('p', { class: 'hint' }, `TagShelf has looked at ${S.vectors} pictures and videos so far.`);
  const aiRes = h('div', {});
  const dirBox = h('div', { class: 'dirlist' });
  const drawDirs = () => {
    const dirs = (S.prefs && S.prefs.watchDirs) || [];
    dirBox.replaceChildren(...(dirs.length ? dirs.map((d) => h('div', { class: 'd' }, h('span', { title: d }, d),
      h('button', { class: 'ibtn', title: 'Stop watching', onclick: async () => { await setPrefs({ WatchDirs: dirs.filter((x) => x !== d) }); drawDirs(); } }, icon('x', 14))))
      : [h('div', { class: 'd' }, h('span', {}, S.prefs.noDriveWatch ? (S.downloads || 'Downloads') + '  (default)' : 'None - the whole drive is watched'))]));
  };
  drawDirs();
  const addIn = h('input', { class: 'txt', type: 'text', placeholder: 'Another folder to watch, e.g. D:\\Downloads', spellcheck: 'false' });
  const addDir = async (p) => {
    p = (p || '').trim(); if (!p) return;
    const cur = (S.prefs && S.prefs.watchDirs) || [];
    if (!cur.length && S.downloads) cur.push(S.downloads);
    await setPrefs({ WatchDirs: [...cur.filter((x) => x !== p), p] }); addIn.value = ''; drawDirs();
  };
  addIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') addDir(addIn.value); e.stopPropagation(); });

  const body = h('div', {},
    h('div', { class: 'sect' }, h('h4', {}, 'Appearance'),
      line('Theme', seg([['dark', 'Dark'], ['light', 'Light']], S.theme, (v) => look('theme', v))),
      line('Thumbnails', seg([['cover', 'Fill'], ['contain', 'Show whole picture']], S.fit, (v) => look('fit', v))),
      line('Tags under thumbnails', seg([['names', 'Names'], ['dots', 'Dots'], ['none', 'Hidden']], S.tagShow, (v) => { S.tagShow = v; saveSettingsSoon(); renderContent(); })),
      line('Double-click on a picture or video', seg([['system', 'Opens in its app'], ['viewer', 'Opens the viewer']], S.dbl, (v) => look('dbl', v))),
      chk('Show folders first', S.dirsFirst, (v) => { S.dirsFirst = v; saveSettingsSoon(); recompute(); renderContent(); }),
      chk('Ask before deleting', S.confirmDelete, (v) => { S.confirmDelete = v; saveSettingsSoon(); }),
      chk('Show hidden files', S.hidden, (v) => { S.hidden = v; saveSettingsSoon(); NAV.kids.clear(); refresh(); renderTop(); renderNav(); })),
    h('div', { class: 'sect' }, h('h4', {}, 'Tag suggestions'),
      chk('Suggest tags based on how I tag', S.ai, (v) => { S.ai = v; saveSettingsSoon(); aiForget(); renderSide(); },
        'TagShelf compares new files with the ones you have already tagged (look, file names and tags you often combine). It only suggests - nothing is ever tagged without your click, and everything stays on this computer.'),
      aiInfo,
      h('div', { class: 'row' }, h('button', { class: 'btn small', onclick: async (e) => {
        e.target.disabled = true; aiRes.replaceChildren(h('p', { class: 'hint' }, 'Testing…'));
        try {
          const r = await api('/api/ai/test', {});
          aiRes.replaceChildren(h('p', { class: 'hint' }, r.tested ? `Hid the tags of ${r.tested} of your tagged files one by one. For ${Math.round(r.hit * 100)}% of them, at least one of the top 5 suggestions was right; ${Math.round(r.recall * 100)}% of all your tags were among the top 5.`
            : `Not enough tagged pictures yet (${r.trained} of 6 needed). Tag a few more and try again.`));
        } catch (er) { fail(er); aiRes.replaceChildren(); }
        e.target.disabled = false;
      } }, 'Test how well it does')), aiRes),
    h('div', { class: 'sect' }, h('h4', {}, 'Downloads'),
      chk('Ask me for tags when a picture or video finishes downloading', S.prefs.watchDownloads, async (v) => { await setPrefs({ WatchDownloads: v }); },
        'A small window opens with suggested tags, whichever browser you use.'),
      chk('Watch the whole drive (any folder I save to)', !S.prefs.noDriveWatch, async (v) => { await setPrefs({ WatchDrive: v }); drawDirs(); },
        'Catches downloads wherever you choose to save them. Only pictures and videos that Windows marks as “downloaded from the internet” are offered (Edge, Chrome, Firefox and Brave all add that mark on NTFS drives); files you copy or create yourself are ignored. Turn it off to watch only the folders below.'),
      chk('Remove the “downloaded from the internet” mark after I tag a download', S.prefs.unblock, async (v) => { await setPrefs({ Unblock: v }); },
        'Stops Windows from warning “this file may be unsafe” whenever the picture is opened. The picture itself is not changed.'),
      h('div', {}, h('div', { class: 'sh' }, 'Extra folders to watch (offered even without the mark)'), dirBox, h('div', { class: 'row', style: { marginTop: '6px' } }, addIn,
        S.os === 'windows' ? h('button', { class: 'btn', onclick: async () => { try { const r = await api('/api/pick', {}); if (r.path) addDir(r.path); } catch (e) { fail(e); } } }, 'Browse…') : null,
        h('button', { class: 'btn', onclick: () => addDir(addIn.value) }, 'Add'))),
      chk('Keep TagShelf running in the background after I close the window', S.prefs.background, async (v) => { await setPrefs({ Background: v }); },
        'Needed to notice downloads while the main window is closed. Use “Quit TagShelf” (bottom left) to stop it completely.'),
      S.os === 'windows' ? chk('Start TagShelf (in the background) when I sign in to Windows', S.autostart, async (v) => { await setPrefs({ Autostart: v }); }) : null),
    h('p', { class: 'hint' }, 'Your tags are saved in library.json inside TagShelf\'s data folder (default %AppData%\\TagShelf). Copy that file to back them up.'));
  modal('Settings', body, [{ label: 'Done', primary: true }], { wide: true });
}

// ---------------------------------------------------------------- tag manager
function openTagManager() {
  const list = h('div', {});
  const q = h('input', { class: 'txt', type: 'text', placeholder: 'Find a tag…', spellcheck: 'false' });
  const after = (r) => { if (r && r.all) setTags(r.all); draw(); refresh({ silent: true }); renderSide(); aiForget(); };
  const draw = () => {
    const needle = q.value.trim().toLowerCase();
    const tags = S.tags.filter((t) => !needle || t.name.toLowerCase().includes(needle));
    list.replaceChildren(tags.length ? h('table', { class: 'tbl' }, h('tr', {}, h('th', {}, ''), h('th', {}, 'Tag'), h('th', {}, 'Files'), h('th', {}, '')),
      tags.map((t) => h('tr', {},
        h('td', {}, h('input', { type: 'color', class: 'sw', value: /^#[0-9a-f]{6}$/i.test(t.color) ? t.color : '#9aa5b8', title: 'Colour', onchange: async (e) => { try { after(await api('/api/tag/color', { Name: t.name, Color: e.target.value })); } catch (er) { fail(er); } } })),
        h('td', {}, t.name), h('td', { class: 'muted' }, t.count),
        h('td', { style: { textAlign: 'right', whiteSpace: 'nowrap' } },
          h('button', { class: 'btn small', onclick: async () => {
            const nv = await prompt('Rename tag', 'New name', t.name, { help: 'If another tag already has this name, the two are merged.' });
            if (nv == null || !nv.trim() || nv === t.name) return;
            const clash = S.tags.find((x) => x.name.toLowerCase() === nv.trim().toLowerCase() && x.name !== t.name);
            if (clash && !(await confirmBox('Merge tags', `“${clash.name}” already exists. Merge “${t.name}” into it?`, 'Merge'))) return;
            try { after(await api('/api/tag/rename', { From: t.name, To: nv })); } catch (er) { fail(er); }
          } }, 'Rename'), ' ',
          h('button', { class: 'btn small danger', onclick: async () => {
            if (!(await confirmBox('Delete tag', `Remove “${t.name}” from ${t.count} file${t.count === 1 ? '' : 's'}? The files themselves are not touched.`, 'Delete tag', true))) return;
            try { after(await api('/api/tag/delete', { Name: t.name })); } catch (er) { fail(er); }
          } }, 'Delete'))))) : h('p', { class: 'none' }, S.tags.length ? 'No tag matches.' : 'No tags yet. Select a file and add one on the right.'));
  };
  q.addEventListener('input', draw);
  q.addEventListener('keydown', (e) => e.stopPropagation());
  const nt = h('input', { class: 'txt', type: 'text', placeholder: 'New tag name', spellcheck: 'false' });
  const add = async () => { if (!nt.value.trim()) return; try { const r = await api('/api/tag/create', { Name: nt.value }); nt.value = ''; after(r); } catch (e) { fail(e); } };
  nt.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); e.stopPropagation(); });
  draw();
  modal('Manage tags', h('div', {}, h('div', { class: 'row' }, q, nt, h('button', { class: 'btn', onclick: add }, 'Add')), h('div', { style: { height: '10px' } }), list), [{ label: 'Done', primary: true }], { wide: true });
}

// ---------------------------------------------------------------- missing files
async function openMissing() {
  let files;
  try { files = (await api('/api/missing')).files || []; } catch (e) { fail(e); return; }
  const picked = new Set(files.map((f) => f.id));
  const body = h('div', {}, h('p', { class: 'hint', style: { marginTop: 0 } }, 'TagShelf remembers the tags of these files, but they are not where they used to be (deleted, or moved outside TagShelf). If you moved them, just open the folder they are in and TagShelf reconnects them. Forget the rest to clean up.'),
    files.length ? h('table', { class: 'tbl' }, files.map((f) => h('tr', {}, h('td', {}, h('input', { type: 'checkbox', checked: true, onchange: (e) => { if (e.target.checked) picked.add(f.id); else picked.delete(f.id); } })),
      h('td', { title: f.path }, f.name, h('div', { class: 'muted', style: { fontSize: '12px' } }, f.dir)), h('td', {}, (f.tags || []).join(', '))))) : h('p', { class: 'none' }, 'Nothing is missing.'));
  modal('Missing files', body, [{ label: 'Close' }, files.length ? { label: 'Forget selected', danger: true, fn: async () => {
    try { const r = await api('/api/missing/purge', { IDs: Array.from(picked) }); S.missing = Math.max(0, S.missing - r.purged); renderNav(); toast(`Forgot ${r.purged} file${r.purged === 1 ? '' : 's'}`); } catch (e) { fail(e); return false; }
  } } : null].filter(Boolean), { wide: true });
}

// ---------------------------------------------------------------- duplicates
function openDuplicates() {
  let sub = true;
  const res = h('div', {});
  const checks = new Map(); let groups = [];
  const apply = h('button', { class: 'btn danger', disabled: true }, 'Move checked files to the ' + trashWord());
  const optSub = h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: true, onchange: (e) => { sub = e.target.checked; } }), 'Include subfolders');
  const rel = (p) => (p.startsWith(S.path) ? p.slice(S.path.length).replace(/^[\\/]/, '') : p);
  const count = () => Array.from(checks.values()).filter(Boolean).length;
  const upd = () => { const n = count(); apply.disabled = !n; apply.textContent = n ? `Move ${n} checked file${n > 1 ? 's' : ''} to the ${trashWord()}` : 'Move checked files to the ' + trashWord(); };
  async function scan() {
    res.replaceChildren(h('p', { class: 'hint' }, 'Comparing files… this can take a while in big folders.'));
    try {
      const r = await api('/api/dups', { Path: S.path, Sub: sub, Hidden: S.hidden });
      groups = r.groups; checks.clear();
      if (!groups.length) { res.replaceChildren(h('p', { class: 'none' }, `No identical files among ${r.scanned} files.`)); upd(); return; }
      let waste = 0;
      for (const g of groups) {
        // keep the copy with the most tags, then the oldest
        const keep = g.files.slice().sort((a, b) => (b.t || []).length - (a.t || []).length || a.m - b.m)[0];
        waste += g.size * (g.files.length - 1);
        for (const f of g.files) checks.set(f.p, f !== keep);
      }
      const nodes = groups.map((g) => h('div', { class: 'sect' }, h('h4', {}, `${g.files.length} identical files · ${fmtSize(g.size)} each`),
        g.files.map((f) => h('label', { class: 'row', style: { cursor: 'pointer', alignItems: 'flex-start' } },
          h('input', { type: 'checkbox', checked: checks.get(f.p), onchange: (e) => {
            checks.set(f.p, e.target.checked);
            if (g.files.every((x) => checks.get(x.p))) { checks.set(f.p, false); e.target.checked = false; toast('Keep at least one copy of each file'); }
            upd();
          } }),
          kindFromPath(f.p) === 'image' ? h('img', { src: thumbUrl(f.p, f.m), style: { width: '44px', height: '44px', objectFit: 'cover', borderRadius: '6px' } }) : icon(entryIcon({ k: kindFromPath(f.p) }), 28),
          h('span', { style: { flex: 1, minWidth: 0 } }, h('div', { style: { overflowWrap: 'anywhere' } }, rel(f.p)), h('div', { class: 'muted', style: { fontSize: '12px' } }, fmtDate(f.m) + ((f.t || []).length ? ' · ' + f.t.join(', ') : '')))))));
      res.replaceChildren(h('p', { class: 'hint', style: { marginTop: 0 } }, `${groups.length} group${groups.length > 1 ? 's' : ''} of identical files; removing the checked copies frees ${fmtSize(waste)}. Tags from removed copies are added to the copy you keep.`), ...nodes);
      upd();
    } catch (e) { res.replaceChildren(h('p', { class: 'err-box', style: { marginTop: 0 } }, e.message)); }
  }
  apply.addEventListener('click', async () => {
    const del = Array.from(checks.entries()).filter(([, v]) => v).map(([p]) => p);
    if (!del.length || !(await confirmBox('Delete duplicates', `Move ${del.length} file${del.length > 1 ? 's' : ''} to the ${trashWord()}?`, 'Delete', true))) return;
    try {
      for (const g of groups) { // carry tags over to the copy that stays
        const keepers = g.files.filter((f) => !checks.get(f.p));
        if (!keepers.length) continue;
        const have = new Set(keepers[0].t || []);
        const add = [...new Set(g.files.flatMap((f) => f.t || []))].filter((t) => !have.has(t));
        if (add.length) await api('/api/tags/apply', { Paths: [keepers[0].p], Add: add, Remove: [] });
      }
      await api('/api/trash', { Paths: del });
      toast(`Moved ${del.length} duplicate${del.length > 1 ? 's' : ''} to the ${trashWord()}`);
      await refresh(); afterFsDirs([S.path]); await scan();
    } catch (e) { fail(e); }
  });
  const dm = modal('Find duplicate files in “' + baseName(S.path) + '”', h('div', {}, h('div', { class: 'row', style: { justifyContent: 'space-between' } }, optSub, h('button', { class: 'btn', onclick: scan }, 'Scan again')), h('div', { style: { height: '10px' } }), res),
    [{ label: 'Close' }], { wide: true });
  dm.el.querySelector('.dlg-f').prepend(apply);
  scan();
}

// ---------------------------------------------------------------- batch rename
async function renameMany(items) {
  // items: [{path, name}] -> new base names; handles names that swap or overlap by going through temporary names
  const olds = new Set(items.map((i) => baseName(i.path).toLowerCase()));
  const overlap = items.some((i) => olds.has(i.name.toLowerCase()) && i.name.toLowerCase() !== baseName(i.path).toLowerCase());
  const out = [];
  if (overlap) {
    const tmp = [];
    for (const [k, it] of items.entries()) { const r = await api('/api/rename', { Path: it.path, Name: `.tagshelf-tmp-${Date.now().toString(36)}-${k}` }); tmp.push({ path: r.path, name: it.name, from: it.path }); }
    for (const t of tmp) { const r = await api('/api/rename', { Path: t.path, Name: t.name }); out.push({ from: t.from, to: r.path }); }
  } else {
    for (const it of items) { if (baseName(it.path) === it.name) { out.push({ from: it.path, to: it.path }); continue; } const r = await api('/api/rename', { Path: it.path, Name: it.name }); out.push({ from: it.path, to: r.path }); }
  }
  return out;
}

function openBatchRename(es) {
  if (!es.length) return;
  const order = es.slice().sort((a, b) => S.vis.findIndex((x) => x.p === a.p) - S.vis.findIndex((x) => x.p === b.p));
  const pat = h('input', { class: 'txt', type: 'text', value: '{name} {n}', spellcheck: 'false' });
  const start = h('input', { class: 'txt', type: 'number', value: 1, min: 0, style: { width: '80px' } });
  const pad = h('input', { class: 'txt', type: 'number', value: String(order.length).length, min: 1, max: 8, style: { width: '70px' } });
  const prev = h('div', { class: 'dirlist', style: { maxHeight: '300px', overflow: 'auto' } });
  const info = h('p', { class: 'hint' }, '');
  let plan = [];
  const bad = /[\\/:*?"<>|]/;
  const ymd = (s) => { const d = new Date(s * 1000); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  function calc() {
    const taken = new Set(S.entries.filter((e) => !order.some((o) => o.p === e.p)).map((e) => e.n.toLowerCase()));
    const seen = new Set();
    plan = order.map((e, i) => {
      const m = e.n.match(/\.[^.]+$/), ext = e.d || !m ? '' : m[0];
      const base = pat.value.replace(/\{name\}/g, stem(e.n)).replace(/\{n\}/g, String((+start.value || 0) + i).padStart(+pad.value || 1, '0'))
        .replace(/\{date\}/g, ymd(e.m)).replace(/\{tag\}/g, (e.t || [])[0] || '').replace(/\s+/g, ' ').trim();
      const name = base + ext;
      let err = '';
      if (!base) err = 'empty name'; else if (bad.test(base)) err = 'not allowed: \\ / : * ? " < > |';
      else if (seen.has(name.toLowerCase())) err = 'same name twice'; else if (taken.has(name.toLowerCase())) err = 'already exists';
      seen.add(name.toLowerCase());
      return { e, name, err };
    });
    prev.replaceChildren(...plan.slice(0, 200).map((p) => h('div', { class: 'd', style: p.err ? { borderColor: 'var(--danger)' } : null }, h('span', { class: 'muted' }, p.e.n), icon('forward', 13), h('span', { style: { color: p.err ? 'var(--danger)' : null } }, p.name + (p.err ? '  (' + p.err + ')' : '')))));
    const nb = plan.filter((p) => p.err).length;
    info.textContent = nb ? `${nb} name${nb > 1 ? 's' : ''} can't be used - change the pattern.` : plan.length > 200 ? `Showing the first 200 of ${plan.length}.` : '';
    ok.disabled = nb > 0;
  }
  const ok = h('button', { class: 'btn primary' }, 'Rename ' + order.length + ' item' + (order.length > 1 ? 's' : ''));
  for (const i of [pat, start, pad]) { i.addEventListener('input', calc); i.addEventListener('keydown', (e) => e.stopPropagation()); }
  const m = modal('Batch rename', h('div', { class: 'form' },
    h('label', {}, 'Pattern'), pat,
    h('p', { class: 'hint', style: { margin: 0 } }, '{name} = current name · {n} = counter · {date} = date modified · {tag} = first tag. The file extension is kept.'),
    h('div', { class: 'row' }, h('label', {}, 'Start at'), start, h('label', {}, 'Digits'), pad), info, prev), [{ label: 'Cancel' }], { wide: true });
  m.el.querySelector('.dlg-f').append(ok);
  ok.addEventListener('click', async () => {
    ok.disabled = true;
    try {
      const done = await renameMany(plan.map((p) => ({ path: p.e.p, name: p.name })));
      pushUndo('batch rename', async () => { await renameMany(done.map((d) => ({ path: d.to, name: baseName(d.from) }))); await refresh(); });
      m.close(); S.sel = new Set(); await refresh(); S.sel = new Set(done.map((d) => d.to).filter((p) => S.byPath.has(p))); selectionChanged();
      toast(`Renamed ${done.length} item${done.length > 1 ? 's' : ''}`);
    } catch (e) { fail(e); ok.disabled = false; await refresh(); }
  });
  calc();
  setTimeout(() => { pat.focus(); pat.select(); }, 30);
}

// ---------------------------------------------------------------- review suggestions for the untagged files here
async function openReview() {
  if (!S.ai) { toast('Turn on tag suggestions in Settings first'); return; }
  const cands = S.vis.filter((e) => isMedia(e) && !(e.t || []).length).slice(0, 150);
  if (!cands.length) { toast('No untagged pictures or videos here'); return; }
  let dead = false;
  const picks = new Map(); // path -> Set(tag)
  const status = h('p', { class: 'hint', style: { marginTop: 0 } }, 'Looking at the pictures…');
  const grid = h('div', { class: 'rvgrid' });
  const summary = h('span', { class: 'muted' });
  const thr = h('select', { class: 'txt' }, [90, 80, 70, 60, 50].map((v) => h('option', { value: v }, v + '%')));
  const tools = h('div', { class: 'row', style: { marginBottom: '10px', flexWrap: 'wrap' }, hidden: true },
    h('span', {}, 'Pick every suggestion above'), thr,
    h('button', { class: 'btn small', onclick: () => { for (const [p, it] of results) for (const s of it) if (s.score * 100 >= +thr.value) { if (!picks.has(p)) picks.set(p, new Set()); picks.get(p).add(s.tag); } paint(); } }, 'Pick'),
    h('button', { class: 'btn small', onclick: () => { picks.clear(); paint(); } }, 'Clear'), h('span', { class: 'sp' }), summary);
  const results = new Map();
  const okBtn = h('button', { class: 'btn primary', disabled: true }, 'Apply picked tags');
  const m = modal('Suggested tags for untagged files', h('div', {}, h('p', { class: 'hint', style: { marginTop: 0 } }, 'Nothing is tagged until you pick tags below and press Apply. Click a suggestion to pick it.'), status, tools, grid), [{ label: 'Close' }], { wide: true, onclose: () => { dead = true; } });
  m.el.querySelector('.dlg-f').append(okBtn);
  function paint() {
    for (const card of $$('.rvcard', grid)) {
      const p = card.dataset.p, set = picks.get(p) || new Set();
      for (const c of $$('.chip', card)) c.classList.toggle('on', set.has(c.dataset.t)), c.classList.toggle('off', !set.has(c.dataset.t));
    }
    const n = Array.from(picks.values()).reduce((a, s) => a + s.size, 0), f = Array.from(picks.values()).filter((s) => s.size).length;
    summary.textContent = n ? `${n} tag${n > 1 ? 's' : ''} picked on ${f} file${f > 1 ? 's' : ''}` : '';
    okBtn.disabled = !n;
  }
  okBtn.addEventListener('click', async () => {
    okBtn.disabled = true;
    const before = {}, byTag = new Map();
    for (const [p, set] of picks) {
      if (!set.size) continue;
      const e = S.byPath.get(p); before[p] = e && e.t ? e.t.slice() : [];
      for (const t of set) { if (!byTag.has(t)) byTag.set(t, []); byTag.get(t).push(p); }
    }
    try {
      for (const [t, paths] of byTag) applyTagResult(await api('/api/tags/apply', { Paths: paths, Add: [t], Remove: [] }));
      pushUndo('suggested tags', async () => { applyTagResult(await api('/api/tags/set', { Items: before })); afterTagChange(); });
      aiForget(); afterTagChange(); m.close();
      toast(`Tagged ${Object.keys(before).length} file${Object.keys(before).length > 1 ? 's' : ''}`);
    } catch (e) { fail(e); okBtn.disabled = false; }
  });
  try {
    const need = (await api('/api/ai/need', { Paths: cands.map((e) => e.p) })).need || [];
    if (need.length) await indexFiles(need.map((p) => ({ path: p, kind: kindFromPath(p), mtime: 0 })), (d, t) => { status.textContent = `Looking at the pictures… ${d} of ${t}`; });
    if (dead) return;
    const first = await api('/api/ai/suggest', { Paths: [cands[0].p] });
    if (!first.ready) { status.textContent = `Not enough to learn from yet: tag at least 6 pictures or videos yourself first (${first.trained} so far).`; return; }
    status.textContent = 'Finding suggestions…';
    let i = 0, shown = 0;
    const worker = async () => {
      while (i < cands.length && !dead) {
        const e = cands[i++];
        let r; try { r = await api('/api/ai/suggest', { Paths: [e.p] }); } catch (er) { continue; }
        const items = (r.items || []).filter((s) => s.score >= 0.25).slice(0, 5);
        if (!items.length) continue;
        results.set(e.p, items); shown++;
        grid.append(h('div', { class: 'rvcard', dataset: { p: e.p } },
          h('div', { class: 'rvimg' }, e.k === 'image' ? h('img', { src: THUMB_EXT.has(e.x) ? thumbUrl(e.p, e.m) : fileUrl(e.p), alt: '', loading: 'lazy' }) : h('video', { src: fileUrl(e.p) + '#t=0.1', muted: true, preload: 'metadata' })),
          h('div', { class: 'rvname', title: e.p }, e.n),
          h('div', { class: 'chips' }, items.map((s) => h('span', { class: 'chip quick off', dataset: { t: s.tag }, style: chipStyle(tagColor(s.tag)), title: (s.why || []).join(' · ') },
            h('span', { class: 'chip-t', onclick: () => { if (!picks.has(e.p)) picks.set(e.p, new Set()); const set = picks.get(e.p); if (set.has(s.tag)) set.delete(s.tag); else set.add(s.tag); paint(); } }, s.tag, h('em', {}, Math.round(s.score * 100) + '%')))))));
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    if (dead) return;
    status.textContent = shown ? `${shown} of ${cands.length} untagged files have suggestions.` : 'No confident suggestions for these files yet - tag a few more by hand and try again.';
    tools.hidden = !shown;
  } catch (e) { status.textContent = e.message; }
}

// ---------------------------------------------------------------- similar pictures
async function openSimilar(e) {
  const grid = h('div', { class: 'simgrid' });
  const status = h('p', { class: 'hint', style: { marginTop: 0 } }, 'Looking…');
  const m = modal('Similar to “' + e.n + '”', h('div', {}, status, grid), [{ label: 'Close' }], { wide: true });
  try {
    let r = await api('/api/ai/similar', { Path: e.p, N: 48 });
    if (r.need) { await indexFiles([{ path: e.p, kind: e.k, mtime: e.m }]); r = await api('/api/ai/similar', { Path: e.p, N: 48 }); }
    const items = r.items || [];
    status.textContent = items.length ? 'Compared with every picture and video TagShelf has looked at so far (it looks at each folder you open and at everything you tag).' : 'Nothing similar found yet. Open a few more folders so TagShelf can look at them, then try again.';
    for (const it of items) {
      const k = kindFromPath(it.path);
      grid.append(h('div', { class: 'sim', title: it.path, onclick: () => { m.close(); go(dirOf(it.path), { select: [it.path] }); } },
        k === 'image' ? h('img', { src: THUMB_EXT.has(extOf(it.path)) ? thumbUrl(it.path, 0) : fileUrl(it.path), loading: 'lazy', alt: '' }) : h('div', { style: { aspectRatio: '1', display: 'grid', placeItems: 'center' } }, icon('video', 32)),
        h('div', {}, h('span', {}, baseName(it.path)), h('span', { class: 'muted' }, Math.round(it.sim * 100) + '%'))));
    }
  } catch (er) { status.textContent = er.message; }
}

// ---------------------------------------------------------------- downloads, help, welcome
function openDownloads() {
  const root = h('div', {});
  const dl = mountDownloads(root, { onApplied: () => refresh({ silent: true }), onEmpty: () => {} });
  modal('New downloads', root, [{ label: 'Close' }], { onclose: () => { dl.stop(); renderNav(); } });
}

function openHelp() {
  const rows = [
    ['Enter / double-click', 'Open file or folder'], ['Space', 'Preview picture or video'], ['← → ↑ ↓', 'Move the selection (with Shift: extend it)'],
    ['Ctrl+A / Ctrl+I', 'Select all / invert selection'], ['1 … 9', 'Toggle your nine most-used tags on the selected files'], ['Alt+1 … 5 (Alt+0)', 'Set a star rating (clear it)'],
    ['F2', 'Rename (several files: batch rename)'], ['Delete', 'Move to the ' + trashWord()], ['Ctrl+C / X / V', 'Copy / cut / paste files'], ['Ctrl+Z', 'Undo (rename, move, tag changes)'],
    ['Ctrl+Shift+N', 'New folder'], ['Alt+← / → / ↑, Backspace', 'Back / forward / up'], ['Ctrl+L or F4', 'Type a folder path'], ['Ctrl+F', 'Search this folder'],
    ['F5', 'Refresh'], ['Esc', 'Clear selection, then filters'], ['Drag files onto a folder', 'Move them (hold Ctrl to copy)'], ['Type letters', 'Jump to a file by name'],
  ];
  modal('Keyboard shortcuts', h('table', { class: 'tbl' }, rows.map(([k, d]) => h('tr', {}, h('td', {}, h('kbd', {}, k)), h('td', {}, d)))), [{ label: 'Close', primary: true }], { wide: true });
}

function openWelcome() {
  modal('Welcome to TagShelf', h('div', { class: 'form' },
    h('p', { style: { margin: 0 } }, 'Browse your folders like in Explorer, but give any file as many tags as you like.'),
    h('ul', { style: { margin: 0, paddingLeft: '20px', lineHeight: '1.7' } },
      h('li', {}, 'Click a file: its tags appear on the right. Select several to tag them together.'),
      h('li', {}, 'The Filter tab narrows the current folder (and subfolders) by tag.'),
      h('li', {}, 'TagShelf learns from your tagging and suggests tags. It never applies one by itself.'),
      h('li', {}, 'When you download a picture or video, a small window offers tags for it.'),
      h('li', {}, 'Your files are never changed. Tags live in TagShelf\'s own file.'))),
  [{ label: 'Keyboard shortcuts', fn: () => { setTimeout(openHelp, 50); } }, { label: 'Start', primary: true, fn: () => { if (!S.bgAsked) setTimeout(openBackgroundAsk, 80); } }]);
  S.welcomed = true; saveSettingsSoon();
}

// asked once: should TagShelf keep running quietly so it can catch downloads?
function openBackgroundAsk() {
  let auto = S.os === 'windows';
  const done = () => { S.bgAsked = true; saveSettingsSoon(); };
  modal('Offer tags for your downloads?', h('div', { class: 'form' },
    h('p', { style: { margin: 0 } }, 'When a picture or video finishes downloading in your browser, TagShelf can pop up a small window with suggested tags.'),
    h('p', { style: { margin: 0 } }, 'For that it has to keep running quietly in the background, even after you close its main window. Start the app again to open the window, or use “Quit TagShelf” (bottom left) to stop it completely. You can change this any time in Settings.'),
    S.os === 'windows' ? h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: true, onchange: (e) => { auto = e.target.checked; } }), 'Also start it automatically when I sign in to Windows') : null),
  [{ label: 'No, only while the window is open', fn: done },
    { label: 'Yes, keep it running', primary: true, fn: async () => { done(); await setPrefs(auto ? { Background: true, Autostart: true } : { Background: true }); toast('TagShelf will offer tags for new downloads'); } }],
  { onclose: () => { if (!S.bgAsked) done(); } });
}
