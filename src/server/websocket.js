const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { app } = require('electron');
const db = require('./db');
const ttsGenerator = require('./tts-generator');

let wss = null;
let httpServer = null;
let heartbeatInterval = null;
let dayRolloverInterval = null;
let cachedQrUrl = '';
let cachedQrDataUrl = '';

// Mulai server WebSocket
function startWebSocketServer(port) {
  if (wss) stopWebSocketServer();

  // Create combined HTTP server to serve local static audio files (with Range Request support)
  httpServer = http.createServer((req, res) => {
    if (req.url.startsWith('/audio/')) {
      const filename = path.basename(req.url);
      // Prioritas pencarian berkas audio:
      // 1. Folder cache TTS dinamis di userData (data/tts-cache)
      // 2. Folder berkas suara bawaan aplikasi di src/assets/tts-prebuilt
      // 3. Folder data/tts-cache di process.cwd()
      let filePath = path.join(ttsGenerator.cacheDir, filename);
      if (!fs.existsSync(filePath)) {
        filePath = path.join(__dirname, '..', 'assets', 'tts-prebuilt', filename);
      }
      if (!fs.existsSync(filePath)) {
        filePath = path.join(process.cwd(), 'data', 'tts-cache', filename);
      }
      
      if (fs.existsSync(filePath)) {
        const stat = fs.statSync(filePath);
        const total = stat.size;
        const range = req.headers.range;
        
        // Deteksi tipe MIME berdasarkan ekstensi file
          const audioExt = path.extname(filePath).toLowerCase();
          const audioMime = { '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.opus': 'audio/opus', '.flac': 'audio/flac' };
          const audioContentType = audioMime[audioExt] || 'audio/wav';

          if (range) {
          const parts = range.replace(/bytes=/, "").split("-");
          const partialstart = parts[0];
          const partialend = parts[1];
          
          const start = parseInt(partialstart, 10);
          const end = partialend ? parseInt(partialend, 10) : total - 1;

          // Validasi range bounds
          if (isNaN(start) || start < 0 || start >= total || end < start || end >= total) {
            res.writeHead(416, { 'Content-Range': `bytes */${total}` });
            res.end();
            return;
          }

          const chunksize = (end - start) + 1;
          
          res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${total}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunksize,
            'Content-Type': audioContentType
          });
          
          const stream = fs.createReadStream(filePath, { start: start, end: end });
          stream.pipe(res);
          res.on('close', () => stream.destroy());
        } else {
          res.writeHead(200, {
            'Content-Length': total,
            'Content-Type': audioContentType,
            'Accept-Ranges': 'bytes'
          });
          const stream = fs.createReadStream(filePath);
          stream.pipe(res);
          res.on('close', () => stream.destroy());
        }
      } else {
        res.writeHead(404);
        res.end();
      }
    } else if (req.url.startsWith('/video/')) {
      const filename = path.basename(decodeURIComponent(req.url.split('?')[0]));
      const videoDir = app ? path.join(app.getPath('userData'), 'data', 'videos') : path.join(process.cwd(), 'data', 'videos');
      const filePath = path.join(videoDir, filename);
      
      // Gunakan fs.stat async agar tidak memblokir event loop saat melayani video
      // fs.existsSync + fs.statSync sebelumnya SYNCHRONOUS -> memblokir event loop
      // pada setiap range request -> menyebabkan stutter pada SEMUA stream aktif
      fs.stat(filePath, (statErr, stat) => {
      if (statErr || !stat) {
        res.writeHead(404);
        res.end();
        return;
      }
        const total = stat.size;
        const range = req.headers.range;
        
        const ext = path.extname(filePath).toLowerCase();
        const mimeTypes = {
          // Videos
          '.mp4': 'video/mp4',
          '.m4v': 'video/mp4',
          '.webm': 'video/webm',
          '.ogg': 'video/ogg',
          '.ogv': 'video/ogg',
          '.mkv': 'video/x-matroska',
          '.mov': 'video/quicktime',
          '.avi': 'video/x-msvideo',
          '.wmv': 'video/x-ms-wmv',
          '.flv': 'video/x-flv',
          '.3gp': 'video/3gpp',
          '.ts': 'video/mp2t',
          // Images
          '.webp': 'image/webp',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.png': 'image/png',
          '.gif': 'image/gif',
          '.bmp': 'image/bmp',
          '.svg': 'image/svg+xml',
          '.avif': 'image/avif',
          '.ico': 'image/x-icon'
        };
        const contentType = mimeTypes[ext] || 'application/octet-stream';
        
        if (range) {
          const parts = range.replace(/bytes=/, "").split("-");
          const partialstart = parts[0];
          const partialend = parts[1];
          
          const start = parseInt(partialstart, 10);
          // Gunakan range penuh yang diminta browser dengan buffer 512KB agar video bitrate tinggi tidak buffer-stall
          const end = partialend ? parseInt(partialend, 10) : total - 1;

          // Validasi range bounds
          if (isNaN(start) || start < 0 || start >= total || end < start || end >= total) {
            res.writeHead(416, { 'Content-Range': `bytes */${total}` });
            res.end();
            return;
          }

          const chunksize = (end - start) + 1;
          
          res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${total}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunksize,
            'Content-Type': contentType,
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=86400, immutable'
          });
          
          const stream = fs.createReadStream(filePath, { start, end, highWaterMark: 1024 * 1024 });
          stream.pipe(res);
          res.on('close', () => stream.destroy());
        } else {
          res.writeHead(200, {
            'Content-Length': total,
            'Content-Type': contentType,
            'Accept-Ranges': 'bytes',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=86400, immutable'
          });
          const stream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
          stream.pipe(res);
          res.on('close', () => stream.destroy());
        }
      }); // tutup fs.stat callback
    } else if (req.url === '/api/discovery' || req.url === '/discovery' || req.url === '/api/ping') {
      db.getSettings().then(settings => {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify({
          type: 'ping',
          serverUuid: settings.server_uuid || '',
          serverName: settings.server_name || 'Server Utama',
          port: parseInt(settings.port, 10) || 8080,
          timestamp: Date.now()
        }));
      }).catch(() => {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({
          type: 'ping',
          serverName: 'Server Antrian',
          port: 8080,
          timestamp: Date.now()
        }));
      });
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
    ws.isAlive = true;

    ws.on('pong', () => {
      ws.isAlive = true;
    });

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
        if (action.type === 'PONG') {
          ws.isAlive = true;
          return;
        }
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

  // Heartbeat berkala setiap 25 detik agar koneksi tidak diputus router/OS saat idle
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  heartbeatInterval = setInterval(() => {
    if (!wss) return;
    wss.clients.forEach((client) => {
      if (client.isAlive === false) {
        console.log('[WebSocket Server] Memutuskan koneksi client yang tidak merespon heartbeat.');
        return client.terminate();
      }
      client.isAlive = false;
      try {
        client.ping();
        client.send(JSON.stringify({ type: 'PING' }));
      } catch (_) {}
    });
  }, 25000);

  // Interval pemeriksaan pergantian hari otomatis setiap 60 detik
  if (dayRolloverInterval) {
    clearInterval(dayRolloverInterval);
  }
  dayRolloverInterval = setInterval(async () => {
    try {
      const changed = await db.handleDayRollover();
      if (changed) {
        await broadcastStateUpdate();
      }
    } catch (_) {}
  }, 60000);

  httpServer.on('error', (err) => {
    console.error('[WebSocket/HTTP Server Error]:', err);
  });

  httpServer.listen(port, '0.0.0.0', () => {
    console.log(`WebSocket & HTTP Audio Server listening on 0.0.0.0:${port}`);
  });
}

// Hentikan server WebSocket
function stopWebSocketServer() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
  if (dayRolloverInterval) {
    clearInterval(dayRolloverInterval);
    dayRolloverInterval = null;
  }
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
  // handleDayRollover DIHAPUS dari sini — sudah dijalankan oleh dayRolloverInterval (60 detik)
  // dan oleh callNextTicket/createTicket. Memanggil di sini menambah 5+ query SQL
  // pada SETIAP broadcast, menyebabkan lag/freeze video.
  const services = await db.getServices();
  const waitingTickets = await db.getWaitingTickets();
  const callingTickets = await db.getCallingTickets();
  const settings = await db.getSettings();
  let videoPlaylist = [];
  if (settings.video_playlist) {
    try { videoPlaylist = JSON.parse(settings.video_playlist); } catch (_) { console.error('[WebSocket] Malformed video_playlist JSON in DB, using empty playlist'); }
  }
  const displayMode = settings.display_mode || 'queue';
  const mirrorWindowName = settings.mirror_window_name || '';
  const mirrorCropTop = settings.mirror_crop_top === 'true';
  const videoSidebarMuted = settings.video_sidebar_muted !== 'false'; // default true
  const videoFullscreenMuted = settings.video_fullscreen_muted === 'true'; // default false
  const colorTheme = settings.color_theme || 'default';
  const displayLayout = settings.display_layout || 'standard';
  const photoDuration = parseInt(settings.photo_duration, 10) || 10;
  
  const surveyUrl = settings.feedback_survey_url ? settings.feedback_survey_url.trim() : '';
  let feedbackQrDataUrl = '';
  if (surveyUrl) {
    // Cache QR agar tidak di-regenerate setiap broadcast (CPU-intensive)
    if (cachedQrUrl === surveyUrl && cachedQrDataUrl) {
      feedbackQrDataUrl = cachedQrDataUrl;
    } else {
      try {
        const QRCode = require('qrcode');
        feedbackQrDataUrl = await QRCode.toDataURL(surveyUrl, {
          margin: 1,
          width: 140,
          color: { dark: '#0b0f19', light: '#ffffff' }
        });
        cachedQrUrl = surveyUrl;
        cachedQrDataUrl = feedbackQrDataUrl;
      } catch (err) {
        console.error('[WebSocket] Error generating survey QR code:', err.message);
      }
    }
  } else {
    cachedQrUrl = '';
    cachedQrDataUrl = '';
  }

  return {
    serverName: settings.server_name || 'Server Utama',
    serverUuid: settings.server_uuid || '',
    services,
    waitingTickets,
    callingTickets,
    videoPlaylist,
    displayMode,
    mirrorWindowName,
    mirrorCropTop,
    videoSidebarMuted,
    videoFullscreenMuted,
    colorTheme,
    displayLayout,
    photoDuration,
    ttsLanguage: settings.tts_language || 'id',
    displayTitle: settings.display_title || 'SimpleAntrian',
    displaySubtitle: settings.display_subtitle || '',
    displayLogo: settings.display_logo || '',
    feedbackSurveyUrl: surveyUrl,
    feedbackDisplayMode: settings.feedback_display_mode || 'both',
    feedbackQrDataUrl
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
          await announceCall(calledTicket.ticket_number, calledTicket.desk_number, calledTicket.service_name, calledTicket.customer_name);

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
          await announceCall(calledTicket.ticket_number, calledTicket.desk_number, calledTicket.service_name, calledTicket.customer_name);

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
        const { ticketId, deskNumber } = payload;
        if (ticketId && deskNumber) {
          await db.updateTicketDesk(ticketId, deskNumber);
        }
        const recalledTicket = await db.recallTicket(ticketId);
        
        if (recalledTicket) {
          await broadcastStateUpdate();

          // Kirim trigger panggilan ulang suara
          await announceCall(recalledTicket.ticket_number, recalledTicket.desk_number, recalledTicket.service_name, recalledTicket.customer_name);
        }
        break;
      }

      case 'COMPLETE': {
        const { ticketId, serviceId, deskNumber, autoCallNext } = payload;
        // Selesaikan tiket di database
        let ticket = null;
        if (ticketId) {
          ticket = await db.completeTicket(ticketId);
        }

        const settings = await db.getSettings();
        // Default auto-call adalah true kecuali jika dinonaktifkan di pengaturan
        const isAutoCallEnabled = settings.auto_call_next_on_complete !== 'false';
        const shouldAutoCall = autoCallNext !== undefined ? autoCallNext === true : isAutoCallEnabled;

        const targetServiceId = (ticket && ticket.service_id) || serviceId;
        const targetDesk = (ticket && ticket.desk_number) || deskNumber || 'Loket 1';

        // Pastikan tidak ada tiket calling zombie tertinggal untuk desk ini
        if (targetDesk) {
          await db.completeCallingTicketsByDesk(targetDesk, targetServiceId);
        }

        if (shouldAutoCall && targetServiceId) {
          // Cari apakah ada antrian berikutnya untuk layanan yang sama
          const calledTicket = await db.callNextTicket(targetServiceId, targetDesk);
          if (calledTicket) {
            await broadcastStateUpdate();
            
            // Broadcast ke display untuk memutar suara panggilan
            await announceCall(calledTicket.ticket_number, calledTicket.desk_number, calledTicket.service_name, calledTicket.customer_name);

            // Kirim notifikasi WA
            try {
              const { sendTicketCalledNotification } = require('./whatsapp');
              sendTicketCalledNotification(calledTicket);
            } catch (e) {}

            try {
              await triggerWhatsAppQueueReminder(targetServiceId, calledTicket.number_sequence);
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

      case 'STOP_ANNOUNCEMENT': {
        broadcast({
          type: 'STOP_ANNOUNCEMENT'
        });
        break;
      }

      case 'SAVE_TTS': {
        const { enabled, multilang, ttsLanguage, callName, callDesk, autoCallNext } = payload;
        const dbMod = require('./db');
        if (enabled !== undefined) await dbMod.saveSetting('tts_enabled', enabled);
        if (ttsLanguage !== undefined) {
          await dbMod.saveSetting('tts_language', ttsLanguage);
          await dbMod.saveSetting('multilang_enabled', ttsLanguage === 'id_en' ? 'true' : 'false');
        } else if (multilang !== undefined) {
          await dbMod.saveSetting('multilang_enabled', multilang);
          await dbMod.saveSetting('tts_language', multilang === 'true' ? 'id_en' : 'id');
        }
        if (callName !== undefined) {
          await dbMod.saveSetting('call_customer_name', callName);
        }
        if (callDesk !== undefined) {
          await dbMod.saveSetting('call_desk_enabled', callDesk);
        }
        if (autoCallNext !== undefined) {
          await dbMod.saveSetting('auto_call_next_on_complete', autoCallNext);
        }
        // Broadcast ke semua client
        broadcast({
          type: 'TTS_SETTING_UPDATE',
          payload: { enabled, multilang, ttsLanguage: ttsLanguage || 'id', callName, autoCallNext }
        });
        // Kirim status TTS engine terkini ke seluruh klien agar progress bar muncul
        const currentTtsStatus = ttsGenerator.getLastStatus();
        broadcast({
          type: 'TTS_GEN_STATUS',
          payload: currentTtsStatus
        });
        ws.send(JSON.stringify({ type: 'ALERT', payload: { message: 'Pengaturan Suara (TTS) berhasil disimpan!' } }));
        
        // Memicu inisialisasi model TTS latar belakang jika multilang diaktifkan
        try {
          await ttsGenerator.initialize();
        } catch (e) {}
        break;
      }

      case 'SAVE_DISPLAY_CUSTOM': {
        const { title, subtitle, logo, theme, layout, feedbackSurveyUrl, feedbackDisplayMode } = payload;
        const dbMod = require('./db');
        if (title !== undefined) await dbMod.saveSetting('display_title', title);
        if (subtitle !== undefined) await dbMod.saveSetting('display_subtitle', subtitle);
        if (logo !== undefined) await dbMod.saveSetting('display_logo', logo);
        if (theme !== undefined) await dbMod.saveSetting('color_theme', theme);
        if (layout !== undefined) await dbMod.saveSetting('display_layout', layout);
        if (feedbackSurveyUrl !== undefined) await dbMod.saveSetting('feedback_survey_url', feedbackSurveyUrl.trim());
        if (feedbackDisplayMode !== undefined) await dbMod.saveSetting('feedback_display_mode', feedbackDisplayMode);
        
        // Broadcast ke semua client
        broadcast({
          type: 'DISPLAY_CUSTOM_UPDATE',
          payload: { title, subtitle, logo, theme, layout, feedbackSurveyUrl, feedbackDisplayMode }
        });
        await broadcastStateUpdate();
        ws.send(JSON.stringify({ type: 'ALERT', payload: { message: 'Pengaturan Tampilan & Survei berhasil disimpan!' } }));
        break;
      }

      case 'SAVE_VIDEO_PLAYLIST': {
        const { playlist, photoDuration } = payload;
        if (!Array.isArray(playlist)) break;
        const dbMod = require('./db');
        await dbMod.saveSetting('video_playlist', JSON.stringify(playlist));
        if (photoDuration !== undefined) {
          await dbMod.saveSetting('photo_duration', String(photoDuration));
        }
        
        // Broadcast ke semua client
        broadcast({
          type: 'VIDEO_PLAYLIST_UPDATE',
          payload: { playlist, photoDuration }
        });
        await broadcastStateUpdate();
        ws.send(JSON.stringify({ type: 'ALERT', payload: { message: 'Playlist Media berhasil disimpan!' } }));
        break;
      }

      case 'SAVE_DISPLAY_MODE': {
        const { mode } = payload;
        const dbMod = require('./db');
        await dbMod.saveSetting('display_mode', mode);
        
        // Broadcast ke semua client
        broadcast({
          type: 'DISPLAY_MODE_UPDATE',
          payload: { mode }
        });
        await broadcastStateUpdate();
        break;
      }

      case 'SAVE_MIRROR_WINDOW': {
        const { windowName } = payload;
        const dbMod = require('./db');
        await dbMod.saveSetting('mirror_window_name', windowName);
        
        // Broadcast ke semua client
        broadcast({
          type: 'MIRROR_WINDOW_UPDATE',
          payload: { windowName }
        });
        await broadcastStateUpdate();
        break;
      }

      case 'SAVE_MIRROR_CROP': {
        const { crop } = payload;
        const dbMod = require('./db');
        await dbMod.saveSetting('mirror_crop_top', crop ? 'true' : 'false');
        
        // Broadcast ke semua client
        broadcast({
          type: 'MIRROR_CROP_UPDATE',
          payload: { crop }
        });
        await broadcastStateUpdate();
        break;
      }

      case 'SAVE_VIDEO_AUDIO_SETTINGS': {
        const { sidebarMuted, fullscreenMuted } = payload;
        const dbMod = require('./db');
        await dbMod.saveSetting('video_sidebar_muted', sidebarMuted ? 'true' : 'false');
        await dbMod.saveSetting('video_fullscreen_muted', fullscreenMuted ? 'true' : 'false');
        
        // Broadcast state update agar sinkron
        await broadcastStateUpdate();
        ws.send(JSON.stringify({ type: 'ALERT', payload: { message: 'Pengaturan Suara Video berhasil disimpan!' } }));
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

      case 'UPDATE_ACTIVE_TICKET_DESK': {
        const { ticketId, deskNumber } = payload;
        if (ticketId && deskNumber) {
          await db.updateTicketDesk(ticketId, deskNumber);
          await broadcastStateUpdate();
        }
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

async function getVoiceAnnouncementFiles(ticketNumber, deskNumber, customerName) {
  const prefix = ticketNumber.charAt(0);
  const num = parseInt(ticketNumber.substring(1), 10);
  
  let safeDesk = (deskNumber || 'Loket 1').trim();
  const digits = safeDesk.replace(/[^0-9]/g, '');
  const deskNum = digits ? parseInt(digits, 10) : 1;
  let deskWord = safeDesk.replace(/[0-9]+/g, '').trim().toLowerCase();
  
  // Jika deskWord kosong atau kata kategori layanan (bukan kata loket/counter/meja/ruang), fallback ke 'loket'
  if (!deskWord || (!deskWord.includes('loket') && !deskWord.includes('counter') && !deskWord.includes('meja') && !deskWord.includes('ruang') && !deskWord.includes('desk') && !deskWord.includes('cs'))) {
    deskWord = 'loket';
  }
  
  const files = [];

  const getDeskWordFile = async (word, lang) => {
    const cleanWord = word.trim().toLowerCase();
    
    // Map standard words directly to static vocabulary files to avoid redundant TTS generation
    if (lang === 'id' && (cleanWord === 'loket' || cleanWord === 'counter')) return 'id_loket.wav';
    if (lang === 'en' && (cleanWord === 'counter' || cleanWord === 'loket')) return 'en_counter.wav';
    
    // Custom phrase generation via Piper if available
    try {
      const ttsGenerator = require('./tts-generator');
      const generated = await ttsGenerator.generatePhraseIfNeeded(word, lang);
      if (generated) return generated;
    } catch (err) {
      console.warn(`[WebSocket Server] Dynamic TTS phrase generation failed for "${word}" (${lang}):`, err.message);
    }
    
    // Fallback aman ke berkas audio bawaan (loket / counter) agar tidak terjadi audio hilang / 404
    return lang === 'en' ? 'en_counter.wav' : 'id_loket.wav';
  };

  const settings = await db.getSettings();
  const ttsLanguage = settings.tts_language || (settings.multilang_enabled === 'true' ? 'id_en' : 'id');
  const isCallNameEnabled = settings.call_customer_name !== 'false';
  const isCallDeskEnabled = settings.call_desk_enabled !== 'false';
  const cleanName = customerName ? customerName.trim() : '';

  // Helper untuk panggil nomor antrian dalam Bahasa Indonesia
  const appendIndonesianVoice = async () => {
    files.push('id_nomor_antrian.wav');
    files.push(`id_letter_${prefix}.wav`);
    const idNumTokens = getIndonesianNumberTokens(num);
    idNumTokens.forEach(t => files.push(`id_${t}.wav`));

    if (isCallNameEnabled && cleanName && cleanName !== 'Pelanggan' && cleanName !== 'Pelanggan Mandiri') {
      try {
        const ttsGenerator = require('./tts-generator');
        const namePhraseFile = await ttsGenerator.generatePhraseIfNeeded(cleanName, 'id');
        if (namePhraseFile) files.push(namePhraseFile);
      } catch (err) {
        console.error(`[TTS] Gagal generate audio nama "${cleanName}":`, err.message);
      }
    }

    // Hanya ucapkan "silakan menuju loket..." jika opsi sebutkan loket diaktifkan
    if (isCallDeskEnabled) {
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
    }
  };

  // Helper untuk panggil nomor antrian dalam Bahasa Inggris
  const appendEnglishVoice = async () => {
    files.push('en_queue_number.wav');
    files.push(`en_letter_${prefix}.wav`);
    const enNumTokens = getEnglishNumberTokens(num);
    enNumTokens.forEach(t => files.push(`en_${t}.wav`));

    if (isCallNameEnabled && cleanName && cleanName !== 'Pelanggan' && cleanName !== 'Pelanggan Mandiri') {
      try {
        const ttsGenerator = require('./tts-generator');
        const enNameFile = await ttsGenerator.generatePhraseIfNeeded(cleanName, 'en');
        if (enNameFile) files.push(enNameFile);
      } catch (_) {}
    }

    // Hanya ucapkan "please proceed to counter..." jika opsi sebutkan loket diaktifkan
    if (isCallDeskEnabled) {
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
    }
  };

  if (ttsLanguage === 'en') {
    // Mode Bahasa Inggris murni (English Only)
    await appendEnglishVoice();
  } else if (ttsLanguage === 'id_en') {
    // Mode Dua Bahasa (Bahasa Indonesia kemudian Bahasa Inggris)
    await appendIndonesianVoice();
    await appendEnglishVoice();
  } else {
    // Default: Bahasa Indonesia murni (Indonesian Only)
    await appendIndonesianVoice();
  }

  return files;
}

async function announceCall(ticketNumber, deskNumber, serviceName, customerName) {
  const voiceFiles = await getVoiceAnnouncementFiles(ticketNumber, deskNumber, customerName);
  broadcast({
    type: 'ANNOUNCE_CALL',
    payload: {
      ticketNumber,
      deskNumber,
      serviceName,
      customerName: customerName || '',
      voiceFiles
    }
  });
}
