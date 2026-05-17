process.env.PLAYWRIGHT_BROWSERS_PATH = '/home/site/wwwroot/ms-playwright';

const { chromium } = require('playwright');

let browserInstance = null;

async function getBrowser() {

  try {

    // Reuse existing browser instance
    if (browserInstance) {
      return browserInstance;
    }

    browserInstance = await chromium.launch({

      headless: true,

      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage'
      ]
    });

    console.log('✅ Playwright browser launched');

    browserInstance.on('disconnected', () => {

      console.log('⚠️ Browser disconnected');

      browserInstance = null;
    });

    return browserInstance;

  } catch (error) {

    console.error('❌ Browser launch error:', error);

    browserInstance = null;

    throw error;
  }
}

module.exports = {
  getBrowser
};