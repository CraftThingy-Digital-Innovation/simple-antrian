# Usulan Arsitektur & Rekomendasi Framework Aplikasi Antrian Standalone

Dokumen ini disusun untuk membantu menentukan pilihan framework dan arsitektur teknis dalam membuat aplikasi antrian standalone dengan fitur dual-screen, client-server (auto-discovery), database tangguh, serta opsional integrasi WhatsApp.

---

## 1. Perbandingan Framework

Berikut adalah 3 opsi framework utama yang cocok untuk kebutuhan aplikasi yang ringan, standalone, dan lintas platform (Windows & Linux):

| Fitur / Parameter | **Opsi A: Tauri (Rust + Svelte/React)** *(Direkomendasikan)* | **Opsi B: Electron (Node.js + Svelte/React)** | **Opsi C: Python (PyQt6 / PySide6)** |
| :--- | :--- | :--- | :--- |
| **Ukuran Aplikasi** | **Sangat Kecil** (~10 - 20 MB) | **Besar** (~80 - 150 MB) | **Sedang** (~30 - 60 MB) |
| **Penggunaan RAM** | **Sangat Rendah** (~30 - 50 MB) | **Tinggi** (~150 MB+) | **Sedang** (~60 - 80 MB) |
| **UI/UX Aesthetics** | **Sangat Fleksibel & Premium** (HTML, CSS modern, Tailwind, Svelte/React) | **Sangat Fleksibel & Premium** (HTML, CSS modern, Tailwind, Svelte/React) | **Terbatas** (Qt Widgets/QML lebih kaku dan membutuhkan usaha ekstra untuk estetika modern) |
| **Dukungan Multi-Screen** | **Sangat Baik** (Tauri Window API dapat mendeteksi monitor dan menempatkan window layar kedua) | **Sangat Baik** (Electron Screen API) | **Sangat Baik** (QScreen API) |
| **Client-Server & Discovery** | **Sangat Baik** (Rust backend sangat cepat untuk server WebSocket/HTTP + UDP Multicast) | **Sangat Baik** (Node.js backend dengan Express/WS + UDP Multicast) | **Sangat Baik** (Python socket + FastAPI/Flask) |
| **Database** | SQLite (Sangat stabil via `tauri-plugin-sql` atau custom Rust integration) | SQLite (Via `better-sqlite3` atau `sqlite3` node-modules) | SQLite (Modul `sqlite3` bawaan Python) |
| **Kemudahan Build & Deploy** | Menghasilkan installer native (MSI, AppImage/DEB) tanpa perlu runtime external. | Menghasilkan installer native (NSI, DEB) tapi resource heavy. | Memerlukan PyInstaller untuk bundling, terkadang rawan terdeteksi false-positive oleh antivirus. |

### Rekomendasi: **Tauri (dengan Svelte atau React)**
* **Mengapa?** Tauri menggunakan system webview bawaan OS (WebView2 di Windows, WebKit di Linux), sehingga ukuran filenya sangat kecil dan hemat RAM. Rust sebagai backend menjamin performa server yang sangat cepat dan stabil pada mode server.

---

## 2. Arsitektur Teknis Fitur Utama

### A. Mode Dua Layar (Dual Screen Mode)
1. **Window Utama (Operator Panel)**: Menampilkan antarmuka pemanggilan antrian, input data baru, pencarian data, statistik, dan konfigurasi.
2. **Window Kedua (Customer Display)**: Menampilkan nomor antrian yang dipanggil, animasi, pemutar video/gambar iklan, dan daftar antrian menunggu.
3. **Mekanisme**:
   - Aplikasi menggunakan Screen API untuk mendeteksi jumlah monitor terhubung.
   - Jika terdeteksi monitor kedua (Extended), aplikasi secara otomatis membuka Window Kedua di koordinat monitor kedua tersebut secara *fullscreen*.
   - Jika hanya ada 1 monitor, Window Kedua dapat dibuka secara windowed (bisa di-drag manual) atau dinonaktifkan via Settings.

### B. Mode Client-Server & Auto Discovery (Tanpa Bentrok)
Untuk mendukung hingga 3 Server dan 3 Client di jaringan lokal yang sama tanpa bentrok, kita menggunakan protokol **UDP Multicast / mDNS**:

1. **Server Node**:
   - Setiap Server saat pertama kali dijalankan akan membuat **Server UUID** unik dan **Server Name** (misal: "Antrian Utama", "Antrian CS").
   - Server menjalankan HTTP/WebSocket server lokal di port tertentu (atau port dinamis jika port default terpakai).
   - Server secara periodik (misal tiap 2 detik) menyiarkan (broadcast) paket UDP Multicast berisi metadata: `{ "uuid": "SERVER_UUID", "name": "SERVER_NAME", "ip": "192.168.1.100", "port": 8080 }`.
2. **Client Node**:
   - Client mendengarkan (listen) pada grup UDP Multicast yang sama.
   - Client secara otomatis mengumpulkan daftar Server aktif di jaringan lokal.
   - Pada UI Client, pengguna dapat memilih Server mana yang ingin dihubungkan (misal: memilih "Antrian Utama").
   - Client berkomunikasi via WebSocket ke Server pilihan tersebut untuk sinkronisasi data antrian secara *real-time*.
   - **Tanpa Bentrok**: Karena setiap koneksi didasarkan pada Server UUID unik, beberapa pasang Server dan Client dapat berjalan di satu jaringan lokal yang sama tanpa saling mengganggu.

### C. Database Tangguh (Anti-Corrupt) & Robust
* **Pilihan**: **SQLite**. SQLite adalah database file-based yang sangat andal, mendukung transaksi ACID secara penuh (Atomic, Consistent, Isolated, Durable).
* **Fitur Tambahan untuk Robustness**:
   - Mengaktifkan mode **WAL (Write-Ahead Logging)** pada SQLite untuk memastikan database aman dari korupsi data meskipun terjadi mati listrik tiba-tiba.
   - **Auto-Save**: Setiap perubahan data (pembuatan tiket, update status antrian) langsung ditulis ke SQLite (tidak hanya di memori).
   - **Export/Import**: Menyediakan fitur backup satu tombol yang menduplikasi file `.db` ke folder pilihan pengguna, serta fitur ekspor data riwayat antrian ke format **CSV / JSON** untuk pelaporan.

### D. Integrasi WhatsApp (Opsional)
Untuk menjaga aplikasi tetap ringan dan tidak terbebani library browser headless yang berat (seperti Puppeteer pada `whatsapp-web.js`), diusulkan sistem **WhatsApp Gateway**:
1. **Metode Gateway HTTP**:
   - Di menu Settings, pengguna dapat mengaktifkan fitur WhatsApp.
   - Pengguna memasukkan **URL Gateway API** dan **API Key/Token** (bisa menggunakan penyedia layanan WA Gateway lokal seperti Fonnte, Ruangguru WA, atau server Baileys self-hosted yang dijalankan terpisah).
   - Pengguna menyusun template pesan (misal: `"Halo {{nama}}, antrian Anda {{nomor}} berjarak 3 antrian lagi. Silakan bersiap."`).
2. **Trigger Pengiriman**:
   - **Peringatan 3 Antrian**: Ketika nomor antrian yang aktif dipanggil adalah $X$, server secara otomatis mengirimkan request API WhatsApp ke tiket antrian nomor $X+3$ (jika nomor telepon diisi).
   - **Giliran Tiba**: Ketika nomor antrian tersebut dipanggil oleh operator, pesan WhatsApp dikirim kembali memberi tahu bahwa giliran mereka telah tiba.

---

## 3. Skema Database SQLite (Usulan)

```sql
-- Tabel Pengaturan Aplikasi
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Tabel Layanan / Kategori Antrian (contoh: Teller, Customer Service)
CREATE TABLE IF NOT EXISTS services (
    id TEXT PRIMARY KEY,          -- UUID atau kode pendek seperti 'A', 'B'
    name TEXT NOT NULL,           -- Nama Layanan
    prefix TEXT NOT NULL,         -- Prefix antrian (misal: "A", "B")
    current_number INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Tabel Tiket Antrian
CREATE TABLE IF NOT EXISTS tickets (
    id TEXT PRIMARY KEY,
    service_id TEXT NOT NULL,
    ticket_number TEXT NOT NULL,  -- Gabungan prefix + nomor, misal "A005"
    number_sequence INTEGER NOT NULL, -- Hanya nomor integer, misal 5
    customer_name TEXT,
    customer_phone TEXT,          -- Untuk WA Notifikasi
    status TEXT NOT NULL,         -- 'waiting', 'calling', 'completed', 'skipped'
    desk_number TEXT,             -- Loket yang memanggil (misal: "Loket 1")
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    called_at TIMESTAMP,
    completed_at TIMESTAMP,
    FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE CASCADE
);
```

---

## 4. Rencana Kerja Git Commit (Conventional Commits)

Semua perubahan kode akan dicatat di Git dengan aturan Conventional Commits berikut:
* `feat: <deskripsi>` - Untuk fitur baru (misal: `feat: implementasi auto-discovery menggunakan UDP Multicast`).
* `fix: <deskripsi>` - Untuk perbaikan bug (misal: `fix: perbaikan sinkronisasi nomor antrian saat client terputus`).
* `docs: <deskripsi>` - Untuk dokumentasi (misal: `docs: menambahkan petunjuk konfigurasi WhatsApp`).
* `style: <deskripsi>` - Untuk styling UI tanpa merubah logika (misal: `style: desain glassmorphism pada panel operator`).
* `refactor: <deskripsi>` - Untuk restrukturisasi kode tanpa mengubah fungsionalitas.
