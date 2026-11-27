/*!
 * rich-editor.js — محرر المقالات (لوحة الإدارة)
 * يعمل فوق نفس <textarea id="body"> الحالي، ويحفظ المحتوى بنفس صيغة Markdown الموسَّعة،
 * لذلك تبقى كل وظائف اللوحة (الحفظ، التعديل، حذف الصور غير المستخدمة …) كما هي.
 * يعتمد على: js/rich.js
 */
(function () {
  'use strict';
  var Rich = window.Rich;
  var S = { ta: null, host: null, view: 'write', device: 'desktop', dirty: false, enabled: true, sel: { s: 0, e: 0 }, slash: null, timers: {}, frame: null, saving: false, lastLocal: 0, lastServer: 0, wide: false };
  var nf = function (n) { return (n || 0).toLocaleString('ar-EG'); };
  var $ = function (s, r) { return (r || document).querySelector(s); };

  function h(tag, props, kids) {
    var e = document.createElement(tag), k;
    for (k in (props || {})) { if (k === 'class') e.className = props[k]; else if (k === 'html') e.innerHTML = props[k]; else if (k === 'text') e.textContent = props[k]; else if (props[k] !== false && props[k] != null) e.setAttribute(k, props[k] === true ? '' : props[k]); }
    (kids || []).forEach(function (c) { if (c) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }
  var svg = function (d, extra) { return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"' + (extra || '') + '><path d="' + d + '"/></svg>'; };
  var IC = {
    alignR: 'M21 6H3M21 10H9M21 14H3M21 18H9', alignL: 'M3 6h18M3 10h12M3 14h18M3 18h12', alignC: 'M3 6h18M7 10h10M3 14h18M7 18h10', alignJ: 'M3 6h18M3 10h18M3 14h18M3 18h18',
    ul: 'M9 6h12M9 12h12M9 18h12M4 6h.01M4 12h.01M4 18h.01', ol: 'M10 6h11M10 12h11M10 18h11M4 6h1v4M4 10h2M6 18H4c0-1 2-2 2-3s-1-1.5-2-1', task: 'M3 5l2 2 4-4M3 14l2 2 4-4M13 6h8M13 15h8',
    indent: 'M3 6h18M11 12h10M3 18h18M3 9l3 3-3 3', outdent: 'M3 6h18M11 12h10M3 18h18M6 9l-3 3 3 3',
    link: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71',
    image: 'M3 5h18v14H3zM8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3M21 15l-5-5L5 19', video: 'M3 6h13v12H3zM16 10l5-3v10l-5-3', table: 'M3 4h18v16H3zM3 10h18M3 15h18M9 4v16M15 4v16',
    code: 'M16 18l6-6-6-6M8 6l-6 6 6 6', quote: 'M3 21c3 0 7-1 7-8V5H4v6h3c0 3-2 4-4 4zM14 21c3 0 7-1 7-8V5h-6v6h3c0 3-2 4-4 4z', hr: 'M3 12h18', card: 'M3 4h18v16H3zM7 9h6M7 13h10M7 16h4',
    details: 'M5 5l5 4-5 4M13 7h8M13 13h8M3 19h18', upload: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12', clear: 'M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3', eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6', help: 'M12 17h.01M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20'
  };
  var ico = function (n) { return svg(IC[n]); };

  /* ====================================================== low-level editing */
  function rep(a, b, text, sa, sb) {
    var ta = S.ta, ok = false, v0 = ta.value;
    ta.focus(); ta.setSelectionRange(a, b);
    try { if (text !== '') ok = document.execCommand('insertText', false, text); else ok = document.execCommand('delete'); } catch (e) { ok = false; }
    if (!ok || ta.value !== v0.slice(0, a) + text + v0.slice(b)) {
      ta.value = v0; ta.setRangeText(text, a, b, 'end'); ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
    var end = a + text.length;
    ta.setSelectionRange(sa == null ? end : sa, sb == null ? (sa == null ? end : sa) : sb);
    saveSel();
  }
  function saveSel() { S.sel = { s: S.ta.selectionStart, e: S.ta.selectionEnd }; }
  function restoreSel() { S.ta.focus(); try { S.ta.setSelectionRange(S.sel.s, S.sel.e); } catch (e) { } }
  function lineStart(v, p) { return v.lastIndexOf('\n', p - 1) + 1; }
  function lineEnd(v, p) { var i = v.indexOf('\n', p); return i < 0 ? v.length : i; }
  function selLines() {
    var ta = S.ta, v = ta.value, s = ta.selectionStart, e = ta.selectionEnd, a = lineStart(v, s);
    if (e > s && v.charAt(e - 1) === '\n') e--;
    var b = lineEnd(v, e);
    return { a: a, b: b, text: v.slice(a, b), empty: s === e && !v.slice(a, b).trim() };
  }
  function mapLines(fn) {
    var L = selLines(), lines = L.text.split('\n'), out = fn(lines).join('\n');
    rep(L.a, L.b, out, L.a, L.a + out.length);
  }
  /** هل الموضع داخل كتلة كود ``` ؟ */
  function inFence(pos) {
    var v = S.ta.value.slice(0, pos), re = /^[ \t]*(`{3,}|~{3,})/gm, m, open = null;
    while ((m = re.exec(v))) { if (open && m[1].charAt(0) === open.charAt(0) && m[1].length >= open.length) open = null; else if (!open) open = m[1]; }
    return !!open;
  }
  function insertBlock(a, b, block, selOff, selLen) {
    var v = S.ta.value, before = v.slice(0, a), after = v.slice(b), pre = '', post = '';
    if (before && !/\n\n$/.test(before)) pre = /\n$/.test(before) ? '\n' : '\n\n';
    if (after && !/^\n\n/.test(after)) post = /^\n/.test(after) ? '\n' : '\n\n';
    rep(a, b, pre + block + post, a + pre.length + (selOff || 0), a + pre.length + (selOff || 0) + (selLen || 0));
  }

  /* ---- inline formatting (toggle) ---- */
  function wrapOne(t, pre, post) {
    if (t.length >= pre.length + post.length && t.indexOf(pre) === 0 && t.slice(-post.length) === post && !(pre === '*' && t.indexOf('**') === 0) && !(pre === '~' && t.indexOf('~~') === 0)) return t.slice(pre.length, t.length - post.length);
    return pre + t + post;
  }
  function inl(pre, post, ph) {
    var ta = S.ta, v = ta.value, s = ta.selectionStart, e = ta.selectionEnd;
    while (s < e && /\s/.test(v.charAt(s))) s++;
    while (e > s && /\s/.test(v.charAt(e - 1))) e--;
    var sel = v.slice(s, e), out;
    if (sel.indexOf('\n') > -1) {
      out = sel.split('\n').map(function (l) { if (!l.trim()) return l; var m = l.match(/^(\s*)([\s\S]*?)(\s*)$/); return m[1] + wrapOne(m[2], pre, post) + m[3]; }).join('\n');
      return rep(s, e, out, s, s + out.length);
    }
    var bp = v.slice(s - pre.length, s), ap = v.slice(e, e + post.length), dbl = (pre === '*' && (v.charAt(s - 2) === '*' || v.charAt(e + 1) === '*')) || (pre === '~' && (v.charAt(s - 2) === '~' || v.charAt(e + 1) === '~'));
    if (sel && bp === pre && ap === post && !dbl) return rep(s - pre.length, e + post.length, sel, s - pre.length, s - pre.length + sel.length);
    if (sel && wrapOne(sel, pre, post) !== pre + sel + post) { out = wrapOne(sel, pre, post); return rep(s, e, out, s, s + out.length); }
    var txt = sel || ph;
    rep(s, e, pre + txt + post, s + pre.length, s + pre.length + txt.length);
  }
  function spanAttr(attr, val) { // [نص]{c=#hex} / {h=#hex}  — val===null يزيل اللون/التمييز
    var ta = S.ta, v = ta.value, s = ta.selectionStart, e = ta.selectionEnd;
    if (s === e) { S.host.toast('حدّد النص الذي تريد تلوينه أولاً', 'e'); return; }
    var sel = v.slice(s, e), m = sel.match(/^\[([\s\S]*)\]\{([^{}]*)\}$/), inner = sel, rest = {};
    if (!m && v.charAt(s - 1) === '[' && /^\]\{[^{}]*\}/.test(v.slice(e))) { var mm = v.slice(e).match(/^\]\{([^{}]*)\}/); s--; e += mm[0].length; sel = v.slice(s, e); m = sel.match(/^\[([\s\S]*)\]\{([^{}]*)\}$/); }
    if (m) { inner = m[1]; m[2].split(/\s+/).forEach(function (t) { var p = t.split('='); if (p[0]) rest[p[0]] = p.slice(1).join('='); }); }
    if (attr === 'c') { delete rest.color; if (val === null) delete rest.c; else rest.c = val; } else { delete rest.bg; delete rest.hl; if (val === null) delete rest.h; else rest.h = val; }
    var a = Object.keys(rest).map(function (k) { return rest[k] === '' ? k : k + '=' + rest[k]; }).join(' '), out = a ? '[' + inner + ']{' + a + '}' : inner;
    rep(s, e, out, s, s + out.length);
  }
  var PAL = { c: ['#e11d48', '#ea580c', '#d97706', '#16a34a', '#0d9488', '#2563eb', '#7c3aed', '#db2777', '#6b7280', '#111827', '#0b7285', '#a16207'], h: ['#fde68a', '#fecaca', '#fed7aa', '#bbf7d0', '#a5f3fc', '#bfdbfe', '#ddd6fe', '#fbcfe8', '#e5e7eb', '#fde047', '#86efac', '#93c5fd'] };
  function closePal() { var o = document.getElementById('re-pal'); if (o) o.remove(); document.removeEventListener('mousedown', palOut, true); }
  function palOut(e) { var o = document.getElementById('re-pal'); if (o && !o.contains(e.target) && !e.target.closest('[data-pal]')) closePal(); }
  function openPal(kind, anchor) {
    closePal(); var box = h('div', { id: 're-pal', class: 're-pal', role: 'dialog', 'aria-label': kind === 'c' ? 'لون النص' : 'لون التمييز' }), tt = h('div', { class: 're-pt', text: kind === 'c' ? 'لون النص المحدد' : 'لون خلفية النص المحدد' }), g = h('div', { class: 're-sw' });
    PAL[kind].forEach(function (c) { var b = h('button', { type: 'button', class: 're-swb', style: 'background:' + c, title: c, 'aria-label': c }); b.onmousedown = function (e) { e.preventDefault(); }; b.onclick = function () { restoreSel(); spanAttr(kind, c); closePal(); }; g.appendChild(b); });
    var cust = h('label', { class: 're-cu' }, [h('span', { text: 'لون مخصص' }), h('input', { type: 'color', value: PAL[kind][0] })]);
    cust.querySelector('input').onchange = function (e) { restoreSel(); spanAttr(kind, e.target.value); closePal(); };
    var rm = h('button', { type: 'button', class: 'btn o sm', text: kind === 'c' ? 'إزالة اللون' : 'إزالة التمييز' }); rm.onmousedown = function (e) { e.preventDefault(); }; rm.onclick = function () { restoreSel(); spanAttr(kind, null); closePal(); };
    [tt, g, cust, rm].forEach(function (x) { box.appendChild(x); }); document.body.appendChild(box);
    var r = anchor.getBoundingClientRect(), w = box.offsetWidth; box.style.top = Math.min(r.bottom + 6, innerHeight - box.offsetHeight - 8) + 'px'; box.style.left = Math.max(8, Math.min(r.left, innerWidth - w - 8)) + 'px';
    document.addEventListener('mousedown', palOut, true);
  }

  function clearFmt() {
    var ta = S.ta, v = ta.value, s = ta.selectionStart, e = ta.selectionEnd; if (s === e) { s = lineStart(v, s); e = lineEnd(v, e); }
    var t = v.slice(s, e).replace(/\[([^\]]*)\]\{[^{}]*\}/g, '$1').replace(/\*\*(\S(?:[\s\S]*?\S)?)\*\*/g, '$1').replace(/(^|[^*\w])\*(\S(?:[^*\n]*?\S)?)\*/g, '$1$2').replace(/~~(\S(?:[\s\S]*?\S)?)~~/g, '$1').replace(/\+\+(\S(?:[\s\S]*?\S)?)\+\+/g, '$1').replace(/==(\S(?:[\s\S]*?\S)?)==/g, '$1').replace(/\^([^\s^]+)\^/g, '$1').replace(/~([^\s~]+)~/g, '$1');
    rep(s, e, t, s, s + t.length);
  }

  /* ---- paragraph-level ---- */
  var PUNCT_END = /[.،,؛:!؟?…"”»)]$/;
  var PREFIX = /^([ \t]*)(?:[-•*]\s+(?:\[[ xX]\]\s+)?|(?:\d{1,4}|[٠-٩]{1,4})[.)]\s+|>\s?|#{1,4}\s+)?([\s\S]*)$/;
  function heading(n) {
    mapLines(function (lines) {
      var ne = lines.filter(function (l) { return l.trim(); }), same = n > 0 && ne.length && ne.every(function (l) { return new RegExp('^#{' + n + '}\\s').test(l); });
      if (same) n = 0;
      return lines.map(function (l) {
        if (!l.trim()) return l;
        var wasH = /^#{1,4}\s/.test(l), body = l.replace(PREFIX, '$2').replace(/\s*\{p\}\s*$/, '');
        if (n) return '#'.repeat(n) + ' ' + body;
        if (wasH && body.length <= 70 && !PUNCT_END.test(body) && !/\{[^{}]*\}\s*$/.test(body)) return body + ' {p}'; // يمنع تحوّل السطر القصير إلى عنوان تلقائياً
        return body;
      });
    });
  }
  function kindOf(l) {
    if (/^\s*[-•*]\s+\[[ xX]\]\s/.test(l)) return 'task'; if (/^\s*[-•*]\s/.test(l)) return 'ul';
    if (/^\s*(?:\d{1,4}|[٠-٩]{1,4})[.)]\s/.test(l)) return 'ol'; if (/^\s*>/.test(l)) return 'quote'; return '';
  }
  function listKind(kind) {
    var ph = { ul: 'عنصر', ol: 'عنصر', task: 'مهمة', quote: 'اقتباس' }[kind];
    var L = selLines(); if (L.empty) { var pf = { ul: '- ', ol: '1. ', task: '- [ ] ', quote: '> ' }[kind]; return rep(L.a, L.b, pf + ph, L.a + pf.length, L.a + pf.length + ph.length); }
    mapLines(function (lines) {
      var ne = lines.filter(function (l) { return l.trim(); }), off = ne.length && ne.every(function (l) { return kindOf(l) === kind; }), n = 0;
      return lines.map(function (l) {
        if (!l.trim()) return l; var m = l.match(PREFIX), indent = m[1], body = m[2];
        if (off) return indent + body; n++;
        return indent + { ul: '- ', ol: n + '. ', task: '- [ ] ', quote: '> ' }[kind] + body;
      });
    });
  }
  function quote(style) {
    var L = selLines(), lines = L.text.split('\n'), ne = lines.filter(function (l) { return l.trim(); }), out;
    var hdr = /^\s*>\s*\[!\w+\]\s*$/;
    if (ne.length && ne.every(function (l) { return kindOf(l) === 'quote'; })) { out = lines.filter(function (l) { return !hdr.test(l); }).map(function (l) { return l.replace(/^(\s*)>\s?/, '$1'); }).join('\n'); return rep(L.a, L.b, out, L.a, L.a + out.length); }
    var body = L.text.trim() ? lines.filter(function (l) { return l.trim(); }).map(function (l) { return '> ' + l.replace(PREFIX, '$2'); }) : ['> اقتباس'];
    if (style && style !== 'classic') body.unshift('> [!' + style + ']');
    out = body.join('\n'); rep(L.a, L.b, out, L.a + out.length - (L.text.trim() ? 0 : 5), L.a + out.length);
  }
  function indent(dir) {
    var L = selLines(); if (L.empty && dir > 0) return rep(S.ta.selectionStart, S.ta.selectionEnd, '  ');
    mapLines(function (lines) { return lines.map(function (l) { if (dir > 0) return l.trim() ? '  ' + l : l; return l.replace(/^(?: {1,2}|\t)/, ''); }); });
  }
  var AL = { right: 1, left: 1, center: 1, justify: 1 }, DR = { rtl: 1, ltr: 1, auto: 1 }, TOKOK = /^(?:right|left|center|justify|rtl|ltr|auto|p|يمين|يسار|وسط|ضبط|#[\p{L}\p{N}_-]{1,60})$/u;
  var AR2EN = { 'يمين': 'right', 'يسار': 'left', 'وسط': 'center', 'ضبط': 'justify' };
  function tokensOf(line) {
    var text = line, toks = [], n, m, t;
    for (n = 0; n < 4; n++) { m = text.match(/\s*\{([^{}]*)\}\s*$/); if (!m) break; t = m[1].trim().split(/[\s,]+/).filter(Boolean); if (!t.length || !t.every(function (k) { return TOKOK.test(k); })) break; toks = t.concat(toks); text = text.slice(0, m.index); }
    return { text: text, toks: toks.map(function (k) { return AR2EN[k] || k; }) };
  }
  var NOTPARA = /^\s*(?:[-•*]\s|(?:\d{1,4}|[٠-٩]{1,4})[.)]\s|\||`{3}|~{3}|:{3}|!\[|@(?:video|card)|\[video\]|-{3,}\s*$|https?:\/\/\S+\s*$)/;
  function setTok(tok, group) {
    var L = selLines(), starts = lineStart(S.ta.value, L.a), lines = L.text.split('\n'), pos = L.a, elig = [];
    lines.forEach(function (l, i) { var inF = inFence(pos); pos += l.length + 1; if (l.trim() && !inF && !NOTPARA.test(l)) elig.push(i); });
    if (!elig.length) { S.host.toast('ضع المؤشر داخل فقرة أو عنوان أو اقتباس', 'e'); return; }
    var all = elig.every(function (i) { return tokensOf(lines[i]).toks.indexOf(tok) > -1; });
    mapLines(function (ls) {
      return ls.map(function (l, i) {
        if (elig.indexOf(i) < 0) return l;
        var o = tokensOf(l), t = o.toks.filter(function (k) { return !group[k]; });
        if (!all) t.push(tok); else t = o.toks.filter(function (k) { return k !== tok; });
        return o.text + (t.length ? ' {' + t.join(' ') + '}' : '');
      });
    });
  }

  /* ---- blocks ---- */
  function wrapBlock(open, close, ph) {
    var L = selLines(), body = L.text.trim() ? L.text : ph, out = open + '\n' + body + '\n' + close;
    insertBlock(L.a, L.b, out, open.length + 1, body.length);
  }
  function callout(type) { wrapBlock(':::' + type, ':::', 'اكتب النص هنا'); }
  function detailsIns() { var L = selLines(), body = L.text.trim() ? L.text : 'المحتوى المخفي هنا', out = ':::details عنوان القسم\n' + body + '\n:::'; insertBlock(L.a, L.b, out, 11, 10); }
  function hrIns() { var p = S.ta.selectionStart, v = S.ta.value, a = lineEnd(v, p); insertBlock(a, a, '---', 3, 0); }
  function codeIns(o) {
    var L = selLines(), body = L.text.trim() ? L.text : (o.lang === 'html' || o.lang === 'xml' ? '<div>الكود هنا</div>' : '// الكود هنا'), fence = /```/.test(body) ? '````' : '```';
    var head = fence + o.lang + (o.file ? ' ' + o.file.replace(/[\n\r]/g, ' ') : '') + (o.nolines ? ' nolines' : ''), out = head + '\n' + body + '\n' + fence;
    insertBlock(L.a, L.b, out, head.length + 1, body.length);
  }
  function tableIns(r, c) {
    var hd = [], sp = [], rows = [], i, j, row;
    for (j = 1; j <= c; j++) { hd.push('عمود ' + nf(j)); sp.push('---'); }
    for (i = 0; i < r; i++) { row = []; for (j = 0; j < c; j++) row.push('  '); rows.push('| ' + row.join(' | ') + ' |'); }
    var out = '| ' + hd.join(' | ') + ' |\n| ' + sp.join(' | ') + ' |\n' + rows.join('\n'), L = selLines();
    insertBlock(L.a, L.b, out, 2, hd[0].length);
  }

  /* ====================================================== dialogs */
  function dialog(o) {
    return new Promise(function (resolve) {
      var ta = S.ta, ov = h('div', { class: 're-ov' }), form = h('form', { class: 're-dlg', role: 'dialog', 'aria-modal': 'true', 'aria-label': o.title, novalidate: true }), err = h('div', { class: 're-err', role: 'alert' }), els = {};
      form.appendChild(h('h4', { text: o.title }));
      (o.fields || []).forEach(function (f) {
        var inp, wrap = h('label', { class: 're-f' + (f.type === 'checkbox' ? ' re-fc' : '') });
        if (f.type === 'select') { inp = h('select', {}, f.options.map(function (op) { return h('option', { value: op[0], text: op[1] }); })); inp.value = f.value != null ? f.value : f.options[0][0]; }
        else if (f.type === 'checkbox') { inp = h('input', { type: 'checkbox' }); inp.checked = !!f.value; }
        else if (f.type === 'file') { inp = h('input', { type: 'file', accept: f.accept || 'image/*' }); if (f.preset) { try { inp.files = f.preset; } catch (x) { } } }
        else { inp = h('input', { type: f.type === 'number' ? 'number' : 'text', placeholder: f.ph || '', dir: f.dir || null, inputmode: f.type === 'url' ? 'url' : null, min: f.min, max: f.max, autocomplete: 'off' }); inp.value = f.value != null ? f.value : ''; }
        els[f.id] = inp;
        if (f.type === 'checkbox') { wrap.appendChild(inp); wrap.appendChild(h('span', { text: f.label })); } else { wrap.appendChild(h('span', { text: f.label })); wrap.appendChild(inp); }
        if (f.hint) wrap.appendChild(h('small', { text: f.hint }));
        form.appendChild(wrap);
      });
      form.appendChild(err);
      var ok = h('button', { type: 'submit', class: 'btn sm', text: o.ok || 'إدراج' }), cancel = h('button', { type: 'button', class: 'btn o sm', text: 'إلغاء' });
      form.appendChild(h('div', { class: 're-act' }, [ok, cancel])); ov.appendChild(form); document.body.appendChild(ov);
      var close = function (v) { document.removeEventListener('keydown', kd, true); ov.remove(); try { ta.focus(); ta.setSelectionRange(S.sel.s, S.sel.e); } catch (e) { } resolve(v); };
      var kd = function (e) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(null); } };
      document.addEventListener('keydown', kd, true);
      cancel.onclick = function () { close(null); };
      ov.addEventListener('mousedown', function (e) { if (e.target === ov) close(null); });
      form.onsubmit = function (e) {
        e.preventDefault(); err.textContent = '';
        var v = {}; Object.keys(els).forEach(function (k) { var i = els[k]; v[k] = i.type === 'checkbox' ? i.checked : i.type === 'file' ? (i.files && i.files[0]) : i.value.trim(); });
        var bad = o.validate && o.validate(v); if (bad) { err.textContent = bad; return; }
        if (!o.submit) return close(v);
        ok.disabled = true; var t0 = ok.textContent; ok.textContent = 'جارٍ التنفيذ…';
        Promise.resolve(o.submit(v)).then(function (r) { close(r); }, function (x) { ok.disabled = false; ok.textContent = t0; err.textContent = (x && x.message) || 'تعذّر التنفيذ'; });
      };
      var first = form.querySelector('input:not([type=file]),select'); setTimeout(function () { (first || ok).focus(); if (first && first.select) first.select(); }, 30);
    });
  }
  var normUrl = function (u) { u = String(u || '').trim(); if (!u) return ''; if (/^(?:https?:|mailto:|tel:|\/|#)/i.test(u)) return u; if (/^[\w-]+(\.[\w-]+)+(\/|$)/.test(u)) return 'https://' + u; return u; };

  function linkDlg() {
    var ta = S.ta, s = ta.selectionStart, e = ta.selectionEnd, sel = ta.value.slice(s, e), isU = /^https?:\/\/\S+$/.test(sel);
    dialog({ title: 'إدراج رابط', fields: [{ id: 'text', label: 'نص الرابط', value: isU ? '' : sel, ph: 'اكتب نص الرابط' }, { id: 'url', label: 'العنوان (URL)', value: isU ? sel : '', ph: 'https://', dir: 'ltr', type: 'url' }],
      validate: function (v) { v.url = normUrl(v.url); if (!Rich.safeUrl(v.url)) return 'أدخل رابطاً صالحاً (https://… أو mailto: أو tel:)'; } })
      .then(function (v) { if (!v) return; var t = (v.text || v.url.replace(/^https?:\/\/(?:www\.)?/, '')).replace(/[\[\]]/g, ''); rep(s, e, '[' + t + '](' + v.url.replace(/\s/g, '%20').replace(/\)/g, '%29') + ')'); });
  }
  function currentImageLine() {
    var v = S.ta.value, p = S.ta.selectionStart, a = lineStart(v, p), b = lineEnd(v, p), l = v.slice(a, b), m = l.match(/^!\[([^\]]*)\]\(\s*(\S+?)(?:\s+"([^"]*)")?\s*\)\s*(?:\{([^{}]*)\})?\s*$/);
    if (!m) return null; var at = (m[4] || '').split(/\s+/), size = '100', align = 'center';
    at.forEach(function (t) { var w = t.match(/^(?:w=|width=|size=)?(\d{2,3})%?$/); if (w) size = w[1]; if (/^(left|center|right)$/.test(t)) align = t; });
    return { a: a, b: b, alt: m[1], url: m[2], caption: m[3] === undefined ? m[1] : m[3], size: size, align: align };
  }
  function imageDlg(pre) {
    var cur = pre || currentImageLine(), ta = S.ta, host = S.host, s = ta.selectionStart, e = ta.selectionEnd;
    dialog({
      title: cur ? 'تعديل الصورة' : 'إدراج صورة', ok: cur ? 'تحديث' : 'إدراج',
      fields: [{ id: 'file', type: 'file', label: 'رفع صورة من جهازك', hint: 'يتم ضغطها تلقائياً قبل الرفع' }, { id: 'url', label: 'أو رابط الصورة', value: cur ? cur.url : '', ph: '/api/img/… أو https://', dir: 'ltr' },
        { id: 'alt', label: 'النص البديل (alt) — يصف الصورة لقارئات الشاشة ومحركات البحث', value: cur ? cur.alt : '' }, { id: 'caption', label: 'تعليق توضيحي يظهر تحت الصورة (اختياري)', value: cur ? cur.caption : '' },
        { id: 'size', type: 'select', label: 'حجم الصورة', value: cur ? cur.size : '100', options: [['100', 'عرض كامل'], ['75', '75%'], ['66', '66%'], ['50', '50%'], ['33', '33%'], ['25', '25%']] },
        { id: 'align', type: 'select', label: 'المحاذاة', value: cur ? cur.align : 'center', options: [['center', 'وسط'], ['right', 'يمين'], ['left', 'يسار']] }],
      validate: function (v) { if (!v.file && !isImg(v.url)) return 'ارفع صورة أو أدخل رابطاً يبدأ بـ https:// أو /api/img/'; },
      submit: function (v) {
        var go = function (url) { v.url = url; return v; };
        if (v.file) { if (!/^image\//.test(v.file.type)) throw new Error('اختر ملف صورة'); return host.upload(v.file).then(function (r) { if (!r) throw new Error('تعذّر رفع الصورة'); host.toast('تم رفع الصورة (' + host.fmtB(r.size) + ')', 's'); return go(r.url); }); }
        return go(v.url);
      }
    }).then(function (v) {
      if (!v) return;
      var at = []; if (+v.size < 100) at.push('w=' + v.size); if (v.align !== 'center' || at.length) at.push(v.align);
      var line = '![' + v.alt.replace(/[\[\]\n]/g, ' ') + '](' + v.url + ' "' + v.caption.replace(/"/g, '”').replace(/\n/g, ' ') + '")' + (at.length ? '{' + at.join(' ') + '}' : '');
      if (cur) rep(cur.a, cur.b, line); else insertBlock(s, e, line, line.length, 0);
      if (!v.alt) host.toast('نصيحة: أضف نصاً بديلاً (alt) لتحسين الوصول والسيو', '');
    });
  }
  var isImg = function (u) { return /^(?:https?:\/\/|\/api\/img\/|\/img\/)\S+$/i.test(u || ''); };
  function videoDlg() {
    var s = S.ta.selectionStart, e = S.ta.selectionEnd;
    dialog({ title: 'تضمين فيديو', fields: [{ id: 'url', label: 'رابط الفيديو (يوتيوب / فيمو / دايلي موشن / فيسبوك / ملف mp4)', ph: 'https://www.youtube.com/watch?v=…', dir: 'ltr' }],
      validate: function (v) { if (!/^https?:\/\//i.test(v.url)) return 'الرابط يجب أن يبدأ بـ https://'; if (!Rich.videoEmbed(v.url)) return 'هذا الرابط ليس من المنصات المدعومة (يوتيوب، فيمو، دايلي موشن، فيسبوك، أو ملف mp4/webm مباشر)'; } })
      .then(function (v) { if (v) insertBlock(s, e, '[video](' + v.url + ')', 0, 0); });
  }
  function cardDlg() {
    var s = S.ta.selectionStart, e = S.ta.selectionEnd, host = S.host;
    dialog({ title: 'بطاقة معاينة رابط', ok: 'جلب وإدراج', fields: [{ id: 'url', label: 'رابط الصفحة', ph: 'https://', dir: 'ltr', hint: 'يُجلب العنوان والوصف والصورة تلقائياً من الصفحة ويمكنك تعديلها لاحقاً في النص.' }],
      validate: function (v) { v.url = normUrl(v.url); if (!/^https?:\/\//i.test(v.url)) return 'أدخل رابطاً يبدأ بـ https://'; },
      submit: function (v) { return host.api('linkmeta?url=' + encodeURIComponent(v.url)).then(function (m) { return { url: v.url, meta: m || {} }; }); } })
      .then(function (r) {
        if (!r) return; var m = r.meta, clean = function (t) { return String(t || '').replace(/[|\n\r]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160); };
        var img = /^https?:\/\//i.test(m.image || '') ? m.image : '';
        insertBlock(s, e, '@card ' + r.url + ' | ' + clean(m.title) + ' | ' + clean(m.desc) + (img ? ' | ' + img : ''), 0, 0);
        if (!m.title) host.toast('تعذّر جلب بيانات الصفحة — أضف العنوان والوصف يدوياً بعد علامة |', '');
      });
  }
  function codeDlg() {
    dialog({ title: 'كتلة كود', fields: [{ id: 'lang', type: 'select', label: 'اللغة (لتمييز الصيغة)', value: 'js', options: Rich.LANG_LIST.map(function (l) { return [l, Rich.LABEL[l] || l]; }) }, { id: 'file', label: 'اسم الملف (اختياري)', ph: 'app.js', dir: 'ltr' }, { id: 'nolines', type: 'checkbox', label: 'إخفاء أرقام الأسطر' }] })
      .then(function (v) { if (v) codeIns({ lang: v.lang === 'text' ? '' : v.lang, file: v.file, nolines: v.nolines }); });
  }
  function tableDlg() {
    dialog({ title: 'إدراج جدول', fields: [{ id: 'r', type: 'number', label: 'عدد الصفوف', value: 3, min: 1, max: 30 }, { id: 'c', type: 'number', label: 'عدد الأعمدة', value: 3, min: 1, max: 10 }] })
      .then(function (v) { if (v) tableIns(Math.min(30, Math.max(1, +v.r || 3)), Math.min(10, Math.max(1, +v.c || 3))); });
  }
  var HELP = [['Ctrl+B', 'عريض'], ['Ctrl+I', 'مائل'], ['Ctrl+U', 'تسطير'], ['Ctrl+Shift+X', 'يتوسطه خط'], ['Ctrl+Alt+H', 'تمييز'], ['Ctrl+E', 'كود مضمّن'], ['Ctrl+K', 'رابط'], ['Ctrl+Alt+1…4', 'عنوان H1–H4'], ['Ctrl+Alt+0', 'فقرة عادية'],
    ['Ctrl+Alt+8 / 7 / 9', 'قائمة نقطية / مرقمة / مهام'], ['Tab / Shift+Tab', 'إزاحة عنصر القائمة'], ['Enter', 'متابعة القائمة تلقائياً (فارغ = إنهاء)'], ['Ctrl+Alt+Q', 'اقتباس'], ['Ctrl+Alt+C', 'كتلة كود'],
    ['Ctrl+Shift+R / E / L / J', 'محاذاة يمين / وسط / يسار / ضبط'], ['Ctrl+Alt+D', 'تبديل اتجاه الفقرة RTL ⇄ LTR'], ['Ctrl+Alt+P', 'تبديل المعاينة'], ['/', 'قائمة الأوامر بالشرطة المائلة'], ['Ctrl+S', 'حفظ'], ['Ctrl+/', 'هذه المساعدة']];
  function helpDlg() {
    var ov = h('div', { class: 're-ov' }), box = h('div', { class: 're-dlg re-help', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'اختصارات المحرر' });
    box.appendChild(h('h4', { text: 'اختصارات لوحة المفاتيح' }));
    var tb = h('div', { class: 're-kb' }); HELP.forEach(function (r) { tb.appendChild(h('kbd', { text: r[0], dir: 'ltr' })); tb.appendChild(h('span', { text: r[1] })); }); box.appendChild(tb);
    box.appendChild(h('h4', { text: 'صيغة الكتابة', style: 'margin-top:14px' }));
    box.appendChild(h('pre', { class: 're-cheat', dir: 'ltr', text: '# H1  ## H2  ### H3  #### H4   {#معرّف}\n- نقطة   1. مرقمة   - [ ] مهمة   (تداخل = مسافتان)\n> اقتباس    > [!pull|card|minimal]\n:::tip|info|warning|danger|note  عنوان\n:::details عنوان قابل للطي\n```js file.js nolines\n| عمود | عمود |  /  |--:|:-:|\n![alt](url "تعليق"){w=50 left}\n[video](url)   @card url | عنوان | وصف | صورة\n**غامق** *مائل* ++تسطير++ ~~شطب~~ ==تمييز==\n^أعلى^ ~أسفل~ `كود` [نص]{c=#e11d48 h=#fde68a}\nنهاية السطر: {center} {ltr} {justify} {p}' }));
    var x = h('button', { type: 'button', class: 'btn sm', text: 'تم' }); box.appendChild(h('div', { class: 're-act' }, [x])); ov.appendChild(box); document.body.appendChild(ov);
    var close = function () { document.removeEventListener('keydown', kd, true); ov.remove(); S.ta.focus(); };
    var kd = function (e) { if (e.key === 'Escape') { e.preventDefault(); close(); } }; document.addEventListener('keydown', kd, true);
    x.onclick = close; ov.addEventListener('mousedown', function (e) { if (e.target === ov) close(); }); x.focus();
  }


  /* ====================================================== استيراد من Word / PDF */
  function applyImport(r, mode, fill) {
    var ta = S.ta, host = S.host, body = r.body || '';
    if (mode === 'append' && ta.value.trim()) { var end = ta.value.length; rep(end, end, '\n\n' + body, end, end); }
    else { ta.focus(); rep(0, ta.value.length, body, 0, 0); ta.scrollTop = 0; }
    if (fill) { if (r.title && !(host.getFields().title || '').trim()) host.setField('title', r.title); if (r.desc && !(host.getFields().desc || '').trim()) host.setField('desc', r.desc); }
    S.dirty = true; status('dirty'); updateStats(); renderPreview(true); markDirty();
    host.toast('تم استيراد الملف (' + nf(Rich.stats(body).words) + ' كلمة)' + (r.images ? ' و' + nf(r.images) + ' صورة' : '') + ' — راجع النص ثم احفظ', 's');
    if (r.warnings && r.warnings.length) setTimeout(function () { host.toast(r.warnings[0], ''); }, 2800);
  }
  function importDlg(pre) {
    var host = S.host, has = !!S.ta.value.trim();
    dialog({
      title: 'استيراد مقال من ملف', ok: 'استيراد',
      fields: [{ id: 'file', type: 'file', preset: pre || null, accept: '.docx,.pdf,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document', label: 'اختر ملف Word (.docx) أو PDF', hint: 'Word أفضل: يحافظ على العناوين والألوان والقوائم والجداول والصور. PDF: يُستخرج النص والعناوين فقط.' },
        { id: 'mode', type: 'select', label: has ? 'المحتوى الحالي للمقال' : 'طريقة الإدراج', value: has ? 'replace' : 'replace', options: has ? [['replace', 'استبداله بمحتوى الملف'], ['append', 'إضافة محتوى الملف في النهاية']] : [['replace', 'وضع محتوى الملف كنص للمقال']] },
        { id: 'fill', type: 'checkbox', label: 'ملء العنوان والملخص من الملف إن كانا فارغين', value: true }],
      validate: function (v) { if (!v.file) return 'اختر ملفاً أولاً'; if (!/\.(docx|pdf)$/i.test(v.file.name) && !/pdf|wordprocessingml/.test(v.file.type)) return /\.doc$/i.test(v.file.name) ? 'صيغة .doc القديمة غير مدعومة — افتحه في Word واحفظه بصيغة .docx' : 'الملفات المدعومة: .docx و .pdf'; if (v.mode === 'replace' && has && !confirm('سيُستبدل نص المقال الحالي بمحتوى الملف (يمكنك التراجع بـ Ctrl+Z). هل تريد المتابعة؟')) return 'تم الإلغاء'; },
      submit: function (v) { var pdf = /\.pdf$/i.test(v.file.name) || v.file.type === 'application/pdf'; return (pdf ? host.importPdf(v.file) : host.importDocx(v.file)).then(function (r) { return { r: r, v: v }; }); }
    }).then(function (x) { if (x) applyImport(x.r, x.v.mode, x.v.fill); });
  }

  /* ====================================================== actions & toolbar */
  var A = {
    bold: function () { inl('**', '**', 'نص عريض'); }, italic: function () { inl('*', '*', 'نص مائل'); }, underline: function () { inl('++', '++', 'نص مسطّر'); }, strike: function () { inl('~~', '~~', 'نص مشطوب'); },
    mark: function () { inl('==', '==', 'نص مميَّز'); }, code: function () { inl('`', '`', 'code'); }, sup: function () { inl('^', '^', 'أعلى'); }, sub: function () { inl('~', '~', 'أسفل'); }, clear: clearFmt,
    heading: function (n) { heading(+n); }, ul: function () { listKind('ul'); }, ol: function () { listKind('ol'); }, task: function () { listKind('task'); }, quote: quote,
    indent: function () { indent(1); }, outdent: function () { indent(-1); },
    alignR: function () { setTok('right', AL); }, alignC: function () { setTok('center', AL); }, alignL: function () { setTok('left', AL); }, alignJ: function () { setTok('justify', AL); },
    rtl: function () { setTok('rtl', DR); }, ltr: function () { setTok('ltr', DR); },
    link: linkDlg, import: function () { importDlg(); }, image: function () { imageDlg(); }, video: videoDlg, card: cardDlg, table: tableDlg, codeblock: codeDlg, callout: callout, details: detailsIns, hr: hrIns, help: helpDlg,
    view: function (v) { setView(v); }
  };
  var TB = [
    [['bold', '<b>B</b>', 'عريض (Ctrl+B)'], ['italic', '<i>I</i>', 'مائل (Ctrl+I)'], ['underline', '<u>U</u>', 'تسطير (Ctrl+U)'], ['strike', '<s>S</s>', 'يتوسطه خط (Ctrl+Shift+X)'], ['mark', '<span class="re-mk">ت</span>', 'تمييز (Ctrl+Alt+H)'], ['code', '&lt;/&gt;', 'كود مضمّن (Ctrl+E)'], ['sup', 'x<sup>2</sup>', 'أعلى السطر'], ['sub', 'x<sub>2</sub>', 'أسفل السطر'],
      ['@pal:c', 'A', 'لون النص المحدد'], ['@pal:h', '▮', 'لون خلفية (تمييز) النص المحدد'], ['clear', ico('clear'), 'مسح تنسيق النص']],
    [['@sel:heading', [['', 'العنوان ▾'], ['1', 'عنوان 1 — H1'], ['2', 'عنوان 2 — H2'], ['3', 'عنوان 3 — H3'], ['4', 'عنوان 4 — H4'], ['0', 'فقرة عادية']], 'نمط الفقرة'], ['alignR', ico('alignR'), 'محاذاة لليمين (Ctrl+Shift+R)'], ['alignC', ico('alignC'), 'توسيط (Ctrl+Shift+E)'], ['alignL', ico('alignL'), 'محاذاة لليسار (Ctrl+Shift+L)'], ['alignJ', ico('alignJ'), 'ضبط (Ctrl+Shift+J)'], ['rtl', '<span class="re-d">RTL</span>', 'اتجاه الفقرة من اليمين لليسار'], ['ltr', '<span class="re-d">LTR</span>', 'اتجاه الفقرة من اليسار لليمين (Ctrl+Alt+D)']],
    [['ul', ico('ul'), 'قائمة نقطية (Ctrl+Alt+8)'], ['ol', ico('ol'), 'قائمة مرقمة (Ctrl+Alt+7)'], ['task', ico('task'), 'قائمة مهام (Ctrl+Alt+9)'], ['outdent', ico('outdent'), 'تقليل الإزاحة (Shift+Tab)'], ['indent', ico('indent'), 'زيادة الإزاحة / تداخل (Tab)'], ['@sel:quote', [['', '❝ اقتباس ▾'], ['classic', 'اقتباس كلاسيكي'], ['card', 'اقتباس بطاقة'], ['pull', 'اقتباس بارز'], ['minimal', 'اقتباس بسيط']], 'اقتباس بأنماط (Ctrl+Alt+Q)']],
    [['link', ico('link'), 'رابط (Ctrl+K)'], ['image', ico('image'), 'صورة'], ['video', ico('video'), 'فيديو'], ['card', ico('card'), 'بطاقة معاينة رابط'], ['table', ico('table'), 'جدول'], ['codeblock', ico('code'), 'كتلة كود (Ctrl+Alt+C)'],
      ['@sel:callout', [['', 'ⓘ تنبيه ▾'], ['info', 'معلومة'], ['tip', 'نصيحة'], ['warning', 'تحذير'], ['danger', 'خطر'], ['note', 'ملاحظة']], 'صندوق تنبيه'], ['details', ico('details'), 'قسم قابل للطي'], ['hr', ico('hr'), 'فاصل أفقي'], ['import', ico('upload'), 'استيراد مقال من ملف Word أو PDF']],
    [['@views'], ['help', ico('help'), 'الاختصارات (Ctrl+/)']]
  ];
  function buildToolbar(tb) {
    tb.className = 're-tb'; tb.setAttribute('role', 'toolbar'); tb.setAttribute('aria-label', 'أدوات تنسيق المقال'); tb.innerHTML = '';
    TB.forEach(function (g) {
      var grp = h('div', { class: 're-g', role: 'group' });
      g.forEach(function (it) {
        var id = it[0], e;
        if (id === '@views') {
          [['write', 'كتابة'], ['split', 'مقسوم'], ['prev', 'معاينة']].forEach(function (v) { grp.appendChild(h('button', { type: 'button', class: 're-b re-vb', 'data-view': v[0], 'aria-pressed': v[0] === S.view ? 'true' : 'false', text: v[1], title: 'وضع العرض: ' + v[1] })); });
          return;
        }
        if (id.indexOf('@sel:') === 0) {
          e = h('select', { class: 're-sel', 'data-a': id.slice(5), 'aria-label': it[2], title: it[2] }, it[1].map(function (o) { return h('option', { value: o[0], text: o[1] }); })); grp.appendChild(e); return;
        }
        if (id.indexOf('@pal:') === 0) {
          var kind = id.slice(5);
          grp.appendChild(h('button', { type: 'button', class: 're-b re-colb', 'data-pal': kind, title: it[2], 'aria-label': it[2], 'aria-haspopup': 'dialog' }, [h('span', { class: 're-cl', text: it[1], style: 'border-color:' + (kind === 'c' ? '#e11d48' : '#fde68a') })])); return;
        }
        grp.appendChild(h('button', { type: 'button', class: 're-b', 'data-a': id, title: it[2], 'aria-label': it[2].replace(/\s*\(.*\)$/, ''), html: it[1] }));
      });
      tb.appendChild(grp);
    });
  }

  /* ====================================================== slash menu */
  var SL = [
    ['عنوان 1 (H1)', 'h1 heading title عنوان', 'heading', '1', '#'], ['عنوان 2 (H2)', 'h2 heading عنوان', 'heading', '2', '##'], ['عنوان 3 (H3)', 'h3 heading عنوان', 'heading', '3', '###'], ['عنوان 4 (H4)', 'h4 heading عنوان', 'heading', '4', '####'],
    ['قائمة نقطية', 'ul bullet list قائمة نقاط', 'ul', null, '•'], ['قائمة مرقمة', 'ol number ordered list قائمة ترقيم', 'ol', null, '1.'], ['قائمة مهام', 'task todo check checklist مهام تحقق', 'task', null, '☑'],
    ['اقتباس', 'quote blockquote اقتباس', 'quote', 'classic', '❝'], ['اقتباس بارز', 'pull quote اقتباس بارز', 'quote', 'pull', '❝'], ['اقتباس بطاقة', 'card quote اقتباس', 'quote', 'card', '❝'],
    ['معلومة', 'info callout تنبيه معلومة', 'callout', 'info', 'ⓘ'], ['نصيحة', 'tip callout تنبيه نصيحة', 'callout', 'tip', '💡'], ['تحذير', 'warning callout تنبيه تحذير', 'callout', 'warning', '⚠'], ['خطر', 'danger callout تنبيه خطر', 'callout', 'danger', '⛔'], ['ملاحظة', 'note callout تنبيه ملاحظة', 'callout', 'note', '✎'],
    ['كتلة كود', 'code block كود برمجة', 'codeblock', null, '</>'], ['جدول', 'table جدول', 'table', null, '▦'], ['صورة', 'image img صورة', 'image', null, '🖼'], ['فيديو', 'video youtube فيديو يوتيوب', 'video', null, '▶'], ['بطاقة رابط', 'card link preview بطاقة رابط معاينة', 'card', null, '🔗'],
    ['فاصل أفقي', 'hr divider فاصل خط', 'hr', null, '—'], ['قسم قابل للطي', 'details accordion toggle طي أكورديون', 'details', null, '▸'],
    ['استيراد من Word/PDF', 'import word pdf docx استيراد ملف ورد', 'import', null, '⇪'], ['توسيط', 'center align توسيط وسط', 'alignC', null, '≡'], ['اتجاه LTR', 'ltr english اتجاه انجليزي', 'ltr', null, 'Aa']
  ];
  function slashCtx() {
    var ta = S.ta; if (ta.selectionStart !== ta.selectionEnd) return null;
    var p = ta.selectionStart, v = ta.value, a = lineStart(v, p), seg = v.slice(a, p), m = seg.match(/(^|\s)\/([^\s\/]{0,14})$/);
    if (!m || inFence(p)) return null;
    return { from: p - m[2].length - 1, to: p, q: m[2].toLowerCase() };
  }
  function slashUpdate() {
    var c = slashCtx(); if (!c) return slashClose();
    var items = SL.filter(function (it) { return !c.q || (it[0] + ' ' + it[1]).toLowerCase().indexOf(c.q) > -1; });
    if (!items.length) return slashClose();
    var m = S.slash; if (!m) { m = S.slash = { el: h('div', { class: 're-slash', role: 'listbox', 'aria-label': 'أوامر التنسيق' }), idx: 0 }; document.body.appendChild(m.el); }
    m.c = c; m.items = items; if (m.idx >= items.length) m.idx = 0;
    m.el.innerHTML = ''; items.forEach(function (it, i) {
      var b = h('button', { type: 'button', role: 'option', class: 're-si' + (i === m.idx ? ' on' : ''), 'aria-selected': i === m.idx ? 'true' : 'false' }, [h('span', { class: 're-sg', text: it[4] }), h('span', { text: it[0] })]);
      b.onmousedown = function (e) { e.preventDefault(); slashRun(i); }; m.el.appendChild(b);
    });
    var r = caretXY(S.ta, c.to), vw = innerWidth, vh = innerHeight, w = m.el.offsetWidth || 240, hgt = Math.min(m.el.scrollHeight, 280), rtl = getComputedStyle(S.ta).direction === 'rtl';
    var left = rtl ? r.x - w + 24 : r.x; left = Math.max(8, Math.min(left, vw - w - 8));
    var top = r.y + r.h + 6; if (top + hgt > vh - 8) top = Math.max(8, r.y - hgt - 6);
    m.el.style.left = left + 'px'; m.el.style.top = top + 'px';
    var on = m.el.querySelector('.on'); if (on) on.scrollIntoView({ block: 'nearest' });
  }
  function slashClose() { if (S.slash) { S.slash.el.remove(); S.slash = null; } }
  function slashRun(i) {
    var m = S.slash; if (!m) return; var it = m.items[i], c = m.c; slashClose();
    rep(c.from, c.to, '', c.from, c.from);
    A[it[2]](it[3]);
  }
  function caretXY(ta, pos) {
    var d = document.createElement('div'), cs = getComputedStyle(ta), sp = document.createElement('span');
    ['direction', 'boxSizing', 'width', 'overflowX', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'fontStyle', 'fontWeight', 'fontSize', 'fontFamily', 'lineHeight', 'textAlign', 'letterSpacing', 'tabSize'].forEach(function (p) { d.style[p] = cs[p]; });
    d.style.cssText += ';position:absolute;visibility:hidden;white-space:pre-wrap;word-wrap:break-word;top:0;left:-9999px;height:auto;overflow:hidden';
    d.textContent = ta.value.slice(0, pos); sp.textContent = '​'; d.appendChild(sp); document.body.appendChild(d);
    var r = ta.getBoundingClientRect(), lh = parseFloat(cs.lineHeight) || 24;
    var out = { x: r.left + parseFloat(cs.borderLeftWidth) + sp.offsetLeft - ta.scrollLeft, y: r.top + parseFloat(cs.borderTopWidth) + sp.offsetTop - ta.scrollTop, h: lh };
    d.remove(); return out;
  }

  /* ====================================================== keyboard */
  var LI_RE = /^([ \t]*)([-•*]|\d{1,4}[.)]|[٠-٩]{1,4}[.)])([ \t]+)(\[[ xX]\][ \t]+)?([\s\S]*)$/;
  function onEnter(e) {
    var ta = S.ta, v = ta.value, p = ta.selectionStart; if (ta.selectionEnd !== p || inFence(p)) return false;
    var a = lineStart(v, p), b = lineEnd(v, p), line = v.slice(a, b), m = line.match(LI_RE), q = !m && line.match(/^(\s*>[ \t]?)([\s\S]*)$/);
    if (m) {
      var markEnd = a + m[1].length + m[2].length + m[3].length + (m[4] ? m[4].length : 0); if (p < markEnd) return false;
      if (!m[5].trim() && p === b) { e.preventDefault(); if (m[1].length) { rep(a, b, m[1].replace(/^(?: {1,2}|\t)/, '')); } else rep(a, b, ''); return true; }
      var mk = m[2], ar = /[٠-٩]/.test(mk), next = mk;
      if (/\d|[٠-٩]/.test(mk.charAt(0))) { var num = parseInt(mk.replace(/[٠-٩]/g, function (d) { return d.charCodeAt(0) - 1632; }), 10) + 1, s = String(num); if (ar) s = s.replace(/\d/g, function (d) { return String.fromCharCode(1632 + +d); }); next = s + mk.slice(-1); }
      e.preventDefault(); rep(p, p, '\n' + m[1] + next + m[3] + (m[4] ? '[ ] ' : '')); return true;
    }
    if (q) {
      if (p < a + q[1].length) return false;
      if (!q[2].trim() && p === b) { e.preventDefault(); rep(a, b, ''); return true; }
      e.preventDefault(); rep(p, p, '\n' + q[1]); return true;
    }
    return false;
  }
  function onTab(e) {
    var ta = S.ta, v = ta.value, s = ta.selectionStart, en = ta.selectionEnd, a = lineStart(v, s), b = lineEnd(v, en), seg = v.slice(a, b);
    var isList = seg.split('\n').some(function (l) { return LI_RE.test(l); });
    if (!isList || inFence(s)) return false;
    e.preventDefault(); if (e.shiftKey) indent(-1); else indent(1); return true;
  }
  var KEYS = {
    ctrl: { KeyB: 'bold', KeyI: 'italic', KeyU: 'underline', KeyE: 'code', KeyK: 'link', Slash: 'help' },
    ctrlShift: { KeyX: 'strike', KeyR: 'alignR', KeyE: 'alignC', KeyL: 'alignL', KeyJ: 'alignJ' },
    ctrlAlt: { KeyH: 'mark', Digit1: ['heading', 1], Digit2: ['heading', 2], Digit3: ['heading', 3], Digit4: ['heading', 4], Digit0: ['heading', 0], Digit8: 'ul', Digit7: 'ol', Digit9: 'task', KeyQ: ['quote', 'classic'], KeyC: 'codeblock', KeyD: 'dirToggle', KeyP: 'viewToggle' }
  };
  function onKey(e) {
    if (e.isComposing || !S.enabled) return;
    var m = S.slash;
    if (m) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); m.idx = (m.idx + (e.key === 'ArrowDown' ? 1 : -1) + m.items.length) % m.items.length; slashUpdate(); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); slashRun(m.idx); return; }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); slashClose(); return; }
    }
    var ctrl = e.ctrlKey || e.metaKey, code = e.code, k;
    if (!ctrl && !e.altKey && !e.shiftKey && !e.metaKey) {
      if (e.key === 'Enter' && onEnter(e)) return; if (e.key === 'Tab' && onTab(e)) return;
    }
    if (e.key === 'Tab' && e.shiftKey && !ctrl && !e.altKey) { if (onTab(e)) return; }
    if (!ctrl) return;
    k = e.altKey ? KEYS.ctrlAlt[code] : e.shiftKey ? KEYS.ctrlShift[code] : KEYS.ctrl[code];
    if (!k) return;
    e.preventDefault();
    if (k === 'dirToggle') { var cur = tokensOf(selLines().text.split('\n')[0] || '').toks; return A[cur.indexOf('ltr') > -1 ? 'rtl' : 'ltr'](); }
    if (k === 'viewToggle') return setView(S.view === 'write' ? 'split' : 'write');
    if (Array.isArray(k)) A[k[0]](k[1]); else A[k]();
  }

  /* ====================================================== preview (3 devices) */
  var DEV = { mobile: 390, tablet: 768, desktop: 1100 };
  function frameHtml() {
    var th = document.documentElement.dataset.theme || 'dark';
    return '<!doctype html><html lang="ar" dir="rtl" data-theme="' + th + '"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'none\'; img-src \'self\' https: data:; media-src \'self\' https:; style-src \'self\' \'unsafe-inline\' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; frame-src https://www.youtube-nocookie.com https://player.vimeo.com https://www.dailymotion.com https://www.facebook.com">' +
      '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&family=El+Messiri:wght@500;600;700&display=swap"><link rel="stylesheet" href="/css/rich.css">' +
      '<style>:root{--p:#2b7bd0;--p2:#4aa8ee;--serif:\'El Messiri\',\'IBM Plex Sans Arabic\',serif;--hh:0px}[data-theme=light]{color-scheme:light;--bg:#f2f7fd;--card:#fff;--tx:#0f2236;--mu:#566b82;--bd:#dfe9f5;--sh:0 10px 40px #0f2a4a14;--pt:#2b7bd0;--sk1:#e6eef9}' +
      '[data-theme=dark]{color-scheme:dark;--bg:#08121f;--card:#11233a;--tx:#eaf2fc;--mu:#9db3cc;--bd:#223a58;--sh:0 10px 40px #0007;--pt:#7cc4ff;--sk1:#142c47}' +
      '*,*::before,*::after{box-sizing:border-box}*{margin:0}img,video,iframe{max-width:100%}html{scroll-behavior:smooth;-webkit-text-size-adjust:100%}body{background:var(--bg);color:var(--tx);font-family:\'IBM Plex Sans Arabic\',Tahoma,sans-serif;line-height:1.85;padding:20px 16px 60px;overflow-x:auto}' +
      '#w{max-width:44rem;margin:auto;min-width:0}#t{font-family:var(--serif);font-size:clamp(1.6rem,1.2rem + 1.6vw,2.2rem);line-height:1.4;margin:0 0 14px}.e{color:var(--mu);text-align:center;padding:40px 0}a{cursor:pointer}</style></head>' +
      '<body><div id="w"><h1 id="t"></h1><article class="rich" id="c"></article></div></body></html>';
  }
  function ensureFrame() {
    var fr = S.frame; if (fr && fr.contentDocument && fr.contentDocument.getElementById('c')) return fr;
    fr = $('#refr'); if (!fr) return null; S.frame = fr; fr.srcdoc = frameHtml();
    fr.addEventListener('load', function () {
      var d = fr.contentDocument; if (!d) return;
      d.addEventListener('click', function (e) { var a = e.target.closest && e.target.closest('a[href^="#"]'); if (a) { e.preventDefault(); var t = d.getElementById(decodeURIComponent(a.getAttribute('href').slice(1))); if (t) t.scrollIntoView({ behavior: 'smooth' }); } });
      renderPreview(true);
    });
    return null;
  }
  function renderPreview(now) {
    if (S.view === 'write') return;
    clearTimeout(S.timers.pv);
    var go = function () {
      var fr = ensureFrame(); if (!fr) return; var d = fr.contentDocument, c = d && d.getElementById('c'); if (!c) return;
      var f = S.host.getFields(), r = Rich.render(S.ta.value), sc = d.scrollingElement ? d.scrollingElement.scrollTop : 0;
      d.getElementById('t').textContent = f.title || '';
      c.innerHTML = r.html || '<div class="e">لا يوجد نص بعد — ابدأ الكتابة لترى المعاينة هنا</div>';
      if (d.scrollingElement) d.scrollingElement.scrollTop = sc;
    };
    if (now) go(); else S.timers.pv = setTimeout(go, 180);
  }
  function layoutFrame() {
    var fw = $('.re-fw'), fs = $('.re-fs'); if (!fw || !fs || S.view === 'write') return;
    /* السبب الجذري لقطع المعاينة على الهاتف: الإطار بعرض ثابت (390) داخل حاوية RTL أضيق منه، فيفيض نحو اليسار
       ثم يُصغَّر بـ transform من «top center» فينزاح عن الحاوية ويُقصّ. الحل: حاوية LTR نسبية + تموضع مطلق + أصل التحويل 0 0 */
    var W = DEV[S.device], avail = Math.max(200, fw.clientWidth - 2), k = Math.min(1, avail / W), hh = Math.max(380, Math.min(innerHeight * 0.7, 760));
    if (S.device === 'mobile' && avail < W) { W = avail; k = 1; } // على الهاتف نعرض بعرض الشاشة الفعلي بدل تصغير غير مقروء
    fw.style.position = 'relative'; fw.style.direction = 'ltr';
    fs.style.position = 'absolute'; fs.style.top = '0'; fs.style.left = Math.max(0, (avail + 2 - W * k) / 2) + 'px'; fs.style.margin = '0';
    fs.style.width = (W + 2) + 'px'; fs.style.height = hh / k + 'px'; fs.style.transform = k < 1 ? 'scale(' + k + ')' : 'none'; fs.style.transformOrigin = '0 0';
    fw.style.height = hh + 2 + 'px'; var lb = $('.re-wl'); if (lb) lb.textContent = nf(Math.round(W)) + ' بكسل' + (k < 1 ? ' (مُصغَّر ' + nf(Math.round(k * 100)) + '٪)' : '');
  }
  function setView(v) {
    S.view = v; var re = $('#re'); if (!re) return;
    re.classList.remove('re-v-write', 're-v-split', 're-v-prev'); re.classList.add('re-v-' + (v === 'prev' ? 'prev' : v));
    Array.prototype.forEach.call(re.querySelectorAll('.re-vb'), function (b) { b.setAttribute('aria-pressed', b.dataset.view === v ? 'true' : 'false'); });
    var pv = $('#repv'); pv.hidden = v === 'write'; S.ta.hidden = v === 'prev';
    if (v !== 'write') { ensureFrame(); renderPreview(true); setTimeout(layoutFrame, 0); }
    if (v !== 'prev') S.ta.focus();
    try { localStorage.reView = v; } catch (e) { }
  }
  function setDevice(d) {
    S.device = d; Array.prototype.forEach.call(document.querySelectorAll('.re-dev button'), function (b) { b.setAttribute('aria-pressed', b.dataset.d === d ? 'true' : 'false'); });
    layoutFrame(); try { localStorage.reDev = d; } catch (e) { }
  }

  /* ====================================================== stats + autosave */
  function updateStats() {
    var t = Rich.stats(S.ta.value), el = $('#wc'); if (!el) return;
    el.textContent = t.words ? nf(t.words) + ' كلمة · ' + nf(t.chars) + ' حرف · وقت القراءة ≈ ' + nf(t.minutes) + ' د' : 'لا يوجد نص بعد';
  }
  var hhmm = function (t) { try { return new Date(t).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; } };
  function status(kind, t) {
    var el = $('#asv'); if (!el) return;
    var M = { clean: ['', ''], dirty: ['● تغييرات غير محفوظة', 'warn'], saving: ['جارٍ الحفظ…', ''], local: ['✓ حُفظت مسودة تلقائياً على هذا الجهاز ' + hhmm(t), 'ok'], server: ['✓ حُفظت المسودة على الخادم ' + hhmm(t), 'ok'], saved: ['✓ تم الحفظ', 'ok'], err: ['⚠ تعذّر الحفظ التلقائي', 'bad'], restored: ['↺ تمت استعادة نسخة غير محفوظة', 'warn'] }[kind] || ['', ''];
    el.textContent = M[0]; el.className = 're-asv ' + M[1];
  }
  var draftKey = function () { var id = S.host.editingId(); return id ? 'dr:' + id : 'dr'; };
  function saveLocal() {
    var f = S.host.getFields(); if (f.type !== 'article' || (!f.title.trim() && !f.body.trim())) return;
    try { localStorage.setItem(draftKey(), JSON.stringify({ title: f.title, slug: f.slug, desc: f.desc, body: f.body, image: f.image, t: Date.now() })); S.lastLocal = Date.now(); if (S.dirty) status('local', S.lastLocal); } catch (e) { status('err'); }
  }
  function saveServer() {
    var id = S.host.editingId(), f = S.host.getFields(); if (!id || !f.draft || f.type !== 'article' || !f.title.trim() || !S.dirty || S.saving) return;
    S.saving = true; status('saving');
    var d = { title: f.title.trim(), desc: f.desc, body: f.body };
    Promise.resolve(S.host.api('items?id=' + encodeURIComponent(id), 'PUT', d)).then(function (r) {
      S.saving = false; if (r) { S.lastServer = Date.now(); S.host.onServerSaved(id, d); if (S.host.getFields().body === d.body) { S.dirty = false; try { localStorage.removeItem('dr:' + id); } catch (e) { } } status('server', S.lastServer); } else status('err');
    });
  }
  function markDirty() {
    S.dirty = true; status('dirty');
    clearTimeout(S.timers.l); S.timers.l = setTimeout(saveLocal, 1000);
    clearTimeout(S.timers.s); var f = S.host.getFields(); if (S.host.editingId() && f.draft) S.timers.s = setTimeout(saveServer, 12000);
  }

  /* ====================================================== paste / drop / events */
  function uploadInsert(file) {
    var host = S.host, s = S.ta.selectionStart, e = S.ta.selectionEnd; host.toast('جارٍ رفع الصورة…');
    host.upload(file).then(function (r) { if (r) { insertBlock(s, e, '![](' + r.url + ' "")', 0, 0); host.toast('تمت إضافة الصورة (' + host.fmtB(r.size) + ') — أضف نصاً بديلاً عبر زر الصورة', 's'); } }, function (x) { host.toast((x && x.message) || 'تعذّر رفع الصورة', 'e'); });
  }
  function bind() {
    var ta = S.ta, tb = $('#etb');
    tb.addEventListener('pointerdown', function (e) { if (!e.target.closest('select,input,label')) e.preventDefault(); });
    tb.addEventListener('mousedown', function (e) { if (!e.target.closest('select,input,label')) e.preventDefault(); });
    tb.addEventListener('click', function (e) {
      var vb = e.target.closest('[data-view]'); if (vb) return setView(vb.dataset.view);
      var pb = e.target.closest('[data-pal]'); if (pb) { restoreSel(); return openPal(pb.dataset.pal, pb); }
      var b = e.target.closest('button[data-a]'); if (!b) return; restoreSel(); A[b.dataset.a](); saveSel();
    });
    tb.addEventListener('change', function (e) {
      var t = e.target;
      if (t.tagName === 'SELECT') { var v = t.value; t.value = ''; if (v === '') return; restoreSel(); A[t.dataset.a](v); saveSel(); }
    });
    ['select', 'keyup', 'mouseup', 'touchend', 'blur', 'focus'].forEach(function (ev) { ta.addEventListener(ev, saveSel); });
    ta.addEventListener('keydown', onKey);
    ta.addEventListener('input', function (e) {
      if (!S.enabled) return; saveSel(); clearTimeout(S.timers.st); S.timers.st = setTimeout(updateStats, 150); markDirty(); renderPreview(); if (!e.isComposing) slashUpdate();
    });
    ta.addEventListener('click', function () { if (S.slash) slashUpdate(); });
    ta.addEventListener('blur', function () { setTimeout(slashClose, 120); });
    ta.addEventListener('scroll', function () { if (S.slash) slashClose(); });
    ta.addEventListener('paste', function (e) {
      var cd = e.clipboardData; if (!cd || !S.enabled) return;
      var f = Array.prototype.slice.call(cd.files || []).filter(function (x) { return /^image\//.test(x.type); })[0];
      if (f) { e.preventDefault(); return uploadInsert(f); }
      var t = (cd.getData('text/plain') || '').trim();
      if (/^https?:\/\/\S+$/.test(t) && ta.selectionStart !== ta.selectionEnd && ta.value.slice(ta.selectionStart, ta.selectionEnd).indexOf('\n') < 0) { e.preventDefault(); var s = ta.selectionStart, en = ta.selectionEnd; rep(s, en, '[' + ta.value.slice(s, en) + '](' + t + ')'); }
    });
    ta.addEventListener('dragover', function (e) { var t = e.dataTransfer && e.dataTransfer.types; if (t && Array.prototype.indexOf.call(t, 'Files') > -1) e.preventDefault(); });
    ta.addEventListener('drop', function (e) { var f = e.dataTransfer && Array.prototype.slice.call(e.dataTransfer.files).filter(function (x) { return /^image\//.test(x.type); })[0]; if (f && S.enabled) { e.preventDefault(); uploadInsert(f); return; }
      var d = e.dataTransfer && Array.prototype.slice.call(e.dataTransfer.files).filter(function (x) { return /\.(docx|pdf)$/i.test(x.name); })[0];
      if (d && S.enabled) { e.preventDefault(); var dt = new DataTransfer(); dt.items.add(d); importDlg(dt.files); } });
    ['title', 'desc', 'draft'].forEach(function (id) { var el = document.getElementById(id); if (el) el.addEventListener(id === 'draft' ? 'change' : 'input', function () { if (S.enabled) { markDirty(); renderPreview(); } }); });
    var dv = $('.re-dev'); dv.addEventListener('click', function (e) { var b = e.target.closest('button[data-d]'); if (b) setDevice(b.dataset.d); });
    addEventListener('resize', function () { layoutFrame(); slashClose(); });
    if (window.ResizeObserver) new ResizeObserver(function () { layoutFrame(); var re = $('#re'); if (re) re.classList.toggle('re-wide', re.clientWidth >= 880); }).observe($('#re'));
    new MutationObserver(function () { var d = S.frame && S.frame.contentDocument; if (d) d.documentElement.dataset.theme = document.documentElement.dataset.theme; }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    addEventListener('beforeunload', function () { if (S.dirty && S.enabled) saveLocal(); });
  }

  /* ====================================================== public API */
  function init(host) {
    if (!Rich) { console.error('rich.js missing'); return; }
    S.host = host; S.ta = host.ta; S.ta.setAttribute('spellcheck', 'true'); S.ta.setAttribute('aria-describedby', 'wc');
    var re = $('#re'), tb = $('#etb'); buildToolbar(tb);
    var pv = h('div', { class: 're-pv', id: 'repv', hidden: true }, [
      h('div', { class: 're-pvh' }, [h('div', { class: 're-dev', role: 'group', 'aria-label': 'حجم المعاينة' }, [['mobile', '📱 موبايل'], ['tablet', 'تابلت'], ['desktop', '🖥 ديسكتوب']].map(function (d) { return h('button', { type: 'button', 'data-d': d[0], 'aria-pressed': 'false', text: d[1] }); })), h('span', { class: 're-wl' })]),
      h('div', { class: 're-fw' }, [h('div', { class: 're-fs' }, [h('iframe', { id: 'refr', title: 'معاينة مباشرة للمقال' })])])]);
    $('#remain').appendChild(pv);
    var sv, sd; try { sv = localStorage.reView; sd = localStorage.reDev; } catch (e) { }
    S.device = DEV[sd] ? sd : 'desktop'; bind(); setDevice(S.device); setView(sv === 'split' || sv === 'prev' ? sv : 'write');
    re.classList.toggle('re-wide', re.clientWidth >= 880); updateStats(); status('clean');
  }
  function setEnabled(on) { S.enabled = !!on; var re = $('#re'); if (re) re.classList.toggle('re-off', !on); if (!on) { slashClose(); } }
  function refresh() { if (!S.ta) return; updateStats(); renderPreview(true); layoutFrame(); }
  /** يُستدعى بعد تحميل عنصر للتعديل: يعرض نسخة محلية أحدث إن وُجدت */
  function loaded(item) {
    S.dirty = false; status('clean'); refresh();
    try {
      var d = JSON.parse(localStorage.getItem('dr:' + item._id) || 'null'); if (!d) return;
      var newer = d.t && (!item.updatedAt || d.t > new Date(item.updatedAt).getTime() + 2000), diff = d.body !== (item.body || '') || d.title !== (item.title || '') || d.desc !== (item.desc || '');
      if (newer && diff && confirm('وُجدت نسخة محلية أحدث غير محفوظة من هذا المقال (' + hhmm(d.t) + '). هل تريد استعادتها؟')) { S.host.setFields(d); S.dirty = true; status('restored'); refresh(); }
      else localStorage.removeItem('dr:' + item._id);
    } catch (e) { }
  }
  /** بعد حفظ ناجح (نشر/تعديل) */
  function saved(id) { clearTimeout(S.timers.l); clearTimeout(S.timers.s); S.dirty = false; try { localStorage.removeItem('dr'); if (id) localStorage.removeItem('dr:' + id); } catch (e) { } status('saved'); }
  function reset() { clearTimeout(S.timers.l); clearTimeout(S.timers.s); S.dirty = false; status('clean'); slashClose(); refresh(); }

  window.RichEd = { init: init, refresh: refresh, setEnabled: setEnabled, loaded: loaded, saved: saved, reset: reset, isDirty: function () { return S.dirty; }, markDirty: markDirty };
})();
