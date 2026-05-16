// ==================== controllers/chatController.js ====================
const { Message, Contact, ChatLog, File, Instance, MessageStatus, MessageType,   Group,GroupMembers ,CustomerInfo, FileStatus ,Template ,Cart ,Product, Invoice, Purchase , PaymentStatus, CampaignLog} = require('../models');
const whatsappAPI = require('../utils/whatsappAPI');
const { deductCampaignCost } = require('./walletController');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const pdf = require('html-pdf');
const handlebars = require('handlebars');
const {
  getOrCreateWallet,
  buildCostBreakdown,
  generateCampaignId
} = require('./walletController');


// @desc    WhatsApp webhook verification
// @route   GET /api/chats/webhook
// @access  Public
const verifyWebhook = (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  // You can set a verify token in your instance or use a global one
  const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || 'your_verify_token';

  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('Webhook verified');
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  }
};

// @desc    WhatsApp webhook receiver
// @route   POST /api/chats/webhook
// @access  Public
const receiveWebhook = async (req, res) => {
  try {
    const body = req.body;

    if (body.object === 'whatsapp_business_account') {
      const entries = body.entry || [];
      for (const entry of entries) {
        const changes = entry.changes || [];
        for (const change of changes) {
          const value = change.value;
            
          // Handle messages
          if (value.messages) {
            for (const message of value.messages) {
              await handleIncomingMessage(message, value);
            }
          }

          // Handle message status updates
          if (value.statuses) {
            for (const status of value.statuses) {
              await handleMessageStatus(status);
            }
          }
        }
      }
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('Webhook error:', error);
    res.sendStatus(500);
  }
};

// Handle incoming message
const handleIncomingMessage = async (message, value) => {
  try {
    // Prevent duplicates
    console.log('icoming message', message)
    if (await Message.exists({ messageId: message.id })) return;

    const sender = message.from;
    const phoneNumberId = value.metadata.phone_number_id;
    const type = message.type;
    
    const contactName = value?.contacts?.[0]?.profile?.name || "";

    const instance = await Instance.findOne({
      numberId: phoneNumberId,
      isActive: true,
      isDeleted: false
    });
    if (!instance) return;

    const existingContact = await Contact.findOne({ number: sender });

     if (existingContact) {

      const updateData = {
        lastMessageAt: new Date(),
        lastMessageId: message.id
      };

      // if contact exists but name missing
      if (!existingContact.name && contactName) {
        updateData.name = contactName;
      }

      await Contact.updateOne(
        { number: sender },
        {
          $set: updateData,
          $inc: { unreadCount: 1 }
        }
      );

    } else {

      await Contact.create({
        number: sender,
        name: contactName,
        lastMessageAt: new Date(),
        lastMessageId: message.id,
        unreadCount: 1
      });

    }

    const messageData = {
      messageId: message.id,
      sender,
      receiver: value.metadata.display_phone_number,
      instance_id: instance._id.toString(),
      type,
      status: [{
        status: MessageStatus.RECEIVED,
        timeStamp: new Date()
      }]
    };

    if (type === 'text') {
      messageData.text = message.text.body;
    }

    if (['image', 'video', 'audio', 'document'].includes(type)) {
      const fileDoc = await saveWhatsAppFile(message, instance);
      if (fileDoc) {
        messageData.file = fileDoc._id;
        messageData.text = message[type]?.caption || '';
      }
    }

    if (type === 'location') {
      messageData.location = {
        latitude: message.location.latitude,
        longitude: message.location.longitude,
        name: message.location.name,
        address: message.location.address
      };
    }

    if (type === 'reaction') {
      await Message.findOneAndUpdate(
        { messageId: message.reaction.message_id },
        {
          $push: {
            reactions: {
              emoji: message.reaction.emoji,
              from: sender,
              timestamp: new Date()
            }
          }
        }
      );
      return;
    }

    if (message.context) {
      messageData.context = {
        messageId: message.context.id,
        from: message.context.from
      };
    }

    await Message.create(messageData);
    
    await runLLMAgentAndReply({
      message,
      fileDoc: messageData.file ? await File.findById(messageData.file) : null,
      locationData : messageData.location || null ,
      sender,
      instance
    });

    await whatsappAPI.markAsRead(phoneNumberId, message.id);
  } catch (error) {
    console.error('Handle incoming message error:', error);
  }
};

// Handle message status updates
const handleMessageStatus = async (status) => {
  try {
    // COSMOS DB COMPATIBLE: fetch, modify in memory, then save (avoids $slice in $push)
    const msg = await Message.findOne({
      messageId: status.id,
      'status.status': { $ne: status.status } // avoid duplicates
    });

    if (!msg) return;

    // Append new status entry
    msg.status.push({ status: status.status, timeStamp: new Date() });

    // Keep only last 10 statuses in memory
    if (msg.status.length > 10) {
      msg.status = msg.status.slice(-10);
    }

    if (status.status === 'read') {
      msg.isRead = true;
      msg.readAt = new Date();
    }

    await msg.save();
  } catch (error) {
    console.error('Handle message status error:', error);
  }
};

// @desc    Get all conversations (contacts with messages)
// @route   GET /api/chats/conversations
const getConversations = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      readFilter,
      status,
      search,
      archived
    } = req.query;

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    /* ================================
       CONTACT MATCH FILTER
    ================================= */
    const contactMatch = {};

    if (status) {
      contactMatch.status = status;
    }

    if (archived !== undefined) {
      contactMatch.isArchived = archived === 'true';
    }

    if (readFilter === 'unread') {
      contactMatch.unreadCount = { $gt: 0 };
    }

    if (readFilter === 'read') {
      contactMatch.unreadCount = 0;
    }

    if (search) {
      contactMatch.$or = [
        { name: { $regex: search, $options: 'i' } },
        { number: { $regex: search, $options: 'i' } }
      ];
    }
    /* ================================
       COSMOS DB COMPATIBLE: fetch contacts, then join last message in memory
    ================================= */
    const [allContacts, totalResult] = await Promise.all([
      Contact.find(contactMatch).lean(),
      Contact.countDocuments(contactMatch)
    ]);

    // For each contact, find the last message (in parallel, batched)
    const contactNumbers = allContacts.map(c => c.number);

    // Fetch the most recent message per contact number using simple queries
    const lastMessages = await Promise.all(
      contactNumbers.map(num =>
        Message.findOne({
          $or: [{ sender: num }, { receiver: num }]
        })
          .sort({ createdAt: -1 })
          .lean()
          .catch(() => null)
      )
    );

    // Attach lastMessage to each contact, then sort + paginate in memory
    let data = allContacts.map((contact, i) => ({
      ...contact,
      lastMessage: lastMessages[i] || null
    }));

    // Sort: contacts with most recent message/activity first
    data.sort((a, b) => {
      const aTime = a.lastMessageAt ? new Date(a.lastMessageAt) : (a.lastMessage ? new Date(a.lastMessage.createdAt) : new Date(0));
      const bTime = b.lastMessageAt ? new Date(b.lastMessageAt) : (b.lastMessage ? new Date(b.lastMessage.createdAt) : new Date(0));
      return bTime - aTime;
    });

    // Paginate in memory
    data = data.slice(skip, skip + limitNum);

    res.json({
      success: true,
      data,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: totalResult,
        pages: Math.ceil(totalResult / limitNum)
      }
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};


// @desc    Get messages for a conversation
// @route   GET /api/chats/:userNumber
// @access  Private
const getMessages = async (req, res) => {
  try {
    const { userNumber } = req.params;
    const { page = 1, limit = 50 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    // _id is ALWAYS indexed, so this works in Cosmos DB
    const messages = await Message.find({
      $or: [
        { sender: userNumber },
        { receiver: userNumber }
      ]
    })
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(parseInt(limit))
    .lean();

    // Rest of the code remains same...
    const fileIds = messages.map(m => m.file).filter(Boolean);
    const files = fileIds.length ? await File.find({ _id: { $in: fileIds } }).lean() : [];
    const fileMap = {};
    files.forEach(f => { fileMap[f._id.toString()] = f; });

    const messagesWithFiles = messages.map(m => ({
      ...m,
      file: m.file ? fileMap[m.file.toString()] || m.file : null
    }));

    const total = await Message.countDocuments({
      $or: [
        { sender: userNumber },
        { receiver: userNumber }
      ]
    });

    await Message.updateMany(
      { sender: userNumber, isRead: false },
      { isRead: true, readAt: new Date() }
    );

    await Contact.findOneAndUpdate(
      { number: userNumber },
      { unreadCount: 0 }
    );

    res.json({
      success: true,
      data: messagesWithFiles.reverse(),
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

// @desc    Send text message
// @route   POST /api/chats/send
// @access  Private
const sendMessage = async (req, res) => {
  try {
    const { to, text, instanceId } = req.body;

    // Verify instance
    const instance = await Instance.findOne({
      numberId: instanceId,
      isActive: true,
      isDeleted: false
    });

    if (!instance) {
      return res.status(400).json({
        success: false,
        message: 'Invalid or inactive instance'
      });
    }

    // Send WhatsApp message
    const result = await whatsappAPI.sendMessage(instanceId, to, text);

    const messageId = result?.messages?.[0]?.id;

    if (!messageId) {
      return res.status(500).json({
        success: false,
        message: 'Failed to send message via WhatsApp'
      });
    }

    const now = new Date();

    // Prepare DB operations
    const messagePromise = Message.create({
      messageId,
      sender: instance.number.toString(),
      receiver: to,
      instance_id: instanceId,
      text,
      type: 'text',
      status: [
        {
          status: MessageStatus.SENT,
          timeStamp: now
        }
      ]
    });

    const contactPromise = Contact.findOneAndUpdate(
      { number: to },
      {
        $set: { lastMessageAt: now },
        $setOnInsert: { number: to }
      },
      { upsert: true }
    );

    const llmPromise = axios.post(
      `${process.env.LLM_API}/api/ecommerce/include_message`,
      {
        phone_number: `+${to}`,
        message: text
      }
    ).catch(err => {
      console.error('LLM API failed:', err?.response?.data || err.message);
      return null;
    });

    // Run parallel
    const [message] = await Promise.all([
      messagePromise,
      contactPromise,
      llmPromise
    ]);

    res.json({
      success: true,
      message: 'Message sent successfully',
      data: message
    });

  } catch (error) {
    console.error('Send message error:', error);

    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};
// @desc    Send media message
// @route   POST /api/chats/send-media
// @access  Private
const sendMediaMessage = async (req, res) => {
  try {
    const { to, mediaType, mediaUrl, caption, instanceId } = req.body;

    // Verify instance
    const instance = await Instance.findOne({
      numberId: instanceId,
      isActive: true,
      isDeleted: false
    });
    if (!instance || !instance.isActive) {
      return res.status(400).json({
        success: false,
        message: 'Invalid or inactive instance'
      });
    }

    // Send via WhatsApp API
    const result = await whatsappAPI.sendMedia(instanceId, to, mediaType, mediaUrl, caption);

    // Save to database
    const message = await Message.create({
      messageId: result.messages[0].id,
      sender: instance.number.toString(),
      receiver: to,
      instance_id: instanceId,
      text: caption || '',
      type: mediaType,
      status:  [
        {
          status: MessageStatus.SENT,
          timeStamp: new Date()
        }
      ]
    });

    res.json({
      success: true,
      message: 'Media message sent successfully',
      data: message
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// @desc    Reply to a message
// @route   POST /api/chats/reply
// @access  Private
const replyToMessage = async (req, res) => {
  try {
    const { to, text, replyToMessageId, instanceId } = req.body;

    // Verify instance
    const instance = await Instance.findOne({
      numberId: instanceId,
      isActive: true,
      isDeleted: false
    });
    if (!instance || !instance.isActive) {
      return res.status(400).json({
        success: false,
        message: 'Invalid or inactive instance'
      });
    }

    // Send via WhatsApp API
    const result = await whatsappAPI.replyToMessage(instanceId, to, text, replyToMessageId);

    // Save to database
    const message = await Message.create({
      messageId: result.messages[0].id,
      sender: instance.number.toString(),
      receiver: to,
      instance_id: instanceId,
      text: text,
      type: 'text',
      context: {
        messageId: replyToMessageId
      },
      status:  [
        {
          status: MessageStatus.SENT,
          timeStamp: new Date()
        }
      ]
    });

    res.json({
      success: true,
      message: 'Reply sent successfully',
      data: message
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// @desc    React to a message
// @route   POST /api/chats/react
// @access  Private
const reactToMessage = async (req, res) => {
  try {
    const { to, messageId, emoji, instanceId } = req.body;

    // Verify instance
    const instance = await Instance.findOne({
      numberId: instanceId,
      isActive: true,
      isDeleted: false
    });
    if (!instance || !instance.isActive) {
      return res.status(400).json({
        success: false,
        message: 'Invalid or inactive instance'
      });
    }

    // Send reaction via WhatsApp API
    await whatsappAPI.reactToMessage(instanceId, to, messageId, emoji);

    // Update message in database
    await Message.findOneAndUpdate(
      { messageId: messageId },
      {
        $push: {
          reactions: {
            emoji: emoji,
            from: instance.number.toString(),
            timestamp: new Date()
          }
        }
      }
    );

    res.json({
      success: true,
      message: 'Reaction sent successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

const uploadFile = async(req, res)=>{
    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: 'No file uploaded'
        });
      }
  
  
      const { entityType, entityId, altText, caption } = req.body;
  
      const fileType = req.file.mimetype.startsWith('image/') ? 'image' : 
                      req.file.mimetype.startsWith('video/') ? 'video' :
                      req.file.mimetype.startsWith('audio/') ? 'audio' : 'document';
  
      const file = await File.create({
        fileName: req.file.filename,
        originalName: req.file.originalname,
        fileType: fileType,
        mimeType: req.file.mimetype,
        fileSize: req.file.size,
        url: `${req.protocol}://${req.get('host')}/uploads/messages/${req.file.filename}`,
        path: `/uploads/messages/${req.file.filename}`,
        altText: altText || '',
        caption: caption || '',
        uploadedBy: req.user._id,
        entityType: entityType || 'other',
        entityId: entityId || null
      });
  
      res.status(201).json({
        success: true,
        message: 'File uploaded successfully',
        data: file
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: error.message
      });
    }
}

// @desc    Get unread message count
// @route   GET /api/chats/unread
// @access  Private
const getUnreadCount = async (req, res) => {
  try {
    // COSMOS DB COMPATIBLE: fetch unreadCount values and sum in memory
    const contacts = await Contact.find({ unreadCount: { $gt: 0 } }).select('unreadCount').lean();
    const totalUnread = contacts.reduce((sum, c) => sum + (c.unreadCount || 0), 0);

    res.json({
      success: true,
      data: {
        unreadCount: totalUnread || 0
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

const saveWhatsAppFile = async (message, instance) => {
  try {
    const type = message.type;
    const media = message[type];
    if (!media?.id) return null;

    const accessToken = instance.accessToken;
    const mediaId = media.id;

    // Fetch metadata
    const metaRes = await axios.get(
      `${process.env.META_API}/${mediaId}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    // Download binary
    const fileRes = await axios.get(metaRes.data.url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      responseType: 'arraybuffer'
    });

    const buffer = Buffer.from(fileRes.data);

    // Save locally
    const uploadsDir = path.join(__dirname, '../../uploads/messages');
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    const extension = metaRes.data.mime_type.split('/')[1] || 'bin';
    const fileName = `${mediaId}.${extension}`;
    const filePath = path.join(uploadsDir, fileName);

    fs.writeFileSync(filePath, buffer);

    const fileUrl = `${process.env.FILE_URL}/uploads/messages/${fileName}`;

    // Save File document
    const fileDoc = await File.create({
      fileName,
      originalName: media.filename || fileName,
      fileType: type,
      mimeType: metaRes.data.mime_type,
      fileSize: metaRes.data.file_size || buffer.length,
      url: fileUrl,
      path: filePath,
      caption: media.caption || '',
      entityType: 'message',
      entityId: message.id,
      status: FileStatus.ACTIVE
    });

    return fileDoc;
  } catch (err) {
    console.error('❌ Media save error:', err?.response?.data || err);
    return null;
  }
};

const runLLMAgentAndReply = async ({
  message,
  fileDoc,
  locationData,
  sender,
  instance,
  contactName = 'Customer'}) => {
  try {
    const isFile = !!fileDoc;

    const isLocation = !!locationData;
    
    // Generate Google Maps link if location is shared
    let googleMapsLink = null;
    if (isLocation) {
      googleMapsLink = `https://www.google.com/maps?q=${locationData.latitude},${locationData.longitude}`;
    }
    
    const payload = {
      phone_number: sender.startsWith('+') ? sender : `+${sender}`,
      user_name: contactName,
      message: isFile ? null : message?.text?.body || googleMapsLink || '',
      is_file: isFile,
      file_type: isFile ? fileDoc.fileType : null,
      file_path: isFile ? fileDoc.url : null
    };
    

    console.log('🤖 LLM Payload:', payload);

    const llmRes = await axios.post(
      `${process.env.LLM_API}/api/ecommerce/message`,
      payload,
      { timeout: 30000 }
    );


console.log('llmResponse', llmRes)
    if (llmRes.data.status !== 'success') {
      console.error('❌ LLM Error:', llmRes.data);
      return;
    }

    await sendLLMResponseViaMeta({
      llmResponse: llmRes.data,
      sender,
      instance
    });
  } catch (error) {
    console.error('🔥 LLM processing error:', error?.response?.data || error);
  }
};

const sendLLMResponseViaMeta = async ({ llmResponse, sender, instance }) => {
  try {
    console.log('llmResponse in function', llmResponse);

    const phoneNumberId = instance.numberId;
    const token = instance.accessToken;

    const graphURL = `${process.env.META_API}/${phoneNumberId}/messages`;

    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    };

    const responseType = llmResponse.response_type;
    const text = llmResponse.response;

    // ===============================
    // 1️⃣ TEXT ONLY
    // ===============================
    if (responseType === 'text' && text) {
      const payload = {
        messaging_product: 'whatsapp',
        to: sender,
        type: 'text',
        text: { body: text }
      };

      const res = await axios.post(graphURL, payload, { headers });
      const messageId = res.data.messages?.[0]?.id;

      if (messageId) {
        await Message.create({
          messageId,
          sender: instance.number.toString(),
          receiver: sender,
          instance_id: instance._id.toString(),
          text,
          type: 'text',
          status: [{ status: MessageStatus.SENT, timeStamp: new Date() }]
        });
      }
    }

    // ===============================
    // 2️⃣ IMAGE / IMAGE + TEXT
    // ===============================
    if (
      ['image', 'both'].includes(responseType) &&
      Array.isArray(llmResponse.image_urls)
    ) {

      const totalImages = llmResponse.image_urls.length;

      for (let i = 0; i < totalImages; i++) {
        const imageUrl = llmResponse.image_urls[i];

        const fileDoc = await File.findOne({ url: imageUrl });

        if (!fileDoc) {
          console.warn(`⚠️ File not found for URL: ${imageUrl}`);
          continue;
        }

        const isLastImage = i === totalImages - 1;

        const payload = {
          messaging_product: 'whatsapp',
          to: sender,
          type: 'image',
          image: {
            link: imageUrl,
            ...(responseType === 'both' && text && isLastImage
              ? { caption: text }
              : {})
          }
        };

        const res = await axios.post(graphURL, payload, { headers });

        const messageId = res.data.messages?.[0]?.id;

        if (messageId) {
          await Message.create({
            messageId,
            sender: instance.number.toString(),
            receiver: sender,
            instance_id: instance._id.toString(),
            text: isLastImage && responseType === 'both' ? text : '',
            type: 'image',
            file: fileDoc._id,
            status: [{ status: MessageStatus.SENT, timeStamp: new Date() }]
          });
        }
      }
    }

  } catch (error) {
    console.error('🔥 Meta send error:', error?.response?.data || error);
  }
};

const generateOrderId = async () => {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

  while (true) {
    const randomLetters =
      letters[Math.floor(Math.random() * 26)] +
      letters[Math.floor(Math.random() * 26)] +
      letters[Math.floor(Math.random() * 26)];

    const randomNumbers = Math.floor(1000 + Math.random() * 9000);

    const orderId = `${randomLetters}${randomNumbers}`;

    const exists = await Purchase.exists({ orderId });

    if (!exists) return orderId;
  }
};

const saveOwnerNotificationMessage = async ({
  instance,
  ownerNumber,
  pdfPublicUrl,
  pdfFileName,
  captionText,
  messageId,          // returned by Meta API
  campaignLogId = null,
  templateId    = null
}) => {
  // 1. File record (type = document, so the chat UI can render it)
  const fileDoc = await File.create({
    fileName:     pdfFileName,
    originalName: pdfFileName,
    fileType:     'document',
    mimeType:     'application/pdf',
    fileSize:     0,
    url:          pdfPublicUrl,
    path:         pdfPublicUrl,
    caption:      captionText,
    entityType:   'message'
  });
 
  // 2. Message record — matches chatSchema fields
  //    messageType / templateId / campaignId are extra fields that exist on the
  //    processContact() messages; they're safe to include even if schema doesn't
  //    have them (Mongoose silently ignores unknown fields unless strict:true is
  //    overridden — but processContact already does the same thing successfully).
  const message = await Message.create({
    messageId,
    sender:      instance.number.toString(),
    receiver:    ownerNumber,
    instance_id: instance.numberId,
    text:        captionText,
    type:        'document',
    file:        fileDoc._id,
    ...(templateId    && { templateId }),
    ...(campaignLogId && { campaignId: campaignLogId }),
    ...(templateId    && { messageType: 'template' }),
    status: [{ status: MessageStatus.SENT, timeStamp: new Date() }]
  });
 
  // 3. ChatLog (same as processContact)
  await ChatLog.create({
    sender:      instance.number.toString(),
    receiver:    ownerNumber,
    instance_id: instance.numberId,
    usedFile:    fileDoc._id,
    action:      'sent',
    metadata: {
      ...(templateId && { templateId }),
      source: 'order-notification'
    }
  });
 
  // 4. Update / upsert the owner contact so conversation appears in chat
  await Contact.findOneAndUpdate(
    { number: ownerNumber },
    {
      $set:         { lastMessageAt: new Date() },
      $setOnInsert: { number: ownerNumber }
    },
    { upsert: true, new: true }
  );
 
  return message;
};
 
// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL HELPER — deduct wallet without checking balance (order notifications
// must go through even if wallet is zero / negative).
// Creates a CampaignLog and records a single debit transaction.
// ─────────────────────────────────────────────────────────────────────────────
const deductOrderNotificationCost = async ({
  instance,
  template,
  ownerContacts   // array of { number } objects representing business owners
}) => {
  const templateCategory = (template.category || 'marketing').toLowerCase();
 
  // Build cost breakdown against owner numbers
  const { breakdown, totalCost } = await buildCostBreakdown(ownerContacts, templateCategory);
 
  const wallet = await getOrCreateWallet(instance.createdBy || instance._id);
 
  const balanceBefore = wallet.balance;
  wallet.balance = parseFloat((wallet.balance - totalCost).toFixed(4));
 
  const campaignId = await generateCampaignId(template.templateName || template.name || 'neworder');
 
  const campaignLog = await CampaignLog.create({
    campaignId,
    userId:             instance.createdBy || instance._id,
    templateId:         template._id,
    templateName:       template.templateName || template.name,
    templateCategory,
    viewMode:           'contacts',
    totalRecipients:    ownerContacts.length,
    totalCost,
    breakdownByCountry: breakdown,
    walletBalanceBefore: balanceBefore,
    walletBalanceAfter:  wallet.balance,
    status: 'queued'
  });
 
  wallet.transactions.push({
    type:        'debit',
    amount:      totalCost,
    description: `Order Notification [${campaignId}] — ${ownerContacts.length} owner(s) (${templateCategory})`,
    campaignId:  campaignLog._id,
    balanceAfter: wallet.balance
  });
 
  // { validateBeforeSave: false } bypasses walletSchema's min:0 constraint
  await wallet.save({ validateBeforeSave: false });
 
  // Mark campaign as processing immediately (owners are few, send is fast)
  await CampaignLog.findByIdAndUpdate(campaignLog._id, { status: 'processing' });
 
  return { campaignLog, campaignId, totalCost, balanceBefore, balanceAfter: wallet.balance };
};

const messageToOwnerTemplate = async (req, res) => {
  try {
    const { mediaUrl, contactNumber, message, orderDetails } = req.body;
 
    console.log(JSON.stringify(req.body));
 
    // ── VALIDATION ──────────────────────────────────────────────────────────
    if (!contactNumber) {
      return res.status(400).json({ success: false, message: 'contactNumber is required' });
    }
    if (!orderDetails?.items?.length) {
      return res.status(400).json({ success: false, message: 'orderDetails with items is required' });
    }
 
    // ── 1. ACTIVE INSTANCE ───────────────────────────────────────────────────
    const instance = await Instance.findOne({ isActive: true, isDeleted: false }).lean();
    if (!instance) {
      return res.status(404).json({ success: false, message: 'No active WhatsApp instance found' });
    }
    if (!instance.businessOwners?.length) {
      return res.status(400).json({ success: false, message: 'No business owners configured' });
    }
 
    // ── 2. TEMPLATE ──────────────────────────────────────────────────────────
    const template = await Template.findOne({ name: 'neworder' }).lean();
    if (!template) {
      return res.status(404).json({ success: false, message: 'neworder template not found' });
    }
 
    // ── 3. CONTACT / ADDRESS ─────────────────────────────────────────────────
    const contact     = await Contact.findOne({ number: contactNumber }).lean();
    const addressInfo = await Contact.findOne({
      number: { $in: [`+${contactNumber}`, contactNumber] },
      address: { $exists: true, $ne: '' }
    }).lean();
 
    if (!addressInfo) {
      return res.status(404).json({ success: false, message: 'Customer address not found' });
    }
 
    // ── 4. TOTALS ────────────────────────────────────────────────────────────
    const subTotal        = parseFloat(orderDetails.subtotal || 0);
    const shippingCharges = parseFloat(orderDetails.shipping_charge || 0);
    const gstAmount       = 0;
    const grandTotal      = parseFloat(orderDetails.total_amount || 0).toFixed(2);
 
    // ── 5. ORDER DATA ────────────────────────────────────────────────────────
    const orderData = {
        contact: {
          name: addressInfo.name || contact?.name || 'N/A',
          number: addressInfo.number || contactNumber,
          address: addressInfo.address || 'N/A',
          city: addressInfo.city || 'N/A',
          state: addressInfo.state || 'N/A',
          country: addressInfo.country || 'N/A',
          pinCode: addressInfo.pinCode || 'N/A',
          mapUrl: addressInfo.mapUrl || '',
          deliveryType: addressInfo.deliveryType || 'home_delivery',
          isHomeDelivery: addressInfo?.deliveryType ? addressInfo?.deliveryType === 'home_delivery': true,
          recieverName: addressInfo.recieverName || 'N/A',
          recieverNumber: addressInfo.recieverNumber || 'N/A'
        },
        cartItems: orderDetails.items.map(item => ({
        productName:  item.product_name,
        quantity:     item.quantity,
        price:        item.price?.value || 0,
        total:        item.total_price,
        categoryName: 'N/A'
      })),
      mediaUrls:         mediaUrl ? (Array.isArray(mediaUrl) ? mediaUrl : [mediaUrl]) : [],
      subTotal:          subTotal.toFixed(2),
      shipping:          shippingCharges,
      gst:               gstAmount,
      grandTotal,
      orderDate:         new Date(orderDetails.order_date).toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata', dateStyle: 'full', timeStyle: 'short'
      }),
      additionalMessage: message || ''
    };
 
    // ── 6. GENERATE PDF ──────────────────────────────────────────────────────
    const pdfPath      = await generateOrderPDF(orderData, contactNumber);
    const pdfFileName  = path.basename(pdfPath);
    const pdfPublicUrl = `${process.env.FILE_URL}/uploads/pdfs/${pdfFileName}`;
 
    // ── 7. BUILD TEMPLATE COMPONENTS ─────────────────────────────────────────
    const components = [];
 
    components.push({
      type: 'header',
      parameters: [{
        type: 'document',
        document: { link: pdfPublicUrl, filename: `Order_${contactNumber}.pdf` }
      }]
    });
 
    if (template.parameters?.length) {
      const bodyParameters = template.parameters.map(param => {
        let value = param.bindValue || '';
        value = value.replace(/{{contactName}}/g,   orderData.contact.name);
        value = value.replace(/{{contactNumber}}/g, contactNumber);
        value = value.replace(/{{orderTotal}}/g,    `₹${grandTotal}`);
        value = value.replace(/{{itemCount}}/g,     orderDetails.items.length.toString());
        return { type: 'text', text: value };
      });
      components.push({ type: 'body', parameters: bodyParameters });
    }
 
    // ── 8. PURCHASE + INVOICE ────────────────────────────────────────────────
    const orderId  = await generateOrderId();
    const purchase = await Purchase.create({
      userNumber: contactNumber,
      orderId,
      items: orderDetails.items.map(i => ({
        product:     i.product_id,
        productName: i.product_name,
        quantity:    i.quantity,
        price:       i.price?.value,
        total:       i.total_price
      })),
      deliveryType: addressInfo.deliveryType || 'home_delivery',
      subTotal:        subTotal.toString(),
      gst:             gstAmount.toString(),
      deliveryCharges: shippingCharges.toString(),
      totalAmount:     grandTotal.toString(),
      shippingAddress: {
        name:    addressInfo.name,
        address: addressInfo.address,
        city:    addressInfo.city,
        state:   addressInfo.state,
        pinCode: addressInfo.pinCode
      },
      instance_id: instance.numberId,
      statusLog:   [{ status: 'pending', comment: 'Order created from WhatsApp' }]
    });
 
    const invoice = await Invoice.create({
      invoiceNumber: `INV-${Date.now()}`,
      purchaseId:    purchase._id,
      name:          addressInfo.name,
      address:       addressInfo.address,
      city:          addressInfo.city,
      state:         addressInfo.state,
      pincode:       addressInfo.pinCode,
      items: purchase.items.map(i => ({
        product: i.productName, price: i.price, quantity: i.quantity, total: i.total
      })),
      subTotal:        subTotal.toString(),
      gst:             gstAmount.toString(),
      deliveryCharges: shippingCharges.toString(),
      totalAmount:     grandTotal.toString(),
      paymentStatus:   PaymentStatus.PAID,
      filePath:        pdfPublicUrl
    });
 
    purchase.invoice = invoice._id;
    await purchase.save();
 
    // ── 9. WALLET DEDUCTION (no balance check — order notifications always go through) ──
    const ownerContacts = instance.businessOwners.map(o => ({ number: o.number.toString() }));
    let campaignLog = null;
    let campaignId  = null;
    try {
      ({ campaignLog, campaignId } = await deductOrderNotificationCost({
        instance,
        template,
        ownerContacts
      }));
    } catch (walletErr) {
      // Wallet errors must never block the notification — log and continue
      console.error('⚠️  Wallet deduction failed (order notification will still send):', walletErr.message);
    }
 
    // ── 10. SEND TO EACH OWNER ───────────────────────────────────────────────
    const graphURL    = `${process.env.META_API}/${instance.numberId}/messages`;
    const sendResults = [];
    const captionText = `New Order Received — ₹${grandTotal}`;
    let successCount  = 0;
    let failedCount   = 0;
 
    for (const owner of instance.businessOwners) {
      const to = owner.number.toString();
 
      try {
        const payload = {
          messaging_product: 'whatsapp',
          to,
          type: 'template',
          template: {
            name:       template.templateName,
            language:   { code: template.languageCode || 'en' },
            components
          }
        };
 
        const response = await axios.post(graphURL, payload, {
          headers: {
            Authorization:  `Bearer ${instance.accessToken}`,
            'Content-Type': 'application/json'
          }
        });
 
        console.log('response', JSON.stringify(response.data));
        const metaMessageId = response.data.messages?.[0]?.id || null;
 
        sendResults.push({ owner: owner.name, number: owner.number, status: 'sent', messageId: metaMessageId });
 
        // ── Save message to DB ──────────────────────────────────────────────
        if (metaMessageId) {
          try {
            await saveOwnerNotificationMessage({
              instance,
              ownerNumber:   to,
              pdfPublicUrl,
              pdfFileName,
              captionText,
              messageId:     metaMessageId,
              campaignLogId: campaignLog?._id || null,
              templateId:    template._id
            });
          } catch (dbErr) {
            console.error(`⚠️  DB save failed for owner ${to}:`, dbErr.message);
          }
        }
 
        successCount++;
      } catch (ownerError) {
        failedCount++;
        sendResults.push({
          owner:  owner.name,
          number: owner.number,
          status: 'failed',
          error:  ownerError?.response?.data?.error?.message || ownerError.message
        });
      }
    }
 
    // ── 11. UPDATE CAMPAIGN STATUS ───────────────────────────────────────────
    if (campaignLog) {
      await CampaignLog.findByIdAndUpdate(campaignLog._id, {
        status:       failedCount === instance.businessOwners.length ? 'failed' : 'completed',
        successCount,
        failedCount
      });
    }
 
    return res.status(200).json({
      success: true,
      message: 'Order notification sent successfully',
      summary: sendResults,
      pdfPublicUrl,
      ...(campaignId && { campaignId })
    });
 
  } catch (error) {
    console.error('messageToOwnerTemplate error:', error?.response?.data || error);
    return res.status(500).json({
      success: false,
      message: 'Failed to send order notification',
      error:   error.message
    });
  }
};
 
const messageToOwner = async (req, res) => {
  try {
    const { mediaUrl, contactNumber, message, orderDetails } = req.body;
 
    console.log('req.body', JSON.stringify(req.body));
 
    // ── VALIDATION ──────────────────────────────────────────────────────────
    if (!contactNumber) {
      return res.status(400).json({ success: false, message: 'contactNumber is required' });
    }
    if (!orderDetails?.items?.length) {
      return res.status(400).json({ success: false, message: 'orderDetails with items is required' });
    }
 
    // ── 1. ACTIVE INSTANCE ───────────────────────────────────────────────────
    const instance = await Instance.findOne({ isActive: true, isDeleted: false }).lean();
    if (!instance) {
      return res.status(404).json({ success: false, message: 'No active WhatsApp instance found' });
    }
    if (!instance.businessOwners?.length) {
      return res.status(400).json({ success: false, message: 'No business owners configured' });
    }
 
    // ── 2. CONTACT / ADDRESS ─────────────────────────────────────────────────
    const contact     = await Contact.findOne({ number: contactNumber }).lean();
    const addressInfo = await Contact.findOne({
      number: { $in: [`+${contactNumber}`, contactNumber] },
      address: { $exists: true, $ne: '' }
    }).lean();
 
    if (!addressInfo) {
      return res.status(404).json({ success: false, message: 'Customer address not found' });
    }
 
    // ── 3. TOTALS ────────────────────────────────────────────────────────────
    const subTotal        = parseFloat(orderDetails.subtotal || 0);
    const shippingCharges = parseFloat(orderDetails.shipping_charge || 0);
    const gstAmount       = 0;
    const grandTotal      = parseFloat(orderDetails.total_amount || 0).toFixed(2);
 
    // ── 4. ORDER DATA ────────────────────────────────────────────────────────
    const orderData = {
      contact: {
        name:          addressInfo.name || contact?.name || 'N/A',
        number:        addressInfo.number || contactNumber,
        address:       addressInfo.address || 'N/A',
        city:          addressInfo.city    || 'N/A',
        state:         addressInfo.state   || 'N/A',
        country:       addressInfo.country || 'N/A',
        pinCode:       addressInfo.pinCode || 'N/A',
        mapUrl:        addressInfo.mapUrl  || '',
        recieverNumber: addressInfo.recieverNumber || addressInfo.number || contactNumber || '',
        recieverName:   addressInfo.recieverName   || addressInfo.name  || contact?.name || ''
      },
      cartItems: orderDetails.items.map(item => ({
        productName:  item.product_name,
        quantity:     item.quantity,
        price:        item.price?.value || 0,
        total:        item.total_price,
        categoryName: 'N/A'
      })),
      mediaUrls:         mediaUrl ? (Array.isArray(mediaUrl) ? mediaUrl : [mediaUrl]) : [],
      subTotal:          subTotal.toFixed(2),
      shipping:          shippingCharges,
      gst:               gstAmount,
      grandTotal,
      orderDate:         new Date(orderDetails.order_date).toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata', dateStyle: 'full', timeStyle: 'short'
      }),
      additionalMessage: message || ''
    };
 
    // ── 5. GENERATE PDF ──────────────────────────────────────────────────────
    const pdfPath      = await generateOrderPDF(orderData, contactNumber);
    const pdfFileName  = path.basename(pdfPath);
    const pdfPublicUrl = `${process.env.FILE_URL}/uploads/pdfs/${pdfFileName}`;
 
    // ── 6. PURCHASE + INVOICE ────────────────────────────────────────────────
    const purchase = await Purchase.create({
      userNumber: contactNumber,
      items: orderDetails.items.map(i => ({
        product:     i.product_id,
        productName: i.product_name,
        quantity:    i.quantity,
        price:       i.price?.value,
        total:       i.total_price
      })),
      subTotal:        subTotal.toString(),
      gst:             gstAmount.toString(),
      deliveryCharges: shippingCharges.toString(),
      totalAmount:     grandTotal.toString(),
      shippingAddress: {
        name:    addressInfo.name,
        address: addressInfo.address,
        city:    addressInfo.city,
        state:   addressInfo.state,
        pinCode: addressInfo.pinCode
      },
      instance_id: instance.numberId,
      statusLog:   [{ status: 'pending', comment: 'Order created from WhatsApp' }]
    });
 
    const invoice = await Invoice.create({
      invoiceNumber:   `INV-${Date.now()}`,
      purchaseId:      purchase._id,
      name:            addressInfo.name,
      address:         addressInfo.address,
      city:            addressInfo.city,
      state:           addressInfo.state,
      pincode:         addressInfo.pinCode,
      items: purchase.items.map(i => ({
        product: i.productName, price: i.price, quantity: i.quantity, total: i.total
      })),
      subTotal:        subTotal.toString(),
      gst:             gstAmount.toString(),
      deliveryCharges: shippingCharges.toString(),
      totalAmount:     grandTotal.toString(),
      paymentStatus:   'pending',
      outstandingAmount: grandTotal.toString(),
      filePath:        pdfPublicUrl
    });
 
    purchase.invoice = invoice._id;
    await purchase.save();
 
    // ── 7. SEND TO EACH OWNER ────────────────────────────────────────────────
    const graphURL    = `${process.env.META_API}/${instance.numberId}/messages`;
    const sendResults = [];
    const captionText = 'New Order Received.';
 
    for (const owner of instance.businessOwners) {
      const to = owner.number.toString();
 
      try {
        const payload = {
          messaging_product: 'whatsapp',
          to,
          type: 'document',
          document: {
            link:     pdfPublicUrl,
            filename: `Order_${contactNumber}.pdf`,
            caption:  captionText
          }
        };
 
        const response = await axios.post(graphURL, payload, {
          headers: {
            Authorization:  `Bearer ${instance.accessToken}`,
            'Content-Type': 'application/json'
          }
        });
 
        const metaMessageId = response.data.messages?.[0]?.id || null;
 
        sendResults.push({ owner: owner.name, number: owner.number, status: 'sent', messageId: metaMessageId });
 
        // ── Save message to DB ──────────────────────────────────────────────
        if (metaMessageId) {
          try {
            await saveOwnerNotificationMessage({
              instance,
              ownerNumber:   to,
              pdfPublicUrl,
              pdfFileName,
              captionText,
              messageId:     metaMessageId,
              campaignLogId: null,
              templateId:    null
            });
          } catch (dbErr) {
            console.error(`⚠️  DB save failed for owner ${to}:`, dbErr.message);
          }
        }
 
      } catch (ownerError) {
        sendResults.push({
          owner:  owner.name,
          number: owner.number,
          status: 'failed',
          error:  ownerError?.response?.data?.error?.message || ownerError.message
        });
      }
    }
 
    // // ── 8. CLEANUP PDF (delayed) ─────────────────────────────────────────────
    // setTimeout(() => {
    //   if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);
    // }, 300000);
 
    return res.status(200).json({
      success:    true,
      message:    'Order notification sent successfully',
      summary:    sendResults,
      pdfPublicUrl
    });
 
  } catch (error) {
    console.error('messageToOwner error:', error?.response?.data || error);
    return res.status(500).json({
      success: false,
      message: 'Failed to send order notification',
      error:   error.message
    });
  }
};

const sendtoowner = async (req, res) => {
  try {
    // COSMOS DB COMPATIBLE: no .sort() on findOne
    const instance = await Instance.findOne({ isActive: true, isDeleted: false }).lean();
 
    if (!instance) {
      return res.status(404).json({ success: false, message: 'No active WhatsApp instance found' });
    }
 
    if (!instance.businessOwners?.length) {
      return res.status(400).json({ success: false, message: 'No business owners configured' });
    }
 
    const purchase = await Purchase.findOne({ _id: req.params.purchaseId });
    if (!purchase) {
      return res.status(404).json({ success: false, message: 'Purchase not found' });
    }
 
    const invoice = await Invoice.findOne({ _id: purchase.invoice });
    if (!invoice) {
      return res.status(404).json({ success: false, message: 'Invoice not found' });
    }
 
    const graphURL    = `${process.env.META_API}/${instance.numberId}/messages`;
    const sendResults = [];
    const captionText = 'New Order Received.';
    const pdfPublicUrl = invoice.filePath;
    const pdfFileName  = `Order_${invoice.invoiceNumber}.pdf`;
 
    for (const owner of instance.businessOwners) {
      const to = owner.number.toString();
 
      try {
        const payload = {
          messaging_product: 'whatsapp',
          to,
          type: 'document',
          document: {
            link:     pdfPublicUrl,
            filename: pdfFileName,
            caption:  captionText
          }
        };
 
        const response = await axios.post(graphURL, payload, {
          headers: {
            Authorization:  `Bearer ${instance.accessToken}`,
            'Content-Type': 'application/json'
          }
        });
 
        console.log('response', JSON.stringify(response.data.messages));
 
        const metaMessageId = response.data.messages?.[0]?.id || null;
 
        sendResults.push({
          owner:     owner.name,
          number:    owner.number,
          status:    'sent',
          messageId: metaMessageId
        });
 
        // ── Save message to DB ────────────────────────────────────────────
        if (metaMessageId) {
          try {
            await saveOwnerNotificationMessage({
              instance,
              ownerNumber:   to,
              pdfPublicUrl,
              pdfFileName,
              captionText,
              messageId:     metaMessageId,
              campaignLogId: null,
              templateId:    null
            });
          } catch (dbErr) {
            console.error(`⚠️  DB save failed for owner ${to}:`, dbErr.message);
          }
        }
 
      } catch (ownerError) {
        sendResults.push({
          owner:  owner.name,
          number: owner.number,
          status: 'failed',
          error:  ownerError?.response?.data?.error?.message || ownerError.message
        });
      }
    }
 
    // NOTE: pdfPath (local disk path) is not available here — only invoice.filePath (public URL) is.
    // PDF cleanup is intentionally skipped. If you need cleanup, store the local path on the Invoice
    // model and use it here. The file will persist in uploads/pdfs which is fine for order records.
 
    return res.status(200).json({
      success:     true,
      message:     'Order notification sent successfully',
      summary:     sendResults,
      pdfPublicUrl: invoice.filePath
    });
 
  } catch (error) {
    console.error('sendtoowner error:', error?.response?.data || error);
    return res.status(500).json({
      success: false,
      message: 'Failed to send order notification',
      error:   error.message
    });
  }
};
 
// ===== HELPER: GENERATE PDF =====
async function generateOrderPDF(orderData, contactNumber) {
  return new Promise((resolve, reject) => {
    try {
      // Read HTML template
      const templatePath = path.join(process.cwd(), 'uploads', 'ordertemplate.hbs');
      
      if (!fs.existsSync(templatePath)) {
        throw new Error(`Template not found at ${templatePath}`);
      }

      const templateHtml = fs.readFileSync(templatePath, 'utf8');
      // Compile with Handlebars
      const compiledTemplate = handlebars.compile(templateHtml);
      const html = compiledTemplate(orderData);
      // PDF options
      const options = {
        format: 'A4',
        border: {
          top: '10mm',
          right: '10mm',
          bottom: '10mm',
          left: '10mm'
        }
      };

      // Generate PDF path
      const pdfDir = path.join(process.cwd(), 'uploads', 'pdfs');
      if (!fs.existsSync(pdfDir)) {
        fs.mkdirSync(pdfDir, { recursive: true });
      }

      const pdfPath = path.join(pdfDir, `order_${contactNumber}_${Date.now()}.pdf`);

      // Create PDF
      pdf.create(html, options).toFile(pdfPath, (err, result) => {
        if (err) {
          console.error('PDF generation error:', err);
          reject(err);
        } else {
          resolve(result.filename);
        }
      });

    } catch (error) {
      console.error('PDF preparation error:', error);
      reject(error);
    }
  });
}

// ===== HELPER: UPLOAD MEDIA TO WHATSAPP (FALLBACK - NOT USED BY DEFAULT) =====
// Uncomment and use this function if direct link doesn't work
/*
async function uploadMediaToWhatsApp(filePath, numberId, accessToken) {
  try {
    const formData = new FormData();
    formData.append('file', fs.createReadStream(filePath));
    formData.append('messaging_product', 'whatsapp');
    formData.append('type', 'application/pdf');

    const uploadUrl = `${process.env.META_API}/${numberId}/media`;
    
    const response = await axios.post(uploadUrl, formData, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        ...formData.getHeaders()
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    });

    return response.data.id;
  } catch (error) {
    console.error('Media upload error:', error?.response?.data || error);
    throw new Error('Failed to upload media to WhatsApp');
  }
}
*/

// ==================== BULK MESSAGING ====================

const sendBulkTemplateOld = async (req, res) => {
  try {
    const { templateId, filters } = req.body;

    if (!templateId) {
      return res.status(400).json({
        success: false,
        message: 'Template ID is required'
      });
    }

    const template = await Template.findById(templateId);
    if (!template) {
      return res.status(404).json({
        success: false,
        message: 'Template not found'
      });
    }

    const instance = await Instance.findOne({
      isActive: true,
      isDeleted: false
    }).sort({ updatedAt: -1 });

    if (!instance) {
      return res.status(404).json({
        success: false,
        message: 'No active WhatsApp instance found'
      });
    }

    // CONTACT FILTERS (AS-IS)
    const contactQuery = { isArchived: false };

    if (filters?.searchQuery) {
      contactQuery.$or = [
        { name: { $regex: filters.searchQuery, $options: 'i' } },
        { number: { $regex: filters.searchQuery, $options: 'i' } }
      ];
    }

    if (filters?.statusFilter && filters.statusFilter !== 'all') {
      contactQuery.status = filters.statusFilter;
    }

    if (filters?.readFilter === 'unread') {
      contactQuery.unreadCount = { $gt: 0 };
    }

    console.log('contactQuery', contactQuery)
    const contacts = await Contact.find(contactQuery);
    if (!contacts.length) {
      return res.status(404).json({
        success: false,
        message: 'No contacts found matching filters'
      });
    }
    
    // FIRST CONTACT (VALIDATION SEND)
    try {
      await processContact({
        contact: contacts[0],
        instance,
        template
      });
    } catch (err) {
      return res.status(400).json({
        success: false,
        message: 'Template validation failed',
        error: err.message
      });
    }

    // BACKGROUND BULK
    (async () => {
      for (let i = 1; i < contacts.length; i++) {
        try {
          await processContact({
            contact: contacts[i],
            instance,
            template
          });
          await new Promise(r => setTimeout(r, 2000));
        } catch (e) {
          console.error(`❌ ${contacts[i].number}:`, e.message);
        }
      }
      console.log(`✅ Bulk send completed (${contacts.length})`);
    })();

    return res.json({
      success: true,
      message: 'Bulk template messages queued',
      data: {
        templateName: template.name,
        totalRecipients: contacts.length,
        status: 'processing'
      }
    });

  } catch (error) {
    console.error('❌ Bulk send error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to send bulk template messages',
      error: error.message
    });
  }
};

const sendBulkTemplateOld2 = async (req, res) => {
  try {
    const { templateId, viewMode, selectedIds, filters } = req.body;
    
    // Validation
    if (!templateId) {
      return res.status(400).json({
        success: false,
        message: 'Template ID is required'
      });
    }

    if (!selectedIds || !Array.isArray(selectedIds) || selectedIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'At least one recipient must be selected'
      });
    }

    // Get template
    const template = await Template.findById(templateId);
    if (!template) {
      return res.status(404).json({
        success: false,
        message: 'Template not found'
      });
    }

    // Get active instance
    const instance = await Instance.findOne({
      isActive: true,
      isDeleted: false
    }).sort({ updatedAt: -1 });
    
    if (!instance) {
      return res.status(404).json({
        success: false,
        message: 'No active WhatsApp instance found'
      });
    }

    let recipients = [];
    let groupInfo = null;

    // Handle different view modes
    if (viewMode === 'groups') {
      console.log('📂 Processing groups:', selectedIds);
      
      // Get selected groups with validation
      const groups = await Group.find({
        _id: { $in: selectedIds },
        isDeleted: false,
        isArchived: false
      });

      if (!groups.length) {
        return res.status(404).json({
          success: false,
          message: 'No valid groups found'
        });
      }

      console.log(`📋 Found ${groups.length} valid groups`);

      // Get all members from selected groups
      const groupIds = groups.map(g => g._id.toString());
      const groupMembers = await GroupMembers.find({
        groupId: { $in: groupIds },
        status: 'active'
      });

      console.log(`👥 Found ${groupMembers.length} group members`);

      // Extract unique contact IDs
      const contactIds = [...new Set(
        groupMembers
          .map(gm => gm.contactId)
          .filter(id => id) // Remove null/undefined
      )];

      if (!contactIds.length) {
        return res.status(404).json({
          success: false,
          message: 'No active members found in selected groups'
        });
      }

      // Fetch actual contacts
      recipients = await Contact.find({
        _id: { $in: contactIds },
        isArchived: false
      });

      // Remove duplicates by number
      const uniqueRecipients = new Map();
      recipients.forEach(contact => {
        if (!uniqueRecipients.has(contact.number)) {
          uniqueRecipients.set(contact.number, contact);
        }
      });
      recipients = Array.from(uniqueRecipients.values());

      groupInfo = {
        groupCount: groups.length,
        groupNames: groups.map(g => g.groupName).join(', '),
        totalMembers: recipients.length
      };

      console.log(`✅ Final unique recipients: ${recipients.length}`);

    } else {
      // Contacts mode - build query with filters
      const contactQuery = {
        $or: [
          { _id: { $in: selectedIds } },
          { number: { $in: selectedIds } }
        ],
        isArchived: false
      };

      // Apply additional filters if provided
      if (filters?.searchQuery) {
        contactQuery.$and = contactQuery.$and || [];
        contactQuery.$and.push({
          $or: [
            { name: { $regex: filters.searchQuery, $options: 'i' } },
            { number: { $regex: filters.searchQuery, $options: 'i' } }
          ]
        });
      }

      if (filters?.statusFilter && filters.statusFilter !== 'all') {
        contactQuery.status = filters.statusFilter;
      }

      if (filters?.readFilter === 'unread') {
        contactQuery.unreadCount = { $gt: 0 };
      }

      recipients = await Contact.find(contactQuery);
    }

    if (!recipients.length) {
      return res.status(404).json({
        success: false,
        message: viewMode === 'groups' 
          ? 'No active members found in selected groups' 
          : 'No valid recipients found matching criteria'
      });
    }

    console.log(`📤 Sending to ${recipients.length} final recipients`);

    // Send to first contact for validation
    try {
      await processContact({
        contact: recipients[0],
        instance,
        template
      });
    } catch (err) {
      return res.status(400).json({
        success: false,
        message: 'Template validation failed',
        error: err.message
      });
    }

    // Process remaining contacts in background
    (async () => {
      const results = {
        success: 1, // First one already sent
        failed: 0,
        errors: [],
        duplicates: 0
      };

      const sentNumbers = new Set([recipients[0].number]);

      for (let i = 1; i < recipients.length; i++) {
        try {
          // Skip if already sent (duplicate number)
          if (sentNumbers.has(recipients[i].number)) {
            results.duplicates++;
            continue;
          }

          await processContact({
            contact: recipients[i],
            instance,
            template
          });
          
          sentNumbers.add(recipients[i].number);
          results.success++;
          
          // Rate limiting - 2 second delay between messages
          await new Promise(r => setTimeout(r, 2000));
          
          // Log progress every 10 messages
          if ((i + 1) % 10 === 0) {
            console.log(`📊 Progress: ${i + 1}/${recipients.length} processed`);
          }
        } catch (e) {
          results.failed++;
          results.errors.push({
            recipient: recipients[i].number,
            error: e.message
          });
          console.error(`❌ Failed for ${recipients[i].number}:`, e.message);
        }
      }

      console.log(`✅ Bulk send completed`);
      console.log(`   Success: ${results.success}`);
      console.log(`   Failed: ${results.failed}`);
      console.log(`   Duplicates skipped: ${results.duplicates}`);
      
      // Optionally: Store results in database for admin review
      // await BulkMessageLog.create({ templateId, results, timestamp: new Date() });
    })();

    // Return immediate response
    const responseData = {
      templateName: template.name,
      totalRecipients: recipients.length,
      viewMode: viewMode,
      status: 'processing',
      estimatedTime: `${Math.ceil(recipients.length * 2 / 60)} minutes`
    };

    if (groupInfo) {
      responseData.groupInfo = groupInfo;
    }

    return res.json({
      success: true,
      message: 'Bulk template messages queued successfully',
      data: responseData
    });

  } catch (error) {
    console.error('❌ Bulk send error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to send bulk template messages',
      error: error.message
    });
  }
};

const sendBulkTemplate = async (req, res) => {
  try {
    const { templateId, viewMode, selectedIds, filters } = req.body;
 
    // ── Validation ────────────────────────────────────────────────────────
    if (!templateId) {
      return res.status(400).json({ success: false, message: 'Template ID is required' });
    }
    if (!selectedIds || !Array.isArray(selectedIds) || selectedIds.length === 0) {
      return res.status(400).json({ success: false, message: 'At least one recipient must be selected' });
    }
 
    // ── Fetch template ────────────────────────────────────────────────────
    const template = await Template.findById(templateId);
    if (!template) {
      return res.status(404).json({ success: false, message: 'Template not found' });
    }
 
    // ── Fetch active instance ─────────────────────────────────────────────
    // COSMOS DB COMPATIBLE: no .sort() on findOne
    const instance = await Instance.findOne({ isActive: true, isDeleted: false }).lean();
    if (!instance) {
      return res.status(404).json({ success: false, message: 'No active WhatsApp instance found' });
    }
 
    // ── Resolve recipients ────────────────────────────────────────────────
    let recipients = [];
    let groupInfo = null;
 
    if (viewMode === 'groups') {
      const groups = await Group.find({ _id: { $in: selectedIds }, isDeleted: false, isArchived: false });
      if (!groups.length) {
        return res.status(404).json({ success: false, message: 'No valid groups found' });
      }
 
      const groupIds = groups.map(g => g._id.toString());
      const groupMembers = await GroupMembers.find({ groupId: { $in: groupIds }, status: 'active' });
      const contactIds = [...new Set(groupMembers.map(gm => gm.contactId).filter(Boolean))];
 
      if (!contactIds.length) {
        return res.status(404).json({ success: false, message: 'No active members found in selected groups' });
      }
 
      recipients = await Contact.find({ _id: { $in: contactIds }, isArchived: false });
 
      // Deduplicate by number
      const uniqueMap = new Map();
      recipients.forEach(c => { if (!uniqueMap.has(c.number)) uniqueMap.set(c.number, c); });
      recipients = Array.from(uniqueMap.values());
 
      groupInfo = {
        groupCount: groups.length,
        groupNames: groups.map(g => g.groupName).join(', '),
        totalMembers: recipients.length
      };
 
    } else {
      const contactQuery = {
        $or: [{ _id: { $in: selectedIds } }, { number: { $in: selectedIds } }],
        isArchived: false
      };
      if (filters?.searchQuery) {
        contactQuery.$and = [{ $or: [
          { name: { $regex: filters.searchQuery, $options: 'i' } },
          { number: { $regex: filters.searchQuery, $options: 'i' } }
        ]}];
      }
      if (filters?.statusFilter && filters.statusFilter !== 'all') contactQuery.status = filters.statusFilter;
      if (filters?.readFilter === 'unread') contactQuery.unreadCount = { $gt: 0 };
 
      recipients = await Contact.find(contactQuery);
    }
 
    if (!recipients.length) {
      return res.status(404).json({
        success: false,
        message: viewMode === 'groups'
          ? 'No active members found in selected groups'
          : 'No valid recipients found matching criteria'
      });
    }
 
    // ── Wallet: check balance + deduct (throws 402 if insufficient) ────────
    const templateCategory = (template.category || 'marketing').toLowerCase();
    const templateName = template.templateName || template.name;
 
    let campaignResult;
    try {
      campaignResult = await deductCampaignCost({
        userId: req.user._id,
        templateId: template._id,
        templateName,
        templateCategory,
        viewMode,
        contacts: recipients
      });
    } catch (walletErr) {
      return res.status(walletErr.statusCode || 402).json({
        success: false,
        message: walletErr.message,
        walletError: true
      });
    }
 
    const { campaignLog, campaignId, totalCost, balanceBefore, balanceAfter, breakdown } = campaignResult;
 
    // Mark campaign as processing
    await CampaignLog.findByIdAndUpdate(campaignLog._id, { status: 'processing' });
 
    // ── Validate with first contact (synchronous — blocks response if fail) ─
    try {
      await processContact({ contact: recipients[0], instance, template, campaignLogId: campaignLog._id  });
    } catch (err) {
      // Full refund on validation failure
      const { getOrCreateWallet } = require('./walletController');
      const wallet = await getOrCreateWallet(req.user._id);
      wallet.balance = parseFloat((wallet.balance + totalCost).toFixed(4));
      wallet.transactions.push({
        type: 'credit',
        amount: totalCost,
        description: `Refund [${campaignId}] — validation failed`,
        campaignId: campaignLog._id,
        balanceAfter: wallet.balance
      });
      await wallet.save();
 
      await CampaignLog.findByIdAndUpdate(campaignLog._id, {
        status: 'failed',
        errorMessage: err.message,
        successCount: 0,
        failedCount: 1
      });
 
      return res.status(400).json({
        success: false,
        message: `Template send failed: ${err.message}`,
        campaignId
      });
    }
 
    // ── Background bulk send (remaining recipients) ────────────────────────
    (async () => {
      const results = { success: 1, failed: 0, errors: [] };
      const sentNumbers = new Set([recipients[0].number]);
 
      for (let i = 1; i < recipients.length; i++) {
        try {
          if (sentNumbers.has(recipients[i].number)) continue; // skip duplicate
 
          await processContact({ contact: recipients[i], instance, template, campaignLogId: campaignLog._id  });
          sentNumbers.add(recipients[i].number);
          results.success++;
 
          // Rate limit — 2 s between messages to avoid Meta throttling
          await new Promise(r => setTimeout(r, 2000));
 
          if ((i + 1) % 10 === 0) {
            console.log(`[${campaignId}] Progress: ${i + 1}/${recipients.length}`);
          }
        } catch (e) {
          results.failed++;
          results.errors.push({ recipient: recipients[i].number, error: e.message });
          console.error(`[${campaignId}] ❌ Failed for ${recipients[i].number}:`, e.message);
        }
      }
 
      // Update campaign log with final counts
      await CampaignLog.findByIdAndUpdate(campaignLog._id, {
        status: results.failed === recipients.length ? 'failed' : 'completed',
        successCount: results.success,
        failedCount: results.failed
      });
 
      console.log(`[${campaignId}] ✅ Done — sent: ${results.success}, failed: ${results.failed}`);
    })();
 
    // ── Immediate response ────────────────────────────────────────────────
    const responseData = {
      campaignId,
      templateName,
      totalRecipients: recipients.length,
      viewMode,
      status: 'processing',
      estimatedTime: `${Math.ceil(recipients.length * 2 / 60)} minutes`,
      costSummary: {
        templateCategory,
        breakdownByCountry: breakdown,
        totalCost,
        walletBalanceBefore: balanceBefore,
        walletBalanceAfter: balanceAfter
      }
    };
 
    if (groupInfo) responseData.groupInfo = groupInfo;
 
    return res.json({
      success: true,
      message: 'Bulk campaign queued successfully',
      data: responseData
    });
 
  } catch (error) {
    console.error('❌ sendBulkTemplate error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to send bulk template messages',
      error: error.message
    });
  }
};

const processContact = async ({ contact, instance, template, campaignLogId = null, extraContext = {} }) => {
  const bindValues = buildBindValues({ template, contact, extra: extraContext });
 
  // Throws if Meta API returns an error — no silent catch
  const messageId = await sendTemplateToWhatsApp({ instance, contact, template, bindValues });
 
  if (!messageId) {
    throw new Error(`Meta API returned no messageId for ${contact.number}`);
  }
 
  // FILE (only if template has media)
  let fileId = null;
  if (template.mediaUrl) {
    const file = await File.create({
      fileName: template.mediaUrl.split('/').pop(),
      originalName: template.mediaUrl.split('/').pop(),
      fileType: template.mediaType,
      mimeType: template.mediaMime,
      fileSize: 0,
      url: process.env.IMAGE_URL + template.mediaUrl,
      path: template.mediaUrl,
      entityType: 'message'
    });
    fileId = file._id;
  }
 
  // ── NEW: Chat message record now includes templateId + campaignId ──
  const message = await Message.create({
    messageId,
    sender: instance.number.toString(),
    receiver: contact.number,
    instance_id: instance.numberId,
    text: reformText(template.templateText, { bindValue: bindValues }),
    type: template.mediaUrl ? template.mediaType : MessageType.TEXT,
    // ─── template tracking fields (NEW) ───────────────────────────
    messageType: 'template',                        // marks this as a template message
    templateId: template._id,                       // which template was used
    campaignId: campaignLogId,                      // links back to CampaignLog._id
    // ──────────────────────────────────────────────────────────────
    file: fileId,
    status: [{ status: MessageStatus.SENT, timeStamp: new Date() }]
  });
 
  // Chat log
  await ChatLog.create({
    sender: instance.number.toString(),
    receiver: contact.number,
    instance_id: instance.numberId,
    usedFile: fileId,
    action: 'sent',
    metadata: { templateId: template._id, templateName: template.templateName }
  });
 
  // Update contact's last message timestamp
  await Contact.findOneAndUpdate(
    { number: contact.number },
    { $set: { lastMessageAt: new Date() }, $inc: { unreadCount: 1 } }
  );
 
  return message;
};
const sendTemplateToWhatsApp = async ({ instance, contact, template, bindValues }) => {
  const graphURL = `${process.env.META_API}/${instance.numberId}/messages`;
 
  const components = [];
 
  if (template.mediaUrl && template.mediaType) {
    components.push({
      type: 'header',
      parameters: [{ type: template.mediaType, [template.mediaType]: { link: process.env.IMAGE_URL + template.mediaUrl } }]
    });
  }
 
  if (Object.keys(bindValues).length > 0) {
    components.push({
      type: 'body',
      parameters: Object.entries(bindValues).map(([key, value]) => ({
        type: 'text',
        parameter_name: key,
        text: String(value)
      }))
    });
  }
 
  const payload = {
    messaging_product: 'whatsapp',
    to: contact.number,
    type: 'template',
    template: {
      name: template.templateName,
      language: { code: template.languageCode || 'en' },
      components
    }
  };
 
  try {
    const res = await axios.post(graphURL, payload, {
      headers: { Authorization: `Bearer ${instance.accessToken}`, 'Content-Type': 'application/json' }
    });
 
    const messageId = res?.data?.messages?.[0]?.id;
    if (!messageId) throw new Error('Meta API did not return a message ID');
    return messageId;
 
  } catch (err) {
    // Extract the clearest error message from Meta's response
    const metaError = err?.response?.data?.error;
    const metaMessage = metaError?.error_user_msg || metaError?.message || err.message;
    const metaCode    = metaError?.code ? ` (code ${metaError.code})` : '';
 
    console.error(
      `❌ Meta API error for ${contact.number} — template "${template.templateName}": ${metaMessage}${metaCode}`,
      '\nFull response:', JSON.stringify(metaError ?? err.message)
    );
 
    throw new Error(`Meta API: ${metaMessage}${metaCode}`);
  }
};

const buildBindValues = ({ template, contact, extra = {} }) => {
  const bindValues = {};

  for (const param of template.parameters || []) {
    const { key, bindValue } = param;
    let value = '';

    if (contact && Object.prototype.hasOwnProperty.call(contact.toObject(), bindValue)) {
      value = contact[bindValue];
    } else if (Object.prototype.hasOwnProperty.call(extra, bindValue)) {
      value = extra[bindValue];
    }

    bindValues[key] = value ?? '';
  }

  return bindValues;
};

const reformText = (message, data = {}) => {
  const { bindValue = {}, contact = {}, chatLog = {} } = data;

  let mergedContact = {};

  if (contact) {
    mergedContact = { ...contact?.toObject?.() };
  }
  if (bindValue){
    mergedContact = { ...mergedContact, ...bindValue };
  }


  function replacePlaceholders(message, data) {
    return message.replace(/{(\w+)}/g, (_, key) => data[key] ?? `{${key}}`);
  }

  return replacePlaceholders(message, mergedContact);
};


module.exports = {
  verifyWebhook,
  receiveWebhook,
  getConversations,
  getMessages,
  sendMessage,
  sendMediaMessage,
  replyToMessage,
  reactToMessage,
  getUnreadCount,
  uploadFile,
  messageToOwner,
  sendBulkTemplate,
  messageToOwnerTemplate,
  sendtoowner
};