const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const mediasoup = require('mediasoup');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let worker, router;

const transports = new Map();
const producers = new Map();
const consumers = new Map();

// Track which client owns which producers
const clientProducers = new Map(); // clientId -> Set of producerIds

(async () => {
  worker = await mediasoup.createWorker();
  console.log('✅ Worker created');

  router = await worker.createRouter({
    mediaCodecs: [
      { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
      { kind: 'video', mimeType: 'video/VP8', clockRate: 90000 }
    ]
  });

  console.log('✅ Router created');
})();

function createTransport() {
  return router.createWebRtcTransport({
    listenIps: [{ ip: '127.0.0.1', announcedIp: null }],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true
  });
}

wss.on('connection', (ws) => {
  ws._id = Math.random().toString(36).substring(7);
  console.log('\n🟢 Client connected →', ws._id);

  clientProducers.set(ws._id, new Set());

  ws.on('message', async (message) => {
    const msg = JSON.parse(message);
    console.log('\n📩', ws._id, '→', msg.action);

    switch (msg.action) {

      case 'getRtpCapabilities':
        ws.send(JSON.stringify({
          action: 'rtpCapabilities',
          data: router.rtpCapabilities
        }));
        break;

      // ───────── SEND TRANSPORT ─────────

      case 'createSendTransport': {
        const transport = await createTransport();
        transport.appData = { clientId: ws._id, type: 'send' };

        transports.set(transport.id, transport);

        console.log('✅ Send transport:', transport.id);

        ws.send(JSON.stringify({
          action: 'sendTransportCreated',
          data: {
            id: transport.id,
            iceParameters: transport.iceParameters,
            iceCandidates: transport.iceCandidates,
            dtlsParameters: transport.dtlsParameters
          }
        }));
        break;
      }

      case 'connectSendTransport': {
        const transport = transports.get(msg.transportId);
        await transport.connect({ dtlsParameters: msg.dtlsParameters });

        console.log('✅ Send transport connected');
        break;
      }

      case 'produce': {
        const transport = transports.get(msg.transportId);

        const producer = await transport.produce({
          kind: msg.kind,
          rtpParameters: msg.rtpParameters
        });

        producers.set(producer.id, producer);
        clientProducers.get(ws._id).add(producer.id);

        console.log('✅ Producer:', producer.id, producer.kind);

        // Notify other clients about the new producer
        wss.clients.forEach(client => {
          if (client !== ws && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
              action: 'newProducer',
              data: { producerId: producer.id, kind: producer.kind }
            }));
          }
        });

        ws.send(JSON.stringify({
          action: 'produced',
          data: { id: producer.id }
        }));

        break;
      }

      // ───────── RECV TRANSPORT ─────────

      case 'createRecvTransport': {
        const transport = await createTransport();
        transport.appData = { clientId: ws._id, type: 'recv' };

        transports.set(transport.id, transport);

        console.log('✅ Recv transport:', transport.id);

        ws.send(JSON.stringify({
          action: 'recvTransportCreated',
          data: {
            id: transport.id,
            iceParameters: transport.iceParameters,
            iceCandidates: transport.iceCandidates,
            dtlsParameters: transport.dtlsParameters
          }
        }));

        break;
      }

      case 'connectRecvTransport': {
        const transport = transports.get(msg.transportId);
        await transport.connect({ dtlsParameters: msg.dtlsParameters });

        console.log('✅ Recv transport connected');
        break;
      }

      // ───────── GET EXISTING PRODUCERS ─────────

      case 'getExistingProducers': {
        const existingProducers = [];
        for (const [clientId, producerIds] of clientProducers.entries()) {
          if (clientId !== ws._id) {
            for (const producerId of producerIds) {
              const producer = producers.get(producerId);
              if (producer && !producer.closed) {
                existingProducers.push({ producerId: producer.id, kind: producer.kind });
              }
            }
          }
        }

        if (existingProducers.length > 0) {
          console.log('📤 Sending', existingProducers.length, 'existing producers to', ws._id);
          ws.send(JSON.stringify({
            action: 'existingProducers',
            data: existingProducers
          }));
        }
        break;
      }

      // ───────── CONSUME ─────────

      case 'consume': {
        const producer = producers.get(msg.producerId);

        if (!producer || producer.closed) {
          console.log('❌ Producer not found or closed');
          return;
        }

        if (!router.canConsume({
          producerId: producer.id,
          rtpCapabilities: msg.rtpCapabilities
        })) {
          console.log('❌ Cannot consume');
          return;
        }

        const transport = [...transports.values()]
          .find(t => t.appData.clientId === ws._id && t.appData.type === 'recv');

        const consumer = await transport.consume({
          producerId: producer.id,
          rtpCapabilities: msg.rtpCapabilities,
          paused: true
        });

        consumers.set(consumer.id, consumer);

        console.log('✅ Consumer:', consumer.id);

        ws.send(JSON.stringify({
          action: 'consumeResponse',
          data: {
            id: consumer.id,
            producerId: producer.id,
            kind: consumer.kind,
            rtpParameters: consumer.rtpParameters
          }
        }));

        break;
      }

      case 'resumeConsumer': {
        const consumer = consumers.get(msg.consumerId);
        await consumer.resume();

        console.log('✅ Consumer resumed');
        break;
      }
    }
  });

  ws.on('close', () => {
    console.log('🔴 Client disconnected →', ws._id);

    // Clean up producers for this client
    const producerIds = clientProducers.get(ws._id);
    if (producerIds) {
      for (const id of producerIds) {
        const producer = producers.get(id);
        if (producer && !producer.closed) producer.close();
        producers.delete(id);
      }
    }
    clientProducers.delete(ws._id);

    // Clean up transports for this client
    for (const [id, transport] of transports.entries()) {
      if (transport.appData.clientId === ws._id) {
        if (!transport.closed) transport.close();
        transports.delete(id);
      }
    }
  });
});

server.listen(3000, () => {
  console.log('🚀 Server running → ws://localhost:3000');
});