'use strict';
// The small window that opens by itself when a picture or video has finished downloading.
(async function () {
  try { await loadState(); } catch (e) { /* the card still works with defaults */ }
  const ping = () => fetch('/api/popup/ping').catch(() => {});
  ping(); setInterval(ping, 2000);
  const body = h('div', { class: 'popbody' });
  $('#popup').append(h('div', { class: 'phead' }, h('span', { class: 'logo' }, icon('tag', 15)), h('b', {}, 'TagShelf'), h('span', { class: 'muted' }, 'tag your download')), body);
  let closing = false;
  mountDownloads(body, {
    popup: true,
    onEmpty: () => { if (closing) return; closing = true; setTimeout(() => { window.close(); }, 1100); },
  });
})();
