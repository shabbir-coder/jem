const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const validate = require('../middlewares/validator');
const { protect } = require('../middlewares/auth');
const { uploadMultiple, handleUploadError } = require('../middlewares/upload');

const {
  submitReview,
  createReview,
  listReviews,
  getReviewStats,
  getReview,
  updateReviewStatus,
  respondToReview,
  toggleDisplayOnWebsite,
  manageReview,
  deleteReview,
  listPublicReviews
} = require('../controllers/reviewController');

// Validation rules
const reviewValidation = [
  body('customerNumber').notEmpty().withMessage('Customer number is required'),
  body('reviewText').notEmpty().withMessage('Review text is required'),
  validate
];

const statusValidation = [
  body('status').isIn(['pending', 'approved', 'rejected']).withMessage('Invalid status'),
  validate
];

// ── Service-to-service (LLM / WhatsApp integration) ─────────────────────────
router.post('/submit', reviewValidation, submitReview);

// ── Public storefront ───────────────────────────────────────────────────────
router.get('/public', listPublicReviews);

// ── Admin panel ──────────────────────────────────────────────────────────
router.route('/')
  .get(protect, listReviews)
  .post(protect, uploadMultiple, handleUploadError, reviewValidation, createReview);

router.get('/stats', protect, getReviewStats);

router.route('/:id')
  .get(protect, getReview)
  .delete(protect, deleteReview);

router.put('/:id/status', protect, statusValidation, updateReviewStatus);
router.put('/:id/response', protect, respondToReview);
router.put('/:id/display', protect, toggleDisplayOnWebsite);
router.put('/:id/manage', protect, manageReview);

module.exports = router;