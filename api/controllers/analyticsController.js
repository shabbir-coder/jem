// ==================== controllers/analyticsController.js ====================
const { CampaignLog, Message, Purchase, Invoice, Contact } = require('../models');
const mongoose = require('mongoose');

// Helper: safely cast to ObjectId (works in Mongoose 5, 6, 7, 8)
const toObjectId = (id) => new mongoose.Types.ObjectId(id);

// ─────────────────────────────────────────────────────────────
// @desc  Dashboard overview stats
// @route GET /api/analytics/overview
// @access Private
// ─────────────────────────────────────────────────────────────
exports.getOverview = async (req, res) => {
  try {
    const userId = req.user._id;

    const [
      totalCampaigns,
      totalSpendAgg,
      recentCampaigns,
      recentPurchases,
      totalPurchases,
      totalRevenueAgg,
      totalContacts,
      walletData
    ] = await Promise.all([
      CampaignLog.countDocuments({ userId }),

      // totalCost is a number in CampaignLog
      CampaignLog.aggregate([
        { $match: { userId: toObjectId(userId) } },
        { $group: { _id: null, total: { $sum: '$totalCost' } } }
      ]),

      // FIXED: Remove .sort() - Cosmos DB requires indexes for sorting
      // Alternative: sort in memory after fetching
      CampaignLog.find({ userId }).limit(5).lean().then(docs => 
        docs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      ),

      // FIXED: Remove .sort() and populate
      Purchase.find()
        .limit(10)
        .lean()
        .then(async (purchases) => {
          // Sort in memory
          purchases.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
          
          // Manual populate for Cosmos DB compatibility
          const invoiceIds = purchases.map(p => p.invoice).filter(Boolean);
          const invoices = await Invoice.find({ _id: { $in: invoiceIds } }).lean();
          const invoiceMap = {};
          invoices.forEach(inv => { invoiceMap[inv._id.toString()] = inv; });
          
          return purchases.map(p => ({
            ...p,
            invoice: p.invoice ? invoiceMap[p.invoice.toString()] : null
          }));
        }),

      Purchase.countDocuments(),

      // FIXED: Use $convert instead of $toDouble (more compatible)
      Purchase.aggregate([
        {
          $group: {
            _id: null,
            total: { 
              $sum: { 
                $convert: { 
                  input: '$totalAmount', 
                  to: 'double',
                  onError: 0,
                  onNull: 0
                } 
              } 
            }
          }
        }
      ]),

      Contact.countDocuments({ isArchived: { $ne: true } }),

      // Wallet balance — graceful if Wallet model not available
      mongoose.modelNames().includes('Wallet')
        ? mongoose.model('Wallet').findOne({ userId }).lean()
        : Promise.resolve(null)
    ]);

    res.json({
      success: true,
      data: {
        totalCampaigns,
        totalSpend:    totalSpendAgg[0]?.total   || 0,
        recentCampaigns,
        recentPurchases,
        totalPurchases,
        totalRevenue:  totalRevenueAgg[0]?.total || 0,
        totalContacts,
        walletBalance: walletData?.balance        || 0
      }
    });
  } catch (err) {
    console.error('getOverview error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────
// @desc  Get campaign analytics list (paginated)
// @route GET /api/analytics/campaigns
// @access Private
// ─────────────────────────────────────────────────────────────
exports.getCampaigns = async (req, res) => {
  try {
    const { page = 1, limit = 20, status, from, to } = req.query;
    const filter = { userId: req.user._id };

    if (status) filter.status = status;
    if (from || to) {
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = new Date(from);
      if (to)   filter.createdAt.$lte = new Date(to);
    }

    const skip = (Number(page) - 1) * Number(limit);
    
    // FIXED: Fetch without sort, then sort in memory
    const [allCampaigns, total] = await Promise.all([
      CampaignLog.find(filter).skip(skip).limit(Number(limit)).lean(),
      CampaignLog.countDocuments(filter)
    ]);

    // Sort in memory
    const campaigns = allCampaigns.sort((a, b) => 
      new Date(b.createdAt) - new Date(a.createdAt)
    );

    // Attach message-level delivery stats per campaign
    const enriched = await Promise.all(campaigns.map(async (c) => {
      const stats = await getMessageStats(c._id);
      return { ...c, messageStats: stats };
    }));

    res.json({
      success: true,
      data: enriched,
      pagination: {
        page:  Number(page),
        limit: Number(limit),
        total,
        pages: Math.ceil(total / Number(limit))
      }
    });
  } catch (err) {
    console.error('getCampaigns error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────
// @desc  Get single campaign detail with full message stats
// @route GET /api/analytics/campaigns/:id
// @access Private
// ─────────────────────────────────────────────────────────────
exports.getCampaignDetail = async (req, res) => {
  try {
    const campaign = await CampaignLog
      .findOne({ _id: req.params.id, userId: req.user._id })
      .lean();

    if (!campaign) {
      return res.status(404).json({ success: false, message: 'Campaign not found' });
    }

    const [stats, timeline] = await Promise.all([
      getMessageStats(campaign._id),
      getMessageTimeline(campaign._id)
    ]);

    res.json({ success: true, data: { ...campaign, messageStats: stats, timeline } });
  } catch (err) {
    console.error('getCampaignDetail error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────
// @desc  List purchases with invoice (paginated + status filter)
// @route GET /api/analytics/purchases
// @access Private
// ─────────────────────────────────────────────────────────────
exports.getPurchases = async (req, res) => {
  try {
    const { page = 1, limit = 20, status } = req.query;

    // Support both field names the schema might use
    const filter = {};
    if (status) {
      filter.$or = [
        { orderStatus:   status },
        { currentStatus: status }
      ];
    }

    const skip = (Number(page) - 1) * Number(limit);
    
    // FIXED: Remove .sort() and .populate(), do manually
    const [allPurchases, total] = await Promise.all([
      Purchase.find(filter).skip(skip).limit(Number(limit)).lean(),
      Purchase.countDocuments(filter)
    ]);

    // Sort in memory
    const sortedPurchases = allPurchases.sort((a, b) => 
      new Date(b.createdAt) - new Date(a.createdAt)
    );

    // Manual populate
    const invoiceIds = sortedPurchases.map(p => p.invoice).filter(Boolean);
    const invoices = await Invoice.find({ _id: { $in: invoiceIds } }).lean();
    const invoiceMap = {};
    invoices.forEach(inv => { invoiceMap[inv._id.toString()] = inv; });
    
    const purchases = sortedPurchases.map(p => ({
      ...p,
      invoice: p.invoice ? invoiceMap[p.invoice.toString()] : null
    }));

    res.json({
      success: true,
      data: purchases,
      pagination: {
        page:  Number(page),
        limit: Number(limit),
        total,
        pages: Math.ceil(total / Number(limit))
      }
    });
  } catch (err) {
    console.error('getPurchases error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────
// HELPER: aggregate message delivery stats for a campaign
// FIXED: Removed $arrayElemAt which uses $let internally
// ─────────────────────────────────────────────────────────────
const getMessageStats = async (campaignId) => {
  try {
    // COSMOS DB COMPATIBLE: Fetch all messages and process in memory
    const messages = await Message.find({ campaignId: toObjectId(campaignId) })
      .select('status')
      .lean();

    const stats = { sent: 0, delivered: 0, read: 0, failed: 0, total: messages.length };

    messages.forEach(msg => {
      if (msg.status && Array.isArray(msg.status) && msg.status.length > 0) {
        // Get last status manually (instead of $arrayElemAt)
        const lastStatus = msg.status[msg.status.length - 1];
        const s = (lastStatus.status || '').toLowerCase();
        
        if (s === 'sent')      stats.sent++;
        if (s === 'delivered') stats.delivered++;
        if (s === 'read')      stats.read++;
        if (s === 'failed')    stats.failed++;
      }
    });

    return stats;
  } catch (err) {
    console.error('getMessageStats error:', err);
    return { sent: 0, delivered: 0, read: 0, failed: 0, total: 0 };
  }
};

// ─────────────────────────────────────────────────────────────
// HELPER: hourly timeline of status changes for a campaign
// FIXED: Simplified aggregation for Cosmos DB
// ─────────────────────────────────────────────────────────────
const getMessageTimeline = async (campaignId) => {
  try {
    // COSMOS DB COMPATIBLE: Simpler aggregation without complex date functions
    const messages = await Message.find({ campaignId: toObjectId(campaignId) })
      .select('status')
      .lean();

    // Process in memory instead of complex aggregation
    const timelineMap = {};

    messages.forEach(msg => {
      if (msg.status && Array.isArray(msg.status)) {
        msg.status.forEach(statusEntry => {
          if (statusEntry.timeStamp && statusEntry.status) {
            // Format hour manually
            const date = new Date(statusEntry.timeStamp);
            const hour = date.toISOString().substring(0, 13) + ':00';
            const status = statusEntry.status;

            const key = `${status}|${hour}`;
            if (!timelineMap[key]) {
              timelineMap[key] = { status, hour, count: 0 };
            }
            timelineMap[key].count++;
          }
        });
      }
    });

    // Convert to array and sort
    const timeline = Object.values(timelineMap);
    timeline.sort((a, b) => a.hour.localeCompare(b.hour));

    return timeline.map(t => ({
      _id: { status: t.status, hour: t.hour },
      count: t.count
    }));
  } catch (err) {
    console.error('getMessageTimeline error:', err);
    return [];
  }
};