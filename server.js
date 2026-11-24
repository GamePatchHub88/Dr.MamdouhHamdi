const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
const read = (...p) => { try { return fs.readFileSync(path.join(__dirname, 'public', ...p), 'utf8'); } catch { return null; } };
const admin = read('admin', 'index.html'), content = read('content.html');
// المسار القديم لقسم «التخزين» صار تبويباً داخل «إدارة الموقع»
app.get(['/admin/storage', '/admin/storage/', '/admin/site', '/admin/site/'], (q, s) => s.redirect(301, '/admin/?view=site&tab=storage'));
if (admin) app.get(['/admin', '/admin/'], (q, s) => { s.set('X-Robots-Tag', 'noindex, nofollow'); s.type('html').send(admin); });
if (content) app.get(['/content', '/content/', '/content.html'], (q, s) => s.type('html').send(content));
// الصفحة الرئيسية (/) و /articles و /articles/:slug تُخدَّم الآن من lib/app.js (صفحات مُصيَّرة من السيرفر لمحركات البحث)
app.use(require('./lib/app'));
module.exports = app;
