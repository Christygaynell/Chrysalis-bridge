'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, dialog } = require('electron');
const path   = require('path');
const bridge = require('./bridge');
const creds  = require('./credentials');

// ── Single instance lock ───────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

let tray          = null;
let settingsWin   = null;
let logWin        = null;
let bridgeRunning = false;
let currentStatus = 'stopped';
let logEntries    = [];

// ── Tray icon helpers ──────────────────────────────────────────
function getTrayIcon(status) {
  // Use a simple colored square as tray icon
  // TODO: replace with real branded .ico/.png once final icon is designed
  // (silver/blue butterfly, per Chrysalis branding direction)
  const size = 16;
  const canvas = Buffer.alloc(size * size * 4);

  let r, g, b;
  switch(status) {
    case 'idle':    r=79;  g=209; b=197; break; // Chrysalis teal
    case 'posting': r=246; g=173; b=85;  break; // amber
    case 'error':   r=252; g=129; b=129; break; // red
    default:        r=100; g=100; b=100; break; // gray
  }

  for (let i = 0; i < size * size; i++) {
    canvas[i * 4 + 0] = r;
    canvas[i * 4 + 1] = g;
    canvas[i * 4 + 2] = b;
    canvas[i * 4 + 3] = 255;
  }

  return nativeImage.createFromBuffer(canvas, { width: size, height: size });
}

function updateTray(status) {
  currentStatus = status;
  if (!tray) return;

  tray.setImage(getTrayIcon(status));

  const statusLabels = {
    idle:     '● Idle — watching for notes',
    checking: '◎ Checking for notes…',
    posting:  '⟳ Posting to Tebra…',
    error:    '✗ Error — check logs',
    stopped:  '○ Stopped',
  };

  tray.setToolTip('Chrysalis Bridge — ' + (statusLabels[status] || status));
  buildTrayMenu();
}

function buildTrayMenu() {
  const statusLabels = {
    idle:     'Idle — watching for notes',
    checking: 'Checking for notes…',
    posting:  'Posting to Tebra…',
    error:    'Error — check logs',
    stopped:  'Stopped',
  };

  const menu = Menu.buildFromTemplate([
    {
      label: '🦋 Chrysalis Bridge',
      enabled: false,
    },
    {
      label: (statusLabels[currentStatus] || currentStatus),
      enabled: false,
    },
    { type: 'separator' },
    {
      label: bridgeRunning ? '⏸ Pause Bridge' : '▶ Start Bridge',
      click: () => {
        if (bridgeRunning) stopBridge();
        else startBridge();
      },
    },
    {
      label: '🔄 Check Now',
      enabled: bridgeRunning,
      click: () => bridge.pollNow(),
    },
    {
      label: '📅 Sync Today\'s Patients',
      enabled: bridgeRunning,
      click: async () => {
        log('Manual calendar sync triggered from tray');
        await bridge.syncPatients();
      },
    },
    { type: 'separator' },
    {
      label: '⚙ Settings',
      click: openSettings,
    },
    {
      label: '📋 View Log',
      click: openLog,
    },
    { type: 'separator' },
    {
      label: 'Quit Bridge',
      click: () => {
        bridge.stop();
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(menu);
}

// ── Bridge control ─────────────────────────────────────────────
function startBridge() {
  if (!creds.isSetupComplete()) {
    openSettings();
    dialog.showMessageBox({
      type: 'info',
      title: 'Setup Required',
      message: 'Please enter your Chrysalis and Tebra credentials to start Bridge.',
    });
    return;
  }

  bridgeRunning = true;
  updateTray('idle');

  bridge.start({
    onLog: (entry) => {
      logEntries.push(entry);
      // Keep last 500 entries
      if (logEntries.length > 500) logEntries.shift();
      // Push to log window if open
      if (logWin && !logWin.isDestroyed()) {
        logWin.webContents.send('log-entry', entry);
      }
    },
    onStatus: (status) => {
      updateTray(status);
    },
  });
}

function stopBridge() {
  bridgeRunning = false;
  bridge.stop();
  updateTray('stopped');
}

// ── Settings window ────────────────────────────────────────────
function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.focus();
    return;
  }

  settingsWin = new BrowserWindow({
    width: 480,
    height: 560,
    title: 'Chrysalis Bridge — Settings',
    resizable: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  settingsWin.loadFile('settings.html');
  settingsWin.setMenu(null);
}

// ── Log window ─────────────────────────────────────────────────
function openLog() {
  if (logWin && !logWin.isDestroyed()) {
    logWin.focus();
    return;
  }

  logWin = new BrowserWindow({
    width: 700,
    height: 480,
    title: 'Chrysalis Bridge — Activity Log',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  logWin.loadFile('log.html');
  logWin.setMenu(null);

  // Send existing log entries when window opens
  logWin.webContents.on('did-finish-load', () => {
    logWin.webContents.send('log-history', logEntries);
  });
}

// ── IPC handlers ───────────────────────────────────────────────
// Settings — get current credentials (passwords masked)
ipcMain.handle('get-settings', () => ({
  chrysalisEmail:    creds.getChrysalisEmail(),
  chrysalisPassword: creds.getChrysalisPassword() ? '••••••••' : '',
  tebraEmail:        creds.getTebraEmail(),
  tebraPassword:     creds.getTebraPassword() ? '••••••••' : '',
  isSetupComplete:   creds.isSetupComplete(),
  bridgeRunning,
}));

// Settings — save credentials
ipcMain.handle('save-settings', (event, data) => {
  if (data.chrysalisEmail)    creds.setChrysalisEmail(data.chrysalisEmail);
  if (data.chrysalisPassword && data.chrysalisPassword !== '••••••••') {
    creds.setChrysalisPassword(data.chrysalisPassword);
    creds.setChrysalisToken(null); // force re-auth with new password
  }
  if (data.tebraEmail)    creds.setTebraEmail(data.tebraEmail);
  if (data.tebraPassword && data.tebraPassword !== '••••••••') {
    creds.setTebraPassword(data.tebraPassword);
  }

  // Auto-start bridge after setup if not already running
  if (!bridgeRunning && creds.isSetupComplete()) {
    startBridge();
  }

  return { success: true };
});

// Settings — test Chrysalis connection
ipcMain.handle('test-chrysalis', async () => {
  try {
    const res = await require('node-fetch')(
      'https://chrysalis-db.christygaynell.workers.dev/auth/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email:    creds.getChrysalisEmail(),
          password: creds.getChrysalisPassword(),
        }),
      }
    );
    const data = await res.json();
    if (data.token) {
      creds.setChrysalisToken(data.token);
      return { success: true, name: data.physician?.name || 'Connected' };
    }
    return { success: false, error: data.error || 'Login failed' };
  } catch(e) {
    return { success: false, error: e.message };
  }
});

// Settings — test Tebra connection with a real, visible browser login
// Mirrors bridge.js's own login pattern but runs independently so a
// failure here never affects the production polling logic in bridge.js
ipcMain.handle('test-tebra', async () => {
  const { chromium } = require('playwright');
  const os = require('os');

  const email    = creds.getTebraEmail();
  const password = creds.getTebraPassword();

  if (!email || !password) {
    return { success: false, error: 'Enter both Tebra email and password first' };
  }

  const TEBRA_BASE = 'https://app.kareo.com';
  const PROFILE_DIR = path.join(
    os.homedir(), 'AppData', 'Local', 'ChrysalisBridge', 'TebraProfile'
  );

  let context;
  try {
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
      args: ['--no-sandbox','--disable-setuid-sandbox','--restore-last-session=false','--no-first-run'],
      viewport: { width: 1100, height: 750 },
    });

    const page = await context.newPage();
    await page.goto(TEBRA_BASE + '/v2/#/scheduling/dashboard', {
      waitUntil: 'networkidle', timeout: 30000,
    });
    await page.waitForTimeout(3000);

    const url = page.url();

    if (url.includes('sign-in') || url.includes('login')) {
      // Not already logged in — attempt login with the entered credentials
      const emailInput = await page.$(
        'input[type="email"], input[type="text"], input[name="email"], ' +
        'input[placeholder*="email" i], input[placeholder*="username" i]'
      );
      if (!emailInput) {
        await context.close();
        return { success: false, error: 'Could not find Tebra login form — site may have changed' };
      }
      await emailInput.click({ clickCount: 3 });
      await emailInput.type(email, { delay: 50 });

      const passInput = await page.$('input[type="password"]');
      if (!passInput) {
        await context.close();
        return { success: false, error: 'Could not find password field' };
      }
      await passInput.click({ clickCount: 3 });
      await passInput.type(password, { delay: 50 });

      const loginBtn = await page.$('button:has-text("Login"), button:has-text("Log in"), input[type="submit"]');
      if (!loginBtn) {
        await context.close();
        return { success: false, error: 'Could not find login button' };
      }
      await loginBtn.click();

      try {
        await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 20000 });
      } catch(navErr) { /* some Tebra logins don't trigger a full navigation event */ }
      await page.waitForTimeout(3000);

      const finalUrl = page.url();
      if (finalUrl.includes('sign-in') || finalUrl.includes('login')) {
        await context.close();
        return { success: false, error: 'Login failed — check your Tebra email and password' };
      }
    }

    // If we reach here, either already logged in or login just succeeded
    await page.waitForTimeout(1500);
    await context.close();
    return { success: true };

  } catch(e) {
    try { if (context) await context.close(); } catch(closeErr) {}
    return { success: false, error: 'Connection test failed: ' + e.message };
  }
});
// Reset Tebra connection — stops Bridge, deletes the stale browser
// profile folder, leaves credentials intact so it logs in fresh next poll
ipcMain.handle('reset-tebra-connection', async () => {
  const fs = require('fs');
  const os = require('os');

  try {
    if (bridgeRunning) stopBridge();

    const profileDir = path.join(
      os.homedir(), 'AppData', 'Local', 'ChrysalisBridge', 'TebraProfile'
    );

    if (fs.existsSync(profileDir)) {
      fs.rmSync(profileDir, { recursive: true, force: true });
    }

    if (creds.isSetupComplete()) startBridge();

    return { success: true };
  } catch(e) {
    return { success: false, error: e.message };
  }
});

// Manual poll trigger from IPC
ipcMain.handle('poll-now', async () => {
  if (!bridgeRunning) return { error: 'Bridge not running' };
  await bridge.pollNow();
  return { success: true };
});

// Bridge start/stop from settings
ipcMain.handle('start-bridge', () => { startBridge(); return { running: true }; });
ipcMain.handle('stop-bridge',  () => { stopBridge();  return { running: false }; });
ipcMain.handle('bridge-status', () => ({ running: bridgeRunning, status: currentStatus }));

// ── App lifecycle ──────────────────────────────────────────────
app.whenReady().then(() => {
  // Hide from dock on Mac
  if (process.platform === 'darwin') app.dock.hide();

  tray = new Tray(getTrayIcon('stopped'));
  tray.setToolTip('Chrysalis Bridge');
  buildTrayMenu();

  // Double-click tray icon to open settings
  tray.on('double-click', openSettings);

  // Auto-start if credentials are already set up
  if (creds.isSetupComplete()) {
    startBridge();
  } else {
    openSettings();
  }
});

// Keep app running when all windows closed (system tray app)
app.on('window-all-closed', (e) => {
  e.preventDefault();
});

app.on('before-quit', () => {
  bridge.stop();
});
