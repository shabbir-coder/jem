const express = require('express');
const router = express.Router();
const {
  getProducts,
  getProduct,
  getCategories
} = require('../controllers/productController');

const { messageToOwner,messageToOwnerTemplate  } = require('../controllers/chatController')

// Routes
router.route('/products')
  .get(getProducts)
  
router.get('/categories', getCategories);

router.route('/:id')
  .get(getProduct)
  
router.route('/messageToOwner')
  .post(messageToOwnerTemplate)
  
module.exports = router;