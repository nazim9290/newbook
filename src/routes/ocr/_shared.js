/**
 * _shared.js — OCR routes shared multer upload config
 * temp ফোল্ডারে ফাইল সেভ, max 10MB, JPEG/PNG/WebP/PDF allowed
 */

const multer = require("multer");
const fs = require("fs");
const path = require("path");

const uploadDir = path.join(__dirname, "../../../uploads/ocr-temp");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, ["image/jpeg", "image/png", "image/webp", "application/pdf"].includes(file.mimetype));
  }
});

module.exports = { upload };
