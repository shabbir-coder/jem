// ==================== routes/discountRoutes.js ====================
const express = require('express');
const router  = express.Router();
const { body } = require('express-validator');
const validate = require('../middlewares/validator');
const { protect } = require('../middlewares/auth');
const {
  createDiscount,
  getDiscounts,
  getDiscount,
  updateDiscount,
  deleteDiscount,
  toggleDiscountStatus,
  validateCoupon
} = require('../controllers/discountController');

// ── Validation rules ──────────────────────────────────────────────────────────
const createValidation = [
  body('campaignName')
    .notEmpty().withMessage('Campaign name is required.')
    .isLength({ max: 60 }).withMessage('Campaign name must be at most 60 characters.'),
  body('discountType')
    .isIn(['percent', 'flat', 'freeShipping']).withMessage('discountType must be "percent", "flat", or "freeShipping".'),
  body('pricingModel')
    .isIn(['simple', 'tiered']).withMessage('pricingModel must be "simple" or "tiered".'),
  body('simpleDiscount.value')
  .if((value, { req }) =>
    req.body.pricingModel === 'simple' &&
    req.body.discountType !== 'freeShipping'   // ← add this
  )
  .notEmpty().withMessage('Discount value is required for simple model.')
  .isFloat({ min: 0 }).withMessage('Discount value must be a positive number.'),
  validate
];

const updateValidation = [
  body('campaignName')
    .optional()
    .isLength({ max: 60 }).withMessage('Campaign name must be at most 60 characters.'),
  body('discountType')
    .optional()
    .isIn(['percent', 'flat', 'freeShipping']).withMessage('discountType must be "percent", "flat", or "freeShipping".'),
  body('pricingModel')
    .optional()
    .isIn(['simple', 'tiered']).withMessage('pricingModel must be "simple" or "tiered".'),
  body('simpleDiscount.value')
    .optional()
    .if((value, { req }) => req.body.discountType !== 'freeShipping')
    .isFloat({ min: 0 }).withMessage('Discount value must be a positive number.'),
  validate
];

const statusValidation = [
  body('status')
    .isIn(['active', 'inactive', 'expired']).withMessage('status must be active, inactive or expired.'),
  validate
];

// ── Routes ────────────────────────────────────────────────────────────────────

// POST   /api/discounts/validate   ← must be BEFORE /:id routes to avoid clash
router.post('/validate', protect, validateCoupon);

// GET    /api/discounts            → list all campaigns
// POST   /api/discounts            → create a campaign
router.route('/')
  .get(protect, getDiscounts)
  .post(protect, createValidation, createDiscount);

// GET    /api/discounts/:id        → single campaign
// PUT    /api/discounts/:id        → full update
// DELETE /api/discounts/:id        → hard delete
router.route('/:id')
  .get(protect, getDiscount)
  .put(protect, updateValidation, updateDiscount)
  .delete(protect, deleteDiscount);

// PATCH  /api/discounts/:id/status → toggle active/inactive/expired
router.patch('/:id/status', protect, statusValidation, toggleDiscountStatus);

module.exports = router;