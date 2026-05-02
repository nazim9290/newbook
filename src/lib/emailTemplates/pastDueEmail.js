/**
 * pastDueEmail.js — bilingual past-due reminder template.
 *
 * Tone progression based on reminder_count (Section 4.5):
 *   1-3 days: friendly nudge
 *   4-7 days: firmer warning + suspension threat
 *
 * Returns: { subject, html, text }
 */

const fmtBDT = (n) => `BDT ${Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDate = (d) => d ? new Date(d).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—";
const esc = (s) => String(s || "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function buildPastDueEmail({ invoice, agency, daysOverdue }) {
  const balance = Number(invoice.total_amount) - Number(invoice.paid_amount || 0);
  const isFinalWarning = daysOverdue >= 5;   // last 2-3 reminders before suspend
  const paymentUrl = `https://${agency?.subdomain || "demo"}.agencybook.net/pay/${invoice.invoice_number}`;

  const subject = isFinalWarning
    ? `⚠ FINAL NOTICE — Invoice ${invoice.invoice_number} ${daysOverdue} days overdue (${fmtBDT(balance)})`
    : `Reminder: Invoice ${invoice.invoice_number} is overdue — ${fmtBDT(balance)}`;

  const headerColor = isFinalWarning ? "#be123c" : "#d97706";
  const headerBg = isFinalWarning ? "#fef2f2" : "#fffbeb";
  const headerEmoji = isFinalWarning ? "🚨" : "⏰";

  const banner = isFinalWarning
    ? `<strong>Final Reminder</strong> — invoice পরিশোধ না হলে আপনার account suspend হবে এবং service বন্ধ হয়ে যাবে।`
    : `আপনার invoice ${daysOverdue} দিন overdue। দ্রুত পরিশোধ করুন।`;

  const bannerEn = isFinalWarning
    ? `Account will be suspended and access will be cut off if not paid soon.`
    : `Your invoice is now ${daysOverdue} day(s) past due. Please pay at your earliest.`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:'Noto Sans Bengali','Hind Siliguri','Segoe UI',Arial,sans-serif;color:#1f2937;line-height:1.5;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08);">

        <!-- Header alert -->
        <tr><td style="background:${headerBg};padding:20px 32px;border-bottom:3px solid ${headerColor};">
          <p style="margin:0;font-size:13px;color:${headerColor};font-weight:700;">
            ${headerEmoji} ${isFinalWarning ? "FINAL NOTICE / চূড়ান্ত সতর্কতা" : "PAYMENT REMINDER / পেমেন্ট রিমাইন্ডার"}
          </p>
          <h1 style="margin:6px 0 0;font-size:22px;color:${headerColor};">${daysOverdue} ${daysOverdue === 1 ? "day" : "days"} overdue</h1>
        </td></tr>

        <!-- Banner -->
        <tr><td style="background:${headerColor}10;padding:14px 32px;border-bottom:1px solid #fecaca;">
          <p style="margin:0;font-size:13px;color:${headerColor};font-weight:600;">${banner}</p>
          <p style="margin:6px 0 0;font-size:11px;color:#78350f;">${bannerEn}</p>
        </td></tr>

        <!-- Body -->
        <tr><td style="padding:28px 32px;">

          <p style="margin:0 0 8px;font-size:15px;">Hello <strong>${esc(agency?.name || "")}</strong>,</p>
          <p style="margin:0 0 20px;font-size:14px;color:#4b5563;">
            আপনার invoice <strong style="font-family:'Courier New',monospace;">${esc(invoice.invoice_number)}</strong>-এর due date <strong>${fmtDate(invoice.due_date)}</strong> পার হয়ে গেছে। অনুগ্রহ করে দ্রুত পরিশোধ করুন।
          </p>

          <!-- Amount due -->
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#fef2f2;border:2px solid ${headerColor};border-radius:8px;margin:0 0 20px;">
            <tr><td style="padding:18px 24px;text-align:center;">
              <p style="margin:0;font-size:11px;color:${headerColor};letter-spacing:0.5px;text-transform:uppercase;font-weight:600;">Balance Due / বকেয়া</p>
              <p style="margin:8px 0 0;font-size:32px;font-weight:800;color:${headerColor};">${fmtBDT(balance)}</p>
              <p style="margin:6px 0 0;font-size:12px;color:#78350f;">
                Originally due: ${fmtDate(invoice.due_date)}
              </p>
            </td></tr>
          </table>

          <!-- CTA -->
          <table width="100%" style="margin:0 0 24px;"><tr>
            <td align="center">
              <a href="${esc(paymentUrl)}" style="display:inline-block;background:${headerColor};color:#ffffff;padding:14px 36px;border-radius:8px;text-decoration:none;font-weight:700;font-size:15px;">
                Pay Now / এখন পরিশোধ করুন →
              </a>
            </td>
          </tr></table>

          <!-- Payment options summary -->
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;">
            <tr><td style="padding:14px 18px;">
              <p style="margin:0 0 6px;font-size:11px;font-weight:600;color:#374151;">Payment Options:</p>
              <p style="margin:0;font-size:12px;color:#4b5563;line-height:1.7;">
                • <strong>bKash Merchant:</strong> 01XXX-XXXXXX (Ref: ${esc(invoice.invoice_number)})<br>
                • <strong>Bank Transfer:</strong> AgencyBook Ltd. — Bank XYZ — A/C 1234567890<br>
                • <strong>Online:</strong> <a href="${esc(paymentUrl)}" style="color:#0891b2;">${esc(paymentUrl)}</a>
              </p>
            </td></tr>
          </table>

          ${isFinalWarning ? `
          <!-- Suspension warning -->
          <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:20px;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;">
            <tr><td style="padding:14px 18px;">
              <p style="margin:0;font-size:12px;color:${headerColor};font-weight:600;">⚠ যা ঘটতে চলেছে:</p>
              <ul style="margin:8px 0 0;padding-left:20px;font-size:11px;color:#7f1d1d;line-height:1.6;">
                <li>৭ দিনের বেশি past_due হলে আপনার account <strong>read-only</strong> mode-এ যাবে (suspended)</li>
                <li>১৪ দিনের বেশি হলে account <strong>cancelled</strong> হবে — login বন্ধ হবে</li>
                <li>৩০ দিন পর data archive — ৯০ দিনের মধ্যে restore করতে পারবেন</li>
              </ul>
            </td></tr>
          </table>
          ` : ""}

          <p style="margin:24px 0 4px;font-size:13px;color:#4b5563;">
            যদি আপনি ইতিমধ্যে পেমেন্ট করে থাকেন, এই email উপেক্ষা করুন। অথবা confirmation reply করুন।
          </p>
          <p style="margin:0 0 4px;font-size:13px;color:#4b5563;">
            কোনো সমস্যা হলে <a href="mailto:billing@agencybook.net" style="color:#0891b2;">billing@agencybook.net</a>-এ যোগাযোগ করুন।
          </p>
          <p style="margin:16px 0 0;font-size:13px;color:#4b5563;">— AgencyBook Team</p>
        </td></tr>

        <!-- Footer -->
        <tr><td style="background:#f9fafb;padding:14px 32px;border-top:1px solid #e5e7eb;">
          <p style="margin:0;font-size:11px;color:#9ca3af;text-align:center;">
            AgencyBook · <a href="https://agencybook.net" style="color:#9ca3af;text-decoration:underline;">agencybook.net</a> ·
            <a href="mailto:support@agencybook.net" style="color:#9ca3af;text-decoration:underline;">support@agencybook.net</a>
          </p>
          <p style="margin:6px 0 0;font-size:10px;color:#d1d5db;text-align:center;">
            This is reminder ${invoice.reminder_count + 1} for invoice ${esc(invoice.invoice_number)}. Transactional billing email — cannot be unsubscribed.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  // Plain text fallback
  const text = [
    `${isFinalWarning ? "⚠ FINAL NOTICE" : "Payment Reminder"} — Invoice ${invoice.invoice_number}`,
    `${daysOverdue} day(s) overdue.`,
    "",
    `Balance Due: ${fmtBDT(balance)}`,
    `Originally due: ${fmtDate(invoice.due_date)}`,
    "",
    `Pay now: ${paymentUrl}`,
    "",
    "Payment options:",
    "  - bKash Merchant: 01XXX-XXXXXX",
    "  - Bank Transfer: AgencyBook Ltd. — Bank XYZ — A/C 1234567890",
    `  - Online: ${paymentUrl}`,
    "",
    isFinalWarning
      ? "WARNING: account will be suspended at 7 days overdue, cancelled at 14 days."
      : "Pay soon to avoid account suspension.",
    "",
    "If you already paid, please ignore this email or reply with confirmation.",
    "",
    "— AgencyBook Team",
  ].join("\n");

  return { subject, html, text };
}

module.exports = { buildPastDueEmail };
