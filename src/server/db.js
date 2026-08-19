const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

// Path database di folder data aplikasi (userData agar aman dari permission EPERM)
const dbDir = app ? path.join(app.getPath('userData'), 'data') : path.join(process.cwd(), 'data');
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}
const dbPath = path.join(dbDir, 'db.sqlite');

const db = new sqlite3.Database(dbPath);

// Helper function untuk query promise
function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ id: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

// Inisialisasi Database
async function initDb() {
  // Aktifkan mode WAL untuk performa tinggi & anti korup data
  await run("PRAGMA journal_mode=WAL;");
  await run("PRAGMA foreign_keys=ON;");

  // Buat tabel Settings
  await run(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Buat tabel Services (Layanan)
  await run(`
    CREATE TABLE IF NOT EXISTS services (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      prefix TEXT NOT NULL,
      current_number INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Buat tabel Tickets
  await run(`
    CREATE TABLE IF NOT EXISTS tickets (
      id TEXT PRIMARY KEY,
      service_id TEXT NOT NULL,
      ticket_number TEXT NOT NULL,
      number_sequence INTEGER NOT NULL,
      customer_name TEXT,
      customer_phone TEXT,
      status TEXT NOT NULL, -- 'waiting', 'calling', 'completed', 'skipped'
      desk_number TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      called_at TIMESTAMP,
      completed_at TIMESTAMP,
      FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE CASCADE
    );
  `);

  // Isi data layanan default jika kosong
  const existingServices = await all("SELECT * FROM services");
  if (existingServices.length === 0) {
    await run("INSERT INTO services (id, name, prefix, current_number) VALUES ('teller', 'Teller', 'A', 0)");
    await run("INSERT INTO services (id, name, prefix, current_number) VALUES ('cs', 'Customer Service', 'B', 0)");
  }

  // Inisialisasi nama server acak unik (Human Readable)
  const animals = ['Elang', 'Harimau', 'Singa', 'Lumba', 'Kancil', 'Merak', 'Garuda', 'Banteng', 'Panda', 'Koala', 'Kucing', 'Serigala', 'Rajawali', 'Cendrawasih'];
  const colors = ['Biru', 'Merah', 'Hijau', 'Emas', 'Perak', 'Putih', 'Abu', 'Jingga', 'Ungu', 'Cokelat', 'Kuning', 'Hitam'];
  const adjectives = ['Pintar', 'Cepat', 'Tangguh', 'Handal', 'Prima', 'Lancar', 'Aman', 'Kreatif', 'Agung', 'Hebat', 'Setia'];
  const randomServerName = `Server ${animals[Math.floor(Math.random() * animals.length)]} ${colors[Math.floor(Math.random() * colors.length)]} ${adjectives[Math.floor(Math.random() * adjectives.length)]}`;

  // Isi setting default
  const defaultSettings = [
    { key: 'server_name', value: randomServerName },
    { key: 'server_uuid', value: require('crypto').randomUUID() },
    { key: 'port', value: '8080' },
    { key: 'wa_enabled', value: 'false' },
    { key: 'wa_gateway_url', value: '' },
    { key: 'wa_token', value: '' },
    { key: 'wa_template_wait', value: 'Halo {{name}}, antrian Anda {{ticket}} berjarak {{waiting}} antrian lagi. Silakan bersiap-siap.' },
    { key: 'wa_template_call', value: 'Halo {{name}}, antrian Anda {{ticket}} sedang dipanggil ke {{desk}}.' },
    {
      key: 'running_texts',
      value: JSON.stringify([
        'Selamat Datang di Layanan Kami. Budayakan Mengantri dengan Tertib demi Kenyamanan Bersama. Terima kasih atas kerja sama Anda.',
        'Welcome to Our Service. Please Queue in an Orderly Manner for Everyone\'s Comfort. Thank you for your cooperation.',
        '欢迎光临我们的服务中心。请遵守秩序排队，共同维护良好环境。感谢您的配合。'
      ])
    },
    { key: 'tts_enabled', value: 'true' },
    { key: 'display_title', value: 'SimpleAntrian' },
    { key: 'display_subtitle', value: 'Budayakan antri demi kenyamanan bersama. \nSilakan siapkan tiket Anda dan perhatikan panggilan layar.' },
    { key: 'display_logo', value: '' }
  ];

  for (const s of defaultSettings) {
    const setting = await get("SELECT * FROM settings WHERE key = ?", [s.key]);
    if (!setting) {
      await run("INSERT INTO settings (key, value) VALUES (?, ?)", [s.key, s.value]);
    }
  }
}

// ==================== OPERASI LAYANAN (SERVICES) ====================

function getServices() {
  return all("SELECT * FROM services ORDER BY prefix ASC");
}

function getServiceById(id) {
  return get("SELECT * FROM services WHERE id = ?", [id]);
}

async function addService(id, name, prefix) {
  const cleanId = id.toLowerCase().replace(/[^a-z0-9]/g, '_');
  await run("INSERT INTO services (id, name, prefix, current_number) VALUES (?, ?, ?, 0)", [cleanId, name, prefix.toUpperCase()]);
  return getServiceById(cleanId);
}

async function updateService(id, name, prefix) {
  await run("UPDATE services SET name = ?, prefix = ? WHERE id = ?", [name, prefix.toUpperCase(), id]);
  return getServiceById(id);
}

async function deleteService(id) {
  await run("DELETE FROM services WHERE id = ?", [id]);
}

// Reset semua antrian
async function resetAllQueues() {
  await run("UPDATE services SET current_number = 0");
  await run("DELETE FROM tickets");
}

// ==================== OPERASI TIKET (TICKETS) ====================

// Dapatkan tiket hari ini / tanggal tertentu
function getTickets(dateStr = null) {
  const filterDate = dateStr || new Date().toISOString().split('T')[0];
  return all(
    "SELECT t.*, s.name as service_name FROM tickets t JOIN services s ON t.service_id = s.id WHERE date(t.created_at) = date(?) ORDER BY t.created_at ASC",
    [filterDate]
  );
}

// Dapatkan tiket waiting
function getWaitingTickets() {
  return all(
    "SELECT t.*, s.name as service_name FROM tickets t JOIN services s ON t.service_id = s.id WHERE t.status = 'waiting' ORDER BY t.number_sequence ASC"
  );
}

// Dapatkan tiket yang dipanggil saat ini
function getCallingTickets() {
  return all(
    "SELECT t.*, s.name as service_name FROM tickets t JOIN services s ON t.service_id = s.id WHERE t.status = 'calling' ORDER BY t.called_at DESC"
  );
}

// Buat tiket baru (auto increment)
async function createTicket(serviceId, name, phone) {
  const service = await get("SELECT * FROM services WHERE id = ?", [serviceId]);
  if (!service) throw new Error("Service not found");

  // Dapatkan sequence terakhir untuk hari ini
  const today = new Date().toISOString().split('T')[0];
  const lastTicket = await get(
    "SELECT MAX(number_sequence) as max_seq FROM tickets WHERE service_id = ? AND date(created_at) = date(?)",
    [serviceId, today]
  );

  const nextSeq = (lastTicket && lastTicket.max_seq ? lastTicket.max_seq : 0) + 1;
  const ticketNumber = `${service.prefix}${String(nextSeq).padStart(3, '0')}`;
  const id = require('crypto').randomUUID();

  await run(
    "INSERT INTO tickets (id, service_id, ticket_number, number_sequence, customer_name, customer_phone, status) VALUES (?, ?, ?, ?, ?, ?, 'waiting')",
    [id, serviceId, ticketNumber, nextSeq, name || '', phone || '']
  );

  return get("SELECT t.*, s.name as service_name FROM tickets t JOIN services s ON t.service_id = s.id WHERE t.id = ?", [id]);
}

// Panggil antrian berikutnya
async function callNextTicket(serviceId, deskNumber) {
  // Cari tiket waiting pertama
  const nextTicket = await get(
    "SELECT * FROM tickets WHERE service_id = ? AND status = 'waiting' ORDER BY number_sequence ASC LIMIT 1",
    [serviceId]
  );

  if (!nextTicket) return null;

  const now = new Date().toISOString();
  await run(
    "UPDATE tickets SET status = 'calling', desk_number = ?, called_at = ? WHERE id = ?",
    [deskNumber, now, nextTicket.id]
  );

  // Update current_number di service
  await run(
    "UPDATE services SET current_number = ? WHERE id = ?",
    [nextTicket.number_sequence, serviceId]
  );

  return get("SELECT t.*, s.name as service_name FROM tickets t JOIN services s ON t.service_id = s.id WHERE t.id = ?", [nextTicket.id]);
}

// Panggil ulang antrian (recall)
async function recallTicket(ticketId) {
  const ticket = await get("SELECT * FROM tickets WHERE id = ?", [ticketId]);
  if (!ticket) return null;

  const now = new Date().toISOString();
  await run("UPDATE tickets SET called_at = ? WHERE id = ?", [now, ticketId]);

  return get("SELECT t.*, s.name as service_name FROM tickets t JOIN services s ON t.service_id = s.id WHERE t.id = ?", [ticketId]);
}

// Selesaikan tiket
async function completeTicket(ticketId) {
  const now = new Date().toISOString();
  await run("UPDATE tickets SET status = 'completed', completed_at = ? WHERE id = ?", [now, ticketId]);
  return get("SELECT t.*, s.name as service_name FROM tickets t JOIN services s ON t.service_id = s.id WHERE t.id = ?", [ticketId]);
}

// Lewati tiket
async function skipTicket(ticketId) {
  const now = new Date().toISOString();
  await run("UPDATE tickets SET status = 'skipped', completed_at = ? WHERE id = ?", [now, ticketId]);
  return get("SELECT t.*, s.name as service_name FROM tickets t JOIN services s ON t.service_id = s.id WHERE t.id = ?", [ticketId]);
}

// Cari dan Filter tiket
function searchTickets(query = '', status = '', serviceId = '', dateStr = '') {
  let sql = `
    SELECT t.*, s.name as service_name 
    FROM tickets t 
    JOIN services s ON t.service_id = s.id 
    WHERE 1=1
  `;
  const params = [];

  if (dateStr) {
    sql += " AND date(t.created_at) = date(?)";
    params.push(dateStr);
  } else {
    sql += " AND date(t.created_at) = date('now', 'localtime')";
  }

  if (status) {
    sql += " AND t.status = ?";
    params.push(status);
  }

  if (serviceId) {
    sql += " AND t.service_id = ?";
    params.push(serviceId);
  }

  if (query) {
    sql += " AND (t.ticket_number LIKE ? OR t.customer_name LIKE ? OR t.customer_phone LIKE ?)";
    const likeVal = `%${query}%`;
    params.push(likeVal, likeVal, likeVal);
  }

  sql += " ORDER BY t.created_at DESC";
  return all(sql, params);
}

// ==================== OPERASI SETTINGS ====================

async function getSettings() {
  const rows = await all("SELECT * FROM settings");
  const config = {};
  rows.forEach(r => {
    config[r.key] = r.value;
  });
  return config;
}

async function saveSetting(key, value) {
  await run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, String(value)]);
}

// ==================== STATISTIK ====================

async function getDailyStats(dateStr = null) {
  const dateFilter = dateStr || new Date().toISOString().split('T')[0];

  const total = await get("SELECT COUNT(*) as count FROM tickets WHERE date(created_at) = date(?)", [dateFilter]);
  const completed = await get("SELECT COUNT(*) as count FROM tickets WHERE date(created_at) = date(?) AND status = 'completed'", [dateFilter]);
  const skipped = await get("SELECT COUNT(*) as count FROM tickets WHERE date(created_at) = date(?) AND status = 'skipped'", [dateFilter]);
  const waiting = await get("SELECT COUNT(*) as count FROM tickets WHERE date(created_at) = date(?) AND status = 'waiting'", [dateFilter]);

  // Rata-rata waktu tunggu (dari created_at ke called_at dalam detik)
  const avgWait = await get(`
    SELECT AVG(strftime('%s', called_at) - strftime('%s', created_at)) as avg_wait 
    FROM tickets 
    WHERE date(created_at) = date(?) AND called_at IS NOT NULL
  `, [dateFilter]);

  // Rata-rata waktu pelayanan (dari called_at ke completed_at dalam detik)
  const avgService = await get(`
    SELECT AVG(strftime('%s', completed_at) - strftime('%s', called_at)) as avg_serve 
    FROM tickets 
    WHERE date(created_at) = date(?) AND status = 'completed' AND called_at IS NOT NULL
  `, [dateFilter]);

  // Statistik per layanan
  const serviceStats = await all(`
    SELECT 
      s.id, 
      s.name, 
      s.prefix,
      COUNT(t.id) as total,
      SUM(CASE WHEN t.status = 'completed' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN t.status = 'skipped' THEN 1 ELSE 0 END) as skipped,
      SUM(CASE WHEN t.status = 'waiting' THEN 1 ELSE 0 END) as waiting
    FROM services s
    LEFT JOIN tickets t ON s.id = t.service_id AND date(t.created_at) = date(?)
    GROUP BY s.id
  `, [dateFilter]);

  return {
    date: dateFilter,
    summary: {
      total: total.count || 0,
      completed: completed.count || 0,
      skipped: skipped.count || 0,
      waiting: waiting.count || 0,
      avg_wait_seconds: Math.round(avgWait.avg_wait || 0),
      avg_service_seconds: Math.round(avgService.avg_serve || 0)
    },
    services: serviceStats
  };
}

// ==================== EXPORT / IMPORT ====================

// Ekspor seluruh database ke file backup
function backupDatabase(destPath) {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      // Menutup journal mode WAL sementara sebelum backup agar file utama komplit
      db.run("PRAGMA wal_checkpoint(TRUNCATE);", (err) => {
        if (err) return reject(err);
        fs.copyFile(dbPath, destPath, (copyErr) => {
          if (copyErr) reject(copyErr);
          else resolve();
        });
      });
    });
  });
}

// Impor seluruh database dari file backup
async function restoreDatabase(srcPath) {
  // Tutup koneksi saat ini
  await new Promise((resolve) => db.close(() => resolve()));

  // Salin file backup ke file db utama
  await new Promise((resolve, reject) => {
    fs.copyFile(srcPath, dbPath, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });

  // Hubungkan kembali ke modul-scoped db (bukan global.db)
  const newDb = new sqlite3.Database(dbPath);
  // Override reference internal helper functions agar mengarah ke koneksi baru
  db.run = newDb.run.bind(newDb);
  db.get = newDb.get.bind(newDb);
  db.all = newDb.all.bind(newDb);
  db.serialize = newDb.serialize.bind(newDb);
  db.close = newDb.close.bind(newDb);
  // Re-enable WAL
  await run("PRAGMA journal_mode=WAL;");
  await run("PRAGMA foreign_keys=ON;");
}

module.exports = {
  dbPath,
  initDb,
  getServices,
  getServiceById,
  addService,
  updateService,
  deleteService,
  resetAllQueues,
  getTickets,
  getWaitingTickets,
  getCallingTickets,
  createTicket,
  callNextTicket,
  recallTicket,
  completeTicket,
  skipTicket,
  searchTickets,
  getSettings,
  saveSetting,
  getDailyStats,
  backupDatabase,
  restoreDatabase
};
