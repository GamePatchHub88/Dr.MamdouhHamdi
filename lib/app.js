require('dotenv').config();
const express=require('express'),mongoose=require('mongoose'),jwt=require('jsonwebtoken');
const app=express();app.use(express.json());
let conn;const connect=()=>conn||(conn=mongoose.connect(process.env.MONGODB_URI,{serverSelectionTimeoutMS:8000}));
app.use('/api',async(q,s,n)=>{try{await connect();n()}catch(e){conn=null;s.status(500).json({error:'db: '+e.message})}});
const Item=mongoose.model('Item',new mongoose.Schema({type:String,title:String,desc:String,body:String,url:String,image:String,views:{type:Number,default:0},likes:{type:Number,default:0}},{timestamps:true}));
const Setting=mongoose.model('Setting',new mongoose.Schema({key:{type:String,unique:true},value:String}));
const Booking=mongoose.model('Booking',new mongoose.Schema({name:String,phone:String,message:String,status:{type:String,default:'new'}},{timestamps:true}));
const Img=mongoose.model('Img',new mongoose.Schema({name:String,type:String,size:Number,data:Buffer},{timestamps:true}));
const Comment=mongoose.model('Comment',new mongoose.Schema({item:{type:String,index:true},name:String,text:String,status:{type:String,default:'ok'}},{timestamps:true}));
const auth=(q,s,n)=>{try{jwt.verify((q.headers.authorization||'').slice(7),process.env.JWT_SECRET);n()}catch{s.sendStatus(401)}};
const h=f=>(q,s)=>f(q,s).catch(e=>s.status(500).json({error:e.message}));
const valid=id=>mongoose.isValidObjectId(id);
const FIELDS=['type','title','desc','body','url','image'];
const pick=b=>Object.fromEntries(FIELDS.filter(k=>b&&k in b).map(k=>[k,b[k]]));

/* ---------- images stored in MongoDB ---------- */
const IMG='/api/img/';
const imgId=u=>typeof u=='string'&&u.startsWith(IMG)?u.slice(IMG.length).split(/[?#]/)[0]:null;
// map of imageId -> where it is used
const usage=async()=>{const[items,sets]=await Promise.all([Item.find().select('title type image body').lean(),Setting.find().lean()]);const m=new Map();const add=(id,r)=>{if(!m.has(id))m.set(id,[]);m.get(id).push(r)};
for(const i of items){const a=imgId(i.image);if(a)add(a,{kind:'item',label:i.title||'',type:i.type});for(const x of String(i.body||'').matchAll(/\/api\/img\/([a-f0-9]{24})/g))if(x[1]!==a)add(x[1],{kind:'item',label:i.title||'',type:i.type})}
for(const st of sets){const a=imgId(st.value);if(a)add(a,{kind:'setting',label:st.key})}return m};
const gc=async u=>{const id=imgId(u);if(!id||!valid(id))return;if(!(await usage()).has(id))await Img.findByIdAndDelete(id)};
const OKT=['image/jpeg','image/png','image/webp','image/gif'];
app.post('/api/images',auth,express.raw({type:'image/*',limit:'4mb'}),h(async(q,s)=>{const t=(q.headers['content-type']||'').split(';')[0].trim();if(!OKT.includes(t)||!Buffer.isBuffer(q.body)||!q.body.length)return s.status(400).json({error:'bad image'});const d=await Img.create({type:t,size:q.body.length,name:String(q.query.name||'').slice(0,80),data:q.body});s.json({_id:d._id,url:IMG+d._id,size:d.size})}));
app.get('/api/img/:id',h(async(q,s)=>{if(!valid(q.params.id))return s.sendStatus(404);const d=await Img.findById(q.params.id);if(!d)return s.sendStatus(404);s.set({'Content-Type':d.type,'Cache-Control':'public,max-age=31536000,immutable','X-Content-Type-Options':'nosniff'});s.send(Buffer.from(d.data))}));
const delImgs=async ids=>{let n=0,freed=0;for(const id of ids){if(!valid(id))continue;const d=await Img.findById(id).select('size');if(!d)continue;const u=IMG+id;await Item.updateMany({image:u},{image:''});await Setting.updateMany({value:u},{value:''});await Img.findByIdAndDelete(id);n++;freed+=d.size||0}return{deleted:n,freed}};
app.post('/api/images/delete',auth,h(async(q,s)=>s.json(await delImgs(Array.isArray(q.body.ids)?q.body.ids:[]))));
app.post('/api/images/cleanup',auth,h(async(q,s)=>{const u=await usage(),L=await Img.find().select('_id').lean();s.json(await delImgs(L.map(x=>String(x._id)).filter(id=>!u.has(id))))}));
app.get('/api/storage',auth,h(async(q,s)=>{const db=mongoose.connection.db;let st={};try{st=await db.stats()}catch{}
const sz=async M=>{try{const r=await M.aggregate([{$group:{_id:null,n:{$sum:1},b:{$sum:{$bsonSize:'$$ROOT'}}}}]);return{count:r[0]?.n||0,bytes:r[0]?.b??0}}catch{return{count:await M.countDocuments(),bytes:null}}};
const cols=[];for(const[key,label,M]of[['items','المحتوى',Item],['comments','التعليقات',Comment],['bookings','الحجوزات',Booking],['settings','الإعدادات',Setting],['images','الصور',Img]])cols.push({key,label,...await sz(M)});
const u=await usage(),imgs=(await Img.find().select('-data').sort('-createdAt').lean()).map(x=>({_id:x._id,size:x.size||0,type:x.type,name:x.name,createdAt:x.createdAt,usedBy:u.get(String(x._id))||[]}));
const q0=await Setting.findOne({key:'storage_quota_mb'}),est=cols.reduce((a,c)=>a+(c.bytes||0),0);
s.json({quotaMB:+(q0&&q0.value)||512,dataSize:st.dataSize??est,storageSize:st.storageSize??est,indexSize:st.indexSize??0,exact:st.dataSize!=null,collections:cols,images:imgs})}));

/* ---------- auth / settings ---------- */
app.post('/api/login',(q,s)=>q.body.password===process.env.ADMIN_PASSWORD?s.json({token:jwt.sign({a:1},process.env.JWT_SECRET,{expiresIn:'7d'})}):s.sendStatus(401));
app.get('/api/settings',h(async(q,s)=>s.json(Object.fromEntries((await Setting.find()).map(x=>[x.key,x.value])))));
app.put('/api/settings',auth,h(async(q,s)=>{for(const[k,v]of Object.entries(q.body)){const old=await Setting.findOne({key:k});await Setting.updateOne({key:k},{value:v},{upsert:true});if(old&&old.value&&old.value!==v&&imgId(old.value))await gc(old.value)}s.json({ok:1})}));

/* ---------- items ---------- */
const one=async(id,s)=>{const i=valid(id)?await Item.findById(id).lean():null;i?s.json(i):s.status(404).json({error:'not found'})};
const lite=({body,...r})=>{const w=(body||'').trim().split(/\s+/).filter(Boolean).length;return{...r,hasBody:w>0,words:w}};
app.get('/api/items',h(async(q,s)=>{const{id,type,limit,lite:l}=q.query;if(id)return one(id,s);let c=Item.find(type?{type:String(type)}:{}).sort('-createdAt');if(+limit>0)c=c.limit(Math.min(+limit,200));const L=await c.lean();s.json(l?L.map(lite):L)}));
app.get('/api/items/:id',h(async(q,s)=>one(q.params.id,s)));
app.post('/api/items',auth,h(async(q,s)=>s.json(await Item.create(pick(q.body)))));
app.put('/api/items/:id',auth,h(async(q,s)=>{const old=valid(q.params.id)?await Item.findById(q.params.id).select('image').lean():null;const i=await Item.findByIdAndUpdate(q.params.id,pick(q.body),{new:true});if(old&&old.image&&i&&old.image!==i.image)await gc(old.image);s.json(i)}));
app.delete('/api/items/:id',auth,h(async(q,s)=>{const old=valid(q.params.id)?await Item.findByIdAndDelete(q.params.id):null;if(old){await Comment.deleteMany({item:String(old._id)});if(old.image)await gc(old.image)}s.json({ok:1})}));
app.post('/api/items/:id/view',h(async(q,s)=>{const i=valid(q.params.id)?await Item.findByIdAndUpdate(q.params.id,{$inc:{views:1}},{new:true,timestamps:false}).select('views likes'):null;i?s.json({views:i.views||0,likes:i.likes||0}):s.sendStatus(404)}));
app.post('/api/items/:id/like',h(async(q,s)=>{if(!valid(q.params.id))return s.sendStatus(404);const up=q.body&&q.body.on===false;const i=await Item.findOneAndUpdate(up?{_id:q.params.id,likes:{$gt:0}}:{_id:q.params.id},{$inc:{likes:up?-1:1}},{new:true,timestamps:false}).select('views likes')||await Item.findById(q.params.id).select('views likes');i?s.json({views:i.views||0,likes:i.likes||0}):s.sendStatus(404)}));

/* ---------- comments ---------- */
const hits=new Map();const limited=ip=>{const n=Date.now(),a=(hits.get(ip)||[]).filter(t=>n-t<600000);if(a.length>=5){hits.set(ip,a);return true}a.push(n);hits.set(ip,a);return false};
app.get('/api/comments',h(async(q,s)=>{if(!valid(q.query.item))return s.json([]);s.json(await Comment.find({item:q.query.item,status:'ok'}).sort('-createdAt').limit(200).select('name text createdAt').lean())}));
app.post('/api/comments',h(async(q,s)=>{const{item,name,text,website}=q.body||{};if(website)return s.json({ok:1,status:'ok'});
const n=String(name||'').trim().slice(0,60),t=String(text||'').trim().slice(0,1500);if(!valid(item)||n.length<2||t.length<2)return s.sendStatus(400);
const ip=String(q.headers['x-forwarded-for']||q.ip||'').split(',')[0].trim();if(limited(ip))return s.status(429).json({error:'rate'});
if(!(await Item.exists({_id:item})))return s.sendStatus(404);
if(await Comment.exists({item,name:n,text:t}))return s.json({ok:1,status:'ok',comment:null});
const m=await Setting.findOne({key:'comments_mode'}),status=m&&m.value=='moderate'?'pending':'ok',c=await Comment.create({item,name:n,text:t,status});
s.json({ok:1,status,comment:status=='ok'?{_id:c._id,name:n,text:t,createdAt:c.createdAt}:null})}));
app.get('/api/admin/comments',auth,h(async(q,s)=>{const L=await Comment.find().sort('-createdAt').limit(500).lean(),its=await Item.find({_id:{$in:[...new Set(L.map(c=>c.item).filter(valid))]}}).select('title type').lean(),m=Object.fromEntries(its.map(i=>[String(i._id),i]));s.json(L.map(c=>({...c,itemTitle:(m[c.item]||{}).title||'(محذوف)',itemType:(m[c.item]||{}).type||''})))}));
app.put('/api/comments/:id',auth,h(async(q,s)=>s.json(valid(q.params.id)?await Comment.findByIdAndUpdate(q.params.id,{status:q.body.status=='pending'?'pending':'ok'},{new:true}):null)));
app.delete('/api/comments/:id',auth,h(async(q,s)=>{if(valid(q.params.id))await Comment.findByIdAndDelete(q.params.id);s.json({ok:1})}));

/* ---------- bookings ---------- */
app.post('/api/bookings',h(async(q,s)=>{const{name,phone,message}=q.body;if(!name||!phone)return s.sendStatus(400);await Booking.create({name,phone,message});s.json({ok:1})}));
app.get('/api/bookings',auth,h(async(q,s)=>s.json(await Booking.find().sort('-createdAt'))));
app.put('/api/bookings/:id',auth,h(async(q,s)=>s.json(await Booking.findByIdAndUpdate(q.params.id,{status:q.body.status==='done'?'done':'new'},{new:true}))));
app.delete('/api/bookings/:id',auth,h(async(q,s)=>{await Booking.findByIdAndDelete(q.params.id);s.json({ok:1})}));
module.exports=app;
