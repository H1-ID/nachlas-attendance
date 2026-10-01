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
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const APP_TZ = process.env.TZ || 'Asia/Jerusalem';
process.env.TZ = APP_TZ;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-change-me';
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL is required');

const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: String(process.env.DATABASE_SSL ?? 'true').toLowerCase() === 'true' ? { rejectUnauthorized: false } : false,
  max: Number(process.env.DB_POOL_MAX || 2),
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 10000
});

const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use('/api/auth/login', rateLimit({ windowMs: 10 * 60 * 1000, max: 30 }));
app.use(express.static(path.join(rootDir, 'public')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });
const q = (text, params=[]) => pool.query(text, params);
let dbReady;

function normalizePhone(v='') {
  let s = String(v).replace(/\D/g,'');
  if (s.startsWith('972')) s = '0' + s.slice(3);
  if (s.length === 9 && s.startsWith('5')) s = '0' + s;
  return s;
}
function isoDay(d=new Date()) { return new Intl.DateTimeFormat('en-CA',{timeZone:APP_TZ,year:'numeric',month:'2-digit',day:'2-digit'}).format(d); }
function signUser(user) { return jwt.sign({id:user.id,name:user.name,email:user.email,role:user.role,class_id:user.class_id}, JWT_SECRET, {expiresIn:'12h'}); }
function auth(req,res,next){
  try { req.user = jwt.verify(req.cookies.nachlas_session || '', JWT_SECRET); next(); }
  catch { res.status(401).json({error:'unauthorized'}); }
}
function allow(...roles){ return (req,res,next) => roles.includes(req.user.role) ? next() : res.status(403).json({error:'forbidden'}); }
function scopeClass(req){ return req.user.role === 'class_teacher' ? req.user.class_id : null; }
async function audit(userId, action, entity=null, entityId=null, details={}){
  await q('INSERT INTO audit_log(user_id,action,entity,entity_id,details) VALUES($1,$2,$3,$4,$5)',[userId,action,entity,entityId,JSON.stringify(details)]).catch(()=>{});
}

async function initDb(){
  await q(fs.readFileSync(path.join(rootDir,'sql/schema.sql'),'utf8'));
  const email = process.env.ADMIN_EMAIL || 'admin@example.com';
  const pass = process.env.ADMIN_PASSWORD || 'ChangeMe123!';
  const found = await q('SELECT id FROM users WHERE email=$1',[email]);
  if (!found.rowCount){
    const hash = await bcrypt.hash(pass, 11);
    await q('INSERT INTO users(name,email,password_hash,role) VALUES($1,$2,$3,$4)',['מנהל מערכת',email,hash,'admin']);
  }
  if (String(process.env.SEED_DEMO).toLowerCase()==='true') await seedDemo();
}
async function seedDemo(){
  const c = await q("INSERT INTO classes(name,extension_path,start_time,end_time,late_after_minutes,min_present_minutes) VALUES('שיעור ב','07/1/2','09:00','10:00',10,20) ON CONFLICT(name) DO UPDATE SET extension_path=EXCLUDED.extension_path RETURNING id");
  const cid = c.rows[0]?.id || (await q("SELECT id FROM classes WHERE name='שיעור ב'")).rows[0].id;
  for (const [name,phone] of [['ישראל כהן','0500000001'],['משה לוי','0500000002'],['דוד פרידמן','0500000003']])
    await q('INSERT INTO students(name,phone,class_id) VALUES($1,$2,$3) ON CONFLICT(phone) DO NOTHING',[name,phone,cid]);
}

dbReady = initDb();
app.use(async (_req,_res,next)=>{ try { await dbReady; next(); } catch(e) { next(e); } });

app.get('/api/health', async (_req,res)=>{
  try { await q('SELECT 1'); res.json({ok:true,db:true,version:'4.1.0',hosting:process.env.VERCEL?'vercel':'local'}); }
  catch(e){ res.status(500).json({ok:false,error:e.message}); }
});

app.post('/api/auth/login', async (req,res)=>{
  const email=String(req.body.email||'').trim().toLowerCase();
  const row=(await q('SELECT * FROM users WHERE lower(email)=lower($1) AND active=true',[email])).rows[0];
  if(!row || !(await bcrypt.compare(String(req.body.password||''),row.password_hash))) return res.status(401).json({error:'פרטי כניסה שגויים'});
  res.cookie('nachlas_session',signUser(row),{httpOnly:true,sameSite:'strict',secure:process.env.NODE_ENV==='production' || process.env.VERCEL_ENV==='production',maxAge:12*60*60*1000});
  await audit(row.id,'login');
  res.json({user:{id:row.id,name:row.name,email:row.email,role:row.role,class_id:row.class_id}});
});
app.post('/api/auth/logout',auth,async(req,res)=>{res.clearCookie('nachlas_session'); await audit(req.user.id,'logout'); res.json({ok:true});});
app.get('/api/auth/me',auth,(req,res)=>res.json({user:req.user}));

app.get('/api/dashboard',auth,async(req,res)=>{
  const day=String(req.query.day||isoDay());
  const cls=scopeClass(req);
  const total=(await q(`SELECT count(*)::int n FROM students s WHERE active=true ${cls?'AND s.class_id=$1':''}`,cls?[cls]:[])).rows[0].n;
  const live=(await q(`SELECT count(*)::int n FROM call_sessions c LEFT JOIN students s ON s.phone=c.phone WHERE c.exited_at IS NULL ${cls?'AND s.class_id=$1':''}`,cls?[cls]:[])).rows[0].n;
  const rows=(await buildAttendance(day, cls));
  const present=rows.filter(x=>['present','late'].includes(x.status)).length;
  const absent=rows.filter(x=>x.status==='absent').length;
  const avg=present?Math.round(rows.filter(x=>x.total_minutes>0).reduce((a,b)=>a+b.total_minutes,0)/present):0;
  res.json({day,total,live,present,absent,avg_minutes:avg,recent:rows.slice(0,8)});
});

app.get('/api/classes',auth,async(req,res)=>{
  const cls=scopeClass(req);
  const r=await q(`SELECT c.*, (SELECT count(*) FROM students s WHERE s.class_id=c.id AND s.active=true)::int student_count FROM classes c ${cls?'WHERE c.id=$1':''} ORDER BY c.name`,cls?[cls]:[]);
  res.json(r.rows);
});
app.post('/api/classes',auth,allow('admin','secretary'),async(req,res)=>{
  const b=req.body; const r=await q(`INSERT INTO classes(name,extension_path,weekdays,start_time,end_time,late_after_minutes,min_present_minutes,active)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[b.name,b.extension_path||'',b.weekdays||[0,1,2,3,4,5,6],b.start_time||'09:00',b.end_time||'10:00',Number(b.late_after_minutes||10),Number(b.min_present_minutes||20),b.active!==false]);
  await audit(req.user.id,'create','class',String(r.rows[0].id),b); res.json(r.rows[0]);
});
app.put('/api/classes/:id',auth,allow('admin','secretary'),async(req,res)=>{
  const b=req.body; const r=await q(`UPDATE classes SET name=$1,extension_path=$2,weekdays=$3,start_time=$4,end_time=$5,late_after_minutes=$6,min_present_minutes=$7,active=$8 WHERE id=$9 RETURNING *`,[b.name,b.extension_path||'',b.weekdays||[0,1,2,3,4,5,6],b.start_time,b.end_time,Number(b.late_after_minutes||10),Number(b.min_present_minutes||20),b.active!==false,req.params.id]);
  await audit(req.user.id,'update','class',req.params.id,b); res.json(r.rows[0]);
});

app.get('/api/students',auth,async(req,res)=>{
  const search=String(req.query.search||'').trim(); const cls=scopeClass(req)||req.query.class_id||null;
  const p=[]; const wh=['s.active=true'];
  if(cls){p.push(cls);wh.push(`s.class_id=$${p.length}`)}
  if(search){p.push(`%${search}%`);wh.push(`(s.name ILIKE $${p.length} OR s.phone ILIKE $${p.length})`)}
  const r=await q(`SELECT s.*,c.name class_name,c.extension_path FROM students s LEFT JOIN classes c ON c.id=s.class_id WHERE ${wh.join(' AND ')} ORDER BY c.name NULLS LAST,s.name`,p);
  res.json(r.rows);
});
app.post('/api/students',auth,allow('admin','secretary'),async(req,res)=>{
  const b=req.body; const phone=normalizePhone(b.phone); if(!phone)return res.status(400).json({error:'טלפון חסר'});
  const r=await q('INSERT INTO students(name,phone,class_id,external_id,notes) VALUES($1,$2,$3,$4,$5) RETURNING *',[b.name,phone,b.class_id||null,b.external_id||null,b.notes||null]);
  await audit(req.user.id,'create','student',String(r.rows[0].id),{name:b.name,phone}); res.json(r.rows[0]);
});
app.put('/api/students/:id',auth,allow('admin','secretary'),async(req,res)=>{
  const b=req.body; const r=await q('UPDATE students SET name=$1,phone=$2,class_id=$3,external_id=$4,notes=$5,active=$6 WHERE id=$7 RETURNING *',[b.name,normalizePhone(b.phone),b.class_id||null,b.external_id||null,b.notes||null,b.active!==false,req.params.id]);
  await audit(req.user.id,'update','student',req.params.id,{name:b.name}); res.json(r.rows[0]);
});
app.delete('/api/students/:id',auth,allow('admin'),async(req,res)=>{await q('UPDATE students SET active=false WHERE id=$1',[req.params.id]);await audit(req.user.id,'archive','student',req.params.id);res.json({ok:true});});

function getCell(row, names){ for(const n of names){ const k=Object.keys(row).find(x=>String(x).trim().toLowerCase()===n.toLowerCase()); if(k && row[k]!==undefined && row[k]!==null && String(row[k]).trim()!=='') return row[k]; } return ''; }
app.post('/api/students/import',auth,allow('admin','secretary'),upload.single('file'),async(req,res)=>{
  if(!req.file)return res.status(400).json({error:'לא התקבל קובץ'});
  const wb=XLSX.read(req.file.buffer,{type:'buffer'}); const rows=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{defval:''});
  const classes=(await q('SELECT id,name FROM classes')).rows; let imported=0,updated=0,skipped=0;
  for(const row of rows){
    const name=String(getCell(row,['שם','שם מלא','name','student'])).trim();
    const phone=normalizePhone(getCell(row,['טלפון','פלאפון','נייד','phone','mobile']));
    const className=String(getCell(row,['שיעור','כיתה','class','group'])).trim();
    if(!name||!phone){skipped++;continue;}
    let classId=null;
    if(className){ let c=classes.find(x=>x.name.trim()===className); if(!c){ c=(await q('INSERT INTO classes(name) VALUES($1) RETURNING id,name',[className])).rows[0]; classes.push(c); } classId=c.id; }
    const r=await q(`INSERT INTO students(name,phone,class_id) VALUES($1,$2,$3) ON CONFLICT(phone) DO UPDATE SET name=EXCLUDED.name,class_id=COALESCE(EXCLUDED.class_id,students.class_id),active=true RETURNING (xmax=0) inserted`,[name,phone,classId]);
    if(r.rows[0].inserted)imported++;else updated++;
  }
  await audit(req.user.id,'import','students',null,{imported,updated,skipped}); res.json({imported,updated,skipped,total:rows.length});
});

app.get('/api/live',auth,async(req,res)=>{
  const cls=scopeClass(req); const p=cls?[cls]:[];
  const r=await q(`SELECT c.*,s.name student_name,s.class_id,cl.name class_name,cl.extension_path class_extension,
    EXTRACT(EPOCH FROM (NOW()-c.entered_at))::int live_seconds
    FROM call_sessions c LEFT JOIN students s ON s.phone=c.phone LEFT JOIN classes cl ON cl.id=s.class_id
    WHERE c.exited_at IS NULL ${cls?'AND s.class_id=$1':''} ORDER BY c.entered_at`,p);
  res.json(r.rows);
});

async function buildAttendance(day, classId=null){
  const p=[day]; let cf=''; if(classId){p.push(classId);cf=`AND s.class_id=$2`;}
  const sql=`SELECT s.id student_id,s.name,s.phone,c.id class_id,c.name class_name,c.extension_path,c.start_time,c.end_time,c.late_after_minutes,c.min_present_minutes,
    MIN(cs.entered_at) FILTER (WHERE cs.id IS NOT NULL) first_enter,
    MAX(COALESCE(cs.exited_at,NOW())) FILTER (WHERE cs.id IS NOT NULL) last_exit,
    COALESCE(SUM(GREATEST(0,EXTRACT(EPOCH FROM (COALESCE(cs.exited_at,NOW())-cs.entered_at)))),0)::int seconds,
    ao.status override_status,ao.note override_note
    FROM students s LEFT JOIN classes c ON c.id=s.class_id
    LEFT JOIN call_sessions cs ON cs.phone=s.phone AND cs.extension_path=c.extension_path AND cs.entered_at >= $1::date AND cs.entered_at < ($1::date + INTERVAL '1 day')
    LEFT JOIN attendance_overrides ao ON ao.student_id=s.id AND ao.day=$1::date
    WHERE s.active=true ${cf}
    GROUP BY s.id,s.name,s.phone,c.id,c.name,c.extension_path,c.start_time,c.end_time,c.late_after_minutes,c.min_present_minutes,ao.status,ao.note
    ORDER BY c.name NULLS LAST,s.name`;
  const rows=(await q(sql,p)).rows;
  return rows.map(r=>{
    const mins=Math.round(Number(r.seconds)/60); let status='absent';
    if(r.override_status)status=r.override_status;
    else if(mins>=Number(r.min_present_minutes||1)){
      status='present';
      if(r.first_enter && r.start_time){
        const start=new Date(`${day}T${String(r.start_time).slice(0,8)}`); if(new Date(r.first_enter)>new Date(start.getTime()+Number(r.late_after_minutes||0)*60000))status='late';
      }
    }
    return {...r,total_minutes:mins,status};
  });
}
app.get('/api/attendance',auth,async(req,res)=>res.json(await buildAttendance(String(req.query.day||isoDay()),scopeClass(req)||req.query.class_id||null)));
app.post('/api/attendance/override',auth,allow('admin','secretary','class_teacher'),async(req,res)=>{
  const b=req.body; if(req.user.role==='class_teacher'){
    const chk=await q('SELECT 1 FROM students WHERE id=$1 AND class_id=$2',[b.student_id,req.user.class_id]); if(!chk.rowCount)return res.status(403).json({error:'forbidden'});
  }
  await q(`INSERT INTO attendance_overrides(student_id,day,status,note,user_id) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(student_id,day) DO UPDATE SET status=EXCLUDED.status,note=EXCLUDED.note,user_id=EXCLUDED.user_id,created_at=NOW()`,[b.student_id,b.day,b.status,b.note||null,req.user.id]);
  await audit(req.user.id,'override','attendance',`${b.student_id}:${b.day}`,b);res.json({ok:true});
});

app.get('/api/reports/summary',auth,async(req,res)=>{
  const from=String(req.query.from||isoDay(new Date(Date.now()-6*86400000))); const to=String(req.query.to||isoDay()); const cls=scopeClass(req)||req.query.class_id||null;
  const days=[]; for(let d=new Date(from+'T12:00:00');d<=new Date(to+'T12:00:00');d.setDate(d.getDate()+1)){const day=isoDay(d);const rows=await buildAttendance(day,cls);days.push({day,total:rows.length,present:rows.filter(x=>['present','late'].includes(x.status)).length,late:rows.filter(x=>x.status==='late').length,absent:rows.filter(x=>x.status==='absent').length,minutes:rows.reduce((a,b)=>a+b.total_minutes,0)});}
  res.json({from,to,days});
});

app.get('/api/users',auth,allow('admin'),async(_req,res)=>res.json((await q('SELECT id,name,email,role,class_id,active,created_at FROM users ORDER BY name')).rows));
app.post('/api/users',auth,allow('admin'),async(req,res)=>{
  const b=req.body; const hash=await bcrypt.hash(String(b.password||Math.random()),11); const r=await q('INSERT INTO users(name,email,password_hash,role,class_id,active) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,name,email,role,class_id,active',[b.name,String(b.email).toLowerCase(),hash,b.role||'viewer',b.class_id||null,b.active!==false]); await audit(req.user.id,'create','user',String(r.rows[0].id),{email:b.email,role:b.role});res.json(r.rows[0]);
});

app.get('/api/settings/status',auth,async(_req,res)=>res.json({yemotConfigured:!!(process.env.YEMOT_LIVE_ENDPOINT&&process.env.YEMOT_API_KEY),systemNumber:process.env.YEMOT_SYSTEM_NUMBER||'',mode:(process.env.YEMOT_LIVE_ENDPOINT&&process.env.YEMOT_API_KEY)?'yemot':'pending_api'}));
app.post('/api/integrations/pull-live',auth,allow('admin'),async(_req,res)=>{
  if(!process.env.YEMOT_LIVE_ENDPOINT||!process.env.YEMOT_API_KEY)return res.status(400).json({error:'Yemot API עדיין לא הוגדר. השארנו את החיבור מוכן.'});
  return res.status(501).json({error:'יש API Key, אך צריך להתאים פעם אחת את פורמט האימות והתגובה של GetIncomingCalls למפתח שתקבל.'});
});

app.get('/api/audit',auth,allow('admin'),async(_req,res)=>res.json((await q('SELECT a.*,u.name user_name FROM audit_log a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.created_at DESC LIMIT 100')).rows));

app.use((_req,res)=>res.sendFile(path.join(rootDir,'public/index.html')));

export { app, dbReady, pool };
export default app;
