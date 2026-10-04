require("dotenv").config();
const fs=require("fs"),path=require("path");
const {MongoClient,ObjectId}=require("mongodb");
const bcrypt=require("bcryptjs");
const uri=process.env.MONGODB_URI, dbName=process.env.MONGODB_DB||"attendance_portal";
if(!uri)throw new Error("MONGODB_URI is required.");
const file=path.join(__dirname,"..","data","db.json");
(async()=>{
 const raw=JSON.parse(fs.readFileSync(file,"utf8"));const client=new MongoClient(uri);await client.connect();const db=client.db(dbName);
 const userMap=new Map(),studentMap=new Map();
 for(const u of raw.users||[]){
  const old=String(u.id), doc={username:u.username,password_hash:u.password_hash,role:u.role,status:u.status,created_at:u.created_at||new Date().toISOString(),updated_at:u.updated_at||new Date().toISOString()};
  let found=await db.collection("users").findOne({username:u.username});
  if(!found) {const r=await db.collection("users").insertOne(doc);found={_id:r.insertedId};}
  userMap.set(old,found._id);
 }
 for(const s of raw.students||[]){
  const doc={user_id:userMap.get(String(s.user_id)),student_id:s.student_id,name:s.name,email:s.email||null,phone:s.phone||null,roll_number:s.roll_number||null,class_name:s.class_name||null,status:s.status||"active",created_at:s.created_at||new Date().toISOString(),updated_at:s.updated_at||new Date().toISOString()};
  let found=await db.collection("students").findOne({student_id:s.student_id});
  if(!found){const r=await db.collection("students").insertOne(doc);found={_id:r.insertedId};} else await db.collection("students").updateOne({_id:found._id},{$set:doc});
  studentMap.set(String(s.id),found._id);
 }
 for(const a of raw.attendance||[]){
  const sid=studentMap.get(String(a.student_id));if(!sid)continue;
  await db.collection("attendance").updateOne({student_id:sid,attendance_date:a.attendance_date},{$set:{student_id:sid,attendance_date:a.attendance_date,status:a.status,marked_at:a.marked_at||null,marked_by:userMap.get(String(a.marked_by))||null,finalized:a.finalized||0,finalized_at:a.finalized_at||null,finalized_by:userMap.get(String(a.finalized_by))||null}}, {upsert:true});
 }
 for(const st of raw.attendance_settings||[]){
  await db.collection("attendance_settings").updateOne({attendance_date:st.attendance_date},{$set:{attendance_date:st.attendance_date,is_open:st.is_open||0,is_finalized:st.is_finalized||0,opened_at:st.opened_at||null,closed_at:st.closed_at||null,finalized_at:st.finalized_at||null,opened_by:userMap.get(String(st.opened_by))||null,closed_by:userMap.get(String(st.closed_by))||null,finalized_by:userMap.get(String(st.finalized_by))||null,is_holiday:st.is_holiday||0,holiday_reason:st.holiday_reason||null,holiday_announced_at:st.holiday_announced_at||null,holiday_announced_by:userMap.get(String(st.holiday_announced_by))||null,control_mode:st.control_mode||"auto"}},{upsert:true});
 }
 console.log("JSON data migrated to MongoDB.");await client.close();
})().catch(e=>{console.error(e);process.exit(1)});
