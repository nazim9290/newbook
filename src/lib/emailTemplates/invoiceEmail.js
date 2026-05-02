/**
 * invoiceEmail.js — bilingual HTML template for invoice email.
 *
 * Returns: { subject, html, text }
 *
 * Design: clean transactional email — system fonts, inline CSS, mobile-friendly.
 * Bengali rendering — Unicode passes through email clients fine; Noto Sans Bengali
 * font-family hint for clients that have it installed.
 */

const fmtBDT = (n) => `BDT ${Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDate = (d) => d ? new Date(d).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—";
const esc = (s) => String(s || "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function buildInvoiceEmail({ invoice, agency }) {
  const lineItems = Array.isArray(invoice.line_items) ? invoice.line_items
    : (typeof invoice.line_items === "string" ? JSON.parse(invoice.line_items || "[]") : []);
  const balance = Number(invoice.total_amount) - Number(invoice.paid_amount || 0);
  const isOverdue = invoice.due_date && new Date(invoice.due_date) < new Date();
  const paymentUrl = `https://${agency?.subdomain || "demo"}.agencybook.net/pay/${invoice.invoice_number}`;

  const subject = `Invoice ${invoice.invoice_number} — ${fmtBDT(invoice.total_amount)} due ${fmtDate(invoice.due_date)}`;

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

        <!-- Header -->
        <tr>
          <td style="background:linear-gradient(135deg,#0891b2,#7c3aed);padding:28px 32px;color:#fff;">
            <table width="100%"><tr>
              <td>
                <p style="margin:0;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;opacity:0.85;">AgencyBook</p>
                <h1 style="margin:6px 0 0;font-size:26px;font-weight:700;">Invoice</h1>
              </td>
              <td align="right">
                <p style="margin:0;font-size:11px;opacity:0.85;">Invoice #</p>
                <p style="margin:4px 0 0;font-size:16px;font-weight:600;font-family:'Courier New',monospace;">${esc(invoice.invoice_number)}</p>
              </td>
            </tr></table>
          </td>
        </tr>

        <!-- Status banner -->
        ${invoice.status === "paid" ? `
        <tr><td style="background:#10b98115;padding:12px 32px;border-bottom:1px solid #d1fae5;">
          <p style="margin:0;color:#059669;font-weight:600;font-size:13px;">✓ Paid · ধন্যবাদ</p>
        </td></tr>` : isOverdue ? `
        <tr><td style="background:#f43f5e15;padding:12px 32px;border-bottom:1px solid #fecaca;">
          <p style="margin:0;color:#be123c;font-weight:600;font-size:13px;">⚠ Overdue — Due ${fmtDate(invoice.due_date)}</p>
        </td></tr>` : `
        <tr><td style="background:#f59e0b15;padding:12px 32px;border-bottom:1px solid #fde68a;">
          <p style="margin:0;color:#b45309;font-weight:600;font-size:13px;">⏰ Due by ${fmtDate(invoice.due_date)}</p>
        </td></tr>`}

        <!-- Body -->
        <tr><td style="padding:32px;">

          <!-- Greeting -->
          <p style="margin:0 0 8px;font-size:15px;">Hello <strong>${esc(agency?.name || "")}</strong>,</p>
          <p style="margin:0 0 24px;font-size:14px;color:#4b5563;">
            আপনার নতুন invoice তৈরি হয়েছে। নিচে details দেখুন বা attached PDF download করুন।<br>
            <span style="color:#9ca3af;font-size:12px;">Your new invoice is ready. Details below or see the attached PDF.</span>
          </p>

          <!-- Summary card -->
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;margin:0 0 20px;">
            <tr>
              <td style="padding:16px 20px;border-bottom:1px solid #e5e7eb;">
                <table width="100%"><tr>
                  <td>
                    <p style="margin:0;font-size:11px;color:#6b7280;letter-spacing:0.5px;text-transform:uppercase;">Total Due / মোট প্রদেয়</p>
                    <p style="margin:4px 0 0;font-size:28px;font-weight:700;color:#0891b2;">${fmtBDT(invoice.total_amount)}</p>
                  </td>
                  <td align="right">
                    <p style="margin:0;font-size:11px;color:#6b7280;text-transform:uppercase;">Period</p>
                    <p style="margin:4px 0 0;font-size:13px;color:#374151;">${fmtDate(invoice.period_start)} → ${fmtDate(invoice.period_end)}</p>
                  </td>
                </tr></table>
              </td>
            </tr>
            ${Number(invoice.paid_amount) > 0 ? `
            <tr><td style="padding:12px 20px;border-bottom:1px solid #e5e7eb;background:#10b9810a;">
              <table width="100%"><tr>
                <td><p style="margin:0;font-size:12px;color:#059669;">Already Paid</p></td>
                <td align="right"><p style="margin:0;font-size:14px;font-weight:600;color:#059669;">${fmtBDT(invoice.paid_amount)}</p></td>
              </tr></table>
              <table width="100%" style="margin-top:6px;"><tr>
                <td><p style="margin:0;font-size:13px;font-weight:600;color:#be123c;">Balance / বকেয়া</p></td>
                <td align="right"><p style="margin:0;font-size:18px;font-weight:700;color:#be123c;">${fmtBDT(balance)}</p></td>
              </tr></table>
            </td></tr>` : ""}
          </table>

          <!-- Line items -->
          <p style="margin:24px 0 8px;font-size:11px;color:#6b7280;letter-spacing:0.5px;text-transform:uppercase;">Line Items</p>
          <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:6px;">
            <tr style="background:#f9fafb;">
              <th align="left"  style="padding:8px 12px;font-size:11px;color:#6b7280;font-weight:600;border-bottom:1px solid #e5e7eb;">Description</th>
              <th align="right" style="padding:8px 12px;font-size:11px;color:#6b7280;font-weight:600;border-bottom:1px solid #e5e7eb;width:60px;">Qty</th>
              <th align="right" style="padding:8px 12px;font-size:11px;color:#6b7280;font-weight:600;border-bottom:1px solid #e5e7eb;width:120px;">Total</th>
            </tr>
            ${lineItems.map(item => `
            <tr>
              <td style="padding:10px 12px;font-size:13px;border-bottom:1px solid #f3f4f6;">${esc(item.description)}</td>
              <td style="padding:10px 12px;font-size:13px;border-bottom:1px solid #f3f4f6;text-align:right;color:#6b7280;">${item.qty || 1}</td>
              <td style="padding:10px 12px;font-size:13px;border-bottom:1px solid #f3f4f6;text-align:right;font-weight:600;">${fmtBDT(item.total)}</td>
            </tr>`).join("")}
          </table>

          ${balance > 0 && invoice.status !== "paid" ? `
          <!-- CTA -->
          <table width="100%" style="margin:28px 0 16px;"><tr>
            <td align="center">
              <a href="${esc(paymentUrl)}" style="display:inline-block;background:#0891b2;color:#ffffff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;">
                Pay Now / এখন পরিশোধ করুন →
              </a>
            </td>
          </tr></table>` : ""}

          <!-- Payment instructions -->
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;margin:20px 0 0;">
            <tr><td style="padding:16px 20px;">
              <p style="margin:0 0 8px;font-size:12px;font-weight:600;color:#b45309;">💳 Payment Instructions / পরিশোধের মাধ্যম</p>
              <p style="margin:0;font-size:12px;color:#78350f;line-height:1.7;">
                <strong>bKash Merchant:</strong> 01XXX-XXXXXX (Reference: ${esc(invoice.invoice_number)})<br>
                <strong>Bank Transfer:</strong> AgencyBook Ltd. — Bank XYZ — A/C 1234567890<br>
                <strong>Online:</strong> <a href="${esc(paymentUrl)}" style="color:#0891b2;">${esc(paymentUrl)}</a>
              </p>
            </td></tr>
          </table>

          <!-- Closing -->
          <p style="margin:32px 0 4px;font-size:13px;color:#4b5563;">
            কোনো প্রশ্ন থাকলে এই email-এ reply করুন বা <a href="mailto:billing@agencybook.net" style="color:#0891b2;">billing@agencybook.net</a>-এ যোগাযোগ করুন।
          </p>
          <p style="margin:0 0 4px;font-size:13px;color:#4b5563;">
            ধন্যবাদ আপনার সাথে কাজ করার সুযোগ দেওয়ার জন্য।<br>
            <span style="color:#9ca3af;font-size:11px;">Thank you for your business.</span>
          </p>
          <p style="margin:16px 0 0;font-size:13px;color:#4b5563;">— AgencyBook Team</p>
        </td></tr>

        <!-- Footer -->
        <tr><td style="background:#f9fafb;padding:16px 32px;border-top:1px solid #e5e7eb;">
          <p style="margin:0;font-size:11px;color:#9ca3af;text-align:center;">
            AgencyBook · Study Abroad CRM<br>
            <a href="https://agencybook.net" style="color:#9ca3af;text-decoration:underline;">agencybook.net</a> ·
            <a href="mailto:support@agencybook.net" style="color:#9ca3af;text-decoration:underline;">support@agencybook.net</a>
          </p>
          <p style="margin:8px 0 0;font-size:10px;color:#d1d5db;text-align:center;">
            This is a transactional email regarding your AgencyBook subscription. You cannot unsubscribe from billing emails.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  // Plain text fallback
  const text = [
    `Invoice ${invoice.invoice_number}`,
    "",
    `Total Due: ${fmtBDT(invoice.total_amount)}`,
    `Period: ${fmtDate(invoice.period_start)} → ${fmtDate(invoice.period_end)}`,
    `Due Date: ${fmtDate(invoice.due_date)}`,
    Number(invoice.paid_amount) > 0 ? `Already Paid: ${fmtBDT(invoice.paid_amount)}` : "",
    Number(invoice.paid_amount) > 0 ? `Balance: ${fmtBDT(balance)}` : "",
    "",
    "Line Items:",
    ...lineItems.map(i => `  - ${i.description} (${i.qty}× ${fmtBDT(i.unit_price)}) = ${fmtBDT(i.total)}`),
    "",
    "Payment options:",
    "  - bKash Merchant: 01XXX-XXXXXX",
    "  - Bank Transfer: AgencyBook Ltd. — Bank XYZ — A/C 1234567890",
    `  - Online: ${paymentUrl}`,
    "",
    "Questions? Reply to this email or contact billing@agencybook.net",
    "",
    "— AgencyBook Team",
  ].filter(Boolean).join("\n");

  return { subject, html, text };
}

module.exports = { buildInvoiceEmail };
