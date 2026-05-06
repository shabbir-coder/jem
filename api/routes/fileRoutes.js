const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/auth');
const { uploadSingle, handleUploadError } = require('../middlewares/upload');
const {
  uploadFile,
  getFile,
  getFilesByEntity,
  updateFile,
  deleteFile,
  getFiles
} = require('../controllers/fileController');

// Routes
router.route('/')
  .get(protect, getFiles)
  .post(protect, uploadSingle, handleUploadError, uploadFile);

router.route('/:id')
  .get(protect, getFile)
  .put(protect, updateFile)
  .delete(protect, deleteFile);

router.get('/entity/:entityType/:entityId', protect, getFilesByEntity);

module.exports = router;
