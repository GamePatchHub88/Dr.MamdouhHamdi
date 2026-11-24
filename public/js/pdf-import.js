/*!
 * pdf-import.js — استخراج نص PDF وتحويله إلى نص مقال (في المتصفح)
 * يحمّل pdf.js من cdnjs عند أول استخدام فقط (لا يؤثر على سرعة بقية اللوحة).
 * fromPages() دالة نقية قابلة للاختبار: تستقبل عناصر النص وتُرجع {title,desc,body,warnings}.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.PdfImport = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var PDFJS = '3.11.174', BASE = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/' + PDFJS + '/';
  var escMd = function (t) { return t.replace(/([\\`*_\[\]{}|~^])/g, '\\$1').replace(/==/g, '\\=\\=').replace(/\+\+/g, '\\+\\+').replace(/</g, '&lt;'); };
  var END = /[.،,؛:!؟?…"”»)]$/, SENT = /[.!؟?…:]$/;

  function lines(page) {
    var its = page.items.filter(function (i) { return i.str && i.str.trim(); }).sort(function (a, b) { return b.y - a.y; }), out = [], cur = null, i, it;
    for (i = 0; i < its.length; i++) {
      it = its[i];
      if (cur && Math.abs(it.y - cur.y) <= Math.max(2, 0.45 * Math.min(it.h, cur.items[0].h))) cur.items.push(it);
      else { cur = { y: it.y, items: [it] }; out.push(cur); }
    }
    return out.map(function (l) {
      var rtl = l.items.filter(function (x) { return x.dir === 'rtl' || /[\u0600-\u06FF]/.test(x.str); }).length * 2 >= l.items.length;
      var s = l.items.slice().sort(function (a, b) { return rtl ? b.x - a.x : a.x - b.x; }), text = '', j, p, gap;
      for (j = 0; j < s.length; j++) {
        p = s[j - 1];
        if (p) { gap = rtl ? p.x - (s[j].x + s[j].w) : s[j].x - (p.x + p.w); if (gap > 0.12 * Math.max(p.h, s[j].h) && !/\s$/.test(text) && !/^\s/.test(s[j].str)) text += ' '; }
        text += s[j].str;
      }
      var xs = s.map(function (x) { return x.x; }), xe = s.map(function (x) { return x.x + x.w; });
      return { text: text.replace(/\s+/g, ' ').trim(), y: l.y, h: Math.max.apply(null, s.map(function (x) { return x.h; })), x0: Math.min.apply(null, xs), x1: Math.max.apply(null, xe), rtl: rtl };
    }).filter(function (l) { return l.text; });
  }

  function fromPages(pages) {
    var L = pages.map(function (p) { var ls = lines(p); ls.forEach(function (l) { l.pg = p; l.top = p.height ? l.y / p.height : 0.5; }); return ls; }), all = [].concat.apply([], L), warnings = [];
    if (all.reduce(function (a, l) { return a + l.text.length; }, 0) < 40) throw new Error('لا يوجد نص قابل للاستخراج في هذا الـ PDF (ربما هو صور ممسوحة ضوئياً). استخدم ملفاً نصياً أو ملف Word.');
    // الحجم الأساسي للخط = الأكثر شيوعاً (موزوناً بطول النص)
    var freq = {}, body = 12; all.forEach(function (l) { var k = Math.round(l.h * 2) / 2; freq[k] = (freq[k] || 0) + l.text.length; });
    Object.keys(freq).forEach(function (k) { if (freq[k] > (freq[body] || 0)) body = +k; });
    // ترويسة/تذييل متكررة وأرقام الصفحات
    var rep = {}, norm = function (t) { return t.replace(/[\d\u0660-\u0669]+/g, '#').toLowerCase(); };
    if (pages.length >= 3) L.forEach(function (ls) { var seen = {}; ls.forEach(function (l) { if ((l.top > 0.9 || l.top < 0.1) && !seen[norm(l.text)]) { seen[norm(l.text)] = 1; rep[norm(l.text)] = (rep[norm(l.text)] || 0) + 1; } }); });
    all = all.filter(function (l) {
      var edge = l.top > 0.9 || l.top < 0.1;
      if (edge && /^[-–—\s]*[\d\u0660-\u0669]+[-–—\s]*$/.test(l.text)) return false;
      if (edge && pages.length >= 3 && rep[norm(l.text)] >= Math.max(3, pages.length * 0.5)) return false;
      return true;
    });
    var blocks = [], cur = null, prev = null, title = '', desc = '', hs = [];
    var flush = function () { if (cur) { blocks.push(cur); cur = null; } };
    all.forEach(function (l) {
      var ratio = l.h / body, t = l.text, lvl = 0, m;
      if (t.length <= 140 && ratio >= 1.18) lvl = ratio >= 1.7 ? 1 : ratio >= 1.4 ? 2 : 3;
      var newPage = prev && prev.pg !== l.pg, gap = prev && !newPage ? Math.abs(prev.y - l.y) : 0;
      if (lvl) { flush(); if (!title && blocks.length === 0 && lvl === 1) { title = t; } else blocks.push({ k: 'h', l: lvl, t: t }); prev = l; return; }
      if ((m = t.match(/^[•●▪◦‣■□·\-–—*]\s+(.*)$/))) { flush(); cur = { k: 'li', t: m[1], o: false }; prev = l; return; }
      if ((m = t.match(/^\(?(\d{1,3}|[\u0660-\u0669]{1,3})[.)]\s+(.*)$/))) { flush(); cur = { k: 'li', t: m[2], o: true }; prev = l; return; }
      var newPara = !cur || cur.k === 'h' || newPage && SENT.test(cur.t) || gap > 1.8 * l.h || (gap > 1.3 * l.h && SENT.test(cur.t));
      if (newPara) { flush(); cur = { k: 'p', t: t }; }
      else cur.t += (/[-­]$/.test(cur.t) && !/\s-$/.test(cur.t) ? '' : ' ') + t;
      if (/[-­]$/.test(cur.t)) cur.t = cur.t.replace(/[-­]$/, '');
      prev = l;
    });
    flush();
    var md = [], lastLi = false;
    blocks.forEach(function (b, i) {
      var t = escMd(b.t.replace(/\s+/g, ' ').trim()); if (!t) return;
      if (b.k === 'h') { md.push((lastLi ? '\n' : '') + '#'.repeat(Math.min(4, b.l)) + ' ' + t); lastLi = false; return; }
      if (b.k === 'li') { md.push((lastLi ? '' : '\n') + (b.o ? '1. ' : '- ') + t); lastLi = true; return; }
      lastLi = false;
      t = t.replace(/^(\d{1,4})([.)])(\s)/, '$1\\$2$3').replace(/^([#>+\-])(\s)/, '\\$1$2').replace(/^(:{3,}|`{3}|~{3}|\||@)/, '\\$1');
      if (!desc && b.t.length > 40) desc = b.t.slice(0, 158);
      if (b.t.length <= 70 && !END.test(b.t)) t += ' {p}';
      md.push('\n' + t);
    });
    var text = md.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/(\n- [^\n]*)\n(?=- |1\. )/g, '$1\n');
    // سطر بين عنصر القائمة وما بعده
    text = text.replace(/\n\n(- |1\. )/g, '\n\n$1');
    warnings.push('تُستخرج النصوص فقط من PDF — الصور والجداول لا تُستورد، وقد يحتاج ترتيب الفقرات والعناوين لمراجعة سريعة');
    if (all.some(function (l) { return l.rtl; })) warnings.push('ملفات PDF العربية قد تأتي بترتيب كلمات مختلف أحياناً — راجع النص قبل النشر');
    return { title: title.slice(0, 200), desc: desc, body: text, warnings: warnings, pages: pages.length };
  }

  function loadScript(src) {
    return new Promise(function (ok, no) { var s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = function () { no(new Error('تعذّر تحميل مكتبة قراءة PDF — تحقق من الاتصال بالإنترنت')); }; document.head.appendChild(s); });
  }
  var ready = null;
  function ensure() {
    if (window.pdfjsLib && window.pdfjsLib.__ready) return Promise.resolve(window.pdfjsLib);
    if (ready) return ready;
    ready = loadScript(BASE + 'pdf.min.js').then(function () {
      return fetch(BASE + 'pdf.worker.min.js').then(function (r) { if (!r.ok) throw new Error('تعذّر تحميل مكتبة قراءة PDF'); return r.blob(); });
    }).then(function (b) { window.pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([b], { type: 'text/javascript' })); window.pdfjsLib.__ready = 1; return window.pdfjsLib; }, function (e) { ready = null; throw e; });
    return ready;
  }
  /** يقرأ ملف PDF (File) ويُرجع {title,desc,body,warnings} */
  function load(file, onProgress) {
    if (file.size > 25 * 1024 * 1024) return Promise.reject(new Error('ملف PDF كبير جداً (الحد 25MB)'));
    return Promise.all([ensure(), file.arrayBuffer()]).then(function (r) {
      return r[0].getDocument({ data: r[1] }).promise.then(function (pdf) {
        var n = Math.min(pdf.numPages, 150), pages = [], i = 0;
        var next = function () {
          if (i >= n) return pages;
          i++; if (onProgress) onProgress(i, n);
          return pdf.getPage(i).then(function (pg) { var vp = pg.getViewport({ scale: 1 }); return pg.getTextContent().then(function (tc) {
            pages.push({ width: vp.width, height: vp.height, items: tc.items.map(function (x) { return { str: x.str, x: x.transform[4], y: x.transform[5], h: Math.hypot(x.transform[2], x.transform[3]) || x.height, w: x.width, dir: x.dir }; }) });
          }); }).then(next);
        };
        return Promise.resolve(next()).then(function (p) { var res = fromPages(p); if (pdf.numPages > n) res.warnings.push('تم استيراد أول ' + n + ' صفحة فقط'); return res; });
      });
    });
  }
  return { load: load, fromPages: fromPages };
});
