const { app, BrowserWindow, ipcMain, screen, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

// Impor modul backend
const db = require('./src/server/db');
const discovery = require('./src/server/discovery');
const websocket = require('./src/server/websocket');
const whatsapp = require('./src/server/whatsapp');

let mainWindow = null;
let displayWindow = null;
let currentMode = 'server'; // default mode
let isDiscoveryRunning = false;

// Inisialisasi Aplikasi
app.whenReady().then(async () => {
  // 1. Inisialisasi Database SQLite
  try {
    await db.initDb();
    console.log("Database initialized successfully.");
  } catch (err) {
    console.error("Database initialization failed:", err);
  }

  // 2. Baca konfigurasi mode dari database
  const settings = await db.getSettings();
  currentMode = settings.app_mode || 'server';

  // 3. Jalankan service sesuai mode
  await startServicesBasedOnMode(settings);

  // 4. Buat Window Utama (Operator)
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  // Hentikan service sebelum keluar
  discovery.stopBroadcaster();
  discovery.stopDiscoveryListener();
  websocket.stopWebSocketServer();
  whatsapp.stopWhatsAppClient();
  
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Membuat Window Utama (Operator Panel)
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    show: false,
    title: "SimpleAntrian - Operator Panel"
  });

  mainWindow.loadFile(path.join(__dirname, 'src/renderer/operator.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    // Jika window utama ditutup, tutup juga layar display
    if (displayWindow) {
      displayWindow.close();
    }
  });
}

// Menjalankan/Menghentikan service secara dinamis
async function startServicesBasedOnMode(settings) {
  const wsPort = parseInt(settings.port || '8080');
  const serverUuid = settings.server_uuid;
  const serverName = settings.server_name || 'Server Antrian';

  if (currentMode === 'server') {
    // Stop Client discovery
    discovery.stopDiscoveryListener();
    isDiscoveryRunning = false;

    // Jalankan WS Server
    websocket.startWebSocketServer(wsPort);
    // Jalankan UDP Broadcaster
    discovery.startBroadcaster(serverUuid, serverName, wsPort);
    // Jalankan WA Client
    whatsapp.startWhatsAppClient();
  } else {
    // Mode Client: Matikan WS Server & Broadcaster
    websocket.stopWebSocketServer();
    discovery.stopBroadcaster();
    whatsapp.stopWhatsAppClient();

    // Jalankan UDP Discovery Listener
    discovery.startDiscoveryListener((servers) => {
      // Kirim daftar server ke renderer process
      if (mainWindow) {
        mainWindow.webContents.send('servers-updated', servers);
      }
    });
    isDiscoveryRunning = true;
  }
}

// ==================== IPC HANDLERS ====================

// Info Sistem & Mode
ipcMain.handle('get-system-info', async () => {
  const settings = await db.getSettings();
  return {
    mode: currentMode,
    serverUuid: settings.server_uuid,
    serverName: settings.server_name,
    port: settings.port,
    localIp: discovery.getLocalIp()
  };
});

ipcMain.handle('save-mode-settings', async (event, modeSettings) => {
  const { mode, serverName, port } = modeSettings;
  
  currentMode = mode;
  await db.saveSetting('app_mode', mode);
  await db.saveSetting('server_name', serverName);
  await db.saveSetting('port', port);
  
  const settings = await db.getSettings();
  await startServicesBasedOnMode(settings);
  
  return { success: true };
});

// Pengaturan DB Umum
ipcMain.handle('get-settings', () => db.getSettings());
ipcMain.handle('save-setting', (event, key, value) => db.saveSetting(key, value));

// Deteksi Monitor & Window Display Layar Kedua
ipcMain.handle('get-monitors', () => {
  return screen.getAllDisplays().map((d, index) => ({
    index,
    id: d.id,
    bounds: d.bounds,
    workArea: d.workArea,
    isPrimary: d.bounds.x === 0 && d.bounds.y === 0
  }));
});

ipcMain.handle('open-display-window', () => {
  if (displayWindow) {
    displayWindow.focus();
    return true;
  }

  const displays = screen.getAllDisplays();
  let externalDisplay = displays.find((display) => {
    return display.bounds.x !== 0 || display.bounds.y !== 0;
  });

  const windowOptions = {
    width: 1024,
    height: 768,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    title: "SimpleAntrian - Customer Display"
  };

  if (externalDisplay) {
    // Jika ada monitor kedua (Extended), buka langsung fullscreen di sana
    windowOptions.x = externalDisplay.bounds.x;
    windowOptions.y = externalDisplay.bounds.y;
    windowOptions.fullscreen = true;
    windowOptions.frame = false;
  } else {
    // Jika hanya 1 monitor, buka windowed biasa
    windowOptions.center = true;
  }

  displayWindow = new BrowserWindow(windowOptions);
  displayWindow.loadFile(path.join(__dirname, 'src/renderer/display.html'));

  displayWindow.on('closed', () => {
    displayWindow = null;
  });

  return true;
});

ipcMain.handle('close-display-window', () => {
  if (displayWindow) {
    displayWindow.close();
    displayWindow = null;
    return true;
  }
  return false;
});

ipcMain.handle('is-display-window-open', () => {
  return displayWindow !== null;
});

// Database Pass-through
ipcMain.handle('get-daily-stats', (event, dateStr) => db.getDailyStats(dateStr));
ipcMain.handle('search-tickets', (event, query, status, serviceId, dateStr) => db.searchTickets(query, status, serviceId, dateStr));
ipcMain.handle('get-services', () => db.getServices());
ipcMain.handle('add-service', (event, name, prefix) => db.addService(require('crypto').randomUUID().substring(0, 8), name, prefix));
ipcMain.handle('delete-service', (event, id) => db.deleteService(id));
ipcMain.handle('reset-all-queues', () => db.resetAllQueues());

// Export & Import Handlers
ipcMain.handle('export-data', async () => {
  if (!mainWindow) return { success: false };

  const { filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Backup Database Antrian',
    defaultPath: path.join(app.getPath('documents'), 'simple-antrian-backup.sqlite'),
    filters: [{ name: 'SQLite Database', extensions: ['sqlite', 'db'] }]
  });

  if (filePath) {
    try {
      await db.backupDatabase(filePath);
      // Ekspor juga ke file CSV laporan untuk kemudahan user
      const csvPath = filePath.replace(/\.(sqlite|db)$/i, '.csv');
      const tickets = await db.getTickets();
      let csvContent = 'ID,Nomor Tiket,Layanan,Nama Pelanggan,No. Telepon,Status,Loket,Dibuat Pada,Dipanggil Pada,Selesai Pada\n';
      tickets.forEach(t => {
        csvContent += `"${t.id}","${t.ticket_number}","${t.service_name}","${t.customer_name || ''}","${t.customer_phone || ''}","${t.status}","${t.desk_number || ''}","${t.created_at || ''}","${t.called_at || ''}","${t.completed_at || ''}"\n`;
      });
      fs.writeFileSync(csvPath, csvContent, 'utf-8');

      return { success: true, message: `Backup berhasil di-save di ${filePath} dan laporan CSV di ${csvPath}` };
    } catch (err) {
      console.error("Backup failed:", err);
      return { success: false, message: `Gagal membuat backup: ${err.message}` };
    }
  }
  return { success: false, message: 'Batal ekspor.' };
});

ipcMain.handle('import-data', async () => {
  if (!mainWindow) return { success: false };

  const { filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Restore Database Antrian',
    filters: [{ name: 'SQLite Database', extensions: ['sqlite', 'db'] }],
    properties: ['openFile']
  });

  if (filePaths && filePaths.length > 0) {
    try {
      await db.restoreDatabase(filePaths[0]);
      // Broadcast state baru ke semua client ws yang sedang aktif
      websocket.broadcastStateUpdate();
      return { success: true, message: 'Database berhasil direstore. Silakan muat ulang halaman jika diperlukan.' };
    } catch (err) {
      console.error("Restore failed:", err);
      return { success: false, message: `Gagal merestore database: ${err.message}` };
    }
  }
  return { success: false, message: 'Batal impor.' };
});

ipcMain.handle('wa-perform-update', () => whatsapp.performLibraryUpdate());
