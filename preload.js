const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Mode & System Info
  getSystemInfo: () => ipcRenderer.invoke('get-system-info'),
  saveModeSettings: (settings) => ipcRenderer.invoke('save-mode-settings', settings),
  
  // Settings (Database)
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSetting: (key, value) => ipcRenderer.invoke('save-setting', key, value),
  
  // Export / Import
  exportData: () => ipcRenderer.invoke('export-data'),
  importData: () => ipcRenderer.invoke('import-data'),
  
  // Dual Screen / Monitors
  getMonitors: () => ipcRenderer.invoke('get-monitors'),
  openDisplayWindow: () => ipcRenderer.invoke('open-display-window'),
  closeDisplayWindow: () => ipcRenderer.invoke('close-display-window'),
  isDisplayWindowOpen: () => ipcRenderer.invoke('is-display-window-open'),
  performWaUpdate: () => ipcRenderer.invoke('wa-perform-update'),

  // UDP Discovery (Client Mode)
  onServersUpdated: (callback) => {
    // Remove existing listener before adding a new one to prevent memory leaks
    ipcRenderer.removeAllListeners('servers-updated');
    ipcRenderer.on('servers-updated', (event, servers) => callback(servers));
  },
  
  // Stats (Database)
  getDailyStats: (dateStr) => ipcRenderer.invoke('get-daily-stats', dateStr),
  searchTickets: (query, status, serviceId, dateStr) => ipcRenderer.invoke('search-tickets', query, status, serviceId, dateStr),
  getServices: () => ipcRenderer.invoke('get-services'),
  addService: (name, prefix) => ipcRenderer.invoke('add-service', name, prefix),
  deleteService: (id) => ipcRenderer.invoke('delete-service', id),
  resetAllQueues: () => ipcRenderer.invoke('reset-all-queues')
});
