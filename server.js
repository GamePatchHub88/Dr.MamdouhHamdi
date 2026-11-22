const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
const read = (...p) => { try { return fs.readFileSync(path.join(__dirname, 'public', ...p), 'utf8'); } catch { return null; } };
const home = read('index.html'), admin = read('admin', 'index.html'), content = read('content.html');
// الدومين الأساسي: يفضَّل ضبط SITE_URL في متغيرات البيئة (مثال: https://example.com)
const origin = q => (process.env.SITE_URL || '').replace(/\/+$/, '') || (String(q.headers['x-forwarded-proto'] || 'https').split(',')[0].trim() + '://' + String(q.headers['x-forwarded-host'] || q.headers.host || '').split(',')[0].trim());
// يحوّل الروابط النسبية في رأس الصفحة الرئيسية إلى روابط مطلقة (canonical / og:url / og:image / twitter:image)
const absHome = (html, o) => html
  .replace('<link rel="canonical" href="/">', '<link rel="canonical" href="' + o + '/">')
  .replace('<meta property="og:url" content="/">', '<meta property="og:url" content="' + o + '/">')
  .split('content="/img/hero.jpg"').join('content="' + o + '/img/hero.jpg"');
if (home) app.get(['/', '/index.html'], (q, s) => { s.set('Cache-Control', 'public, max-age=0, s-maxage=300, stale-while-revalidate=86400'); s.type('html').send(absHome(home, origin(q))); });
if (admin) app.get(['/admin', '/admin/'], (q, s) => { s.set('X-Robots-Tag', 'noindex, nofollow'); s.type('html').send(admin); });
if (content) app.get(['/content', '/content/', '/content.html'], (q, s) => s.type('html').send(content));
// /articles و /articles/:slug تُخدَّم الآن من lib/app.js (صفحات مُصيَّرة من السيرفر لمحركات البحث)
app.use(require('./lib/app'));
module.exports = app;
