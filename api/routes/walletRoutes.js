// ==================== routes/walletRoutes.js ====================
const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/auth');
const {
  getWallet,
  getCampaignCostPreview,
  topupWallet,
  getCampaigns
} = require('../controllers/walletController');

router.get('/', protect, getWallet);
router.post('/topup', protect, topupWallet);
router.post('/campaign-cost-preview', protect, getCampaignCostPreview);
router.get('/campaigns', protect, getCampaigns);

module.exports = router;