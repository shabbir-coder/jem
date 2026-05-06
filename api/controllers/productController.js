// ==================== controllers/productController.js ====================
const { Product, File, Category, FileStatus, Purchase, Invoice } = require('../models');
const axios = require('axios');

// ─── Allowed makeup placement values (mirrors the frontend options) ─────────
const VALID_MAKEUP_PLACEMENTS = [
  'lipstick', 'lipliner', 'blush', 'foundation', 'concealer',
  'contour', 'highlighter', 'bronzer', 'eyeshadow', 'eyeliner',
  'eyebrows', 'mascara', 'freckles', 'gems', 'kajal', ''
];

// @desc    Create product with files
// @route   POST /api/productsgetProducts
// @access  Private
const createProduct = async (req, res) => {
  try {
    const {
      productName,
      categoryId,
      categoryName,
      subCategory,
      price,
      description,
      attributes,
      tags,
      stock,
      // ── Try-on fields ──────────────────────────────────────────────────
      makeupPlacement,
      finish,
      defaultOpacity,
    } = req.body;

    // Parse JSON strings if needed
    const parsedDescription = typeof description === 'string' ? JSON.parse(description) : description;
    const parsedAttributes  = typeof attributes  === 'string' ? JSON.parse(attributes)  : attributes;
    const parsedTags        = typeof tags        === 'string' ? JSON.parse(tags)        : tags;
    const parsedPrice       = typeof price       === 'string' ? JSON.parse(price)       : price;

    // Validate makeup placement
    const placement = makeupPlacement || '';
    if (!VALID_MAKEUP_PLACEMENTS.includes(placement)) {
      return res.status(400).json({ success: false, message: 'Invalid makeupPlacement value' });
    }

    const product = await Product.create({
      productName,
      categoryId,
      categoryName,
      subCategory,
      price: parsedPrice,
      description:  parsedDescription,
      attributes:   parsedAttributes,
      tags:         parsedTags,
      stock:        stock || 0,
      createdBy:    req.user._id,
      // ── Try-on fields ────────────────────────────────────────────────
      makeupPlacement: placement,
      finish:          finish          || 'matte',
      defaultOpacity:  defaultOpacity  != null ? Number(defaultOpacity) : 70,
      vectorSync: { status: 'pending', syncedAt: new Date() }
    });

    // Handle file uploads
    let uploadedFiles = [];
    if (req.files && req.files.length > 0) {
      const filePromises = req.files.map(file => {
        const fileType = file.mimetype.startsWith('image/') ? 'image'
                       : file.mimetype.startsWith('video/') ? 'video'
                       : 'document';
        return File.create({
          fileName:     file.filename,
          originalName: file.originalname,
          fileType,
          mimeType:   file.mimetype,
          fileSize:   file.size,
          url:        `${process.env.FILE_URL}/uploads/products/${file.filename}`,
          path:       `/uploads/products/${file.filename}`,
          altText:    productName,
          caption:    productName,
          uploadedBy: req.user._id,
          entityType: 'product',
          entityId:   product._id.toString()
        });
      });
      uploadedFiles = await Promise.all(filePromises);
    }

    await syncProductDb();
    res.status(201).json({
      success: true,
      message: 'Product created successfully',
      data: { product, files: uploadedFiles }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get all products with filters and search
// @route   GET /api/products
// @access  Private
const getProducts = async (req, res) => {
  try {
    const {
      search,
      categoryId,
      status,
      makeupPlacement,      // ← new filter
      minPrice,
      maxPrice,
      page      = 1,
      limit     = 20,
      sortBy    = 'createdAt',
      sortOrder = 'desc'
    } = req.query;

    const match = {};

    if (search) {
      match.$or = [
        { productName:  { $regex: search, $options: 'i' } },
        { tags:         { $in: [new RegExp(search, 'i')] } },
        { categoryName: { $regex: search, $options: 'i' } }
      ];
    }
    if (categoryId)      match.categoryId      = categoryId;
    if (status)          match.status          = status;
    if (makeupPlacement) match.makeupPlacement = makeupPlacement;   // ← new

    if (minPrice || maxPrice) {
      match.$expr = {
        $and: [
          minPrice ? { $gte: [{ $toDouble: '$price.value' }, Number(minPrice)] } : { $gte: [1,1] },
          maxPrice ? { $lte: [{ $toDouble: '$price.value' }, Number(maxPrice)] } : { $lte: [1,1] }
        ]
      };
    }

    const pageNum  = parseInt(page);
    const limitNum = parseInt(limit);
    const skip     = (pageNum - 1) * limitNum;
    const sort     = { [sortBy]: sortOrder === 'asc' ? 1 : -1 };

    const result = await Product.aggregate([
      { $match: match },
      {
        $facet: {
          data: [
            { $sort: sort },
            { $skip: skip },
            { $limit: limitNum },
            { $addFields: { productIdStr: { $toString: '$_id' } } },
            {
              $lookup: {
                from: 'productfiles',
                let:  { pid: '$productIdStr' },
                pipeline: [
                  {
                    $match: {
                      $expr: {
                        $and: [
                          { $eq: ['$entityType', 'product'] },
                          { $eq: ['$status', 'active']  },
                          { $eq: ['$entityId', '$$pid'] }
                        ]
                      }
                    }
                  },
                  { $project: { _id:1, fileName:1, originalName:1, fileType:1, mimeType:1, fileSize:1, url:1, altText:1, caption:1, createdAt:1, makeupPlacement:1, finish:1, defaultOpacity:1 } }
                ],
                as: 'files'
              }
            },
            { $project: { productIdStr: 0 } }
          ],
          total: [{ $count: 'count' }]
        }
      }
    ]);

    const products = result[0]?.data  || [];
    const total    = result[0]?.total?.[0]?.count || 0;

    res.json({
      success: true,
      data: products,
      pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) }
    });
  } catch (error) {
    console.error('getProducts error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get single product
// @route   GET /api/products/:id
// @access  Private
const getProduct = async (req, res) => {
  try {
    const product = await Product.findById(req.params.id).lean();
    if (!product) return res.status(404).json({ success: false, message: 'Product not found' });

    const files = await File.find({
      entityType: 'product',
      entityId:   product._id.toString(),
      status:     'active'
    }).lean();

    res.json({ success: true, data: { ...product, files } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Update product
// @route   PUT /api/products/:id
// @access  Private
const updateProduct = async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ success: false, message: 'Product not found' });

    const {
      productName,
      categoryId,
      categoryName,
      subCategory,
      price,
      description,
      attributes,
      tags,
      stock,
      status,
      deletedFileIds,
      // ── Try-on fields ────────────────────────────────────────────────────
      makeupPlacement,
      finish,
      defaultOpacity,
    } = req.body;

    if (productName)   product.productName  = productName;
    if (categoryId)    product.categoryId   = categoryId;
    if (categoryName)  product.categoryName = categoryName;
    if (subCategory !== undefined) product.subCategory = subCategory;
    if (price)         product.price        = typeof price       === 'string' ? JSON.parse(price)       : price;
    if (description)   product.description  = typeof description === 'string' ? JSON.parse(description) : description;
    if (attributes)    product.attributes   = typeof attributes  === 'string' ? JSON.parse(attributes)  : attributes;
    if (tags)          product.tags         = typeof tags        === 'string' ? JSON.parse(tags)        : tags;
    if (stock !== undefined) product.stock  = stock;
    if (status)        product.status       = status;

    // ── Try-on fields ────────────────────────────────────────────────────
    if (makeupPlacement !== undefined) {
      if (!VALID_MAKEUP_PLACEMENTS.includes(makeupPlacement)) {
        return res.status(400).json({ success: false, message: 'Invalid makeupPlacement value' });
      }
      product.makeupPlacement = makeupPlacement;
    }
    if (finish !== undefined)         product.finish         = finish;
    if (defaultOpacity !== undefined) product.defaultOpacity = Number(defaultOpacity);

    product.vectorSync = { status: 'pending', syncedAt: new Date() };
    await product.save();

    // Handle deleted files
    if (deletedFileIds) {
      const ids = typeof deletedFileIds === 'string' ? JSON.parse(deletedFileIds) : deletedFileIds;
      if (Array.isArray(ids) && ids.length > 0) {
        await File.updateMany({ _id: { $in: ids } }, { status: 'deleted' });
      }
    }

    // Handle new file uploads
    let uploadedFiles = [];
    if (req.files && req.files.length > 0) {
      const filePromises = req.files.map(file => {
        const fileType = file.mimetype.startsWith('image/') ? 'image'
                       : file.mimetype.startsWith('video/') ? 'video'
                       : 'document';
        return File.create({
          fileName:     file.filename,
          originalName: file.originalname,
          fileType,
          mimeType:   file.mimetype,
          fileSize:   file.size,
          url:        `${process.env.FILE_URL}/uploads/products/${file.filename}`,
          path:       `/uploads/products/${file.filename}`,
          altText:    product.productName,
          caption:    product.productName,
          uploadedBy: req.user._id,
          entityType: 'product',
          entityId:   product._id.toString()
        });
      });
      uploadedFiles = await Promise.all(filePromises);
    }

    const updatedProduct = await Product.findById(product._id).lean();

    await syncProductDb();
    res.json({
      success: true,
      message: 'Product updated successfully',
      data: { product: updatedProduct, newFiles: uploadedFiles }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Delete product (soft delete)
// @route   DELETE /api/products/:id
// @access  Private
const deleteProduct = async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ success: false, message: 'Product not found' });

    product.status     = 'inactive';
    product.vectorSync = { status: 'pending', syncedAt: new Date() };
    await product.save();

    await File.updateMany(
      { entityType: 'product', entityId: product._id.toString() },
      { status: 'deleted' }
    );

    await syncProductDb();
    res.json({ success: true, message: 'Product deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get product categories
// @route   GET /api/products/categories/list
// @access  Private
const getCategories = async (req, res) => {
  try {
    const counts = await Product.aggregate([
      { $group: { _id: '$categoryId', productCount: { $sum: 1 } } }
    ]);
    const countMap = {};
    counts.forEach(c => { countMap[c._id.toString()] = c.productCount; });

    const categories = await Category.find().sort({ categoryName: 1 });
    const result = categories.map(cat => ({
      ...cat.toObject(),
      count: countMap[cat._id.toString()] || 0
    }));

    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

const createCategory = async (req, res) => {
  try {
    const { categoryName, description, status } = req.body;
    if (!categoryName) {
      return res.status(400).json({ success: false, message: 'categoryName is required' });
    }

    const lastCategory = await Category.findOne().sort({ categoryId: -1 }).lean();
    let nextId = 'C001';
    if (lastCategory?.categoryId) {
      const num = parseInt(lastCategory.categoryId.replace('C', ''));
      nextId = `C${String(num + 1).padStart(3, '0')}`;
    }

    const category = await Category.create({
      categoryId:   nextId,
      categoryName: categoryName.trim(),
      description,
      status:       status || 'active',
      createdBy:    req.user?._id
    });

    res.status(201).json({ success: true, data: category });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

const updateCategory = async (req, res) => {
  try {
    const { id } = req.params;
    if (req.body.categoryId) delete req.body.categoryId;   // prevent ID mutation

    const category = await Category.findByIdAndUpdate(id, req.body, { new: true, runValidators: true });
    if (!category) return res.status(404).json({ success: false, message: 'Category not found' });

    res.json({ success: true, data: category });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

const deleteCategory = async (req, res) => {
  try {
    const { id } = req.params;
    const category = await Category.findById(id);
    if (!category) return res.status(404).json({ success: false, message: 'Category not found' });

    const exists = await Product.exists({ categoryId: category.categoryId });
    if (exists) {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete — this category has products assigned to it'
      });
    }

    await category.deleteOne();
    res.json({ success: true, message: 'Category deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

const syncProductDb = async () => {
  try {
    const llmRes = await axios.post(`${process.env.LLM_API}/api/ecommerce/vector/sync`, '');
    console.log('llmRes', llmRes.status);
    return llmRes;
  } catch (e) {
    console.warn('syncProductDb failed (non-fatal):', e.message);
  }
};

const listPurchases = async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const skip = (page - 1) * limit;

    const purchases = await Purchase.find()
      .populate('invoice')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean();

    const total = await Purchase.countDocuments();

    res.json({
      success: true,
      data: purchases,
      pagination: { total, page: parseInt(page), limit: parseInt(limit) }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

const updateOrderStatus = async (req, res) => {
  try {
    const { purchaseId, status, comment } = req.body;
    if (!purchaseId) return res.status(400).json({ success: false, message: 'purchaseId is required' });

    const validStatuses = ['pending','confirmed','processing','shipped','delivered','cancelled'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `Invalid status. Must be one of: ${validStatuses.join(', ')}`
      });
    }

    const purchase = await Purchase.findById(purchaseId);
    if (!purchase) return res.status(404).json({ success: false, message: 'Purchase not found' });

    purchase.orderStatus   = status;
    purchase.currentStatus = status;
    purchase.statusLog.push({ status, comment: comment || `Status updated to ${status}`, updatedAt: new Date() });

    await purchase.save();
    res.json({ success: true, message: 'Status updated', data: { purchaseId, status } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = {
  createProduct,
  getProducts,
  getProduct,
  updateProduct,
  deleteProduct,
  getCategories,
  createCategory,
  updateCategory,
  deleteCategory,
  listPurchases,
  updateOrderStatus
};