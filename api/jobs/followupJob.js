// ==================== jobs/followUpJob.js ====================
const cron = require('node-cron');
const { runFollowUpCycle } = require('../controllers/followupController');

let isRunning = false; // prevents overlapping runs if one cycle is slow

const startFollowUpJob = () => {
  const schedule = process.env.FOLLOWUP_CRON || '0 * * * *'; // every 1 hour

  cron.schedule(
    schedule,
    async () => {
      if (isRunning) {
        console.log('[followup-cron] previous run still active, skipping');
        return;
      }
      isRunning = true;
      try {
        const { picked } = await runFollowUpCycle();
        console.log(`[followup-cron] done, picked ${picked}`);
      } catch (err) {
        console.error('[followup-cron] failed:', err.message);
      } finally {
        isRunning = false;
      }
    },
    { timezone: 'Asia/Kolkata' }
  );

  console.log(`[followup-cron] scheduled: ${schedule}`);
};

module.exports = { startFollowUpJob };