const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const db = require('./db');

const sessionDir = path.join(process.cwd(), 'data', 'wa-session');

let sock = null;
let qrCodeBase64 = null;
let connectionStatus = 'disconnected'; // 'disconnected', 'connecting', 'qr', 'connected'
let waUserNumber = '';
let currentBaileysVersion = require('@whiskeysockets/baileys/package.json').version;
let latestBaileysVersion = currentBaileysVersion;
let updateAvailable = false;

// Broadcaster WebSocket untuk perubahan status WA
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

// Inisialisasi Klien WhatsApp Lokal (Baileys)
async function startWhatsAppClient() {
  const settings = await db.getSettings();
  if (settings.wa_enabled !== 'true') {
    stopWhatsAppClient();
    return;
  }

  if (sock) return; // sudah berjalan

  connectionStatus = 'connecting';
  broadcastWaStatus();

  try {
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    sock = makeWASocket({
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        connectionStatus = 'qr';
        try {
          qrCodeBase64 = await QRCode.toDataURL(qr);
          broadcastWaStatus();
        } catch (err) {
          console.error('Gagal men-generate QR base64:', err);
        }
      }

      if (connection === 'close') {
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        console.log(`Koneksi WA terputus. Reconnect: ${shouldReconnect}`);
        
        sock = null;
        connectionStatus = 'disconnected';
        qrCodeBase64 = null;
        waUserNumber = '';
        broadcastWaStatus();

        if (shouldReconnect) {
          setTimeout(startWhatsAppClient, 5000); // hubungkan ulang otomatis
        } else {
          logoutWhatsAppClient(); // bersihkan kredensial jika di-logout paksa
        }
      } else if (connection === 'open') {
        connectionStatus = 'connected';
        qrCodeBase64 = null;
        waUserNumber = sock.user.id.split(':')[0];
        console.log(`WhatsApp terhubung! Akun: ${waUserNumber}`);
        broadcastWaStatus();
      }
    });

    // Cek pembaruan pustaka Baileys secara background di awal startup
    checkForUpdates();

  } catch (err) {
    console.error('Error starting Baileys WhatsApp client:', err);
    connectionStatus = 'disconnected';
    sock = null;
    broadcastWaStatus();
  }
}

// Menghentikan koneksi Baileys
function stopWhatsAppClient() {
  if (sock) {
    try {
      sock.end();
    } catch (e) {}
    sock = null;
  }
  connectionStatus = 'disconnected';
  qrCodeBase64 = null;
  waUserNumber = '';
  broadcastWaStatus();
}

// Logout & hapus sesi
async function logoutWhatsAppClient() {
  stopWhatsAppClient();
  
  if (fs.existsSync(sessionDir)) {
    try {
      fs.rmSync(sessionDir, { recursive: true, force: true });
      console.log('WA Session folder cleared.');
    } catch (e) {
      console.error('Failed to clear WA session folder:', e);
    }
  }
  
  // Hubungkan ulang untuk memicu QR code baru
  const settings = await db.getSettings();
  if (settings.wa_enabled === 'true') {
    setTimeout(startWhatsAppClient, 1000);
  }
}

// Mendapatkan Status WA saat ini
function getWaStatus() {
  return {
    status: connectionStatus,
    qr: qrCodeBase64,
    number: waUserNumber,
    version: currentBaileysVersion,
    latestVersion: latestBaileysVersion,
    updateAvailable: updateAvailable
  };
}

// Mengirim Pesan WhatsApp Lokal
async function sendWhatsAppMessage(phone, messageText) {
  const settings = await db.getSettings();
  if (settings.wa_enabled !== 'true') return;

  if (!sock || connectionStatus !== 'connected') {
    console.warn("WhatsApp is not connected. Message skipped.");
    return;
  }

  // Format nomor telepon
  let formattedPhone = phone.replace(/[^0-9]/g, '');
  if (formattedPhone.startsWith('0')) {
    formattedPhone = '62' + formattedPhone.substring(1);
  }
  
  const jid = `${formattedPhone}@s.whatsapp.net`;
  
  try {
    await sock.sendMessage(jid, { text: messageText });
    console.log(`[Baileys WA] Pesan terkirim ke ${formattedPhone}`);
  } catch (err) {
    console.error(`[Baileys WA] Gagal mengirim pesan ke ${formattedPhone}:`, err);
  }
}

// Cek pembaruan library Baileys dari NPM registry
async function checkForUpdates() {
  try {
    const response = await fetch('https://registry.npmjs.org/@whiskeysockets/baileys/latest');
    const data = await response.json();
    latestBaileysVersion = data.version;
    
    // Bandingkan versi
    if (latestBaileysVersion !== currentBaileysVersion) {
      updateAvailable = true;
      console.log(`Baileys update available: ${currentBaileysVersion} -> ${latestBaileysVersion}`);
    } else {
      updateAvailable = false;
    }
    broadcastWaStatus();
  } catch (err) {
    console.error('Gagal mengecek update Baileys:', err);
  }
}

// Lakukan update library Baileys ke versi terbaru secara otomatis
function performLibraryUpdate() {
  return new Promise((resolve, reject) => {
    console.log("Memulai proses update otomatis @whiskeysockets/baileys...");
    
    // Matikan koneksi saat ini
    stopWhatsAppClient();
    
    // Jalankan perintah install versi terbaru
    exec('npm install @whiskeysockets/baileys@latest pino@latest --save', {
      cwd: process.cwd()
    }, (error, stdout, stderr) => {
      if (error) {
        console.error("Gagal melakukan update Baileys:", error);
        reject(error);
        // Hubungkan kembali dengan versi lama
        startWhatsAppClient();
        return;
      }
      
      console.log("Update Baileys sukses:", stdout);
      
      // Reload versi sekarang
      try {
        delete require.cache[require.resolve('@whiskeysockets/baileys/package.json')];
        currentBaileysVersion = require('@whiskeysockets/baileys/package.json').version;
        latestBaileysVersion = currentBaileysVersion;
        updateAvailable = false;
      } catch (e) {}

      resolve({ success: true, version: currentBaileysVersion });
      
      // Hubungkan kembali klien WA dengan versi baru
      setTimeout(startWhatsAppClient, 2000);
    });
  });
}

// ==================== METODE NOTIFIKASI SAMA SEPERTI SEBELUMNYA ====================

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
