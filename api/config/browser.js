const { chromium } = require('playwright');

let browserInstance = null;

async function getBrowser() {

  try {

    if (browserInstance) {
      return browserInstance;
    }

    browserInstance = await chromium.launch({
      headless: true
    });

    browserInstance.on('disconnected', () => {
      browserInstance = null;
    });

    console.log('✅ Playwright browser launched');

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