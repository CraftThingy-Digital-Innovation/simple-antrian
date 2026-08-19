// State Global
let ws = null;
let currentMode = 'server';
let serverIp = 'localhost';
let serverPort = 8080;
let servicesList = [];
let localDeskSettings = {}; // Menyimpan nomor loket per layanan, misal: { teller: 'Loket 1' }

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
    
    // Tampilkan mode di UI
    const badgeMode = document.getElementById('badge-mode');
    badgeMode.innerText = currentMode === 'server' ? 'Server Mode' : 'Client Mode';
    badgeMode.className = `badge ${currentMode === 'server' ? 'badge-waiting' : 'badge-completed'}`;

    if (currentMode === 'server') {
      document.getElementById('network-status-title').innerText = 'Server Aktif (Lokal)';
      document.getElementById('status-text').innerText = `${info.localIp}:${serverPort}`;
      document.getElementById('status-dot').style.background = 'var(--accent-success)';
      
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

    case 'WA_STATUS_UPDATE':
      renderWaStatus(payload);
      break;
    
    case 'ANNOUNCE_CALL':
      // Main process display window yang akan memutar suara, 
      // tapi kita juga bisa memutarnya secara opsional di operator panel.
      playVoiceAnnounce(payload.ticketNumber, payload.deskNumber);
      break;

    case 'ALERT':
      showToast(payload.message, 'info');
      break;
      
    case 'ERROR':
      showToast(payload.message, 'error');
      break;
  }
}

// Render status WhatsApp lokal ke UI settings
function renderWaStatus(waState) {
  const { status, qr, number, version, latestVersion, updateAvailable } = waState;
  
  const badge = document.getElementById('wa-status-badge');
  const qrContainer = document.getElementById('wa-qr-container');
  const qrImg = document.getElementById('wa-qr-img');
  const details = document.getElementById('wa-details');
  const detailsNumber = document.getElementById('wa-details-number');
  const btnLogout = document.getElementById('btn-wa-logout');
  
  badge.innerText = status === 'connected' ? 'Terhubung' : 
                   status === 'qr' ? 'Pindai QR Code' : 
                   status === 'connecting' ? 'Menghubungkan...' : 'Terputus';
                   
  badge.className = `badge ${status === 'connected' ? 'badge-completed' : 
                            status === 'qr' ? 'badge-calling' : 'badge-skipped'}`;
  
  if (status === 'qr' && qr) {
    qrImg.src = qr;
    qrContainer.style.display = 'flex';
  } else {
    qrContainer.style.display = 'none';
    qrImg.src = '';
  }
  
  if (status === 'connected') {
    detailsNumber.innerText = number;
    details.style.display = 'flex';
    btnLogout.style.display = 'block';
  } else {
    details.style.display = 'none';
    btnLogout.style.display = 'none';
  }

  // Update panel versi
  document.getElementById('wa-version-lbl').innerText = `v${version}`;
  const updateAlert = document.getElementById('wa-update-alert');
  const btnUpdate = document.getElementById('btn-wa-update');
  
  if (updateAvailable) {
    document.getElementById('wa-latest-version-lbl').innerText = `v${latestVersion}`;
    updateAlert.style.display = 'block';
    btnUpdate.style.display = 'block';
  } else {
    updateAlert.style.display = 'none';
    btnUpdate.style.display = 'none';
  }
}

// Play Voice Announce menggunakan Web Speech API & Web Audio Ding-Dong
async function playVoiceAnnounce(ticketNumber, deskNumber) {
  // Hanya bunyikan jika dicentang di setelan audio (opsional, untuk operator)
  const settings = await window.api.getSettings();
  if (settings.play_audio_operator !== 'true') return;

  try {
    // 1. Play Ding-Dong
    await playDingDong();

    // 2. Speech Synthesis
    const prefix = ticketNumber.charAt(0);
    const num = parseInt(ticketNumber.substring(1));
    const cleanDesk = deskNumber.replace(/([0-9]+)/, ' $1'); // Pisah angka biar lebih jelas dibaca TTS
    
    const text = `Nomor antrian ${prefix}, ${num}. Silakan menuju ${cleanDesk}.`;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'id-ID';
    
    const voices = window.speechSynthesis.getVoices();
    const idVoice = voices.find(v => v.lang.includes('id') || v.lang.includes('ID'));
    if (idVoice) utterance.voice = idVoice;
    
    window.speechSynthesis.speak(utterance);
  } catch (err) {
    console.error('Speech synthesis failed:', err);
  }
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
  const { services, waitingTickets, callingTickets } = state;
  servicesList = services;

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
        <button class="btn btn-primary" onclick="callNext('${srv.id}')">
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

  // Buat Tiket Baru
  const btnCreateTicket = document.getElementById('btn-create-ticket');
  btnCreateTicket.addEventListener('click', () => {
    const serviceId = document.getElementById('quick-service').value;
    const name = document.getElementById('quick-name').value;
    const phone = document.getElementById('quick-phone').value;

    if (!serviceId) {
      showToast('Pilih kategori layanan terlebih dahulu.', 'error');
      return;
    }

    sendAction('CREATE_TICKET', { serviceId, name, phone });
    
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

  // Simpan WA Settings
  const btnSaveWa = document.getElementById('btn-save-wa');
  btnSaveWa.addEventListener('click', async () => {
    const enabled = document.getElementById('setting-wa-enabled').checked ? 'true' : 'false';
    const waitTemplate = document.getElementById('setting-wa-template-wait').value.trim();
    const callTemplate = document.getElementById('setting-wa-template-call').value.trim();

    await window.api.saveSetting('wa_enabled', enabled);
    await window.api.saveSetting('wa_template_wait', waitTemplate);
    await window.api.saveSetting('wa_template_call', callTemplate);

    showToast('Pengaturan WhatsApp berhasil disimpan!', 'success');
    sendAction('GET_STATE');
  });

  // Logout WhatsApp
  const btnWaLogout = document.getElementById('btn-wa-logout');
  btnWaLogout.addEventListener('click', () => {
    if (confirm("Apakah Anda yakin ingin memutus sambungan WhatsApp?")) {
      sendAction('WA_LOGOUT');
      showToast('Memutus koneksi WhatsApp...', 'info');
    }
  });

  // Update WhatsApp Baileys Library
  const btnWaUpdate = document.getElementById('btn-wa-update');
  btnWaUpdate.addEventListener('click', async () => {
    showToast('Mengunduh dan memperbarui library WhatsApp... Silakan tunggu.', 'info');
    btnWaUpdate.disabled = true;
    btnWaUpdate.innerText = 'Memperbarui...';
    try {
      const res = await window.api.performWaUpdate();
      if (res.success) {
        showToast(`Pustaka Baileys berhasil diperbarui ke versi v${res.version}!`, 'success');
        sendAction('WA_STATUS');
      } else {
        showToast('Gagal memperbarui library.', 'error');
      }
    } catch (err) {
      showToast('Error update: ' + err.message, 'error');
    } finally {
      btnWaUpdate.disabled = false;
      btnWaUpdate.innerText = '⚡ Perbarui Otomatis';
    }
  });

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
}

// ==================== TAMPIL DATA LAINNYA ====================

// Trigger Pencarian Tiket
async function triggerSearch() {
  const query = document.getElementById('search-query').value.trim();
  const status = document.getElementById('search-status').value;
  const serviceId = document.getElementById('search-service').value;
  const dateStr = document.getElementById('search-date').value;

  const results = await window.api.searchTickets(query, status, serviceId, dateStr);
  const tbody = document.getElementById('search-tbody');
  tbody.innerHTML = '';

  if (results.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; color: var(--text-muted); padding: 15px;">Tidak ditemukan tiket yang cocok dengan filter.</td></tr>';
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

    tr.innerHTML = `
      <td><strong>${t.ticket_number}</strong></td>
      <td>${t.service_name}</td>
      <td>${t.customer_name || '-'}</td>
      <td>${t.customer_phone || '-'}</td>
      <td><span class="badge ${badgeClass}">${t.status}</span></td>
      <td>${t.desk_number || '-'}</td>
      <td>${formattedCreated}</td>
      <td>${formattedCalled}</td>
    `;
    tbody.appendChild(tr);
  });
}

// Muat Statistik Harian
async function loadStats(dateStr) {
  const stats = await window.api.getDailyStats(dateStr);
  
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
  const settings = await window.api.getSettings();
  
  // App Mode UI
  document.getElementById('app-mode-select').value = settings.app_mode || 'server';
  document.getElementById('setting-server-name').value = settings.server_name || 'Server Utama';
  document.getElementById('setting-port').value = settings.port || '8080';
  
  // WA Settings UI
  document.getElementById('setting-wa-enabled').checked = settings.wa_enabled === 'true';
  document.getElementById('setting-wa-template-wait').value = settings.wa_template_wait || '';
  document.getElementById('setting-wa-template-call').value = settings.wa_template_call || '';

  // Minta status WA terbaru ke WebSocket server
  sendAction('WA_STATUS');

  // Load Kategori Layanan Table
  const services = await window.api.getServices();
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
