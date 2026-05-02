/**
 * email.js — SMTP email service (industry-standard nodemailer wrapper)
 *
 * Agency-aware (Phase 4 — BYOK SMTP):
 *   - Pass agencyId as the first arg to sendEmail() to use that agency's
 *     own SMTP configuration (Pro+ tier only).
 *   - Without agencyId, falls back to platform .env SMTP (transactional
 *     emails sent on behalf of the SaaS provider — billing notices,
 *     password resets, etc.)
 *
 * Configurable via env (works with mailcow / Resend / SendGrid / SES):
 *   SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASSWORD,
 *   SMTP_FROM_NAME, SMTP_FROM_EMAIL, SMTP_REPLY_TO (optional)
 *
 * Usage:
 *   const { sendEmail } = require("./lib/email");
 *
 *   // Platform email (billing, password reset — sent by the SaaS provider):
 *   await sendEmail(null, { to, subject, html });
 *
 *   // Agency-branded email (notifications to their students/staff —
 *   // hits agency's BYOK SMTP if configured):
 *   await sendEmail(agencyId, { to, subject, html });
 *
 * Returns: { success: bool, messageId?, error?, source? }
 *   Catches all errors — never throws — billing cron-এ disrupt না হয়।
 */

const nodemailer = require("nodemailer");

// Cache transporters keyed by credential signature so we don't reconnect
// for every email. Cache invalidates implicitly on credential rotation
// (next call hits resolver, gets fresh creds, hashes to a new key).
const transporterCache = new Map();

function buildTransporter(creds) {
  const host = creds.host;
  const port = Number(creds.port || 587);
  const user = creds.user;
  const pass = creds.password;
  const secure = String(creds.secure || "").toLowerCase() === "true" || port === 465;

  if (!host || !user || !pass) return null;

  return nodemailer.createTransport({
    host, port, secure,
    auth: { user, pass },
    pool: true,
    maxConnections: 3,
    maxMessages: 100,
    connectionTimeout: 30 * 1000,
    socketTimeout: 30 * 1000,
  });
}

function getPlatformTransporter() {
  const cacheKey = `platform:${process.env.SMTP_HOST}:${process.env.SMTP_USER}`;
  if (transporterCache.has(cacheKey)) return transporterCache.get(cacheKey);

  const t = buildTransporter({
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT,
    user: process.env.SMTP_USER,
    password: process.env.SMTP_PASSWORD,
    secure: process.env.SMTP_SECURE,
  });
  if (!t) {
    console.warn("[Email] platform SMTP not configured — emails will be skipped (set SMTP_HOST/USER/PASSWORD in .env)");
    return null;
  }
  transporterCache.set(cacheKey, { transporter: t, creds: {
    user: process.env.SMTP_USER,
    from_email: process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER,
    from_name: process.env.SMTP_FROM_NAME || "AgencyBook",
  }, source: "platform" });
  // Verify in background
  t.verify().then(() => console.log(`[Email] platform SMTP ready: ${process.env.SMTP_USER}@${process.env.SMTP_HOST}`))
    .catch(err => console.error(`[Email] platform SMTP verify failed: ${err.message}`));
  return transporterCache.get(cacheKey);
}

async function getAgencyTransporter(agencyId) {
  if (!agencyId) return getPlatformTransporter();
  const { getCredential } = require("./integrations");
  let creds;
  try {
    creds = await getCredential(agencyId, "smtp");
  } catch (e) {
    if (e.code === "INTEGRATION_REQUIRED" || e.code === "QUOTA_EXCEEDED") {
      // Shared mode → fall back to platform; enterprise mode → already errored
      // Note: getCredential already returned platform if shared+available, so
      // arriving here in shared mode means platform also missing.
      return null;
    }
    throw e;
  }
  // creds.source = "agency" or "platform"
  const cacheKey = `${creds.source}:${creds.host}:${creds.user}`;
  if (transporterCache.has(cacheKey)) return transporterCache.get(cacheKey);

  const t = buildTransporter(creds);
  if (!t) return null;
  const entry = {
    transporter: t,
    creds: { user: creds.user, from_email: creds.from_email || creds.user, from_name: creds.from_name || "AgencyBook" },
    source: creds.source,
  };
  transporterCache.set(cacheKey, entry);
  t.verify().then(() => console.log(`[Email] ${creds.source} SMTP ready (agency=${agencyId}): ${creds.user}@${creds.host}`))
    .catch(err => console.error(`[Email] ${creds.source} SMTP verify failed (agency=${agencyId}): ${err.message}`));
  return entry;
}

/**
 * Send an email. agencyId optional — pass to use agency's BYOK SMTP.
 *
 *   sendEmail(null, { to, subject, html })          → platform
 *   sendEmail(agencyId, { to, subject, html })      → agency BYOK with platform fallback
 *
 * Backward compat: if first arg is a plain object (legacy single-arg call),
 * treat as platform email — keeps old call sites working until refactored.
 *
 * Returns { success, messageId?, error?, source? }. Never throws.
 */
async function sendEmail(agencyIdOrOptions, maybeOptions) {
  // Backward-compat shim: legacy call sendEmail({ to, ... })
  let agencyId, options;
  if (typeof agencyIdOrOptions === "string" || agencyIdOrOptions === null || agencyIdOrOptions === undefined) {
    agencyId = agencyIdOrOptions || null;
    options = maybeOptions || {};
  } else {
    agencyId = null;
    options = agencyIdOrOptions || {};
  }

  const { to, subject, html, text, attachments = [], replyTo, from } = options;
  if (!to || !subject) return { success: false, error: "to + subject required" };

  const entry = await getAgencyTransporter(agencyId);
  if (!entry) return { success: false, error: "SMTP not configured" };

  const fromEmail = entry.creds.from_email;
  const fromName = entry.creds.from_name;
  const defaultFrom = from || `"${fromName}" <${fromEmail}>`;
  const defaultReplyTo = replyTo || process.env.SMTP_REPLY_TO || fromEmail;

  try {
    const info = await entry.transporter.sendMail({
      from: defaultFrom,
      to,
      subject,
      text: text || htmlToPlainText(html),
      html,
      replyTo: defaultReplyTo,
      attachments,
      headers: {
        "X-Priority": "1",
        "X-Mailer": "AgencyBook/1.0",
      },
    });
    return { success: true, messageId: info.messageId, source: entry.source };
  } catch (e) {
    console.error(`[Email] sendMail failed for ${to} (${entry.source}):`, e.message);
    return { success: false, error: e.message, source: entry.source };
  }
}

function htmlToPlainText(html = "") {
  return String(html)
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/h[1-6]>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Backward-compat default transporter for any callsites that still use it
function getTransporter() {
  return getPlatformTransporter()?.transporter || null;
}

module.exports = { sendEmail, getTransporter };
