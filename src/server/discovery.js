const dgram = require('dgram');
const os = require('os');

const MULTICAST_ADDR = '239.255.255.250'; // SSDP standard multicast address
const MULTICAST_PORT = 41234;

let clientSocket = null;
let serverSocket = null;
let broadcastInterval = null;
let discoveredServers = {};

// Helper untuk mendapatkan IP lokal
function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      // Support Node 18+ where family is string 'IPv4' or number 4
      const isIPv4 = iface.family === 'IPv4' || iface.family === 4;
      if (isIPv4 && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

// ==================== SERVER MODE: BROADCASTER ====================

function startBroadcaster(serverUuid, serverName, wsPort) {
  if (serverSocket) stopBroadcaster();

  serverSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  serverSocket.bind(MULTICAST_PORT, () => {
    // Bergabung dengan grup multicast
    try {
      serverSocket.addMembership(MULTICAST_ADDR);
      serverSocket.setMulticastLoopback(true); // Izinkan loopback agar bisa ditest di satu PC
    } catch (e) {
      console.error("Failed to add membership to multicast group:", e);
    }
  });

  const ip = getLocalIp();

  broadcastInterval = setInterval(() => {
    const payload = JSON.stringify({
      type: 'ping',
      serverUuid,
      serverName,
      ip,
      port: wsPort
    });

    const message = Buffer.from(payload);
    try {
      serverSocket.send(message, 0, message.length, MULTICAST_PORT, MULTICAST_ADDR);
    } catch (err) {
      console.error('Error sending multicast broadcast:', err);
    }
  }, 2000);

  console.log(`UDP Broadcaster started for server "${serverName}" [${serverUuid}] on ${ip}:${wsPort}`);
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
      if (data.type === 'ping' && data.serverUuid) {
        // Simpan atau update info server
        discoveredServers[data.serverUuid] = {
          uuid: data.serverUuid,
          name: data.serverName,
          ip: data.ip,
          port: data.port,
          lastSeen: Date.now()
        };
        
        onServersUpdated(getDiscoveredServersList());
      }
    } catch (err) {
      // Abaikan data tidak valid
    }
  });

  clientSocket.bind(MULTICAST_PORT, () => {
    try {
      clientSocket.addMembership(MULTICAST_ADDR);
    } catch (e) {
      console.error("Failed to bind client membership to multicast group:", e);
    }
  });

  // Interval pembersihan server offline (tidak aktif dalam 6 detik)
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    let updated = false;

    for (const uuid of Object.keys(discoveredServers)) {
      if (now - discoveredServers[uuid].lastSeen > 6000) {
        delete discoveredServers[uuid];
        updated = true;
      }
    }

    if (updated) {
      onServersUpdated(getDiscoveredServersList());
    }
  }, 2000);

  clientSocket.cleanupInterval = cleanupInterval;
  console.log('UDP Discovery Listener started on port', MULTICAST_PORT);
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
  startDiscoveryListener,
  stopDiscoveryListener,
  getDiscoveredServersList,
  getLocalIp
};
