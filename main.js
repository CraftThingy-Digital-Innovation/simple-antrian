const { app, BrowserWindow, ipcMain, screen, dialog, shell, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');

// Matikan Autoplay Policy agar audio bisa berputar otomatis tanpa interaksi user
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

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
const logStdout = process.stdout;

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
      nodeIntegration: false
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

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    // Cek pembaruan aplikasi dari GitHub secara otomatis pada startup
    setTimeout(checkAppUpdates, 3000);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    // Jika window utama ditutup, tutup juga layar display & kiosk
    if (displayWindow) displayWindow.close();
    if (kioskWindow) kioskWindow.close();
  });
}

const runtimeServerUuid = require('crypto').randomUUID();

// Menjalankan/Menghentikan service secara dinamis
async function startServicesBasedOnMode(settings) {
  const wsPort = parseInt(settings.port || '8080');
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
  const appVersion = require('./package.json').version;
  return {
    mode: currentMode,
    serverUuid: runtimeServerUuid,
    serverName: settings.server_name,
    port: settings.port,
    localIp: discovery.getLocalIp(),
    appVersion: appVersion
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
  captureWindowLogs(displayWindow, 'Display');
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

// IPC Handler to pick and copy local video files to data/videos/
ipcMain.handle('add-video-file', async () => {
  if (!mainWindow) return { success: false, message: 'Window utama tidak ditemukan.' };
  
  const { filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Pilih Video untuk Playlist',
    filters: [{ name: 'Videos', extensions: ['mp4', 'webm', 'ogg'] }],
    properties: ['openFile']
  });
  
  if (filePaths && filePaths.length > 0) {
    const srcPath = filePaths[0];
    const ext = path.extname(srcPath);
    const baseName = path.basename(srcPath);
    
    const videoDir = app ? path.join(app.getPath('userData'), 'data', 'videos') : path.join(process.cwd(), 'data', 'videos');
    if (!fs.existsSync(videoDir)) {
      fs.mkdirSync(videoDir, { recursive: true });
    }
    
    const crypto = require('crypto');
    const uniqueFilename = `${crypto.randomUUID()}${ext}`;
    const destPath = path.join(videoDir, uniqueFilename);
    
    try {
      fs.copyFileSync(srcPath, destPath);
      return {
        success: true,
        video: {
          id: crypto.randomUUID().substring(0, 8),
          originalName: baseName,
          filename: uniqueFilename,
          url: `/video/${uniqueFilename}`
        }
      };
    } catch (err) {
      console.error("Gagal menyalin video:", err);
      return { success: false, message: `Gagal menyalin video: ${err.message}` };
    }
  }
  return { success: false, message: 'Batal memilih video.' };
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
  checkAppUpdates();
  return { success: true };
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
      if (res.statusCode !== 200) return;
      try {
        const release = JSON.parse(data);
        const latestVersion = release.tag_name.replace(/^v/, '');
        const appVersion = require('./package.json').version;

        if (latestVersion !== appVersion) {
          console.log(`[App Update] Pembaruan SimpleAntrian tersedia: v${appVersion} -> v${latestVersion}`);
          
          // Cari asset zip Windows (.zip)
          const winAsset = release.assets && release.assets.find(asset => 
            asset.name.toLowerCase().includes('windows') || 
            asset.name.toLowerCase().includes('win32') || 
            asset.name.toLowerCase().endsWith('.zip')
          );
          const downloadUrl = winAsset ? winAsset.browser_download_url : null;

          if (mainWindow) {
            mainWindow.webContents.send('app-update-available', {
              current: appVersion,
              latest: latestVersion,
              url: release.html_url,
              body: release.body,
              downloadUrl: downloadUrl
            });
          }
        }
      } catch (err) {
        console.error('Gagal parsing data update github:', err);
      }
    });
  }).on('error', (err) => {
    console.warn('[App Update] Gagal mengecek update GitHub:', err.message);
  });
}
