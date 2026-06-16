// ==================== controllers/discountController.js ====================
const { Discount, Purchase } = require('../models');
const { GiftCard } = require('./giftCardController');
// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────

const toNum = v => parseFloat(String(v).replace(/[^0-9.]/g, '')) || 0;

/**
 * Decide which cart items are eligible for a given discount campaign.
 * Returns { eligibleItems, ineligibleItems }
 * AND logic: item must satisfy ALL item-level scopes that are set.
 */
function splitItemsByScope(cartItems, discount) {
  const productScope  = discount.scopes?.find(s => s.type === 'products');
  const categoryScope = discount.scopes?.find(s => s.type === 'categories');
  const hasItemScope  = !!(productScope?.selectedIds?.length || categoryScope?.selectedIds?.length);

  if (!hasItemScope) {
    return { eligibleItems: [...cartItems], ineligibleItems: [] };
  }

  const eligibleItems   = [];
  const ineligibleItems = [];

  for (const item of cartItems) {
    let productOk  = true;
    let categoryOk = true;

    if (productScope?.selectedIds?.length) {
      productOk = productScope.selectedIds.includes(String(item.productId));
    }
    if (categoryScope?.selectedIds?.length) {
      categoryOk = categoryScope.selectedIds.includes(String(item.categoryId));
    }

    if (productOk && categoryOk) {
      eligibleItems.push(item);
    } else {
      ineligibleItems.push(item);
    }
  }

  return { eligibleItems, ineligibleItems };
}

/**
 * Compute the discount amount for a single campaign against an eligible subtotal.
 * Returns { discountAmount, tierApplied, freeShipping, error }
 */
function computeDiscount(discount, eligibleSubtotal) {
  // Free shipping
  if (discount.discountType === 'freeShipping') {
    const minCart = discount.simpleDiscount?.minCart || 0;
    if (eligibleSubtotal < minCart) {
      return {
        discountAmount: 0, tierApplied: null, freeShipping: false,
        error: `Minimum eligible amount ₹${minCart} required for free shipping (you have ₹${eligibleSubtotal.toFixed(2)}).`
      };
    }
    return { discountAmount: 0, tierApplied: null, freeShipping: true, error: null };
  }

  // Simple
  if (discount.pricingModel === 'simple') {
    const minCart = discount.simpleDiscount?.minCart || 0;
    if (eligibleSubtotal < minCart) {
      return {
        discountAmount: 0, tierApplied: null, freeShipping: false,
        error: `Minimum eligible amount ₹${minCart} required (you have ₹${eligibleSubtotal.toFixed(2)}).`
      };
    }
    const val = discount.simpleDiscount?.value || 0;
    const amount = discount.discountType === 'percent'
      ? (eligibleSubtotal * val) / 100
      : val;
    return { discountAmount: Math.min(amount, eligibleSubtotal), tierApplied: null, freeShipping: false, error: null };
  }

  // Tiered
  const sortedDesc = [...(discount.tiers || [])].sort((a, b) => b.minCart - a.minCart);
  const bestTier   = sortedDesc.find(t => eligibleSubtotal >= t.minCart);

  if (!bestTier) {
    const lowest = sortedDesc[sortedDesc.length - 1];
    return {
      discountAmount: 0, tierApplied: null, freeShipping: false,
      error: `Minimum eligible amount ₹${lowest?.minCart} required for this tiered discount (you have ₹${eligibleSubtotal.toFixed(2)}).`
    };
  }

  const amount = discount.discountType === 'percent'
    ? (eligibleSubtotal * bestTier.value) / 100
    : bestTier.value;

  return {
    discountAmount: Math.min(amount, eligibleSubtotal),
    tierApplied:    { minCart: bestTier.minCart, value: bestTier.value },
    freeShipping:   false,
    error:          null
  };
}

/**
 * Build next-tier hint for a tiered campaign.
 */
function getNextTierHint(discount, eligibleSubtotal) {
  if (discount.pricingModel !== 'tiered') return null;
  const sortedAsc = [...(discount.tiers || [])].sort((a, b) => a.minCart - b.minCart);
  const next = sortedAsc.find(t => t.minCart > eligibleSubtotal);
  if (!next) return null;
  const shortfall = parseFloat((next.minCart - eligibleSubtotal).toFixed(2));
  return {
    minCart:  next.minCart,
    value:    next.value,
    shortfall,
    hint: `Add ₹${shortfall} more eligible items to unlock ${
      discount.discountType === 'percent' ? next.value + '% off' : '₹' + next.value + ' off'
    }`
  };
}

/**
 * Build per-item discount breakdown (proportional split).
 */
function buildItemBreakdown(eligibleItems, discountAmount, eligibleSubtotal) {
  return eligibleItems.map(item => {
    const itemTotal  = toNum(item.price) * (item.quantity || 1);
    const itemShare  = eligibleSubtotal > 0 ? itemTotal / eligibleSubtotal : 0;
    const itemDisc   = parseFloat((discountAmount * itemShare).toFixed(2));
    return {
      productId:       item.productId,
      productName:     item.productName,
      price:           toNum(item.price),
      quantity:        item.quantity || 1,
      itemTotal:       parseFloat(itemTotal.toFixed(2)),
      discountApplied: itemDisc,
      finalItemTotal:  parseFloat((itemTotal - itemDisc).toFixed(2))
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Customer-level eligibility check for a single campaign.
// Returns null if eligible, or an error string if not.
// ─────────────────────────────────────────────────────────────────────────────
async function checkCustomerEligibility(discount, { customerId, customerNumber }) {
  // ── Gift card: customer already validated at fetch time, skip scope check ──
  if (!discount._isGiftCard) {
    const customerScope = discount.scopes?.find(s => s.type === 'customers');
    if (customerScope?.selectedIds?.length) {
      const allowed = customerId
        ? customerScope.selectedIds.includes(String(customerId))
        : false;
      if (!allowed) return 'This coupon is not valid for your account.';
    }
  }

  // newCustomerOnly
  if (discount.limits?.newCustomerOnly && customerNumber) {
    const paidOrders = await Purchase.countDocuments({ userNumber: customerNumber });
    if (paidOrders > 0) return 'This coupon is only valid for new customers.';
  }

  // firstOrderOnly
  if (discount.limits?.firstOrderOnly && customerNumber) {
    const orderCount = await Purchase.countDocuments({ userNumber: customerNumber });
    if (orderCount > 0) return 'This coupon is only valid on your first order.';
  }

  // maxUses
  if (discount.limits?.maxUses != null) {
    const total = await Purchase.countDocuments({
      'appliedDiscounts.campaignId': discount._id
    });
    if (total >= discount.limits.maxUses) return 'This coupon has reached its maximum usage limit.';
  }

  // maxPerUser
  if (discount.limits?.maxPerUser != null && customerNumber) {
    const userCount = await Purchase.countDocuments({
      userNumber: customerNumber,
      'appliedDiscounts.campaignId': discount._id
    });
    if (userCount >= discount.limits.maxPerUser)
      return `You have already used this coupon the maximum allowed times (${discount.limits.maxPerUser}).`;
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// @desc    Apply ALL eligible discounts to a cart (multi-discount engine)
// @route   POST /api/discounts/apply
// @access  Private
//
// Body: {
//   couponCode?:     string   — specific code (optional)
//   customerNumber:  string
//   customerId:      string
//   cartItems: [{
//     productId, categoryId, productName, price, quantity
//   }]
// }
//
// Logic:
//  1. If couponCode provided → evaluate ONLY that campaign
//     (still respects combineOther against active auto-apply campaigns)
//  2. If no couponCode → find ALL active campaigns with empty couponCode (auto-apply)
//  3. For each candidate campaign run full eligibility + item-split
//  4. combineOther=false on ANY applied campaign blocks adding further campaigns
//  5. Each campaign's discount is calculated on ITS OWN eligible items' subtotal
//     (items can be eligible for multiple campaigns → each gets its own deduction)
//  6. Aggregate final amounts and return full breakdown per campaign
// ─────────────────────────────────────────────────────────────────────────────
const applyDiscount = async (req, res) => {
  try {
    const {
      couponCode,
      customerNumber,
      customerId,
      cartItems = [],
    } = req.body;

    if (!cartItems.length) {
      return res.status(400).json({ success: false, message: 'Cart is empty.' });
    }

    const now = new Date();

    // ── 1. Gather candidate campaigns ─────────────────────────────────────────
    let candidates = [];

    // 1a. Always fetch auto-apply campaigns (empty couponCode)
    const autoApplyCandidates = await Discount.find({ couponCode: '', status: 'active' }).lean();
    candidates = [...autoApplyCandidates];

    // 1b. Auto-fetch active gift cards for this customer number
    if (customerNumber) {
    
      const activeGiftCards = await GiftCard.find({
        recipientNumber: "+" + customerNumber,
        status: 'active'
      }).lean();

      if (activeGiftCards.length) {
        const giftCardDiscountIds = activeGiftCards
          .map(gc => gc.discountDocId)
          .filter(Boolean);

        const giftCardDiscounts = await Discount.find({
          _id: { $in: giftCardDiscountIds },
          status: 'active'
        }).lean();

        // Tag them so scope check knows to skip customer ID validation
        giftCardDiscounts.forEach(d => { d._isGiftCard = true; });
        candidates.push(...giftCardDiscounts);
      }
    }

    // 1c. If a coupon code was provided, fetch that campaign too
    if (couponCode && couponCode.trim()) {
      const upper = couponCode.trim().toUpperCase();

      // Check if it's a gift card coupon first
      const giftCardByCoupon = await GiftCard.findOne({
        couponCode: upper,
        status: 'active'
      }).lean();

      if (giftCardByCoupon) {
        // Validate it belongs to this customer
        if (customerNumber && giftCardByCoupon.recipientNumber !== customerNumber) {
          return res.status(403).json({
            success: false,
            message: 'This gift card coupon is not valid for your account.'
          });
        }

        // Load its linked Discount doc
        if (giftCardByCoupon.discountDocId) {
          const gcDiscount = await Discount.findOne({
            _id: giftCardByCoupon.discountDocId,
            status: 'active'
          }).lean();

          if (!gcDiscount) {
            return res.status(404).json({ success: false, message: 'Invalid or expired gift card.' });
          }

          // Avoid duplicate if already auto-fetched in step 1b
          const alreadyAdded = candidates.some(c => String(c._id) === String(gcDiscount._id));
          if (!alreadyAdded) {
            gcDiscount._isGiftCard = true;
            candidates.push(gcDiscount);
          }
        }
      } else {
        // Regular coupon code
        const couponCandidate = await Discount.findOne({
          couponCode: upper,
          status: 'active'
        }).lean();

        if (!couponCandidate) {
          return res.status(404).json({ success: false, message: 'Invalid or expired coupon code.' });
        }

        // Avoid duplicate
        const alreadyAdded = candidates.some(c => String(c._id) === String(couponCandidate._id));
        if (!alreadyAdded) candidates.push(couponCandidate);
      }
    }

    // ── 2. Filter by date validity ────────────────────────────────────────────
    candidates = candidates.filter(d => {
      if (d.startDate && new Date(d.startDate) > now) return false;
      if (d.endDate   && new Date(d.endDate)   < now) return false;
      return true;
    });

    if (!candidates.length) {
      return res.status(200).json({
        success: false,
        message: 'No active discounts found for your cart.',
        data: { appliedDiscounts: [], skippedDiscounts: [] }
      });
    }

    // ── 3. Evaluate each campaign ─────────────────────────────────────────────
    const customerCtx = { customerId, customerNumber };

    const appliedResults  = [];
    const skippedResults  = [];

    let nonCombinableLocked = false;

    for (const discount of candidates) {

      // 3a. combineOther gate
      if (nonCombinableLocked) {
        skippedResults.push({
          campaignId:   discount._id,
          campaignName: discount.campaignName,
          couponCode:   discount.couponCode || null,
          reason: 'Skipped — a previously applied coupon cannot be combined with other offers.'
        });
        continue;
      }

      if (!discount.limits?.combineOther && appliedResults.length > 0) {
        skippedResults.push({
          campaignId:   discount._id,
          campaignName: discount.campaignName,
          couponCode:   discount.couponCode || null,
          reason: 'This coupon cannot be combined with other offers already applied.'
        });
        continue;
      }

      // 3b. Customer eligibility
      const customerError = await checkCustomerEligibility(discount, customerCtx);
      if (customerError) {
        skippedResults.push({
          campaignId:   discount._id,
          campaignName: discount.campaignName,
          couponCode:   discount.couponCode || null,
          reason: customerError
        });
        continue;
      }

      // 3c. Item eligibility
      const { eligibleItems, ineligibleItems } = splitItemsByScope(cartItems, discount);
      if (!eligibleItems.length) {
        skippedResults.push({
          campaignId:   discount._id,
          campaignName: discount.campaignName,
          couponCode:   discount.couponCode || null,
          reason: 'No items in your cart are eligible for this discount.'
        });
        continue;
      }

      // 3d. Compute financials
      const eligibleSubtotal = eligibleItems.reduce(
        (s, i) => s + toNum(i.price) * (i.quantity || 1), 0
      );

      const { discountAmount, tierApplied, freeShipping, error } =
        computeDiscount(discount, eligibleSubtotal);

      if (error) {
        skippedResults.push({
          campaignId:   discount._id,
          campaignName: discount.campaignName,
          couponCode:   discount.couponCode || null,
          reason: error
        });
        continue;
      }

      // ✅ Campaign passes — record it
      appliedResults.push({
        campaignId:    discount._id,
        campaignName:  discount.campaignName,
        couponCode:    discount.couponCode || null,
        discountType:  discount.discountType,
        pricingModel:  discount.pricingModel,
        freeShipping,
        isGiftCard:    discount._isGiftCard || false,

        eligibleItems:   eligibleItems.map(i => ({ productId: i.productId, productName: i.productName })),
        ineligibleItems: ineligibleItems.map(i => ({ productId: i.productId, productName: i.productName })),
        itemBreakdown:   buildItemBreakdown(eligibleItems, discountAmount, eligibleSubtotal),

        eligibleSubtotal:   parseFloat(eligibleSubtotal.toFixed(2)),
        discountAmount:     parseFloat(discountAmount.toFixed(2)),

        tierApplied: tierApplied,
        nextTier:    getNextTierHint(discount, eligibleSubtotal),

        appliedDiscountEmbed: {
          campaignId:     discount._id,
          campaignName:   discount.campaignName,
          couponCode:     discount.couponCode || null,
          discountType:   discount.discountType,
          discountAmount: parseFloat(discountAmount.toFixed(2)),
          freeShipping
        }
      });

      // Lock combinability if this campaign is non-combinable
      if (!discount.limits?.combineOther) {
        nonCombinableLocked = true;
      }
    }

    // ── 4. Nothing applied ────────────────────────────────────────────────────
    if (!appliedResults.length) {
      return res.status(200).json({
        success: false,
        message: 'No active discounts found for your cart.',
      });
    }

    // ── 5. Aggregate totals ───────────────────────────────────────────────────
    const cartSubtotal    = cartItems.reduce((s, i) => s + toNum(i.price) * (i.quantity || 1), 0);
    const totalDiscount   = appliedResults.reduce((s, r) => s + r.discountAmount, 0);
    const hasFreeShipping = appliedResults.some(r => r.freeShipping);
    const cappedDiscount  = Math.min(totalDiscount, cartSubtotal);
    const finalAmount     = Math.max(cartSubtotal - cappedDiscount, 0);

    // ── 6. Per-product merged summary ─────────────────────────────────────────
    const productMap = new Map();
    for (const item of cartItems) {
      const key = String(item.productId);
      productMap.set(key, {
        productId:        item.productId,
        productName:      item.productName,
        price:            toNum(item.price),
        quantity:         item.quantity || 1,
        itemTotal:        parseFloat((toNum(item.price) * (item.quantity || 1)).toFixed(2)),
        totalDiscount:    0,
        finalItemTotal:   0,
        appliedCampaigns: []
      });
    }

    for (const result of appliedResults) {
      for (const bd of result.itemBreakdown) {
        const entry = productMap.get(String(bd.productId));
        if (!entry) continue;
        entry.totalDiscount = parseFloat((entry.totalDiscount + bd.discountApplied).toFixed(2));
        entry.appliedCampaigns.push({
          campaignName:    result.campaignName,
          discountApplied: bd.discountApplied
        });
      }
    }
    for (const entry of productMap.values()) {
      entry.finalItemTotal = parseFloat((entry.itemTotal - entry.totalDiscount).toFixed(2));
    }

    // ── 7. Response ───────────────────────────────────────────────────────────
    const totalApplied = appliedResults.length;
    const summaryMsg = totalApplied === 1
      ? `1 discount applied — you save ₹${cappedDiscount.toFixed(2)}!`
      : `${totalApplied} discounts applied — you save ₹${cappedDiscount.toFixed(2)} in total!`;

    return res.json({
      success: true,
      message: summaryMsg,
      data: {
        cartSubtotal:    parseFloat(cartSubtotal.toFixed(2)),
        totalDiscount:   parseFloat(cappedDiscount.toFixed(2)),
        finalAmount:     parseFloat(finalAmount.toFixed(2)),
        hasFreeShipping,

        appliedDiscounts:      appliedResults,
        skippedDiscounts:      skippedResults,
        productSummary:        Array.from(productMap.values()),
        appliedDiscountsEmbed: appliedResults.map(r => r.appliedDiscountEmbed)
      }
    });

  } catch (error) {
    console.error('applyDiscount error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// @desc    Create discount
// @route   POST /api/discounts
// ─────────────────────────────────────────────────────────────────────────────
const createDiscount = async (req, res) => {
  try {
    const { campaignName, startDate, endDate, couponCode,
            discountType, pricingModel, simpleDiscount,
            tiers, scopes, limits, tnc } = req.body;

    if (couponCode && couponCode.trim()) {
      const existing = await Discount.findOne({
        couponCode: couponCode.trim().toUpperCase(), status: { $ne: 'expired' }
      });
      if (existing) return res.status(400).json({
        success: false, message: `Coupon code "${couponCode.toUpperCase()}" already exists.`
      });
    }

    const discount = await Discount.create({
      campaignName, startDate, endDate,
      couponCode: couponCode ? couponCode.trim().toUpperCase() : '',
      discountType, pricingModel,
      simpleDiscount: simpleDiscount || { value: null, minCart: null },
      tiers: pricingModel === 'tiered' ? (tiers || []) : [],
      scopes: Array.isArray(scopes) ? scopes : [],
      limits: limits || {},
      tnc: tnc || '',
      createdBy: req.user._id
    });

    return res.status(201).json({ success: true, message: 'Discount campaign created successfully.', data: discount });
  } catch (error) {
    console.error('createDiscount error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// @desc    List discounts
// @route   GET /api/discounts
// ─────────────────────────────────────────────────────────────────────────────
const getDiscounts = async (req, res) => {
  try {
    const { search, status, discountType,
            page = 1, limit = 20, sortBy = 'createdAt', sortOrder = 'desc' } = req.query;

    const filter = {};
    if (search) filter.$or = [
      { campaignName: { $regex: search, $options: 'i' } },
      { couponCode:   { $regex: search, $options: 'i' } }
    ];
    if (status)       filter.status       = status;
    if (discountType) filter.discountType = discountType;

    const pageNum  = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);
    const skip     = (pageNum - 1) * limitNum;

    const [discounts, total] = await Promise.all([
      Discount.find(filter).sort({ [sortBy]: sortOrder === 'asc' ? 1 : -1 }).skip(skip).limit(limitNum).lean(),
      Discount.countDocuments(filter)
    ]);

    return res.json({
      success: true, data: discounts,
      pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) }
    });
  } catch (error) {
    console.error('getDiscounts error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// @desc    Get single discount
// @route   GET /api/discounts/:id
// ─────────────────────────────────────────────────────────────────────────────
const getDiscount = async (req, res) => {
  try {
    const discount = await Discount.findById(req.params.id).lean();
    if (!discount) return res.status(404).json({ success: false, message: 'Discount campaign not found.' });
    return res.json({ success: true, data: discount });
  } catch (error) {
    console.error('getDiscount error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// @desc    Update discount
// @route   PUT /api/discounts/:id
// ─────────────────────────────────────────────────────────────────────────────
const updateDiscount = async (req, res) => {
  try {
    const discount = await Discount.findById(req.params.id);
    if (!discount) return res.status(404).json({ success: false, message: 'Discount campaign not found.' });

    const { campaignName, startDate, endDate, couponCode,
            discountType, pricingModel, simpleDiscount,
            tiers, scopes, limits, tnc, status } = req.body;

    if (couponCode && couponCode.trim()) {
      const upper = couponCode.trim().toUpperCase();
      const conflict = await Discount.findOne({ _id: { $ne: discount._id }, couponCode: upper, status: { $ne: 'expired' } });
      if (conflict) return res.status(400).json({ success: false, message: `Coupon code "${upper}" already exists.` });
      discount.couponCode = upper;
    }

    if (campaignName   !== undefined) discount.campaignName   = campaignName;
    if (startDate      !== undefined) discount.startDate      = startDate;
    if (endDate        !== undefined) discount.endDate        = endDate;
    if (discountType   !== undefined) discount.discountType   = discountType;
    if (pricingModel   !== undefined) discount.pricingModel   = pricingModel;
    if (simpleDiscount !== undefined) discount.simpleDiscount = simpleDiscount;
    if (tiers          !== undefined) discount.tiers          = pricingModel === 'tiered' ? tiers : [];
    if (Array.isArray(scopes))        discount.scopes         = scopes;
    if (limits         !== undefined) discount.limits         = { ...discount.limits.toObject?.() ?? discount.limits, ...limits };
    if (tnc            !== undefined) discount.tnc            = tnc;
    if (status         !== undefined) discount.status         = status;

    await discount.save();
    return res.json({ success: true, message: 'Discount campaign updated successfully.', data: discount });
  } catch (error) {
    console.error('updateDiscount error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// @desc    Delete discount
// @route   DELETE /api/discounts/:id
// ─────────────────────────────────────────────────────────────────────────────
const deleteDiscount = async (req, res) => {
  try {
    const discount = await Discount.findByIdAndDelete(req.params.id);
    if (!discount) return res.status(404).json({ success: false, message: 'Discount campaign not found.' });
    return res.json({ success: true, message: 'Discount campaign deleted successfully.' });
  } catch (error) {
    console.error('deleteDiscount error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// @desc    Toggle status
// @route   PATCH /api/discounts/:id/status
// ─────────────────────────────────────────────────────────────────────────────
const toggleDiscountStatus = async (req, res) => {
  try {
    const discount = await Discount.findById(req.params.id);
    if (!discount) return res.status(404).json({ success: false, message: 'Discount campaign not found.' });

    const { status } = req.body;
    if (!['active', 'inactive', 'expired'].includes(status))
      return res.status(400).json({ success: false, message: 'Invalid status value.' });

    discount.status = status;
    await discount.save();
    return res.json({ success: true, message: `Campaign status changed to "${status}".`, data: { _id: discount._id, status: discount.status } });
  } catch (error) {
    console.error('toggleDiscountStatus error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// @desc    Validate coupon (simple, no cart context)
// @route   POST /api/discounts/validate
// ─────────────────────────────────────────────────────────────────────────────
const validateCoupon = async (req, res) => {
  try {
    const { couponCode, cartTotal } = req.body;
    if (!couponCode) return res.status(400).json({ success: false, message: 'Coupon code is required.' });

    const discount = await Discount.findOne({ couponCode: couponCode.trim().toUpperCase(), status: 'active' }).lean();
    if (!discount) return res.status(404).json({ success: false, message: 'Invalid or expired coupon code.' });

    const now = new Date();
    if (discount.startDate && new Date(discount.startDate) > now)
      return res.status(400).json({ success: false, message: 'This coupon is not yet active.' });
    if (discount.endDate && new Date(discount.endDate) < now)
      return res.status(400).json({ success: false, message: 'This coupon has expired.' });

    const cart = Number(cartTotal) || 0;
    const { discountAmount, freeShipping, error } = computeDiscount(discount, cart);
    if (error) return res.status(400).json({ success: false, message: error });

    return res.json({
      success: true, message: freeShipping ? 'Free shipping coupon valid.' : 'Coupon applied successfully.',
      data: { discount, discountAmount, freeShipping: freeShipping || false, finalAmount: Math.max(cart - discountAmount, 0) }
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
  validateCoupon,
  applyDiscount
};