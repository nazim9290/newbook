/**
 * lifecycleEmails.js — bilingual subscription-lifecycle email templates.
 *
 * Triggered by status transitions / mutate endpoints:
 *   - welcome:      legacy → tier OR new tier subscription created
 *   - suspended:    cron transitions past_due → suspended
 *   - cancelled:    cron transitions suspended → cancelled OR self-cancel completed
 *   - reactivated:  super-admin restore OR self reactivate
 *
 * Each function returns { subject, html, text }.
 */

const fmtBDT = (n) => `BDT ${Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDate = (d) => d ? new Date(d).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—";
const esc = (s) => String(s || "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Shared shell — header + body + footer
function shell({ accent, headerEmoji, headerLabel, headerTitle, headerSubtitle, bodyHtml, ctaUrl, ctaLabel }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:'Noto Sans Bengali','Hind Siliguri','Segoe UI',Arial,sans-serif;color:#1f2937;line-height:1.5;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
        <tr><td style="background:${accent};padding:28px 32px;color:#fff;">
          <p style="margin:0;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;opacity:0.85;">${headerEmoji} ${headerLabel}</p>
          <h1 style="margin:8px 0 0;font-size:26px;font-weight:700;">${headerTitle}</h1>
          ${headerSubtitle ? `<p style="margin:6px 0 0;font-size:13px;opacity:0.9;">${headerSubtitle}</p>` : ""}
        </td></tr>
        <tr><td style="padding:28px 32px;">
          ${bodyHtml}
          ${ctaUrl ? `
          <table width="100%" style="margin:24px 0 16px;"><tr>
            <td align="center">
              <a href="${esc(ctaUrl)}" style="display:inline-block;background:${accent};color:#ffffff;padding:14px 36px;border-radius:8px;text-decoration:none;font-weight:700;font-size:15px;">
                ${ctaLabel}
              </a>
            </td>
          </tr></table>` : ""}
        </td></tr>
        <tr><td style="background:#f9fafb;padding:14px 32px;border-top:1px solid #e5e7eb;">
          <p style="margin:0;font-size:11px;color:#9ca3af;text-align:center;">
            AgencyBook · <a href="https://agencybook.net" style="color:#9ca3af;text-decoration:underline;">agencybook.net</a> ·
            <a href="mailto:support@agencybook.net" style="color:#9ca3af;text-decoration:underline;">support@agencybook.net</a>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ── 1. Welcome — new paid subscription ──
function buildWelcomeEmail({ agency, plan, billingCycle, periodEnd }) {
  const subject = `🎉 Welcome to AgencyBook ${plan?.name_en || ""} — আপনার subscription active`;
  const url = `https://${agency?.subdomain || "demo"}.agencybook.net/subscription`;

  const bodyHtml = `
    <p style="margin:0 0 12px;font-size:15px;">Hello <strong>${esc(agency?.name || "")}</strong>,</p>
    <p style="margin:0 0 16px;font-size:14px;color:#4b5563;">
      স্বাগতম! আপনি সফলভাবে <strong>${esc(plan?.name_bn || plan?.name_en || "")}</strong> plan-এ subscribe করেছেন।
      এখন থেকে full feature access পাবেন।
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#ecfeff;border:1px solid #06b6d4;border-radius:8px;margin:0 0 16px;">
      <tr><td style="padding:16px 20px;">
        <p style="margin:0;font-size:11px;color:#0e7490;letter-spacing:0.5px;text-transform:uppercase;font-weight:600;">Subscription Details</p>
        <table style="margin-top:10px;width:100%;font-size:13px;">
          <tr><td style="padding:3px 0;color:#6b7280;">Plan:</td><td style="padding:3px 0;text-align:right;"><strong>${esc(plan?.name_en || "")}</strong></td></tr>
          <tr><td style="padding:3px 0;color:#6b7280;">Billing Cycle:</td><td style="padding:3px 0;text-align:right;"><strong>${esc(billingCycle)}</strong></td></tr>
          <tr><td style="padding:3px 0;color:#6b7280;">Price:</td><td style="padding:3px 0;text-align:right;"><strong>${fmtBDT(billingCycle === "annual" ? plan?.annual_price : plan?.monthly_price)}/${billingCycle === "annual" ? "yr" : "mo"}</strong></td></tr>
          <tr><td style="padding:3px 0;color:#6b7280;">Next Bill:</td><td style="padding:3px 0;text-align:right;"><strong>${fmtDate(periodEnd)}</strong></td></tr>
        </table>
      </td></tr>
    </table>
    ${billingCycle === "annual" ? `
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fffbeb;border:1px solid #f59e0b40;border-radius:8px;margin:0 0 16px;">
      <tr><td style="padding:14px 18px;">
        <p style="margin:0 0 6px;font-size:11px;font-weight:600;color:#b45309;">🏆 Annual Plan Perks Active</p>
        <ul style="margin:0;padding-left:20px;font-size:11px;color:#78350f;line-height:1.7;">
          <li>Price Lock Guarantee — পরের ১২ মাসে দাম same</li>
          <li>Free Onboarding Session (4 ঘণ্টা) — আমরা schedule করব</li>
          <li>Free Add-on (১ম বছরে যেকোনো একটা)</li>
          <li>Priority Feature Requests</li>
        </ul>
      </td></tr>
    </table>` : ""}
    <p style="margin:16px 0 0;font-size:13px;color:#4b5563;">
      Subscription manage করতে dashboard-এ যান। কোনো প্রশ্ন থাকলে support team আপনার পাশে।
    </p>`;

  const html = shell({
    accent: "#0891b2", headerEmoji: "🎉", headerLabel: "Welcome to AgencyBook",
    headerTitle: `${plan?.name_en || "Premium"} Plan Active`,
    headerSubtitle: `Next bill: ${fmtDate(periodEnd)}`,
    bodyHtml, ctaUrl: url, ctaLabel: "Dashboard-এ যান →",
  });

  const text = [
    `Welcome to AgencyBook ${plan?.name_en || ""}!`,
    "",
    `Hello ${agency?.name || ""},`,
    "",
    `Your subscription is now active.`,
    "",
    `Plan: ${plan?.name_en || ""}`,
    `Billing Cycle: ${billingCycle}`,
    `Price: ${fmtBDT(billingCycle === "annual" ? plan?.annual_price : plan?.monthly_price)}/${billingCycle === "annual" ? "yr" : "mo"}`,
    `Next Bill: ${fmtDate(periodEnd)}`,
    "",
    `Dashboard: ${url}`,
    "",
    "— AgencyBook Team",
  ].join("\n");

  return { subject, html, text };
}

// ── 2. Suspended notice ──
function buildSuspendedEmail({ agency, lastInvoice }) {
  const subject = `🔒 Account Suspended — ${agency?.name || ""} — পরিশোধ করুন এখনই`;
  const url = `https://${agency?.subdomain || "demo"}.agencybook.net/subscription`;
  const balance = lastInvoice ? Number(lastInvoice.total_amount) - Number(lastInvoice.paid_amount || 0) : 0;

  const bodyHtml = `
    <p style="margin:0 0 12px;font-size:15px;">Hello <strong>${esc(agency?.name || "")}</strong>,</p>
    <p style="margin:0 0 16px;font-size:14px;color:#4b5563;">
      দুঃখিত আপনাকে জানাতে হচ্ছে — invoice ৭ দিনের বেশি বকেয়া থাকায় আপনার account এখন <strong style="color:#be123c">read-only mode</strong>-এ আছে।
      নতুন data যোগ/edit করতে পারবেন না, কিন্তু পুরোনো data সব intact আছে।
    </p>
    ${balance > 0 ? `
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fef2f2;border:2px solid #be123c;border-radius:8px;margin:0 0 16px;">
      <tr><td style="padding:18px 24px;text-align:center;">
        <p style="margin:0;font-size:11px;color:#be123c;letter-spacing:0.5px;text-transform:uppercase;font-weight:600;">Outstanding Balance</p>
        <p style="margin:8px 0 0;font-size:30px;font-weight:800;color:#be123c;">${fmtBDT(balance)}</p>
        <p style="margin:6px 0 0;font-size:12px;color:#7f1d1d;">Invoice ${esc(lastInvoice.invoice_number)}</p>
      </td></tr>
    </table>` : ""}
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fffbeb;border:1px solid #f59e0b40;border-radius:8px;">
      <tr><td style="padding:14px 18px;">
        <p style="margin:0 0 6px;font-size:11px;font-weight:600;color:#b45309;">পরবর্তী টাইমলাইন:</p>
        <ul style="margin:0;padding-left:20px;font-size:11px;color:#78350f;line-height:1.7;">
          <li>আজ থেকে ৭ দিনের মধ্যে পরিশোধ করলে — instantly restore</li>
          <li>৭ দিন পর — account <strong>cancelled</strong> হবে, login বন্ধ হবে</li>
          <li>৩০ দিনের মধ্যে data export করতে পারবেন</li>
          <li>৯০ দিন পর data archived → restore fee ৳5,000</li>
        </ul>
      </td></tr>
    </table>`;

  const html = shell({
    accent: "#be123c", headerEmoji: "🔒", headerLabel: "Account Suspended",
    headerTitle: "Read-only mode",
    headerSubtitle: balance > 0 ? `Outstanding: ${fmtBDT(balance)}` : "",
    bodyHtml, ctaUrl: url, ctaLabel: "Pay Now / এখন পরিশোধ করুন →",
  });

  const text = [
    `🔒 ACCOUNT SUSPENDED`,
    "",
    `Hello ${agency?.name || ""},`,
    "",
    `Your account is now read-only because invoice was overdue >7 days.`,
    balance > 0 ? `\nOutstanding: ${fmtBDT(balance)}\nInvoice: ${lastInvoice.invoice_number}\n` : "",
    `Pay now: ${url}`,
    "",
    "Timeline:",
    "  - Pay within 7 days → instant restore",
    "  - 7 days → account cancelled, login blocked",
    "  - 30 days → data export available",
    "  - 90 days → archived (BDT 5,000 restore fee)",
    "",
    "— AgencyBook Team",
  ].filter(Boolean).join("\n");

  return { subject, html, text };
}

// ── 3. Cancelled (final) ──
function buildCancelledEmail({ agency, reason }) {
  const subject = `Account Cancelled — ${agency?.name || ""} — Data preserved 90 days`;
  const url = `mailto:support@agencybook.net?subject=Reactivate%20${encodeURIComponent(agency?.subdomain || "")}`;

  const bodyHtml = `
    <p style="margin:0 0 12px;font-size:15px;">Hello <strong>${esc(agency?.name || "")}</strong>,</p>
    <p style="margin:0 0 16px;font-size:14px;color:#4b5563;">
      আপনার account আজ থেকে cancelled — login বন্ধ। ${reason ? `Reason: <em>${esc(reason)}</em>` : ""}
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;margin:0 0 16px;">
      <tr><td style="padding:14px 18px;">
        <p style="margin:0 0 6px;font-size:11px;font-weight:600;color:#374151;">আপনার Data Status</p>
        <ul style="margin:0;padding-left:20px;font-size:12px;color:#4b5563;line-height:1.7;">
          <li><strong>Day 0-30:</strong> পূর্ণ data preserved — export request করতে পারবেন</li>
          <li><strong>Day 31-90:</strong> Data archived — কোনো cost ছাড়াই restore</li>
          <li><strong>Day 91-365:</strong> Restore fee ৳5,000</li>
          <li><strong>Day 365+:</strong> Permanent deletion (compliance)</li>
        </ul>
      </td></tr>
    </table>
    <p style="margin:16px 0 0;font-size:13px;color:#4b5563;">
      মন বদলালে যেকোনো সময় <a href="${esc(url)}" style="color:#0891b2;">support@agencybook.net</a>-এ reply করুন — আমরা reactivate করে দেব।
    </p>
    <p style="margin:12px 0 0;font-size:13px;color:#4b5563;">
      আপনার বিশ্বাসের জন্য ধন্যবাদ। হয়তো কখনো আবার দেখা হবে। 🙏
    </p>`;

  const html = shell({
    accent: "#6b7280", headerEmoji: "👋", headerLabel: "Account Cancelled",
    headerTitle: "We're sorry to see you go",
    headerSubtitle: "Data preserved for 90 days",
    bodyHtml, ctaUrl: url, ctaLabel: "Reactivate Request →",
  });

  const text = [
    `Account Cancelled — ${agency?.name || ""}`,
    "",
    `Your account is now cancelled.`,
    reason ? `Reason: ${reason}` : "",
    "",
    "Data status:",
    "  Day 0-30:    Preserved, export available",
    "  Day 31-90:   Archived, free restore",
    "  Day 91-365:  Restore fee BDT 5,000",
    "  Day 365+:    Permanent deletion",
    "",
    "Reactivate: support@agencybook.net",
    "",
    "Thank you. — AgencyBook Team",
  ].filter(Boolean).join("\n");

  return { subject, html, text };
}

// ── 4. Reactivated ──
function buildReactivatedEmail({ agency, plan, periodEnd }) {
  const subject = `✓ Account Reactivated — ${agency?.name || ""}`;
  const url = `https://${agency?.subdomain || "demo"}.agencybook.net`;

  const bodyHtml = `
    <p style="margin:0 0 12px;font-size:15px;">Hello <strong>${esc(agency?.name || "")}</strong>,</p>
    <p style="margin:0 0 16px;font-size:14px;color:#4b5563;">
      আপনার account সফলভাবে reactivated — full access ফিরে এসেছে। 🎉
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#ecfdf5;border:1px solid #10b98140;border-radius:8px;margin:0 0 16px;">
      <tr><td style="padding:14px 18px;">
        <p style="margin:0;font-size:13px;color:#065f46;line-height:1.6;">
          <strong>Plan:</strong> ${esc(plan?.name_en || "Active")}<br>
          ${periodEnd ? `<strong>Next Bill:</strong> ${fmtDate(periodEnd)}` : ""}
        </p>
      </td></tr>
    </table>
    <p style="margin:16px 0 0;font-size:13px;color:#4b5563;">
      আবার আপনাকে দেখে ভালো লাগলো। কোনো help লাগলে আমরা আছি।
    </p>`;

  const html = shell({
    accent: "#10b981", headerEmoji: "✓", headerLabel: "Account Reactivated",
    headerTitle: "Welcome back!",
    bodyHtml, ctaUrl: url, ctaLabel: "Dashboard →",
  });

  const text = [
    `✓ Account Reactivated — ${agency?.name || ""}`,
    "",
    `Welcome back! Full access restored.`,
    "",
    `Plan: ${plan?.name_en || "Active"}`,
    periodEnd ? `Next Bill: ${fmtDate(periodEnd)}` : "",
    "",
    `Dashboard: ${url}`,
    "",
    "— AgencyBook Team",
  ].filter(Boolean).join("\n");

  return { subject, html, text };
}

module.exports = { buildWelcomeEmail, buildSuspendedEmail, buildCancelledEmail, buildReactivatedEmail };
