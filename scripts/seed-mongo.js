require("dotenv").config();
const { MongoClient } = require("mongodb");
const bcrypt = require("bcryptjs");

const uri=process.env.MONGODB_URI;
const dbName=process.env.MONGODB_DB||"attendance_portal";
if(!uri) throw new Error("MONGODB_URI is required.");

(async()=>{
 const client=new MongoClient(uri); await client.connect(); const db=client.db(dbName);
 await Promise.all([
  db.collection("users").createIndex({username:1},{unique:true}),
  db.collection("students").createIndex({student_id:1},{unique:true}),
  db.collection("students").createIndex({user_id:1},{unique:true}),
  db.collection("attendance").createIndex({student_id:1,attendance_date:1},{unique:true}),
  db.collection("attendance_settings").createIndex({attendance_date:1},{unique:true})
 ]);
 const adminPass=await bcrypt.hash("Admin@123",12);
 await db.collection("users").updateOne({username:"admin"},{$set:{username:"admin",password_hash:adminPass,role:"admin",status:"active",updated_at:new Date().toISOString()},$setOnInsert:{created_at:new Date().toISOString()}},{upsert:true});
 const sample=[
 ["ST001","Rahul Kumar","rahul@example.com","9000000001","1","BCA"],["ST002","Amit Singh","amit@example.com","9000000002","2","BCA"],
 ["ST003","Ravi Sharma","ravi@example.com","9000000003","3","BCA"],["ST004","Priya Verma","priya@example.com","9000000004","4","BCA"],
 ["ST005","Neha Gupta","neha@example.com","9000000005","5","BCA"],["ST006","Anjali Yadav","anjali@example.com","9000000006","6","BCA"],
 ["ST007","Vikas Kumar","vikas@example.com","9000000007","7","BCA"],["ST008","Pooja Singh","pooja@example.com","9000000008","8","BCA"],
 ["ST009","Mohit Raj","mohit@example.com","9000000009","9","BCA"],["ST010","Sneha Sharma","sneha@example.com","9000000010","10","BCA"]];
 const hash=await bcrypt.hash("Student@123",12);
 for(const [sid,name,email,phone,roll,cls] of sample){
  let u=await db.collection("users").findOne({username:sid.toLowerCase()});
  if(!u){const r=await db.collection("users").insertOne({username:sid.toLowerCase(),password_hash:hash,role:"student",status:"active",created_at:new Date().toISOString(),updated_at:new Date().toISOString()});u={_id:r.insertedId};}
  await db.collection("students").updateOne({student_id:sid},{$set:{user_id:u._id,student_id:sid,name,email,phone,roll_number:roll,class_name:cls,status:"active",updated_at:new Date().toISOString()},$setOnInsert:{created_at:new Date().toISOString()}},{upsert:true});
 }
 console.log("MongoDB seed complete."); console.log("Admin: admin / Admin@123"); console.log("Student: st001 / Student@123");
 await client.close();
})().catch(e=>{console.error(e);process.exit(1)});
