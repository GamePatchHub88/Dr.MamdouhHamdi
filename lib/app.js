require('dotenv').config();
const express=require('express'),mongoose=require('mongoose'),jwt=require('jsonwebtoken'),crypto=require('crypto');
const Rich=require('../public/js/rich.js'),docx=require('./docx.js'),Q=require('./qcluster.js');
const speed=require('./speed'),BOOT=speed.boot(); // فحص السرعة (إدارة الموقع ← فحص السرعة)
const Tests=require('../public/js/tests-data.js');
const app=express();app.set('etag',false);app.use(express.json({limit:'1mb'}));
/* ---------- التخزين المؤقت لتقليل استهلاك CPU على Vercel ----------
   CC: كاش الـCDN (s-maxage) — الطلب المخزّن لا يشغّل الدالة إطلاقاً. stale-while-revalidate يخدم النسخة القديمة فوراً ويجدّدها بالخلفية.
   memo: كاش داخل الذاكرة للنسخة الدافئة من الدالة (يُمسح عند أي كتابة). عدّل الأرقام (بالثواني) من هنا. */
const TTL={api:60,settings:120,comments:15,page:900,list:600,static:86400,swr:86400};
const CC=(sec,swr)=>'public, max-age=0, s-maxage='+sec+', stale-while-revalidate='+(swr==null?TTL.swr:swr);
const MEMO=new Map();const memo=async(k,ms,fn)=>{const n=Date.now(),e=MEMO.get(k);if(e&&n-e.t<ms)return e.v;const v=await fn();MEMO.set(k,{t:n,v});if(MEMO.size>150)MEMO.delete(MEMO.keys().next().value);return v};
let conn;const connect=()=>conn||(conn=(t=>mongoose.connect(process.env.MONGODB_URI,{serverSelectionTimeoutMS:8000,maxPoolSize:8,maxIdleTimeMS:60000}).then(r=>{BOOT.dbMs=Date.now()-t;return r}))(Date.now()));
app.disable('x-powered-by');
app.use((q,s,n)=>{BOOT.n++;n()});speed.early(app,{jwt,BOOT}); // /api/admin/speed/ping: قياس شبكة خالص قبل middleware القاعدة
app.use('/api',(q,s,n)=>{if(!q.path.startsWith('/img'))s.set('X-Robots-Tag','noindex, nofollow');n()});
app.use('/api',async(q,s,n)=>{try{await connect();await backfill();n()}catch(e){conn=null;s.status(500).json({error:'db: '+e.message})}});
/* أي كتابة تمسّ الصور/الإعدادات/المحتوى تُبطل كاش لوحة التخزين (القراءات لا تفعل) */
let stC=null;app.use('/api',(q,s,n)=>{if(q.method!=='GET'&&/^\/(images|settings|items)/.test(q.path)&&!/\/(view|like)$/.test(q.path)){stC=null;MEMO.clear()}n()});
const LogS=new mongoose.Schema({m:String,p:String,id:String},{timestamps:{createdAt:true,updatedAt:false}});LogS.index({createdAt:1},{expireAfterSeconds:7776000});const Log=mongoose.model('Log',LogS);
const Day=mongoose.model('Day',new mongoose.Schema({d:{type:String,unique:true},views:{type:Number,default:0}}));
app.use('/api',(q,s,n)=>{if(q.method!='GET'&&isAdmin(q)){const p=q.originalUrl.split('?')[0].slice(0,90),m=q.method,id=String(q.query.id||'');s.on('finish',()=>{if(s.statusCode<400)Log.create({m,p,id}).catch(()=>{})})}n()});
const Item=mongoose.model('Item',new mongoose.Schema({type:String,title:String,desc:String,body:String,url:String,image:String,slug:{type:String,index:true},draft:{type:Boolean,default:false},views:{type:Number,default:0},likes:{type:Number,default:0},words:Number,ogImage:String,ogFor:String},{timestamps:true}));
const Question=mongoose.model('Question',new mongoose.Schema({text:String,cat:String,status:{type:String,default:'new'},itemId:String,norm:String,gid:{type:String,index:true},sug:String},{timestamps:true}));
const Setting=mongoose.model('Setting',new mongoose.Schema({key:{type:String,unique:true},value:String}));
const Booking=mongoose.model('Booking',new mongoose.Schema({name:String,phone:String,message:String,status:{type:String,default:'new'},note:String,appt:String},{timestamps:true}));
const BST=['new','contacted','confirmed','done','noshow'],BSL={new:'جديد',contacted:'تم التواصل',confirmed:'مؤكد',done:'تمت الجلسة',noshow:'لم يحضر'}; // حالات الحجز (كانبان)؛ الحجوزات القديمة new/done تبقى كما هي
const Img=mongoose.model('Img',new mongoose.Schema({name:String,type:String,size:Number,data:Buffer},{timestamps:true}));
const Comment=mongoose.model('Comment',new mongoose.Schema({item:{type:String,index:true},name:String,text:String,status:{type:String,default:'ok'},token:{type:String,select:false},editedAt:Date},{timestamps:true}));
const auth=(q,s,n)=>{try{jwt.verify((q.headers.authorization||'').slice(7),process.env.JWT_SECRET);n()}catch{s.sendStatus(401)}};
const h=f=>(q,s)=>f(q,s).catch(e=>s.status(500).json({error:e.message}));
const valid=id=>mongoose.isValidObjectId(id);
const FIELDS=['type','title','slug','desc','body','url','image','draft','ogImage','ogFor'];
const pid=q=>q.params.id||q.query.id;
const isAdmin=q=>{if(!q.headers.authorization)return false;try{jwt.verify((q.headers.authorization||'').slice(7),process.env.JWT_SECRET);return true}catch{return false}};
/* ---------- slugs (Arabic-friendly) ---------- */
const SL=t=>String(t||'').normalize('NFKC').replace(/[\u064B-\u065F\u0670\u0640]/g,'').toLowerCase().trim().replace(/[^\p{L}\p{N}]+/gu,'-').replace(/^-+|-+$/g,'').slice(0,80).replace(/-+$/,'');
const uniq=async(base,id)=>{const b=base||'article-'+Date.now().toString(36);let c=b,n=1;while(await Item.exists(id?{slug:c,_id:{$ne:id}}:{slug:c})){n++;c=b+'-'+n}return c};
let slugged=false;const backfill=async()=>{if(slugged)return;slugged=true;try{const L=await Item.find({type:'article',$or:[{slug:{$exists:false}},{slug:''},{slug:null}]}).sort('createdAt').select('_id title').lean();for(const i of L)await Item.updateOne({_id:i._id},{slug:await uniq(SL(i.title),i._id)},{timestamps:false})}catch(e){slugged=false}};
// prepares item fields for create / update (old = existing item when updating)
const prep=async(b,old)=>{const d=pick(b),t=d.type||(old&&old.type);if(typeof d.body=='string'){d.body=Rich.cleanSource(d.body);d.words=Rich.words(d.body)}if('draft' in d)d.draft=d.draft===true||d.draft==='true';if(t=='article'){const given='slug' in d;let w=given?SL(d.slug):'';if(!w)w=(!given&&old&&old.slug)?old.slug:SL(d.title||(old&&old.title));d.slug=await uniq(w,old&&old._id)}else delete d.slug;return d};
const pick=b=>Object.fromEntries(FIELDS.filter(k=>b&&k in b).map(k=>[k,b[k]]));

/* ---------- images stored in MongoDB ---------- */
const IMG='/api/img/';
const imgId=u=>typeof u=='string'&&u.startsWith(IMG)?u.slice(IMG.length).split(/[?#]/)[0]:null;
// map of imageId -> where it is used
const usage=async()=>{const[items,sets]=await Promise.all([Item.find().select('title type image body ogImage').lean(),Setting.find().lean()]);const m=new Map();const add=(id,r)=>{if(!m.has(id))m.set(id,[]);m.get(id).push(r)};
for(const i of items){const a=imgId(i.image),og=imgId(i.ogImage);if(a)add(a,{kind:'item',label:i.title||'',type:i.type});if(og)add(og,{kind:'item',label:i.title||'',type:i.type});for(const x of String(i.body||'').matchAll(/\/api\/img\/([a-f0-9]{24})/g))if(x[1]!==a)add(x[1],{kind:'item',label:i.title||'',type:i.type})}
for(const st of sets){const a=imgId(st.value);if(a)add(a,{kind:'setting',label:st.key})}return m};
const bodyIds=b=>[...String(b||'').matchAll(/\/api\/img\/([a-f0-9]{24})/g)].map(m=>m[1]);
const gcIds=async ids=>{ids=[...new Set(ids.filter(Boolean))].filter(valid);if(!ids.length)return;const u=await usage();for(const id of ids)if(!u.has(id))await Img.findByIdAndDelete(id)};
const gc=u=>gcIds([imgId(u)]);
const OKT=['image/jpeg','image/png','image/webp','image/gif'];
app.post('/api/images',auth,express.raw({type:'image/*',limit:'4mb'}),h(async(q,s)=>{const t=(q.headers['content-type']||'').split(';')[0].trim();if(!OKT.includes(t)||!Buffer.isBuffer(q.body)||!q.body.length)return s.status(400).json({error:'bad image'});const d=await Img.create({type:t,size:q.body.length,name:String(q.query.name||'').slice(0,80),data:q.body});s.json({_id:d._id,url:IMG+d._id,size:d.size})}));
app.get(['/api/img/:id','/api/img'],h(async(q,s)=>{const id=pid(q);if(!valid(id))return s.sendStatus(404);const d=await Img.findById(id);if(!d)return s.sendStatus(404);s.set({'Content-Type':d.type,'Cache-Control':'public, max-age=31536000, s-maxage=31536000, immutable','X-Content-Type-Options':'nosniff'});s.send(Buffer.from(d.data))}));
const delImgs=async ids=>{let n=0,freed=0;for(const id of ids){if(!valid(id))continue;const d=await Img.findById(id).select('size');if(!d)continue;const u=IMG+id;await Item.updateMany({image:u},{image:''});await Item.updateMany({ogImage:u},{ogImage:'',ogFor:''});await Setting.updateMany({value:u},{value:''});await Img.findByIdAndDelete(id);n++;freed+=d.size||0}return{deleted:n,freed}};
app.post('/api/images/delete',auth,h(async(q,s)=>s.json(await delImgs(Array.isArray(q.body.ids)?q.body.ids:[]))));
app.post('/api/images/cleanup',auth,h(async(q,s)=>{const u=await usage(),L=await Img.find().select('_id').lean();s.json(await delImgs(L.map(x=>String(x._id)).filter(id=>!u.has(id))))}));
/* ---------- import a Word file as article text (docx → editor syntax); images are stored like uploaded ones ---------- */
app.post('/api/import/docx',auth,express.raw({type:()=>true,limit:'4mb'}),async(q,s)=>{try{if(!Buffer.isBuffer(q.body)||q.body.length<100)return s.status(400).json({error:'ملف فارغ'});
const r=await docx.convert(q.body,{onImage:async(buf,mime,name)=>{const d=await Img.create({type:mime,size:buf.length,name:String(name||'').slice(0,80),data:buf});return IMG+d._id}});
r.body=Rich.cleanSource(r.body);s.json(r)}catch(e){s.status(422).json({error:e.message||'تعذر قراءة الملف'})}});
/* ---------- link-card metadata (admin only; blocks private / local addresses) ---------- */
const dns=require('dns').promises,net=require('net');
const privIp=ip=>{if(net.isIPv6(ip)){const l=ip.toLowerCase();return l=='::1'||l=='::'||/^(fc|fd|fe[89ab])/.test(l)||/^::ffff:/.test(l)&&privIp(l.slice(7))}const p=ip.split('.').map(Number);return p[0]==10||p[0]==127||p[0]==0||p[0]==169&&p[1]==254||p[0]==172&&p[1]>=16&&p[1]<=31||p[0]==192&&p[1]==168||p[0]==100&&p[1]>=64&&p[1]<=127||p[0]>=224};
const okHost=async u=>{if(!/^https?:$/.test(u.protocol)||u.username||u.password||(u.port&&!['80','443'].includes(u.port)))return false;if(net.isIP(u.hostname))return !privIp(u.hostname);const L=await dns.lookup(u.hostname,{all:true});return L.length>0&&L.every(x=>!privIp(x.address))};
const metaOf=(h,base)=>{const g=(re)=>{const m=h.match(re);return m?m[1]:''},un=t=>String(t||'').replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos|nbsp);/gi,(m,c)=>{c=c.toLowerCase();if(c[0]=='#'){const n=parseInt(c[1]=='x'?c.slice(2):c.slice(1),c[1]=='x'?16:10);return n>0&&n<65536?String.fromCharCode(n):''}return{amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '}[c]}).replace(/\s+/g,' ').trim();
const mt=k=>{const r=new RegExp('<meta[^>]+(?:property|name)=["\']'+k+'["\'][^>]*>','i'),t=h.match(r);if(!t)return '';const c=t[0].match(/content=("([^"]*)"|'([^']*)')/i);return c?c[2]??c[3]:''};
let img=un(mt('og:image')||mt('twitter:image'));try{img=img?new URL(img,base).href:''}catch(e){img=''}
return{title:un(mt('og:title')||mt('twitter:title')||g(/<title[^>]*>([\s\S]*?)<\/title>/i)).slice(0,160),desc:un(mt('og:description')||mt('description')).slice(0,200),image:/^https?:\/\//.test(img)?img:''}};
app.get('/api/linkmeta',auth,async(q,s)=>{try{let u=new URL(String(q.query.url||'')),hops=0,res;while(true){if(!await okHost(u))return s.status(400).json({error:'رابط غير مسموح'});
res=await fetch(u,{redirect:'manual',signal:AbortSignal.timeout(6000),headers:{'User-Agent':'Mozilla/5.0 (compatible; LinkPreview/1.0)',Accept:'text/html'}});
if(res.status>=300&&res.status<400&&res.headers.get('location')&&hops++<3){u=new URL(res.headers.get('location'),u);continue}break}
if(!res.ok||!/html/i.test(res.headers.get('content-type')||''))return s.json({url:u.href,title:'',desc:'',image:''});
const rd=res.body.getReader();let b='',n=0;while(n<4e5){const{done,value}=await rd.read();if(done)break;n+=value.length;b+=Buffer.from(value).toString('utf8');if(/<\/head>/i.test(b))break}try{rd.cancel()}catch(e){}
s.json({url:u.href,...metaOf(b,u.href)})}catch(e){s.status(400).json({error:'تعذر جلب بيانات الرابط'})}});
/* ---------- storage overview (MongoDB: قاعدة البيانات + الصور/الملفات المخزّنة داخلها) — كاش 60 ثانية، ?refresh=1 لتجاوزه ---------- */
const ST_TTL=60e3,kindOf=t=>/^image\//i.test(t||'')?'images':/^video\//i.test(t||'')?'video':'files';
app.get('/api/storage',auth,h(async(q,s)=>{
if(!q.query.refresh&&stC&&Date.now()-stC.t<ST_TTL)return s.json({...stC.v,cached:true});
const db=mongoose.connection.db;let st={};try{st=await db.stats()}catch{}
const sz=async M=>{try{const r=await M.aggregate([{$group:{_id:null,n:{$sum:1},b:{$sum:{$bsonSize:'$$ROOT'}}}}]);return{count:r[0]?.n||0,bytes:r[0]?.b??0}}catch{return{count:await M.countDocuments(),bytes:null}}};
const cols=[];for(const[key,label,M]of[['items','المحتوى',Item],['comments','التعليقات',Comment],['bookings','الحجوزات',Booking],['questions','الأسئلة',Question],['settings','الإعدادات',Setting],['images','الصور',Img],['log','سجل النشاط',Log],['days','إحصاءات الزيارات',Day]])cols.push({key,label,...await sz(M)});
const u=await usage(),imgs=(await Img.find().select('-data').sort('-createdAt').lean()).map(x=>({_id:x._id,size:x.size||0,type:x.type,name:x.name,createdAt:x.createdAt,usedBy:u.get(String(x._id))||[]}));
const q0=await Setting.findOne({key:'storage_quota_mb'}),envQ=+process.env.STORAGE_QUOTA_MB||0,est=cols.reduce((a,c)=>a+(c.bytes||0),0);
const quotaMB=+(q0&&q0.value)||envQ||512,dataSize=st.dataSize??est,indexSize=st.indexSize??0,storageSize=st.storageSize??est,used=dataSize+indexSize,quota=quotaMB*1048576;
const by={images:{bytes:0,count:0},video:{bytes:0,count:0},files:{bytes:0,count:0}};for(const x of imgs){const k=by[kindOf(x.type)];k.bytes+=x.size;k.count++}
const g=k=>(cols.find(c=>c.key===k)||{}).bytes||0,dbB=['items','comments','bookings','settings','questions'].reduce((a,k)=>a+g(k),0),media=by.images.bytes+by.video.bytes+by.files.bytes;
const breakdown=[{key:'images',label:'صور',...by.images},{key:'video',label:'فيديو',...by.video},{key:'files',label:'ملفات',...by.files},{key:'database',label:'قاعدة البيانات (محتوى وتعليقات وحجوزات وإعدادات)',bytes:dbB,count:cols.filter(c=>['items','comments','bookings','settings','questions'].includes(c.key)).reduce((a,c)=>a+c.count,0)},{key:'indexes',label:'الفهارس',bytes:indexSize,count:0},{key:'other',label:'أخرى (سجلات وإحصاءات وهوامش التخزين)',bytes:Math.max(0,used-media-dbB-indexSize),count:0}];
const v={provider:'MongoDB',quotaMB,quotaSource:q0&&q0.value?'setting':envQ?'env':'default',quotaBytes:quota,usedBytes:used,freeBytes:Math.max(0,quota-used),pct:quota?used/quota*100:0,
dataSize,storageSize,indexSize,exact:st.dataSize!=null,collections:cols,images:imgs,breakdown,
split:{files:{bytes:media,count:imgs.length},database:{bytes:Math.max(0,used-media)},total:used},generatedAt:new Date().toISOString(),ttl:ST_TTL/1000};
stC={t:Date.now(),v};s.json({...v,cached:false})}));

/* ---------- auth / settings ---------- */
const lf=new Map(),dig=x=>crypto.createHash('sha256').update(String(x||'')).digest();
app.post('/api/login',(q,s)=>{const ip=String(q.headers['x-forwarded-for']||q.ip||'').split(',')[0].trim(),n=Date.now(),L=(lf.get(ip)||[]).filter(t=>n-t<9e5);
if(L.length>=5){lf.set(ip,L);return s.status(429).json({error:'many'})}
const ok=!!process.env.ADMIN_PASSWORD&&crypto.timingSafeEqual(dig(q.body&&q.body.password),dig(process.env.ADMIN_PASSWORD));
if(!ok){L.push(n);lf.set(ip,L);return s.sendStatus(401)}lf.delete(ip);s.json({token:jwt.sign({a:1},process.env.JWT_SECRET,{expiresIn:'7d'})})});
const getSet=async()=>Object.fromEntries((await Setting.find().lean()).map(x=>[x.key,x.value]));
app.get('/api/settings',h(async(q,s)=>{const adm=isAdmin(q);s.set('Cache-Control',adm?'private, no-store':CC(TTL.settings));s.json(adm?await getSet():await memo('settings',TTL.api*1e3,getSet))}));
app.put('/api/settings',auth,h(async(q,s)=>{for(const[k,v]of Object.entries(q.body)){const old=await Setting.findOne({key:k});await Setting.updateOne({key:k},{value:v},{upsert:true});if(old&&old.value&&old.value!==v&&imgId(old.value))await gc(old.value)}s.json({ok:1})}));

/* ---------- items ---------- */
const one=async(key,s,adm)=>{key=String(key||'');let i=null;if(/^[a-f0-9]{24}$/i.test(key))i=await Item.findById(key).lean();if(!i&&key)i=await Item.findOne({slug:key}).lean()||await Item.findOne({slug:SL(key)}).lean();if(i&&i.draft&&!adm)i=null;s.set('Cache-Control',adm||!i?'no-store':CC(TTL.api));i?s.json(i):s.status(404).json({error:'not found'})};
const listItems=async(flt,lim,l)=>{let c=Item.find(flt).sort('-createdAt');if(lim)c=c.limit(lim);if(l)c=c.select('-body');const L=await c.lean();if(!l)return L;
/* عناصر قديمة بلا عدّاد كلمات: يُحسب مرة واحدة ويُحفظ (بعدها لا يُحمَّل نص المقال إطلاقاً في القوائم) */
const miss=L.filter(i=>i.words==null);if(miss.length){const B=await Item.find({_id:{$in:miss.map(i=>i._id)}}).select('body').lean(),m=new Map(B.map(b=>[String(b._id),Rich.words(b.body||'')]));for(const i of miss){i.words=m.get(String(i._id))||0;Item.updateOne({_id:i._id},{words:i.words},{timestamps:false}).catch(()=>{})}}
return L.map(i=>({...i,words:i.words||0,hasBody:(i.words||0)>0}))};
app.get('/api/items',h(async(q,s)=>{const{id,slug,type,limit,lite:l}=q.query;const adm=isAdmin(q);if(id||slug)return one(id||slug,s,adm);const flt=type?{type:String(type)}:{};if(!adm)flt.draft={$ne:true};const lim=+limit>0?Math.min(+limit,200):0;
s.set('Cache-Control',adm?'private, no-store':CC(TTL.api));const run=()=>listItems(flt,lim,!!l);s.json(adm?await run():await memo('items:'+JSON.stringify([flt,lim,!!l]),TTL.api*1e3,run))}));
app.get('/api/items/:id',h(async(q,s)=>one(q.params.id,s,isAdmin(q))));
app.post('/api/items',auth,h(async(q,s)=>s.json(await Item.create(await prep(q.body)))));
app.put(['/api/items/:id','/api/items'],auth,h(async(q,s)=>{const id=pid(q);const old=valid(id)?await Item.findById(id).select('image body type slug title ogImage').lean():null;if(!old)return s.status(404).json({error:'not found'});const onlyOg=Object.keys(q.body||{}).every(k=>k=='ogImage'||k=='ogFor');const i=await Item.findByIdAndUpdate(id,await prep(q.body,old),{new:true,timestamps:!onlyOg}).lean();await gcIds([imgId(old.image),imgId(old.ogImage),...bodyIds(old.body)]);s.json(i)}));
app.delete(['/api/items/:id','/api/items'],auth,h(async(q,s)=>{const old=valid(pid(q))?await Item.findByIdAndDelete(pid(q)):null;if(old){await Comment.deleteMany({item:String(old._id)});await gcIds([imgId(old.image),imgId(old.ogImage),...bodyIds(old.body)])}s.json({ok:1})}));
const bump=(inc,up)=>h(async(q,s)=>{const id=pid(q);if(!valid(id))return s.sendStatus(404);const dn=up&&q.body&&q.body.on===false;let i;if(inc=='views')i=await Item.findByIdAndUpdate(id,{$inc:{views:1}},{new:true,timestamps:false}).select('views likes');else i=await Item.findOneAndUpdate(dn?{_id:id,likes:{$gt:0}}:{_id:id},{$inc:{likes:dn?-1:1}},{new:true,timestamps:false}).select('views likes')||await Item.findById(id).select('views likes');if(i&&inc=='views')Day.updateOne({d:new Date().toISOString().slice(0,10)},{$inc:{views:1}},{upsert:true}).catch(()=>{});i?s.json({views:i.views||0,likes:i.likes||0}):s.sendStatus(404)});
app.post(['/api/items/:id/view','/api/view'],bump('views'));
app.post(['/api/items/:id/like','/api/like'],bump('likes',1));

/* ---------- comments ---------- */
const sha=t=>crypto.createHash('sha256').update(String(t||'')).digest('hex');
// the comment's author is recognised by a secret token that only his browser holds
const mine=async q=>{const t=q.headers['x-comment-token'];if(!t||!valid(pid(q)))return null;const c=await Comment.findById(pid(q)).select('+token');return c&&c.token&&c.token===sha(t)?c:null};
const hits=new Map();const limited=(ip,k)=>{k=(k||'c')+':'+ip;const n=Date.now(),a=(hits.get(k)||[]).filter(t=>n-t<600000);if(a.length>=5){hits.set(k,a);return true}a.push(n);hits.set(k,a);if(hits.size>5000)for(const[x,v]of hits)if(!v.some(t=>n-t<600000))hits.delete(x);return false};
app.get('/api/comments',h(async(q,s)=>{if(!valid(q.query.item))return s.json([]);s.set('Cache-Control',CC(TTL.comments,120));s.json(await Comment.find({item:q.query.item,status:'ok'}).sort('-createdAt').limit(200).select('name text createdAt editedAt').lean())}));
app.post('/api/comments',h(async(q,s)=>{const{item,name,text,website}=q.body||{};if(website)return s.json({ok:1,status:'ok'});
const n=String(name||'').trim().slice(0,60),t=String(text||'').trim().slice(0,1500);if(!valid(item)||n.length<2||t.length<2)return s.sendStatus(400);
const ip=String(q.headers['x-forwarded-for']||q.ip||'').split(',')[0].trim();if(limited(ip))return s.status(429).json({error:'rate'});
if(!(await Item.exists({_id:item})))return s.sendStatus(404);
if(await Comment.exists({item,name:n,text:t}))return s.json({ok:1,status:'ok',comment:null});
const m=await Setting.findOne({key:'comments_mode'}),status=m&&m.value=='moderate'?'pending':'ok',tk=crypto.randomBytes(16).toString('hex'),c=await Comment.create({item,name:n,text:t,status,token:sha(tk)});
s.json({ok:1,status,token:tk,comment:status=='ok'?{_id:c._id,name:n,text:t,createdAt:c.createdAt}:null})}));
app.get('/api/admin/comments',auth,h(async(q,s)=>{const L=await Comment.find().sort('-createdAt').limit(500).lean(),its=await Item.find({_id:{$in:[...new Set(L.map(c=>c.item).filter(valid))]}}).select('title type').lean(),m=Object.fromEntries(its.map(i=>[String(i._id),i]));s.json(L.map(c=>({...c,itemTitle:(m[c.item]||{}).title||'(محذوف)',itemType:(m[c.item]||{}).type||''})))}));
app.put(['/api/comments/:id','/api/comments'],h(async(q,s)=>{const id=pid(q);if(!valid(id))return s.sendStatus(404);const B=q.body||{};
if(isAdmin(q)){const u={};if(B.status)u.status=B.status=='pending'?'pending':'ok';if(typeof B.text=='string'&&B.text.trim().length>1){u.text=B.text.trim().slice(0,1500);u.editedAt=new Date()}return s.json(await Comment.findByIdAndUpdate(id,u,{new:true}))}
const c=await mine(q);if(!c)return s.sendStatus(403);const t=String(B.text||'').trim().slice(0,1500);if(t.length<2)return s.sendStatus(400);
const m=await Setting.findOne({key:'comments_mode'});c.text=t;c.editedAt=new Date();if(m&&m.value=='moderate')c.status='pending';await c.save();
s.json({ok:1,status:c.status,comment:c.status=='ok'?{_id:c._id,name:c.name,text:c.text,createdAt:c.createdAt,editedAt:c.editedAt}:null})}));
app.delete(['/api/comments/:id','/api/comments'],h(async(q,s)=>{const id=pid(q);if(!valid(id))return s.sendStatus(404);if(!isAdmin(q)&&!(await mine(q)))return s.sendStatus(403);await Comment.findByIdAndDelete(id);s.json({ok:1})}));

/* ---------- أسئلة مجهولة: لا اسم ولا هاتف ولا IP يُخزَّن (المحدِّد يعمل في الذاكرة فقط) ---------- */
const QCAT=['زوجي وأسري','أطفال ومراهقون','نفسي وقلق','إدمان سلوكي','أخرى'];
app.post('/api/questions',h(async(q,s)=>{const B=q.body||{};s.set('Cache-Control','no-store');if(B.website)return s.json({ok:1});
const text=String(B.text||'').replace(/\r/g,'').replace(/\n{3,}/g,'\n\n').trim().slice(0,1000),cat=QCAT.includes(B.cat)?B.cat:'';if(text.length<15)return s.sendStatus(400);
if(limited(String(q.headers['x-forwarded-for']||q.ip||'').split(',')[0].trim(),'q'))return s.status(429).json({error:'rate'});await qBackfill();const tk=Q.toks(text),pool=(await Question.find({gid:{$exists:true,$ne:''},norm:{$exists:true,$ne:''}}).sort('-createdAt').limit(600).select('gid norm').lean()).map(x=>({gid:x.gid,toks:String(x.norm).split(' ')}));
const d=new Question({text,cat,norm:tk.join(' ')});d.gid=Q.assign(tk,pool)||String(d._id);const sg=Q.suggest(await qIndex(),tk,cat);d.sug=sg?sg.id:'';await d.save();s.json({ok:1})}));
/* تجميع الأسئلة: فهرس المقالات المنشورة (مُخزَّن مؤقتاً ويُبطَل مع أي تعديل على المحتوى) + تعبئة الأسئلة القديمة مرة واحدة */
const qIndex=()=>memo('qix',3e5,async()=>Q.buildIndex((await Item.find({type:'article',draft:{$ne:true}}).select('title desc body slug').limit(300).lean()).map(a=>({...a,body:Rich.plainText(a.body||'')}))));
let qFilled=false;const qBackfill=async()=>{if(qFilled)return;qFilled=true;try{const L=await Question.find({$or:[{gid:{$exists:false}},{gid:''},{gid:null}]}).sort('createdAt').limit(1000).lean();if(!L.length)return;
const pool=(await Question.find({gid:{$exists:true,$ne:''},norm:{$exists:true,$ne:''}}).select('gid norm').lean()).map(x=>({gid:x.gid,toks:String(x.norm).split(' ')})),ix=await qIndex();
for(const x of L){const tk=Q.toks(x.text),g=Q.assign(tk,pool)||String(x._id),sg=Q.suggest(ix,tk,x.cat);await Question.updateOne({_id:x._id},{norm:tk.join(' '),gid:g,sug:sg?sg.id:''},{timestamps:false});pool.push({gid:g,toks:tk})}}catch(e){qFilled=false}};
/* «الأكثر سؤالاً» (عام): مجموعات فيها سؤالان فأكثر، نص مُنظَّف من أي معلومة تعريفية، بلا تواريخ ولا معرّفات؛ المؤرشف لا يُحتسب */
app.get('/api/questions/top',h(async(q,s)=>{s.set('Cache-Control',CC(TTL.list));s.json(await memo('qtop',3e5,async()=>{await qBackfill();
const L=await Question.find({status:{$ne:'arch'},gid:{$exists:true,$ne:''}}).sort('-createdAt').limit(1000).select('text cat gid status itemId sug').lean(),G=new Map();
for(const x of L){if(!G.has(x.gid))G.set(x.gid,[]);G.get(x.gid).push(x)}
const ix=await qIndex(),by=new Map(ix.docs.map(d=>[d.id,d])),out=[];
for(const m of G.values()){if(m.length<2)continue;let rep='';for(const x of m){const t=Q.scrub(x.text);if(t.length>=15&&(!rep||t.length<rep.length))rep=t}if(!rep)continue;
const dn=m.find(x=>x.status=='done'&&x.itemId&&by.has(String(x.itemId))),sid=dn?String(dn.itemId):(m.map(x=>x.sug).find(x=>x&&by.has(x))||''),a=sid?by.get(sid):null,cc={};m.forEach(x=>{if(x.cat)cc[x.cat]=(cc[x.cat]||0)+1});
out.push({q:Q.clip(rep,150),n:m.length,cat:Object.keys(cc).sort((u,v)=>cc[v]-cc[u])[0]||'',art:a&&a.slug?{slug:a.slug,title:a.title}:null})}
return out.sort((u,v)=>v.n-u.n).slice(0,6)}))}));
app.get('/api/questions',auth,h(async(q,s)=>{s.set('Cache-Control','no-store');await qBackfill();s.json(await Question.find().sort('-createdAt').limit(300).select('-norm').lean())}));
app.put('/api/questions/:id',auth,h(async(q,s)=>{if(!valid(q.params.id))return s.sendStatus(404);const B=q.body||{},u={};if(['new','done','arch'].includes(B.status))u.status=B.status;if(typeof B.itemId=='string')u.itemId=B.itemId.slice(0,40);s.json(await Question.findByIdAndUpdate(q.params.id,u,{new:true}))}));
app.delete('/api/questions/:id',auth,h(async(q,s)=>{if(valid(q.params.id))await Question.findByIdAndDelete(q.params.id);s.json({ok:1})}));
/* ---------- bookings ---------- */
app.post('/api/bookings',h(async(q,s)=>{const B=q.body||{},name=String(B.name||'').trim().slice(0,80),phone=String(B.phone||'').trim().slice(0,30),message=String(B.message||'').trim().slice(0,2000);if(!name||!phone||name.length<2||phone.replace(/\D/g,'').length<7||phone.replace(/\D/g,'').length>15)return s.sendStatus(400);
if(limited(String(q.headers['x-forwarded-for']||q.ip||'').split(',')[0].trim(),'b'))return s.status(429).json({error:'rate'});await Booking.create({name,phone,message});s.json({ok:1})}));
app.get('/api/bookings',auth,h(async(q,s)=>s.json(await Booking.find().sort('-createdAt'))));
app.put('/api/bookings/:id',auth,h(async(q,s)=>{const u={},B=q.body||{};if('status' in B){if(!BST.includes(B.status))return s.sendStatus(400);u.status=B.status}if(typeof B.note=='string')u.note=B.note.slice(0,500);if(typeof B.appt=='string'){const a=B.appt.trim();u.appt=/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(a)?a:''}s.json(await Booking.findByIdAndUpdate(q.params.id,u,{new:true}))}));
app.delete('/api/bookings/:id',auth,h(async(q,s)=>{await Booking.findByIdAndDelete(q.params.id);s.json({ok:1})}));
/* ---------- admin: bulk actions / CSV export / full backup ---------- */
const bids=q=>(Array.isArray(q.body&&q.body.ids)?q.body.ids:[]).filter(valid).slice(0,300);
app.post('/api/items/bulk',auth,h(async(q,s)=>{const L=bids(q),a=q.body.action;
if(a=='delete'){const o=await Item.find({_id:{$in:L}}).select('image body ogImage').lean();await Item.deleteMany({_id:{$in:L}});await Comment.deleteMany({item:{$in:L}});await gcIds(o.flatMap(x=>[imgId(x.image),imgId(x.ogImage),...bodyIds(x.body)]))}
else if(a=='publish'||a=='draft')await Item.updateMany({_id:{$in:L}},{draft:a=='draft'});else return s.sendStatus(400);s.json({ok:1,n:L.length})}));
app.post('/api/bookings/bulk',auth,h(async(q,s)=>{const L=bids(q),a=q.body.action;
if(a=='delete')await Booking.deleteMany({_id:{$in:L}});else if(BST.includes(a))await Booking.updateMany({_id:{$in:L}},{status:a});else return s.sendStatus(400);s.json({ok:1,n:L.length})}));
app.get('/api/bookings/export',auth,h(async(q,s)=>{const c=v=>{v=String(v==null?'':v);if(/^[=+\-@]/.test(v))v="'"+v;return '"'+v.replace(/"/g,'""')+'"'};
const L=await Booking.find().sort('-createdAt').lean();s.set({'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="bookings.csv"'});
s.send('\ufeff'+['الاسم,الهاتف,الرسالة,الحالة,ملاحظة,التاريخ'].concat(L.map(b=>[b.name,b.phone,b.message,BSL[b.status]||'جديد',b.note,b.createdAt&&b.createdAt.toISOString()].map(c).join(','))).join('\r\n'))}));
app.get('/api/admin/backup',auth,h(async(q,s)=>{const[items,settings,bookings,comments,questions]=await Promise.all([Item.find().lean(),Setting.find().lean(),Booking.find().lean(),Comment.find().lean(),Question.find().lean()]);s.json({exportedAt:new Date(),items,settings,bookings,comments,questions})}));
app.get('/api/admin/analytics',auth,h(async(q,s)=>s.json(await Day.find({d:{$gte:new Date(Date.now()-29*864e5).toISOString().slice(0,10)}}).sort('d').select('d views -_id').lean())));
app.get('/api/admin/log',auth,h(async(q,s)=>s.json(await Log.find().sort('-createdAt').limit(40).lean())));
app.post('/api/comments/bulk',auth,h(async(q,s)=>{const L=bids(q),a=q.body.action;if(a=='delete')await Comment.deleteMany({_id:{$in:L}});else if(a=='ok'||a=='pending')await Comment.updateMany({_id:{$in:L}},{status:a});else return s.sendStatus(400);s.json({ok:1,n:L.length})}));
/* ---------- SEO: sitemap + robots + server-rendered article pages ---------- */
const fs=require('fs'),path=require('path');
const SITE=(process.env.SITE_URL||'').replace(/\/+$/,'');
const origin=q=>SITE||String(q.headers['x-forwarded-proto']||'https').split(',')[0].trim()+'://'+String(q.headers['x-forwarded-host']||q.headers.host||'').split(',')[0].trim();
const xe=t=>String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const he=t=>String(t==null?'':t).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const jld=o=>JSON.stringify(o).replace(/</g,'\\u003c');
const absU=(o,u)=>!u?'':/^https?:\/\//i.test(u)?u:o+(u[0]=='/'?'':'/')+u;
const clip=(t,n)=>{t=String(t||'').replace(/\s+/g,' ').trim();if(t.length<=n)return t;t=t.slice(0,n-1);const k=t.lastIndexOf(' ');return(k>n*.6?t.slice(0,k):t)+'…'};
const plain=b=>Rich.plainText(b);
const dAr=d=>{try{return new Date(d).toLocaleDateString('ar-EG',{year:'numeric',month:'long',day:'numeric'})}catch(e){return ''}};
const iso=d=>{try{return new Date(d).toISOString()}catch(e){return undefined}};
const FULL='index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1';
const AUTHOR='د. ممدوح حمدي',BRAND='دوبامين';

app.get('/sitemap.xml',h(async(q,s)=>{await connect();const o=origin(q),L=await Item.find({type:'article',draft:{$ne:true},slug:{$exists:true,$ne:''}}).sort('-createdAt').select('slug image updatedAt createdAt').lean();
const d10=d=>d?new Date(d).toISOString().slice(0,10):'';
const u=(loc,d,cf,pr,img)=>'<url><loc>'+xe(loc)+'</loc>'+(d?'<lastmod>'+d10(d)+'</lastmod>':'')+'<changefreq>'+cf+'</changefreq><priority>'+pr+'</priority>'+(img?'<image:image><image:loc>'+xe(img)+'</image:loc></image:image>':'')+'</url>';
const last=L[0]&&(L[0].updatedAt||L[0].createdAt);
s.set('Cache-Control','public, max-age=0, s-maxage=3600, stale-while-revalidate=86400');
s.type('application/xml').send('<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">'+u(o+'/',last,'weekly','1.0',o+'/img/og-share.jpg')+u(o+'/articles',last,'daily','0.8')+u(o+'/tests',null,'monthly','0.8')+Tests.list.map(t=>u(o+'/tests/'+t.id,null,'monthly','0.7')).join('')+L.map(i=>u(o+'/articles/'+encodeURIComponent(i.slug),i.updatedAt||i.createdAt,'monthly','0.7',i.image?absU(o,i.image):'')).join('')+'</urlset>')}));
app.get('/robots.txt',(q,s)=>{s.set('Cache-Control','public, max-age=0, s-maxage=3600');s.type('text/plain').send('User-agent: *\nAllow: /\nAllow: /api/img/\nDisallow: /admin\nDisallow: /api/\n\nSitemap: '+origin(q)+'/sitemap.xml\n')});

/* template of the articles page (read once) */
let TPL;const tpl=async q=>{if(TPL)return TPL;try{return TPL=fs.readFileSync(path.join(__dirname,'..','public','articles.html'),'utf8')}catch(e){}
try{const r=await fetch(origin(q)+'/articles.html',{signal:AbortSignal.timeout(5000)});if(r.ok)return TPL=await r.text()}catch(e){}return null};
const shareImg=async(o,u,og)=>{const def=o+'/img/og-share.jpg';if(og&&/^(\/api\/img\/[a-f0-9]{24}|https?:\/\/)/i.test(og))return{u:absU(o,og),w:1200,h:630};if(!u)return{u:def,w:1200,h:630};
const m=String(u).match(/^\/api\/img\/([a-f0-9]{24})/i);if(!m)return{u:absU(o,u)};
try{const d=await Img.findById(m[1]).select('size type').lean();if(d&&d.size<=300000&&/jpeg|png/.test(d.type||''))return{u:absU(o,u)}}catch(e){}return{u:def,w:1200,h:630}};
const metaTags=m=>'<link rel="canonical" href="'+he(m.url)+'"><meta name="robots" content="'+m.robots+'">'
+'<meta property="og:site_name" content="'+BRAND+'"><meta property="og:locale" content="ar_AR"><meta property="og:type" content="'+m.type+'">'
+'<meta property="og:title" content="'+he(m.title)+'"><meta property="og:description" content="'+he(m.desc)+'"><meta property="og:url" content="'+he(m.url)+'"><meta property="og:image" content="'+he(m.image)+'">'+(m.iw?'<meta property="og:image:type" content="image/jpeg"><meta property="og:image:width" content="'+m.iw+'"><meta property="og:image:height" content="'+m.ih+'">':'')
+'<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="'+he(m.title)+'"><meta name="twitter:description" content="'+he(m.desc)+'"><meta name="twitter:image" content="'+he(m.image)+'">'
+(m.extra||'')+(m.ld?'<script type="application/ld+json" id="ld">'+jld(m.ld)+'</script>':'');
const build=(html,m)=>html.replace(/<html lang="ar" dir="rtl"/,'<html data-ssr="1" lang="ar" dir="rtl"')
.replace(/<title>[^<]*<\/title>/,()=>'<title>'+he(m.title)+'</title>')
.replace(/<meta name="description" id="md" content="[^"]*">/,()=>'<meta name="description" id="md" content="'+he(m.desc)+'">')
.replace('</head>',()=>metaTags(m)+'</head>');

/* same formatting rules as the browser reader, so crawlers see the real article text */
const fmtBody=b=>Rich.render(b).html;
const href=i=>'/articles/'+encodeURIComponent(i.slug||i._id);
const cardH=i=>'<div class="card"><span class="chip">مقال</span>'+(i.image?'<img src="'+he(i.image)+'" alt="'+he(i.title)+'" loading="lazy">':'<div class="th"></div>')+'<div class="b"><h3><a href="'+href(i)+'">'+he(i.title)+'</a></h3><p>'+he(clip(i.desc,140))+'</p><a class="btn sm" href="'+href(i)+'">اقرأ المزيد</a></div></div>';
const crumbs=(o,t,u)=>({'@type':'BreadcrumbList',itemListElement:[{'@type':'ListItem',position:1,name:BRAND,item:o+'/'},{'@type':'ListItem',position:2,name:'المقالات',item:o+'/articles'}].concat(t?[{'@type':'ListItem',position:3,name:t,item:u}]:[])});
const plainPage=async(q,s)=>{const t=await tpl(q);if(!t)return s.status(503).send('تعذّر تحميل الصفحة، حاول مرة أخرى.');s.set('Cache-Control','public, max-age=0, s-maxage=60');s.type('html').send(t)};
const ready=async()=>{await connect();await backfill()};


/* home page: rendered by the server so canonical / og:url / og:image are absolute (required by WhatsApp, Facebook, Telegram) */
let HTPL;const htpl=async q=>{if(HTPL)return HTPL;try{return HTPL=fs.readFileSync(path.join(__dirname,'..','public','home.html'),'utf8')}catch(e){}
try{const r=await fetch(origin(q)+'/home.html',{signal:AbortSignal.timeout(5000)});if(r.ok)return HTPL=await r.text()}catch(e){}return null};
const absHome=(html,o)=>html.replace('<link rel="canonical" href="/">',()=>'<link rel="canonical" href="'+o+'/">').replace('<meta property="og:url" content="/">',()=>'<meta property="og:url" content="'+o+'/">').split('content="/img/og-share.jpg"').join('content="'+o+'/img/og-share.jpg"');
/* بطاقات «اختبر نفسك» في الصفحة الرئيسية تُولَّد من tests-data.js (أول 6 اختبارات) حتى لا تتخلف عن قائمة الاختبارات */
const HOME_TESTS=6,homeTests=t=>t.replace(/(<div class="tgrid">)[\s\S]*?(<\/a><\/div>\s*<p class="tnote)/,(m,a,b)=>a+Tests.list.slice(0,HOME_TESTS).map(x=>'<a class="tcd rv" href="/tests/'+he(x.id)+'"><div class="ci"><svg class="i"><use href="#i-'+he(x.icon)+'"/></svg></div><h3>'+he(x.title.replace(/^اختبار\s+/,''))+'</h3><p>'+he(x.short)+'</p><span class="go">ابدأ الاختبار <svg class="i"><use href="#i-arr"/></svg></span></a>').join('')+b);
app.get(['/','/index.html'],async(q,s)=>{const t=await htpl(q);if(!t)return s.status(503).send('تعذّر تحميل الصفحة، حاول مرة أخرى.');
s.set('Cache-Control',CC(TTL.static));s.type('html').send(absHome(homeTests(t),origin(q)))});

/* /articles : list page, with real links in the HTML */
app.get(['/articles','/articles/','/articles.html'],async(q,s)=>{try{const t=await tpl(q);if(!t)return plainPage(q,s);await ready();
const o=origin(q),url=o+'/articles',L=await Item.find({type:'article',draft:{$ne:true}}).sort('-createdAt').limit(100).select('title slug desc image createdAt updatedAt').lean();
const desc='مقالات د. ممدوح حمدي في الصحة النفسية والأسرية، تعديل سلوك الأطفال والمراهقين، العلاقات الزوجية، والتعافي من الإدمان السلوكي — بأسلوب علمي مبسّط.';
const ld={'@context':'https://schema.org','@graph':[{'@type':'CollectionPage','@id':url+'#page','url':url,'name':'المقالات | '+BRAND+' — '+AUTHOR,'description':desc,'inLanguage':'ar','isPartOf':{'@type':'WebSite','name':BRAND,'url':o+'/'},'mainEntity':{'@type':'ItemList',itemListElement:L.slice(0,50).map((i,n)=>({'@type':'ListItem',position:n+1,url:o+href(i),name:i.title}))}},crumbs(o)]};
let html=build(t,{title:'المقالات | دوبامين — د. ممدوح حمدي',desc,url,image:o+'/img/og-share.jpg',iw:1200,ih:630,type:'website',robots:FULL,ld});
html=html.replace('<div class="grid" id="grid"></div>',()=>'<div class="grid" id="grid">'+L.map(cardH).join('')+'</div>');
s.set('Cache-Control',CC(TTL.list));s.type('html').send(html)}catch(e){conn=null;plainPage(q,s)}});

/* /articles/:slug : full article in the first HTML response (title, description, canonical, Open Graph, JSON-LD, text) */
app.get('/articles/:slug',async(q,s)=>{try{const t=await tpl(q);if(!t)return plainPage(q,s);await ready();
const o=origin(q),key=String(q.params.slug||'');let i=null;
if(/^[a-f0-9]{24}$/i.test(key))i=await Item.findById(key).lean();if(!i)i=await Item.findOne({slug:key}).lean()||await Item.findOne({slug:SL(key)}).lean();
if(i&&i.type!='article'&&!i.draft)return s.redirect(301,'/content.html?tab='+encodeURIComponent(i.type||'')+'&id='+i._id);
if(!i||i.draft||!i.slug){const html=build(t,{title:'المقال غير موجود | دوبامين',desc:'لم نعثر على هذا المقال. تصفّح أحدث مقالات د. ممدوح حمدي.',url:o+'/articles',image:o+'/img/og-share.jpg',type:'website',robots:'noindex,follow'}).replace('<div id="listv">','<div id="listv" style="display:none">').replace('<div id="readv" style="display:none">','<div id="readv" style="display:block">');
s.status(404).set('Cache-Control','public, max-age=0, s-maxage=60').type('html').send(html);return}
const url=o+'/articles/'+encodeURIComponent(i.slug);
if(key!==i.slug)return s.redirect(301,'/articles/'+encodeURIComponent(i.slug));
const txt=plain(i.body),desc=clip(i.desc||txt,158),si=await shareImg(o,i.image,i.ogImage),img=si.u,words=txt?txt.split(' ').length:0;
const ld={'@context':'https://schema.org','@graph':[{'@type':'Article','@id':url+'#article','headline':clip(i.title,110),'description':desc,'image':[img],'datePublished':iso(i.createdAt),'dateModified':iso(i.updatedAt||i.createdAt),'inLanguage':'ar','wordCount':words,'author':{'@type':'Person','name':AUTHOR,'url':o+'/'},'publisher':{'@type':'Organization','name':BRAND,'url':o+'/','logo':{'@type':'ImageObject','url':o+'/img/favicon-512.png'}},'mainEntityOfPage':{'@type':'WebPage','@id':url},'isPartOf':{'@type':'WebSite','name':BRAND,'url':o+'/'}},crumbs(o,i.title,url)]};
const extra='<meta property="article:published_time" content="'+he(iso(i.createdAt))+'"><meta property="article:modified_time" content="'+he(iso(i.updatedAt||i.createdAt))+'"><meta property="article:author" content="'+AUTHOR+'"><meta property="og:image:alt" content="'+he(i.title)+'">';
const rel=await Item.find({type:'article',draft:{$ne:true},_id:{$ne:i._id}}).sort('-createdAt').limit(3).select('title slug desc image').lean();
const art='<a class="back" href="/articles">كل المقالات</a><div><span class="chip">مقال</span></div><h1>'+he(i.title)+'</h1><div class="meta"><span>'+AUTHOR+'</span><span><time datetime="'+he(iso(i.createdAt))+'">'+he(dAr(i.createdAt))+'</time></span></div>'
+(i.image?'<img class="cover" src="'+he(i.image)+'" alt="'+he(i.title)+'">':'')+(i.desc&&i.body?'<p class="lead">'+he(i.desc)+'</p>':'')+'<div class="body rich" id="bd">'+(i.body?fmtBody(i.body):(i.desc?'<p>'+he(i.desc)+'</p>':''))+'</div>';
let html=build(t,{title:i.title+' | دوبامين',desc,url,image:img,type:'article',robots:FULL,ld,extra,iw:si.w,ih:si.h});
html=html.replace('<div id="listv">','<div id="listv" style="display:none">').replace('<div id="readv" style="display:none">','<div id="readv" style="display:block">').replace('<article class="rd" id="rd"></article>',()=>'<article class="rd" id="rd">'+art+'</article>')
.replace('<section class="rel" id="rel"></section>',()=>'<section class="rel" id="rel">'+(rel.length?'<h2>مقالات أخرى قد تهمك</h2><div class="grid">'+rel.map(cardH).join('')+'</div>':'')+'</section>');
s.set('Cache-Control',CC(TTL.page));s.type('html').send(html)}catch(e){conn=null;plainPage(q,s)}});

/* ---------- /tests و /tests/:id : صفحات ثابتة من الملف (بدون قاعدة بيانات) + وسوم SEO لكل اختبار ---------- */
let TTPL;const ttpl=()=>{if(TTPL)return TTPL;try{return TTPL=fs.readFileSync(path.join(__dirname,'..','public','tests.html'),'utf8')}catch(e){return null}};
app.get(['/tests','/tests/','/tests/:id'],(q,s)=>{const t=ttpl();if(!t)return s.status(503).send('تعذّر تحميل الصفحة، حاول مرة أخرى.');const o=origin(q),id=q.params.id,T=id?(Tests.byId(decodeURIComponent(id))||(decodeURIComponent(id)==='couple'?Tests.couple:null)):null;if(id&&!T)return s.redirect(302,'/tests');
  const url=o+(T?'/tests/'+T.id:'/tests'),title=T?T.title+' | دوبامين — د. ممدوح حمدي':'اختبارات التقييم الذاتي | دوبامين — د. ممدوح حمدي',desc=T?(T.id==='couple'?clip(T.desc,158):clip(T.desc+' اختبار مجاني وسرّي، وتُحسب النتيجة في متصفحك.',158)):'اختبارات تقييم ذاتي مجانية وسرّية من د. ممدوح حمدي ('+Tests.list.length+' اختباراً): التوتر، النوم، الاحتراق النفسي، القلق، الاكتئاب، الغضب، الحقد والضغينة، تقدير الذات، الغيرة وغيرها. تُحسب النتيجة في متصفحك ولا تُرسل لأي جهة.';
  const ld={'@context':'https://schema.org','@graph':[{'@type':'WebPage','@id':url+'#page','url':url,'name':title,'description':desc,'inLanguage':'ar','isPartOf':{'@type':'WebSite','name':BRAND,'url':o+'/'},'author':{'@type':'Person','name':AUTHOR}},{'@type':'BreadcrumbList',itemListElement:[{'@type':'ListItem',position:1,name:BRAND,item:o+'/'},{'@type':'ListItem',position:2,name:'الاختبارات',item:o+'/tests'}].concat(T?[{'@type':'ListItem',position:3,name:T.title,item:url}]:[])}].concat(T?[]:[{'@type':'ItemList','name':'اختبارات التقييم الذاتي','numberOfItems':Tests.list.length,itemListElement:Tests.list.map((x,i)=>({'@type':'ListItem',position:i+1,name:x.title,url:o+'/tests/'+x.id}))}])};
  const ssr=T?'<h1>'+he(T.title)+'</h1><p>'+he(T.desc)+'</p>':'<h1>اختبارات التقييم الذاتي</h1><ul>'+Tests.list.map(x=>'<li><a href="/tests/'+x.id+'">'+he(x.title)+'</a> — '+he(x.short)+'</li>').join('')+'</ul>';
  const html=build(t,{title,desc,url,image:o+'/img/og-share.jpg',iw:1200,ih:630,type:'website',robots:T&&T.id==='couple'?'noindex,follow':FULL,ld}).replace('<div id="ssr"></div>',()=>'<div id="ssr">'+ssr+'</div>');
  s.set('Cache-Control',CC(TTL.static,604800));s.type('html').send(html)});
/* ---------- غرف «نحن الاثنان» (/tests/couple) ----------
   الخادم لا يرى سوى نص مشفّر (AES-GCM) من المتصفح؛ المفتاح في جزء الرابط (#) ولا يصل إليه أبداً.
   تُحفظ مؤقتاً بفهرس TTL مدته 30 دقيقة، وتُحذف فور اطّلاع الطرفين على النتيجة. لا شيء يُحفظ بعد ذلك. */
const RTTL=1800;
const RoomS=new mongoose.Schema({code:{type:String,unique:true},a:{iv:String,ct:String},b:{iv:String,ct:String},sa:Boolean,sb:Boolean,createdAt:{type:Date,default:Date.now}},{versionKey:false});
RoomS.index({createdAt:1},{expireAfterSeconds:RTTL});const Room=mongoose.model('Room',RoomS);
const RCH='ABCDEFGHJKLMNPQRSTUVWXYZ23456789',rcode=()=>Array.from({length:8},()=>RCH[crypto.randomInt(RCH.length)]).join(''),rOK=c=>/^[A-HJ-NP-Z2-9]{8}$/.test(c),b64u=x=>typeof x==='string'&&/^[A-Za-z0-9_-]+$/.test(x);
const RL=new Map();const rlim=(q,s,n)=>{const ip=String(q.headers['x-forwarded-for']||q.ip||'?').split(',')[0].trim(),k=ip+':'+q.method,now=Date.now();let e=RL.get(k);if(!e||now>e.r)e={n:0,r:now+60000};e.n++;RL.set(k,e);if(RL.size>2000)RL.delete(RL.keys().next().value);if(e.n>(q.method==='GET'?60:12))return s.status(429).json({error:'طلبات كثيرة، انتظر قليلاً ثم حاول مرة أخرى.'});s.set('Cache-Control','no-store');n()};
const rLive=code=>Room.findOne({code,createdAt:{$gt:new Date(Date.now()-RTTL*1000)}}).lean();
const rLeft=r=>Math.max(0,RTTL-Math.floor((Date.now()-new Date(r.createdAt))/1000));
app.post('/api/rooms',rlim,h(async(q,s)=>{if(await Room.estimatedDocumentCount()>5000)return s.status(503).json({error:'الخدمة مشغولة الآن، حاول بعد قليل.'});for(let i=0;i<4;i++){const code=rcode();try{await Room.create({code});return s.json({code,ttl:RTTL})}catch(e){if(e.code!==11000)throw e}}s.status(500).json({error:'تعذّر إنشاء الغرفة'})}));
app.put('/api/rooms/:code/answer',rlim,h(async(q,s)=>{const code=String(q.params.code||'').toUpperCase(),{slot,iv,ct}=q.body||{};if(!rOK(code)||(slot!=='a'&&slot!=='b')||!b64u(iv)||!b64u(ct)||iv.length>24||ct.length>2000)return s.status(400).json({error:'بيانات غير صالحة'});const r=await rLive(code);if(!r)return s.status(404).json({error:'gone'});const u=await Room.updateOne({code,[slot+'.ct']:{$exists:false}},{$set:{[slot]:{iv,ct}}});if(!u.matchedCount)return s.status(409).json({error:'taken'});s.json({ok:true,left:rLeft(r)})}));
app.get('/api/rooms/:code',rlim,h(async(q,s)=>{const code=String(q.params.code||'').toUpperCase(),as=q.query.as;if(!rOK(code)||(as!=='a'&&as!=='b'))return s.status(400).json({error:'بيانات غير صالحة'});const r=await rLive(code);if(!r)return s.status(404).json({error:'gone'});const ha=!!(r.a&&r.a.ct),hb=!!(r.b&&r.b.ct),left=rLeft(r);if(!(ha&&hb))return s.json({ready:false,a:ha,b:hb,left});await Room.updateOne({code},{$set:{['s'+as]:true}});const d=await Room.deleteOne({code,sa:true,sb:true});s.json({ready:true,a:{iv:r.a.iv,ct:r.a.ct},b:{iv:r.b.iv,ct:r.b.ct},left,deleted:d.deletedCount>0})}));
app.delete('/api/rooms/:code',rlim,h(async(q,s)=>{const code=String(q.params.code||'').toUpperCase();if(!rOK(code))return s.status(400).json({error:'بيانات غير صالحة'});await Room.deleteOne({code});s.json({ok:true})}));
/* ---------- فحص السرعة: /api/admin/speed/{run,history,run/:id,health} (مدير فقط) ---------- */
speed.mount(app,{mongoose,auth,h,Item,Setting,Img,BOOT});
module.exports=app;
