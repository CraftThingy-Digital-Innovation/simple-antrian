/**
 * SimpleAntrian - WhatsApp Integration via Baileys
 * Mendukung dua metode koneksi: QR Code dan Pairing Code via nomor HP.
 *
 * @author    CraftThingy Digital Innovation
 * @developer Alif Nurhidayat
 */

let makeWASocket = null;
let useMultiFileAuthState = null;
let DisconnectReason = null;
const pino = require('pino');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const db = require('./db');

const { app } = require('electron');
const sessionDir = app
  ? path.join(app.getPath('userData'), 'data', 'wa-session')
  : path.join(process.cwd(), 'data', 'wa-session');

let sock = null;
let qrCodeBase64 = null;
let pairingCode = null;         // Kode 8-digit untuk pairing via nomor HP
let pairingPhone = null;        // Nomor HP yang sedang digunakan untuk pairing
let usePairingMode = false;     // Flag: gunakan pairing code (true) atau QR (false)
let connectionStatus = 'disconnected'; // 'disconnected' | 'connecting' | 'qr' | 'pairing_code' | 'connected'
let waUserNumber = '';
let reconnectTimer = null;      // Timer untuk reconnect, agar bisa dibatalkan
let stopRequested = false;      // Flag untuk mencegah reconnect otomatis setelah stop

let currentBaileysVersion = '';
try {
  currentBaileysVersion = require('@whiskeysockets/baileys/package.json').version;
} catch (_) {
  currentBaileysVersion = 'unknown';
}
let latestBaileysVersion = currentBaileysVersion;
let updateAvailable = false;

// ==================== BROADCAST STATUS ====================

/**
 * Broadcast status WA terkini ke semua client WebSocket.
 */
function broadcastWaStatus() {
  try {
    const wsModule = require('./websocket');
    wsModule.broadcast({
      type: 'WA_STATUS_UPDATE',
      payload: getWaStatus()
    });
  } catch (e) {
    // Abaikan jika websocket belum siap
  }
}

// ==================== INISIALISASI CLIENT ====================

/**
 * Mulai WhatsApp client Baileys.
 * @param {object} options - Opsi opsional.
 * @param {boolean} options.pairingMode - Jika true, gunakan pairing code bukan QR.
 * @param {string}  options.phone       - Nomor HP (format internasional tanpa +) untuk pairing.
 */
async function startWhatsAppClient(options = {}) {
  stopRequested = false;

  const settings = await db.getSettings();
  if (settings.wa_enabled !== 'true') {
    stopWhatsAppClient();
    return;
  }

  // Jika sudah ada socket aktif dan bukan request pairing baru, jangan buat ulang
  if (sock && !options.phone) return;

  // Jika ada socket lama, bersihkan dulu tanpa trigger reconnect
  if (sock) {
    stopRequested = true; // Hentikan sementara agar disconnect tidak memicu reconnect
    try { sock.end(); } catch (_) {}
    sock = null;
    await new Promise(r => setTimeout(r, 500));
    stopRequested = false;
  }

  // Simpan pilihan mode untuk sesi ini
  if (options.phone) {
    usePairingMode = true;
    pairingPhone = options.phone.replace(/[^0-9]/g, '');
  } else {
    usePairingMode = false;
    pairingPhone = null;
  }

  pairingCode = null;
  connectionStatus = 'connecting';
  broadcastWaStatus();

  // Silent update library Baileys jika ada versi baru
  try {
    await checkAndPerformSilentUpdate();
  } catch (err) {
    console.warn('[Baileys Auto-Update] Gagal update atau sedang offline:', err.message);
  }

  // Load modul ES Baileys secara dinamis (ESM tidak bisa di-require())
  if (!makeWASocket) {
    try {
      console.log('[Baileys] Memuat modul ES secara dinamis...');
      const baileys = await import('@whiskeysockets/baileys');
      makeWASocket = baileys.default;
      useMultiFileAuthState = baileys.useMultiFileAuthState;
      DisconnectReason = baileys.DisconnectReason;
    } catch (err) {
      console.error('[Baileys] Gagal memuat modul:', err);
      connectionStatus = 'disconnected';
      broadcastWaStatus();
      return;
    }
  }

  // Pastikan folder sesi ada
  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }

  try {
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    sock = makeWASocket({
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      // Jika pairing mode, nonaktifkan browser QR agar server tidak memaksa QR sebelum pairing
      browser: ['SimpleAntrian', 'Chrome', '1.0.0']
    });

    sock.ev.on('creds.update', saveCreds);

    // ---- Pairing Code Request ----
    // Harus dipanggil sebelum 'connection.update' mengirim QR
    if (usePairingMode && pairingPhone && !state.creds.registered) {
      // Tunggu sebentar agar socket siap
      setTimeout(async () => {
        try {
          const code = await sock.requestPairingCode(pairingPhone);
          pairingCode = code;
          connectionStatus = 'pairing_code';
          console.log(`[Baileys Pairing] Kode Penyandingan: ${code}`);
          broadcastWaStatus();
        } catch (err) {
          console.error('[Baileys Pairing] Gagal mendapat kode:', err.message);
          connectionStatus = 'disconnected';
          broadcastWaStatus();
        }
      }, 1500);
    }

    // ---- Event: Connection Update ----
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      // QR Code muncul (hanya di mode QR)
      if (qr && !usePairingMode) {
        connectionStatus = 'qr';
        try {
          qrCodeBase64 = await QRCode.toDataURL(qr);
          broadcastWaStatus();
        } catch (err) {
          console.error('[Baileys] Gagal generate QR base64:', err);
        }
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        console.log(`[Baileys] Koneksi terputus. StatusCode: ${statusCode}. Reconnect: ${shouldReconnect}`);

        sock = null;
        qrCodeBase64 = null;
        pairingCode = null;
        pairingPhone = null;
        waUserNumber = '';
        connectionStatus = 'disconnected';
        broadcastWaStatus();

        if (shouldReconnect && !stopRequested) {
          // Reconnect otomatis dengan delay 5 detik (hanya mode QR, bukan pairing)
          if (!usePairingMode) {
            console.log('[Baileys] Reconnect dalam 5 detik...');
            reconnectTimer = setTimeout(() => startWhatsAppClient(), 5000);
          }
        } else if (!shouldReconnect) {
          // Di-logout paksa → hapus sesi
          logoutWhatsAppClient();
        }
      } else if (connection === 'open') {
        connectionStatus = 'connected';
        qrCodeBase64 = null;
        pairingCode = null;
        usePairingMode = false;
        waUserNumber = sock.user?.id?.split(':')[0] || '';
        console.log(`[Baileys] Terhubung! Akun: ${waUserNumber}`);
        broadcastWaStatus();
      }
    });

  } catch (err) {
    console.error('[Baileys] Error saat inisialisasi:', err);
    connectionStatus = 'disconnected';
    sock = null;
    broadcastWaStatus();
  }
}

// ==================== STOP & LOGOUT ====================

/**
 * Hentikan koneksi Baileys tanpa menghapus sesi.
 */
function stopWhatsAppClient() {
  stopRequested = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (sock) {
    try { sock.end(); } catch (_) {}
    sock = null;
  }
  connectionStatus = 'disconnected';
  qrCodeBase64 = null;
  pairingCode = null;
  pairingPhone = null;
  waUserNumber = '';
  broadcastWaStatus();
}

/**
 * Logout dan hapus folder sesi, lalu reconnect untuk meminta QR baru.
 */
async function logoutWhatsAppClient() {
  stopWhatsAppClient();

  if (fs.existsSync(sessionDir)) {
    try {
      fs.rmSync(sessionDir, { recursive: true, force: true });
      console.log('[Baileys] Folder sesi dihapus.');
    } catch (e) {
      console.error('[Baileys] Gagal hapus folder sesi:', e);
    }
  }

  // Reconnect untuk meminta QR baru (jika WA masih diaktifkan)
  const settings = await db.getSettings();
  if (settings.wa_enabled === 'true') {
    setTimeout(() => startWhatsAppClient(), 1000);
  }
}

// ==================== STATUS ====================

/**
 * Kembalikan objek status WA saat ini.
 */
function getWaStatus() {
  return {
    status: connectionStatus,
    qr: qrCodeBase64,
    pairingCode: pairingCode,
    pairingPhone: pairingPhone,
    number: waUserNumber,
    version: currentBaileysVersion,
    latestVersion: latestBaileysVersion,
    updateAvailable: updateAvailable
  };
}

// ==================== KIRIM PESAN ====================

/**
 * Kirim pesan WhatsApp ke nomor tertentu.
 * @param {string} phone       - Nomor HP penerima (format lokal atau internasional).
 * @param {string} messageText - Teks pesan.
 */
async function sendWhatsAppMessage(phone, messageText) {
  const settings = await db.getSettings();
  if (settings.wa_enabled !== 'true') return;

  if (!sock || connectionStatus !== 'connected') {
    console.warn('[Baileys] WhatsApp belum terhubung. Pesan dilewati.');
    return;
  }

  // Normalisasi nomor ke format internasional
  let formattedPhone = phone.replace(/[^0-9]/g, '');
  if (formattedPhone.startsWith('0')) {
    formattedPhone = '62' + formattedPhone.substring(1);
  }

  const jid = `${formattedPhone}@s.whatsapp.net`;

  try {
    await sock.sendMessage(jid, { text: messageText });
    console.log(`[Baileys] Pesan terkirim ke ${formattedPhone}`);
  } catch (err) {
    console.error(`[Baileys] Gagal kirim ke ${formattedPhone}:`, err.message);
  }
}

// ==================== AUTO UPDATE BAILEYS ====================

/**
 * Cek dan update library Baileys ke versi terbaru jika berbeda.
 * Berjalan di latar belakang saat startup.
 */
async function checkAndPerformSilentUpdate() {
  const response = await fetch('https://registry.npmjs.org/@whiskeysockets/baileys/latest');
  if (!response.ok) return;

  const data = await response.json();
  latestBaileysVersion = data.version;

  if (latestBaileysVersion !== currentBaileysVersion) {
    console.log(`[Baileys Auto-Update] Versi usang: v${currentBaileysVersion} → v${latestBaileysVersion}. Memperbarui...`);

    await new Promise((resolve, reject) => {
      // Gunakan __dirname untuk mendapatkan root proyek (src/server → root)
      const projectRoot = path.join(__dirname, '..', '..');
      exec('npm install @whiskeysockets/baileys@latest pino@latest --save', {
        cwd: projectRoot
      }, (error) => {
        if (error) return reject(error);
        resolve();
      });
    });

    // Reload versi setelah update
    try {
      delete require.cache[require.resolve('@whiskeysockets/baileys/package.json')];
      currentBaileysVersion = require('@whiskeysockets/baileys/package.json').version;
      latestBaileysVersion = currentBaileysVersion;
      updateAvailable = false;
      // Reset agar modul dimuat ulang dengan versi baru
      makeWASocket = null;
      useMultiFileAuthState = null;
      DisconnectReason = null;
      console.log(`[Baileys Auto-Update] Berhasil diperbarui ke v${currentBaileysVersion}!`);
    } catch (e) {
      console.error('[Baileys Auto-Update] Gagal reload package.json:', e);
    }
    broadcastWaStatus();
  } else {
    console.log(`[Baileys Auto-Update] Sudah up-to-date (v${currentBaileysVersion}).`);
  }
}

/**
 * Cek update Baileys tanpa menginstall (hanya update status).
 */
async function checkForUpdates() {
  try {
    const response = await fetch('https://registry.npmjs.org/@whiskeysockets/baileys/latest');
    const data = await response.json();
    latestBaileysVersion = data.version;
    updateAvailable = latestBaileysVersion !== currentBaileysVersion;
    broadcastWaStatus();
  } catch (err) {
    console.error('[Baileys] Gagal cek update:', err.message);
  }
}

/**
 * Pemicu update library manual via IPC.
 */
async function performLibraryUpdate() {
  try {
    await checkAndPerformSilentUpdate();
    return { success: true, version: currentBaileysVersion };
  } catch (err) {
    console.error('[Baileys] Manual update gagal:', err.message);
    return { success: false, message: err.message };
  }
}

// ==================== NOTIFIKASI WHATSAPP ====================

async function sendTicketCreatedNotification(ticket) {
  if (!ticket.customer_phone) return;
  const settings = await db.getSettings();
  let template = settings.wa_template_wait || 'Nomor antrian Anda {{ticket}}.';
  const text = template
    .replace(/{{name}}/g, ticket.customer_name || 'Pelanggan')
    .replace(/{{ticket}}/g, ticket.ticket_number)
    .replace(/{{waiting}}/g, 'beberapa');
  await sendWhatsAppMessage(ticket.customer_phone, text);
}

async function sendQueueReminderNotification(ticket, waitingCount) {
  if (!ticket.customer_phone) return;
  const settings = await db.getSettings();
  let template = settings.wa_template_wait || 'Antrian Anda {{ticket}} berjarak {{waiting}} antrian lagi.';
  const text = template
    .replace(/{{name}}/g, ticket.customer_name || 'Pelanggan')
    .replace(/{{ticket}}/g, ticket.ticket_number)
    .replace(/{{waiting}}/g, String(waitingCount));
  await sendWhatsAppMessage(ticket.customer_phone, text);
}

async function sendTicketCalledNotification(ticket) {
  if (!ticket.customer_phone) return;
  const settings = await db.getSettings();
  let template = settings.wa_template_call || 'Antrian Anda {{ticket}} sedang dipanggil ke {{desk}}.';
  const text = template
    .replace(/{{name}}/g, ticket.customer_name || 'Pelanggan')
    .replace(/{{ticket}}/g, ticket.ticket_number)
    .replace(/{{desk}}/g, ticket.desk_number || 'Loket');
  await sendWhatsAppMessage(ticket.customer_phone, text);
}

module.exports = {
  startWhatsAppClient,
  stopWhatsAppClient,
  logoutWhatsAppClient,
  getWaStatus,
  sendWhatsAppMessage,
  checkForUpdates,
  performLibraryUpdate,
  sendTicketCreatedNotification,
  sendQueueReminderNotification,
  sendTicketCalledNotification
};
