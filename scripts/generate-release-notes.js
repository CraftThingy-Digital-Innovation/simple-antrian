const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function getChangelog() {
  try {
    const prevTag = execSync('git describe --tags --abbrev=0 HEAD^', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
    if (prevTag) {
      const logs = execSync(`git log ${prevTag}..HEAD --pretty=format:"* %s (%h)" --no-merges`, { encoding: 'utf-8' }).trim();
      if (logs) return logs;
    }
  } catch (_) {
    // If no previous tag or HEAD^ is not available
  }

  try {
    const fallbackLogs = execSync('git log -n 20 --pretty=format:"* %s (%h)" --no-merges', { encoding: 'utf-8' }).trim();
    if (fallbackLogs) return fallbackLogs;
  } catch (_) {}

  return '* Peningkatan performa, perbaikan bug, dan stabilitas aplikasi.';
}

function readSha(filename) {
  try {
    if (fs.existsSync(filename)) {
      return fs.readFileSync(filename, 'utf-8').trim().split(/\s+/)[0];
    }
  } catch (_) {}
  return 'N/A';
}

function generate() {
  const repo = process.env.GITHUB_REPOSITORY || 'craftthingy/simple-antrian';
  const tag = process.env.GITHUB_REF_NAME || 'latest';
  const changelog = getChangelog();
  const winSha = readSha('SimpleAntrian-windows-x64.zip.sha256');
  const linuxSha = readSha('SimpleAntrian-linux-x64.tar.gz.sha256');

  const content = `## 🚀 Apa yang Baru di Versi Ini (Changelog)

${changelog}

---

## 📦 Berkas Unduhan Standalone (100% Offline)

| Berkas | Sistem Operasi | Status & Tanda Tangan |
| :--- | :--- | :--- |
| **[SimpleAntrian-windows-x64.zip](https://github.com/${repo}/releases/download/${tag}/SimpleAntrian-windows-x64.zip)** | Windows 10 / 11 (64-bit) | ✅ Ditandatangani Digital (Authenticode) |
| **[SimpleAntrian-linux-x64.tar.gz](https://github.com/${repo}/releases/download/${tag}/SimpleAntrian-linux-x64.tar.gz)** | Linux x64 (Ubuntu / Debian / distro lain) | ✅ Standalone Tarball |

---

## 🛡️ Panduan Keamanan Windows SmartScreen & Antivirus

> [!IMPORTANT]
> Saat pertama kali menjalankan **\`SimpleAntrian.exe\`** di Windows, layar biru peringatan dari **Microsoft Defender SmartScreen** mungkin muncul (*"Windows protected your PC / Windows melindungi PC Anda"*).

### Mengapa hal ini muncul?
Aplikasi ini adalah perangkat lunak sumber terbuka (**Open-Source**) yang dikompilasi secara otomatis melalui **GitHub Actions**. Windows SmartScreen secara otomatis memberikan peringatan kepada aplikasi baru yang belum dibeli sertifikat komersial Extended Validation (EV) seharga jutaan rupiah per tahun dari pihak ketiga. **Aplikasi ini 100% aman, bebas dari malware/virus, dan kode sumbernya terbuka untuk diaudit.**

### Cara Menjalankan Aplikasi:
1. Pada jendela biru peringatan Windows SmartScreen, klik tautan teks **"Info selengkapnya"** (*More info*).
2. Klik tombol **"Tetap jalankan"** (*Run anyway*).
3. Aplikasi akan langsung berjalan secara normal.

### (Opsional) Mendaftarkan Sertifikat Digital Bawaan:
Berkas eksekusi telah ditandatangani secara digital dengan sertifikat Authenticode (\`CraftThingy Digital Innovation\`). Di dalam berkas \`.zip\`, tersedia skrip **\`Install-Certificate.bat\`**:
* Klik kanan **\`Install-Certificate.bat\`** -> Pilih **"Run as administrator"**.
* Sertifikat akan otomatis didaftarkan ke sistem Windows Anda agar peringatan SmartScreen tidak muncul lagi di komputer tersebut.

---

## 🔐 Verifikasi Checksum Berkas (SHA-256)

Anda dapat memverifikasi integritas berkas unduhan Anda dengan mencocokkan nilai hash SHA-256 berikut:
\`\`\`text
${winSha}  SimpleAntrian-windows-x64.zip
${linuxSha}  SimpleAntrian-linux-x64.tar.gz
\`\`\`

---

## 💻 Cara Menjalankan

1. **Ekstrak** berkas \`.zip\` (Windows) atau \`.tar.gz\` (Linux) ke folder pilihan Anda.
2. **Mode Server (Komputer Utama / Display TV):**
   * Jalankan **\`Mulai-Server.bat\`** (Windows) atau **\`./mulai-server.sh\`** (Linux).
3. **Mode Client (Komputer Loket Tambahan / Kiosk):**
   * Jalankan **\`Mulai-Client.bat\`** (Windows) atau **\`./mulai-client.sh\`** (Linux).
   * Aplikasi Client akan otomatis terhubung ke Server melalui jaringan lokal (UDP Auto-Discovery).
`;

  fs.writeFileSync('release_body.md', content, 'utf-8');
  console.log('[Release Notes] release_body.md generated successfully.');
}

generate();
