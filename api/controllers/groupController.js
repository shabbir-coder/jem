// ==================== controllers/groupController.js ====================
const { Group, GroupMembers, Contact, Message, Instance, Template } = require('../models');
const axios = require('axios');

// ==================== GROUP CRUD ====================

// @desc    Create new group
// @route   POST /api/groups
// @access  Private
const createGroup = async (req, res) => {
  try {
    const { groupName, description, members, flag } = req.body;

    if (!groupName || !members || members.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Group name and at least one member are required'
      });
    }

    // Create group
    const group = await Group.create({
      groupName,
      description: description || '',
      flag: flag || '',
      status: 'active',
      createdBy: req.user._id
    });

    // Add members
    const memberDocs = [];
    for (const contactNumber of members) {
      // Find or create contact
      let contact = await Contact.findOne({ number: contactNumber });
      
      if (!contact) {
        contact = await Contact.create({
          number: contactNumber,
          name: contactNumber,
          contactType: 'Customer'
        });
      }

      // Create group member entry
      memberDocs.push({
        groupId: group._id.toString(),
        contactId: contact._id.toString(),
        status: 'active'
      });
    }

    await GroupMembers.insertMany(memberDocs);

    // Get populated response
    const populatedGroup = await getPopulatedGroup(group._id);

    res.status(201).json({
      success: true,
      message: 'Group created successfully',
      data: populatedGroup
    });
  } catch (error) {
    console.error('Create group error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// @desc    Get all groups
// @route   GET /api/groups
// @access  Private
const getGroups = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      search,
      status,
      isArchived
    } = req.query;

    const query = { isDeleted: false };

    if (search) {
      query.$or = [
        { groupName: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } }
      ];
    }

    if (status) {
      query.status = status;
    }

    if (isArchived !== undefined) {
      query.isArchived = isArchived === 'true';
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    // COSMOS DB COMPATIBLE: fetch without complex sort, sort in memory
    const allGroups = await Group.find(query)
      .skip(skip)
      .limit(parseInt(limit))
      .lean();

    // Sort in memory: pinned first, then by updatedAt descending
    const groups = allGroups.sort((a, b) => {
      if (b.isPinned !== a.isPinned) return (b.isPinned ? 1 : 0) - (a.isPinned ? 1 : 0);
      return new Date(b.updatedAt) - new Date(a.updatedAt);
    });

    // Get member count for each group
    const groupsWithCounts = await Promise.all(
      groups.map(async (group) => {
        const memberCount = await GroupMembers.countDocuments({
          groupId: group._id.toString(),
          status: 'active'
        });
        return { ...group, memberCount };
      })
    );

    const total = await Group.countDocuments(query);

    res.json({
      success: true,
      data: groupsWithCounts,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// @desc    Get single group with members
// @route   GET /api/groups/:id
// @access  Private
const getGroupById = async (req, res) => {
  try {
    const populatedGroup = await getPopulatedGroup(req.params.id);

    if (!populatedGroup) {
      return res.status(404).json({
        success: false,
        message: 'Group not found'
      });
    }

    res.json({
      success: true,
      data: populatedGroup
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// @desc    Update group
// @route   PUT /api/groups/:id
// @access  Private
const updateGroup = async (req, res) => {
  try {
    const { groupName, description, flag, status, isArchived, isPinned } = req.body;

    const group = await Group.findById(req.params.id);

    if (!group) {
      return res.status(404).json({
        success: false,
        message: 'Group not found'
      });
    }

    if (groupName) group.groupName = groupName;
    if (description !== undefined) group.description = description;
    if (flag !== undefined) group.flag = flag;
    if (status) group.status = status;
    if (isArchived !== undefined) group.isArchived = isArchived;
    if (isPinned !== undefined) group.isPinned = isPinned;

    await group.save();

    const updatedGroup = await getPopulatedGroup(group._id);

    res.json({
      success: true,
      message: 'Group updated successfully',
      data: updatedGroup
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// @desc    Delete group
// @route   DELETE /api/groups/:id
// @access  Private
const deleteGroup = async (req, res) => {
  try {
    const group = await Group.findById(req.params.id);

    if (!group) {
      return res.status(404).json({
        success: false,
        message: 'Group not found'
      });
    }

    group.isDeleted = true;
    group.status = 'inactive';
    await group.save();

    res.json({
      success: true,
      message: 'Group deleted successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// ==================== MEMBER MANAGEMENT ====================

// @desc    Add members to group
// @route   POST /api/groups/:id/members
// @access  Private
const addMembers = async (req, res) => {
  try {
    const { members } = req.body; // Array of contact numbers

    if (!members || members.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'At least one member is required'
      });
    }

    const group = await Group.findById(req.params.id);

    if (!group) {
      return res.status(404).json({
        success: false,
        message: 'Group not found'
      });
    }

    // Get existing members
    const existingMembers = await GroupMembers.find({
      groupId: group._id.toString(),
      status: 'active'
    });

    const existingContactIds = existingMembers.map(m => m.contactId);

    const memberDocs = [];
    for (const contactNumber of members) {
      let contact = await Contact.findOne({ number: contactNumber });
      
      if (!contact) {
        contact = await Contact.create({
          number: contactNumber,
          name: contactNumber,
          contactType: 'Customer'
        });
      }

      // Check if already member
      if (!existingContactIds.includes(contact._id.toString())) {
        memberDocs.push({
          groupId: group._id.toString(),
          contactId: contact._id.toString(),
          status: 'active'
        });
      }
    }

    if (memberDocs.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'All contacts are already members'
      });
    }

    await GroupMembers.insertMany(memberDocs);

    const updatedGroup = await getPopulatedGroup(group._id);

    res.json({
      success: true,
      message: `${memberDocs.length} member(s) added successfully`,
      data: updatedGroup
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// @desc    Remove member from group
// @route   DELETE /api/groups/:id/members/:contactId
// @access  Private
const removeMember = async (req, res) => {
  try {
    const { contactId } = req.params;

    const member = await GroupMembers.findOne({
      groupId: req.params.id,
      contactId: contactId
    });

    if (!member) {
      return res.status(404).json({
        success: false,
        message: 'Member not found in group'
      });
    }

    member.status = 'inactive';
    await member.save();

    res.json({
      success: true,
      message: 'Member removed successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// ==================== GROUP MESSAGING ====================

// @desc    Send message to all group members
// @route   POST /api/groups/:id/send
// @access  Private
const sendGroupMessage = async (req, res) => {
  try {
    const { text, mediaUrl, mediaType, caption, templateId, instanceId } = req.body;

    if (!text && !mediaUrl && !templateId) {
      return res.status(400).json({
        success: false,
        message: 'Message text, media, or template is required'
      });
    }

    const group = await Group.findById(req.params.id);

    if (!group || group.isDeleted) {
      return res.status(404).json({
        success: false,
        message: 'Group not found'
      });
    }

    // Get active members
    const members = await GroupMembers.find({
      groupId: group._id.toString(),
      status: 'active'
    });

    if (members.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No active members in group'
      });
    }

    // Get contacts
    const contactIds = members.map(m => m.contactId);
    const contacts = await Contact.find({
      _id: { $in: contactIds }
    });

    // Get instance
    const instance = await Instance.findOne({
      numberId: instanceId,
      isActive: true,
      isDeleted: false
    });

    if (!instance) {
      return res.status(404).json({
        success: false,
        message: 'Instance not found'
      });
    }

    // Send messages in background
    sendBulkToContacts({
      contacts,
      instance,
      text,
      mediaUrl,
      mediaType,
      caption,
      templateId,
      groupId: group._id
    });

    res.json({
      success: true,
      message: 'Group message queued for delivery',
      data: {
        groupId: group._id,
        totalRecipients: contacts.length,
        status: 'processing'
      }
    });
  } catch (error) {
    console.error('Send group message error:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// @desc    Get group messages (messages from all group members)
// @route   GET /api/groups/:id/messages
// @access  Private
const getGroupMessages = async (req, res) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const group = await Group.findById(req.params.id);

    if (!group) {
      return res.status(404).json({
        success: false,
        message: 'Group not found'
      });
    }

    // Get active members
    const members = await GroupMembers.find({
      groupId: group._id.toString(),
      status: 'active'
    });

    const contactIds = members.map(m => m.contactId);
    const contacts = await Contact.find({
      _id: { $in: contactIds }
    });

    const contactNumbers = contacts.map(c => c.number);

    // COSMOS DB COMPATIBLE: no .sort(), no .populate() — manual
    const allMessages = await Message.find({
      $or: [
        { sender: { $in: contactNumbers } },
        { receiver: { $in: contactNumbers } }
      ]
    })
      .skip(skip)
      .limit(parseInt(limit))
      .lean();

    // Sort in memory descending, then reverse for chronological
    allMessages.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    // Manual populate file
    const fileIds = allMessages.map(m => m.file).filter(Boolean);
    const { File } = require('../models');
    const files = fileIds.length ? await File.find({ _id: { $in: fileIds } }).lean() : [];
    const fileMap = {};
    files.forEach(f => { fileMap[f._id.toString()] = f; });

    const messages = allMessages.map(m => ({
      ...m,
      file: m.file ? fileMap[m.file.toString()] || m.file : null
    }));

    const total = await Message.countDocuments({
      $or: [
        { sender: { $in: contactNumbers } },
        { receiver: { $in: contactNumbers } }
      ]
    });

    res.json({
      success: true,
      data: messages.reverse(),
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// ==================== HELPER FUNCTIONS ====================

const getPopulatedGroup = async (groupId) => {
  const group = await Group.findById(groupId).lean();
  
  if (!group) return null;

  const members = await GroupMembers.find({
    groupId: groupId.toString(),
    status: 'active'
  });

  const contactIds = members.map(m => m.contactId);
  const contacts = await Contact.find({
    _id: { $in: contactIds }
  }).select('name number status lastMessageAt');

  return {
    ...group,
    members: contacts,
    memberCount: contacts.length
  };
};

const sendBulkToContacts = async ({
  contacts,
  instance,
  text,
  mediaUrl,
  mediaType,
  caption,
  templateId,
  groupId
}) => {
  try {
    const graphURL = `${process.env.META_API}/${instance.numberId}/messages`;
    const headers = {
      Authorization: `Bearer ${instance.accessToken}`,
      'Content-Type': 'application/json'
    };

    let template = null;
    if (templateId) {
      template = await Template.findById(templateId);
    }

    for (let i = 0; i < contacts.length; i++) {
      const contact = contacts[i];
      
      try {
        let payload;
        let messageId;

        if (template) {
          const bindValues = {};
          for (const param of template.parameters || []) {
            const { key, bindValue } = param;
            bindValues[key] = contact[bindValue] || '';
          }

          const components = [];
          
          if (template.mediaUrl && template.mediaType) {
            components.push({
              type: 'header',
              parameters: [{
                type: template.mediaType,
                [template.mediaType]: {
                  link: process.env.IMAGE_URL + template.mediaUrl
                }
              }]
            });
          }

          if (Object.keys(bindValues).length > 0) {
            components.push({
              type: 'body',
              parameters: Object.entries(bindValues).map(([key, value]) => ({
                type: 'text',
                text: String(value)
              }))
            });
          }

          payload = {
            messaging_product: 'whatsapp',
            to: contact.number,
            type: 'template',
            template: {
              name: template.templateName,
              language: { code: template.languageCode || 'en' },
              components
            }
          };
        } else if (mediaUrl) {
          payload = {
            messaging_product: 'whatsapp',
            to: contact.number,
            type: mediaType || 'image',
            [mediaType || 'image']: {
              link: mediaUrl,
              ...(caption ? { caption } : {})
            }
          };
        } else {
          payload = {
            messaging_product: 'whatsapp',
            to: contact.number,
            type: 'text',
            text: { body: text }
          };
        }

        const response = await axios.post(graphURL, payload, { headers });
        messageId = response.data.messages?.[0]?.id;

        // Save regular message
        await Message.create({
          messageId,
          sender: instance.number.toString(),
          receiver: contact.number,
          instance_id: instance.numberId,
          text: text || caption || '',
          type: mediaUrl ? (mediaType || 'image') : 'text',
          isGroupMessage : true,
          groupId : groupId,
          status: [{
            status: 'sent',
            timeStamp: new Date()
          }]
        });

        // Update contact
        await Contact.findOneAndUpdate(
          { number: contact.number },
          { $set: { lastMessageAt: new Date() } }
        );

        // Rate limiting
        await new Promise(resolve => setTimeout(resolve, 2000));

      } catch (error) {
        console.error(`Failed to send to ${contact.number}:`, error.message);
      }
    }

  } catch (error) {
    console.error('Bulk send error:', error);
  }
};

module.exports = {
  createGroup,
  getGroups,
  getGroupById,
  updateGroup,
  deleteGroup,
  addMembers,
  removeMember,
  sendGroupMessage,
  getGroupMessages
};