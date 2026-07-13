// ==================== controllers/reviewController.js ====================
const { Review, ReviewStatus, ConcernType, ConcernForOptions, Product, Purchase, Invoice, File } = require('../models');

// ─────────────────────────────────────────────────────────────────────────
// @desc    Submit a customer review (called by the LLM/WhatsApp service —
//          it has already read the chat, classified sentiment, and pulled
//          out any purchase/product context)
// @route   POST /api/reviews/submit
// @access  Service (x-service-key header, see middlewares/serviceAuth.js)
// ─────────────────────────────────────────────────────────────────────────
const submitReview = async (req, res) => {
  try {
    const {
      customerName,
      customerNumber,
      customerEmail,
      productId,
      productName,
      categoryName,
      purchaseId,
      orderId,
      invoiceId,
      reviewText,
      rating,
      media,            // [{ url, fileType, mimeType, caption }]
      concernType,      // 'concern' | 'good' | 'neutral' — set by the LLM
      llmConfidence,
      llmRawResponse,
      instance_id
    } = req.body;

    if (!customerNumber || !reviewText) {
      return res.status(400).json({ success: false, message: 'customerNumber and reviewText are required' });
    }

    if (concernType && !Object.values(ConcernType).includes(concernType)) {
      return res.status(400).json({ success: false, message: `Invalid concernType. Must be one of: ${Object.values(ConcernType).join(', ')}` });
    }

    // Best-effort backfill of product/purchase context if only IDs were sent
    let resolvedProductName = productName;
    let resolvedCategoryName = categoryName;
    if (productId && (!productName || !categoryName)) {
      const product = await Product.findById(productId).lean();
      if (product) {
        resolvedProductName = resolvedProductName || product.productName;
        resolvedCategoryName = resolvedCategoryName || product.categoryName;
      }
    }

    let resolvedOrderId = orderId;
    if (purchaseId && !orderId) {
      const purchase = await Purchase.findById(purchaseId, 'orderId').lean();
      if (purchase) resolvedOrderId = purchase.orderId;
    }

    const review = await Review.create({
      customerName,
      customerNumber,
      customerEmail,
      product:      productId || undefined,
      productName:  resolvedProductName,
      categoryName: resolvedCategoryName,
      purchase:     purchaseId || undefined,
      orderId:      resolvedOrderId,
      invoice:      invoiceId || undefined,
      reviewText,
      rating,
      media:        Array.isArray(media) ? media : [],
      concernType:  concernType || ConcernType.NEUTRAL,
      llmConfidence,
      llmRawResponse,
      source:       'whatsapp',
      instance_id,
      status:       ReviewStatus.PENDING,
      statusLog:    [{ status: ReviewStatus.PENDING, comment: 'Review received', updatedAt: new Date() }]
    });

    res.status(201).json({ success: true, message: 'Review submitted', data: review });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────
// @desc    Manually add a review from the admin panel (e.g. a review that
//          came in over phone/email rather than WhatsApp)
// @route   POST /api/reviews
// @access  Private
// ─────────────────────────────────────────────────────────────────────────
const createReview = async (req, res) => {
  try {
    const {
      customerName,
      customerNumber,
      customerEmail,
      productId,
      productName,
      categoryName,
      purchaseId,
      orderId,
      invoiceId,
      reviewText,
      rating,
      concernType,
      concernFor,
      concernForOther,
      remark,
      displayOnWebsite
    } = req.body;

    if (!customerNumber || !reviewText) {
      return res.status(400).json({ success: false, message: 'customerNumber and reviewText are required' });
    }

    if (concernFor && !ConcernForOptions.includes(concernFor)) {
      return res.status(400).json({ success: false, message: `Invalid concernFor. Must be one of: ${ConcernForOptions.join(', ')}` });
    }

    let resolvedProductName = productName;
    let resolvedCategoryName = categoryName;
    if (productId && (!productName || !categoryName)) {
      const product = await Product.findById(productId).lean();
      if (product) {
        resolvedProductName = resolvedProductName || product.productName;
        resolvedCategoryName = resolvedCategoryName || product.categoryName;
      }
    }

    const review = await Review.create({
      customerName,
      customerNumber,
      customerEmail,
      product:      productId || undefined,
      productName:  resolvedProductName,
      categoryName: resolvedCategoryName,
      purchase:     purchaseId || undefined,
      orderId,
      invoice:      invoiceId || undefined,
      reviewText,
      rating,
      concernType:  concernType || ConcernType.NEUTRAL,
      concernFor:   concernFor || 'other',
      concernForOther: concernFor === 'other' ? concernForOther : undefined,
      remark,
      displayOnWebsite: !!displayOnWebsite,
      source:    'admin',
      createdBy: req.user._id,
      status:    ReviewStatus.PENDING,
      statusLog: [{ status: ReviewStatus.PENDING, comment: 'Added manually from admin panel', updatedAt: new Date(), updatedBy: req.user._id }]
    });

    // Handle any media uploaded alongside the manual entry
    let uploadedFiles = [];
    if (req.files && req.files.length > 0) {
      const filePromises = req.files.map(file => {
        const fileType = file.mimetype.startsWith('image/') ? 'image'
                       : file.mimetype.startsWith('video/') ? 'video'
                       : file.mimetype.startsWith('audio/') ? 'audio'
                       : 'document';
        return File.create({
          fileName:     file.filename,
          originalName: file.originalname,
          fileType,
          mimeType:   file.mimetype,
          fileSize:   file.size,
          url:        `${process.env.FILE_URL}/uploads/reviews/${file.filename}`,
          path:       `/uploads/reviews/${file.filename}`,
          altText:    `Review by ${customerName || customerNumber}`,
          uploadedBy: req.user._id,
          entityType: 'other',
          entityId:   review._id.toString()
        });
      });
      uploadedFiles = await Promise.all(filePromises);

      review.media = uploadedFiles.map(f => ({
        url: f.url, path: f.path, fileType: f.fileType, mimeType: f.mimeType, file: f._id
      }));
      await review.save();
    }

    res.status(201).json({ success: true, message: 'Review added', data: { review, files: uploadedFiles } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────
// @desc    List reviews with filters, search and pagination
// @route   GET /api/reviews
// @access  Private
// ─────────────────────────────────────────────────────────────────────────
const listReviews = async (req, res) => {
  try {
    const {
      search,
      status,
      concernType,
      concernFor,
      displayOnWebsite,
      isCalled,
      isClosed,
      productId,
      page  = 1,
      limit = 20
    } = req.query;

    const match = {};

    if (search) {
      match.$or = [
        { customerName:   { $regex: search, $options: 'i' } },
        { customerNumber: { $regex: search, $options: 'i' } },
        { reviewText:      { $regex: search, $options: 'i' } },
        { productName:     { $regex: search, $options: 'i' } },
        { orderId:         { $regex: search, $options: 'i' } }
      ];
    }
    if (status)                  match.status = status;
    if (concernType)             match.concernType = concernType;
    if (concernFor)              match.concernFor = concernFor;
    if (productId)                match.product = productId;
    if (displayOnWebsite !== undefined) match.displayOnWebsite = displayOnWebsite === 'true';
    if (isCalled !== undefined)         match.isCalled = isCalled === 'true';
    if (isClosed !== undefined)         match.isClosed = isClosed === 'true';

    const skip = (page - 1) * limit;

    const [reviews, total] = await Promise.all([
      Review.find(match).sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit)).lean(),
      Review.countDocuments(match)
    ]);

    res.json({
      success: true,
      data: reviews,
      pagination: { total, page: parseInt(page), limit: parseInt(limit) }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────
// @desc    Quick counts for dashboard cards / filter badges
// @route   GET /api/reviews/stats
// @access  Private
// ─────────────────────────────────────────────────────────────────────────
const getReviewStats = async (req, res) => {
  try {
    const [byStatus, byConcernType, byConcernFor, openFollowUps, total] = await Promise.all([
      Review.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
      Review.aggregate([{ $group: { _id: '$concernType', count: { $sum: 1 } } }]),
      Review.aggregate([{ $group: { _id: '$concernFor', count: { $sum: 1 } } }]),
      Review.countDocuments({ concernType: 'concern', isClosed: false }),
      Review.countDocuments()
    ]);

    const toMap = (arr) => arr.reduce((m, r) => { m[r._id || 'unknown'] = r.count; return m; }, {});

    res.json({
      success: true,
      data: {
        total,
        byStatus:      toMap(byStatus),
        byConcernType: toMap(byConcernType),
        byConcernFor:  toMap(byConcernFor),
        openConcerns:  openFollowUps
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────
// @desc    Get a single review with resolved product/purchase/invoice
// @route   GET /api/reviews/:id
// @access  Private
// ─────────────────────────────────────────────────────────────────────────
const getReview = async (req, res) => {
  try {
    const review = await Review.findById(req.params.id).lean();
    if (!review) return res.status(404).json({ success: false, message: 'Review not found' });

    const [product, purchase, invoice] = await Promise.all([
      review.product  ? Product.findById(review.product).lean()   : null,
      review.purchase ? Purchase.findById(review.purchase).lean() : null,
      review.invoice  ? Invoice.findById(review.invoice).lean()   : null
    ]);

    res.json({ success: true, data: { ...review, product, purchase, invoice } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────
// @desc    Approve / reject / re-open a review
// @route   PUT /api/reviews/:id/status
// @access  Private
// ─────────────────────────────────────────────────────────────────────────
const updateReviewStatus = async (req, res) => {
  try {
    const { status, comment } = req.body;

    if (!Object.values(ReviewStatus).includes(status)) {
      return res.status(400).json({ success: false, message: `Invalid status. Must be one of: ${Object.values(ReviewStatus).join(', ')}` });
    }

    const review = await Review.findById(req.params.id);
    if (!review) return res.status(404).json({ success: false, message: 'Review not found' });

    review.status = status;
    review.statusLog.push({
      status,
      comment: comment || `Status updated to ${status}`,
      updatedAt: new Date(),
      updatedBy: req.user._id
    });

    // A rejected review should never be shown on the storefront
    if (status === ReviewStatus.REJECTED) review.displayOnWebsite = false;

    await review.save();
    res.json({ success: true, message: 'Status updated', data: review });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────
// @desc    Save our reply to the customer's review
// @route   PUT /api/reviews/:id/response
// @access  Private
// ─────────────────────────────────────────────────────────────────────────
const respondToReview = async (req, res) => {
  try {
    const { ourResponse } = req.body;
    if (!ourResponse) return res.status(400).json({ success: false, message: 'ourResponse is required' });

    const review = await Review.findByIdAndUpdate(
      req.params.id,
      { ourResponse, respondedBy: req.user._id, respondedAt: new Date() },
      { new: true, runValidators: true }
    );
    if (!review) return res.status(404).json({ success: false, message: 'Review not found' });

    res.json({ success: true, message: 'Response saved', data: review });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────
// @desc    Toggle whether a review shows on the public website
// @route   PUT /api/reviews/:id/display
// @access  Private
// ─────────────────────────────────────────────────────────────────────────
const toggleDisplayOnWebsite = async (req, res) => {
  try {
    const { displayOnWebsite } = req.body;

    const review = await Review.findById(req.params.id);
    if (!review) return res.status(404).json({ success: false, message: 'Review not found' });

    if (displayOnWebsite && review.status !== ReviewStatus.APPROVED) {
      return res.status(400).json({ success: false, message: 'Only approved reviews can be displayed on the website' });
    }

    review.displayOnWebsite = !!displayOnWebsite;
    await review.save();

    res.json({ success: true, message: 'Display preference updated', data: review });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────
// @desc    Update ops triage fields — concernFor / remark / isCalled / isClosed
// @route   PUT /api/reviews/:id/manage
// @access  Private
// ─────────────────────────────────────────────────────────────────────────
const manageReview = async (req, res) => {
  try {
    const { concernFor, concernForOther, remark, isCalled, isClosed } = req.body;

    const review = await Review.findById(req.params.id);
    if (!review) return res.status(404).json({ success: false, message: 'Review not found' });

    if (concernFor !== undefined) {
      if (!ConcernForOptions.includes(concernFor)) {
        return res.status(400).json({ success: false, message: `Invalid concernFor. Must be one of: ${ConcernForOptions.join(', ')}` });
      }
      review.concernFor = concernFor;
      review.concernForOther = concernFor === 'other' ? (concernForOther || review.concernForOther) : undefined;
    }

    if (remark !== undefined) review.remark = remark;

    if (isCalled !== undefined) {
      review.isCalled = !!isCalled;
      if (isCalled) { review.calledAt = new Date(); review.calledBy = req.user._id; }
    }

    if (isClosed !== undefined) {
      review.isClosed = !!isClosed;
      if (isClosed) { review.closedAt = new Date(); review.closedBy = req.user._id; }
    }

    await review.save();
    res.json({ success: true, message: 'Review updated', data: review });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────
// @desc    Delete a review (e.g. a mistakenly added manual entry)
// @route   DELETE /api/reviews/:id
// @access  Private
// ─────────────────────────────────────────────────────────────────────────
const deleteReview = async (req, res) => {
  try {
    const review = await Review.findById(req.params.id);
    if (!review) return res.status(404).json({ success: false, message: 'Review not found' });

    await review.deleteOne();
    res.json({ success: true, message: 'Review deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────
// @desc    Approved + display-enabled reviews for the public storefront
// @route   GET /api/reviews/public
// @access  Public
// ─────────────────────────────────────────────────────────────────────────
const listPublicReviews = async (req, res) => {
  try {
    const { productId, page = 1, limit = 10 } = req.query;
    const match = { status: ReviewStatus.APPROVED, displayOnWebsite: true };
    if (productId) match.product = productId;

    const skip = (page - 1) * limit;

    const [reviews, total] = await Promise.all([
      Review.find(match, 'customerName productName rating reviewText media createdAt')
        .sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit)).lean(),
      Review.countDocuments(match)
    ]);

    res.json({ success: true, data: reviews, pagination: { total, page: parseInt(page), limit: parseInt(limit) } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = {
  submitReview,
  createReview,
  listReviews,
  getReviewStats,
  getReview,
  updateReviewStatus,
  respondToReview,
  toggleDisplayOnWebsite,
  manageReview,
  deleteReview,
  listPublicReviews
};