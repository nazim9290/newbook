/**
 * email.js — SMTP email service (industry-standard nodemailer wrapper)
 *
 * Configurable via env (works with mailcow / Resend / SendGrid / SES — যেকোনো SMTP):
 *
 *   SMTP_HOST=mail.agencybook.net
 *   SMTP_PORT=587            (TLS) or 465 (SSL)
 *   SMTP_SECURE=false        (true for 465, false for 587)
 *   SMTP_USER=billing@agencybook.net
 *   SMTP_PASSWORD=...
 *   SMTP_FROM_NAME=AgencyBook Billing
 *   SMTP_FROM_EMAIL=billing@agencybook.net
 *   SMTP_REPLY_TO=support@agencybook.net   (optional)
 *
 * Usage:
 *   const { sendEmail } = require("./lib/email");
 *   await sendEmail({
 *     to: "owner@agency.com",
 *     subject: "Invoice INV-..." ,
 *     html: "<p>...</p>",
 *     text: "fallback plain text",
 *     attachments: [{ filename: "INV-...pdf", content: pdfBuffer, contentType: "application/pdf" }],
 *   });
 *
 * Returns: { success: bool, messageId?, error? }
 *   Catches all errors — never throws — billing cron-এ disrupt না হয়।
 */

const nodemailer = require("nodemailer");

let _transporter = null;

function getTransporter() {
  if (_transporter) return _transporter;

  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASSWORD;
  const secure = String(process.env.SMTP_SECURE || "").toLowerCase() === "true" || port === 465;

  if (!host || !user || !pass) {
    console.warn("[Email] SMTP not configured — emails will be skipped (set SMTP_HOST/USER/PASSWORD in .env)");
    return null;
  }

  _transporter = nodemailer.createTransport({
    host, port, secure,
    auth: { user, pass },
    // Connection pooling — invoice cron batch-এ একই connection re-use
    pool: true,
    maxConnections: 3,
    maxMessages: 100,
    // 30s socket timeout — slow SMTP hang prevent
    connectionTimeout: 30 * 1000,
    socketTimeout: 30 * 1000,
  });

  // Verify on first use — log if creds wrong
  _transporter.verify().then(() => {
    console.log(`[Email] SMTP ready: ${user}@${host}:${port}`);
  }).catch(err => {
    console.error(`[Email] SMTP verify failed: ${err.message}`);
  });

  return _transporter;
}

/**
 * Send an email. Returns { success, messageId?, error? }.
 * Never throws — wraps all errors so cron loops keep running.
 */
async function sendEmail({ to, subject, html, text, attachments = [], replyTo, from }) {
  if (!to || !subject) {
    return { success: false, error: "to + subject required" };
  }
  const transporter = getTransporter();
  if (!transporter) {
    return { success: false, error: "SMTP not configured" };
  }

  const fromEmail = process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER;
  const fromName = process.env.SMTP_FROM_NAME || "AgencyBook";
  const defaultFrom = from || `"${fromName}" <${fromEmail}>`;
  const defaultReplyTo = replyTo || process.env.SMTP_REPLY_TO || fromEmail;

  try {
    const info = await transporter.sendMail({
      from: defaultFrom,
      to,
      subject,
      text: text || htmlToPlainText(html),
      html,
      replyTo: defaultReplyTo,
      attachments,
      // Higher priority for transactional invoice emails
      headers: {
        "X-Priority": "1",
        "X-Mailer": "AgencyBook/1.0",
      },
    });
    return { success: true, messageId: info.messageId };
  } catch (e) {
    console.error(`[Email] sendMail failed for ${to}:`, e.message);
    return { success: false, error: e.message };
  }
}

// crude HTML → plain text fallback (good enough for transactional)
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

module.exports = { sendEmail, getTransporter };
