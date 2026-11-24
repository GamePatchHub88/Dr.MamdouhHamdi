/* =====================================================================
   Migration 001 — سجل فحوصات السرعة  (مجموعة: speedruns)
   المشروع يعمل على MongoDB فلا يوجد SQL؛ هذا هو المكافئ الكامل لإنشاء «الجدول».

   التشغيل (مرة واحدة، وهو اختياري لأن Mongoose ينشئ المجموعة والفهرس تلقائياً عند أول فحص):
     mongosh "<MONGODB_URI>" --file migrations/001_speed_runs.mongosh.js

   الحقول المحفوظة لكل فحص:
     score (0-100) · grade · partial · headline · durationMs
     tests[]     كل اختبار: id, group, label, rating, score, display, rows, raw, error ...
     diagnosis   { healthy, headline, topKey, causes[ {key,label,pct,cost,level,facts,reco[]} ], counts }
     metrics     أرقام مختصرة للرسم البياني (ping, home, dbq, cold, rtt, imgKB ...)
     env         { vercelRegion, dbRegion, node, instance, origin }
     createdAt   وقت الفحص
   الاحتفاظ: آخر 20 فحصاً فقط (يحذف التطبيق الأقدم بعد كل فحص).
   ===================================================================== */
const COL = 'speedruns';

const validator = {
  $jsonSchema: {
    bsonType: 'object',
    required: ['score', 'createdAt'],
    properties: {
      score:      { bsonType: 'number', minimum: 0, maximum: 100 },
      grade:      { bsonType: 'string' },
      partial:    { bsonType: 'bool' },
      headline:   { bsonType: 'string' },
      durationMs: { bsonType: 'number', minimum: 0 },
      tests:      { bsonType: 'array' },
      diagnosis:  { bsonType: 'object' },
      metrics:    { bsonType: 'object' },
      env:        { bsonType: 'object' },
      createdAt:  { bsonType: 'date' }
    }
  }
};

if (!db.getCollectionNames().includes(COL)) {
  // validationAction=warn: يسجّل التحذير فقط ولا يرفض الكتابة (لا يكسر الفحص إن تغيّر شكل الحقول لاحقاً)
  db.createCollection(COL, { validator, validationLevel: 'moderate', validationAction: 'warn' });
  print('created collection ' + COL);
} else {
  db.runCommand({ collMod: COL, validator, validationLevel: 'moderate', validationAction: 'warn' });
  print('collection ' + COL + ' already exists — validator updated');
}

// نفس الفهرس الذي يعرّفه Mongoose (createdAt تنازلي) — الاسم والمواصفات متطابقة فلا يحدث تعارض
db[COL].createIndex({ createdAt: -1 }, { name: 'createdAt_-1' });

// تنظيف اختياري: إبقاء آخر 20 فقط (يفيد لو شغّلته بعد تجارب كثيرة)
const keep = db[COL].find({}, { _id: 1 }).sort({ createdAt: -1 }).limit(20).toArray().map(d => d._id);
if (keep.length === 20) print('trimmed: ' + db[COL].deleteMany({ _id: { $nin: keep } }).deletedCount);

printjson(db[COL].getIndexes().map(i => i.name));

/* تراجُع (Rollback) عند الحاجة:
   db.speedruns.drop()
*/
