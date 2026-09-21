// ==================== MINI OPERATOR WINDOW ====================
// Jendela kecil mengambang yang muncul saat operator window diminimalkan.
// Berisi kontrol penting antrian tanpa perlu membuka jendela utama.

let ws = null;
let currentWsUrl = '';
let reconnectTimer = null;
let servicesList = [];
let activeTickets = {};  // { serviceId: ticketData }
let currentDisplayMode = 'queue';

// ==================== TOAST ====================
function showToast(msg, type = 'info') {
  const el = document.getElementById('mini-toast');
  if (!el) return;
  el.textContent = msg;
  el.className = 'mini-toast show ' + type;
  setTimeout(() => { el.classList.remove('show'); }, 2500);
}

// ==================== WEBSOCKET ====================
async function initConnection() {
  try {
    if (window.api && window.api.getSystemInfo) {
      const info = await window.api.getSystemInfo();
      if (info && info.mode === 'server') {
        const port = parseInt(info.port, 10) || 8080;
        connectWebSocket('ws://127.0.0.1:' + port);
        return;
      }
    }
    // Client mode: ambil dari db settings atau localStorage
    const settings = await window.api.getSettings().catch(() => ({}));
    const lastServer = (settings && settings.active_server_endpoint) || localStorage.getItem('last_connected_server');
    if (lastServer) {
      connectWebSocket('ws://' + lastServer);
    } else {
      updateConnStatus('disconnected', 'Server tidak ditemukan');
    }
  } catch (err) {
    console.error('[MiniOp] Init error:', err);
    updateConnStatus('disconnected', 'Error: ' + err.message);
  }
}

function connectWebSocket(url) {
  currentWsUrl = url;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws) { ws.onclose = null; ws.onerror = null; try { ws.close(); } catch(_) {} }

  updateConnStatus('', 'Menghubungkan...');
  ws = new WebSocket(url);

  ws.onopen = () => {
    updateConnStatus('connected', url.replace('ws://', '').replace('localhost', 'Server'));
    sendAction('GET_STATE');
    sendAction('GET_SETTINGS');
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'PING') {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'PONG' }));
        return;
      }
      handleMessage(msg);
    } catch (_) {}
  };

  ws.onerror = () => {
    updateConnStatus('disconnected', 'Koneksi error');
  };

  ws.onclose = () => {
    updateConnStatus('disconnected', 'Terputus');
    reconnectTimer = setTimeout(() => connectWebSocket(currentWsUrl), 3000);
  };
}

function sendAction(type, payload = {}) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, payload }));
  } else {
    showToast('Koneksi terputus!', 'error');
  }
}

function updateConnStatus(status, text) {
  const dot = document.getElementById('mini-conn-dot');
  const label = document.getElementById('mini-conn-text');
  if (dot) {
    dot.className = 'conn-dot';
    if (status) dot.classList.add(status);
  }
  if (label) label.textContent = text;
}

// ==================== MESSAGE HANDLER ====================
function handleMessage(msg) {
  const { type, payload } = msg;

  if (type === 'STATE_UPDATE') {
    const services = Array.isArray(payload.services) ? payload.services : [];
    const callingTickets = Array.isArray(payload.callingTickets) ? payload.callingTickets : [];

    servicesList = services;
    updateServiceDropdown(services);
    updateCurrentCall(callingTickets, services);
    updateActiveTickets(callingTickets);
  }

  if (type === 'SETTINGS_UPDATE' && payload) {
    const mode = payload.display_mode || 'queue';
    setActiveMode(mode);
  }

  if (type === 'TICKET_CREATED') {
    showToast('Tiket ' + (payload.ticket_number || '') + ' berhasil dibuat!', 'success');
  }
}

// ==================== UI UPDATES ====================
function updateServiceDropdown(services) {
  const select = document.getElementById('mini-service-select');
  if (!select) return;
  const currentVal = select.value;
  select.innerHTML = '<option value="">-- Pilih Layanan --</option>';
  services.forEach(srv => {
    const opt = document.createElement('option');
    opt.value = srv.id;
    opt.textContent = srv.name + ' (' + srv.prefix + ')';
    select.appendChild(opt);
  });
  if (currentVal) select.value = currentVal;
}

function updateCurrentCall(callingTickets, services) {
  const callPanel = document.getElementById('mini-current-call');
  const numEl = document.getElementById('mini-call-number');
  const deskEl = document.getElementById('mini-call-desk');
  const btnComplete = document.getElementById('mini-btn-complete');
  const btnRecall = document.getElementById('mini-btn-recall');
  const btnSkip = document.getElementById('mini-btn-skip');

  if (callingTickets.length > 0) {
    const ticket = callingTickets[0];
    if (callPanel) callPanel.classList.remove('standby');
    if (numEl) numEl.textContent = ticket.ticket_number;
    if (deskEl) deskEl.textContent = ticket.desk_number || 'Loket';
    if (btnComplete) btnComplete.disabled = false;
    if (btnRecall) btnRecall.disabled = false;
    if (btnSkip) btnSkip.disabled = false;
  } else {
    if (callPanel) callPanel.classList.add('standby');
    if (numEl) numEl.textContent = '---';
    if (deskEl) deskEl.textContent = 'Belum ada antrian';
    if (btnComplete) btnComplete.disabled = true;
    if (btnRecall) btnRecall.disabled = true;
    if (btnSkip) btnSkip.disabled = true;
  }
}

function updateActiveTickets(callingTickets) {
  activeTickets = {};
  callingTickets.forEach(t => {
    if (t.service_id) activeTickets[t.service_id] = t;
  });
}

function setActiveMode(mode) {
  currentDisplayMode = mode;
  document.querySelectorAll('.btn-mode').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
  const mirrorSection = document.getElementById('mini-mirror-section');
  if (mirrorSection) mirrorSection.style.display = mode === 'mirror' ? 'block' : 'none';
}

// ==================== ACTIONS ====================
function getFirstServiceId() {
  if (servicesList.length > 0) return servicesList[0].id;
  return null;
}

function getActiveTicket() {
  // Ambil tiket aktif pertama yang ada
  const keys = Object.keys(activeTickets);
  if (keys.length > 0) return activeTickets[keys[0]];
  return null;
}

function getDeskNumber(serviceId) {
  // Coba ambil dari localStorage dulu
  try {
    const local = JSON.parse(localStorage.getItem('local_desk_settings') || '{}');
    if (local[serviceId]) return local[serviceId];
  } catch (_) {}
  const srv = servicesList.find(s => s.id === serviceId);
  return srv ? srv.name : 'Loket 1';
}

// ==================== EVENT LISTENERS ====================
document.addEventListener('DOMContentLoaded', () => {
  initConnection();

  // Tombol restore (buka kembali jendela utama)
  document.getElementById('btn-restore').addEventListener('click', () => {
    if (window.api && window.api.restoreMainWindow) {
      window.api.restoreMainWindow();
    }
  });

  // Panggil berikutnya
  document.getElementById('mini-btn-call').addEventListener('click', () => {
    const serviceId = getFirstServiceId();
    if (!serviceId) { showToast('Belum ada layanan.', 'error'); return; }
    const deskNumber = getDeskNumber(serviceId);
    sendAction('CALL_NEXT', { serviceId, deskNumber });
    showToast('Memanggil berikutnya...', 'info');
  });

  // Selesai
  document.getElementById('mini-btn-complete').addEventListener('click', () => {
    const ticket = getActiveTicket();
    if (!ticket) { showToast('Tidak ada antrian aktif.', 'error'); return; }
    const deskNumber = getDeskNumber(ticket.service_id);
    sendAction('COMPLETE', { ticketId: ticket.id, serviceId: ticket.service_id, deskNumber, autoCallNext: true });
    showToast('Antrian diselesaikan.', 'success');
  });

  // Panggil ulang
  document.getElementById('mini-btn-recall').addEventListener('click', () => {
    const ticket = getActiveTicket();
    if (!ticket) { showToast('Tidak ada antrian aktif.', 'error'); return; }
    const deskNumber = getDeskNumber(ticket.service_id);
    sendAction('RECALL', { ticketId: ticket.id, deskNumber });
    showToast('Memanggil ulang...', 'info');
  });

  // Lewati
  document.getElementById('mini-btn-skip').addEventListener('click', () => {
    const ticket = getActiveTicket();
    if (!ticket) { showToast('Tidak ada antrian aktif.', 'error'); return; }
    sendAction('SKIP', { ticketId: ticket.id });
    showToast('Antrian dilewati.', 'warning');
  });

  // Cetak tiket
  document.getElementById('mini-btn-print').addEventListener('click', () => {
    const serviceId = document.getElementById('mini-service-select').value;
    const name = document.getElementById('mini-ticket-name').value;
    const phone = document.getElementById('mini-ticket-phone').value;
    if (!serviceId) { showToast('Pilih layanan dulu!', 'error'); return; }
    
    const txId = 'mini-' + Date.now();
    sendAction('CREATE_TICKET', { serviceId, name, phone, txId });
    document.getElementById('mini-ticket-name').value = '';
    document.getElementById('mini-ticket-phone').value = '';
    showToast('Membuat tiket...', 'info');
  });

  // Mode buttons
  document.querySelectorAll('.btn-mode').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      sendAction('SAVE_DISPLAY_MODE', { mode });
      setActiveMode(mode);
    });
  });

  // Mirror source
  const mirrorSelect = document.getElementById('mini-mirror-source');
  if (mirrorSelect) {
    mirrorSelect.addEventListener('change', () => {
      sendAction('SAVE_MIRROR_WINDOW', { windowName: mirrorSelect.value });
    });
    // Load mirror sources
    loadMirrorSources();
  }
});

async function loadMirrorSources() {
  if (!window.api || !window.api.getShareableWindows) return;
  try {
    const windows = await window.api.getShareableWindows();
    const select = document.getElementById('mini-mirror-source');
    if (!select) return;
    select.innerHTML = '<option value="">-- Pilih Sumber --</option>';
    windows.forEach(w => {
      const opt = document.createElement('option');
      opt.value = w.name;
      opt.textContent = w.name;
      select.appendChild(opt);
    });
  } catch (_) {}
}
