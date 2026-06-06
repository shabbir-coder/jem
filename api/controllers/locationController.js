// ==================== controllers/locationController.js ====================
// Locations are derived from unique city/state combos in the Contact collection,
// plus a separate Location model for manually-added entries.

const mongoose = require('mongoose');
const { Contact } = require('../models');

// ── inline Location model (add to models/index.js exports too) ────────────────
const locationSchema = new mongoose.Schema({
  name:     { type: String, required: true, trim: true },
  pincode:  { type: String, trim: true, default: '' },
  city:     { type: String, trim: true, default: '' },
  state:    { type: String, trim: true, default: '' },
  country:  { type: String, trim: true, default: 'India' },
  type:     { type: String, enum: ['city', 'state', 'region', 'pincode', 'custom'], default: 'city' },
  isCustom: { type: Boolean, default: false },   // true = manually added by admin
  createdBy:{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

locationSchema.index({ name: 1 });
locationSchema.index({ state: 1 });
locationSchema.index({ pincode: 1 });

// Use mongoose.models to avoid re-compile errors in hot-reload environments
const Location = mongoose.models.Location || mongoose.model('Location', locationSchema);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/locations
// Returns merged list: unique city/state entries from Contact + saved Location docs
// Query params: ?search=  ?type=city|state|...  ?page=1  ?limit=50
// ─────────────────────────────────────────────────────────────────────────────
exports.getLocations = async (req, res) => {
  try {
    const { search = '', type, page = 1, limit = 100 } = req.query;
    const pageNum  = parseInt(page,  10);
    const limitNum = parseInt(limit, 10);

    // ── 1. Pull distinct city+state combos from Contact collection ────────────
    const contactPipeline = [
      {
        $match: {
          $or: [
            { city:  { $exists: true, $ne: '' } },
            { state: { $exists: true, $ne: '' } }
          ]
        }
      },
      {
        $group: {
          _id: { city: '$city', state: '$state' },
          pincode: { $first: '$pinCode' },
          count:   { $sum: 1 }
        }
      },
      {
        $project: {
          _id:    0,
          name:   { $ifNull: ['$_id.city', '$_id.state'] },
          city:   '$_id.city',
          state:  '$_id.state',
          pincode:'$pincode',
          type:   'city',
          source: 'contact'
        }
      }
    ];

    const [contactLocations, savedLocations] = await Promise.all([
      Contact.aggregate(contactPipeline),
      Location.find().lean()
    ]);

    // ── 2. Merge, de-duplicate by normalised name ─────────────────────────────
    const seen   = new Set();
    const merged = [];

    // Saved (manual) locations take priority
    for (const loc of savedLocations) {
      const key = loc.name.toLowerCase().trim();
      if (!seen.has(key)) {
        seen.add(key);
        merged.push({
          id:       loc._id.toString(),
          name:     loc.name,
          city:     loc.city  || loc.name,
          state:    loc.state || '',
          pincode:  loc.pincode || '',
          type:     loc.type || 'city',
          country:  loc.country || 'India',
          isCustom: loc.isCustom ?? false,
          source:   'saved'
        });
      }
    }

    // Then contact-derived locations
    for (const loc of contactLocations) {
      if (!loc.name) continue;
      const key = loc.name.toLowerCase().trim();
      if (!seen.has(key)) {
        seen.add(key);
        merged.push({
          id:       `contact_${key.replace(/\s+/g, '_')}`,
          name:     loc.name,
          city:     loc.city  || '',
          state:    loc.state || '',
          pincode:  loc.pincode || '',
          type:     'city',
          country:  'India',
          isCustom: false,
          source:   'contact'
        });
      }
    }

    // ── 3. Filter ─────────────────────────────────────────────────────────────
    let filtered = merged;

    if (search) {
      const term = search.toLowerCase();
      filtered = merged.filter(l =>
        l.name.toLowerCase().includes(term)    ||
        l.state.toLowerCase().includes(term)   ||
        l.pincode.includes(term)               ||
        l.city.toLowerCase().includes(term)
      );
    }

    if (type) {
      filtered = filtered.filter(l => l.type === type);
    }

    // ── 4. Paginate ───────────────────────────────────────────────────────────
    const total  = filtered.length;
    const paged  = filtered.slice((pageNum - 1) * limitNum, pageNum * limitNum);

    return res.json({
      success: true,
      data: paged,
      pagination: {
        page:  pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum)
      }
    });
  } catch (error) {
    console.error('getLocations error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/locations
// Manually add a location that doesn't exist in the Contact collection
// Body: { name, city, state, pincode, type, country }
// ─────────────────────────────────────────────────────────────────────────────
exports.createLocation = async (req, res) => {
  try {
    const { name, city, state, pincode, type = 'city', country = 'India' } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: 'Location name is required.' });
    }

    // Check for duplicate
    const existing = await Location.findOne({ name: new RegExp(`^${name.trim()}$`, 'i') });
    if (existing) {
      return res.status(400).json({ success: false, message: `Location "${name}" already exists.` });
    }

    const loc = await Location.create({
      name:      name.trim(),
      city:      city    || name.trim(),
      state:     state   || '',
      pincode:   pincode || '',
      type,
      country,
      isCustom:  true,
      createdBy: req.user?._id
    });

    return res.status(201).json({
      success: true,
      message: 'Location created successfully.',
      data: {
        id:       loc._id.toString(),
        name:     loc.name,
        city:     loc.city,
        state:    loc.state,
        pincode:  loc.pincode,
        type:     loc.type,
        country:  loc.country,
        isCustom: true
      }
    });
  } catch (error) {
    console.error('createLocation error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/locations/:id   (only custom / saved locations can be deleted)
// ─────────────────────────────────────────────────────────────────────────────
exports.deleteLocation = async (req, res) => {
  try {
    const loc = await Location.findByIdAndDelete(req.params.id);
    if (!loc) {
      return res.status(404).json({ success: false, message: 'Location not found.' });
    }
    return res.json({ success: true, message: 'Location deleted.' });
  } catch (error) {
    console.error('deleteLocation error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Export the model so it can be registered in models/index.js
exports.Location = Location;