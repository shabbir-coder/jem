// ==================== routes/locationRoutes.js ====================
const express = require('express');
const router  = express.Router();
const { body } = require('express-validator');
const validate = require('../middlewares/validator');
const { protect } = require('../middlewares/auth');
const {
  getLocations,
  createLocation,
  deleteLocation
} = require('../controllers/locationController');

const createValidation = [
  body('name').notEmpty().withMessage('Location name is required.'),
  body('type')
    .optional()
    .isIn(['city', 'state', 'region', 'pincode', 'custom'])
    .withMessage('Invalid location type.'),
  validate
];

// GET  /api/locations         — merged list (contact-derived + saved)
// POST /api/locations         — manually add a new location
router.route('/')
  .get(protect, getLocations)
  .post(protect, createValidation, createLocation);

// DELETE /api/locations/:id   — remove a manually-saved location
router.delete('/:id', protect, deleteLocation);

module.exports = router;