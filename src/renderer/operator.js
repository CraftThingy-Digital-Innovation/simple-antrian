// State Global
let ws = null;
let currentMode = 'server';
let serverIp = 'localhost';
let serverPort = 8080;
let servicesList = [];
let localDeskSettings = {}; // Menyimpan nomor loket per layanan, misal: { teller: 'Loket 1' }
let currentTxId = '';

function generateTxId() {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

// Callbacks map untuk menampung Promise resolve dari request WebSocket (Client Mode)
const wsRequestCallbacks = {};

async function getSettingsData() {
  if (currentMode === 'client') {
    return new Promise((resolve) => {
      wsRequestCallbacks['SETTINGS_RESPONSE'] = resolve;
      sendAction('GET_SETTINGS');
    });
  } else {
    return await window.api.getSettings();
  }
}

async function getServicesData() {
  if (currentMode === 'client') {
    return servicesList || [];
  } else {
    return await window.api.getServices();
  }
}

async function getDailyStatsData(dateStr) {
  if (currentMode === 'client') {
    return new Promise((resolve) => {
      wsRequestCallbacks['STATS_RESPONSE'] = resolve;
      sendAction('GET_STATS', { dateStr });
    });
  } else {
    return await window.api.getDailyStats(dateStr);
  }
}

async function searchTicketsData(query, status, serviceId, dateStr) {
  if (currentMode === 'client') {
    return new Promise((resolve) => {
      wsRequestCallbacks['SEARCH_RESPONSE'] = resolve;
      sendAction('SEARCH_TICKETS', { query, status, serviceId, dateStr });
    });
  } else {
    return await window.api.searchTickets(query, status, serviceId, dateStr);
  }
}

// Inisialisasi Halaman
document.addEventListener('DOMContentLoaded', async () => {
  // Load nomor loket yang tersimpan di localStorage
  const savedDesks = localStorage.getItem('local_desk_settings');
  if (savedDesks) {
    localDeskSettings = JSON.parse(savedDesks);
  }

  // Setup tab navigation
  setupTabs();
  
  // Ambil info sistem dan inisialisasi koneksi
  await initSystemInfo();

  // Setup event listeners
  setupEventListeners();

  // Load awal tab statistik dengan tanggal hari ini
  const today = new Date().toISOString().split('T')[0];
  document.getElementById('stats-date').value = today;
  document.getElementById('search-date').value = today;
  loadStats(today);
});

// Setup Tab Navigation
function setupTabs() {
  const navItems = document.querySelectorAll('.nav-item');
  const tabContents = document.querySelectorAll('.tab-content');

  navItems.forEach(item => {
    item.addEventListener('click', () => {
      const tabName = item.getAttribute('data-tab');
      
      navItems.forEach(n => n.classList.remove('active'));
      tabContents.forEach(c => c.classList.remove('active'));
      
      item.classList.add('active');
      document.getElementById(`tab-${tabName}`).classList.add('active');

      // Refresh data jika beralih ke tab tertentu
      if (tabName === 'stats') {
        const date = document.getElementById('stats-date').value;
        loadStats(date);
      } else if (tabName === 'search') {
        triggerSearch();
      } else if (tabName === 'settings') {
        loadSettings();
        loadRunningTexts(); // refresh running texts setiap kali tab settings dibuka
      }
    });
  });
}

// Ambil info sistem (Mode, IP, Port)
async function initSystemInfo() {
  try {
    const info = await window.api.getSystemInfo();
    currentMode = info.mode;
    serverPort = info.port || 8080;
    
    // Tampilkan versi aplikasi & hubungkan listener pembaruan GitHub
    document.getElementById('lbl-app-version').innerText = `v${info.appVersion}`;
    window.api.onAppUpdateAvailable((updateInfo) => {
      const banner = document.getElementById('app-update-banner');
      const lblNew = document.getElementById('lbl-new-app-version');
      const btnDownload = document.getElementById('btn-download-update');
      
      lblNew.innerText = `v${updateInfo.latest}`;
      banner.style.display = 'block';
      btnDownload.onclick = () => {
        window.api.openExternalUrl(updateInfo.url);
      };

      // Tampilkan toast notifikasi
      showToast(`Pembaruan aplikasi tersedia: v${updateInfo.latest}! Silakan periksa tab Pengaturan.`, 'info');

      // Tampilkan prompt konfirmasi agar user langsung menyadari adanya update
      setTimeout(() => {
        if (confirm(`Pembaruan Baru Tersedia!\n\nVersi v${updateInfo.latest} telah dirilis (versi Anda saat ini: v${info.appVersion}).\nApakah Anda ingin membuka halaman unduhan GitHub sekarang untuk memperbarui aplikasi?`)) {
          window.api.openExternalUrl(updateInfo.url);
        }
      }, 1000);
    });
    
    // Tampilkan mode di UI
    const badgeMode = document.getElementById('badge-mode');
    badgeMode.innerText = currentMode === 'server' ? 'Server Mode' : 'Client Mode';
    badgeMode.className = `badge ${currentMode === 'server' ? 'badge-waiting' : 'badge-completed'}`;

    if (currentMode === 'server') {
      document.getElementById('network-status-title').innerText = 'Server Aktif (Lokal)';
      document.getElementById('status-text').innerText = `${info.localIp}:${serverPort}`;
      document.getElementById('status-dot').style.background = 'var(--accent-success)';
      
      // Update local server name display
      const settings = await window.api.getSettings();
      if (settings && settings.server_name) {
        const lbl = document.getElementById('status-server-name');
        const val = document.getElementById('status-server-name-val');
        if (lbl && val) {
          val.innerText = settings.server_name;
          lbl.style.display = 'block';
        }
      }
      
      // Sembunyikan/Tampilkan menu pengaturan yang relevan
      document.getElementById('settings-server-group').style.display = 'flex';
      document.getElementById('settings-client-group').style.display = 'none';
      document.getElementById('section-services-config').style.display = 'block';
      document.getElementById('section-db-config').style.display = 'block';
      
      // Connect ke WebSocket lokal
      connectWebSocket(`ws://localhost:${serverPort}`);
    } else {
      document.getElementById('network-status-title').innerText = 'Koneksi Server';
      document.getElementById('status-text').innerText = 'Mencari server...';
      document.getElementById('status-dot').style.background = 'var(--accent-warning)';
      
      document.getElementById('settings-server-group').style.display = 'none';
      document.getElementById('settings-client-group').style.display = 'flex';
      document.getElementById('section-services-config').style.display = 'none';
      document.getElementById('section-db-config').style.display = 'none';

      // Load server terakhir yang disimpan jika ada
      const lastConnectedServer = localStorage.getItem('last_connected_server');
      if (lastConnectedServer) {
        document.getElementById('status-text').innerText = `Menghubungkan ke ${lastConnectedServer}...`;
        connectWebSocket(`ws://${lastConnectedServer}`);
      }

      // Mulai mendengarkan daftar server dari UDP Multicast
      window.api.onServersUpdated((servers) => {
        renderDiscoveredServers(servers);
      });
    }
  } catch (err) {
    showToast('Gagal memuat informasi sistem: ' + err.message, 'error');
  }
}

// Render server yang ditemukan di jaringan lokal (UDP)
function renderDiscoveredServers(servers) {
  const container = document.getElementById('discovered-servers-list');
  if (servers.length === 0) {
    container.innerHTML = '<div style="text-align: center; color: var(--text-muted); padding: 15px;">Mencari server di jaringan lokal (UDP)...</div>';
    return;
  }

  container.innerHTML = '';
  servers.forEach(srv => {
    const srvIpPort = `${srv.ip}:${srv.port}`;
    const div = document.createElement('div');
    div.className = 'server-list-item animate-pop-in';
    div.innerHTML = `
      <div>
        <div class="server-info-title">${srv.name}</div>
        <div class="server-info-ip">${srvIpPort}</div>
      </div>
      <button class="btn btn-secondary btn-sm" onclick="connectToRemoteServer('${srvIpPort}')">
        Hubungkan
      </button>
    `;
    container.appendChild(div);
  });
}

// Hubungkan ke server remote (Client Mode)
window.connectToRemoteServer = function(ipPort) {
  localStorage.setItem('last_connected_server', ipPort);
  document.getElementById('status-text').innerText = `Menghubungkan ke ${ipPort}...`;
  connectWebSocket(`ws://${ipPort}`);
};

// Inisialisasi Koneksi WebSocket
function connectWebSocket(url) {
  if (ws) {
    ws.close();
  }

  showToast(`Menghubungkan ke WebSocket ${url}...`, 'info');
  ws = new WebSocket(url);

  ws.onopen = () => {
    showToast('Koneksi WebSocket berhasil terhubung!', 'success');
    document.getElementById('status-dot').style.background = 'var(--accent-success)';
    
    const displayUrl = url.replace('ws://', '').replace('localhost', 'Server');
    document.getElementById('status-text').innerText = displayUrl;
    
    // Minta data state awal
    sendAction('GET_STATE');
    
    // Sync desk names for local TTS pre-generation
    sendAction('SYNC_DESK_NAMES', { deskNames: Object.values(localDeskSettings) });
  };

  ws.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data);
      handleWebSocketMessage(message);
    } catch (err) {
      console.error('Error parsing WS message:', err);
    }
  };

  ws.onclose = () => {
    document.getElementById('status-dot').style.background = 'var(--accent-secondary)';
    document.getElementById('status-text').innerText = 'Terputus';
    showToast('Koneksi terputus. Mencoba menghubungkan kembali dalam 5 detik...', 'error');
    
    // Auto reconnect
    setTimeout(() => {
      connectWebSocket(url);
    }, 5000);
  };

  ws.onerror = (err) => {
    console.error('WebSocket Error:', err);
  };
}

// Kirim aksi ke WebSocket Server
function sendAction(type, payload = {}) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, payload }));
  } else {
    showToast('Gagal mengirim perintah: Koneksi terputus.', 'error');
  }
}

// Handle pesan masuk dari WebSocket Server
function handleWebSocketMessage(message) {
  const { type, payload } = message;
  
  switch (type) {
    case 'STATE_UPDATE':
      renderQueueState(payload);
      break;

    case 'TICKET_CREATED': {
      const ticket = payload;
      // Cetak otomatis jika tiket dibuat oleh operator ini
      if (ticket.tx_id && ticket.tx_id === currentTxId) {
        printTicketHistory(ticket.ticket_number, ticket.service_name, ticket.customer_name, ticket.created_at);
        currentTxId = ''; // Reset transaksi
      }
      break;
    }

    case 'WA_STATUS_UPDATE':
      renderWaStatus(payload);
      break;
    
    case 'ANNOUNCE_CALL':
      // Main process display window yang akan memutar suara, 
      // tapi kita juga bisa memutarnya secara opsional di operator panel.
      playVoiceAnnounce(payload.ticketNumber, payload.deskNumber, payload.voiceFiles);
      break;

    case 'ALERT':
      showToast(payload.message, 'info');
      break;

    case 'RUNNING_TEXT_SAVED':
      showToast(`✅ Teks berjalan berhasil disimpan & diterapkan! (${payload.count} teks)`, 'success');
      break;
      
    case 'SETTINGS_RESPONSE':
      if (wsRequestCallbacks['SETTINGS_RESPONSE']) {
        wsRequestCallbacks['SETTINGS_RESPONSE'](payload);
        delete wsRequestCallbacks['SETTINGS_RESPONSE'];
      }
      break;

    case 'STATS_RESPONSE':
      if (wsRequestCallbacks['STATS_RESPONSE']) {
        wsRequestCallbacks['STATS_RESPONSE'](payload);
        delete wsRequestCallbacks['STATS_RESPONSE'];
      }
      break;

    case 'SEARCH_RESPONSE':
      if (wsRequestCallbacks['SEARCH_RESPONSE']) {
        wsRequestCallbacks['SEARCH_RESPONSE'](payload);
        delete wsRequestCallbacks['SEARCH_RESPONSE'];
      }
      break;

    case 'ERROR':
      showToast(payload.message, 'error');
      break;

    case 'TTS_GEN_STATUS':
      renderTtsStatus(payload);
      break;
  }
}

// Render status download/generasi model suara offline TTS
function renderTtsStatus(statusInfo) {
  const banner = document.getElementById('tts-status-banner');
  if (!banner) return;

  const { status, progress, message } = statusInfo;
  
  if (status === 'ready' || status === 'error') {
    if (status === 'ready') {
      document.getElementById('tts-status-icon').innerText = '✅';
      document.getElementById('tts-status-title').innerText = 'Layanan Suara Offline Siap';
      document.getElementById('tts-status-desc').innerText = 'Model suara offline (TTS) berhasil dimuat.';
      document.getElementById('tts-status-progress').style.width = '100%';
      document.getElementById('tts-status-percent').innerText = '100%';
      setTimeout(() => {
        banner.style.display = 'none';
      }, 5000);
    } else {
      document.getElementById('tts-status-icon').innerText = '❌';
      document.getElementById('tts-status-title').innerText = 'Gagal Memuat Model Suara';
      document.getElementById('tts-status-desc').innerText = message || 'Gagal mengunduh dependensi lokal.';
      document.getElementById('tts-status-progress').style.width = '0%';
      document.getElementById('tts-status-percent').innerText = '0%';
      banner.style.display = 'flex';
    }
  } else {
    banner.style.display = 'flex';
    document.getElementById('tts-status-icon').innerText = '🔄';
    
    let title = 'Mempersiapkan Suara Offline (TTS)';
    if (status.startsWith('downloading_model_')) {
      const lang = status.replace('downloading_model_', '').toUpperCase();
      title = `Mengunduh Model Suara Bahasa ${lang === 'ZH' ? 'Mandarin' : lang === 'ID' ? 'Indonesia' : 'Inggris'}...`;
    } else if (status.startsWith('downloading_config_')) {
      const lang = status.replace('downloading_config_', '').toUpperCase();
      title = `Mengunduh Konfigurasi Bahasa ${lang === 'ZH' ? 'Mandarin' : lang === 'ID' ? 'Indonesia' : 'Inggris'}...`;
    } else if (status === 'downloading_binary') {
      title = 'Mengunduh Modul Piper Offline (Windows/Linux)...';
    } else if (status === 'extracting_binary') {
      title = 'Mengekstrak Modul Piper...';
    } else if (status === 'generating_vocab') {
      title = 'Menghasilkan File Suara Dasar (Angka & Huruf)...';
    }

    document.getElementById('tts-status-title').innerText = title;
    document.getElementById('tts-status-desc').innerText = message || 'Sedang mengunduh aset lokal...';
    document.getElementById('tts-status-progress').style.width = `${progress}%`;
    document.getElementById('tts-status-percent').innerText = `${progress}%`;
  }
}

// Render status WhatsApp lokal ke UI settings
function renderWaStatus(waState) {
  const { status, qr, pairingCode, pairingPhone, number, version } = waState;
  
  const badge        = document.getElementById('wa-status-badge');
  const qrContainer  = document.getElementById('wa-qr-container');
  const qrImg        = document.getElementById('wa-qr-img');
  const pairContainer = document.getElementById('wa-pairing-container');
  const pairDisplay  = document.getElementById('wa-pairing-code-display');
  const details      = document.getElementById('wa-details');
  const detailsNum   = document.getElementById('wa-details-number');
  const btnLogout    = document.getElementById('btn-wa-logout');
  const authMethods  = document.getElementById('wa-auth-methods');

  // --- Badge Status ---
  const labelMap = {
    connected:    'Terhubung ✅',
    qr:           'Pindai QR Code 📷',
    pairing_code: 'Masukkan Kode 🔐',
    connecting:   'Menghubungkan...',
    disconnected: 'Terputus'
  };
  const classMap = {
    connected:    'badge-completed',
    qr:           'badge-calling',
    pairing_code: 'badge-calling',
    connecting:   'badge-waiting',
    disconnected: 'badge-skipped'
  };
  badge.innerText   = labelMap[status] || 'Terputus';
  badge.className   = `badge ${classMap[status] || 'badge-skipped'}`;

  // --- QR Code panel ---
  if (status === 'qr' && qr) {
    qrImg.src = qr;
    qrContainer.style.display = 'flex';
  } else {
    qrContainer.style.display = 'none';
    qrImg.src = '';
  }

  // --- Pairing Code panel ---
  if (status === 'pairing_code' && pairingCode) {
    pairDisplay.innerText = pairingCode;
    pairContainer.style.display = 'flex';
  } else {
    pairContainer.style.display = 'none';
  }

  // --- Connected details ---
  if (status === 'connected') {
    detailsNum.innerText = number || '-';
    details.style.display   = 'flex';
    btnLogout.style.display = 'block';
    if (authMethods) authMethods.style.display = 'none'; // Sembunyikan pilihan metode saat sudah connect
  } else {
    details.style.display   = 'none';
    btnLogout.style.display = 'none';
    if (authMethods) authMethods.style.display = 'flex';
  }

  // --- Versi Baileys ---
  if (version) {
    document.getElementById('wa-version-lbl').innerText = `v${version}`;
  }
}

// Play Voice Announce menggunakan Web Speech API & Web Audio Ding-Dong (3 bahasa)
async function playVoiceAnnounce(ticketNumber, deskNumber, voiceFiles) {
  // Hanya bunyikan jika dicentang di setelan audio (opsional, untuk operator)
  const settings = await window.api.getSettings();
  if (settings.play_audio_operator !== 'true') return;

  if (!voiceFiles || voiceFiles.length === 0) return;

  try {
    // 1. Play Ding-Dong
    await playDingDong();

    // Get current server host from WebSocket connection to build absolute URLs
    const wsUrlObj = new URL(ws.url);
    const audioBaseUrl = `http://${wsUrlObj.host}/audio`;

    // Map filenames to full URLs
    const urls = voiceFiles.map(file => `${audioBaseUrl}/${file}`);

    // Play the sequence of audio files
    await playAudioSequence(urls);
  } catch (err) {
    console.error('Offline TTS playback failed:', err);
  }
}

function playAudioSequence(urls) {
  return new Promise((resolve) => {
    if (!urls || urls.length === 0) {
      resolve();
      return;
    }
    
    let index = 0;
    const audio = new Audio();
    
    audio.onended = () => {
      index++;
      playNext();
    };
    
    audio.onerror = (e) => {
      console.error('Audio playback error for:', urls[index], e);
      index++;
      playNext();
    };
    
    function playNext() {
      if (index >= urls.length) {
        resolve();
        return;
      }
      
      const url = urls[index];
      audio.src = url;
      audio.play().catch(err => {
        console.error('Audio play failed:', err);
        index++;
        playNext();
      });
    }
    
    playNext();
  });
}

// Ding Dong Chime menggunakan Web Audio API (Tanpa asset file audio!)
function playDingDong() {
  return new Promise((resolve) => {
    try {
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      
      const playTone = (freq, delay, duration) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, audioCtx.currentTime + delay);
        
        gain.gain.setValueAtTime(0, audioCtx.currentTime + delay);
        gain.gain.linearRampToValueAtTime(0.2, audioCtx.currentTime + delay + 0.05);
        gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + delay + duration);
        
        osc.start(audioCtx.currentTime + delay);
        osc.stop(audioCtx.currentTime + delay + duration);
      };

      playTone(659.25, 0, 0.4); // E5
      setTimeout(() => playTone(523.25, 0, 0.4), 250); // C5
      setTimeout(() => playTone(783.99, 0, 0.5), 500); // G5
      
      setTimeout(() => {
        audioCtx.close();
        resolve();
      }, 1000);
    } catch (e) {
      resolve(); // Tetap selesaikan jika Web Audio gagal
    }
  });
}

// Render State Antrian ke UI Dashboard
function renderQueueState(state) {
  const { services, waitingTickets, callingTickets, serverName } = state;
  servicesList = services;

  // Render server name if received from WebSocket server
  if (serverName) {
    const lbl = document.getElementById('status-server-name');
    const val = document.getElementById('status-server-name-val');
    if (lbl && val) {
      val.innerText = serverName;
      lbl.style.display = 'block';
    }
  }

  // 1. Render Calling Grid di Dashboard
  const callingGrid = document.getElementById('calling-grid');
  callingGrid.innerHTML = '';

  if (services.length === 0) {
    callingGrid.innerHTML = `
      <div class="glass-panel service-calling-card" style="grid-column: span 2; text-align: center; padding: 40px;">
        <h3 style="color: var(--text-secondary);">Tidak ada layanan terdaftar.</h3>
      </div>
    `;
  }

  services.forEach(srv => {
    // Cari apakah ada tiket sedang dipanggil untuk layanan ini
    const activeCall = callingTickets.find(t => t.service_id === srv.id);
    const activeNumber = activeCall ? activeCall.ticket_number : (srv.prefix + String(srv.current_number).padStart(3, '0'));
    
    // Ambil default nomor loket dari memori lokal
    const currentDesk = localDeskSettings[srv.id] || 'Loket 1';

    const card = document.createElement('div');
    card.className = `glass-panel service-calling-card animate-slide-in ${activeCall ? 'animate-call-blink' : ''}`;
    card.innerHTML = `
      <div class="calling-header">
        <span class="calling-service-name">${srv.name} (Prefix: ${srv.prefix})</span>
        ${activeCall ? '<span class="badge badge-calling">Memanggil</span>' : '<span class="badge badge-waiting">Standby</span>'}
      </div>
      <div class="current-call-number" id="call-number-${srv.id}">${activeNumber}</div>
      
      <div class="desk-setting-row">
        <label for="desk-input-${srv.id}" style="font-size: 0.85rem; font-weight:600; color:var(--text-secondary);">Loket:</label>
        <input type="text" class="input-control desk-input" id="desk-input-${srv.id}" value="${currentDesk}">
      </div>

      <div class="calling-actions-grid">
        <button class="btn btn-primary" onclick="${activeCall ? `recall('${activeCall.id}')` : `callNext('${srv.id}')`}">
          🔔 Panggil
        </button>
        <button class="btn btn-secondary" onclick="recall('${activeCall ? activeCall.id : ''}')" ${!activeCall ? 'disabled' : ''}>
          🔄 Ulang
        </button>
        <button class="btn btn-success" onclick="completeCall('${activeCall ? activeCall.id : ''}')" ${!activeCall ? 'disabled' : ''}>
          ✅ Selesai
        </button>
        <button class="btn btn-danger" onclick="skipCall('${activeCall ? activeCall.id : ''}')" ${!activeCall ? 'disabled' : ''}>
          ❌ Lewati
        </button>
      </div>
    `;
    callingGrid.appendChild(card);
    
    // Event listener untuk menyimpan input loket langsung saat diketik (Auto-save local)
    const deskInput = card.querySelector(`.desk-input`);
    deskInput.addEventListener('input', (e) => {
      localDeskSettings[srv.id] = e.target.value;
      localStorage.setItem('local_desk_settings', JSON.stringify(localDeskSettings));
    });
    deskInput.addEventListener('change', () => {
      sendAction('SYNC_DESK_NAMES', { deskNames: Object.values(localDeskSettings) });
    });
  });

  // 2. Render Dropdown Quick Service Selector
  const quickSelect = document.getElementById('quick-service');
  quickSelect.innerHTML = '';
  services.forEach(srv => {
    const opt = document.createElement('option');
    opt.value = srv.id;
    opt.innerText = `${srv.prefix} - ${srv.name}`;
    quickSelect.appendChild(opt);
  });

  // 3. Render Dropdown Search Service Filter
  const searchSelect = document.getElementById('search-service');
  const prevSearchVal = searchSelect.value;
  searchSelect.innerHTML = '<option value="">Semua Layanan</option>';
  services.forEach(srv => {
    const opt = document.createElement('option');
    opt.value = srv.id;
    opt.innerText = `${srv.prefix} - ${srv.name}`;
    searchSelect.appendChild(opt);
  });
  searchSelect.value = prevSearchVal;

  // 4. Render Waiting Table
  const tbody = document.getElementById('waiting-tbody');
  tbody.innerHTML = '';

  if (waitingTickets.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="4" style="text-align: center; color: var(--text-muted); padding: 15px;">Tidak ada antrian menunggu.</td>
      </tr>
    `;
  } else {
    waitingTickets.forEach(t => {
      const tr = document.createElement('tr');
      tr.className = 'animate-pop-in';
      tr.innerHTML = `
        <td><strong>${t.ticket_number}</strong></td>
        <td>${t.service_name}</td>
        <td>${t.customer_name || '<span style="color:var(--text-muted)">-</span>'}</td>
        <td><span class="badge badge-waiting">Menunggu</span></td>
      `;
      tbody.appendChild(tr);
    });
  }
}

// ==================== AKSI PEMANGGILAN ====================

window.callNext = function(serviceId) {
  const deskInput = document.getElementById(`desk-input-${serviceId}`);
  const deskNumber = deskInput ? deskInput.value : 'Loket 1';
  sendAction('CALL_NEXT', { serviceId, deskNumber });
};

window.recall = function(ticketId) {
  if (!ticketId) return;
  sendAction('RECALL', { ticketId });
};

window.completeCall = function(ticketId) {
  if (!ticketId) return;
  sendAction('COMPLETE', { ticketId });
};

window.skipCall = function(ticketId) {
  if (!ticketId) return;
  sendAction('SKIP', { ticketId });
};

// ==================== EVENT LISTENERS & SETUP ====================

function setupEventListeners() {
  // Proyeksi Display Window
  const btnToggleDisplay = document.getElementById('btn-toggle-display');
  btnToggleDisplay.addEventListener('click', async () => {
    const isOpen = await window.api.isDisplayWindowOpen();
    if (isOpen) {
      await window.api.closeDisplayWindow();
      showToast('Layar Display ditutup.', 'info');
    } else {
      await window.api.openDisplayWindow();
      showToast('Layar Display berhasil dibuka/diproyeksikan!', 'success');
    }
  });

  // Proyeksi Kiosk Window (Layar Ketiga)
  const btnToggleKiosk = document.getElementById('btn-toggle-kiosk');
  btnToggleKiosk.addEventListener('click', async () => {
    const isOpen = await window.api.isKioskWindowOpen();
    if (isOpen) {
      await window.api.closeKioskWindow();
      showToast('Layar Kiosk Mandiri ditutup.', 'info');
    } else {
      await window.api.openKioskWindow();
      showToast('Layar Kiosk Mandiri berhasil dibuka/diproyeksikan!', 'success');
    }
  });

  // Buat Tiket Baru (Quick Ticket)
  const btnCreateTicket = document.getElementById('btn-create-ticket');
  btnCreateTicket.addEventListener('click', () => {
    const serviceId = document.getElementById('quick-service').value;
    const name = document.getElementById('quick-name').value;
    const phone = document.getElementById('quick-phone').value;

    if (!serviceId) {
      showToast('Pilih kategori layanan terlebih dahulu.', 'error');
      return;
    }

    // Set transaction ID untuk memicu auto-print setelah sukses broadcast
    currentTxId = generateTxId();

    sendAction('CREATE_TICKET', { serviceId, name, phone, txId: currentTxId });
    
    // Reset Form Input
    document.getElementById('quick-name').value = '';
    document.getElementById('quick-phone').value = '';
    showToast('Tiket antrian berhasil dibuat!', 'success');
  });

  // Cari Data Trigger
  const btnSearchTrigger = document.getElementById('btn-search-trigger');
  btnSearchTrigger.addEventListener('click', triggerSearch);

  // Ubah Tanggal Statistik
  const statsDateInput = document.getElementById('stats-date');
  statsDateInput.addEventListener('change', (e) => {
    loadStats(e.target.value);
  });

  // Hubungkan Manual (Client Mode)
  const btnManualConnect = document.getElementById('btn-manual-connect');
  btnManualConnect.addEventListener('click', () => {
    const ipPort = document.getElementById('client-manual-ip').value.trim();
    if (!ipPort) {
      showToast('Ketik alamat IP:Port server target.', 'error');
      return;
    }
    connectToRemoteServer(ipPort);
  });

  // Simpan Mode & Restart
  const btnSaveMode = document.getElementById('btn-save-mode');
  btnSaveMode.addEventListener('click', async () => {
    const mode = document.getElementById('app-mode-select').value;
    const serverName = document.getElementById('setting-server-name').value.trim();
    const port = document.getElementById('setting-port').value || '8080';

    if (mode === 'server' && !serverName) {
      showToast('Nama Server tidak boleh kosong.', 'error');
      return;
    }

    await window.api.saveModeSettings({ mode, serverName, port });
    showToast('Pengaturan mode berhasil disimpan! Sistem merestart service.', 'success');
    
    // Muat ulang detail
    await initSystemInfo();
  });

  // Tambah Layanan
  const btnAddService = document.getElementById('btn-add-service');
  btnAddService.addEventListener('click', async () => {
    const prefix = document.getElementById('new-service-prefix').value.trim().toUpperCase();
    const name = document.getElementById('new-service-name').value.trim();

    if (!prefix || !name) {
      showToast('Prefix dan Nama Layanan harus diisi.', 'error');
      return;
    }

    try {
      await window.api.addService(name, prefix);
      showToast('Layanan baru berhasil ditambahkan!', 'success');
      document.getElementById('new-service-prefix').value = '';
      document.getElementById('new-service-name').value = '';
      
      // Update WebSocket State
      sendAction('GET_STATE');
      loadSettings(); // refresh list layanan di setting
    } catch (err) {
      showToast('Gagal menambah layanan: ' + err.message, 'error');
    }
  });

  // Simpan TTS Settings
  const btnSaveTts = document.getElementById('btn-save-tts');
  if (btnSaveTts) {
    btnSaveTts.addEventListener('click', () => {
      const enabled = document.getElementById('setting-tts-enabled').checked ? 'true' : 'false';
      sendAction('SAVE_TTS', { enabled });
      showToast('Menyimpan pengaturan Text-to-Speech...', 'info');
    });
  }

  // Simpan WA Settings
  const btnSaveWa = document.getElementById('btn-save-wa');
  btnSaveWa.addEventListener('click', async () => {
    const enabled = document.getElementById('setting-wa-enabled').checked ? 'true' : 'false';
    const waitTemplate = document.getElementById('setting-wa-template-wait').value.trim();
    const callTemplate = document.getElementById('setting-wa-template-call').value.trim();

    // Simpan + restart WA via WebSocket (sehingga berlaku di server mode maupun client mode)
    sendAction('WA_SAVE_AND_RESTART', {
      enabled,
      templateWait: waitTemplate,
      templateCall: callTemplate
    });
    showToast('Menyimpan pengaturan WhatsApp...', 'info');
  });

  // Tambah Teks Berjalan Baru
  const btnAddRunningText = document.getElementById('btn-add-running-text');
  if (btnAddRunningText) {
    btnAddRunningText.addEventListener('click', () => {
      const input = document.getElementById('new-running-text-input');
      const text = input.value.trim();
      if (!text) {
        showToast('Teks tidak boleh kosong.', 'error');
        return;
      }
      currentRunningTexts.push(text);
      input.value = '';
      renderRunningTextsList();
      showToast('Teks ditambahkan. Klik Simpan untuk menerapkan.', 'info');
    });
  }

  // Simpan & Terapkan Teks Berjalan ke Display
  const btnSaveRunningTexts = document.getElementById('btn-save-running-texts');
  if (btnSaveRunningTexts) {
    btnSaveRunningTexts.addEventListener('click', () => {
      // Sync nilai textarea terkini (user mungkin mengedit langsung)
      currentRunningTexts = currentRunningTexts.map((_, i) => {
        const el = document.getElementById(`rt-input-${i}`);
        return el ? el.value.trim() : currentRunningTexts[i];
      }).filter(t => t);

      if (currentRunningTexts.length === 0) {
        showToast('Minimal harus ada 1 teks.', 'error');
        return;
      }

      sendAction('SAVE_RUNNING_TEXTS', { texts: currentRunningTexts });
    });
  }

  // Logout WhatsApp
  const btnWaLogout = document.getElementById('btn-wa-logout');
  btnWaLogout.addEventListener('click', () => {
    if (confirm("Apakah Anda yakin ingin memutus sambungan WhatsApp?")) {
      sendAction('WA_LOGOUT');
      showToast('Memutus koneksi WhatsApp...', 'info');
    }
  });

  // Tombol Metode QR
  const btnWaMethodQr = document.getElementById('btn-wa-method-qr');
  if (btnWaMethodQr) {
    btnWaMethodQr.addEventListener('click', () => {
      document.getElementById('wa-phone-input-group').style.display = 'none';
      document.getElementById('wa-qr-start-group').style.display = 'flex';
      btnWaMethodQr.className = 'btn btn-primary'; // Aktif
      document.getElementById('btn-wa-method-phone').className = 'btn btn-secondary';
    });
  }

  // Tombol Metode Pairing Code
  const btnWaMethodPhone = document.getElementById('btn-wa-method-phone');
  if (btnWaMethodPhone) {
    btnWaMethodPhone.addEventListener('click', () => {
      document.getElementById('wa-phone-input-group').style.display = 'flex';
      document.getElementById('wa-qr-start-group').style.display = 'none';
      btnWaMethodPhone.className = 'btn btn-primary'; // Aktif
      document.getElementById('btn-wa-method-qr').className = 'btn btn-secondary';
    });
  }

  // Tombol Sambungkan QR (reset sesi lama, tampilkan QR baru)
  const btnWaStartQr = document.getElementById('btn-wa-start-qr');
  if (btnWaStartQr) {
    btnWaStartQr.addEventListener('click', async () => {
      btnWaStartQr.disabled = true;
      btnWaStartQr.innerText = 'Memulai koneksi QR...';
      showToast('Menghubungkan ulang WhatsApp via QR...', 'info');
      try {
        // Pastikan WA enabled dulu
        const enabled = document.getElementById('setting-wa-enabled').checked;
        if (!enabled) {
          showToast('Aktifkan notifikasi WhatsApp terlebih dahulu, lalu simpan.', 'error');
          return;
        }
        sendAction('WA_START_QR');
      } finally {
        setTimeout(() => {
          btnWaStartQr.disabled = false;
          btnWaStartQr.innerText = '🔄 Sambungkan / Perbarui QR Code';
        }, 3000);
      }
    });
  }

  // Tombol Minta Pairing Code
  const btnWaRequestPairing = document.getElementById('btn-wa-request-pairing');
  if (btnWaRequestPairing) {
    btnWaRequestPairing.addEventListener('click', async () => {
      const phone = document.getElementById('wa-phone-input').value.trim().replace(/[^0-9]/g, '');
      if (phone.length < 8) {
        showToast('Masukkan nomor HP yang valid (contoh: 6281368898090).', 'error');
        return;
      }
      const enabled = document.getElementById('setting-wa-enabled').checked;
      if (!enabled) {
        showToast('Aktifkan notifikasi WhatsApp terlebih dahulu, lalu simpan.', 'error');
        return;
      }
      btnWaRequestPairing.disabled = true;
      btnWaRequestPairing.innerText = 'Mengirim...';
      showToast(`Meminta kode penyandingan untuk nomor ${phone}...`, 'info');
      sendAction('WA_START_PAIRING', { phone });
      setTimeout(() => {
        btnWaRequestPairing.disabled = false;
        btnWaRequestPairing.innerText = 'Minta Kode';
      }, 5000);
    });
  }

  // Export DB Backup
  const btnExportDb = document.getElementById('btn-export-db');
  btnExportDb.addEventListener('click', async () => {
    showToast('Mengekspor database...', 'info');
    const res = await window.api.exportData();
    if (res.success) {
      showToast(res.message, 'success');
    } else {
      showToast(res.message, 'error');
    }
  });

  // Import DB Restore
  const btnImportDb = document.getElementById('btn-import-db');
  btnImportDb.addEventListener('click', async () => {
    const confirmRestore = confirm("PERINGATAN: Mengimpor database akan menimpa seluruh data antrian saat ini! Apakah Anda yakin?");
    if (!confirmRestore) return;

    showToast('Mengimpor database...', 'info');
    const res = await window.api.importData();
    if (res.success) {
      showToast(res.message, 'success');
      // Refresh total data
      sendAction('GET_STATE');
    } else {
      showToast(res.message, 'error');
    }
  });

  // Reset Antrian Hari Ini
  const btnResetQueues = document.getElementById('btn-reset-queues');
  btnResetQueues.addEventListener('click', () => {
    const confirmReset = confirm("Apakah Anda yakin ingin mereset seluruh antrian hari ini kembali ke 0?");
    if (confirmReset) {
      sendAction('RESET_ALL');
      showToast('Seluruh data antrian hari ini telah di-reset.', 'success');
    }
  });

  // Cek Pembaruan Aplikasi dari GitHub
  const btnCheckAppUpdate = document.getElementById('btn-check-app-update');
  btnCheckAppUpdate.addEventListener('click', async () => {
    showToast('Mengecek pembaruan aplikasi di GitHub...', 'info');
    btnCheckAppUpdate.disabled = true;
    btnCheckAppUpdate.innerText = 'Mengecek...';
    try {
      await window.api.checkAppUpdates();
      showToast('Pengecekan pembaruan aplikasi selesai.', 'success');
    } catch (err) {
      showToast('Gagal mengecek pembaruan: ' + err.message, 'error');
    } finally {
      btnCheckAppUpdate.disabled = false;
      btnCheckAppUpdate.innerText = '🔄 Cek Pembaruan Aplikasi';
    }
  });
}

// ==================== TAMPIL DATA LAINNYA ====================

// Trigger Pencarian Tiket
async function triggerSearch() {
  const query = document.getElementById('search-query').value.trim();
  const status = document.getElementById('search-status').value;
  const serviceId = document.getElementById('search-service').value;
  const dateStr = document.getElementById('search-date').value;

  const results = await searchTicketsData(query, status, serviceId, dateStr);
  const tbody = document.getElementById('search-tbody');
  tbody.innerHTML = '';

  if (results.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align: center; color: var(--text-muted); padding: 15px;">Tidak ditemukan tiket yang cocok dengan filter.</td></tr>';
    return;
  }

  results.forEach(t => {
    const tr = document.createElement('tr');
    
    const formattedCreated = new Date(t.created_at).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
    const formattedCalled = t.called_at ? new Date(t.called_at).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) : '-';
    
    let badgeClass = 'badge-waiting';
    if (t.status === 'calling') badgeClass = 'badge-calling';
    if (t.status === 'completed') badgeClass = 'badge-completed';
    if (t.status === 'skipped') badgeClass = 'badge-skipped';

    // Format param-param text untuk HTML attribute yang aman dari karakter kutip
    const nameEscaped = (t.customer_name || '').replace(/'/g, "\\'");
    const serviceEscaped = (t.service_name || '').replace(/'/g, "\\'");

    tr.innerHTML = `
      <td><strong>${t.ticket_number}</strong></td>
      <td>${t.service_name}</td>
      <td>${t.customer_name || '-'}</td>
      <td>${t.customer_phone || '-'}</td>
      <td><span class="badge ${badgeClass}">${t.status}</span></td>
      <td>${t.desk_number || '-'}</td>
      <td>${formattedCreated}</td>
      <td>${formattedCalled}</td>
      <td>
        <button class="btn btn-secondary" onclick="printTicketHistory('${t.ticket_number}', '${serviceEscaped}', '${nameEscaped}', '${t.created_at}')" style="padding: 4px 8px; font-size: 0.75rem;">
          🖨️ Cetak
        </button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

// Fungsi Cetak Tiket untuk Printer Thermal / Dot Matrix
window.printTicketHistory = function(ticketNumber, serviceName, customerName, createdAt) {
  // Ambil nama server untuk kepala tiket dari data sistem
  window.api.getSystemInfo().then(info => {
    document.getElementById('print-header-name').innerText = (info.serverName || 'SIMPLE ANTRIAN').toUpperCase();
    document.getElementById('print-service-name').innerText = serviceName;
    document.getElementById('print-ticket-no').innerText = ticketNumber;
    
    const nameLbl = document.getElementById('print-customer-lbl');
    if (customerName && customerName !== '-' && customerName !== '') {
      nameLbl.innerText = `Nama: ${customerName}`;
      nameLbl.style.display = 'block';
    } else {
      nameLbl.innerText = '';
      nameLbl.style.display = 'none';
    }
    
    document.getElementById('print-time-lbl').innerText = `Waktu: ${new Date(createdAt).toLocaleString('id-ID')}`;
    
    window.print();
  });
};

// Muat Statistik Harian
async function loadStats(dateStr) {
  const stats = await getDailyStatsData(dateStr);
  
  // Update Widget
  document.getElementById('stats-total').innerText = stats.summary.total;
  document.getElementById('stats-completed').innerText = stats.summary.completed;
  document.getElementById('stats-skipped').innerText = stats.summary.skipped;
  document.getElementById('stats-waiting').innerText = stats.summary.waiting;

  // Format Rata-rata waktu
  const formatTime = (totalSeconds) => {
    if (totalSeconds <= 0) return '0m 0s';
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${m}m ${s}s`;
  };

  document.getElementById('stats-avg-wait').innerText = formatTime(stats.summary.avg_wait_seconds);
  document.getElementById('stats-avg-serve').innerText = formatTime(stats.summary.avg_service_seconds);

  // Grouped per service
  const tbody = document.getElementById('stats-services-tbody');
  tbody.innerHTML = '';
  
  if (stats.services.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding: 10px;">Tidak ada ringkasan layanan.</td></tr>';
  } else {
    stats.services.forEach(srv => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${srv.prefix}</strong></td>
        <td>${srv.name}</td>
        <td>${srv.total || 0}</td>
        <td style="color: var(--accent-success);">${srv.completed || 0}</td>
        <td style="color: var(--accent-secondary);">${srv.skipped || 0}</td>
      `;
      tbody.appendChild(tr);
    });
  }
}

// Muat Konfigurasi pada Pengaturan
async function loadSettings() {
  const settings = await getSettingsData();
  
  // App Mode UI
  document.getElementById('app-mode-select').value = settings.app_mode || 'server';
  document.getElementById('setting-server-name').value = settings.server_name || 'Server Utama';
  document.getElementById('setting-port').value = settings.port || '8080';
  
  // TTS Settings UI
  const ttsCheckbox = document.getElementById('setting-tts-enabled');
  if (ttsCheckbox) {
    ttsCheckbox.checked = settings.tts_enabled !== 'false';
  }

  // WA Settings UI
  document.getElementById('setting-wa-enabled').checked = settings.wa_enabled === 'true';
  document.getElementById('setting-wa-template-wait').value = settings.wa_template_wait || '';
  document.getElementById('setting-wa-template-call').value = settings.wa_template_call || '';

  // Minta status WA terbaru ke WebSocket server
  sendAction('WA_STATUS');

  // Load Kategori Layanan Table
  const services = await getServicesData();
  const tbody = document.getElementById('services-tbody');
  tbody.innerHTML = '';
  
  services.forEach(srv => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${srv.prefix}</strong></td>
      <td>${srv.name}</td>
      <td>
        <button class="btn btn-danger" onclick="deleteService('${srv.id}')" style="padding: 4px 8px; font-size: 0.8rem;">
          Hapus
        </button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

// Hapus Layanan
window.deleteService = async function(id) {
  if (confirm("Apakah Anda yakin ingin menghapus layanan ini? Ini juga akan menghapus seluruh data antrian di dalamnya.")) {
    try {
      await window.api.deleteService(id);
      showToast('Layanan berhasil dihapus.', 'success');
      
      // Update State
      sendAction('GET_STATE');
      loadSettings(); // refresh setting table
    } catch (err) {
      showToast('Gagal menghapus layanan: ' + err.message, 'error');
    }
  }
};

// ==================== RUNNING TEXTS MANAGEMENT ====================

/** State lokal daftar teks berjalan */
let currentRunningTexts = [];

/**
 * Deteksi bahasa teks untuk label badge (sama dengan display.js).
 */
function detectRunningTextLang(text) {
  if (/[\u4e00-\u9fff\u3400-\u4dbf]/.test(text)) return { label: 'ZH 🇨🇳', color: '#f59e0b' };
  if (/\b(the|and|please|thank|welcome|service|queue)\b/i.test(text)) return { label: 'EN 🇬🇧', color: '#60a5fa' };
  if (/\b(di|dan|kami|antrian|terima|layanan|silakan|selamat)\b/i.test(text)) return { label: 'ID 🇮🇩', color: '#4ade80' };
  return { label: 'MSG', color: '#a78bfa' };
}

/**
 * Muat running texts dari settings database dan render ke UI.
 */
async function loadRunningTexts() {
  try {
    const settings = await window.api.getSettings();
    let texts = [];
    if (settings.running_texts) {
      try { texts = JSON.parse(settings.running_texts); } catch (_) {}
    }
    // Fallback ke nilai default jika masih kosong
    if (!Array.isArray(texts) || texts.length === 0) {
      texts = [
        'Selamat Datang di Layanan Kami. Budayakan Mengantri dengan Tertib demi Kenyamanan Bersama. Terima kasih atas kerja sama Anda.',
        'Welcome to Our Service. Please Queue in an Orderly Manner for Everyone\'s Comfort. Thank you for your cooperation.',
        '\u6b22\u8fce\u5149\u4e34\u6211\u4eec\u7684\u670d\u52a1\u4e2d\u5fc3\u3002\u8bf7\u9075\u5b88\u79e9\u5e8f\u6392\u961f\uff0c\u5171\u540c\u7ef4\u62a4\u826f\u597d\u73af\u5883\u3002\u611f\u8c22\u60a8\u7684\u914d\u5408\u3002'
      ];
    }
    currentRunningTexts = texts.filter(t => t && t.trim());
    renderRunningTextsList();
  } catch (err) {
    showToast('Gagal memuat teks berjalan: ' + err.message, 'error');
  }
}

/**
 * Render daftar teks berjalan di UI settings.
 */
function renderRunningTextsList() {
  const container = document.getElementById('running-texts-list');
  if (!container) return;
  container.innerHTML = '';

  if (currentRunningTexts.length === 0) {
    container.innerHTML = `<div style="text-align:center; color:var(--text-muted); padding:16px;">Belum ada teks. Tambahkan di bawah.</div>`;
    return;
  }

  currentRunningTexts.forEach((text, index) => {
    const langInfo = detectRunningTextLang(text);
    const item = document.createElement('div');
    item.style.cssText = 'display:flex; gap:10px; align-items:flex-start; background:rgba(255,255,255,0.03); border:1px solid var(--border-glass); border-radius:10px; padding:12px;';
    item.innerHTML = `
      <div style="display:flex; flex-direction:column; gap:6px; flex:1; min-width:0;">
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:2px;">
          <span style="font-size:0.7rem; font-weight:700; background:rgba(0,0,0,0.3); color:${langInfo.color}; border:1px solid ${langInfo.color}40; padding:2px 7px; border-radius:4px; white-space:nowrap;">${langInfo.label}</span>
          <span style="font-size:0.72rem; color:var(--text-muted);">Teks ${index + 1} dari ${currentRunningTexts.length}</span>
        </div>
        <textarea class="input-control" id="rt-input-${index}" rows="2"
          style="resize:vertical; min-height:48px; font-size:0.88rem; width:100%; box-sizing:border-box;"
          oninput="updateRunningText(${index}, this.value)">${escapeHtmlAttr(text)}</textarea>
      </div>
      <div style="display:flex; flex-direction:column; gap:6px; flex-shrink:0;">
        <button class="btn btn-secondary" onclick="moveRunningText(${index}, -1)" title="Geser ke atas" ${index === 0 ? 'disabled' : ''} style="padding:6px 10px; font-size:0.85rem;">▲</button>
        <button class="btn btn-secondary" onclick="moveRunningText(${index}, 1)" title="Geser ke bawah" ${index === currentRunningTexts.length - 1 ? 'disabled' : ''} style="padding:6px 10px; font-size:0.85rem;">▼</button>
        <button class="btn btn-danger" onclick="removeRunningText(${index})" title="Hapus" style="padding:6px 10px; font-size:0.85rem;">🗑️</button>
      </div>
    `;
    container.appendChild(item);
  });
}

/** Escape untuk HTML attribute */
function escapeHtmlAttr(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/** Update teks di index tertentu saat diketik */
window.updateRunningText = function(index, value) {
  currentRunningTexts[index] = value;
};

/** Hapus teks di index tertentu */
window.removeRunningText = function(index) {
  currentRunningTexts.splice(index, 1);
  renderRunningTextsList();
};

/** Pindahkan teks ke atas/bawah */
window.moveRunningText = function(index, dir) {
  const newIndex = index + dir;
  if (newIndex < 0 || newIndex >= currentRunningTexts.length) return;
  const temp = currentRunningTexts[index];
  currentRunningTexts[index] = currentRunningTexts[newIndex];
  currentRunningTexts[newIndex] = temp;
  renderRunningTextsList();
};

