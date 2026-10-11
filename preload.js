/** Мост IPC: окно настроек не получает Node — только эти методы. */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rsmine', {
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (data) => ipcRenderer.invoke('settings:save', data),
  getStatus: () => ipcRenderer.invoke('status:get'),
  onStatus: (cb) => ipcRenderer.on('status', (_e, st) => cb(st)),
  testLzt: () => ipcRenderer.invoke('test:lzt'),
  listDonations: () => ipcRenderer.invoke('donations:list'),
  replayDonation: (invoiceId) => ipcRenderer.invoke('donations:replay', invoiceId),
  hideDonation: (invoiceId) => ipcRenderer.invoke('donations:hide', invoiceId),
  unhideDonation: (invoiceId) => ipcRenderer.invoke('donations:unhide', invoiceId),
  onDonations: (cb) => ipcRenderer.on('donations', (_e, log) => cb(log)),
});
