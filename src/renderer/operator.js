// State Global
let ws = null;
let currentMode = 'server';
let serverIp = 'localhost';
let serverPort = 8080;
let servicesList = [];
let localDeskSettings = {}; // Menyimpan nomor loket per layanan, misal: { teller: 'Loket 1' }
let activeTickets = {}; // Menyimpan ID tiket aktif saat ini per layanan untuk pelacakan dinamis
let currentTxId = '';
let currentLogoBase64 = '';
let ttsBannerTimeout = null;
let hourlyChartInstance = null;
let statusChartInstance = null;

function generateTxId() {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

// Custom Asynchronous HTML Confirm Dialog to prevent Electron focus locks
function confirmDialog(message) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.style.zIndex = '9999';
    
    const content = document.createElement('div');
    content.className = 'glass-panel modal-content animate-pop-in';
    content.style.maxWidth = '420px';
    content.style.textAlign = 'center';
    content.style.padding = '24px';
    
    const title = document.createElement('h3');
    title.innerText = 'Konfirmasi';
    title.style.fontSize = '1.3rem';
    title.style.fontWeight = '800';
    title.style.marginBottom = '12px';
    title.style.color = 'var(--text-primary)';
    
    const text = document.createElement('p');
    text.innerText = message;
    text.style.fontSize = '0.95rem';
    text.style.lineHeight = '1.5';
    text.style.color = 'var(--text-secondary)';
    text.style.marginBottom = '24px';
    
    const actions = document.createElement('div');
    actions.style.display = 'flex';
    actions.style.gap = '12px';
    actions.style.justifyContent = 'center';
    
    const btnCancel = document.createElement('button');
    btnCancel.className = 'btn btn-secondary';
    btnCancel.innerText = 'Batal';
    btnCancel.style.flex = '1';
    btnCancel.style.padding = '10px 20px';
    
    const btnOk = document.createElement('button');
    btnOk.className = 'btn btn-danger';
    btnOk.innerText = 'Ya, Lanjutkan';
    btnOk.style.flex = '1';
    btnOk.style.padding = '10px 20px';
    
    actions.appendChild(btnCancel);
    actions.appendChild(btnOk);
    content.appendChild(title);
    content.appendChild(text);
    content.appendChild(actions);
    overlay.appendChild(content);
    document.body.appendChild(overlay);
    
    // Trigger CSS transition
    overlay.offsetHeight;
    overlay.classList.add('active');
    
    const cleanup = (value) => {
      overlay.classList.remove('active');
      setTimeout(() => {
        overlay.remove();
        if (document.activeElement) {
          document.activeElement.blur();
        }
      }, 300);
      resolve(value);
    };
    
    btnCancel.onclick = () => cleanup(false);
    btnOk.onclick = () => cleanup(true);
    
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        window.removeEventListener('keydown', handleKeyDown);
        cleanup(false);
      } else if (e.key === 'Enter') {
        window.removeEventListener('keydown', handleKeyDown);
        cleanup(true);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
  });
}

// Callbacks map untuk menampung Promise resolve dari request WebSocket (Client Mode)
const wsRequestCallbacks = {};

async function getSettingsData() {
  if (currentMode === 'client') {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return await window.api.getSettings().catch(() => ({}));
    }
    return new Promise((resolve) => {
      const timer = setTimeout(async () => {
        delete wsRequestCallbacks['SETTINGS_RESPONSE'];
        const fallback = await window.api.getSettings().catch(() => ({}));
        resolve(fallback || {});
      }, 1500);
      wsRequestCallbacks['SETTINGS_RESPONSE'] = (data) => {
        clearTimeout(timer);
        resolve(data || {});
      };
      sendAction('GET_SETTINGS');
    });
  } else {
    return await window.api.getSettings();
  }
}

async function getServicesData() {
  if (currentMode === 'client') {
    return servicesList || [];
  } else {
    return await window.api.getServices();
  }
}

async function getDailyStatsData(dateStr) {
  if (currentMode === 'client') {
    return new Promise((resolve) => {
      wsRequestCallbacks['STATS_RESPONSE'] = resolve;
      sendAction('GET_STATS', { dateStr });
    });
  } else {
    return await window.api.getDailyStats(dateStr);
  }
}

async function searchTicketsData(query, status, serviceId, dateStr) {
  if (currentMode === 'client') {
    return new Promise((resolve) => {
      wsRequestCallbacks['SEARCH_RESPONSE'] = resolve;
      sendAction('SEARCH_TICKETS', { query, status, serviceId, dateStr });
    });
  } else {
    return await window.api.searchTickets(query, status, serviceId, dateStr);
  }
}

// Inisialisasi Halaman
document.addEventListener('DOMContentLoaded', async () => {
  // Load nomor loket yang tersimpan di localStorage
  const savedDesks = localStorage.getItem('local_desk_settings');
  if (savedDesks) {
    try { localDeskSettings = JSON.parse(savedDesks); } catch (_) { console.warn('[Operator] Corrupt local_desk_settings in localStorage, resetting.'); localStorage.removeItem('local_desk_settings'); }
  }

  // Setup tab navigation
  setupTabs();
  
  // Ambil info sistem dan inisialisasi koneksi
  await initSystemInfo();

  
  if (window.api && typeof window.api.onServerPortUpdated === 'function') {
    window.api.onServerPortUpdated((newPort) => {
      serverPort = newPort;
      const portInput = document.getElementById('setting-port');
      if (portInput) portInput.value = newPort;
      if (currentMode === 'server') {
        connectWebSocket(`ws://127.0.0.1:${newPort}`);
      }
    });
  }

  // Setup event listeners
  setupEventListeners();

  // Load awal list window untuk mirroring
  loadMirrorSources();

  // Load daftar printer untuk Quick Ticket
  if (typeof loadOperatorPrinters === "function") {
    loadOperatorPrinters();
  }

  // Load awal tab statistik dengan tanggal hari ini
  const today = new Date().toLocaleDateString('sv-SE');
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
        loadRunningTexts(); // refresh running texts setiap kali tab settings dibuka
        loadVideoPlaylist(); // refresh video playlist setiap kali tab settings dibuka
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
    
    // Tampilkan versi aplikasi & hubungkan listener pembaruan GitHub
    document.getElementById('lbl-app-version').innerText = `v${info.appVersion}`;
    document.getElementById('lbl-settings-version').innerText = `v${info.appVersion}`;

    const lastSeenVersion = localStorage.getItem('last_seen_app_version');
    if (lastSeenVersion && lastSeenVersion !== info.appVersion) {
      document.getElementById('lbl-app-version').innerHTML = `v${info.appVersion} <span style="color: var(--accent-success); font-size: 0.8rem; margin-left: 8px;">(Sukses Diperbarui)</span>`;
      document.getElementById('lbl-settings-version').innerHTML = `v${info.appVersion} <span style="color: var(--accent-success); font-size: 0.8rem; margin-left: 8px;">(Terbaru)</span>`;
      setTimeout(() => {
        showToast(`🎉 Selamat! Aplikasi berhasil diperbarui ke versi v${info.appVersion} secara otomatis!`, 'success');
      }, 2000);
    }
    localStorage.setItem('last_seen_app_version', info.appVersion);
    // Floating Update Progress Modal variables & helpers
    let updateProgressModal = null;

    function showUpdateProgressModal(version) {
      if (updateProgressModal) {
        updateProgressModal.remove();
      }
      
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.style.zIndex = '10000';
      
      const content = document.createElement('div');
      content.className = 'glass-panel modal-content animate-pop-in';
      content.style.maxWidth = '400px';
      content.style.textAlign = 'center';
      content.style.padding = '28px';
      
      const title = document.createElement('h3');
      title.innerText = `Memperbarui Aplikasi ke v${version}`;
      title.style.fontSize = '1.2rem';
      title.style.fontWeight = '800';
      title.style.marginBottom = '16px';
      title.style.color = 'var(--text-primary)';
      
      const statusText = document.createElement('div');
      statusText.id = 'modal-update-status';
      statusText.innerText = 'Menghubungkan ke server...';
      statusText.style.fontSize = '0.9rem';
      statusText.style.color = 'var(--text-secondary)';
      statusText.style.marginBottom = '8px';
      
      const progressRow = document.createElement('div');
      progressRow.style.display = 'flex';
      progressRow.style.justifyContent = 'space-between';
      progressRow.style.fontSize = '0.75rem';
      progressRow.style.color = 'var(--text-muted)';
      progressRow.style.marginBottom = '8px';
      
      const percentText = document.createElement('span');
      percentText.id = 'modal-update-percent';
      percentText.innerText = '0%';
      
      const barContainer = document.createElement('div');
      barContainer.style.width = '100%';
      barContainer.style.height = '8px';
      barContainer.style.background = 'rgba(255,255,255,0.08)';
      barContainer.style.borderRadius = '4px';
      barContainer.style.overflow = 'hidden';
      barContainer.style.border = '1px solid var(--border-glass)';
      
      const bar = document.createElement('div');
      bar.id = 'modal-update-bar';
      bar.style.width = '0%';
      bar.style.height = '100%';
      bar.style.background = 'var(--accent-success-gradient)';
      bar.style.transition = 'width 0.1s ease';
      
      barContainer.appendChild(bar);
      content.appendChild(title);
      content.appendChild(statusText);
      progressRow.appendChild(document.createTextNode('Progres'));
      progressRow.appendChild(percentText);
      content.appendChild(progressRow);
      content.appendChild(barContainer);
      overlay.appendChild(content);
      document.body.appendChild(overlay);
      
      updateProgressModal = overlay;
    }

    function hideUpdateProgressModal() {
      if (updateProgressModal) {
        updateProgressModal.remove();
        updateProgressModal = null;
      }
    }

    let updateAvailableModal = null;

    async function startAutoUpdate(downloadUrl, latestVersion) {
      // Tampilkan modal progres pembaruan melayang
      showUpdateProgressModal(latestVersion);
      
      const btnDownload = document.getElementById('btn-download-update');
      const btnAutoUpdate = document.getElementById('btn-auto-update');
      if (btnDownload) btnDownload.style.display = 'none';
      if (btnAutoUpdate) btnAutoUpdate.style.display = 'none';
      const progressContainer = document.getElementById('update-progress-container');
      if (progressContainer) progressContainer.style.display = 'block';
      
      try {
        const res = await window.api.performAppUpdate(downloadUrl);
        hideUpdateProgressModal();
        if (!res.success) {
          showToast(`Pembaruan gagal: ${res.message}`, 'error');
          if (btnDownload) btnDownload.style.display = 'inline-flex';
          if (btnAutoUpdate) btnAutoUpdate.style.display = 'inline-flex';
          if (progressContainer) progressContainer.style.display = 'none';
        }
      } catch (err) {
        hideUpdateProgressModal();
        showToast(`Pembaruan gagal: ${err.message}`, 'error');
        if (btnDownload) btnDownload.style.display = 'inline-flex';
        if (btnAutoUpdate) btnAutoUpdate.style.display = 'inline-flex';
        if (progressContainer) progressContainer.style.display = 'none';
      }
    }

    // Modal khusus pemberitahuan pembaruan aplikasi
    window.showUpdateAvailableModal = function(updateInfo) {
      if (updateAvailableModal) {
        updateAvailableModal.remove();
        updateAvailableModal = null;
      }

      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.style.zIndex = '9999';

      const content = document.createElement('div');
      content.className = 'glass-panel modal-content animate-pop-in';
      content.style.maxWidth = '520px';
      content.style.width = '92%';
      content.style.textAlign = 'left';
      content.style.padding = '28px';

      // Header
      const header = document.createElement('div');
      header.style.display = 'flex';
      header.style.justifyContent = 'space-between';
      header.style.alignItems = 'center';
      header.style.marginBottom = '18px';

      const titleGroup = document.createElement('div');
      titleGroup.style.display = 'flex';
      titleGroup.style.alignItems = 'center';
      titleGroup.style.gap = '12px';

      const icon = document.createElement('span');
      icon.innerText = '🚀';
      icon.style.fontSize = '2.2rem';

      const titleTexts = document.createElement('div');
      const title = document.createElement('h3');
      title.innerText = 'Pembaruan Aplikasi Tersedia!';
      title.style.fontSize = '1.25rem';
      title.style.fontWeight = '800';
      title.style.color = 'var(--text-primary)';
      title.style.margin = '0';

      const subtitle = document.createElement('div');
      subtitle.innerText = 'SimpleAntrian versi baru telah dirilis di GitHub';
      subtitle.style.fontSize = '0.82rem';
      subtitle.style.color = 'var(--text-muted)';
      subtitle.style.marginTop = '2px';

      titleTexts.appendChild(title);
      titleTexts.appendChild(subtitle);
      titleGroup.appendChild(icon);
      titleGroup.appendChild(titleTexts);

      const btnClose = document.createElement('button');
      btnClose.innerText = '✕';
      btnClose.style.background = 'none';
      btnClose.style.border = 'none';
      btnClose.style.color = 'var(--text-muted)';
      btnClose.style.fontSize = '1.2rem';
      btnClose.style.cursor = 'pointer';
      btnClose.style.padding = '4px 8px';

      header.appendChild(titleGroup);
      header.appendChild(btnClose);

      // Version Comparison Box
      const versionBox = document.createElement('div');
      versionBox.style.display = 'flex';
      versionBox.style.alignItems = 'center';
      versionBox.style.justifyContent = 'space-around';
      versionBox.style.background = 'rgba(0, 0, 0, 0.25)';
      versionBox.style.border = '1px solid var(--border-glass)';
      versionBox.style.borderRadius = '12px';
      versionBox.style.padding = '14px 16px';
      versionBox.style.marginBottom = '18px';

      versionBox.innerHTML = `
        <div style="text-align: center;">
          <div style="font-size: 0.72rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px;">Versi Saat Ini</div>
          <div style="font-weight: 700; font-size: 1.05rem; color: var(--text-secondary); margin-top: 2px;">v${escapeHtml(updateInfo.current || '1.0.0')}</div>
        </div>
        <div style="font-size: 1.4rem; color: var(--accent-primary); font-weight: bold;">➔</div>
        <div style="text-align: center;">
          <div style="font-size: 0.72rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px;">Versi Terbaru</div>
          <div style="font-weight: 800; font-size: 1.15rem; color: var(--accent-success); margin-top: 2px;">
            v${escapeHtml(updateInfo.latest)} <span class="badge badge-completed" style="font-size: 0.65rem; padding: 2px 6px;">Tersedia</span>
          </div>
        </div>
      `;

      // Changelog area
      const changelogContainer = document.createElement('div');
      changelogContainer.style.marginBottom = '22px';

      const changelogTitle = document.createElement('div');
      changelogTitle.innerText = 'Catatan Pembaruan (Changelog):';
      changelogTitle.style.fontSize = '0.85rem';
      changelogTitle.style.fontWeight = '700';
      changelogTitle.style.color = 'var(--text-secondary)';
      changelogTitle.style.marginBottom = '8px';

      const changelogBox = document.createElement('div');
      changelogBox.style.maxHeight = '180px';
      changelogBox.style.overflowY = 'auto';
      changelogBox.style.background = 'rgba(0, 0, 0, 0.2)';
      changelogBox.style.border = '1px solid var(--border-glass)';
      changelogBox.style.borderRadius = '10px';
      changelogBox.style.padding = '12px 16px';
      changelogBox.style.fontSize = '0.82rem';
      changelogBox.style.color = 'var(--text-muted)';
      changelogBox.style.lineHeight = '1.6';

      let bodyFormatted = '<div>• Peningkatan performa, stabilitas, dan fitur terbaru.</div>';
      if (updateInfo.body && updateInfo.body.trim()) {
        const rawLines = updateInfo.body.split('\n');
        const bulletItems = [];
        for (let l of rawLines) {
          l = l.trim();
          if (l.startsWith('* ') || l.startsWith('- ')) {
            bulletItems.push(`<li>${escapeHtml(l.replace(/^[\*\-]\s*/, ''))}</li>`);
          } else if (l.startsWith('## ') || l.startsWith('### ')) {
            bulletItems.push(`<div style="font-weight: 700; color: var(--text-primary); margin-top: 8px; margin-bottom: 2px;">${escapeHtml(l.replace(/^#+\s*/, ''))}</div>`);
          }
        }
        if (bulletItems.length > 0) {
          bodyFormatted = `<ul style="margin: 0; padding-left: 18px;">${bulletItems.join('')}</ul>`;
        } else {
          bodyFormatted = `<div style="white-space: pre-wrap;">${escapeHtml(updateInfo.body.substring(0, 600))}</div>`;
        }
      }
      changelogBox.innerHTML = bodyFormatted;

      changelogContainer.appendChild(changelogTitle);
      changelogContainer.appendChild(changelogBox);

      // Actions
      const actions = document.createElement('div');
      actions.style.display = 'flex';
      actions.style.gap = '10px';
      actions.style.justifyContent = 'flex-end';
      actions.style.alignItems = 'center';

      const btnDismiss = document.createElement('button');
      btnDismiss.className = 'btn btn-secondary';
      btnDismiss.innerText = 'Nanti Saja';
      btnDismiss.style.padding = '10px 18px';

      const btnGithub = document.createElement('button');
      btnGithub.className = 'btn btn-secondary';
      btnGithub.innerText = '🌐 Buka GitHub';
      btnGithub.style.padding = '10px 18px';

      const btnInstall = document.createElement('button');
      btnInstall.className = 'btn btn-primary';
      btnInstall.style.background = 'var(--accent-success-gradient)';
      btnInstall.style.boxShadow = '0 0 15px rgba(16, 185, 129, 0.35)';
      btnInstall.style.fontWeight = '700';
      btnInstall.style.padding = '10px 22px';
      btnInstall.innerText = '⬇️ Pasang Pembaruan';

      actions.appendChild(btnDismiss);
      actions.appendChild(btnGithub);
      if (updateInfo.downloadUrl) {
        actions.appendChild(btnInstall);
      }

      content.appendChild(header);
      content.appendChild(versionBox);
      content.appendChild(changelogContainer);
      content.appendChild(actions);
      overlay.appendChild(content);
      document.body.appendChild(overlay);

      overlay.offsetHeight;
      overlay.classList.add('active');

      const cleanup = () => {
        overlay.classList.remove('active');
        setTimeout(() => {
          overlay.remove();
          if (updateAvailableModal === overlay) updateAvailableModal = null;
        }, 300);
      };

      btnClose.onclick = cleanup;
      btnDismiss.onclick = cleanup;
      btnGithub.onclick = () => {
        cleanup();
        window.api.openExternalUrl(updateInfo.url);
      };
      btnInstall.onclick = () => {
        cleanup();
        startAutoUpdate(updateInfo.downloadUrl, updateInfo.latest);
      };

      updateAvailableModal = overlay;
    };

    window.api.onAppUpdateAvailable(async (updateInfo) => {
      const banner = document.getElementById('app-update-banner');
      const lblNew = document.getElementById('lbl-new-app-version');
      const btnDownload = document.getElementById('btn-download-update');
      const btnAutoUpdate = document.getElementById('btn-auto-update');
      
      if (lblNew) lblNew.innerText = `v${updateInfo.latest}`;
      if (banner) banner.style.display = 'block';
      
      if (btnDownload) {
        btnDownload.onclick = () => {
          window.api.openExternalUrl(updateInfo.url);
        };
      }

      if (updateInfo.downloadUrl && btnAutoUpdate) {
        btnAutoUpdate.style.display = 'inline-flex';
        btnAutoUpdate.onclick = () => {
          startAutoUpdate(updateInfo.downloadUrl, updateInfo.latest);
        };
      }

      // Hubungkan listener progres pembaruan
      window.api.onUpdateProgress((info) => {
        // 1. Update modal overlay jika sedang aktif
        const mStatus = document.getElementById('modal-update-status');
        const mPercent = document.getElementById('modal-update-percent');
        const mBar = document.getElementById('modal-update-bar');
        
        let statusText = 'Mempersiapkan...';
        if (info.status === 'downloading') {
          statusText = `Mengunduh berkas pembaruan (${info.percent}%)...`;
        } else if (info.status === 'extracting') {
          statusText = 'Mengekstrak berkas pembaruan...';
        } else if (info.status === 'installing') {
          statusText = 'Memasang pembaruan & memuat ulang...';
        }
        
        if (mStatus) mStatus.innerText = statusText;
        if (mPercent) mPercent.innerText = `${info.percent}%`;
        if (mBar) mBar.style.width = `${info.percent}%`;

        // 2. Update status & progress bar di dalam tab Pengaturan (fallback/banner)
        const statusEl = document.getElementById('update-progress-status');
        const percentEl = document.getElementById('update-progress-percent');
        const barEl = document.getElementById('update-progress-bar');
        
        if (statusEl && percentEl && barEl) {
          statusEl.innerText = statusText;
          percentEl.innerText = `${info.percent}%`;
          barEl.style.width = `${info.percent}%`;
        }
      });

      // Tampilkan toast notifikasi
      showToast(`🚀 Pembaruan aplikasi tersedia: v${updateInfo.latest}!`, 'info');

      // Tampilkan Modal Pembaruan Otomatis
      setTimeout(() => {
        window.showUpdateAvailableModal(updateInfo);
      }, 800);
    });
    
    // Tampilkan mode di UI
    const badgeMode = document.getElementById('badge-mode');
    if (badgeMode) {
      badgeMode.innerText = currentMode === 'server' ? 'Server Mode' : 'Client Mode';
      badgeMode.className = `badge ${currentMode === 'server' ? 'badge-waiting' : 'badge-completed'}`;
    }

    const badgeModeConfig = document.getElementById('badge-mode-config');
    if (badgeModeConfig) {
      badgeModeConfig.innerText = currentMode === 'server' ? 'Server Mode' : 'Client Mode';
      badgeModeConfig.className = `badge ${currentMode === 'server' ? 'badge-waiting' : 'badge-completed'}`;
    }

    const clientConnBadge = document.getElementById('client-conn-badge');
    if (clientConnBadge) {
      clientConnBadge.innerText = currentMode === 'server' ? 'Mode Server (Host)' : 'Mode Client';
      clientConnBadge.className = `badge ${currentMode === 'server' ? 'badge-waiting' : 'badge-completed'}`;
    }

    const localIpDisplay = document.getElementById('lbl-local-ip-display');
    if (localIpDisplay) {
      localIpDisplay.value = info.localIp || '127.0.0.1';
    }

    const hintServerIpPort = document.getElementById('hint-server-ip-port');
    if (hintServerIpPort) {
      hintServerIpPort.innerText = `${info.localIp}:${serverPort}`;
    }

    const settings = await window.api.getSettings();
    const serverName = (settings && settings.server_name) || info.serverName || 'Server Antrian';

    const srvCardName = document.getElementById('srv-card-name');
    if (srvCardName) srvCardName.innerText = serverName;

    const srvCardAddr = document.getElementById('srv-card-addr');
    if (srvCardAddr) srvCardAddr.innerText = `${info.localIp}:${serverPort}`;

    if (currentMode === 'server') {
      document.getElementById('network-status-title').innerText = 'Server Aktif (Lokal)';
      document.getElementById('status-text').innerText = `${info.localIp}:${serverPort}`;
      document.getElementById('status-dot').style.background = 'var(--accent-success)';
      
      // Update local server name display
      const lbl = document.getElementById('status-server-name');
      const val = document.getElementById('status-server-name-val');
      if (lbl && val) {
        val.innerText = serverName;
        lbl.style.display = 'block';
      }
      
      // Sembunyikan/Tampilkan menu pengaturan yang relevan
      const serverGroup = document.getElementById('settings-server-group');
      if (serverGroup) serverGroup.style.display = 'flex';
      const clientInfoGroup = document.getElementById('settings-client-info-group');
      if (clientInfoGroup) clientInfoGroup.style.display = 'none';
      const serverBroadcastInfo = document.getElementById('server-mode-broadcast-info');
      if (serverBroadcastInfo) serverBroadcastInfo.style.display = 'flex';
      const clientConnPanel = document.getElementById('client-mode-connection-panel');
      if (clientConnPanel) clientConnPanel.style.display = 'none';
      const servicesConfig = document.getElementById('section-services-config');
      if (servicesConfig) servicesConfig.style.display = 'block';
      const dbConfig = document.getElementById('section-db-config');
      if (dbConfig) dbConfig.style.display = 'block';
      
      // Connect ke WebSocket lokal
      connectWebSocket(`ws://127.0.0.1:${serverPort}`);
    } else {
      document.getElementById('network-status-title').innerText = 'Koneksi Server';
      document.getElementById('status-text').innerText = 'Mencari server...';
      document.getElementById('status-dot').style.background = 'var(--accent-warning)';
      
      const serverGroup = document.getElementById('settings-server-group');
      if (serverGroup) serverGroup.style.display = 'none';
      const clientInfoGroup = document.getElementById('settings-client-info-group');
      if (clientInfoGroup) clientInfoGroup.style.display = 'flex';
      const serverBroadcastInfo = document.getElementById('server-mode-broadcast-info');
      if (serverBroadcastInfo) serverBroadcastInfo.style.display = 'none';
      const clientConnPanel = document.getElementById('client-mode-connection-panel');
      if (clientConnPanel) clientConnPanel.style.display = 'flex';
      const servicesConfig = document.getElementById('section-services-config');
      if (servicesConfig) servicesConfig.style.display = 'none';
      const dbConfig = document.getElementById('section-db-config');
      if (dbConfig) dbConfig.style.display = 'none';

      // Load server terakhir yang disimpan jika ada
      const lastConnectedServer = settings.active_server_endpoint || localStorage.getItem('last_connected_server');
      if (lastConnectedServer) {
        document.getElementById('status-text').innerText = `Menghubungkan ke ${lastConnectedServer}...`;
        const activeEpEl = document.getElementById('client-active-server-endpoint');
        if (activeEpEl) activeEpEl.innerText = lastConnectedServer;
        connectWebSocket(`ws://${lastConnectedServer}`);
      }

      // Mulai mendengarkan daftar server dari UDP Discovery
      window.api.onServersUpdated((servers) => {
        renderDiscoveredServers(servers);
      });
    }
  } catch (err) {
    showToast('Gagal memuat informasi sistem: ' + err.message, 'error');
  }
}

let currentConnectedEndpoint = '';
let currentConnectedServerName = '';

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Render server yang ditemukan di jaringan lokal (UDP)
function renderDiscoveredServers(servers) {
  const container = document.getElementById('discovered-servers-list');
  if (!container) return;

  if (!servers || servers.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; color: var(--text-muted); padding: 20px 12px; background: rgba(0,0,0,0.15); border-radius: 10px; border: 1px dashed var(--border-glass);">
        <div style="font-size: 1.4rem; margin-bottom: 6px;">🔍</div>
        <div style="font-weight: 600; color: var(--text-secondary);">Mencari server di jaringan lokal (UDP)...</div>
        <div style="font-size: 0.78rem; color: var(--text-muted); margin-top: 4px;">Pastikan PC Server menyala pada Wi-Fi/LAN yang sama atau gunakan Hubungkan Manual di bawah.</div>
      </div>
    `;
    return;
  }

  container.innerHTML = '';
  servers.forEach(srv => {
    const srvIpPort = `${srv.ip}:${srv.port}`;
    const isConnected = currentConnectedEndpoint && (
      currentConnectedEndpoint === srvIpPort ||
      (srv.rinfoAddress && currentConnectedEndpoint === `${srv.rinfoAddress}:${srv.port}`)
    );

    const div = document.createElement('div');
    div.className = `server-list-item animate-pop-in ${isConnected ? 'active-connected' : ''}`;
    const methodBadge = srv.method === 'http'
      ? '<span class="badge" style="background: rgba(14, 165, 233, 0.2); color: #38bdf8; font-size: 0.68rem; padding: 2px 7px; margin-left: 6px;">🌐 HTTP/Router</span>'
      : '<span class="badge badge-waiting" style="font-size: 0.68rem; padding: 2px 7px; margin-left: 6px;">📡 UDP</span>';

    div.innerHTML = `
      <div>
        <div class="server-info-title">
          <span>🖥️</span> <strong>${escapeHtml(srv.name || 'Server Antrian')}</strong>
          ${methodBadge}
          ${isConnected ? '<span class="badge badge-completed" style="font-size: 0.7rem; padding: 2px 8px; margin-left: 6px;">✓ Terhubung</span>' : ''}
        </div>
        <div class="server-info-ip">${escapeHtml(srvIpPort)}</div>
      </div>
      <div>
        ${isConnected
          ? '<span style="color: var(--accent-success); font-size: 0.85rem; font-weight: 700; margin-right: 6px;">● Aktif</span>'
          : `<button class="btn btn-primary btn-sm" onclick="connectToRemoteServer('${srvIpPort}', '${escapeHtml(srv.name || '')}')" style="font-weight: 600; padding: 5px 14px;">⚡ Hubungkan</button>`
        }
      </div>
    `;
    container.appendChild(div);
  });
}

// Hubungkan ke server remote (Client Mode)
window.connectToRemoteServer = async function(ipPort, serverName = '') {
  if (!ipPort) return;
  ipPort = ipPort.trim().replace(/^ws:\/\//, '');

  localStorage.setItem('last_connected_server', ipPort);
  try {
    await window.api.saveSetting('active_server_endpoint', ipPort);
    await window.api.setActiveServerEndpoint(ipPort);
  } catch (_) {}

  currentConnectedEndpoint = ipPort;
  if (serverName) currentConnectedServerName = serverName;

  const displayName = currentConnectedServerName ? `${currentConnectedServerName} (${ipPort})` : ipPort;
  document.getElementById('status-text').innerText = `${ipPort}`;
  document.getElementById('status-dot').style.background = 'var(--accent-warning)';

  const activeNameEl = document.getElementById('client-active-server-name');
  if (activeNameEl) activeNameEl.innerText = `Menghubungkan ke ${currentConnectedServerName || 'Server'}...`;

  const activeEpEl = document.getElementById('client-active-server-endpoint');
  if (activeEpEl) activeEpEl.innerText = ipPort;

  const activeDotEl = document.getElementById('client-active-dot');
  if (activeDotEl) activeDotEl.style.background = 'var(--accent-warning)';

  showToast(`Menghubungkan ke server ${displayName}...`, 'info');
  connectWebSocket(`ws://${ipPort}`);
};

let currentOperatorWsUrl = '';
let operatorReconnectTimer = null;

// Inisialisasi Koneksi WebSocket
function connectWebSocket(url) {
  if (url && typeof url === 'string') {
    url = url.replace('ws://localhost:', 'ws://127.0.0.1:');
  }
  currentOperatorWsUrl = url;
  if (operatorReconnectTimer) {
    clearTimeout(operatorReconnectTimer);
    operatorReconnectTimer = null;
  }

  if (ws) {
    ws.onclose = null;
    ws.onerror = null;
    try { ws.close(); } catch (_) {}
  }

  showToast(`Menghubungkan ke WebSocket ${url}...`, 'info');
  ws = new WebSocket(url);

  ws.onopen = () => {
    showToast('Koneksi WebSocket berhasil terhubung!', 'success');
    document.getElementById('status-dot').style.background = 'var(--accent-success)';
    
    const displayUrl = url.replace('ws://', '').replace('localhost', 'Server');
    document.getElementById('status-text').innerText = displayUrl;
    currentConnectedEndpoint = url.replace('ws://', '');

    const activeDotEl = document.getElementById('client-active-dot');
    if (activeDotEl) activeDotEl.style.background = 'var(--accent-success)';

    const activeNameEl = document.getElementById('client-active-server-name');
    if (activeNameEl) {
      activeNameEl.innerText = currentConnectedServerName || 'Server Terhubung';
    }

    const activeEpEl = document.getElementById('client-active-server-endpoint');
    if (activeEpEl) activeEpEl.innerText = currentConnectedEndpoint;

    // Refresh server list highlighting
    const container = document.getElementById('discovered-servers-list');
    if (container) {
      const items = container.querySelectorAll('.server-list-item');
      items.forEach(item => {
        const ipEl = item.querySelector('.server-info-ip');
        if (ipEl && ipEl.innerText.trim() === currentConnectedEndpoint) {
          item.classList.add('active-connected');
        } else {
          item.classList.remove('active-connected');
        }
      });
    }

    // Minta data state awal
    sendAction('GET_STATE');
    
    // Sync desk names for local TTS pre-generation
    sendAction('SYNC_DESK_NAMES', { deskNames: Object.values(localDeskSettings) });
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
      console.error('Error parsing WS message:', err);
    }
  };

  ws.onclose = () => {
    document.getElementById('status-dot').style.background = 'var(--accent-secondary)';
    document.getElementById('status-text').innerText = 'Terputus';

    const activeDotEl = document.getElementById('client-active-dot');
    if (activeDotEl) activeDotEl.style.background = 'var(--accent-danger)';

    const activeNameEl = document.getElementById('client-active-server-name');
    if (activeNameEl && currentMode === 'client') activeNameEl.innerText = 'Koneksi Terputus';

    showToast('Koneksi terputus. Mencoba menghubungkan kembali...', 'error');
    
    // Auto reconnect dengan debounce guard
    if (!operatorReconnectTimer) {
      operatorReconnectTimer = setTimeout(() => {
        operatorReconnectTimer = null;
        connectWebSocket(currentOperatorWsUrl);
      }, 3000);
    }
  };

  ws.onerror = (err) => {
    console.error('WebSocket Error:', err);
    try { ws.close(); } catch (_) {}
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
      if (payload && payload.serverName) {
        currentConnectedServerName = payload.serverName;
        const lbl = document.getElementById('status-server-name');
        const val = document.getElementById('status-server-name-val');
        if (lbl && val) {
          val.innerText = payload.serverName;
          lbl.style.display = 'block';
        }
        const activeNameEl = document.getElementById('client-active-server-name');
        if (activeNameEl) activeNameEl.innerText = payload.serverName;
      }
      renderQueueState(payload);
      break;

    case 'TICKET_CREATED': {
      const ticket = payload;
      // Cetak otomatis jika tiket dibuat oleh operator ini
      if (ticket.tx_id && ticket.tx_id === currentTxId) {
        printTicketHistory(ticket.ticket_number, ticket.service_name, ticket.customer_name, ticket.created_at);
        currentTxId = ''; // Reset transaksi
      }
      break;
    }

    case 'WA_STATUS_UPDATE':
      renderWaStatus(payload);
      break;
    
    case 'ANNOUNCE_CALL':
      // Main process display window yang akan memutar suara, 
      // tapi kita juga bisa memutarnya secara opsional di operator panel.
      playVoiceAnnounce(payload.ticketNumber, payload.deskNumber, payload.voiceFiles);
      break;

    case 'STOP_ANNOUNCEMENT':
      stopLocalAudio();
      break;

    case 'ALERT':
      showToast(payload.message, 'info');
      break;

    case 'RUNNING_TEXT_SAVED':
      showToast(`✅ Teks berjalan berhasil disimpan & diterapkan! (${payload.count} teks)`, 'success');
      break;
      
    case 'SETTINGS_RESPONSE':
      if (wsRequestCallbacks['SETTINGS_RESPONSE']) {
        wsRequestCallbacks['SETTINGS_RESPONSE'](payload);
        delete wsRequestCallbacks['SETTINGS_RESPONSE'];
      }
      break;

    case 'STATS_RESPONSE':
      if (wsRequestCallbacks['STATS_RESPONSE']) {
        wsRequestCallbacks['STATS_RESPONSE'](payload);
        delete wsRequestCallbacks['STATS_RESPONSE'];
      }
      break;

    case 'SEARCH_RESPONSE':
      if (wsRequestCallbacks['SEARCH_RESPONSE']) {
        wsRequestCallbacks['SEARCH_RESPONSE'](payload);
        delete wsRequestCallbacks['SEARCH_RESPONSE'];
      }
      break;

    case 'DISPLAY_CUSTOM_UPDATE': {
      document.getElementById('setting-display-title').value = payload.title || 'SimpleAntrian';
      document.getElementById('setting-display-subtitle').value = payload.subtitle || '';
      if (payload.logo) {
        currentLogoBase64 = payload.logo;
        document.getElementById('display-logo-preview').src = currentLogoBase64;
        document.getElementById('display-logo-preview-container').style.display = 'flex';
      } else {
        currentLogoBase64 = '';
        document.getElementById('display-logo-preview').src = '';
        document.getElementById('display-logo-preview-container').style.display = 'none';
      }
      if (payload.theme) {
        document.body.className = payload.theme === 'imigrasi' ? 'theme-imigrasi' : '';
        const themeSelect = document.getElementById('setting-color-theme');
        if (themeSelect) themeSelect.value = payload.theme;
      }
      break;
    }

    case 'ERROR':
      showToast(payload.message, 'error');
      break;

    case 'TTS_GEN_STATUS':
      renderTtsStatus(payload);
      break;
  }
}

function renderTtsStatus(statusInfo) {
  const banner = document.getElementById('tts-status-banner');
  if (!banner) return;

  // Hapus timeout penyembunyian banner sebelumnya jika ada status baru yang masuk
  if (ttsBannerTimeout) {
    clearTimeout(ttsBannerTimeout);
    ttsBannerTimeout = null;
  }

  const { status, progress, message } = statusInfo;
  
  if (status === 'ready' || status === 'error') {
    if (status === 'ready') {
      banner.style.display = 'flex';
      document.getElementById('tts-status-icon').innerText = '✅';
      document.getElementById('tts-status-title').innerText = 'Layanan Suara Offline Siap';
      document.getElementById('tts-status-desc').innerText = 'Model suara offline (TTS) berhasil dimuat.';
      document.getElementById('tts-status-progress').style.width = '100%';
      document.getElementById('tts-status-percent').innerText = '100%';
      
      ttsBannerTimeout = setTimeout(() => {
        banner.style.display = 'none';
        ttsBannerTimeout = null;
      }, 5000);
    } else {
      document.getElementById('tts-status-icon').innerText = '❌';
      document.getElementById('tts-status-title').innerText = 'Gagal Memuat Model Suara';
      document.getElementById('tts-status-desc').innerText = message || 'Gagal mengunduh dependensi lokal.';
      document.getElementById('tts-status-progress').style.width = '0%';
      document.getElementById('tts-status-percent').innerText = '0%';
      banner.style.display = 'flex';
    }
  } else {
    banner.style.display = 'flex';
    document.getElementById('tts-status-icon').innerText = '🔄';
    
    let title = 'Mempersiapkan Suara Offline (TTS)';
    if (status.startsWith('downloading_model_')) {
      const lang = status.replace('downloading_model_', '').toUpperCase();
      title = `Mengunduh Model Suara Bahasa ${lang === 'ZH' ? 'Mandarin' : lang === 'ID' ? 'Indonesia' : 'Inggris'}...`;
    } else if (status.startsWith('downloading_config_')) {
      const lang = status.replace('downloading_config_', '').toUpperCase();
      title = `Mengunduh Konfigurasi Bahasa ${lang === 'ZH' ? 'Mandarin' : lang === 'ID' ? 'Indonesia' : 'Inggris'}...`;
    } else if (status === 'downloading_binary') {
      title = 'Mengunduh Modul Piper Offline (Windows/Linux)...';
    } else if (status === 'extracting_binary') {
      title = 'Mengekstrak Modul Piper...';
    } else if (status === 'generating_vocab') {
      title = 'Menghasilkan File Suara Dasar (Angka & Huruf)...';
    }

    document.getElementById('tts-status-title').innerText = title;
    document.getElementById('tts-status-desc').innerText = message || 'Sedang mengunduh aset lokal...';
    document.getElementById('tts-status-progress').style.width = `${progress}%`;
    document.getElementById('tts-status-percent').innerText = `${progress}%`;
  }
}

// Render status WhatsApp lokal ke UI settings
function renderWaStatus(waState) {
  const { status, qr, pairingCode, pairingPhone, number, version } = waState;
  
  const badge        = document.getElementById('wa-status-badge');
  const qrContainer  = document.getElementById('wa-qr-container');
  const qrImg        = document.getElementById('wa-qr-img');
  const pairContainer = document.getElementById('wa-pairing-container');
  const pairDisplay  = document.getElementById('wa-pairing-code-display');
  const details      = document.getElementById('wa-details');
  const detailsNum   = document.getElementById('wa-details-number');
  const btnLogout    = document.getElementById('btn-wa-logout');
  const authMethods  = document.getElementById('wa-auth-methods');

  // --- Badge Status ---
  const labelMap = {
    connected:    'Terhubung ✅',
    qr:           'Pindai QR Code 📷',
    pairing_code: 'Masukkan Kode 🔐',
    connecting:   'Menghubungkan...',
    disconnected: 'Terputus'
  };
  const classMap = {
    connected:    'badge-completed',
    qr:           'badge-calling',
    pairing_code: 'badge-calling',
    connecting:   'badge-waiting',
    disconnected: 'badge-skipped'
  };
  badge.innerText   = labelMap[status] || 'Terputus';
  badge.className   = `badge ${classMap[status] || 'badge-skipped'}`;

  // --- QR Code panel ---
  if (status === 'qr' && qr) {
    qrImg.src = qr;
    qrContainer.style.display = 'flex';
  } else {
    qrContainer.style.display = 'none';
    qrImg.src = '';
  }

  // --- Pairing Code panel ---
  if (status === 'pairing_code' && pairingCode) {
    pairDisplay.innerText = pairingCode;
    pairContainer.style.display = 'flex';
  } else {
    pairContainer.style.display = 'none';
  }

  // --- Connected details ---
  if (status === 'connected') {
    detailsNum.innerText = number || '-';
    details.style.display   = 'flex';
    btnLogout.style.display = 'block';
    if (authMethods) authMethods.style.display = 'none'; // Sembunyikan pilihan metode saat sudah connect
  } else {
    details.style.display   = 'none';
    btnLogout.style.display = 'none';
    if (authMethods) authMethods.style.display = 'flex';
  }

  // --- Versi Baileys ---
  if (version) {
    document.getElementById('wa-version-lbl').innerText = `v${version}`;
  }
}

// Play Voice Announce menggunakan Web Speech API & Web Audio Ding-Dong (3 bahasa)
async function playVoiceAnnounce(ticketNumber, deskNumber, voiceFiles) {
  // Hanya bunyikan jika dicentang di setelan audio (opsional, untuk operator)
  const settings = await window.api.getSettings();
  if (settings.play_audio_operator !== 'true') return;

  if (!voiceFiles || voiceFiles.length === 0) return;

  try {
    // 1. Play Ding-Dong
    await playDingDong();

    // Get current server host from WebSocket connection to build absolute URLs
    const wsUrlObj = new URL(ws.url);
    const audioBaseUrl = `http://${wsUrlObj.host}/audio`;

    // Map filenames to full URLs
    const urls = voiceFiles.map(file => `${audioBaseUrl}/${file}`);

    // Play the sequence of audio files
    await playAudioSequence(urls);
  } catch (err) {
    console.error('Offline TTS playback failed:', err);
  }
}

let currentLocalAudio = null;
let isLocalPlaying = false;

function stopLocalAudio() {
  isLocalPlaying = false;
  if (currentLocalAudio) {
    try {
      currentLocalAudio.pause();
      currentLocalAudio.currentTime = 0;
      currentLocalAudio.src = '';
    } catch (_) {}
    currentLocalAudio = null;
  }
}

function playAudioSequence(urls) {
  return new Promise((resolve) => {
    if (!urls || urls.length === 0) {
      resolve();
      return;
    }
    
    isLocalPlaying = true;
    let index = 0;
    const audio = new Audio();
    currentLocalAudio = audio;
    
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
      if (!isLocalPlaying || index >= urls.length) {
        currentLocalAudio = null;
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
      const amp = 0.25 * Math.exp(-6 * t);
      signal += amp * Math.sin(2 * Math.PI * fC5 * t);
    }
    // Nada 2: E5 (mulai 0.2s, durasi 0.4s)
    if (t >= 0.2 && t < 0.6) {
      const amp = 0.25 * Math.exp(-6 * (t - 0.2));
      signal += amp * Math.sin(2 * Math.PI * fE5 * (t - 0.2));
    }
    // Nada 3: G5 (mulai 0.4s, durasi 0.5s)
    if (t >= 0.4 && t < 0.9) {
      const amp = 0.3 * Math.exp(-5 * (t - 0.4));
      signal += amp * Math.sin(2 * Math.PI * fG5 * (t - 0.4));
    }
    
    signal = Math.max(-1.0, Math.min(1.0, signal));
    buffer[44 + i] = Math.floor((signal + 1.0) * 127.5);
  }
  
  return new Blob([buffer], { type: 'audio/wav' });
}

// Ding Dong Chime menggunakan HTML5 Audio (Bypass autoplay block)
function playDingDong() {
  return new Promise((resolve) => {
    try {
      const wavBlob = generateChimeWavBlob();
      const blobUrl = URL.createObjectURL(wavBlob);
      const audio = new Audio(blobUrl);
      
      audio.onended = () => {
        URL.revokeObjectURL(blobUrl);
        resolve();
      };
      
      audio.onerror = (err) => {
        console.error('HTML5 Chime playback failed:', err);
        URL.revokeObjectURL(blobUrl);
        resolve();
      };
      
      audio.play().catch(err => {
        console.error('HTML5 Chime autoplay error:', err);
        URL.revokeObjectURL(blobUrl);
        resolve();
      });
    } catch (e) {
      resolve();
    }
  });
}

// Render State Antrian ke UI Dashboard
function renderQueueState(state) {
  const { services, waitingTickets, callingTickets, serverName } = state;
  servicesList = services;

  // Update Mirroring UI state
  if (state.displayMode) {
    const btnQueue = document.getElementById('btn-mode-queue');
    const btnVideo = document.getElementById('btn-mode-video');
    const btnMirror = document.getElementById('btn-mode-mirror');
    const statusText = document.getElementById('mirror-connection-status');
    
    if (btnQueue && btnMirror && statusText) {
      if (btnQueue) btnQueue.className = 'btn btn-sm btn-secondary';
      if (btnVideo) btnVideo.className = 'btn btn-sm btn-secondary';
      if (btnMirror) btnMirror.className = 'btn btn-sm btn-secondary';
      
      if (state.displayMode === 'mirror') {
        if (btnMirror) btnMirror.className = 'btn btn-sm btn-primary';
        statusText.innerText = 'Duplikasi Jendela';
        statusText.style.color = 'var(--accent-primary)';
      } else if (state.displayMode === 'video') {
        if (btnVideo) btnVideo.className = 'btn btn-sm btn-primary';
        statusText.innerText = 'Video Fullscreen';
        statusText.style.color = 'var(--accent-primary)';
      } else {
        if (btnQueue) btnQueue.className = 'btn btn-sm btn-primary';
        statusText.innerText = 'Layar Antrian';
        statusText.style.color = 'var(--accent-warning)';
      }
    }
  }

  if (state.mirrorWindowName !== undefined) {
    const activeLabel = document.getElementById('mirror-active-window-name');
    const select = document.getElementById('select-mirror-source');
    
    if (activeLabel) {
      activeLabel.innerText = state.mirrorWindowName || 'Tidak Ada Jendela Terpilih';
    }
    if (select && state.mirrorWindowName) {
      const matchOpt = Array.from(select.options).find(opt => opt.value === state.mirrorWindowName);
      if (matchOpt) {
        select.value = state.mirrorWindowName;
      }
    }
  }

  if (state.mirrorCropTop !== undefined) {
    const checkCrop = document.getElementById('check-mirror-crop');
    if (checkCrop) {
      checkCrop.checked = state.mirrorCropTop;
    }
  }

  // Render server name if received from WebSocket server
  if (serverName) {
    const lbl = document.getElementById('status-server-name');
    const val = document.getElementById('status-server-name-val');
    if (lbl && val) {
      val.innerText = serverName;
      lbl.style.display = 'block';
    }
  }

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
    // Tentukan nomor loket
    let currentDesk = localDeskSettings[srv.id];
    // Ambil calling tickets untuk layanan ini (terurut dari yang paling baru dipanggil)
    const serviceCallingTickets = callingTickets.filter(t => t.service_id === srv.id);
    
    if (!currentDesk) {
      // Jika ada tiket aktif dipanggil untuk layanan ini, samakan nomor loketnya
      if (serviceCallingTickets.length > 0 && serviceCallingTickets[0].desk_number) {
        currentDesk = serviceCallingTickets[0].desk_number;
        localDeskSettings[srv.id] = currentDesk;
        localStorage.setItem('local_desk_settings', JSON.stringify(localDeskSettings));
      } else {
        currentDesk = srv.name;
      }
    }

    // Cari apakah ada tiket sedang dipanggil untuk layanan dan loket ini
    // 1. Cocokkan nomor loket yang terdaftar (case-insensitive & trimmed)
    const normDesk = (currentDesk || '').trim().toLowerCase();
    let activeCall = serviceCallingTickets.find(t => (t.desk_number || '').trim().toLowerCase() === normDesk);
    
    // 2. Jika tidak ditemukan karena nama loket baru diubah di input, cari berdasarkan activeTickets tracking
    if (!activeCall && activeTickets[srv.id]) {
      activeCall = serviceCallingTickets.find(t => t.id === activeTickets[srv.id]);
    }

    // 3. Fallback: jika ada tiket calling untuk layanan ini, pasangkan yang terbaru dan sinkronkan loket
    if (!activeCall && serviceCallingTickets.length > 0) {
      activeCall = serviceCallingTickets[0];
      if (activeCall.desk_number) {
        currentDesk = activeCall.desk_number;
        localDeskSettings[srv.id] = currentDesk;
        localStorage.setItem('local_desk_settings', JSON.stringify(localDeskSettings));
      }
    }

    if (activeCall) {
      activeTickets[srv.id] = activeCall.id;
    } else {
      delete activeTickets[srv.id];
    }
    
    // Cari tiket berikutnya yang sedang menunggu untuk layanan ini
    const nextWaiting = waitingTickets.find(t => t.service_id === srv.id);

    const activeNumber = activeCall ? activeCall.ticket_number : '—';
    const lastCalledText = srv.current_number > 0 ? `Terakhir: ${srv.prefix}${String(srv.current_number).padStart(3, '0')}` : 'Belum ada antrian';

    let noticeHtml = '';
    let actionsHtml = '';

    if (activeCall) {
      // Sedang memanggil tiket
      noticeHtml = `
        <div style="font-size: 0.85rem; color: #fbbf24; background: rgba(245, 158, 11, 0.08); border: 1px solid rgba(245, 158, 11, 0.2); padding: 8px 12px; border-radius: 8px; font-weight: 600; text-align: center; margin-bottom: 12px; width: 100%;">
          Sedang melayani antrian aktif
        </div>
      `;
      actionsHtml = `
        <div class="calling-actions-grid">
          <button class="btn btn-primary" onclick="recall('${activeCall.id}', '${srv.id}')" style="grid-column: span 1;">
            🔔 Panggil Ulang
          </button>
          <button class="btn btn-secondary" onclick="callSkipped('${srv.id}')" ${srv.skipped_count > 0 ? '' : 'disabled'}>
            🔄 Terlewat ${srv.skipped_count > 0 ? `(${srv.skipped_count})` : ''}
          </button>
          <button class="btn btn-success" onclick="completeCall('${activeCall.id}', '${srv.id}')" style="grid-column: span 1;">
            ✅ Selesai
          </button>
          <button class="btn btn-danger" onclick="skipCall('${activeCall.id}', '${srv.id}')" style="grid-column: span 1;">
            ❌ Lewati
          </button>
        </div>
      `;
    } else {
      // Standby (tidak ada panggilan aktif)
      if (nextWaiting) {
        noticeHtml = `
          <div style="font-size: 0.9rem; color: #818cf8; background: rgba(99, 102, 241, 0.12); border: 1px solid rgba(99, 102, 241, 0.25); padding: 8px 12px; border-radius: 8px; font-weight: 600; text-align: center; margin-bottom: 12px; width: 100%; display: flex; flex-direction: column; gap: 2px;">
            <span style="font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-secondary);">Antrian Berikutnya</span>
            <span style="font-size: 1.15rem; font-weight: 800; color: #ffffff;">${nextWaiting.ticket_number}</span>
          </div>
        `;
        actionsHtml = `
          <div class="calling-actions-grid" style="grid-template-columns: 2fr 1fr;">
            <button class="btn btn-primary" onclick="callNext('${srv.id}')" style="padding: 12px 16px; font-weight: 700; font-size: 1.05rem; grid-column: span 1;">
              🔔 Panggil ${nextWaiting.ticket_number}
            </button>
            <button class="btn btn-secondary" onclick="callSkipped('${srv.id}')" ${srv.skipped_count > 0 ? '' : 'disabled'} title="Panggil Antrian Terlewat" style="padding: 12px 16px; font-weight: 600; font-size: 1rem;">
              🔄 ${srv.skipped_count > 0 ? `(${srv.skipped_count})` : ''}
            </button>
          </div>
        `;
      } else {
        noticeHtml = `
          <div style="font-size: 0.9rem; color: var(--text-muted); background: rgba(255, 255, 255, 0.02); border: 1px dashed rgba(255, 255, 255, 0.1); padding: 8px 12px; border-radius: 8px; font-weight: 500; text-align: center; margin-bottom: 12px; width: 100%; display: flex; flex-direction: column; gap: 2px;">
            <span style="font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted);">Antrian Berikutnya</span>
            <span style="font-size: 1rem; font-weight: 600; color: var(--text-muted);">Tidak ada antrian</span>
          </div>
        `;
        actionsHtml = `
          <div class="calling-actions-grid" style="grid-template-columns: 2fr 1fr;">
            <button class="btn btn-primary" disabled style="opacity: 0.4; cursor: not-allowed; padding: 12px 16px; font-weight: 600; font-size: 1rem; grid-column: span 1;">
              🔔 Panggil
            </button>
            <button class="btn btn-secondary" onclick="callSkipped('${srv.id}')" ${srv.skipped_count > 0 ? '' : 'disabled'} title="Panggil Antrian Terlewat" style="padding: 12px 16px; font-weight: 600; font-size: 1rem;">
              🔄 ${srv.skipped_count > 0 ? `(${srv.skipped_count})` : ''}
            </button>
          </div>
        `;
      }
    }

    const card = document.createElement('div');
    card.className = `glass-panel service-calling-card animate-slide-in ${activeCall ? 'animate-call-blink' : ''}`;
    card.innerHTML = `
      <div class="calling-header">
        <span class="calling-service-name">${srv.name} (Prefix: ${srv.prefix})</span>
        ${activeCall ? '<span class="badge badge-calling">Memanggil</span>' : '<span class="badge badge-waiting">Standby</span>'}
      </div>
      <div class="current-call-number" id="call-number-${srv.id}" style="font-size: ${activeCall ? '3.5rem' : '2.5rem'}; transition: font-size 0.3s; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; min-height: 80px;">
        <span>${activeNumber}</span>
        ${!activeCall ? `<span style="font-size: 0.85rem; color: var(--text-muted); font-weight: normal;">${lastCalledText}</span>` : ''}
      </div>
      
      <div class="desk-setting-row">
        <label for="desk-input-${srv.id}" style="font-size: 0.85rem; font-weight:600; color:var(--text-secondary);">Loket:</label>
        <input type="text" class="input-control desk-input" id="desk-input-${srv.id}" value="${currentDesk}">
      </div>

      ${noticeHtml}
      ${actionsHtml}
    `;
    callingGrid.appendChild(card);
    
    // Event listener untuk menyimpan input loket langsung saat diketik (Auto-save local)
    const deskInput = card.querySelector(`.desk-input`);
    deskInput.addEventListener('input', (e) => {
      localDeskSettings[srv.id] = e.target.value;
      localStorage.setItem('local_desk_settings', JSON.stringify(localDeskSettings));
    });
    deskInput.addEventListener('change', (e) => {
      const newDesk = e.target.value;
      sendAction('SYNC_DESK_NAMES', { deskNames: Object.values(localDeskSettings) });
      if (activeCall) {
        sendAction('UPDATE_ACTIVE_TICKET_DESK', { ticketId: activeCall.id, deskNumber: newDesk });
      } else {
        sendAction('GET_STATE'); // Memicu re-fetch agar kartu antrian aktif loket baru langsung terupdate
      }
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
  let deskNumber = '';
  if (deskInput && deskInput.value) {
    deskNumber = deskInput.value.trim();
  } else {
    const srv = servicesList.find(s => s.id === serviceId);
    deskNumber = srv ? srv.name : 'Loket 1';
  }
  localDeskSettings[serviceId] = deskNumber;
  localStorage.setItem('local_desk_settings', JSON.stringify(localDeskSettings));
  sendAction('CALL_NEXT', { serviceId, deskNumber });
};

window.callSkipped = function(serviceId) {
  const deskInput = document.getElementById(`desk-input-${serviceId}`);
  let deskNumber = '';
  if (deskInput && deskInput.value) {
    deskNumber = deskInput.value.trim();
  } else {
    const srv = servicesList.find(s => s.id === serviceId);
    deskNumber = srv ? srv.name : 'Loket 1';
  }
  localDeskSettings[serviceId] = deskNumber;
  localStorage.setItem('local_desk_settings', JSON.stringify(localDeskSettings));
  sendAction('CALL_SKIPPED', { serviceId, deskNumber });
};

window.recall = function(ticketId, serviceId) {
  if (!ticketId) return;
  const deskInput = document.getElementById(`desk-input-${serviceId}`);
  let deskNumber = '';
  if (deskInput && deskInput.value) {
    deskNumber = deskInput.value.trim();
  } else {
    const srv = servicesList.find(s => s.id === serviceId);
    deskNumber = srv ? srv.name : 'Loket 1';
  }
  localDeskSettings[serviceId] = deskNumber;
  localStorage.setItem('local_desk_settings', JSON.stringify(localDeskSettings));
  sendAction('RECALL', { ticketId, deskNumber });
};

window.completeCall = function(ticketId, serviceId) {
  if (!ticketId) return;
  const deskInput = document.getElementById(`desk-input-${serviceId}`);
  let deskNumber = '';
  if (deskInput && deskInput.value) {
    deskNumber = deskInput.value.trim();
  } else {
    deskNumber = localDeskSettings[serviceId] || 'Loket 1';
  }
  if (serviceId && activeTickets[serviceId]) {
    delete activeTickets[serviceId];
  }
  const autoCallCheck = document.getElementById('setting-auto-call-next');
  const autoCallNext = autoCallCheck ? autoCallCheck.checked : true;
  sendAction('COMPLETE', { ticketId, serviceId, deskNumber, autoCallNext });
};

window.skipCall = function(ticketId, serviceId) {
  if (!ticketId) return;
  if (serviceId && activeTickets[serviceId]) {
    delete activeTickets[serviceId];
  }
  sendAction('SKIP', { ticketId });
};

// ==================== EVENT LISTENERS & SETUP ====================

function setupEventListeners() {
  // Mirror Controls Event Listeners
  const btnModeQueue = document.getElementById('btn-mode-queue');
  const btnModeVideo = document.getElementById('btn-mode-video');
  const btnModeMirror = document.getElementById('btn-mode-mirror');
  const selectMirrorSource = document.getElementById('select-mirror-source');
  const btnRefreshMirror = document.getElementById('btn-refresh-mirror-sources');

  if (btnModeQueue) {
    btnModeQueue.addEventListener('click', () => {
      sendAction('SAVE_DISPLAY_MODE', { mode: 'queue' });
    });
  }

  if (btnModeVideo) {
    btnModeVideo.addEventListener('click', () => {
      sendAction('SAVE_DISPLAY_MODE', { mode: 'video' });
    });
  }

  if (btnModeMirror) {
    btnModeMirror.addEventListener('click', () => {
      sendAction('SAVE_DISPLAY_MODE', { mode: 'mirror' });
    });
  }

  if (selectMirrorSource) {
    selectMirrorSource.addEventListener('change', () => {
      sendAction('SAVE_MIRROR_WINDOW', { windowName: selectMirrorSource.value });
    });
  }

  const checkMirrorCrop = document.getElementById('check-mirror-crop');
  if (checkMirrorCrop) {
    checkMirrorCrop.addEventListener('change', () => {
      sendAction('SAVE_MIRROR_CROP', { crop: checkMirrorCrop.checked });
    });
  }

  if (btnRefreshMirror) {
    btnRefreshMirror.addEventListener('click', () => {
      loadMirrorSources();
    });
  }

  // Proyeksi Display Window
  const btnToggleDisplay = document.getElementById('btn-toggle-display');
  btnToggleDisplay.addEventListener('click', async () => {
    const isOpen = await window.api.isDisplayWindowOpen();
    if (isOpen) {
      await window.api.closeDisplayWindow();
      showToast('Layar Display ditutup.', 'info');
    } else {
      const targetMonitor = document.getElementById('setting-display-monitor')?.value || 'auto';
      const lockKiosk = document.getElementById('setting-display-lock-kiosk') ? document.getElementById('setting-display-lock-kiosk').checked : true;
      await window.api.openDisplayWindow({
        targetMonitorId: targetMonitor,
        isLocked: lockKiosk
      });
      showToast('Layar Display berhasil dibuka/diproyeksikan!', 'success');
    }
  });

  // Proyeksi Kiosk Window (Layar Ketiga)
  const btnToggleKiosk = document.getElementById('btn-toggle-kiosk');
  btnToggleKiosk.addEventListener('click', async () => {
    const isOpen = await window.api.isKioskWindowOpen();
    if (isOpen) {
      await window.api.closeKioskWindow();
      showToast('Layar Kiosk Mandiri ditutup.', 'info');
    } else {
      await window.api.openKioskWindow();
      showToast('Layar Kiosk Mandiri berhasil dibuka/diproyeksikan!', 'success');
    }
  });

  // Printer selection listener
  const quickPrinterSelect = document.getElementById('quick-printer');
  if (quickPrinterSelect) {
    quickPrinterSelect.addEventListener('change', () => {
      localStorage.setItem('mini_selected_printer', quickPrinterSelect.value);
      const label = quickPrinterSelect.value === '__DIALOG__' ? 'Dialog Cetak OS' : quickPrinterSelect.value;
      showToast('Target printer: ' + label, 'info');
    });
  }

  const btnRefreshQuickPrinter = document.getElementById('btn-refresh-quick-printer');
  if (btnRefreshQuickPrinter) {
    btnRefreshQuickPrinter.addEventListener('click', async () => {
      if (typeof loadOperatorPrinters === 'function') {
        await loadOperatorPrinters();
        showToast('Daftar printer diperbarui!', 'info');
      }
    });
  }

  // Buat Tiket Baru (Quick Ticket)
  const btnCreateTicket = document.getElementById('btn-create-ticket');
  btnCreateTicket.addEventListener('click', () => {
    const serviceId = document.getElementById('quick-service').value;
    const name = document.getElementById('quick-name').value;
    const phone = document.getElementById('quick-phone').value;

    if (!serviceId) {
      showToast('Pilih kategori layanan terlebih dahulu.', 'error');
      return;
    }

    // Set transaction ID untuk memicu auto-print setelah sukses broadcast
    currentTxId = generateTxId();

    sendAction('CREATE_TICKET', { serviceId, name, phone, txId: currentTxId });
    
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
  if (btnManualConnect) {
    btnManualConnect.addEventListener('click', () => {
      const ipPort = document.getElementById('client-manual-ip').value.trim();
      if (!ipPort) {
        showToast('Ketik alamat IP:Port server target (contoh: 192.168.1.50:8080).', 'error');
        return;
      }
      connectToRemoteServer(ipPort);
    });
  }

  const clientManualIp = document.getElementById('client-manual-ip');
  if (clientManualIp && btnManualConnect) {
    clientManualIp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        btnManualConnect.click();
      }
    });
  }

  // Pindai Ulang Server UDP (Client Mode)
  const btnRefreshDiscovery = document.getElementById('btn-refresh-discovery');
  if (btnRefreshDiscovery) {
    btnRefreshDiscovery.addEventListener('click', async () => {
      const icon = document.getElementById('refresh-icon');
      if (icon) icon.classList.add('spinning');
      showToast('📡 Memindai server antrian di jaringan lokal (UDP)...', 'info');
      try {
        const servers = await window.api.refreshDiscovery();
        if (servers) renderDiscoveredServers(servers);
      } catch (err) {
        console.error('Failed to refresh discovery:', err);
      } finally {
        setTimeout(() => {
          if (icon) icon.classList.remove('spinning');
        }, 800);
      }
    });
  }

  // Reconnect ke server yang sedang aktif
  const btnReconnectCurrent = document.getElementById('btn-reconnect-current');
  if (btnReconnectCurrent) {
    btnReconnectCurrent.addEventListener('click', () => {
      const target = currentConnectedEndpoint || localStorage.getItem('last_connected_server');
      if (target) {
        showToast(`Menghubungkan ulang ke ${target}...`, 'info');
        connectToRemoteServer(target);
      } else {
        showToast('Belum ada server yang dipilih.', 'warning');
      }
    });
  }

  // Salin Alamat IP Server ke Clipboard
  const btnCopyServerIp = document.getElementById('btn-copy-server-ip');
  if (btnCopyServerIp) {
    btnCopyServerIp.addEventListener('click', () => {
      const ip = document.getElementById('lbl-local-ip-display').value || '127.0.0.1';
      const port = document.getElementById('setting-port').value || '8080';
      const fullAddr = `${ip}:${port}`;
      navigator.clipboard.writeText(fullAddr).then(() => {
        showToast(`Alamat Server (${fullAddr}) berhasil disalin ke clipboard!`, 'success');
      }).catch(() => {
        showToast(`Alamat Server: ${fullAddr}`, 'info');
      });
    });
  }

  // Live preview perubahan pilihan mode operasi
  const appModeSelect = document.getElementById('app-mode-select');
  if (appModeSelect) {
    appModeSelect.addEventListener('change', async (e) => {
      const selectedMode = e.target.value;
      const serverGroup = document.getElementById('settings-server-group');
      const clientInfoGroup = document.getElementById('settings-client-info-group');
      if (selectedMode === 'server') {
        if (serverGroup) serverGroup.style.display = 'flex';
        if (clientInfoGroup) clientInfoGroup.style.display = 'none';
        const srvInput = document.getElementById('setting-server-name');
        if (srvInput && !srvInput.value.trim()) {
          const localSettings = await window.api.getSettings().catch(() => ({}));
          srvInput.value = (localSettings && localSettings.server_name) || 'Server Utama';
        }
      } else {
        if (serverGroup) serverGroup.style.display = 'none';
        if (clientInfoGroup) clientInfoGroup.style.display = 'flex';
      }
    });
  }

  // Klik status card di sidebar untuk langsung menuju pengaturan koneksi server
  const sidebarStatusCard = document.querySelector('.sidebar .status-card');
  if (sidebarStatusCard) {
    sidebarStatusCard.style.cursor = 'pointer';
    sidebarStatusCard.title = 'Buka Pengaturan Koneksi Server';
    sidebarStatusCard.addEventListener('click', () => {
      const settingsNav = document.querySelector('.nav-item[data-tab="settings"]');
      if (settingsNav) settingsNav.click();
      const serverSection = document.getElementById('section-server-connection');
      if (serverSection) {
        serverSection.scrollIntoView({ behavior: 'smooth' });
      }
    });
  }

  // Simpan Mode & Restart
  const btnSaveMode = document.getElementById('btn-save-mode');
  if (btnSaveMode) {
    btnSaveMode.addEventListener('click', async () => {
      const mode = document.getElementById('app-mode-select').value;
      let serverName = document.getElementById('setting-server-name').value.trim();
      const port = document.getElementById('setting-port').value || '8080';

      if (mode === 'server' && !serverName) {
        const localSettings = await window.api.getSettings().catch(() => ({}));
        serverName = (localSettings && localSettings.server_name) || 'Server Utama';
        const srvInput = document.getElementById('setting-server-name');
        if (srvInput) srvInput.value = serverName;
      }

      await window.api.saveModeSettings({ mode, serverName, port });
      showToast('Pengaturan mode berhasil disimpan! Sistem merestart service.', 'success');
      
      // Muat ulang detail & tabel pengaturan layanan
      await initSystemInfo();
      await loadSettings();
    });
  }

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

  // Tombol Hentikan Suara Cepat (Dashboard)
  const btnStopAudio = document.getElementById('btn-stop-audio');
  if (btnStopAudio) {
    btnStopAudio.addEventListener('click', () => {
      sendAction('STOP_ANNOUNCEMENT');
      stopLocalAudio();
      showToast('⏹️ Panggilan suara dihentikan.', 'info');
    });
  }

  // Simpan TTS & Queue Settings
  const btnSaveTts = document.getElementById('btn-save-tts');
  if (btnSaveTts) {
    btnSaveTts.addEventListener('click', () => {
      const enabled = document.getElementById('setting-tts-enabled').checked ? 'true' : 'false';
      const callName = document.getElementById('setting-call-customer-name').checked ? 'true' : 'false';
      const callDesk = document.getElementById('setting-call-desk-enabled')?.checked ? 'true' : 'false';
      const ttsLanguage = document.getElementById('setting-tts-language') ? document.getElementById('setting-tts-language').value : 'id';
      const multilang = ttsLanguage === 'id_en' ? 'true' : 'false';
      const autoCallNext = document.getElementById('setting-auto-call-next') ? (document.getElementById('setting-auto-call-next').checked ? 'true' : 'false') : 'false';
      sendAction('SAVE_TTS', { enabled, multilang, ttsLanguage, callName, callDesk, autoCallNext });
      showToast('Menyimpan pengaturan Suara & Alur Panggilan...', 'info');
    });
  }

  // Pengaturan Kustomisasi Tampilan Display (Logo, Judul, Slogan)
  const btnBrowseLogo = document.getElementById('btn-browse-display-logo');
  const fileInputLogo = document.getElementById('setting-display-logo-file');
  const logoPreviewContainer = document.getElementById('display-logo-preview-container');
  const logoPreview = document.getElementById('display-logo-preview');
  const btnRemoveLogo = document.getElementById('btn-remove-display-logo');

  if (btnBrowseLogo && fileInputLogo) {
    btnBrowseLogo.addEventListener('click', () => fileInputLogo.click());

    fileInputLogo.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) {
        if (file.size > 2 * 1024 * 1024) {
          showToast('Ukuran berkas logo terlalu besar (maksimal 2MB).', 'error');
          fileInputLogo.value = '';
          return;
        }
        const reader = new FileReader();
        reader.onload = (event) => {
          currentLogoBase64 = event.target.result;
          logoPreview.src = currentLogoBase64;
          logoPreviewContainer.style.display = 'flex';
        };
        reader.readAsDataURL(file);
      }
    });
  }

  if (btnRemoveLogo) {
    btnRemoveLogo.addEventListener('click', () => {
      currentLogoBase64 = '';
      logoPreview.src = '';
      logoPreviewContainer.style.display = 'none';
      fileInputLogo.value = '';
    });
  }

  const btnSaveDisplayCustom = document.getElementById('btn-save-display-custom');
  if (btnSaveDisplayCustom) {
    btnSaveDisplayCustom.addEventListener('click', async () => {
      const title = document.getElementById('setting-display-title').value.trim();
      const subtitle = document.getElementById('setting-display-subtitle').value.trim();
      const theme = document.getElementById('setting-color-theme').value;
      const layout = document.getElementById('setting-display-layout')?.value || 'standard';
      const targetMonitor = document.getElementById('setting-display-monitor')?.value || 'auto';
      const lockKiosk = document.getElementById('setting-display-lock-kiosk')?.checked ? 'true' : 'false';

      // Simpan preferensi monitor & kiosk lock ke DB lokal
      if (window.api && window.api.saveSetting) {
        await window.api.saveSetting('display_target_monitor', targetMonitor);
        await window.api.saveSetting('display_lock_fullscreen', lockKiosk);
      }

      // Terapkan langsung ke display window yang sedang aktif tanpa restart
      if (window.api && window.api.updateDisplayTarget) {
        await window.api.updateDisplayTarget({
          targetMonitorId: targetMonitor,
          isLocked: lockKiosk === 'true'
        });
      }

      const feedbackUrl = document.getElementById('setting-feedback-url')?.value.trim() || '';
      const feedbackMode = document.getElementById('setting-feedback-mode')?.value || 'both';

      sendAction('SAVE_DISPLAY_CUSTOM', {
        title: title || 'SimpleAntrian',
        subtitle: subtitle || 'Budayakan antri demi kenyamanan bersama. Silakan siapkan tiket Anda dan perhatikan panggilan layar.',
        logo: currentLogoBase64,
        theme: theme,
        layout: layout,
        feedbackSurveyUrl: feedbackUrl,
        feedbackDisplayMode: feedbackMode
      });
      showToast('Pengaturan tampilan display berhasil disimpan & diperbarui!', 'success');
    });
  }

  // Simpan WA Settings
  const btnSaveWa = document.getElementById('btn-save-wa');
  btnSaveWa.addEventListener('click', async () => {
    const enabled = document.getElementById('setting-wa-enabled').checked ? 'true' : 'false';
    const waitTemplate = document.getElementById('setting-wa-template-wait').value.trim();
    const callTemplate = document.getElementById('setting-wa-template-call').value.trim();

    // Simpan + restart WA via WebSocket (sehingga berlaku di server mode maupun client mode)
    sendAction('WA_SAVE_AND_RESTART', {
      enabled,
      templateWait: waitTemplate,
      templateCall: callTemplate
    });
    showToast('Menyimpan pengaturan WhatsApp...', 'info');
  });

  // ==================== FOLDER MEDIA LOKAL ====================
  const btnSelectLocalFolder = document.getElementById('btn-select-local-folder');
  const btnClearLocalFolder = document.getElementById('btn-clear-local-folder');
  const localFolderInfo = document.getElementById('local-media-folder-info');
  const localFolderList = document.getElementById('local-media-folder-list');
  const localFolderStatus = document.getElementById('local-media-folder-status');
  const localOverrideNotice = document.getElementById('playlist-local-override-notice');

  // Load current local media folder status
  async function loadLocalMediaFolder() {
    if (!window.api || !window.api.getLocalMediaFolder) return;
    try {
      const result = await window.api.getLocalMediaFolder();
      if (result && result.success && result.mediaFiles && result.mediaFiles.length > 0) {
        renderLocalFolderInfo(result.folderPath, result.mediaFiles);
      } else {
        renderLocalFolderInfo(null, []);
      }
    } catch (err) {
      console.error('[Operator] Gagal load local media folder:', err);
    }
  }

  function renderLocalFolderInfo(folderPath, files) {
    if (!localFolderInfo) return;
    if (folderPath && files.length > 0) {
      localFolderInfo.innerHTML = '📁 <strong>' + folderPath + '</strong> — <strong>' + files.length + '</strong> file media ditemukan.';
      if (btnClearLocalFolder) btnClearLocalFolder.style.display = 'inline-block';
      if (localFolderStatus) localFolderStatus.textContent = '✅ Display pada mesin ini akan memutar media dari folder lokal (file://) — tanpa lag HTTP.';
      if (localOverrideNotice) localOverrideNotice.style.display = 'inline';

      // Tampilkan daftar file
      if (localFolderList) {
        localFolderList.style.display = 'block';
        localFolderList.innerHTML = files.map((f, i) => {
          const icon = f.type === 'image' ? '🖼️' : '🎬';
          const sizeMB = (f.size / (1024 * 1024)).toFixed(1);
          return '<div style="padding: 3px 0; border-bottom: 1px solid rgba(255,255,255,0.05);">' + icon + ' ' + (i + 1) + '. ' + f.name + ' <span style="color: var(--text-muted);">(' + sizeMB + ' MB)</span></div>';
        }).join('');
      }
    } else {
      localFolderInfo.textContent = 'Belum ada folder media lokal terpilih. Display menggunakan playlist server (HTTP streaming).';
      if (btnClearLocalFolder) btnClearLocalFolder.style.display = 'none';
      if (localFolderStatus) localFolderStatus.textContent = '';
      if (localOverrideNotice) localOverrideNotice.style.display = 'none';
      if (localFolderList) {
        localFolderList.style.display = 'none';
        localFolderList.innerHTML = '';
      }
    }
  }

  if (btnSelectLocalFolder) {
    btnSelectLocalFolder.addEventListener('click', async () => {
      if (!window.api || !window.api.selectLocalMediaFolder) {
        showToast('Fitur folder media lokal belum tersedia.', 'error');
        return;
      }
      try {
        const result = await window.api.selectLocalMediaFolder();
        if (result && result.success) {
          renderLocalFolderInfo(result.folderPath, result.mediaFiles);
          showToast('Folder media lokal diset: ' + result.folderPath + ' (' + result.mediaFiles.length + ' file). Restart display untuk menerapkan.', 'success');
        } else {
          showToast(result.message || 'Folder tidak dipilih.', 'warning');
        }
      } catch (err) {
        showToast('Gagal memilih folder: ' + err.message, 'error');
      }
    });
  }

  if (btnClearLocalFolder) {
    btnClearLocalFolder.addEventListener('click', async () => {
      if (!window.api || !window.api.clearLocalMediaFolder) return;
      try {
        await window.api.clearLocalMediaFolder();
        renderLocalFolderInfo(null, []);
        showToast('Folder media lokal dihapus. Display akan menggunakan playlist server. Restart display untuk menerapkan.', 'info');
      } catch (err) {
        showToast('Gagal menghapus folder lokal: ' + err.message, 'error');
      }
    });
  }

  // Load on init
  loadLocalMediaFolder();

  // Pengaturan Playlist Video Layar Display
  const btnImportFolderMedia = document.getElementById('btn-import-folder-media');
  if (btnImportFolderMedia) {
    btnImportFolderMedia.addEventListener('click', async () => {
      showToast('Membuka pemilih folder...', 'info');
      try {
        const res = await window.api.importMediaFromFolder();
        if (res.success && Array.isArray(res.mediaList) && res.mediaList.length > 0) {
          // Tambahkan seluruh media ke playlist
          res.mediaList.forEach(item => currentVideoPlaylist.push(item));
          renderVideoPlaylist();

          // Otomatis simpan & terapkan ke resources sistem dan display
          const photoDuration = parseInt(document.getElementById('setting-photo-duration')?.value || '10', 10) || 10;
          sendAction('SAVE_VIDEO_PLAYLIST', {
            playlist: currentVideoPlaylist,
            photoDuration: photoDuration
          });

          const sidebarMuted = document.getElementById('setting-video-sidebar-muted')?.checked ?? true;
          const fullscreenMuted = document.getElementById('setting-video-fullscreen-muted')?.checked ?? false;
          sendAction('SAVE_VIDEO_AUDIO_SETTINGS', {
            sidebarMuted,
            fullscreenMuted
          });

          showToast(`🎉 Berhasil memindahkan & menyimpan ${res.count} media dari folder "${res.folderName}"!`, 'success');
        } else if (res.message && !res.message.includes('Batal')) {
          showToast(res.message, 'warning');
        }
      } catch (err) {
        showToast('Gagal mengimpor dari folder: ' + err.message, 'error');
      }
    });
  }

  const btnBrowseVideo = document.getElementById('btn-browse-video');
  const btnSaveVideoPlaylist = document.getElementById('btn-save-video-playlist');

  if (btnBrowseVideo) {
    btnBrowseVideo.addEventListener('click', async () => {
      showToast('Membuka pemilih berkas media...', 'info');
      try {
        const res = await window.api.addVideoFile();
        if (res.success) {
          if (Array.isArray(res.mediaList) && res.mediaList.length > 0) {
            res.mediaList.forEach(item => currentVideoPlaylist.push(item));
            renderVideoPlaylist();
            showToast(`Berhasil menambahkan ${res.mediaList.length} berkas media!`, 'success');
          } else if (res.video) {
            currentVideoPlaylist.push(res.video);
            renderVideoPlaylist();
            showToast(`Berhasil menambahkan: ${res.video.originalName}`, 'success');
          }
        } else if (res.message) {
          if (!res.message.includes('Batal')) {
            showToast(res.message, 'error');
          }
        }
      } catch (err) {
        showToast('Gagal menambahkan media: ' + err.message, 'error');
      }
    });
  }

  if (btnSaveVideoPlaylist) {
    btnSaveVideoPlaylist.addEventListener('click', () => {
      const photoDuration = parseInt(document.getElementById('setting-photo-duration')?.value || '10', 10) || 10;
      sendAction('SAVE_VIDEO_PLAYLIST', {
        playlist: currentVideoPlaylist,
        photoDuration: photoDuration
      });
      
      const sidebarMuted = document.getElementById('setting-video-sidebar-muted').checked;
      const fullscreenMuted = document.getElementById('setting-video-fullscreen-muted').checked;
      sendAction('SAVE_VIDEO_AUDIO_SETTINGS', {
        sidebarMuted,
        fullscreenMuted
      });
      
      showToast('Menyimpan playlist media dan durasi foto...', 'info');
    });
  }

  // Tambah Teks Berjalan Baru
  const btnAddRunningText = document.getElementById('btn-add-running-text');
  if (btnAddRunningText) {
    btnAddRunningText.addEventListener('click', () => {
      const input = document.getElementById('new-running-text-input');
      const text = input.value.trim();
      if (!text) {
        showToast('Teks tidak boleh kosong.', 'error');
        return;
      }
      currentRunningTexts.push(text);
      input.value = '';
      renderRunningTextsList();
      showToast('Teks ditambahkan. Klik Simpan untuk menerapkan.', 'info');
    });
  }

  // Simpan & Terapkan Teks Berjalan ke Display
  const btnSaveRunningTexts = document.getElementById('btn-save-running-texts');
  if (btnSaveRunningTexts) {
    btnSaveRunningTexts.addEventListener('click', () => {
      // Sync nilai textarea terkini (user mungkin mengedit langsung)
      currentRunningTexts = currentRunningTexts.map((_, i) => {
        const el = document.getElementById(`rt-input-${i}`);
        return el ? el.value.trim() : currentRunningTexts[i];
      }).filter(t => t);

      if (currentRunningTexts.length === 0) {
        showToast('Minimal harus ada 1 teks.', 'error');
        return;
      }

      sendAction('SAVE_RUNNING_TEXTS', { texts: currentRunningTexts });
    });
  }

  // Logout WhatsApp
  const btnWaLogout = document.getElementById('btn-wa-logout');
  btnWaLogout.addEventListener('click', async () => {
    if (await confirmDialog("Apakah Anda yakin ingin memutus sambungan WhatsApp?")) {
      sendAction('WA_LOGOUT');
      showToast('Memutus koneksi WhatsApp...', 'info');
    }
  });

  // Tombol Metode QR
  const btnWaMethodQr = document.getElementById('btn-wa-method-qr');
  if (btnWaMethodQr) {
    btnWaMethodQr.addEventListener('click', () => {
      document.getElementById('wa-phone-input-group').style.display = 'none';
      document.getElementById('wa-qr-start-group').style.display = 'flex';
      btnWaMethodQr.className = 'btn btn-primary'; // Aktif
      document.getElementById('btn-wa-method-phone').className = 'btn btn-secondary';
    });
  }

  // Tombol Metode Pairing Code
  const btnWaMethodPhone = document.getElementById('btn-wa-method-phone');
  if (btnWaMethodPhone) {
    btnWaMethodPhone.addEventListener('click', () => {
      document.getElementById('wa-phone-input-group').style.display = 'flex';
      document.getElementById('wa-qr-start-group').style.display = 'none';
      btnWaMethodPhone.className = 'btn btn-primary'; // Aktif
      document.getElementById('btn-wa-method-qr').className = 'btn btn-secondary';
    });
  }

  // Tombol Sambungkan QR (reset sesi lama, tampilkan QR baru)
  const btnWaStartQr = document.getElementById('btn-wa-start-qr');
  if (btnWaStartQr) {
    btnWaStartQr.addEventListener('click', async () => {
      btnWaStartQr.disabled = true;
      btnWaStartQr.innerText = 'Memulai koneksi QR...';
      showToast('Menghubungkan ulang WhatsApp via QR...', 'info');
      try {
        // Pastikan WA enabled dulu
        const enabled = document.getElementById('setting-wa-enabled').checked;
        if (!enabled) {
          showToast('Aktifkan notifikasi WhatsApp terlebih dahulu, lalu simpan.', 'error');
          return;
        }
        sendAction('WA_START_QR');
      } finally {
        setTimeout(() => {
          btnWaStartQr.disabled = false;
          btnWaStartQr.innerText = '🔄 Sambungkan / Perbarui QR Code';
        }, 3000);
      }
    });
  }

  // Tombol Minta Pairing Code
  const btnWaRequestPairing = document.getElementById('btn-wa-request-pairing');
  if (btnWaRequestPairing) {
    btnWaRequestPairing.addEventListener('click', async () => {
      const phone = document.getElementById('wa-phone-input').value.trim().replace(/[^0-9]/g, '');
      if (phone.length < 8) {
        showToast('Masukkan nomor HP yang valid (contoh: 6281368898090).', 'error');
        return;
      }
      const enabled = document.getElementById('setting-wa-enabled').checked;
      if (!enabled) {
        showToast('Aktifkan notifikasi WhatsApp terlebih dahulu, lalu simpan.', 'error');
        return;
      }
      btnWaRequestPairing.disabled = true;
      btnWaRequestPairing.innerText = 'Mengirim...';
      showToast(`Meminta kode penyandingan untuk nomor ${phone}...`, 'info');
      sendAction('WA_START_PAIRING', { phone });
      setTimeout(() => {
        btnWaRequestPairing.disabled = false;
        btnWaRequestPairing.innerText = 'Minta Kode';
      }, 5000);
    });
  }

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
    const confirmRestore = await confirmDialog("PERINGATAN: Mengimpor database akan menimpa seluruh data antrian saat ini! Apakah Anda yakin?");
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
  btnResetQueues.addEventListener('click', async () => {
    const confirmReset = await confirmDialog("Apakah Anda yakin ingin mereset seluruh antrian hari ini kembali ke 0?");
    if (confirmReset) {
      sendAction('RESET_ALL');
      showToast('Seluruh data antrian hari ini telah di-reset.', 'success');
    }
  });

  // Cek Pembaruan Aplikasi dari GitHub
  const btnCheckAppUpdate = document.getElementById('btn-check-app-update');
  if (btnCheckAppUpdate) {
    btnCheckAppUpdate.addEventListener('click', async () => {
      showToast('Mengecek pembaruan aplikasi di GitHub...', 'info');
      btnCheckAppUpdate.disabled = true;
      btnCheckAppUpdate.innerText = 'Mengecek...';
      try {
        const res = await window.api.checkAppUpdates();
        if (res && res.hasUpdate) {
          showToast(`Pembaruan tersedia: v${res.latest}!`, 'success');
          if (typeof window.showUpdateAvailableModal === 'function') {
            window.showUpdateAvailableModal(res);
          }
        } else {
          const info = await window.api.getSystemInfo();
          showToast(`✅ Aplikasi sudah menggunakan versi terbaru (v${info.appVersion}). Tidak ada pembaruan saat ini.`, 'success');
        }
      } catch (err) {
        showToast('Gagal mengecek pembaruan: ' + err.message, 'error');
      } finally {
        btnCheckAppUpdate.disabled = false;
        btnCheckAppUpdate.innerText = '🔄 Cek Pembaruan Aplikasi';
      }
    });
  }
}

// ==================== TAMPIL DATA LAINNYA ====================

// Trigger Pencarian Tiket
async function triggerSearch() {
  const query = document.getElementById('search-query').value.trim();
  const status = document.getElementById('search-status').value;
  const serviceId = document.getElementById('search-service').value;
  const dateStr = document.getElementById('search-date').value;

  const results = await searchTicketsData(query, status, serviceId, dateStr);
  const tbody = document.getElementById('search-tbody');
  tbody.innerHTML = '';

  if (results.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align: center; color: var(--text-muted); padding: 15px;">Tidak ditemukan tiket yang cocok dengan filter.</td></tr>';
    return;
  }

  results.forEach(t => {
    const tr = document.createElement('tr');
    
    const formattedCreated = new Date(t.created_at).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
    const formattedCalled = t.called_at ? new Date(t.called_at).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) : '-';
    
    let badgeClass = 'badge-waiting';
    let statusLabel = 'Menunggu';
    if (t.status === 'calling') { badgeClass = 'badge-calling'; statusLabel = 'Dipanggil'; }
    if (t.status === 'completed') { badgeClass = 'badge-completed'; statusLabel = 'Selesai'; }
    if (t.status === 'skipped') { badgeClass = 'badge-skipped'; statusLabel = 'Dilewati'; }
    if (t.status === 'expired') { badgeClass = 'badge-expired'; statusLabel = 'Kadaluarsa'; }

    // Format param-param text untuk HTML attribute yang aman dari karakter kutip
    const nameEscaped = (t.customer_name || '').replace(/'/g, "\\'");
    const serviceEscaped = (t.service_name || '').replace(/'/g, "\\'");

    tr.innerHTML = `
      <td><strong>${t.ticket_number}</strong></td>
      <td>${t.service_name}</td>
      <td>${t.customer_name || '-'}</td>
      <td>${t.customer_phone || '-'}</td>
      <td><span class="badge ${badgeClass}">${statusLabel}</span></td>
      <td>${t.desk_number || '-'}</td>
      <td>${formattedCreated}</td>
      <td>${formattedCalled}</td>
      <td>
        <button class="btn btn-secondary" onclick="printTicketHistory('${t.ticket_number}', '${serviceEscaped}', '${nameEscaped}', '${t.created_at}')" style="padding: 4px 8px; font-size: 0.75rem;">
          🖨️ Cetak
        </button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

// Fungsi Cetak Tiket untuk Printer Thermal / Dot Matrix
window.printTicketHistory = async function(ticketNumber, serviceName, customerName, createdAt) {
  const srvEl = document.getElementById('print-service-name');
  if (srvEl) srvEl.innerText = serviceName || 'Layanan';

  const ticketNoEl = document.getElementById('print-ticket-no');
  if (ticketNoEl) ticketNoEl.innerText = ticketNumber;
  
  const nameLbl = document.getElementById('print-customer-lbl');
  const cleanName = (customerName || '').trim();
  if (cleanName && cleanName !== '-' && cleanName !== 'Pelanggan' && cleanName !== 'Pelanggan Mandiri') {
    nameLbl.innerText = `Nama: ${cleanName}`;
    nameLbl.style.display = 'block';
  } else {
    nameLbl.innerText = '';
    nameLbl.style.display = 'none';
  }
  
  const timeEl = document.getElementById('print-time-lbl');
  if (timeEl) timeEl.innerText = `Waktu: ${new Date(createdAt).toLocaleString('id-ID')}`;
  
  const printerEl = document.getElementById('quick-printer');
  const targetPrinter = printerEl ? printerEl.value : (localStorage.getItem('mini_selected_printer') || '__DIALOG__');

  if (window.api && window.api.printTicket) {
    const isDialog = !targetPrinter || targetPrinter === '__DIALOG__';
    const res = await window.api.printTicket({
      deviceName: isDialog ? undefined : targetPrinter,
      silent: !isDialog
    });
    if (res && res.success && !isDialog) {
      showToast(`Tiket ${ticketNumber} dicetak ke ${targetPrinter}`, 'success');
    }
  } else {
    window.print();
  }
};

// Muat Statistik Harian
async function loadStats(dateStr) {
  const stats = await getDailyStatsData(dateStr);
  
  // Update Widget
  document.getElementById('stats-total').innerText = stats.summary.total;
  document.getElementById('stats-completed').innerText = stats.summary.completed;
  document.getElementById('stats-skipped').innerText = stats.summary.skipped;
  const expiredEl = document.getElementById('stats-expired');
  if (expiredEl) expiredEl.innerText = stats.summary.expired || 0;
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
    tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 10px;">Tidak ada ringkasan layanan.</td></tr>';
  } else {
    stats.services.forEach(srv => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${srv.prefix}</strong></td>
        <td>${srv.name}</td>
        <td>${srv.total || 0}</td>
        <td style="color: var(--accent-success);">${srv.completed || 0}</td>
        <td style="color: var(--accent-secondary);">${srv.skipped || 0}</td>
        <td style="color: #94a3b8;">${srv.expired || 0}</td>
      `;
      tbody.appendChild(tr);
    });
  }

  // 1. Render Hourly Line Chart
  const hourlyCtx = document.getElementById('stats-hourly-chart');
  if (hourlyCtx) {
    if (hourlyChartInstance) {
      hourlyChartInstance.destroy();
    }
    
    // Map hourly stats
    const standardHours = ['08', '09', '10', '11', '12', '13', '14', '15', '16', '17'];
    const hourlyCounts = standardHours.map(h => {
      const match = stats.hourly ? stats.hourly.find(x => x.hour === h) : null;
      return match ? match.count : 0;
    });

    hourlyChartInstance = new Chart(hourlyCtx, {
      type: 'line',
      data: {
        labels: standardHours.map(h => `${h}:00`),
        datasets: [{
          label: 'Jumlah Antrian',
          data: hourlyCounts,
          borderColor: '#6366f1',
          backgroundColor: 'rgba(99, 102, 241, 0.15)',
          fill: true,
          tension: 0.4,
          borderWidth: 3,
          pointBackgroundColor: '#6366f1',
          pointBorderColor: '#ffffff',
          pointBorderWidth: 1.5,
          pointRadius: 4,
          pointHoverRadius: 6
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#1e293b',
            titleColor: '#ffffff',
            bodyColor: '#f8fafc',
            borderWidth: 1,
            borderColor: 'rgba(255, 255, 255, 0.1)'
          }
        },
        scales: {
          x: {
            grid: { color: 'rgba(255, 255, 255, 0.05)' },
            ticks: { color: '#94a3b8' }
          },
          y: {
            grid: { color: 'rgba(255, 255, 255, 0.05)' },
            ticks: { 
              color: '#94a3b8',
              stepSize: 1,
              precision: 0
            },
            min: 0
          }
        }
      }
    });
  }

  // 2. Render Status Doughnut Chart
  const statusCtx = document.getElementById('stats-status-chart');
  if (statusCtx) {
    if (statusChartInstance) {
      statusChartInstance.destroy();
    }

    statusChartInstance = new Chart(statusCtx, {
      type: 'doughnut',
      data: {
        labels: ['Selesai', 'Dilewati', 'Kadaluarsa', 'Menunggu'],
        datasets: [{
          data: [
            stats.summary.completed, 
            stats.summary.skipped, 
            stats.summary.expired || 0, 
            stats.summary.waiting
          ],
          backgroundColor: ['#10b981', '#f43f5e', '#94a3b8', '#6366f1'],
          borderWidth: 3,
          borderColor: '#0b0f19',
          hoverOffset: 4
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'bottom',
            labels: {
              color: '#94a3b8',
              padding: 15,
              font: { size: 12 }
            }
          },
          tooltip: {
            backgroundColor: '#1e293b',
            titleColor: '#ffffff',
            bodyColor: '#f8fafc',
            borderWidth: 1,
            borderColor: 'rgba(255, 255, 255, 0.1)'
          }
        },
        cutout: '65%'
      }
    });
  }
}

// Muat Konfigurasi pada Pengaturan
async function loadSettings() {
  const localSettings = await window.api.getSettings().catch(() => ({}));
  let settings = localSettings || {};
  try {
    const remoteSettings = await getSettingsData();
    if (remoteSettings && typeof remoteSettings === 'object') {
      settings = { ...localSettings, ...remoteSettings };
    }
  } catch (_) {}
  
  // App Mode UI (Gunakan mode lokal PC ini)
  const appMode = currentMode || localSettings.app_mode || 'server';
  const appModeSelectEl = document.getElementById('app-mode-select');
  if (appModeSelectEl) appModeSelectEl.value = appMode;
  const srvNameInput = document.getElementById('setting-server-name');
  if (srvNameInput) srvNameInput.value = localSettings.server_name || (settings && settings.server_name) || 'Server Utama';
  const srvPortInput = document.getElementById('setting-port');
  if (srvPortInput) srvPortInput.value = localSettings.port || (settings && settings.port) || '8080';

  const serverGroup = document.getElementById('settings-server-group');
  const clientInfoGroup = document.getElementById('settings-client-info-group');
  if (appMode === 'server') {
    if (serverGroup) serverGroup.style.display = 'flex';
    if (clientInfoGroup) clientInfoGroup.style.display = 'none';
  } else {
    if (serverGroup) serverGroup.style.display = 'none';
    if (clientInfoGroup) clientInfoGroup.style.display = 'flex';
  }
  
  // TTS Settings UI
  const ttsCheckbox = document.getElementById('setting-tts-enabled');
  if (ttsCheckbox) {
    ttsCheckbox.checked = settings.tts_enabled !== 'false';
  }
  const callNameCheckbox = document.getElementById('setting-call-customer-name');
  if (callNameCheckbox) {
    callNameCheckbox.checked = settings.call_customer_name !== 'false';
  }
  const callDeskCheckbox = document.getElementById('setting-call-desk-enabled');
  if (callDeskCheckbox) {
    callDeskCheckbox.checked = settings.call_desk_enabled !== 'false';
  }
  const ttsLangSelect = document.getElementById('setting-tts-language');
  if (ttsLangSelect) {
    ttsLangSelect.value = settings.tts_language || (settings.multilang_enabled === 'true' ? 'id_en' : 'id');
  }
  const autoCallCheckbox = document.getElementById('setting-auto-call-next');
  if (autoCallCheckbox) {
    autoCallCheckbox.checked = settings.auto_call_next_on_complete !== 'false';
  }

  // Display Monitor & Kiosk Lock UI
  const monitorSelect = document.getElementById('setting-display-monitor');
  const lockKioskCheckbox = document.getElementById('setting-display-lock-kiosk');
  if (lockKioskCheckbox) {
    lockKioskCheckbox.checked = settings.display_lock_fullscreen !== 'false';
  }
  if (monitorSelect && window.api && window.api.getMonitors) {
    window.api.getMonitors().then(monitors => {
      monitorSelect.innerHTML = '<option value="auto">Deteksi Otomatis (Layar Kedua / Eksternal jika ada)</option>';
      monitors.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.label || `Monitor ${m.index + 1} (${m.bounds.width}x${m.bounds.height}${m.isPrimary ? ' - Utama' : ''})`;
        monitorSelect.appendChild(opt);
      });
      if (settings.display_target_monitor) {
        monitorSelect.value = settings.display_target_monitor;
      }
    }).catch(err => console.error("Gagal membaca daftar monitor:", err));
  }

  // WA Settings UI
  document.getElementById('setting-wa-enabled').checked = settings.wa_enabled === 'true';
  document.getElementById('setting-wa-template-wait').value = settings.wa_template_wait || '';
  document.getElementById('setting-wa-template-call').value = settings.wa_template_call || '';

  // Display Customization UI
  document.getElementById('setting-display-title').value = settings.display_title || 'SimpleAntrian';
  document.getElementById('setting-display-subtitle').value = settings.display_subtitle || '';
  if (settings.display_logo) {
    currentLogoBase64 = settings.display_logo;
    document.getElementById('display-logo-preview').src = currentLogoBase64;
    document.getElementById('display-logo-preview-container').style.display = 'flex';
  } else {
    currentLogoBase64 = '';
    document.getElementById('display-logo-preview').src = '';
    document.getElementById('display-logo-preview-container').style.display = 'none';
  }

  // Theme settings
  const themeVal = settings.color_theme || 'default';
  const themeSelect = document.getElementById('setting-color-theme');
  if (themeSelect) {
    themeSelect.value = themeVal;
  }
  document.body.className = themeVal === 'imigrasi' ? 'theme-imigrasi' : '';

  // Display Layout setting
  const layoutSelect = document.getElementById('setting-display-layout');
  if (layoutSelect) {
    layoutSelect.value = settings.display_layout || 'standard';
  }

  // Photo Duration setting
  const photoDurationInput = document.getElementById('setting-photo-duration');
  if (photoDurationInput) {
    photoDurationInput.value = settings.photo_duration || '10';
  }

  // Feedback Survey UI
  const feedbackUrlInput = document.getElementById('setting-feedback-url');
  if (feedbackUrlInput) {
    feedbackUrlInput.value = settings.feedback_survey_url || '';
  }
  const feedbackModeSelect = document.getElementById('setting-feedback-mode');
  if (feedbackModeSelect) {
    feedbackModeSelect.value = settings.feedback_display_mode || 'both';
  }

  // Video Audio Settings UI
  const sidebarMutedCheckbox = document.getElementById('setting-video-sidebar-muted');
  if (sidebarMutedCheckbox) {
    sidebarMutedCheckbox.checked = settings.video_sidebar_muted !== 'false';
  }
  const fullscreenMutedCheckbox = document.getElementById('setting-video-fullscreen-muted');
  if (fullscreenMutedCheckbox) {
    fullscreenMutedCheckbox.checked = settings.video_fullscreen_muted === 'true';
  }

  // Minta status WA terbaru ke WebSocket server
  sendAction('WA_STATUS');

  // Load Kategori Layanan Table
  const services = await getServicesData();
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
  if (await confirmDialog("Apakah Anda yakin ingin menghapus layanan ini? Ini juga akan menghapus seluruh data antrian di dalamnya.")) {
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

// ==================== RUNNING TEXTS MANAGEMENT ====================

/** State lokal daftar teks berjalan */
let currentRunningTexts = [];

/**
 * Deteksi bahasa teks untuk label badge (sama dengan display.js).
 */
function detectRunningTextLang(text) {
  if (/[\u4e00-\u9fff\u3400-\u4dbf]/.test(text)) return { label: 'ZH 🇨🇳', color: '#f59e0b' };
  if (/\b(the|and|please|thank|welcome|service|queue)\b/i.test(text)) return { label: 'EN 🇬🇧', color: '#60a5fa' };
  if (/\b(di|dan|kami|antrian|terima|layanan|silakan|selamat)\b/i.test(text)) return { label: 'ID 🇮🇩', color: '#4ade80' };
  return { label: 'MSG', color: '#a78bfa' };
}

/**
 * Muat running texts dari settings database dan render ke UI.
 */
async function loadRunningTexts() {
  try {
    const settings = await window.api.getSettings();
    let texts = [];
    if (settings.running_texts) {
      try { texts = JSON.parse(settings.running_texts); } catch (_) {}
    }
    // Fallback ke nilai default jika masih kosong
    if (!Array.isArray(texts) || texts.length === 0) {
      texts = [
        'Selamat Datang di Layanan Kami. Budayakan Mengantri dengan Tertib demi Kenyamanan Bersama. Terima kasih atas kerja sama Anda.',
        'Welcome to Our Service. Please Queue in an Orderly Manner for Everyone\'s Comfort. Thank you for your cooperation.',
        '\u6b22\u8fce\u5149\u4e34\u6211\u4eec\u7684\u670d\u52a1\u4e2d\u5fc3\u3002\u8bf7\u9075\u5b88\u79e9\u5e8f\u6392\u961f\uff0c\u5171\u540c\u7ef4\u62a4\u826f\u597d\u73af\u5883\u3002\u611f\u8c22\u60a8\u7684\u914d\u5408\u3002'
      ];
    }
    currentRunningTexts = texts.filter(t => t && t.trim());
    renderRunningTextsList();
  } catch (err) {
    showToast('Gagal memuat teks berjalan: ' + err.message, 'error');
  }
}

/**
 * Render daftar teks berjalan di UI settings.
 */
function renderRunningTextsList() {
  const container = document.getElementById('running-texts-list');
  if (!container) return;
  container.innerHTML = '';

  if (currentRunningTexts.length === 0) {
    container.innerHTML = `<div style="text-align:center; color:var(--text-muted); padding:16px;">Belum ada teks. Tambahkan di bawah.</div>`;
    return;
  }

  currentRunningTexts.forEach((text, index) => {
    const langInfo = detectRunningTextLang(text);
    const item = document.createElement('div');
    item.style.cssText = 'display:flex; gap:10px; align-items:flex-start; background:rgba(255,255,255,0.03); border:1px solid var(--border-glass); border-radius:10px; padding:12px;';
    item.innerHTML = `
      <div style="display:flex; flex-direction:column; gap:6px; flex:1; min-width:0;">
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:2px;">
          <span style="font-size:0.7rem; font-weight:700; background:rgba(0,0,0,0.3); color:${langInfo.color}; border:1px solid ${langInfo.color}40; padding:2px 7px; border-radius:4px; white-space:nowrap;">${langInfo.label}</span>
          <span style="font-size:0.72rem; color:var(--text-muted);">Teks ${index + 1} dari ${currentRunningTexts.length}</span>
        </div>
        <textarea class="input-control" id="rt-input-${index}" rows="2"
          style="resize:vertical; min-height:48px; font-size:0.88rem; width:100%; box-sizing:border-box;"
          oninput="updateRunningText(${index}, this.value)">${escapeHtmlAttr(text)}</textarea>
      </div>
      <div style="display:flex; flex-direction:column; gap:6px; flex-shrink:0;">
        <button class="btn btn-secondary" onclick="moveRunningText(${index}, -1)" title="Geser ke atas" ${index === 0 ? 'disabled' : ''} style="padding:6px 10px; font-size:0.85rem;">▲</button>
        <button class="btn btn-secondary" onclick="moveRunningText(${index}, 1)" title="Geser ke bawah" ${index === currentRunningTexts.length - 1 ? 'disabled' : ''} style="padding:6px 10px; font-size:0.85rem;">▼</button>
        <button class="btn btn-danger" onclick="removeRunningText(${index})" title="Hapus" style="padding:6px 10px; font-size:0.85rem;">🗑️</button>
      </div>
    `;
    container.appendChild(item);
  });
}

/** Escape untuk HTML attribute */
function escapeHtmlAttr(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/** Update teks di index tertentu saat diketik */
window.updateRunningText = function(index, value) {
  currentRunningTexts[index] = value;
};

/** Hapus teks di index tertentu */
window.removeRunningText = function(index) {
  currentRunningTexts.splice(index, 1);
  renderRunningTextsList();
};

/** Pindahkan teks ke atas/bawah */
window.moveRunningText = function(index, dir) {
  const newIndex = index + dir;
  if (newIndex < 0 || newIndex >= currentRunningTexts.length) return;
  const temp = currentRunningTexts[index];
  currentRunningTexts[index] = currentRunningTexts[newIndex];
  currentRunningTexts[newIndex] = temp;
  renderRunningTextsList();
};

// ==================== CONFIG PLAYLIST VIDEO ====================
let currentVideoPlaylist = [];

/**
 * Muat playlist video dari settings database dan render ke UI.
 */
async function loadVideoPlaylist() {
  try {
    const settings = await getSettingsData();
    let playlist = [];
    if (settings.video_playlist) {
      try { playlist = JSON.parse(settings.video_playlist); } catch (_) {}
    }
    currentVideoPlaylist = Array.isArray(playlist) ? playlist : [];
    renderVideoPlaylist();
  } catch (err) {
    showToast('Gagal memuat playlist video: ' + err.message, 'error');
  }
}

/**
 * Render daftar video di UI settings.
 */
function renderVideoPlaylist() {
  const container = document.getElementById('video-playlist-list');
  if (!container) return;
  container.innerHTML = '';

  if (currentVideoPlaylist.length === 0) {
    container.innerHTML = `<div style="text-align:center; color:var(--text-muted); padding:16px;">Belum ada media (video/foto) dalam playlist. Silakan tambah media di bawah.</div>`;
    return;
  }

  const imageExts = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.svg', '.avif'];

  currentVideoPlaylist.forEach((vid, index) => {
    const ext = (vid.filename || vid.originalName || '').substring((vid.filename || vid.originalName || '').lastIndexOf('.')).toLowerCase();
    const isImage = vid.type === 'image' || imageExts.includes(ext);
    const typeBadge = isImage 
      ? '<span style="display:inline-block; font-size:0.7rem; font-weight:700; background:rgba(236,72,153,0.15); color:#f472b6; border:1px solid rgba(236,72,153,0.3); border-radius:4px; padding:2px 6px; margin-right:6px;">FOTO</span>'
      : '<span style="display:inline-block; font-size:0.7rem; font-weight:700; background:rgba(99,102,241,0.15); color:#818cf8; border:1px solid rgba(99,102,241,0.3); border-radius:4px; padding:2px 6px; margin-right:6px;">VIDEO</span>';

    const item = document.createElement('div');
    item.style.cssText = 'display:flex; gap:10px; align-items:center; background:rgba(255,255,255,0.03); border:1px solid var(--border-glass); border-radius:10px; padding:12px;';
    item.innerHTML = `
      <div style="font-size:1.4rem; width:28px; text-align:center; flex-shrink:0;">${isImage ? '🖼️' : '🎬'}</div>
      <div style="flex:1; min-width:0; display:flex; flex-direction:column; gap:4px;">
        <div style="font-weight:600; font-size:0.9rem; color:var(--text-primary); text-overflow:ellipsis; overflow:hidden; white-space:nowrap; display:flex; align-items:center;">
          ${typeBadge}
          <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${vid.originalName}</span>
        </div>
        <div style="font-size:0.75rem; color:var(--text-muted); font-family:monospace; text-overflow:ellipsis; overflow:hidden; white-space:nowrap;">
          ${vid.url}
        </div>
      </div>
      <div style="display:flex; gap:6px; flex-shrink:0;">
        <button class="btn btn-secondary" onclick="moveVideo(${index}, -1)" title="Geser ke atas" ${index === 0 ? 'disabled' : ''} style="padding:6px 10px; font-size:0.85rem;">▲</button>
        <button class="btn btn-secondary" onclick="moveVideo(${index}, 1)" title="Geser ke bawah" ${index === currentVideoPlaylist.length - 1 ? 'disabled' : ''} style="padding:6px 10px; font-size:0.85rem;">▼</button>
        <button class="btn btn-danger" onclick="removeVideo(${index})" title="Hapus" style="padding:6px 10px; font-size:0.85rem;">🗑️</button>
      </div>
    `;
    container.appendChild(item);
  });
}

/** Hapus video dari playlist di index tertentu */
window.removeVideo = function(index) {
  currentVideoPlaylist.splice(index, 1);
  renderVideoPlaylist();
};

/** Pindahkan video ke atas/bawah */
window.moveVideo = function(index, dir) {
  const newIndex = index + dir;
  if (newIndex < 0 || newIndex >= currentVideoPlaylist.length) return;
  const temp = currentVideoPlaylist[index];
  currentVideoPlaylist[index] = currentVideoPlaylist[newIndex];
  currentVideoPlaylist[newIndex] = temp;
  renderVideoPlaylist();
};

// ==================== WINDOW MIRRORING ====================
async function loadMirrorSources() {
  const select = document.getElementById('select-mirror-source');
  if (!select) return;
  
  select.innerHTML = '<option value="">-- Memuat daftar jendela... --</option>';
  
  try {
    const windows = await window.api.getShareableWindows();
    select.innerHTML = '<option value="">-- Pilih Jendela/Aplikasi --</option>';
    
    // Urutkan alfabetis
    windows.sort((a, b) => a.name.localeCompare(b.name));
    
    windows.forEach(win => {
      if (win.name && win.name.trim()) {
        const opt = document.createElement('option');
        opt.value = win.name;
        opt.innerText = win.name;
        select.appendChild(opt);
      }
    });
    
    // Set value dari setting aktif jika ada
    const settings = await getSettingsData();
    if (settings) {
      if (settings.mirror_window_name) {
        select.value = settings.mirror_window_name;
        const activeLabel = document.getElementById('mirror-active-window-name');
        if (activeLabel) {
          activeLabel.innerText = settings.mirror_window_name;
        }
      }
      
      const checkCrop = document.getElementById('check-mirror-crop');
      if (checkCrop) {
        checkCrop.checked = settings.mirror_crop_top === 'true';
      }
    }
  } catch (err) {
    console.error("Gagal memuat jendela shareable:", err);
    select.innerHTML = '<option value="">Gagal memuat daftar jendela</option>';
  }
}



async function loadOperatorPrinters() {
  const select = document.getElementById('quick-printer');
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
      console.error('Gagal memuat printer operator:', err);
    }
  }
}
