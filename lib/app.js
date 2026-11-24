require('dotenv').config();
const express=require('express'),mongoose=require('mongoose'),jwt=require('jsonwebtoken'),crypto=require('crypto');
const Rich=require('../public/js/rich.js'),docx=require('./docx.js');
const app=express();app.use(express.json({limit:'1mb'}));
let conn;const connect=()=>conn||(conn=mongoose.connect(process.env.MONGODB_URI,{serverSelectionTimeoutMS:8000}));
app.disable('x-powered-by');
app.use('/api',(q,s,n)=>{if(!q.path.startsWith('/img'))s.set('X-Robots-Tag','noindex, nofollow');n()});
app.use('/api',async(q,s,n)=>{try{await connect();await backfill();n()}catch(e){conn=null;s.status(500).json({error:'db: '+e.message})}});
/* أي كتابة تمسّ الصور/الإعدادات/المحتوى تُبطل كاش لوحة التخزين (القراءات لا تفعل) */
let stC=null;app.use('/api',(q,s,n)=>{if(q.method!=='GET'&&/^\/(images|settings|items)/.test(q.path)&&!/\/(view|like)$/.test(q.path))stC=null;n()});
const LogS=new mongoose.Schema({m:String,p:String,id:String},{timestamps:{createdAt:true,updatedAt:false}});LogS.index({createdAt:1},{expireAfterSeconds:7776000});const Log=mongoose.model('Log',LogS);
const Day=mongoose.model('Day',new mongoose.Schema({d:{type:String,unique:true},views:{type:Number,default:0}}));
app.use('/api',(q,s,n)=>{if(q.method!='GET'&&isAdmin(q)){const p=q.originalUrl.split('?')[0].slice(0,90),m=q.method,id=String(q.query.id||'');s.on('finish',()=>{if(s.statusCode<400)Log.create({m,p,id}).catch(()=>{})})}n()});
const Item=mongoose.model('Item',new mongoose.Schema({type:String,title:String,desc:String,body:String,url:String,image:String,slug:{type:String,index:true},draft:{type:Boolean,default:false},views:{type:Number,default:0},likes:{type:Number,default:0}},{timestamps:true}));
const Setting=mongoose.model('Setting',new mongoose.Schema({key:{type:String,unique:true},value:String}));
const Booking=mongoose.model('Booking',new mongoose.Schema({name:String,phone:String,message:String,status:{type:String,default:'new'},note:String},{timestamps:true}));
const Img=mongoose.model('Img',new mongoose.Schema({name:String,type:String,size:Number,data:Buffer},{timestamps:true}));
const Comment=mongoose.model('Comment',new mongoose.Schema({item:{type:String,index:true},name:String,text:String,status:{type:String,default:'ok'},token:{type:String,select:false},editedAt:Date},{timestamps:true}));
const auth=(q,s,n)=>{try{jwt.verify((q.headers.authorization||'').slice(7),process.env.JWT_SECRET);n()}catch{s.sendStatus(401)}};
const h=f=>(q,s)=>f(q,s).catch(e=>s.status(500).json({error:e.message}));
const valid=id=>mongoose.isValidObjectId(id);
const FIELDS=['type','title','slug','desc','body','url','image','draft'];
const pid=q=>q.params.id||q.query.id;
const isAdmin=q=>{try{jwt.verify((q.headers.authorization||'').slice(7),process.env.JWT_SECRET);return true}catch{return false}};
/* ---------- slugs (Arabic-friendly) ---------- */
const SL=t=>String(t||'').normalize('NFKC').replace(/[\u064B-\u065F\u0670\u0640]/g,'').toLowerCase().trim().replace(/[^\p{L}\p{N}]+/gu,'-').replace(/^-+|-+$/g,'').slice(0,80).replace(/-+$/,'');
const uniq=async(base,id)=>{const b=base||'article-'+Date.now().toString(36);let c=b,n=1;while(await Item.exists(id?{slug:c,_id:{$ne:id}}:{slug:c})){n++;c=b+'-'+n}return c};
let slugged=false;const backfill=async()=>{if(slugged)return;slugged=true;try{const L=await Item.find({type:'article',$or:[{slug:{$exists:false}},{slug:''},{slug:null}]}).sort('createdAt').select('_id title').lean();for(const i of L)await Item.updateOne({_id:i._id},{slug:await uniq(SL(i.title),i._id)},{timestamps:false})}catch(e){slugged=false}};
// prepares item fields for create / update (old = existing item when updating)
const prep=async(b,old)=>{const d=pick(b),t=d.type||(old&&old.type);if(typeof d.body=='string')d.body=Rich.cleanSource(d.body);if('draft' in d)d.draft=d.draft===true||d.draft==='true';if(t=='article'){const given='slug' in d;let w=given?SL(d.slug):'';if(!w)w=(!given&&old&&old.slug)?old.slug:SL(d.title||(old&&old.title));d.slug=await uniq(w,old&&old._id)}else delete d.slug;return d};
const pick=b=>Object.fromEntries(FIELDS.filter(k=>b&&k in b).map(k=>[k,b[k]]));

/* ---------- images stored in MongoDB ---------- */
const IMG='/api/img/';
const imgId=u=>typeof u=='string'&&u.startsWith(IMG)?u.slice(IMG.length).split(/[?#]/)[0]:null;
// map of imageId -> where it is used
const usage=async()=>{const[items,sets]=await Promise.all([Item.find().select('title type image body').lean(),Setting.find().lean()]);const m=new Map();const add=(id,r)=>{if(!m.has(id))m.set(id,[]);m.get(id).push(r)};
for(const i of items){const a=imgId(i.image);if(a)add(a,{kind:'item',label:i.title||'',type:i.type});for(const x of String(i.body||'').matchAll(/\/api\/img\/([a-f0-9]{24})/g))if(x[1]!==a)add(x[1],{kind:'item',label:i.title||'',type:i.type})}
for(const st of sets){const a=imgId(st.value);if(a)add(a,{kind:'setting',label:st.key})}return m};
const bodyIds=b=>[...String(b||'').matchAll(/\/api\/img\/([a-f0-9]{24})/g)].map(m=>m[1]);
const gcIds=async ids=>{ids=[...new Set(ids.filter(Boolean))].filter(valid);if(!ids.length)return;const u=await usage();for(const id of ids)if(!u.has(id))await Img.findByIdAndDelete(id)};
const gc=u=>gcIds([imgId(u)]);
const OKT=['image/jpeg','image/png','image/webp','image/gif'];
app.post('/api/images',auth,express.raw({type:'image/*',limit:'4mb'}),h(async(q,s)=>{const t=(q.headers['content-type']||'').split(';')[0].trim();if(!OKT.includes(t)||!Buffer.isBuffer(q.body)||!q.body.length)return s.status(400).json({error:'bad image'});const d=await Img.create({type:t,size:q.body.length,name:String(q.query.name||'').slice(0,80),data:q.body});s.json({_id:d._id,url:IMG+d._id,size:d.size})}));
app.get(['/api/img/:id','/api/img'],h(async(q,s)=>{const id=pid(q);if(!valid(id))return s.sendStatus(404);const d=await Img.findById(id);if(!d)return s.sendStatus(404);s.set({'Content-Type':d.type,'Cache-Control':'public,max-age=31536000,immutable','X-Content-Type-Options':'nosniff'});s.send(Buffer.from(d.data))}));
const delImgs=async ids=>{let n=0,freed=0;for(const id of ids){if(!valid(id))continue;const d=await Img.findById(id).select('size');if(!d)continue;const u=IMG+id;await Item.updateMany({image:u},{image:''});await Setting.updateMany({value:u},{value:''});await Img.findByIdAndDelete(id);n++;freed+=d.size||0}return{deleted:n,freed}};
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
const cols=[];for(const[key,label,M]of[['items','المحتوى',Item],['comments','التعليقات',Comment],['bookings','الحجوزات',Booking],['settings','الإعدادات',Setting],['images','الصور',Img],['log','سجل النشاط',Log],['days','إحصاءات الزيارات',Day]])cols.push({key,label,...await sz(M)});
const u=await usage(),imgs=(await Img.find().select('-data').sort('-createdAt').lean()).map(x=>({_id:x._id,size:x.size||0,type:x.type,name:x.name,createdAt:x.createdAt,usedBy:u.get(String(x._id))||[]}));
const q0=await Setting.findOne({key:'storage_quota_mb'}),envQ=+process.env.STORAGE_QUOTA_MB||0,est=cols.reduce((a,c)=>a+(c.bytes||0),0);
const quotaMB=+(q0&&q0.value)||envQ||512,dataSize=st.dataSize??est,indexSize=st.indexSize??0,storageSize=st.storageSize??est,used=dataSize+indexSize,quota=quotaMB*1048576;
const by={images:{bytes:0,count:0},video:{bytes:0,count:0},files:{bytes:0,count:0}};for(const x of imgs){const k=by[kindOf(x.type)];k.bytes+=x.size;k.count++}
const g=k=>(cols.find(c=>c.key===k)||{}).bytes||0,dbB=['items','comments','bookings','settings'].reduce((a,k)=>a+g(k),0),media=by.images.bytes+by.video.bytes+by.files.bytes;
const breakdown=[{key:'images',label:'صور',...by.images},{key:'video',label:'فيديو',...by.video},{key:'files',label:'ملفات',...by.files},{key:'database',label:'قاعدة البيانات (محتوى وتعليقات وحجوزات وإعدادات)',bytes:dbB,count:cols.filter(c=>['items','comments','bookings','settings'].includes(c.key)).reduce((a,c)=>a+c.count,0)},{key:'indexes',label:'الفهارس',bytes:indexSize,count:0},{key:'other',label:'أخرى (سجلات وإحصاءات وهوامش التخزين)',bytes:Math.max(0,used-media-dbB-indexSize),count:0}];
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
app.get('/api/settings',h(async(q,s)=>s.json(Object.fromEntries((await Setting.find()).map(x=>[x.key,x.value])))));
app.put('/api/settings',auth,h(async(q,s)=>{for(const[k,v]of Object.entries(q.body)){const old=await Setting.findOne({key:k});await Setting.updateOne({key:k},{value:v},{upsert:true});if(old&&old.value&&old.value!==v&&imgId(old.value))await gc(old.value)}s.json({ok:1})}));

/* ---------- items ---------- */
const one=async(key,s,adm)=>{key=String(key||'');let i=null;if(/^[a-f0-9]{24}$/i.test(key))i=await Item.findById(key).lean();if(!i&&key)i=await Item.findOne({slug:key}).lean()||await Item.findOne({slug:SL(key)}).lean();if(i&&i.draft&&!adm)i=null;i?s.json(i):s.status(404).json({error:'not found'})};
const lite=({body,...r})=>{const w=Rich.words(body||'');return{...r,hasBody:w>0,words:w}};
app.get('/api/items',h(async(q,s)=>{const{id,slug,type,limit,lite:l}=q.query;const adm=isAdmin(q);if(id||slug)return one(id||slug,s,adm);const flt=type?{type:String(type)}:{};if(!adm)flt.draft={$ne:true};let c=Item.find(flt).sort('-createdAt');if(+limit>0)c=c.limit(Math.min(+limit,200));const L=await c.lean();s.json(l?L.map(lite):L)}));
app.get('/api/items/:id',h(async(q,s)=>one(q.params.id,s,isAdmin(q))));
app.post('/api/items',auth,h(async(q,s)=>s.json(await Item.create(await prep(q.body)))));
app.put(['/api/items/:id','/api/items'],auth,h(async(q,s)=>{const id=pid(q);const old=valid(id)?await Item.findById(id).select('image body type slug title').lean():null;if(!old)return s.status(404).json({error:'not found'});const i=await Item.findByIdAndUpdate(id,await prep(q.body,old),{new:true}).lean();await gcIds([imgId(old.image),...bodyIds(old.body)]);s.json(i)}));
app.delete(['/api/items/:id','/api/items'],auth,h(async(q,s)=>{const old=valid(pid(q))?await Item.findByIdAndDelete(pid(q)):null;if(old){await Comment.deleteMany({item:String(old._id)});await gcIds([imgId(old.image),...bodyIds(old.body)])}s.json({ok:1})}));
const bump=(inc,up)=>h(async(q,s)=>{const id=pid(q);if(!valid(id))return s.sendStatus(404);const dn=up&&q.body&&q.body.on===false;let i;if(inc=='views')i=await Item.findByIdAndUpdate(id,{$inc:{views:1}},{new:true,timestamps:false}).select('views likes');else i=await Item.findOneAndUpdate(dn?{_id:id,likes:{$gt:0}}:{_id:id},{$inc:{likes:dn?-1:1}},{new:true,timestamps:false}).select('views likes')||await Item.findById(id).select('views likes');if(i&&inc=='views')Day.updateOne({d:new Date().toISOString().slice(0,10)},{$inc:{views:1}},{upsert:true}).catch(()=>{});i?s.json({views:i.views||0,likes:i.likes||0}):s.sendStatus(404)});
app.post(['/api/items/:id/view','/api/view'],bump('views'));
app.post(['/api/items/:id/like','/api/like'],bump('likes',1));

/* ---------- comments ---------- */
const sha=t=>crypto.createHash('sha256').update(String(t||'')).digest('hex');
// the comment's author is recognised by a secret token that only his browser holds
const mine=async q=>{const t=q.headers['x-comment-token'];if(!t||!valid(pid(q)))return null;const c=await Comment.findById(pid(q)).select('+token');return c&&c.token&&c.token===sha(t)?c:null};
const hits=new Map();const limited=(ip,k)=>{k=(k||'c')+':'+ip;const n=Date.now(),a=(hits.get(k)||[]).filter(t=>n-t<600000);if(a.length>=5){hits.set(k,a);return true}a.push(n);hits.set(k,a);if(hits.size>5000)for(const[x,v]of hits)if(!v.some(t=>n-t<600000))hits.delete(x);return false};
app.get('/api/comments',h(async(q,s)=>{if(!valid(q.query.item))return s.json([]);s.json(await Comment.find({item:q.query.item,status:'ok'}).sort('-createdAt').limit(200).select('name text createdAt editedAt').lean())}));
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

/* ---------- bookings ---------- */
app.post('/api/bookings',h(async(q,s)=>{const B=q.body||{},name=String(B.name||'').trim().slice(0,80),phone=String(B.phone||'').trim().slice(0,30),message=String(B.message||'').trim().slice(0,2000);if(!name||!phone||name.length<2||phone.replace(/\D/g,'').length<7||phone.replace(/\D/g,'').length>15)return s.sendStatus(400);
if(limited(String(q.headers['x-forwarded-for']||q.ip||'').split(',')[0].trim(),'b'))return s.status(429).json({error:'rate'});await Booking.create({name,phone,message});s.json({ok:1})}));
app.get('/api/bookings',auth,h(async(q,s)=>s.json(await Booking.find().sort('-createdAt'))));
app.put('/api/bookings/:id',auth,h(async(q,s)=>{const u={},B=q.body||{};if('status' in B)u.status=B.status==='done'?'done':'new';if(typeof B.note=='string')u.note=B.note.slice(0,500);s.json(await Booking.findByIdAndUpdate(q.params.id,u,{new:true}))}));
app.delete('/api/bookings/:id',auth,h(async(q,s)=>{await Booking.findByIdAndDelete(q.params.id);s.json({ok:1})}));
/* ---------- admin: bulk actions / CSV export / full backup ---------- */
const bids=q=>(Array.isArray(q.body&&q.body.ids)?q.body.ids:[]).filter(valid).slice(0,300);
app.post('/api/items/bulk',auth,h(async(q,s)=>{const L=bids(q),a=q.body.action;
if(a=='delete'){const o=await Item.find({_id:{$in:L}}).select('image body').lean();await Item.deleteMany({_id:{$in:L}});await Comment.deleteMany({item:{$in:L}});await gcIds(o.flatMap(x=>[imgId(x.image),...bodyIds(x.body)]))}
else if(a=='publish'||a=='draft')await Item.updateMany({_id:{$in:L}},{draft:a=='draft'});else return s.sendStatus(400);s.json({ok:1,n:L.length})}));
app.post('/api/bookings/bulk',auth,h(async(q,s)=>{const L=bids(q),a=q.body.action;
if(a=='delete')await Booking.deleteMany({_id:{$in:L}});else if(a=='done'||a=='new')await Booking.updateMany({_id:{$in:L}},{status:a});else return s.sendStatus(400);s.json({ok:1,n:L.length})}));
app.get('/api/bookings/export',auth,h(async(q,s)=>{const c=v=>{v=String(v==null?'':v);if(/^[=+\-@]/.test(v))v="'"+v;return '"'+v.replace(/"/g,'""')+'"'};
const L=await Booking.find().sort('-createdAt').lean();s.set({'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="bookings.csv"'});
s.send('\ufeff'+['الاسم,الهاتف,الرسالة,الحالة,ملاحظة,التاريخ'].concat(L.map(b=>[b.name,b.phone,b.message,b.status=='done'?'تمت المعالجة':'جديد',b.note,b.createdAt&&b.createdAt.toISOString()].map(c).join(','))).join('\r\n'))}));
app.get('/api/admin/backup',auth,h(async(q,s)=>{const[items,settings,bookings,comments]=await Promise.all([Item.find().lean(),Setting.find().lean(),Booking.find().lean(),Comment.find().lean()]);s.json({exportedAt:new Date(),items,settings,bookings,comments})}));
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
s.type('application/xml').send('<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">'+u(o+'/',last,'weekly','1.0',o+'/img/og-share.jpg')+u(o+'/articles',last,'daily','0.8')+L.map(i=>u(o+'/articles/'+encodeURIComponent(i.slug),i.updatedAt||i.createdAt,'monthly','0.7',i.image?absU(o,i.image):'')).join('')+'</urlset>')}));
app.get('/robots.txt',(q,s)=>{s.set('Cache-Control','public, max-age=0, s-maxage=3600');s.type('text/plain').send('User-agent: *\nAllow: /\nAllow: /api/img/\nDisallow: /admin\nDisallow: /api/\n\nSitemap: '+origin(q)+'/sitemap.xml\n')});

/* template of the articles page (read once) */
let TPL;const tpl=async q=>{if(TPL)return TPL;try{return TPL=fs.readFileSync(path.join(__dirname,'..','public','articles.html'),'utf8')}catch(e){}
try{const r=await fetch(origin(q)+'/articles.html',{signal:AbortSignal.timeout(5000)});if(r.ok)return TPL=await r.text()}catch(e){}return null};
const shareImg=async(o,u)=>{const def=o+'/img/og-share.jpg';if(!u)return{u:def,w:1200,h:630};
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
app.get(['/','/index.html'],async(q,s)=>{const t=await htpl(q);if(!t)return s.status(503).send('تعذّر تحميل الصفحة، حاول مرة أخرى.');
s.set('Cache-Control','public, max-age=0, s-maxage=300, stale-while-revalidate=86400');s.type('html').send(absHome(t,origin(q)))});

/* /articles : list page, with real links in the HTML */
app.get(['/articles','/articles/','/articles.html'],async(q,s)=>{try{const t=await tpl(q);if(!t)return plainPage(q,s);await ready();
const o=origin(q),url=o+'/articles',L=await Item.find({type:'article',draft:{$ne:true}}).sort('-createdAt').limit(100).select('title slug desc image createdAt updatedAt').lean();
const desc='مقالات د. ممدوح حمدي في الصحة النفسية والأسرية، تعديل سلوك الأطفال والمراهقين، العلاقات الزوجية، والتعافي من الإدمان السلوكي — بأسلوب علمي مبسّط.';
const ld={'@context':'https://schema.org','@graph':[{'@type':'CollectionPage','@id':url+'#page','url':url,'name':'المقالات | '+BRAND+' — '+AUTHOR,'description':desc,'inLanguage':'ar','isPartOf':{'@type':'WebSite','name':BRAND,'url':o+'/'},'mainEntity':{'@type':'ItemList',itemListElement:L.slice(0,50).map((i,n)=>({'@type':'ListItem',position:n+1,url:o+href(i),name:i.title}))}},crumbs(o)]};
let html=build(t,{title:'المقالات | دوبامين — د. ممدوح حمدي',desc,url,image:o+'/img/og-share.jpg',iw:1200,ih:630,type:'website',robots:FULL,ld});
html=html.replace('<div class="grid" id="grid"></div>',()=>'<div class="grid" id="grid">'+L.map(cardH).join('')+'</div>');
s.set('Cache-Control','public, max-age=0, s-maxage=300, stale-while-revalidate=86400');s.type('html').send(html)}catch(e){conn=null;plainPage(q,s)}});

/* /articles/:slug : full article in the first HTML response (title, description, canonical, Open Graph, JSON-LD, text) */
app.get('/articles/:slug',async(q,s)=>{try{const t=await tpl(q);if(!t)return plainPage(q,s);await ready();
const o=origin(q),key=String(q.params.slug||'');let i=null;
if(/^[a-f0-9]{24}$/i.test(key))i=await Item.findById(key).lean();if(!i)i=await Item.findOne({slug:key}).lean()||await Item.findOne({slug:SL(key)}).lean();
if(i&&i.type!='article'&&!i.draft)return s.redirect(301,'/content.html?tab='+encodeURIComponent(i.type||'')+'&id='+i._id);
if(!i||i.draft||!i.slug){const html=build(t,{title:'المقال غير موجود | دوبامين',desc:'لم نعثر على هذا المقال. تصفّح أحدث مقالات د. ممدوح حمدي.',url:o+'/articles',image:o+'/img/og-share.jpg',type:'website',robots:'noindex,follow'}).replace('<div id="listv">','<div id="listv" style="display:none">').replace('<div id="readv" style="display:none">','<div id="readv" style="display:block">');
s.status(404).set('Cache-Control','public, max-age=0, s-maxage=60').type('html').send(html);return}
const url=o+'/articles/'+encodeURIComponent(i.slug);
if(key!==i.slug)return s.redirect(301,'/articles/'+encodeURIComponent(i.slug));
const txt=plain(i.body),desc=clip(i.desc||txt,158),si=await shareImg(o,i.image),img=si.u,words=txt?txt.split(' ').length:0;
const ld={'@context':'https://schema.org','@graph':[{'@type':'Article','@id':url+'#article','headline':clip(i.title,110),'description':desc,'image':[img],'datePublished':iso(i.createdAt),'dateModified':iso(i.updatedAt||i.createdAt),'inLanguage':'ar','wordCount':words,'author':{'@type':'Person','name':AUTHOR,'url':o+'/'},'publisher':{'@type':'Organization','name':BRAND,'url':o+'/','logo':{'@type':'ImageObject','url':o+'/img/favicon-512.png'}},'mainEntityOfPage':{'@type':'WebPage','@id':url},'isPartOf':{'@type':'WebSite','name':BRAND,'url':o+'/'}},crumbs(o,i.title,url)]};
const extra='<meta property="article:published_time" content="'+he(iso(i.createdAt))+'"><meta property="article:modified_time" content="'+he(iso(i.updatedAt||i.createdAt))+'"><meta property="article:author" content="'+AUTHOR+'"><meta property="og:image:alt" content="'+he(i.title)+'">';
const rel=await Item.find({type:'article',draft:{$ne:true},_id:{$ne:i._id}}).sort('-createdAt').limit(3).select('title slug desc image').lean();
const art='<a class="back" href="/articles">كل المقالات</a><div><span class="chip">مقال</span></div><h1>'+he(i.title)+'</h1><div class="meta"><span>'+AUTHOR+'</span><span><time datetime="'+he(iso(i.createdAt))+'">'+he(dAr(i.createdAt))+'</time></span></div>'
+(i.image?'<img class="cover" src="'+he(i.image)+'" alt="'+he(i.title)+'">':'')+(i.desc&&i.body?'<p class="lead">'+he(i.desc)+'</p>':'')+'<div class="body rich" id="bd">'+(i.body?fmtBody(i.body):(i.desc?'<p>'+he(i.desc)+'</p>':''))+'</div>';
let html=build(t,{title:i.title+' | دوبامين',desc,url,image:img,type:'article',robots:FULL,ld,extra,iw:si.w,ih:si.h});
html=html.replace('<div id="listv">','<div id="listv" style="display:none">').replace('<div id="readv" style="display:none">','<div id="readv" style="display:block">').replace('<article class="rd" id="rd"></article>',()=>'<article class="rd" id="rd">'+art+'</article>')
.replace('<section class="rel" id="rel"></section>',()=>'<section class="rel" id="rel">'+(rel.length?'<h2>مقالات أخرى قد تهمك</h2><div class="grid">'+rel.map(cardH).join('')+'</div>':'')+'</section>');
s.set('Cache-Control','public, max-age=0, s-maxage=300, stale-while-revalidate=86400');s.type('html').send(html)}catch(e){conn=null;plainPage(q,s)}});
module.exports=app;
