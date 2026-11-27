/*!
 * rich.js — محرّك تنسيق المقالات المشترك (يعمل على Node وفي المتصفح بنفس الكود)
 *
 * المدخل  : نص بصيغة Markdown الموسَّعة (نفس صيغة المقالات القديمة + إضافات).
 * المخرج  : HTML نظيف (يمر عبر sanitizeHTML دائماً) + قائمة العناوين + عدد الكلمات.
 *
 * الصيغة الجديدة متوافقة تماماً مع القديمة (## عنوان، - قائمة، > اقتباس، **غامق**،
 * ![صورة](url)، [video](url)، وسطر قصير = عنوان) فلا حاجة لأي migration.
 *
 * مرجع الصيغة (مختصر):
 *   # … ####  عناوين  (+ {#معرّف-مخصص})      {right|center|left|justify|rtl|ltr|auto|p} في آخر السطر
 *   - عنصر / 1. عنصر / - [ ] مهمة / - [x] منجزة   (التداخل بمسافتين أو Tab)
 *   > اقتباس     > [!pull|card|minimal]  أول سطر لتغيير النمط ، و«— المصدر» في آخر سطر
 *   :::info|tip|warning|danger|note  عنوان اختياري … :::      :::details عنوان … :::
 *   ```js [nolines] [اسم-الملف]  … ```
 *   | a | b |  جداول GFM  (:--: لمحاذاة العمود)
 *   ![alt](url "caption"){w=60 center}    [video](url)    @card url | عنوان | وصف | صورة    ---
 *   **غامق** *مائل* ++تسطير++ ~~يتوسطه خط~~ ==تمييز== ^أعلى^ ~أسفل~ `كود` [نص](url)
 *   [نص]{c=#e11d48 h=#fde68a}  لون النص / لون التمييز
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Rich = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ------------------------------------------------------------------ utils */
  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ESC[c]; }); };
  var MAXLEN = 400000;

  function normalize(s) {
    s = String(s == null ? '' : s);
    if (s.length > MAXLEN) s = s.slice(0, MAXLEN);
    // CR/LF → LF ، حذف محارف التحكم، وحذف محارف bidi-override (تُستخدم في التزوير)
    return s.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202D\u202E]/g, '');
  }

  /** يُرجع الرابط إن كان آمناً (http/https/mailto/tel/مسار نسبي/#) وإلا نصاً فارغاً */
  function safeUrl(u) {
    u = String(u == null ? '' : u).trim();
    if (!u) return '';
    var probe = u.replace(/[\u0000-\u0020\u007F-\u009F\u00AD\u200B-\u200F\u2028\u2029\uFEFF]/g, '');
    if (/^[a-z][a-z0-9+.\-]*:/i.test(probe)) return /^(?:https?|mailto|tel):/i.test(probe) ? u : '';
    if (/^\/\//.test(probe) || /^\\/.test(probe)) return '';
    return u;
  }
  var isImgUrl = function (u) { return /^(?:https?:\/\/|\/api\/img\/|\/img\/)[^\s"'<>]+$/i.test(u || ''); };

  var COLORS = { red: '#dc2626', orange: '#ea580c', amber: '#d97706', green: '#16a34a', teal: '#0d9488', blue: '#2563eb', purple: '#7c3aed', pink: '#db2777', gray: '#6b7280' };
  var HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
  var toColor = function (v) { v = String(v || '').trim().toLowerCase(); return HEX.test(v) ? v : (COLORS[v] || ''); };

  /** معرّف عنوان عربي صالح (يحافظ على الحروف العربية ويزيل التشكيل) */
  function slugId(t) {
    var s = String(t || '').normalize('NFKC').replace(/[ً-ٰٟـ]/g, '').toLowerCase().trim()
      .replace(/[^\p{L}\p{N}\p{M}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
    return s || 'section';
  }
  // معرّفات عناصر صفحة المقال نفسها — لا يجوز أن تتصادم معها عناوين المقال
  var RESERVED = ('top pg rd bd aft rel cmt cl cf cn cs cp ns lk lc fm fp pr th yr grid sort q lm listv readv tcur vw cname ctext cmsg cc0 cm0 cnt md ld main toast app body html head header footer nav rt rt2 file').split(' ');

  /* --------------------------------------------------------------- allow-lists */
  var DIRS = { rtl: 1, ltr: 1, auto: 1 };
  var AL = { right: 'ta-r', left: 'ta-l', center: 'ta-c', justify: 'ta-j' };
  var AR = { 'يمين': 'right', 'يسار': 'left', 'وسط': 'center', 'ضبط': 'justify' };
  var CALLOUTS = {
    info: ['معلومة', 'info'], tip: ['نصيحة', 'tip'], warning: ['تحذير', 'warning'], danger: ['خطر', 'danger'], note: ['ملاحظة', 'note'],
    'معلومة': ['معلومة', 'info'], 'نصيحة': ['نصيحة', 'tip'], 'تحذير': ['تحذير', 'warning'], 'خطر': ['خطر', 'danger'], 'ملاحظة': ['ملاحظة', 'note']
  };
  var DETAILS = { details: 1, accordion: 1, collapse: 1, 'طي': 1, 'قابل-للطي': 1 };
  var QSTYLES = { classic: 1, pull: 1, card: 1, minimal: 1 };

  /* ----------------------------------------------------------------- inline */
  function parseSpanAttrs(a) {
    var o = {}, ok = false, toks = String(a).trim().split(/\s+/).filter(Boolean), i, k, v, p;
    for (i = 0; i < toks.length; i++) {
      p = toks[i].split('='); k = p[0].toLowerCase(); v = p.slice(1).join('=');
      if (k === 'c' || k === 'color') { var c = toColor(v); if (!c) return null; o.c = c; ok = true; }
      else if (k === 'h' || k === 'bg' || k === 'hl') { if (v) { var h = toColor(v); if (!h) return null; o.h = h; } else o.h = ''; o.hs = true; ok = true; }
      else if (k === 'sup') { o.sup = 1; ok = true; } else if (k === 'sub') { o.sub = 1; ok = true; }
      else return null;
    }
    return ok ? o : null;
  }

  function inline(src, st) {
    var top = !st; st = st || [];
    var keep = function (h) { return '\u0001' + (st.push(h) - 1) + '\u0002'; };
    var t = String(src);
    // 1) escapes + inline code (تُحفظ كما هي ولا تُعالَج)
    t = t.replace(/\\([\\`*_{}\[\]()#+\-.!~^=|>:<&"'])/g, function (m, c) { return keep(esc(c)); });
    t = t.replace(/(`+)([^`\n](?:[\s\S]*?[^`\n])?)\1(?!`)/g, function (m, a, c) { return keep('<code dir="ltr">' + esc(c.trim()) + '</code>'); });
    // 2) أنماط النص [نص]{c=… h=…}
    t = t.replace(/\[((?:[^\[\]\\\n]|\\.)+?)\]\{([^{}\n]*)\}/g, function (m, txt, a) {
      var o = parseSpanAttrs(a); if (!o) return m;
      var h = inline(txt, st), style = '';
      if (o.c) style += 'color:' + o.c + ';';
      if (o.hs) h = '<mark' + (o.h ? ' style="background-color:' + o.h + '"' : '') + '>' + h + '</mark>';
      if (style) h = '<span style="' + style + '">' + h + '</span>';
      if (o.sup) h = '<sup>' + h + '</sup>'; if (o.sub) h = '<sub>' + h + '</sub>';
      return keep(h);
    });
    // 3) روابط [نص](url "عنوان")
    t = t.replace(/\[((?:[^\[\]\\\n]|\\.)+?)\]\(\s*([^\s)]+)(?:\s+"([^"]*)")?\s*\)/g, function (m, txt, url, title, off, whole) {
      if (off > 0 && whole.charAt(off - 1) === '!') return m;
      var u = safeUrl(url), inner = inline(txt, st);
      if (!u) return keep(inner);
      var ext = /^https?:/i.test(u);
      return keep('<a href="' + esc(u) + '"' + (title ? ' title="' + esc(title) + '"' : '') + (ext ? ' target="_blank" rel="noopener noreferrer"' : '') + '>' + inner + '</a>');
    });
    // 4) روابط عارية
    t = t.replace(/(^|[\s(«"'،>])(https?:\/\/[^\s<>"'()\u0001\u0002]+)/g, function (m, pre, url) {
      var tail = (url.match(/[.,;:!?،؛؟…\]]+$/) || [''])[0]; if (tail) url = url.slice(0, -tail.length);
      var u = safeUrl(url); if (!u) return m;
      return pre + keep('<a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">' + esc(u) + '</a>') + tail;
    });
    // 5) هروب HTML لكل ما تبقى — لا يخرج أي وسم من المستخدم أبداً
    t = esc(t);
    // 6) التنسيق النصي
    t = t.replace(/\*\*\*(\S(?:[\s\S]*?\S)?)\*\*\*/g, '<strong><em>$1</em></strong>');
    t = t.replace(/\*\*(\S(?:[\s\S]*?\S)?)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/(^|[^*\w])\*(?!\*)(\S(?:[^*\n]*?\S)?)\*(?!\*)/g, '$1<em>$2</em>');
    t = t.replace(/~~(\S(?:[\s\S]*?\S)?)~~/g, '<s>$1</s>');
    t = t.replace(/\+\+(\S(?:[\s\S]*?\S)?)\+\+/g, '<u>$1</u>');
    t = t.replace(/==(\S(?:[\s\S]*?\S)?)==/g, '<mark>$1</mark>');
    t = t.replace(/\^([^\s^]+)\^/g, '<sup>$1</sup>');
    t = t.replace(/~([^\s~]+)~/g, '<sub>$1</sub>');
    if (top) { var n = 0; while (n++ < 8 && t.indexOf('\u0001') > -1) t = t.replace(/\u0001(\d+)\u0002/g, function (m, i) { return st[+i] == null ? '' : st[+i]; }); }
    return t;
  }

  /** نص عادي من سطر منسّق (للعناوين وعدّ الكلمات والوصف) */
  function strip(s) {
    return String(s)
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]*)\]\{[^}]*\}/g, '$1')
      .replace(/`+([^`]*)`+/g, '$1').replace(/\*\*|~~|\+\+|==/g, '').replace(/(^|[^*\w])\*(\S(?:[^*]*?\S)?)\*/g, '$1$2')
      .replace(/\^([^\s^]+)\^/g, '$1').replace(/\\([\\`*_{}\[\]()#+\-.!~^=|>:<])/g, '$1').replace(/\s+/g, ' ').trim();
  }

  /* --------------------------------------------------------- attribute tokens */
  function takeAttrs(s) {
    var o = { cls: '', dir: '', id: '', force: false, found: false, text: s }, text = s, n, m, toks, ok, tmp, i, k;
    for (n = 0; n < 4; n++) {
      m = text.match(/\s*\{([^{}]*)\}\s*$/); if (!m) break;
      toks = m[1].trim().split(/[\s,]+/).filter(Boolean); if (!toks.length) break;
      ok = true; tmp = { cls: '', dir: '', id: '', force: false };
      for (i = 0; i < toks.length; i++) {
        k = AR[toks[i]] || toks[i];
        if (AL[k]) tmp.cls = AL[k]; else if (DIRS[k]) tmp.dir = k; else if (k === 'p') tmp.force = true;
        else if (/^#[\p{L}\p{N}_-]{1,60}$/u.test(k)) tmp.id = k.slice(1);
        else { ok = false; break; }
      }
      if (!ok) break;
      if (tmp.cls && !o.cls) o.cls = tmp.cls; if (tmp.dir && !o.dir) o.dir = tmp.dir; if (tmp.id && !o.id) o.id = tmp.id; if (tmp.force) o.force = true;
      text = text.slice(0, m.index); o.found = true;
    }
    o.text = text; return o;
  }
  var attrStr = function (o, extraCls) {
    var c = [extraCls, o && o.cls].filter(Boolean).join(' ');
    return (c ? ' class="' + c + '"' : '') + (o && o.dir ? ' dir="' + o.dir + '"' : '');
  };

  /* ----------------------------------------------------------------- video */
  var iframe = function (src, title) {
    return '<div class="vid"><iframe src="' + esc(src) + '" title="' + esc(title || 'فيديو') + '" loading="lazy" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe></div>';
  };
  function videoEmbed(u) {
    var m; u = String(u || '').trim();
    if ((m = u.match(/^https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?(?:[^#\s]*&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([\w-]{11})/i))) {
      var s = u.match(/[?&#](?:t|start)=(\d{1,6})s?(?:$|[&#])/);
      return iframe('https://www.youtube-nocookie.com/embed/' + m[1] + (s ? '?start=' + s[1] : ''));
    }
    if ((m = u.match(/^https?:\/\/(?:www\.)?vimeo\.com\/(?:[^?#]*\/)?(\d+)/i))) return iframe('https://player.vimeo.com/video/' + m[1]);
    if ((m = u.match(/^https?:\/\/(?:www\.)?(?:dailymotion\.com\/video\/|dai\.ly\/)([a-z0-9]+)/i))) return iframe('https://www.dailymotion.com/embed/video/' + m[1]);
    if (/^https?:\/\/(?:www\.|m\.|web\.)?(?:facebook\.com\/[^\s]*(?:videos?|watch|reel)|fb\.watch\/)/i.test(u)) return iframe('https://www.facebook.com/plugins/video.php?show_text=false&href=' + encodeURIComponent(u));
    if (/^(?:https?:\/\/|\/api\/img\/)[^\s"'<>]+\.(?:mp4|webm|ogg|mov)(?:\?[^\s"'<>]*)?$/i.test(u)) return '<div class="vid"><video controls preload="metadata" playsinline src="' + esc(u) + '"></video></div>';
    return '';
  }

  /* ------------------------------------------------------ syntax highlighting */
  var Y = function (s, f) { return new RegExp(s, 'y' + (f || '')); };
  var set = function (s) { var o = Object.create(null); s.split(' ').forEach(function (w) { if (w) o[w] = 1; }); return o; };
  var C_LINE = ['c', Y('\\/\\/[^\\n]*')], C_BLOCK = ['c', Y('\\/\\*[\\s\\S]*?(?:\\*\\/|$)')], C_HASH = ['c', Y('#[^\\n]*')], C_DASH = ['c', Y('--[^\\n]*')];
  var S_D = ['s', Y('"(?:\\\\[\\s\\S]|[^"\\\\\\n])*"?')], S_S = ['s', Y("'(?:\\\\[\\s\\S]|[^'\\\\\\n])*'?")], S_T = ['s', Y('`(?:\\\\[\\s\\S]|[^`\\\\])*`?')];
  var NUM = ['n', Y('(?:0[xX][\\da-fA-F_]+|\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)(?![\\w.])')];
  var KW_JS = set('abstract as async await break case catch class const continue debugger declare default delete do else enum export extends finally for from function get if implements import in instanceof interface let namespace new of package private protected public readonly return set static super switch this throw try type typeof var void while with yield');
  var KW_PY = set('and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case print');
  var KW_SH = set('if then else elif fi for while do done case esac in function return exit export local source alias unset set echo cd sudo');
  var KW_C = set('abstract assert auto bool boolean break byte case catch char class const constexpr continue default defer delete do double else enum explicit extends extern final finally float fn for foreach func function go goto if impl implements import in include inline instanceof int interface internal let long map match mod mut namespace native new operator override package private protected pub public range readonly record ref return sealed select short signed sizeof static string struct super switch synchronized template this throw throws trait try type typedef typename union unsigned use using var virtual void volatile where while yield async await echo require');
  var KW_SQL = set('select from where and or not null insert into values update set delete create table alter drop index join left right inner outer full on as group by order having limit offset union all distinct case when then else end in is like between exists primary key foreign references default unique check constraint view trigger begin commit rollback asc desc count sum avg min max');
  var LIT = set('true false null undefined NaN Infinity True False None nil NULL nullptr');
  var KW_YML = set('true false null yes no on off');

  var LANGS = {
    js: { r: [C_LINE, C_BLOCK, S_D, S_S, S_T, NUM], kw: KW_JS, ty: 1 },
    py: { r: [C_HASH, ['s', Y('(?:"""[\\s\\S]*?(?:"""|$)|\'\'\'[\\s\\S]*?(?:\'\'\'|$))')], S_D, S_S, NUM], kw: KW_PY },
    sh: { r: [C_HASH, S_D, S_S, ['n', Y('\\$\\{?[A-Za-z_]\\w*\\}?|\\$[0-9@#?*!$-]')], NUM], kw: KW_SH },
    sql: { r: [C_DASH, C_BLOCK, S_S, S_D, NUM], kw: KW_SQL, ci: 1 },
    c: { r: [C_LINE, C_BLOCK, ['k', Y('^[ \\t]*#\\s*\\w+', 'm')], S_D, S_S, NUM], kw: KW_C, ty: 1 },
    php: { r: [C_LINE, C_BLOCK, C_HASH, ['k', Y('<\\?php|\\?>')], ['n', Y('\\$[A-Za-z_]\\w*')], S_D, S_S, NUM], kw: KW_C },
    css: { r: [C_BLOCK, S_D, S_S, ['k', Y('@[\\w-]+')], ['n', Y('#[0-9a-fA-F]{3,8}\\b')], ['n', Y('-?(?:\\d*\\.)?\\d+(?:px|r?em|%|vh|vw|s|ms|deg|fr|ch)?(?![\\w])')], ['a', Y('-{0,2}[a-zA-Z][\\w-]*(?=\\s*:(?!:))')]], kw: set('') },
    json: { r: [['a', Y('"(?:\\\\.|[^"\\\\\\n])*"(?=\\s*:)')], S_D, NUM], kw: set(''), lit: 1 },
    html: { r: [['c', Y('<!--[\\s\\S]*?(?:-->|$)')], ['k', Y('<\\/?[A-Za-z][\\w:.-]*')], ['k', Y('\\/?>')], ['a', Y('[A-Za-z_:@][\\w:.@-]*(?=\\s*=)')], ['s', Y('"[^"]*"?')], ['s', Y("'[^']*'?")], ['n', Y('&[#\\w]+;')]], kw: set('') },
    yaml: { r: [C_HASH, ['a', Y('[\\w.-]+(?=\\s*:(?:\\s|$))')], S_D, S_S, NUM], kw: KW_YML },
    diff: { r: [['ins', Y('^\\+.*', 'm')], ['del', Y('^-.*', 'm')], ['k', Y('^@@.*', 'm')]], kw: set('') }
  };
  var ALIAS = {
    js: 'js', javascript: 'js', jsx: 'js', mjs: 'js', node: 'js', ts: 'js', typescript: 'js', tsx: 'js',
    py: 'py', python: 'py', bash: 'sh', sh: 'sh', shell: 'sh', zsh: 'sh', console: 'sh', cmd: 'sh', powershell: 'sh',
    sql: 'sql', mysql: 'sql', postgres: 'sql', java: 'c', c: 'c', cpp: 'c', 'c++': 'c', cs: 'c', csharp: 'c', 'c#': 'c', go: 'c', golang: 'c', rust: 'c', rs: 'c', kotlin: 'c', swift: 'c', dart: 'c', ruby: 'py', rb: 'py',
    php: 'php', css: 'css', scss: 'css', less: 'css', json: 'json', jsonc: 'json', html: 'html', xml: 'html', svg: 'html', vue: 'html', yaml: 'yaml', yml: 'yaml', toml: 'yaml', ini: 'yaml', diff: 'diff', patch: 'diff'
  };
  var LABEL = { js: 'JavaScript', javascript: 'JavaScript', jsx: 'JSX', ts: 'TypeScript', typescript: 'TypeScript', tsx: 'TSX', py: 'Python', python: 'Python', bash: 'Bash', sh: 'Shell', shell: 'Shell', zsh: 'Zsh', sql: 'SQL', html: 'HTML', xml: 'XML', svg: 'SVG', css: 'CSS', scss: 'SCSS', json: 'JSON', java: 'Java', c: 'C', cpp: 'C++', 'c++': 'C++', cs: 'C#', csharp: 'C#', 'c#': 'C#', go: 'Go', rust: 'Rust', rs: 'Rust', php: 'PHP', ruby: 'Ruby', rb: 'Ruby', kotlin: 'Kotlin', swift: 'Swift', dart: 'Dart', yaml: 'YAML', yml: 'YAML', diff: 'Diff', md: 'Markdown', markdown: 'Markdown', text: 'نص', txt: 'نص', plain: 'نص', powershell: 'PowerShell', vue: 'Vue', toml: 'TOML', ini: 'INI', less: 'Less', mysql: 'MySQL', postgres: 'PostgreSQL', node: 'Node.js', cmd: 'CMD', console: 'Console', golang: 'Go' };
  var LANG_LIST = ['js', 'ts', 'jsx', 'tsx', 'html', 'css', 'json', 'py', 'php', 'java', 'cs', 'cpp', 'c', 'go', 'rust', 'sql', 'bash', 'powershell', 'yaml', 'xml', 'diff', 'md', 'text'];

  function lex(code, L, lang) {
    var out = [], i = 0, plain = '', n = code.length, w = Y('[A-Za-z_$\\u00A1-\\uFFFF][\\w$\\u00A1-\\uFFFF]*'), r, m, j, hit, t, cls, nx;
    var flush = function () { if (plain) { out.push(['', plain]); plain = ''; } };
    while (i < n) {
      hit = false;
      for (j = 0; j < L.r.length; j++) {
        r = L.r[j][1]; r.lastIndex = i; m = r.exec(code);
        if (m && m[0].length) { flush(); out.push([L.r[j][0], m[0]]); i += m[0].length; hit = true; break; }
      }
      if (hit) continue;
      w.lastIndex = i; m = w.exec(code);
      if (m) {
        t = m[0]; cls = '';
        if (L.kw[L.ci ? t.toLowerCase() : t]) cls = 'k';
        else if (L.lit ? LIT[t] : (LIT[t] && lang !== 'sql')) cls = 'n';
        else if (L.ty && /^[A-Z][A-Za-z0-9_]*$/.test(t) && t.length > 1) cls = 't';
        else { nx = code.slice(i + t.length, i + t.length + 40).match(/^\s*\(/); if (nx && L.kw !== undefined && lang !== 'css' && lang !== 'json' && lang !== 'html' && lang !== 'yaml' && lang !== 'diff') cls = 'f'; }
        if (cls) { flush(); out.push([cls, t]); } else plain += t;
        i += t.length; continue;
      }
      plain += code.charAt(i++);
    }
    flush(); return out;
  }

  /** يُرجع مصفوفة أسطر HTML (كل سطر مغلّف بـ span.l) */
  function highlightLines(code, lang) {
    var key = ALIAS[String(lang || '').toLowerCase()], L = key && LANGS[key], toks;
    if (!L || code.length > 30000) toks = [['', code]]; else toks = lex(code, L, key);
    var lines = [''], i, segs, k;
    for (i = 0; i < toks.length; i++) {
      segs = toks[i][1].split('\n');
      for (k = 0; k < segs.length; k++) {
        if (k > 0) lines.push('');
        if (segs[k]) lines[lines.length - 1] += toks[i][0] ? '<span class="t-' + toks[i][0] + '">' + esc(segs[k]) + '</span>' : esc(segs[k]);
      }
    }
    return lines;
  }

  function codeBlock(lang, opts, code) {
    var lines = highlightLines(code.replace(/\n+$/, ''), lang), lg = String(lang || '').toLowerCase().replace(/[^\w+#.-]/g, '').slice(0, 20);
    var label = LABEL[lg] || (lg ? lg.toUpperCase() : 'كود');
    return '<figure class="cb' + (opts.nolines ? ' cb-nl' : '') + '" data-lang="' + (lg || 'text') + '"><div class="cb-h"><span class="cb-l">' + esc(label) + '</span>' + (opts.file ? '<span class="cb-f" dir="ltr">' + esc(opts.file) + '</span>' : '') +
      '</div><pre dir="ltr" tabindex="0"><code' + (lg ? ' class="lang-' + lg + '"' : '') + '>' + lines.map(function (l) { return '<span class="l">' + l + '</span>'; }).join('\n') + '</code></pre></figure>';
  }

  /* ----------------------------------------------------------------- blocks */
  var RE_FENCE = /^(\s*)(`{3,}|~{3,})\s*([^\s`]*)\s*(.*?)\s*$/;
  var RE_CONT = /^(:{3,})\s*([^\s:]+)?\s*(.*?)\s*$/;
  var RE_HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
  var RE_LI = /^([ \t]*)([-•*]|\d{1,4}[.)]|[٠-٩]{1,4}[.)])[ \t]+(.*)$/;
  var RE_SEP = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
  var RE_IMG = /^!\[([^\]]*)\]\(\s*(\S+?)(?:\s+"([^"]*)")?\s*\)\s*(?:\{([^{}]*)\})?\s*$/;
  var RE_VID = /^(?:\[(?:video|فيديو)\]\(\s*(\S+?)\s*\)|@(?:video|فيديو)\s+(\S+)|(https?:\/\/\S+))$/i;
  var RE_CARD = /^@(?:card|بطاقة)\s+(\S+)(?:\s*\|\s*(.*))?$/i;

  function ind(s) { var n = 0, i; for (i = 0; i < s.length; i++) n += s.charAt(i) === '\t' ? 4 : 1; return n; }
  function arNum(s) { return parseInt(String(s).replace(/[٠-٩]/g, function (d) { return d.charCodeAt(0) - 1632; }), 10); }

  function splitRow(l) {
    var s = l.trim(), cells = [], cur = '', i, c;
    if (s.charAt(0) === '|') s = s.slice(1);
    for (i = 0; i < s.length; i++) {
      c = s.charAt(i);
      if (c === '\\' && s.charAt(i + 1) === '|') { cur += '|'; i++; }
      else if (c === '|') { cells.push(cur.trim()); cur = ''; }
      else cur += c;
    }
    if (cur.trim() !== '' || !/\|\s*$/.test(s)) cells.push(cur.trim());
    return cells;
  }

  function uniqueId(base, ctx) {
    var id = base, n = 1;
    while (ctx.used[id] || RESERVED.indexOf(id) > -1 || /^s\d+$/.test(id)) { n++; id = base + '-' + n; }
    ctx.used[id] = 1; return id;
  }

  function heading(level, raw, ctx, forceId) {
    var a = takeAttrs(raw), text = a.text, plain = strip(text), id = uniqueId(a.id || forceId || slugId(plain), ctx);
    ctx.heads.push({ id: id, level: level, text: plain });
    ctx.text.push(plain);
    return '<h' + level + ' id="' + id + '"' + attrStr(a) + '>' + inline(text) + '<a class="anc" href="#' + id + '" aria-label="رابط مباشر لهذا القسم">#</a></h' + level + '>';
  }

  function listHtml(items, ctx) {
    var out = '', stack = [], i, it, top, tag, li, tcls;
    for (i = 0; i < items.length; i++) {
      it = items[i]; tag = it.ord ? 'ol' : 'ul';
      while (stack.length && it.ind < stack[stack.length - 1].ind) { out += '</li></' + stack[stack.length - 1].tag + '>'; stack.pop(); }
      top = stack[stack.length - 1];
      if (top && it.ind === top.ind && top.tag !== tag) { out += '</li></' + top.tag + '>'; stack.pop(); top = stack[stack.length - 1]; }
      if (!top || it.ind > top.ind) {
        out += '<' + tag + (tag === 'ol' && it.num > 1 ? ' start="' + it.num + '"' : '') + '>'; stack.push({ ind: it.ind, tag: tag });
      } else out += '</li>';
      tcls = it.task ? (' class="task' + (it.done ? ' done' : '') + '"') : '';
      li = '<li' + tcls + '>';
      if (it.task) li += '<input type="checkbox" disabled' + (it.done ? ' checked' : '') + '> ';
      out += li + inline(it.text);
      ctx.text.push(strip(it.text));
    }
    while (stack.length) { out += '</li></' + stack[stack.length - 1].tag + '>'; stack.pop(); }
    return out;
  }

  function findClose(L, i, len) {
    // يبحث عن سطر إغلاق الحاوية ::: مع احترام التداخل وكتل الكود
    var depth = 0, j, m, f, fch = null, flen = 0;
    for (j = i + 1; j < L.length; j++) {
      f = L[j].match(RE_FENCE);
      if (fch) { if (f && f[2].charAt(0) === fch && f[2].length >= flen && !f[3] && !f[4]) fch = null; continue; }
      if (f) { fch = f[2].charAt(0); flen = f[2].length; continue; }
      m = L[j].trim().match(RE_CONT);
      if (!m) continue;
      if (!m[2] && !m[3]) { if (depth === 0 && m[1].length >= len) return j; depth--; if (depth < 0) depth = 0; }
      else depth++;
    }
    return L.length;
  }

  function blocks(L, ctx) {
    var out = '', i = 0, prev = ctx.depth === 0, raw, l, m, a, j, k;
    while (i < L.length) {
      raw = L[i]; l = raw.trim();
      if (!l) { prev = ctx.depth === 0 ? true : prev; i++; continue; }

      // ---- كتلة كود
      if ((m = raw.match(RE_FENCE)) && !/`/.test(m[3] + m[4]) ) {
        var fch = m[2].charAt(0), flen = m[2].length, lang = m[3], info = m[4], code = [], opts = { nolines: false, file: '' };
        if (/(?:^|\s)nolines(?:\s|$)/i.test(info)) { opts.nolines = true; info = info.replace(/(?:^|\s)nolines(?=\s|$)/i, '').trim(); }
        opts.file = info.replace(/^(?:title|file)=/i, '').replace(/^["']|["']$/g, '').slice(0, 60);
        j = i + 1;
        while (j < L.length) { var cm = L[j].match(RE_FENCE); if (cm && cm[2].charAt(0) === fch && cm[2].length >= flen && !cm[3] && !cm[4]) break; code.push(L[j]); j++; }
        out += codeBlock(lang, opts, code.join('\n')); i = j + 1; prev = false; continue;
      }

      // ---- حاويات ::: (تنبيهات / قابل للطي)
      if ((m = l.match(RE_CONT)) && m[2] && ctx.depth < 4) {
        var name = m[2].toLowerCase(), title = m[3] || '', close = findClose(L, i, m[1].length), inner = L.slice(i + 1, close);
        if (CALLOUTS[name] || DETAILS[name]) {
          ctx.depth++;
          var body = blocks(inner, ctx);
          ctx.depth--;
          if (DETAILS[name]) {
            var open = /\{open\}\s*$/.test(title); title = title.replace(/\s*\{open\}\s*$/, '');
            out += '<details class="acc"' + (open ? ' open' : '') + '><summary>' + inline(title || 'التفاصيل') + '</summary><div class="acc-b">' + body + '</div></details>';
            ctx.text.push(strip(title));
          } else {
            var c = CALLOUTS[name];
            out += '<aside class="co co-' + c[1] + '"><div class="co-h"><span class="co-t">' + inline(title || c[0]) + '</span></div><div class="co-b">' + body + '</div></aside>';
          }
          i = close + 1; prev = false; continue;
        }
      }

      // ---- جدول
      if (l.indexOf('|') > -1 && i + 1 < L.length && RE_SEP.test(L[i + 1]) && splitRow(L[i + 1]).length === splitRow(l).length && (L[i + 1].indexOf('|') > -1 || splitRow(l).length > 1)) {
        var head = splitRow(l), sep = splitRow(L[i + 1]), al = sep.map(function (s) { var x = /^:/.test(s), y = /:$/.test(s); return x && y ? 'ta-c' : y ? 'ta-r' : x ? 'ta-l' : ''; });
        var rows = []; j = i + 2;
        while (j < L.length && L[j].trim() && L[j].indexOf('|') > -1) { rows.push(splitRow(L[j])); j++; }
        var cell = function (tag, t, c) { ctx.text.push(strip(t)); return '<' + tag + (al[c] ? ' class="' + al[c] + '"' : '') + '>' + inline(t) + '</' + tag + '>'; };
        out += '<div class="tw" tabindex="0"><table><thead><tr>' + head.map(function (t, c) { return cell('th', t, c); }).join('') + '</tr></thead><tbody>' +
          rows.map(function (r) { var s = ''; for (k = 0; k < head.length; k++) s += cell('td', r[k] || '', k); return '<tr>' + s + '</tr>'; }).join('') + '</tbody></table></div>';
        i = j; prev = false; continue;
      }

      // ---- فاصل أفقي
      if (RE_HR.test(raw)) { out += '<hr>'; i++; prev = false; continue; }

      // ---- صورة
      if ((m = l.match(RE_IMG)) && isImgUrl(m[2])) {
        var alt = m[1], cap = m[3] === undefined ? alt : m[3], w = 0, al2 = 'al-c', toks = (m[4] || '').split(/[\s,]+/).filter(Boolean), t;
        for (k = 0; k < toks.length; k++) {
          t = toks[k].toLowerCase(); var wm = t.match(/^(?:w|width|size)?=?(\d{2,3})%?$/);
          if (wm && +wm[1] >= 10 && +wm[1] <= 100) w = +wm[1];
          else if (/^(?:align=)?(left|center|right)$/.test(t)) al2 = 'al-' + t.replace('align=', '').charAt(0);
          else if (AR[t]) al2 = 'al-' + AR[t].charAt(0);
        }
        out += '<figure class="md ' + al2 + '"' + (w && w < 100 ? ' style="width:' + w + '%"' : '') + '><img src="' + esc(m[2]) + '" alt="' + esc(alt) + '" width="1200" height="675" loading="lazy" decoding="async">' + (cap ? '<figcaption>' + inline(cap) + '</figcaption>' : '') + '</figure>';
        i++; prev = false; continue;
      }

      // ---- فيديو
      if ((m = l.match(RE_VID))) { var v = videoEmbed(m[1] || m[2] || m[3]); if (v) { out += v; i++; prev = false; continue; } }

      // ---- بطاقة رابط
      if ((m = l.match(RE_CARD))) {
        var cu = safeUrl(m[1]);
        if (/^https?:\/\//i.test(cu)) {
          var parts = (m[2] || '').split('|').map(function (s) { return s.trim(); }), dom = '';
          try { dom = new URL(cu).hostname.replace(/^www\./, ''); } catch (e) { dom = cu; }
          var img = parts[2] && /^https?:\/\//i.test(parts[2]) ? parts[2] : '';
          out += '<a class="lc" href="' + esc(cu) + '" target="_blank" rel="noopener noreferrer">' + (img ? '<span class="lc-img"><img src="' + esc(img) + '" alt="" loading="lazy" decoding="async"></span>' : '') +
            '<span class="lc-b"><span class="lc-t">' + esc(parts[0] || dom) + '</span>' + (parts[1] ? '<span class="lc-d">' + esc(parts[1]) + '</span>' : '') + '<span class="lc-u" dir="ltr">' + esc(dom) + '</span></span></a>';
          ctx.text.push(parts[0] || '');
          i++; prev = false; continue;
        }
      }

      // ---- عنوان
      if ((m = l.match(/^(#{1,4})\s+(.+)/))) { out += heading(m[1].length, m[2], ctx); i++; prev = false; continue; }

      // ---- اقتباس
      if (/^>/.test(l)) {
        var q = []; j = i;
        while (j < L.length && /^\s*>/.test(L[j])) { q.push(L[j].trim().replace(/^>\s?/, '')); j++; }
        var style = 'classic', qa = {};
        if ((m = (q[0] || '').match(/^\[!(\w+)\]\s*(.*)$/)) && QSTYLES[m[1].toLowerCase()]) { style = m[1].toLowerCase(); if (m[2]) q[0] = m[2]; else q.shift(); }
        var cite = '';
        if (q.length > 1 && /^(?:—|–|--)\s*\S/.test(q[q.length - 1])) cite = q.pop().replace(/^(?:—|–|--)\s*/, '');
        var lastA = takeAttrs(q.length ? q[q.length - 1] : '');
        if (lastA.found && q.length) { qa = lastA; q[q.length - 1] = lastA.text; }
        q = q.filter(function (s) { return s.trim(); });
        out += '<blockquote class="q-' + style + (qa.cls ? ' ' + qa.cls : '') + '"' + (qa.dir ? ' dir="' + qa.dir + '"' : '') + '>' + q.map(function (s) { ctx.text.push(strip(s)); return '<p>' + inline(s) + '</p>'; }).join('') + (cite ? '<footer>— ' + inline(cite) + '</footer>' : '') + '</blockquote>';
        i = j; prev = false; continue;
      }

      // ---- قوائم
      if ((m = raw.match(RE_LI))) {
        var items = []; j = i;
        while (j < L.length && (m = L[j].match(RE_LI)) && !RE_HR.test(L[j])) {
          var tx = m[3], tk = tx.match(/^\[([ xX✓✔])\]\s+(.*)$/), ord = /^[\d٠-٩]/.test(m[2]);
          items.push({ ind: ind(m[1]), ord: ord, num: ord ? arNum(m[2]) : 0, task: !!tk, done: !!tk && tk[1] !== ' ', text: tk ? tk[2] : tx });
          j++;
        }
        out += listHtml(items, ctx); i = j; prev = false; continue;
      }

      // ---- فقرة (أو عنوان بالسطر القصير للتوافق مع المقالات القديمة)
      a = takeAttrs(l);
      var nx = (L[i + 1] || '').trim();
      if (!a.found && prev && nx && l.length <= 70 && !/[.،,؛:!؟?…"”»)]$/.test(l) && !/^(?:`{3,}|~{3,}|:{3,}|\|)/.test(nx)) {
        out += heading(2, l, ctx);
      } else if (a.text.trim()) {
        ctx.text.push(strip(a.text));
        out += '<p' + attrStr(a) + '>' + inline(a.text) + '</p>';
      }
      i++; prev = false;
    }
    return out;
  }

  /* -------------------------------------------------------------- sanitizer */
  var TAGS = {
    p: 1, br: 1, h1: 1, h2: 1, h3: 1, h4: 1, a: 1, strong: 1, em: 1, u: 1, s: 1, mark: 1, sub: 1, sup: 1, code: 1, pre: 1, span: 1, div: 1, ul: 1, ol: 1, li: 1,
    blockquote: 1, footer: 1, hr: 1, figure: 1, figcaption: 1, img: 1, table: 1, thead: 1, tbody: 1, tr: 1, th: 1, td: 1, details: 1, summary: 1, aside: 1,
    iframe: 1, video: 1, input: 1, button: 1
  };
  var VOID = { br: 1, hr: 1, img: 1, input: 1 };
  var CLS_OK = /^(?:ta-[rlcj]|al-[lcr]|md|vid|anc|co|co-(?:info|tip|warning|danger|note)|co-[htb]|acc|acc-b|cb|cb-h|cb-l|cb-f|cb-nl|cb-copy|cb-ok|l|t-(?:k|s|c|n|f|a|t|ins|del)|tw|task|done|q-(?:classic|pull|card|minimal)|lc|lc-img|lc-b|lc-t|lc-d|lc-u|lang-[\w+#.-]{1,20}|rich|ld)$/;
  var IFRAME_OK = /^https:\/\/(?:www\.youtube-nocookie\.com\/embed\/[\w-]{11}(?:\?start=\d{1,6})?|player\.vimeo\.com\/video\/\d+|www\.dailymotion\.com\/embed\/video\/[a-z0-9]+|www\.facebook\.com\/plugins\/video\.php\?show_text=false&href=[\w%.~-]+)$/i;
  var STYLE_OK = /^(?:\s*(?:color|background-color)\s*:\s*#[0-9a-f]{3,8}\s*;?|\s*width\s*:\s*\d{1,3}%\s*;?)+\s*$/i;
  var ID_OK = /^[\p{L}\p{N}_-]{1,80}$/u;
  var ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', colon: ':', tab: '\t', newline: '\n', sol: '/', lpar: '(', rpar: ')' };
  var decode = function (s) {
    return String(s).replace(/&(?:#x([0-9a-f]+)|#(\d+)|([a-z]+));?/gi, function (m, h, d, n) {
      if (h || d) { var c = parseInt(h || d, h ? 16 : 10); return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : ''; }
      return ENT[n.toLowerCase()] !== undefined ? ENT[n.toLowerCase()] : m;
    });
  };
  var URL_ATTR = {
    a: function (v) { return safeUrl(v) || (/^#/.test(v) ? v : ''); },
    img: function (v) { return isImgUrl(v) ? v : ''; },
    iframe: function (v) { return IFRAME_OK.test(v) ? v : ''; },
    video: function (v) { return /^(?:https?:\/\/|\/api\/img\/)[^\s"'<>]+$/i.test(v) ? v : ''; }
  };
  var ATTRS = {
    '*': ['class', 'id', 'dir', 'style', 'title'],
    a: ['href', 'target', 'rel', 'aria-label'], img: ['src', 'alt', 'width', 'height', 'loading', 'decoding'],
    iframe: ['src', 'allow', 'allowfullscreen', 'referrerpolicy', 'loading'], video: ['src', 'controls', 'preload', 'playsinline'],
    input: ['type', 'disabled', 'checked'], ol: ['start'], figure: ['data-lang'], pre: ['tabindex'], div: ['tabindex'], button: ['type', 'aria-label']
  };
  function cleanAttr(tag, name, val) {
    name = name.toLowerCase();
    var ok = ATTRS['*'].indexOf(name) > -1 || (ATTRS[tag] && ATTRS[tag].indexOf(name) > -1);
    if (!ok) return null;
    var v = decode(val == null ? '' : val).replace(/[\u0000-\u001F\u007F]/g, ' ');
    switch (name) {
      case 'class': var cs = v.split(/\s+/).filter(function (c) { return CLS_OK.test(c); }); return cs.length ? cs.join(' ') : null;
      case 'id': return ID_OK.test(v) ? v : null;
      case 'dir': return DIRS[v] ? v : null;
      case 'style': return STYLE_OK.test(v) ? v : null;
      case 'title': case 'alt': case 'aria-label': return v.slice(0, 300);
      case 'href': case 'src': var f = URL_ATTR[tag]; v = f ? f(v.trim()) : ''; return v || null;
      case 'target': return v === '_blank' ? v : null;
      case 'rel': return /^[a-z ]{1,40}$/i.test(v) ? v : null;
      case 'width': case 'height': case 'start': return /^\d{1,5}$/.test(v) ? v : null;
      case 'loading': return /^(?:lazy|eager)$/.test(v) ? v : null;
      case 'decoding': return /^(?:async|auto|sync)$/.test(v) ? v : null;
      case 'allow': return /^[a-z\-; ]{1,200}$/i.test(v) ? v : null;
      case 'referrerpolicy': return /^[a-z-]{1,40}$/.test(v) ? v : null;
      case 'preload': return /^(?:none|metadata|auto)$/.test(v) ? v : null;
      case 'type': return tag === 'input' ? (v === 'checkbox' ? v : null) : (tag === 'button' && v === 'button' ? v : null);
      case 'data-lang': return /^[\w+#.-]{1,20}$/.test(v) ? v : null;
      case 'tabindex': return v === '0' ? v : null;
      default: return ''; // خصائص منطقية: allowfullscreen / controls / disabled / checked / playsinline
    }
  }
  var BOOL = { allowfullscreen: 1, controls: 1, disabled: 1, checked: 1, playsinline: 1 };
  var RE_TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^\s"'<>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'`=<>]+))?)*)\s*(\/?)>|<!--[\s\S]*?-->|[<>]/g;
  var RE_ATTR = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+)))?/g;

  /** تنظيف HTML بقائمة سماح صارمة: وسوم وخصائص وقيم محددة فقط */
  function sanitizeHTML(html) {
    html = String(html == null ? '' : html);
    var out = '', last = 0, m, tag, attrs, am, name, val, cv, s, closing;
    RE_TAG.lastIndex = 0;
    while ((m = RE_TAG.exec(html))) {
      out += html.slice(last, m.index).replace(/[<>]/g, function (c) { return c === '<' ? '&lt;' : '&gt;'; });
      last = RE_TAG.lastIndex;
      if (!m[2]) { if (m[0] === '<') out += '&lt;'; else if (m[0] === '>') out += '&gt;'; continue; } // تعليق أو محرف شارد
      tag = m[2].toLowerCase(); closing = !!m[1];
      if (!TAGS[tag]) continue; // وسم غير مسموح: يُحذف ويبقى محتواه نصاً
      if (closing) { if (!VOID[tag]) out += '</' + tag + '>'; continue; }
      s = '<' + tag; attrs = m[3] || ''; RE_ATTR.lastIndex = 0;
      var seen = {};
      while ((am = RE_ATTR.exec(attrs))) {
        name = am[1].toLowerCase(); if (seen[name]) continue;
        val = am[2] !== undefined ? am[2] : am[3] !== undefined ? am[3] : am[4];
        cv = cleanAttr(tag, name, val);
        if (cv === null) continue;
        seen[name] = 1;
        s += BOOL[name] ? ' ' + name : ' ' + name + '="' + esc(cv) + '"';
      }
      if (tag === 'a' && seen.target) { s = s.replace(/ rel="[^"]*"/, ''); s += ' rel="noopener noreferrer"'; }
      if ((tag === 'iframe' || tag === 'img') && !seen.src) continue;
      out += s + '>';
    }
    out += html.slice(last).replace(/[<>]/g, function (c) { return c === '<' ? '&lt;' : '&gt;'; });
    return out;
  }

  /* ---------------------------------------------------------- public: render */
  function countWords(text) { return (String(text).match(/\S+/g) || []).length; }
  var minutesOf = function (w) { return w ? Math.max(1, Math.ceil(w / 200)) : 0; }; // وقت القراءة = الكلمات ÷ 200

  function render(src, opts) {
    opts = opts || {};
    var ctx = { heads: [], used: Object.create(null), text: [], depth: 0 };
    var html = blocks(normalize(src).replace(/[\u0001\u0002]/g, '').split('\n'), ctx);
    var text = ctx.text.join(' ').replace(/\s+/g, ' ').trim(), words = countWords(text);
    return { html: sanitizeHTML(html), headings: ctx.heads, text: text, words: words, minutes: minutesOf(words) };
  }

  /** عدّ سريع للكلمات بدون توليد HTML (للقوائم والإحصاءات) */
  function plainQuick(src) {
    var s = normalize(src);
    s = s.replace(/^(\s*)(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n\1?\2[ \t]*(?:\n|$)|$)/gm, '\n');
    return s.split('\n').map(function (l) {
      l = l.trim(); if (!l || /^:{3,}\s*\S*\s*(?:\{open\})?$/.test(l) || RE_HR.test(l) || RE_SEP.test(l) || /^!\[[^\]]*\]\([^)]*\)\s*(?:\{[^}]*\})?$/.test(l) || RE_VID.test(l)) return '';
      var c = l.match(RE_CARD); if (c) return (c[2] || '').split('|').slice(0, 2).join(' ');
      l = l.replace(/^#{1,4}\s+/, '').replace(/^>\s?(?:\[!\w+\]\s*)?/, '').replace(/^:{3,}\s*\S+\s*/, '').replace(/^[ \t]*(?:[-•*]|\d{1,4}[.)]|[٠-٩]{1,4}[.)])\s+(?:\[[ xX]\]\s+)?/, '').replace(/(?:\s*\{[^{}]*\})+\s*$/, '');
      if (l.indexOf('|') > -1) l = l.replace(/\|/g, ' ');
      return strip(l);
    }).join(' ').replace(/\s+/g, ' ').trim();
  }
  function stats(src) {
    var t = plainQuick(src), w = countWords(t);
    return { words: w, chars: t.replace(/\s/g, '').length, minutes: minutesOf(w), text: t };
  }

  /** تنظيف المصدر قبل الحفظ: محارف تحكم، روابط خطرة. الـ HTML الخام يبقى مُهرَّباً عند العرض دائماً */
  function cleanSource(src) {
    var s = normalize(src).replace(/[\u0001\u0002]/g, '');
    s = s.replace(/(\]\()\s*([^\s)]+)/g, function (m, p, u) { return safeUrl(u) || u === '' ? m : p + '#'; });
    s = s.replace(/^(\s*@(?:video|فيديو|card|بطاقة)\s+)(\S+)/gim, function (m, p, u) { return safeUrl(u) ? m : p + '#'; });
    s = s.replace(/^(\s*!\[[^\]]*\]\(\s*)(\S+?)(\s|\))/gm, function (m, p, u, e) { return isImgUrl(u) ? m : p + '#' + e; });
    return s.replace(/[ \t]+$/gm, function (m) { return m.length > 1 ? ' ' : m; });
  }

  /* ----------------------------------------------------- client: enhancements */
  var enhanced = false;
  function copyText(t) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(t);
    return new Promise(function (ok, no) {
      try { var a = document.createElement('textarea'); a.value = t; a.style.cssText = 'position:fixed;opacity:0'; document.body.appendChild(a); a.select(); document.execCommand('copy'); a.remove(); ok(); } catch (e) { no(e); }
    });
  }
  function lightbox(img) {
    var fig = img.closest('figure'), cap = fig && fig.querySelector('figcaption'), box = document.createElement('div'), last = document.activeElement;
    box.className = 'rich-lb'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', 'عرض الصورة');
    var im = document.createElement('img'); im.src = img.currentSrc || img.src; im.alt = img.alt || '';
    var b = document.createElement('button'); b.type = 'button'; b.className = 'rich-lb-x'; b.setAttribute('aria-label', 'إغلاق'); b.textContent = '✕';
    box.appendChild(im); box.appendChild(b);
    if (cap && cap.textContent) { var c = document.createElement('div'); c.className = 'rich-lb-c'; c.textContent = cap.textContent; box.appendChild(c); }
    var close = function () { document.removeEventListener('keydown', onKey, true); box.remove(); document.documentElement.classList.remove('rich-lb-on'); if (last && last.focus) last.focus(); };
    var onKey = function (e) { if (e.key === 'Escape') { e.preventDefault(); close(); } else if (e.key === 'Tab') { e.preventDefault(); b.focus(); } };
    box.addEventListener('click', function (e) { if (e.target !== im) close(); });
    document.addEventListener('keydown', onKey, true);
    document.documentElement.classList.add('rich-lb-on'); document.body.appendChild(box); b.focus();
  }
  function initGlobal() {
    if (enhanced || typeof document === 'undefined') return; enhanced = true;
    document.addEventListener('click', function (e) {
      var t = e.target; if (!t || !t.closest) return;
      var cp = t.closest('.cb-copy');
      if (cp) {
        var code = cp.closest('.cb').querySelector('code'), old = cp.getAttribute('data-l') || cp.textContent;
        cp.setAttribute('data-l', old);
        copyText(code ? code.textContent : '').then(function () { cp.textContent = 'تم النسخ ✓'; cp.classList.add('cb-ok'); }, function () { cp.textContent = 'تعذّر النسخ'; });
        clearTimeout(cp._t); cp._t = setTimeout(function () { cp.textContent = old; cp.classList.remove('cb-ok'); }, 1800);
        return;
      }
      var an = t.closest('a.anc');
      if (an) {
        e.preventDefault();
        var id = an.getAttribute('href').slice(1), url = location.origin + location.pathname + location.search + '#' + encodeURIComponent(id), h = document.getElementById(id);
        try { history.replaceState(null, '', '#' + encodeURIComponent(id)); } catch (x) { }
        if (h) h.scrollIntoView({ behavior: 'smooth', block: 'start' });
        copyText(url).then(function () { an.classList.add('cb-ok'); an.setAttribute('data-tip', 'تم نسخ الرابط'); setTimeout(function () { an.classList.remove('cb-ok'); an.removeAttribute('data-tip'); }, 1600); }, function () { });
        return;
      }
      var im = t.closest('.rich figure.md img');
      if (im && !t.closest('a')) lightbox(im);
    });
  }
  /** يُفعِّل التفاعل داخل عنصر العرض: أزرار النسخ، lightbox، مؤشرات تحميل الصور */
  function enhance(el) {
    if (typeof document === 'undefined' || !el) return;
    initGlobal();
    el.classList.add('rich');
    Array.prototype.forEach.call(el.querySelectorAll('.cb-h'), function (h) {
      if (h.querySelector('.cb-copy')) return;
      var b = document.createElement('button'); b.type = 'button'; b.className = 'cb-copy'; b.setAttribute('aria-label', 'نسخ الكود'); b.textContent = 'نسخ'; h.appendChild(b);
    });
    Array.prototype.forEach.call(el.querySelectorAll('figure.md img'), function (im) {
      im.setAttribute('tabindex', '0'); im.style.cursor = 'zoom-in';
      im.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); lightbox(im); } });
    });
    el.addEventListener('load', function (e) { if (e.target.tagName === 'IMG') e.target.classList.add('ld'); }, true);
    el.addEventListener('error', function (e) { if (e.target.tagName === 'IMG') e.target.classList.add('ld'); }, true);
  }

  return {
    render: render, stats: stats, words: function (s) { return stats(s).words; }, plainText: function (s) { return plainQuick(s); },
    cleanSource: cleanSource, sanitizeHTML: sanitizeHTML, safeUrl: safeUrl, slugId: slugId, videoEmbed: videoEmbed, strip: strip,
    highlightLines: highlightLines, enhance: enhance, minutesOf: minutesOf, esc: esc, LANG_LIST: LANG_LIST, LABEL: LABEL
  };
});
