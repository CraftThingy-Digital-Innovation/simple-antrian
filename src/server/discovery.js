const dgram = require('dgram');
const http = require('http');
const os = require('os');

const MULTICAST_ADDR = '239.255.255.250'; // SSDP standard multicast address
const MULTICAST_PORT = 41234;
const DISCOVERY_QUERY_TYPE = 'discover';
const DISCOVERY_PING_TYPE = 'ping';

let clientSocket = null;
let clientPhysicalSockets = [];
let serverSocket = null;
let broadcastInterval = null;
let activeSweepInterval = null;
let discoveredServers = {};
let knownServerEndpoints = new Set();
let onServersUpdatedCallback = null;

let currentServerUuid = '';
let currentServerName = 'Server Antrian';
let currentWsPort = 8080;

/**
 * Mendapatkan semua interface IPv4 non-internal dengan prioritas:
 * 1. Interface Wi-Fi / Ethernet fisik (192.168.x.x, 10.x.x.x) -> Prioritas tertinggi
 * 2. Mengabaikan 169.254.x.x (APIPA / link-local)
 * 3. Menandai virtual/VPN adapters (FortiClient, Cloudflare WARP, Tailscale, Hamachi, VirtualBox, WSL, Hyper-V)
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
      let isVpn = false;

      // Deteksi adapter virtual / VPN / container
      if (/tailscale|warp|cloudflare|forti|fortinet|hamachi|vethernet|virtualbox|vmware|hyper-v|docker|wsl|tap|tun|loopback|bluetooth|vpn|wireguard|pstorm|zerotier/i.test(lowerName)) {
        priority = 1;
        isVpn = true;
      } else if (/wi-fi|wifi|wlan|ethernet|lan|eth|en0|wlan0|local area connection/i.test(lowerName)) {
        priority = 40;
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
        isVpn,
        priority
      });
    }
  }

  results.sort((a, b) => b.priority - a.priority);
  return results;
}

/**
 * Hitung subnet broadcast address berdasarkan IP dan Netmask
 */
function calculateBroadcast(ip, netmask) {
  try {
    const ipParts = ip.split('.').map(Number);
    const maskParts = (netmask || '255.255.255.0').split('.').map(Number);
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

/**
 * Kirim paket UDP secara eksplisit lewat kartu jaringan fisik tertentu.
 * Mengikat socket ke IP lokal adapter (ifaceAddress) memaksa Windows melewati kartu jaringan fisik
 * tersebut dan tidak terbelokkan ke default route VPN (FortiClient / Cloudflare WARP).
 */
function sendPacketViaInterface(ifaceAddress, targetAddress, port, message) {
  try {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.bind(0, ifaceAddress, () => {
      try {
        sock.setBroadcast(true);
        sock.send(message, 0, message.length, port, targetAddress, () => {
          try { sock.close(); } catch (_) {}
        });
      } catch (e) {
        try { sock.close(); } catch (_) {}
      }
    });
    sock.on('error', () => {
      try { sock.close(); } catch (_) {}
    });
  } catch (_) {}
}

// ==================== SERVER MODE: BROADCASTER ====================

function startBroadcaster(serverUuid, serverName, wsPort) {
  if (serverSocket) stopBroadcaster();

  currentServerUuid = serverUuid;
  currentServerName = serverName || 'Server Antrian';
  currentWsPort = wsPort || 8080;

  serverSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  // Dengarkan pesan masuk ke socket server (termasuk direct unicast query dari client di beda AP/subnet)
  serverSocket.on('message', (msg, rinfo) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.type === DISCOVERY_QUERY_TYPE) {
        // Balas langsung secara instan via UNICAST ke pengirim
        sendDirectAnnouncement(rinfo.address, rinfo.port || MULTICAST_PORT);
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

      const ifaces = getAllValidIPv4Interfaces();
      try { serverSocket.addMembership(MULTICAST_ADDR); } catch (e) {}

      ifaces.forEach(iface => {
        try {
          serverSocket.addMembership(MULTICAST_ADDR, iface.address);
        } catch (e) {}
      });
    } catch (e) {
      console.error('Failed to configure server socket options:', e);
    }

    broadcastPing();
  });

  // Kirim broadcast berkala setiap 2 detik
  broadcastInterval = setInterval(() => {
    broadcastPing();
  }, 2000);

  console.log(`[Discovery] Broadcaster started for server "${currentServerName}" [${currentServerUuid}] on ${getLocalIp()}:${currentWsPort}`);
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
 * 4. Pengiriman langsung lewat socket tiap interface fisik (Bypass VPN / WARP)
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

    try {
      serverSocket.setMulticastInterface(iface.address);
      serverSocket.send(message, 0, message.length, MULTICAST_PORT, MULTICAST_ADDR);
    } catch (err) {}

    // BIND LANGSUNG KE INTERFACE FISIK AGAR TIDAK DIBELOKKAN OLEH WARP / FORTICLIENT
    if (!iface.isVpn) {
      sendPacketViaInterface(iface.address, subnetBcast, MULTICAST_PORT, message);
      sendPacketViaInterface(iface.address, '255.255.255.255', MULTICAST_PORT, message);
      sendPacketViaInterface(iface.address, MULTICAST_ADDR, MULTICAST_PORT, message);
    }
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

  // Kirim juga via socket adapter fisik jika ada
  ifaces.filter(i => !i.isVpn).forEach(iface => {
    sendPacketViaInterface(iface.address, targetIp, targetPort || MULTICAST_PORT, message);
  });
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
  console.log('[Discovery] Broadcaster stopped.');
}

// ==================== CLIENT MODE: LISTENER ====================

function startDiscoveryListener(onServersUpdated) {
  if (clientSocket) stopDiscoveryListener();

  onServersUpdatedCallback = onServersUpdated;
  discoveredServers = {};
  clientSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  const handleIncomingMessage = (msg, rinfo) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.type === DISCOVERY_PING_TYPE && data.serverUuid) {
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

        discoveredServers[data.serverUuid] = {
          uuid: data.serverUuid,
          name: data.serverName || 'Server Antrian',
          ip: bestIp,
          port: data.port || 8080,
          rinfoAddress: rinfo.address,
          addresses: data.addresses || [bestIp],
          method: 'udp',
          lastSeen: Date.now()
        };

        if (typeof onServersUpdatedCallback === 'function') {
          onServersUpdatedCallback(getDiscoveredServersList());
        }
      }
    } catch (err) {}
  };

  clientSocket.on('message', handleIncomingMessage);
  clientSocket.on('error', (err) => console.error('[UDP Discovery Listener Error]', err));

  clientSocket.bind(MULTICAST_PORT, () => {
    try {
      clientSocket.setBroadcast(true);
      const ifaces = getAllValidIPv4Interfaces();

      try { clientSocket.addMembership(MULTICAST_ADDR); } catch (e) {}

      ifaces.forEach(iface => {
        try { clientSocket.addMembership(MULTICAST_ADDR, iface.address); } catch (e) {}
      });
    } catch (e) {
      console.error('Failed to bind client membership to multicast group:', e);
    }

    sendDiscoveryQuery();
  });

  // Buat socket pendengar khusus di interface fisik untuk memastikan penerimaan saat VPN aktif
  const physicalIfaces = getAllValidIPv4Interfaces().filter(i => !i.isVpn);
  clientPhysicalSockets = [];
  physicalIfaces.forEach(iface => {
    try {
      const pSock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      pSock.on('message', handleIncomingMessage);
      pSock.on('error', () => {});
      pSock.bind(MULTICAST_PORT, iface.address, () => {
        try {
          pSock.setBroadcast(true);
          pSock.addMembership(MULTICAST_ADDR, iface.address);
        } catch (_) {}
      });
      clientPhysicalSockets.push(pSock);
    } catch (_) {}
  });

  // Interval query aktif berkala (setiap 6 detik)
  activeSweepInterval = setInterval(() => {
    sendDiscoveryQuery();
  }, 6000);

  // Interval pembersihan server offline (tidak aktif dalam 12 detik)
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    let updated = false;

    for (const uuid of Object.keys(discoveredServers)) {
      if (now - discoveredServers[uuid].lastSeen > 12000) {
        delete discoveredServers[uuid];
        updated = true;
      }
    }

    if (updated && typeof onServersUpdatedCallback === 'function') {
      onServersUpdatedCallback(getDiscoveredServersList());
    }
  }, 4000);

  clientSocket.cleanupInterval = cleanupInterval;
  console.log('[Discovery] Discovery Listener started on port', MULTICAST_PORT);
}

/**
 * Mengirim query pencarian aktif ke seluruh jaringan:
 * 1. Multicast SSDP
 * 2. Broadcast Global & Subnet via default & per-interface socket (Bypass VPN)
 * 3. Subnet Unicast Sweep (Bypass AP Isolation & Router Subnet Boundaries)
 * 4. HTTP Port 8080 Probe pada known servers & gateway (Bypass UDP firewall)
 */
async function sendDiscoveryQuery(customTarget) {
  const payload = JSON.stringify({
    type: DISCOVERY_QUERY_TYPE,
    timestamp: Date.now()
  });
  const message = Buffer.from(payload);

  // 1. Multicast SSDP
  if (clientSocket) {
    try { clientSocket.send(message, 0, message.length, MULTICAST_PORT, MULTICAST_ADDR); } catch (e) {}
    try { clientSocket.send(message, 0, message.length, MULTICAST_PORT, '255.255.255.255'); } catch (e) {}
  }

  // 2. Broadcast via interface fisik (Bypass WARP/FortiClient)
  const ifaces = getAllValidIPv4Interfaces();
  const physicalIfaces = ifaces.filter(i => !i.isVpn);

  physicalIfaces.forEach(iface => {
    const subnetBcast = calculateBroadcast(iface.address, iface.netmask);
    if (subnetBcast && subnetBcast !== '255.255.255.255') {
      if (clientSocket) {
        try { clientSocket.send(message, 0, message.length, MULTICAST_PORT, subnetBcast); } catch (e) {}
      }
      sendPacketViaInterface(iface.address, subnetBcast, MULTICAST_PORT, message);
    }
    sendPacketViaInterface(iface.address, '255.255.255.255', MULTICAST_PORT, message);
    sendPacketViaInterface(iface.address, MULTICAST_ADDR, MULTICAST_PORT, message);
  });

  // 3. Probing Known Servers (Endpoint yang pernah terhubung / disimpan)
  knownServerEndpoints.forEach(ep => {
    const [host, portStr] = ep.replace(/^ws:\/\//, '').replace(/^http:\/\//, '').split(':');
    const port = parseInt(portStr, 10) || 8080;
    if (host && host !== 'localhost' && host !== '127.0.0.1') {
      if (clientSocket) {
        try { clientSocket.send(message, 0, message.length, MULTICAST_PORT, host); } catch (_) {}
      }
      physicalIfaces.forEach(iface => {
        sendPacketViaInterface(iface.address, host, MULTICAST_PORT, message);
      });
      probeHttpServer(host, port);
    }
  });

  // 4. Subnet Unicast Sweep pada Subnet Fisik (Menembus AP Isolation & Router Beda Subnet)
  const subnetsToSweep = new Set();
  physicalIfaces.forEach(iface => {
    const parts = iface.address.split('.');
    if (parts.length === 4) {
      subnetsToSweep.add(`${parts[0]}.${parts[1]}.${parts[2]}`);
      if (parts[0] === '192' && parts[1] === '168') {
        if (parts[2] === '1') subnetsToSweep.add('192.168.0');
        else if (parts[2] === '0') subnetsToSweep.add('192.168.1');
      }
    }
  });

  // Jika user menyertakan custom target IP / subnet
  if (customTarget && typeof customTarget === 'string') {
    const cleanTarget = customTarget.trim().replace(/^ws:\/\//, '').replace(/^http:\/\//, '');
    const [targetHost, targetPortStr] = cleanTarget.split(':');
    const targetPort = parseInt(targetPortStr, 10) || 8080;
    if (targetHost.includes('/')) {
      const p = targetHost.split('/')[0].split('.');
      if (p.length >= 3) subnetsToSweep.add(`${p[0]}.${p[1]}.${p[2]}`);
    } else {
      const p = targetHost.split('.');
      if (p.length === 4) {
        probeHttpServer(targetHost, targetPort);
        if (clientSocket) {
          try { clientSocket.send(message, 0, message.length, MULTICAST_PORT, targetHost); } catch (_) {}
        }
        subnetsToSweep.add(`${p[0]}.${p[1]}.${p[2]}`);
      }
    }
  }

  // Jalankan UDP unicast sweep pada subnet target
  for (const subnetPrefix of subnetsToSweep) {
    sweepSubnetUdp(subnetPrefix, message);
  }
}

/**
 * Mengirim paket UDP unicast ke seluruh rentang host .1 sampai .254 dalam batch kecil
 */
function sweepSubnetUdp(subnetPrefix, message) {
  if (!clientSocket) return;
  let currentHost = 1;
  const batchSize = 35;

  function sendBatch() {
    const end = Math.min(currentHost + batchSize, 255);
    for (let i = currentHost; i < end; i++) {
      const targetIp = `${subnetPrefix}.${i}`;
      try {
        clientSocket.send(message, 0, message.length, MULTICAST_PORT, targetIp);
      } catch (_) {}
    }
    currentHost = end;
    if (currentHost < 255) {
      setTimeout(sendBatch, 25);
    }
  }

  sendBatch();
}

/**
 * HTTP Probe ke port 8080 /api/discovery
 * Menjamin penemuan server bahkan jika UDP diblokir penuh oleh firewall atau router.
 */
function probeHttpServer(host, port = 8080) {
  try {
    const req = http.get(`http://${host}:${port}/api/discovery`, { timeout: 800 }, (res) => {
      if (res.statusCode === 200) {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            if (data.type === 'ping' && (data.serverUuid || data.serverName)) {
              const serverUuid = data.serverUuid || `srv-${host}-${port}`;
              discoveredServers[serverUuid] = {
                uuid: serverUuid,
                name: data.serverName || 'Server Antrian',
                ip: host,
                port: data.port || port,
                rinfoAddress: host,
                addresses: [host],
                method: 'http',
                lastSeen: Date.now()
              };
              if (typeof onServersUpdatedCallback === 'function') {
                onServersUpdatedCallback(getDiscoveredServersList());
              }
            }
          } catch (_) {}
        });
      }
    });
    req.on('error', () => {});
    req.on('timeout', () => req.destroy());
  } catch (_) {}
}

function addKnownServer(endpoint) {
  if (!endpoint) return;
  const clean = endpoint.trim().replace(/^ws:\/\//, '').replace(/^http:\/\//, '');
  if (clean && !clean.startsWith('localhost') && !clean.startsWith('127.0.0.1')) {
    knownServerEndpoints.add(clean);
    const [host, portStr] = clean.split(':');
    probeHttpServer(host, parseInt(portStr, 10) || 8080);
  }
}

function setKnownServer(endpoint) {
  addKnownServer(endpoint);
}

function stopDiscoveryListener() {
  if (activeSweepInterval) {
    clearInterval(activeSweepInterval);
    activeSweepInterval = null;
  }
  if (clientSocket) {
    if (clientSocket.cleanupInterval) {
      clearInterval(clientSocket.cleanupInterval);
    }
    try { clientSocket.close(); } catch (e) {}
    clientSocket = null;
  }
  if (clientPhysicalSockets && clientPhysicalSockets.length > 0) {
    clientPhysicalSockets.forEach(s => {
      try { s.close(); } catch (_) {}
    });
    clientPhysicalSockets = [];
  }
  discoveredServers = {};
  console.log('[Discovery] Discovery Listener stopped.');
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
  getAllLocalIps,
  addKnownServer,
  setKnownServer
};
