'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  getSettings:     ()       => ipcRenderer.invoke('get-settings'),
  saveSettings:    (data)   => ipcRenderer.invoke('save-settings', data),
  testChrysalis:   ()       => ipcRenderer.invoke('test-chrysalis'),
  pollNow:         ()       => ipcRenderer.invoke('poll-now'),
  startBridge:     ()       => ipcRenderer.invoke('start-bridge'),
  stopBridge:      ()       => ipcRenderer.invoke('stop-bridge'),
  bridgeStatus:    ()       => ipcRenderer.invoke('bridge-status'),
  onLogEntry:      (cb)     => ipcRenderer.on('log-entry',   (e, entry)   => cb(entry)),
  onLogHistory:    (cb)     => ipcRenderer.on('log-history', (e, entries) => cb(entries)),
});
