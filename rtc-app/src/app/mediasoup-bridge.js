/**
 * mediasoup-bridge.js
 *
 * All mediasoup-client logic lives here.
 * WASM calls these functions via  window.mediasoupBridge.*
 * This bridge sends data to the server via  window.__rtcWasmSend(obj)
 * and notifies Angular via  window.__rtcCallbacks.*
 */
import * as mediasoupClient from 'mediasoup-client';

// ── internal state ──
let device = null;
let sendTransport = null;
let recvTransport = null;
let pendingProduceCallback = null;
let sendTransportReady = false;
let recvTransportReady = false;

// ── helpers ──
function sendToServer(data) {
    if (window.__rtcWasmSend) {
        window.__rtcWasmSend(data);
    } else {
        console.error('[bridge] __rtcWasmSend not registered yet');
    }
}

function notifyAngular(event, ...args) {
    if (window.__rtcCallbacks && window.__rtcCallbacks[event]) {
        window.__rtcCallbacks[event](...args);
    }
}

function checkBothTransportsReady() {
    if (sendTransportReady && recvTransportReady) {
        sendToServer({ action: 'getExistingProducers' });
    }
}

// ══════════════════════════════════════════════════════════
//  PUBLIC API  –  attached to window.mediasoupBridge
// ══════════════════════════════════════════════════════════
window.mediasoupBridge = {

    /**
     * Create + load the mediasoup Device, then ask server
     * to create send & recv transports.
     */
    loadDevice: async (routerRtpCapabilities) => {
        device = new mediasoupClient.Device();
        await device.load({ routerRtpCapabilities });
        console.log('📦 Bridge: Device loaded');

        sendToServer({ action: 'createSendTransport' });
        sendToServer({ action: 'createRecvTransport' });
    },

    /**
     * Build the send-side transport, capture local media, and produce tracks.
     */
    createSendTransport: async (params) => {
        sendTransport = device.createSendTransport(params);

        sendTransport.on('connect', ({ dtlsParameters }, callback) => {
            sendToServer({
                action: 'connectSendTransport',
                transportId: sendTransport.id,
                dtlsParameters,
            });
            callback();
        });

        sendTransport.on('produce', ({ kind, rtpParameters }, callback) => {
            sendToServer({
                action: 'produce',
                transportId: sendTransport.id,
                kind,
                rtpParameters,
            });
            pendingProduceCallback = callback;
        });

        // Capture camera + mic
        const stream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: true,
        });

        // Let Angular display the local video
        notifyAngular('onLocalStream', stream);

        for (const track of stream.getTracks()) {
            await sendTransport.produce({ track });
        }

        sendTransportReady = true;
        checkBothTransportsReady();
    },

    /**
     * Build the receive-side transport.
     */
    createRecvTransport: async (params) => {
        recvTransport = device.createRecvTransport(params);

        recvTransport.on('connect', ({ dtlsParameters }, callback) => {
            sendToServer({
                action: 'connectRecvTransport',
                transportId: recvTransport.id,
                dtlsParameters,
            });
            callback();
        });

        recvTransportReady = true;
        checkBothTransportsReady();
    },

    /**
     * Resolve the pending produce callback with the server-assigned id.
     */
    handleProducedResponse: (data) => {
        if (pendingProduceCallback) {
            pendingProduceCallback({ id: data.id });
            pendingProduceCallback = null;
        }
    },

    /**
     * Ask the server to let us consume a remote producer.
     */
    requestConsume: (producerId) => {
        sendToServer({
            action: 'consume',
            producerId,
            rtpCapabilities: device.rtpCapabilities,
        });
    },

    /**
     * Handle the server's consume response — create a Consumer,
     * wrap its track in a MediaStream, and notify Angular.
     */
    handleConsumeResponse: async (data) => {
        const consumer = await recvTransport.consume(data);

        const stream = new MediaStream();
        stream.addTrack(consumer.track);

        notifyAngular('onRemoteStream', stream, consumer.kind, data.producerId);

        sendToServer({ action: 'resumeConsumer', consumerId: consumer.id });
    },
};
