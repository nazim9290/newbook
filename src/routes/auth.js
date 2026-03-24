const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const supabase = require("../lib/supabase");

const router = express.Router();

// POST /api/auth/login
router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email ও password দিন" });

  const { data: user, error } = await supabase
    .from("users")
    .select("*")
    .eq("email", email.toLowerCase())
    .single();

  if (error || !user) return res.status(401).json({ error: "Email বা password ভুল" });

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: "Email বা password ভুল" });

  const token = jwt.sign(
    { id: user.id, email: user.email, role: user.role, branch: user.branch, agency_id: user.agency_id },
    process.env.JWT_SECRET,
    { expiresIn: "7d" }
  );

  res.json({
    token,
    user: { id: user.id, name: user.name, email: user.email, role: user.role, branch: user.branch, agency_id: user.agency_id }
  });
});

// POST /api/auth/register (admin only — create new staff account)
router.post("/register", async (req, res) => {
  const { name, email, password, role, branch } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: "নাম, email ও password দিন" });

  const hash = await bcrypt.hash(password, 10);

  const { data, error } = await supabase
    .from("users")
    .insert({ name, email: email.toLowerCase(), password_hash: hash, role: role || "counselor", branch })
    .select("id, name, email, role, branch")
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

module.exports = router;
