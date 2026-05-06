// ==================== controllers/fileController.js ====================
const { File } = require('../models');
const fs = require('fs');
const path = require('path');

// @desc    Upload file
// @route   POST /api/files/upload
// @access  Private
const uploadFile = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No file uploaded'
      });
    }

    const { entityType, entityId, altText, caption } = req.body;

    const fileType = req.file.mimetype.startsWith('image/') ? 'image' : 
                    req.file.mimetype.startsWith('video/') ? 'video' :
                    req.file.mimetype.startsWith('audio/') ? 'audio' : 'document';

    const file = await File.create({
      fileName: req.file.filename,
      originalName: req.file.originalname,
      fileType: fileType,
      mimeType: req.file.mimetype,
      fileSize: req.file.size,
      url: `${req.protocol}://${req.get('host')}/uploads/products/${req.file.filename}`,
      path: `/uploads/products/${req.file.filename}`,
      altText: altText || '',
      caption: caption || '',
      uploadedBy: req.user._id,
      entityType: entityType || 'other',
      entityId: entityId || null
    });

    res.status(201).json({
      success: true,
      message: 'File uploaded successfully',
      data: file
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// @desc    Get file by ID
// @route   GET /api/files/:id
// @access  Private
const getFile = async (req, res) => {
  try {
    const file = await File.findById(req.params.id);

    if (!file) {
      return res.status(404).json({
        success: false,
        message: 'File not found'
      });
    }

    res.json({
      success: true,
      data: file
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// @desc    Get files by entity
// @route   GET /api/files/entity/:entityType/:entityId
// @access  Private
const getFilesByEntity = async (req, res) => {
  try {
    const { entityType, entityId } = req.params;

    const files = await File.find({
      entityType,
      entityId,
      status: 'active'
    }).sort({ createdAt: -1 });

    res.json({
      success: true,
      data: files
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// @desc    Update file metadata
// @route   PUT /api/files/:id
// @access  Private
const updateFile = async (req, res) => {
  try {
    const file = await File.findById(req.params.id);

    if (!file) {
      return res.status(404).json({
        success: false,
        message: 'File not found'
      });
    }

    const { altText, caption, status } = req.body;

    if (altText) file.altText = altText;
    if (caption) file.caption = caption;
    if (status) file.status = status;

    const updatedFile = await file.save();

    res.json({
      success: true,
      message: 'File updated successfully',
      data: updatedFile
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// @desc    Delete file
// @route   DELETE /api/files/:id
// @access  Private
const deleteFile = async (req, res) => {
  try {
    const file = await File.findById(req.params.id);

    if (!file) {
      return res.status(404).json({
        success: false,
        message: 'File not found'
      });
    }

    // Soft delete - mark as deleted
    file.status = 'deleted';
    await file.save();

    // Optional: Actually delete the file from filesystem
    // const filePath = path.join(__dirname, '..', file.path);
    // if (fs.existsSync(filePath)) {
    //   fs.unlinkSync(filePath);
    // }

    res.json({
      success: true,
      message: 'File deleted successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// @desc    Get all files with pagination
// @route   GET /api/files
// @access  Private
const getFiles = async (req, res) => {
  try {
    const {
      entityType,
      fileType,
      page = 1,
      limit = 20
    } = req.query;

    const query = { status: 'active' };

    if (entityType) query.entityType = entityType;
    if (fileType) query.fileType = fileType;

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const files = await File.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .populate('uploadedBy', 'name email');

    const total = await File.countDocuments(query);

    res.json({
      success: true,
      data: files,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

module.exports = {
  uploadFile,
  getFile,
  getFilesByEntity,
  updateFile,
  deleteFile,
  getFiles
};