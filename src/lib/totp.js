/**
 * totp.js — TOTP / 2FA helpers
 *
 * speakeasy দিয়ে TOTP secret তৈরি ও যাচাই করে।
 * Backup codes — crypto.randomBytes থেকে generate, SHA-256 hash করে DB-তে রাখা হয়।
 *
 * Phone clock drift handle করতে verifyToken() window=1 (±30 sec) ব্যবহার করে।
 */

const speakeasy = require("speakeasy");
const QRCode = require("qrcode");
const crypto = require("crypto");

// ── 1. Secret + otpauth URL ──
function generateSecret(userEmail, agencyName) {
  const issuer = (agencyName || "AgencyOS").toString();
  const label = `AgencyOS (${userEmail || "user"})`;
  const secret = speakeasy.generateSecret({
    name: label,
    issuer,
    length: 32,
  });
  return {
    base32: secret.base32,
    otpauthUrl: speakeasy.otpauthURL({
      secret: secret.base32,
      label,
      issuer,
      encoding: "base32",
    }),
  };
}

// ── 2. QR code → data URL ──
async function generateQR(otpauthUrl) {
  return QRCode.toDataURL(otpauthUrl, { width: 240, margin: 1 });
}

// ── 3. TOTP যাচাই — ±30 sec drift tolerance (Bangladeshi phone clock) ──
function verifyToken(secret, token) {
  if (!secret || !token) return false;
  const cleaned = String(token).replace(/\s+/g, "");
  if (!/^\d{6}$/.test(cleaned)) return false;
  return speakeasy.totp.verify({
    secret,
    encoding: "base32",
    token: cleaned,
    window: 1,
  });
}

// ── 4. Backup codes — XXXX-XXXX-XXXX uppercase hex ──
function generateBackupCodes() {
  const codes = [];
  for (let i = 0; i < 10; i++) {
    const hex = crypto.randomBytes(6).toString("hex").toUpperCase(); // 12 chars
    codes.push(`${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}`);
  }
  return codes;
}

// ── 5. SHA-256 hash backup codes ──
function hashBackupCodes(codes) {
  return codes.map((c) =>
    crypto.createHash("sha256").update(String(c).trim().toUpperCase()).digest("hex")
  );
}

// ── 6. একটি input backup code list-এ আছে কিনা check ──
function verifyBackupCode(input, hashedList) {
  if (!input || !Array.isArray(hashedList) || hashedList.length === 0) {
    return { valid: false, index: -1 };
  }
  const cleaned = String(input).trim().toUpperCase();
  // hyphen-less form-ও allow করো (user পেস্ট করলে format ভিন্ন হতে পারে)
  const normalized = cleaned.includes("-")
    ? cleaned
    : `${cleaned.slice(0, 4)}-${cleaned.slice(4, 8)}-${cleaned.slice(8, 12)}`;
  const hash = crypto.createHash("sha256").update(normalized).digest("hex");
  const index = hashedList.indexOf(hash);
  return { valid: index !== -1, index };
}

// ── 7. 2FA event log helper — auth_2fa_events table ──
async function log2FAEvent({ supabase, agencyId, userId, actorId, event, ip, userAgent, metadata }) {
  try {
    await supabase.from("auth_2fa_events").insert({
      agency_id: agencyId,
      user_id: userId,
      actor_id: actorId || null,
      event,
      ip: ip || null,
      user_agent: userAgent || null,
      metadata: metadata || null,
    });
  } catch (err) {
    console.error("[2FA Audit]", err.message);
  }
}

module.exports = {
  generateSecret,
  generateQR,
  verifyToken,
  generateBackupCodes,
  hashBackupCodes,
  verifyBackupCode,
  log2FAEvent,
};
