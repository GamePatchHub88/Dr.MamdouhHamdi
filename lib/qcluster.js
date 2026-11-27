'use strict';
/* lib/qcluster.js — تجميع الأسئلة المجهولة + ترشيح مقال مناسب.
   دوال نقية بلا اعتماديات (تعمل في الذاكرة فقط، ولا تحتاج أي مكتبة جديدة):
   toks(text)            ← نص عربي → مصفوفة كلمات مُطبَّعة ومُجذَّعة جذعاً خفيفاً
   assign(toks, pool)    ← أقرب مجموعة (gid) متشابهة من قائمة أسئلة سابقة، أو null
   buildIndex / suggest  ← فهرس المقالات المنشورة وترشيح الأنسب (بالكلمات المفتاحية + تصنيف السؤال)
   scrub / clip          ← تنظيف النص قبل عرضه علناً (إزالة أي معلومة تعريفية) */

const DIAC = /[\u064B-\u065F\u0670\u0640\u06D6-\u06ED]/g;

/* تطبيع بسيط: تشكيل/تطويل، همزات الألف، ى→ي، ة→ه، ؤ→و، ئ→ي، الأرقام الهندية، علامات الترقيم */
function normText(s) {
  return String(s || '').toLowerCase()
    .replace(/[\u0660-\u0669]/g, d => String(d.charCodeAt(0) - 0x660))
    .replace(/[\u06F0-\u06F9]/g, d => String(d.charCodeAt(0) - 0x6F0))
    .replace(DIAC, '')
    .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

/* كلمات شائعة لا تدل على الموضوع (بعد التطبيع) */
const STOP = new Set(('من في على الي عن هل كيف لماذا ليه ليش ازاي ازاى انا انت انتي هو هي هم نحن هذا هذه هذي ذلك تلك التي الذي الذين كان كانت يكون تكون لا لم لن ما قد مع بعد قبل كل بين حتي لو اذا اذ عند عندي عندما كم اين ماذا متي ايضا جدا فقط يا او ام ان انه انها لكن ثم بس برضه كده كدا دي ده ايه اي وهل هناك هنا لي لك له لها لهم عليه عليها فيه فيها منه منها به بها بهم ' +
  'اريد ارجو ممكن سوال اسئله دكتور دكتوره استاذ حضرتك سمحت رجاء عايز عايزه اعرف احتاج نصيحه رايك افيدوني ساعدوني ساعدني مشكله مشاكل حاله وضع امر شيء شي كثير كتير دائما احيانا دايما يعني اوي قوي حاجه حاجات اللي').split(' '));

const PRE = ['وبال', 'وال', 'بال', 'كال', 'فال', 'لل', 'ال'];
const SUF = ['تي', 'ته', 'تك', 'ات', 'ون', 'ين', 'ان', 'ها', 'هم', 'هن', 'نا', 'كم', 'ه', 'ي', 'ك'];
/* جذع خفيف: بادئات التعريف وحروف الجر الملتصقة + لواحق الضمائر والجمع */
function stem(w) {
  if (w.length <= 3) return w;
  for (const p of PRE) if (w.startsWith(p) && w.length - p.length >= 3) { w = w.slice(p.length); break; }
  for (const x of SUF) if (w.endsWith(x) && w.length - x.length >= 3) { w = w.slice(0, -x.length); break; }
  return w;
}

function toks(text) {
  const out = [], seen = new Set();
  for (const raw of normText(text).split(' ')) {
    if (raw.length < 2 || /^\d+$/.test(raw) || STOP.has(raw)) continue;
    const t = stem(raw);
    if (t.length < 2 || STOP.has(t) || seen.has(t)) continue;
    seen.add(t); out.push(t);
  }
  return out;
}

/* تشابه كلمات (Ochiai): المشترك ÷ √(|A|·|B|) */
function sim(A, B) {
  if (!A.length || !B.length) return { s: 0, n: 0 };
  const sb = new Set(B); let n = 0;
  for (const t of A) if (sb.has(t)) n++;
  return { s: n / Math.sqrt(A.length * B.length), n };
}
/* قاعدة التجميع: 3 كلمات مشتركة فأكثر بنسبة ≥ 0.55، أو كلمتان بنسبة ≥ 0.8 (للأسئلة القصيرة) */
const same = r => (r.n >= 3 && r.s >= 0.55) || (r.n >= 2 && r.s >= 0.8);

function assign(tk, pool) {
  let best = null, bs = 0;
  for (const p of pool) { const r = sim(tk, p.toks); if (same(r) && r.s > bs) { bs = r.s; best = p.gid; } }
  return best;
}

/* كلمات مفتاحية لكل تصنيف (تُمرَّر عبر toks ليتطابق تطبيعها مع المقالات) */
const CATKW = {
  'زوجي وأسري': 'زواج زوج زوجة خلاف خلافات طلاق أسرة علاقة علاقات حماة بيت عائلة خيانة تفاهم حوار',
  'أطفال ومراهقون': 'طفل أطفال مراهق مراهقة ابن ابنة سلوك عناد مدرسة تربية غضب تنمر دراسة',
  'نفسي وقلق': 'قلق اكتئاب خوف توتر نوم وسواس حزن هلع ثقة نفسية مزاج ضغط',
  'إدمان سلوكي': 'إدمان موبايل هاتف ألعاب إباحية تدخين مقامرة تعافي سلوكي إنترنت تحكم'
};
const CATW = Object.fromEntries(Object.entries(CATKW).map(([k, v]) => [k, toks(v)]));

function buildIndex(arts) {
  const docs = (arts || []).map(a => ({
    id: String(a._id), slug: a.slug || '', title: a.title || '',
    tt: new Set(toks(a.title)), dt: new Set(toks(a.desc)), bt: new Set(toks(String(a.body || '').slice(0, 4000)))
  }));
  const df = new Map();
  for (const d of docs) for (const t of new Set([...d.tt, ...d.dt, ...d.bt])) df.set(t, (df.get(t) || 0) + 1);
  return { docs, df, N: docs.length };
}

/* أنسب مقال: وزن الكلمة (عنوان 3، وصف 2، متن 1) × IDF + دفعة للتصنيف. يلزم تطابق كلمتين أو تطابق تصنيف، وحدّ أدنى للدرجة */
function suggest(ix, tk, cat) {
  if (!ix || !ix.N || !tk.length) return null;
  const cw = CATW[cat] || [];
  let best = null, bs = 0;
  for (const d of ix.docs) {
    let s = 0, m = 0;
    for (const t of tk) {
      const w = Math.log(1 + ix.N / (1 + (ix.df.get(t) || 0)));
      if (d.tt.has(t)) { s += 3 * w; m++; } else if (d.dt.has(t)) { s += 2 * w; m++; } else if (d.bt.has(t)) { s += w; m++; }
    }
    let c = 0; for (const t of cw) if (d.tt.has(t) || d.dt.has(t)) c++;
    c = Math.min(c, 3); s += c * 1.2;
    if ((m >= 2 || (m >= 1 && c > 0)) && s >= 4 && s > bs) { bs = s; best = d; }
  }
  return best;
}

/* قبل العرض العلني: إزالة روابط/بريد/معرّفات/أرقام تشبه الهاتف/«اسمي فلان» */
function scrub(t) {
  return String(t || '')
    .replace(/https?:\/\/\S+|www\.\S+/gi, ' ')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, ' ')
    .replace(/@\w+/g, ' ')
    .replace(/[\d٠-٩۰-۹](?:[\s().-]?[\d٠-٩۰-۹]){6,}/g, ' ')
    .replace(/(?:اسمي|اسمى|أنا اسمي|انا اسمي)\s+\S+(?:\s+\S+)?/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
function clip(t, n) {
  t = String(t || '');
  if (t.length <= n) return t;
  const c = t.slice(0, n), i = c.lastIndexOf(' ');
  return (i > n * 0.6 ? c.slice(0, i) : c).replace(/[\s،,.؛:!؟?]+$/, '') + '…';
}

module.exports = { normText, toks, sim, same, assign, buildIndex, suggest, scrub, clip, CATW };
