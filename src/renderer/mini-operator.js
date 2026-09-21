// ==================== MINI OPERATOR WINDOW ====================
// Jendela kecil mengambang yang muncul saat operator window diminimalkan.
// Berisi kontrol penting antrian tanpa perlu membuka jendela utama.

let ws = null;
let currentWsUrl = '';
let reconnectTimer = null;
let servicesList = [];
let latestCallingTickets = [];
let latestWaitingTickets = [];
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

  if (type === 'STATE_UPDATE' && payload) {
    const services = Array.isArray(payload.services) ? payload.services : [];
    const callingTickets = Array.isArray(payload.callingTickets) ? payload.callingTickets : [];
    const waitingTickets = Array.isArray(payload.waitingTickets) ? payload.waitingTickets : [];

    servicesList = services;
    latestCallingTickets = callingTickets;
    latestWaitingTickets = waitingTickets;
    if (payload.serverName) currentServerName = payload.serverName;

    updateActiveTickets(callingTickets);
    updateServiceDropdown(services);
    updateServiceFilterDropdown(services);
    updateCallDeskDropdown(services, callingTickets);
  }

  if (type === 'SETTINGS_UPDATE' && payload) {
    const mode = payload.display_mode || 'queue';
    setActiveMode(mode);
  }

  if (type === 'ANNOUNCE_CALL' && payload) {
    playMiniAnnouncement(payload.ticketNumber, payload.deskNumber, payload.voiceFiles);
  }

  if (type === 'STOP_ANNOUNCEMENT') {
    stopMiniAudio();
  }

  if (type === 'ALERT' && payload) {
    showToast(payload.message || 'Pemberitahuan', 'warning');
  }

  if (type === 'TICKET_CREATED') {
    const ticket = payload;
    showToast('Tiket ' + (ticket.ticket_number || '') + ' berhasil dibuat!', 'success');

    // Jika tiket dibuat dari mini operator ini -> cetak tiket ke printer terpilih
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
  else if (services.length > 0) select.value = services[0].id;
}

function updateServiceFilterDropdown(services) {
  const row = document.getElementById('mini-service-row');
  const select = document.getElementById('mini-service-filter-select');
  if (!select) return;

  if (!services || services.length <= 1) {
    if (row) row.style.display = 'none';
    return;
  }

  if (row) row.style.display = 'flex';
  const currentVal = select.value || localStorage.getItem('mini_selected_service_id') || services[0].id;
  select.innerHTML = '';
  services.forEach(srv => {
    const opt = document.createElement('option');
    opt.value = srv.id;
    opt.textContent = `[${srv.prefix}] ${srv.name}`;
    select.appendChild(opt);
  });

  const exists = services.some(s => s.id === currentVal);
  if (exists) {
    select.value = currentVal;
  } else if (services.length > 0) {
    select.value = services[0].id;
  }
}

function updateCallDeskDropdown(services, callingTickets) {
  const select = document.getElementById('mini-call-desk-select');
  if (!select) return;

  if (!services || services.length === 0) {
    select.innerHTML = '<option value="">-- Belum ada layanan di Settings --</option>';
    updateCurrentCall(callingTickets, services);
    return;
  }

  // Pilihan MURNI DAN HANYA mengikuti layanan yang terdaftar di Settings!
  const validServiceIds = services.map(s => s.id);
  let selectedServiceId = localStorage.getItem('mini_selected_service_id');
  if (!selectedServiceId || !validServiceIds.includes(selectedServiceId)) {
    selectedServiceId = services[0].id;
    localStorage.setItem('mini_selected_service_id', selectedServiceId);
  }

  const currentSrv = services.find(s => s.id === selectedServiceId) || services[0];

  // Bersihkan stale localStorage
  let savedLocalDesks = {};
  try { savedLocalDesks = JSON.parse(localStorage.getItem('local_desk_settings') || '{}'); } catch (_) {}
  if (!savedLocalDesks[currentSrv.id] || savedLocalDesks[currentSrv.id] !== currentSrv.name) {
    savedLocalDesks[currentSrv.id] = currentSrv.name;
    localStorage.setItem('local_desk_settings', JSON.stringify(savedLocalDesks));
  }

  select.innerHTML = '';
  services.forEach(srv => {
    const opt = document.createElement('option');
    opt.value = srv.id;
    opt.dataset.desk = srv.name;
    opt.dataset.prefix = srv.prefix;
    opt.textContent = services.length > 1 ? `[${srv.prefix}] ${srv.name}` : srv.name;
    select.appendChild(opt);
  });

  select.value = currentSrv.id;

  updateCurrentCall(callingTickets, services);
}

function getSelectedServiceId() {
  const filterSelect = document.getElementById('mini-service-filter-select');
  if (filterSelect && filterSelect.value) return filterSelect.value;
  const saved = localStorage.getItem('mini_selected_service_id');
  if (saved && servicesList.some(s => s.id === saved)) return saved;
  if (servicesList.length > 0) return servicesList[0].id;
  return null;
}

function getDeskNumber(serviceId) {
  const targetId = serviceId || getSelectedServiceId();
  const srv = servicesList.find(s => s.id === targetId);
  if (srv) return srv.name;
  if (servicesList.length > 0) return servicesList[0].name;
  return 'Loket';
}

function updateCurrentCall(callingTickets, services) {
  const callPanel = document.getElementById('mini-current-call');
  const numEl = document.getElementById('mini-call-number');
  const deskEl = document.getElementById('mini-call-desk');
  const btnComplete = document.getElementById('mini-btn-complete');
  const btnRecall = document.getElementById('mini-btn-recall');
  const btnSkip = document.getElementById('mini-btn-skip');

  const selectedServiceId = getSelectedServiceId();
  const srv = (services || servicesList).find(s => s.id === selectedServiceId);
  const chosenDesk = getDeskNumber(selectedServiceId);

  let ticket = null;
  if (selectedServiceId && callingTickets) {
    ticket = callingTickets.find(t => t.service_id === selectedServiceId);
  }
  if (!ticket && callingTickets && callingTickets.length > 0) {
    ticket = callingTickets[0];
  }

  if (ticket) {
    const srvForTicket = (services || servicesList).find(s => s.id === ticket.service_id);
    const validNames = (services || servicesList).map(s => s.name);
    let displayDesk = '';
    if (ticket.desk_number && validNames.includes(ticket.desk_number)) {
      displayDesk = ticket.desk_number;
    } else if (srvForTicket) {
      displayDesk = srvForTicket.name;
    } else {
      displayDesk = ticket.service_name || chosenDesk;
    }

    if (callPanel) callPanel.classList.remove('standby');
    if (numEl) numEl.textContent = ticket.ticket_number;
    if (deskEl) deskEl.textContent = displayDesk;
    if (btnComplete) btnComplete.disabled = false;
    if (btnRecall) btnRecall.disabled = false;
    if (btnSkip) btnSkip.disabled = false;
  } else {
    if (callPanel) callPanel.classList.add('standby');
    if (numEl) numEl.textContent = '---';
    if (deskEl) deskEl.textContent = `${chosenDesk} (Standby)`;
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

function getActiveTicket() {
  const keys = Object.keys(activeTickets);
  if (keys.length > 0) return activeTickets[keys[0]];
  return null;
}

function getActiveTicketForService(serviceId) {
  if (serviceId && activeTickets[serviceId]) {
    return activeTickets[serviceId];
  }
  return getActiveTicket();
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

  // Panggil berikutnya (Cerdas: jika tidak ada waiting tapi ada antrian aktif, otomatis panggil ulang dengan loket yang dipilih)
  document.getElementById('mini-btn-call').addEventListener('click', () => {
    const serviceId = getSelectedServiceId();
    if (!serviceId) { showToast('Belum ada layanan.', 'error'); return; }
    const deskNumber = getDeskNumber(serviceId);

    const waitingForService = (latestWaitingTickets || []).filter(t => t.service_id === serviceId);
    const activeTicket = getActiveTicketForService(serviceId);

    if (waitingForService.length > 0) {
      sendAction('CALL_NEXT', { serviceId, deskNumber });
      showToast('Memanggil antrian berikutnya (' + deskNumber + ')...', 'info');
    } else if (activeTicket) {
      sendAction('RECALL', { ticketId: activeTicket.id, deskNumber });
      showToast('Memanggil ulang ' + activeTicket.ticket_number + ' (' + deskNumber + ')...', 'info');
    } else {
      sendAction('CALL_NEXT', { serviceId, deskNumber });
      showToast('Memanggil (' + deskNumber + ')...', 'info');
    }
  });

  // Selesai
  document.getElementById('mini-btn-complete').addEventListener('click', () => {
    const serviceId = getSelectedServiceId();
    const ticket = getActiveTicketForService(serviceId);
    if (!ticket) { showToast('Tidak ada antrian aktif.', 'error'); return; }
    const deskNumber = getDeskNumber(ticket.service_id || serviceId);
    sendAction('COMPLETE', { ticketId: ticket.id, serviceId: ticket.service_id, deskNumber, autoCallNext: true });
    showToast('Antrian diselesaikan.', 'success');
  });

  // Panggil ulang
  document.getElementById('mini-btn-recall').addEventListener('click', () => {
    const serviceId = getSelectedServiceId();
    const ticket = getActiveTicketForService(serviceId);
    if (!ticket) { showToast('Tidak ada antrian aktif.', 'error'); return; }
    const deskNumber = getDeskNumber(ticket.service_id || serviceId);
    sendAction('RECALL', { ticketId: ticket.id, deskNumber });
    showToast('Memanggil ulang ' + ticket.ticket_number + ' (' + deskNumber + ')...', 'info');
  });

  // Lewati
  document.getElementById('mini-btn-skip').addEventListener('click', () => {
    const serviceId = getSelectedServiceId();
    const ticket = getActiveTicketForService(serviceId);
    if (!ticket) { showToast('Tidak ada antrian aktif.', 'error'); return; }
    sendAction('SKIP', { ticketId: ticket.id });
    showToast('Antrian dilewati.', 'warning');
  });

  // Sound toggle button
  const soundBtn = document.getElementById('mini-btn-sound');
  if (soundBtn) {
    // Default adalah MUTED (true) jika belum ada setelan tersimpan
    const savedMuted = localStorage.getItem('mini_audio_muted');
    const isMuted = savedMuted === null ? true : savedMuted === 'true';
    soundBtn.textContent = isMuted ? '🔇' : '🔊';
    soundBtn.title = isMuted ? 'Suara Dinonaktifkan (Klik untuk aktifkan)' : 'Suara Aktif (Klik untuk bisukan)';

    soundBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const currentVal = localStorage.getItem('mini_audio_muted');
      const currentlyMuted = currentVal === null ? true : currentVal === 'true';
      const newMuted = !currentlyMuted;
      localStorage.setItem('mini_audio_muted', newMuted ? 'true' : 'false');
      soundBtn.textContent = newMuted ? '🔇' : '🔊';
      soundBtn.title = newMuted ? 'Suara Dinonaktifkan (Klik untuk aktifkan)' : 'Suara Aktif (Klik untuk bisukan)';
      showToast(newMuted ? 'Suara di Mini Operator dibisukan' : 'Suara di Mini Operator diaktifkan', 'info');
      if (newMuted) stopMiniAudio();
    });
  }

  // Listener perubahan dropdown Loket: Simpan & kirim UPDATE_ACTIVE_TICKET_DESK langsung!
  const callDeskSelect = document.getElementById('mini-call-desk-select');
  if (callDeskSelect) {
    callDeskSelect.addEventListener('change', (e) => {
      const srvId = e.target.value;
      if (!srvId) return;

      localStorage.setItem('mini_selected_service_id', srvId);
      const printSelect = document.getElementById('mini-service-select');
      if (printSelect) printSelect.value = srvId;

      const srv = servicesList.find(s => s.id === srvId);
      const deskName = srv ? srv.name : '';

      // Update localDeskSettings
      let savedLocalDesks = {};
      try { savedLocalDesks = JSON.parse(localStorage.getItem('local_desk_settings') || '{}'); } catch (_) {}
      savedLocalDesks[srvId] = deskName;
      localStorage.setItem('local_desk_settings', JSON.stringify(savedLocalDesks));

      // Update UI Mini Operator seketika
      const deskEl = document.getElementById('mini-call-desk');
      const ticket = getActiveTicketForService(srvId);
      if (ticket) {
        ticket.desk_number = deskName;
        if (deskEl) deskEl.textContent = deskName;
        sendAction('UPDATE_ACTIVE_TICKET_DESK', { ticketId: ticket.id, deskNumber: deskName });
      } else {
        if (deskEl) deskEl.textContent = `${deskName} (Standby)`;
      }

      updateCurrentCall(latestCallingTickets, servicesList);
      sendAction('SYNC_DESK_NAMES', { deskNames: [deskName] });
      showToast('Layanan aktif: ' + deskName, 'info');
    });
  }

  // Listener perubahan filter layanan (jika > 1 layanan)
  const serviceFilterSelect = document.getElementById('mini-service-filter-select');
  if (serviceFilterSelect) {
    serviceFilterSelect.addEventListener('change', (e) => {
      const srvId = e.target.value;
      if (srvId) {
        localStorage.setItem('mini_selected_service_id', srvId);
        const printSelect = document.getElementById('mini-service-select');
        if (printSelect) printSelect.value = srvId;
        updateCallDeskDropdown(servicesList, latestCallingTickets);
      }
    });
  }

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
          // Prioritaskan thermal printer atau default printer sistem
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

// Template thermal print trigger
async function triggerMiniTicketPrint(ticket) {
  const instansiName = (currentServerName || 'SimpleAntrian').toUpperCase();
  const titleEl = document.getElementById('print-instansi-name');
  if (titleEl) titleEl.textContent = instansiName;

  const serviceEl = document.getElementById('print-service-name');
  if (serviceEl) serviceEl.textContent = ticket.service_name || 'Layanan';

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

// ==================== MINI OPERATOR AUDIO ENGINE ====================
let currentMiniAudio = null;
let isMiniAnnouncing = false;

function stopMiniAudio() {
  isMiniAnnouncing = false;
  if (currentMiniAudio) {
    try {
      currentMiniAudio.pause();
      currentMiniAudio.currentTime = 0;
      currentMiniAudio.src = '';
    } catch (_) {}
    currentMiniAudio = null;
  }
}

// Ding-Dong Chime 2-Nada via Web Audio API
function playMiniDingDong() {
  return new Promise((resolve) => {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return resolve();
      const ctx = new AudioCtx();

      const playTone = (freq, start, duration) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, ctx.currentTime + start);
        gain.gain.setValueAtTime(0.25, ctx.currentTime + start);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + duration);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(ctx.currentTime + start);
        osc.stop(ctx.currentTime + start + duration);
      };

      playTone(587.33, 0, 0.35);    // D5
      playTone(880.00, 0.22, 0.55);  // A5
      setTimeout(() => {
        try { ctx.close(); } catch (_) {}
        resolve();
      }, 850);
    } catch (_) {
      resolve();
    }
  });
}

// Putar rangkaian audio pengumuman (voice clips)
function playMiniAudioSequence(urls) {
  return new Promise((resolve) => {
    if (!urls || urls.length === 0 || !isMiniAnnouncing) {
      resolve();
      return;
    }

    let index = 0;
    const audio = new Audio();
    currentMiniAudio = audio;

    const playNext = () => {
      if (!isMiniAnnouncing || index >= urls.length) {
        currentMiniAudio = null;
        resolve();
        return;
      }
      audio.src = urls[index];
      audio.play().catch(err => {
        console.warn('[Mini Audio] Clip playback failed:', urls[index], err);
        index++;
        playNext();
      });
    };

    audio.onended = () => {
      index++;
      playNext();
    };

    audio.onerror = () => {
      index++;
      playNext();
    };

    playNext();
  });
}

async function playMiniAnnouncement(ticketNumber, deskNumber, voiceFiles) {
  const savedMuted = localStorage.getItem('mini_audio_muted');
  const isMuted = savedMuted === null ? true : savedMuted === 'true';
  if (isMuted) return;
  if (!voiceFiles || voiceFiles.length === 0) return;

  stopMiniAudio();
  isMiniAnnouncing = true;

  try {
    // 1. Bunyikan Bel Ding-Dong
    await playMiniDingDong();

    if (!isMiniAnnouncing) return;

    // 2. Putar Suara Nomor Antrian & Loket
    let host = '127.0.0.1:8080';
    if (ws && ws.url) {
      try {
        const u = new URL(ws.url);
        host = (u.hostname === 'localhost' || u.hostname === '::1') ? `127.0.0.1:${u.port || 8080}` : u.host;
      } catch (_) {}
    } else if (currentWsUrl) {
      try {
        const u = new URL(currentWsUrl);
        host = (u.hostname === 'localhost' || u.hostname === '::1') ? `127.0.0.1:${u.port || 8080}` : u.host;
      } catch (_) {}
    }

    const audioBaseUrl = `http://${host}/audio`;
    const urls = voiceFiles.map(file => `${audioBaseUrl}/${file}`);

    await playMiniAudioSequence(urls);
  } catch (err) {
    console.warn('[Mini Operator] Audio error:', err);
  }
}
