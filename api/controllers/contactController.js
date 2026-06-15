// ==================== controllers/contactController.js ====================
const { Contact, Purchase } = require('../models');
const xlsx = require('xlsx');
const axios = require('axios');

// ── Shared filter builder (used by getContacts + filterContacts) ───────────────
async function buildContactFilter(query) {
  const {
    search,
    last7days,
    lastMonth,
    fromDate,
    toDate,
    status
  } = query;

  const cities  = [].concat(query['cities[]']  || query.cities  || []);
  const states  = [].concat(query['states[]']  || query.states  || []);

  const parseBoolean = value =>
  value === true ||
  value === 'true' ||
  value === '1';

  const filter = {};

  // ── Text search ─────────────────────────────────────────────────────────────
  if (search) {
    filter.$or = [
      { name:   new RegExp(search, 'i') },
      { number: new RegExp(search, 'i') },
      { city:   new RegExp(search, 'i') }
    ];
  }

  // ── Status ──────────────────────────────────────────────────────────────────
  if (status) filter.status = status;

  // ── Location filters ────────────────────────────────────────────────────────

  const cityList = Array.isArray(query.cities)
    ? query.cities
    : Array.isArray(query['cities[]'])
      ? query['cities[]']
      : query.cities
        ? [query.cities]
        : [];

  const stateList = Array.isArray(query.states)
    ? query.states
    : Array.isArray(query['states[]'])
      ? query['states[]']
      : query.states
        ? [query.states]
        : [];

  if (cityList.length) {
    filter.city = {
      $in: cityList
        .filter(Boolean)
        .map(city => new RegExp(`^${city.trim()}$`, 'i'))
    };
  }

  if (stateList.length) {
    filter.state = {
      $in: stateList
        .filter(Boolean)
        .map(state => new RegExp(`^${state.trim()}$`, 'i'))
    };
  }

  // ── Purchase-date filters ───────────────────────────────────────────────────

    const isLast7Days = parseBoolean(last7days);
    const isLastMonth = parseBoolean(lastMonth);

    const hasPurchaseFilter =
      isLast7Days ||
      isLastMonth ||
      (fromDate && toDate);

    if (hasPurchaseFilter) {
      let purchaseFilter = {
        paymentStatus: 'paid'
      };

      if (isLast7Days) {
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - 7);

        purchaseFilter.createdAt = {
          $gte: startDate
        };
      } else if (isLastMonth) {
        const startDate = new Date();
        startDate.setMonth(startDate.getMonth() - 1);

        purchaseFilter.createdAt = {
          $gte: startDate
        };
      } else if (fromDate && toDate) {
        const startDate = new Date(fromDate);

        const endDate = new Date(toDate);
        endDate.setHours(23, 59, 59, 999);

        purchaseFilter.createdAt = {
          $gte: startDate,
          $lte: endDate
        };
      }

      // Get unique customer numbers who purchased in the selected range
      const buyerNumbers = await Purchase.distinct(
        'userNumber',
        purchaseFilter
      );

      if (!buyerNumbers.length) {
        filter._id = { $in: [] };
      } else {
        // Merge with existing number filter if any
        if (filter.number?.$in) {
          filter.number.$in = filter.number.$in.filter(num =>
            buyerNumbers.includes(
              num instanceof RegExp ? num.source.replace(/^\^|\$$/g, '') : num
            )
          );
        } else {
          filter.number = {
            $in: buyerNumbers
          };
        }
      }
    }

  return filter;
}

// ==================== CREATE CONTACT ====================
exports.createContact = async (req, res) => {
  try {
    const { name, number, city, state, pinCode, address } = req.body;

    const existing = await Contact.findOne({ number });
    if (existing) {
      return res.status(400).json({ error: 'Contact already exists' });
    }

    const contact = await Contact.create({ name, number, city, state, pinCode, address });
    res.status(201).json(contact);
  } catch (error) {
    console.error('createContact error:', error);
    res.status(500).json({ error: 'Failed to create contact' });
  }
};

// ==================== GET CONTACTS ====================
// Standard list — supports search, status, pagination
exports.getContacts = async (req, res) => {
  try {
    const { page = 1, limit = 200 } = req.query;
    const pageNum  = parseInt(page,  10);
    const limitNum = parseInt(limit, 10);
    const skip     = (pageNum - 1) * limitNum;

    const filter = await buildContactFilter(req.query);

    const [contacts, total] = await Promise.all([
      Contact.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limitNum).lean(),
      Contact.countDocuments(filter)
    ]);

    res.json({
      success: true,
      data:    contacts,
      pagination: {
        page:  pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum)
      }
    });
  } catch (error) {
    console.error('getContacts error:', error);
    res.status(500).json({ error: 'Failed to fetch contacts' });
  }
};

// ==================== FILTER CONTACTS (for gift cards / discount scope) ====================
// GET /api/contacts/filter
// Accepts: last7days=1 | lastMonth=1 | fromDate=&toDate= | cities[]=X | states[]=Y | search=
// Returns a flat list (no pagination) formatted for picker UIs
exports.filterContacts = async (req, res) => {
  try {
    const filter = await buildContactFilter(req.query);

    const contacts = await Contact.find(filter)
      .select('name number city state email')
      .sort({ name: 1 })
      .lean();

    return res.json({
      success: true,
      total:   contacts.length,
      data:    contacts.map(c => ({
        id:     c._id,
        name:   c.name   || c.number,
        number: c.number,
        city:   c.city   || '',
        state:  c.state  || '',
        email:  c.email  || ''
      }))
    });
  } catch (error) {
    console.error('filterContacts error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ==================== GET SINGLE CONTACT ====================
exports.getContact = async (req, res) => {
  try {
    const contact = await Contact.findById(req.params.id);
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    res.json(contact);
  } catch (error) {
    console.error('getContact error:', error);
    res.status(500).json({ error: 'Failed to fetch contact' });
  }
};

// ==================== UPDATE CONTACT STATUS ====================
exports.updateContactStatus = async (req, res) => {
  try {
    const { status } = req.body;
    const validStatuses = ['enquiry', 'cart', 'checkout', 'not_delivered', 'delivered'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const contact = await Contact.findByIdAndUpdate(req.params.id, { status }, { new: true });
    if (!contact) return res.status(404).json({ error: 'Contact not found' });

    res.json({ success: true, data: contact });
  } catch (error) {
    console.error('updateContactStatus error:', error);
    res.status(500).json({ error: 'Failed to update contact status' });
  }
};

// ==================== UPDATE CONTACT ====================
exports.updateContact = async (req, res) => {
  try {
    const contact = await Contact.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
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
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
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
    if (!filePath) return res.status(400).json({ error: 'File is required' });

    const workbook  = xlsx.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const sheet     = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1 });

    const headers = sheet[0];
    const rows    = sheet.slice(1);

    let createdCount = 0;
    let skippedCount = 0;

    for (const row of rows) {
      const rowData = {};
      headers.forEach((header, index) => { rowData[header] = row[index]; });

      const number = rowData.number ? String(rowData.number).trim() : null;
      if (!number) { skippedCount++; continue; }

      const exists = await Contact.findOne({ number });
      if (exists) { skippedCount++; continue; }

      await Contact.create({
        name:    rowData.name || 'Unnamed',
        number,
        city:    rowData.city    || '',
        state:   rowData.state   || '',
        pinCode: rowData.pinCode || '',
        address: rowData.address || ''
      });
      createdCount++;
    }

    res.status(201).json({ message: 'Bulk contacts upload completed', createdCount, skippedCount });
  } catch (error) {
    console.error('saveContactsInBulk error:', error);
    res.status(500).json({ error: 'Failed to upload contacts in bulk' });
  }
};

// ==================== BLOCK USER (Meta WhatsApp API) ====================
exports.blockUser = async (req, res) => {
  try {
    const { id } = req.params;
    const contact = await Contact.findById(id);
    if (!contact) return res.status(404).json({ success: false, error: 'Contact not found' });

    const { Instance } = require('../models');
    const instance = await Instance.findOne({});
    if (!instance || !instance.accessToken || !instance.numberId) {
      return res.status(400).json({ success: false, error: 'Invalid instance or missing credentials' });
    }

    const phoneNumber  = contact.number.replace(/\+/g, '');
    const metaApiUrl   = `${process.env.META_API}/${instance.numberId}/block_users`;
    const response = await axios.post(metaApiUrl, {
      messaging_product: 'whatsapp',
      block_users: [{ user: phoneNumber }]
    }, {
      headers: { Authorization: `Bearer ${instance.accessToken}`, 'Content-Type': 'application/json' }
    });

    const addedUsers  = response.data?.block_users?.added_users  || [];
    const failedUsers = response.data?.block_users?.failed_users || [];

    if (addedUsers.length === 0 && failedUsers.length > 0) {
      return res.status(400).json({ success: false, error: 'Failed to block user on WhatsApp', details: failedUsers[0]?.errors || [] });
    }

    await Contact.findByIdAndUpdate(id, { isBlocked: true, blockedAt: new Date(), blockedBy: instance._id }, { new: true });

    res.json({ success: true, message: 'User blocked successfully', data: { contact: contact.number, addedUsers, failedUsers, metaResponse: response.data } });
  } catch (error) {
    console.error('blockUser error:', error);
    if (error.response?.data) {
      return res.status(error.response.status || 500).json({ success: false, error: 'Failed to block user on WhatsApp', details: error.response.data.error || error.response.data });
    }
    res.status(500).json({ success: false, error: 'Failed to block user' });
  }
};

// ==================== UNBLOCK USER (Meta WhatsApp API) ====================
exports.unblockUser = async (req, res) => {
  try {
    const { id } = req.params;
    const contact = await Contact.findById(id);
    if (!contact) return res.status(404).json({ success: false, error: 'Contact not found' });

    const { Instance } = require('../models');
    const instance = await Instance.findOne({});
    if (!instance || !instance.accessToken || !instance.numberId) {
      return res.status(400).json({ success: false, error: 'Invalid instance or missing credentials' });
    }

    const phoneNumber = contact.number.replace(/\+/g, '');
    const metaApiUrl  = `${process.env.META_API}/${instance.numberId}/block_users`;
    const response = await axios.delete(metaApiUrl, {
      data: { messaging_product: 'whatsapp', block_users: [{ user: phoneNumber }] },
      headers: { Authorization: `Bearer ${instance.accessToken}`, 'Content-Type': 'application/json' }
    });

    const removedUsers = response.data?.block_users?.removed_users || [];
    const failedUsers  = response.data?.block_users?.failed_users  || [];

    if (removedUsers.length === 0 && failedUsers.length > 0) {
      return res.status(400).json({ success: false, error: 'Failed to unblock user on WhatsApp', details: failedUsers[0]?.errors || [] });
    }

    await Contact.findByIdAndUpdate(id, { isBlocked: false, unblockedAt: new Date(), blockedAt: null, blockedBy: null }, { new: true });

    res.json({ success: true, message: 'User unblocked successfully', data: { contact: contact.number, removedUsers, failedUsers, metaResponse: response.data } });
  } catch (error) {
    console.error('unblockUser error:', error);
    if (error.response?.data) {
      return res.status(error.response.status || 500).json({ success: false, error: 'Failed to unblock user on WhatsApp', details: error.response.data.error || error.response.data });
    }
    res.status(500).json({ success: false, error: 'Failed to unblock user' });
  }
};

// ==================== GET BLOCKED USERS LIST ====================
exports.getBlockedUsers = async (req, res) => {
  try {
    const { Instance } = require('../models');
    const instance = await Instance.findOne({});
    if (!instance || !instance.accessToken || !instance.numberId) {
      return res.status(400).json({ success: false, error: 'Invalid instance or missing credentials' });
    }

    const { limit, after, before } = req.query;
    const params = {};
    if (limit)  params.limit  = limit;
    if (after)  params.after  = after;
    if (before) params.before = before;

    const metaApiUrl = `${process.env.META_API}/${instance.numberId}/block_users`;
    const response   = await axios.get(metaApiUrl, {
      params,
      headers: { Authorization: `Bearer ${instance.accessToken}`, 'Content-Type': 'application/json' }
    });

    res.json({ success: true, data: response.data.data || [], paging: response.data.paging || {} });
  } catch (error) {
    console.error('getBlockedUsers error:', error);
    if (error.response?.data) {
      return res.status(error.response.status || 500).json({ success: false, error: 'Failed to fetch blocked users from WhatsApp', details: error.response.data.error || error.response.data });
    }
    res.status(500).json({ success: false, error: 'Failed to fetch blocked users' });
  }
};