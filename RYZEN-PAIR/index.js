'use strict';

/**
 * RYZEN-PAIR/index.js — Standalone Express server for WhatsApp session generation.
 *
 * Endpoints:
 *   GET  /            — Serve the pairing UI (public/index.html)
 *   POST /api/start   — Start a new Baileys session (QR or pairing code mode)
 *   GET  /api/status  — Get current session status
 *   POST /api/code    — Request a pairing code for a given number
 *
 * WebSocket events (via Socket.io):
 *   → qr              — emits QR string to the client
 *   → pairing-code    — emits the pairing code
 *   → session-id      — emits the generated SESSION_ID after login
 *   → status          — emits connection status updates
 *   → error           — emits error messages
 */

require('dotenv').config();

const path = require('path');
const fs = require('fs');
const os = require('os');
const tar = require('tar');
const express = require('express');
const http = require('http');
const { Server: SocketServer } = require('socket.io');
const pino = require('pino');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers,
} = require('@whiskeysockets/baileys');

const QRCode = require('qrcode');

// ─── Logger ──────────────────────────────────────────────────────────────────
const logger = pino({ level: 'info' });
const silentLogger = pino({ level: 'silent' });

// ─── Express + Socket.io setup ───────────────────────────────────────────────
const app = express();
const server = http.createServer(app);
const io = new SocketServer(server, {
  cors: { origin: '*' },
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Session state ───────────────────────────────────────────────────────────
const SESSIONS_BASE = path.join(__dirname, 'sessions');

/** Active Baileys sockets keyed by socket.id */
const activeSockets = new Map();

/**
 * Encode a session directory into a base64 SESSION_ID string.
 * @param {string} sessionDir
 * @returns {Promise<string>}
 */
async function encodeSession(sessionDir) {
  const tmpFile = path.join(os.tmpdir(), `ryzen-pair-${Date.now()}.tar.gz`);

  await tar.create(
    { gzip: true, file: tmpFile, cwd: sessionDir },
    fs.readdirSync(sessionDir)
  );

  const buffer = fs.readFileSync(tmpFile);
  fs.unlinkSync(tmpFile);
  return buffer.toString('base64');
}

/**
 * Clean up a session directory after encoding.
 * @param {string} sessionDir
 */
function cleanupSession(sessionDir) {
  try {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  } catch (_) {}
}

// ─── Baileys socket factory ──────────────────────────────────────────────────

/**
 * Create a new Baileys socket for a given Socket.io connection.
 * Emits events back to the client in real time.
 *
 * @param {import('socket.io').Socket} clientSocket
 * @param {'qr'|'code'} mode — login method
 * @param {string} [phoneNumber] — required when mode is 'code'
 */
async function startBaileysSession(clientSocket, mode = 'qr', phoneNumber = '') {
  const sessionId = clientSocket.id;
  const sessionDir = path.join(SESSIONS_BASE, sessionId);

  fs.mkdirSync(sessionDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, silentLogger),
    },
    browser: Browsers.macOS('Safari'),
    logger: silentLogger,
    printQRInTerminal: false,
    syncFullHistory: false,
    getMessage: async () => ({ conversation: '' }),
  });

  // Store so we can clean up on disconnect.
  activeSockets.set(sessionId, { sock, sessionDir });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // ── QR Code ────────────────────────────────────────────────────────────
    if (qr) {
      try {
        const qrDataUrl = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
        clientSocket.emit('qr', { qr: qrDataUrl });
        clientSocket.emit('status', { status: 'waiting_scan', message: 'Scan the QR code in WhatsApp' });
      } catch (err) {
        clientSocket.emit('error', { message: 'Failed to generate QR image' });
      }
    }

    // ── Pairing Code ─────────────────────────────────────────────────────────
    if (mode === 'code' && !sock.authState.creds.registered && phoneNumber) {
      try {
        // Small delay to ensure socket is ready before requesting the code.
        await new Promise((r) => setTimeout(r, 3000));
        const code = await sock.requestPairingCode(phoneNumber.trim());
        clientSocket.emit('pairing-code', { code });
        clientSocket.emit('status', { status: 'waiting_code', message: 'Enter the pairing code in WhatsApp' });
      } catch (err) {
        clientSocket.emit('error', { message: `Failed to get pairing code: ${err.message}` });
      }
    }

    // ── Connected ───────────────────────────────────────────────────────────
    if (connection === 'open') {
      clientSocket.emit('status', { status: 'connected', message: 'Connected! Generating SESSION_ID…' });

      try {
        const encoded = await encodeSession(sessionDir);
        clientSocket.emit('session-id', { sessionId: encoded });
        clientSocket.emit('status', { status: 'done', message: 'Your SESSION_ID is ready!' });

        // Disconnect the WhatsApp socket — we only needed it for the QR/code.
        sock.logout().catch(() => {});
        cleanupSession(sessionDir);
        activeSockets.delete(sessionId);
      } catch (err) {
        clientSocket.emit('error', { message: `Failed to encode session: ${err.message}` });
      }
    }

    // ── Disconnected ────────────────────────────────────────────────────────
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;

      if (code === DisconnectReason.loggedOut) {
        clientSocket.emit('status', { status: 'logged_out', message: 'Logged out. Please try again.' });
      } else {
        clientSocket.emit('status', { status: 'disconnected', message: 'Disconnected from WhatsApp.' });
      }

      cleanupSession(sessionDir);
      activeSockets.delete(sessionId);
    }
  });
}

// ─── REST API ────────────────────────────────────────────────────────────────

// Health check.
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'RYZEN-PAIR' });
});

// ─── Socket.io events ────────────────────────────────────────────────────────

io.on('connection', (clientSocket) => {
  logger.info(`Client connected: ${clientSocket.id}`);

  // Client requests a QR code login.
  clientSocket.on('start-qr', async () => {
    try {
      clientSocket.emit('status', { status: 'starting', message: 'Starting QR login…' });
      await startBaileysSession(clientSocket, 'qr');
    } catch (err) {
      clientSocket.emit('error', { message: err.message });
    }
  });

  // Client requests a pairing code login.
  clientSocket.on('start-code', async ({ phoneNumber }) => {
    if (!phoneNumber || !/^\d{7,15}$/.test(phoneNumber.replace(/\D/g, ''))) {
      clientSocket.emit('error', { message: 'Invalid phone number. Use digits only with country code.' });
      return;
    }

    try {
      clientSocket.emit('status', { status: 'starting', message: 'Requesting pairing code…' });
      await startBaileysSession(clientSocket, 'code', phoneNumber.replace(/\D/g, ''));
    } catch (err) {
      clientSocket.emit('error', { message: err.message });
    }
  });

  // Client manually disconnects.
  clientSocket.on('disconnect', () => {
    logger.info(`Client disconnected: ${clientSocket.id}`);
    const active = activeSockets.get(clientSocket.id);
    if (active) {
      try { active.sock.end(); } catch (_) {}
      cleanupSession(active.sessionDir);
      activeSockets.delete(clientSocket.id);
    }
  });
});

// ─── Start the server ─────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '4000', 10);

server.listen(PORT, () => {
  logger.info(`🌐 RYZEN-PAIR running at http://localhost:${PORT}`);
});
