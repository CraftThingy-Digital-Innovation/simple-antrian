// ==================== MINI OPERATOR WINDOW ====================
// Jendela kecil mengambang yang muncul saat operator window diminimalkan.
// Berisi kontrol penting antrian tanpa perlu membuka jendela utama.

let ws = null;
let currentWsUrl = '';
let reconnectTimer = null;
let servicesList = [];
let activeTickets = {};  // { serviceId: ticketData }
let currentDisplayMode = 'queue';
let currentTxId = '';
let currentServerName = '';

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

  if (type === 'STATE_UPDATE' && payload) {
    if (payload.serverName) currentServerName = payload.serverName;
  }

  if (type === 'TICKET_CREATED') {
    const ticket = payload;
    showToast('Tiket ' + (ticket.ticket_number || '') + ' berhasil dibuat!', 'success');

    // Jika tiket dibuat dari mini operator ini -> cetak tiket ke printer terpilih / buka dialog
    if (ticket.tx_id && ticket.tx_id === currentTxId) {
      currentTxId = ''; // Reset transaksi
      triggerMiniTicketPrint(ticket);
    }
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

  // Muat daftar printer sistem
  loadPrinters();

  const printerSelect = document.getElementById('mini-printer-select');
  if (printerSelect) {
    printerSelect.addEventListener('change', () => {
      localStorage.setItem('mini_selected_printer', printerSelect.value);
      const label = printerSelect.value === '__DIALOG__' ? 'Dialog Cetak OS' : printerSelect.value;
      showToast('Printer target: ' + label, 'info');
    });
  }

  const btnRefreshPrinters = document.getElementById('mini-btn-refresh-printers');
  if (btnRefreshPrinters) {
    btnRefreshPrinters.addEventListener('click', async () => {
      await loadPrinters();
      showToast('Daftar printer diperbarui!', 'info');
    });
  }

  // Cetak tiket
  document.getElementById('mini-btn-print').addEventListener('click', () => {
    const serviceId = document.getElementById('mini-service-select').value;
    const name = (document.getElementById('mini-ticket-name').value || '').trim();
    const phone = (document.getElementById('mini-ticket-phone').value || '').trim();
    if (!serviceId) { showToast('Pilih kategori layanan dulu!', 'error'); return; }
    
    currentTxId = 'mini-' + Date.now();
    sendAction('CREATE_TICKET', { serviceId, name, phone, txId: currentTxId });
    document.getElementById('mini-ticket-name').value = '';
    document.getElementById('mini-ticket-phone').value = '';
    showToast('Membuat & menyiapkan cetak tiket...', 'info');
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


// ==================== PRINTER FUNCTIONS ====================
async function loadPrinters() {
  const select = document.getElementById('mini-printer-select');
  if (!select) return;

  const savedPrinter = localStorage.getItem('mini_selected_printer') || '';
  select.innerHTML = '<option value="__DIALOG__">🖨️ Dialog Cetak (Pilih Manual)</option>';

  if (window.api && window.api.getPrinters) {
    try {
      const printers = await window.api.getPrinters();
      if (printers && printers.length > 0) {
        let foundSaved = false;
        let defaultPrinterName = '';

        printers.forEach(p => {
          const opt = document.createElement('option');
          opt.value = p.name;
          const isDef = !!p.isDefault;
          if (isDef) defaultPrinterName = p.name;
          const isThermal = /pos|thermal|receipt|58|80|tm-/i.test(p.name);
          const badge = isThermal ? '🧾 ' : (isDef ? '⭐ ' : '🖨️ ');
          opt.textContent = `${badge}${p.displayName || p.name}${isDef ? ' (Default)' : ''}`;
          select.appendChild(opt);
          if (p.name === savedPrinter) foundSaved = true;
        });

        if (savedPrinter && foundSaved) {
          select.value = savedPrinter;
        } else if (!savedPrinter) {
          // Prioritaskan thermal printer (seperti POS-58) atau default printer sistem
          const thermal = printers.find(p => /pos|thermal|receipt|58|80|tm-/i.test(p.name));
          if (thermal) {
            select.value = thermal.name;
            localStorage.setItem('mini_selected_printer', thermal.name);
          } else if (defaultPrinterName) {
            select.value = defaultPrinterName;
            localStorage.setItem('mini_selected_printer', defaultPrinterName);
          }
        }
      }
    } catch (err) {
      console.error('Gagal mengambil daftar printer:', err);
    }
  }
}

async function triggerMiniTicketPrint(ticket) {
  const instansiEl = document.getElementById('print-instansi-name');
  if (instansiEl) {
    instansiEl.textContent = currentServerName || '';
    instansiEl.style.display = currentServerName ? 'block' : 'none';
  }

  const srvEl = document.getElementById('print-service-name');
  if (srvEl) srvEl.textContent = ticket.service_name || 'Layanan';

  const ticketNoEl = document.getElementById('print-ticket-no');
  if (ticketNoEl) ticketNoEl.textContent = ticket.ticket_number || '---';

  const nameLbl = document.getElementById('print-customer-lbl');
  const cleanName = (ticket.customer_name || '').trim();
  if (cleanName && cleanName !== '-' && cleanName !== 'Pelanggan' && cleanName !== 'Pelanggan Mandiri') {
    if (nameLbl) {
      nameLbl.textContent = 'Nama: ' + cleanName;
      nameLbl.style.display = 'block';
    }
  } else if (nameLbl) {
    nameLbl.textContent = '';
    nameLbl.style.display = 'none';
  }

  const timeEl = document.getElementById('print-time-lbl');
  if (timeEl) {
    const dateObj = ticket.created_at ? new Date(ticket.created_at) : new Date();
    timeEl.textContent = 'Waktu: ' + dateObj.toLocaleString('id-ID');
  }

  const printerSelect = document.getElementById('mini-printer-select');
  const selectedPrinter = printerSelect ? printerSelect.value : '__DIALOG__';

  if (window.api && window.api.printTicket) {
    const isDialog = !selectedPrinter || selectedPrinter === '__DIALOG__';
    showToast(isDialog ? 'Membuka dialog cetak tiket...' : `Mencetak ke ${selectedPrinter}...`, 'info');
    
    const res = await window.api.printTicket({
      deviceName: isDialog ? undefined : selectedPrinter,
      silent: !isDialog
    });

    if (res && res.success) {
      showToast(`Tiket ${ticket.ticket_number} berhasil dicetak!`, 'success');
    } else if (res && res.reason && res.reason !== 'cancelled') {
      showToast(`Gagal mencetak: ${res.reason}`, 'error');
    }
  } else {
    // Fallback native print dialog
    window.print();
  }
}
