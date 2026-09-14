const dgram = require('dgram');
const os = require('os');

const MULTICAST_ADDR = '239.255.255.250'; // SSDP standard multicast address
const MULTICAST_PORT = 41234;
const DISCOVERY_QUERY_TYPE = 'discover';
const DISCOVERY_PING_TYPE = 'ping';

let clientSocket = null;
let serverSocket = null;
let broadcastInterval = null;
let discoveredServers = {};

let currentServerUuid = '';
let currentServerName = 'Server Antrian';
let currentWsPort = 8080;

/**
 * Mendapatkan semua interface IPv4 non-internal dengan prioritas:
 * 1. Interface Wi-Fi / Ethernet fisik (192.168.x.x, 10.x.x.x) -> Prioritas tertinggi
 * 2. Mengabaikan 169.254.x.x (APIPA / link-local)
 * 3. Menurunkan prioritas virtual/VPN adapters (Tailscale, WARP, Hamachi, VirtualBox, WSL, Hyper-V)
 */
function getAllValidIPv4Interfaces() {
  const interfaces = os.networkInterfaces();
  const results = [];

  for (const [name, list] of Object.entries(interfaces)) {
    for (const item of list) {
      const isIPv4 = item.family === 'IPv4' || item.family === 4;
      if (!isIPv4 || item.internal) continue;
      // Filter out APIPA / auto-IP (169.254.x.x) and unconfigured
      if (item.address.startsWith('169.254.') || item.address.startsWith('0.')) continue;

      const lowerName = name.toLowerCase();
      let priority = 10;

      // Turunkan prioritas virtual / VPN / container adapters
      if (/tailscale|warp|cloudflare|hamachi|vethernet|virtualbox|vmware|hyper-v|docker|wsl|tap|tun|loopback|bluetooth/.test(lowerName)) {
        priority = 1;
      } else if (/wi-fi|wifi|wlan|ethernet|lan|eth|en0|wlan0/.test(lowerName)) {
        priority = 35;
      }

      // Rentang IP private LAN standar (rumah / kantor)
      if (item.address.startsWith('192.168.')) {
        priority += 15;
      } else if (item.address.startsWith('10.')) {
        priority += 10;
      } else if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(item.address)) {
        priority += 5;
      }

      results.push({
        name,
        address: item.address,
        netmask: item.netmask || '255.255.255.0',
        priority
      });
    }
  }

  results.sort((a, b) => b.priority - a.priority);
  return results;
}

/**
 * Hitung subnet broadcast address berdasarkan IP dan Netmask
 * Contoh: IP 192.168.0.175 + Netmask 255.255.255.0 -> 192.168.0.255
 */
function calculateBroadcast(ip, netmask) {
  try {
    const ipParts = ip.split('.').map(Number);
    const maskParts = netmask.split('.').map(Number);
    if (ipParts.length !== 4 || maskParts.length !== 4) return '255.255.255.255';
    const broadcastParts = [];
    for (let i = 0; i < 4; i++) {
      broadcastParts.push((ipParts[i] & maskParts[i]) | (~maskParts[i] & 255));
    }
    return broadcastParts.join('.');
  } catch (e) {
    return '255.255.255.255';
  }
}

// Helper untuk mendapatkan IP lokal prioritas tertinggi (Wi-Fi/LAN)
function getLocalIp() {
  const ifaces = getAllValidIPv4Interfaces();
  if (ifaces.length > 0) {
    return ifaces[0].address;
  }
  return '127.0.0.1';
}

// Helper untuk mendapatkan daftar semua IP lokal aktif
function getAllLocalIps() {
  const ifaces = getAllValidIPv4Interfaces();
  if (ifaces.length > 0) {
    return ifaces.map(i => ({ name: i.name, ip: i.address }));
  }
  return [{ name: 'Loopback', ip: '127.0.0.1' }];
}

// ==================== SERVER MODE: BROADCASTER ====================

function startBroadcaster(serverUuid, serverName, wsPort) {
  if (serverSocket) stopBroadcaster();

  currentServerUuid = serverUuid;
  currentServerName = serverName || 'Server Antrian';
  currentWsPort = wsPort || 8080;

  serverSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  // Dengarkan pesan masuk ke socket server (seperti request 'discover' dari client yang baru nyala)
  serverSocket.on('message', (msg, rinfo) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.type === DISCOVERY_QUERY_TYPE) {
        // Balas langsung secara instan ke pengirim dan kirim broadcast ping
        sendDirectAnnouncement(rinfo.address, rinfo.port);
        broadcastPing();
      }
    } catch (e) {}
  });

  serverSocket.on('error', (err) => {
    console.error('[UDP Broadcaster Error]', err);
  });

  serverSocket.bind(MULTICAST_PORT, () => {
    try {
      serverSocket.setBroadcast(true);
      serverSocket.setMulticastLoopback(true);
      serverSocket.setMulticastTTL(128);

      // Bergabung dengan grup multicast di semua interface yang valid
      const ifaces = getAllValidIPv4Interfaces();
      try {
        serverSocket.addMembership(MULTICAST_ADDR);
      } catch (e) {}

      ifaces.forEach(iface => {
        try {
          serverSocket.addMembership(MULTICAST_ADDR, iface.address);
        } catch (e) {}
      });
    } catch (e) {
      console.error('Failed to configure server socket options:', e);
    }

    // Kirim siaran pertama segera setelah bind
    broadcastPing();
  });

  // Kirim broadcast berkala setiap 2 detik
  broadcastInterval = setInterval(() => {
    broadcastPing();
  }, 2000);

  console.log(`UDP Broadcaster started for server "${currentServerName}" [${currentServerUuid}] on ${getLocalIp()}:${currentWsPort}`);
}

function updateBroadcasterDetails(serverName, wsPort) {
  if (serverName) currentServerName = serverName;
  if (wsPort) currentWsPort = wsPort;
  if (serverSocket) {
    broadcastPing();
  }
}

/**
 * Mengirim paket ping ke seluruh jalur:
 * 1. Multicast SSDP (239.255.255.250)
 * 2. Global UDP Broadcast (255.255.255.255)
 * 3. Subnet Broadcast tiap adapter (misal 192.168.0.255)
 * 4. Multicast via interface routing eksplisit (setMulticastInterface)
 */
function broadcastPing() {
  if (!serverSocket) return;

  const ifaces = getAllValidIPv4Interfaces();
  const primaryIp = ifaces.length > 0 ? ifaces[0].address : getLocalIp();
  const allIps = ifaces.map(i => i.address);

  const payload = JSON.stringify({
    type: DISCOVERY_PING_TYPE,
    serverUuid: currentServerUuid,
    serverName: currentServerName,
    ip: primaryIp,
    port: currentWsPort,
    addresses: allIps,
    timestamp: Date.now()
  });

  const message = Buffer.from(payload);

  // 1. Multicast umum
  try {
    serverSocket.send(message, 0, message.length, MULTICAST_PORT, MULTICAST_ADDR);
  } catch (err) {}

  // 2. Global Broadcast (255.255.255.255)
  try {
    serverSocket.send(message, 0, message.length, MULTICAST_PORT, '255.255.255.255');
  } catch (err) {}

  // 3. Subnet Broadcast untuk setiap interface fisik LAN / Wi-Fi
  ifaces.forEach(iface => {
    const subnetBcast = calculateBroadcast(iface.address, iface.netmask);
    if (subnetBcast && subnetBcast !== '255.255.255.255') {
      try {
        serverSocket.send(message, 0, message.length, MULTICAST_PORT, subnetBcast);
      } catch (err) {}
    }

    // Multicast eksplisit lewat kartu jaringan ini
    try {
      serverSocket.setMulticastInterface(iface.address);
      serverSocket.send(message, 0, message.length, MULTICAST_PORT, MULTICAST_ADDR);
    } catch (err) {}
  });
}

function sendDirectAnnouncement(targetIp, targetPort) {
  if (!serverSocket) return;
  const ifaces = getAllValidIPv4Interfaces();
  const primaryIp = ifaces.length > 0 ? ifaces[0].address : getLocalIp();

  const payload = JSON.stringify({
    type: DISCOVERY_PING_TYPE,
    serverUuid: currentServerUuid,
    serverName: currentServerName,
    ip: primaryIp,
    port: currentWsPort,
    addresses: ifaces.map(i => i.address),
    timestamp: Date.now()
  });

  const message = Buffer.from(payload);
  try {
    serverSocket.send(message, 0, message.length, targetPort || MULTICAST_PORT, targetIp);
  } catch (err) {}
}

function stopBroadcaster() {
  if (broadcastInterval) {
    clearInterval(broadcastInterval);
    broadcastInterval = null;
  }
  if (serverSocket) {
    try {
      serverSocket.close();
    } catch (e) {}
    serverSocket = null;
  }
  console.log('UDP Broadcaster stopped.');
}

// ==================== CLIENT MODE: LISTENER ====================

function startDiscoveryListener(onServersUpdated) {
  if (clientSocket) stopDiscoveryListener();

  discoveredServers = {};
  clientSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  clientSocket.on('message', (msg, rinfo) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.type === DISCOVERY_PING_TYPE && data.serverUuid) {
        // Resolusi IP terbaik untuk mencapai server:
        // Prioritaskan IP rinfo.address jika rinfo adalah private LAN yang valid
        let bestIp = data.ip;
        const isLoopbackOrLinkLocal = !bestIp || bestIp.startsWith('127.') || bestIp.startsWith('169.254.');
        if (isLoopbackOrLinkLocal && rinfo.address && !rinfo.address.startsWith('127.')) {
          bestIp = rinfo.address;
        }

        if (rinfo.address && (rinfo.address.startsWith('192.168.') || rinfo.address.startsWith('10.'))) {
          if (!bestIp || bestIp.startsWith('172.') || bestIp.startsWith('169.254.')) {
            bestIp = rinfo.address;
          }
        }

        // Simpan atau update info server
        discoveredServers[data.serverUuid] = {
          uuid: data.serverUuid,
          name: data.serverName || 'Server Antrian',
          ip: bestIp,
          port: data.port || 8080,
          rinfoAddress: rinfo.address,
          addresses: data.addresses || [bestIp],
          lastSeen: Date.now()
        };

        if (typeof onServersUpdated === 'function') {
          onServersUpdated(getDiscoveredServersList());
        }
      }
    } catch (err) {
      // Abaikan paket tidak valid
    }
  });

  clientSocket.on('error', (err) => {
    console.error('[UDP Discovery Listener Error]', err);
  });

  clientSocket.bind(MULTICAST_PORT, () => {
    try {
      clientSocket.setBroadcast(true);
      const ifaces = getAllValidIPv4Interfaces();

      // Join multicast pada interface default dan semua interface LAN/Wi-Fi
      try { clientSocket.addMembership(MULTICAST_ADDR); } catch (e) {}

      ifaces.forEach(iface => {
        try {
          clientSocket.addMembership(MULTICAST_ADDR, iface.address);
        } catch (e) {}
      });
    } catch (e) {
      console.error('Failed to bind client membership to multicast group:', e);
    }

    // Segera kirim permintaan pencarian (discovery query) aktif
    sendDiscoveryQuery();
  });

  // Interval pembersihan server offline (tidak aktif dalam 8 detik)
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    let updated = false;

    for (const uuid of Object.keys(discoveredServers)) {
      if (now - discoveredServers[uuid].lastSeen > 8000) {
        delete discoveredServers[uuid];
        updated = true;
      }
    }

    if (updated && typeof onServersUpdated === 'function') {
      onServersUpdated(getDiscoveredServersList());
    }
  }, 3000);

  clientSocket.cleanupInterval = cleanupInterval;
  console.log('UDP Discovery Listener started on port', MULTICAST_PORT);
}

/**
 * Mengirim query pencarian aktif ke seluruh jaringan agar server merespons instan
 */
function sendDiscoveryQuery() {
  if (!clientSocket) return;

  const payload = JSON.stringify({
    type: DISCOVERY_QUERY_TYPE,
    timestamp: Date.now()
  });
  const message = Buffer.from(payload);

  // 1. Kirim ke multicast SSDP
  try {
    clientSocket.send(message, 0, message.length, MULTICAST_PORT, MULTICAST_ADDR);
  } catch (e) {}

  // 2. Kirim ke Global Broadcast
  try {
    clientSocket.send(message, 0, message.length, MULTICAST_PORT, '255.255.255.255');
  } catch (e) {}

  // 3. Kirim ke Subnet Broadcast tiap interface
  const ifaces = getAllValidIPv4Interfaces();
  ifaces.forEach(iface => {
    const subnetBcast = calculateBroadcast(iface.address, iface.netmask);
    if (subnetBcast && subnetBcast !== '255.255.255.255') {
      try {
        clientSocket.send(message, 0, message.length, MULTICAST_PORT, subnetBcast);
      } catch (e) {}
    }
  });
}

function stopDiscoveryListener() {
  if (clientSocket) {
    if (clientSocket.cleanupInterval) {
      clearInterval(clientSocket.cleanupInterval);
    }
    try {
      clientSocket.close();
    } catch (e) {}
    clientSocket = null;
  }
  discoveredServers = {};
  console.log('UDP Discovery Listener stopped.');
}

function getDiscoveredServersList() {
  return Object.values(discoveredServers);
}

module.exports = {
  startBroadcaster,
  stopBroadcaster,
  updateBroadcasterDetails,
  startDiscoveryListener,
  stopDiscoveryListener,
  sendDiscoveryQuery,
  getDiscoveredServersList,
  getLocalIp,
  getAllLocalIps
};
