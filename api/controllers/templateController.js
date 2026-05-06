// ==================== controllers/templateController.js ====================
const axios = require('axios');
const { Template, Instance } = require('../models');

// ─────────────────────────────────────────────────────────────────
// HELPER: fetch the active instance (needed for Meta API calls)
// ─────────────────────────────────────────────────────────────────
const getActiveInstance = async () => {
  const instance = await Instance.findOne({ isActive: true, isDeleted: false }).sort({ updatedAt: -1 });
  if (!instance) throw new Error('No active WhatsApp instance found');
  return instance;
};

// ─────────────────────────────────────────────────────────────────
// HELPER: map a single Meta template object → our DB shape
// ─────────────────────────────────────────────────────────────────
const metaTemplateToDb = (mt) => {
  // Extract body text from components
  const bodyComponent = (mt.components || []).find(c => c.type === 'BODY');
  const headerComponent = (mt.components || []).find(c => c.type === 'HEADER');

  const templateText = bodyComponent?.text || '';

  // Build parameters list from body variables {{1}}, {{2}} …
  const matches = templateText.match(/\{\{(\d+)\}\}/g) || [];
  const parameters = matches.map(m => {
    const key = m.replace(/[{}]/g, '');
    return { key, bindValue: '' };   // bindValue filled by user later
  });

  // Media from header
  let mediaUrl = '';
  let mediaType = '';
  let mediaMime = '';
  if (headerComponent?.format === 'IMAGE') { mediaType = 'image'; }
  if (headerComponent?.format === 'VIDEO') { mediaType = 'video'; }
  if (headerComponent?.format === 'DOCUMENT') { mediaType = 'document'; }
  if (headerComponent?.example?.header_handle?.[0]) {
    mediaUrl = headerComponent.example.header_handle[0];
  }

  return {
    name: mt.name,
    templateName: mt.name,
    category: (mt.category || 'MARKETING').toLowerCase(),
    languageCode: mt.language || 'en',
    templateText,
    parameters,
    mediaUrl,
    mediaType,
    mediaMime,
    metaTemplateId: mt.id,
    metaStatus: mt.status || 'PENDING',
    metaSyncedAt: new Date()
  };
};

// ─────────────────────────────────────────────────────────────────
// HELPER: upsert a batch of Meta templates into MongoDB
// ─────────────────────────────────────────────────────────────────
const upsertMetaTemplates = async (metaTemplates) => {
  const ops = metaTemplates.map(mt => ({
    updateOne: {
      filter: { metaTemplateId: mt.id },
      update: { $set: metaTemplateToDb(mt) },
      upsert: true
    }
  }));
  if (ops.length) await Template.bulkWrite(ops, { ordered: false });
};

// ─────────────────────────────────────────────────────────────────
// HELPER: fetch ALL templates from Meta (handles pagination)
// ─────────────────────────────────────────────────────────────────
const fetchAllMetaTemplates = async (instance) => {
  const allTemplates = [];
  let url = `${process.env.META_API}/${instance.businessId}/message_templates?limit=100`;

  while (url) {
    const res = await axios.get(url, {
      headers: { Authorization: `Bearer ${instance.accessToken}` }
    });
    allTemplates.push(...(res.data.data || []));
    url = res.data.paging?.next || null;
  }

  return allTemplates;
};

// =================================================================
// @desc  Sync all Meta templates → local DB
// @route POST /api/templates/sync
// @access Private
// =================================================================
exports.syncTemplatesFromMeta = async (req, res) => {
  try {
    const instance = await getActiveInstance();
    const metaTemplates = await fetchAllMetaTemplates(instance);

    await upsertMetaTemplates(metaTemplates);

    // Mark deleted on Meta as DELETED locally
    const metaIds = metaTemplates.map(t => t.id);
    await Template.updateMany(
      { metaTemplateId: { $exists: true, $nin: metaIds } },
      { $set: { metaStatus: 'DELETED' } }
    );

    res.json({
      success: true,
      message: `Synced ${metaTemplates.length} templates from Meta`,
      synced: metaTemplates.length
    });
  } catch (error) {
    console.error('syncTemplatesFromMeta error:', error?.response?.data || error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// =================================================================
// @desc  Get all templates (local DB, with optional Meta sync)
// @route GET /api/templates
// @access Private
// =================================================================
exports.getAllTemplates = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 50,
      category,
      languageCode,
      instanceId,
      syncMeta = 'false'      // pass ?syncMeta=true to force a fresh pull
    } = req.query;

    // Optional live sync before returning
    if (syncMeta === 'true') {
      try {
        const instance = await getActiveInstance();
        const metaTemplates = await fetchAllMetaTemplates(instance);
        await upsertMetaTemplates(metaTemplates);
      } catch (syncErr) {
        console.warn('Background Meta sync failed:', syncErr.message);
        // Don't fail the whole request — serve what we have
      }
    }

    const filter = {};
    if (category) filter.category = category;
    if (languageCode) filter.languageCode = languageCode;
    if (instanceId) filter.instanceId = instanceId;

    // Exclude Meta-deleted templates from normal listing
    filter.metaStatus = { $ne: 'DELETED' };

    const skip = (Number(page) - 1) * Number(limit);

    const [templates, total] = await Promise.all([
      Template.find(filter).sort({ createdAt: -1 }).skip(skip).limit(Number(limit)),
      Template.countDocuments(filter)
    ]);

    res.status(200).json({
      success: true,
      data: templates,
      pagination: {
        total,
        page: Number(page),
        pages: Math.ceil(total / Number(limit)),
        limit: Number(limit)
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error fetching templates', error: error.message });
  }
};

// =================================================================
// @desc  Get template by ID
// @route GET /api/templates/:id
// @access Private
// =================================================================
exports.getTemplateById = async (req, res) => {
  try {
    const template = await Template.findById(req.params.id);
    if (!template) return res.status(404).json({ success: false, message: 'Template not found' });
    res.status(200).json({ success: true, data: template });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error fetching template', error: error.message });
  }
};

// =================================================================
// @desc  Create template — saves locally AND submits to Meta
// @route POST /api/templates
// @access Private
// =================================================================
exports.createTemplate = async (req, res) => {
  try {
    const {
      name,
      templateName,
      category = 'MARKETING',
      languageCode = 'en',
      templateText,
      parameters = [],
      mediaUrl,
      mediaType,
      mediaMime,
      description
    } = req.body;

    // ── 1. Build Meta API payload ──────────────────────────────────────────
    const components = [];

    // Header (media)
    if (mediaType && mediaUrl) {
      components.push({
        type: 'HEADER',
        format: mediaType.toUpperCase(),
        example: { header_handle: [mediaUrl] }
      });
    }

    // Body with example values
    if (templateText) {
      const bodyComp = { type: 'BODY', text: templateText };
      if (parameters.length) {
        bodyComp.example = {
          body_text: [parameters.map((_, i) => `example${i + 1}`)]
        };
      }
      components.push(bodyComp);
    }

    const metaPayload = {
      name: templateName || name,
      category: category.toUpperCase(),
      language: languageCode,
      components
    };

    // ── 2. Submit to Meta ──────────────────────────────────────────────────
    let metaTemplateId = null;
    let metaStatus = 'PENDING';

    try {
      const instance = await getActiveInstance();
      const metaRes = await axios.post(
        `${process.env.META_API}/${instance.businessId}/message_templates`,
        metaPayload,
        { headers: { Authorization: `Bearer ${instance.accessToken}`, 'Content-Type': 'application/json' } }
      );
      metaTemplateId = metaRes.data?.id || null;
      metaStatus = metaRes.data?.status || 'PENDING';
      console.log('✅ Template submitted to Meta:', metaTemplateId);
    } catch (metaErr) {
      const metaError = metaErr?.response?.data?.error;
      console.warn('⚠️ Meta template submission failed:', metaError?.message || metaErr.message);
      // Save locally even if Meta fails
    }

    // ── 3. Save to MongoDB ─────────────────────────────────────────────────
    const template = await Template.create({
      name,
      templateName: templateName || name,
      category: category.toLowerCase(),
      languageCode,
      templateText,
      parameters,
      mediaUrl,
      mediaType,
      mediaMime,
      description,
      metaTemplateId,
      metaStatus,
      metaSyncedAt: new Date()
    });

    res.status(201).json({
      success: true,
      message: metaTemplateId
        ? 'Template created and submitted to Meta for approval'
        : 'Template saved locally (Meta submission failed — check logs)',
      data: template
    });
  } catch (error) {
    res.status(400).json({ success: false, message: 'Error creating template', error: error.message });
  }
};

// =================================================================
// @desc  Update template — updates locally, re-submits to Meta if text changed
// @route PUT /api/templates/:id
// @access Private
// =================================================================
exports.updateTemplate = async (req, res) => {
  try {
    const existing = await Template.findById(req.params.id);
    if (!existing) return res.status(404).json({ success: false, message: 'Template not found' });

    const {
      name, templateName, category, languageCode,
      templateText, parameters, mediaUrl, mediaType, mediaMime, description
    } = req.body;

    const textChanged = templateText && templateText !== existing.templateText;
    let metaStatus = existing.metaStatus;

    // ── Re-submit to Meta only if content changed ──────────────────────────
    if (textChanged || (category && category !== existing.category)) {
      try {
        const instance = await getActiveInstance();

        // Meta doesn't allow editing approved templates — delete + recreate
        if (existing.metaTemplateId) {
          await axios.delete(
            `${process.env.META_API}/${instance.businessId}/message_templates?name=${existing.templateName}`,
            { headers: { Authorization: `Bearer ${instance.accessToken}` } }
          ).catch(() => {}); // ignore delete errors
        }

        const components = [];
        if (mediaType && mediaUrl) {
          components.push({ type: 'HEADER', format: (mediaType || existing.mediaType).toUpperCase(), example: { header_handle: [mediaUrl || existing.mediaUrl] } });
        }
        if (templateText) {
          const bodyComp = { type: 'BODY', text: templateText };
          const params = parameters || existing.parameters;
          if (params?.length) bodyComp.example = { body_text: [params.map((_, i) => `example${i + 1}`)] };
          components.push(bodyComp);
        }

        const metaRes = await axios.post(
          `${process.env.META_API}/${instance.businessId}/message_templates`,
          {
            name: templateName || existing.templateName,
            category: (category || existing.category).toUpperCase(),
            language: languageCode || existing.languageCode,
            components
          },
          { headers: { Authorization: `Bearer ${instance.accessToken}`, 'Content-Type': 'application/json' } }
        );

        metaStatus = metaRes.data?.status || 'PENDING';
        req.body.metaTemplateId = metaRes.data?.id || existing.metaTemplateId;
        console.log('✅ Template re-submitted to Meta');
      } catch (metaErr) {
        console.warn('⚠️ Meta re-submission failed:', metaErr?.response?.data?.error?.message || metaErr.message);
      }
    }

    const updated = await Template.findByIdAndUpdate(
      req.params.id,
      { ...req.body, metaStatus, metaSyncedAt: new Date() },
      { new: true, runValidators: true }
    );

    res.status(200).json({ success: true, message: 'Template updated successfully', data: updated });
  } catch (error) {
    res.status(400).json({ success: false, message: 'Error updating template', error: error.message });
  }
};

// =================================================================
// @desc  Delete template — removes from Meta + local DB
// @route DELETE /api/templates/:id
// @access Private
// =================================================================
exports.deleteTemplate = async (req, res) => {
  try {
    const template = await Template.findById(req.params.id);
    if (!template) return res.status(404).json({ success: false, message: 'Template not found' });

    // Delete from Meta
    if (template.metaTemplateId) {
      try {
        const instance = await getActiveInstance();
        await axios.delete(
          `${process.env.META_API}/${instance.businessId}/message_templates?name=${template.templateName}`,
          { headers: { Authorization: `Bearer ${instance.accessToken}` } }
        );
        console.log(`✅ Deleted template "${template.templateName}" from Meta`);
      } catch (metaErr) {
        console.warn('⚠️ Meta delete failed:', metaErr?.response?.data?.error?.message || metaErr.message);
      }
    }

    await Template.findByIdAndDelete(req.params.id);

    res.status(200).json({ success: true, message: 'Template deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error deleting template', error: error.message });
  }
};

// =================================================================
// @desc  Webhook handler — Meta calls this when a template status changes
//        Register this URL in Meta App Dashboard → Webhooks → message_template_status_update
// @route POST /api/templates/webhook
// @access Public
// =================================================================
exports.handleMetaTemplateWebhook = async (req, res) => {
  try {
    res.sendStatus(200); // Acknowledge immediately

    const entry = req.body?.entry?.[0];
    const changes = entry?.changes || [];

    for (const change of changes) {
      if (change.field !== 'message_template_status_update') continue;

      const { message_template_id, message_template_name, event } = change.value || {};

      if (message_template_id) {
        await Template.findOneAndUpdate(
          { metaTemplateId: String(message_template_id) },
          {
            $set: {
              metaStatus: event || 'PENDING',
              metaSyncedAt: new Date()
            }
          }
        );
        console.log(`📋 Template "${message_template_name}" status → ${event}`);
      }
    }
  } catch (error) {
    console.error('handleMetaTemplateWebhook error:', error);
  }
};