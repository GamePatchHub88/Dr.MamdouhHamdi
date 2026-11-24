/* =====================================================================
   تبويب «فحص السرعة» داخل إدارة الموقع (لوحة المدير)
   - يُحمَّل قبل سكربت لوحة المدير؛ دالة siteTab تستدعي window.onSpeedTab عند فتح التبويب
   - كل الاختبارات تعمل على السيرفر (/api/admin/speed/*)؛ المتصفح يقيس فقط زمن الوصول RTT
   ===================================================================== */
(function () {
  'use strict';
  const GROUPS = [['db', 'قاعدة البيانات'], ['region', 'منطقة القاعدة مقابل منطقة السيرفر'], ['cold', 'Cold Start'], ['pages', 'الصفحات الرئيسية'], ['size', 'حجم الاستجابات والضغط'],
    ['cache', 'التخزين المؤقت'], ['images', 'الصور'], ['external', 'خدمات خارجية'], ['browser', 'من المتصفح']];
  const RL = { excellent: 'ممتاز', good: 'جيد', slow: 'بطيء', failed: 'تعذّر', na: 'غير متاح' };
  const METRICS = [['score', 'الدرجة العامة', '/100'], ['home', 'TTFB الرئيسية', ' ms'], ['ping', 'ping القاعدة', ' ms'], ['dbq', 'استعلامات القاعدة', ' ms'], ['cold', 'Cold Start', ' ms'], ['rtt', 'زمن المتصفح', ' ms'], ['imgKB', 'أكبر صورة', ' KB']];
  const st = { run: null, hist: [], busy: false, cool: 0, metric: 'score', tick: null, cdt: null, ready: false };
  let box = null;

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const $ = id => document.getElementById(id);
  const tk = () => localStorage.tk || '';
  const say = (m, t) => { if (typeof toast === 'function') toast(m, t || ''); };
  const dtf = d => { try { return new Date(d).toLocaleString('ar-EG', { dateStyle: 'medium', timeStyle: 'short' }); } catch (e) { return ''; } };
  const tone = s => s >= 90 ? 'ok' : s >= 75 ? 'gd' : s >= 50 ? 'sl' : 'bd';
  const icon = n => (typeof U === 'function' ? U(n) : '');

  async function req(path, method, body, ms) {
    const ac = new AbortController(), tm = setTimeout(() => ac.abort(), ms || 45000);
    try {
      const r = await fetch('/api/admin/speed/' + path, { method: method || 'GET', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tk() }, body: body ? JSON.stringify(body) : undefined, cache: 'no-store', signal: ac.signal });
      if (r.status === 401) { localStorage.removeItem('tk'); location.reload(); return { status: 401 }; }
      let j = null; try { j = await r.json(); } catch (e) { }
      return { status: r.status, ok: r.ok, data: j };
    } catch (e) { return { status: 0, ok: false, err: e && e.name === 'AbortError' ? 'timeout' : 'network' }; }
    finally { clearTimeout(tm); }
  }

  /* ---------- بناء الهيكل (مرة واحدة) ---------- */
  function build(el) {
    box = el; box.className = 'sp';
    box.innerHTML = `<div class="card"><div class="sth"><div><h3>${icon('db')}فحص سرعة الموقع</h3>
<p class="sub">تُنفَّذ الاختبارات من السيرفر: قاعدة البيانات، المنطقة، الصفحات، Cold Start، الضغط، الكاش، الصور والخدمات الخارجية — ثم يُحدَّد السبب الأرجح للبطء.</p></div>
<button type="button" class="btn" id="spGo">ابدأ الفحص</button></div>
<div id="spProg" class="sp-prog" hidden role="status" aria-live="polite"><div class="sp-bar"><i></i></div><span id="spProgT">جارٍ التحضير…</span></div>
<div id="spNote" class="sp-alert" hidden></div></div>
<div id="spRes"><div class="empty">جارٍ تحميل آخر فحص…</div></div>
<div class="card" id="spHist"></div>`;
    $('spGo').onclick = start;
    box.addEventListener('click', onClick);
    box.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('[data-sp="run"]')) { e.preventDefault(); onClick(e); } });
    st.ready = true;
  }

  function onClick(e) {
    const t = e.target.closest('[data-sp]'); if (!t) return;
    const a = t.dataset.sp;
    if (a === 'det') { const d = t.closest('.sp-row').nextElementSibling, o = d.hidden; d.hidden = !o; t.setAttribute('aria-expanded', String(o)); t.textContent = o ? 'إخفاء' : 'تفاصيل'; }
    else if (a === 'copy') copyJson();
    else if (a === 'dl') dlJson();
    else if (a === 'metric') { st.metric = t.dataset.k; renderHist(); }
    else if (a === 'run') loadRun(t.dataset.id, true);
  }

  /* ---------- زر البدء والتهدئة ---------- */
  function setBtn() {
    const b = $('spGo'); if (!b) return;
    b.disabled = st.busy || st.cool > 0;
    b.textContent = st.busy ? 'جارٍ الفحص…' : st.cool > 0 ? 'ابدأ الفحص (بعد ' + st.cool + ' ث)' : 'ابدأ الفحص';
  }
  function startCool(n) {
    clearInterval(st.cdt); st.cool = Math.max(0, Math.ceil(n)); setBtn();
    if (st.cool > 0) st.cdt = setInterval(() => { st.cool--; setBtn(); if (st.cool <= 0) clearInterval(st.cdt); }, 1000);
  }
  function note(msg, kind) { const n = $('spNote'); if (!n) return; n.hidden = !msg; n.className = 'sp-alert ' + (kind || 'w'); n.textContent = msg || ''; }

  /* ---------- زمن الوصول من المتصفح (round-trip) ---------- */
  async function measureRtt() {
    const s = []; let first = null, firstUp = null;
    for (let i = 0; i < 5; i++) {
      const t = performance.now();
      try {
        const r = await fetch('/api/admin/speed/ping?_=' + Date.now() + '_' + i, { headers: { Authorization: 'Bearer ' + tk() }, cache: 'no-store' });
        if (r.status === 401) { localStorage.removeItem('tk'); location.reload(); return {}; }
        const j = await r.json(), d = performance.now() - t;
        if (i === 0) { first = d; firstUp = j.up; } else s.push(d);
      } catch (e) { }
    }
    return { samples: s, first, firstUp };
  }

  async function start() {
    if (st.busy || st.cool > 0) return;
    st.busy = true; setBtn(); note('');
    const pr = $('spProg'), pt = $('spProgT'), t0 = Date.now(); pr.hidden = false; pt.textContent = 'قياس زمن الوصول من متصفحك…';
    st.tick = setInterval(() => { pt.textContent = 'جارٍ تنفيذ الاختبارات على السيرفر… ' + Math.round((Date.now() - t0) / 1000) + ' ث (قد تستغرق حتى 25 ثانية)'; }, 500);
    try {
      const rtt = await measureRtt();
      pt.textContent = 'جارٍ تنفيذ الاختبارات على السيرفر…';
      const r = await req('run', 'POST', { rtt }, 60000);
      if (r.status === 429) { const ra = (r.data && r.data.retryAfter) || 30; startCool(ra); note('لا يمكن إجراء فحصين متتاليين — حاول بعد ' + ra + ' ثانية.', 'w'); }
      else if (r.ok && r.data) { st.run = r.data; renderRun(); loadHist(true); startCool(30); say('اكتمل الفحص', 's'); $('spRes').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
      else if (r.err === 'timeout') note('انتهت مهلة الاتصال قبل اكتمال الفحص — أعد المحاولة.', 'x');
      else if (r.status === 0) note('تعذّر الاتصال بالسيرفر — تحقق من الشبكة وأعد المحاولة.', 'x');
      else note('فشل الفحص (خطأ ' + r.status + ')' + (r.data && r.data.error ? ': ' + r.data.error : '') + ' — تأكد من رفع lib/app.js وlib/speed.js.', 'x');
    } finally { clearInterval(st.tick); st.busy = false; pr.hidden = true; setBtn(); }
  }

  /* ---------- التحميل ---------- */
  async function loadHist(keep) {
    const r = await req('history');
    if (!r.ok || !Array.isArray(r.data)) { if (!keep) { $('spRes').innerHTML = '<div class="empty">تعذّر تحميل سجل الفحوصات — تأكد من رفع آخر نسخة من lib/app.js وlib/speed.js ثم أعد المحاولة.</div>'; } return; }
    st.hist = r.data;
    if (st.hist[0] && st.cool <= 0 && !st.busy) { const rem = 30 - (Date.now() - new Date(st.hist[0].createdAt).getTime()) / 1000; if (rem > 0) startCool(rem); }
    renderHist();
    if (!keep && !st.run) { if (st.hist[0]) loadRun(st.hist[0]._id); else renderRun(); }
  }
  async function loadRun(id, scroll) {
    const r = await req('run/' + encodeURIComponent(id));
    if (r.ok && r.data) { st.run = r.data; renderRun(); renderHist(); if (scroll) $('spRes').scrollIntoView({ behavior: 'smooth', block: 'start' }); } else say('تعذّر تحميل هذا الفحص', 'e');
  }

  /* ---------- عرض النتيجة ---------- */
  function gauge(s) {
    const C = 2 * Math.PI * 52, col = { ok: 'var(--ok)', gd: 'var(--p2)', sl: '#e8a23a', bd: 'var(--dg)' }[tone(s)];
    return `<svg class="sp-g" viewBox="0 0 120 120" role="img" aria-label="الدرجة ${s} من 100"><circle cx="60" cy="60" r="52" fill="none" stroke="var(--bd)" stroke-width="10"/>
<circle cx="60" cy="60" r="52" fill="none" stroke="${col}" stroke-width="10" stroke-linecap="round" stroke-dasharray="${(C * s / 100).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 60 60)"/>
<text x="60" y="64" text-anchor="middle" class="sp-gn">${s}</text><text x="60" y="84" text-anchor="middle" class="sp-gs">من 100</text></svg>`;
  }
  function renderRun() {
    const r = st.run, el = $('spRes'); if (!el) return;
    if (!r) { el.innerHTML = '<div class="empty">لم يُجرَ أي فحص بعد — اضغط «ابدأ الفحص».</div>'; return; }
    const d = r.diagnosis || {}, T = r.tests || [], c = d.counts || {};
    const al = T.filter(t => t.alert).map(t => `<div class="sp-alert x" role="alert">${icon('ext')}<div><b>تنبيه: اختلاف دولي بين السيرفر والقاعدة</b><span>${esc(t.alert)}</span></div></div>`).join('');
    const part = r.partial ? '<div class="sp-alert w">تعذّر بعض الاختبارات (موضّحة أدناه بحالة «تعذّر»)؛ حُسبت الدرجة من الاختبارات التي اكتملت فقط.</div>' : '';
    const e = r.env || {};
    el.innerHTML = `<div class="card sp-sum"><div class="sp-gw">${gauge(r.score || 0)}</div><div class="sp-si"><h3>${esc(r.grade || '')}</h3>
<p class="sub">${dtf(r.createdAt)} · استغرق ${((r.durationMs || 0) / 1000).toFixed(1)} ث${e.vercelRegion ? ' · منطقة السيرفر ' + esc(e.vercelRegion) : ''}</p>
<div class="sp-cnt"><span class="sp-b r-excellent">${c.excellent || 0} ممتاز</span><span class="sp-b r-good">${c.good || 0} جيد</span><span class="sp-b r-slow">${c.slow || 0} بطيء</span><span class="sp-b r-failed">${c.failed || 0} تعذّر</span></div></div>
<div class="sp-ex"><button type="button" class="btn o sm" data-sp="copy">نسخ JSON</button><button type="button" class="btn o sm" data-sp="dl">تنزيل JSON</button></div></div>
${al}${part}${diagnosisHtml(d)}${GROUPS.map(g => groupHtml(g, T)).join('')}`;
  }
  function diagnosisHtml(d) {
    const cs = d.causes || []; if (!cs.length) return '';
    const on = cs.filter(c => c.pct > 0), off = cs.filter(c => !(c.pct > 0));
    return `<div class="card"><h3>${icon('ed')}التشخيص</h3><p class="sp-hl ${d.healthy ? 'ok' : ''}">${esc(d.headline || '')}</p>
${on.map((c, i) => `<details class="sp-cs lv-${c.level}" ${i === 0 && !d.healthy ? 'open' : ''}><summary><span class="sp-cn">${esc(c.label)}</span><span class="sp-pb"><i style="width:${c.pct}%"></i></span><b dir="ltr">${c.pct}%</b></summary>
<div class="sp-cb"><p>${esc(c.facts || '')}</p>${(c.reco || []).length ? '<ul>' + c.reco.map(x => '<li>' + esc(x) + '</li>').join('') + '</ul>' : ''}</div></details>`).join('')}
${off.length ? '<p class="sp-off">أسباب غير مؤثرة حالياً: ' + off.map(c => esc(c.label)).join('، ') + '</p>' : ''}
<p class="sp-fn">النسب تقديرية: كل سبب يُقدَّر له الزمن الزائد عن الحد المعقول ثم يُحوَّل إلى نسبة؛ هي للترتيب والاتجاه وليست قياساً دقيقاً.</p></div>`;
  }
  function groupHtml(g, T) {
    const L = T.filter(t => t.group === g[0]); if (!L.length) return '';
    return `<div class="card"><h3>${esc(g[1])}</h3>${L.map(rowHtml).join('')}</div>`;
  }
  function rowHtml(t) {
    const has = (t.rows && t.rows.length) || t.table || t.note || t.error;
    const det = has ? `<div class="sp-det" hidden>${(t.rows || []).map(r => `<div class="sp-kv"><span>${esc(r[0])}</span><b>${esc(r[1])}</b></div>`).join('')}${t.table ? tableHtml(t.table) : ''}${t.error ? '<p class="sp-er">' + esc(t.error) + '</p>' : ''}${t.note ? '<p class="sp-nt">' + esc(t.note) + '</p>' : ''}</div>` : '<div class="sp-det" hidden></div>';
    return `<div class="sp-row r-${t.rating}"><div class="sp-l"><b>${esc(t.label)}</b>${t.rating === 'failed' ? '<small class="sp-er">' + esc(t.error || 'تعذّر') + '</small>' : ''}</div>
<div class="sp-v" dir="ltr">${esc(t.display || '—')}</div><span class="sp-b r-${t.rating}">${RL[t.rating] || ''}</span>${has ? '<button type="button" class="sp-t" data-sp="det" aria-expanded="false">تفاصيل</button>' : '<span class="sp-t"></span>'}</div>${det}`;
  }
  function tableHtml(tb) {
    return `<div class="sp-tw"><table class="ctb"><thead><tr>${tb.cols.map(c => '<th>' + esc(c) + '</th>').join('')}</tr></thead><tbody>${tb.rows.map(r => '<tr>' + r.map(x => '<td>' + esc(x) + '</td>').join('') + '</tr>').join('')}</tbody></table></div>`;
  }

  /* ---------- التصدير ---------- */
  const payload = () => JSON.stringify({ tool: 'speed-check', exportedAt: new Date().toISOString(), site: location.origin, run: st.run }, null, 2);
  async function copyJson() {
    if (!st.run) return; const txt = payload();
    try { await navigator.clipboard.writeText(txt); say('تم نسخ النتيجة', 's'); }
    catch (e) { const ta = document.createElement('textarea'); ta.value = txt; ta.style.cssText = 'position:fixed;opacity:0'; document.body.appendChild(ta); ta.select(); let ok = false; try { ok = document.execCommand('copy'); } catch (x) { } ta.remove(); say(ok ? 'تم نسخ النتيجة' : 'تعذّر النسخ — استخدم التنزيل', ok ? 's' : 'e'); }
  }
  function dlJson() {
    if (!st.run) return; const d = new Date(st.run.createdAt || Date.now()), p = n => String(n).padStart(2, '0');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([payload()], { type: 'application/json' }));
    a.download = 'speed-check-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + '.json'; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  /* ---------- السجل والرسم البياني ---------- */
  function chart() {
    const m = METRICS.find(x => x[0] === st.metric) || METRICS[0], data = st.hist.slice().reverse().map(h => ({ id: h._id, at: h.createdAt, v: h.metrics ? h.metrics[m[0]] : null })).filter(p => typeof p.v === 'number' && isFinite(p.v));
    if (!data.length) return '<div class="empty">لا توجد قياسات لهذا المؤشر في السجل بعد.</div>';
    const W = 640, H = 230, L = 46, Rr = 14, Tp = 16, B = 32, pw = W - L - Rr, ph = H - Tp - B;
    const mx = m[0] === 'score' ? 100 : Math.max(10, Math.ceil(Math.max(...data.map(p => p.v)) * 1.15 / 10) * 10);
    const x = i => L + (data.length === 1 ? pw / 2 : i * pw / (data.length - 1)), y = v => Tp + ph - Math.min(v, mx) / mx * ph;
    const grid = [0, .25, .5, .75, 1].map(f => `<line x1="${L}" x2="${W - Rr}" y1="${y(mx * f).toFixed(1)}" y2="${y(mx * f).toFixed(1)}" class="sp-gl"/><text x="${L - 6}" y="${(y(mx * f) + 4).toFixed(1)}" text-anchor="end" class="sp-ax">${Math.round(mx * f)}</text>`).join('');
    const sd = d => { const t = new Date(d); return t.getDate() + '/' + (t.getMonth() + 1) + ' ' + String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0'); };
    const lbl = [0, Math.floor((data.length - 1) / 2), data.length - 1].filter((v, i, a) => a.indexOf(v) === i).map(i => `<text x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="middle" class="sp-ax">${sd(data[i].at)}</text>`).join('');
    const line = data.length > 1 ? `<polyline points="${data.map((p, i) => x(i).toFixed(1) + ',' + y(p.v).toFixed(1)).join(' ')}" fill="none" class="sp-ln"/>` : '';
    const dots = data.map((p, i) => `<g data-sp="run" data-id="${esc(p.id)}" class="sp-dt ${st.run && st.run._id === p.id ? 'on' : ''}" tabindex="0" role="button" aria-label="${esc(sd(p.at) + ' — ' + Math.round(p.v * 10) / 10 + m[2])}"><circle cx="${x(i).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="12" fill="transparent"/><circle cx="${x(i).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="4.5" class="sp-pt"/><title>${esc(sd(p.at))} — ${Math.round(p.v * 10) / 10}${esc(m[2])}</title></g>`).join('');
    return `<div class="sp-chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="رسم ${esc(m[1])} عبر الزمن">${grid}${line}${dots}${lbl}</svg><div class="sp-cap">الأقدم ← الأحدث · ${esc(m[1])} (${esc(m[2].trim())})</div></div>`;
  }
  function renderHist() {
    const el = $('spHist'); if (!el) return;
    el.innerHTML = `<h3>${icon('cal')}سجل آخر 20 فحصاً</h3><p class="sub">يُحفظ في قاعدة البيانات؛ اضغط على نقطة أو سطر لعرض تفاصيل ذلك الفحص.</p>
${st.hist.length ? `<div class="chips sp-mt" role="group" aria-label="مؤشر الرسم">${METRICS.map(m => `<button type="button" class="ch ${m[0] === st.metric ? 'on' : ''}" data-sp="metric" data-k="${m[0]}">${m[1]}</button>`).join('')}</div>${chart()}
<div class="sp-hl2">${st.hist.map(h => `<button type="button" class="sp-hr ${st.run && st.run._id === h._id ? 'on' : ''}" data-sp="run" data-id="${esc(h._id)}"><span class="sp-hs ${tone(h.score)}">${h.score}</span><span class="sp-hd">${dtf(h.createdAt)}</span><span class="sp-hh">${esc(h.headline || '')}</span></button>`).join('')}</div>` : '<div class="empty">لا توجد فحوصات محفوظة بعد.</div>'}`;
  }

  /* يستدعيها siteTab عند فتح التبويب */
  window.onSpeedTab = function (el) {
    if (!st.ready || box !== el) build(el);
    if (!st.busy) loadHist(false);
  };
})();
