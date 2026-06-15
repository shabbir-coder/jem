// ==================== routes/giftCardRoutes.js ====================
const express = require('express');
const router  = express.Router();
const { body, query } = require('express-validator');
const validate  = require('../middlewares/validator');
const { protect } = require('../middlewares/auth');

const {
  generateGiftCards,
  getGiftCards,
  getGiftCard,
  updateGiftCardStatus,
  deleteGiftCard,
  previewCustomers,
  getGiftCardsForContact
} = require('../controllers/giftCardController');

// ── Validations ───────────────────────────────────────────────────────────────

const generateValidation = [
  body('campaignName').notEmpty().withMessage('Campaign name is required.').isLength({ max: 80 }),
  body('discountType').optional().isIn(['percent', 'flat', 'freeShipping']),
  body('discountValue')
    .if((v, { req }) => req.body.discountType !== 'freeShipping')
    .notEmpty().withMessage('Discount value is required.')
    .isFloat({ min: 0.01 }).withMessage('Discount value must be a positive number.'),
  body('minCart').optional().isFloat({ min: 0 }),
  body('startDate').optional().isISO8601().withMessage('Invalid start date.'),
  body('endDate').optional().isISO8601().withMessage('Invalid end date.'),
  body('message').optional().isLength({ max: 300 }),
  // At least one of customerIds or filterBy must be provided
  body('customerIds').optional().isArray(),
  body('filterBy').optional().isObject(),
  validate
];

const statusValidation = [
  body('status').isIn(['active', 'inactive', 'sent', 'used', 'expired'])
    .withMessage('Invalid status value.'),
  validate
];

// ── Routes ────────────────────────────────────────────────────────────────────

// Preview customers matching filter criteria (before generating)
router.get('/customers/filter', protect, previewCustomers);

// Gift cards for a specific contact
router.get('/contact/:contactId', protect, getGiftCardsForContact);

// Bulk generate
router.post('/generate', protect, generateValidation, generateGiftCards);

// List + (no bulk create route — use /generate)
router.get('/', protect, getGiftCards);

// Single operations
router.get('/:id', protect, getGiftCard);
router.patch('/:id/status', protect, statusValidation, updateGiftCardStatus);
router.delete('/:id', protect, deleteGiftCard);

module.exports = router;