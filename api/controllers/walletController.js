// ==================== controllers/walletController.js ====================
const { Wallet, CountryPricing, Contact, Template, Group, GroupMembers, CampaignLog } = require('../models');

// ─────────────────────────────────────────────
// HELPER: get or create wallet for user
// ─────────────────────────────────────────────
const getOrCreateWallet = async (userId) => {
  let wallet = await Wallet.findOne({ userId });
  if (!wallet) {
    wallet = await Wallet.create({ userId, balance: 1000 });
  }
  return wallet;
};

// ─────────────────────────────────────────────
// HELPER: price per message for a given country + template category
// ─────────────────────────────────────────────
const getPriceForCountry = (countryPricing, templateCategory) => {
  switch (templateCategory.toLowerCase()) {
    case 'marketing':      return countryPricing.marketingMetaCost;
    case 'utility':        return countryPricing.utilityMetaCost;
    case 'authentication': return countryPricing.authenticationMetaCost;
    default:               return countryPricing.marketingMetaCost;
  }
};

// ─────────────────────────────────────────────
// HELPER: build cost breakdown from contacts + templateCategory
// Returns { breakdown, totalCost, unknownNumbers }
// ─────────────────────────────────────────────
const buildCostBreakdown = async (contacts, templateCategory) => {
  const allPricings = await CountryPricing.find({});
  const countryMap = {};
  const unknownNumbers = [];

  for (const contact of contacts) {
    const digits = contact.number.replace(/^\+/, '');

    let matched = null;
    for (const len of [4, 3, 2, 1]) {
      const prefix = '+' + digits.slice(0, len);
      const pricing = allPricings.find(p => p.countryCode === prefix);
      if (pricing) { matched = pricing; break; }
    }

    if (!matched) { unknownNumbers.push(contact.number); continue; }

    const code = matched.countryCode;
    if (!countryMap[code]) countryMap[code] = { pricing: matched, count: 0 };
    countryMap[code].count++;
  }

  // Multiply by 4.2 (USD → AED conversion)
  const breakdown = Object.values(countryMap).map(({ pricing, count }) => {
    const pricePerMessage = getPriceForCountry(pricing, templateCategory) * 4.2;
    return {
      countryCode: pricing.countryCode,
      countryName: pricing.countryName,
      count,
      pricePerMessage,
      subtotal: parseFloat((count * pricePerMessage).toFixed(4))
    };
  });

  const totalCost = parseFloat(
    breakdown.reduce((sum, row) => sum + row.subtotal, 0).toFixed(4)
  );

  return { breakdown, totalCost, unknownNumbers };
};

// ─────────────────────────────────────────────
// HELPER: generate campaign ID
// Format: templateName-dd-mm-yy/a  (next letter each same name+date)
// e.g.  template_new-02-11-26/a
//       template_new-02-11-26/b
//       template_verify-02-11-26/a
// ─────────────────────────────────────────────
const generateCampaignId = async (templateName) => {
  const now  = new Date();
  const dd   = String(now.getDate()).padStart(2, '0');
  const mm   = String(now.getMonth() + 1).padStart(2, '0');
  const yy   = String(now.getFullYear()).slice(-2);

  // Sanitise template name — replace spaces/special chars with underscore
  const safeName = (templateName || 'campaign').replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
  const prefix   = `${safeName}-${dd}-${mm}-${yy}/`;

  // Escape regex special chars in prefix
  const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Count existing campaigns with this prefix today
  const count = await CampaignLog.countDocuments({
    campaignId: { $regex: `^${escapedPrefix}` }
  });

  // Convert count → letter sequence: 0→a, 1→b … 25→z, 26→aa, 27→ab …
  const toLetters = (n) => {
    let result = '';
    do {
      result = String.fromCharCode(97 + (n % 26)) + result;
      n = Math.floor(n / 26) - 1;
    } while (n >= 0);
    return result;
  };

  return `${prefix}${toLetters(count)}`;
};

// =================================================================
// @desc  Get wallet balance + recent transactions
// @route GET /api/wallet
// @access Private
// =================================================================
exports.getWallet = async (req, res) => {
  try {
    const wallet = await getOrCreateWallet(req.user._id);

    res.json({
      success: true,
      data: {
        balance: wallet.balance,
        transactions: wallet.transactions.slice(-20).reverse()
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// =================================================================
// @desc  Preview campaign cost before sending
// @route POST /api/wallet/campaign-cost-preview
// @access Private
// =================================================================
exports.getCampaignCostPreview = async (req, res) => {
  try {
    const { templateId, viewMode = 'contacts', selectedIds = [], filters } = req.body;

    if (!templateId) return res.status(400).json({ success: false, message: 'templateId is required' });
    if (!selectedIds.length) return res.status(400).json({ success: false, message: 'No recipients selected' });

    const template = await Template.findById(templateId).lean();
    if (!template) return res.status(404).json({ success: false, message: 'Template not found' });

    const templateCategory = (template.category || 'marketing').toLowerCase();

    let contacts = [];

    if (viewMode === 'groups') {
      const groups = await Group.find({ _id: { $in: selectedIds }, isDeleted: false, isArchived: false });
      const groupIds = groups.map(g => g._id.toString());
      const members = await GroupMembers.find({ groupId: { $in: groupIds }, status: 'active' });
      const contactIds = [...new Set(members.map(m => m.contactId).filter(Boolean))];
      contacts = await Contact.find({ _id: { $in: contactIds }, isArchived: false }).lean();

      const seen = new Set();
      contacts = contacts.filter(c => { if (seen.has(c.number)) return false; seen.add(c.number); return true; });
    } else {
      const q = {
        $or: [{ _id: { $in: selectedIds } }, { number: { $in: selectedIds } }],
        isArchived: false
      };
      if (filters?.statusFilter && filters.statusFilter !== 'all') q.status = filters.statusFilter;
      if (filters?.readFilter === 'unread') q.unreadCount = { $gt: 0 };
      contacts = await Contact.find(q).lean();
    }

    if (!contacts.length) return res.status(404).json({ success: false, message: 'No valid recipients found' });

    const { breakdown, totalCost, unknownNumbers } = await buildCostBreakdown(contacts, templateCategory);
    const wallet = await getOrCreateWallet(req.user._id);

    // Preview the campaign ID so the user can see it before confirming
    const previewCampaignId = await generateCampaignId(template.templateName || template.name);

    res.json({
      success: true,
      data: {
        templateCategory,
        totalRecipients: contacts.length,
        breakdownByCountry: breakdown,
        totalCost,
        walletBalance: wallet.balance,
        balanceAfterCampaign: parseFloat((wallet.balance - totalCost).toFixed(4)),
        hasSufficientBalance: wallet.balance >= totalCost,
        unknownNumbers,
        previewCampaignId
      }
    });
  } catch (error) {
    console.error('getCampaignCostPreview error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// =================================================================
// @desc  Top-up wallet
// @route POST /api/wallet/topup
// @access Private
// =================================================================
exports.topupWallet = async (req, res) => {
  try {
    const { amount, description } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ success: false, message: 'Valid amount is required' });

    const wallet = await getOrCreateWallet(req.user._id);
    wallet.balance = parseFloat((wallet.balance + Number(amount)).toFixed(4));
    wallet.transactions.push({
      type: 'credit',
      amount: Number(amount),
      description: description || 'Manual top-up',
      balanceAfter: wallet.balance
    });
    await wallet.save();

    res.json({
      success: true,
      message: `Wallet topped up by ${amount} AED`,
      data: { balance: wallet.balance }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// =================================================================
// EXPORTED HELPER — called inside chatController.sendBulkTemplate
//
// Steps:
//   1. Build cost breakdown
//   2. Check balance (throws 402 if short)
//   3. Generate campaign ID  e.g. "order_promo-02-11-26/a"
//   4. Create CampaignLog (status: queued)
//   5. Deduct wallet — ONE transaction linked to this campaign
//
// Returns: { campaignLog, campaignId, totalCost, balanceBefore, balanceAfter, breakdown }
// =================================================================
exports.deductCampaignCost = async ({
  userId,
  templateId,
  templateName,
  templateCategory,
  viewMode,
  contacts
}) => {
  const { breakdown, totalCost } = await buildCostBreakdown(contacts, templateCategory);

  const wallet = await getOrCreateWallet(userId);

  if (wallet.balance < totalCost) {
    const err = new Error(
      `Insufficient wallet balance. Required: ${totalCost} AED, Available: ${wallet.balance} AED`
    );
    err.statusCode = 402;
    throw err;
  }

  const balanceBefore = wallet.balance;
  wallet.balance = parseFloat((wallet.balance - totalCost).toFixed(4));

  // Unique campaign ID
  const campaignId = await generateCampaignId(templateName || 'campaign');

  // Campaign log (one record per send action)
  const campaignLog = await CampaignLog.create({
    campaignId,
    userId,
    templateId,
    templateName,
    templateCategory,
    viewMode,
    totalRecipients: contacts.length,
    totalCost,
    breakdownByCountry: breakdown,
    walletBalanceBefore: balanceBefore,
    walletBalanceAfter: wallet.balance,
    status: 'queued'
  });

  // ONE wallet debit transaction — not per message
  wallet.transactions.push({
    type: 'debit',
    amount: totalCost,
    description: `Campaign [${campaignId}] — ${contacts.length} msgs (${templateCategory})`,
    campaignId: campaignLog._id,
    balanceAfter: wallet.balance
  });

  await wallet.save();

  return {
    campaignLog,
    campaignId,
    totalCost,
    balanceBefore,
    balanceAfter: wallet.balance,
    breakdown
  };
};

// =================================================================
// @desc  List campaigns for the current user
// @route GET /api/wallet/campaigns
// @access Private
// =================================================================
exports.getCampaigns = async (req, res) => {
  try {
    const { page = 1, limit = 20, status } = req.query;
    const filter = { userId: req.user._id };
    if (status) filter.status = status;

    const skip = (Number(page) - 1) * Number(limit);
    const [campaigns, total] = await Promise.all([
      CampaignLog.find(filter).sort({ createdAt: -1 }).skip(skip).limit(Number(limit)),
      CampaignLog.countDocuments(filter)
    ]);

    res.json({
      success: true,
      data: campaigns,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        pages: Math.ceil(total / Number(limit))
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Export helpers used in other controllers
exports.getOrCreateWallet = getOrCreateWallet;
exports.buildCostBreakdown = buildCostBreakdown;
exports.generateCampaignId = generateCampaignId;