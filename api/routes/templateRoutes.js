// ==================== routes/templateRoutes.js ====================
const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/auth');
const {
  getAllTemplates,
  getTemplateById,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  syncTemplatesFromMeta,
  handleMetaTemplateWebhook
} = require('../controllers/templateController');

// ── Public: Meta webhook (no auth — Meta POSTs here on status change) ──────
router.post('/webhook', handleMetaTemplateWebhook);

// ── Private ────────────────────────────────────────────────────────────────
router.get('/', protect, getAllTemplates);
router.get('/:id', protect, getTemplateById);
router.post('/', protect, createTemplate);
router.put('/:id', protect, updateTemplate);
router.delete('/:id', protect, deleteTemplate);

// Manual full sync from Meta (admin trigger)
router.post('/sync', protect, syncTemplatesFromMeta);

module.exports = router;