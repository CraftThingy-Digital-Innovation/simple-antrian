# SimpleAntrian

Aplikasi antrian (SimpleAntrian) adalah aplikasi desktop lintas platform (**Windows & Linux**) yang dirancang untuk bekerja secara **standalone**, sangat ringan, dan memiliki performa tinggi. Aplikasi ini dikembangkan menggunakan **Electron, Vanilla HTML/CSS/JS, dan SQLite**.

Aplikasi ini dibuat oleh **Alif Nurhidayat** di bawah naungan **CraftThingy Digital Innovation**.

---

### 🌟 Fitur Utama

1. **Mode Proyeksi Layar Kedua (Dual Screen Mode)**:
   Aplikasi mendeteksi jumlah monitor terhubung. Jika monitor tambahan (extended monitor) terdeteksi, jendela display antrian pelanggan akan otomatis diproyeksikan secara *fullscreen* tanpa bingkai di monitor tersebut, sedangkan panel operator tetap terbuka di monitor utama.

2. **Mode Jaringan Client-Server & Auto-Discovery (Bebas Bentrok)**:
   * **Auto-Discovery**: Server secara berkala menyiarkan metadatanya via **UDP Multicast** (`239.255.255.250:41234`). Client di jaringan lokal yang sama akan langsung mendeteksi server aktif dan menampilkannya di daftar koneksi.
   * **Bebas Bentrok**: Setiap server menghasilkan UUID unik saat startup pertama kali. Sistem mendukung operasional beberapa pasang server dan client sekaligus di satu jaringan lokal (misal: 3 server dan 3 client) tanpa terjadi bentrokan data.
   * **Sinkronisasi WebSocket**: Sinkronisasi data tiket antrian dan panggilan loket berjalan secara instan (*real-time*) di seluruh client terhubung.

3. **Panggilan Suara Loket Multi-Bahasa (Piper TTS - Neural Offline)**:
   Sistem panggilan suara antrian kini menggunakan engine neural **Piper TTS** yang berjalan 100% offline dan mandiri (tanpa internet). Mengucapkan nomor antrian secara berurutan dalam **3 bahasa sekaligus** (Bahasa Indonesia, Inggris, dan Mandarin/China) dengan lafal alami berkualitas studio. Aset suara dasar (angka dan huruf) serta modul binari Piper diunduh secara dinamis dan di-generate di latar belakang saat startup pertama kali. Nama loket kustom baru akan di-generate secara otomatis saat diinput oleh operator sebelum panggilan dimulai.

4. **Tombol "Selesai" Panggil Otomatis (Complete & Call Next)**:
   Meningkatkan efisiensi kerja operator. Ketika operator mengeklik tombol **✅ Selesai** (Complete), jika masih ada antrian yang menunggu pada layanan tersebut, sistem secara otomatis akan memanggil nomor antrian berikutnya secara instan tanpa perlu operator mengeklik tombol panggil secara manual.

5. **WhatsApp Lokal Terintegrasi (Pairing Code & QR Code)**:
   Aplikasi menggunakan modul **Baileys** untuk terhubung langsung ke WhatsApp Web secara lokal.
   * **Kode Penyandingan (Pairing Code)**: Anda kini dapat menghubungkan nomor WhatsApp hanya dengan memasukkan nomor HP pada settings. Aplikasi akan meminta kode pairing 8-digit langsung dari server WhatsApp untuk dimasukkan pada menu Tautkan Perangkat di HP Anda.
   * **Scan QR**: Mendukung koneksi standar dengan memindai QR Code di tab Settings. Sesi aman disimpan secara lokal di folder `data/wa-session`.
   * **Auto-Update Library**: Untuk mengantisipasi perubahan protokol WhatsApp Web di masa mendatang, aplikasi secara otomatis memeriksa versi terbaru `@whiskeysockets/baileys` di NPM Registry setiap kali startup. Jika terdeteksi versi baru, aplikasi akan unduh dan pasang secara senyap (*silent update*) di latar belakang sebelum menghubungkan layanan.
   * **Notifikasi Antrian**: Mengirimkan notifikasi WA otomatis saat tiket baru dibuat, saat antrian berjarak 3 nomor lagi dari antrian aktif (pengingat bersiap), dan saat nomor antrian tersebut dipanggil ke loket.

6. **Pengelola Teks Berjalan Interaktif (Running Text Manager)**:
   * Menampilkan running text bergantian (cycling) pada bagian bawah layar display.
   * Admin/Operator dapat menambah, menghapus, mengubah, atau mengatur urutan tampilan teks langsung dari tab Settings.
   * Deteksi bahasa otomatis (ID/EN/ZH) dengan label badge khusus di layar display pelanggan.
   * Durasi marquee dihitung secara dinamis dan proporsional sesuai dengan panjang karakter teks, memastikan teks panjang terbaca sepenuhnya sebelum berganti ke teks berikutnya.

7. **Layar Kiosk Pendaftaran Mandiri (Layar Ketiga / Client Ketiga)**:
   * Menyediakan antarmuka pendaftaran mandiri (self-service) bagi pelanggan. Pelanggan dapat memasukkan nama & nomor WhatsApp secara mandiri lewat layar sentuh (touchscreen) dan langsung mencetak struk antrian.
   * Mendukung mode monitor ketiga di PC Server (dibuka otomatis fullscreen tanpa frame) atau di perangkat Client terpisah (tablet/PC pendaftaran) di area depan pintu masuk yang terhubung ke server utama via WebSockets.

8. **Cetak Tiket Printer Thermal & Dot Matrix**:
   * Layout tiket terformat secara otomatis via CSS media query `@media print` sehingga pas di kertas printer kasir/thermal 58mm/80mm maupun printer dot-matrix.
   * Mendukung cetak otomatis saat tiket dibuat di Kiosk (hanya di printer Kiosk lokal berdasarkan ID transaksi unik) serta cetak ulang (reprint) manual dari panel operator untuk rekap data.

9. **Database SQLite yang Tangguh & Anti-Corrupt**:
   Database lokal dikonfigurasi menggunakan mode **WAL (Write-Ahead Logging)** yang menjamin integritas data yang sangat aman dari korupsi data meskipun PC mengalami mati listrik tiba-tiba atau aplikasi dimatikan secara paksa. Semua data secara otomatis langsung disimpan (*auto-save*).

10. **Pencarian, Filter, & Statistik Harian**:
    * **Pencarian**: Cari tiket berdasarkan nomor antrian, nama pelanggan, atau nomor WA. Filter berdasarkan status tiket, kategori layanan, dan tanggal operasional.
    * **Statistik Harian**: Menghitung total antrian, tiket dilayani, dilewati, dan sedang menunggu, lengkap dengan performa rata-rata waktu tunggu serta waktu pelayanan per hari yang dipilih.

11. **Utilitas Backup & Restore (SQL + CSV)**:
    Ekspor seluruh database SQLite ke file backup eksternal sekali klik sekaligus menghasilkan laporan rekapitulasi data dalam format **CSV**, serta impor database (restore) instan.

------

## 📂 Struktur Proyek

```text
simple-antrian/
├── .github/workflows/   # CI/CD Pipeline (GitHub Actions Release)
│   └── release.yml
├── data/                # Data lokal (SQLite DB, Sesi WA) - DIABAIKAN OLEH GIT
├── src/
│   ├── server/          # Backend Node.js
│   │   ├── db.js        # Modul database SQLite & WAL
│   │   ├── discovery.js # UDP Multicast Broadcaster & Listener
│   │   ├── tts-generator.js # Modul offline Piper TTS, downloader & generator
│   │   ├── websocket.js # WebSocket Server & Client handler
│   │   └── whatsapp.js  # Klien WA Baileys & silent updater
│   └── renderer/        # Frontend Chromium (UI)
│       ├── index.css    # Gaya glassmorphism & media cetak struk
│       ├── operator.html# UI Kontrol Operator
│       ├── operator.js  # Logika halaman operator & WS client
│       ├── display.html # UI Layar Customer Display
│       ├── display.js   # Audio chime, Text-to-Speech & Visualizer Canvas
│       ├── kiosk.html   # UI Kiosk Pendaftaran Mandiri (Layar Sentuh)
│       └── kiosk.js     # Logika Kiosk & penanganan printer thermal
├── main.js              # Entry point utama Electron
├── preload.js           # Bridge API aman (IPC Renderer)
├── package.json         # Konfigurasi dependensi & build scripts
└── LICENSE              # Lisensi penggunaan perangkat lunak
```

---

## 🛠️ Panduan Penggunaan & Pengembangan

Aplikasi ini bersifat **truly standalone**. Di sisi pengguna/operator, aplikasi dapat langsung dijalankan tanpa perlu menginstal Node.js, npm, SQLite, atau Git. Cukup jalankan file executable di dalam folder hasil build.

### Persyaratan untuk Developer (Development Setup)
Pastikan komputer Anda sudah terinstal **Node.js (v18+)** dan **Git**.

1. **Clone repositori dan masuk ke direktori**:
   ```bash
    git clone https://github.com/CraftThingy-Digital-Innovation/simple-antrian.git
    cd simple-antrian
   ```
2. **Install dependensi**:
   ```bash
   npm install
   ```
3. **Jalankan aplikasi dalam mode pengembangan**:
   ```bash
   npm start
   ```

### Cara Memaketkan Aplikasi (Build Standalone Binary)
Untuk membuat folder aplikasi mandiri yang berisi seluruh executable binary:

* **Build untuk Windows (x64)**:
  ```bash
  npm run pack
  ```
  Hasil build dapat ditemukan di folder `dist/SimpleAntrian-win32-x64/`. Di dalamnya terdapat file shortcut siap pakai:
  * **`Mulai-Server.bat`**: Menjalankan aplikasi langsung sebagai Server Node.
  * **`Mulai-Client.bat`**: Menjalankan aplikasi langsung sebagai Client Node.

* **Build untuk Linux (x64)**:
  ```bash
  npm run pack-linux
  ```
  Hasil build dapat ditemukan di folder `dist/SimpleAntrian-linux-x64/`. Di dalamnya terdapat file shell script siap pakai:
  * **`mulai-server.sh`**: Menjalankan aplikasi langsung sebagai Server.
  * **`mulai-client.sh`**: Menjalankan aplikasi langsung sebagai Client.

---

## ⚙️ Parameter Startup (Command-Line Arguments)

Anda dapat memaksa mode aplikasi saat dijalankan melalui terminal/shortcut tanpa bergantung pada pengaturan database:
* **Force Client Mode**: Jalankan dengan parameter `--client` atau `-c` (Contoh: `SimpleAntrian.exe --client`).
* **Force Server Mode**: Jalankan dengan parameter `--server` or `-s` (Contoh: `SimpleAntrian.exe --server`).
* **Auto-Detect**: Jika nama file executable diubah dan mengandung kata `client` (misal: `SimpleAntrianClient.exe`), aplikasi akan otomatis mendeteksi dan langsung berjalan dalam **Mode Client**.

---

## 🚀 Otomatisasi Rilis (GitHub Actions Workflow)

Proyek ini telah dikonfigurasi dengan pipeline CI/CD GitHub Actions di [.github/workflows/release.yml](file:///d:/CraftThingy/simple-antrian/.github/workflows/release.yml).

* **Cara Memicu Auto-Release**:
  Ketika Anda membuat rilis versi baru di Git lokal, cukup buat tag rilis baru (misal `v1.0.0`) lalu push tag tersebut ke GitHub:
  ```bash
  git tag v1.0.0
  git push origin v1.0.0
  ```
* **Hasil**: GitHub Actions akan otomatis membuat draf rilis baru di repositori GitHub organisasi `CraftThingy-Digital-Innovation`, mengompilasi module SQLite untuk Windows dan Linux pada runner native masing-masing, mengompresnya (`.zip` untuk Windows, `.tar.gz` untuk Linux), dan mengunggahnya sebagai aset rilis secara otomatis. Pengguna akhir Anda dapat langsung mengunduh versi rilis yang diinginkan dari tab **Releases** di GitHub.

---

## 📄 Lisensi

Aplikasi ini didistribusikan di bawah lisensi khusus **CraftThingy Digital Innovation**.
* **Gratis** digunakan untuk penggunaan pribadi, lembaga pendidikan, yayasan non-profit (nirlaba), dan UMKM/perusahaan dengan penghasilan kotor (revenue) tahunan di bawah **USD 1.000.000** atau setara dengan **Rp 15.000.000.000**.
* **Wajib Membayar Royalti & Berlisensi Komersial** bagi perusahaan atau entitas korporasi dengan penghasilan kotor tahunan sama dengan atau melebihi **USD 1.000.000** atau **Rp 15.000.000.000**.

Bagi korporat dengan penghasilan di atas batas tersebut, silakan hubungi kontak support berikut untuk pembelian lisensi resmi:
* **Kontak Lisensi**: Alif Nurhidayat
* **Email**: [alifnurhidayatwork@gmail.com](mailto:alifnurhidayatwork@gmail.com)
* **No. HP/WhatsApp**: +62 813-6889-8090
