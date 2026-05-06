const { Instance } = require('../models');

/**
 * @desc    Get instance for logged-in user
 * @route   GET /api/instance
 * @access  Private
 */
exports.getInstance = async (req, res) => {
  try {
    const instance = await Instance.findOne({
      createdBy: req.user._id,
      isDeleted: false,
    });

    if (!instance) {
      return res.status(404).json({
        success: false,
        message: 'Instance not found',
      });
    }

    res.status(200).json({
      success: true,
      data: instance,
    });
  } catch (error) {
    console.error('Get Instance Error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while fetching instance',
    });
  }
};

/**
 * @desc    Create or Update instance
 * @route   POST /api/instance
 * @access  Private
 */
exports.updateInstance = async (req, res) => {
  try {
    const {
      accessToken,
      numberId,
      businessId,
      number,
      name,
      isActive,
      isVerified,
      lastScannedAt,
      businessOwners
    } = req.body;

    let instance = await Instance.findOne({
      createdBy: req.user._id,
      isDeleted: false,
    });

    if (instance) {
      // Update existing instance
      instance.accessToken = accessToken;
      instance.numberId = numberId;
      instance.businessId = businessId;
      instance.number = number;
      instance.name = name;
      instance.isActive = isActive ?? instance.isActive;
      instance.isVerified = isVerified ?? instance.isVerified;
      instance.lastScannedAt = lastScannedAt ?? instance.lastScannedAt;
      instance.businessOwners = businessOwners ?? instance.businessOwners;
      instance.updatedAt = new Date();

      await instance.save();

      return res.status(200).json({
        success: true,
        message: 'Instance updated successfully',
        data: instance,
      });
    }

    // Create new instance
    instance = await Instance.create({
      accessToken,
      numberId,
      businessId,
      number,
      businessOwners,
      name,
      createdBy: req.user._id,
      isActive: isActive ?? false,
      isVerified: isVerified ?? false,
      lastScannedAt,
    });

    res.status(201).json({
      success: true,
      message: 'Instance created successfully',
      data: instance,
    });
  } catch (error) {
    console.error('Update Instance Error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while saving instance',
    });
  }
};
