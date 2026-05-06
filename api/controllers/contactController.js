// ==================== CONTACT CONTROLLER ====================
const { Contact } = require('../models');
const xlsx = require('xlsx');
const axios = require('axios');


// ==================== CREATE CONTACT ====================
exports.createContact = async (req, res) => {
  try {
    const { name, number, city, state, pinCode, address } = req.body;

    const existing = await Contact.findOne({ number });
    if (existing) {
      return res.status(400).json({ error: 'Contact already exists' });
    }

    const contact = await Contact.create({
      name,
      number,
      city,
      state,
      pinCode,
      address
    });

    res.status(201).json(contact);
  } catch (error) {
    console.error('createContact error:', error);
    res.status(500).json({ error: 'Failed to create contact' });
  }
};

// ==================== GET CONTACTS ====================
exports.getContacts = async (req, res) => {
  try {
    const { search } = req.query;

    const filter = {};
    if (search) {
      filter.$or = [
        { name: new RegExp(search, 'i') },
        { number: new RegExp(search, 'i') }
      ];
    }

    const contacts = await Contact
      .find(filter)
      .sort({ createdAt: -1 });

    res.json(contacts);
  } catch (error) {
    console.error('getContacts error:', error);
    res.status(500).json({ error: 'Failed to fetch contacts' });
  }
};

// ==================== GET SINGLE CONTACT ====================
exports.getContact = async (req, res) => {
  try {
    const contact = await Contact.findById(req.params.id);
    if (!contact) {
      return res.status(404).json({ error: 'Contact not found' });
    }
    res.json(contact);
  } catch (error) {
    console.error('getContact error:', error);
    res.status(500).json({ error: 'Failed to fetch contact' });
  }
};

// ==================== UPDATE CONTACT STATUS====================
exports.updateContactStatus = async (req, res) => {
  try {
    const { status } = req.body;
    
    const validStatuses = ['enquiry', 'cart', 'checkout', 'not_delivered', 'delivered'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const contact = await Contact.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true }
    );

    if (!contact) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    res.json({ success: true, data: contact });
  } catch (error) {
    console.error('updateContactStatus error:', error);
    res.status(500).json({ error: 'Failed to update contact status' });
  }
};

// ==================== UPDATE CONTACT ====================
exports.updateContact = async (req, res) => {
  try {
    const contact = await Contact.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true }
    );

    if (!contact) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    res.json(contact);
  } catch (error) {
    console.error('updateContact error:', error);
    res.status(500).json({ error: 'Failed to update contact' });
  }
};

// ==================== DELETE CONTACT ====================
exports.deleteContact = async (req, res) => {
  try {
    const contact = await Contact.findByIdAndDelete(req.params.id);
    if (!contact) {
      return res.status(404).json({ error: 'Contact not found' });
    }
    res.json({ message: 'Contact deleted successfully' });
  } catch (error) {
    console.error('deleteContact error:', error);
    res.status(500).json({ error: 'Failed to delete contact' });
  }
};

// ==================== BULK UPLOAD CONTACTS ====================
exports.saveContactsInBulk = async (req, res) => {
  try {
    const filePath = req.file?.path;
    if (!filePath) {
      return res.status(400).json({ error: 'File is required' });
    }

    const workbook = xlsx.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const sheet = xlsx.utils.sheet_to_json(
      workbook.Sheets[sheetName],
      { header: 1 }
    );

    const headers = sheet[0];
    const rows = sheet.slice(1);

    let createdCount = 0;
    let skippedCount = 0;

    for (const row of rows) {
      let rowData = {};
      headers.forEach((header, index) => {
        rowData[header] = row[index];
      });

      const number = rowData.number ? String(rowData.number).trim() : null;
      if (!number) {
        skippedCount++;
        continue;
      }

      const exists = await Contact.findOne({ number });
      if (exists) {
        skippedCount++;
        continue;
      }

      await Contact.create({
        name: rowData.name || 'Unnamed',
        number,
        city: rowData.city || '',
        state: rowData.state || '',
        pinCode: rowData.pinCode || '',
        address: rowData.address || ''
      });

      createdCount++;
    }

    res.status(201).json({
      message: 'Bulk contacts upload completed',
      createdCount,
      skippedCount
    });

  } catch (error) {
    console.error('saveContactsInBulk error:', error);
    res.status(500).json({ error: 'Failed to upload contacts in bulk' });
  }
};
// ==================== BLOCK USER (Meta WhatsApp API) ====================
/**
 * Block a WhatsApp user using Meta's Graph API
 * Reference: https://developers.facebook.com/docs/whatsapp/cloud-api/guides/block-users
 */
exports.blockUser = async (req, res) => {
  try {
    const { id } = req.params;

    // Find contact
    const contact = await Contact.findById(id);
    if (!contact) {
      return res.status(404).json({
        success: false,
        error: 'Contact not found'
      });
    }

    // Get instance details (access token and phone number ID)
    const { Instance } = require('../models');
    const instance = await Instance.findOne({});

    if (!instance || !instance.accessToken || !instance.numberId) {
      return res.status(400).json({
        success: false,
        error: 'Invalid instance or missing credentials'
      });
    }

    // Format phone number (remove + if present, Meta expects format like 918983503471)
    const phoneNumber = contact.number.replace(/\+/g, '');

    // Call Meta Graph API to block user
    // Endpoint: POST /<PHONE_NUMBER_ID>/block_users
    const metaApiUrl = `${process.env.META_API}/${instance.numberId}/block_users`;

    const body = {
      messaging_product: 'whatsapp',
      block_users: [
        {
          user: phoneNumber
        }
      ]
    };

    const response = await axios.post(metaApiUrl, body, {
      headers: {
        Authorization: `Bearer ${instance.accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    // Check for partial failures in Meta's response
    // Meta returns 400 with a mixed success/failure body if some users failed
    const addedUsers = response.data?.block_users?.added_users || [];
    const failedUsers = response.data?.block_users?.failed_users || [];

    if (addedUsers.length === 0 && failedUsers.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'Failed to block user on WhatsApp',
        details: failedUsers[0]?.errors || []
      });
    }

    // Update contact in database
    await Contact.findByIdAndUpdate(
      id,
      {
        isBlocked: true,
        blockedAt: new Date(),
        blockedBy: instance._id   // FIX: was referencing undefined `instanceId`
      },
      { new: true }
    );

    res.json({
      success: true,
      message: 'User blocked successfully',
      data: {
        contact: contact.number,
        addedUsers,
        failedUsers,
        metaResponse: response.data
      }
    });

  } catch (error) {
    console.error('blockUser error:', error);

    // Handle Meta API errors (including mixed success/failure 400s)
    if (error.response?.data) {
      return res.status(error.response.status || 500).json({
        success: false,
        error: 'Failed to block user on WhatsApp',
        details: error.response.data.error || error.response.data
      });
    }

    res.status(500).json({
      success: false,
      error: 'Failed to block user'
    });
  }
};

// ==================== UNBLOCK USER (Meta WhatsApp API) ====================
/**
 * Unblock a WhatsApp user using Meta's Graph API
 * Reference: https://developers.facebook.com/docs/whatsapp/cloud-api/guides/block-users
 */
exports.unblockUser = async (req, res) => {
  try {
    const { id } = req.params;

    // Find contact
    const contact = await Contact.findById(id);
    if (!contact) {
      return res.status(404).json({
        success: false,
        error: 'Contact not found'
      });
    }

    // Get instance details
    const { Instance } = require('../models');
    const instance = await Instance.findOne({});

    if (!instance || !instance.accessToken || !instance.numberId) {
      return res.status(400).json({
        success: false,
        error: 'Invalid instance or missing credentials'
      });
    }

    // Format phone number
    const phoneNumber = contact.number.replace(/\+/g, '');

    // Call Meta Graph API to unblock user
    // Endpoint: DELETE /<PHONE_NUMBER_ID>/block_users  (NOT /blocked)
    const metaApiUrl = `${process.env.META_API}/${instance.numberId}/block_users`;

    const response = await axios.delete(metaApiUrl, {
      // FIX: body must use `messaging_product` + `block_users[].user` format
      data: {
        messaging_product: 'whatsapp',
        block_users: [
          {
            user: phoneNumber
          }
        ]
      },
      headers: {
        Authorization: `Bearer ${instance.accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    // Check for partial failures
    const removedUsers = response.data?.block_users?.removed_users || [];
    const failedUsers  = response.data?.block_users?.failed_users  || [];

    if (removedUsers.length === 0 && failedUsers.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'Failed to unblock user on WhatsApp',
        details: failedUsers[0]?.errors || []
      });
    }

    // Update contact in database
    await Contact.findByIdAndUpdate(
      id,
      {
        isBlocked: false,
        unblockedAt: new Date(),
        blockedAt: null,
        blockedBy: null
      },
      { new: true }
    );

    res.json({
      success: true,
      message: 'User unblocked successfully',
      data: {
        contact: contact.number,
        removedUsers,
        failedUsers,
        metaResponse: response.data
      }
    });

  } catch (error) {
    console.error('unblockUser error:', error);

    if (error.response?.data) {
      return res.status(error.response.status || 500).json({
        success: false,
        error: 'Failed to unblock user on WhatsApp',
        details: error.response.data.error || error.response.data
      });
    }

    res.status(500).json({
      success: false,
      error: 'Failed to unblock user'
    });
  }
};

// ==================== GET BLOCKED USERS LIST (Meta WhatsApp API) ====================
/**
 * Get list of blocked users from Meta WhatsApp API
 * Supports pagination via ?limit, ?after, ?before query params
 */
exports.getBlockedUsers = async (req, res) => {
  try {
    // Get instance details
    const { Instance } = require('../models');
    const instance = await Instance.findOne({});

    if (!instance || !instance.accessToken || !instance.numberId) {
      return res.status(400).json({
        success: false,
        error: 'Invalid instance or missing credentials'
      });
    }

    // Support pagination query params forwarded from client
    const { limit, after, before } = req.query;
    const params = {};
    if (limit)  params.limit  = limit;
    if (after)  params.after  = after;
    if (before) params.before = before;

    // Call Meta Graph API to get blocked users
    // Endpoint: GET /<PHONE_NUMBER_ID>/block_users  (NOT /blocked)
    const metaApiUrl = `${process.env.META_API}/${instance.numberId}/block_users`;

    const response = await axios.get(metaApiUrl, {
      params,
      headers: {
        Authorization: `Bearer ${instance.accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    // response.data = { data: [...], paging: { cursors: { after, before } } }
    res.json({
      success: true,
      data:   response.data.data   || [],
      paging: response.data.paging || {}
    });

  } catch (error) {
    console.error('getBlockedUsers error:', error);

    if (error.response?.data) {
      return res.status(error.response.status || 500).json({
        success: false,
        error: 'Failed to fetch blocked users from WhatsApp',
        details: error.response.data.error || error.response.data
      });
    }

    res.status(500).json({
      success: false,
      error: 'Failed to fetch blocked users'
    });
  }
};
