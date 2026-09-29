const multer = require('multer');
const uploadMessage = require('../config/multerMessages');
const upload = require('../config/multer');


// Single file upload
const uploadSingle = upload.single('file');

// Multiple files upload (max 10)
const uploadMultiple = upload.array('files', 10);

// Single file upload for message
const uploadMessageFile = uploadMessage.single('file'); // NEW


// Handle multer errors
const handleUploadError = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        success: false,
        message: 'File size too large. Maximum size is 10MB'
      });
    }
    return res.status(400).json({
      success: false,
      message: err.message
    });
  } else if (err) {
    return res.status(400).json({
      success: false,
      message: err.message
    });
  }
  next();
};

module.exports = { uploadSingle, uploadMultiple, uploadMessageFile, handleUploadError };