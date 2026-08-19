const { WebSocketServer } = require('ws');
const db = require('./db');

let wss = null;

// Mulai server WebSocket
function startWebSocketServer(port) {
  if (wss) stopWebSocketServer();

  wss = new WebSocketServer({ port });

  wss.on('connection', async (ws) => {
    console.log('Client connected to WebSocket server');

    // Kirim data awal (inisialisasi state) ke client yang baru terhubung
    try {
      await sendStateToClient(ws);
    } catch (err) {
      console.error('Error sending initial state:', err);
    }

    ws.on('message', async (message) => {
      try {
        const action = JSON.parse(message.toString());
        await handleClientAction(action, ws);
      } catch (err) {
        console.error('Error parsing client message:', err);
        ws.send(JSON.stringify({ type: 'ERROR', payload: { message: 'Invalid action payload' } }));
      }
    });

    ws.on('close', () => {
      console.log('Client disconnected from WebSocket server');
    });
  });

  console.log('WebSocket Server started on port', port);
}

// Hentikan server WebSocket
function stopWebSocketServer() {
  if (wss) {
    wss.clients.forEach((client) => {
      client.close();
    });
    wss.close();
    wss = null;
    console.log('WebSocket Server stopped.');
  }
}

// Kirim state ter-update ke client spesifik
async function sendStateToClient(ws) {
  const state = await getCurrentState();
  ws.send(JSON.stringify({
    type: 'STATE_UPDATE',
    payload: state
  }));
  
  try {
    const waStatus = require('./whatsapp').getWaStatus();
    ws.send(JSON.stringify({
      type: 'WA_STATUS_UPDATE',
      payload: waStatus
    }));
  } catch (e) {}
}

// Ambil state gabungan saat ini
async function getCurrentState() {
  const services = await db.getServices();
  const waitingTickets = await db.getWaitingTickets();
  const callingTickets = await db.getCallingTickets();
  
  return {
    services,
    waitingTickets,
    callingTickets
  };
}

// Broadcast pesan ke seluruh client
function broadcast(messageObj) {
  if (!wss) return;
  const payload = JSON.stringify(messageObj);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) { // Open
      client.send(payload);
    }
  });
}

// Ambil state database dan broadcast ke semua client
async function broadcastStateUpdate() {
  try {
    const state = await getCurrentState();
    broadcast({
      type: 'STATE_UPDATE',
      payload: state
    });
  } catch (err) {
    console.error('Error broadcasting state update:', err);
  }
}

// Handle request aksi dari client (operator)
async function handleClientAction(action, ws) {
  const { type, payload } = action;
  console.log(`Received client action: ${type}`, payload);

  try {
    switch (type) {
      case 'GET_STATE':
        await sendStateToClient(ws);
        break;

      case 'WA_STATUS': {
        const waStatus = require('./whatsapp').getWaStatus();
        ws.send(JSON.stringify({ type: 'WA_STATUS_UPDATE', payload: waStatus }));
        break;
      }

      case 'WA_LOGOUT': {
        await require('./whatsapp').logoutWhatsAppClient();
        break;
      }

      case 'WA_CHECK_UPDATE': {
        await require('./whatsapp').checkForUpdates();
        break;
      }

      case 'CREATE_TICKET': {
        const { serviceId, name, phone } = payload;
        const newTicket = await db.createTicket(serviceId, name, phone);
        await broadcastStateUpdate();
        
        // Optional WA Notification for Ticket creation
        // Kirim notifikasi WhatsApp ke server pendukung (jika WA aktif)
        try {
          const { sendTicketCreatedNotification } = require('./whatsapp');
          sendTicketCreatedNotification(newTicket);
        } catch (e) {
          console.error("WA notification trigger failed:", e);
        }
        break;
      }

      case 'CALL_NEXT': {
        const { serviceId, deskNumber } = payload;
        const calledTicket = await db.callNextTicket(serviceId, deskNumber);
        
        if (calledTicket) {
          await broadcastStateUpdate();
          
          // Kirim trigger panggilan suara (announcement) ke seluruh display
          broadcast({
            type: 'ANNOUNCE_CALL',
            payload: {
              ticketNumber: calledTicket.ticket_number,
              deskNumber: calledTicket.desk_number,
              serviceName: calledTicket.service_name
            }
          });

          // Kirim WhatsApp pemberitahuan giliran tiba
          try {
            const { sendTicketCalledNotification } = require('./whatsapp');
            sendTicketCalledNotification(calledTicket);
          } catch (e) {}

          // Kirim WhatsApp pengingat 3 antrian lagi ke tiket berikutnya (jika ada)
          try {
            await triggerWhatsAppQueueReminder(serviceId, calledTicket.number_sequence);
          } catch (e) {}
        } else {
          ws.send(JSON.stringify({ type: 'ALERT', payload: { message: 'Antrian kosong.' } }));
        }
        break;
      }

      case 'RECALL': {
        const { ticketId } = payload;
        const recalledTicket = await db.recallTicket(ticketId);
        
        if (recalledTicket) {
          await broadcastStateUpdate();

          // Kirim trigger panggilan ulang suara
          broadcast({
            type: 'ANNOUNCE_CALL',
            payload: {
              ticketNumber: recalledTicket.ticket_number,
              deskNumber: recalledTicket.desk_number,
              serviceName: recalledTicket.service_name
            }
          });
        }
        break;
      }

      case 'COMPLETE': {
        const { ticketId } = payload;
        await db.completeTicket(ticketId);
        await broadcastStateUpdate();
        break;
      }

      case 'SKIP': {
        const { ticketId } = payload;
        await db.skipTicket(ticketId);
        await broadcastStateUpdate();
        break;
      }

      case 'RESET_ALL': {
        await db.resetAllQueues();
        await broadcastStateUpdate();
        break;
      }

      default:
        console.warn('Unknown action type:', type);
    }
  } catch (err) {
    console.error(`Error processing action ${type}:`, err);
    ws.send(JSON.stringify({ type: 'ERROR', payload: { message: err.message } }));
  }
}

// WhatsApp pengingat: kirim ke orang yang antriannya berjarak 3 antrian lagi (current_number + 3)
async function triggerWhatsAppQueueReminder(serviceId, currentNumber) {
  const targetSeq = currentNumber + 3;
  // Cari apakah ada antrian waiting dengan nomor sequence ini untuk hari ini
  const today = new Date().toISOString().split('T')[0];
  const dbModule = require('./db');
  
  const targetTicket = await dbModule.searchTickets('', 'waiting', serviceId, today);
  // Filter yang sequence-nya persis targetSeq
  const ticket = targetTicket.find(t => t.number_sequence === targetSeq);
  
  if (ticket && ticket.customer_phone) {
    const { sendQueueReminderNotification } = require('./whatsapp');
    sendQueueReminderNotification(ticket, 3);
  }
}

module.exports = {
  startWebSocketServer,
  stopWebSocketServer,
  broadcast,
  broadcastStateUpdate,
  getCurrentState
};
