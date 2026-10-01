import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import * as XLSX from 'xlsx';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const APP_TZ = 'Asia/Jerusalem';
const IS_PROD = process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production';
const JWT_SECRET = process.env.JWT_SECRET || (IS_PROD ? '' : 'dev-only-change-me');
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL is required');
if (!JWT_SECRET) throw new Error('JWT_SECRET is required in production');

const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: String(process.env.DATABASE_SSL ?? 'true').toLowerCase() === 'true' ? { rejectUnauthorized: false } : false,
  max: Number(process.env.DB_POOL_MAX || 2),
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 10000
});
const q = (text, params=[]) => pool.query(text, params);

const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use('/api/auth/login', rateLimit({ windowMs: 10 * 60 * 1000, max: 30 }));
app.use(express.static(path.join(rootDir, 'public')));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });
let dbReady;

function normalizePhone(v='') {
  let s = String(v).replace(/\D/g,'');
  if (s.startsWith('972')) s = '0' + s.slice(3);
  if (s.length === 9 && s.startsWith('5')) s = '0' + s;
  return s;
}
function normalizeSystemNumber(v='') { return String(v).replace(/\D/g,''); }
function isoDay(d=new Date()) { return new Intl.DateTimeFormat('en-CA',{timeZone:APP_TZ,year:'numeric',month:'2-digit',day:'2-digit'}).format(d); }
function slugify(v='') {
  const s=String(v).trim().toLowerCase().replace(/[^a-z0-9\u0590-\u05ff]+/g,'-').replace(/^-+|-+$/g,'');
  return s || `org-${Date.now().toString(36)}`;
}
function signSession(userId, organizationId) { return jwt.sign({id:userId,org_id:organizationId}, JWT_SECRET, {expiresIn:'12h'}); }
function setSession(res,userId,organizationId){
  res.cookie('nachlas_session',signSession(userId,organizationId),{httpOnly:true,sameSite:'strict',secure:IS_PROD,maxAge:12*60*60*1000});
}
async function organizationsForUser(userId){
  return (await q(`SELECT o.id,o.name,o.slug,m.role,m.class_id
    FROM organization_members m JOIN organizations o ON o.id=m.organization_id
    WHERE m.user_id=$1 AND m.active=true AND o.active=true ORDER BY o.name`,[userId])).rows;
}
async function auth(req,res,next){
  try {
    const token=jwt.verify(req.cookies.nachlas_session || '', JWT_SECRET);
    const r=await q(`SELECT u.id,u.name,u.email,m.organization_id,m.role,m.class_id,o.name organization_name,o.slug organization_slug
      FROM users u JOIN organization_members m ON m.user_id=u.id JOIN organizations o ON o.id=m.organization_id
      WHERE u.id=$1 AND m.organization_id=$2 AND u.active=true AND m.active=true AND o.active=true`,[token.id,token.org_id]);
    if(!r.rowCount) return res.status(401).json({error:'unauthorized'});
    req.user=r.rows[0]; next();
  } catch { res.status(401).json({error:'unauthorized'}); }
}
function allow(...roles){ return (req,res,next) => roles.includes(req.user.role) ? next() : res.status(403).json({error:'forbidden'}); }
function scopeClass(req){ return req.user.role === 'class_teacher' ? req.user.class_id : null; }
async function audit(reqOrUser, action, entity=null, entityId=null, details={}){
  const u=reqOrUser?.user || reqOrUser;
  await q('INSERT INTO audit_log(organization_id,user_id,action,entity,entity_id,details) VALUES($1,$2,$3,$4,$5,$6)',[u?.organization_id||null,u?.id||null,action,entity,entityId,JSON.stringify(details)]).catch(()=>{});
}
function encryptionKey(){
  const raw=process.env.ENCRYPTION_KEY;
  if(!raw) throw new Error('ENCRYPTION_KEY is required before storing a Yemot API key');
  return crypto.createHash('sha256').update(raw).digest();
}
function encryptSecret(value){
  const iv=crypto.randomBytes(12); const cipher=crypto.createCipheriv('aes-256-gcm',encryptionKey(),iv);
  const encrypted=Buffer.concat([cipher.update(String(value),'utf8'),cipher.final()]); const tag=cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}
function publicUser(u){ return {id:u.id,name:u.name,email:u.email,role:u.role,class_id:u.class_id,organization_id:u.organization_id,organization_name:u.organization_name}; }

async function runSqlFile(name){
  const p=path.join(rootDir,'sql',name); if(fs.existsSync(p)) await q(fs.readFileSync(p,'utf8'));
}
async function initDb(){
  const autoMigrate = !IS_PROD || String(process.env.AUTO_MIGRATE || '').toLowerCase() === 'true';
  if (autoMigrate) {
    await runSqlFile('schema.sql');
    await runSqlFile('002_multi_tenant.sql');
  }

  let org=(await q('SELECT * FROM organizations ORDER BY id LIMIT 1')).rows[0];
  if(!org){
    const name=process.env.DEFAULT_ORG_NAME || '׳”׳׳¨׳’׳•׳ ׳©׳׳™';
    org=(await q('INSERT INTO organizations(name,slug) VALUES($1,$2) RETURNING *',[name,slugify(process.env.DEFAULT_ORG_SLUG||name)])).rows[0];
  }

  const email=String(process.env.ADMIN_EMAIL||'').trim().toLowerCase();
  const pass=String(process.env.ADMIN_PASSWORD||'');
  if(email && pass){
    let user=(await q('SELECT * FROM users WHERE lower(email)=lower($1)',[email])).rows[0];
    if(!user){
      const hash=await bcrypt.hash(pass,11);
      user=(await q('INSERT INTO users(name,email,password_hash) VALUES($1,$2,$3) RETURNING *',['׳׳ ׳”׳ ׳׳¢׳¨׳›׳×',email,hash])).rows[0];
    }
    await q(`INSERT INTO organization_members(organization_id,user_id,role,active) VALUES($1,$2,'admin',true)
      ON CONFLICT(organization_id,user_id) DO UPDATE SET active=true`,[org.id,user.id]);
  }

  if(String(process.env.SEED_DEMO).toLowerCase()==='true') await seedDemo(org.id);
}
async function seedDemo(orgId){
  const sys=(await q(`INSERT INTO yemot_systems(organization_id,name,system_number) VALUES($1,'׳׳¢׳¨׳›׳× ׳”׳“׳’׳׳”','000000000')
    ON CONFLICT(organization_id,system_number) DO UPDATE SET name=EXCLUDED.name RETURNING id`,[orgId])).rows[0];
  const c=(await q(`INSERT INTO classes(organization_id,yemot_system_id,name,extension_path,start_time,end_time,late_after_minutes,min_present_minutes)
    VALUES($1,$2,'׳©׳™׳¢׳•׳¨ ׳‘','07/1/2','09:00','10:00',10,20)
    ON CONFLICT(organization_id,name) DO UPDATE SET extension_path=EXCLUDED.extension_path RETURNING id`,[orgId,sys.id])).rows[0];
  for(const [name,phone] of [['׳™׳©׳¨׳׳ ׳›׳”׳','0500000001'],['׳׳©׳” ׳׳•׳™','0500000002'],['׳“׳•׳“ ׳₪׳¨׳™׳“׳׳','0500000003']])
    await q(`INSERT INTO students(organization_id,name,phone,class_id) VALUES($1,$2,$3,$4)
      ON CONFLICT(organization_id,phone) DO NOTHING`,[orgId,name,phone,c.id]);
}

dbReady=initDb();
app.use(async (_req,_res,next)=>{ try { await dbReady; next(); } catch(e) { next(e); } });

app.get('/api/health',async(_req,res)=>{
  try{await q('SELECT 1');res.json({ok:true,db:true,version:'5.0.0',hosting:process.env.VERCEL?'vercel':'local',multiTenant:true,multiSystem:true});}
  catch(e){res.status(500).json({ok:false,error:e.message});}
});

app.post('/api/auth/login',async(req,res)=>{
  const email=String(req.body.email||'').trim().toLowerCase();
  const user=(await q('SELECT * FROM users WHERE lower(email)=lower($1) AND active=true',[email])).rows[0];
  if(!user || !(await bcrypt.compare(String(req.body.password||''),user.password_hash))) return res.status(401).json({error:'׳₪׳¨׳˜׳™ ׳›׳ ׳™׳¡׳” ׳©׳’׳•׳™׳™׳'});
  const orgs=await organizationsForUser(user.id); if(!orgs.length) return res.status(403).json({error:'׳”׳׳©׳×׳׳© ׳׳™׳ ׳• ׳׳©׳•׳™׳ ׳׳׳¨׳’׳•׳ ׳₪׳¢׳™׳'});
  const org=orgs[0]; setSession(res,user.id,org.id);
  const payload={id:user.id,name:user.name,email:user.email,role:org.role,class_id:org.class_id,organization_id:org.id,organization_name:org.name};
  await q('INSERT INTO audit_log(organization_id,user_id,action) VALUES($1,$2,$3)',[org.id,user.id,'login']).catch(()=>{});
  res.json({user:payload,organizations:orgs});
});
app.post('/api/auth/logout',auth,async(req,res)=>{res.clearCookie('nachlas_session');await audit(req,'logout');res.json({ok:true});});
app.get('/api/auth/me',auth,async(req,res)=>res.json({user:publicUser(req.user),organizations:await organizationsForUser(req.user.id)}));
app.post('/api/auth/switch-organization',auth,async(req,res)=>{
  const oid=Number(req.body.organization_id); const orgs=await organizationsForUser(req.user.id); const org=orgs.find(x=>Number(x.id)===oid);
  if(!org)return res.status(403).json({error:'׳׳™׳ ׳”׳¨׳©׳׳” ׳׳׳¨׳’׳•׳ ׳–׳”'}); setSession(res,req.user.id,org.id);
  res.json({ok:true,organization:org});
});

app.get('/api/organization',auth,async(req,res)=>{
  res.json((await q('SELECT id,name,slug,active,created_at FROM organizations WHERE id=$1',[req.user.organization_id])).rows[0]);
});
app.put('/api/organization',auth,allow('admin'),async(req,res)=>{
  const name=String(req.body.name||'').trim(); if(!name)return res.status(400).json({error:'׳©׳ ׳”׳׳¨׳’׳•׳ ׳—׳¡׳¨'});
  const r=await q('UPDATE organizations SET name=$1,updated_at=NOW() WHERE id=$2 RETURNING id,name,slug',[name,req.user.organization_id]);
  await audit(req,'update','organization',String(req.user.organization_id),{name}); res.json(r.rows[0]);
});
app.post('/api/organizations',auth,allow('admin'),async(req,res)=>{
  const name=String(req.body.name||'').trim(); if(!name)return res.status(400).json({error:'׳©׳ ׳”׳׳¨׳’׳•׳ ׳—׳¡׳¨'});
  let slug=slugify(req.body.slug||name); if((await q('SELECT 1 FROM organizations WHERE slug=$1',[slug])).rowCount)slug+=`-${Date.now().toString(36)}`;
  const client=await pool.connect();
  try{await client.query('BEGIN');const org=(await client.query('INSERT INTO organizations(name,slug) VALUES($1,$2) RETURNING id,name,slug',[name,slug])).rows[0];await client.query("INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,'admin')",[org.id,req.user.id]);await client.query('COMMIT');res.json(org);}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
});

app.get('/api/yemot-systems',auth,async(req,res)=>{
  const r=await q(`SELECT y.id,y.name,y.system_number,y.api_status,y.api_last_checked_at,y.api_last_error,y.active,y.created_at,
    (y.api_key_encrypted IS NOT NULL) api_key_configured,
    (SELECT count(*)::int FROM classes c WHERE c.yemot_system_id=y.id AND c.active=true) class_count
    FROM yemot_systems y WHERE y.organization_id=$1 AND y.active=true ORDER BY y.name`,[req.user.organization_id]);
  res.json(r.rows);
});
app.post('/api/yemot-systems',auth,allow('admin'),async(req,res)=>{
  const name=String(req.body.name||'').trim(); const systemNumber=normalizeSystemNumber(req.body.system_number);
  if(!name)return res.status(400).json({error:'׳©׳ ׳”׳׳¢׳¨׳›׳× ׳—׳¡׳¨'}); if(systemNumber.length<5)return res.status(400).json({error:'׳׳¡׳₪׳¨ ׳”׳׳¢׳¨׳›׳× ׳׳™׳ ׳• ׳×׳§׳™׳'});
  const apiKey=String(req.body.api_key||'').trim(); const encrypted=apiKey?encryptSecret(apiKey):null; const status=apiKey?'configured':'pending_api';
  const r=await q(`INSERT INTO yemot_systems(organization_id,name,system_number,api_key_encrypted,api_status)
    VALUES($1,$2,$3,$4,$5) RETURNING id,name,system_number,api_status,active,created_at`,[req.user.organization_id,name,systemNumber,encrypted,status]);
  await audit(req,'create','yemot_system',String(r.rows[0].id),{name,system_number:systemNumber,api_key_configured:!!apiKey}); res.json(r.rows[0]);
});
app.put('/api/yemot-systems/:id',auth,allow('admin'),async(req,res)=>{
  const existing=(await q('SELECT * FROM yemot_systems WHERE id=$1 AND organization_id=$2',[req.params.id,req.user.organization_id])).rows[0];
  if(!existing)return res.status(404).json({error:'׳”׳׳¢׳¨׳›׳× ׳׳ ׳ ׳׳¦׳׳”'});
  const name=String(req.body.name??existing.name).trim(); const systemNumber=normalizeSystemNumber(req.body.system_number??existing.system_number);
  const apiKey=String(req.body.api_key||'').trim(); const encrypted=apiKey?encryptSecret(apiKey):existing.api_key_encrypted; const status=encrypted?'configured':'pending_api';
  const r=await q(`UPDATE yemot_systems SET name=$1,system_number=$2,api_key_encrypted=$3,api_status=$4,active=$5,updated_at=NOW()
    WHERE id=$6 AND organization_id=$7 RETURNING id,name,system_number,api_status,active`,[name,systemNumber,encrypted,status,req.body.active!==false,req.params.id,req.user.organization_id]);
  await audit(req,'update','yemot_system',req.params.id,{name,system_number:systemNumber,api_key_changed:!!apiKey}); res.json(r.rows[0]);
});
app.delete('/api/yemot-systems/:id',auth,allow('admin'),async(req,res)=>{
  await q('UPDATE yemot_systems SET active=false,updated_at=NOW() WHERE id=$1 AND organization_id=$2',[req.params.id,req.user.organization_id]);
  await audit(req,'archive','yemot_system',req.params.id); res.json({ok:true});
});
app.post('/api/yemot-systems/:id/test',auth,allow('admin'),async(req,res)=>{
  const s=(await q('SELECT id,api_key_encrypted FROM yemot_systems WHERE id=$1 AND organization_id=$2 AND active=true',[req.params.id,req.user.organization_id])).rows[0];
  if(!s)return res.status(404).json({error:'׳”׳׳¢׳¨׳›׳× ׳׳ ׳ ׳׳¦׳׳”'}); if(!s.api_key_encrypted)return res.status(400).json({error:'׳¢׳“׳™׳™׳ ׳׳ ׳”׳•׳’׳“׳¨ API Key ׳׳׳¢׳¨׳›׳× ׳–׳•'});
  res.status(501).json({error:'׳”׳׳₪׳×׳— ׳ ׳©׳׳¨ ׳‘׳¦׳•׳¨׳” ׳׳•׳¦׳₪׳ ׳×. ׳‘׳“׳™׳§׳× GetIncomingCalls ׳×׳—׳•׳‘׳¨ ׳›׳©׳™׳×׳§׳‘׳ ׳׳₪׳¨׳˜ ׳”-API ׳”׳¡׳•׳₪׳™.'});
});

async function validClass(orgId,classId){if(!classId)return true;return (await q('SELECT 1 FROM classes WHERE id=$1 AND organization_id=$2',[classId,orgId])).rowCount>0;}
async function validSystem(orgId,systemId){if(!systemId)return true;return (await q('SELECT 1 FROM yemot_systems WHERE id=$1 AND organization_id=$2 AND active=true',[systemId,orgId])).rowCount>0;}

app.get('/api/dashboard',auth,async(req,res)=>{
  const day=String(req.query.day||isoDay()); const cls=scopeClass(req); const org=req.user.organization_id;
  const params=[org]; let sf=''; if(cls){params.push(cls);sf=`AND s.class_id=$2`;}
  const total=(await q(`SELECT count(*)::int n FROM students s WHERE s.organization_id=$1 AND s.active=true ${sf}`,params)).rows[0].n;
  const live=(await q(`SELECT count(*)::int n FROM call_sessions c LEFT JOIN students s ON s.organization_id=c.organization_id AND s.phone=c.phone WHERE c.organization_id=$1 AND c.exited_at IS NULL ${cls?'AND s.class_id=$2':''}`,params)).rows[0].n;
  const rows=await buildAttendance(org,day,cls); const present=rows.filter(x=>['present','late'].includes(x.status)).length; const absent=rows.filter(x=>x.status==='absent').length;
  const avg=present?Math.round(rows.filter(x=>x.total_minutes>0).reduce((a,b)=>a+b.total_minutes,0)/present):0;
  res.json({day,total,live,present,absent,avg_minutes:avg,recent:rows.slice(0,8)});
});

app.get('/api/classes',auth,async(req,res)=>{
  const cls=scopeClass(req); const p=[req.user.organization_id]; let wh='c.organization_id=$1'; if(cls){p.push(cls);wh+=' AND c.id=$2';}
  const r=await q(`SELECT c.*,y.name yemot_system_name,y.system_number,
    (SELECT count(*) FROM students s WHERE s.class_id=c.id AND s.organization_id=c.organization_id AND s.active=true)::int student_count
    FROM classes c LEFT JOIN yemot_systems y ON y.id=c.yemot_system_id WHERE ${wh} ORDER BY c.name`,p); res.json(r.rows);
});
app.post('/api/classes',auth,allow('admin','secretary'),async(req,res)=>{
  const b=req.body; if(!(await validSystem(req.user.organization_id,b.yemot_system_id)))return res.status(400).json({error:'׳׳¢׳¨׳›׳× ׳™׳׳•׳× ׳׳™׳ ׳” ׳©׳™׳™׳›׳× ׳׳׳¨׳’׳•׳'});
  const r=await q(`INSERT INTO classes(organization_id,yemot_system_id,name,extension_path,weekdays,start_time,end_time,late_after_minutes,min_present_minutes,active)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[req.user.organization_id,b.yemot_system_id||null,b.name,b.extension_path||'',b.weekdays||[0,1,2,3,4,5,6],b.start_time||'09:00',b.end_time||'10:00',Number(b.late_after_minutes||10),Number(b.min_present_minutes||20),b.active!==false]);
  await audit(req,'create','class',String(r.rows[0].id),{name:b.name,extension_path:b.extension_path,yemot_system_id:b.yemot_system_id||null});res.json(r.rows[0]);
});
app.put('/api/classes/:id',auth,allow('admin','secretary'),async(req,res)=>{
  const b=req.body;if(!(await validSystem(req.user.organization_id,b.yemot_system_id)))return res.status(400).json({error:'׳׳¢׳¨׳›׳× ׳™׳׳•׳× ׳׳™׳ ׳” ׳©׳™׳™׳›׳× ׳׳׳¨׳’׳•׳'});
  const r=await q(`UPDATE classes SET yemot_system_id=$1,name=$2,extension_path=$3,weekdays=$4,start_time=$5,end_time=$6,late_after_minutes=$7,min_present_minutes=$8,active=$9,updated_at=NOW()
    WHERE id=$10 AND organization_id=$11 RETURNING *`,[b.yemot_system_id||null,b.name,b.extension_path||'',b.weekdays||[0,1,2,3,4,5,6],b.start_time,b.end_time,Number(b.late_after_minutes||10),Number(b.min_present_minutes||20),b.active!==false,req.params.id,req.user.organization_id]);
  if(!r.rowCount)return res.status(404).json({error:'׳”׳©׳™׳¢׳•׳¨ ׳׳ ׳ ׳׳¦׳'});await audit(req,'update','class',req.params.id,b);res.json(r.rows[0]);
});

app.get('/api/students',auth,async(req,res)=>{
  const search=String(req.query.search||'').trim(); const cls=scopeClass(req)||req.query.class_id||null; const p=[req.user.organization_id]; const wh=['s.organization_id=$1','s.active=true'];
  if(cls){p.push(cls);wh.push(`s.class_id=$${p.length}`);} if(search){p.push(`%${search}%`);wh.push(`(s.name ILIKE $${p.length} OR s.phone ILIKE $${p.length})`);}
  const r=await q(`SELECT s.*,c.name class_name,c.extension_path,y.name yemot_system_name,y.system_number FROM students s LEFT JOIN classes c ON c.id=s.class_id LEFT JOIN yemot_systems y ON y.id=c.yemot_system_id WHERE ${wh.join(' AND ')} ORDER BY c.name NULLS LAST,s.name`,p);res.json(r.rows);
});
app.post('/api/students',auth,allow('admin','secretary'),async(req,res)=>{
  const b=req.body;const phone=normalizePhone(b.phone);if(!phone)return res.status(400).json({error:'׳˜׳׳₪׳•׳ ׳—׳¡׳¨'});if(!(await validClass(req.user.organization_id,b.class_id)))return res.status(400).json({error:'׳”׳©׳™׳¢׳•׳¨ ׳׳™׳ ׳• ׳©׳™׳™׳ ׳׳׳¨׳’׳•׳'});
  const r=await q('INSERT INTO students(organization_id,name,phone,class_id,external_id,notes) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[req.user.organization_id,b.name,phone,b.class_id||null,b.external_id||null,b.notes||null]);
  await audit(req,'create','student',String(r.rows[0].id),{name:b.name,phone});res.json(r.rows[0]);
});
app.put('/api/students/:id',auth,allow('admin','secretary'),async(req,res)=>{
  const b=req.body;if(!(await validClass(req.user.organization_id,b.class_id)))return res.status(400).json({error:'׳”׳©׳™׳¢׳•׳¨ ׳׳™׳ ׳• ׳©׳™׳™׳ ׳׳׳¨׳’׳•׳'});
  const r=await q(`UPDATE students SET name=$1,phone=$2,class_id=$3,external_id=$4,notes=$5,active=$6,updated_at=NOW() WHERE id=$7 AND organization_id=$8 RETURNING *`,[b.name,normalizePhone(b.phone),b.class_id||null,b.external_id||null,b.notes||null,b.active!==false,req.params.id,req.user.organization_id]);
  if(!r.rowCount)return res.status(404).json({error:'׳”׳×׳׳׳™׳“ ׳׳ ׳ ׳׳¦׳'});await audit(req,'update','student',req.params.id,{name:b.name});res.json(r.rows[0]);
});
app.delete('/api/students/:id',auth,allow('admin'),async(req,res)=>{await q('UPDATE students SET active=false,updated_at=NOW() WHERE id=$1 AND organization_id=$2',[req.params.id,req.user.organization_id]);await audit(req,'archive','student',req.params.id);res.json({ok:true});});

function getCell(row,names){for(const n of names){const k=Object.keys(row).find(x=>String(x).trim().toLowerCase()===n.toLowerCase());if(k&&row[k]!==undefined&&row[k]!==null&&String(row[k]).trim()!=='')return row[k];}return '';}
app.post('/api/students/import',auth,allow('admin','secretary'),upload.single('file'),async(req,res)=>{
  if(!req.file)return res.status(400).json({error:'׳׳ ׳”׳×׳§׳‘׳ ׳§׳•׳‘׳¥'});const wb=XLSX.read(req.file.buffer,{type:'buffer'});const rows=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{defval:''});
  const org=req.user.organization_id;const classes=(await q('SELECT id,name FROM classes WHERE organization_id=$1',[org])).rows;let imported=0,updated=0,skipped=0;
  for(const row of rows){const name=String(getCell(row,['׳©׳','׳©׳ ׳׳׳','name','student'])).trim();const phone=normalizePhone(getCell(row,['׳˜׳׳₪׳•׳','׳₪׳׳׳₪׳•׳','׳ ׳™׳™׳“','phone','mobile']));const className=String(getCell(row,['׳©׳™׳¢׳•׳¨','׳›׳™׳×׳”','class','group'])).trim();if(!name||!phone){skipped++;continue;}let classId=null;
    if(className){let c=classes.find(x=>x.name.trim()===className);if(!c){c=(await q('INSERT INTO classes(organization_id,name) VALUES($1,$2) RETURNING id,name',[org,className])).rows[0];classes.push(c);}classId=c.id;}
    const r=await q(`INSERT INTO students(organization_id,name,phone,class_id) VALUES($1,$2,$3,$4)
      ON CONFLICT(organization_id,phone) DO UPDATE SET name=EXCLUDED.name,class_id=COALESCE(EXCLUDED.class_id,students.class_id),active=true,updated_at=NOW() RETURNING (xmax=0) inserted`,[org,name,phone,classId]);
    if(r.rows[0].inserted)imported++;else updated++;}
  await audit(req,'import','students',null,{imported,updated,skipped});res.json({imported,updated,skipped,total:rows.length});
});

app.get('/api/live',auth,async(req,res)=>{
  const cls=scopeClass(req);const p=[req.user.organization_id];let cf='';if(cls){p.push(cls);cf='AND s.class_id=$2';}
  const r=await q(`SELECT c.*,s.name student_name,s.class_id,cl.name class_name,cl.extension_path class_extension,y.name yemot_system_name,y.system_number,
    EXTRACT(EPOCH FROM (NOW()-c.entered_at))::int live_seconds
    FROM call_sessions c LEFT JOIN students s ON s.organization_id=c.organization_id AND s.phone=c.phone LEFT JOIN classes cl ON cl.id=s.class_id LEFT JOIN yemot_systems y ON y.id=c.yemot_system_id
    WHERE c.organization_id=$1 AND c.exited_at IS NULL ${cf} ORDER BY c.entered_at`,p);res.json(r.rows);
});

async function buildAttendance(orgId,day,classId=null){
  const p=[orgId,day];let cf='';if(classId){p.push(classId);cf=`AND s.class_id=$3`;}
  const sql=`SELECT s.id student_id,s.name,s.phone,c.id class_id,c.name class_name,c.extension_path,c.yemot_system_id,c.start_time,c.end_time,c.late_after_minutes,c.min_present_minutes,
    MIN(cs.entered_at) FILTER (WHERE cs.id IS NOT NULL) first_enter,MAX(COALESCE(cs.exited_at,NOW())) FILTER (WHERE cs.id IS NOT NULL) last_exit,
    COALESCE(SUM(GREATEST(0,EXTRACT(EPOCH FROM (COALESCE(cs.exited_at,NOW())-cs.entered_at)))),0)::int seconds,ao.status override_status,ao.note override_note
    FROM students s LEFT JOIN classes c ON c.id=s.class_id
    LEFT JOIN call_sessions cs ON cs.organization_id=s.organization_id AND cs.phone=s.phone AND cs.extension_path=c.extension_path
      AND (c.yemot_system_id IS NULL OR cs.yemot_system_id=c.yemot_system_id) AND cs.entered_at >= $2::date AND cs.entered_at < ($2::date + INTERVAL '1 day')
    LEFT JOIN attendance_overrides ao ON ao.organization_id=s.organization_id AND ao.student_id=s.id AND ao.day=$2::date
    WHERE s.organization_id=$1 AND s.active=true ${cf}
    GROUP BY s.id,s.name,s.phone,c.id,c.name,c.extension_path,c.yemot_system_id,c.start_time,c.end_time,c.late_after_minutes,c.min_present_minutes,ao.status,ao.note
    ORDER BY c.name NULLS LAST,s.name`;
  const rows=(await q(sql,p)).rows;return rows.map(r=>{const mins=Math.round(Number(r.seconds)/60);let status='absent';if(r.override_status)status=r.override_status;else if(mins>=Number(r.min_present_minutes||1)){status='present';if(r.first_enter&&r.start_time){const start=new Date(`${day}T${String(r.start_time).slice(0,8)}+03:00`);if(new Date(r.first_enter)>new Date(start.getTime()+Number(r.late_after_minutes||0)*60000))status='late';}}return {...r,total_minutes:mins,status};});
}
app.get('/api/attendance',auth,async(req,res)=>res.json(await buildAttendance(req.user.organization_id,String(req.query.day||isoDay()),scopeClass(req)||req.query.class_id||null)));
app.post('/api/attendance/override',auth,allow('admin','secretary','class_teacher'),async(req,res)=>{
  const b=req.body;const chk=await q('SELECT class_id FROM students WHERE id=$1 AND organization_id=$2',[b.student_id,req.user.organization_id]);if(!chk.rowCount)return res.status(404).json({error:'׳”׳×׳׳׳™׳“ ׳׳ ׳ ׳׳¦׳'});if(req.user.role==='class_teacher'&&Number(chk.rows[0].class_id)!==Number(req.user.class_id))return res.status(403).json({error:'forbidden'});
  await q(`INSERT INTO attendance_overrides(organization_id,student_id,day,status,note,user_id) VALUES($1,$2,$3,$4,$5,$6)
    ON CONFLICT(student_id,day) DO UPDATE SET status=EXCLUDED.status,note=EXCLUDED.note,user_id=EXCLUDED.user_id,organization_id=EXCLUDED.organization_id,created_at=NOW()`,[req.user.organization_id,b.student_id,b.day,b.status,b.note||null,req.user.id]);
  await audit(req,'override','attendance',`${b.student_id}:${b.day}`,b);res.json({ok:true});
});
app.get('/api/reports/summary',auth,async(req,res)=>{
  const from=String(req.query.from||isoDay(new Date(Date.now()-6*86400000)));const to=String(req.query.to||isoDay());const cls=scopeClass(req)||req.query.class_id||null;const days=[];
  for(let d=new Date(from+'T12:00:00');d<=new Date(to+'T12:00:00');d.setDate(d.getDate()+1)){const day=isoDay(d);const rows=await buildAttendance(req.user.organization_id,day,cls);days.push({day,total:rows.length,present:rows.filter(x=>['present','late'].includes(x.status)).length,late:rows.filter(x=>x.status==='late').length,absent:rows.filter(x=>x.status==='absent').length,minutes:rows.reduce((a,b)=>a+b.total_minutes,0)});}res.json({from,to,days});
});

app.get('/api/users',auth,allow('admin'),async(req,res)=>res.json((await q(`SELECT u.id,u.name,u.email,m.role,m.class_id,m.active,m.created_at
  FROM organization_members m JOIN users u ON u.id=m.user_id WHERE m.organization_id=$1 ORDER BY u.name`,[req.user.organization_id])).rows));
app.post('/api/users',auth,allow('admin'),async(req,res)=>{
  const b=req.body;if(!(await validClass(req.user.organization_id,b.class_id)))return res.status(400).json({error:'׳”׳©׳™׳¢׳•׳¨ ׳׳™׳ ׳• ׳©׳™׳™׳ ׳׳׳¨׳’׳•׳'});const email=String(b.email||'').trim().toLowerCase();if(!email)return res.status(400).json({error:'׳׳™׳׳™׳™׳ ׳—׳¡׳¨'});
  let user=(await q('SELECT * FROM users WHERE lower(email)=lower($1)',[email])).rows[0];
  if(!user){if(!b.password)return res.status(400).json({error:'׳¡׳™׳¡׳׳” ׳–׳׳ ׳™׳× ׳—׳¡׳¨׳”'});const hash=await bcrypt.hash(String(b.password),11);user=(await q('INSERT INTO users(name,email,password_hash) VALUES($1,$2,$3) RETURNING *',[b.name,email,hash])).rows[0];}
  const r=await q(`INSERT INTO organization_members(organization_id,user_id,role,class_id,active) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(organization_id,user_id) DO UPDATE SET role=EXCLUDED.role,class_id=EXCLUDED.class_id,active=EXCLUDED.active,updated_at=NOW()
    RETURNING id,organization_id,user_id,role,class_id,active`,[req.user.organization_id,user.id,b.role||'viewer',b.class_id||null,b.active!==false]);
  await audit(req,'create_or_update','user',String(user.id),{email,role:b.role});res.json({...r.rows[0],name:user.name,email:user.email});
});

app.get('/api/settings/status',auth,async(req,res)=>{
  const systems=(await q(`SELECT count(*)::int total,count(*) FILTER(WHERE api_key_encrypted IS NOT NULL)::int configured FROM yemot_systems WHERE organization_id=$1 AND active=true`,[req.user.organization_id])).rows[0];
  res.json({organization:{id:req.user.organization_id,name:req.user.organization_name},systemsTotal:systems.total,systemsConfigured:systems.configured,yemotConfigured:systems.configured>0,mode:systems.configured>0?'yemot_ready':'pending_api',encryptionConfigured:!!process.env.ENCRYPTION_KEY});
});
app.post('/api/integrations/pull-live',auth,allow('admin'),async(req,res)=>{
  const systems=(await q('SELECT id FROM yemot_systems WHERE organization_id=$1 AND active=true AND api_key_encrypted IS NOT NULL',[req.user.organization_id])).rows;
  if(!systems.length)return res.status(400).json({error:'׳׳™׳ ׳¢׳“׳™׳™׳ ׳׳¢׳¨׳›׳× ׳™׳׳•׳× ׳¢׳ API Key. ׳ ׳™׳×׳ ׳׳”׳’׳“׳™׳¨ ׳׳¡׳₪׳¨ ׳׳¢׳¨׳›׳× ׳‘׳׳‘׳“ ׳•׳׳”׳•׳¡׳™׳£ ׳׳₪׳×׳— ׳׳׳•׳—׳¨ ׳™׳•׳×׳¨.'});
  res.status(501).json({error:'׳”׳׳¢׳¨׳›׳•׳× ׳׳•׳›׳ ׳•׳× ׳׳—׳™׳‘׳•׳¨. adapter ׳©׳ GetIncomingCalls ׳™׳—׳•׳‘׳¨ ׳׳׳—׳¨ ׳§׳‘׳׳× ׳׳₪׳¨׳˜ ׳”-API ׳•׳”׳׳₪׳×׳—.'});
});
app.get('/api/audit',auth,allow('admin'),async(req,res)=>res.json((await q(`SELECT a.*,u.name user_name FROM audit_log a LEFT JOIN users u ON u.id=a.user_id WHERE a.organization_id=$1 ORDER BY a.created_at DESC LIMIT 100`,[req.user.organization_id])).rows));

app.use((_req,res)=>res.sendFile(path.join(rootDir,'public/index.html')));
app.use((err,_req,res,_next)=>{
  console.error(err);
  if(err?.code==='23505')return res.status(409).json({error:'׳›׳‘׳¨ ׳§׳™׳™׳ ׳₪׳¨׳™׳˜ ׳¢׳ ׳”׳¢׳¨׳ ׳”׳–׳” ׳‘׳׳¨׳’׳•׳ ׳”׳ ׳•׳›׳—׳™'});
  res.status(500).json({error:IS_PROD?'׳©׳’׳™׳׳× ׳©׳¨׳×':String(err?.message||err)});
});

export { app, dbReady, pool };
export default app;
