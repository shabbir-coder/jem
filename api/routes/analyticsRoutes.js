// ==================== routes/analyticsRoutes.js ====================
const express = require('express');
const router  = express.Router();
const { protect } = require('../middlewares/auth');
const {
  getCampaigns,
  getCampaignDetail,
  getOverview,
  getPurchases
} = require('../controllers/analyticsController');

router.get('/overview',           protect, getOverview);
router.get('/campaigns',          protect, getCampaigns);
router.get('/campaigns/:id',      protect, getCampaignDetail);
router.get('/purchases',          protect, getPurchases);

module.exports = router;

// ─────────────────────────────────────────────────────────────
// Register in index.js:
//
//   const analyticsRoutes = require('./routes/analyticsRoutes');
//   app.use('/api/analytics', analyticsRoutes);
// ─────────────────────────────────────────────────────────────