// nav.js - one nav bar, injected into every tower page. Served at /nav.js.
// Each page includes <script src="/nav.js"></script>; this builds the bar,
// highlights the current view, and carries a one-line description of each.
(function () {
  var PAGES = [
    { href: '/lotor', label: 'Lotor', tag: 'the product',
      desc: 'The product. Your record derived straight from the receipts: where each session landed, day-blocks rolling up the work, the decisions you signed, and the recall index into every transcript.' },
    { href: '/control', label: 'Control', tag: 'witness',
      desc: 'Master control panel. The three modes (herded, grazing, loose) and the witness board - who is watching, and do they agree. The outside witness, when absent, is the loudest element on the page.' },
    { href: '/ontology', label: 'Decisions', tag: 'lineage',
      desc: 'The decision lineage, left to right: how we got to this moment. Every card carries provenance (you said it, I inferred it, or the chain recorded it). The rail ranks what needs a decision.' },
    { href: '/events', label: 'Events', tag: 'audit',
      desc: 'Every receipt on the chain, filterable by kind, time, and session, newest first. Append-only and hash-linked, so you can browse the record but never edit it.' },
    { href: '/', label: 'Lineage', tag: 'detail',
      desc: 'Session detail. The chain as a spine, newest first, with each session’s model ladder, tool counts, files touched, and gate approvals and denials.' },
    { href: '/people', label: 'People', tag: 'private',
      desc: 'Private tool, not part of the shipped product. You as the nucleus, guild buckets ordered by closeness, drag to categorize. Counts only, nothing enforced.' }
  ];
  var path = location.pathname.replace(/\/+$/, '') || '/';
  var cur = null;
  for (var i = 0; i < PAGES.length; i++) {
    var p = PAGES[i];
    if (p.href === '/' ? path === '/' : path.indexOf(p.href) === 0) { cur = p; break; }
  }
  if (!cur) cur = PAGES[0];

  var css = ''
    + '.lotor-nav{position:sticky;top:0;z-index:40;display:flex;align-items:center;gap:16px;'
    + 'padding:9px 22px;background:#0b0b0b;border-bottom:1px solid #2A2A2A;font-family:Inter,system-ui,sans-serif;flex-wrap:wrap}'
    + '.ln-brand{font-family:Syne,Inter,sans-serif;font-weight:700;font-size:14px;color:#EDEDED;letter-spacing:.02em}'
    + '.ln-links{display:flex;gap:4px}'
    + '.ln-link{color:#A6A6A6;font-size:13px;text-decoration:none;padding:5px 12px;border-radius:7px;border:1px solid transparent;display:inline-flex;align-items:center;gap:6px}'
    + '.ln-link:hover{color:#EDEDED;background:#161616}'
    + '.ln-link.on{color:#D4A017;border-color:rgba(212,160,23,.35);background:rgba(212,160,23,.10)}'
    + '.ln-tag{font-family:"JetBrains Mono",ui-monospace,Consolas,monospace;font-size:9px;text-transform:uppercase;letter-spacing:.06em;color:#6A6A6A}'
    + '.ln-link.on .ln-tag{color:#D4A017}'
    + '.ln-desc{color:#6A6A6A;font-size:11.5px;flex:1;min-width:220px;line-height:1.35}'
    + '.ln-help{margin-left:auto;color:#6A6A6A;border:1px solid #2A2A2A;border-radius:6px;padding:3px 9px;font-size:11px;cursor:pointer;background:#141414}'
    + '.ln-help:hover{color:#EDEDED;border-color:#3a3a3a}'
    + '.ln-sheet{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:60;display:none;align-items:center;justify-content:center}'
    + '.ln-sheet.show{display:flex}'
    + '.ln-card{width:min(560px,92vw);background:#131313;border:1px solid #2A2A2A;border-top:3px solid #D4A017;border-radius:12px;padding:20px 22px;max-height:82vh;overflow:auto}'
    + '.ln-card h3{font-family:Syne,Inter,sans-serif;margin:0 0 12px;font-size:17px;color:#EDEDED}'
    + '.ln-row{padding:9px 0;border-bottom:1px solid #1C1C1C}'
    + '.ln-row .t{font-size:13px;color:#EDEDED;font-weight:600}.ln-row .t b{color:#D4A017}'
    + '.ln-row .d{font-size:12px;color:#A6A6A6;margin-top:3px;line-height:1.4}'
    + '.ln-close{float:right;background:none;border:1px solid #2A2A2A;color:#A6A6A6;border-radius:6px;padding:3px 10px;cursor:pointer;font:inherit}';

  var linksHtml = PAGES.map(function (p) {
    return '<a class="ln-link' + (p === cur ? ' on' : '') + '" href="' + p.href + '" title="' +
      p.desc.replace(/"/g, '&quot;') + '">' + p.label + '<span class="ln-tag">' + p.tag + '</span></a>';
  }).join('');

  var bar = document.createElement('div');
  bar.className = 'lotor-nav';
  bar.innerHTML = '<span class="ln-brand">🔱 tower</span>' +
    '<div class="ln-links">' + linksHtml + '</div>' +
    '<div class="ln-desc">' + cur.desc + '</div>' +
    '<button class="ln-help" id="lnHelp">what am I looking at?</button>';

  var sheet = document.createElement('div');
  sheet.className = 'ln-sheet';
  sheet.innerHTML = '<div class="ln-card"><button class="ln-close" id="lnSheetClose">close</button>' +
    '<h3>The tower, five views over one record</h3>' +
    PAGES.map(function (p) {
      return '<div class="ln-row"><div class="t"><b>' + p.label + '</b> &middot; ' + p.tag + '</div><div class="d">' + p.desc + '</div></div>';
    }).join('') +
    '<div class="ln-row" style="border:none"><div class="d" style="color:#6A6A6A">Everything above one source: the Lotor receipt chain. The server is a lightweight hook that pulls it in. Design around the model, not into it.</div></div>' +
    '</div>';

  function inject() {
    var style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);
    var sig = document.querySelector('.sig');
    if (sig) sig.parentNode.insertBefore(bar, sig.nextSibling);
    else document.body.insertBefore(bar, document.body.firstChild);
    document.body.appendChild(sheet);
    document.getElementById('lnHelp').onclick = function () { sheet.classList.add('show'); };
    document.getElementById('lnSheetClose').onclick = function () { sheet.classList.remove('show'); };
    sheet.onclick = function (e) { if (e.target === sheet) sheet.classList.remove('show'); };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', inject);
  else inject();
})();
