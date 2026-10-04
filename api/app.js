require("dotenv").config();

const express = require("express");
const path = require("path");
const cookieParser = require("cookie-parser");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const ExcelJS = require("exceljs");
const { MongoClient, ObjectId } = require("mongodb");

const app = express();

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB || "attendance_portal";
const JWT_SECRET = process.env.JWT_SECRET;
const ATTENDANCE_OPEN_TIME = process.env.ATTENDANCE_OPEN_TIME || "08:00";
const ATTENDANCE_CLOSE_TIME = process.env.ATTENDANCE_CLOSE_TIME || "11:40";
const AUTO_FINALIZE = String(process.env.AUTO_FINALIZE ?? "true").toLowerCase() === "true";
const COOKIE_SECURE = String(process.env.COOKIE_SECURE ?? "true").toLowerCase() === "true";

if (!MONGODB_URI) console.warn("MONGODB_URI is not set. Add it to Vercel/local environment variables.");
if (!JWT_SECRET) console.warn("JWT_SECRET is not set. Login requests will fail until it is configured.");

let clientPromise;
let dbPromise;

async function connectDb() {
  if (!MONGODB_URI) throw new Error("MONGODB_URI is required.");
  if (!JWT_SECRET) throw new Error("JWT_SECRET is required.");
  if (!clientPromise) {
    const client = new MongoClient(MONGODB_URI, {
      maxPoolSize: Number(process.env.MONGO_MAX_POOL_SIZE || 10),
      minPoolSize: 0,
      serverSelectionTimeoutMS: 10000
    });
    clientPromise = client.connect();
  }
  if (!dbPromise) dbPromise = clientPromise.then(client => client.db(MONGODB_DB));
  return dbPromise;
}
async function getDb() { return dbPromise || connectDb(); }

function oid(id) {
  try { return new ObjectId(String(id)); } catch { return null; }
}
function nowIso() { return new Date().toISOString(); }
function todayIndia() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
}
function istNowParts() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit", weekday: "short"
  }).formatToParts(new Date());
  const get = t => parts.find(p => p.type === t)?.value;
  return { date:`${get("year")}-${get("month")}-${get("day")}`, hour:Number(get("hour")), minute:Number(get("minute")), weekday:get("weekday") };
}
function minutes(hhmm) { const [h,m] = String(hhmm).split(":").map(Number); return h*60+m; }
function todayMinutes() { const x=istNowParts(); return x.hour*60+x.minute; }
function isWeekend(date) { const d=new Date(`${date}T00:00:00Z`).getUTCDay(); return d===0 || d===6; }

function publicStudent(student,user) {
  return {
    id:String(student._id), user_id:String(student.user_id), student_id:student.student_id,
    name:student.name,email:student.email,phone:student.phone,roll_number:student.roll_number,
    class_name:student.class_name,status:student.status,username:user?.username||null
  };
}
async function findUser(db,id) { return db.collection("users").findOne({_id:oid(id)}); }
async function findStudentByUser(db,userId) { return db.collection("students").findOne({user_id:oid(userId)}); }
async function attendanceFor(db,studentId,date) {
  return db.collection("attendance").findOne({student_id:oid(studentId),attendance_date:date});
}

async function ensureIndexes(db) {
  if (db._indexesReady) return;
  await Promise.all([
    db.collection("users").createIndex({username:1},{unique:true}),
    db.collection("students").createIndex({student_id:1},{unique:true}),
    db.collection("students").createIndex({user_id:1},{unique:true}),
    db.collection("attendance").createIndex({student_id:1,attendance_date:1},{unique:true}),
    db.collection("attendance_settings").createIndex({attendance_date:1},{unique:true})
  ]);
  db._indexesReady = true;
}

async function getSetting(db,date=todayIndia()) {
  const c=db.collection("attendance_settings");
  let st=await c.findOne({attendance_date:date});
  if (!st) {
    const doc={attendance_date:date,is_open:0,is_finalized:0,opened_at:null,closed_at:null,finalized_at:null,
      opened_by:null,closed_by:null,finalized_by:null,is_holiday:0,holiday_reason:null,
      holiday_announced_at:null,holiday_announced_by:null,control_mode:"auto"};
    try { await c.insertOne(doc); st=doc; }
    catch(e) { if(e.code===11000) st=await c.findOne({attendance_date:date}); else throw e; }
  }
  st=await applyAutomaticSchedule(db,st,date);
  return st;
}

async function applyAutomaticSchedule(db,st,date) {
  const c=db.collection("attendance_settings");
  if (isWeekend(date)) {
    if (!st.is_holiday || st.is_open) {
      await c.updateOne({_id:st._id},{$set:{is_holiday:1,holiday_reason:st.holiday_reason||"Weekend (Saturday/Sunday)",is_open:0}});
      st={...st,is_holiday:1,is_open:0,holiday_reason:st.holiday_reason||"Weekend (Saturday/Sunday)"};
    }
    return st;
  }
  if (st.is_holiday || st.is_finalized || st.control_mode !== "auto" || date !== todayIndia()) return st;
  const now=todayMinutes(), openAt=minutes(ATTENDANCE_OPEN_TIME), closeAt=minutes(ATTENDANCE_CLOSE_TIME);
  const set={};
  if(now>=openAt && now<closeAt) {
    set.is_open=1;
    if(!st.opened_at) set.opened_at=nowIso();
  } else if(now>=closeAt) {
    set.is_open=0;
    if(!st.closed_at) set.closed_at=nowIso();
    if(AUTO_FINALIZE) {
      set.is_finalized=1;
      if(!st.finalized_at) set.finalized_at=nowIso();
      const stamp=set.finalized_at;
      await db.collection("attendance").updateMany({attendance_date:date},{$set:{finalized:1,finalized_at:stamp}});
    }
  } else set.is_open=0;
  if(Object.keys(set).length) {
    await c.updateOne({_id:st._id},{$set:set});
    st={...st,...set};
  }
  return st;
}

function auth(req,res,next) {
  const token=req.cookies.token || (req.headers.authorization||"").replace("Bearer ","");
  if(!token) return res.status(401).json({message:"Authentication required."});
  try { req.user=jwt.verify(token,JWT_SECRET); next(); }
  catch { return res.status(401).json({message:"Invalid or expired session."}); }
}
function role(name) {
  return (req,res,next)=>req.user?.role===name?next():res.status(403).json({message:`${name} access required.`});
}
function issue(res,user) {
  res.cookie("token",jwt.sign(user,JWT_SECRET,{expiresIn:"8h"}),{
    httpOnly:true, sameSite:"lax", secure:COOKIE_SECURE, maxAge:8*60*60*1000,
    path:"/"
  });
}
function validDate(date) { return /^\d{4}-\d{2}-\d{2}$/.test(String(date)); }

async function upsertAttendance(db,studentId,date,status,markedBy) {
  const stamp=nowIso();
  const studentOid=oid(studentId);
  const result=await db.collection("attendance").findOneAndUpdate(
    {student_id:studentOid,attendance_date:date},
    {$set:{status,marked_at:stamp,marked_by:oid(markedBy),finalized:0,finalized_at:null,finalized_by:null},
     $setOnInsert:{student_id:studentOid,attendance_date:date}},
    {upsert:true,returnDocument:"after"}
  );
  return result;
}

app.use(helmet({contentSecurityPolicy:false}));
app.use(express.json({limit:"1mb"}));
app.use(express.urlencoded({extended:true}));
app.use(cookieParser());

const loginLimit=rateLimit({windowMs:15*60*1000,max:50,standardHeaders:true,legacyHeaders:false});
app.use("/api/auth",loginLimit);

app.post("/api/auth/:role/login",async(req,res,next)=>{
  try {
    const roleName=req.params.role;
    if(!["admin","student"].includes(roleName)) return res.status(404).json({message:"Invalid login type."});
    const {username,password}=req.body||{};
    const db=await getDb(); await ensureIndexes(db);
    const user=await db.collection("users").findOne({username:String(username||"").trim(),role:roleName});
    if(!user || user.status!=="active" || !(await bcrypt.compare(String(password||""),user.password_hash)))
      return res.status(401).json({message:"Invalid credentials."});
    issue(res,{id:String(user._id),username:user.username,role:user.role});
    res.json({message:"Login successful.",user:{id:String(user._id),username:user.username,role:user.role}});
  } catch(e){next(e);}
});

app.post("/api/auth/logout",(req,res)=>{res.clearCookie("token",{path:"/"});res.json({message:"Logged out."});});

app.get("/api/auth/me",auth,async(req,res,next)=>{
  try {
    const db=await getDb();
    if(req.user.role==="student"){
      const student=await findStudentByUser(db,req.user.id);
      if(!student)return res.status(404).json({message:"Student profile not found."});
      const user=await findUser(db,req.user.id);
      return res.json({user:publicStudent(student,user)});
    }
    res.json({user:req.user});
  } catch(e){next(e);}
});

app.get("/api/attendance/settings",auth,async(req,res,next)=>{
  try {
    const db=await getDb(); const date=req.query.date||todayIndia(); const settings=await getSetting(db,date);
    res.json({settings,schedule:{open:ATTENDANCE_OPEN_TIME,close:ATTENDANCE_CLOSE_TIME,autoFinalize:AUTO_FINALIZE,weekendHoliday:true}});
  } catch(e){next(e);}
});

app.get("/api/attendance/today",auth,role("admin"),async(req,res,next)=>{
  try {
    const db=await getDb(),date=todayIndia(),st=await getSetting(db,date);
    const students=await db.collection("students").find({status:"active"}).sort({name:1}).toArray();
    const ids=students.map(s=>s._id);
    const ats=ids.length?await db.collection("attendance").find({attendance_date:date,student_id:{$in:ids}}).toArray():[];
    const map=new Map(ats.map(a=>[String(a.student_id),a]));
    const rows=students.map(s=>{const a=map.get(String(s._id));return{id:String(s._id),student_id:s.student_id,name:s.name,roll_number:s.roll_number,class_name:s.class_name,status:a?.status||"Not Marked",marked_at:a?.marked_at||null};});
    const total=rows.length,present=rows.filter(s=>s.status==="Present").length,absent=rows.filter(s=>s.status==="Absent").length;
    res.json({date,settings:st,students:rows,stats:{total,present,absent}});
  } catch(e){next(e);}
});

app.post("/api/attendance/mark",auth,async(req,res,next)=>{
  try {
    const db=await getDb(),date=todayIndia(),st=await getSetting(db,date),status=req.body?.status;
    if(!["Present","Absent"].includes(status))return res.status(400).json({message:"Invalid status."});
    if(isWeekend(date))return res.status(409).json({message:"Saturday and Sunday are holidays. Attendance cannot be marked."});
    if(st.is_holiday)return res.status(409).json({message:st.holiday_reason?`Today is a holiday: ${st.holiday_reason}`:"Today has been declared a holiday."});
    if(st.is_finalized)return res.status(409).json({message:"Attendance is finalized and locked."});
    if(req.user.role==="student" && status!=="Present")return res.status(403).json({message:"Students can only mark Present."});
    if(req.user.role==="student" && !st.is_open)return res.status(409).json({message:"Student attendance is currently closed."});
    let studentId=req.body?.studentId;
    if(req.user.role==="student") {
      const student=await findStudentByUser(db,req.user.id);
      if(!student||student.status!=="active")return res.status(404).json({message:"Student profile not found."});
      studentId=String(student._id);
      const existing=await attendanceFor(db,studentId,date);
      if(existing)return res.status(409).json({message:"Your attendance is already marked and cannot be changed."});
    }
    const soid=oid(studentId);
    if(!soid)return res.status(400).json({message:"Valid student ID is required."});
    const student=await db.collection("students").findOne({_id:soid,status:"active"});
    if(!student)return res.status(404).json({message:"Student not found."});
    await upsertAttendance(db,studentId,date,status,req.user.id);
    res.json({message:"Attendance saved.",date,status});
  } catch(e){next(e);}
});

app.post("/api/attendance/mark-all",auth,role("admin"),async(req,res,next)=>{
  try {
    const db=await getDb(),date=todayIndia(),st=await getSetting(db,date),status=req.body?.status;
    if(!["Present","Absent"].includes(status))return res.status(400).json({message:"Invalid status."});
    if(isWeekend(date))return res.status(409).json({message:"Saturday and Sunday are holidays. Attendance cannot be marked."});
    if(st.is_holiday)return res.status(409).json({message:"Today is declared a holiday. Attendance cannot be marked."});
    if(st.is_finalized)return res.status(409).json({message:"Attendance is finalized and locked."});
    const students=await db.collection("students").find({status:"active"},{projection:{_id:1}}).toArray();
    const stamp=nowIso();
    if(students.length) {
      await db.collection("attendance").bulkWrite(students.map(s=>({
        updateOne:{filter:{student_id:s._id,attendance_date:date},
          update:{$set:{status,marked_at:stamp,marked_by:oid(req.user.id),finalized:0,finalized_at:null,finalized_by:null},
                 $setOnInsert:{student_id:s._id,attendance_date:date}},upsert:true}
      })),{ordered:false});
    }
    res.json({message:`All students marked ${status}.`,count:students.length});
  } catch(e){next(e);}
});

app.post("/api/attendance/holiday",auth,role("admin"),async(req,res,next)=>{
  try {
    const db=await getDb(),date=String(req.body?.date||todayIndia()),reason=String(req.body?.reason||"Holiday").trim().slice(0,200)||"Holiday",today=todayIndia();
    if(!validDate(date))return res.status(400).json({message:"Invalid holiday date."});
    if(date<today)return res.status(400).json({message:"Holiday date cannot be in the past."});
    const st=await getSetting(db,date);
    if(st.is_finalized&&date===today)return res.status(409).json({message:"Today's attendance is finalized and locked."});
    const values={is_holiday:1,holiday_reason:isWeekend(date)?"Weekend (Saturday/Sunday)":reason,holiday_announced_at:nowIso(),holiday_announced_by:oid(req.user.id),is_open:0,control_mode:"manual_closed"};
    if(date===today){values.closed_at=nowIso();values.closed_by=oid(req.user.id);}
    await db.collection("attendance_settings").updateOne({_id:st._id},{$set:values});
    const updated=await db.collection("attendance_settings").findOne({_id:st._id});
    res.json({message:date===today?"Today has been declared a holiday.":`Holiday scheduled for ${date}.`,settings:updated});
  } catch(e){next(e);}
});

app.get("/api/attendance/holidays",auth,role("admin"),async(req,res,next)=>{
  try {
    const db=await getDb(),from=String(req.query.from||todayIndia());
    const docs=await db.collection("attendance_settings").find({is_holiday:1,attendance_date:{$gte:from}}).sort({attendance_date:1}).toArray();
    res.json({holidays:docs.map(s=>({date:s.attendance_date,reason:s.holiday_reason||"Holiday",weekend:isWeekend(s.attendance_date)}))});
  } catch(e){next(e);}
});

app.post("/api/attendance/remove-holiday",auth,role("admin"),async(req,res,next)=>{
  try {
    const db=await getDb(),date=String(req.body?.date||todayIndia()),st=await getSetting(db,date);
    if(isWeekend(date))return res.status(409).json({message:"Saturday and Sunday are permanent holidays and cannot be removed."});
    const values={is_holiday:0,holiday_reason:null,holiday_announced_at:null,holiday_announced_by:null,control_mode:"auto"};
    await db.collection("attendance_settings").updateOne({_id:st._id},{$set:values});
    let updated=await db.collection("attendance_settings").findOne({_id:st._id});
    if(date===todayIndia())updated=await applyAutomaticSchedule(db,updated,date);
    res.json({message:"Holiday declaration removed.",settings:updated});
  } catch(e){next(e);}
});

app.post("/api/attendance/reset",auth,role("admin"),async(req,res,next)=>{
  try {
    const db=await getDb(),date=todayIndia(),st=await getSetting(db,date),stamp=nowIso();
    await db.collection("attendance").deleteMany({attendance_date:date});
    await db.collection("attendance_settings").updateOne({_id:st._id},{$set:{
      is_open:1,control_mode:"manual_open",is_finalized:0,opened_at:stamp,opened_by:oid(req.user.id),
      closed_at:null,closed_by:null,finalized_at:null,finalized_by:null,is_holiday:0,holiday_reason:null,
      holiday_announced_at:null,holiday_announced_by:null
    }});
    const updated=await db.collection("attendance_settings").findOne({_id:st._id});
    res.json({message:"Today's attendance has been reset and the student portal is open again.",settings:updated});
  } catch(e){next(e);}
});

async function settingAction(req,res,action) {
  const db=await getDb(),date=todayIndia(),st=await getSetting(db,date),stamp=nowIso(),set={};
  if(action==="open") {
    if(st.is_holiday)return res.status(409).json({message:"Today is a holiday. Remove the holiday declaration before opening attendance."});
    set.is_open=1;set.control_mode="manual_open";set.opened_at=stamp;set.opened_by=oid(req.user.id);
  }
  if(action==="close") {set.is_open=0;set.control_mode="manual_closed";set.closed_at=stamp;set.closed_by=oid(req.user.id);}
  if(action==="finalize") {
    set.is_open=0;set.control_mode="manual_closed";set.is_finalized=1;set.finalized_at=stamp;set.finalized_by=oid(req.user.id);
    await db.collection("attendance").updateMany({attendance_date:date},{$set:{finalized:1,finalized_at:stamp,finalized_by:oid(req.user.id)}});
  }
  if(action==="reopen") {
    if(st.is_holiday)return res.status(409).json({message:"Today is a holiday. Remove the holiday declaration before reopening attendance."});
    set.is_open=1;set.control_mode="manual_open";set.is_finalized=0;set.finalized_at=null;set.finalized_by=null;
    await db.collection("attendance").updateMany({attendance_date:date},{$set:{finalized:0,finalized_at:null,finalized_by:null}});
  }
  await db.collection("attendance_settings").updateOne({_id:st._id},{$set:set});
  const updated=await db.collection("attendance_settings").findOne({_id:st._id});
  res.json({message:`Attendance ${action} completed.`,settings:updated});
}
for(const action of ["open","close","finalize","reopen"])
  app.post(`/api/attendance/${action}`,auth,role("admin"),(req,res,next)=>settingAction(req,res,action).catch(next));

app.get("/api/attendance/my-history",auth,role("student"),async(req,res,next)=>{
  try {
    const db=await getDb(),student=await findStudentByUser(db,req.user.id);
    if(!student)return res.status(404).json({message:"Student profile not found."});
    const history=await db.collection("attendance").find({student_id:student._id}).sort({attendance_date:-1}).limit(366).toArray();
    const clean=history.map(a=>({attendance_date:a.attendance_date,status:a.status,marked_at:a.marked_at}));
    const total=clean.length,present=clean.filter(a=>a.status==="Present").length,absent=clean.filter(a=>a.status==="Absent").length;
    res.json({history:clean,stats:{total,present,absent}});
  } catch(e){next(e);}
});

app.get("/api/students",auth,role("admin"),async(req,res,next)=>{
  try {
    const db=await getDb(),students=await db.collection("students").find({}).sort({name:1}).toArray();
    const userIds=students.map(s=>s.user_id);
    const users=userIds.length?await db.collection("users").find({_id:{$in:userIds}}).toArray():[];
    const um=new Map(users.map(u=>[String(u._id),u]));
    res.json({students:students.map(s=>publicStudent(s,um.get(String(s.user_id))))});
  } catch(e){next(e);}
});

app.post("/api/students",auth,role("admin"),async(req,res,next)=>{
  try {
    const db=await getDb(); const {studentId,name,email,phone,rollNumber,className,username,password}=req.body||{};
    if(!studentId||!name||!username||!password)return res.status(400).json({message:"Student ID, name, username and password are required."});
    const sid=String(studentId).trim(),uname=String(username).trim();
    const [sameSid,sameUser]=await Promise.all([
      db.collection("students").findOne({student_id:{$regex:`^${sid.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}$`,$options:"i"}}),
      db.collection("users").findOne({username:uname})
    ]);
    if(sameSid)return res.status(409).json({message:"Student ID already exists."});
    if(sameUser)return res.status(409).json({message:"Username already exists."});
    const hash=await bcrypt.hash(String(password),12),now=nowIso();
    const userDoc={username:uname,password_hash:hash,role:"student",status:"active",created_at:now,updated_at:now};
    const userResult=await db.collection("users").insertOne(userDoc);
    const studentDoc={user_id:userResult.insertedId,student_id:sid,name:String(name).trim(),email:email||null,phone:phone||null,
      roll_number:rollNumber||null,class_name:className||null,status:"active",created_at:now,updated_at:now};
    try { await db.collection("students").insertOne(studentDoc); }
    catch(e){await db.collection("users").deleteOne({_id:userResult.insertedId}); if(e.code===11000)return res.status(409).json({message:"Student ID already exists."}); throw e;}
    res.status(201).json({message:"Student created.",studentId:String(studentDoc._id)});
  } catch(e){next(e);}
});

app.delete("/api/students/:id",auth,role("admin"),async(req,res,next)=>{
  try {
    const db=await getDb(),student=await db.collection("students").findOne({_id:oid(req.params.id)});
    if(!student)return res.status(404).json({message:"Student not found."});
    const now=nowIso();
    await db.collection("students").updateOne({_id:student._id},{$set:{status:"inactive",updated_at:now}});
    await db.collection("users").updateOne({_id:student.user_id},{$set:{status:"inactive",updated_at:now}});
    res.json({message:"Student deactivated."});
  } catch(e){next(e);}
});

async function dailyRows(db,date) {
  const students=await db.collection("students").find({status:"active"}).sort({name:1}).toArray();
  const ids=students.map(s=>s._id);
  const ats=ids.length?await db.collection("attendance").find({attendance_date:date,student_id:{$in:ids}}).toArray():[];
  const map=new Map(ats.map(a=>[String(a.student_id),a]));
  return students.map(s=>{const a=map.get(String(s._id));return{
    student_id:s.student_id,name:s.name,roll_number:s.roll_number,class_name:s.class_name,
    attendance_date:date,attendance_status:a?.status||"Not Marked",marked_at:a?.marked_at||null
  };});
}

app.get("/api/reports/daily",auth,role("admin"),async(req,res,next)=>{
  try {const db=await getDb(),date=String(req.query.date||todayIndia());res.json({date,rows:await dailyRows(db,date)});}
  catch(e){next(e);}
});
app.get("/api/reports/monthly",auth,role("admin"),async(req,res,next)=>{
  try {
    const db=await getDb(),month=String(req.query.month||todayIndia().slice(0,7));
    const students=await db.collection("students").find({status:"active"}).sort({name:1}).toArray();
    const ids=students.map(s=>s._id);
    const ats=ids.length?await db.collection("attendance").find({attendance_date:{$regex:`^${month}-`},student_id:{$in:ids}}).toArray():[];
    const sm=new Map(students.map(s=>[String(s._id),s]));
    const rows=ats.map(a=>{const s=sm.get(String(a.student_id));return{student_id:s.student_id,name:s.name,roll_number:s.roll_number,class_name:s.class_name,attendance_date:a.attendance_date,status:a.status};})
      .sort((a,b)=>a.name.localeCompare(b.name)||a.attendance_date.localeCompare(b.attendance_date));
    res.json({month,rows});
  } catch(e){next(e);}
});

app.get("/api/reports/daily/excel",auth,role("admin"),async(req,res,next)=>{
  try {
    const db=await getDb(),date=String(req.query.date||todayIndia()),rows=await dailyRows(db,date);
    const wb=new ExcelJS.Workbook(),ws=wb.addWorksheet("Daily Attendance");
    ws.columns=[
      {header:"Student ID",key:"student_id",width:16},{header:"Student Name",key:"name",width:28},
      {header:"Roll Number",key:"roll_number",width:16},{header:"Class",key:"class_name",width:18},
      {header:"Date",key:"attendance_date",width:15},{header:"Status",key:"attendance_status",width:18},{header:"Marked At",key:"marked_at",width:24}
    ];
    ws.addRows(rows);ws.getRow(1).font={bold:true};ws.autoFilter="A1:G1";
    res.setHeader("Content-Type","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition",`attachment; filename="attendance_${date}.xlsx"`);
    await wb.xlsx.write(res);res.end();
  } catch(e){next(e);}
});

app.get("/api/reports/monthly/excel",auth,role("admin"),async(req,res,next)=>{
  try {
    const db=await getDb(),month=String(req.query.month||todayIndia().slice(0,7));
    const year=Number(month.slice(0,4)),m=Number(month.slice(5,7)),totalDays=new Date(Date.UTC(year,m,0)).getUTCDate();
    const students=await db.collection("students").find({status:"active"}).sort({name:1}).toArray(),ids=students.map(s=>s._id);
    const ats=ids.length?await db.collection("attendance").find({attendance_date:{$regex:`^${month}-`},student_id:{$in:ids}}).toArray():[];
    const map=new Map(ats.map(a=>[`${a.student_id}-${Number(a.attendance_date.slice(8,10))}`,a.status]));
    const wb=new ExcelJS.Workbook(),ws=wb.addWorksheet("Monthly Attendance");
    const cols=[{header:"Student ID",key:"student_id",width:15},{header:"Student Name",key:"name",width:28},{header:"Roll No",key:"roll_number",width:14}];
    for(let d=1;d<=totalDays;d++)cols.push({header:String(d).padStart(2,"0"),key:`d${d}`,width:6});
    cols.push({header:"Present",key:"present",width:10},{header:"Absent",key:"absent",width:10},{header:"Percentage",key:"percentage",width:13});ws.columns=cols;
    for(const s of students){
      const row={student_id:s.student_id,name:s.name,roll_number:s.roll_number};let p=0,a=0;
      for(let d=1;d<=totalDays;d++){const v=map.get(`${s._id}-${d}`)||"-";row[`d${d}`]=v==="Present"?"P":v==="Absent"?"A":"-";if(v==="Present")p++;if(v==="Absent")a++;}
      row.present=p;row.absent=a;row.percentage=(p+a?((p/(p+a))*100).toFixed(2):"0.00")+"%";ws.addRow(row);
    }
    ws.getRow(1).font={bold:true};ws.views=[{state:"frozen",xSplit:3,ySplit:1}];
    res.setHeader("Content-Type","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition",`attachment; filename="attendance_${month}.xlsx"`);
    await wb.xlsx.write(res);res.end();
  } catch(e){next(e);}
});

// Serve the existing frontend in local development. Vercel serves /public via vercel.json.
app.use(express.static(path.join(__dirname,"..","public")));
app.get("/",(req,res)=>res.sendFile(path.join(__dirname,"..","public","index.html")));

app.use((err,req,res,next)=>{
  console.error(err);
  if(res.headersSent)return next(err);
  const msg=process.env.NODE_ENV==="development"?err.message:"Server error.";
  res.status(500).json({message:msg});
});

module.exports={app,connectDb};
