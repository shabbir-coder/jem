// ==================== controllers/giftCardController.js ====================
// Gift cards are personal discount coupons tied to a specific customer (contact).
// Each card has its own unique coupon code stored in the Discount model
// with a scope: [{ type: 'customers', selectedIds: [contactId] }].

const mongoose = require('mongoose');
const { Contact, Purchase } = require('../models');

// ── Inline GiftCard model ─────────────────────────────────────────────────────
// Stores the "card metadata" (design, message, delivery status).
// The actual coupon logic lives in the Discount model via couponCode linkage.

const giftCardSchema = new mongoose.Schema({
  couponCode:     { type: String, required: true, unique: true, uppercase: true, trim: true },
  campaignName:   { type: String, required: true, trim: true },
  recipientId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Contact', required: true },
  recipientName:  { type: String },
  recipientNumber:{ type: String },
  discountType:   { type: String, enum: ['percent', 'flat', 'freeShipping'], default: 'percent' },
  discountValue:  { type: Number, default: 0 },
  minCart:        { type: Number, default: 0 },
  startDate:      { type: Date },
  endDate:        { type: Date },
  message:        { type: String, trim: true, default: '' },
  status:         { type: String, enum: ['active', 'inactive', 'sent', 'used', 'expired'], default: 'active' },
  sentAt:         { type: Date },
  usedAt:         { type: Date },
  discountDocId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Discount' },
  createdBy:      { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

giftCardSchema.index({ recipientId: 1 });
giftCardSchema.index({ couponCode: 1 });
giftCardSchema.index({ status: 1 });

const GiftCard = mongoose.models.GiftCard || mongoose.model('GiftCard', giftCardSchema);
exports.GiftCard = GiftCard;

// ─────────────────────────────────────────────────────────────────────────────
// Helper: generate a unique coupon code
// ─────────────────────────────────────────────────────────────────────────────
async function generateUniqueCouponCode(prefix = 'GIFT') {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code, exists;
  do {
    const random = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    code = `${prefix}-${random}`;
    // Check both GiftCard and Discount models
    const [gcExists, discExists] = await Promise.all([
      GiftCard.findOne({ couponCode: code }),
      mongoose.models.Discount?.findOne({ couponCode: code })
    ]);
    exists = gcExists || discExists;
  } while (exists);
  return code;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: build customer filter from query params for purchase-based filters
// Supports: locationsIds[], last7days, lastMonth, fromDate+toDate
// ─────────────────────────────────────────────────────────────────────────────
async function buildCustomerFilter(filterParams) {
  const {
    last7days, lastMonth, fromDate, toDate,
    locationIds, cities, states
  } = filterParams;

  const now = new Date();
  let contactIds = null; // null = no purchase-based filter (all contacts)

  // ── Purchase date filters ─────────────────────────────────────────────────
  if (last7days || lastMonth || (fromDate && toDate)) {
    let dateFilter = {};
    if (last7days) {
      const d = new Date(now);
      d.setDate(d.getDate() - 7);
      dateFilter = { createdAt: { $gte: d } };
    } else if (lastMonth) {
      const d = new Date(now);
      d.setMonth(d.getMonth() - 1);
      dateFilter = { createdAt: { $gte: d } };
    } else if (fromDate && toDate) {
      dateFilter = { createdAt: { $gte: new Date(fromDate), $lte: new Date(toDate) } };
    }

    // Find unique buyer numbers from purchases within the date window
    const purchases = await Purchase.find({
      ...dateFilter,
      paymentStatus: 'paid'
    }).select('userNumber').lean();

    const buyerNumbers = [...new Set(purchases.map(p => p.userNumber).filter(Boolean))];
    if (buyerNumbers.length === 0) return { _id: { $in: [] } }; // no buyers = no contacts

    // Match contacts by their phone numbers
    const contacts = await Contact.find({ number: { $in: buyerNumbers } }).select('_id').lean();
    contactIds = contacts.map(c => c._id);
  }

  // ── Location filters ──────────────────────────────────────────────────────
  const locationFilter = {};
  if (cities?.length) locationFilter.city = { $in: cities };
  if (states?.length) locationFilter.state = { $in: states };

  // ── Compose final filter ──────────────────────────────────────────────────
  const finalFilter = { ...locationFilter };
  if (contactIds !== null) {
    finalFilter._id = { $in: contactIds };
  }

  return finalFilter;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/gift-cards/customers/filter
// Preview which customers match the given filters (before generating cards)
// Query: last7days=1 | lastMonth=1 | fromDate=&toDate= | cities[]=X | states[]=Y
// ─────────────────────────────────────────────────────────────────────────────
exports.previewCustomers = async (req, res) => {
  try {
    const { last7days, lastMonth, fromDate, toDate, search } = req.query;
    const cities  = [].concat(req.query['cities[]']  || req.query.cities  || []);
    const states  = [].concat(req.query['states[]']  || req.query.states  || []);

    const baseFilter = await buildCustomerFilter({ last7days, lastMonth, fromDate, toDate, cities, states });

    if (search) {
      baseFilter.$or = [
        { name:   new RegExp(search, 'i') },
        { number: new RegExp(search, 'i') },
        { city:   new RegExp(search, 'i') }
      ];
    }

    const contacts = await Contact.find(baseFilter)
      .select('name number city state email')
      .sort({ name: 1 })
      .lean();

    return res.json({
      success: true,
      total:   contacts.length,
      data:    contacts.map(c => ({
        id:     c._id,
        name:   c.name,
        number: c.number,
        city:   c.city  || '',
        state:  c.state || '',
        email:  c.email || ''
      }))
    });
  } catch (error) {
    console.error('previewCustomers error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/gift-cards/generate
// Generate gift cards for one or more customers.
// Body: {
//   campaignName, discountType, discountValue, minCart, startDate, endDate, message,
//   // Recipients — supply ONE of:
//   customerIds: ['id1','id2'],          // explicit list (always available)
//   // OR filter params:
//   filterBy: { last7days, lastMonth, fromDate, toDate, cities, states, selectAll }
// }
// ─────────────────────────────────────────────────────────────────────────────
exports.generateGiftCards = async (req, res) => {
  try {
    const {
      campaignName, discountType = 'percent', discountValue,
      minCart = 0, startDate, endDate, message = '',
      customerIds,
      filterBy = {}
    } = req.body;

    if (!campaignName) return res.status(400).json({ success: false, message: 'Campaign name is required.' });
    if (!discountValue && discountType !== 'freeShipping')
      return res.status(400).json({ success: false, message: 'Discount value is required.' });

    // ── Resolve recipient contact list ────────────────────────────────────────
    let contacts = [];

    if (customerIds?.length) {
      // Explicit IDs (from manual selection or filter-then-select-all)
      contacts = await Contact.find({ _id: { $in: customerIds } })
        .select('name number city state')
        .lean();
    } else if (filterBy.selectAll || Object.keys(filterBy).length > 0) {
      // Filter-based: grab all matching customers
      const filter = await buildCustomerFilter(filterBy);
      contacts = await Contact.find(filter)
        .select('name number city state')
        .lean();
    }

    if (contacts.length === 0) {
      return res.status(400).json({ success: false, message: 'No customers match the given criteria.' });
    }

    // ── Create gift card + linked Discount doc for each customer ──────────────
    const Discount = mongoose.models.Discount;
    const created  = [];
    const errors   = [];

    for (const contact of contacts) {
      try {
        const couponCode = await generateUniqueCouponCode('GIFT');

        // 1. Create Discount doc (used by the /apply endpoint for checkout validation)
        let discountDoc = null;
        if (Discount) {
          discountDoc = await Discount.create({
            campaignName: `${campaignName} — ${contact.name || contact.number}`,
            couponCode,
            discountType,
            pricingModel:   'simple',
            simpleDiscount: { value: Number(discountValue) || 0, minCart: Number(minCart) || 0 },
            tiers:   [],
            scopes:  [{ type: 'customers', selectedIds: [String(contact._id)], selectedLabels: [contact.name || contact.number] }],
            limits:  { maxUses: 1, maxPerUser: 1, combineOther: false, firstOrderOnly: false, newCustomerOnly: false },
            startDate: startDate || null,
            endDate:   endDate   || null,
            tnc:       message   || '',
            status:    'active',
            createdBy: req.user?._id
          });
        }

        // 2. Create GiftCard metadata doc
        const giftCard = await GiftCard.create({
          couponCode,
          campaignName,
          recipientId:     contact._id,
          recipientName:   contact.name,
          recipientNumber: contact.number,
          discountType,
          discountValue:   Number(discountValue) || 0,
          minCart:         Number(minCart) || 0,
          startDate:       startDate || null,
          endDate:         endDate   || null,
          message,
          status:          'active',
          discountDocId:   discountDoc?._id || null,
          createdBy:       req.user?._id
        });

        created.push({
          id:              giftCard._id,
          couponCode:      giftCard.couponCode,
          recipientName:   giftCard.recipientName,
          recipientNumber: giftCard.recipientNumber,
          discountType:    giftCard.discountType,
          discountValue:   giftCard.discountValue,
          startDate:       giftCard.startDate,
          endDate:         giftCard.endDate,
          message:         giftCard.message,
          status:          giftCard.status
        });
      } catch (err) {
        errors.push({ contactId: contact._id, error: err.message });
      }
    }

    return res.status(201).json({
      success: true,
      message: `${created.length} gift card(s) generated successfully.${errors.length ? ` ${errors.length} failed.` : ''}`,
      data:    created,
      errors:  errors.length ? errors : undefined
    });
  } catch (error) {
    console.error('generateGiftCards error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/gift-cards
// List gift cards with optional filters
// ─────────────────────────────────────────────────────────────────────────────
exports.getGiftCards = async (req, res) => {
  try {
    const { search, status, page = 1, limit = 20 } = req.query;

    const filter = {};
    if (status) filter.status = status;
    if (search) {
      filter.$or = [
        { couponCode:      new RegExp(search, 'i') },
        { campaignName:    new RegExp(search, 'i') },
        { recipientName:   new RegExp(search, 'i') },
        { recipientNumber: new RegExp(search, 'i') }
      ];
    }

    const pageNum  = parseInt(page,  10);
    const limitNum = parseInt(limit, 10);
    const skip     = (pageNum - 1) * limitNum;

    const [cards, total] = await Promise.all([
      GiftCard.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      GiftCard.countDocuments(filter)
    ]);

    return res.json({
      success: true,
      data:    cards,
      pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) }
    });
  } catch (error) {
    console.error('getGiftCards error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/gift-cards/:id
// ─────────────────────────────────────────────────────────────────────────────
exports.getGiftCard = async (req, res) => {
  try {
    const card = await GiftCard.findById(req.params.id).lean();
    if (!card) return res.status(404).json({ success: false, message: 'Gift card not found.' });
    return res.json({ success: true, data: card });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/gift-cards/:id/status
// ─────────────────────────────────────────────────────────────────────────────
exports.updateGiftCardStatus = async (req, res) => {
  try {
    const { status } = req.body;
    const validStatuses = ['active', 'inactive', 'sent', 'used', 'expired'];
    if (!validStatuses.includes(status))
      return res.status(400).json({ success: false, message: 'Invalid status.' });

    const card = await GiftCard.findByIdAndUpdate(req.params.id, { status }, { new: true });
    if (!card) return res.status(404).json({ success: false, message: 'Gift card not found.' });

    // Also sync the linked Discount doc's status
    if (card.discountDocId && mongoose.models.Discount) {
      const discStatus = status === 'active' ? 'active' : status === 'expired' ? 'expired' : 'inactive';
      await mongoose.models.Discount.findByIdAndUpdate(card.discountDocId, { status: discStatus });
    }

    return res.json({ success: true, message: `Gift card status changed to "${status}".`, data: card });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/gift-cards/:id
// ─────────────────────────────────────────────────────────────────────────────
exports.deleteGiftCard = async (req, res) => {
  try {
    const card = await GiftCard.findByIdAndDelete(req.params.id);
    if (!card) return res.status(404).json({ success: false, message: 'Gift card not found.' });

    // Also delete the linked Discount doc
    if (card.discountDocId && mongoose.models.Discount) {
      await mongoose.models.Discount.findByIdAndDelete(card.discountDocId);
    }

    return res.json({ success: true, message: 'Gift card deleted.' });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/gift-cards/contact/:contactId
// All gift cards for a specific customer
// ─────────────────────────────────────────────────────────────────────────────
exports.getGiftCardsForContact = async (req, res) => {
  try {
    const cards = await GiftCard.find({ recipientId: req.params.contactId })
      .sort({ createdAt: -1 })
      .lean();
    return res.json({ success: true, data: cards });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};