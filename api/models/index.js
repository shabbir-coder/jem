// ==================== models/index.js ====================
const mongoose = require('mongoose');

// ==================== ENUMS & CONSTANTS ====================
const CartStatus = {
  IN_CART: 'IN_CART',
  IS_PAID: 'ORDERED',
  IS_REMOVED: 'REMOVED',
  IS_CHECKOUT: 'CHECKOUT'
};

const MessageStatus = {
  SENT: 'sent',
  READ: 'read',
  DELIVERED: 'delivered',
  FAILED: 'failed',
  RECEIVED: 'received'
}

const ProductStatus = {
  ACTIVE: 'active',
  INACTIVE: 'inactive',
  OUT_OF_STOCK: 'outOfStock',
  DRAFT: 'draft'
};

const FileStatus = {
  ACTIVE: 'active',
  INACTIVE: 'inactive',
  DELETED: 'deleted'
};

const MessageType = {
  TEXT: 'text',
  TEMPLATE: 'template',
  IMAGE: 'image',
  VIDEO: 'video',
  AUDIO: 'audio',
  DOCUMENT: 'document',
  STICKER: 'sticker',
  LOCATION: 'location',
  CONTACT: 'contact'
};

const PaymentStatus = {
  PENDING: 'pending',
  PAID: 'paid',
  FAILED: 'failed',
  REFUNDED: 'refunded'
};

// ==================== USER SCHEMA ====================
const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  phoneNo: { type: Number },
  token: { type: String },
  refreshToken: { type: String },
  isActive: { type: Boolean, default: false },
  isVerified: { type: Boolean, default: false },
}, { timestamps: true });

// ==================== INSTANCE SCHEMA ====================
const instanceSchema = new mongoose.Schema({
  accessToken: { type: String, required: true },
  numberId: { type: String, required: true },
  businessId: { type: String },
  lastScannedAt: { type: Date },
  number: { type: Number, required: true },
  businessOwners: [{ name: { type: String }, number: { type: Number } }],
  name: { type: String },
  isActive: { type: Boolean, default: false },
  isVerified: { type: Boolean, default: false },
  isDeleted: { type: Boolean, default: false },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

// ==================== CONTACT SCHEMA ====================
const contactSchema = new mongoose.Schema({
  name: { type: String, required: false },
  number: { type: String, required: true, unique: true, index: true },
  isVerified: { type: Boolean, default: false },
  addressTrackingActive: { type: Boolean, default: false },
  trackingStep: { type: Number, default: 0 },
  address: { type: String, required: false },
  city: { type: String },
  state: { type: String },
  country: { type: String },
  pinCode: { type: String },
  mapUrl: { type: String },
  status: {
    type: String,
    enum: ['enquiry', 'cart', 'checkout', 'not_delivered', 'delivered'],
    default: 'enquiry'
  },
  statusLog: [{ type: { type: String, default: 'enquiry' }, updatedAt: { type: Date, default: Date.now } }],
  recieverNumber: { type: String },
  recieverName: { type: String },
  isArchived: { type: Boolean, default: false },
  recentTransaction: [{ entityType: String, details: mongoose.Schema.Types.Mixed }],
  lastMessageAt: { type: Date },
  lastMessageId: { type: String },
  unreadCount: { type: Number, default: 0 },
  contactType: { type: String, default: 'Customer' },
  isBlocked: { type: Boolean, default: false, index: true },
  blockedAt: { type: Date },
  deliveryType : {
    type: String,
    enum: ["home_delivery", "store_pickup"],
    default: 'home_delivery'
  },
  unblockedAt: { type: Date },
  blockedBy: { type: String }, // Instance ID that blocked this user
  blockHistory: [{
    action: { type: String, enum: ['blocked', 'unblocked'] },
    timestamp: { type: Date, default: Date.now },
    instanceId: { type: String },
    reason: { type: String }
  }],
}, { timestamps: true });

const customerAddressSchema = new mongoose.Schema(
  {
    phoneNumber: { type: String },
    name: { type: String },
    address: { type: String },
    city: { type: String },
    country: { type: String },
    state: { type: String },
    postalCode: { type: String },
    mapUrl: { type: String }
  },
  { timestamps: { createdAt: 'addedAt', updatedAt: 'updatedAt' }, collection: 'customerInfo' }
);

contactSchema.index({ status: 1 });
contactSchema.index({ isArchived: 1 });
contactSchema.index({ lastMessageAt: -1 });
contactSchema.index({ unreadCount: 1 });

// ==================== PRODUCT SCHEMA ====================
const productSchema = new mongoose.Schema({
  productName:  { type: String, required: true, trim: true },
  categoryId:   { type: String, required: true, index: true },
  categoryName: { type: String, required: true },
  subCategory:  { type: String },
 
  price: {
    currency: { type: String, default: 'INR' },
    value:    { type: String, required: true }
  },
 
  description: [{ type: String }],
 
  attributes: {
    shade:            { type: String },
    shadeDescription: { type: String },
    suitableFor:      { type: String },
    shadeColour:      { type: String },
  },
 
  tags:   [{ type: String }],
  status: { type: String, enum: ['active','inactive','outOfStock','draft'], default: 'active' },
  stock:  { type: Number, default: 0 },
 
  // ── Virtual Try-On fields ───────────────────────────────────────────────────
  // Which makeup layer this product maps to on the face
  makeupPlacement: {
    type: String,
    enum: [
      'lipstick', 'lipliner', 'blush', 'foundation', 'concealer',
      'contour', 'highlighter', 'bronzer', 'eyeshadow', 'eyeliner',
      'eyebrows', 'mascara', 'freckles', 'gems', 'kajal'
    ],
    default: ''
  },
  // Applicable for lipstick, eyeshadow
  finish: {
    type: String,
    enum: ['matte', 'satin', 'glossy'],
    default: 'matte'
  },
  // Default opacity (0–100) passed to the canvas renderer
  defaultOpacity: {
    type: Number,
    min: 0,
    max: 100,
    default: 15
  },
  // ────────────────────────────────────────────────────────────────────────────
 
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
 
  vectorSync: {
    status:   { type: String, enum: ['pending','synced','failed'], default: 'pending' },
    syncedAt: { type: Date }
  }
}, { timestamps: true });
productSchema.index({ productName: 1 });
productSchema.index({ tags: 1 });
productSchema.index({ categoryName: 1 });
productSchema.index({ categoryId: 1, status: 1 });
productSchema.index({ 'price.value': 1 });

// ==================== FILE SCHEMA ====================
const fileSchema = new mongoose.Schema({
  fileName: { type: String, required: true },
  originalName: { type: String, required: true },
  fileType: { type: String, required: true },
  mimeType: { type: String, required: true },
  fileSize: { type: Number, required: true },
  url: { type: String, required: true },
  path: { type: String, required: true },
  altText: { type: String },
  caption: { type: String },
  uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  entityType: { type: String, enum: ['product', 'message', 'invoice', 'other'] },
  entityId: { type: String },
  status: { type: String, enum: Object.values(FileStatus), default: FileStatus.ACTIVE }
}, { timestamps: true });

fileSchema.index({ entityType: 1, entityId: 1 });
fileSchema.index({ uploadedBy: 1 });

// ==================== CHAT MESSAGE SCHEMA ====================
const chatSchema = new mongoose.Schema({
  messageId: { type: String, unique: true, sparse: true },
  sender: { type: String, required: true, index: true },
  receiver: { type: String, required: true, index: true },
  instance_id: { type: String, required: true },
  text: { type: String },
  type: { type: String, enum: Object.values(MessageType), default: MessageType.TEXT },
  file: { type: mongoose.Schema.Types.ObjectId, ref: 'ProductFile' },
  context: { messageId: { type: String }, from: { type: String }, text: { type: String } },
  reactions: [{ emoji: { type: String }, from: { type: String }, timestamp: { type: Date, default: Date.now } }],
  isForwarded: { type: Boolean, default: false },
  forwardedFrom: { type: String },
  status: [{
    status: { type: String, enum: Object.values(MessageStatus), default: MessageStatus.SENT },
    timeStamp: { type: Date }
  }],
  isRead: { type: Boolean, default: false },
  readAt: { type: Date },
  isBuyingRequest: { type: Boolean, default: false },
  isSearchingRequest: { type: Boolean, default: false },
  location: { latitude: { type: Number }, longitude: { type: Number }, name: { type: String }, address: { type: String } },
  isGroupMessage: { type: Boolean, default: false },
  groupId: { type: mongoose.Schema.Types.ObjectId }
}, { timestamps: true });

chatSchema.index({ sender: 1, receiver: 1, createdAt: -1 });
chatSchema.index({ instance_id: 1, createdAt: -1 });

// ==================== CHAT LOGS SCHEMA ====================
const chatLogsSchema = new mongoose.Schema({
  sender: { type: String, required: true },
  receiver: { type: String, required: true },
  instance_id: { type: String, required: true },
  usedFile: { type: mongoose.Schema.Types.ObjectId, ref: 'ProductFile' },
  action: { type: String },
  metadata: { type: mongoose.Schema.Types.Mixed }
}, { timestamps: true });

// ==================== CART SCHEMA ====================
const cartSchema = new mongoose.Schema({
  userNumber: { type: String, required: true, index: true },
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  quantity: { type: Number, default: 1, min: 1 },
  price: { type: String, required: true },
  total: { type: String, required: true },
  status: { type: String, enum: Object.values(CartStatus), default: CartStatus.IN_CART },
  isRemoved: { type: Boolean, default: false },
  instance_id: { type: String, required: true }
}, { timestamps: true });

cartSchema.index({ userNumber: 1, status: 1 });
cartSchema.index({ product: 1 });

const statusLogSchema = new mongoose.Schema({
  status: { type: String, enum: ['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled'] },
  comment: { type: String },
  updatedAt: { type: Date, default: Date.now }
}, { _id: false });

// ==================== PURCHASE SCHEMA ====================
const purchaseSchema = new mongoose.Schema({
  userNumber: { type: String, required: true, index: true },
  orderId: { type: String, unique: true },
  items: [{
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    productName: { type: String, required: true },
    quantity: { type: Number, required: true },
    price: { type: String, required: true },
    total: { type: String, required: true }
  }],
  subTotal: { type: String, required: true },
  gst: { type: String, default: '0' },
  deliveryCharges: { type: String, default: '0' },
  otherCharges: { type: String, default: '0' },
  totalAmount: { type: String, required: true },
  shippingAddress: { name: { type: String }, address: { type: String }, city: { type: String }, state: { type: String }, pinCode: { type: String } },
  paymentStatus: { type: String, enum: Object.values(PaymentStatus), default: PaymentStatus.PENDING },
  transactionNumber: { type: String },
  paymentDate: { type: Date },
  orderStatus: { type: String, enum: ['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled'], default: 'pending' },
  statusLog: [statusLogSchema],
  instance_id: { type: String, required: true },
  invoice: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice' },
  appliedDiscounts: [{ 
    campaignId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Discount', default: null },
    campaignName:   { type: String, default: null },
    couponCode:     { type: String, default: null },
    discountType:   { type: String, default: null },   // 'percent' | 'flat' | 'freeShipping'
    discountAmount: { type: Number, default: 0 },
    freeShipping:   { type: Boolean, default: false }
  }],
}, { timestamps: true });

purchaseSchema.index({ userNumber: 1, createdAt: -1 });
purchaseSchema.index({ 'appliedDiscounts.campaignId': 1 });

// ==================== INVOICE SCHEMA ====================
const itemSchema = new mongoose.Schema({
  product: { type: String, required: true },
  price: { type: String, required: true },
  quantity: { type: Number, required: true },
  total: { type: String, required: true }
});

const invoiceSchema = new mongoose.Schema({
  invoiceNumber: { type: String, required: true, unique: true },
  purchaseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Purchase' },
  name: { type: String },
  address: { type: String },
  city: { type: String },
  state: { type: String },
  pincode: { type: String },
  items: [itemSchema],
  subTotal: { type: String },
  gst: { type: String },
  deliveryCharges: { type: String },
  otherCharges: { type: String },
  totalAmount: { type: String },
  paymentStatus: { type: String },
  transactionNumber: { type: String },
  paymentDate: { type: String },
  outstandingAmount: { type: String },
  filePath: { type: String }
}, { timestamps: true });

// ==================== CATEGORY SCHEMA ====================
const categorySchema = new mongoose.Schema({
  categoryId: { type: String, required: true, unique: true },
  categoryName: { type: String, required: true },
  description: { type: String },
  parentCategory: { type: String },
  status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

// ==================== GROUP SCHEMA ====================
const groupSchema = new mongoose.Schema({
  groupName: { type: String, required: true, unique: true },
  description: { type: String },
  flag: { type: String },
  status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  isArchived: { type: Boolean, default: false },
  isDeleted: { type: Boolean, default: false },
  isPinned: { type: Boolean, default: false },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

const groupMemberSchema = new mongoose.Schema({
  groupId: { type: String },
  contactId: { type: String },
  status: { type: String, enum: ['active', 'inactive'], default: 'active' },
}, { timestamps: true });

// ==================== TEMPLATE SCHEMA ====================
const ParameterSchema = new mongoose.Schema({
  key: { type: String },
  bindValue: { type: String }
}, { _id: false });

const TemplateSchema = new mongoose.Schema({
  name: { type: String },
  category: { type: String },
  templateName: { type: String },
  languageCode: { type: String, default: 'en' },
  templateText: { type: String },
  parameters: [ParameterSchema],
  mediaUrl: { type: String },
  mediaType: { type: String },
  mediaMime: { type: String },
  description: { type: String },

  // ── Meta sync fields ──────────────────────────────────────────────────────
  metaTemplateId: { type: String, index: true },   // id returned by Meta API
  metaStatus: {                                     // APPROVED / PENDING / REJECTED etc.
    type: String,
    enum: ['APPROVED', 'PENDING', 'REJECTED', 'PAUSED', 'DISABLED', 'IN_APPEAL', 'DELETED', 'REINSTATED'],
    default: 'PENDING'
  },
  metaSyncedAt: { type: Date },                    // last time we pulled from Meta
}, { timestamps: true });

// ==================== WALLET / TRANSACTION SCHEMA ====================
const transactionSchema = new mongoose.Schema({
  type: { type: String, enum: ['credit', 'debit'], required: true },
  amount: { type: Number, required: true },
  description: { type: String, default: '' },
  campaignId: { type: mongoose.Schema.Types.ObjectId, ref: 'CampaignLog', default: null },
  balanceAfter: { type: Number, required: true },
  createdAt: { type: Date, default: Date.now }
});

const walletSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    balance: { type: Number, default: 1000, min: 0 },
    transactions: [transactionSchema]
  },
  { timestamps: true }
);

// ==================== CAMPAIGN LOG SCHEMA ====================
const recipientBreakdownSchema = new mongoose.Schema({
  countryCode: String,
  countryName: String,
  count: Number,
  pricePerMessage: Number,
  subtotal: Number
}, { _id: false });

const campaignLogSchema = new mongoose.Schema(
  {
    campaignId: { type: String, unique: true, index: true }, // e.g. template_new-02-11-26/a
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    templateId: { type: mongoose.Schema.Types.ObjectId, ref: 'Template', required: true },
    templateName: { type: String },                          // denormalised for display
    templateCategory: {
      type: String,
      enum: ['marketing', 'utility', 'authentication'],
      required: true
    },
    viewMode: { type: String, enum: ['contacts', 'groups'], default: 'contacts' },
    totalRecipients: Number,
    successCount: { type: Number, default: 0 },
    failedCount: { type: Number, default: 0 },
    totalCost: Number,
    breakdownByCountry: [recipientBreakdownSchema],
    walletBalanceBefore: Number,
    walletBalanceAfter: Number,
    status: {
      type: String,
      enum: ['queued', 'processing', 'completed', 'failed'],
      default: 'queued'
    },
    errorMessage: { type: String }
  },
  { timestamps: true }
);

campaignLogSchema.index({ userId: 1, createdAt: -1 });


// ==================== COUNTRY PRICING SCHEMA ====================
const countryPricingSchema = new mongoose.Schema({
  countryName: { type: String, required: true, trim: true },
  countryCode: { type: String, required: true, trim: true },
  marketingMetaCost: { type: Number, required: true, default: 0 },
  utilityMetaCost: { type: Number, required: true, default: 0 },
  authenticationMetaCost: { type: Number, required: true, default: 0 },
  profitType: { type: String, enum: ['fixed', 'percentage'], required: true, default: 'fixed' },
});


const discountTierSchema = new mongoose.Schema({
  minCart: { type: Number, required: true, min: 0 },
  value:   { type: Number, required: true, min: 0 }
}, { _id: false });
 
const discountLimitsSchema = new mongoose.Schema({
  maxUses:         { type: Number, default: null },
  maxPerUser:      { type: Number, default: null },
  combineOther:    { type: Boolean, default: false },
  firstOrderOnly:  { type: Boolean, default: false },
  newCustomerOnly: { type: Boolean, default: false }
}, { _id: false });
 
const discountScopeConditionSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['products', 'categories', 'customers', 'locations'],
    required: true
  },
  selectedIds:    [{ type: String }],
  selectedLabels: [{ type: String }]
}, { _id: false });

const discountSchema = new mongoose.Schema({
  campaignName: { type: String, required: true, trim: true, maxlength: 60 },
  startDate:    { type: String },   // kept as ISO date-string to match frontend
  endDate:      { type: String },
  couponCode:   { type: String, trim: true, uppercase: true, default: '' },
 
  discountType: {
    type: String,
    enum: ['percent', 'flat', 'freeShipping'],
    required: true,
    default: 'percent'
  },
  pricingModel: {
    type: String,
    enum: ['simple', 'tiered'],
    required: true,
    default: 'simple'
  },
 
  simpleDiscount: {
    value:   { type: Number, default: null },
    minCart: { type: Number, default: null }
  },
  tiers: [discountTierSchema],
 
  scopes: {
    type: [discountScopeConditionSchema],
    default: []   // empty = applies to ALL — no restriction
  },
  limits: { type: discountLimitsSchema, default: () => ({}) },
 
  tnc: { type: String, default: '' },
 
  status: {
    type: String,
    enum: ['active', 'inactive', 'expired'],
    default: 'active'
  },
 
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });
 
discountSchema.index({ status: 1 });
discountSchema.index({ couponCode: 1 });
discountSchema.index({ createdBy: 1, createdAt: -1 });

const pendingLLMRequestSchema = new mongoose.Schema({
  requestId:   { type: String, required: true, unique: true },
  sender:      { type: String, required: true },
  instanceId:  { type: String, required: true },   // instance._id.toString()
  numberId:    { type: String, required: true },   // instance.numberId, needed to send the reply
  status:      { type: String, enum: ['pending', 'completed', 'failed', 'expired'], default: 'pending' },
  createdAt:   { type: Date, default: Date.now, expires: 60 * 60 * 6 } // TTL index, auto-cleans after 6h
});

const ReviewStatus = {
  PENDING:  'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected'
};

const ConcernType = {
  CONCERN: 'concern',
  GOOD:    'good',
  NEUTRAL: 'neutral'
};

const ConcernForOptions = [
  'delivery',
  'order_process',
  'product_quality',
  'chat_ai',
  'packaging',
  'price',
  'other'
];

const ReviewSource = {
  WHATSAPP: 'whatsapp',   // captured from a live WhatsApp chat, identified by the LLM
  ADMIN:    'admin'       // typed in manually from the admin panel
};

const reviewStatusLogSchema = new mongoose.Schema({
  status:    { type: String, enum: Object.values(ReviewStatus) },
  comment:   { type: String },
  updatedAt: { type: Date, default: Date.now },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { _id: false });

const reviewMediaSchema = new mongoose.Schema({
  url:      { type: String, required: true },
  path:     { type: String },
  fileType: { type: String, enum: ['image', 'video', 'audio', 'document'], default: 'image' },
  mimeType: { type: String },
  fileId:   { type: String },
  caption:  { type: String },
  file:     { type: mongoose.Schema.Types.ObjectId, ref: 'ProductFile' } // set when uploaded via admin panel
}, { _id: false });

// ==================== REVIEW SCHEMA ====================
const reviewSchema = new mongoose.Schema({

  // ── Customer details ────────────────────────────────────────────────────
  customerName:   { type: String, trim: true },
  customerNumber: { type: String, required: true, index: true, trim: true },
  customerEmail:  { type: String, trim: true },

  // ── Product details ─────────────────────────────────────────────────────
  product:      { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
  productName:  { type: String },     // denormalised so review still reads fine if product is later removed
  categoryName: { type: String },

  // ── Purchase details (which order this guest is reviewing) ─────────────
  purchase: { type: mongoose.Schema.Types.ObjectId, ref: 'Purchase' },
  orderId:  { type: String },
  invoice:  { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice' },

  // ── The review itself ───────────────────────────────────────────────────
  reviewText: { type: String, required: true },
  rating:     { type: Number, min: 1, max: 5 },
  media:      [reviewMediaSchema],

  // ── LLM classification (read-only from the ops side, in principle) ─────
  concernType: { type: String, enum: Object.values(ConcernType), default: 'neutral', index: true },
  llmConfidence:   { type: Number },              // 0–1, optional, if the LLM provides one
  llmRawResponse:  { type: mongoose.Schema.Types.Mixed },  // raw payload for audit/debugging

  // ── Ops triage ───────────────────────────────────────────────────────────
  concernFor:      { type: String, enum: ConcernForOptions, default: 'other' },
  concernForOther: { type: String, trim: true },  // free text used only when concernFor === 'other'
  remark:          { type: String, trim: true },  // internal note, not shown to the customer

  // ── Workflow status ──────────────────────────────────────────────────────
  status:    { type: String, enum: Object.values(ReviewStatus), default: ReviewStatus.PENDING, index: true },
  statusLog: [reviewStatusLogSchema],

  // ── Storefront display ───────────────────────────────────────────────────
  displayOnWebsite: { type: Boolean, default: false, index: true },

  // ── Our response back to the customer ───────────────────────────────────
  ourResponse: { type: String, trim: true },
  respondedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  respondedAt: { type: Date },

  // ── Contact / follow-up tracking ─────────────────────────────────────────
  isCalled:  { type: Boolean, default: false },
  calledAt:  { type: Date },
  calledBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

  isClosed:  { type: Boolean, default: false },
  closedAt:  { type: Date },
  closedBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

  // ── Provenance ───────────────────────────────────────────────────────────
  source:      { type: String, enum: Object.values(ReviewSource), default: ReviewSource.WHATSAPP },
  instance_id: { type: String },          // WhatsApp business instance this came through, if any
  createdBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User' }   // set when source === 'admin'

}, { timestamps: true });

reviewSchema.index({ status: 1, createdAt: -1 });
reviewSchema.index({ concernType: 1 });
reviewSchema.index({ concernFor: 1 });
reviewSchema.index({ displayOnWebsite: 1, status: 1 });
reviewSchema.index({ customerNumber: 1, createdAt: -1 });
reviewSchema.index({ product: 1 });
reviewSchema.index({ isClosed: 1 });

async function syncAllIndexes() {
  const models = [
    { name: 'User', model: User },
    { name: 'Instance', model: Instance },
    { name: 'Contact', model: Contact },
    { name: 'Product', model: Product },
    { name: 'ProductFile', model: File },
    { name: 'Message', model: Message },
    { name: 'Cart', model: Cart },
    { name: 'Purchase', model: Purchase },
    { name: 'Invoice', model: Invoice },
    { name: 'Category', model: Category },
    { name: 'Template', model: Template },
    { name: 'Group', model: Group },
    { name: 'Groupmembers', model: GroupMembers },
    { name: 'CampaignLog', model: CampaignLog },
    { name: 'Wallet', model: Wallet },
    { name: 'CountryPricing', model: CountryPricing },
    { name: 'Discount', model: Discount },
    { name: 'Review', model: Review }
  ];

  console.log('🔄 Starting index synchronization for all models...');
  
  const results = [];
  
  for (const { name, model } of models) {
    try {
      await model.syncIndexes();
      console.log(`✅ ${name}: Indexes synced successfully`);
      results.push({ model: name, status: 'success' });
    } catch (error) {
      console.error(`❌ ${name}: Index sync failed -`, error.message);
      results.push({ model: name, status: 'failed', error: error.message });
    }
  }
  
  // Summary
  const successful = results.filter(r => r.status === 'success').length;
  const failed = results.filter(r => r.status === 'failed').length;
  
  console.log('\n📊 Index Sync Summary:');
  console.log(`   ✅ Successful: ${successful}/${models.length}`);
  console.log(`   ❌ Failed: ${failed}/${models.length}`);
  
  if (failed > 0) {
    console.log('\n⚠️  Failed models:');
    results
      .filter(r => r.status === 'failed')
      .forEach(r => console.log(`   - ${r.model}: ${r.error}`));
  }
  
  return results;
}


// ==================== MODELS ====================
const User = mongoose.model('User', userSchema);
const Instance = mongoose.model('Instance', instanceSchema);
const Contact = mongoose.model('Contact', contactSchema);
const CustomerInfo = mongoose.model('CustomerInfo', customerAddressSchema);

const Product = mongoose.model('Product', productSchema);
const File = mongoose.model('ProductFile', fileSchema);

const Message = mongoose.model('Message', chatSchema);
const ChatLog = mongoose.model('ChatLog', chatLogsSchema);
const Cart = mongoose.model('Cart', cartSchema);
const Purchase = mongoose.model('Purchase', purchaseSchema);
const Invoice = mongoose.model('Invoice', invoiceSchema);
const Category = mongoose.model('Category', categorySchema);

const Template = mongoose.model('Template', TemplateSchema);
const Group = mongoose.model('Group', groupSchema);
const GroupMembers = mongoose.model('Groupmembers', groupMemberSchema);

const CampaignLog = mongoose.model('CampaignLog', campaignLogSchema);
const Wallet = mongoose.model('Wallet', walletSchema);
const CountryPricing = mongoose.model('CountryPricing', countryPricingSchema);

const Discount = mongoose.model('Discount', discountSchema);

const PendingLLMRequest = mongoose.model('PendingLLMRequest', pendingLLMRequestSchema);

const Review = mongoose.model('Review', reviewSchema);

module.exports = {
  User,
  Instance,
  Contact,
  CustomerInfo,
  Product,
  File,
  Message,
  ChatLog,
  Cart,
  Purchase,
  Invoice,
  Category,
  Template,
  Group,
  Wallet,
  CampaignLog,
  CountryPricing,
  GroupMembers,
  MessageStatus,
  CartStatus,
  ProductStatus,
  FileStatus,
  MessageType,
  PaymentStatus,
  Discount,
  PendingLLMRequest,
  Review,
  ReviewStatus,
  ConcernType,
  ConcernForOptions,
  ReviewSource,
  syncAllIndexes
};
