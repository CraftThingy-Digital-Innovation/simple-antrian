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
  openDisplayWindow: (options) => ipcRenderer.invoke('open-display-window', options),
  updateDisplayTarget: (options) => ipcRenderer.invoke('update-display-target', options),
  closeDisplayWindow: () => ipcRenderer.invoke('close-display-window'),
  isDisplayWindowOpen: () => ipcRenderer.invoke('is-display-window-open'),
  openKioskWindow: () => ipcRenderer.invoke('open-kiosk-window'),
  closeKioskWindow: () => ipcRenderer.invoke('close-kiosk-window'),
  isKioskWindowOpen: () => ipcRenderer.invoke('is-kiosk-window-open'),
  addVideoFile: () => ipcRenderer.invoke('add-video-file'),
  // Local Media Folder: folder lokal per-mesin untuk video/foto tanpa HTTP streaming
  selectLocalMediaFolder: () => ipcRenderer.invoke('select-local-media-folder'),
  getLocalMediaFolder: () => ipcRenderer.invoke('get-local-media-folder'),
  clearLocalMediaFolder: () => ipcRenderer.invoke('clear-local-media-folder'),
  // Mini Operator Window: restore jendela utama
  restoreMainWindow: () => ipcRenderer.invoke('restore-main-window'),
  performWaUpdate: () => ipcRenderer.invoke('wa-perform-update'),
  checkAppUpdates: () => ipcRenderer.invoke('check-app-updates'),
  onAppUpdateAvailable: (callback) => {
    ipcRenderer.removeAllListeners('app-update-available');
    ipcRenderer.on('app-update-available', (event, info) => callback(info));
  },
  performAppUpdate: (downloadUrl) => ipcRenderer.invoke('perform-app-update', downloadUrl),
  onUpdateProgress: (callback) => {
    ipcRenderer.removeAllListeners('update-progress');
    ipcRenderer.on('update-progress', (event, info) => callback(info));
  },

  // UDP Discovery (Client Mode)
  refreshDiscovery: (customTarget) => ipcRenderer.invoke('refresh-discovery', customTarget),
  onServersUpdated: (callback) => {
    // Remove existing listener before adding a new one to prevent memory leaks
    ipcRenderer.removeAllListeners('servers-updated');
    ipcRenderer.on('servers-updated', (event, servers) => callback(servers));
  },

  // Endpoint Sync (Display & Kiosk)
  setActiveServerEndpoint: (endpoint) => ipcRenderer.invoke('set-active-server-endpoint', endpoint),
  onServerPortUpdated: (callback) => {
    ipcRenderer.removeAllListeners('server-port-updated');
    ipcRenderer.on('server-port-updated', (event, port) => callback(port));
  },
  onServerEndpointChanged: (callback) => {
    ipcRenderer.removeAllListeners('server-endpoint-changed');
    ipcRenderer.on('server-endpoint-changed', (event, endpoint) => callback(endpoint));
  },
  
  // Stats (Database)
  getDailyStats: (dateStr) => ipcRenderer.invoke('get-daily-stats', dateStr),
  searchTickets: (query, status, serviceId, dateStr) => ipcRenderer.invoke('search-tickets', query, status, serviceId, dateStr),
  getServices: () => ipcRenderer.invoke('get-services'),
  addService: (name, prefix) => ipcRenderer.invoke('add-service', name, prefix),
  deleteService: (id) => ipcRenderer.invoke('delete-service', id),
  resetAllQueues: () => ipcRenderer.invoke('reset-all-queues'),
  openExternalUrl: (url) => ipcRenderer.invoke('open-external-url', url),
  getShareableWindows: () => ipcRenderer.invoke('get-shareable-windows'),
  findWindowIdByName: (name) => ipcRenderer.invoke('find-window-id-by-name', name),

  // WhatsApp Auth
  waStartQr: () => ipcRenderer.invoke('wa-start-qr'),
  waStartPairing: (phone) => ipcRenderer.invoke('wa-start-pairing', phone)
});
