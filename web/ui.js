'use strict';
// toasts, context menus, dialogs

let toastTimer;
function toast(msg, opt = {}) {
  const t = $('#toast');
  t.replaceChildren(h('span', {}, msg));
  if (opt.action) t.append(h('button', { class: 'toast-act', onclick: () => { t.hidden = true; opt.action.fn(); } }, opt.action.label));
  t.className = opt.error ? 'err' : '';
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, opt.ms || (opt.error ? 6000 : opt.action ? 6500 : 3200));
}
const fail = (e) => toast(e && e.message ? e.message : String(e), { error: true });

function closeMenu() { const m = $('#menu'); m.hidden = true; m.replaceChildren(); }
function menu(x, y, items) {
  const m = $('#menu');
  m.replaceChildren();
  for (const it of items) {
    if (it === '-') { m.append(h('div', { class: 'msep' })); continue; }
    if (it.label == null) continue;
    m.append(h('button', {
      class: 'mi' + (it.danger ? ' danger' : ''), disabled: !!it.disabled,
      onclick: () => { closeMenu(); it.fn && it.fn(); },
    }, it.icon ? icon(it.icon, 15) : h('span', { class: 'ico' }), h('span', { class: 'ml' }, it.label), it.key ? h('span', { class: 'mk' }, it.key) : null));
  }
  m.hidden = false;
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 4)) + 'px';
  m.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 4)) + 'px';
}
document.addEventListener('mousedown', (e) => { if (!e.target.closest('#menu')) closeMenu(); }, true);
document.addEventListener('scroll', closeMenu, true);

// generic modal: returns {close, el}
function modal(title, body, buttons = [], opt = {}) {
  const root = $('#modal');
  const box = h('div', { class: 'dlg' + (opt.wide ? ' wide' : '') },
    h('div', { class: 'dlg-h' }, h('span', {}, title), h('button', { class: 'ibtn', title: 'Close', onclick: () => close() }, icon('x', 16))),
    h('div', { class: 'dlg-b' }, body),
    buttons.length ? h('div', { class: 'dlg-f' }, buttons.map((b) => h('button', {
      class: 'btn' + (b.primary ? ' primary' : '') + (b.danger ? ' danger' : ''),
      onclick: async () => { if (b.fn) { const r = await b.fn(); if (r === false) return; } close(); },
    }, b.label))) : null);
  const back = h('div', { class: 'dlg-back', onmousedown: (e) => { if (e.target === back) close(); } }, box);
  const prevFocus = document.activeElement;
  function close() { back.remove(); if (!$('#modal').children.length) root.hidden = true; if (opt.onclose) opt.onclose(); if (prevFocus && prevFocus.focus) try { prevFocus.focus(); } catch (e) { /* gone */ } }
  root.append(back); root.hidden = false;
  return { close, el: box };
}
function isModalOpen() { return !$('#modal').hidden && $('#modal').children.length > 0; }

function prompt(title, label, value = '', opt = {}) {
  return new Promise((resolve) => {
    let done = false;
    const inp = h('input', { class: 'txt', type: 'text', value, spellcheck: 'false' });
    const submit = () => { if (done) return false; done = true; resolve(inp.value); m.close(); };
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    const m = modal(title, h('div', { class: 'form' }, label ? h('label', {}, label) : null, inp, opt.help ? h('p', { class: 'hint' }, opt.help) : null),
      [{ label: 'Cancel' }, { label: opt.ok || 'OK', primary: true, fn: () => { submit(); return false; } }],
      { onclose: () => { if (!done) { done = true; resolve(null); } } });
    setTimeout(() => { inp.focus(); if (opt.selectStem) inp.setSelectionRange(0, stem(value).length); else inp.select(); }, 30);
  });
}
function confirmBox(title, message, okLabel = 'OK', danger = false) {
  return new Promise((resolve) => {
    let done = false;
    const m = modal(title, h('p', {}, message), [{ label: 'Cancel' }, { label: okLabel, primary: !danger, danger, fn: () => { done = true; resolve(true); } }],
      { onclose: () => { if (!done) resolve(false); } });
    setTimeout(() => $('.btn:last-child', m.el).focus(), 30);
  });
}

// ---------------------------------------------------------------- tag chip helpers
function tagColor(name) { return (S && S.tagMap[name] && S.tagMap[name].color) || '#9aa5b8'; }
function chipStyle(color) { return { '--c': color }; }
function tagChip(name, opt = {}) {
  const c = h('span', { class: 'chip' + (opt.partial ? ' partial' : '') + (opt.cls ? ' ' + opt.cls : ''), style: chipStyle(tagColor(name)), title: opt.title || name },
    h('span', { class: 'chip-t', onclick: opt.onclick }, name, opt.count ? h('em', {}, opt.count) : null));
  if (opt.onremove) c.append(h('button', { class: 'chip-x', title: 'Remove tag', onclick: (e) => { e.stopPropagation(); opt.onremove(); } }, icon('x', 11)));
  return c;
}

// An input that adds tags: autocompletes from existing tags, Enter adds, comma separates.
function tagInput(onAdd, opt = {}) {
  const inp = h('input', { class: 'txt tag-in', type: 'text', placeholder: opt.placeholder || 'Add a tag…', spellcheck: 'false', autocomplete: 'off' });
  const list = h('div', { class: 'ac', hidden: true });
  let items = [], idx = -1;
  const wrap = h('div', { class: 'tagin' }, inp, list);
  function show() {
    const q = inp.value.trim().split(',').pop().trim().toLowerCase();
    const have = new Set((opt.exclude ? opt.exclude() : []).map((x) => x.toLowerCase()));
    items = S.tags.filter((t) => !have.has(t.name.toLowerCase()) && (!q || t.name.toLowerCase().includes(q)))
      .sort((a, b) => (a.name.toLowerCase().startsWith(q) ? 0 : 1) - (b.name.toLowerCase().startsWith(q) ? 0 : 1) || b.used - a.used).slice(0, 8);
    idx = -1; paint();
  }
  function paint() {
    list.replaceChildren(...items.map((t, i) => h('div', { class: 'ac-i' + (i === idx ? ' on' : ''), onmousedown: (e) => { e.preventDefault(); pick(t.name); } },
      h('i', { style: { background: t.color } }), h('span', {}, t.name), h('em', {}, t.count))));
    list.hidden = !items.length || document.activeElement !== inp;
  }
  function pick(name) {
    const parts = inp.value.split(',');
    parts[parts.length - 1] = name;
    inp.value = parts.join(',');
    commit();
  }
  function commit() {
    const names = inp.value.split(',').map((s) => s.trim()).filter(Boolean);
    inp.value = ''; list.hidden = true;
    if (names.length) onAdd(names);
  }
  inp.addEventListener('input', show);
  inp.addEventListener('blur', () => { list.hidden = true; });
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && list.hidden) { e.preventDefault(); show(); }
    else if (e.key === 'ArrowDown' && items.length) { e.preventDefault(); idx = (idx + 1) % items.length; paint(); }
    else if (e.key === 'ArrowUp' && items.length) { e.preventDefault(); idx = (idx - 1 + items.length) % items.length; paint(); }
    else if (e.key === 'Enter') { e.preventDefault(); if (idx >= 0 && items[idx]) pick(items[idx].name); else commit(); }
    else if (e.key === 'Escape') { if (inp.value) { inp.value = ''; list.hidden = true; e.stopPropagation(); } else inp.blur(); }
    else if (e.key === 'Tab' && items.length && inp.value.trim()) { e.preventDefault(); pick(items[Math.max(idx, 0)].name); }
    e.stopPropagation();
  });
  wrap.input = inp;
  return wrap;
}
