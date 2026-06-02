// ==================== api/routes/index.js ====================
const express = require('express');
const router = express.Router();

// Import route modules
const authRoutes = require('./authRoutes');
const productRoutes = require('./productRoutes');
const fileRoutes = require('./fileRoutes');
const chatRoutes = require('./chatRoutes');
const instanceRoutes = require('./instanceRoutes');
const websiteRoutes = require('./websiteRoutes');
const contactRoutes = require('./contactRoutes');
const templateRoutes = require('./templateRoutes');
const groupRoutes = require('./groupRoutes');
const walletRoutes = require('./walletRoutes');
const analyticsRoutes = require('./analyticsRoutes');
const discountRoutes = require('./discountRoutes');

// Mount routes
router.use('/auth', authRoutes);
router.use('/products', productRoutes);
router.use('/files', fileRoutes);
router.use('/chats', chatRoutes);
router.use('/instances', instanceRoutes);
router.use('/website', websiteRoutes);
router.use('/contacts', contactRoutes);
router.use('/templates', templateRoutes);
router.use('/groups', groupRoutes);
router.use('/wallet', walletRoutes);
router.use('/analytics', analyticsRoutes);
router.use('/discounts', discountRoutes);

// Health check
router.get('/health', (req, res) => {
  res.json({
    success: true,
    message: 'API is running',
    timestamp: new Date().toISOString()
  });
});

module.exports = router;