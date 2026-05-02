/**
 * agencyNavGuard.js — per-agency nav-item enforcement.
 *
 * Each agency owner can disable nav items in Settings (stored in
 * agency_settings.disabled_nav_items). This middleware blocks API calls
 * to disabled modules so URL-typing doesn't bypass the sidebar hide.
 *
 * How it works:
 *   1. Inspect req.path → look up nav-key via NAV_TO_PATH_PREFIX
 *   2. If no match (e.g. /api/auth, /api/health) → next() — never gated
 *   3. If user not authed yet → next() — auth middleware handles 401
 *   4. Read agency's disabled list from cache (DB on first miss)
 *   5. If nav-key in disabled list → 403 with MODULE_DISABLED code
 *
 * ESSENTIAL pages — never block these even if accidentally added to
 * disabled_nav_items (admin must always be able to fix their own
 * setting; users always need profile/help):
 *   dashboard, profile, settings, help, super-admin
 *
 * Cache TTL: 60s. Invalidate explicitly when settings change via
 * `invalidateAgencyNav(agencyId)`.
 */

const { pool } = require("../lib/db");
const jwt = require("jsonwebtoken");

// Decode the JWT *without verifying* (cheap; auth middleware will verify
// downstream). We only need agency_id to check the disabled list.
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

const CACHE_TTL_MS = 60 * 1000;
const cache = new Map(); // agencyId → { disabled: Set<string>, ts: number }

const ESSENTIAL = new Set([
  "dashboard", "profile", "settings", "help", "super-admin",
]);

// Map URL prefix → sidebar nav-key. Order matters for longer-prefix-first
// matching (sorted at module load).
const NAV_TO_PATH_PREFIX = {
  visitors:           ["/api/visitors"],
  students:           ["/api/students"],
  course:             ["/api/batches"],
  attendance:         ["/api/attendance"],
  departure:          ["/api/pre-departure"],
  alumni:             ["/api/alumni"],
  documents:          ["/api/documents", "/api/pdfTemplates"],
  excel:              ["/api/excel"],
  schools:            ["/api/schools"],
  agents:             ["/api/agents"],
  partners:           ["/api/partners"],
  calendar:           ["/api/calendar", "/api/holidays"],
  tasks:              ["/api/tasks"],
  communication:      ["/api/communications"],
  inventory:          ["/api/inventory"],
  accounts:           ["/api/accounts", "/api/billing"],
  hr:                 ["/api/hr"],
  reports:            ["/api/reports"],
  "owner-analytics":  ["/api/owner-analytics"],
  forecast:           ["/api/forecast"],
  reviews:            ["/api/feedback"],
  broadcast:          ["/api/broadcasts"],
  "ai-assistant":     ["/api/ai-assistant"],
  "lead-scoring":     ["/api/lead-scoring"],
  webhooks:           ["/api/webhooks"],
  "audit-log":        ["/api/audit-search"],
  import:             ["/api/onboarding"],
  "data-export":      ["/api/data-export", "/api/exit"],
  "api-keys":         ["/api/api-keys"],
  "outbound-webhooks":["/api/outbound-webhooks"],
  "bot-knowledge":    ["/api/help-bot"],
  "operator-console": ["/api/ops"],
};

// Build a flat list of [prefix, navKey] sorted longest-first so /api/api-keys
// doesn't accidentally match /api before /api-keys.
const PREFIX_INDEX = (() => {
  const flat = [];
  for (const [navKey, prefixes] of Object.entries(NAV_TO_PATH_PREFIX)) {
    for (const p of prefixes) flat.push([p, navKey]);
  }
  flat.sort((a, b) => b[0].length - a[0].length);
  return flat;
})();

function pathToNavKey(path) {
  for (const [prefix, navKey] of PREFIX_INDEX) {
    if (path === prefix || path.startsWith(prefix + "/")) return navKey;
  }
  return null;
}

async function getDisabledForAgency(agencyId) {
  const cached = cache.get(agencyId);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.disabled;
  try {
    const r = await pool.query(
      "SELECT disabled_nav_items FROM agency_settings WHERE agency_id = $1",
      [agencyId]
    );
    const arr = r.rows[0]?.disabled_nav_items || [];
    const set = new Set(arr);
    cache.set(agencyId, { disabled: set, ts: Date.now() });
    return set;
  } catch (err) {
    console.warn("[navGuard] DB read failed, fail-open:", err.message);
    return new Set(); // fail-open — don't block on DB errors
  }
}

function invalidateAgencyNav(agencyId) {
  if (agencyId) cache.delete(agencyId);
}

function agencyNavGuard() {
  return async function guard(req, res, next) {
    try {
      const navKey = pathToNavKey(req.path);
      if (!navKey || ESSENTIAL.has(navKey)) return next();

      // Decode JWT directly (auth middleware not yet run at this point).
      // Anonymous requests pass through — auth middleware will 401 them anyway.
      const agencyId = decodeAgencyId(req);
      if (!agencyId) return next();

      const disabled = await getDisabledForAgency(agencyId);
      if (disabled.has(navKey)) {
        return res.status(403).json({
          error: "এই module আপনার agency-তে disabled — owner Settings থেকে enable করতে পারবেন",
          code: "MODULE_DISABLED",
          nav_key: navKey,
        });
      }
      next();
    } catch (err) {
      // Never let our middleware bring down a request; log and pass through
      console.error("[navGuard]", err.message);
      next();
    }
  };
}

module.exports = { agencyNavGuard, invalidateAgencyNav, NAV_TO_PATH_PREFIX, ESSENTIAL };
