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
      if (payload.videoSidebarMuted !== undefined) {
        videoSidebarMuted = payload.videoSidebarMuted;
      }
      if (payload.videoFullscreenMuted !== undefined) {
        videoFullscreenMuted = payload.videoFullscreenMuted;
      }
      if (typeof updateVideoPlaylist === 'function') {
        updateVideoPlaylist(payload.videoPlaylist);
      }
      if (typeof updateMirrorState === 'function') {
        updateMirrorState(payload.displayMode, payload.mirrorWindowName, payload.mirrorCropTop);
      }
      if (payload.colorTheme !== undefined) {
        document.body.className = payload.colorTheme === 'imigrasi' ? 'theme-imigrasi' : '';
      }
      break;

    case 'ANNOUNCE_CALL':
      // Tambahkan panggilan ke antrian suara untuk diputar berurutan
      queueAnnouncement(payload.ticketNumber, payload.deskNumber, payload.voiceFiles);
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
      applyDisplayCustomization(payload);
      if (payload.video_sidebar_muted !== undefined) {
        videoSidebarMuted = payload.video_sidebar_muted !== 'false';
      }
      if (payload.video_fullscreen_muted !== undefined) {
        videoFullscreenMuted = payload.video_fullscreen_muted === 'true';
      }
      if (typeof updateVideoPlaylist === 'function' && payload.video_playlist) {
        try {
          updateVideoPlaylist(JSON.parse(payload.video_playlist));
        } catch (_) {}
      }
      if (typeof updateMirrorState === 'function') {
        updateMirrorState(payload.display_mode || 'queue', payload.mirror_window_name || '', payload.mirror_crop_top === 'true');
      }
      if (payload.color_theme !== undefined) {
        document.body.className = payload.color_theme === 'imigrasi' ? 'theme-imigrasi' : '';
      }
      break;

    case 'VIDEO_PLAYLIST_UPDATE':
      if (typeof updateVideoPlaylist === 'function') {
        updateVideoPlaylist(payload.playlist);
      }
      break;

    case 'DISPLAY_CUSTOM_UPDATE':
      if (globalSettings) {
        globalSettings.display_title = payload.title;
        globalSettings.display_subtitle = payload.subtitle;
        globalSettings.display_logo = payload.logo;
        if (payload.theme) globalSettings.color_theme = payload.theme;
      }
      applyDisplayCustomization({
        display_title: payload.title,
        display_subtitle: payload.subtitle,
        display_logo: payload.logo
      });
      if (payload.theme !== undefined) {
        document.body.className = payload.theme === 'imigrasi' ? 'theme-imigrasi' : '';
      }
      break;

    case 'TTS_SETTING_UPDATE':
      if (globalSettings) {
        globalSettings.tts_enabled = payload.enabled;
      }
      break;
  }
}

// Terapkan penyesuaian tampilan Welcome Banner (Logo, Judul, Deskripsi)
function applyDisplayCustomization(settings) {
  if (!settings) return;
  const titleEl = document.getElementById('display-card-title');
  const textEl = document.getElementById('display-card-text');
  const logoContainer = document.getElementById('display-logo-container');
  const logoImg = document.getElementById('display-logo-img');

  if (titleEl) {
    titleEl.innerText = settings.display_title || 'SimpleAntrian';
  }
  if (textEl) {
    const textVal = settings.display_subtitle || 'Budayakan antri demi kenyamanan bersama. <br> Silakan siapkan tiket Anda dan perhatikan panggilan layar.';
    textEl.innerHTML = textVal.replace(/\n/g, '<br>');
  }
  if (logoContainer && logoImg) {
    if (settings.display_logo) {
      logoImg.src = settings.display_logo;
      logoContainer.style.display = 'flex';
    } else {
      logoContainer.style.display = 'none';
      logoImg.src = '';
    }
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
    
    // Perbarui teks jika berbeda (nomor tiket atau nomor loket berubah)
    if (mainNumberEl.innerText !== currentTicket.ticket_number || mainDeskEl.innerText !== currentTicket.desk_number || mainDisplayPanel.classList.contains('standby')) {
      mainDisplayPanel.classList.remove('standby');
      mainNumberEl.innerText = currentTicket.ticket_number;
      mainDeskEl.innerText = currentTicket.desk_number;
      mainDisplayPanel.classList.add('animate-call-blink');
      setTimeout(() => mainDisplayPanel.classList.remove('animate-call-blink'), 5000);
    }
  } else {
    // Tidak ada panggilan aktif, tampilkan default/standby
    mainDisplayPanel.classList.add('standby');
    mainNumberEl.innerText = '---';
    mainDeskEl.innerText = 'Belum ada antrian';
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
  const mainDisplayPanel = document.getElementById('main-display-panel');
  
  if (mainDisplayPanel) {
    mainDisplayPanel.classList.remove('standby');
  }

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

  // Hitung durasi marquee proporsional dengan panjang teks (dibuat lebih lambat)
  const charCount = text.length;
  const durationSec = Math.max(20, Math.round(charCount * 0.35));
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

function queueAnnouncement(ticketNumber, deskNumber, voiceFiles) {
  announcementQueue.push({ ticketNumber, deskNumber, voiceFiles });
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
  const { ticketNumber, deskNumber, voiceFiles } = announcementQueue.shift();

  try {
    // 1. Bunyikan Bel Ding-Dong
    await playDingDongChime();
    
    // Tunggu jeda singkat
    await delay(300);

    // 2. Putar Pengumuman Suara
    await playVoice(ticketNumber, deskNumber, voiceFiles);
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

      // Melodi Ding-Ding-Ding Elegan (Ascending Triad): C5 -> E5 -> G5
      playTone(523.25, 0, 0.4); 
      setTimeout(() => playTone(659.25, 0, 0.4), 200); 
      setTimeout(() => playTone(783.99, 0, 0.5), 400); 
      
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
async function playVoice(ticketNumber, deskNumber, voiceFiles) {
  if (globalSettings && globalSettings.tts_enabled === 'false') {
    console.log('TTS is disabled, skipping playVoice');
    return;
  }

  if (!voiceFiles || voiceFiles.length === 0) {
    console.warn('No voice files provided for announcement.');
    return;
  }

  try {
    const wsUrlObj = new URL(ws.url);
    const audioBaseUrl = `http://${wsUrlObj.host}/audio`;
    const urls = voiceFiles.map(file => `${audioBaseUrl}/${file}`);
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

// ==================== PLAYLIST VIDEO DISPLAY ====================
let videoPlaylist = [];
let currentVideoIndex = 0;
let currentDisplayMode = 'queue';
let videoSidebarMuted = true;
let videoFullscreenMuted = false;

function updateVideoPlaylist(newPlaylist) {
  const playlist = Array.isArray(newPlaylist) ? newPlaylist : [];
  const playlistJson = JSON.stringify(playlist);
  const currentJson = JSON.stringify(videoPlaylist);
  
  if (playlistJson !== currentJson) {
    videoPlaylist = playlist;
    currentVideoIndex = 0;
    syncVideoPlayers(currentDisplayMode);
  }
}

function syncVideoPlayers(displayMode) {
  if (displayMode) {
    currentDisplayMode = displayMode;
  }
  
  const sidebarCard = document.getElementById('video-card');
  const sidebarPlayer = document.getElementById('display-video-player');
  const fullscreenContainer = document.getElementById('video-fullscreen-container');
  const fullscreenPlayer = document.getElementById('fullscreen-video-player');
  const fullscreenPlaceholder = document.getElementById('fullscreen-video-placeholder');
  
  if (!sidebarPlayer || !fullscreenPlayer) return;
  
  // Jika playlist kosong, sembunyikan semua player
  if (videoPlaylist.length === 0) {
    if (sidebarCard) sidebarCard.style.display = 'none';
    if (fullscreenContainer) fullscreenContainer.style.display = 'none';
    sidebarPlayer.pause();
    sidebarPlayer.src = '';
    fullscreenPlayer.pause();
    fullscreenPlayer.src = '';
    return;
  }
  
  // Tentukan host berdasarkan lokasi WebSocket
  let host = window.location.host;
  if (window.location.protocol === 'file:') {
    const lastConnectedServer = localStorage.getItem('last_connected_server');
    if (lastConnectedServer) {
      host = lastConnectedServer;
    } else {
      host = 'localhost:8080';
    }
  }
  
  // Pastikan indeks video valid
  if (currentVideoIndex >= videoPlaylist.length) {
    currentVideoIndex = 0;
  }
  const video = videoPlaylist[currentVideoIndex];
  const videoUrl = `http://${host}${video.url}`;
  
  if (currentDisplayMode === 'video') {
    // Mode Video Fullscreen
    if (sidebarCard) sidebarCard.style.display = 'none';
    sidebarPlayer.pause();
    sidebarPlayer.src = '';
    
    if (fullscreenContainer) fullscreenContainer.style.display = 'flex';
    if (fullscreenPlaceholder) fullscreenPlaceholder.style.display = 'none';
    
    // Set status mute secara dinamis dari pengaturan
    fullscreenPlayer.muted = videoFullscreenMuted;
    
    // Play video jika belum memutar URL yang benar
    if (fullscreenPlayer.src !== videoUrl) {
      console.log(`[FullscreenPlayer] Playing video ${currentVideoIndex + 1}/${videoPlaylist.length}: ${videoUrl}`);
      fullscreenPlayer.src = videoUrl;
      fullscreenPlayer.load();
      
      const playPromise = fullscreenPlayer.play();
      if (playPromise !== undefined) {
        playPromise.catch(error => {
          console.warn("Failed to autoplay fullscreen video, skipping to next:", error);
          setTimeout(() => {
            currentVideoIndex++;
            syncVideoPlayers();
          }, 3000);
        });
      }
    }
  } else if (currentDisplayMode === 'queue') {
    // Mode Antrian Standar
    if (fullscreenContainer) fullscreenContainer.style.display = 'none';
    fullscreenPlayer.pause();
    fullscreenPlayer.src = '';
    
    if (sidebarCard) sidebarCard.style.display = 'block';
    
    // Set status mute secara dinamis dari pengaturan
    sidebarPlayer.muted = videoSidebarMuted;
    
    if (sidebarPlayer.src !== videoUrl) {
      console.log(`[SidebarPlayer] Playing video ${currentVideoIndex + 1}/${videoPlaylist.length}: ${videoUrl}`);
      sidebarPlayer.src = videoUrl;
      sidebarPlayer.load();
      
      const playPromise = sidebarPlayer.play();
      if (playPromise !== undefined) {
        playPromise.catch(error => {
          console.warn("Failed to autoplay sidebar video, skipping to next:", error);
          setTimeout(() => {
            currentVideoIndex++;
            syncVideoPlayers();
          }, 3000);
        });
      }
    }
  } else {
    // Mode Mirroring atau lainnya, pause semua
    if (sidebarCard) sidebarCard.style.display = 'none';
    if (fullscreenContainer) fullscreenContainer.style.display = 'none';
    sidebarPlayer.pause();
    sidebarPlayer.src = '';
    fullscreenPlayer.pause();
    fullscreenPlayer.src = '';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const sidebarPlayer = document.getElementById('display-video-player');
  const fullscreenPlayer = document.getElementById('fullscreen-video-player');
  
  if (sidebarPlayer) {
    sidebarPlayer.addEventListener('ended', () => {
      currentVideoIndex++;
      syncVideoPlayers();
    });
    sidebarPlayer.addEventListener('error', (e) => {
      console.error("[SidebarPlayer] Error loading video file, skipping...", e);
      setTimeout(() => {
        currentVideoIndex++;
        syncVideoPlayers();
      }, 3000);
    });
  }
  
  if (fullscreenPlayer) {
    fullscreenPlayer.addEventListener('ended', () => {
      currentVideoIndex++;
      syncVideoPlayers();
    });
    fullscreenPlayer.addEventListener('error', (e) => {
      console.error("[FullscreenPlayer] Error loading video file, skipping...", e);
      setTimeout(() => {
        currentVideoIndex++;
        syncVideoPlayers();
      }, 3000);
    });
  }
  
  // Start the footer clock
  startClock();
});

// Clock widget helper
function startClock() {
  const timeEl = document.getElementById('footer-time');
  const dateEl = document.getElementById('footer-date');
  if (!timeEl || !dateEl) return;
  
  const days = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
  const months = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
  
  function update() {
    const now = new Date();
    
    // Format Time: HH:mm:ss
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    timeEl.innerText = `${hours}:${minutes}:${seconds}`;
    
    // Format Date: Hari, DD Bulan YYYY
    const dayName = days[now.getDay()];
    const date = now.getDate();
    const monthName = months[now.getMonth()];
    const year = now.getFullYear();
    dateEl.innerText = `${dayName}, ${date} ${monthName} ${year}`;
  }
  
  update();
  setInterval(update, 1000);
}

// ==================== DUPLIKASI LAYAR (WINDOW MIRRORING) ====================
let mirrorStream = null;
let activeMirrorWindowName = '';

async function updateMirrorState(displayMode, windowName, mirrorCropTop) {
  // Sinkronkan pemutar video berdasarkan display mode yang aktif
  if (typeof syncVideoPlayers === 'function') {
    syncVideoPlayers(displayMode);
  }

  const container = document.getElementById('mirror-container');
  const video = document.getElementById('mirror-video-player');
  const placeholder = document.getElementById('mirror-placeholder');
  const placeholderTitle = document.getElementById('mirror-placeholder-title');
  const placeholderDesc = document.getElementById('mirror-placeholder-desc');
  
  if (!container || !video) return;
  
  // Terapkan efek potong atas jika diaktifkan
  if (mirrorCropTop) {
    video.classList.add('crop-browser');
  } else {
    video.classList.remove('crop-browser');
  }
  
  if (displayMode !== 'mirror') {
    // Sembunyikan mirror dan hentikan stream jika ada
    container.style.display = 'none';
    stopMirrorStream();
    activeMirrorWindowName = '';
    return;
  }
  
  // Tampilkan mirror container
  container.style.display = 'flex';
  
  if (!windowName) {
    stopMirrorStream();
    placeholder.style.display = 'flex';
    placeholderTitle.innerText = 'Menunggu Jendela Terpilih';
    placeholderDesc.innerText = 'Silakan pilih jendela aplikasi di Operator Panel.';
    activeMirrorWindowName = '';
    return;
  }
  
  // Jika jendela terpilih berubah atau belum terhubung, hubungkan!
  if (activeMirrorWindowName !== windowName) {
    stopMirrorStream();
    activeMirrorWindowName = windowName;
    
    placeholder.style.display = 'flex';
    placeholderTitle.innerText = 'Mencari Jendela...';
    placeholderDesc.innerText = `Menghubungkan ke: "${windowName}"`;
    
    await tryConnectMirrorStream(windowName);
  }
}

async function tryConnectMirrorStream(windowName) {
  const video = document.getElementById('mirror-video-player');
  const placeholder = document.getElementById('mirror-placeholder');
  const placeholderTitle = document.getElementById('mirror-placeholder-title');
  const placeholderDesc = document.getElementById('mirror-placeholder-desc');
  
  try {
    const sourceId = await window.api.findWindowIdByName(windowName);
    if (!sourceId) {
      placeholder.style.display = 'flex';
      placeholderTitle.innerText = 'Aplikasi Tidak Aktif';
      placeholderDesc.innerText = `Harap buka aplikasi/jendela "${windowName}" di PC ini.`;
      
      // Jadwalkan pengecekan ulang setiap 3 detik sampai ketemu
      setTimeout(() => {
        if (activeMirrorWindowName === windowName && (!mirrorStream || !mirrorStream.active)) {
          tryConnectMirrorStream(windowName);
        }
      }, 3000);
      return;
    }
    
    // Capture stream
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId,
          minWidth: 1280,
          maxWidth: 1920,
          minHeight: 720,
          maxHeight: 1080
        }
      }
    });
    
    mirrorStream = stream;
    video.srcObject = stream;
    
    // Mute video to prevent audio feedback
    video.muted = true;
    
    video.play();
    
    // Sembunyikan placeholder setelah video aktif
    placeholder.style.display = 'none';
    console.log(`[Mirror] Berhasil menduplikasi jendela: ${windowName}`);
    
    // Deteksi jika stream mati (misal jendela ditutup)
    stream.getVideoTracks()[0].onended = () => {
      console.warn("[Mirror] Jendela ditutup oleh pengguna.");
      stopMirrorStream();
      tryConnectMirrorStream(windowName); // Coba cari kembali
    };
  } catch (err) {
    console.error("[Mirror] Gagal menghubungkan stream:", err);
    placeholder.style.display = 'flex';
    placeholderTitle.innerText = 'Koneksi Gagal';
    placeholderDesc.innerText = `Error: ${err.message}`;
  }
}

function stopMirrorStream() {
  const video = document.getElementById('mirror-video-player');
  if (video) {
    video.srcObject = null;
  }
  if (mirrorStream) {
    try {
      mirrorStream.getTracks().forEach(track => track.stop());
    } catch (_) {}
    mirrorStream = null;
  }
}
