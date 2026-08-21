let socket = null;
let serverPort = 8080;
let serverName = 'Server Antrian';
let selectedServiceId = null;
let currentServices = [];
let localIp = 'localhost';
let transactionId = '';
let isReconnecting = false; // Guard untuk mencegah double-reconnect

// Generate random string for tracking transaction
function generateTxId() {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

// Inisialisasi koneksi Kiosk ke WebSocket Server
async function initKiosk() {
  try {
    const info = await window.api.getSystemInfo();
    serverPort = info.port || 8080;
    serverName = info.serverName || 'Server Antrian';
    
    document.getElementById('kiosk-server-name').innerText = `Kiosk Pendaftaran - ${serverName}`;
    
    // Tentukan URL WebSocket
    let wsUrl = '';
    if (info.mode === 'server') {
      wsUrl = `ws://localhost:${serverPort}`;
    } else {
      // Jika mode client, hubungkan ke server terakhir yang tersimpan di localStorage
      const lastConnectedServer = localStorage.getItem('last_connected_server');
      if (lastConnectedServer) {
        wsUrl = `ws://${lastConnectedServer}`;
      } else {
        wsUrl = `ws://localhost:${serverPort}`;
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
    
    connectWebSocket(wsUrl);
  } catch (err) {
    console.error("Gagal inisialisasi Kiosk:", err);
    showToast("Gagal mengambil konfigurasi sistem.", "error");
  }
}

// Koneksi ke server antrian via WebSocket
function connectWebSocket(url) {
  const statusDot = document.getElementById('kiosk-status-dot');
  
  statusDot.innerText = 'Connecting...';
  statusDot.className = 'badge badge-waiting';

  if (socket) {
    try {
      socket.close();
    } catch (_) {}
  }

  socket = new WebSocket(url);

  socket.onopen = () => {
    isReconnecting = false;
    statusDot.innerText = 'Connected';
    statusDot.className = 'badge badge-completed';
    showToast("Terhubung ke server antrian.", "success");
    
    // Minta data state penuh (layanan, tiket) - server menangani GET_STATE
    socket.send(JSON.stringify({
      type: 'GET_STATE'
    }));
  };

  socket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      
      switch (data.type) {
        case 'STATE_UPDATE':
          // Tangani state update untuk mendapatkan daftar layanan aktif
          currentServices = data.payload.services || [];
          renderKioskServices(currentServices);
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
            showToast(`Nomor antrian Anda: ${ticket.ticket_number}`, 'success');
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
    statusDot.innerText = 'Disconnected';
    statusDot.className = 'badge badge-skipped';
    
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
  grid.innerHTML = '';
  
  if (services.length === 0) {
    grid.innerHTML = `<div style="grid-column: 1/-1; color: var(--text-muted);">Tidak ada layanan aktif saat ini. Silakan konfigurasi layanan di operator.</div>`;
    return;
  }

  services.forEach(srv => {
    const card = document.createElement('div');
    card.className = 'kiosk-card';
    card.onclick = () => openKioskModal(srv.id);
    
    // Custom icon/letter sesuai prefix
    card.innerHTML = `
      <div class="kiosk-card-icon">${srv.prefix}</div>
      <div class="kiosk-card-title">${srv.name}</div>
      <div class="kiosk-card-desc">Loket Layanan: ${srv.prefix}</div>
    `;
    grid.appendChild(card);
  });
}

// Buka modal input data pelanggan
function openKioskModal(serviceId) {
  selectedServiceId = serviceId;
  const modal = document.getElementById('kiosk-modal');
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

// Isi template print tiket dan trigger print dialog OS
function triggerTicketPrint(ticket) {
  const service = currentServices.find(s => s.id === ticket.service_id);
  const srvName = service ? service.name : 'Layanan Umum';
  
  document.getElementById('print-header-name').innerText = serverName.toUpperCase();
  document.getElementById('print-service-name').innerText = srvName;
  document.getElementById('print-ticket-no').innerText = ticket.ticket_number;
  
  const nameLbl = document.getElementById('print-customer-lbl');
  if (ticket.customer_name && ticket.customer_name !== 'Pelanggan Mandiri') {
    nameLbl.innerText = `Nama: ${ticket.customer_name}`;
    nameLbl.style.display = 'block';
  } else {
    nameLbl.innerText = '';
    nameLbl.style.display = 'none';
  }
  
  document.getElementById('print-time-lbl').innerText = `Waktu: ${new Date(ticket.created_at).toLocaleString('id-ID')}`;
  
  // Trigger cetak biner/dialog
  window.print();
}

// Hubungkan Kiosk saat halaman termuat + pasang event listener setelah DOM siap
window.addEventListener('DOMContentLoaded', () => {
  // Pasang event listener di sini agar DOM sudah tersedia
  document.getElementById('btn-kiosk-cancel').addEventListener('click', closeKioskModal);
  document.getElementById('btn-kiosk-submit').addEventListener('click', submitKioskTicket);
  
  // Inisialisasi koneksi Kiosk
  initKiosk();
});
