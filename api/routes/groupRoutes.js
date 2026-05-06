// ==================== routes/groupRoutes.js ====================
const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const validate = require('../middlewares/validator');
const { protect } = require('../middlewares/auth');

const {
  createGroup,
  getGroups,
  getGroupById,
  updateGroup,
  deleteGroup,
  addMembers,
  removeMember,
  sendGroupMessage,
  getGroupMessages
} = require('../controllers/groupController');

// Validation
const createGroupValidation = [
  body('groupName').notEmpty().withMessage('Group name is required'),
  body('members').isArray({ min: 1 }).withMessage('At least one member required'),
  validate
];

const addMembersValidation = [
  body('members').isArray({ min: 1 }).withMessage('At least one member required'),
  validate
];

const sendMessageValidation = [
  body('instanceId').notEmpty().withMessage('Instance ID is required'),
  validate
];

// Group CRUD
router.get('/', protect, getGroups);
router.post('/', protect, createGroupValidation, createGroup);
router.get('/:id', protect, getGroupById);
router.put('/:id', protect, updateGroup);
router.delete('/:id', protect, deleteGroup);

// Members
router.post('/:id/members', protect, addMembersValidation, addMembers);
router.delete('/:id/members/:contactId', protect, removeMember);

// Messaging
router.post('/:id/send', protect, sendMessageValidation, sendGroupMessage);
router.get('/:id/messages', protect, getGroupMessages);

module.exports = router;