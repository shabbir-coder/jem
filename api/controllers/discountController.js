// ==================== controllers/discountController.js ====================
const { Discount, Purchase } = require('../models');
const { GiftCard } = require('./giftCardController');

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────

const toNum = v => parseFloat(String(v).replace(/[^0-9.]/g, '')) || 0;

// Strip leading "+" so "+9199..." and "9199..." compare equal
const norm = n => String(n || '').replace(/^\+/, '');

// Dates are stored as "YYYY-MM-DD" strings. Treat them as IST day boundaries
// so a campaign ending on 31 Oct is valid until 23:59:59 IST on 31 Oct.
const toStart = s => new Date(`${s}T00:00:00.000+05:30`);
const toEnd   = s => new Date(`${s}T23:59:59.999+05:30`);

const skipEntry = (d, reason) => ({
  campaignId:   d._id,
  campaignName: d.campaignName,
  couponCode:   d.couponCode || null,
  reason
});

const skipFromApplied = (a, reason) => ({
  campaignId:   a.campaignId,
  campaignName: a.campaignName,
  couponCode:   a.couponCode,
  reason
});

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
// Evaluate ONE campaign against the cart (dates, customer, items, amount).
// Returns { skip }  OR  { applied, combinable }
// ─────────────────────────────────────────────────────────────────────────────
async function evaluateCampaign(discount, cartItems, customerCtx, now) {
  // Date validity (IST day boundaries)
  if (discount.startDate && toStart(discount.startDate) > now)
    return { skip: skipEntry(discount, 'This offer is not active yet.') };
  if (discount.endDate && toEnd(discount.endDate) < now)
    return { skip: skipEntry(discount, 'This offer has expired.') };

  // Customer eligibility
  const customerError = await checkCustomerEligibility(discount, customerCtx);
  if (customerError) return { skip: skipEntry(discount, customerError) };

  // Item eligibility
  const { eligibleItems, ineligibleItems } = splitItemsByScope(cartItems, discount);
  if (!eligibleItems.length)
    return { skip: skipEntry(discount, 'No items in your cart are eligible for this discount.') };

  // Financials
  const eligibleSubtotal = eligibleItems.reduce(
    (s, i) => s + toNum(i.price) * (i.quantity || 1), 0
  );

  const { discountAmount, tierApplied, freeShipping, error } =
    computeDiscount(discount, eligibleSubtotal);
  if (error) return { skip: skipEntry(discount, error) };

  const rounded = parseFloat(discountAmount.toFixed(2));

  return {
    combinable: !!discount.limits?.combineOther,
    applied: {
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

      eligibleSubtotal: parseFloat(eligibleSubtotal.toFixed(2)),
      discountAmount:   rounded,

      tierApplied,
      nextTier: getNextTierHint(discount, eligibleSubtotal),

      appliedDiscountEmbed: {
        campaignId:     discount._id,
        campaignName:   discount.campaignName,
        couponCode:     discount.couponCode || null,
        discountType:   discount.discountType,
        discountAmount: rounded,
        freeShipping
      }
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// @desc    Apply eligible discounts to a cart
// @route   POST /api/discounts/apply
// @access  Private
//
// Body: {
//   couponCode?:     string   — specific code (optional)
//   customerNumber:  string
//   customerId:      string
//   cartItems: [{ productId, categoryId, productName, price, quantity }]
// }
//
// Rules:
//  1. Coupon shared  → evaluated FIRST (gift card coupon or regular coupon).
//  2. Coupon applies & is non-combinable → it is the only offer applied.
//  3. Coupon applies & is combinable     → only combinable auto offers stack on top.
//  4. Coupon invalid / expired / below minCart → auto offers still run as fallback,
//     and `couponError` explains why the code did not work.
//  5. No coupon → all combinable auto offers stack; the best single
//     non-combinable offer competes against that stack, higher saving wins.
//  6. Each campaign is calculated on ITS OWN eligible items' subtotal;
//     total discount is capped at the cart subtotal.
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

    const now          = new Date();
    const customerCtx  = { customerId, customerNumber };
    const appliedResults = [];
    const skippedResults = [];
    let couponError = null;

    // ── 1. ENTERED COUPON (highest priority) ──────────────────────────────────
    const entered = (couponCode || '').trim().toUpperCase();
    let enteredDiscount = null;

    if (entered) {
      const giftCard = await GiftCard.findOne({ couponCode: entered, status: 'active' }).lean();

      if (giftCard) {
        if (customerNumber && norm(giftCard.recipientNumber) !== norm(customerNumber)) {
          couponError = 'This gift card coupon is not valid for your account.';
        } else if (giftCard.discountDocId) {
          enteredDiscount = await Discount.findOne({
            _id: giftCard.discountDocId, status: 'active'
          }).lean();
          if (enteredDiscount) enteredDiscount._isGiftCard = true;
          else couponError = 'Invalid or expired gift card.';
        } else {
          couponError = 'Invalid or expired gift card.';
        }
      } else {
        enteredDiscount = await Discount.findOne({ couponCode: entered, status: 'active' }).lean();
        if (!enteredDiscount) couponError = 'Invalid or expired coupon code.';
      }
    }

    let couponApplied = null; // { applied, combinable }
    if (enteredDiscount) {
      const r = await evaluateCampaign(enteredDiscount, cartItems, customerCtx, now);
      if (r.skip) {
        skippedResults.push(r.skip);
        couponError = r.skip.reason;
      } else {
        couponApplied = r;
        appliedResults.push(r.applied);
      }
    }

    // ── 2. AUTO-APPLY CANDIDATES (auto campaigns + customer's gift cards) ─────
    let autoCandidates = await Discount.find({ couponCode: '', status: 'active' }).lean();

    if (customerNumber) {
      const n = norm(customerNumber);
      const activeGiftCards = await GiftCard.find({
        recipientNumber: { $in: [n, `+${n}`] },
        status: 'active'
      }).lean();

      const ids = activeGiftCards.map(g => g.discountDocId).filter(Boolean);
      if (ids.length) {
        const gcDiscounts = await Discount.find({ _id: { $in: ids }, status: 'active' }).lean();
        gcDiscounts.forEach(d => { d._isGiftCard = true; });
        autoCandidates.push(...gcDiscounts);
      }
    }

    // De-dupe, and drop the entered coupon if it is already in the list
    const seen = new Set(enteredDiscount ? [String(enteredDiscount._id)] : []);
    autoCandidates = autoCandidates.filter(d => {
      const k = String(d._id);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    // ── 3. DECIDE WHICH AUTO OFFERS CAN JOIN ──────────────────────────────────
    if (couponApplied && !couponApplied.combinable) {
      // Coupon is exclusive: nothing else applies
      for (const d of autoCandidates) {
        skippedResults.push(
          skipEntry(d, `Not applied — coupon ${entered} cannot be combined with other offers.`)
        );
      }
    } else {
      const combinable = [];
      const exclusive  = [];

      for (const d of autoCandidates) {
        const r = await evaluateCampaign(d, cartItems, customerCtx, now);
        if (r.skip) { skippedResults.push(r.skip); continue; }
        (r.combinable ? combinable : exclusive).push(r.applied);
      }

      const notCombinableReason = 'This offer cannot be combined with other offers already applied.';

      if (couponApplied) {
        // Combinable coupon: only combinable autos may stack
        appliedResults.push(...combinable);
        exclusive.forEach(a => skippedResults.push(skipFromApplied(a, notCombinableReason)));
      } else {
        // No coupon: stack of combinables vs best single exclusive offer
        const sum  = arr => arr.reduce((s, a) => s + a.discountAmount, 0);
        const best = [...exclusive].sort((a, b) => b.discountAmount - a.discountAmount)[0];

        if (best && best.discountAmount > sum(combinable)) {
          const reason = `A better offer (${best.campaignName}) was applied instead.`;
          appliedResults.push(best);
          combinable.forEach(a => skippedResults.push(skipFromApplied(a, reason)));
          exclusive.filter(a => a !== best).forEach(a => skippedResults.push(skipFromApplied(a, reason)));
        } else {
          appliedResults.push(...combinable);
          exclusive.forEach(a => skippedResults.push(skipFromApplied(a, notCombinableReason)));
        }
      }
    }

    // ── 4. Nothing applied ────────────────────────────────────────────────────
    if (!appliedResults.length) {
      return res.status(200).json({
        success: false,
        message: couponError || 'No active discounts found for your cart.',
        data: { appliedDiscounts: [], skippedDiscounts: skippedResults, couponError }
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

    const fallbackNote = couponError ? ` (Coupon ${entered}: ${couponError})` : '';

    return res.json({
      success: true,
      message: summaryMsg + fallbackNote,
      data: {
        cartSubtotal:    parseFloat(cartSubtotal.toFixed(2)),
        totalDiscount:   parseFloat(cappedDiscount.toFixed(2)),
        finalAmount:     parseFloat(finalAmount.toFixed(2)),
        hasFreeShipping,

        couponError,                       // null when coupon worked or none was sent
        couponApplied: !!couponApplied,

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
    if (discount.startDate && toStart(discount.startDate) > now)
      return res.status(400).json({ success: false, message: 'This coupon is not yet active.' });
    if (discount.endDate && toEnd(discount.endDate) < now)
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