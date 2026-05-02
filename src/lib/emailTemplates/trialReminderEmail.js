/**
 * trialReminderEmail.js — bilingual trial-end reminder.
 *
 * Sent at Day -7, Day -3, Day -1 before trial ends (Section 4.2).
 *
 * Returns: { subject, html, text }
 */

const fmtDate = (d) => d ? new Date(d).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—";
const esc = (s) => String(s || "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function buildTrialReminderEmail({ agency, daysLeft, trialEndsAt }) {
  const isFinalDay = daysLeft <= 1;
  const isMidWindow = daysLeft >= 2 && daysLeft <= 4;
  const accent = isFinalDay ? "#be123c" : isMidWindow ? "#d97706" : "#0891b2";
  const bg = isFinalDay ? "#fef2f2" : isMidWindow ? "#fffbeb" : "#ecfeff";
  const upgradeUrl = `https://${agency?.subdomain || "demo"}.agencybook.net/subscription`;

  const subject = isFinalDay
    ? `⏰ আপনার Trial আজই শেষ — Plan select করুন`
    : `Trial শেষ হবে ${daysLeft} দিনে — ${fmtDate(trialEndsAt)}`;

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

        <tr><td style="background:${accent};padding:28px 32px;color:#fff;">
          <p style="margin:0;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;opacity:0.85;">Trial Reminder</p>
          <h1 style="margin:8px 0 0;font-size:28px;font-weight:700;">
            ${isFinalDay ? "আজই শেষ" : `আর ${daysLeft} দিন বাকি`}
          </h1>
          <p style="margin:6px 0 0;font-size:13px;opacity:0.9;">Trial expires: ${fmtDate(trialEndsAt)}</p>
        </td></tr>

        <tr><td style="background:${bg};padding:14px 32px;border-bottom:1px solid #e5e7eb;">
          <p style="margin:0;font-size:13px;color:${accent};font-weight:600;">
            ${isFinalDay
              ? "⚠ আজ Trial শেষ — Plan select না করলে কাল থেকে account read-only হবে।"
              : `Trial শেষ হতে আর ${daysLeft} দিন। Plan upgrade করে সাবলীলভাবে কাজ চালিয়ে যান।`}
          </p>
        </td></tr>

        <tr><td style="padding:28px 32px;">
          <p style="margin:0 0 8px;font-size:15px;">Hello <strong>${esc(agency?.name || "")}</strong>,</p>
          <p style="margin:0 0 20px;font-size:14px;color:#4b5563;">
            আপনি ${isFinalDay ? "আজ পর্যন্ত" : `আর ${daysLeft} দিন`} AgencyBook full access-এ ব্যবহার করতে পারবেন। এর মধ্যে একটা plan select করুন যাতে আপনার data, students ও workflow নিরবিচ্ছিন্ন থাকে।
          </p>

          <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;margin:0 0 20px;">
            <tr><td style="padding:16px 20px;">
              <p style="margin:0 0 10px;font-size:11px;color:#6b7280;letter-spacing:0.5px;text-transform:uppercase;font-weight:600;">Available Plans</p>
              <table width="100%" cellspacing="0" cellpadding="0">
                <tr>
                  <td style="padding:8px 0;border-bottom:1px solid #e5e7eb;">
                    <strong>Starter</strong> — Solo agency
                  </td>
                  <td style="padding:8px 0;border-bottom:1px solid #e5e7eb;text-align:right;">
                    <strong style="color:#0891b2;">৳5,000/mo</strong>
                  </td>
                </tr>
                <tr>
                  <td style="padding:8px 0;border-bottom:1px solid #e5e7eb;">
                    <strong>Professional</strong> — Multi-branch + AI ⭐
                  </td>
                  <td style="padding:8px 0;border-bottom:1px solid #e5e7eb;text-align:right;">
                    <strong style="color:#7c3aed;">৳12,000/mo</strong>
                  </td>
                </tr>
                <tr>
                  <td style="padding:8px 0;">
                    <strong>Business</strong> — API + custom domain
                  </td>
                  <td style="padding:8px 0;text-align:right;">
                    <strong style="color:#10b981;">৳25,000/mo</strong>
                  </td>
                </tr>
              </table>
              <p style="margin:12px 0 0;font-size:11px;color:#6b7280;">
                💡 Annual plan = 12-month flat (no discount) + price lock + free onboarding + free add-on
              </p>
            </td></tr>
          </table>

          <table width="100%" style="margin:0 0 24px;"><tr>
            <td align="center">
              <a href="${esc(upgradeUrl)}" style="display:inline-block;background:${accent};color:#ffffff;padding:14px 36px;border-radius:8px;text-decoration:none;font-weight:700;font-size:15px;">
                Plan Select করুন →
              </a>
            </td>
          </tr></table>

          <p style="margin:16px 0 0;font-size:12px;color:#6b7280;text-align:center;">
            কোনো প্রশ্ন? <a href="mailto:billing@agencybook.net" style="color:${accent};">billing@agencybook.net</a>-এ reply করুন।
          </p>
        </td></tr>

        <tr><td style="background:#f9fafb;padding:14px 32px;border-top:1px solid #e5e7eb;">
          <p style="margin:0;font-size:11px;color:#9ca3af;text-align:center;">
            AgencyBook · Study Abroad CRM · <a href="https://agencybook.net" style="color:#9ca3af;text-decoration:underline;">agencybook.net</a>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = [
    isFinalDay ? "⏰ TRIAL ENDS TODAY" : `Trial ends in ${daysLeft} day(s)`,
    `Expires: ${fmtDate(trialEndsAt)}`,
    "",
    `Hello ${agency?.name || ""},`,
    "",
    isFinalDay
      ? "Your trial ends today. Select a plan to keep your account active."
      : `Your trial ends in ${daysLeft} day(s). Pick a plan to continue uninterrupted.`,
    "",
    "Available Plans:",
    "  - Starter:      BDT 5,000/mo  (solo agency)",
    "  - Professional: BDT 12,000/mo (multi-branch + AI) ⭐",
    "  - Business:     BDT 25,000/mo (API + custom domain)",
    "",
    `Select a plan: ${upgradeUrl}`,
    "",
    "Annual = 12-month flat + price lock + free onboarding + free add-on",
    "",
    "Questions? billing@agencybook.net",
    "",
    "— AgencyBook Team",
  ].join("\n");

  return { subject, html, text };
}

module.exports = { buildTrialReminderEmail };
