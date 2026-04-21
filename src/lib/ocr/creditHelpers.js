/**
 * creditHelpers.js — OCR credit balance + deduction + usage logging
 *
 * প্রতি scan-এ 5 credit কাটে (৳1 = 1 credit, ৳5/scan)
 * ocr_usage + ocr_credit_log table-এ log হয়
 */

const supabase = require("../supabase");

const CREDITS_PER_SCAN = 5;

// Agency-র OCR credit balance চেক
async function getOcrCredits(agencyId) {
  const { data } = await supabase.from("agencies").select("ocr_credits").eq("id", agencyId).single();
  return data?.ocr_credits || 0;
}

// Credit deduct + usage log + transaction log
async function deductCredit(agencyId, userId, meta) {
  // Credit 5 কমাও — raw SQL দিয়ে atomic update
  const { pool } = supabase;
  try {
    await pool.query("UPDATE agencies SET ocr_credits = GREATEST(0, ocr_credits - $1) WHERE id = $2", [CREDITS_PER_SCAN, agencyId]);
  } catch (e) { console.error("[OCR Credit Deduct]", e.message); }

  // নতুন balance আনো
  const newBalance = await getOcrCredits(agencyId);

  // Usage log — কোন document কে scan করলো
  try {
    await supabase.from("ocr_usage").insert({
      agency_id: agencyId, user_id: userId,
      doc_type: meta.docType || "unknown", engine: meta.engine || "haiku",
      credits_used: CREDITS_PER_SCAN, confidence: meta.confidence || "low",
      fields_extracted: meta.fieldsCount || 0, file_name: meta.fileName || "",
    });
  } catch (e) { console.error("[OCR Usage Log]", e.message); }

  // Transaction log — credit deduct record
  try {
    await supabase.from("ocr_credit_log").insert({
      agency_id: agencyId, amount: -CREDITS_PER_SCAN, balance_after: newBalance,
      type: "scan", description: `OCR scan: ${meta.docType || "unknown"} (${meta.engine})`,
      created_by: userId,
    });
  } catch (e) { console.error("[OCR Credit Log]", e.message); }

  return newBalance;
}

module.exports = { CREDITS_PER_SCAN, getOcrCredits, deductCredit };
