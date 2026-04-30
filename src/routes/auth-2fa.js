/**
 * auth-2fa.js — TOTP self-service endpoints
 *
 * Mounted at /api/auth/2fa
 *
 * Routes:
 *   GET  /status              — auth required
 *   POST /setup-init          — auth required (generates fresh secret + QR)
 *   POST /setup-verify        — auth required (confirms first TOTP, returns backup codes)
 *   POST /verify              — NO auth (uses mfaSession from login response)
 *   POST /disable             — auth required (re-verify password + TOTP)
 *   POST /backup-codes/regenerate — auth required (verify TOTP first)
 */

const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const supabase = require("../lib/db");
const asyncHandler = require("../lib/asyncHandler");
const auth = require("../middleware/auth");
const { encrypt, decrypt } = require("../lib/crypto");
const {
  generateSecret,
  generateQR,
  verifyToken,
  generateBackupCodes,
  hashBackupCodes,
  verifyBackupCode,
  log2FAEvent,
} = require("../lib/totp");

const router = express.Router();

// ── Cookie options — same as routes/auth.js ──
const isProduction = process.env.NODE_ENV === "production";
const COOKIE_OPTS = {
  httpOnly: true,
  secure: isProduction,
  sameSite: "lax",
  maxAge: 7 * 24 * 60 * 60 * 1000,
  path: "/",
};

// ── Rate limiters ──
// /verify — IP-based (no auth context)
const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
  message: { error: "অনেকবার চেষ্টা করেছেন — ১৫ মিনিট পরে আবার চেষ্টা করুন" },
});

// /setup-verify — per-user
const setupVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
  keyGenerator: (req) => req.user?.id || req.ip,
  message: { error: "অনেকবার চেষ্টা করেছেন — ১৫ মিনিট পরে আবার চেষ্টা করুন" },
});

// ── Helpers ──
function mfaSecretKey() {
  return process.env.JWT_SECRET + "_MFA";
}

function getAgencyName(agency) {
  if (!agency) return "AgencyOS";
  return agency.name_bn || agency.name || "AgencyOS";
}

async function loadUser(id) {
  const { data, error } = await supabase.from("users").select("*").eq("id", id).single();
  if (error || !data) return null;
  return data;
}

async function loadAgency(agencyId) {
  if (!agencyId) return null;
  const { data } = await supabase.from("agencies").select("name, name_bn").eq("id", agencyId).single();
  return data;
}

function parseBackupCodes(json) {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function issueFullToken(user) {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      role: user.role,
      branch: user.branch,
      agency_id: user.agency_id,
    },
    process.env.JWT_SECRET,
    { expiresIn: "7d" }
  );
}

function userPublicShape(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    branch: user.branch,
    designation: user.designation || "",
    agency_id: user.agency_id,
    avatar_url: user.avatar_url || null,
    phone: user.phone || null,
    created_at: user.created_at,
  };
}

// ════════════════════════════════════════════════════════════
// GET /status — current user's 2FA state
// ════════════════════════════════════════════════════════════
router.get("/status", auth, asyncHandler(async (req, res) => {
  const user = await loadUser(req.user.id);
  if (!user) return res.status(404).json({ error: "User পাওয়া যায়নি" });

  const codes = parseBackupCodes(user.totp_backup_codes);
  res.json({
    enabled: !!user.totp_enabled,
    required: !!user.totp_required,
    enrolledAt: user.totp_enrolled_at || null,
    lastUsedAt: user.last_2fa_at || null,
    backupCodesRemaining: codes.length,
  });
}));

// ════════════════════════════════════════════════════════════
// POST /setup-init — generate fresh secret + QR
// ════════════════════════════════════════════════════════════
router.post("/setup-init", auth, asyncHandler(async (req, res) => {
  const user = await loadUser(req.user.id);
  if (!user) return res.status(404).json({ error: "User পাওয়া যায়নি" });

  const agency = await loadAgency(user.agency_id);
  const issuer = getAgencyName(agency);

  const { base32, otpauthUrl } = generateSecret(user.email, issuer);
  const qr = await generateQR(otpauthUrl);

  // Encrypt + save fresh secret. totp_enabled stays false until setup-verify.
  const encrypted = encrypt(base32);
  const { error } = await supabase
    .from("users")
    .update({ totp_secret: encrypted, totp_enabled: false })
    .eq("id", user.id);

  if (error) {
    console.error("[2FA setup-init]", error.message);
    return res.status(500).json({ error: "সার্ভার ত্রুটি" });
  }

  res.json({ qr, secret: base32, issuer });
}));

// ════════════════════════════════════════════════════════════
// POST /setup-verify — confirm first TOTP, return backup codes
// ════════════════════════════════════════════════════════════
router.post("/setup-verify", auth, setupVerifyLimiter, asyncHandler(async (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: "৬ digit কোড দিন" });

  const user = await loadUser(req.user.id);
  if (!user || !user.totp_secret) {
    return res.status(400).json({ error: "প্রথমে setup-init করুন" });
  }

  const secret = decrypt(user.totp_secret);
  if (!verifyToken(secret, token)) {
    log2FAEvent({
      supabase, agencyId: user.agency_id, userId: user.id, actorId: user.id,
      event: "setup_failed", ip: req.ip, userAgent: req.headers["user-agent"],
    });
    return res.status(400).json({ error: "ভুল কোড — Authenticator app-এর সময় check করুন" });
  }

  const plaintextCodes = generateBackupCodes();
  const hashed = hashBackupCodes(plaintextCodes);

  const { error } = await supabase
    .from("users")
    .update({
      totp_enabled: true,
      totp_enrolled_at: new Date().toISOString(),
      totp_backup_codes: JSON.stringify(hashed),
      last_2fa_at: new Date().toISOString(),
    })
    .eq("id", user.id);

  if (error) {
    console.error("[2FA setup-verify]", error.message);
    return res.status(500).json({ error: "সার্ভার ত্রুটি" });
  }

  log2FAEvent({
    supabase, agencyId: user.agency_id, userId: user.id, actorId: user.id,
    event: "enrolled", ip: req.ip, userAgent: req.headers["user-agent"],
  });

  res.json({ backupCodes: plaintextCodes });
}));

// ════════════════════════════════════════════════════════════
// POST /verify — exchange mfaSession + token for full JWT
// (NO auth middleware — mfaSession in body is the credential)
// ════════════════════════════════════════════════════════════
router.post("/verify", verifyLimiter, asyncHandler(async (req, res) => {
  const { mfaSession, token, useBackup } = req.body || {};
  if (!mfaSession || !token) {
    return res.status(400).json({ error: "session ও কোড দিন" });
  }

  let payload;
  try {
    payload = jwt.verify(mfaSession, mfaSecretKey());
  } catch {
    return res.status(401).json({ error: "Session মেয়াদ শেষ — আবার login করুন" });
  }

  if (!payload.userId || payload.mode === "enroll") {
    return res.status(400).json({ error: "প্রথমে setup করুন" });
  }

  const user = await loadUser(payload.userId);
  if (!user || !user.totp_enabled || !user.totp_secret) {
    return res.status(400).json({ error: "২FA সেটআপ পাওয়া যায়নি" });
  }

  let success = false;
  let usedBackup = false;
  let backupIndex = -1;

  if (useBackup) {
    const codes = parseBackupCodes(user.totp_backup_codes);
    const result = verifyBackupCode(token, codes);
    if (result.valid) {
      success = true;
      usedBackup = true;
      backupIndex = result.index;
    }
  } else {
    const secret = decrypt(user.totp_secret);
    success = verifyToken(secret, token);
  }

  if (!success) {
    log2FAEvent({
      supabase, agencyId: user.agency_id, userId: user.id, actorId: user.id,
      event: "verify_failed", ip: req.ip, userAgent: req.headers["user-agent"],
      metadata: { useBackup: !!useBackup },
    });
    return res.status(401).json({ error: "ভুল কোড" });
  }

  // Consume backup code if used
  if (usedBackup) {
    const codes = parseBackupCodes(user.totp_backup_codes);
    codes.splice(backupIndex, 1);
    await supabase.from("users").update({
      totp_backup_codes: JSON.stringify(codes),
      last_2fa_at: new Date().toISOString(),
    }).eq("id", user.id);
  } else {
    await supabase.from("users").update({
      last_2fa_at: new Date().toISOString(),
    }).eq("id", user.id);
  }

  log2FAEvent({
    supabase, agencyId: user.agency_id, userId: user.id, actorId: user.id,
    event: usedBackup ? "backup_used" : "verified",
    ip: req.ip, userAgent: req.headers["user-agent"],
  });

  // Issue full 7-day JWT (cookie + JSON, matching /api/auth/login)
  const fullToken = issueFullToken(user);
  res.cookie("agencybook_token", fullToken, COOKIE_OPTS);
  res.json({ token: fullToken, user: userPublicShape(user) });
}));

// ════════════════════════════════════════════════════════════
// POST /disable — re-verify password + TOTP, then wipe
// ════════════════════════════════════════════════════════════
router.post("/disable", auth, asyncHandler(async (req, res) => {
  const { password, token } = req.body || {};
  if (!password || !token) return res.status(400).json({ error: "Password ও কোড দিন" });

  const user = await loadUser(req.user.id);
  if (!user) return res.status(404).json({ error: "User পাওয়া যায়নি" });

  if (user.totp_required) {
    return res.status(403).json({ error: "Admin আপনার জন্য ২FA mandatory করেছেন — নিজে বন্ধ করা যাবে না" });
  }

  if (!user.password_hash) return res.status(400).json({ error: "Password set নেই" });
  const okPwd = await bcrypt.compare(password, user.password_hash);
  if (!okPwd) return res.status(401).json({ error: "Password ভুল" });

  const secret = decrypt(user.totp_secret);
  if (!verifyToken(secret, token)) {
    log2FAEvent({
      supabase, agencyId: user.agency_id, userId: user.id, actorId: user.id,
      event: "verify_failed", ip: req.ip, userAgent: req.headers["user-agent"],
      metadata: { context: "disable" },
    });
    return res.status(401).json({ error: "ভুল কোড" });
  }

  await supabase.from("users").update({
    totp_secret: null,
    totp_enabled: false,
    totp_backup_codes: null,
    totp_enrolled_at: null,
  }).eq("id", user.id);

  log2FAEvent({
    supabase, agencyId: user.agency_id, userId: user.id, actorId: user.id,
    event: "disabled", ip: req.ip, userAgent: req.headers["user-agent"],
  });

  res.json({ success: true });
}));

// ════════════════════════════════════════════════════════════
// POST /backup-codes/regenerate — verify TOTP, return new codes
// ════════════════════════════════════════════════════════════
router.post("/backup-codes/regenerate", auth, asyncHandler(async (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: "কোড দিন" });

  const user = await loadUser(req.user.id);
  if (!user || !user.totp_enabled || !user.totp_secret) {
    return res.status(400).json({ error: "২FA চালু নেই" });
  }

  const secret = decrypt(user.totp_secret);
  if (!verifyToken(secret, token)) {
    return res.status(401).json({ error: "ভুল কোড" });
  }

  const plaintextCodes = generateBackupCodes();
  const hashed = hashBackupCodes(plaintextCodes);

  await supabase.from("users").update({
    totp_backup_codes: JSON.stringify(hashed),
  }).eq("id", user.id);

  log2FAEvent({
    supabase, agencyId: user.agency_id, userId: user.id, actorId: user.id,
    event: "backup_regenerated", ip: req.ip, userAgent: req.headers["user-agent"],
  });

  res.json({ backupCodes: plaintextCodes });
}));

module.exports = router;
