const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const validate = require('../middlewares/validator');
const { protect } = require('../middlewares/auth');
const {
  verifyWebhook,
  receiveWebhook,
  getConversations,
  getMessages,
  sendMessage,
  sendMediaMessage,
  replyToMessage,
  reactToMessage,
  sendBulkTemplate,
  getUnreadCount,
  uploadFile
} = require('../controllers/chatController');
const { uploadMultiple, handleUploadError } = require('../middlewares/upload');

// Webhook routes (public)
router.get('/webhook', verifyWebhook);
router.post('/webhook', receiveWebhook);

// Message validation
const sendMessageValidation = [
  body('to').notEmpty().withMessage('Recipient number is required'),
  body('text').notEmpty().withMessage('Message text is required'),
  body('instanceId').notEmpty().withMessage('Instance ID is required'),
  validate
];

const sendMediaValidation = [
  body('to').notEmpty().withMessage('Recipient number is required'),
  body('mediaType').isIn(['image', 'video', 'audio', 'document']).withMessage('Invalid media type'),
  body('mediaUrl').isURL().withMessage('Valid media URL is required'),
  body('instanceId').notEmpty().withMessage('Instance ID is required'),
  validate
];

const replyValidation = [
  body('to').notEmpty().withMessage('Recipient number is required'),
  body('text').notEmpty().withMessage('Message text is required'),
  body('replyToMessageId').notEmpty().withMessage('Reply to message ID is required'),
  body('instanceId').notEmpty().withMessage('Instance ID is required'),
  validate
];

const reactValidation = [
  body('to').notEmpty().withMessage('Recipient number is required'),
  body('messageId').notEmpty().withMessage('Message ID is required'),
  body('emoji').notEmpty().withMessage('Emoji is required'),
  body('instanceId').notEmpty().withMessage('Instance ID is required'),
  validate
];

// Protected routes
router.get('/conversations', protect, getConversations);
router.get('/unread', protect, getUnreadCount);
router.get('/:userNumber', protect, getMessages);
router.post('/send', protect, sendMessageValidation, sendMessage);
router.post('/sendBulkMessage', protect, sendBulkTemplate);
router.post('/send-media', protect, sendMediaValidation, sendMediaMessage);
router.post('/reply', protect, replyValidation, replyToMessage);
router.post('/react', protect, reactValidation, reactToMessage);

router.route('/file') 
  .post(protect, uploadMultiple, handleUploadError, uploadFile);

module.exports = router;