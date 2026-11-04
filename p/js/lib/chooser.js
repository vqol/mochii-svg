// mochii's own dropdown list. every <select> on the site (the shell, mochii's pages and the chat) still holds the value, shows it
// and fires its usual change events, but clicking it or opening it from the keyboard shows this list instead of the browser's.
// long lists get a filter box. a select with data-native keeps the browser's list. pages are blob urls, so pages/shared.js
// inlines this function's text into each one: it may only use its own body
function mochiiChooser() {
  if (window.__mochiiChooser) return;
  window.__mochiiChooser = true;
  const chevron = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%238c8c8c' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")";
  const st = document.createElement('style');
  st.textContent = `
    select:not([multiple]):not([data-native]){-webkit-appearance:none!important;appearance:none!important;background-image:${chevron}!important;background-repeat:no-repeat!important;background-position:right 10px center!important;background-size:13px 13px!important;padding-right:30px!important;cursor:pointer;text-overflow:ellipsis}
    select[data-open]{border-color:var(--border-faint,rgba(255,255,255,.18))!important}
    .mch{position:fixed;z-index:2147483600;display:flex;flex-direction:column;max-width:min(380px,calc(100vw - 16px));max-height:min(340px,60vh);padding:5px;border-radius:calc(var(--radius-item,10px) + 4px);
      background:var(--surface-3,#111);border:1px solid var(--border-faint,rgba(255,255,255,.1));box-shadow:0 18px 44px -14px rgba(0,0,0,.75),0 2px 6px rgba(0,0,0,.3);
      color:var(--text-secondary,#c8c8c8);font-size:13px;text-transform:lowercase;transform-origin:top center;animation:mch-in .13s cubic-bezier(.2,.7,.2,1)}
    .mch.up{transform-origin:bottom center}
    @keyframes mch-in{from{opacity:0;transform:translateY(-4px) scale(.98)}}
    .mch.up{animation-name:mch-in-up}
    @keyframes mch-in-up{from{opacity:0;transform:translateY(4px) scale(.98)}}
    @media (prefers-reduced-motion:reduce){.mch{animation:none}}
    .mch-q{flex:0 0 32px;height:32px;margin:0 0 5px;padding:0 10px;border:1px solid var(--border-subtle,rgba(255,255,255,.06));border-radius:var(--radius-item,10px);outline:none;
      background:var(--surface-0,#060606);color:var(--text-primary,#ebebeb);font:inherit;text-transform:lowercase}
    .mch-q:focus{border-color:var(--border-faint,rgba(255,255,255,.14))}
    .mch-q::placeholder{color:var(--text-faint,#646464)}
    .mch-list{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin}
    .mch-opt{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:32px;padding:0 10px;border-radius:calc(var(--radius-item,10px) - 2px);cursor:pointer;white-space:nowrap}
    .mch-opt span{min-width:0;overflow:hidden;text-overflow:ellipsis}
    .mch-opt svg{flex:0 0 14px;width:14px;height:14px;opacity:0;color:var(--accent,#fff)}
    .mch-opt.act{background:var(--accent-soft,rgba(255,255,255,.08));color:var(--text-white,#fafafa)}
    .mch-opt.on{color:var(--text-white,#fafafa)}
    .mch-opt.on svg{opacity:1}
    .mch-opt.off{opacity:.4;cursor:default}
    .mch-group{padding:9px 10px 4px;color:var(--text-faint,#646464);font-size:11px}
    .mch-empty{padding:16px 10px;color:var(--text-faint,#646464);text-align:center}`;
  (document.head || document.documentElement).appendChild(st);

  const check = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  let pop = null, sel = null, items = [], act = 0, typed = '', typedAt = 0;
  const usable = s => s && s.tagName === 'SELECT' && !s.multiple && s.size <= 1 && !s.disabled && !s.hasAttribute('data-native');
  const listen = on => {
    const f = on ? addEventListener : removeEventListener;
    f('pointerdown', outside, true); f('resize', closeNow); f('scroll', onScroll, true); f('blur', closeNow);
  };
  const outside = e => { if (pop && !pop.contains(e.target) && e.target !== sel) close(false); };
  const onScroll = e => { if (pop && !pop.contains(e.target)) close(false); };
  const closeNow = () => close(false);

  function close(refocus) {
    if (!pop) return;
    pop.remove(); pop = null; listen(false);
    const s = sel; sel = null;
    if (s) { s.removeAttribute('data-open'); if (refocus) s.focus({ preventScroll: true }); }
  }
  function mark(scroll) {
    items.forEach((d, k) => d.classList.toggle('act', k === act));
    if (scroll && items[act]) items[act].scrollIntoView({ block: 'nearest' });
  }
  function build(filter) {
    const list = pop.querySelector('.mch-list'), f = (filter || '').trim().toLowerCase();
    list.innerHTML = ''; items = [];
    let group = null;
    [...sel.options].forEach((o, i) => {
      if (o.hidden || (f && !o.text.toLowerCase().includes(f))) return;
      const g = o.parentElement && o.parentElement.tagName === 'OPTGROUP' ? o.parentElement.label : null;
      if (g !== group) { group = g; if (g) { const h = document.createElement('div'); h.className = 'mch-group'; h.textContent = g; list.appendChild(h); } }
      const d = document.createElement('div'), on = i === sel.selectedIndex;
      d.className = 'mch-opt' + (o.disabled ? ' off' : '') + (on ? ' on' : '');
      d.setAttribute('role', 'option'); d.setAttribute('aria-selected', on); d.dataset.i = i;
      d.innerHTML = '<span></span>' + check; d.firstChild.textContent = o.text;
      list.appendChild(d);
      if (!o.disabled) items.push(d);
    });
    if (!list.childElementCount) list.innerHTML = '<div class="mch-empty">nothing matches</div>';
    act = Math.max(0, items.findIndex(d => d.classList.contains('on')));
    mark(true);
  }
  function place() {
    const r = sel.getBoundingClientRect();
    pop.style.minWidth = Math.max(r.width, 170) + 'px';
    const w = pop.offsetWidth, h = pop.offsetHeight, below = innerHeight - r.bottom - 8, above = r.top - 8;
    pop.style.left = Math.max(8, Math.min(r.left, innerWidth - w - 8)) + 'px';
    if (h > below && above > below) { pop.classList.add('up'); pop.style.top = Math.max(8, r.top - 6 - h) + 'px'; }
    else pop.style.top = Math.min(r.bottom + 6, innerHeight - h - 8) + 'px';
  }
  function open(s) {
    close(false);
    sel = s; s.setAttribute('data-open', '');
    pop = document.createElement('div');
    pop.className = 'mch'; pop.setAttribute('role', 'listbox');
    if (s.getAttribute('aria-label')) pop.setAttribute('aria-label', s.getAttribute('aria-label'));
    pop.style.fontFamily = getComputedStyle(s).fontFamily;
    const long = s.options.length > 10;
    pop.innerHTML = (long ? '<input class="mch-q" type="text" placeholder="filter" spellcheck="false" autocomplete="off" aria-label="filter">' : '') + '<div class="mch-list"></div>';
    document.body.appendChild(pop);
    build(''); place(); mark(true);
    const q = pop.querySelector('.mch-q');
    if (q) { q.oninput = () => build(q.value); q.focus({ preventScroll: true }); }
    // clicks inside keep focus where it is, so the select (or the filter) still gets the keys
    pop.onpointerdown = e => { if (e.target !== q) e.preventDefault(); };
    pop.onclick = e => { const d = e.target.closest('.mch-opt'); if (d && !d.classList.contains('off')) pick(+d.dataset.i); };
    pop.onpointermove = e => { const k = items.indexOf(e.target.closest('.mch-opt')); if (k >= 0 && k !== act) { act = k; mark(false); } };
    listen(true);
  }
  function pick(i) {
    const s = sel;
    close(true);
    if (!s || s.selectedIndex === i) return;
    s.selectedIndex = i;
    s.dispatchEvent(new Event('input', { bubbles: true }));
    s.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function keys(e) {
    const k = e.key, inQ = e.target.classList && e.target.classList.contains('mch-q');
    if (k === 'ArrowDown' || k === 'ArrowUp') { e.preventDefault(); act = Math.max(0, Math.min(items.length - 1, act + (k === 'ArrowDown' ? 1 : -1))); mark(true); }
    else if ((k === 'Home' || k === 'End') && !inQ) { e.preventDefault(); act = k === 'Home' ? 0 : items.length - 1; mark(true); }
    else if (k === 'Enter' || (k === ' ' && !inQ)) { e.preventDefault(); if (items[act]) pick(+items[act].dataset.i); }
    else if (k === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
    else if (k === 'Tab') close(false);
    else if (!inQ && k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // type to jump, like the browser's own list
      e.preventDefault();
      typed = (Date.now() - typedAt > 700 ? '' : typed) + k.toLowerCase(); typedAt = Date.now();
      const k2 = items.findIndex(d => d.textContent.toLowerCase().startsWith(typed));
      if (k2 >= 0) { act = k2; mark(true); }
    }
  }

  addEventListener('mousedown', e => {
    const s = e.target.closest && e.target.closest('select');
    if (!usable(s) || e.button !== 0) return;
    e.preventDefault();
    s.focus({ preventScroll: true });
    if (sel === s) close(false); else open(s);
  }, true);
  // touch screens open the list on the tap itself
  addEventListener('touchend', e => {
    const s = e.target.closest && e.target.closest('select');
    if (!usable(s)) return;
    e.preventDefault();
    if (sel === s) close(false); else open(s);
  }, { capture: true, passive: false });
  addEventListener('keydown', e => {
    if (pop && (e.target === sel || pop.contains(e.target))) return keys(e);
    const s = e.target;
    if (!usable(s) || e.ctrlKey || e.metaKey) return;
    if (['Enter', ' ', 'ArrowDown', 'ArrowUp', 'F4'].includes(e.key)) { e.preventDefault(); open(s); }
  }, true);
}
mochiiChooser();
