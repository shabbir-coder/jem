const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

let browserInstance = null;

async function getBrowser() {
  try {

    if (browserInstance?.connected) {
      return browserInstance;
    }

    const executablePath = await chromium.executablePath();

    browserInstance = await puppeteer.launch({
      executablePath,

      headless: chromium.headless,

      defaultViewport: chromium.defaultViewport,

      args: [
        ...chromium.args,
        '--no-sandbox',
        '--disable-setuid-sandbox'
      ]
    });

    console.log('✅ Browser launched');

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