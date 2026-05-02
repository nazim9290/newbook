/**
 * invoicePdf.js — Generate bilingual invoice PDF using pdf-lib + fontkit.
 *
 * Bengali rendering: Noto Sans Bengali Regular embedded via @pdf-lib/fontkit।
 * Latin text-এর জন্য Helvetica (smaller PDF size)। Auto fallback — ASCII text
 * Helvetica use করে, Bengali/Unicode text Noto Bengali।
 *
 * Returns: Uint8Array (PDF buffer)
 */

const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
const fontkit = require("@pdf-lib/fontkit");
const fs = require("fs");
const path = require("path");

// Bengali font load once at module init — avoid repeated disk reads on cron batch
const BENGALI_FONT_PATH = path.join(__dirname, "../../assets/fonts/NotoSansBengali-Regular.ttf");
let _bengaliFontBytes = null;
try {
  if (fs.existsSync(BENGALI_FONT_PATH)) {
    _bengaliFontBytes = fs.readFileSync(BENGALI_FONT_PATH);
  } else {
    console.warn(`[InvoicePDF] Bengali font missing at ${BENGALI_FONT_PATH} — Bengali text will fall back to '?'`);
  }
} catch (e) {
  console.error("[InvoicePDF] Bengali font load error:", e.message);
}

// Detect non-Latin characters → use Bengali font when present
const NON_LATIN_RE = /[^\x00-\x7F]/;

// ── format helpers ──
const fmtBDT = (n) => `BDT ${Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDate = (d) => d ? new Date(d).toISOString().slice(0, 10) : "—";

async function generateInvoicePdf({ invoice, agency }) {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const page = pdf.addPage([595, 842]);   // A4 portrait (pt)
  const { width, height } = page.getSize();
  const helv = await pdf.embedFont(StandardFonts.Helvetica);
  const helvBold = await pdf.embedFont(StandardFonts.HelveticaBold);
  // Embed Bengali font if available (subset for size)
  let bengaliFont = null;
  if (_bengaliFontBytes) {
    try {
      bengaliFont = await pdf.embedFont(_bengaliFontBytes, { subset: true });
    } catch (e) {
      console.error("[InvoicePDF] embedFont(Bengali) failed:", e.message);
    }
  }

  const margin = 40;
  let y = height - margin;

  const drawText = (text, opts = {}) => {
    const { x = margin, size = 10, bold = false, color = rgb(0, 0, 0), font, maxWidth } = opts;
    let str = String(text ?? "");
    // Auto-pick font: non-Latin text → Bengali font (if available); else Helvetica
    let useFont;
    if (font) {
      useFont = font;
    } else if (NON_LATIN_RE.test(str) && bengaliFont) {
      useFont = bengaliFont;
    } else if (NON_LATIN_RE.test(str) && !bengaliFont) {
      // Fallback — strip non-ASCII when no Bengali font available
      str = str.replace(/[^\x20-\x7E\n]/g, "?");
      useFont = bold ? helvBold : helv;
    } else {
      useFont = bold ? helvBold : helv;
    }
    if (maxWidth && useFont.widthOfTextAtSize(str, size) > maxWidth) {
      // crude truncate
      while (str.length > 5 && useFont.widthOfTextAtSize(str + "...", size) > maxWidth) str = str.slice(0, -1);
      str = str + "...";
    }
    page.drawText(str, { x, y: opts.y ?? y, size, font: useFont, color });
  };

  const hr = (yy = y) => {
    page.drawLine({
      start: { x: margin, y: yy },
      end: { x: width - margin, y: yy },
      thickness: 0.5,
      color: rgb(0.7, 0.7, 0.7),
    });
  };

  // ── Header ──
  drawText("INVOICE", { x: margin, y, size: 24, bold: true, color: rgb(0.1, 0.4, 0.7) });
  drawText("AgencyBook — Study Abroad CRM", { x: width - margin - 200, y, size: 9, color: rgb(0.3, 0.3, 0.3) });
  y -= 6;
  drawText("agencybook.net", { x: width - margin - 200, y: y - 12, size: 8, color: rgb(0.5, 0.5, 0.5) });

  y -= 30;
  hr(y); y -= 15;

  // ── Invoice meta + Bill-to ──
  // Left column — invoice info
  drawText("Invoice #", { y, size: 9, color: rgb(0.4, 0.4, 0.4) });
  drawText(invoice.invoice_number, { x: margin, y: y - 12, size: 12, bold: true });
  drawText("Issue Date", { x: 200, y, size: 9, color: rgb(0.4, 0.4, 0.4) });
  drawText(fmtDate(invoice.issue_date), { x: 200, y: y - 12, size: 11 });
  drawText("Due Date", { x: 320, y, size: 9, color: rgb(0.4, 0.4, 0.4) });
  drawText(fmtDate(invoice.due_date), { x: 320, y: y - 12, size: 11, bold: true, color: rgb(0.7, 0.2, 0.1) });
  drawText("Status", { x: 440, y, size: 9, color: rgb(0.4, 0.4, 0.4) });
  drawText((invoice.status || "").toUpperCase(), { x: 440, y: y - 12, size: 11, bold: true,
    color: invoice.status === "paid" ? rgb(0.1, 0.6, 0.2) : rgb(0.8, 0.5, 0) });

  y -= 40;
  hr(y); y -= 15;

  // Bill to
  drawText("BILL TO", { y, size: 9, bold: true, color: rgb(0.4, 0.4, 0.4) });
  y -= 14;
  drawText(agency?.name || "—", { y, size: 12, bold: true });
  y -= 12;
  if (agency?.email) { drawText(agency.email, { y, size: 9, color: rgb(0.4, 0.4, 0.4) }); y -= 11; }
  if (agency?.phone) { drawText(agency.phone, { y, size: 9, color: rgb(0.4, 0.4, 0.4) }); y -= 11; }
  if (agency?.address) { drawText(agency.address, { y, size: 9, color: rgb(0.4, 0.4, 0.4), maxWidth: 300 }); y -= 11; }

  // Period
  y -= 8;
  drawText(`Billing Period: ${fmtDate(invoice.period_start)}  -->  ${fmtDate(invoice.period_end)}`, { y, size: 10, color: rgb(0.3, 0.3, 0.3) });
  y -= 20;

  hr(y); y -= 18;

  // ── Line items table ──
  drawText("DESCRIPTION", { x: margin, y, size: 9, bold: true, color: rgb(0.4, 0.4, 0.4) });
  drawText("QTY", { x: 360, y, size: 9, bold: true, color: rgb(0.4, 0.4, 0.4) });
  drawText("UNIT PRICE", { x: 410, y, size: 9, bold: true, color: rgb(0.4, 0.4, 0.4) });
  drawText("TOTAL", { x: 500, y, size: 9, bold: true, color: rgb(0.4, 0.4, 0.4) });
  y -= 6;
  hr(y); y -= 14;

  const items = Array.isArray(invoice.line_items) ? invoice.line_items
    : (typeof invoice.line_items === "string" ? JSON.parse(invoice.line_items || "[]") : []);

  items.forEach(item => {
    drawText(item.description || "—", { x: margin, y, size: 10, maxWidth: 300 });
    drawText(String(item.qty || 1), { x: 360, y, size: 10 });
    drawText(fmtBDT(item.unit_price), { x: 410, y, size: 10 });
    drawText(fmtBDT(item.total), { x: 500, y, size: 10, bold: true });
    y -= 16;
  });

  if (items.length === 0) {
    drawText("(No line items)", { y, size: 9, color: rgb(0.5, 0.5, 0.5) });
    y -= 16;
  }

  y -= 6;
  hr(y); y -= 14;

  // ── Totals ──
  const totalLineX = 380;
  drawText("Subtotal", { x: totalLineX, y, size: 10, color: rgb(0.4, 0.4, 0.4) });
  drawText(fmtBDT(invoice.subtotal), { x: 500, y, size: 10 });
  y -= 14;
  if (Number(invoice.tax_amount) > 0) {
    drawText("Tax", { x: totalLineX, y, size: 10, color: rgb(0.4, 0.4, 0.4) });
    drawText(fmtBDT(invoice.tax_amount), { x: 500, y, size: 10 });
    y -= 14;
  }
  if (Number(invoice.discount_amount) > 0) {
    drawText("Discount", { x: totalLineX, y, size: 10, color: rgb(0.4, 0.4, 0.4) });
    drawText(`- ${fmtBDT(invoice.discount_amount)}`, { x: 500, y, size: 10, color: rgb(0.1, 0.6, 0.2) });
    y -= 14;
  }
  hr(y); y -= 14;
  drawText("TOTAL DUE", { x: totalLineX, y, size: 12, bold: true });
  drawText(fmtBDT(invoice.total_amount), { x: 500, y, size: 13, bold: true, color: rgb(0.1, 0.4, 0.7) });
  y -= 20;
  if (Number(invoice.paid_amount) > 0) {
    drawText("Paid", { x: totalLineX, y, size: 10, color: rgb(0.1, 0.6, 0.2) });
    drawText(fmtBDT(invoice.paid_amount), { x: 500, y, size: 10, color: rgb(0.1, 0.6, 0.2) });
    y -= 14;
    drawText("BALANCE", { x: totalLineX, y, size: 11, bold: true });
    drawText(fmtBDT(Number(invoice.total_amount) - Number(invoice.paid_amount)), { x: 500, y, size: 12, bold: true, color: rgb(0.7, 0.2, 0.1) });
    y -= 20;
  }

  // ── Payment instructions ──
  y -= 30;
  hr(y); y -= 16;
  drawText("PAYMENT INSTRUCTIONS", { y, size: 10, bold: true, color: rgb(0.1, 0.4, 0.7) });
  y -= 14;
  drawText("- bKash Merchant: 01XXX-XXXXXX (Reference: invoice number)", { y, size: 9, color: rgb(0.3, 0.3, 0.3) }); y -= 12;
  drawText("- Bank Transfer: AgencyBook Ltd. — Bank XYZ — A/C 1234567890", { y, size: 9, color: rgb(0.3, 0.3, 0.3) }); y -= 12;
  drawText("- Online: https://agencybook.net/pay/" + invoice.invoice_number, { y, size: 9, color: rgb(0.3, 0.3, 0.3) }); y -= 12;

  y -= 12;
  drawText("কোনো প্রশ্ন? Email: billing@agencybook.net", { y, size: 9, color: rgb(0.3, 0.3, 0.3) });

  // Footer
  drawText("Generated " + new Date().toISOString(), { y: 30, x: margin, size: 7, color: rgb(0.6, 0.6, 0.6) });
  drawText("AgencyBook (c) " + new Date().getUTCFullYear(), { y: 30, x: width - margin - 100, size: 7, color: rgb(0.6, 0.6, 0.6) });

  return await pdf.save();
}

module.exports = { generateInvoicePdf };
