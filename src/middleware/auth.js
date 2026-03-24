/**
 * auth.js — JWT Authentication Middleware
 *
 * প্রতিটি protected route-এ এই middleware ব্যবহার হয়।
 * - Request header থেকে "Bearer <token>" পড়ে
 * - JWT verify করে → req.user এ decoded payload বসায়
 * - Token না থাকলে বা invalid হলে 401 error দেয়
 *
 * req.user এ যা থাকে: { id, email, role, branch, agency_id }
 */

const jwt = require("jsonwebtoken");

module.exports = function authMiddleware(req, res, next) {
  // Header থেকে Authorization token বের করো
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Token প্রয়োজন" });
  }

  // "Bearer " অংশ বাদ দিয়ে শুধু token নাও
  const token = header.slice(7);

  try {
    // JWT verify — সফল হলে decoded payload req.user এ বসাও
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next(); // পরবর্তী handler-এ যাও
  } catch {
    return res.status(401).json({ error: "Token অবৈধ বা মেয়াদ শেষ" });
  }
};
