'use strict';

const { chromium } = require('playwright');
const fetch = require('node-fetch');
const path = require('path');
const os = require('os');
const fs = require('fs');
const credentials = require('./credentials');

const CHRYSALIS_API = 'https://chrysalis-db.christygaynell.workers.dev';
const TEBRA_BASE    = 'https://app.kareo.com';
const POLL_INTERVAL = 60 * 1000;

const PROFILE_DIR = path.join(
  os.homedir(), 'AppData', 'Local', 'ChrysalisBridge', 'TebraProfile'
);

let context        = null;
let keepAlivePage  = null;
let pollTimer      = null;
let isPosting      = false;
let logCallback    = null;
let statusCallback = null;

function log(message, level = 'info') {
  const entry = { time: new Date().toLocaleTimeString(), message, level };
  console.log(`[Bridge ${level.toUpperCase()}] ${entry.time} — ${message}`);
  if (logCallback) logCallback(entry);
}

function setStatus(status) {
  if (statusCallback) statusCallback(status);
}

async function getChrysalisToken() {
  let token = credentials.getChrysalisToken();
  if (token) {
    try {
      const res = await fetch(CHRYSALIS_API + '/auth/me', {
        headers: { 'Authorization': 'Bearer ' + token },
      });
      if (res.ok) return token;
    } catch(e) {}
  }
  log('Re-authenticating with Chrysalis…');
  const res = await fetch(CHRYSALIS_API + '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email:    credentials.getChrysalisEmail(),
      password: credentials.getChrysalisPassword(),
    }),
  });
  const data = await res.json();
  if (!data.token) throw new Error('Chrysalis login failed: ' + (data.error || 'unknown'));
  credentials.setChrysalisToken(data.token);
  log('Chrysalis authentication successful');
  return data.token;
}

async function fetchPendingNotes(token) {
  const res = await fetch(CHRYSALIS_API + '/queue/pending', {
    headers: { 'Authorization': 'Bearer ' + token },
  });
  if (!res.ok) throw new Error('Failed to fetch queue: ' + res.status);
  const data = await res.json();
  return data.notes || [];
}

async function markComplete(token, noteId, ehrNoteId) {
  await fetch(CHRYSALIS_API + '/queue/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: JSON.stringify({ note_id: noteId, ehr_note_id: ehrNoteId || 'posted' }),
  });
}

async function markFailed(token, noteId, error) {
  await fetch(CHRYSALIS_API + '/queue/failed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: JSON.stringify({ note_id: noteId, error }),
  });
}

async function syncTodayPatients(token) {
  log('Syncing today\'s patients from Tebra schedule…');
  try {
    const today = new Date().toISOString().slice(0, 10);
    const apptRes = await fetch(
      TEBRA_BASE + '/v2/api/appointments?date=' + today + '&limit=50',
      { headers: { 'Accept': 'application/json', 'Cookie': await getTebraSessionCookie() } }
    );
    if (!apptRes.ok) {
      log('Tebra REST API not accessible — using browser sync instead', 'warn');
      await syncPatientsViaBrowser(token);
      return;
    }
    const apptData = await apptRes.json();
    const appointments = apptData.appointments || apptData.data || [];
    if (appointments.length === 0) { log('No appointments found for today'); return; }
    log(appointments.length + ' appointments found — syncing to Chrysalis');
    let created = 0, existing = 0;
    for (const appt of appointments) {
      const name = appt.patient_name || appt.patientName || '';
      const dob  = appt.patient_dob  || appt.dateOfBirth || '';
      const insurance = appt.insurance_name || appt.insuranceName || '';
      const apptType  = appt.appointment_type || appt.appointmentType || 'Follow-Up Visit';
      if (!name) continue;
      try {
        const checkRes  = await fetch(CHRYSALIS_API + '/patients', { headers: { 'Authorization': 'Bearer ' + token } });
        const checkData = await checkRes.json();
        const patients  = checkData.patients || [];
        if (patients.some(p => p.name.toLowerCase().trim() === name.toLowerCase().trim())) { existing++; continue; }
        await fetch(CHRYSALIS_API + '/patients', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
          body: JSON.stringify({ name, dob, insurance: insurance || 'Unknown', encounter_type: apptType, reason_for_visit: appt.chief_complaint || appt.reason || '' }),
        });
        created++;
        log('Created patient: ' + name);
      } catch(e) { log('Could not sync patient ' + name + ': ' + e.message, 'warn'); }
    }
    log('Sync complete — ' + created + ' created, ' + existing + ' already existed', 'success');
  } catch(e) {
    log('Calendar sync error: ' + e.message, 'error');
    await syncPatientsViaBrowser(token);
  }
}

async function getTebraSessionCookie() {
  try {
    if (context) {
      const cookies = await context.cookies(TEBRA_BASE);
      return cookies.map(c => c.name + '=' + c.value).join('; ');
    }
  } catch(e) {}
  return '';
}

async function syncPatientsViaBrowser(token) {
  log('Opening Tebra schedule for browser-based sync…');
  await ensureBrowser();
  const page = await context.newPage();
  try {
    await ensureTebraLoggedIn(page);
    await page.goto(TEBRA_BASE + '/v2/#/scheduling/dashboard', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(3000);
    const appointments = await page.evaluate(() => {
      const appts = [];
      document.querySelectorAll('[class*="appointment"], [class*="appt-block"], .event-item').forEach(el => {
        const nameEl = el.querySelector('[class*="patient-name"], [class*="patient"], strong, b');
        if (nameEl) appts.push({ name: nameEl.textContent.trim(), type: el.getAttribute('data-appointment-type') || 'Follow-Up Visit' });
      });
      return appts;
    });
    log('Found ' + appointments.length + ' appointments on schedule');
    let created = 0;
    for (const appt of appointments) {
      if (!appt.name) continue;
      try {
        await fetch(CHRYSALIS_API + '/patients', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
          body: JSON.stringify({ name: appt.name, encounter_type: appt.type, insurance: 'Unknown' }),
        });
        created++;
      } catch(e) {}
    }
    log('Browser sync complete — ' + created + ' patients synced', 'success');
  } finally {
    try { await page.close(); } catch(e) {}
  }
}

async function ensureBrowser() {
  if (context && keepAlivePage && !keepAlivePage.isClosed()) return;
  if (context) {
    try { await context.close(); } catch(e) {}
    context = null;
    keepAlivePage = null;
  }
  log('Launching browser…');

  // Resolve Chromium executable path — in a packaged app, the browser
  // binary lives under resourcesPath/playwright-browsers (bundled via
  // electron-builder's extraResources). In dev (npm start from source),
  // Playwright's default cache-based resolution still works as before,
  // so this only kicks in when running as a built/installed app.
  let executablePath;
  try {
    if (process.resourcesPath) {
      const bundledDir = path.join(process.resourcesPath, 'playwright-browsers');
      if (fs.existsSync(bundledDir)) {
        // Find the chromium-* subfolder and its actual binary
        const entries = fs.readdirSync(bundledDir).filter(d => d.startsWith('chromium'));
        if (entries.length > 0) {
          const chromiumDir = path.join(bundledDir, entries[0]);
          const candidate = process.platform === 'win32'
            ? path.join(chromiumDir, 'chrome-win', 'chrome.exe')
            : path.join(chromiumDir, 'chrome-linux', 'chrome');
          if (fs.existsSync(candidate)) executablePath = candidate;
        }
      }
    }
  } catch(e) {
    log('Bundled Chromium lookup failed — falling back to default: ' + e.message, 'warn');
  }

  context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    ...(executablePath ? { executablePath } : {}),
    args: ['--no-sandbox','--disable-setuid-sandbox','--restore-last-session=false','--no-first-run','--disable-session-crashed-bubble','--hide-crash-restore-bubble'],
    viewport: { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
  });
  keepAlivePage = await context.newPage();
  await keepAlivePage.goto('about:blank');
  try {
    await keepAlivePage.waitForTimeout(1500);
    await keepAlivePage.goto('about:newtab').catch(() => {});
    await keepAlivePage.waitForTimeout(500);
  } catch(e) {}
  log('Browser ready');
}

async function ensureTebraLoggedIn(page) {
  log('Navigating to Tebra…');
  await page.goto(TEBRA_BASE + '/v2/#/scheduling/dashboard', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(4000);
  const url = page.url();
  if (url.includes('sign-in') || url.includes('login')) {
    log('Session expired — attempting auto-login…', 'warn');
    try {
      const emailInput = await page.$('input[type="email"], input[type="text"], input[name="email"], input[placeholder*="email" i], input[placeholder*="username" i]');
      if (!emailInput) throw new Error('Email field not found');
      await emailInput.click({ clickCount: 3 });
      await emailInput.type(credentials.getTebraEmail(), { delay: 60 });
      const passInput = await page.$('input[type="password"]');
      if (!passInput) throw new Error('Password field not found');
      await passInput.click({ clickCount: 3 });
      await passInput.type(credentials.getTebraPassword(), { delay: 60 });
      const loginBtn = await page.$('button:has-text("Login"), button:has-text("Log in"), input[type="submit"]');
      if (!loginBtn) throw new Error('Login button not found');
      await loginBtn.click();
      await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 20000 });
      await page.waitForTimeout(3000);
      const newUrl = page.url();
      if (newUrl.includes('sign-in') || newUrl.includes('login')) throw new Error('Still on login page — credentials may be wrong');
      log('Auto-login successful', 'success');
    } catch(loginErr) {
      log('Auto-login failed: ' + loginErr.message, 'error');
      throw new Error('Tebra login failed — ' + loginErr.message);
    }
  } else {
    log('Already logged in to Tebra via saved session');
  }
}

// ============================================================
// NOTE TYPE SELECTION — select BEFORE filling any fields
// and verify the note re-rendered to the correct type
// ============================================================
const NOTE_TYPE_MAP = {
  'soap':         'SOAP',
  'progress':     'SOAP',
  'followup':     'SOAP',
  'follow-up':    'SOAP',
  'h&p':          'H&P',
  'hp':           'H&P',
  'intake':       'H&P',
  'consult':      'Consultation',
  'consultation': 'Consultation',
  'procedure':    'Procedure',
  'telehealth':   'Telehealth SOAP',
  'telehealthhp': 'Telehealth H&P',
  'dap':          'SOAP',
  'birp':         'SOAP',
  'discharge':    'SOAP',
};

async function selectNoteType(page, noteType) {
  if (!noteType) return 'SOAP';

  const tebraType = NOTE_TYPE_MAP[noteType.toLowerCase().replace(/\s/g, '')] || 'SOAP';
  if (tebraType === 'SOAP') return 'SOAP'; // default — no action needed

  log('Selecting note type: ' + tebraType);

  try {
    // Try native select first
    const typeSelect = await page.$('select[ng-model*="noteType"], select[ng-model*="type"], .note-type-select select');
    if (typeSelect) {
      await typeSelect.selectOption({ label: tebraType });
      await page.waitForTimeout(1500);
      log('Note type set via select: ' + tebraType);
      return tebraType;
    }

    // Try Angular dropdown
    const typeDropdown = await page.$('[class*="note-type"], [data-testid*="note-type"]');
    if (typeDropdown) {
      await typeDropdown.click();
      await page.waitForTimeout(500);
      await page.getByText(tebraType, { exact: true }).click();
      await page.waitForTimeout(1500);
      log('Note type set via dropdown: ' + tebraType);
      return tebraType;
    }

    // Try finding it as a link or option anywhere on page
    const typeLink = await page.$('a:has-text("' + tebraType + '"), li:has-text("' + tebraType + '")');
    if (typeLink) {
      await typeLink.click();
      await page.waitForTimeout(1500);
      log('Note type set via link: ' + tebraType);
      return tebraType;
    }

    log('Note type selector not found for ' + tebraType + ' — using SOAP fields', 'warn');
    return 'SOAP';

  } catch(e) {
    log('Could not set note type to ' + tebraType + ': ' + e.message + ' — using SOAP fields', 'warn');
    return 'SOAP';
  }
}

// ============================================================
// NOTE PARSING
// ============================================================
function cleanSectionContent(text) {
  if (!text) return '';
  return text
    .replace(/^[^\n]*\[(?:INSUFFICIENT CLINICAL INFORMATION|NOT DOCUMENTED|PROVIDER TO COMPLETE|VITALS NOT DOCUMENTED|PHYSICAL EXAM NOT DOCUMENTED|DOSE AND FREQUENCY NOT DOCUMENTED|EXTERNAL CAUSE CODING PENDING|PROVIDER TO CONFIRM|REMAINDER OF ROS NOT DOCUMENTED)[^\]]*\][^\n]*/gim, '')
    .replace(/\*\*[^*]+\*\*:\s*\[[^\]]*\]/gi, '')
    .replace(/\*\*MEDICATIONS:\*\*[^\n]*/gi, '')
    .replace(/\*\*VITAL SIGNS:\*\*\s*\[[^\]]*\]/gi, '')
    .replace(/\*\*VITAL SIGNS:\*\*\s*\[/gi, '')
    .replace(/\[[A-Z][A-Z\- ]+\]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s*[\r\n]+/, '')
    .trim();
}

function parseNoteIntoTebraSections(rawOutput, resolvedNoteType) {
  // Normalize bracket-wrapped headers like "[SUBJECTIVE]" to "SUBJECTIVE:" —
  // Claude occasionally wraps the header itself in brackets instead of just
  // the placeholder guidance, which would otherwise cause indexOf(key + ':')
  // to silently miss the section and drop it from the note entirely.
  const normalizedOutput = rawOutput.replace(
    /\[(SUBJECTIVE|OBJECTIVE|ASSESSMENT|PLAN|DATA|BEHAVIOR|INTERVAL_HISTORY|CURRENT_STATUS|HISTORY|PHYSICAL_EXAM|CHIEF_COMPLAINT)\]/gi,
    (match, word) => word.toUpperCase() + ':'
  );

  const get = (key, stopKeys) => {
    const si = normalizedOutput.indexOf(key + ':');
    if (si === -1) return '';
    const from = si + key.length + 1;
    let to = normalizedOutput.length;
    const billingIdx = normalizedOutput.indexOf('---BILLING---', from);
    if (billingIdx !== -1 && billingIdx < to) to = billingIdx;
    (stopKeys || []).forEach(k => {
      const ki = normalizedOutput.indexOf(k + ':', from);
      if (ki !== -1 && ki < to) to = ki;
    });
    return normalizedOutput.slice(from, to).trim();
  };

  const subjective = get('SUBJECTIVE',       ['OBJECTIVE', 'ASSESSMENT', 'PLAN', '---']);
  const objective  = get('OBJECTIVE',        ['ASSESSMENT', 'PLAN', '---']);
  const assessment = get('ASSESSMENT',       ['PLAN', '---']);
  const plan       = get('PLAN',             ['---']);
  const data       = get('DATA',             ['ASSESSMENT', 'PLAN', '---']);
  const behavior   = get('BEHAVIOR',         ['INTERVENTION', 'RESPONSE', 'PLAN', '---']);
  const interval   = get('INTERVAL_HISTORY', ['CURRENT_STATUS', 'ASSESSMENT', 'PLAN', '---']);

  // H&P specific sections
  const history    = get('HISTORY',          ['PHYSICAL_EXAM', 'ASSESSMENT', 'PLAN', '---']);
  const physExam   = get('PHYSICAL_EXAM',    ['ASSESSMENT', 'PLAN', '---']);
  const chiefComp  = get('CHIEF_COMPLAINT',  ['HISTORY', 'PHYSICAL_EXAM', 'ASSESSMENT', 'PLAN', '---']);

  // Resolve based on actual note type that was set in Tebra
  const isHP = resolvedNoteType && (resolvedNoteType === 'H&P' || resolvedNoteType === 'Telehealth H&P');

  const subjectiveText = isHP
    ? (history || subjective || data || behavior || interval || '')
    : (subjective || data || behavior || interval || history || '');

  const objectiveText = isHP
    ? (physExam || objective || '')
    : (objective || physExam || '');

  const medMatch = subjectiveText.match(/\*\*MEDICATIONS:\*\*\s*([^\n]+)/i) ||
                   subjectiveText.match(/medications?:?\s*([^\n]+)/i);
  const medications = medMatch ? medMatch[1].replace(/\[.*$/, '').trim() : '';

  const cleanedSubjective = cleanSectionContent(subjectiveText);
  const subjectiveForCC   = cleanedSubjective.trim() || subjectiveText.trim();

  // For H&P use chief complaint as CC if available
  const ccSource = isHP && chiefComp ? chiefComp : subjectiveForCC;
  const ccMatch  = ccSource.match(/^(.+?[.!?])\s/);
  const cc       = ccMatch ? ccMatch[1] : ccSource.slice(0, 120) || 'See note';

  return {
    cc,
    subjective:  cleanedSubjective,
    objective:   objectiveText,
    assessment,
    plan,
    medications,
    resolvedNoteType: resolvedNoteType || 'SOAP',
  };
}

// ============================================================
// TEBRA SECTION FILLING
// Maps support both SOAP and H&P field testids
// ============================================================
const TEBRA_TESTID_MAP = {
  // SOAP fields
  'cc':               'cc',
  'subjective':       'hpi',
  'objective':        'exam',
  'assessment':       'asmt',
  'plan':             'plan',
  // H&P fields — Tebra uses different testids for H&P note type
  'history':          'hpi',       // History of Present Illness maps to hpi
  'physicalexam':     'exam',      // Physical Exam maps to exam
  'chiefcomplaint':   'cc',
  // Shared
  'medications':      'medications',
  'medication':       'medications',
  'meds':             'medications',
  'mentalfunctional': 'mental',
  'vitals':           'vitals',
};

async function fillTebraField(page, sectionName, content) {
  if (!content || !content.trim()) return;

  const key      = sectionName.toLowerCase().replace(/[^a-z0-9]/g, '');
  const testId   = TEBRA_TESTID_MAP[key] || key;
  const selector = `div.section-content[data-testid="${testId}"]`;
  const trimmedContent = content.trim();

  try {
    // Wait for field to exist — handles DOM settling after note type change
    const field = await page.waitForSelector(selector, { timeout: 8000 }).catch(() => null);

    if (!field) {
      log('Section not found: ' + sectionName + ' (testid: ' + testId + ') — skipping', 'warn');
      return;
    }

    await field.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);

    // Click and verify focus landed — handles cases where Include Problems
    // left focus trapped in a modal or off-screen element
    await page.evaluate(el => el.click(), field);
    await page.waitForTimeout(800);

    const isFocused = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return el ? (document.activeElement === el || el.contains(document.activeElement)) : false;
    }, selector);

    if (!isFocused) {
      log(sectionName + ' did not receive focus — retrying click', 'warn');
      await field.click();
      await page.waitForTimeout(400);
    }

    // Use execCommand — Angular-safe, fires correct events for Tebra's model
    await page.evaluate(({ sel, text }) => {
      const el = document.querySelector(sel);
      if (!el) return;
      el.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, text);
      try {
        const scope = window.angular && window.angular.element(el).scope();
        if (scope && typeof scope.$apply === 'function') scope.$apply();
      } catch(e) {}
      el.dispatchEvent(new Event('input',  { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, { sel: selector, text: trimmedContent });

    await page.waitForTimeout(300);

    // Verify content landed — catch truncation before moving on
    const actualText = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return el ? (el.innerText || el.textContent || '').trim() : '';
    }, selector);

    const ratio = trimmedContent.length > 0 ? actualText.length / trimmedContent.length : 1;

    if (ratio < 0.85) {
      log(sectionName + ' truncated (' + actualText.length + '/' + trimmedContent.length + ' chars) — retrying', 'warn');
      await field.click();
      await page.waitForTimeout(400);
      await page.keyboard.press('Control+a');
      await page.waitForTimeout(150);
      await page.keyboard.press('Delete');
      await page.waitForTimeout(150);
      await page.keyboard.type(trimmedContent, { delay: 20 });
      await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return;
        el.dispatchEvent(new Event('input',  { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        try {
          const scope = window.angular && window.angular.element(el).scope();
          if (scope && typeof scope.$apply === 'function') scope.$apply();
        } catch(e) {}
      }, selector);
      log(sectionName + ' retry complete', 'info');
    } else {
      log('Filled: ' + sectionName + ' (' + actualText.length + ' chars)');
    }

    await page.keyboard.press('Tab');
    await page.waitForTimeout(300);

  } catch(e) {
    log('Error filling ' + sectionName + ': ' + e.message, 'warn');
  }
}

async function fillTebraFieldMulti(page, testIds, content) {
  for (const testId of testIds) {
    try {
      const selector = `div.section-content[data-testid="${testId}"]`;
      const field = await page.$(selector);
      if (field) {
        await field.click();
        await page.waitForTimeout(300);
        await page.keyboard.press('Control+a');
        await page.waitForTimeout(100);
        await page.keyboard.type(content.trim(), { delay: 15 });
        await page.keyboard.press('Tab');
        await page.waitForTimeout(200);
        log('Filled medications via testid: ' + testId);
        return true;
      }
    } catch(e) {}
  }
  return false;
}

async function closeAnyOpenModal(page) {
  try {
    const modalVisible = await page.evaluate(() => {
      const allBtns = Array.from(document.querySelectorAll('button'));
      const closeBtn = allBtns.find(b => {
        if (b.textContent.trim() !== 'Close') return false;
        let el = b.parentElement;
        for (let i = 0; i < 8; i++) {
          if (!el) break;
          if (el.textContent.includes('Active Medications') ||
              el.textContent.includes('Medication reconciliation') ||
              (el.querySelector && el.querySelector('[class*="medication"]'))) return true;
          el = el.parentElement;
        }
        return false;
      });
      if (closeBtn) { closeBtn.click(); return true; }
      const xBtn = document.querySelector('.modal .close, [class*="modal"] button[aria-label="Close"], [class*="medication-modal"] .close');
      if (xBtn) { xBtn.click(); return true; }
      return false;
    });
    if (modalVisible) {
      log('Medications modal detected and closed', 'warn');
      await page.waitForTimeout(800);
    }
  } catch(e) {
    log('Modal guard error: ' + e.message, 'warn');
  }
}

async function handleProblemList(page, selectedICDs) {
  if (!selectedICDs || selectedICDs.length === 0) {
    log('No ICD codes selected — skipping problem list');
    return;
  }
  log('Opening Include Problems modal for ' + selectedICDs.length + ' code(s)…');
  try {
    const noteUrl = page.url();
    await page.evaluate(() => {
      const asmt = document.querySelector('div.section-content[data-testid="asmt"]');
      if (asmt) asmt.click();
    });
    await page.waitForTimeout(1500);

    const opened = await page.evaluate(() => {
      const btn = document.querySelector('a.include-problems[role="button"]');
      if (btn) { btn.click(); return true; }
      return false;
    });
    if (!opened) { log('Include Problems button not found — skipping', 'warn'); return; }
    await page.waitForTimeout(2500);

    const panelOpen = await page.evaluate(() => !!document.getElementById('problem-histories-table'));
    if (!panelOpen) { log('Include Problems panel did not open — skipping', 'warn'); return; }
    log('Include Problems panel open');

    const checkedCodes = await page.evaluate((icdCodes) => {
      const checked = [];
      const table = document.getElementById('problem-histories-table');
      if (!table) return checked;
      const rows = Array.from(table.querySelectorAll('tr.problem_history'));
      for (const row of rows) {
        const icdCell = row.querySelector('td.icd10Code');
        const rowIcd  = icdCell ? icdCell.textContent.trim().toUpperCase() : '';
        const matched = icdCodes.find(code => rowIcd === code.toUpperCase() || rowIcd.startsWith(code.slice(0,3).toUpperCase()));
        if (!matched) continue;
        const input = row.querySelector('input[type="checkbox"]');
        const span  = row.querySelector('div.checker span');
        if (!input) continue;
        if (input.checked || row.classList.contains('selected')) { checked.push(matched + ' (already checked)'); continue; }
        input.checked = true;
        if (span) span.className = 'checked';
        row.classList.add('selected');
        input.dispatchEvent(new Event('change', { bubbles: true }));
        try {
          const scope = window.angular && window.angular.element(input).scope();
          if (scope && typeof scope.$apply === 'function') scope.$apply();
        } catch(e) {}
        checked.push(matched);
      }
      return checked;
    }, selectedICDs);

    log('Checked ' + checkedCodes.length + ' problem(s): ' + checkedCodes.join(', '));

    const missed = selectedICDs.filter(c => !checkedCodes.some(x => x.startsWith(c)));
    if (missed.length > 0) log(missed.length + ' code(s) not in existing list — Assessment text only: ' + missed.join(', '), 'info');

    await page.waitForTimeout(500);
    const submitted = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('a, button, input[type="button"]'));
      const btn = all.find(b => b.textContent.trim() === 'Include');
      if (btn) { btn.click(); return true; }
      return false;
    });
    if (submitted) log('Include submitted', 'success');
    else log('Include button not found', 'warn');

    await page.waitForTimeout(2500);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    if (page.url() !== noteUrl) {
      log('Navigated away — returning to note', 'warn');
      await page.goto(noteUrl, { waitUntil: 'networkidle', timeout: 20000 });
      await page.waitForTimeout(2000);
    }
  } catch(e) {
    log('Problem list error: ' + e.message + ' — skipping to free text', 'warn');
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(500);
  }
}

async function addNewProblem(page, icdCode) {
  log('Adding new problem: ' + icdCode);
  try {
    const addProblemBtn = await page.$('button:has-text("+ Problem"), a:has-text("+ Problem"), [class*="add-problem"], .btn:has-text("Problem")');
    if (!addProblemBtn) { log('+ Problem button not found for ' + icdCode, 'warn'); return; }
    await page.evaluate(el => el.click(), addProblemBtn);
    await page.waitForTimeout(1500);

    let icdInput;
    try {
      icdInput = await page.waitForSelector('input[placeholder*="ICD-10"], input[placeholder*="Search for problem or ICD"]', { timeout: 5000, state: 'visible' });
    } catch(e) { log('ICD-10 field not found for ' + icdCode, 'warn'); await cancelAddProblemModal(page); return; }

    await page.evaluate(el => { el.focus(); el.value = ''; }, icdInput);
    await page.waitForTimeout(200);
    const searchCode = icdCode.length > 5 ? icdCode.slice(0, 5) : icdCode;
    await icdInput.type(searchCode, { delay: 80 });
    await page.waitForTimeout(2000);

    const icdDropdownSeen = await page.evaluate(() => {
      const modal = document.querySelector('.epocrates.newProblem, [aria-labelledby*="problem-histories"]');
      if (!modal) return false;
      return modal.querySelectorAll('ol li, ul li, [class*="suggestion"] li, typeahead-container li').length > 0;
    });

    if (!icdDropdownSeen) { log('ICD-10 no results for ' + icdCode, 'warn'); await cancelAddProblemModal(page); return; }

    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(300);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1000);

    const icdValue = await page.evaluate(el => el.value, icdInput);
    if (!icdValue || icdValue.length < 2) { log('ICD-10 field empty after selection for ' + icdCode, 'warn'); await cancelAddProblemModal(page); return; }
    log('ICD-10 selected: ' + icdValue);

    let snomedInput;
    try {
      snomedInput = await page.waitForSelector(
        'input[placeholder="Search for problem or SNOMED code"], input[placeholder*="Search for problem"], input[type="text"][placeholder*="SNOMED"]',
        { timeout: 5000, state: 'visible' }
      );
    } catch(e) { log('SNOMED field not found for ' + icdCode, 'warn'); await cancelAddProblemModal(page); return; }

    await page.evaluate(el => { el.focus(); el.value = ''; }, snomedInput);
    await page.waitForTimeout(200);
    await snomedInput.type(searchCode, { delay: 80 });
    await page.waitForTimeout(2000);

    const snomedDropdownSeen = await page.evaluate(() => {
      const modal = document.querySelector('.epocrates.newProblem, [aria-labelledby*="problem-histories"]');
      if (!modal) return false;
      return modal.querySelectorAll('ol li, ul li, [class*="suggestion"] li, typeahead-container li').length > 0;
    });

    if (!snomedDropdownSeen) { log('SNOMED no results for ' + icdCode, 'warn'); await cancelAddProblemModal(page); return; }

    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(400);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1000);

    const snomedValue = await page.evaluate(() => {
      const hidden = document.getElementById('problem_history_snomed_code') || document.querySelector('input[name="problem_history[snomed_code]"]');
      if (hidden && hidden.value) return hidden.value;
      const visible = document.querySelector('input[placeholder*="Search for problem"]');
      return visible ? visible.value : '';
    });

    if (!snomedValue) { log('SNOMED still empty for ' + icdCode, 'warn'); await cancelAddProblemModal(page); return; }
    log('SNOMED populated: ' + snomedValue);

    const saveClicked = await page.evaluate(() => {
      const modal = document.querySelector('.epocrates.newProblem, [aria-labelledby*="problem-histories"]');
      const scope = modal || document;
      const buttons = Array.from(scope.querySelectorAll('button'));
      const saveBtn = buttons.find(b => b.textContent.trim() === 'Save');
      if (saveBtn) { saveBtn.click(); return true; }
      const primary = scope.querySelector('.ui-dialog-buttonpane .ui-button, .modal-footer .btn-primary');
      if (primary) { primary.click(); return true; }
      return false;
    });

    if (saveClicked) { await page.waitForTimeout(1500); log('Added new problem: ' + icdCode, 'success'); }
    else { log('Save button not found for ' + icdCode, 'warn'); await cancelAddProblemModal(page); }

  } catch(e) {
    log('Failed to add problem ' + icdCode + ': ' + e.message, 'warn');
    await cancelAddProblemModal(page);
  }
}

async function cancelAddProblemModal(page) {
  try {
    const cancelled = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const cancelBtn = btns.find(b => b.textContent.trim() === 'Cancel');
      if (cancelBtn) { cancelBtn.click(); return true; }
      return false;
    });
    if (!cancelled) await page.keyboard.press('Escape');
    await page.waitForTimeout(800);
  } catch(e) {
    try { await page.keyboard.press('Escape'); await page.waitForTimeout(500); } catch(esc) {}
  }
}

async function fillPlanSubFields(page, planText, selectedICDs) {
  if (!planText) return;
  log('Filling Plan sub-fields…');

  const planSections = [];
  const lines = planText.split('\n');
  let current = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const numMatch = trimmed.match(/^\*{0,2}(\d+)\.\s*\*{0,2}(.+)/);
    if (numMatch) {
      if (current) planSections.push(current);
      const heading = numMatch[2].replace(/\*\*/g, '').replace(/:$/, '').trim();
      current = { number: parseInt(numMatch[1], 10), heading, lines: [], matched: false };
    } else if (current) {
      current.lines.push(trimmed);
    }
  }
  if (current) planSections.push(current);

  log('Parsed ' + planSections.length + ' plan sections: ' + planSections.map(s => s.number + '. ' + s.heading).join(' | '));

  if (!planSections.length) {
    log('No numbered plan sections — pasting full plan', 'warn');
    await fillTebraField(page, 'Plan', cleanSectionContent(planText));
    return;
  }

  log('Polling for Plan sub-fields…');
  let subFields = [];
  for (let i = 0; i < 23; i++) {
    try {
      const okBtn = page.getByRole('button', { name: 'OK' });
      if (await okBtn.isVisible().catch(() => false)) { await okBtn.click(); await page.waitForTimeout(500); log('Date dialog cleared'); }
    } catch(e) {}

    subFields = await page.evaluate(() => {
      const results = [];
      const candidates = Array.from(document.querySelectorAll('div.section-content[id$="_PLAN"], div.section-content[id$="_plan"]'));
      for (const el of candidates) {
        if (!el.id || el.id === 'plan') continue;
        const label = el.id.replace(/_PLAN$/, '').replace(/_plan$/, '').replace(/_/g, ' ').toLowerCase();
        results.push({ contentId: el.id, contentTestId: el.getAttribute('data-testid') || '', label });
      }
      return results;
    });
    if (subFields.length > 0) { log('Sub-fields found on poll ' + (i+1) + ': ' + subFields.map(f => f.label).join(', ')); break; }
    log('Poll ' + (i+1) + '/23 — sub-fields not yet in DOM…');
    await page.waitForTimeout(1000);
  }

  if (!subFields.length) {
    log('No sub-fields appeared — pasting full plan', 'warn');
    await fillTebraField(page, 'Plan', cleanSectionContent(planText));
    return;
  }

  for (const section of planSections) {
    section.pasteText = cleanSectionContent(section.lines.join('\n'));
    if (!section.pasteText.trim()) { section.matched = true; }
  }

  const adminHeadings = ['follow-up','follow up','followup','general','other'];
  function scoreMatch(subField, section) {
    if (section.matched) return 0;
    const labelStr   = subField.label.toLowerCase();
    const labelWords = labelStr.split(/[\s\/\-]+/).filter(w => w.length >= 2);
    const headingLower = section.heading.toLowerCase();
    const headingWords = headingLower.split(/[\s\/\-]+/).filter(w => w.length >= 2);
    if (headingLower.includes(labelStr)) return 100;
    const headingScore = labelWords.filter(w => headingWords.some(hw => hw.includes(w) || w.includes(hw))).length * 10;
    if (headingScore > 0) return headingScore;
    if (!adminHeadings.some(a => headingLower.includes(a))) {
      const bodyText  = section.lines.join(' ').toLowerCase();
      const bodyWords = bodyText.split(/[\s\/\-,;.(\[\]]+/).filter(w => w.length >= 3);
      const bodyScore = labelWords.filter(w => bodyWords.some(bw => bw === w || bw.startsWith(w) || w.startsWith(bw))).length;
      if (bodyScore > 0) return 1;
    }
    return 0;
  }

  const allPairs = [];
  for (const subField of subFields) {
    for (const section of planSections) {
      if (section.matched) continue;
      const score = scoreMatch(subField, section);
      if (score > 0) allPairs.push({ subField, section, score });
    }
  }
  allPairs.sort((a, b) => b.score - a.score);

  const assignedSubFields = new Set();
  const assignments = new Map();
  for (const pair of allPairs) {
    if (assignedSubFields.has(pair.subField.contentId)) continue;
    if (pair.section.matched) continue;
    assignments.set(pair.subField.contentId, { section: pair.section, pasteText: pair.section.pasteText, score: pair.score });
    pair.section.matched = true;
    assignedSubFields.add(pair.subField.contentId);
    log('Assigned: section ' + pair.section.number + ' "' + pair.section.heading + '" → "' + pair.subField.label + '" (score: ' + pair.score + ')');
  }

  let filledCount = 0;
  for (const subField of subFields) {
    const assignment = assignments.get(subField.contentId);
    if (!assignment) { log('No plan match for "' + subField.label + '" — skipping', 'info'); continue; }
    const { section, pasteText } = assignment;
    log('Filling "' + subField.label + '" ← section ' + section.number);
    const contentSelector = `div.section-content[id="${subField.contentId}"]`;
    try {
      const field = await page.$(contentSelector);
      if (!field) { log('Content div not found for "' + subField.label + '"', 'warn'); continue; }
      await page.evaluate(el => el.click(), field);
      await page.waitForTimeout(800);
      const inserted = await page.evaluate(({ sel, text }) => {
        const el = document.querySelector(sel);
        if (!el) return 'not-found';
        el.focus();
        document.execCommand('selectAll', false, null);
        const ok = document.execCommand('insertText', false, text);
        el.dispatchEvent(new Event('input',  { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        try { const scope = window.angular && window.angular.element(el).scope(); if (scope && typeof scope.$apply === 'function') scope.$apply(); } catch(e) {}
        return ok ? 'ok' : 'execCommand-false';
      }, { sel: contentSelector, text: pasteText });

      if (inserted === 'ok') {
        log('✓ Filled sub-field "' + subField.label + '"', 'success');
        section.matched = true;
        filledCount++;
        await page.waitForTimeout(300);
        await page.keyboard.press('Tab');
        await page.waitForTimeout(300);
      } else {
        log('execCommand failed — trying keyboard for "' + subField.label + '"', 'warn');
        await field.click();
        await page.waitForTimeout(300);
        await page.keyboard.press('Control+a');
        await page.waitForTimeout(100);
        await page.keyboard.type(pasteText, { delay: 8 });
        await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          if (!el) return;
          el.dispatchEvent(new Event('input',  { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          try { const scope = window.angular && window.angular.element(el).scope(); if (scope && typeof scope.$apply === 'function') scope.$apply(); } catch(e) {}
        }, contentSelector);
        log('✓ Filled via keyboard "' + subField.label + '"', 'success');
        section.matched = true;
        filledCount++;
        await page.waitForTimeout(300);
        await page.keyboard.press('Tab');
        await page.waitForTimeout(300);
      }
    } catch(e) {
      log('Error filling "' + subField.label + '": ' + e.message, 'warn');
    }
  }

  const unmatched = planSections.filter(s => !s.matched);
  if (filledCount === 0) {
    log('No sub-fields filled — pasting full plan', 'warn');
    await fillTebraField(page, 'Plan', cleanSectionContent(planText));
  } else if (unmatched.length === 0) {
    log('All ' + filledCount + ' section(s) matched — Plan summary inserted');
    await fillTebraField(page, 'Plan', 'See individual diagnosis plans below.');
  } else {
    const remainderLines = [];
    for (const s of unmatched) { remainderLines.push(s.number + '. ' + s.heading + ':'); for (const l of s.lines) remainderLines.push(l); remainderLines.push(''); }
    log(unmatched.length + ' unmatched section(s) → Plan field');
    await fillTebraField(page, 'Plan', cleanSectionContent(remainderLines.join('\n')));
  }
}

async function ensureNoteDateSet(page) {
  try {
    const dateInput = await page.$('input[data-testid="dateOfVisit"], input[id="date_of_visit_date"], input[name="date_of_visit_date"], input[class*="ehr-note-toolbar-date"]');
    if (!dateInput) { log('Date input not found', 'warn'); return; }
    await dateInput.click();
    await page.waitForTimeout(800);
    const clicked = await page.evaluate(() => {
      const todayCell = document.querySelector('.ui-datepicker td.ui-datepicker-today a, .ui-datepicker td a.ui-state-highlight, .ui-datepicker td a.ui-state-active');
      if (todayCell) { todayCell.click(); return 'today-cell'; }
      const todayNum = new Date().getDate().toString();
      const allCells = Array.from(document.querySelectorAll('.ui-datepicker td a'));
      const match = allCells.find(a => a.textContent.trim() === todayNum);
      if (match) { match.click(); return 'date-number'; }
      return null;
    });
    if (clicked) { log('Date of visit set: ' + clicked); await page.waitForTimeout(500); }
    else {
      log('Datepicker cell not found — typing date', 'warn');
      const today = new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
      await dateInput.click({ clickCount: 3 });
      await page.keyboard.press('Control+a');
      await page.keyboard.type(today, { delay: 50 });
      await page.keyboard.press('Tab');
      await page.waitForTimeout(300);
    }
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  } catch(e) { log('ensureNoteDateSet error: ' + e.message, 'warn'); }
}

async function dismissDateDialog(page) {
  try {
    const okBtn = page.getByRole('button', { name: 'OK' });
    if (!await okBtn.isVisible().catch(() => false)) return false;
    await okBtn.click();
    log('Date dialog dismissed');
    await page.waitForTimeout(800);
    return true;
  } catch(e) { return false; }
}

async function clickSaveAndClose(page) {
  // Wait for Last Saved indicator — with 15s fallback to preserve original behavior
  try {
    await page.waitForSelector('[class*="last-saved"], :text("Last Saved")', { timeout: 15000 });
    log('Auto-save confirmed — proceeding to Save & Close');
    await page.waitForTimeout(1000);
  } catch(e) {
    log('Auto-save indicator not seen after 15s — proceeding anyway', 'warn');
  }

  await dismissDateDialog(page);
  await page.waitForTimeout(500);

  try {
    await page.getByText('Save & Close', { exact: true }).click();
    log('Clicked Save & Close', 'success');
    await page.waitForTimeout(2000);
    const hadDialog = await dismissDateDialog(page);
    if (hadDialog) {
      await page.waitForTimeout(800);
      try {
        await page.getByText('Save & Close', { exact: true }).click();
        log('Retried Save & Close after date dialog', 'success');
        await page.waitForTimeout(3000);
      } catch(e2) {
        await page.evaluate(() => {
          const btn = Array.from(document.querySelectorAll('button, a')).find(b => b.textContent.trim() === 'Save & Close');
          if (btn) btn.click();
        });
        await page.waitForTimeout(3000);
      }
    } else {
      await page.waitForTimeout(2000);
    }
    return true;
  } catch(e) {}

  const selectors = ['button:has-text("Save & Close")','a:has-text("Save & Close")','[class*="save-close"]','.bottom-bar button:last-of-type'];
  for (const sel of selectors) {
    try {
      const btn = await page.$(sel);
      if (btn) {
        await btn.scrollIntoViewIfNeeded();
        await page.waitForTimeout(300);
        await page.evaluate(el => el.click(), btn);
        log('Clicked Save & Close via fallback', 'success');
        await page.waitForTimeout(2000);
        return true;
      }
    } catch(e) {}
  }

  try {
    const lastSaved = await page.$('[class*="last-saved"], :has-text("Last Saved")');
    if (lastSaved) { log('Note auto-saved — navigating away', 'info'); return true; }
  } catch(e) {}

  return false;
}

// ============================================================
// POST NOTE TO TEBRA — main orchestration
// ============================================================
async function postNoteToTebra(page, queueItem) {
  const { patient_name, note_text, raw_output, reason_for_visit, note_type, selected_icd_codes } = queueItem;
  const source = raw_output || note_text || '';

  let selectedICDs = [];
  try { selectedICDs = JSON.parse(selected_icd_codes || '[]'); } catch(e) { selectedICDs = []; }

  // Normalize patient name
  let searchName = patient_name;
  if (patient_name.includes(',')) {
    const parts = patient_name.split(',').map(s => s.trim());
    searchName = parts[1] + ' ' + parts[0];
  }

  log('Searching for patient: ' + searchName);
  const searchInput = await page.waitForSelector('[data-testid="header-search-patient-input"]', { timeout: 20000 });
  await searchInput.click();
  await searchInput.fill('');
  await page.waitForTimeout(500);
  await searchInput.type(searchName, { delay: 100 });
  await page.waitForTimeout(3000);

  let firstResult = null;
  for (const sel of ['a.omni-search-result','.krome-menu-dropdown a.omni-search-result','[class*="search-result"] a','.krome-menu-dropdown li a','a[href*="facesheet"]','a[href*="patient"]']) {
    try {
      await page.waitForSelector(sel, { timeout: 5000 });
      firstResult = await page.$(sel);
      if (firstResult) { log('Found patient via: ' + sel); break; }
    } catch(e) {}
  }
  if (!firstResult) throw new Error('No patient search results for: ' + searchName);

  await firstResult.click();
  await page.waitForLoadState('networkidle', { timeout: 20000 });
  await page.waitForTimeout(2000);

  log('Found patient — opening new note');
  const newNoteBtn = await page.waitForSelector('button:has-text("New Note"), a:has-text("New Note"), button:has-text("+ New Note")', { timeout: 10000 });
  await newNoteBtn.click();
  await page.waitForLoadState('networkidle', { timeout: 20000 });
  await page.waitForTimeout(3000);

  // ── Select note type FIRST before filling any fields ─────────
  // This ensures Tebra renders the correct field structure before we start
  const resolvedNoteType = await selectNoteType(page, note_type);

  // Parse sections using the resolved note type so H&P sections map correctly
  const sections = parseNoteIntoTebraSections(source, resolvedNoteType);

  // ── Fill sections ─────────────────────────────────────────────
  log('Filling note sections (' + resolvedNoteType + ')…');

  // Warn if any core section came back empty — usually means Claude's
  // output used an unexpected header format that the parser didn't catch
  ['subjective','objective','assessment','plan'].forEach(key => {
    if (!sections[key] || !sections[key].trim()) {
      log('WARNING: ' + key.toUpperCase() + ' section is empty after parsing — check raw_output formatting', 'warn');
    }
  });

  await fillTebraField(page, 'CC',         cleanSectionContent(sections.cc || reason_for_visit || 'Follow-up visit'));
  await fillTebraField(page, 'Subjective', cleanSectionContent(sections.subjective));
  await fillTebraField(page, 'Objective',  cleanSectionContent(sections.objective));
  await fillTebraField(page, 'Assessment', cleanSectionContent(sections.assessment));
  log('Note sections filled');

  // ── Problem list + Plan sub-fields ───────────────────────────
  if (selectedICDs.length > 0) {
    await closeAnyOpenModal(page);
    await page.waitForTimeout(500);

    // Defensive focus reset before problem list — prevents CC/Subjective
    // fill failures caused by lingering modal focus state
    try {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      const body = await page.$('body');
      if (body) await body.click({ position: { x: 5, y: 5 } });
      await page.waitForTimeout(500);
    } catch(e) {}

    await handleProblemList(page, selectedICDs);
    await page.waitForTimeout(3000);
    await fillPlanSubFields(page, sections.plan, selectedICDs);
    await page.waitForTimeout(500);
  } else {
    await fillTebraField(page, 'Plan', cleanSectionContent(sections.plan));
  }

  log('Sections filled — saving note');
  const saved = await clickSaveAndClose(page);
  if (!saved) {
    const screenshotPath = path.join(os.homedir(), 'Downloads', 'bridge-debug-' + Date.now() + '.png');
    await page.screenshot({ path: screenshotPath, fullPage: true });
    log('Save button not found — screenshot saved to Downloads', 'warn');
  }

  await page.waitForTimeout(2000);
  return 'posted-' + Date.now();
}

// ============================================================
// POLL AND PROCESS — fresh page per note, one retry on failure
// ============================================================
async function pollAndProcess() {
  if (isPosting) { log('Still processing — skipping poll cycle'); return; }
  isPosting = true;
  setStatus('checking');

  try {
    const token = await getChrysalisToken();
    const notes = await fetchPendingNotes(token);

    if (notes.length === 0) { log('No pending notes'); setStatus('idle'); isPosting = false; return; }

    log(notes.length + ' note(s) to post — opening Tebra');
    setStatus('posting');
    await ensureBrowser();

    // Single shared page for the whole batch — matches the proven working
    // pattern. Per-note fresh pages caused Tebra dashboard re-navigation
    // on every note, which sometimes timed out waiting for the search box
    // even though the page was mostly loaded (Angular SPA networkidle is flaky).
    const page = await context.newPage();
    page.on('dialog', async dialog => { await dialog.accept(); });

    try {
      await ensureTebraLoggedIn(page);

      for (const note of notes) {
        log('Processing note for: ' + note.patient_name);
        try {
          const ehrNoteId = await postNoteToTebra(page, note);
          await markComplete(token, note.note_id, ehrNoteId);
          log('✓ Posted: ' + note.patient_name, 'success');
        } catch(noteErr) {
          log('✗ Failed: ' + note.patient_name + ' — ' + noteErr.message + ' — retrying once', 'warn');

          // Retry once on the SAME page — re-verify login first in case
          // the failure was a session hiccup, but don't open a new page
          try {
            await ensureTebraLoggedIn(page);
            const ehrNoteId = await postNoteToTebra(page, note);
            await markComplete(token, note.note_id, ehrNoteId);
            log('✓ Posted on retry: ' + note.patient_name, 'success');
          } catch(retryErr) {
            log('✗ Failed after retry: ' + note.patient_name + ' — ' + retryErr.message, 'error');
            await markFailed(token, note.note_id, retryErr.message);
          }
        }
      }
    } finally {
      try { await page.close(); } catch(e) {}
    }

    setStatus('idle');
  } catch(err) {
    log('Poll error: ' + err.message, 'error');
    setStatus('error');
  } finally {
    isPosting = false;
  }
}

// ============================================================
// PUBLIC API
// ============================================================
module.exports = {
  start(opts = {}) {
    logCallback    = opts.onLog    || null;
    statusCallback = opts.onStatus || null;
    log('Chrysalis Bridge starting…');
    log('Polling every 60 seconds');
    pollAndProcess();
    pollTimer = setInterval(pollAndProcess, POLL_INTERVAL);
  },

  stop() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (context) {
      try { context.close(); } catch(e) {}
      context = null;
      keepAlivePage = null;
    }
    log('Bridge stopped');
    setStatus('stopped');
  },

  async pollNow() {
    log('Manual poll triggered');
    await pollAndProcess();
  },

  async syncPatients() {
    log('Manual calendar sync triggered');
    setStatus('syncing');
    try {
      const token = await getChrysalisToken();
      await ensureBrowser();
      await syncTodayPatients(token);
    } catch(e) {
      log('Sync error: ' + e.message, 'error');
    }
    setStatus('idle');
  },

  isRunning() { return pollTimer !== null; },
};
