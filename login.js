'use strict';

// Run this when Tebra session expires:
// node login.js
//
// A browser opens — log into Tebra manually, then close the window.
// Bridge will use the saved session automatically.

const { chromium } = require('playwright');
const path = require('path');
const os = require('os');

const PROFILE_DIR = path.join(
  os.homedir(), 'AppData', 'Local', 'ChrysalisBridge', 'TebraProfile'
);

(async () => {
  console.log('Opening browser for Tebra login...');
  console.log('Log in to Tebra, then CLOSE the browser window when done.');
  console.log('');

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 900 },
  });

  const page = await context.newPage();
  await page.goto('https://app.kareo.com');

  // Wait until user closes the browser
  await new Promise(resolve => {
    context.on('close', resolve);
    page.on('close', resolve);
  });

  console.log('Session saved. You can now restart Bridge with: npm start');
  process.exit(0);
})();
