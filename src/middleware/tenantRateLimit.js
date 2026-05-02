/**
 * Per-tenant (agency-level) rate limit middleware.
 *
 * The existing `apiLimiter` in app.js limits per-user (300 req/min).
 * That doesn't stop a single tenant with 50 active users from collectively
 * sending 15,000 req/min and degrading the shared instance for other tenants.
 *
 * This middleware adds an additional bucket keyed by `agency_id`, decoded
 * from the JWT in the Authorization header. Anonymous requests (no JWT)
 * are skipped — the per-user/IP limiter already covers them.
 *
 * Tier hook: future work — read tenant's subscription tier from cache and
 * raise/lower the limit. For now, single default.
 */

const rateLimit = require("express-rate-limit");
const jwt = require("jsonwebtoken");

const DEFAULT_TENANT_PER_MIN = parseInt(process.env.TENANT_RATE_LIMIT_PER_MIN || "1500", 10);
const HEAVY_TENANT_PER_MIN = parseInt(process.env.TENANT_HEAVY_RATE_LIMIT_PER_MIN || "60", 10);

function decodeAgencyId(req) {
  try {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) return null;
    const decoded = jwt.decode(token);
    return decoded?.agency_id || null;
  } catch {
    return null;
  }
}

const tenantApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: DEFAULT_TENANT_PER_MIN,
  keyGenerator: (req) => decodeAgencyId(req) || `ip:${req.ip}`,
  skip: (req) => !decodeAgencyId(req),
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
  message: {
    error: "এই এজেন্সির জন্য অনেক বেশি রিকোয়েস্ট — কিছুক্ষণ পর চেষ্টা করুন",
    code: "TENANT_RATE_LIMIT",
  },
});

const tenantHeavyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: HEAVY_TENANT_PER_MIN,
  keyGenerator: (req) => decodeAgencyId(req) || `ip:${req.ip}`,
  skip: (req) => !decodeAgencyId(req),
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
  message: {
    error: "এই এজেন্সির জন্য heavy অপারেশনের সীমা — কিছুক্ষণ পর চেষ্টা করুন",
    code: "TENANT_HEAVY_RATE_LIMIT",
  },
});

module.exports = { tenantApiLimiter, tenantHeavyLimiter };
