let ws = null;
let currentMode = 'server';
let serverPort = 8080;
let announcementQueue = [];
let isAnnouncing = false;

// Inisialisasi Halaman Display
document.addEventListener('DOMContentLoaded', async () => {
  // Mulai animasi background canvas
  initCanvasVisualizer();

  // Ambil info sistem untuk inisialisasi koneksi
  await initDisplayConnection();

  // Load teks running text pengumuman dari setting
  loadAnnouncements();
});

// Ambil info koneksi & hubungkan ke server websocket yang tepat
async function initDisplayConnection() {
  try {
    const info = await window.api.getSystemInfo();
    currentMode = info.mode;
    serverPort = info.port || 8080;

    const dbSettings = await window.api.getSettings();

    if (currentMode === 'server') {
      // Connect ke server lokal
      connectWebSocket(`ws://localhost:${serverPort}`);
    } else {
      // Mode Client: Hubungkan ke server remote yang disimpan di database/settings
      const activeEndpoint = dbSettings.active_server_endpoint || 'localhost:8080';
      connectWebSocket(`ws://${activeEndpoint}`);
    }
  } catch (err) {
    console.error('Failed to init display connection:', err);
    setTimeout(initDisplayConnection, 5000);
  }
}

// Hubungkan ke WebSocket
function connectWebSocket(url) {
  if (ws) {
    ws.close();
  }

  console.log(`Display connecting to ${url}`);
  ws = new WebSocket(url);

  ws.onopen = () => {
    console.log('Display WebSocket connected!');
    // Request data awal
    ws.send(JSON.stringify({ type: 'GET_STATE' }));
  };

  ws.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data);
      handleWebSocketMessage(message);
    } catch (err) {
      console.error('Error parsing display WS message:', err);
    }
  };

  ws.onclose = () => {
    console.log('Display WebSocket closed. Reconnecting in 5 seconds...');
    setTimeout(() => connectWebSocket(url), 5000);
  };

  ws.onerror = (err) => {
    console.error('Display WebSocket error:', err);
  };
}

// Handler pesan masuk WebSocket
function handleWebSocketMessage(message) {
  const { type, payload } = message;

  switch (type) {
    case 'STATE_UPDATE':
      renderDisplayState(payload);
      break;

    case 'ANNOUNCE_CALL':
      // Tambahkan panggilan ke antrian suara untuk diputar berurutan
      queueAnnouncement(payload.ticketNumber, payload.deskNumber);
      // Animasi kedip kedip pada display utama
      triggerCallAnimation(payload.ticketNumber, payload.deskNumber);
      break;
  }
}

// Render State Antrian di Layar Display
function renderDisplayState(state) {
  const { services, callingTickets } = state;

  // 1. Tampilkan Panggilan Aktif Utama
  const mainNumberEl = document.getElementById('lbl-call-number');
  const mainDeskEl = document.getElementById('lbl-call-desk');
  const mainDisplayPanel = document.getElementById('main-display-panel');

  if (callingTickets && callingTickets.length > 0) {
    // Tiket yang paling baru dipanggil adalah yang pertama
    const currentTicket = callingTickets[0];
    
    // Perbarui teks jika berbeda
    if (mainNumberEl.innerText !== currentTicket.ticket_number) {
      mainNumberEl.innerText = currentTicket.ticket_number;
      mainDeskEl.innerText = currentTicket.desk_number;
      mainDisplayPanel.classList.add('animate-call-blink');
      setTimeout(() => mainDisplayPanel.classList.remove('animate-call-blink'), 5000);
    }
  } else {
    // Tidak ada panggilan aktif, tampilkan default/standby
    mainNumberEl.innerText = '---';
    mainDeskEl.innerText = 'Loket Standby';
  }

  // 2. Tampilkan Layanan Lain di Sidebar
  const otherListEl = document.getElementById('lst-other-services');
  otherListEl.innerHTML = '';

  if (services.length === 0) {
    otherListEl.innerHTML = '<div style="text-align: center; color: var(--text-muted); margin-top: 20px;">Belum ada layanan aktif.</div>';
    return;
  }

  services.forEach(srv => {
    // Cari nomor terakhir yang sedang dipanggil
    const activeCall = callingTickets.find(t => t.service_id === srv.id);
    const num = activeCall ? activeCall.ticket_number : (srv.prefix + String(srv.current_number).padStart(3, '0'));

    const div = document.createElement('div');
    div.className = 'other-service-item animate-pop-in';
    div.innerHTML = `
      <span class="other-service-name">${srv.name}</span>
      <span class="other-service-number">${num}</span>
    `;
    otherListEl.appendChild(div);
  });
}

// Animasi Scale-Up pada Panggilan Baru
function triggerCallAnimation(ticketNumber, deskNumber) {
  const numberEl = document.getElementById('lbl-call-number');
  const deskEl = document.getElementById('lbl-call-desk');
  
  numberEl.innerText = ticketNumber;
  deskEl.innerText = deskNumber;

  numberEl.classList.add('scale-up');
  deskEl.classList.add('scale-up');

  setTimeout(() => {
    numberEl.classList.remove('scale-up');
    deskEl.classList.remove('scale-up');
  }, 3000);
}

// Load Running Text pengumuman dari SQLite Settings
async function loadAnnouncements() {
  try {
    const settings = await window.api.getSettings();
    if (settings.running_text) {
      document.getElementById('running-text-content').innerText = settings.running_text;
    }
  } catch (err) {
    console.error('Failed to load announcements:', err);
  }
}

// ==================== ANTRIAN SUARA (VOICE ANNOUNCEMENT QUEUE) ====================

function queueAnnouncement(ticketNumber, deskNumber) {
  announcementQueue.push({ ticketNumber, deskNumber });
  if (!isAnnouncing) {
    processNextAnnouncement();
  }
}

async function processNextAnnouncement() {
  if (announcementQueue.length === 0) {
    isAnnouncing = false;
    return;
  }

  isAnnouncing = true;
  const { ticketNumber, deskNumber } = announcementQueue.shift();

  try {
    // 1. Bunyikan Bel Ding-Dong
    await playDingDongChime();
    
    // Tunggu jeda singkat
    await delay(300);

    // 2. Putar Pengumuman Suara
    await playVoice(ticketNumber, deskNumber);
  } catch (err) {
    console.error('Announcement playback error:', err);
  }

  // Jeda antar pengumuman
  await delay(1000);
  processNextAnnouncement();
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Ding-Dong Chime menggunakan Web Audio API
function playDingDongChime() {
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
        gain.gain.linearRampToValueAtTime(0.3, audioCtx.currentTime + delay + 0.05);
        gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + delay + duration);
        
        osc.start(audioCtx.currentTime + delay);
        osc.stop(audioCtx.currentTime + delay + duration);
      };

      // Melodi Ding-Dong Elegan: E5 -> C5 -> G5
      playTone(659.25, 0, 0.4); 
      setTimeout(() => playTone(523.25, 0, 0.4), 250); 
      setTimeout(() => playTone(783.99, 0, 0.5), 500); 
      
      setTimeout(() => {
        audioCtx.close();
        resolve();
      }, 1000);
    } catch (e) {
      resolve(); // Tetap selesaikan jika Web Audio gagal
    }
  });
}

// Pengumuman Suara Text-To-Speech
function playVoice(ticketNumber, deskNumber) {
  return new Promise((resolve) => {
    const prefix = ticketNumber.charAt(0);
    const num = parseInt(ticketNumber.substring(1));
    const cleanDesk = deskNumber.replace(/([0-9]+)/, ' $1'); // Pisah angka biar dibaca "Loket Satu", bukan "Loket Sebelas" jika 11
    
    const text = `Nomor antrian ${prefix}, ${num}. Silakan menuju ${cleanDesk}.`;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'id-ID';
    
    // Cari suara Bahasa Indonesia
    const voices = window.speechSynthesis.getVoices();
    const idVoice = voices.find(v => v.lang.includes('id') || v.lang.includes('ID'));
    if (idVoice) utterance.voice = idVoice;
    
    utterance.onend = () => {
      resolve();
    };

    utterance.onerror = (e) => {
      console.error("Utterance error:", e);
      resolve(); // Pastikan antrian tetap berjalan meskipun TTS error
    };

    window.speechSynthesis.speak(utterance);
  });
}

// ==================== PREMIUM CANVAS PARTICLE VISUALIZER ====================

function initCanvasVisualizer() {
  const canvas = document.getElementById('visualizer-canvas');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  let animationFrameId;

  // Resize canvas sesuai panel pembungkus
  const resizeCanvas = () => {
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = rect.height;
  };
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  // Class Partikel
  class Particle {
    constructor() {
      this.reset();
    }

    reset() {
      this.x = Math.random() * canvas.width;
      this.y = Math.random() * canvas.height;
      this.size = Math.random() * 2 + 1;
      this.speedX = Math.random() * 0.4 - 0.2;
      this.speedY = Math.random() * 0.4 - 0.2;
      this.opacity = Math.random() * 0.5 + 0.1;
      this.life = Math.random() * 100 + 100;
    }

    update() {
      this.x += this.speedX;
      this.y += this.speedY;

      // Pantul pinggir
      if (this.x < 0 || this.x > canvas.width) this.speedX *= -1;
      if (this.y < 0 || this.y > canvas.height) this.speedY *= -1;
    }

    draw() {
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(99, 102, 241, ${this.opacity})`; // Indigo particles
      ctx.fill();
    }
  }

  // Inisialisasi Kumpulan Partikel
  const particleCount = 45;
  const particles = [];
  for (let i = 0; i < particleCount; i++) {
    particles.push(new Particle());
  }

  // Loop Animasi
  const animate = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    // Draw grid neon samar
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.02)';
    ctx.lineWidth = 1;
    const step = 40;
    for (let x = 0; x < canvas.width; x += step) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, canvas.height);
      ctx.stroke();
    }
    for (let y = 0; y < canvas.height; y += step) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(canvas.width, y);
      ctx.stroke();
    }

    // Draw partikel & garis hubung
    particles.forEach((p, index) => {
      p.update();
      p.draw();

      // Hubungkan garis antar partikel yang dekat
      for (let j = index + 1; j < particles.length; j++) {
        const other = particles[j];
        const dist = Math.hypot(p.x - other.x, p.y - other.y);
        if (dist < 100) {
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(other.x, other.y);
          ctx.strokeStyle = `rgba(99, 102, 241, ${0.1 * (1 - dist / 100)})`;
          ctx.stroke();
        }
      }
    });

    animationFrameId = requestAnimationFrame(animate);
  };

  animate();
}
