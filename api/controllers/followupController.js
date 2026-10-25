// ==================== controllers/followUpController.js ====================
// Follow-up reminder flow:
//   1. cron -> runFollowUpCycle(): find guests who ghosted us, POST their numbers to the LLM
//   2. LLM  -> POST /api/chat/followupMessage (followUpMessage): we send the text/images via Meta
//              and bump the contact's reminder counter.
const axios = require('axios');
const { Contact, Instance, Message, File, ChatLog, MessageStatus } = require('../models');

// ── Config (all overridable via env) ────────────────────────────────────────
const CFG = {
  MAX_REMINDERS: parseInt(process.env.FOLLOWUP_MAX_REMINDERS || '2', 10),      // total reminders per ghosting
  FIRST_IDLE_HOURS: parseFloat(process.env.FOLLOWUP_FIRST_IDLE_HOURS || '2'),  // silence before 1st reminder
  GAP_HOURS: parseFloat(process.env.FOLLOWUP_GAP_HOURS || '6'),                // gap between reminders
  PENDING_MINUTES: parseInt(process.env.FOLLOWUP_PENDING_MINUTES || '30', 10), // wait for LLM callback
  MAX_FAILS: parseInt(process.env.FOLLOWUP_MAX_FAILS || '3', 10),
  BATCH_SIZE: parseInt(process.env.FOLLOWUP_BATCH_SIZE || '50', 10),           // numbers per LLM call
  LOOKBACK_DAYS: parseInt(process.env.FOLLOWUP_LOOKBACK_DAYS || '2', 10),
  // WhatsApp only allows free-form messages within 24h of the guest's last message
  REQUIRE_24H_WINDOW: (process.env.FOLLOWUP_REQUIRE_24H_WINDOW || 'true') === 'true',
  CALLBACK_SECRET: process.env.FOLLOWUP_CALLBACK_SECRET || ''                  // optional shared secret
};

const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;

const digits = (n) => String(n || '').replace(/\D/g, '');
const numberVariants = (n) => {
  const d = digits(n);
  return [d, `+${d}`];
};

// ─────────────────────────────────────────────────────────────────────────────
// ELIGIBILITY
// A contact qualifies when ALL are true:
//   - not archived / blocked / a business owner
//   - reminderCount < MAX_REMINDERS, not waiting on LLM, not failing repeatedly
//   - the LAST message in the conversation was sent by us (guest hasn't replied)
//   - enough silence (FIRST_IDLE_HOURS for 1st reminder, GAP_HOURS after previous reminder)
//   - (optional) guest's last inbound message is within the 24h WhatsApp window
// Cosmos DB compatible: simple finds + in-memory filtering, no aggregation.
// ─────────────────────────────────────────────────────────────────────────────
const findGhostedContacts = async (instance) => {
  const now = Date.now();
  const ownerNumbers = new Set((instance.businessOwners || []).map(o => digits(o.number)));
  const ourNumber = digits(instance.number);

  const candidates = await Contact.find({
    isArchived: false,
    isBlocked: { $ne: true },
    lastMessageAt: { $gte: new Date(now - CFG.LOOKBACK_DAYS * 24 * HOUR) }
  }).lean();

  // cheap in-memory pre-filter before hitting the Message collection
  const pre = candidates.filter(c => {
    const num = digits(c.number);
    if (!num || num === ourNumber || ownerNumbers.has(num)) return false;

    const count = c.reminderCount || 0;
    if (count >= CFG.MAX_REMINDERS) return false;
    if ((c.reminderFailCount || 0) >= CFG.MAX_FAILS) return false;
    if (c.reminderPendingAt && now - new Date(c.reminderPendingAt).getTime() < CFG.PENDING_MINUTES * MIN) return false;
    if (count > 0 && c.lastReminderAt && now - new Date(c.lastReminderAt).getTime() < CFG.GAP_HOURS * HOUR) return false;
    return true;
  });

  const eligible = [];
  const CHUNK = 10;

  for (let i = 0; i < pre.length; i += CHUNK) {
    const chunk = pre.slice(i, i + CHUNK);
    const checked = await Promise.all(chunk.map(async (c) => {
      try {
        const num = digits(c.number);
        const variants = numberVariants(num);

        const last = await Message.findOne({
          $or: [{ sender: { $in: variants } }, { receiver: { $in: variants } }]
        }).sort({ createdAt: -1 }).select('sender createdAt').lean();

        if (!last) return null;
        if (digits(last.sender) === num) return null;            // guest spoke last -> not ghosted

        const idleMs = now - new Date(last.createdAt).getTime();
        const count = c.reminderCount || 0;
        if (count === 0 && idleMs < CFG.FIRST_IDLE_HOURS * HOUR) return null;

        if (CFG.REQUIRE_24H_WINDOW) {
          const lastInbound = await Message.findOne({ sender: { $in: variants } })
            .sort({ createdAt: -1 }).select('createdAt').lean();
          if (!lastInbound) return null;
          if (now - new Date(lastInbound.createdAt).getTime() > 24 * HOUR) return null;
        }

        return c;
      } catch (err) {
        console.error('[followup] eligibility check failed for', c.number, err.message);
        return null;
      }
    }));
    eligible.push(...checked.filter(Boolean));
  }

  return eligible;
};

// ─────────────────────────────────────────────────────────────────────────────
// CRON ENTRY: find ghosted guests -> send numbers to LLM -> mark them pending
// ─────────────────────────────────────────────────────────────────────────────
const runFollowUpCycle = async ({ dryRun = false } = {}) => {
  const instance = await Instance.findOne({ isActive: true, isDeleted: false }).lean();
  if (!instance) {
    console.log('[followup] no active instance, skipping');
    return { picked: 0, numbers: [], error: 'No active instance' };
  }

  const eligible = await findGhostedContacts(instance);
  if (!eligible.length) {
    console.log('[followup] no ghosted contacts this cycle');
    return { picked: 0, numbers: [] };
  }

  // Dry run: show who WOULD be picked, call nothing, mark nothing
  if (dryRun) {
    return {
      picked: 0,
      dryRun: true,
      eligibleCount: eligible.length,
      numbers: eligible.map(c => `+${digits(c.number)}`)
    };
  }

  const dispatchedNumbers = [];
  let picked = 0;
  for (let i = 0; i < eligible.length; i += CFG.BATCH_SIZE) {
    const batch = eligible.slice(i, i + CFG.BATCH_SIZE);
    const phoneNumbers = batch.map(c => `+${digits(c.number)}`);

    try {
      await axios.post(
        `${process.env.LLM_API}/api/ecommerce/followup_message`,
        { phone_numbers: phoneNumbers },
      );

      // LLM accepted -> mark pending so the next cron tick doesn't re-pick them
      await Contact.updateMany(
        { _id: { $in: batch.map(c => c._id) } },
        { $set: { reminderPendingAt: new Date() } }
      );
      picked += batch.length;
      dispatchedNumbers.push(...phoneNumbers);
      console.log(`[followup] dispatched ${batch.length} number(s) to LLM`);
    } catch (err) {
      console.error('[followup] LLM dispatch failed:', err?.response?.data || err.message);
      // not marked pending -> will be retried on next cron tick
    }
  }

  return { picked, numbers: dispatchedNumbers };
};

// ─────────────────────────────────────────────────────────────────────────────
// @desc    Manually run one follow-up cycle (same logic the cron runs) - for testing
// @route   POST /api/chats/followup/run          (body or query: { dryRun: true })
// @access  Private
// dryRun=true  -> only returns the numbers that would be sent to the LLM
// dryRun=false -> actually sends them to the LLM and marks them pending
// ─────────────────────────────────────────────────────────────────────────────
const triggerFollowUp = async (req, res) => {
  try {
    const raw = req.body?.dryRun ?? req.query?.dryRun;
    const dryRun = raw === true || raw === 'true';

    const result = await runFollowUpCycle({ dryRun });

    return res.status(200).json({
      success: true,
      message: dryRun ? 'Dry run complete (nothing sent)' : 'Follow-up cycle executed',
      data: result
    });
  } catch (error) {
    console.error('triggerFollowUp error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// META SENDER (text / image(s) + caption)
// ─────────────────────────────────────────────────────────────────────────────
const sendFollowUpViaMeta = async ({ instance, to, responseType, text, imageUrls }) => {
  const graphURL = `${process.env.META_API}/${instance.numberId}/messages`;
  const headers = { Authorization: `Bearer ${instance.accessToken}`, 'Content-Type': 'application/json' };
  const sentIds = [];

  const saveMessage = async ({ messageId, text: msgText, type, fileId, raw }) => {
    await Message.create({
      messageId,
      sender: instance.number.toString(),
      receiver: to,
      instance_id: instance._id.toString(),
      text: msgText || '',
      type,
      ...(fileId && { file: fileId }),
      status: [{ status: MessageStatus.SENT, timeStamp: new Date(), metadata: raw }]
    });
  };

  const images = responseType === 'both' && Array.isArray(imageUrls) ? imageUrls.filter(Boolean) : [];

  // images first (caption goes on the last one), like the main LLM reply flow
  for (let i = 0; i < images.length; i++) {
    const url = images[i];
    const isLast = i === images.length - 1;
    const caption = isLast && text ? text : undefined;

    const res = await axios.post(graphURL, {
      messaging_product: 'whatsapp',
      to,
      type: 'image',
      image: { link: url, ...(caption && { caption }) }
    }, { headers });

    const messageId = res.data.messages?.[0]?.id;
    if (messageId) {
      const fileDoc = await File.findOne({ url }).select('_id').lean();
      await saveMessage({ messageId, text: caption, type: 'image', fileId: fileDoc?._id, raw: res.data });
      sentIds.push(messageId);
    }
  }

  // plain text: either text-only response, or "both" with no usable images
  if (!images.length && text) {
    const res = await axios.post(graphURL, {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text }
    }, { headers });

    const messageId = res.data.messages?.[0]?.id;
    if (messageId) {
      await saveMessage({ messageId, text, type: 'text', raw: res.data });
      sentIds.push(messageId);
    }
  }

  return sentIds;
};

// ─────────────────────────────────────────────────────────────────────────────
// @desc    Callback from LLM service with the follow-up message to deliver
// @route   POST /api/chat/followupMessage
// @access  Public (optionally guarded by x-followup-secret header)
// body: { phone_number, status: 'success'|'failed', response_type: 'text'|'both',
//         response, image_urls }
// ─────────────────────────────────────────────────────────────────────────────
const followUpMessage = async (req, res) => {
  try {
    if (CFG.CALLBACK_SECRET && req.headers['x-followup-secret'] !== CFG.CALLBACK_SECRET) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const {
      phone_number,
      status = 'success',
      response_type = 'text',
      response = null,
      image_urls = []
    } = req.body;

    if (!phone_number) {
      return res.status(400).json({ success: false, message: 'phone_number is required' });
    }

    const to = digits(phone_number);
    const variants = numberVariants(to);

    // Atomically claim the pending reminder. This makes duplicate callbacks harmless,
    // and if the guest replied in the meantime the webhook already cleared reminderPendingAt,
    // so we correctly skip sending.
    const contact = await Contact.findOneAndUpdate(
      { number: { $in: variants }, reminderPendingAt: { $ne: null } },
      { $set: { reminderPendingAt: null } },
      { new: false }
    );

    if (!contact) {
      return res.status(200).json({ success: true, message: 'No pending reminder for this number (already handled or guest replied)' });
    }

    if (status !== 'success' || (!response && !(image_urls || []).length)) {
      console.error('[followup] LLM reported failure/empty for', to, req.body);
      await Contact.updateOne({ _id: contact._id }, { $inc: { reminderFailCount: 1 } });
      return res.status(200).json({ success: true, message: 'LLM failure recorded' });
    }

    const instance = await Instance.findOne({ isActive: true, isDeleted: false });
    if (!instance) {
      await Contact.updateOne({ _id: contact._id }, { $inc: { reminderFailCount: 1 } });
      return res.status(404).json({ success: false, message: 'No active WhatsApp instance found' });
    }

    let sentIds = [];
    try {
      sentIds = await sendFollowUpViaMeta({
        instance,
        to: contact.number,
        responseType: response_type,
        text: response,
        imageUrls: image_urls
      });
    } catch (sendErr) {
      console.error('[followup] Meta send failed:', sendErr?.response?.data || sendErr.message);
      await Contact.updateOne({ _id: contact._id }, { $inc: { reminderFailCount: 1 } });
      return res.status(502).json({
        success: false,
        message: sendErr?.response?.data?.error?.message || sendErr.message
      });
    }

    if (!sentIds.length) {
      await Contact.updateOne({ _id: contact._id }, { $inc: { reminderFailCount: 1 } });
      return res.status(502).json({ success: false, message: 'Meta did not return a message id' });
    }

    // Success: reminder 0 -> 1 (-> 2 ...). findOneAndUpdate/updateOne with timestamps also bumps updatedAt.
    const now = new Date();
    const updated = await Contact.findOneAndUpdate(
      { _id: contact._id },
      {
        $inc: { reminderCount: 1 },
        $set: { lastReminderAt: now, lastMessageAt: now, reminderFailCount: 0, reminderPendingAt: null }
      },
      { new: true }
    );

    ChatLog.create({
      sender: instance.number.toString(),
      receiver: contact.number,
      instance_id: instance._id.toString(),
      action: 'sent',
      metadata: { source: 'followup-reminder', reminderNumber: updated.reminderCount, messageIds: sentIds }
    }).catch(e => console.error('[followup] ChatLog failed:', e.message));

    return res.status(200).json({
      success: true,
      message: 'Follow-up sent',
      data: { phone_number: contact.number, reminderCount: updated.reminderCount, messageIds: sentIds }
    });
  } catch (error) {
    console.error('followUpMessage error:', error?.response?.data || error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = { runFollowUpCycle, findGhostedContacts, followUpMessage, triggerFollowUp };