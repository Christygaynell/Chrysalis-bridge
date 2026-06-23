'use strict';

const Store = require('electron-store');

// Credentials stored locally on Dr. Thompson's machine
// Never transmitted to Chrysalis servers
const store = new Store({
  name: 'chrysalis-bridge-credentials',
  encryptionKey: 'chrysalis-bridge-2026-local-only',
});

module.exports = {

  // ── Chrysalis credentials ──────────────────────────────────────
  getChrysalisToken() {
    return store.get('chrysalis_token', null);
  },

  setChrysalisToken(token) {
    store.set('chrysalis_token', token);
  },

  getChrysalisEmail() {
    return store.get('chrysalis_email', '');
  },

  setChrysalisEmail(email) {
    store.set('chrysalis_email', email);
  },

  getChrysalisPassword() {
    return store.get('chrysalis_password', '');
  },

  setChrysalisPassword(password) {
    store.set('chrysalis_password', password);
  },

  // ── Tebra credentials ─────────────────────────────────────────
  getTebraEmail() {
    return store.get('tebra_email', '');
  },

  setTebraEmail(email) {
    store.set('tebra_email', email);
  },

  getTebraPassword() {
    return store.get('tebra_password', '');
  },

  setTebraPassword(password) {
    store.set('tebra_password', password);
  },

  // ── Settings ──────────────────────────────────────────────────
  isSetupComplete() {
    return !!(
      store.get('chrysalis_email') &&
      store.get('chrysalis_password') &&
      store.get('tebra_email') &&
      store.get('tebra_password')
    );
  },

  clearAll() {
    store.clear();
  },

};
