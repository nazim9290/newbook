/**
 * index.js — OCR routes aggregator
 *
 * Sub-routers:
 *   credits.js — GET /credits, GET /usage
 *   scan.js    — POST /scan (Google Vision + Haiku AI extraction)
 */

const express = require("express");
const router = express.Router();

router.use(require("./credits"));
router.use(require("./scan"));

module.exports = router;
