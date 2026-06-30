// ==================== controllers/productController.js ====================
const { Product, File, Category, FileStatus, Purchase, Invoice, Discount } = require('../models');
const axios = require('axios');

// ─── Storefront discount helpers ─────────────────────────────────────────────

/**
 * Fetch all discounts that are safe to display on product listings/detail
 * without customer or cart context:
 *   • active + within date window
 *   • auto-apply (no couponCode required)
 *   • simple pricing model (tiered can't show a single price; shown on cart)
 *   • not freeShipping (nothing to render as a price cut on a card)
 *   • no customers / locations scope (depends on context we don't have here)
 */
async function loadStorefrontDiscounts() {
  const now = new Date();
  const candidates = await Discount.find({
    status:       'active',
    couponCode:   '',
    pricingModel: 'simple',
    discountType: { $ne: 'freeShipping' }
  }).lean();

  console.log(`loadStorefrontDiscounts: ${candidates.length} candidates found`);
  console.log(`loadStorefrontDiscounts: filtering by date and scope...`, candidates);

  return candidates.filter(d => {
    if (d.startDate && new Date(d.startDate) > now) return false;
    if (d.endDate   && new Date(d.endDate)   < now) return false;
    if ((d.scopes || []).some(s => s.type === 'customers' || s.type === 'locations')) return false;
    if (d.simpleDiscount?.value == null) return false;
    return true;
  });
}

/**
 * Given a loaded list of storefront discounts and a product, return the best
 * (most savings) matching discount — or null if none apply.
 *
 * Mirrors the AND-scope logic from splitItemsByScope in discountController:
 * a discount must satisfy EVERY scope type it declares.
 *
 * minCart > 0 discounts are excluded here: a product price doesn't represent
 * the cart subtotal, so we can't guarantee the threshold is met. They still
 * fire correctly through /api/discounts/apply at checkout.
 */
function getBestDiscount(discounts, product) {
  let best = null;

  console.log(`getBestDiscount: checking ${discounts}`);
  console.log(`getBestDiscount: product ${product._id} price ${product.price?.value ?? product.price}`);
  for (const d of discounts) {
    // Skip if a cart minimum is required — can't verify on a product card
    if (d.simpleDiscount.minCart > 0) continue;

    const productScope  = (d.scopes || []).find(s => s.type === 'products');
    const categoryScope = (d.scopes || []).find(s => s.type === 'categories');

    const productOk  = !productScope?.selectedIds?.length
      || productScope.selectedIds.includes(String(product._id));
    const categoryOk = !categoryScope?.selectedIds?.length
      || categoryScope.selectedIds.includes(String(product.categoryId));

    if (!productOk || !categoryOk) continue;

    const price = parseFloat(product.price?.value ?? product.price) || 0;
    const discountedPrice = d.discountType === 'percent'
      ? price - (price * d.simpleDiscount.value) / 100
      : Math.max(price - d.simpleDiscount.value, 0);

    const rounded = Math.round(discountedPrice * 100) / 100;

    if (!best || rounded < best.discountedPrice) {
      best = {
        campaignId:      String(d._id),
        campaignName:    d.campaignName,
        discountType:    d.discountType,
        value:           d.simpleDiscount.value,
        originalPrice:   price,
        discountedPrice: rounded,
        badgeLabel:      d.discountType === 'percent'
          ? `${d.simpleDiscount.value}% OFF`
          : `₹${d.simpleDiscount.value} OFF`
      };
    }
  }

  console.log(`getBestDiscount: ${best ? 'found' : 'none'} for product ${product._id}`);

  return best;
}

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

const getSalesCountMap = async (products) => {
  const objectIds = products.map(p => p._id);   // already ObjectId, no conversion needed

  const results = await Purchase.aggregate([
    { $unwind: '$items' },
    { $match: { 'items.product': { $in: objectIds } } },
    { $group: { _id: '$items.product', totalSold: { $sum: '$items.quantity' } } }
  ]);

  const map = {};
  results.forEach(r => { map[r._id.toString()] = r.totalSold; });
  return map;
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
      makeupPlacement,
      minPrice,
      maxPrice,
      page      = 1,
      limit     = 20,
      sortBy    = 'createdAt',   // 'bestseller' | 'latest' | 'createdAt' | 'price' etc.
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
    if (makeupPlacement) match.makeupPlacement = makeupPlacement;

    const pageNum  = parseInt(page);
    const limitNum = parseInt(limit);
    const skip     = (pageNum - 1) * limitNum;

    let allProducts = await Product.find(match).lean();

    // ── Price filter (in-memory, CosmosDB-compatible) ────────────────────────
    if (minPrice || maxPrice) {
      allProducts = allProducts.filter(p => {
        const val = parseFloat(p.price?.value);
        if (isNaN(val)) return false;
        if (minPrice && val < Number(minPrice)) return false;
        if (maxPrice && val > Number(maxPrice)) return false;
        return true;
      });
    }

    // ── Bestseller: fetch sales counts only when needed ──────────────────────
    let salesMap = {};
    if (sortBy === 'bestseller') {
      salesMap = await getSalesCountMap(allProducts);     // ← pass full objects
      allProducts.forEach(p => {
        p._salesCount = salesMap[p._id.toString()] || 0;
      });
    }

    // ── Sort ─────────────────────────────────────────────────────────────────
    const sortDir = sortOrder === 'asc' ? 1 : -1;

    if (sortBy === 'bestseller') {
      allProducts.sort((a, b) => (b._salesCount - a._salesCount));   // always desc
    } else if (sortBy === 'latest') {
      allProducts.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    } else {
      allProducts.sort((a, b) => {
        const aVal = a[sortBy] ?? '';
        const bVal = b[sortBy] ?? '';
        if (aVal < bVal) return -sortDir;
        if (aVal > bVal) return sortDir;
        return 0;
      });
    }

    // ── Paginate ─────────────────────────────────────────────────────────────
    const total    = allProducts.length;
    const products = allProducts.slice(skip, skip + limitNum);


    // ── Discount join (single DB query for all matching storefront discounts) ─
    const storefrontDiscounts = await loadStorefrontDiscounts();

    console.log('storefrontDiscounts', storefrontDiscounts)
    // ── Files join ───────────────────────────────────────────────────────────
    const productIds = products.map(p => p._id.toString());
    const allFiles = productIds.length
      ? await File.find({ entityType: 'product', entityId: { $in: productIds }, status: 'active' })
          .select('_id fileName originalName fileType mimeType fileSize url altText caption createdAt makeupPlacement finish defaultOpacity entityId')
          .lean()
      : [];

    console.log(`getProducts: ${allFiles.length} files found for ${productIds.length} products`);
    const filesMap = {};
    allFiles.forEach(f => {
      if (!filesMap[f.entityId]) filesMap[f.entityId] = [];
      filesMap[f.entityId].push(f);
    });

    const enrichedProducts = products.map(p => ({
      ...p,
      files:    filesMap[p._id.toString()] || [],
      discount: getBestDiscount(storefrontDiscounts, p) // null if none apply
    }));


    res.json({
      success: true,
      data: enrichedProducts,
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

    const storefrontDiscounts = await loadStorefrontDiscounts();
    const discount = getBestDiscount(storefrontDiscounts, product);

    res.json({ success: true, data: { ...product, files, discount } });
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
    // COSMOS DB COMPATIBLE: no aggregate with $group, count in memory
    const [allProducts, categories] = await Promise.all([
      Product.find({}, 'categoryId').lean(),
      Category.find().lean()
    ]);

    const countMap = {};
    allProducts.forEach(p => {
      const id = p.categoryId?.toString();
      if (id) countMap[id] = (countMap[id] || 0) + 1;
    });

    // Sort categories in memory
    const result = categories
      .sort((a, b) => (a.categoryName || '').localeCompare(b.categoryName || ''))
      .map(cat => ({
        ...cat,
        count: countMap[cat._id?.toString()] || countMap[cat.categoryId] || 0
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

    // COSMOS DB COMPATIBLE: no .sort() — fetch all, find max in memory
    const allCategories = await Category.find({}, 'categoryId').lean();
    let nextId = 'C001';
    if (allCategories.length) {
      const nums = allCategories
        .map(c => parseInt((c.categoryId || '').replace('C', '')))
        .filter(n => !isNaN(n));
      const maxNum = nums.length ? Math.max(...nums) : 0;
      nextId = `C${String(maxNum + 1).padStart(3, '0')}`;
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

    // COSMOS DB COMPATIBLE: no .populate(), no .sort() — do manually
    const allPurchases = await Purchase.find()
      .skip(skip)
      .limit(parseInt(limit))
      .lean();

    // Sort in memory
    allPurchases.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    // Manual populate invoice
    const invoiceIds = allPurchases.map(p => p.invoice).filter(Boolean);
    const invoices = invoiceIds.length ? await Invoice.find({ _id: { $in: invoiceIds } }).lean() : [];
    const invoiceMap = {};
    invoices.forEach(inv => { invoiceMap[inv._id.toString()] = inv; });

    const purchases = allPurchases.map(p => ({
      ...p,
      invoice: p.invoice ? invoiceMap[p.invoice.toString()] || null : null
    }));

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