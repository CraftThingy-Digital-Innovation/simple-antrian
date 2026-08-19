let ws = null;
let currentMode = 'server';
let serverPort = 8080;
let announcementQueue = [];
let isAnnouncing = false;
let globalSettings = {};

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
    globalSettings = dbSettings;

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
    ws.send(JSON.stringify({ type: 'GET_SETTINGS' }));
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
      // Animasi kedip pada display utama
      triggerCallAnimation(payload.ticketNumber, payload.deskNumber);
      break;

    case 'RUNNING_TEXT_UPDATE':
      // Update teks berjalan secara langsung dari server
      try {
        const texts = JSON.parse(payload.texts);
        if (Array.isArray(texts) && texts.length > 0) {
          runningTexts = texts.filter(t => t && t.trim());
          currentTextIndex = 0;
          restartCycler();
        }
      } catch (_) {}
      break;

    case 'SETTINGS_RESPONSE':
      globalSettings = payload;
      break;

    case 'TTS_SETTING_UPDATE':
      if (globalSettings) {
        globalSettings.tts_enabled = payload.enabled;
      }
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

// ==================== CYCLING RUNNING TEXT ====================

// Daftar teks yang akan di-cycle
let runningTexts = [
  'Selamat Datang di Layanan Kami. Budayakan Mengantri dengan Tertib demi Kenyamanan Bersama. Terima kasih atas kerja sama Anda.',
  'Welcome to Our Service. Please Queue in an Orderly Manner for Everyone\'s Comfort. Thank you for your cooperation.',
  '欢迎光临我们的服务中心。请遵守秩序排队，共同维护良好环境。感谢您的配合。'
];
let currentTextIndex = 0;
let cyclerTimeout = null;

/**
 * Deteksi bahasa teks untuk label badge.
 * Deteksi sederhana: karakter CJK = ZH, lainnya heuristik.
 */
function detectLang(text) {
  if (/[\u4e00-\u9fff\u3400-\u4dbf]/.test(text)) return 'ZH';
  if (/[\u00C0-\u024F]/.test(text) && /\b(le|la|les|de|du|en|je|vous)\b/i.test(text)) return 'FR';
  if (/\b(the|and|please|thank|welcome|service|queue)\b/i.test(text)) return 'EN';
  if (/\b(di|dan|kami|antrian|terima|layanan|silakan|selamat)\b/i.test(text)) return 'ID';
  return 'MSG';
}

/**
 * Jalankan satu teks sebagai marquee, lalu cycle ke berikutnya.
 */
function runNextText() {
  if (!runningTexts || runningTexts.length === 0) return;

  const el = document.getElementById('running-text-content');
  const langBadge = document.getElementById('running-text-lang');
  const text = runningTexts[currentTextIndex];

  // Set teks dan bahasa
  el.innerText = text;
  const lang = detectLang(text);
  langBadge.innerText = lang;

  // Hitung durasi marquee proporsional dengan panjang teks
  // Asumsi: 60 karakter = 15 detik, minimum 12 detik
  const charCount = text.length;
  const durationSec = Math.max(12, Math.round(charCount * 0.22));
  el.style.setProperty('--marquee-dur', `${durationSec}s`);

  // Reset animasi agar teks mulai dari kanan lagi
  el.classList.remove('fade-out');
  el.style.animation = 'none';
  el.offsetHeight; // force reflow
  el.style.animation = '';

  // Setelah marquee selesai (+ 800ms buffer), cycle ke teks berikutnya
  cyclerTimeout = setTimeout(() => {
    // Fade out teks yang selesai
    el.classList.add('fade-out');

    setTimeout(() => {
      currentTextIndex = (currentTextIndex + 1) % runningTexts.length;
      runNextText();
    }, 700);
  }, (durationSec + 0.8) * 1000);
}

/**
 * Hentikan cycler yang sedang berjalan dan mulai ulang dari awal.
 */
function restartCycler() {
  if (cyclerTimeout) {
    clearTimeout(cyclerTimeout);
    cyclerTimeout = null;
  }
  currentTextIndex = 0;
  runNextText();
}

/**
 * Muat running texts dari database via IPC, lalu mulai cycling.
 */
async function loadAnnouncements() {
  try {
    const settings = await window.api.getSettings();

    // Parse running_texts (JSON array) atau fallback ke running_text lama
    if (settings.running_texts) {
      try {
        const parsed = JSON.parse(settings.running_texts);
        if (Array.isArray(parsed) && parsed.length > 0) {
          runningTexts = parsed.filter(t => t && t.trim());
        }
      } catch (_) {
        // Jika gagal parse, gunakan teks tunggal lama sebagai array
        if (settings.running_text) {
          runningTexts = [settings.running_text];
        }
      }
    } else if (settings.running_text) {
      runningTexts = [settings.running_text];
    }
  } catch (err) {
    console.error('[Display] Gagal load running texts:', err);
  }

  // Mulai cycling
  runNextText();
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

// Pengumuman Suara Text-To-Speech dalam 3 Bahasa (Indonesian, English, Chinese) secara Berurutan
async function playVoice(ticketNumber, deskNumber) {
  if (globalSettings && globalSettings.tts_enabled === 'false') {
    console.log('TTS is disabled, skipping playVoice');
    return;
  }

  const prefix = ticketNumber.charAt(0);
  const num = parseInt(ticketNumber.substring(1));

  // 1. Bahasa Indonesia
  const deskId = deskNumber.replace(/([0-9]+)/, ' $1');
  const textId = `Nomor antrian ${prefix}, ${num}. Silakan menuju ${deskId}.`;
  await speakText(textId, 'id-ID', 'id');

  await delay(300);

  // 2. English
  const deskEn = deskNumber.replace(/loket/i, 'counter').replace(/([0-9]+)/, ' $1');
  const textEn = `Queue number ${prefix}, ${num}. Please proceed to ${deskEn}.`;
  await speakText(textEn, 'en-US', 'en');

  await delay(300);

  // 3. Chinese (Mandarin)
  const deskZh = deskNumber
    .replace(/loket/i, '柜台')
    .replace(/customer\s*service/i, '客户服务')
    .replace(/teller/i, '出纳柜台')
    .replace(/([0-9]+)/, ' $1');
  const textZh = `排队号码 ${prefix}, ${num}。请前往 ${deskZh}。`;
  await speakText(textZh, 'zh-CN', 'zh');
}

function speakText(text, langCode, voiceSearchPattern) {
  return new Promise((resolve) => {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = langCode;

    // Cari suara spesifik jika tersedia di sistem
    const voices = window.speechSynthesis.getVoices();
    const voice = voices.find(v => v.lang.toLowerCase().includes(voiceSearchPattern.toLowerCase()));
    if (voice) {
      utterance.voice = voice;
    }

    utterance.onend = () => {
      resolve();
    };

    utterance.onerror = (e) => {
      console.error(`TTS Error (${langCode}):`, e);
      resolve(); // Pastikan tidak memblokir antrian jika salah satu bahasa error/tidak disupport
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
