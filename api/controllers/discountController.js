// ==================== controllers/discountController.js ====================
const { Discount } = require('../models');

// ─────────────────────────────────────────────────────────────────────────────
// @desc    Create a new discount campaign
// @route   POST /api/discounts
// @access  Private
// ─────────────────────────────────────────────────────────────────────────────
const createDiscount = async (req, res) => {
  try {
    const {
      campaignName, startDate, endDate, couponCode,
      discountType, pricingModel,
      simpleDiscount, tiers,
      scopes,          // ← NEW: array of scope conditions
      limits, tnc
    } = req.body;

    // Duplicate coupon-code guard (only when a code is provided)
    if (couponCode && couponCode.trim()) {
      const existing = await Discount.findOne({
        couponCode: couponCode.trim().toUpperCase(),
        status: { $ne: 'expired' }
      });
      if (existing) {
        return res.status(400).json({
          success: false,
          message: `Coupon code "${couponCode.toUpperCase()}" already exists.`
        });
      }
    }

    const discount = await Discount.create({
      campaignName,
      startDate,
      endDate,
      couponCode: couponCode ? couponCode.trim().toUpperCase() : '',
      discountType,
      pricingModel,
      simpleDiscount: simpleDiscount || { value: null, minCart: null },
      tiers: pricingModel === 'tiered' ? (tiers || []) : [],
      scopes: Array.isArray(scopes) ? scopes : [],   // ← save scopes array
      limits: limits || {},
      tnc: tnc || '',
      createdBy: req.user._id
    });

    return res.status(201).json({
      success: true,
      message: 'Discount campaign created successfully.',
      data: discount
    });
  } catch (error) {
    console.error('createDiscount error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// @desc    List all discount campaigns (with search / filter / pagination)
// @route   GET /api/discounts
// @access  Private
// ─────────────────────────────────────────────────────────────────────────────
const getDiscounts = async (req, res) => {
  try {
    const {
      search,
      status,
      discountType,
      page      = 1,
      limit     = 20,
      sortBy    = 'createdAt',
      sortOrder = 'desc'
    } = req.query;

    const filter = {};

    if (search) {
      filter.$or = [
        { campaignName: { $regex: search, $options: 'i' } },
        { couponCode:   { $regex: search, $options: 'i' } }
      ];
    }
    if (status)       filter.status       = status;
    if (discountType) filter.discountType = discountType;

    const pageNum  = parseInt(page,  10);
    const limitNum = parseInt(limit, 10);
    const skip     = (pageNum - 1) * limitNum;
    const sortDir  = sortOrder === 'asc' ? 1 : -1;

    const [discounts, total] = await Promise.all([
      Discount.find(filter)
        .sort({ [sortBy]: sortDir })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Discount.countDocuments(filter)
    ]);

    return res.json({
      success: true,
      data: discounts,
      pagination: {
        page:  pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum)
      }
    });
  } catch (error) {
    console.error('getDiscounts error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// @desc    Get a single discount campaign by ID
// @route   GET /api/discounts/:id
// @access  Private
// ─────────────────────────────────────────────────────────────────────────────
const getDiscount = async (req, res) => {
  try {
    const discount = await Discount.findById(req.params.id).lean();
    if (!discount) {
      return res.status(404).json({ success: false, message: 'Discount campaign not found.' });
    }
    return res.json({ success: true, data: discount });
  } catch (error) {
    console.error('getDiscount error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// @desc    Update a discount campaign
// @route   PUT /api/discounts/:id
// @access  Private
// ─────────────────────────────────────────────────────────────────────────────
const updateDiscount = async (req, res) => {
  try {
    const discount = await Discount.findById(req.params.id);
    if (!discount) {
      return res.status(404).json({ success: false, message: 'Discount campaign not found.' });
    }

    const {
      campaignName, startDate, endDate, couponCode,
      discountType, pricingModel,
      simpleDiscount, tiers,
      scopes,          // ← NEW
      limits, tnc, status
    } = req.body;

    // Duplicate coupon-code guard (exclude current doc)
    if (couponCode && couponCode.trim()) {
      const upper = couponCode.trim().toUpperCase();
      const conflict = await Discount.findOne({
        _id:        { $ne: discount._id },
        couponCode: upper,
        status:     { $ne: 'expired' }
      });
      if (conflict) {
        return res.status(400).json({
          success: false,
          message: `Coupon code "${upper}" already exists.`
        });
      }
      discount.couponCode = upper;
    }

    if (campaignName   !== undefined) discount.campaignName   = campaignName;
    if (startDate      !== undefined) discount.startDate      = startDate;
    if (endDate        !== undefined) discount.endDate        = endDate;
    if (discountType   !== undefined) discount.discountType   = discountType;
    if (pricingModel   !== undefined) discount.pricingModel   = pricingModel;
    if (simpleDiscount !== undefined) discount.simpleDiscount = simpleDiscount;
    if (tiers          !== undefined) discount.tiers          = pricingModel === 'tiered' ? tiers : [];
    if (Array.isArray(scopes))        discount.scopes         = scopes;   // ← save scopes array
    if (limits         !== undefined) discount.limits         = { ...discount.limits.toObject?.() ?? discount.limits, ...limits };
    if (tnc            !== undefined) discount.tnc            = tnc;
    if (status         !== undefined) discount.status         = status;

    await discount.save();

    return res.json({
      success: true,
      message: 'Discount campaign updated successfully.',
      data: discount
    });
  } catch (error) {
    console.error('updateDiscount error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// @desc    Delete a discount campaign
// @route   DELETE /api/discounts/:id
// @access  Private
// ─────────────────────────────────────────────────────────────────────────────
const deleteDiscount = async (req, res) => {
  try {
    const discount = await Discount.findByIdAndDelete(req.params.id);
    if (!discount) {
      return res.status(404).json({ success: false, message: 'Discount campaign not found.' });
    }
    return res.json({ success: true, message: 'Discount campaign deleted successfully.' });
  } catch (error) {
    console.error('deleteDiscount error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// @desc    Toggle status (active ↔ inactive)
// @route   PATCH /api/discounts/:id/status
// @access  Private
// ─────────────────────────────────────────────────────────────────────────────
const toggleDiscountStatus = async (req, res) => {
  try {
    const discount = await Discount.findById(req.params.id);
    if (!discount) {
      return res.status(404).json({ success: false, message: 'Discount campaign not found.' });
    }

    const { status } = req.body;
    if (!['active', 'inactive', 'expired'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status value.' });
    }

    discount.status = status;
    await discount.save();

    return res.json({
      success: true,
      message: `Campaign status changed to "${status}".`,
      data: { _id: discount._id, status: discount.status }
    });
  } catch (error) {
    console.error('toggleDiscountStatus error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// @desc    Validate a coupon code at checkout
// @route   POST /api/discounts/validate
// @access  Private
// ─────────────────────────────────────────────────────────────────────────────
const validateCoupon = async (req, res) => {
  try {
    const { couponCode, cartTotal } = req.body;
    if (!couponCode) {
      return res.status(400).json({ success: false, message: 'Coupon code is required.' });
    }

    const discount = await Discount.findOne({
      couponCode: couponCode.trim().toUpperCase(),
      status: 'active'
    }).lean();

    if (!discount) {
      return res.status(404).json({ success: false, message: 'Invalid or expired coupon code.' });
    }

    // Date check
    const now = new Date();
    if (discount.startDate && new Date(discount.startDate) > now) {
      return res.status(400).json({ success: false, message: 'This coupon is not yet active.' });
    }
    if (discount.endDate && new Date(discount.endDate) < now) {
      return res.status(400).json({ success: false, message: 'This coupon has expired.' });
    }

    // Calculate discount amount
    let discountAmount = 0;
    const cart = Number(cartTotal) || 0;

    if (discount.pricingModel === 'simple') {
      const minCart = discount.simpleDiscount?.minCart || 0;
      if (cart < minCart) {
        return res.status(400).json({
          success: false,
          message: `Minimum order of ₹${minCart} required for this coupon.`
        });
      }
      const val = discount.simpleDiscount?.value || 0;
      discountAmount = discount.discountType === 'percent'
        ? (cart * val) / 100
        : val;
    } else {
      const eligibleTiers = (discount.tiers || [])
        .filter(t => cart >= t.minCart)
        .sort((a, b) => b.minCart - a.minCart);

      if (eligibleTiers.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'Cart total does not meet any tier threshold for this coupon.'
        });
      }
      const best = eligibleTiers[0];
      discountAmount = discount.discountType === 'percent'
        ? (cart * best.value) / 100
        : best.value;
    }

    return res.json({
      success: true,
      message: 'Coupon applied successfully.',
      data: {
        discount,
        discountAmount: Math.min(discountAmount, cart),
        finalAmount:    Math.max(cart - discountAmount, 0)
      }
    });
  } catch (error) {
    console.error('validateCoupon error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = {
  createDiscount,
  getDiscounts,
  getDiscount,
  updateDiscount,
  deleteDiscount,
  toggleDiscountStatus,
  validateCoupon
};