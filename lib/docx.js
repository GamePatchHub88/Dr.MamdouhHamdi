/**
 * lib/docx.js — تحويل ملف Word (.docx) إلى نص المقال (Markdown الموسَّع الخاص بالمحرر)
 * بدون أي مكتبات خارجية: قارئ ZIP صغير (zlib) + محلل XML صغير.
 *
 * يحافظ على: العناوين، غامق/مائل/تسطير/شطب/أعلى/أسفل، لون النص، التمييز، الروابط،
 * القوائم (نقطية/مرقمة/متداخلة)، الجداول، محاذاة التوسيط/الضبط، الصور (تُرفع عبر onImage).
 */
'use strict';
const zlib = require('zlib');

/* ------------------------------------------------------------------ zip */
function readZip(buf) {
  let e = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new Error('الملف ليس بصيغة docx صالحة (يجب حفظه من Word بصيغة .docx)');
  const n = buf.readUInt16LE(e + 10);
  let p = buf.readUInt32LE(e + 16), total = 0;
  const files = {};
  for (let i = 0; i < n; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nl).toString('utf8');
    p += 46 + nl + el + cl;
    if (/\/$/.test(name)) continue;
    if (usize > 25e6) continue;
    const ln = buf.readUInt16LE(off + 26), le = buf.readUInt16LE(off + 28), ds = off + 30 + ln + le, raw = buf.slice(ds, ds + csize);
    total += usize; if (total > 60e6) throw new Error('الملف كبير جداً بعد فك الضغط');
    try { files[name] = method === 0 ? raw : method === 8 ? zlib.inflateRawSync(raw, { maxOutputLength: 25e6 }) : null; } catch (x) { files[name] = null; }
  }
  return files;
}

/* ------------------------------------------------------------------ xml */
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const dec = s => s.replace(/&(?:#x([0-9a-f]+)|#(\d+)|(amp|lt|gt|quot|apos));/gi, (m, h, d, n) => n ? ENT[n.toLowerCase()] : String.fromCodePoint(parseInt(h || d, h ? 16 : 10) || 32));
function parseXml(s) {
  const root = { n: '#', a: {}, c: [] }, st = [root];
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(s))) {
    if (m[6] !== undefined) { st[st.length - 1].c.push({ t: dec(m[6]) }); continue; }
    if (m[1] !== undefined && m[0].charAt(1) === '!') { st[st.length - 1].c.push({ t: m[1] }); continue; }
    if (!m[3]) continue;
    if (m[2]) { if (st.length > 1) st.pop(); continue; }
    const a = {}; m[4].replace(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g, (x, k, v1, v2) => { a[k] = dec(v1 !== undefined ? v1 : v2); return ''; });
    const el = { n: m[3], a, c: [] }; st[st.length - 1].c.push(el);
    if (!m[5]) st.push(el);
  }
  return root;
}
const kids = (e, n) => e.c.filter(x => x.n === n);
const kid = (e, n) => e && e.c.find(x => x.n === n);
const val = (e, n) => { const k = kid(e, n); return k ? (k.a['w:val'] === undefined ? true : k.a['w:val']) : undefined; };
const on = (e, n) => { const v = val(e, n); return v !== undefined && v !== '0' && v !== 'false' && v !== 'off'; };
const textOf = e => e.t !== undefined ? e.t : (e.c || []).map(textOf).join('');

/* ------------------------------------------------------------- md helpers */
const HL = { yellow: '#fde047', green: '#86efac', cyan: '#67e8f9', magenta: '#f0abfc', red: '#fca5a5', blue: '#93c5fd', lightGray: '#e5e7eb', darkYellow: '#facc15', darkGreen: '#4ade80', darkCyan: '#22d3ee', darkMagenta: '#e879f9', darkRed: '#f87171', darkBlue: '#60a5fa', darkGray: '#9ca3af' };
const escMd = t => t.replace(/([\\`*_\[\]{}|~^])/g, '\\$1').replace(/==/g, '\\=\\=').replace(/\+\+/g, '\\+\\+').replace(/</g, '&lt;');
const hasAr = s => /[\u0600-\u06FF]/.test(s), hasLat = s => /[A-Za-z]/.test(s);

function fmtRun(text, f) {
  if (!text) return '';
  const m = text.match(/^(\s*)([\s\S]*?)(\s*)$/), lead = m[1], core = m[2], tail = m[3];
  if (!core) return text.replace(/\s+/g, ' ');
  let t = escMd(core), attrs = [];
  if (f.color) attrs.push('c=' + f.color);
  if (f.hl) attrs.push(f.hl === 'default' ? 'h' : 'h=' + f.hl);
  if (attrs.length) t = '[' + t + ']{' + attrs.join(' ') + '}';
  if (f.sup) t = '^' + t.replace(/\s/g, '') + '^'; else if (f.sub) t = '~' + t.replace(/\s/g, '') + '~';
  if (f.u) t = '++' + t + '++';
  if (f.s) t = '~~' + t + '~~';
  if (f.b && f.i) t = '***' + t + '***'; else if (f.b) t = '**' + t + '**'; else if (f.i) t = '*' + t + '*';
  return (lead ? ' ' : '') + t + (tail ? ' ' : '');
}
const sameF = (a, b) => ['b', 'i', 'u', 's', 'sup', 'sub', 'color', 'hl'].every(k => (a[k] || false) === (b[k] || false));

/* ----------------------------------------------------------------- main */
async function convert(buf, opt) {
  opt = opt || {};
  const Z = readZip(buf), docXml = Z['word/document.xml'];
  if (!docXml) throw new Error('الملف ليس مستند Word صالحاً (لم يُعثر على word/document.xml). إن كان بصيغة .doc القديمة فاحفظه كـ .docx أولاً');
  const warnings = [], doc = parseXml(docXml.toString('utf8'));
  const rels = {}; if (Z['word/_rels/document.xml.rels']) parseXml(Z['word/_rels/document.xml.rels'].toString('utf8')).c.forEach(function walk(r) { if (r.n === 'Relationship') rels[r.a.Id] = r.a; (r.c || []).forEach(walk); });
  const styles = {}; if (Z['word/styles.xml']) parseXml(Z['word/styles.xml'].toString('utf8')).c.forEach(function walk(r) { if (r.n === 'w:style') styles[r.a['w:styleId']] = { name: String(val(r, 'w:name') || ''), ol: (() => { const o = kid(kid(r, 'w:pPr'), 'w:outlineLvl'); return o ? +o.a['w:val'] : -1; })(), num: kid(kid(r, 'w:pPr'), 'w:numPr') }; (r.c || []).forEach(walk); });
  const numFmt = {}, numAbs = {};
  if (Z['word/numbering.xml']) {
    const nx = parseXml(Z['word/numbering.xml'].toString('utf8'));
    (function walk(r) {
      if (r.n === 'w:abstractNum') kids(r, 'w:lvl').forEach(l => { numFmt[r.a['w:abstractNumId'] + ':' + l.a['w:ilvl']] = val(l, 'w:numFmt'); });
      if (r.n === 'w:num') numAbs[r.a['w:numId']] = val(r, 'w:abstractNumId');
      (r.c || []).forEach(walk);
    })(nx);
  }
  const isOrdered = (id, lvl) => { const f = numFmt[numAbs[id] + ':' + lvl]; return !!f && f !== 'bullet' && f !== 'none'; };
  let nImg = 0;
  const imgCache = {};
  async function image(rid) {
    const r = rels[rid]; if (!r || !opt.onImage) return '';
    let path = String(r.Target || '').replace(/^\//, ''); path = path.indexOf('word/') === 0 ? path : 'word/' + path.replace(/^\.\//, '');
    if (imgCache[path] !== undefined) return imgCache[path];
    const data = Z[path], ext = (path.split('.').pop() || '').toLowerCase(), mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }[ext];
    let url = '';
    if (!data) warnings.push('تعذّر قراءة إحدى الصور');
    else if (!mime) warnings.push('صورة بصيغة غير مدعومة (' + ext + ') لم تُستورد — حوّلها إلى PNG/JPG');
    else if (data.length > 4e6) warnings.push('صورة أكبر من 4MB لم تُستورد');
    else if (++nImg > 40) warnings.push('تم الاكتفاء بأول 40 صورة');
    else url = await opt.onImage(data, mime, path.split('/').pop());
    return imgCache[path] = url;
  }

  const runFmt = rPr => {
    const f = {}; if (!rPr) return f;
    f.b = on(rPr, 'w:b'); f.i = on(rPr, 'w:i'); f.s = on(rPr, 'w:strike') || on(rPr, 'w:dstrike');
    const u = val(rPr, 'w:u'); f.u = !!u && u !== 'none';
    const c = val(rPr, 'w:color'); if (c && c !== 'auto' && /^[0-9a-f]{6}$/i.test(c) && !/^(?:000000|0{0,6}|1[0-9a-f]1[0-9a-f]1[0-9a-f])$/i.test(c)) f.color = '#' + c.toLowerCase();
    const hl = val(rPr, 'w:highlight'); if (hl && hl !== 'none') f.hl = hl === 'yellow' ? 'default' : (HL[hl] || 'default');
    const sh = kid(rPr, 'w:shd'); if (!f.hl && sh && sh.a['w:fill'] && /^[0-9a-f]{6}$/i.test(sh.a['w:fill']) && sh.a['w:fill'].toLowerCase() !== 'ffffff') f.hl = '#' + sh.a['w:fill'].toLowerCase();
    const va = val(rPr, 'w:vertAlign'); f.sup = va === 'superscript'; f.sub = va === 'subscript';
    return f;
  };
  /** يحوّل عناصر فقرة إلى مقاطع: {run:[{t,f}]} أو {img:url} أو {link:{href,runs}} */
  async function collect(el, out, link) {
    for (const c of el.c) {
      if (c.n === 'w:r') {
        const f = runFmt(kid(c, 'w:rPr'));
        for (const x of c.c) {
          if (x.n === 'w:t') out.push({ t: textOf(x), f });
          else if (x.n === 'w:tab' || x.n === 'w:br' || x.n === 'w:noBreakHyphen') out.push({ t: x.n === 'w:noBreakHyphen' ? '-' : ' ', f });
          else if (x.n === 'w:drawing' || x.n === 'w:pict' || x.n === 'mc:AlternateContent') {
            let rid = null; (function find(n) { if (rid) return; if (n.n === 'a:blip' && n.a['r:embed']) rid = n.a['r:embed']; else if (n.n === 'v:imagedata' && n.a['r:id']) rid = n.a['r:id']; (n.c || []).forEach(find); })(x);
            let alt = ''; (function find(n) { if (n.n === 'wp:docPr' && !alt) alt = n.a.descr || ''; (n.c || []).forEach(find); })(x);
            if (rid) { const url = await image(rid); if (url) out.push({ img: url, alt }); }
          }
        }
      } else if (c.n === 'w:hyperlink') {
        const href = c.a['r:id'] && rels[c.a['r:id']] ? rels[c.a['r:id']].Target : (c.a['w:anchor'] ? '' : ''), inner = [];
        await collect(c, inner);
        out.push({ link: /^(https?:|mailto:|tel:)/i.test(href || '') ? href : '', runs: inner });
      } else if (c.n === 'w:del' || c.n === 'w:pPr' || c.n === 'w:rPr' || c.n === 'w:proofErr' || c.n === 'w:bookmarkStart' || c.n === 'w:bookmarkEnd' || c.n === 'w:commentRangeStart') continue;
      else if (c.c && c.c.length) await collect(c, out); // ins / smartTag / sdt / fldSimple …
    }
  }
  const runsToMd = (items, noBold) => {
    let s = '', buf = null;
    const flush = () => { if (buf) { s += fmtRun(buf.t, noBold ? Object.assign({}, buf.f, { b: false }) : buf.f); buf = null; } };
    for (const it of items) {
      if (it.t !== undefined) { if (buf && sameF(buf.f, it.f)) buf.t += it.t; else { flush(); buf = { t: it.t, f: it.f }; } }
      else if (it.link !== undefined) { flush(); const inner = runsToMd(it.runs, noBold); s += it.link && inner.trim() ? '[' + inner.trim().replace(/\]/g, '\\]') + '](' + it.link.replace(/\s/g, '%20').replace(/\)/g, '%29') + ')' : inner; }
    }
    flush(); return s.replace(/[ \t]{2,}/g, ' ').trim();
  };
  const plainOf = items => items.map(i => i.t !== undefined ? i.t : i.runs ? plainOf(i.runs) : '').join('').replace(/\s+/g, ' ').trim();

  const out = []; let title = '', desc = '', firstH1 = -1, h1Count = 0;
  async function para(p) {
    const pPr = kid(p, 'w:pPr'), sid = pPr && val(pPr, 'w:pStyle'), st = (sid && styles[sid]) || { name: String(sid || ''), ol: -1 };
    const items = []; await collect(p, items);
    const nm = (st.name + ' ' + (sid || '')).toLowerCase(); let lvl = 0, isTitle = false;
    let m = nm.match(/heading\s*(\d)|عنوان\s*(\d)/); if (m) lvl = +(m[1] || m[2]);
    else if (/\btitle\b|^عنوان\s*$|^العنوان/.test(nm.trim())) { isTitle = true; }
    else { const o = pPr && kid(pPr, 'w:outlineLvl'); const ol = o ? +o.a['w:val'] : st.ol; if (ol >= 0 && ol < 9) lvl = ol + 1; }
    if (lvl > 4) lvl = 4;
    const numPr = pPr && kid(pPr, 'w:numPr'), sNum = (st.num && val(st.num, 'w:numId') !== '0') ? st.num : null, byName = /(?:^|\s)(?:list|قائمة)/i.test(st.name) && !/paragraph|table of/i.test(st.name), list = !lvl && !isTitle && ((numPr && val(numPr, 'w:numId') !== '0' && numPr) || sNum || (byName && { _name: true })) || null;
    const imgs = items.filter(i => i.img), rest = items.filter(i => !i.img);
    const txt = plainOf(rest);
    if (txt || imgs.length) {
      if (txt) {
        const bidi = pPr && on(pPr, 'w:bidi'), jc = pPr && val(pPr, 'w:jc'), tok = [];
        if (jc === 'center') tok.push('center'); else if (jc === 'both') tok.push('justify');
        if (!bidi && hasLat(txt) && !hasAr(txt)) tok.push('ltr');
        if (isTitle && !title) { title = txt; }
        else if (lvl) { const body = runsToMd(rest, true); out.push({ k: 'h', l: lvl, md: '#'.repeat(lvl) + ' ' + body + (tok.length ? ' {' + tok.join(' ') + '}' : ''), txt }); if (lvl === 1) { h1Count++; if (firstH1 < 0) firstH1 = out.length - 1; } }
        else if (list) {
          const np = (numPr && numPr.c.length ? numPr : null) || sNum, nameLvl = +((st.name.match(/(\d)\s*$/) || [])[1] || 1) - 1, il = Math.max(np ? +(val(np, 'w:ilvl') || 0) : 0, /\d\s*$/.test(st.name) ? nameLvl : 0), ord = np && val(np, 'w:numId') ? isOrdered(val(np, 'w:numId'), il) : /number|ترقيم|مرقم/i.test(st.name);
          out.push({ k: 'li', md: '  '.repeat(Math.min(il, 6)) + (ord ? '1. ' : '- ') + runsToMd(rest) });
        } else {
          let md = runsToMd(rest); if (!md) return;
          md = md.replace(/^(\d{1,4})([.)])(\s)/, '$1\\$2$3').replace(/^([#>+\-])(\s)/, '\\$1$2').replace(/^(:{3,}|`{3}|~{3}|\||@)/, '\\$1').replace(/^(-{3,}|\*{3,}|_{3,})$/, '\\$1');
          if (!tok.length && txt.length <= 70 && !/[.،,؛:!؟?…"”»)]$/.test(txt)) tok.push('p'); // يمنع تحويل السطر القصير إلى عنوان
          out.push({ k: 'p', md: md + (tok.length ? ' {' + tok.join(' ') + '}' : ''), txt });
          if (!desc && txt.length > 40) desc = txt;
        }
      }
      for (const im of imgs) out.push({ k: 'img', md: '![' + (im.alt || '').replace(/[\[\]\n]/g, ' ').trim() + '](' + im.img + ' "")' });
    }
  }
  async function table(t) {
    const rows = [];
    for (const tr of kids(t, 'w:tr')) {
      const cells = [];
      for (const tc of kids(tr, 'w:tc')) {
        const span = +(val(kid(tc, 'w:tcPr'), 'w:gridSpan') || 1), parts = [];
        for (const p of kids(tc, 'w:p')) { const it = []; await collect(p, it); const md = runsToMd(it.filter(i => !i.img)); if (md) parts.push(md); }
        cells.push(parts.join(' ').replace(/\n/g, ' '));
        for (let k = 1; k < span; k++) cells.push('');
      }
      if (cells.length) rows.push(cells);
    }
    if (!rows.length) return;
    const w = Math.max.apply(null, rows.map(r => r.length)), line = r => '| ' + Array.from({ length: w }, (_, i) => r[i] || ' ').join(' | ') + ' |';
    out.push({ k: 'tbl', md: line(rows[0]) + '\n| ' + Array(w).fill('---').join(' | ') + ' |' + (rows.length > 1 ? '\n' + rows.slice(1).map(line).join('\n') : '') });
  }
  async function walkBody(el) {
    for (const c of el.c) {
      if (c.n === 'w:p') await para(c);
      else if (c.n === 'w:tbl') await table(c);
      else if (c.n === 'w:sdt' || c.n === 'w:sdtContent' || c.n === 'w:ins') await walkBody(c);
    }
  }
  const body = (function find(n) { if (n.n === 'w:body') return n; for (const c of n.c || []) { const r = find(c); if (r) return r; } return null; })(doc);
  if (!body) throw new Error('محتوى المستند فارغ');
  await walkBody(body);

  if (!title && h1Count === 1 && firstH1 >= 0 && firstH1 < 3) { title = out[firstH1].txt; out.splice(firstH1, 1); }
  let md = '';
  out.forEach((b, i) => { const pv = out[i - 1]; md += (i ? (b.k === 'li' && pv && pv.k === 'li' ? '\n' : '\n\n') : '') + b.md; });
  if (!md.trim()) throw new Error('لم يُعثر على نص داخل الملف');
  if (out.some(b => b.k === 'tbl')) warnings.push('راجع الجداول بعد الاستيراد (الخلايا المدمجة تُحوَّل لخلايا منفصلة)');
  return { title: title.slice(0, 200), desc: desc ? desc.slice(0, 158) : '', body: md, images: nImg, warnings };
}

module.exports = { convert, readZip, parseXml };
