const multer = require('multer');
const path = require('path');
const fs = require('fs');

// api/config -> ../../uploads/messages (same folder server.js serves and saveWhatsAppFile writes to)
const messagesDir = path.resolve(__dirname, '../../uploads/messages');
fs.mkdirSync(messagesDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, messagesDir),
  filename: (req, file, cb) => {
    const unique = Date.now() + '_' + Math.round(Math.random() * 1e9);
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${unique}_${safe}`);
  }
});

const allowedExt = /\.(jpe?g|png|webp|gif|pdf|docx?|xlsx?|pptx?|txt|mp4|3gp|mov|mp3|ogg|aac|amr|m4a|wav)$/i;

const fileFilter = (req, file, cb) => {
  if (allowedExt.test(file.originalname)) return cb(null, true);
  cb(new Error('Invalid file type for WhatsApp media.'));
};

const uploadMessage = multer({
  storage,
  fileFilter,
  limits: { fileSize: 16 * 1024 * 1024 } // WhatsApp cap for video/audio
});

module.exports = uploadMessage;