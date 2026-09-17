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

let currentWsUrl = '';
let reconnectTimer = null;

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
      // Mode Client: Coba endpoint dari DB, lalu localStorage, lalu default
      const activeEndpoint = dbSettings.active_server_endpoint || localStorage.getItem('last_connected_server') || `localhost:${serverPort}`;
      connectWebSocket(`ws://${activeEndpoint}`);

      // Dengarkan penemuan server via UDP Discovery
      window.api.onServersUpdated((servers) => {
        if (servers && servers.length > 0) {
          const srv = servers[0];
          const srvEndpoint = `${srv.ip}:${srv.port}`;
          if (!ws || ws.readyState !== WebSocket.OPEN) {
            console.log(`[Display UDP] Menghubungkan otomatis ke server terdeteksi: ${srvEndpoint}`);
            connectWebSocket(`ws://${srvEndpoint}`);
          }
        }
      });
    }

    // Dengarkan perubahan endpoint server dari Operator Panel secara realtime
    window.api.onServerEndpointChanged((newEndpoint) => {
      console.log(`[Display] Server endpoint diubah oleh operator menjadi: ${newEndpoint}`);
      connectWebSocket(`ws://${newEndpoint}`);
    });
  } catch (err) {
    console.error('Failed to init display connection:', err);
    setTimeout(initDisplayConnection, 5000);
  }
}

// Hubungkan ke WebSocket
function connectWebSocket(url) {
  currentWsUrl = url;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (ws) {
    // Matikan event listener lama agar tidak memicu reconnect ganda saat sengaja ditutup
    ws.onclose = null;
    ws.onerror = null;
    try { ws.close(); } catch (_) {}
  }

  console.log(`Display connecting to ${url}`);
  ws = new WebSocket(url);

  ws.onopen = () => {
    console.log(`Display WebSocket connected to ${url}!`);
    // Request data awal
    ws.send(JSON.stringify({ type: 'GET_STATE' }));
    ws.send(JSON.stringify({ type: 'GET_SETTINGS' }));
  };

  ws.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data);
      if (message.type === 'PING') {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'PONG' }));
        }
        return;
      }
      handleWebSocketMessage(message);
    } catch (err) {
      console.error('Error parsing display WS message:', err);
    }
  };

  ws.onclose = () => {
    console.log(`Display WebSocket closed (${currentWsUrl}). Reconnecting in 3 seconds...`);
    if (!reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectWebSocket(currentWsUrl);
      }, 3000);
    }
  };

  ws.onerror = (err) => {
    console.error('Display WebSocket error:', err);
    try { ws.close(); } catch (_) {}
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
      if (payload.displayLayout !== undefined) {
        applyDisplayLayout(payload.displayLayout);
      }
      if (payload.feedbackSurveyUrl !== undefined || payload.feedbackDisplayMode !== undefined) {
        renderFeedbackSurvey(payload);
      }
      if (payload.displayTitle !== undefined || payload.displayLogo !== undefined) {
        applyDisplayCustomization({
          display_title: payload.displayTitle,
          display_subtitle: payload.displaySubtitle,
          display_logo: payload.displayLogo
        });
      }
      if (payload.photoDuration !== undefined) {
        photoDurationSetting = parseInt(payload.photoDuration, 10) || 10;
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
      if (payload.display_layout !== undefined) {
        applyDisplayLayout(payload.display_layout);
      }
      if (payload.photo_duration !== undefined) {
        photoDurationSetting = parseInt(payload.photo_duration, 10) || 10;
      }
      break;

    case 'VIDEO_PLAYLIST_UPDATE':
      if (typeof updateVideoPlaylist === 'function') {
        updateVideoPlaylist(payload.playlist);
      }
      if (payload.photoDuration !== undefined) {
        photoDurationSetting = parseInt(payload.photoDuration, 10) || 10;
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
      if (payload.layout !== undefined) {
        applyDisplayLayout(payload.layout);
      }
      if (payload.theme !== undefined) {
        document.body.className = payload.theme === 'imigrasi' ? 'theme-imigrasi' : '';
      }
      if (payload.feedbackSurveyUrl !== undefined) {
        renderFeedbackSurvey({
          feedbackSurveyUrl: payload.feedbackSurveyUrl,
          feedbackDisplayMode: payload.feedbackDisplayMode
        });
      }
      break;

    case 'TTS_SETTING_UPDATE':
      if (globalSettings) {
        globalSettings.tts_enabled = payload.enabled;
      }
      break;

    case 'STOP_ANNOUNCEMENT':
      stopAnnouncement();
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

// Render Banner Survei Kepuasan Pelanggan (IKM)
function renderFeedbackSurvey(state) {
  const bar = document.getElementById('feedback-survey-bar');
  const qrWrapper = document.getElementById('feedback-qr-wrapper');
  const qrImg = document.getElementById('feedback-qr-img');
  const urlWrapper = document.getElementById('feedback-url-wrapper');
  const urlText = document.getElementById('feedback-url-text');
  if (!bar) return;

  const url = (state && (state.feedbackSurveyUrl || state.feedback_survey_url)) ? String(state.feedbackSurveyUrl || state.feedback_survey_url).trim() : '';
  const mode = (state && (state.feedbackDisplayMode || state.feedback_display_mode)) || 'both';
  const qrData = state && state.feedbackQrDataUrl ? state.feedbackQrDataUrl : '';

  // Tersembunyi secara default dan atau jika tidak ada teks link website yang disediakan
  if (!url) {
    bar.style.display = 'none';
    return;
  }

  bar.style.display = 'flex';

  // Tampilkan QR Code jika mode 'both' atau 'qr'
  if ((mode === 'both' || mode === 'qr') && qrData) {
    if (qrImg) qrImg.src = qrData;
    if (qrWrapper) qrWrapper.style.display = 'flex';
  } else {
    if (qrWrapper) qrWrapper.style.display = 'none';
  }

  // Tampilkan Link Website jika mode 'both' atau 'url'
  if (mode === 'both' || mode === 'url') {
    if (urlText) urlText.innerText = url;
    if (urlWrapper) urlWrapper.style.display = 'flex';
  } else {
    if (urlWrapper) urlWrapper.style.display = 'none';
  }
}

// Render State Antrian di Layar Display
function renderDisplayState(state) {
  const { services, callingTickets } = state;
  try {
    renderFeedbackSurvey(state);
  } catch (err) {
    console.error('Error rendering feedback survey:', err);
  }

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

let currentDisplayAudio = null;
let isDisplayAnnouncing = false;

function stopAnnouncement() {
  console.log('[Display] Menghentikan panggilan suara pengumuman.');
  announcementQueue = [];
  isAnnouncing = false;
  isDisplayAnnouncing = false;

  if (currentDisplayAudio) {
    try {
      currentDisplayAudio.pause();
      currentDisplayAudio.currentTime = 0;
      currentDisplayAudio.src = '';
    } catch (_) {}
    currentDisplayAudio = null;
  }

  // Cancel Web Speech API jika ada
  if (window.speechSynthesis) {
    try {
      window.speechSynthesis.cancel();
    } catch (_) {}
  }

  // Hentikan kedip animasi jika sedang berkedip
  const mainDisplayPanel = document.getElementById('main-display-panel');
  if (mainDisplayPanel) {
    mainDisplayPanel.classList.remove('animate-call-blink');
  }
  const numberEl = document.getElementById('lbl-call-number');
  const deskEl = document.getElementById('lbl-call-desk');
  if (numberEl) numberEl.classList.remove('scale-up');
  if (deskEl) deskEl.classList.remove('scale-up');
}

// Handler klik tombol stop di layar display
function handleDisplayStopAudio() {
  stopAnnouncement();
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'STOP_ANNOUNCEMENT' }));
  }
}

window.stopAnnouncement = stopAnnouncement;
window.handleDisplayStopAudio = handleDisplayStopAudio;

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
    
    if (!isAnnouncing) return;

    // Tunggu jeda singkat
    await delay(300);

    if (!isAnnouncing) return;

    // 2. Putar Pengumuman Suara
    await playVoice(ticketNumber, deskNumber, voiceFiles);
  } catch (err) {
    console.error('Announcement playback error:', err);
  }

  if (!isAnnouncing) return;

  // Jeda antar pengumuman
  await delay(1000);

  if (!isAnnouncing) return;
  processNextAnnouncement();
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Generate WAV Chime secara dinamis di memori untuk bypass proteksi autoplay Web Audio API
function generateChimeWavBlob() {
  const sampleRate = 11025;
  const duration = 1.0; // 1 detik total
  const numSamples = Math.floor(sampleRate * duration);
  const buffer = new Uint8Array(44 + numSamples);
  
  // WAV Header (44 bytes)
  buffer[0] = 0x52; buffer[1] = 0x49; buffer[2] = 0x46; buffer[3] = 0x46; // "RIFF"
  const size = 36 + numSamples;
  buffer[4] = size & 0xff;
  buffer[5] = (size >> 8) & 0xff;
  buffer[6] = (size >> 16) & 0xff;
  buffer[7] = (size >> 24) & 0xff;
  buffer[8] = 0x57; buffer[9] = 0x41; buffer[10] = 0x56; buffer[11] = 0x45; // "WAVE"
  buffer[12] = 0x66; buffer[13] = 0x6d; buffer[14] = 0x74; buffer[15] = 0x20; // "fmt "
  buffer[16] = 16; buffer[17] = 0; buffer[18] = 0; buffer[19] = 0;
  buffer[20] = 1; buffer[21] = 0;
  buffer[22] = 1; buffer[23] = 0;
  buffer[24] = sampleRate & 0xff;
  buffer[25] = (sampleRate >> 8) & 0xff;
  buffer[26] = (sampleRate >> 16) & 0xff;
  buffer[27] = (sampleRate >> 24) & 0xff;
  buffer[28] = sampleRate & 0xff;
  buffer[29] = (sampleRate >> 8) & 0xff;
  buffer[30] = (sampleRate >> 16) & 0xff;
  buffer[31] = (sampleRate >> 24) & 0xff;
  buffer[32] = 1; buffer[33] = 0;
  buffer[34] = 8; buffer[35] = 0;
  buffer[36] = 0x64; buffer[37] = 0x61; buffer[38] = 0x74; buffer[39] = 0x61; // "data"
  buffer[40] = numSamples & 0xff;
  buffer[41] = (numSamples >> 8) & 0xff;
  buffer[42] = (numSamples >> 16) & 0xff;
  buffer[43] = (numSamples >> 24) & 0xff;
  
  // Nada bel: C5 (523.25 Hz), E5 (659.25 Hz), G5 (783.99 Hz)
  const fC5 = 523.25;
  const fE5 = 659.25;
  const fG5 = 783.99;
  
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    let signal = 0;
    
    // Nada 1: C5 (mulai 0.0s, durasi 0.4s)
    if (t >= 0 && t < 0.4) {
      const amp = 0.3 * Math.exp(-6 * t);
      signal += amp * Math.sin(2 * Math.PI * fC5 * t);
    }
    // Nada 2: E5 (mulai 0.2s, durasi 0.4s)
    if (t >= 0.2 && t < 0.6) {
      const amp = 0.3 * Math.exp(-6 * (t - 0.2));
      signal += amp * Math.sin(2 * Math.PI * fE5 * (t - 0.2));
    }
    // Nada 3: G5 (mulai 0.4s, durasi 0.5s)
    if (t >= 0.4 && t < 0.9) {
      const amp = 0.35 * Math.exp(-5 * (t - 0.4));
      signal += amp * Math.sin(2 * Math.PI * fG5 * (t - 0.4));
    }
    
    signal = Math.max(-1.0, Math.min(1.0, signal));
    buffer[44 + i] = Math.floor((signal + 1.0) * 127.5);
  }
  
  return new Blob([buffer], { type: 'audio/wav' });
}

// Ding-Dong Chime menggunakan HTML5 Audio (Bypass autoplay block)
function playDingDongChime() {
  return new Promise((resolve) => {
    if (!isAnnouncing) {
      resolve();
      return;
    }
    try {
      const wavBlob = generateChimeWavBlob();
      const blobUrl = URL.createObjectURL(wavBlob);
      const audio = new Audio(blobUrl);
      currentDisplayAudio = audio;
      
      const cleanup = () => {
        if (currentDisplayAudio === audio) currentDisplayAudio = null;
        URL.revokeObjectURL(blobUrl);
        resolve();
      };

      audio.onended = cleanup;
      
      audio.onerror = (err) => {
        console.error('HTML5 Chime playback failed:', err);
        cleanup();
      };
      
      audio.play().catch(err => {
        console.error('HTML5 Chime autoplay error:', err);
        cleanup();
      });
    } catch (e) {
      resolve();
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
    let host = 'localhost:8080';
    if (ws && ws.url) {
      try {
        const wsUrlObj = new URL(ws.url);
        host = wsUrlObj.host;
      } catch (_) {}
    } else if (currentWsUrl) {
      try {
        const wsUrlObj = new URL(currentWsUrl);
        host = wsUrlObj.host;
      } catch (_) {}
    }
    const audioBaseUrl = `http://${host}/audio`;
    const urls = voiceFiles.map(file => `${audioBaseUrl}/${file}`);
    await playAudioSequence(urls);
  } catch (err) {
    console.error('Offline TTS playback failed:', err);
  }
}

function playAudioSequence(urls) {
  return new Promise((resolve) => {
    if (!urls || urls.length === 0 || !isAnnouncing) {
      resolve();
      return;
    }
    
    isDisplayAnnouncing = true;
    let index = 0;
    const audio = new Audio();
    currentDisplayAudio = audio;
    
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
      if (!isAnnouncing || !isDisplayAnnouncing || index >= urls.length) {
        if (currentDisplayAudio === audio) currentDisplayAudio = null;
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

  const ctx = canvas.getContext('2d', { alpha: true });
  let animationFrameId;

  // Resize canvas sesuai panel pembungkus
  const resizeCanvas = () => {
    if (!canvas.parentElement) return;
    const rect = canvas.parentElement.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      canvas.width = rect.width;
      canvas.height = rect.height;
    }
  };
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  // Class Partikel Ringan
  class Particle {
    constructor() {
      this.reset();
    }

    reset() {
      this.x = Math.random() * (canvas.width || 800);
      this.y = Math.random() * (canvas.height || 600);
      this.size = Math.random() * 1.5 + 1;
      this.speedX = Math.random() * 0.3 - 0.15;
      this.speedY = Math.random() * 0.3 - 0.15;
      this.opacity = Math.random() * 0.4 + 0.1;
    }

    update() {
      this.x += this.speedX;
      this.y += this.speedY;

      if (this.x < 0 || this.x > canvas.width) this.speedX *= -1;
      if (this.y < 0 || this.y > canvas.height) this.speedY *= -1;
    }

    draw() {
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(99, 102, 241, ${this.opacity})`;
      ctx.fill();
    }
  }

  // Cukup 18 partikel ringan agar CPU/GPU video decoding tetap maksimal
  const particleCount = 18;
  const particles = [];
  for (let i = 0; i < particleCount; i++) {
    particles.push(new Particle());
  }

  // Loop Animasi Efisien
  let lastFrameTime = 0;
  const targetFpsInterval = 1000 / 30; // 30 FPS untuk background ambient sudah sangat mulus & hemat daya

  const animate = (timestamp) => {
    animationFrameId = requestAnimationFrame(animate);

    // Jangan buang daya jika mode video fullscreen sedang aktif
    if (currentDisplayMode === 'video') return;

    if (timestamp - lastFrameTime < targetFpsInterval) return;
    lastFrameTime = timestamp;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Draw partikel & garis hubung (menggunakan jarak kuadrat tanpa Math.hypot berat)
    const maxDistSq = 90 * 90;
    particles.forEach((p, index) => {
      p.update();
      p.draw();

      for (let j = index + 1; j < particles.length; j++) {
        const other = particles[j];
        const dx = p.x - other.x;
        const dy = p.y - other.y;
        const distSq = dx * dx + dy * dy;
        if (distSq < maxDistSq) {
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(other.x, other.y);
          const ratio = 1 - (distSq / maxDistSq);
          ctx.strokeStyle = `rgba(99, 102, 241, ${0.12 * ratio})`;
          ctx.stroke();
        }
      }
    });
  };

  requestAnimationFrame(animate);
}

// ==================== PLAYLIST MEDIA DISPLAY (VIDEO & FOTO) ====================
let isLocalServer = false;
let serverPort = '8080';

if (typeof window !== 'undefined' && window.api && window.api.getSystemInfo) {
  window.api.getSystemInfo().then(info => {
    if (info && info.mode === 'server') {
      isLocalServer = true;
      serverPort = info.port || '8080';
      console.log('[Display] Running on Server machine -> using ultra-fast 127.0.0.1 loopback for media streaming.');
    }
  }).catch(() => {});
}

let videoPlaylist = [];
let currentMediaIndex = 0;
let currentActiveMediaUrl = '';
let currentDisplayMode = 'queue';
let videoSidebarMuted = true;
let videoFullscreenMuted = false;
let photoDurationSetting = 10;
let displayLayoutSetting = 'standard';
let mediaAdvanceTimer = null;

function clearMediaTimer() {
  if (mediaAdvanceTimer) {
    clearTimeout(mediaAdvanceTimer);
    mediaAdvanceTimer = null;
  }
}

function isImageMedia(item) {
  if (!item) return false;
  if (item.type === 'image') return true;
  const target = item.url || item.filename || item.name || '';
  return /\.(jpe?g|png|gif|webp|bmp|svg|avif)$/i.test(target);
}

function updateVideoPlaylist(newPlaylist) {
  const playlist = Array.isArray(newPlaylist) ? newPlaylist : [];
  const playlistJson = JSON.stringify(playlist);
  const currentJson = JSON.stringify(videoPlaylist);
  
  if (playlistJson !== currentJson) {
    videoPlaylist = playlist;
    currentMediaIndex = 0;
    currentActiveMediaUrl = '';
    clearMediaTimer();
    syncVideoPlayers(currentDisplayMode);
  }
}

function applyDisplayLayout(layout) {
  displayLayoutSetting = (layout === 'swapped') ? 'swapped' : 'standard';
  const contentArea = document.getElementById('content-area');
  const primarySlot = document.getElementById('primary-slot');
  const sidebarSlot = document.getElementById('sidebar-swappable-slot');
  const mainCallPanel = document.getElementById('main-display-panel');
  const videoCard = document.getElementById('video-card');

  if (!primarySlot || !sidebarSlot || !mainCallPanel || !videoCard) return;

  if (displayLayoutSetting === 'swapped') {
    if (contentArea) contentArea.classList.add('layout-swapped');
    mainCallPanel.classList.add('compact');
    videoCard.classList.add('primary-video');

    // Pindahkan video card ke slot utama (kiri)
    if (primarySlot.firstElementChild !== videoCard) {
      primarySlot.appendChild(videoCard);
    }
    // Pindahkan nomor antrian ke slot sidebar (kanan)
    if (sidebarSlot.firstElementChild !== mainCallPanel) {
      sidebarSlot.appendChild(mainCallPanel);
    }
  } else {
    if (contentArea) contentArea.classList.remove('layout-swapped');
    mainCallPanel.classList.remove('compact');
    videoCard.classList.remove('primary-video');

    // Pindahkan nomor antrian ke slot utama (kiri)
    if (primarySlot.firstElementChild !== mainCallPanel) {
      primarySlot.appendChild(mainCallPanel);
    }
    // Pindahkan video card ke slot sidebar (kanan)
    if (sidebarSlot.firstElementChild !== videoCard) {
      sidebarSlot.appendChild(videoCard);
    }
  }

  // Banner Logo & Nama Instansi (.media-card) SELALU TETAP TAMPIL DI SIDEBAR!
  syncVideoPlayers();
  window.dispatchEvent(new Event('resize'));
}

function advanceMedia(isError = false) {
  clearMediaTimer();
  if (videoPlaylist.length <= 1 && !isError) {
    if (videoPlaylist.length === 1 && isImageMedia(videoPlaylist[0])) {
      const durationMs = Math.max(3, photoDurationSetting) * 1000;
      mediaAdvanceTimer = setTimeout(() => advanceMedia(false), durationMs);
    }
    return;
  }
  
  if (videoPlaylist.length > 0) {
    currentMediaIndex = (currentMediaIndex + 1) % videoPlaylist.length;
  } else {
    currentMediaIndex = 0;
  }
  currentActiveMediaUrl = '';
  syncVideoPlayers();
}

function syncVideoPlayers(displayMode) {
  if (displayMode) {
    currentDisplayMode = displayMode;
  }
  
  const videoCard = document.getElementById('video-card');
  const emptyPlaceholder = document.getElementById('video-card-empty-placeholder');
  const sidebarPlayer = document.getElementById('display-video-player');
  const sidebarImage = document.getElementById('display-image-player');
  
  const fullscreenContainer = document.getElementById('video-fullscreen-container');
  const fullscreenPlayer = document.getElementById('fullscreen-video-player');
  const fullscreenImage = document.getElementById('fullscreen-image-player');
  const fullscreenPlaceholder = document.getElementById('fullscreen-video-placeholder');
  
  if (!sidebarPlayer || !fullscreenPlayer) return;
  
  // Jika playlist kosong, bersihkan media player
  if (videoPlaylist.length === 0) {
    clearMediaTimer();
    currentActiveMediaUrl = '';
    
    // Banner Logo/Instansi (.media-card) tidak pernah disentuh agar tetap tampil!
    if (displayLayoutSetting === 'swapped') {
      if (videoCard) videoCard.style.display = 'flex';
      if (emptyPlaceholder) emptyPlaceholder.style.display = 'flex';
    } else {
      if (videoCard) videoCard.style.display = 'none';
      if (emptyPlaceholder) emptyPlaceholder.style.display = 'none';
    }
    
    sidebarPlayer.pause();
    sidebarPlayer.removeAttribute('src');
    sidebarPlayer.load();
    sidebarPlayer.style.display = 'none';
    if (sidebarImage) {
      sidebarImage.style.display = 'none';
      sidebarImage.removeAttribute('src');
    }
    
    fullscreenPlayer.pause();
    fullscreenPlayer.removeAttribute('src');
    fullscreenPlayer.load();
    fullscreenPlayer.style.display = 'none';
    if (fullscreenImage) {
      fullscreenImage.style.display = 'none';
      fullscreenImage.removeAttribute('src');
    }
    
    if (currentDisplayMode === 'video') {
      if (fullscreenContainer) fullscreenContainer.style.display = 'flex';
      if (fullscreenPlaceholder) fullscreenPlaceholder.style.display = 'flex';
    } else {
      if (fullscreenContainer) fullscreenContainer.style.display = 'none';
    }
    return;
  }
  
  if (emptyPlaceholder) emptyPlaceholder.style.display = 'none';
  
  // Tentukan host berdasarkan lokasi server (127.0.0.1 jika di server agar bebas lag/stutter)
  let host = window.location.host;
  if (isLocalServer) {
    host = '127.0.0.1:' + serverPort;
  } else if (window.location.protocol === 'file:') {
    const lastConnectedServer = localStorage.getItem('last_connected_server');
    if (lastConnectedServer) {
      host = lastConnectedServer;
    } else {
      host = '127.0.0.1:8080';
    }
  }
  
  // Pastikan indeks media valid
  if (currentMediaIndex >= videoPlaylist.length || currentMediaIndex < 0) {
    currentMediaIndex = 0;
  }
  
  const currentItem = videoPlaylist[currentMediaIndex];
  let rawUrl = currentItem.url || '';
  let mediaUrl = rawUrl;
  if (!mediaUrl.startsWith('http://') && !mediaUrl.startsWith('https://')) {
    mediaUrl = 'http://' + host + rawUrl;
  }
  
  const isImg = isImageMedia(currentItem);
  
  if (currentDisplayMode === 'video') {
    // Mode Video Fullscreen Dedicated
    if (videoCard) videoCard.style.display = 'none';
    sidebarPlayer.pause();
    sidebarPlayer.style.display = 'none';
    if (sidebarImage) sidebarImage.style.display = 'none';
    
    if (fullscreenContainer) fullscreenContainer.style.display = 'flex';
    if (fullscreenPlaceholder) fullscreenPlaceholder.style.display = 'none';
    
    if (isImg) {
      // Tampilkan Foto Fullscreen
      fullscreenPlayer.pause();
      fullscreenPlayer.style.display = 'none';
      if (fullscreenImage) {
        fullscreenImage.style.display = 'block';
        if (currentActiveMediaUrl !== mediaUrl || fullscreenImage.src !== mediaUrl) {
          currentActiveMediaUrl = mediaUrl;
          fullscreenImage.src = mediaUrl;
          clearMediaTimer();
          const durationMs = Math.max(3, photoDurationSetting) * 1000;
          mediaAdvanceTimer = setTimeout(() => advanceMedia(false), durationMs);
        }
      }
    } else {
      // Tampilkan Video Fullscreen
      if (fullscreenImage) {
        fullscreenImage.style.display = 'none';
        fullscreenImage.removeAttribute('src');
      }
      fullscreenPlayer.style.display = 'block';
      fullscreenPlayer.playbackRate = 1.0;
      fullscreenPlayer.loop = (videoPlaylist.length === 1);
      fullscreenPlayer.muted = videoFullscreenMuted;
      
      if (currentActiveMediaUrl !== mediaUrl) {
        currentActiveMediaUrl = mediaUrl;
        clearMediaTimer();
        fullscreenPlayer.src = mediaUrl;
        fullscreenPlayer.load();
        
        const playPromise = fullscreenPlayer.play();
        if (playPromise !== undefined) {
          playPromise.catch(error => {
            if (error.name === 'AbortError') return;
            if (error.name === 'NotAllowedError') {
              fullscreenPlayer.muted = true;
              fullscreenPlayer.play().catch(() => {});
              return;
            }
            console.warn("[FullscreenPlayer] Autoplay failed, advancing in 3s:", error);
            clearMediaTimer();
            mediaAdvanceTimer = setTimeout(() => advanceMedia(true), 3000);
          });
        }
      }
    }
  } else if (currentDisplayMode === 'queue') {
    // Mode Antrian Standar / Swapped
    if (fullscreenContainer) fullscreenContainer.style.display = 'none';
    fullscreenPlayer.pause();
    fullscreenPlayer.style.display = 'none';
    if (fullscreenImage) fullscreenImage.style.display = 'none';
    
    // Tampilkan video card (di sidebar jika standar, atau di kiri jika swapped)
    if (videoCard) videoCard.style.display = 'flex';
    
    if (isImg) {
      // Tampilkan Foto di Card Media
      sidebarPlayer.pause();
      sidebarPlayer.style.display = 'none';
      if (sidebarImage) {
        sidebarImage.style.display = 'block';
        if (currentActiveMediaUrl !== mediaUrl || sidebarImage.src !== mediaUrl) {
          currentActiveMediaUrl = mediaUrl;
          sidebarImage.src = mediaUrl;
          clearMediaTimer();
          const durationMs = Math.max(3, photoDurationSetting) * 1000;
          mediaAdvanceTimer = setTimeout(() => advanceMedia(false), durationMs);
        }
      }
    } else {
      // Tampilkan Video di Card Media
      if (sidebarImage) {
        sidebarImage.style.display = 'none';
        sidebarImage.removeAttribute('src');
      }
      sidebarPlayer.style.display = 'block';
      sidebarPlayer.playbackRate = 1.0;
      sidebarPlayer.loop = (videoPlaylist.length === 1);
      sidebarPlayer.muted = videoSidebarMuted;
      
      if (currentActiveMediaUrl !== mediaUrl) {
        currentActiveMediaUrl = mediaUrl;
        clearMediaTimer();
        sidebarPlayer.src = mediaUrl;
        sidebarPlayer.load();
        
        const playPromise = sidebarPlayer.play();
        if (playPromise !== undefined) {
          playPromise.catch(error => {
            if (error.name === 'AbortError') return;
            if (error.name === 'NotAllowedError') {
              sidebarPlayer.muted = true;
              sidebarPlayer.play().catch(() => {});
              return;
            }
            console.warn("[SidebarPlayer] Autoplay failed, advancing in 3s:", error);
            clearMediaTimer();
            mediaAdvanceTimer = setTimeout(() => advanceMedia(true), 3000);
          });
        }
      }
    }
  } else {
    // Mode Mirroring atau lainnya, sembunyikan semua
    clearMediaTimer();
    currentActiveMediaUrl = '';
    if (videoCard) videoCard.style.display = 'none';
    if (fullscreenContainer) fullscreenContainer.style.display = 'none';
    sidebarPlayer.pause();
    sidebarPlayer.style.display = 'none';
    if (sidebarImage) sidebarImage.style.display = 'none';
    fullscreenPlayer.pause();
    fullscreenPlayer.style.display = 'none';
    if (fullscreenImage) fullscreenImage.style.display = 'none';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const sidebarPlayer = document.getElementById('display-video-player');
  const fullscreenPlayer = document.getElementById('fullscreen-video-player');
  const sidebarImage = document.getElementById('display-image-player');
  const fullscreenImage = document.getElementById('fullscreen-image-player');
  
  if (sidebarPlayer) {
    sidebarPlayer.addEventListener('ended', () => {
      if (!sidebarPlayer.loop) {
        advanceMedia(false);
      }
    });
    sidebarPlayer.addEventListener('error', (e) => {
      console.error("[SidebarPlayer] Error loading video file, advancing...", e);
      clearMediaTimer();
      mediaAdvanceTimer = setTimeout(() => advanceMedia(true), 3000);
    });
  }
  
  if (fullscreenPlayer) {
    fullscreenPlayer.addEventListener('ended', () => {
      if (!fullscreenPlayer.loop) {
        advanceMedia(false);
      }
    });
    fullscreenPlayer.addEventListener('error', (e) => {
      console.error("[FullscreenPlayer] Error loading video file, advancing...", e);
      clearMediaTimer();
      mediaAdvanceTimer = setTimeout(() => advanceMedia(true), 3000);
    });
  }

  if (sidebarImage) {
    sidebarImage.addEventListener('error', (e) => {
      console.error("[SidebarImage] Error loading image file, advancing in 2s...", e);
      clearMediaTimer();
      mediaAdvanceTimer = setTimeout(() => advanceMedia(true), 2000);
    });
  }

  if (fullscreenImage) {
    fullscreenImage.addEventListener('error', (e) => {
      console.error("[FullscreenImage] Error loading image file, advancing in 2s...", e);
      clearMediaTimer();
      mediaAdvanceTimer = setTimeout(() => advanceMedia(true), 2000);
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
