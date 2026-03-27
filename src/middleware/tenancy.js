/**
 * tenancy.js — Multi-tenancy middleware
 *
 * প্রতিটি request-এ agency_id enforce করে:
 * - req.user.agency_id থেকে নেয় (JWT-তে আছে)
 * - req.agencyId হিসেবে set করে
 * - Super Admin check: role === "super_admin" হলে all agency access
 */

module.exports = function tenancy(req, res, next) {
  // Super admin সব agency দেখতে পারে
  if (req.user && req.user.role === "super_admin") {
    req.agencyId = req.query._agency_id || req.user.agency_id || null;
    req.isSuperAdmin = true;
    return next();
  }

  // Normal user — must have agency_id
  const agencyId = req.user?.agency_id;
  if (!agencyId) {
    return res.status(403).json({ error: "Agency নির্ধারিত নেই" });
  }
  req.agencyId = agencyId;
  req.isSuperAdmin = false;
  next();
};
