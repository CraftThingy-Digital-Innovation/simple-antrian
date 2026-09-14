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
    { key: 'display_logo', value: '' },
    { key: 'video_playlist', value: JSON.stringify([]) },
    { key: 'display_mode', value: 'queue' },
    { key: 'mirror_window_name', value: '' },
    { key: 'mirror_crop_top', value: 'false' },
    { key: 'video_sidebar_muted', value: 'true' },
    { key: 'video_fullscreen_muted', value: 'false' },
    { key: 'color_theme', value: 'default' },
    { key: 'multilang_enabled', value: 'false' },
    { key: 'call_customer_name', value: 'true' },
    { key: 'auto_call_next_on_complete', value: 'true' }
  ];

  for (const s of defaultSettings) {
    const setting = await get("SELECT * FROM settings WHERE key = ?", [s.key]);
    if (!setting) {
      await run("INSERT INTO settings (key, value) VALUES (?, ?)", [s.key, s.value]);
    }
  }

  // Migrasi satu kali setting auto_call_next_on_complete ke 'true' agar tombol selesai otomatis memanggil antrian berikutnya
  const migratedAutoCall = await get("SELECT * FROM settings WHERE key = 'v158_auto_call_migrated'");
  if (!migratedAutoCall) {
    await run("UPDATE settings SET value = 'true' WHERE key = 'auto_call_next_on_complete'");
    await run("INSERT INTO settings (key, value) VALUES ('v158_auto_call_migrated', 'true')");
  }

  // Bersihkan tiket calling zombie dari sesi sebelumnya (jaga hanya 1 tiket calling terbaru per loket)
  try {
    await run(`
      UPDATE tickets 
      SET status = 'completed', completed_at = CURRENT_TIMESTAMP 
      WHERE status = 'calling' 
      AND id NOT IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (PARTITION BY service_id, desk_number ORDER BY called_at DESC) as rn 
          FROM tickets 
          WHERE status = 'calling'
        ) WHERE rn = 1
      )
    `);
  } catch (_) {}

  // 1. Eksekusi rollover harian (lewati tiket waiting kemarin & selesaikan calling kemarin)
  await handleDayRollover();

  // 2. Perbaiki tiket duplikat di antrian waiting jika ada dari versi sebelumnya
  await fixDuplicateWaitingTickets();
}

// ==================== PENANGANAN PERGANTIAN HARI & DUPLIKASI ====================

// Otomatis skip tiket waiting kemarin, selesaikan calling kemarin, dan reset current_number jika hari berganti
async function handleDayRollover() {
  try {
    let changed = false;

    // 1. Lewatkan (skip) antrian waiting dari hari-hari sebelumnya
    const skippedRes = await run(`
      UPDATE tickets 
      SET status = 'skipped' 
      WHERE status = 'waiting' 
        AND date(created_at, 'localtime') < date('now', 'localtime')
    `);
    if (skippedRes && skippedRes.changes > 0) changed = true;

    // 2. Selesaikan tiket calling dari hari-hari sebelumnya
    const completedRes = await run(`
      UPDATE tickets 
      SET status = 'completed', completed_at = CURRENT_TIMESTAMP 
      WHERE status = 'calling' 
        AND date(created_at, 'localtime') < date('now', 'localtime')
    `);
    if (completedRes && completedRes.changes > 0) changed = true;

    // 3. Sinkronisasikan current_number setiap layanan ke tiket terakhir yang dipanggil HARI INI
    // Jika belum ada tiket yang dipanggil hari ini, current_number kembali ke 0
    const allServices = await all("SELECT * FROM services");
    for (const srv of allServices) {
      const todayCalled = await get(
        `SELECT MAX(number_sequence) as max_seq 
         FROM tickets 
         WHERE service_id = ? 
           AND status IN ('calling', 'completed') 
           AND date(created_at, 'localtime') = date('now', 'localtime')`,
        [srv.id]
      );
      const todaySeq = (todayCalled && todayCalled.max_seq) ? Number(todayCalled.max_seq) : 0;
      if (srv.current_number !== todaySeq) {
        await run("UPDATE services SET current_number = ? WHERE id = ?", [todaySeq, srv.id]);
        changed = true;
      }
    }

    return changed;
  } catch (err) {
    console.error("handleDayRollover error:", err);
    return false;
  }
}

// Perbaiki duplikasi nomor tiket waiting yang sempat terbentuk di database
async function fixDuplicateWaitingTickets() {
  try {
    const allServices = await all("SELECT * FROM services");
    for (const srv of allServices) {
      const duplicates = await get(
        `SELECT COUNT(*) as dup_count 
         FROM (
           SELECT number_sequence, COUNT(*) as c 
           FROM tickets 
           WHERE service_id = ? 
             AND status = 'waiting' 
             AND date(created_at, 'localtime') = date('now', 'localtime') 
           GROUP BY number_sequence 
           HAVING c > 1
         )`,
        [srv.id]
      );

      if (duplicates && duplicates.dup_count > 0) {
        const lastServed = await get(
          `SELECT MAX(number_sequence) as max_seq 
           FROM tickets 
           WHERE service_id = ? 
             AND status IN ('calling', 'completed', 'skipped') 
             AND date(created_at, 'localtime') = date('now', 'localtime')`,
          [srv.id]
        );
        let baseSeq = Math.max(
          lastServed && lastServed.max_seq ? Number(lastServed.max_seq) : 0,
          srv.current_number ? Number(srv.current_number) : 0
        );

        const waitingTickets = await all(
          `SELECT id, number_sequence 
           FROM tickets 
           WHERE service_id = ? 
             AND status = 'waiting' 
             AND date(created_at, 'localtime') = date('now', 'localtime') 
           ORDER BY rowid ASC`,
          [srv.id]
        );

        for (const t of waitingTickets) {
          baseSeq++;
          const newTicketNum = `${srv.prefix}${String(baseSeq).padStart(3, '0')}`;
          await run(
            "UPDATE tickets SET number_sequence = ?, ticket_number = ? WHERE id = ?",
            [baseSeq, newTicketNum, t.id]
          );
        }
      }
    }
  } catch (err) {
    console.error("fixDuplicateWaitingTickets error:", err);
  }
}

// ==================== OPERASI LAYANAN (SERVICES) ====================

function getServices() {
  return all(`
    SELECT s.*, 
      (SELECT COUNT(*) FROM tickets t WHERE t.service_id = s.id AND t.status = 'waiting' AND date(t.created_at, 'localtime') = date('now', 'localtime')) as waiting_count,
      (SELECT COUNT(*) FROM tickets t WHERE t.service_id = s.id AND t.status = 'skipped' AND date(t.created_at, 'localtime') = date('now', 'localtime')) as skipped_count
    FROM services s
    ORDER BY s.prefix ASC
  `);
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
  const filterDate = dateStr || new Date().toLocaleDateString('sv-SE');
  return all(
    "SELECT t.*, s.name as service_name FROM tickets t JOIN services s ON t.service_id = s.id WHERE date(t.created_at, 'localtime') = date(?) ORDER BY t.created_at ASC",
    [filterDate]
  );
}

// Dapatkan tiket waiting hari ini
function getWaitingTickets() {
  return all(
    "SELECT t.*, s.name as service_name FROM tickets t JOIN services s ON t.service_id = s.id WHERE t.status = 'waiting' AND date(t.created_at, 'localtime') = date('now', 'localtime') ORDER BY t.number_sequence ASC"
  );
}

// Dapatkan tiket yang dipanggil hari ini
function getCallingTickets() {
  return all(
    "SELECT t.*, s.name as service_name FROM tickets t JOIN services s ON t.service_id = s.id WHERE t.status = 'calling' AND date(t.created_at, 'localtime') = date('now', 'localtime') ORDER BY t.called_at DESC"
  );
}

// Queue mutex untuk menjamin nomor tiket selalu unik & berurutan secara thread-safe
let ticketCreationQueue = Promise.resolve();

async function _createTicketInternal(serviceId, name, phone) {
  await handleDayRollover();

  const service = await get("SELECT * FROM services WHERE id = ?", [serviceId]);
  if (!service) throw new Error("Service not found");

  // Dapatkan sequence tertinggi untuk hari ini atau yang sedang aktif di antrian
  const today = new Date().toLocaleDateString('sv-SE');
  const lastTicket = await get(
    `SELECT MAX(number_sequence) as max_seq 
     FROM tickets 
     WHERE service_id = ? 
       AND (
         date(created_at, 'localtime') = date('now', 'localtime')
         OR date(created_at) = date('now')
         OR date(created_at, 'localtime') = date(?)
         OR date(created_at) = date(?)
         OR status IN ('waiting', 'calling')
       )`,
    [serviceId, today, today]
  );

  const maxTicketSeq = (lastTicket && lastTicket.max_seq) ? Number(lastTicket.max_seq) : 0;
  const currentServed = (service && service.current_number) ? Number(service.current_number) : 0;
  const nextSeq = Math.max(maxTicketSeq, currentServed) + 1;
  const ticketNumber = `${service.prefix}${String(nextSeq).padStart(3, '0')}`;
  const id = require('crypto').randomUUID();

  await run(
    "INSERT INTO tickets (id, service_id, ticket_number, number_sequence, customer_name, customer_phone, status) VALUES (?, ?, ?, ?, ?, ?, 'waiting')",
    [id, serviceId, ticketNumber, nextSeq, name || '', phone || '']
  );

  return get("SELECT t.*, s.name as service_name FROM tickets t JOIN services s ON t.service_id = s.id WHERE t.id = ?", [id]);
}

// Buat tiket baru (auto increment dengan jaminan sequence urut tanpa duplikasi)
function createTicket(serviceId, name, phone) {
  return new Promise((resolve, reject) => {
    ticketCreationQueue = ticketCreationQueue.then(async () => {
      try {
        const result = await _createTicketInternal(serviceId, name, phone);
        resolve(result);
      } catch (err) {
        reject(err);
      }
    });
  });
}

// Panggil antrian berikutnya
async function callNextTicket(serviceId, deskNumber) {
  await handleDayRollover();

  // Cari tiket waiting pertama hari ini
  const nextTicket = await get(
    "SELECT * FROM tickets WHERE service_id = ? AND status = 'waiting' AND date(created_at, 'localtime') = date('now', 'localtime') ORDER BY number_sequence ASC LIMIT 1",
    [serviceId]
  );

  if (!nextTicket) return null;

  const now = new Date().toISOString();

  // Selesaikan tiket calling sebelumnya di loket ini agar tidak ada zombie calling
  if (deskNumber) {
    await run(
      "UPDATE tickets SET status = 'completed', completed_at = ? WHERE desk_number = ? AND status = 'calling'",
      [now, deskNumber]
    );
  } else {
    await run(
      "UPDATE tickets SET status = 'completed', completed_at = ? WHERE service_id = ? AND status = 'calling'",
      [now, serviceId]
    );
  }

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

// Panggil antrian terlewat (skipped) pertama ke loket tertentu
async function callSkippedTicket(serviceId, deskNumber) {
  await handleDayRollover();

  const nextSkipped = await get(
    "SELECT * FROM tickets WHERE service_id = ? AND status = 'skipped' AND date(created_at, 'localtime') = date('now', 'localtime') ORDER BY created_at ASC LIMIT 1",
    [serviceId]
  );

  if (!nextSkipped) return null;

  const now = new Date().toISOString();

  // Selesaikan tiket calling sebelumnya di loket ini
  if (deskNumber) {
    await run(
      "UPDATE tickets SET status = 'completed', completed_at = ? WHERE desk_number = ? AND status = 'calling'",
      [now, deskNumber]
    );
  } else {
    await run(
      "UPDATE tickets SET status = 'completed', completed_at = ? WHERE service_id = ? AND status = 'calling'",
      [now, serviceId]
    );
  }

  await run(
    "UPDATE tickets SET status = 'calling', desk_number = ?, called_at = ? WHERE id = ?",
    [deskNumber, now, nextSkipped.id]
  );

  return get("SELECT t.*, s.name as service_name FROM tickets t JOIN services s ON t.service_id = s.id WHERE t.id = ?", [nextSkipped.id]);
}

// Selesaikan semua tiket yang berstatus calling untuk loket/layanan tertentu (mencegah zombie)
async function completeCallingTicketsByDesk(deskNumber, serviceId = null) {
  const now = new Date().toISOString();
  if (deskNumber) {
    await run(
      "UPDATE tickets SET status = 'completed', completed_at = ? WHERE desk_number = ? AND status = 'calling'",
      [now, deskNumber]
    );
  }
  if (serviceId) {
    await run(
      "UPDATE tickets SET status = 'completed', completed_at = ? WHERE service_id = ? AND status = 'calling'",
      [now, serviceId]
    );
  }
}

// Panggil ulang antrian (recall)
async function recallTicket(ticketId) {
  const ticket = await get("SELECT * FROM tickets WHERE id = ?", [ticketId]);
  if (!ticket) return null;

  const now = new Date().toISOString();
  await run("UPDATE tickets SET called_at = ? WHERE id = ?", [now, ticketId]);

  return get("SELECT t.*, s.name as service_name FROM tickets t JOIN services s ON t.service_id = s.id WHERE t.id = ?", [ticketId]);
}

// Update desk number untuk tiket tertentu
async function updateTicketDesk(ticketId, deskNumber) {
  await run("UPDATE tickets SET desk_number = ? WHERE id = ?", [deskNumber, ticketId]);
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
  const dateFilter = dateStr || new Date().toLocaleDateString('sv-SE');

  const total = await get("SELECT COUNT(*) as count FROM tickets WHERE date(created_at, 'localtime') = date(?)", [dateFilter]);
  const completed = await get("SELECT COUNT(*) as count FROM tickets WHERE date(created_at, 'localtime') = date(?) AND status = 'completed'", [dateFilter]);
  const skipped = await get("SELECT COUNT(*) as count FROM tickets WHERE date(created_at, 'localtime') = date(?) AND status = 'skipped'", [dateFilter]);
  const waiting = await get("SELECT COUNT(*) as count FROM tickets WHERE date(created_at, 'localtime') = date(?) AND status = 'waiting'", [dateFilter]);

  // Rata-rata waktu tunggu (dari created_at ke called_at dalam detik)
  const avgWait = await get(`
    SELECT AVG(strftime('%s', called_at) - strftime('%s', created_at)) as avg_wait 
    FROM tickets 
    WHERE date(created_at, 'localtime') = date(?) AND called_at IS NOT NULL
  `, [dateFilter]);

  // Rata-rata waktu pelayanan (dari called_at ke completed_at dalam detik)
  const avgService = await get(`
    SELECT AVG(strftime('%s', completed_at) - strftime('%s', called_at)) as avg_serve 
    FROM tickets 
    WHERE date(created_at, 'localtime') = date(?) AND status = 'completed' AND called_at IS NOT NULL
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
    LEFT JOIN tickets t ON s.id = t.service_id AND date(t.created_at, 'localtime') = date(?)
    GROUP BY s.id
  `, [dateFilter]);

  // Statistik per jam untuk chart
  const hourlyStats = await all(`
    SELECT strftime('%H', created_at, 'localtime') as hour, COUNT(*) as count 
    FROM tickets 
    WHERE date(created_at, 'localtime') = date(?) 
    GROUP BY hour 
    ORDER BY hour ASC
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
    services: serviceStats,
    hourly: hourlyStats
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
  callSkippedTicket,
  recallTicket,
  updateTicketDesk,
  completeTicket,
  completeCallingTicketsByDesk,
  skipTicket,
  searchTickets,
  getSettings,
  saveSetting,
  getDailyStats,
  backupDatabase,
  restoreDatabase,
  handleDayRollover,
  fixDuplicateWaitingTickets
};
