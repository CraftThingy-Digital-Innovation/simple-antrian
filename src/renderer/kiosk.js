let socket = null;
let serverPort = 8080;
let serverName = 'Server Antrian';
let selectedServiceId = null;
let currentServices = [];
let currentFeedbackSurveyUrl = '';
let currentFeedbackQrDataUrl = '';
let targetPrinter = '';
let transactionId = '';
let isReconnecting = false;
let settingsCached = null;

// Generate random string for tracking transaction
function generateTxId() {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

// Inisialisasi koneksi Kiosk ke WebSocket Server & Deteksi Printer Desktop
async function initKiosk() {
  try {
    const info = await window.api.getSystemInfo();
    serverPort = info.port || 8080;
    serverName = info.serverName || 'Server Antrian';
    
    // 1. Ambil Pengaturan dari Database SQLite (Desktop Settings)
    try {
      settingsCached = await window.api.getSettings();
      applyKioskCustomization(settingsCached);
    } catch (e) {
      console.warn("[Kiosk] Gagal mengambil settings:", e);
    }

    // 2. Deteksi Printer Thermal Desktop (58mm / 80mm)
    await detectTargetPrinter();

    // 3. Setup Jam & Tanggal Realtime
    startKioskClock();

    // 4. Setup Tombol Fullscreen
    setupFullscreenButton();
    
    // 5. Tentukan URL WebSocket
    let wsUrl = '';
    if (info.mode === 'server') {
      wsUrl = `ws://127.0.0.1:${serverPort}`;
    } else {
      // Jika mode client, hubungkan ke server terakhir yang tersimpan di DB / localStorage
      const lastConnectedServer = (settingsCached && settingsCached.active_server_endpoint) || localStorage.getItem('last_connected_server');
      if (lastConnectedServer) {
        wsUrl = `ws://${lastConnectedServer}`;
      } else {
        wsUrl = `ws://127.0.0.1:${serverPort}`;
      }

      // Jalankan UDP Discovery Listener di Kiosk Client untuk auto-connect
      window.api.onServersUpdated((servers) => {
        if (servers.length > 0) {
          const srv = servers[0];
          const srvIpPort = `${srv.ip}:${srv.port}`;
          const currentUrl = `ws://${srvIpPort}`;
          
          const lastSaved = localStorage.getItem('last_connected_server');
          if (lastSaved !== srvIpPort) {
            localStorage.setItem('last_connected_server', srvIpPort);
          }
          
          if (!socket || socket.readyState === WebSocket.CLOSED) {
            console.log(`[UDP Kiosk] Auto-connecting to discovered server: ${srvIpPort}`);
            connectWebSocket(currentUrl);
          }
        }
      });
    }

    // Dengarkan perubahan endpoint server dari Operator Panel secara realtime
    window.api.onServerEndpointChanged((newEndpoint) => {
      console.log(`[Kiosk] Server endpoint diubah oleh operator menjadi: ${newEndpoint}`);
      connectWebSocket(`ws://${newEndpoint}`);
    });
    
    connectWebSocket(wsUrl);
  } catch (err) {
    console.error("Gagal inisialisasi Kiosk:", err);
    showToast("Gagal mengambil konfigurasi sistem.", "error");
  }
}

// Terapkan branding & kustomisasi tampilan (Logo, Judul, Subtitle, Tema)
function applyKioskCustomization(settings) {
  if (!settings) return;
  const titleEl = document.getElementById('kiosk-server-name');
  const subtitleEl = document.getElementById('kiosk-subtitle');
  const logoContainer = document.getElementById('kiosk-logo-container');
  const logoImg = document.getElementById('kiosk-logo-img');

  const titleVal = settings.display_title || settings.title || settings.displayTitle || settings.app_name;
  if (titleEl && titleVal) {
    titleEl.innerText = titleVal;
  }
  
  const subtitleVal = settings.display_subtitle || settings.subtitle || settings.displaySubtitle;
  if (subtitleEl && subtitleVal !== undefined) {
    subtitleEl.innerText = subtitleVal || 'Pendaftaran Antrian Mandiri';
  }

  const logoVal = settings.display_logo || settings.logo || settings.displayLogo;
  if (logoContainer && logoImg) {
    if (logoVal) {
      logoImg.src = logoVal;
      logoContainer.style.display = 'flex';
    } else if (settings.display_logo === '' || settings.logo === null) {
      logoContainer.style.display = 'none';
      logoImg.src = '';
    }
  }

  const themeVal = settings.color_theme || settings.theme || settings.colorTheme;
  if (themeVal !== undefined) {
    document.body.className = themeVal === 'imigrasi' ? 'theme-imigrasi' : '';
  }

  const surveyUrlVal = settings.feedback_survey_url || settings.feedbackSurveyUrl;
  if (surveyUrlVal !== undefined) {
    currentFeedbackSurveyUrl = surveyUrlVal;
  }

  const surveyQrVal = settings.feedback_qr_data_url || settings.feedbackQrDataUrl;
  if (surveyQrVal !== undefined) {
    currentFeedbackQrDataUrl = surveyQrVal;
  }
}

// Deteksi Printer Thermal yang tersedia di OS untuk pencetakan tiket tanpa dialog
async function detectTargetPrinter() {
  try {
    if (!window.api || !window.api.getPrinters) return;
    const printers = await window.api.getPrinters();
    if (!printers || printers.length === 0) return;

    const savedPrinter = (settingsCached && settingsCached.selected_printer) || localStorage.getItem('mini_selected_printer');
    if (savedPrinter && printers.some(p => p.name === savedPrinter)) {
      targetPrinter = savedPrinter;
    } else {
      // Prioritaskan printer thermal (POS, Receipt, 58, 80, TM-T)
      const thermal = printers.find(p => /pos|thermal|receipt|58|80|tm-/i.test(p.name));
      if (thermal) {
        targetPrinter = thermal.name;
      } else {
        const def = printers.find(p => p.isDefault);
        targetPrinter = def ? def.name : printers[0].name;
      }
    }
    console.log(`[Kiosk] Printer terpilih: ${targetPrinter}`);
  } catch (err) {
    console.warn("[Kiosk] Gagal mendeteksi printer:", err);
  }
}

// Jam digital & kalender realtime di navbar Kiosk
function startKioskClock() {
  const clockEl = document.getElementById('kiosk-clock');
  const dateEl = document.getElementById('kiosk-date');

  function update() {
    const now = new Date();
    if (clockEl) {
      clockEl.innerText = now.toLocaleTimeString('id-ID', { hour12: false }) + ' WIB';
    }
    if (dateEl) {
      dateEl.innerText = now.toLocaleDateString('id-ID', {
        weekday: 'long', day: 'numeric', month: 'short', year: 'numeric'
      });
    }
  }
  update();
  setInterval(update, 1000);
}

// Setup Tombol Fullscreen Touch
function setupFullscreenButton() {
  const fsBtn = document.getElementById('btn-kiosk-fullscreen');
  if (!fsBtn) return;
  fsBtn.addEventListener('click', () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  });
}

// Koneksi ke server antrian via WebSocket
function connectWebSocket(url) {
  const statusDot = document.getElementById('kiosk-status-dot');
  if (statusDot) {
    statusDot.innerText = 'Connecting...';
    statusDot.className = 'badge badge-waiting';
  }

  if (socket) {
    try {
      socket.close();
    } catch (_) {}
  }

  socket = new WebSocket(url);

  socket.onopen = () => {
    isReconnecting = false;
    if (statusDot) {
      statusDot.innerText = 'Online / Terhubung';
      statusDot.className = 'badge badge-completed';
    }
    showToast("Terhubung ke server antrian.", "success");
    
    // Minta data state penuh (layanan, tiket, survei)
    socket.send(JSON.stringify({
      type: 'GET_STATE'
    }));
  };

  socket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'PING') {
        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'PONG' }));
        }
        return;
      }
      
      switch (data.type) {
        case 'STATE_UPDATE': {
          const payload = data.payload || {};
          currentServices = payload.services || [];
          renderKioskServices(currentServices);
          if (payload.colorTheme !== undefined) {
            document.body.className = payload.colorTheme === 'imigrasi' ? 'theme-imigrasi' : '';
          }
          if (payload.feedbackSurveyUrl !== undefined) {
            currentFeedbackSurveyUrl = payload.feedbackSurveyUrl;
          }
          if (payload.feedbackQrDataUrl !== undefined) {
            currentFeedbackQrDataUrl = payload.feedbackQrDataUrl;
          }
          // Sinkronisasi otomatis judul, subtitle, logo, dan branding dari state desktop
          if (payload.displayTitle || payload.displayLogo || payload.displaySubtitle) {
            applyKioskCustomization(payload);
          }
          break;
        }

        case 'DISPLAY_CUSTOM_UPDATE':
          applyKioskCustomization(data.payload);
          break;

        case 'SERVICES_LIST':
          currentServices = data.payload;
          renderKioskServices(currentServices);
          break;
          
        case 'TICKET_CREATED': {
          const ticket = data.payload;
          // Periksa apakah tiket ini dibuat oleh transaksi Kiosk ini
          if (transactionId && ticket.tx_id === transactionId) {
            triggerTicketPrint(ticket);
            closeKioskModal();
            transactionId = ''; // Reset transaksi
          }
          break;
        }
          
        case 'SYSTEM_STATE':
          currentServices = data.payload.services || [];
          renderKioskServices(currentServices);
          break;
      }
    } catch (e) {
      console.error("Error memproses pesan WS:", e);
    }
  };

  socket.onclose = () => {
    if (statusDot) {
      statusDot.innerText = 'Disconnected';
      statusDot.className = 'badge badge-skipped';
    }
    
    // Hindari double-reconnect dengan flag guard
    if (!isReconnecting) {
      isReconnecting = true;
      setTimeout(() => {
        connectWebSocket(url);
      }, 5000);
    }
  };
}

// Render daftar kartu layanan di layar Kiosk
function renderKioskServices(services) {
  const grid = document.getElementById('kiosk-service-grid');
  if (!grid) return;
  grid.innerHTML = '';
  
  if (!services || services.length === 0) {
    grid.innerHTML = `<div style="grid-column: 1/-1; text-align: center; color: var(--text-muted); padding: 50px;">
      <div style="font-size: 2.5rem; margin-bottom: 12px;">📋</div>
      <div style="font-size: 1.15rem; font-weight: 600;">Tidak ada layanan aktif saat ini</div>
      <div style="font-size: 0.95rem; margin-top: 6px;">Silakan aktifkan kategori layanan melalui Operator Panel.</div>
    </div>`;
    return;
  }

  services.forEach(srv => {
    const card = document.createElement('div');
    card.className = 'kiosk-card';
    card.onclick = () => openKioskModal(srv.id);
    
    card.innerHTML = `
      <div class="kiosk-card-icon">${srv.prefix || 'A'}</div>
      <div class="kiosk-card-title">${srv.name}</div>
      <div class="kiosk-card-desc">${srv.description || ('Loket Layanan ' + (srv.prefix || ''))}</div>
      <div class="kiosk-card-action">
        <span>Sentuh untuk Ambil Antrian</span>
        <span>➔</span>
      </div>
    `;
    grid.appendChild(card);
  });
}

// Buka modal input data pelanggan
function openKioskModal(serviceId) {
  selectedServiceId = serviceId;
  const srv = currentServices.find(s => s.id === serviceId);
  const modal = document.getElementById('kiosk-modal');
  const badgeEl = document.getElementById('modal-service-badge');
  const srvNameEl = document.getElementById('modal-service-name');

  if (badgeEl) badgeEl.innerText = srv ? (`Layanan ${srv.prefix}`) : 'Layanan';
  if (srvNameEl) srvNameEl.innerText = srv ? srv.name : 'Data Pendaftaran';
  
  modal.classList.add('show');
  
  // Reset input
  document.getElementById('kiosk-customer-name').value = '';
  document.getElementById('kiosk-customer-phone').value = '';
  document.getElementById('kiosk-customer-name').focus();
}

// Tutup modal input
function closeKioskModal() {
  const modal = document.getElementById('kiosk-modal');
  modal.classList.remove('show');
  selectedServiceId = null;
}

// Kirim data ke WebSocket untuk membuat tiket antrian baru
function submitKioskTicket() {
  if (!selectedServiceId || !socket || socket.readyState !== WebSocket.OPEN) {
    showToast("Gagal mengambil antrian, koneksi terputus.", "error");
    return;
  }
  
  const nameInput = document.getElementById('kiosk-customer-name').value.trim();
  const phoneInput = document.getElementById('kiosk-customer-phone').value.trim();
  
  // Tentukan id transaksi unik agar printer tahu tiket mana yang dicetak
  transactionId = generateTxId();

  const payload = {
    serviceId: selectedServiceId,
    customerName: nameInput || 'Pelanggan Mandiri',
    customerPhone: phoneInput || null,
    txId: transactionId
  };

  socket.send(JSON.stringify({
    type: 'CREATE_TICKET',
    payload: payload
  }));
}

// Bangun HTML cetak thermal yang presisi, terpusat, dan seragam dengan Operator Desktop
function buildThermalReceiptHtml(ticket, service) {
  const titleEl = document.getElementById('kiosk-server-name');
  const instansiName = (titleEl && titleEl.innerText ? titleEl.innerText.trim() : 'SIMPLEANTRIAN').toUpperCase();
  const serviceName = service ? service.name : (ticket.service_name || 'Layanan');
  const ticketNumber = ticket.ticket_number || 'A-001';
  const cleanCustomer = (ticket.customer_name || '').trim();
  const validCustomer = (cleanCustomer && cleanCustomer !== '-' && cleanCustomer !== 'Pelanggan' && cleanCustomer !== 'Pelanggan Mandiri') ? cleanCustomer : '';
  const dateObj = ticket.created_at ? new Date(ticket.created_at) : new Date();
  const timeStr = dateObj.toLocaleString('id-ID', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });

  const is80 = /80/i.test(targetPrinter || '');
  const paperWidth = is80 ? '80mm' : '58mm';
  const contentWidth = is80 ? '72mm' : '48mm';
  const numSize = is80 ? '36pt' : '32pt';
  const qrSize = is80 ? '90px' : '75px';

  return '<!DOCTYPE html>' +
    '<html>' +
    '<head>' +
    '  <meta charset="utf-8">' +
    '  <style>' +
    '    @page { size: ' + paperWidth + ' auto; margin: 0; }' +
    '    * { box-sizing: border-box; margin: 0; padding: 0; }' +
    '    html, body {' +
    '      width: ' + paperWidth + ';' +
    '      margin: 0 auto;' +
    '      padding: 0;' +
    '      background: #ffffff !important;' +
    '      color: #000000 !important;' +
    '      font-family: "Segoe UI", Arial, -apple-system, sans-serif;' +
    '      -webkit-print-color-adjust: exact !important;' +
    '      print-color-adjust: exact !important;' +
    '      text-align: center;' +
    '    }' +
    '    .ticket {' +
    '      width: ' + contentWidth + ';' +
    '      margin: 0 auto;' +
    '      padding: 4px 0 14px 0;' +
    '      text-align: center;' +
    '    }' +
    '    .instansi {' +
    '      font-size: 8.5pt;' +
    '      font-weight: 700;' +
    '      line-height: 1.2;' +
    '      margin-bottom: 2px;' +
    '      text-transform: uppercase;' +
    '      word-wrap: break-word;' +
    '    }' +
    '    .title {' +
    '      font-size: 11pt;' +
    '      font-weight: 800;' +
    '      letter-spacing: -0.5px;' +
    '      margin: 2px 0;' +
    '    }' +
    '    .service {' +
    '      font-size: 9.5pt;' +
    '      font-weight: 700;' +
    '      margin: 2px 0;' +
    '    }' +
    '    .divider {' +
    '      border-top: 1px dashed #000000;' +
    '      width: 100%;' +
    '      margin: 6px auto;' +
    '    }' +
    '    .number {' +
    '      font-size: ' + numSize + ';' +
    '      font-weight: 900;' +
    '      letter-spacing: 0.5px;' +
    '      line-height: 1.1;' +
    '      margin: 4px 0;' +
    '      font-family: "Segoe UI", Arial, sans-serif;' +
    '    }' +
    '    .customer {' +
    '      font-size: 8.5pt;' +
    '      font-weight: 600;' +
    '      margin: 2px 0;' +
    '    }' +
    '    .time {' +
    '      font-size: 7.5pt;' +
    '      margin: 2px 0;' +
    '    }' +
    '    .survey-box {' +
    '      margin-top: 6px;' +
    '      padding-top: 5px;' +
    '      border-top: 1px dashed #000000;' +
    '      text-align: center;' +
    '    }' +
    '    .survey-title {' +
    '      font-size: 7.5pt;' +
    '      font-weight: 700;' +
    '      margin-bottom: 2px;' +
    '    }' +
    '    .survey-url {' +
    '      font-size: 6.8pt;' +
    '      word-break: break-all;' +
    '      margin-bottom: 3px;' +
    '      font-family: "Segoe UI", Arial, sans-serif;' +
    '      line-height: 1.25;' +
    '    }' +
    '    .survey-qr {' +
    '      width: ' + qrSize + ';' +
    '      height: ' + qrSize + ';' +
    '      margin: 2px auto;' +
    '      display: block;' +
    '      image-rendering: pixelated;' +
    '    }' +
    '    .note {' +
    '      font-size: 7.5pt;' +
    '      margin-top: 6px;' +
    '      line-height: 1.2;' +
    '    }' +
    '    .thanks {' +
    '      font-size: 8pt;' +
    '      font-weight: 700;' +
    '      margin-top: 2px;' +
    '    }' +
    '  </style>' +
    '</head>' +
    '<body>' +
    '  <div class="ticket">' +
    '    <div class="instansi">' + instansiName + '</div>' +
    '    <div class="title">NOMOR ANTRIAN</div>' +
    '    <div class="service">' + serviceName + '</div>' +
    '    <div class="divider"></div>' +
    '    <div class="number">' + ticketNumber + '</div>' +
    (validCustomer ? '<div class="customer">Nama: ' + validCustomer + '</div>' : '') +
    '    <div class="divider"></div>' +
    '    <div class="time">Waktu: ' + timeStr + '</div>' +
    (currentFeedbackSurveyUrl ? (
    '    <div class="survey-box">' +
    '      <div class="survey-title">⭐ Survei Kepuasan Layanan ⭐</div>' +
    '      <div class="survey-url">' + currentFeedbackSurveyUrl + '</div>' +
    (currentFeedbackQrDataUrl ? '<img src="' + currentFeedbackQrDataUrl + '" class="survey-qr" alt="QR Survei">' : '') +
    '    </div>'
    ) : '') +
    '    <div class="note">Silakan tunggu giliran Anda dipanggil.</div>' +
    '    <div class="thanks">Terima kasih</div>' +
    '  </div>' +
    '</body>' +
    '</html>';
}

// Tampilkan overlay visual status pencetakan tiket di layar Kiosk
function showPrintingOverlay(ticketNo) {
  const overlay = document.getElementById('kiosk-printing-overlay');
  const noEl = document.getElementById('printing-ticket-number');
  if (noEl) noEl.innerText = ticketNo;
  if (overlay) {
    overlay.style.display = 'flex';
    setTimeout(() => {
      overlay.classList.add('show');
    }, 10);
    setTimeout(() => {
      overlay.classList.remove('show');
      setTimeout(() => {
        overlay.style.display = 'none';
      }, 300);
    }, 3200);
  }
}

// Cetak Tiket Kiosk (Langsung silent ke thermal printer seperti di Operator Desktop)
async function triggerTicketPrint(ticket) {
  const service = currentServices.find(s => s.id === ticket.service_id);
  const receiptHtml = buildThermalReceiptHtml(ticket, service);

  // Tampilkan konfirmasi visual bahwa tiket sedang dicetak
  showPrintingOverlay(ticket.ticket_number);

  if (window.api && window.api.printTicket) {
    try {
      const isDialog = !targetPrinter || targetPrinter === '__DIALOG__';
      const res = await window.api.printTicket({
        deviceName: isDialog ? undefined : targetPrinter,
        silent: !isDialog,
        html: receiptHtml
      });
      if (res && res.success && !isDialog) {
        showToast(`Tiket ${ticket.ticket_number} berhasil dicetak ke ${targetPrinter}`, 'success');
      }
    } catch (err) {
      console.error("[Kiosk] Error saat mencetak tiket:", err);
      showToast("Gagal mencetak tiket ke printer thermal.", "error");
    }
  } else {
    // Fallback untuk browser jika di luar lingkungan Electron
    const srvName = service ? service.name : 'Layanan';
    const titleEl = document.getElementById('print-instansi-name');
    const serverTitleEl = document.getElementById('kiosk-server-name');
    if (titleEl) titleEl.innerText = (serverTitleEl && serverTitleEl.innerText ? serverTitleEl.innerText.trim() : 'SimpleAntrian').toUpperCase();

    const srvEl = document.getElementById('print-service-name');
    if (srvEl) srvEl.innerText = srvName;

    const ticketNoEl = document.getElementById('print-ticket-no');
    if (ticketNoEl) ticketNoEl.innerText = ticket.ticket_number;
    
    const nameLbl = document.getElementById('print-customer-lbl');
    const cleanName = (ticket.customer_name || '').trim();
    if (cleanName && cleanName !== '-' && cleanName !== 'Pelanggan' && cleanName !== 'Pelanggan Mandiri') {
      nameLbl.innerText = 'Nama: ' + cleanName;
      nameLbl.style.display = 'block';
    } else {
      nameLbl.innerText = '';
      nameLbl.style.display = 'none';
    }
    
    const dateObj = ticket.created_at ? new Date(ticket.created_at) : new Date();
    const timeEl = document.getElementById('print-time-lbl');
    if (timeEl) timeEl.innerText = 'Waktu: ' + dateObj.toLocaleString('id-ID');

    const surveySec = document.getElementById('print-survey-section');
    const surveyUrlEl = document.getElementById('print-survey-url');
    const surveyQrEl = document.getElementById('print-survey-qr');
    if (currentFeedbackSurveyUrl) {
      if (surveySec) surveySec.style.display = 'block';
      if (surveyUrlEl) surveyUrlEl.textContent = currentFeedbackSurveyUrl;
      if (surveyQrEl) {
        if (currentFeedbackQrDataUrl) {
          surveyQrEl.src = currentFeedbackQrDataUrl;
          surveyQrEl.style.display = 'block';
        } else {
          surveyQrEl.style.display = 'none';
        }
      }
    } else if (surveySec) {
      surveySec.style.display = 'none';
    }

    const printTicketEl = document.getElementById('print-ticket');
    if (printTicketEl) printTicketEl.style.display = 'block';
    setTimeout(() => {
      window.print();
      setTimeout(() => {
        if (printTicketEl) printTicketEl.style.display = 'none';
      }, 500);
    }, 60);
  }
}

// Hubungkan Kiosk saat halaman termuat
window.addEventListener('DOMContentLoaded', () => {
  document.getElementById('btn-kiosk-cancel').addEventListener('click', closeKioskModal);
  document.getElementById('btn-kiosk-submit').addEventListener('click', submitKioskTicket);
  
  // Submit via Enter di field input
  document.getElementById('kiosk-customer-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitKioskTicket();
  });
  document.getElementById('kiosk-customer-phone').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitKioskTicket();
  });

  // Inisialisasi koneksi Kiosk
  initKiosk();
});

// Expose functions globally on window
window.renderKioskServices = renderKioskServices;
window.applyKioskCustomization = applyKioskCustomization;
window.openKioskModal = openKioskModal;
window.closeKioskModal = closeKioskModal;
window.submitKioskTicket = submitKioskTicket;
window.triggerTicketPrint = triggerTicketPrint;
