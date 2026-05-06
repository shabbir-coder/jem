// ==================== CONTACT ROUTES ====================
const express = require('express');
const router = express.Router();
const { body } = require('express-validator');

const validate = require('../middlewares/validator');
const { protect } = require('../middlewares/auth');
const { uploadSingle, handleUploadError } = require('../middlewares/upload');

const {
  createContact,
  getContacts,
  getContact,
  updateContact,
  updateContactStatus,
  deleteContact,
  saveContactsInBulk,
  blockUser,
  unblockUser,
  getBlockedUsers
} = require('../controllers/contactController');

// ==================== VALIDATIONS ====================
const contactValidation = [
  body('number')
    .notEmpty()
    .withMessage('Contact number is required'),
  validate
];

// ==================== ROUTES ====================

// List + Create
router.route('/')
  .get(protect, getContacts)
  .post(protect, contactValidation, createContact);

// Bulk Upload (Excel)
router.post(
  '/bulk-upload',
  protect,
  uploadSingle,
  handleUploadError,
  saveContactsInBulk
);

// Get blocked users list from WhatsApp
router.get('/blocked', protect, getBlockedUsers);
 
// Update contact status
router.patch('/:id/status', protect, updateContactStatus);
 
// Block user on WhatsApp
router.get('/:id/block', protect, blockUser);
 
// Unblock user on WhatsApp
router.get('/:id/unblock', protect, unblockUser);
 

// Single Contact
router.route('/:id')
  .get(protect, getContact)
  .put(protect, contactValidation, updateContact)
  .delete(protect, deleteContact);
  

module.exports = router;
