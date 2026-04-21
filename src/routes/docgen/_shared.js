/**
 * _shared.js — docgen routes-এর shared multer upload config
 */

const multer = require("multer");
const path = require("path");

// Filename sanitization — path traversal ও special char সরাও
const sanitize = (name) => name.replace(/[^a-zA-Z0-9._-]/g, "_");

// Allowed MIME types for docx upload
const ALLOWED_MIMES = [
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
  "application/octet-stream",
];

// File upload — sanitized filename + MIME validation
const storage = multer.diskStorage({
  destination: path.join(__dirname, "../../../uploads"),
  filename: (req, file, cb) => cb(null, `doctemplate_${Date.now()}_${sanitize(file.originalname)}`),
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    // MIME type validation — শুধু .docx / .doc allow
    if (ALLOWED_MIMES.includes(file.mimetype) || file.originalname.match(/\.(docx?|DOCX?)$/)) {
      cb(null, true);
    } else {
      cb(new Error("শুধু .docx বা .doc ফাইল আপলোড করুন"));
    }
  },
});

module.exports = { upload };
