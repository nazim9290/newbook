/**
 * credits.js — OCR credit balance + usage history routes
 *
 * GET /credits — agency-র বর্তমান credit balance
 * GET /usage   — agency-র OCR usage history (last 100)
 */

const express = require("express");
const supabase = require("../../lib/supabase");
const auth = require("../../middleware/auth");
const { getOcrCredits } = require("../../lib/ocr/creditHelpers");

const router = express.Router();
router.use(auth);

// GET /api/ocr/credits — agency-র বর্তমান credit balance
router.get("/credits", async (req, res) => {
  try {
    const credits = await getOcrCredits(req.user.agency_id);
    res.json({ credits });
  } catch { res.json({ credits: 0 }); }
});

// GET /api/ocr/usage — agency-র OCR usage history
router.get("/usage", async (req, res) => {
  try {
    const { data } = await supabase.from("ocr_usage")
      .select("*").eq("agency_id", req.user.agency_id)
      .order("created_at", { ascending: false }).limit(100);
    res.json(data || []);
  } catch { res.json([]); }
});

module.exports = router;
