// ==================== routes/discountRoutes.js ====================
const express = require('express');
const router  = express.Router();
const { body } = require('express-validator');
const validate  = require('../middlewares/validator');
const { protect } = require('../middlewares/auth');
const {
  createDiscount, getDiscounts, getDiscount,
  updateDiscount, deleteDiscount, toggleDiscountStatus,
  validateCoupon, applyDiscount
} = require('../controllers/discountController');

// ── Validation middleware ─────────────────────────────────────────────────────

const createValidation = [
  body('campaignName').notEmpty().withMessage('Campaign name is required.').isLength({ max: 60 }),
  body('discountType').isIn(['percent', 'flat', 'freeShipping']),
  body('pricingModel').isIn(['simple', 'tiered']),
  body('simpleDiscount.value')
    .if((v, { req }) => req.body.pricingModel === 'simple' && req.body.discountType !== 'freeShipping')
    .notEmpty().isFloat({ min: 0 }),
  validate
];

const updateValidation = [
  body('campaignName').optional().isLength({ max: 60 }),
  body('discountType').optional().isIn(['percent', 'flat', 'freeShipping']),
  body('pricingModel').optional().isIn(['simple', 'tiered']),
  body('simpleDiscount.value').optional()
    .if((v, { req }) => req.body.discountType !== 'freeShipping')
    .isFloat({ min: 0 }),
  validate
];

const statusValidation = [
  body('status').isIn(['active', 'inactive', 'expired']),
  validate
];

const applyValidation = [
  body('cartItems').isArray({ min: 1 }).withMessage('cartItems must be a non-empty array.'),
  body('cartItems.*.productId').notEmpty().withMessage('Each cart item must have a productId.'),
  body('cartItems.*.price').notEmpty().withMessage('Each cart item must have a price.'),
  body('cartItems.*.quantity').optional().isInt({ min: 1 }),
  validate
];

// ── Routes ────────────────────────────────────────────────────────────────────

// Specific routes BEFORE /:id to avoid param clash

// POST /api/discounts/validate  — quick coupon check (no full cart)
router.post('/validate', protect, validateCoupon);

// POST /api/discounts/apply     — multi-discount cart engine
// Body: { couponCode?, customerNumber, customerId, cartItems[] }
router.post('/apply', applyValidation, applyDiscount);

// CRUD
router.route('/')
  .get(protect, getDiscounts)
  .post(protect, createValidation, createDiscount);

router.route('/:id')
  .get(protect, getDiscount)
  .put(protect, updateValidation, updateDiscount)
  .delete(protect, deleteDiscount);

router.patch('/:id/status', protect, statusValidation, toggleDiscountStatus);

module.exports = router;