const puppeteer = require('puppeteer');

let browserInstance = null;

async function getBrowser() {
  try {
    // Reuse browser if already connected
    if (browserInstance && browserInstance.connected) {
      return browserInstance;
    }

    browserInstance = await puppeteer.launch({
      headless: true,

      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote'
      ],

      timeout: 60000
    });

    browserInstance.on('disconnected', () => {
      console.log('⚠️ Puppeteer browser disconnected');
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