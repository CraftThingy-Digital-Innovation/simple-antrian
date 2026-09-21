const { app, BrowserWindow, ipcMain, screen, dialog, shell, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');

// Matikan Autoplay Policy agar audio bisa berputar otomatis tanpa interaksi user
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// GPU Hardware Acceleration & Background Throttling Switches untuk video playback 60 FPS lancar
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-accelerated-video-decode');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

// Sanitasi data sensitif untuk telemetry log
function sanitizeLogMessage(msg) {
  if (typeof msg !== 'string') return msg;
  let sanitized = msg;

  // 1. Redact Kode Penyandingan WhatsApp (e.g. ABCD-1234 atau 8 digit kode penyandingan)
  sanitized = sanitized.replace(/Kode Penyandingan:\s*([A-Za-z0-9]{4}-[A-Za-z0-9]{4})/gi, 'Kode Penyandingan: ****-****');
  sanitized = sanitized.replace(/([A-Za-z0-9]{4}-[A-Za-z0-9]{4})/gi, (match) => {
    if (/^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/.test(match)) {
      return '****-****';
    }
    return match;
  });

  // 2. Redact Nomor Telepon (e.g. 08123456789, 628123456789, +628123456789)
  // Ganti digit di tengah dengan asterisk, sisakan 3 digit depan dan 3 digit belakang (e.g. 081******789)
  sanitized = sanitized.replace(/(?:\+?62|0)8[0-9]{8,11}/g, (phone) => {
    if (phone.length >= 9) {
      return phone.substring(0, 3) + '*'.repeat(phone.length - 6) + phone.substring(phone.length - 3);
    }
    return phone;
  });

  // 3. Redact Data Sensitif di dalam objek JSON/Payload (e.g. "phone":"...", "name":"...")
  sanitized = sanitized.replace(/"phone"\s*:\s*"([^"]+)"/g, (match, p1) => {
    const maskedPhone = p1.length >= 6 
      ? p1.substring(0, 3) + '*'.repeat(p1.length - 6) + p1.substring(p1.length - 3)
      : '***';
    return `"phone":"${maskedPhone}"`;
  });
  sanitized = sanitized.replace(/"name"\s*:\s*"([^"]+)"/g, (match, p1) => {
    if (p1.trim() === '') return match;
    const maskedName = p1.length > 2 
      ? p1.charAt(0) + '*'.repeat(p1.length - 2) + p1.charAt(p1.length - 1)
      : '***';
    return `"name":"${maskedName}"`;
  });

  return sanitized;
}

// Redirect console logs to a local file for debugging
const debugLogPath = app ? path.join(app.getPath('userData'), 'app-debug.log') : path.join(__dirname, 'app-debug.log');
const LOG_MAX_SIZE = 5 * 1024 * 1024; // 5MB max log size
const logStdout = process.stdout;

// Rotasi log: hapus file lama jika melebihi batas ukuran saat startup
try {
  if (fs.existsSync(debugLogPath) && fs.statSync(debugLogPath).size > LOG_MAX_SIZE) {
    const archivePath = debugLogPath + '.old';
    try { fs.unlinkSync(archivePath); } catch (_) {}
    fs.renameSync(debugLogPath, archivePath);
  }
} catch (_) {}

console.log = function (...args) {
  const rawMsg = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' ') + '\n';
  const msg = sanitizeLogMessage(rawMsg);
  try {
    fs.appendFileSync(debugLogPath, `[LOG] ${new Date().toISOString()} - ${msg}`);
  } catch (e) {}
  logStdout.write(msg);
};

console.error = function (...args) {
  const rawMsg = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' ') + '\n';
  const msg = sanitizeLogMessage(rawMsg);
  try {
    fs.appendFileSync(debugLogPath, `[ERR] ${new Date().toISOString()} - ${msg}`);
  } catch (e) {}
  logStdout.write(msg);
};

console.warn = function (...args) {
  const rawMsg = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' ') + '\n';
  const msg = sanitizeLogMessage(rawMsg);
  try {
    fs.appendFileSync(debugLogPath, `[WRN] ${new Date().toISOString()} - ${msg}`);
  } catch (e) {}
  logStdout.write(msg);
};

process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err.stack || err);
});
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION:', reason.stack || reason || 'Unknown Rejection');
});

// Impor modul backend
const db = require('./src/server/db');
const discovery = require('./src/server/discovery');
const websocket = require('./src/server/websocket');
const whatsapp = require('./src/server/whatsapp');

let mainWindow = null;
let displayWindow = null;
let miniOperatorWindow = null; // Jendela kecil mengambang saat operator diminimalkan
let currentDisplayMonitorId = null;
let kioskWindow = null;
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
  
  const hasClientArg = process.argv.includes('--client') || process.argv.includes('-c');
  const hasServerArg = process.argv.includes('--server') || process.argv.includes('-s');
  const isClientName = path.basename(process.execPath).toLowerCase().includes('client');

  if (hasClientArg || isClientName) {
    currentMode = 'client';
    console.log("[Mode Overridden] Dipaksa berjalan sebagai CLIENT karena parameter command line atau nama file.");
  } else if (hasServerArg) {
    currentMode = 'server';
    console.log("[Mode Overridden] Dipaksa berjalan sebagai SERVER karena parameter command line.");
  } else {
    currentMode = settings.app_mode || 'select-mode';
  }

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

// Helper to pipe console logs/errors from renderer processes (Chromium) to main process logs
function captureWindowLogs(win, name) {
  if (!win) return;
  win.webContents.on('console-message', (event, level, message, line, sourceId) => {
    const levels = ['DEBUG', 'LOG', 'WARNING', 'ERROR'];
    const lvl = levels[level] || 'LOG';
    const cleanSource = sourceId ? path.basename(sourceId) : 'unknown';
    if (lvl === 'ERROR') {
      console.error(`[Renderer ${name} - ${lvl}] ${message} (at ${cleanSource}:${line})`);
    } else {
      console.log(`[Renderer ${name} - ${lvl}] ${message} (at ${cleanSource}:${line})`);
    }
  });
}

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
      nodeIntegration: false,
      backgroundThrottling: false
    },
    show: false,
    title: "SimpleAntrian - Operator Panel"
  });

  captureWindowLogs(mainWindow, 'Operator');

  if (currentMode === 'select-mode') {
    mainWindow.loadFile(path.join(__dirname, 'src/renderer/select-mode.html'));
  } else {
    mainWindow.loadFile(path.join(__dirname, 'src/renderer/operator.html'));
  }

  // Lindungi layar customer display agar jendela operator tidak bisa menyasar ke monitor display
  setupMainWindowScreenConstraint();

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    // Cek pembaruan aplikasi dari GitHub secara otomatis pada startup
    setTimeout(checkAppUpdates, 3000);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    // Jika window utama ditutup, tutup juga layar display, kiosk, dan mini operator
    if (displayWindow) displayWindow.close();
    if (kioskWindow) kioskWindow.close();
    if (miniOperatorWindow) { miniOperatorWindow.close(); miniOperatorWindow = null; }
  });

  // Saat operator diminimalkan -> tampilkan mini floating window
  mainWindow.on('minimize', () => {
    createMiniOperatorWindow();
  });

  // Saat operator di-restore -> tutup mini floating window
  mainWindow.on('restore', () => {
    if (miniOperatorWindow) {
      miniOperatorWindow.close();
      miniOperatorWindow = null;
    }
  });

  mainWindow.on('focus', () => {
    if (miniOperatorWindow) {
      miniOperatorWindow.close();
      miniOperatorWindow = null;
    }
  });
}

// Membuat Mini Operator Window (floating, always-on-top, draggable)
function createMiniOperatorWindow() {
  if (miniOperatorWindow) return; // Sudah terbuka

  const { screen } = require('electron');
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenW, height: screenH } = primaryDisplay.workAreaSize;

  // Posisi di pojok kanan bawah
  const winWidth = 295;
  const winHeight = 550;
  const x = screenW - winWidth - 16;
  const y = screenH - winHeight - 16;

  miniOperatorWindow = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    x: x,
    y: y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    movable: true,
    hasShadow: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    },
    title: 'SimpleAntrian - Mini Operator'
  });

  miniOperatorWindow.loadFile(path.join(__dirname, 'src/renderer/mini-operator.html'));

  miniOperatorWindow.on('closed', () => {
    miniOperatorWindow = null;
  });

  console.log('[Main] Mini Operator window dibuka di posisi', x, y);
}

const net = require('net');

function isPortAvailable(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once('error', () => resolve(false));
    tester.once('listening', () => {
      tester.close(() => resolve(true));
    });
    tester.listen(port, host);
  });
}

async function resolveAvailableServerPort(desiredPort) {
  let port = parseInt(desiredPort, 10) || 8080;
  const isFree127 = await isPortAvailable(port, '127.0.0.1');
  const isFree0 = await isPortAvailable(port, '0.0.0.0');
  if (isFree127 && isFree0) {
    return port;
  }
  console.warn(`[Main] Port ${port} sedang digunakan oleh aplikasi lain (misal PHP/Laragon/Web server). Mencari port pengganti...`);
  const candidatePorts = [8088, 8082, 8083, 8084, 8085, 8089, 8090];
  for (const p of candidatePorts) {
    const free127 = await isPortAvailable(p, '127.0.0.1');
    const free0 = await isPortAvailable(p, '0.0.0.0');
    if (free127 && free0) {
      console.log(`[Main] Menggunakan port bebas pengganti: ${p}`);
      await db.saveSetting('port', p.toString());
      return p;
    }
  }
  return port;
}

const runtimeServerUuid = require('crypto').randomUUID();

// Menjalankan/Menghentikan service secara dinamis
async function startServicesBasedOnMode(settings) {
  let wsPort = parseInt(settings.port || '8080', 10);
  if (currentMode === 'server') {
    wsPort = await resolveAvailableServerPort(wsPort);
  }
  const serverUuid = runtimeServerUuid;
  const serverName = settings.server_name || 'Server Antrian';

  if (currentMode === 'select-mode') {
    // Mode pemilihan: Pastikan semua service mati
    websocket.stopWebSocketServer();
    discovery.stopBroadcaster();
    discovery.stopDiscoveryListener();
    whatsapp.stopWhatsAppClient();
    return;
  }

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

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('server-port-updated', wsPort);
    }
  } else {
    // Mode Client: Matikan WS Server & Broadcaster
    websocket.stopWebSocketServer();
    discovery.stopBroadcaster();
    whatsapp.stopWhatsAppClient();

    // Muat endpoint server yang tersimpan ke daftar known servers
    if (settings && settings.active_server_endpoint) {
      discovery.addKnownServer(settings.active_server_endpoint);
    }

    // Jalankan UDP Discovery Listener
    discovery.startDiscoveryListener((servers) => {
      // Kirim daftar server ke semua renderer window yang aktif
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('servers-updated', servers);
      }
      if (displayWindow && !displayWindow.isDestroyed()) {
        displayWindow.webContents.send('servers-updated', servers);
      }
      if (kioskWindow && !kioskWindow.isDestroyed()) {
        kioskWindow.webContents.send('servers-updated', servers);
      }
    });
    isDiscoveryRunning = true;
  }
}

// ==================== IPC HANDLERS ====================

// Info Sistem & Mode
ipcMain.handle('get-system-info', async () => {
  const settings = await db.getSettings();
  const appVersion = require('./package.json').version;
  // videoDir dikirim ke display.js agar bisa gunakan file:// langsung (bypass HTTP server bottleneck)
  const videoDir = app ? path.join(app.getPath('userData'), 'data', 'videos') : path.join(process.cwd(), 'data', 'videos');
  return {
    mode: currentMode,
    serverUuid: runtimeServerUuid,
    serverName: settings.server_name || 'Server Antrian',
    port: settings.port || '8080',
    localIp: discovery.getLocalIp(),
    allLocalIps: discovery.getAllLocalIps(),
    appVersion: appVersion,
    videoDir: videoDir
  };
});

ipcMain.handle('save-mode-settings', async (event, modeSettings) => {
  const { mode, serverName, port } = modeSettings;
  
  currentMode = mode;
  await db.saveSetting('app_mode', mode);
  const existingName = await db.getSetting('server_name');
  const effectiveServerName = (serverName && serverName.trim()) || existingName || 'Server Utama';
  await db.saveSetting('server_name', effectiveServerName);
  if (port) await db.saveSetting('port', port);
  
  const settings = await db.getSettings();
  await startServicesBasedOnMode(settings);
  
  return { success: true };
});

// Refresh / Trigger Scan UDP Discovery (Mode Client)
ipcMain.handle('refresh-discovery', async (event, customTarget) => {
  if (currentMode === 'client') {
    await discovery.sendDiscoveryQuery(customTarget);
    return discovery.getDiscoveredServersList();
  }
  return [];
});

// Pengaturan DB Umum
ipcMain.handle('get-settings', () => db.getSettings());
ipcMain.handle('save-setting', async (event, key, value) => {
  const res = await db.saveSetting(key, value);
  if (key === 'server_name' && currentMode === 'server') {
    discovery.updateBroadcasterDetails(value, null);
  } else if (key === 'port' && currentMode === 'server') {
    discovery.updateBroadcasterDetails(null, parseInt(value));
  }
  return res;
});
ipcMain.handle('set-active-server-endpoint', (event, endpoint) => {
  if (displayWindow && !displayWindow.isDestroyed()) {
    displayWindow.webContents.send('server-endpoint-changed', endpoint);
  }
  if (kioskWindow && !kioskWindow.isDestroyed()) {
    kioskWindow.webContents.send('server-endpoint-changed', endpoint);
  }
  return true;
});

// Helper untuk menempatkan dan mengunci Display Window di monitor target
// Cegah jendela admin/operator masuk ke monitor yang dipakai oleh Customer Display
function checkAndConstrainMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed() || !displayWindow || displayWindow.isDestroyed() || !currentDisplayMonitorId) return;
  const displays = screen.getAllDisplays();
  if (displays.length <= 1) return;

  const targetDisplay = displays.find(d => String(d.id) === String(currentDisplayMonitorId));
  if (!targetDisplay) return;

  const bounds = mainWindow.getBounds();
  const midX = bounds.x + bounds.width / 2;
  const midY = bounds.y + bounds.height / 2;
  const displayBounds = targetDisplay.bounds;

  const isInsideDisplayScreen = (
    midX >= displayBounds.x && midX < displayBounds.x + displayBounds.width &&
    midY >= displayBounds.y && midY < displayBounds.y + displayBounds.height
  );

  if (isInsideDisplayScreen) {
    const allowedDisplay = displays.find(d => String(d.id) !== String(currentDisplayMonitorId)) || screen.getPrimaryDisplay();
    if (allowedDisplay) {
      mainWindow.setPosition(allowedDisplay.workArea.x + 40, allowedDisplay.workArea.y + 40);
    }
  }
}

function setupMainWindowScreenConstraint() {
  if (!mainWindow) return;
  mainWindow.on('move', checkAndConstrainMainWindow);
}

function applyTargetDisplay(win, targetMonitorId = 'auto', isLocked = true) {
  if (!win || win.isDestroyed()) return;
  const displays = screen.getAllDisplays();
  const primaryDisplay = screen.getPrimaryDisplay();
  let targetDisplay = null;

  if (targetMonitorId && targetMonitorId !== 'auto') {
    targetDisplay = displays.find(d => String(d.id) === String(targetMonitorId) || String(d.index) === String(targetMonitorId));
  }

  if (!targetDisplay) {
    // Deteksi otomatis: utamakan display eksternal / sekunder jika ada
    targetDisplay = displays.find(d => d.id !== primaryDisplay.id) || primaryDisplay;
  }

  currentDisplayMonitorId = targetDisplay.id;

  // Set bounds sesuai monitor target
  win.setBounds(targetDisplay.bounds);

  if (isLocked) {
    // Mode Kiosk & Always On Top 'screen-saver' level agar tidak bisa tertutup atau terganggu aplikasi lain
    try {
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    } catch (_) {}
    win.setAlwaysOnTop(true, 'screen-saver', 1);
    win.setFullScreen(true);
    win.setKiosk(true);
  } else {
    win.setKiosk(false);
    win.setAlwaysOnTop(false);
    win.setFullScreen(true);
  }

  // Jika mainWindow berada di monitor display saat layar display diaktifkan, pindahkan mainWindow ke monitor operator
  checkAndConstrainMainWindow();
}

// Deteksi Monitor & Window Display Layar Kedua
ipcMain.handle('get-monitors', () => {
  const primaryDisplay = screen.getPrimaryDisplay();
  return screen.getAllDisplays().map((d, index) => {
    const isPrimary = d.id === primaryDisplay.id || (d.bounds.x === 0 && d.bounds.y === 0);
    return {
      index,
      id: d.id,
      bounds: d.bounds,
      workArea: d.workArea,
      isPrimary,
      label: `Monitor ${index + 1} (${d.bounds.width}x${d.bounds.height}${isPrimary ? ' - Layar Utama' : ' - Eksternal'})`
    };
  });
});

ipcMain.handle('open-display-window', (event, options = {}) => {
  const { targetMonitorId = 'auto', isLocked = true } = options;

  if (displayWindow && !displayWindow.isDestroyed()) {
    applyTargetDisplay(displayWindow, targetMonitorId, isLocked);
    displayWindow.focus();
    return true;
  }

  const displays = screen.getAllDisplays();
  const primaryDisplay = screen.getPrimaryDisplay();
  let targetDisplay = null;
  if (targetMonitorId && targetMonitorId !== 'auto') {
    targetDisplay = displays.find(d => String(d.id) === String(targetMonitorId) || String(d.index) === String(targetMonitorId));
  }
  if (!targetDisplay) {
    targetDisplay = displays.find(d => d.id !== primaryDisplay.id) || primaryDisplay;
  }

  const windowOptions = {
    x: targetDisplay.bounds.x,
    y: targetDisplay.bounds.y,
    width: targetDisplay.bounds.width,
    height: targetDisplay.bounds.height,
    fullscreen: true,
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    },
    title: "SimpleAntrian - Customer Display"
  };

  displayWindow = new BrowserWindow(windowOptions);
  captureWindowLogs(displayWindow, 'Display');
  displayWindow.loadFile(path.join(__dirname, 'src/renderer/display.html'));

  displayWindow.once('ready-to-show', () => {
    applyTargetDisplay(displayWindow, targetMonitorId, isLocked);
  });

  displayWindow.on('closed', () => {
    displayWindow = null;
    currentDisplayMonitorId = null;
  });

  return true;
});

ipcMain.handle('update-display-target', (event, options = {}) => {
  const { targetMonitorId = 'auto', isLocked = true } = options;
  if (displayWindow && !displayWindow.isDestroyed()) {
    applyTargetDisplay(displayWindow, targetMonitorId, isLocked);
    return true;
  }
  return false;
});

ipcMain.handle('close-display-window', () => {
  if (displayWindow) {
    displayWindow.close();
    displayWindow = null;
    currentDisplayMonitorId = null;
    return true;
  }
  return false;
});

ipcMain.handle('is-display-window-open', () => {
  return displayWindow !== null;
});

// Kiosk Mandiri (Layar Ketiga)
function openKioskWindow() {
  if (kioskWindow) {
    kioskWindow.focus();
    return true;
  }

  const displays = screen.getAllDisplays();
  // Cari layar ketiga (bukan primary dan bukan secondary)
  let kioskDisplay = displays.find((display) => {
    const isPrimary = display.bounds.x === 0 && display.bounds.y === 0;
    let isSecondary = false;
    if (displayWindow && !displayWindow.isDestroyed()) {
      const bounds = displayWindow.getBounds();
      isSecondary = display.bounds.x === bounds.x && display.bounds.y === bounds.y;
    }
    return !isPrimary && !isSecondary;
  });

  const windowOptions = {
    width: 1024,
    height: 768,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    title: "SimpleAntrian - Kiosk Mandiri"
  };

  if (kioskDisplay) {
    windowOptions.x = kioskDisplay.bounds.x;
    windowOptions.y = kioskDisplay.bounds.y;
    windowOptions.fullscreen = true;
    windowOptions.frame = false;
  } else {
    windowOptions.center = true;
  }

  kioskWindow = new BrowserWindow(windowOptions);
  captureWindowLogs(kioskWindow, 'Kiosk');
  kioskWindow.loadFile(path.join(__dirname, 'src/renderer/kiosk.html'));

  kioskWindow.on('closed', () => {
    kioskWindow = null;
  });

  return true;
}

ipcMain.handle('open-kiosk-window', () => openKioskWindow());

ipcMain.handle('close-kiosk-window', () => {
  if (kioskWindow) {
    kioskWindow.close();
    kioskWindow = null;
    return true;
  }
  return false;
});

ipcMain.handle('is-kiosk-window-open', () => {
  return kioskWindow !== null;
});

// IPC Handler: Pilih folder media lokal — tanpa copy, langsung pakai file://
// Setiap mesin (server/client) bisa pilih folder sendiri.
ipcMain.handle('select-local-media-folder', async () => {
  if (!mainWindow) return { success: false, message: 'Window utama tidak ditemukan.' };

  const { filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Pilih Folder Media Lokal (Video & Foto)',
    properties: ['openDirectory']
  });

  if (!filePaths || filePaths.length === 0) {
    return { success: false, message: 'Tidak ada folder dipilih.' };
  }

  const folderPath = filePaths[0];

  // Scan folder untuk file media
  const mediaFiles = scanMediaFolder(folderPath);

  // Simpan path ke file lokal (per-mesin, bukan di server DB)
  const configPath = app ? path.join(app.getPath('userData'), 'local-media-folder.json') : path.join(process.cwd(), 'local-media-folder.json');
  try {
    fs.writeFileSync(configPath, JSON.stringify({ folderPath, lastScan: Date.now() }), 'utf8');
  } catch (err) {
    console.error('[Local Media] Gagal menyimpan config:', err);
  }

  console.log('[Local Media] Folder dipilih:', folderPath, '- Ditemukan', mediaFiles.length, 'file media.');
  return { success: true, folderPath, mediaFiles };
});

// IPC Handler: Ambil folder media lokal yang sudah disimpan
ipcMain.handle('get-local-media-folder', async () => {
  const configPath = app ? path.join(app.getPath('userData'), 'local-media-folder.json') : path.join(process.cwd(), 'local-media-folder.json');
  try {
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (config.folderPath && fs.existsSync(config.folderPath)) {
        const mediaFiles = scanMediaFolder(config.folderPath);
        return { success: true, folderPath: config.folderPath, mediaFiles };
      }
    }
  } catch (err) {
    console.error('[Local Media] Gagal membaca config:', err);
  }
  return { success: false, folderPath: '', mediaFiles: [] };
});

// IPC Handler: Hapus setting folder media lokal
ipcMain.handle('clear-local-media-folder', async () => {
  const configPath = app ? path.join(app.getPath('userData'), 'local-media-folder.json') : path.join(process.cwd(), 'local-media-folder.json');
  try {
    if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
  } catch (_) {}
  return { success: true };
});

// Helper: Scan folder untuk menemukan file media (video & foto)
function scanMediaFolder(folderPath) {
  const mediaExtensions = ['.mp4','.webm','.ogg','.mkv','.mov','.avi','.flv','.wmv','.m4v','.3gp','.ts','.webp','.jpg','.jpeg','.png','.gif','.bmp','.svg','.avif'];
  const imageExtensions = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.svg', '.avif'];
  const results = [];

  try {
    const files = fs.readdirSync(folderPath);
    for (const file of files) {
      const ext = path.extname(file).toLowerCase();
      if (mediaExtensions.includes(ext)) {
        const fullPath = path.join(folderPath, file);
        try {
          const stat = fs.statSync(fullPath);
          if (stat.isFile()) {
            results.push({
              name: file,
              path: fullPath,
              type: imageExtensions.includes(ext) ? 'image' : 'video',
              size: stat.size,
              // URL file:// untuk digunakan langsung oleh Chromium
              fileUrl: 'file:///' + fullPath.replace(/\\/g, '/')
            });
          }
        } catch (_) {}
      }
    }
    // Sort abjad agar konsisten
    results.sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    console.error('[Local Media] Gagal scan folder:', err);
  }

  return results;
}

// IPC Handler: Ambil daftar printer yang terinstall di sistem
ipcMain.handle('get-printers', async (event) => {
  try {
    const printers = await event.sender.getPrintersAsync();
    return printers || [];
  } catch (err) {
    console.error('[Printer] Gagal mengambil daftar printer:', err);
    return [];
  }
});

// IPC Handler: Cetak tiket antrian (dialog OS atau silent langsung ke printer)
ipcMain.handle('print-ticket', async (event, options = {}) => {
  return new Promise((resolve) => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) {
        return resolve({ success: false, reason: 'Window tidak ditemukan' });
      }

      const isDialog = !options.deviceName || options.deviceName === '__DIALOG__';
      const printOptions = {
        silent: !isDialog,
        printBackground: true,
        margins: { marginType: 'none' }
      };

      if (!isDialog) {
        printOptions.deviceName = options.deviceName;
      }

      // Jika membuka dialog cetak OS, pastikan window difokuskan
      if (isDialog) {
        win.focus();
      }

      win.webContents.print(printOptions, (success, failureReason) => {
        if (!success) {
          console.warn('[Print] Result:', failureReason);
          resolve({ success: false, reason: failureReason });
        } else {
          resolve({ success: true });
        }
      });
    } catch (err) {
      console.error('[Print] Gagal mengeksekusi print:', err);
      resolve({ success: false, reason: err.message });
    }
  });
});

// IPC Handler: Restore jendela utama (dipanggil dari mini operator)
ipcMain.handle('restore-main-window', () => {
  if (mainWindow) {
    mainWindow.restore();
    mainWindow.focus();
  }
});

// IPC Handler to pick and copy local video or photo files to data/videos/
// IPC Handler to pick a folder, scan for all videos/photos, and copy them to data/videos/
ipcMain.handle('import-media-from-folder', async () => {
  if (!mainWindow) return { success: false, message: 'Window utama tidak ditemukan.' };

  const { filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Pilih Folder Berisi Foto atau Video untuk Playlist',
    properties: ['openDirectory']
  });

  if (!filePaths || filePaths.length === 0) {
    return { success: false, message: 'Batal memilih folder.' };
  }

  const selectedDir = filePaths[0];
  const videoDir = app ? path.join(app.getPath('userData'), 'data', 'videos') : path.join(process.cwd(), 'data', 'videos');
  if (!fs.existsSync(videoDir)) {
    fs.mkdirSync(videoDir, { recursive: true });
  }

  const crypto = require('crypto');
  const videoExtensions = ['.mp4', '.webm', '.ogg', '.mkv', '.mov', '.avi', '.flv', '.wmv', '.m4v', '.3gp', '.ts'];
  const imageExtensions = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.svg', '.avif'];
  const supportedExtensions = [...videoExtensions, ...imageExtensions];

  try {
    const entries = fs.readdirSync(selectedDir, { withFileTypes: true });
    const mediaList = [];

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!supportedExtensions.includes(ext)) continue;

      const srcPath = path.join(selectedDir, entry.name);
      const isImage = imageExtensions.includes(ext);
      const uniqueFilename = `${crypto.randomUUID()}${ext}`;
      const destPath = path.join(videoDir, uniqueFilename);

      try {
        fs.copyFileSync(srcPath, destPath);
        mediaList.push({
          id: crypto.randomUUID().substring(0, 8),
          type: isImage ? 'image' : 'video',
          originalName: entry.name,
          filename: uniqueFilename,
          url: `/video/${uniqueFilename}`
        });
      } catch (err) {
        console.error(`Gagal menyalin ${entry.name}:`, err);
      }
    }

    if (mediaList.length === 0) {
      return {
        success: false,
        message: `Tidak ditemukan berkas video atau foto yang didukung di dalam folder "${path.basename(selectedDir)}".`
      };
    }

    return {
      success: true,
      folderPath: selectedDir,
      folderName: path.basename(selectedDir),
      count: mediaList.length,
      mediaList: mediaList
    };
  } catch (err) {
    console.error('Error importing media from folder:', err);
    return { success: false, message: 'Gagal membaca folder: ' + err.message };
  }
});

ipcMain.handle('add-video-file', async () => {
  if (!mainWindow) return { success: false, message: 'Window utama tidak ditemukan.' };
  
  const { filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Pilih Berkas Video atau Foto untuk Playlist',
    filters: [
      { name: 'Semua Media (Video & Foto)', extensions: ['mp4', 'webm', 'ogg', 'mkv', 'mov', 'avi', 'flv', 'wmv', 'm4v', '3gp', 'ts', 'webp', 'jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'avif'] },
      { name: 'Video', extensions: ['mp4', 'webm', 'ogg', 'mkv', 'mov', 'avi', 'flv', 'wmv', 'm4v', '3gp', 'ts'] },
      { name: 'Foto / Gambar', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'svg', 'avif'] },
      { name: 'Semua Berkas (*.*)', extensions: ['*'] }
    ],
    properties: ['openFile', 'multiSelections']
  });
  
  if (filePaths && filePaths.length > 0) {
    const videoDir = app ? path.join(app.getPath('userData'), 'data', 'videos') : path.join(process.cwd(), 'data', 'videos');
    if (!fs.existsSync(videoDir)) {
      fs.mkdirSync(videoDir, { recursive: true });
    }
    
    const crypto = require('crypto');
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.svg', '.avif'];
    const mediaList = [];
    
    for (const srcPath of filePaths) {
      const ext = path.extname(srcPath).toLowerCase();
      const baseName = path.basename(srcPath);
      const isImage = imageExtensions.includes(ext);
      const uniqueFilename = `${crypto.randomUUID()}${ext}`;
      const destPath = path.join(videoDir, uniqueFilename);
      
      try {
        fs.copyFileSync(srcPath, destPath);
        mediaList.push({
          id: crypto.randomUUID().substring(0, 8),
          type: isImage ? 'image' : 'video',
          originalName: baseName,
          filename: uniqueFilename,
          url: `/video/${uniqueFilename}`
        });
      } catch (err) {
        console.error('Gagal menyalin berkas media:', err);
      }
    }
    
    if (mediaList.length > 0) {
      return {
        success: true,
        video: mediaList[0],
        mediaList: mediaList
      };
    } else {
      return { success: false, message: 'Gagal menyalin berkas media yang dipilih.' };
    }
  }
  return { success: false, message: 'Batal memilih berkas media.' };
});

// Database Pass-through
ipcMain.handle('get-daily-stats', (event, dateStr) => db.getDailyStats(dateStr));
ipcMain.handle('search-tickets', (event, query, status, serviceId, dateStr) => db.searchTickets(query, status, serviceId, dateStr));
ipcMain.handle('get-services', () => db.getServices());
ipcMain.handle('add-service', (event, name, prefix) => db.addService(require('crypto').randomUUID().substring(0, 8), name, prefix));
ipcMain.handle('delete-service', (event, id) => db.deleteService(id));
ipcMain.handle('reset-all-queues', () => db.resetAllQueues());

// Jendela Shareable & Window Mirroring
ipcMain.handle('get-shareable-windows', async () => {
  try {
    const sources = await desktopCapturer.getSources({ types: ['window', 'screen'] });
    return sources.map(src => ({
      id: src.id,
      name: src.name
    }));
  } catch (err) {
    console.error("Gagal mendapatkan daftar jendela shareable:", err);
    return [];
  }
});

ipcMain.handle('find-window-id-by-name', async (event, name) => {
  try {
    const sources = await desktopCapturer.getSources({ types: ['window', 'screen'] });
    const match = sources.find(src => src.name.toLowerCase().includes(name.toLowerCase()));
    return match ? match.id : null;
  } catch (err) {
    console.error("Gagal mencari ID jendela berdasarkan nama:", err);
    return null;
  }
});

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

ipcMain.handle('check-app-updates', async () => {
  return await checkAppUpdates();
});

// Helper untuk mengunduh file dengan progress indicator
function downloadFileWithProgress(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const fs = require('fs');
    const https = require('https');

    const download = (targetUrl) => {
      https.get(targetUrl, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          // Tangani redirect
          download(res.headers.location);
          return;
        }

        if (res.statusCode !== 200) {
          reject(new Error(`Server merespon dengan status: ${res.statusCode}`));
          return;
        }

        const totalBytes = parseInt(res.headers['content-length'], 10) || 0;
        let receivedBytes = 0;
        const fileStream = fs.createWriteStream(dest);

        res.on('data', (chunk) => {
          receivedBytes += chunk.length;
          fileStream.write(chunk);
          if (totalBytes > 0) {
            const percent = Math.round((receivedBytes / totalBytes) * 100);
            onProgress(percent);
          }
        });

        res.on('end', () => {
          fileStream.end();
          resolve();
        });

        res.on('error', (err) => {
          fileStream.destroy();
          try {
            if (fs.existsSync(dest)) fs.unlinkSync(dest);
          } catch (_) {}
          reject(err);
        });
      }).on('error', (err) => {
        reject(err);
      });
    };

    download(url);
  });
}

// Handler IPC untuk melakukan auto-update mandiri (Windows & Linux)
ipcMain.handle('perform-app-update', async (event, downloadUrl) => {
  if (!downloadUrl) {
    return { success: false, message: 'URL unduhan rilis tidak valid.' };
  }

  const isWin = process.platform === 'win32';
  const isLinux = process.platform === 'linux';

  if (!isWin && !isLinux) {
    return { success: false, message: 'Platform sistem operasi tidak didukung untuk auto-update.' };
  }

  try {
    const sendProgress = (status, percent) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update-progress', { status, percent });
      }
    };

    sendProgress('downloading', 0);

    const tempDir = app.getPath('temp');
    const archiveName = isWin ? 'SimpleAntrian-update.zip' : 'SimpleAntrian-update.tar.gz';
    const archivePath = path.join(tempDir, archiveName);
    const extractDir = path.join(tempDir, 'SimpleAntrian-extracted');

    // Hapus sisa unduhan lama jika ada
    if (fs.existsSync(archivePath)) fs.unlinkSync(archivePath);
    if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true, force: true });
    fs.mkdirSync(extractDir, { recursive: true });

    // 1. Download berkas arsip rilis
    await downloadFileWithProgress(downloadUrl, archivePath, (percent) => {
      sendProgress('downloading', percent);
    });

    sendProgress('extracting', 100);

    // 2. Ekstrak berkas menggunakan tar (bawaan Windows 10+ & Linux, aman dari antivirus)
    const { exec, spawn } = require('child_process');
    const extractCmd = isWin 
      ? `tar -xf "${archivePath}" -C "${extractDir}"`
      : `tar -xzf "${archivePath}" -C "${extractDir}"`;

    await new Promise((resolve, reject) => {
      exec(extractCmd, (err, stdout, stderr) => {
        if (err) {
          console.error("Gagal mengekstrak update:", stderr);
          reject(new Error("Gagal mengekstrak berkas arsip update."));
        } else {
          resolve();
        }
      });
    });

    sendProgress('installing', 100);

    // 3. Tentukan direktori aplikasi
    const appDir = path.dirname(process.execPath);
    const exeName = path.basename(process.execPath);

    // Deteksi hak akses tulis ke folder aplikasi
    let hasWriteAccess = true;
    try {
      fs.accessSync(appDir, fs.constants.W_OK);
    } catch (_) {
      hasWriteAccess = false;
    }

    if (isWin) {
      const batchPath = path.join(tempDir, 'simple-antrian-updater.bat');
      const batchContent = `@echo off
title SimpleAntrian Updater
echo Menunggu aplikasi ditutup...
timeout /t 2 /nobreak > NUL

echo Memasang pembaruan baru...
robocopy "${extractDir}" "${appDir}" /E /MOVE /IS /IT /R:3 /W:1 > NUL

echo Membuka kembali aplikasi...
start "" "${path.join(appDir, exeName)}"

:: Bersihkan berkas sementara
del "${archivePath}" > NUL
(goto) 2>nul & del "%~f0"
`;
      fs.writeFileSync(batchPath, batchContent, 'utf-8');

      if (hasWriteAccess) {
        // Jalankan updater batch biasa
        const child = spawn('cmd.exe', ['/c', batchPath], {
          detached: true,
          stdio: 'ignore'
        });
        child.unref();
      } else {
        // Perlu hak administrator: Jalankan dengan PowerShell (Verb RunAs) untuk memicu dialog UAC
        console.log("[App Update] Folder terproteksi admin, meminta elevasi hak akses (UAC)...");
        const elevateCmd = `powershell -Command "Start-Process cmd.exe -ArgumentList '/c \\"${batchPath}\\"' -Verb RunAs"`;
        exec(elevateCmd, (err) => {
          if (err) console.error("Gagal menjalankan updater dengan hak Administrator:", err);
        });
      }

    } else {
      // Linux shell script updater
      const shPath = path.join(tempDir, 'simple-antrian-updater.sh');
      const shContent = `#!/bin/bash
echo "Menunggu aplikasi utama ditutup..."
sleep 2

echo "Memasang pembaruan..."
cp -r "${extractDir}"/* "${appDir}"/

echo "Membuka kembali aplikasi..."
"${path.join(appDir, exeName)}" &

# Bersihkan file arsip
rm "${archivePath}"
rm -- "$0"
`;
      fs.writeFileSync(shPath, shContent, 'utf-8');
      fs.chmodSync(shPath, '755');

      if (hasWriteAccess) {
        // Jalankan updater shell biasa
        const child = spawn('/bin/bash', [shPath], {
          detached: true,
          stdio: 'ignore'
        });
        child.unref();
      } else {
        // Perlu hak root: Gunakan pkexec (Polkit GUI sudo dialog bawaan Linux)
        console.log("[App Update] Folder terproteksi root, memicu dialog pkexec...");
        const child = spawn('pkexec', ['/bin/bash', shPath], {
          detached: true,
          stdio: 'ignore'
        });
        child.unref();
      }
    }

    // 4. Tutup aplikasi utama agar berkas biner tidak terkunci
    setTimeout(() => {
      app.quit();
    }, 500);

    return { success: true };
  } catch (err) {
    console.error("Gagal melakukan auto-update:", err);
    return { success: false, message: err.message };
  }
});

// Restart WhatsApp client dengan mode QR code
ipcMain.handle('wa-start-qr', async () => {
  try {
    await whatsapp.logoutWhatsAppClient(); // Bersihkan sesi lama
    return { success: true };
  } catch (err) {
    console.error('wa-start-qr error:', err);
    return { success: false, message: err.message };
  }
});

// Mulai pairing via nomor HP, kembalikan kode ke renderer
ipcMain.handle('wa-start-pairing', async (event, phone) => {
  try {
    if (!phone || phone.replace(/[^0-9]/g, '').length < 8) {
      return { success: false, message: 'Nomor HP tidak valid.' };
    }
    // Logout sesi lama agar socket bersih, lalu connect pairing mode
    await whatsapp.logoutWhatsAppClient();
    // Tunggu logout selesai lalu start ulang dengan pairing mode
    setTimeout(() => {
      whatsapp.startWhatsAppClient({ phone });
    }, 1500);
    return { success: true };
  } catch (err) {
    console.error('wa-start-pairing error:', err);
    return { success: false, message: err.message };
  }
});

// Buka URL eksternal dengan aman (digunakan renderer untuk link GitHub)
ipcMain.handle('open-external-url', (event, url) => {
  shell.openExternal(url);
});

// Mengecek pembaruan aplikasi dari repositori GitHub organisasi CraftThingy-Digital-Innovation
function checkAppUpdates() {
  return new Promise((resolve) => {
    const https = require('https');
    const options = {
      hostname: 'api.github.com',
      path: '/repos/CraftThingy-Digital-Innovation/simple-antrian/releases/latest',
      method: 'GET',
      headers: {
        'User-Agent': 'simple-antrian-app'
      }
    };

    https.get(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        if (res.statusCode !== 200) {
          resolve({ hasUpdate: false, message: `Server GitHub merespon dengan status ${res.statusCode}` });
          return;
        }
        try {
          const release = JSON.parse(data);
          const latestVersion = release.tag_name ? release.tag_name.replace(/^v/, '') : '';
          const appVersion = require('./package.json').version;

          const isWin = process.platform === 'win32';
          let downloadUrl = null;
          if (release.assets && release.assets.length > 0) {
            const asset = release.assets.find(a => {
              const n = a.name.toLowerCase();
              return isWin 
                ? (n.includes('windows') || n.includes('win32') || n.endsWith('.zip'))
                : (n.includes('linux') || n.endsWith('.tar.gz'));
            });
            if (asset) downloadUrl = asset.browser_download_url;
          }

          const hasUpdate = Boolean(latestVersion && latestVersion !== appVersion);

          const updateInfo = {
            hasUpdate,
            current: appVersion,
            latest: latestVersion,
            url: release.html_url,
            body: release.body || '',
            downloadUrl: downloadUrl
          };

          if (hasUpdate) {
            console.log(`[App Update] Pembaruan SimpleAntrian tersedia: v${appVersion} -> v${latestVersion}`);
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('app-update-available', updateInfo);
            }
          }

          resolve(updateInfo);
        } catch (err) {
          console.error('Gagal parsing data update github:', err);
          resolve({ hasUpdate: false, message: err.message });
        }
      });
    }).on('error', (err) => {
      console.warn('[App Update] Gagal mengecek update GitHub:', err.message);
      resolve({ hasUpdate: false, message: err.message });
    });
  });
}
