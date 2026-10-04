# Student Attendance Portal — Vercel + MongoDB

This version is prepared for **Vercel deployment and multiple students using the portal at the same time**.

## Why JSON was replaced
The old `data/db.json` design is suitable only for one local server. Vercel functions are serverless and their local filesystem is not a shared persistent database. This version stores users, students, attendance, holidays and settings in **MongoDB Atlas**.

## Features retained
- Separate admin/student login
- Students can mark Present only
- One attendance submission per student per day
- Admin individual and bulk Present/Absent
- Open / Close / Reopen / Finalize
- Automatic 08:00–11:40 IST schedule
- Automatic finalization
- Today reset
- Today/future holiday management
- Saturday/Sunday permanent holidays
- Daily and monthly Excel reports
- Responsive existing frontend
- Shared cloud database for concurrent users

## 1. Create MongoDB Atlas database
Create a MongoDB Atlas cluster and a database user. Add your deployment's IP access rule. For easiest Vercel deployment, use `0.0.0.0/0` and protect the database with a strong username/password.

Copy the MongoDB connection string.

## 2. Environment variables
Create these in Vercel Project Settings → Environment Variables:

```text
MONGODB_URI=mongodb+srv://...
MONGODB_DB=attendance_portal
JWT_SECRET=use-a-long-random-secret
ATTENDANCE_OPEN_TIME=08:00
ATTENDANCE_CLOSE_TIME=11:40
AUTO_FINALIZE=true
COOKIE_SECURE=true
NODE_ENV=production
```

Do not commit `.env`.

## 3. Seed the database
From your local project folder:

```bash
npm install
npm run seed
```

Default demo accounts:
- Student: `st001` / `Student@123`

**Change/remove these demo credentials before real classroom use.**

If you already have data in the old `data/db.json`, configure `MONGODB_URI` locally and run:

```bash
npm run migrate
```

The migration keeps users, students, attendance and attendance settings.

## 4. Deploy to Vercel
Push this folder to GitHub, import it into Vercel, and add the environment variables above.

Build command: leave empty.
Install command: `npm install`.
Output directory: leave empty.

Vercel detects `api/index.js` as the serverless API and `vercel.json` routes `/api/*` to it. The existing HTML/CSS/JS files are served from `public`.

## 5. Important for many students
All students must use the **same deployed Vercel URL**. They do not need to be on the same Wi-Fi.

Example:
```text
https://your-attendance-portal.vercel.app
```

Each device logs into its own student account. Attendance is written to MongoDB, so students and the admin see the same shared data.

## 6. Automatic attendance schedule
The server evaluates the schedule whenever an API request arrives. This is intentional for Vercel: there is no permanent Node.js process or `setInterval` that must stay alive.

Default:
- Monday–Friday: opens at 08:00 IST
- closes at 11:40 IST
- automatic finalization at 11:40
- Saturday/Sunday: holiday

## 7. Production notes
- Use a strong `JWT_SECRET`.
- Use a strong MongoDB password.
- Change demo passwords.
- Keep MongoDB access restricted as much as practical.
- Vercel and MongoDB Atlas should be in stable production regions.
- For very large classes, add pagination/search to the admin student list.
- MongoDB has a unique `(student_id, attendance_date)` index, preventing duplicate attendance records when many users submit at once.

## Local run
```bash
npm install
# configure .env
npm run seed
npm start
```

Open:
```text
http://localhost:5000
```
