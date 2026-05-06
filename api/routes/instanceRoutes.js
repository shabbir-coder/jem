    const express = require('express');
    const router = express.Router();
    const { body } = require('express-validator');
    const validate = require('../middlewares/validator');
    const { protect } = require('../middlewares/auth');
    const { getInstance, updateInstance
    } = require('../controllers/instanceController');

    // Validation rules
    const instanceValidation = [
    body('accessToken').notEmpty().withMessage('access token is required'),
    body('numberId').notEmpty().withMessage('Number ID is required'),
    body('businessId').notEmpty().withMessage('Business ID is required'),
    body('name').notEmpty().withMessage('Name is required'),
    body('number').notEmpty().withMessage('Number is required'),
    validate
    ];

    // Routes
    router.route('/')
    .get(protect, getInstance)
    .post(protect, instanceValidation, updateInstance);

    module.exports = router;