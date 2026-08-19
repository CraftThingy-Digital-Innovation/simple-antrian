const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const db = require('./db');
const ttsGenerator = require('./tts-generator');

let wss = null;
let httpServer = null;

// Mulai server WebSocket
function startWebSocketServer(port) {
  if (wss) stopWebSocketServer();

  // Create combined HTTP server to serve local static audio files (with Range Request support)
  httpServer = http.createServer((req, res) => {
    if (req.url.startsWith('/audio/')) {
      const filename = path.basename(req.url);
      const filePath = path.join(process.cwd(), 'data', 'tts-cache', filename);
      
      if (fs.existsSync(filePath)) {
        const stat = fs.statSync(filePath);
        const total = stat.size;
        const range = req.headers.range;
        
        if (range) {
          const parts = range.replace(/bytes=/, "").split("-");
          const partialstart = parts[0];
          const partialend = parts[1];
          
          const start = parseInt(partialstart, 10);
          const end = partialend ? parseInt(partialend, 10) : total - 1;
          const chunksize = (end - start) + 1;
          
          res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${total}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunksize,
            'Content-Type': 'audio/wav'
          });
          
          fs.createReadStream(filePath, { start: start, end: end }).pipe(res);
        } else {
          res.writeHead(200, {
            'Content-Length': total,
            'Content-Type': 'audio/wav',
            'Accept-Ranges': 'bytes'
          });
          fs.createReadStream(filePath).pipe(res);
        }
      } else {
        res.writeHead(404);
        res.end();
      }
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  wss = new WebSocketServer({ server: httpServer });

  // Initialize TTS Engine in the background
  ttsGenerator.initTtsEngine((status) => {
    broadcast({
      type: 'TTS_GEN_STATUS',
      payload: status
    });
  });

  wss.on('connection', async (ws) => {
    console.log('Client connected to WebSocket server');

    // Kirim data awal (inisialisasi state) ke client yang baru terhubung
    try {
      await sendStateToClient(ws);
      // Kirim status TTS terkini
      const currentTtsStatus = ttsGenerator.getLastStatus();
      ws.send(JSON.stringify({
        type: 'TTS_GEN_STATUS',
        payload: currentTtsStatus
      }));
    } catch (err) {
      console.error('Error sending initial state:', err);
    }

    ws.on('message', async (message) => {
      try {
        const action = JSON.parse(message.toString());
        await handleClientAction(action, ws);
      } catch (err) {
        console.error('Error parsing client message:', err);
        ws.send(JSON.stringify({ type: 'ERROR', payload: { message: 'Invalid action payload' } }));
      }
    });

    ws.on('close', () => {
      console.log('Client disconnected from WebSocket server');
    });
  });

  httpServer.listen(port);
  console.log('WebSocket & HTTP Audio Server started on port', port);
}

// Hentikan server WebSocket
function stopWebSocketServer() {
  if (wss) {
    wss.clients.forEach((client) => {
      client.close();
    });
    wss.close();
    wss = null;
  }
  if (httpServer) {
    httpServer.close();
    httpServer = null;
    console.log('WebSocket & HTTP Server stopped.');
  }
}

// Kirim state ter-update ke client spesifik
async function sendStateToClient(ws) {
  const state = await getCurrentState();
  ws.send(JSON.stringify({
    type: 'STATE_UPDATE',
    payload: state
  }));
  
  try {
    const waStatus = require('./whatsapp').getWaStatus();
    ws.send(JSON.stringify({
      type: 'WA_STATUS_UPDATE',
      payload: waStatus
    }));
  } catch (e) {}
}

// Ambil state gabungan saat ini
async function getCurrentState() {
  const services = await db.getServices();
  const waitingTickets = await db.getWaitingTickets();
  const callingTickets = await db.getCallingTickets();
  const settings = await db.getSettings();
  
  return {
    serverName: settings.server_name || 'Server Utama',
    serverUuid: settings.server_uuid || '',
    services,
    waitingTickets,
    callingTickets
  };
}

// Broadcast pesan ke seluruh client
function broadcast(messageObj) {
  if (!wss) return;
  const payload = JSON.stringify(messageObj);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) { // Open
      client.send(payload);
    }
  });
}

// Ambil state database dan broadcast ke semua client
async function broadcastStateUpdate() {
  try {
    const state = await getCurrentState();
    broadcast({
      type: 'STATE_UPDATE',
      payload: state
    });
  } catch (err) {
    console.error('Error broadcasting state update:', err);
  }
}

// Handle request aksi dari client (operator)
async function handleClientAction(action, ws) {
  const { type, payload } = action;
  console.log(`Received client action: ${type}`, payload);

  try {
    switch (type) {
      case 'GET_STATE':
        await sendStateToClient(ws);
        break;

      case 'WA_STATUS': {
        const waStatus = require('./whatsapp').getWaStatus();
        ws.send(JSON.stringify({ type: 'WA_STATUS_UPDATE', payload: waStatus }));
        break;
      }

      case 'WA_LOGOUT': {
        await require('./whatsapp').logoutWhatsAppClient();
        break;
      }

      case 'WA_CHECK_UPDATE': {
        await require('./whatsapp').checkForUpdates();
        break;
      }

      case 'WA_START_QR': {
        // Bersihkan sesi dan reconnect untuk mendapatkan QR baru
        await require('./whatsapp').logoutWhatsAppClient();
        break;
      }

      case 'WA_START_PAIRING': {
        // Mulai koneksi via nomor HP (pairing code)
        const phone = payload.phone;
        if (!phone || phone.replace(/[^0-9]/g, '').length < 8) {
          ws.send(JSON.stringify({ type: 'ERROR', payload: { message: 'Nomor HP tidak valid untuk pairing.' } }));
          break;
        }
        await require('./whatsapp').logoutWhatsAppClient();
        setTimeout(() => {
          require('./whatsapp').startWhatsAppClient({ phone });
        }, 1500);
        break;
      }

      case 'WA_SAVE_AND_RESTART': {
        // Simpan pengaturan WA, lalu restart WA client sesuai status enabled
        const { enabled, templateWait, templateCall } = payload;
        const dbMod = require('./db');
        await dbMod.saveSetting('wa_enabled', enabled);
        if (templateWait) await dbMod.saveSetting('wa_template_wait', templateWait);
        if (templateCall) await dbMod.saveSetting('wa_template_call', templateCall);

        const wa = require('./whatsapp');
        if (enabled === 'true') {
          wa.startWhatsAppClient();
        } else {
          wa.stopWhatsAppClient();
        }
        ws.send(JSON.stringify({ type: 'WA_STATUS_UPDATE', payload: wa.getWaStatus() }));
        break;
      }

      case 'CREATE_TICKET': {
        const serviceId = payload.serviceId;
        const name = payload.customerName || payload.name || 'Pelanggan';
        const phone = payload.customerPhone || payload.phone || null;
        const txId = payload.txId || null;

        const newTicket = await db.createTicket(serviceId, name, phone);
        
        // Tempelkan txId ke objek tiket untuk dibroadcast balik
        newTicket.tx_id = txId;

        // Broadcast event TICKET_CREATED khusus untuk pencetakan tiket mandiri
        broadcast({
          type: 'TICKET_CREATED',
          payload: newTicket
        });

        await broadcastStateUpdate();
        
        // Optional WA Notification for Ticket creation
        try {
          const { sendTicketCreatedNotification } = require('./whatsapp');
          sendTicketCreatedNotification(newTicket);
        } catch (e) {
          console.error("WA notification trigger failed:", e);
        }
        break;
      }

      case 'CALL_NEXT': {
        const { serviceId, deskNumber } = payload;
        const calledTicket = await db.callNextTicket(serviceId, deskNumber);
        
        if (calledTicket) {
          await broadcastStateUpdate();
          
          // Kirim trigger panggilan suara (announcement) ke seluruh display
          await announceCall(calledTicket.ticket_number, calledTicket.desk_number, calledTicket.service_name);

          // Kirim WhatsApp pemberitahuan giliran tiba
          try {
            const { sendTicketCalledNotification } = require('./whatsapp');
            sendTicketCalledNotification(calledTicket);
          } catch (e) {}

          // Kirim WhatsApp pengingat 3 antrian lagi ke tiket berikutnya (jika ada)
          try {
            await triggerWhatsAppQueueReminder(serviceId, calledTicket.number_sequence);
          } catch (e) {}
        } else {
          ws.send(JSON.stringify({ type: 'ALERT', payload: { message: 'Antrian kosong.' } }));
        }
        break;
      }

      case 'CALL_SKIPPED': {
        const { serviceId, deskNumber } = payload;
        const calledTicket = await db.callSkippedTicket(serviceId, deskNumber);
        
        if (calledTicket) {
          await broadcastStateUpdate();
          
          // Kirim trigger panggilan suara (announcement)
          await announceCall(calledTicket.ticket_number, calledTicket.desk_number, calledTicket.service_name);

          // Kirim WhatsApp pemberitahuan
          try {
            const { sendTicketCalledNotification } = require('./whatsapp');
            sendTicketCalledNotification(calledTicket);
          } catch (e) {}
        } else {
          ws.send(JSON.stringify({ type: 'ALERT', payload: { message: 'Tidak ada antrian terlewat.' } }));
        }
        break;
      }

      case 'RECALL': {
        const { ticketId } = payload;
        const recalledTicket = await db.recallTicket(ticketId);
        
        if (recalledTicket) {
          await broadcastStateUpdate();

          // Kirim trigger panggilan ulang suara
          await announceCall(recalledTicket.ticket_number, recalledTicket.desk_number, recalledTicket.service_name);
        }
        break;
      }

      case 'COMPLETE': {
        const { ticketId } = payload;
        // Ambil info tiket sebelum diselesaikan untuk tahu layanan dan loketnya (completeTicket mengembalikan data tiket)
        const ticket = await db.completeTicket(ticketId);

        if (ticket) {
          const { service_id, desk_number } = ticket;
          // Cari apakah ada antrian berikutnya untuk layanan yang sama
          const calledTicket = await db.callNextTicket(service_id, desk_number);
          if (calledTicket) {
            await broadcastStateUpdate();
            
            // Broadcast ke display untuk memutar suara panggilan
            await announceCall(calledTicket.ticket_number, calledTicket.desk_number, calledTicket.service_name);

            // Kirim notifikasi WA
            try {
              const { sendTicketCalledNotification } = require('./whatsapp');
              sendTicketCalledNotification(calledTicket);
            } catch (e) {}

            try {
              await triggerWhatsAppQueueReminder(service_id, calledTicket.number_sequence);
            } catch (e) {}
            break;
          }
        }
        
        await broadcastStateUpdate();
        break;
      }

      case 'SKIP': {
        const { ticketId } = payload;
        await db.skipTicket(ticketId);
        await broadcastStateUpdate();
        break;
      }

      case 'RESET_ALL': {
        await db.resetAllQueues();
        await broadcastStateUpdate();
        break;
      }

      case 'SAVE_RUNNING_TEXTS': {
        // Simpan array teks berjalan ke DB dan broadcast langsung ke semua display
        const { texts } = payload;
        if (!Array.isArray(texts)) break;
        const filtered = texts.filter(t => typeof t === 'string' && t.trim());
        await db.saveSetting('running_texts', JSON.stringify(filtered));
        // Broadcast ke seluruh client (display, kiosk, operator)
        broadcast({
          type: 'RUNNING_TEXT_UPDATE',
          payload: { texts: JSON.stringify(filtered) }
        });
        // Balas sukses ke pengirim
        ws.send(JSON.stringify({ type: 'RUNNING_TEXT_SAVED', payload: { count: filtered.length } }));
        break;
      }

      case 'SAVE_TTS': {
        const { enabled } = payload;
        const dbMod = require('./db');
        await dbMod.saveSetting('tts_enabled', enabled);
        // Broadcast ke semua client
        broadcast({
          type: 'TTS_SETTING_UPDATE',
          payload: { enabled }
        });
        // Kirim status TTS engine terkini ke seluruh klien agar progress bar muncul
        const currentTtsStatus = ttsGenerator.getLastStatus();
        broadcast({
          type: 'TTS_GEN_STATUS',
          payload: currentTtsStatus
        });
        ws.send(JSON.stringify({ type: 'ALERT', payload: { message: 'Pengaturan Suara (TTS) berhasil disimpan!' } }));
        break;
      }

      case 'SAVE_DISPLAY_CUSTOM': {
        const { title, subtitle, logo } = payload;
        const dbMod = require('./db');
        await dbMod.saveSetting('display_title', title);
        await dbMod.saveSetting('display_subtitle', subtitle);
        await dbMod.saveSetting('display_logo', logo);
        
        // Broadcast ke semua client
        broadcast({
          type: 'DISPLAY_CUSTOM_UPDATE',
          payload: { title, subtitle, logo }
        });
        ws.send(JSON.stringify({ type: 'ALERT', payload: { message: 'Pengaturan Tampilan berhasil disimpan!' } }));
        break;
      }

      case 'SYNC_DESK_NAMES': {
        const { deskNames } = payload;
        if (!Array.isArray(deskNames)) break;
        
        // Run background generation of custom desk name sounds
        for (const fullDeskName of deskNames) {
          if (!fullDeskName || typeof fullDeskName !== 'string') continue;
          
          const wordPart = fullDeskName.replace(/[0-9]+/g, '').trim();
          if (!wordPart) continue;

          // Generate Indonesian
          await ttsGenerator.generatePhraseIfNeeded(wordPart, 'id');

          // Generate English
          const enWord = wordPart.replace(/loket/i, 'counter');
          await ttsGenerator.generatePhraseIfNeeded(enWord, 'en');

          // Generate Chinese
          const zhWord = wordPart
            .replace(/loket/i, '柜台')
            .replace(/customer\s*service/i, '客户服务')
            .replace(/teller/i, '出纳柜台');
          await ttsGenerator.generatePhraseIfNeeded(zhWord, 'zh');
        }
        break;
      }

      case 'GET_SETTINGS': {
        const settings = await db.getSettings();
        ws.send(JSON.stringify({ type: 'SETTINGS_RESPONSE', payload: settings }));
        break;
      }

      case 'GET_STATS': {
        const { dateStr } = payload;
        const stats = await db.getDailyStats(dateStr);
        ws.send(JSON.stringify({ type: 'STATS_RESPONSE', payload: stats }));
        break;
      }

      case 'SEARCH_TICKETS': {
        const { query, status, serviceId, dateStr } = payload;
        const results = await db.searchTickets(query, status, serviceId, dateStr);
        ws.send(JSON.stringify({ type: 'SEARCH_RESPONSE', payload: results }));
        break;
      }

      default:
        console.warn('Unknown action type:', type);
    }
  } catch (err) {
    console.error(`Error processing action ${type}:`, err);
    ws.send(JSON.stringify({ type: 'ERROR', payload: { message: err.message } }));
  }
}

// WhatsApp pengingat: kirim ke orang yang antriannya berjarak 3 antrian lagi (current_number + 3)
async function triggerWhatsAppQueueReminder(serviceId, currentNumber) {
  const targetSeq = currentNumber + 3;
  // Cari apakah ada antrian waiting dengan nomor sequence ini untuk hari ini
  const today = new Date().toLocaleDateString('sv-SE');
  const dbModule = require('./db');
  
  const targetTicket = await dbModule.searchTickets('', 'waiting', serviceId, today);
  // Filter yang sequence-nya persis targetSeq
  const ticket = targetTicket.find(t => t.number_sequence === targetSeq);
  
  if (ticket && ticket.customer_phone) {
    const { sendQueueReminderNotification } = require('./whatsapp');
    sendQueueReminderNotification(ticket, 3);
  }
}

module.exports = {
  startWebSocketServer,
  stopWebSocketServer,
  broadcast,
  broadcastStateUpdate,
  getCurrentState,
  announceCall
};

function getIndonesianNumberTokens(num) {
  if (num === 0) return ['0'];
  const tokens = [];
  
  const hundreds = Math.floor(num / 100);
  const remainder100 = num % 100;
  
  if (hundreds > 0) {
    if (hundreds === 1) {
      tokens.push('100');
    } else {
      tokens.push(String(hundreds), 'ratus');
    }
  }
  
  if (remainder100 > 0) {
    if (remainder100 <= 19) {
      tokens.push(String(remainder100));
    } else {
      const tens = Math.floor(remainder100 / 10);
      const ones = remainder100 % 10;
      tokens.push(String(tens), 'puluh');
      if (ones > 0) {
        tokens.push(String(ones));
      }
    }
  }
  
  return tokens;
}

function getEnglishNumberTokens(num) {
  if (num === 0) return ['0'];
  const tokens = [];
  
  const hundreds = Math.floor(num / 100);
  const remainder100 = num % 100;
  
  if (hundreds > 0) {
    tokens.push(String(hundreds), 'hundred');
  }
  
  if (remainder100 > 0) {
    if (remainder100 <= 19) {
      tokens.push(String(remainder100));
    } else {
      const tens = Math.floor(remainder100 / 10) * 10;
      const ones = remainder100 % 10;
      tokens.push(String(tens));
      if (ones > 0) {
        tokens.push(String(ones));
      }
    }
  }
  
  return tokens;
}

function getChineseNumberTokens(num) {
  if (num === 0) return ['0'];
  const tokens = [];
  
  const hundreds = Math.floor(num / 100);
  const remainder100 = num % 100;
  
  if (hundreds > 0) {
    tokens.push(String(hundreds), 'bai');
  }
  
  if (remainder100 > 0) {
    if (hundreds > 0 && remainder100 < 10) {
      tokens.push('0');
    }
    
    if (remainder100 < 10) {
      tokens.push(String(remainder100));
    } else if (remainder100 === 10) {
      tokens.push('10');
    } else if (remainder100 < 20) {
      tokens.push('shi', String(remainder100 % 10));
    } else {
      const tens = Math.floor(remainder100 / 10);
      const ones = remainder100 % 10;
      tokens.push(String(tens), 'shi');
      if (ones > 0) {
        tokens.push(String(ones));
      }
    }
  }
  
  return tokens;
}

async function getVoiceAnnouncementFiles(ticketNumber, deskNumber) {
  const prefix = ticketNumber.charAt(0);
  const num = parseInt(ticketNumber.substring(1));
  
  const deskWord = deskNumber.replace(/[0-9]+/g, '').trim();
  const deskNum = parseInt(deskNumber.replace(/[^0-9]/g, ''));
  
  const files = [];

  const getDeskWordFile = async (word, lang) => {
    const cleanWord = word.trim().toLowerCase();
    
    // Map standard words directly to static vocabulary files to avoid redundant TTS generation
    if (lang === 'id' && cleanWord === 'loket') return 'id_loket.wav';
    if (lang === 'en' && cleanWord === 'counter') return 'en_counter.wav';
    if (lang === 'zh' && cleanWord === '柜台') return 'zh_counter.wav';
    
    // Custom phrase generation
    const crypto = require('crypto');
    const hash = crypto.createHash('md5').update(cleanWord).digest('hex');
    const filename = `${lang}_phrase_${hash}.wav`;
    
    try {
      const ttsGenerator = require('./tts-generator');
      await ttsGenerator.generatePhraseIfNeeded(word, lang);
    } catch (err) {
      console.error(`[WebSocket Server] Dynamic TTS phrase generation failed for "${word}" (${lang}):`, err.message);
    }
    
    return filename;
  };

  // 1. Indonesian
  files.push('id_nomor_antrian.wav');
  files.push(`id_letter_${prefix}.wav`);
  const idNumTokens = getIndonesianNumberTokens(num);
  idNumTokens.forEach(t => files.push(`id_${t}.wav`));
  files.push('id_silakan_menuju.wav');
  if (deskWord) {
    files.push(await getDeskWordFile(deskWord, 'id'));
  } else {
    files.push('id_loket.wav');
  }
  if (!isNaN(deskNum)) {
    const idDeskTokens = getIndonesianNumberTokens(deskNum);
    idDeskTokens.forEach(t => files.push(`id_${t}.wav`));
  }

  // 2. English
  files.push('en_queue_number.wav');
  files.push(`en_letter_${prefix}.wav`);
  const enNumTokens = getEnglishNumberTokens(num);
  enNumTokens.forEach(t => files.push(`en_${t}.wav`));
  files.push('en_please_proceed_to.wav');
  if (deskWord) {
    const enWord = deskWord.replace(/loket/i, 'counter');
    files.push(await getDeskWordFile(enWord, 'en'));
  } else {
    files.push('en_counter.wav');
  }
  if (!isNaN(deskNum)) {
    const enDeskTokens = getEnglishNumberTokens(deskNum);
    enDeskTokens.forEach(t => files.push(`en_${t}.wav`));
  }

  // 3. Chinese
  files.push('zh_queue_number.wav');
  files.push(`zh_letter_${prefix}.wav`);
  const zhNumTokens = getChineseNumberTokens(num);
  zhNumTokens.forEach(t => files.push(`zh_${t}.wav`));
  files.push('zh_please_proceed_to.wav');
  if (deskWord) {
    const zhWord = deskWord
      .replace(/loket/i, '柜台')
      .replace(/customer\s*service/i, '客户服务')
      .replace(/teller/i, '出纳柜台');
    files.push(await getDeskWordFile(zhWord, 'zh'));
  } else {
    files.push('zh_counter.wav');
  }
  if (!isNaN(deskNum)) {
    const zhDeskTokens = getChineseNumberTokens(deskNum);
    zhDeskTokens.forEach(t => files.push(`zh_${t}.wav`));
  }

  return files;
}

async function announceCall(ticketNumber, deskNumber, serviceName) {
  const voiceFiles = await getVoiceAnnouncementFiles(ticketNumber, deskNumber);
  broadcast({
    type: 'ANNOUNCE_CALL',
    payload: {
      ticketNumber,
      deskNumber,
      serviceName,
      voiceFiles
    }
  });
}
