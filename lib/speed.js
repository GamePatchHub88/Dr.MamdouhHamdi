'use strict';
/* =====================================================================
   فحص سرعة الموقع (إدارة الموقع ← فحص السرعة)
   - كل المسارات تحت /api/admin/speed/* ومحمية بصلاحية المدير (JWT)
   - يُسجَّل آخر 20 فحصاً في مجموعة speedruns (MongoDB)
   - لا يعتمد على أي حزمة جديدة (fetch و performance مدمجان في Node 22)
   ===================================================================== */
const crypto = require('crypto');

const RATE_MS = 30e3;        // فحص واحد كل 30 ثانية
const KEEP = 20;             // عدد الفحوصات المحفوظة
const DEADLINE_MS = 25e3;    // سقف زمني كلي للفحص (maxDuration في vercel.json = 30 ث)

/* ---------- أدوات صغيرة ---------- */
const now = () => performance.now();
const ri = x => Math.round(x);
const r1 = x => Math.round(x * 10) / 10;
const med = a => { const s = a.filter(x => Number.isFinite(x)).sort((x, y) => x - y), n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };
const kb = b => b == null ? '—' : b >= 1048576 ? r1(b / 1048576) + ' MB' : r1(b / 1024) + ' KB';
const ms = v => v == null ? '—' : ri(v) + ' ms';
/* تقييم: ≤e ممتاز، ≤g جيد، غير ذلك بطيء */
const RT = (v, e, g) => v <= e ? 'excellent' : v <= g ? 'good' : 'slow';
/* درجة 0..100: 100 حتى e، ثم تنزل إلى 60 عند g، ثم إلى 0 عند 3g */
const SC = (v, e, g) => v <= e ? 100 : v <= g ? 100 - (v - e) / (g - e) * 40 : Math.max(0, 60 - (v - g) / (2 * g) * 60);
const worse = (a, b) => { const o = ['excellent', 'good', 'slow']; return o[Math.max(o.indexOf(a), o.indexOf(b))]; };
const grade = s => s >= 90 ? 'ممتاز' : s >= 75 ? 'جيد' : s >= 50 ? 'متوسط — يحتاج تحسين' : 'ضعيف';

/* ---------- مناطق Vercel والقارات ---------- */
const CONT = { NA: 'أمريكا الشمالية', SA: 'أمريكا الجنوبية', EU: 'أوروبا', ME: 'الشرق الأوسط', AS: 'آسيا', OC: 'أوقيانوسيا', AF: 'أفريقيا' };
const VREG = {
  iad1: ['واشنطن — أمريكا', 'NA'], cle1: ['كليفلاند — أمريكا', 'NA'], sfo1: ['سان فرانسيسكو — أمريكا', 'NA'], pdx1: ['بورتلاند — أمريكا', 'NA'],
  dub1: ['دبلن — أيرلندا', 'EU'], lhr1: ['لندن — بريطانيا', 'EU'], cdg1: ['باريس — فرنسا', 'EU'], fra1: ['فرانكفورت — ألمانيا', 'EU'], arn1: ['ستوكهولم — السويد', 'EU'],
  dxb1: ['دبي — الإمارات', 'ME'], bom1: ['مومباي — الهند', 'AS'], sin1: ['سنغافورة', 'AS'], hnd1: ['طوكيو — اليابان', 'AS'], kix1: ['أوساكا — اليابان', 'AS'], icn1: ['سول — كوريا', 'AS'], hkg1: ['هونغ كونغ', 'AS'],
  syd1: ['سيدني — أستراليا', 'OC'], gru1: ['ساو باولو — البرازيل', 'SA'], cpt1: ['كيب تاون — جنوب أفريقيا', 'AF']
};
const NEAR = { EU: 'fra1', NA: 'iad1', AS: 'sin1', ME: 'dxb1', OC: 'syd1', SA: 'gru1', AF: 'cpt1' }; // منطقة Vercel المقترحة لكل قارة
/* استنتاج القارة من نص منطقة القاعدة (aws-eu-central-1 / europe-west1 / westeurope / me-central-1 ...) */
const contOf = t => {
  t = String(t || '').toLowerCase(); if (!t) return null;
  const T = [['OC', /australia|sydney|melbourne|newzealand|ap-southeast-[24]\b/], ['ME', /\bme-|uae|dubai|qatar|bahrain|israel|saudi|middle ?east/], ['AF', /\baf-|southafrica|cape ?town|johannesburg|africa/],
    ['SA', /\bsa-|southamerica|brazil|sao[-_ ]?paulo|chile|santiago/], ['EU', /\beu-|europe|uksouth|ukwest|germany|frankfurt|ireland|london|paris|france|sweden|stockholm|milan|spain|zurich|swiss|netherlands|belgium|finland|warsaw|poland|norway/],
    ['AS', /\bap-|asia|japan|tokyo|osaka|seoul|korea|india|mumbai|singapore|hong ?kong|taiwan|indonesia|jakarta/], ['NA', /\b(us|ca)-(east|west|central|north|south)|eastus|westus|centralus|canada|northamerica|virginia|oregon|ohio|iowa|california|texas|\bus\b/]];
  for (const [c, re] of T) if (re.test(t)) return c; return null;
};

/* منطقة Vercel المكافئة لمنطقة القاعدة (إن عُرفت) — لمعرفة هل هما في نفس المنطقة تماماً */
const vercelOf = t => {
  t = String(t || '').toLowerCase();
  const M = [['fra1', /eu-central-1|germany|frankfurt|europe-west3/], ['dub1', /eu-west-1\b|northeurope|ireland|europe-west1\b/], ['lhr1', /eu-west-2|uksouth|london|europe-west2/], ['cdg1', /eu-west-3|francecentral|paris|europe-west9/],
    ['arn1', /eu-north-1|swedencentral|stockholm|europe-north1/], ['iad1', /us-east-1|eastus\b|virginia|us-east4/], ['cle1', /us-east-2|ohio/], ['sfo1', /us-west-1|california|us-west2/], ['pdx1', /us-west-2|oregon|westus2|us-west1/],
    ['dxb1', /me-central-1|uaenorth|dubai/], ['sin1', /ap-southeast-1|singapore/], ['hnd1', /ap-northeast-1|japaneast|tokyo/], ['bom1', /ap-south-1|centralindia|mumbai/], ['syd1', /ap-southeast-2|australiaeast|sydney/], ['gru1', /sa-east-1|brazilsouth|sao[-_ ]?paulo/], ['cpt1', /af-south-1|southafricanorth|cape ?town/]];
  for (const [v, re] of M) if (re.test(t)) return v; return null;
};

/* ---------- HTML helpers ---------- */
const attr = (tag, n) => { const m = new RegExp('(?:^|\\s)' + n + '\\s*=\\s*("([^"]*)"|\'([^\']*)\')', 'i').exec(tag); return m ? (m[2] != null ? m[2] : m[3]) : null; };
const tags = (html, name) => String(html || '').match(new RegExp('<' + name + '\\b[^>]*>', 'gi')) || [];
const fmtOf = ct => { ct = String(ct || '').toLowerCase(); return /webp/.test(ct) ? 'webp' : /avif/.test(ct) ? 'avif' : /jpe?g/.test(ct) ? 'jpeg' : /png/.test(ct) ? 'png' : /gif/.test(ct) ? 'gif' : /svg/.test(ct) ? 'svg' : /icon/.test(ct) ? 'ico' : (ct.split('/')[1] || '—'); };
const MODERN = new Set(['webp', 'avif', 'svg']);

/* ---------- طلب HTTP مع قياس TTFB والزمن الكامل ---------- */
async function timed(url, { timeout = 5000, headers = {}, method = 'GET', readBody = true } = {}) {
  const t0 = now();
  const res = await fetch(url, { method, headers: { 'user-agent': 'SpeedCheck/1.0', accept: '*/*', ...headers }, redirect: 'follow', signal: AbortSignal.timeout(timeout) });
  const ttfb = now() - t0; let bytes = 0, text = '';
  if (readBody) {
    const buf = Buffer.from(await res.arrayBuffer()); bytes = buf.length;
    if (/text|json|xml|javascript/i.test(res.headers.get('content-type') || '')) text = buf.toString('utf8');
  } else { try { await res.body.cancel(); } catch (e) { } }
  return { status: res.status, ok: res.ok, ttfb, total: now() - t0, bytes, text, h: res.headers };
}
const hdr = h => ({ enc: (h.get('content-encoding') || '').toLowerCase(), cc: h.get('cache-control') || '', vc: h.get('x-vercel-cache') || '', age: +h.get('age') || 0, len: h.get('content-length') ? +h.get('content-length') : null, ct: h.get('content-type') || '' });
/* تصنيف الكاش: cdn / browser / none / no-store */
const classify = x => {
  const cc = (x.cc || '').toLowerCase(), sm = /s-maxage=(\d+)/.exec(cc), ma = /(?:^|[\s,])max-age=(\d+)/.exec(cc);
  if (/no-store|private/.test(cc) && !(sm && +sm[1] > 0)) return 'no-store';
  if ((sm && +sm[1] > 0) || /^(HIT|STALE|PRERENDER)$/i.test(x.vc)) return 'cdn';
  if (ma && +ma[1] > 0) return 'browser';
  return 'none';
};
const CLS = { cdn: 'مخزّن على CDN', browser: 'كاش المتصفح فقط', none: 'ديناميكي بالكامل (بلا كاش)', 'no-store': 'ممنوع الكاش' };

/* ---------- تشغيل اختبار واحد بمهلة؛ الفشل لا يوقف البقية ---------- */
const withT = (p, t) => { let id; return Promise.race([p, new Promise((_, j) => { id = setTimeout(() => j(Object.assign(new Error('timeout'), { timeout: true })), t); })]).finally(() => clearTimeout(id)); };
async function exec(def, ctx) {
  const base = { id: def.id, group: def.group, label: def.label, weight: def.weight };
  const t0 = now();
  if (Date.now() > ctx.deadline) return { ...base, rating: 'failed', score: null, display: 'تعذّر', error: 'تجاوز الحدّ الزمني الكلي للفحص', took: 0 };
  try {
    const r = await withT(Promise.resolve().then(def.fn), def.timeout || 5000);
    return { ...base, rating: 'na', score: null, ...r, took: ri(now() - t0) };
  } catch (e) {
    const msg = e && e.timeout ? 'انتهت المهلة (' + (def.timeout || 5000) / 1000 + ' ث)' : (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) ? 'انتهت المهلة' : String((e && e.message) || e).slice(0, 160);
    return { ...base, rating: 'failed', score: null, display: 'تعذّر', error: msg, took: ri(now() - t0) };
  }
}

/* ===================================================================== */
function boot() { return { at: Date.now(), id: crypto.randomBytes(3).toString('hex'), n: 0, dbMs: null }; }

/* يُسجَّل قبل middleware الاتصال بالقاعدة: قياس شبكة خالص (لا يمرّ بالقاعدة) */
function early(app, { jwt, BOOT }) {
  app.get('/api/admin/speed/ping', (q, s) => {
    try { jwt.verify((q.headers.authorization || '').slice(7), process.env.JWT_SECRET); } catch (e) { return s.sendStatus(401); }
    s.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' });
    s.json({ t: Date.now(), up: r1((Date.now() - BOOT.at) / 1000), id: BOOT.id, region: process.env.VERCEL_REGION || null });
  });
}

function schema(mongoose) {
  const M = mongoose.Schema.Types.Mixed;
  const S = new mongoose.Schema({ score: Number, grade: String, partial: Boolean, headline: String, durationMs: Number, tests: [M], diagnosis: M, metrics: M, env: M },
    { timestamps: { createdAt: true, updatedAt: false }, minimize: false });
  S.index({ createdAt: -1 });
  return S;
}

/* ===================================================================== */
function mount(app, D) {
  const { mongoose, auth, h, Item, Setting, Img, BOOT } = D;
  const Run = mongoose.models.SpeedRun || mongoose.model('SpeedRun', schema(mongoose));
  let busy = false, lastStart = 0;

  const baseUrl = q => {
    const site = (process.env.SITE_URL || '').replace(/\/+$/, ''); if (site) return site;
    const host = String(q.headers['x-forwarded-host'] || q.headers.host || '').split(',')[0].trim();
    const proto = /^(localhost|127\.|\[::1\])/.test(host) ? 'http' : String(q.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
    return proto + '://' + host;
  };

  /* يستدعيه فحص Cold Start عبر الشبكة (يمرّ بـ middleware القاعدة كأي طلب حقيقي) */
  app.get('/api/admin/speed/health', auth, (q, s) => { s.set('Cache-Control', 'no-store'); s.json({ ok: 1, id: BOOT.id, up: r1((Date.now() - BOOT.at) / 1000), n: BOOT.n, dbMs: BOOT.dbMs }); });

  app.get('/api/admin/speed/history', auth, h(async (q, s) => {
    s.set('Cache-Control', 'no-store');
    s.json(await Run.find().sort('-createdAt').limit(KEEP).select('score grade partial headline durationMs metrics createdAt env.vercelRegion').lean());
  }));
  app.get('/api/admin/speed/run/:id', auth, h(async (q, s) => {
    s.set('Cache-Control', 'no-store');
    if (!mongoose.isValidObjectId(q.params.id)) return s.sendStatus(404);
    const r = await Run.findById(q.params.id).lean(); r ? s.json(r) : s.sendStatus(404);
  }));

  app.post('/api/admin/speed/run', auth, h(async (q, s) => {
    s.set('Cache-Control', 'no-store');
    const t = Date.now(), wait = () => Math.max(1, Math.ceil((RATE_MS - (Date.now() - lastStart)) / 1000));
    if (busy) return s.status(429).json({ error: 'busy', retryAfter: 5 });
    if (t - lastStart < RATE_MS) return s.status(429).json({ error: 'rate', retryAfter: wait() });
    const last = await Run.findOne().sort('-createdAt').select('createdAt').lean();
    if (last && t - new Date(last.createdAt).getTime() < RATE_MS) return s.status(429).json({ error: 'rate', retryAfter: Math.max(1, Math.ceil((RATE_MS - (t - new Date(last.createdAt).getTime())) / 1000)) });
    busy = true; lastStart = t;
    try {
      const out = await execute(q);
      const doc = await Run.create(out);
      const keep = await Run.find().sort('-createdAt').limit(KEEP).select('_id').lean();
      await Run.deleteMany({ _id: { $nin: keep.map(x => x._id) } });
      s.json(doc.toObject());
    } finally { busy = false; }
  }));

  /* ------------------------------------------------------------------ */
  async function execute(q) {
    const started = Date.now();
    const o = baseUrl(q), rttIn = (q.body && q.body.rtt) || {};
    const samples = (Array.isArray(rttIn.samples) ? rttIn.samples : []).map(Number).filter(x => Number.isFinite(x) && x > 0 && x < 60000).slice(0, 10);
    const ctx = {
      o, auth: q.headers.authorization || '', deadline: started + DEADLINE_MS, pages: {}, homeHtml: '', inst: null,
      rtt: { samples, first: rttIn.first != null && Number.isFinite(+rttIn.first) ? +rttIn.first : null, firstUp: rttIn.firstUp != null && Number.isFinite(+rttIn.firstUp) ? +rttIn.firstUp : null }
    };
    const T = [], push = r => { T.push(r); return r; };
    const run = async defs => { const r = await Promise.all(defs.map(d => exec(d, ctx))); r.forEach(push); return r; };
    const db = () => mongoose.connection.db;

    /* ===== 1) قاعدة البيانات ===== */
    const dPing = {
      id: 'db.ping', group: 'db', label: 'استعلام بسيط (ping — يعادل SELECT 1)', weight: 6, timeout: 4000, fn: async () => {
        const a = []; for (let i = 0; i < 5; i++) { const t0 = now(); await db().command({ ping: 1 }); a.push(now() - t0); }
        const warm = a.slice(1), m = med(warm), mn = Math.min(...warm);
        ctx.ping = m;
        return { ms: ri(m), display: ms(m), rating: RT(m, 20, 60), score: SC(m, 20, 60), raw: { median: r1(m), min: r1(mn), first: r1(a[0]), samples: a.map(r1) },
          rows: [['الوسيط (4 قياسات دافئة)', ms(m)], ['الأقل', ms(mn)], ['أول قياس', ms(a[0])]], note: 'الزمن الذهاب والإياب لشبكة الاتصال بالقاعدة — يعكس بُعد المنطقة أكثر مما يعكس أداء القاعدة.' };
      }
    };
    const dConn = {
      id: 'db.connect', group: 'db', label: 'زمن فتح اتصال جديد بالقاعدة', weight: 4, timeout: 5000, fn: async () => {
        const c = mongoose.createConnection(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 4000, maxPoolSize: 1 });
        try {
          const t0 = now(); await c.asPromise(); const connectMs = now() - t0;
          const t1 = now(); await c.db.command({ ping: 1 }); const execMs = now() - t1;
          return { ms: ri(connectMs), display: 'اتصال ' + ms(connectMs) + ' · تنفيذ ' + ms(execMs), rating: RT(connectMs, 300, 900), score: SC(connectMs, 300, 900), raw: { connectMs: r1(connectMs), execMs: r1(execMs) },
            rows: [['زمن الاتصال (TLS + مصادقة + اكتشاف الخوادم)', ms(connectMs)], ['زمن تنفيذ أول أمر على الاتصال الجديد', ms(execMs)], ['زمن الاتصال الأصلي لهذه الـ instance', BOOT.dbMs != null ? ms(BOOT.dbMs) : '—']],
            note: 'هذا الزمن يُدفع مرة واحدة عند كل Cold Start، أما بقية الطلبات فتعيد استخدام الاتصال.' };
        } finally { try { await c.close(); } catch (e) { } }
      }
    };
    const dQuery = {
      id: 'db.query', group: 'db', label: 'استعلامات حقيقية من جداول الموقع', weight: 12, timeout: 5000, fn: async () => {
        const flt = { type: 'article', draft: { $ne: true } };
        let t0 = now(); const items = await Item.find(flt).sort('-createdAt').limit(20).lean(); const q1 = now() - t0;
        t0 = now(); await Setting.find().lean(); const q2 = now() - t0;
        t0 = now(); const cnt = await Item.countDocuments(flt); const q3 = now() - t0;
        const bytes = Buffer.byteLength(JSON.stringify(items)), sum = q1 + q2 + q3;
        let ex = null;
        try {
          const e0 = await Item.find(flt).sort('-createdAt').limit(20).explain('executionStats'), e = Array.isArray(e0) ? e0[0] : e0, es = (e && e.executionStats) || {};
          ex = { collscan: /COLLSCAN/.test(JSON.stringify(e.queryPlanner && e.queryPlanner.winningPlan)), docs: es.totalDocsExamined, returned: es.nReturned, execMs: es.executionTimeMillis };
        } catch (e) { }
        const netPart = ex && ex.execMs != null ? Math.max(0, q1 - ex.execMs) : null;
        return { ms: ri(sum), display: ms(sum) + ' (3 استعلامات)', rating: RT(sum, 80, 250), score: SC(sum, 80, 250),
          raw: { sum: r1(sum), itemsMs: r1(q1), settingsMs: r1(q2), countMs: r1(q3), itemsBytes: bytes, itemsCount: items.length, total: cnt, explain: ex },
          rows: [['قائمة آخر 20 مقالاً', ms(q1) + ' · ' + kb(bytes)], ['كل الإعدادات', ms(q2)], ['عدّ المقالات المنشورة (' + cnt + ')', ms(q3)],
            ['تنفيذ داخل القاعدة (explain)', ex && ex.execMs != null ? ms(ex.execMs) : 'غير متاح'], ['زمن الشبكة المقدّر للقائمة', netPart != null ? ms(netPart) : '—'],
            ['خطة التنفيذ', ex ? (ex.collscan ? 'مسح كامل COLLSCAN (' + ex.docs + ' وثيقة)' : 'فهرس IXSCAN (' + ex.docs + ' وثيقة)') : 'غير متاح']],
          note: bytes > 200 * 1024 ? 'قائمة المقالات تُرجع محتوى المقال كاملاً — حجمها كبير على الشبكة.' : undefined };
      }
    };
    const dConns = {
      id: 'db.conns', group: 'db', label: 'عدد الاتصالات المفتوحة', weight: 0, timeout: 4000, fn: async () => {
        try {
          const r = await db().admin().command({ serverStatus: 1 }), c = r.connections || {}, tot = (c.current || 0) + (c.available || 0), p = tot ? c.current / tot : 0;
          return { display: c.current + ' من ' + tot, rating: p <= .5 ? 'excellent' : p <= .8 ? 'good' : 'slow', score: null, raw: { current: c.current, available: c.available, total: tot, pct: r1(p * 100) },
            rows: [['الاتصالات الحالية', String(c.current)], ['المتاحة', String(c.available)], ['نسبة الاستهلاك', r1(p * 100) + '%'], ['أُنشئت منذ التشغيل', String(c.totalCreated != null ? c.totalCreated : '—')]] };
        } catch (e) {
          return { display: 'غير متاح', rating: 'na', score: null, note: 'المزوّد لا يسمح بأمر serverStatus (شائع في باقات Atlas المجانية M0)، وهذا لا يؤثر على الدرجة.', raw: {}, rows: [['حالة اتصال Mongoose', ['منقطع', 'متصل', 'جارٍ الاتصال', 'جارٍ القطع'][mongoose.connection.readyState] || '—']] };
        }
      }
    };
    await run([dPing]);
    await run([dConn, dQuery, dConns]);

    /* ===== 2) منطقة القاعدة مقابل منطقة السيرفر ===== */
    await run([{
      id: 'region', group: 'region', label: 'منطقة Vercel مقابل منطقة قاعدة البيانات', weight: 10, timeout: 2000, fn: async () => {
        const vr = process.env.VERCEL_REGION || null, vi = vr ? VREG[vr] : null, vCont = vi ? vi[1] : contOf(vr);
        const uri = process.env.MONGODB_URI || '';
        let dbRaw = (process.env.DB_REGION || '').trim(), src = dbRaw ? 'env' : null;
        if (!dbRaw && contOf(uri.replace(/^mongodb(\+srv)?:\/\/[^@]*@/, '').split(/[/?]/)[0])) { dbRaw = uri.replace(/^mongodb(\+srv)?:\/\/[^@]*@/, '').split(/[/?]/)[0]; src = 'uri'; }
        const dCont = contOf(dbRaw), ping = ctx.ping;
        let rating, score, cross = false, how = src, verdict;
        if (!vr) { rating = 'na'; score = null; verdict = 'يعمل خارج Vercel (بيئة محلية) فلا توجد منطقة سيرفر لمقارنتها.'; }
        else if (dCont && vCont) {
          cross = dCont !== vCont;
          const same = !cross && (vercelOf(dbRaw) === vr || (ping != null && ping <= 15));
          rating = cross ? 'slow' : same ? 'excellent' : 'good'; score = cross ? 20 : same ? 100 : 80;
          verdict = cross ? 'السيرفر في ' + CONT[vCont] + ' والقاعدة في ' + CONT[dCont] + ' — اختلاف دولي' + (ping != null ? ' (زمن الاتصال الفعلي ' + ms(ping) + ' لكل استعلام)' : '') + '.'
            : 'السيرفر والقاعدة في نفس القارة (' + CONT[vCont] + ').';
        } else if (ping != null) {
          how = 'latency'; rating = RT(ping, 15, 60); score = SC(ping, 15, 60); cross = ping > 80;
          verdict = 'منطقة القاعدة غير معلنة (أضف DB_REGION)؛ التقدير من زمن الاستجابة: ' + (ping <= 15 ? 'يبدو أنهما في نفس المنطقة.' : ping <= 60 ? 'قارة واحدة غالباً.' : 'غالباً في قارتين مختلفتين.');
        } else { rating = 'na'; score = null; verdict = 'تعذّر تحديد منطقة القاعدة.'; }
        return {
          display: (vr ? vr + (vi ? ' — ' + vi[0] : '') : 'محلي') + '  ↔  ' + (dbRaw ? (dbRaw.length > 28 ? dbRaw.slice(0, 26) + '…' : dbRaw) : 'غير معلنة'), rating, score,
          raw: { vercelRegion: vr, vercelCont: vCont || null, dbRegion: dbRaw || null, dbCont: dCont || null, source: how, cross, pingMs: ping != null ? r1(ping) : null, verdict, vercelEnv: process.env.VERCEL_ENV || null },
          rows: [['منطقة Vercel (VERCEL_REGION)', vr ? vr + (vi ? ' — ' + vi[0] : '') : 'غير متوفرة'], ['منطقة قاعدة البيانات', dbRaw || 'غير معلنة — أضف المتغير DB_REGION'], ['مصدر معلومة القاعدة', how === 'env' ? 'متغير DB_REGION' : how === 'uri' ? 'رابط الاتصال' : how === 'latency' ? 'تقدير من زمن ping' : '—'],
            ['القارة (سيرفر ↔ قاعدة)', (vCont ? CONT[vCont] : '—') + '  ↔  ' + (dCont ? CONT[dCont] : '—')], ['الخلاصة', verdict]],
          alert: cross ? verdict : undefined
        };
      }
    }]);

    /* ===== 3) Cold Start ===== */
    await run([{
      id: 'cold.start', group: 'cold', label: 'Cold Start: أول طلب مقابل طلب لاحق', weight: 8, timeout: 8000, fn: async () => {
        const u = o + '/api/admin/speed/health', H = { authorization: ctx.auth, 'cache-control': 'no-cache' };
        const a = await timed(u + '?a=' + Date.now(), { timeout: 4000, headers: H }), b = await timed(u + '?b=' + Date.now(), { timeout: 4000, headers: H });
        if (!a.ok || !b.ok) throw new Error('HTTP ' + (a.ok ? b.status : a.status));
        let ja = {}, jb = {}; try { ja = JSON.parse(a.text); jb = JSON.parse(b.text); } catch (e) { }
        const A = a.total, B = b.total, diff = A - B, up = r1((Date.now() - BOOT.at) / 1000);
        const fresh = ctx.rtt.firstUp != null ? ctx.rtt.firstUp < 15 : up < 15;
        ctx.cold = { diff };
        return { ms: ri(Math.max(0, diff)), display: 'أول ' + ms(A) + ' ← لاحق ' + ms(B), rating: RT(Math.max(0, diff), 150, 500), score: SC(Math.max(0, diff), 150, 500),
          raw: { first: r1(A), second: r1(B), diff: r1(diff), idA: ja.id || null, idB: jb.id || null, sameInstance: !!(ja.id && ja.id === jb.id), instanceUpSec: up, instanceRequests: BOOT.n, dbConnectMs: BOOT.dbMs, freshAtStart: fresh },
          rows: [['أول طلب', ms(A)], ['طلب لاحق', ms(B)], ['الفرق (تقدير Cold Start)', ms(diff)], ['نفس الـ instance؟', ja.id && jb.id ? (ja.id === jb.id ? 'نعم' : 'لا — instance مختلفة') : '—'],
            ['عمر هذه الـ instance', up + ' ث · ' + BOOT.n + ' طلب'], ['هل بدأ فحصك على instance جديدة؟', fresh ? 'نعم — حدث Cold Start فعلياً' : 'لا — كانت دافئة']],
          note: 'القياس تقريبي: الـ instance الحالية دافئة بحكم أنها تنفّذ الفحص. أعد الفحص بعد 15–20 دقيقة خمول لترى Cold Start حقيقياً في السجل.' };
      }
    }]);

    /* ===== 4) الصفحات الرئيسية (TTFB + التحميل الكامل) ===== */
    const artSlug = async () => { const i = await Item.findOne({ type: 'article', draft: { $ne: true }, slug: { $exists: true, $ne: '' } }).sort('-createdAt').select('slug').lean(); return i ? '/articles/' + encodeURIComponent(i.slug) : null; };
    const pageDef = (id, label, weight, getPath) => ({
      id, group: 'pages', label, weight, timeout: 9000, fn: async () => {
        const path = await getPath(); if (!path) return { display: 'لا توجد مقالات', rating: 'na', score: null, note: 'لا يوجد مقال منشور لقياس صفحة المقال.' };
        const url = o + path, a = await timed(url, { timeout: 6000 });
        if (!a.ok) throw new Error('HTTP ' + a.status + (a.status === 401 || a.status === 403 ? ' — قد تكون حماية النشر (Deployment Protection) تمنع الفحص الذاتي' : ''));
        let b = null; try { b = await timed(url, { timeout: 2500, readBody: false }); } catch (e) { }
        const ha = hdr(a.h), hb = b ? hdr(b.h) : null, cls = classify(hb || ha);
        const info = { path, status: a.status, ttfb: ri(a.ttfb), total: ri(a.total), bytes: a.bytes, enc: ha.enc, cc: ha.cc, vc: ha.vc, len: ha.len, warmTtfb: b ? ri(b.ttfb) : null, warmVc: hb ? hb.vc : '', warmCc: hb ? hb.cc : '', cls, json: /json/.test(ha.ct) };
        ctx.pages[id] = info; if (id === 'page.home') ctx.homeHtml = a.text;
        const r1_ = RT(a.ttfb, 200, 600), r2_ = RT(a.total, 500, 1500);
        return { ms: info.ttfb, display: 'TTFB ' + ms(a.ttfb) + ' · كامل ' + ms(a.total), rating: worse(r1_, r2_), score: Math.min(SC(a.ttfb, 200, 600), SC(a.total, 500, 1500)), raw: info,
          rows: [['TTFB (وصول أول بايت)', ms(a.ttfb)], ['زمن التحميل الكامل', ms(a.total)], ['الحجم بعد فك الضغط', kb(a.bytes)], ['TTFB للطلب الثاني', b ? ms(b.ttfb) : '—'], ['x-vercel-cache (أول / ثاني)', (ha.vc || '—') + ' / ' + ((hb && hb.vc) || '—')], ['Cache-Control', ha.cc || '— (غير محدد)']],
          note: 'يُقاس من داخل منطقة السيرفر إلى موقعك نفسه، أي دون شبكة الزائر.' };
      }
    });
    await run([
      pageDef('page.home', 'الصفحة الرئيسية /', 10, async () => '/'),
      pageDef('page.articles', 'قائمة المقالات /articles', 8, async () => '/articles'),
      pageDef('page.article', 'صفحة مقال', 6, artSlug),
      pageDef('api.main', 'API الرئيسي /api/items', 6, async () => '/api/items?type=article&limit=20')
    ]);

    /* ===== 5) الصور + الخدمات الخارجية + اختبارات مشتقة ===== */
    const imgDef = {
      id: 'images.home', group: 'images', label: 'الصور: الحجم والصيغة وطريقة التحميل', weight: 10, timeout: 8000, fn: async () => {
        const html = ctx.homeHtml, own = new URL(o).origin, refs = new Map();
        const add = (r, src) => { if (!r || /\$\{|\{\{|^data:/.test(r)) return; try { const u = new URL(r, o + '/'); if (u.origin !== own) return; const k = u.pathname; if (!refs.has(k)) refs.set(k, { path: k, src }); } catch (e) { } };
        const imgTags = tags(html, 'img');
        imgTags.forEach(t => add(attr(t, 'src'), 'html'));
        tags(html, 'link').forEach(t => { if (/preload/i.test(attr(t, 'rel') || '') && /image/i.test(attr(t, 'as') || '')) add(attr(t, 'href'), 'html'); });
        try { (await Setting.find({ key: { $in: ['img_hero', 'img_about', 'img_mark'] } }).lean()).forEach(x => add(x.value, 'setting')); } catch (e) { }
        try { (await Item.find({ type: 'article', draft: { $ne: true } }).sort('-createdAt').limit(6).select('image').lean()).forEach(x => add(x.image, 'article')); } catch (e) { }
        const list = [...refs.values()].slice(0, 14), ids = list.map(x => (/^\/api\/img\/([a-f0-9]{24})$/i.exec(x.path) || [])[1]).filter(Boolean);
        const dbm = new Map(); if (ids.length) { try { (await Img.find({ _id: { $in: ids } }).select('size type').lean()).forEach(x => dbm.set(String(x._id), x)); } catch (e) { } }
        const got = await Promise.all(list.map(async x => {
          const m = /^\/api\/img\/([a-f0-9]{24})$/i.exec(x.path);
          if (m) { const d = dbm.get(m[1]); return d ? { ...x, bytes: d.size || 0, fmt: fmtOf(d.type), cc: 'public,max-age=31536000,immutable' } : null; }
          try {
            let r = await timed(o + x.path, { method: 'HEAD', timeout: 3500, readBody: false }), hh = hdr(r.h);
            if (!r.ok) return null; let bytes = hh.len;
            if (bytes == null) { r = await timed(o + x.path, { timeout: 3500 }); bytes = r.bytes; hh = hdr(r.h); }
            return { ...x, bytes, fmt: fmtOf(hh.ct), cc: hh.cc };
          } catch (e) { return null; }
        }));
        const L = got.filter(Boolean).sort((a, b) => b.bytes - a.bytes);
        if (!L.length) return { display: 'لا صور', rating: 'na', score: null, note: 'لم تُوجد صور قابلة للقياس في الصفحة الرئيسية.' };
        const total = L.reduce((a, x) => a + x.bytes, 0), big = L[0], top3 = L.slice(0, 3).reduce((a, x) => a + x.bytes, 0), old = L.filter(x => !MODERN.has(x.fmt));
        const lazy = imgTags.filter(t => /loading\s*=\s*["']lazy/i.test(t)).length, dims = imgTags.filter(t => attr(t, 'width') && attr(t, 'height')).length, srcset = imgTags.filter(t => attr(t, 'srcset')).length;
        const rr = worse(RT(big.bytes / 1024, 150, 400), RT(total / 1024, 600, 1500)), sc = Math.min(SC(big.bytes / 1024, 150, 400), SC(total / 1024, 600, 1500));
        const nm = p => decodeURIComponent(p.split('/').pop() || p).slice(0, 40);
        return { display: 'الأكبر ' + kb(big.bytes) + ' · المجموع ' + kb(total), rating: rr, score: sc,
          raw: { count: L.length, largest: { name: nm(big.path), bytes: big.bytes, fmt: big.fmt }, totalBytes: total, top3Bytes: top3, nonModern: old.length, lazy, dims, srcset, tags: imgTags.length, nextImage: false,
            top: L.slice(0, 3).map(x => ({ name: nm(x.path), bytes: x.bytes, fmt: x.fmt })) },
          rows: [['عدد الصور المقاسة', String(L.length)], ['أكبر صورة', nm(big.path) + ' — ' + kb(big.bytes)], ['إجمالي الأحجام', kb(total)], ['صور ليست WebP/AVIF', old.length + ' من ' + L.length],
            ['وسوم img: lazy / width+height / srcset', lazy + ' / ' + dims + ' / ' + srcset + ' من ' + imgTags.length], ['next/image', 'غير مستخدم — المشروع Express وليس Next.js']],
          table: { cols: ['الصورة', 'الحجم', 'الصيغة', 'المصدر'], rows: L.slice(0, 8).map(x => [nm(x.path), kb(x.bytes), x.fmt, x.src === 'html' ? 'الصفحة' : x.src === 'setting' ? 'إعدادات' : 'غلاف مقال']) } };
      }
    };
    const extDef = {
      id: 'external.services', group: 'external', label: 'الخدمات الخارجية التي تعتمد عليها الصفحة', weight: 4, timeout: 7000, fn: async () => {
        const own = new URL(o).origin, urls = new Map();
        const add = (u, t) => { try { const x = new URL(u); if (/^https?:$/.test(x.protocol) && x.origin !== own && !urls.has(u)) urls.set(u, { url: u, host: x.hostname, kind: t }); } catch (e) { } };
        tags(ctx.homeHtml, 'link').forEach(t => { const rel = (attr(t, 'rel') || '').toLowerCase(); if (/stylesheet|preload/.test(rel)) add(attr(t, 'href'), 'css'); });
        tags(ctx.homeHtml, 'script').forEach(t => add(attr(t, 'src'), 'js'));
        const nice = hh => /fonts\.googleapis/.test(hh) ? 'Google Fonts' : /gstatic/.test(hh) ? 'Google Static' : hh;
        const L = [...urls.values()].slice(0, 5);
        if (!L.length) return { display: 'لا يوجد', rating: 'na', score: null, note: 'الصفحة الرئيسية لا تحمّل أي ملفات من خدمات خارجية (قاعدة البيانات تُقاس في قسمها).' };
        const res = await Promise.all(L.map(async x => { try { const r = await timed(x.url, { timeout: 4000, readBody: false }); return { ...x, name: nice(x.host), ttfb: ri(r.ttfb), ok: r.ok }; } catch (e) { return { ...x, name: nice(x.host), ttfb: null, ok: false }; } }));
        const okL = res.filter(x => x.ttfb != null), worst = okL.length ? Math.max(...okL.map(x => x.ttfb)) : null;
        if (worst == null) throw new Error('تعذّر الوصول إلى الخدمات الخارجية');
        return { ms: worst, display: 'أبطأ خدمة ' + ms(worst), rating: RT(worst, 300, 900), score: SC(worst, 300, 900), raw: { items: res.map(x => ({ name: x.name, ttfb: x.ttfb })) },
          rows: [['عدد الخدمات المقاسة', String(res.length)], ['فشل الوصول', res.filter(x => x.ttfb == null).length + ' خدمة']],
          table: { cols: ['الخدمة', 'النوع', 'زمن الاستجابة'], rows: res.map(x => [x.name, x.kind === 'css' ? 'ملف CSS/خط' : 'سكربت', x.ttfb != null ? ms(x.ttfb) : 'تعذّر']) },
          note: 'القياس من السيرفر؛ زمن الزائر الفعلي قد يختلف قليلاً.' };
      }
    };
    await run([imgDef, extDef]);

    /* مشتقة من قياسات سابقة (لا شبكة إضافية) */
    const pg = ctx.pages, html = ['page.home', 'page.articles', 'page.article'].map(i => pg[i]).filter(Boolean), all = Object.values(pg);
    const sizeC = {
      id: 'size.compress', group: 'size', label: 'ضغط الاستجابات (gzip / br)', weight: 3, fn: () => {
        if (!all.length) throw new Error('لا توجد استجابات مقاسة');
        const bad = all.filter(p => p.bytes > 1400 && !/gzip|br|zstd|deflate/.test(p.enc)), enc = [...new Set(all.map(p => p.enc || 'بدون'))];
        return { display: bad.length ? bad.length + ' من ' + all.length + ' غير مضغوطة' : 'مفعّل في الكل (' + enc.join(' / ') + ')', rating: bad.length ? 'slow' : 'excellent', score: bad.length ? 30 : 100, raw: { bad: bad.map(p => p.path), encodings: enc },
          rows: all.map(p => [p.path, (p.enc || 'بدون ضغط') + (p.len ? ' · على الشبكة ' + kb(p.len) + ' من ' + kb(p.bytes) : '')]) };
      }
    };
    const sizeP = {
      id: 'size.payload', group: 'size', label: 'حجم HTML و JSON', weight: 3, fn: () => {
        if (!all.length) throw new Error('لا توجد استجابات مقاسة');
        const h_ = html.map(p => p.bytes), j = all.filter(p => p.json).map(p => p.bytes), mh = h_.length ? Math.max(...h_) : 0, mj = j.length ? Math.max(...j) : 0;
        const rr = worse(RT(mh / 1024, 100, 250), RT(mj / 1024, 100, 300)), sc = Math.min(SC(mh / 1024, 100, 250), SC(mj / 1024, 100, 300));
        return { display: 'HTML ' + kb(mh) + ' · JSON ' + kb(mj), rating: rr, score: sc, raw: { maxHtml: mh, maxJson: mj },
          rows: all.map(p => [p.path, kb(p.bytes) + (p.json ? ' (JSON)' : ' (HTML)')]), note: mj > 200 * 1024 ? 'استجابة JSON كبيرة: قوائم المقالات تتضمن نص المقال كاملاً.' : undefined };
      }
    };
    const cacheT = {
      id: 'cache.html', group: 'cache', label: 'التخزين المؤقت للصفحات (Cache-Control / CDN)', weight: 10, fn: () => {
        if (!html.length) throw new Error('لا توجد صفحات مقاسة');
        const c = html.filter(p => p.cls === 'cdn').length, b = html.filter(p => p.cls === 'browser').length, n = html.length, api = pg['api.main'];
        const rr = c === n ? 'excellent' : c + b > 0 ? 'good' : 'slow', sc = c === n ? 100 : c + b > 0 ? 65 : 20;
        return { display: c + ' من ' + n + ' على CDN', rating: rr, score: sc, raw: { cdn: c, browser: b, total: n, uncached: html.filter(p => p.cls === 'none' || p.cls === 'no-store').map(p => p.path), apiCls: api ? api.cls : null },
          rows: html.map(p => [p.path, CLS[p.cls] + (p.cc ? ' — ' + p.cc : '')]).concat(api ? [[api.path + ' (API)', CLS[api.cls] + (api.cc ? ' — ' + api.cc : '')]] : []),
          note: 'الصفحات عندنا تُخدم عبر Express (وليس Next.js)، فمعنى ISR/Static هنا: ترويسة s-maxage على CDN في Vercel.' };
      }
    };
    const rttT = {
      id: 'browser.rtt', group: 'browser', label: 'زمن الوصول من متصفحك إلى السيرفر (round-trip)', weight: 0, fn: () => {
        const sm = ctx.rtt.samples; if (!sm.length) return { display: 'لم يُرسل', rating: 'na', score: null, note: 'لم يرسل المتصفح قياسات الوصول.' };
        const m = med(sm), home = pg['page.home'] ? pg['page.home'].ttfb : null;
        return { display: 'الوسيط ' + ms(m), ms: ri(m), rating: RT(m, 150, 400), score: null, raw: { median: r1(m), min: r1(Math.min(...sm)), max: r1(Math.max(...sm)), samples: sm.map(r1), first: ctx.rtt.first, firstUp: ctx.rtt.firstUp, homeTtfb: home },
          rows: [['الوسيط', ms(m)], ['الأقل / الأعلى', ms(Math.min(...sm)) + ' / ' + ms(Math.max(...sm))], ['أول طلب (يشمل فتح الاتصال)', ctx.rtt.first != null ? ms(ctx.rtt.first) : '—'], ['زمن الصفحة الرئيسية داخل السيرفر', home != null ? ms(home) : '—'],
            ['مقارنة', home != null ? 'شبكتك ' + ms(m) + ' ذهاباً وإياباً، والسيرفر ينتج الرئيسية في ' + ms(home) : '—']],
          note: 'هذا القياس لا يدخل في الدرجة العامة؛ يُستخدم لمعرفة هل البطء من شبكة الزائر وبُعده عن السيرفر.' };
      }
    };
    for (const d of [sizeC, sizeP, cacheT, rttT]) push(await exec(d, ctx));

    /* ===== الدرجة والتشخيص ===== */
    const sc = T.filter(t => t.weight > 0 && t.score != null), W = sc.reduce((a, t) => a + t.weight, 0);
    const score = W ? Math.round(sc.reduce((a, t) => a + t.weight * t.score, 0) / W) : 0;
    const partial = T.some(t => t.rating === 'failed');
    const diagnosis = diagnose(T, ctx);
    const R = id => (T.find(t => t.id === id) || {}).raw || {};
    const metrics = { score, ping: R('db.ping').median, dbq: R('db.query').sum, connect: R('db.connect').connectMs, home: pg['page.home'] && pg['page.home'].ttfb, homeTotal: pg['page.home'] && pg['page.home'].total, articles: pg['page.articles'] && pg['page.articles'].ttfb, api: pg['api.main'] && pg['api.main'].ttfb, cold: ctx.cold ? Math.max(0, r1(ctx.cold.diff)) : null, rtt: R('browser.rtt').median, imgKB: R('images.home').largest ? r1(R('images.home').largest.bytes / 1024) : null };
    const counts = { excellent: 0, good: 0, slow: 0, failed: 0, na: 0 }; T.forEach(t => { counts[t.rating] = (counts[t.rating] || 0) + 1; });
    return { score, grade: grade(score), partial, headline: diagnosis.headline, durationMs: Date.now() - started, tests: T, diagnosis: { ...diagnosis, counts }, metrics,
      env: { vercelRegion: process.env.VERCEL_REGION || null, vercelEnv: process.env.VERCEL_ENV || null, dbRegion: process.env.DB_REGION || null, node: process.version, instance: BOOT.id, origin: o } };
  }
}

/* ===================================================================== التشخيص الذكي
   نموذج مبسّط: كل سبب يُقدَّر له «تكلفة» بالميلي ثانية تقريباً (الزيادة فوق الحد المعقول)،
   ثم تُحوَّل إلى نسب مئوية. هي تقدير للترتيب وليست قياساً دقيقاً. */
function diagnose(T, ctx) {
  const get = id => T.find(t => t.id === id), R = id => (get(id) || {}).raw || {}, ok = id => { const t = get(id); return !!t && t.rating !== 'failed' && t.rating !== 'na'; };
  const ping = ok('db.ping') ? R('db.ping').median : 0, Q = ok('db.query') ? R('db.query') : {}, sumQ = Q.sum || 0, rg = R('region'), RTRIPS = 4;
  const mismatch = (get('region') || {}).rating === 'slow';
  const net = Math.max(0, ping - 8) * RTRIPS, execC = Math.max(0, sumQ - ping * 3 - 30);
  let cDb = execC, cReg = 0; if (mismatch || ping > 60) cReg = net; else cDb += net;
  const cd = R('cold.start'), cCold = Math.max(0, (cd.diff || 0) - 100) + Math.max(0, (R('db.connect').connectMs || 0) - 150) * .5;
  /* أكبر 3 صور فوق ميزانية 300KB، بسرعة تحميل فعّالة ≈ 600KB/ث (4G متوسط) */
  const im = R('images.home'), cImg = Math.min(2500, Math.max(0, (im.top3Bytes || 0) - 300 * 1024) / (600 * 1024) * 1000);
  const hp = ['page.home', 'page.articles', 'page.article'].map(i => ctx.pages[i]).filter(Boolean), unc = hp.filter(p => p.cls === 'none' || p.cls === 'no-store'), avg = hp.length ? hp.reduce((a, p) => a + p.ttfb, 0) / hp.length : 0;
  const cCache = hp.length ? unc.length / hp.length * Math.max(0, avg - 100) * .7 : 0;
  const ex = R('external.services'), exSlow = (ex.items || []).filter(x => x.ttfb != null && x.ttfb > 300), cExt = exSlow.reduce((a, x) => a + (x.ttfb - 300), 0);
  const rt = R('browser.rtt'), cNet = rt.median ? Math.max(0, rt.median - 100) * 2 : 0;
  const vcont = rg.dbCont || null, suggest = vcont ? NEAR[vcont] : null;

  const causes = [
    { key: 'db', label: 'قاعدة البيانات', cost: cDb,
      facts: Q.sum != null ? 'ثلاثة استعلامات استغرقت ' + ms(sumQ) + ' (ping ' + ms(ping) + ')' + (Q.explain ? ' — ' + (Q.explain.collscan ? 'مسح كامل للجدول' : 'تستخدم فهرساً') : '') : 'لم يكتمل قياس الاستعلامات',
      reco: [
        Q.explain && Q.explain.collscan && Q.explain.docs > 200 ? 'أضف فهرساً مركباً على المحتوى: { type: 1, draft: 1, createdAt: -1 } — الاستعلام الحالي يفحص ' + Q.explain.docs + ' وثيقة بمسح كامل.' : null,
        Q.itemsBytes > 200 * 1024 ? 'قوائم المقالات تُرجع نص المقال كاملاً (' + kb(Q.itemsBytes) + ' لـ 20 مقالاً) — استخدم lite=1 أو select(\'-body\') في القوائم.' : null,
        'اضبط maxPoolSize بين 5 و10 في خيارات mongoose.connect: كل instance على Vercel تفتح pool مستقلاً، والافتراضي (100) قد يستنزف حدّ اتصالات Atlas. (الاتصال نفسه يُعاد استخدامه بين الطلبات في lib/app.js بالفعل.)',
        R('db.conns').pct > 70 ? 'الاتصالات المفتوحة مرتفعة (' + R('db.conns').current + ' من ' + R('db.conns').total + ') — قلّل maxPoolSize وتأكد أنك لا تنشئ اتصالات جديدة داخل المسارات.' : null,
        'خزّن نتائج القراءات العامة (items / settings) في كاش CDN بـ s-maxage بدل ضرب القاعدة في كل زيارة.',
        execC > 150 ? 'إن بقي زمن التنفيذ مرتفعاً رغم الفهارس فالمشكلة في موارد الباقة (M0 مشتركة) — فكّر في الترقية.' : null].filter(Boolean) },
    { key: 'region', label: 'بُعد المنطقة (السيرفر ↔ القاعدة)', cost: cReg,
      facts: rg.verdict || (ping ? 'زمن ping ' + ms(ping) : 'لا بيانات'),
      reco: [
        mismatch ? 'انقل الدوال إلى منطقة القاعدة: أضف في vercel.json  "regions": ["' + (suggest || 'fra1') + '"]  (أو انقل Cluster الأطلس إلى ' + (rg.vercelRegion || 'منطقة Vercel') + ').' : null,
        !rg.dbRegion ? 'أضف متغير البيئة DB_REGION (مثل aws-eu-central-1) ليعرض الفحص منطقة القاعدة بدقة بدل التقدير من زمن الاستجابة.' : null,
        ping > 60 ? 'كل صفحة تنفّذ عدة استعلامات متتالية، فكل 100ms مسافة تتضاعف 3–4 مرات — اجمع الاستعلامات (Promise.all) أو قلّلها.' : null,
        'لجمهور عربي، أقرب مناطق Vercel عادةً fra1 أو cdg1 أو dxb1 — اجعل Atlas في المنطقة المقابلة لها.'].filter(Boolean) },
    { key: 'cold', label: 'Cold Start', cost: cCold,
      facts: cd.first != null ? 'أول طلب ' + ms(cd.first) + ' مقابل لاحق ' + ms(cd.second) + (R('db.connect').connectMs ? ' · فتح اتصال جديد ' + ms(R('db.connect').connectMs) : '') : 'لم يكتمل القياس',
      reco: ['فعّل Fluid Compute من إعدادات مشروع Vercel لتقليل Cold Starts وإعادة استخدام الـ instances.', 'اجعل الصفحات العامة (/ و /articles) تُخدم من كاش CDN كي لا يصطدم الزائر بالـ Cold Start (مفعّل جزئياً عبر s-maxage).',
        'استخدم مراقباً خارجياً (UptimeRobot مثلاً) كل 5 دقائق على الصفحة الرئيسية لإبقاء الدالة دافئة.', 'قرّب القاعدة من الدوال: زمن فتح الاتصال يُدفع مع كل Cold Start.'] },
    { key: 'images', label: 'صور ثقيلة', cost: cImg,
      facts: im.largest ? 'أكبر صورة ' + im.largest.name + ' (' + kb(im.largest.bytes) + ') · أكبر 3 صور ' + kb(im.top3Bytes) + ' · ' + im.nonModern + ' من ' + im.count + ' ليست WebP/AVIF' : 'لم تُقَس الصور',
      reco: [(im.top || []).length ? 'اضغط وحوّل إلى WebP/AVIF: ' + im.top.map(x => x.name + ' (' + kb(x.bytes) + ')').join('، ') + '.' : 'حوّل الصور إلى WebP/AVIF.', 'اضغط الصور في المتصفح قبل الرفع (canvas → WebP بجودة 0.8 وعرض أقصى 1600px) لتبقى أقل من 150KB.',
        'الموقع لا يستخدم next/image (مشروع Express): قدّم أحجاماً متعددة بـ srcset/<picture> وأضف width وheight وloading="lazy" لكل صورة خارج الشاشة الأولى.'] },
    { key: 'cache', label: 'غياب الكاش', cost: cCache,
      facts: hp.length ? (unc.length ? 'صفحات بلا كاش CDN: ' + unc.map(p => p.path).join('، ') : 'كل الصفحات الرئيسية مخزّنة على CDN') + (ctx.pages['api.main'] ? ' · API: ' + CLS[ctx.pages['api.main'].cls] : '') : 'لا بيانات',
      reco: [unc.length ? 'أضف Cache-Control: public, s-maxage=300, stale-while-revalidate=86400 للصفحات: ' + unc.map(p => p.path).join('، ') + '.' : null,
        ctx.pages['api.main'] && (ctx.pages['api.main'].cls === 'none' || ctx.pages['api.main'].cls === 'no-store') ? 'GET /api/items و /api/settings العامة بلا كاش: أضف s-maxage=60 مع stale-while-revalidate، وامنع الكاش عندما يكون الطلب بترويسة Authorization (المدير يرى المسودات) وأضف Vary: Authorization.' : null,
        'بعد تعديل المحتوى من لوحة المدير ستظهر التغييرات خلال مدة s-maxage — اختر مدة تناسبك.'].filter(Boolean) },
    { key: 'external', label: 'خدمة خارجية', cost: cExt,
      facts: exSlow.length ? exSlow.map(x => x.name + ' ' + ms(x.ttfb)).join('، ') : (ex.items && ex.items.length ? 'الخدمات الخارجية سريعة' : 'لا خدمات خارجية'),
      reco: ['استضف خطوط Google Fonts ذاتياً (woff2 في /fonts) أو اكتفِ بوزنين من الخط لتقليل الطلبات الخارجية.', 'حافظ على preconnect وdisplay=swap كي لا يحجب الخط عرض النص.'] },
    { key: 'network', label: 'شبكة المستخدم', cost: cNet,
      facts: rt.median ? 'زمن الوصول من متصفحك ' + ms(rt.median) + (rt.homeTtfb != null ? ' بينما الصفحة تُنتَج داخل السيرفر في ' + ms(rt.homeTtfb) : '') : 'لم يُقَس',
      reco: ['إن كان هذا الزمن مرتفعاً فالسبب مسافة/جودة شبكة الزائر: قرّب الدوال من جمهورك واعتمد على CDN وكاش الصفحات حتى تُخدم من أقرب Edge.', 'جرّب الفحص من شبكة أخرى (بيانات الهاتف مقابل Wi-Fi) للتأكد.'] }
  ];
  const total = causes.reduce((a, c) => a + c.cost, 0);
  /* نسب تساوي 100 بطريقة أكبر باقٍ */
  if (total > 0) {
    const raw = causes.map(c => c.cost / total * 100), fl = raw.map(Math.floor); let left = 100 - fl.reduce((a, b) => a + b, 0);
    raw.map((x, i) => [x - fl[i], i]).sort((a, b) => b[0] - a[0]).forEach(([, i]) => { if (left-- > 0) fl[i]++; });
    causes.forEach((c, i) => { c.pct = fl[i]; });
  } else causes.forEach(c => { c.pct = 0; });
  causes.forEach(c => { c.cost = ri(c.cost); c.level = c.cost >= 500 ? 'high' : c.cost >= 150 ? 'mid' : 'low'; });
  causes.sort((a, b) => b.cost - a.cost);
  const healthy = total < 80, top = causes[0];
  return { healthy, totalCostMs: ri(total), headline: healthy ? 'الأداء جيد — لا يوجد سبب بارز للبطء' : 'السبب الأرجح للبطء: ' + top.label + ' (≈' + top.pct + '%)', topKey: healthy ? null : top.key, causes };
}

module.exports = { boot, early, mount };
