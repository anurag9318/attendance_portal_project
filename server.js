require("dotenv").config();
const express = require("express");
const path = require("path");
const { app, connectDb } = require("./api/app");

const PORT = Number(process.env.PORT || 5000);

(async () => {
  await connectDb();
  app.listen(PORT, () => console.log(`Attendance Portal: http://localhost:${PORT}`));
})().catch(err => { console.error(err); process.exit(1); });
