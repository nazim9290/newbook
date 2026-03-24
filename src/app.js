require("dotenv").config();
const express = require("express");
const cors = require("cors");

const app = express();

// Middleware
app.use(cors({ origin: process.env.CLIENT_URL || "http://localhost:5173" }));
app.use(express.json());

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Routes
app.use("/api/auth", require("./routes/auth"));
app.use("/api/students", require("./routes/students"));
app.use("/api/visitors", require("./routes/visitors"));
app.use("/api/attendance", require("./routes/attendance"));
app.use("/api/accounts", require("./routes/accounts"));
app.use("/api/schools", require("./routes/schools"));
app.use("/api/batches", require("./routes/batches"));
app.use("/api/documents", require("./routes/documents"));
app.use("/api/hr", require("./routes/hr"));
app.use("/api/tasks", require("./routes/tasks"));
app.use("/api/excel", require("./routes/excel"));

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
});

// Error handler
app.use((err, req, res, next) => {
  console.error("Server error:", err);
  res.status(500).json({ error: "Internal server error" });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`AgencyOS API running on http://localhost:${PORT}`);
});
