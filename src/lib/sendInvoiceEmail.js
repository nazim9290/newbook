/**
 * sendInvoiceEmail.js — Generate PDF + email an invoice to its agency.
 *
 * Single source of truth used by:
 *   - billingCron.js (auto-send right after invoice creation)
 *   - super-admin manual invoice generate
 *   - super-admin /resend endpoint
 *
 * Steps:
 *   1. Load invoice + agency from DB (verify still exists)
 *   2. Generate PDF buffer
 *   3. Build email subject + html + text
 *   4. Resolve recipient: agency.billing_email > agency.email > skip
 *   5. SMTP send with PDF attachment
 *   6. Update invoices.email_sent_at / email_status / email_error / email_attempts
 *
 * Returns: { success, error?, recipient? }
 */

const supabase = require("./db");
const { sendEmail } = require("./email");
const { generateInvoicePdf } = require("./invoicePdf");
const { buildInvoiceEmail } = require("./emailTemplates/invoiceEmail");

async function sendInvoiceEmail(invoiceId) {
  // Load invoice + agency
  const { data: invoice, error: invErr } = await supabase.from("invoices")
    .select("*").eq("id", invoiceId).maybeSingle();
  if (invErr || !invoice) return { success: false, error: "Invoice not found" };

  const { data: agency } = await supabase.from("agencies")
    .select("id, name, name_bn, email, billing_email, phone, address, subdomain, logo_url")
    .eq("id", invoice.agency_id).maybeSingle();

  // Recipient resolution: billing_email > email
  const recipient = agency?.billing_email || agency?.email;
  if (!recipient) {
    await markFailed(invoiceId, "No recipient email on agency");
    return { success: false, error: "No recipient email" };
  }

  // Increment attempts counter immediately (so retry loops can cap)
  await supabase.pool.query(
    `UPDATE invoices SET email_attempts = COALESCE(email_attempts, 0) + 1 WHERE id = $1`,
    [invoiceId]
  );

  // Generate PDF
  let pdfBytes;
  try {
    pdfBytes = await generateInvoicePdf({ invoice, agency });
  } catch (e) {
    console.error("[sendInvoiceEmail] PDF gen failed:", e.message);
    await markFailed(invoiceId, "PDF generation: " + e.message);
    return { success: false, error: "PDF generation failed" };
  }

  // Build email body
  const { subject, html, text } = buildInvoiceEmail({ invoice, agency });

  // Send
  const result = await sendEmail({
    to: recipient,
    subject,
    html,
    text,
    attachments: [{
      filename: `${invoice.invoice_number}.pdf`,
      content: Buffer.from(pdfBytes),
      contentType: "application/pdf",
    }],
  });

  if (result.success) {
    await supabase.pool.query(
      `UPDATE invoices SET email_sent_at = now(), email_status = 'sent', email_error = NULL, updated_at = now() WHERE id = $1`,
      [invoiceId]
    );
    console.log(`[sendInvoiceEmail] ✓ ${invoice.invoice_number} → ${recipient}`);
    return { success: true, recipient };
  } else {
    await markFailed(invoiceId, result.error || "unknown error");
    return { success: false, error: result.error, recipient };
  }
}

async function markFailed(invoiceId, error) {
  try {
    await supabase.pool.query(
      `UPDATE invoices SET email_status = 'failed', email_error = $2, updated_at = now() WHERE id = $1`,
      [invoiceId, String(error).slice(0, 500)]
    );
  } catch (e) { /* best effort */ }
}

module.exports = { sendInvoiceEmail };
