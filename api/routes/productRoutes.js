const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const validate = require('../middlewares/validator');
const { protect } = require('../middlewares/auth');
const { uploadMultiple, handleUploadError } = require('../middlewares/upload');
const {
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
} = require('../controllers/productController');

const { sendtoowner } = require('../controllers/chatController')

// Validation rules
const productValidation = [
  body('productName').notEmpty().withMessage('Product name is required'),
  body('categoryId').notEmpty().withMessage('Category ID is required'),
  body('categoryName').notEmpty().withMessage('Category name is required'),
  body('price').notEmpty().withMessage('Price is required'),
  validate
];

// Routes
router.route('/')
  .get(protect, getProducts)
  .post(protect, uploadMultiple, handleUploadError, createProduct);

router.get('/categories/list', protect, getCategories);
router.post("/categories", protect, createCategory);
router.put("/categories/:id", protect, updateCategory);
router.delete("/categories/:id", protect, deleteCategory);

router.route('/:id')
  .get(protect, getProduct)
  .put(protect, uploadMultiple, handleUploadError, updateProduct)
  .delete(protect, deleteProduct);
  
  
router.post('/listPurchases', protect, listPurchases)

router.post('/updateOrderStatus' , protect, updateOrderStatus)
router.post('/invoice/:purchaseId/send-to-owner' , protect, sendtoowner)


  

module.exports = router;