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

      CampaignLog.find({ userId }).sort({ createdAt: -1 }).limit(5).lean(),

      Purchase.find()
        .populate('invoice')
        .sort({ createdAt: -1 })
        .limit(10)
        .lean(),

      Purchase.countDocuments(),

      // totalAmount is stored as a STRING in Purchase ("1700.00")
      // so we must convert it before summing
      Purchase.aggregate([
        {
          $group: {
            _id: null,
            total: { $sum: { $toDouble: '$totalAmount' } }
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
    const [campaigns, total] = await Promise.all([
      CampaignLog.find(filter).sort({ createdAt: -1 }).skip(skip).limit(Number(limit)).lean(),
      CampaignLog.countDocuments(filter)
    ]);

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
    const [purchases, total] = await Promise.all([
      Purchase.find(filter)
        .populate('invoice')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .lean(),
      Purchase.countDocuments(filter)
    ]);

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
// ─────────────────────────────────────────────────────────────
const getMessageStats = async (campaignId) => {
  try {
    const agg = await Message.aggregate([
      { $match: { campaignId: toObjectId(campaignId) } },
      {
        $project: {
          lastStatus: { $arrayElemAt: ['$status', -1] }
        }
      },
      {
        $group: {
          _id:   '$lastStatus.status',
          count: { $sum: 1 }
        }
      }
    ]);

    const stats = { sent: 0, delivered: 0, read: 0, failed: 0, total: 0 };
    agg.forEach(row => {
      const s = (row._id || '').toLowerCase();
      if (s === 'sent')      stats.sent      += row.count;
      if (s === 'delivered') stats.delivered += row.count;
      if (s === 'read')      stats.read      += row.count;
      if (s === 'failed')    stats.failed    += row.count;
      stats.total += row.count;
    });

    return stats;
  } catch {
    // If campaignId not yet used / messages not tagged — return zeroes
    return { sent: 0, delivered: 0, read: 0, failed: 0, total: 0 };
  }
};

// ─────────────────────────────────────────────────────────────
// HELPER: hourly timeline of status changes for a campaign
// ─────────────────────────────────────────────────────────────
const getMessageTimeline = async (campaignId) => {
  try {
    return await Message.aggregate([
      { $match: { campaignId: toObjectId(campaignId) } },
      { $unwind: '$status' },
      {
        $group: {
          _id: {
            status: '$status.status',
            hour:   { $dateToString: { format: '%Y-%m-%dT%H:00', date: '$status.timeStamp' } }
          },
          count: { $sum: 1 }
        }
      },
      { $sort: { '_id.hour': 1 } }
    ]);
  } catch {
    return [];
  }
};