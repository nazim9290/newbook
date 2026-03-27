/**
 * auth.js — JWT Authentication Middleware
 *
 * Token ৩ জায়গা থেকে পড়ে (priority order):
 * 1. httpOnly cookie (agencybook_token) — সবচেয়ে নিরাপদ
 * 2. Authorization: Bearer <token> header — API client/mobile
 * 3. ❌ URL query param — কখনো না (log-এ leak হয়)
 *
 * req.user এ যা থাকে: { id, email, role, branch, agency_id }
 */

const jwt = require("jsonwebtoken");

module.exports = function authMiddleware(req, res, next) {
  let token = null;

  // ১. httpOnly cookie থেকে পড়ো (সবচেয়ে safe)
  if (req.cookies && req.cookies.agencybook_token) {
    token = req.cookies.agencybook_token;
  }

  // ২. Authorization header থেকে fallback (API client, mobile app)
  if (!token) {
    const header = req.headers.authorization;
    if (header && header.startsWith("Bearer ")) {
      token = header.slice(7);
    }
  }

  // Token না থাকলে 401
  if (!token) {
    return res.status(401).json({ error: "Token প্রয়োজন" });
  }

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Token অবৈধ বা মেয়াদ শেষ" });
  }
};
