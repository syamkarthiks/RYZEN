'use strict';

/**
 * lib/connection.js — Baileys socket creation and session management.
 *
 * Responsibilities:
 *  1. Decode SESSION_ID (if set) → restore session files to /session/
 *  2. Create a Baileys MultiFileAuthState socket
 *  3. Generate pairing code or display QR (if no session)
 *  4. After successful login: encode session → print SESSION_ID
 *  5. Handle reconnects with exponential back-off
 *  6. Start a minimal HTTP keep-alive server (required by Render/Koyeb)
 */

const path = require('path');
const fs = require('fs');
const http = require('http');
const tar = require('tar');
const os = require('os');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers,
} = require('@whiskeysockets/baileys');

const pino = require('pino');
const config = require('../config');
const { logger, ensureDir, sleep } = require('./utils');
const { attachEvents } = require('./events');
const { loadAllPlugins } = require('./pluginLoader');

// ─── Paths ───────────────────────────────────────────────────────────────────
const SESSION_DIR = path.resolve(config.sessionDir);
const MEDIA_DIR = path.resolve(config.mediaDir);

// ─── Session Encoding / Decoding ─────────────────────────────────────────────

/**
 * Clear all session files from SESSION_DIR.
 * Called when the device is logged out or session keys are corrupted,
 * so the next restart triggers a fresh QR / pairing-code flow.
 */
function clearSession() {
  try {
    if (fs.existsSync(SESSION_DIR)) {
      const files = fs.readdirSync(SESSION_DIR);
      for (const file of files) {
        fs.rmSync(path.join(SESSION_DIR, file), { recursive: true, force: true });
      }
      logger.info('🗑️  Stale session files cleared from ' + SESSION_DIR);
    }
  } catch (err) {
    logger.warn({ err }, 'Could not fully clear session directory');
  }
}

/**
 * Decode a SESSION_ID string and restore session files into SESSION_DIR.
 * SESSION_ID can be a base64 string or a tiny ID like RYZEN~xxx
 * @param {string} sessionId
 */
async function decodeSession(sessionId) {
  logger.info('🔑 SESSION_ID detected — restoring session…');
  ensureDir(SESSION_DIR);

  let base64Data = sessionId;

  // If it's a tiny ID, download the payload from paste.rs
  if (sessionId.startsWith('RYZEN~')) {
    logger.info('☁️ Tiny Session ID detected. Downloading from cloud...');
    const pasteId = sessionId.split('~')[1];
    try {
      const response = await require('axios').get(`https://paste.rs/${pasteId}`);
      base64Data = response.data.trim();
    } catch (error) {
      logger.error('❌ Failed to download session from cloud. Please generate a new one.');
      return;
    }
  }

  const tarBuffer = Buffer.from(base64Data, 'base64');
  const tmpFile = path.join(os.tmpdir(), `ryzen-session-${Date.now()}.tar.gz`);

  fs.writeFileSync(tmpFile, tarBuffer);

  const tar = require('tar');
  await tar.extract({
    file: tmpFile,
    cwd: SESSION_DIR,
  });

  fs.unlinkSync(tmpFile);
  logger.info('✅ Session restored successfully');
}

/**
 * Encode the current SESSION_DIR into a base64 string and log it.
 */
async function encodeSession() {
  const tmpFile = path.join(os.tmpdir(), `ryzen-session-export-${Date.now()}.tar.gz`);

  await tar.create(
    { gzip: true, file: tmpFile, cwd: SESSION_DIR },
    fs.readdirSync(SESSION_DIR)
  );

  const buffer = fs.readFileSync(tmpFile);
  const encoded = buffer.toString('base64');
  fs.unlinkSync(tmpFile);

  logger.info('\n\n═══════════════════════════════════════════════════════');
  logger.info('🔑 YOUR SESSION_ID (save this in your environment):');
  logger.info('═══════════════════════════════════════════════════════');
  console.log('\nSESSION_ID=' + encoded + '\n');
  logger.info('═══════════════════════════════════════════════════════\n');
}

// ─── Keep-Alive HTTP Server ──────────────────────────────────────────────────

/**
 * Start a minimal Express-less HTTP server so platforms like Render and Koyeb
 * detect the service as healthy and don't spin it down.
 */
function startKeepAliveServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'online',
      bot: config.botName,
      version: config.version,
      uptime: process.uptime(),
    }));
  });

  server.listen(config.port, () => {
    logger.info(`🌐 Keep-alive server running on port ${config.port}`);
  });
}

// ─── Socket Factory ──────────────────────────────────────────────────────────

let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY_MS = 60_000;

/**
 * Create and connect the Baileys WhatsApp socket.
 * Automatically retries on disconnection with exponential back-off.
 */
async function createSocket() {
  ensureDir(SESSION_DIR);
  ensureDir(MEDIA_DIR);

  // Decode session if provided.
  if (config.sessionId && !fs.existsSync(path.join(SESSION_DIR, 'creds.json'))) {
    await decodeSession(config.sessionId);
  }

  // Guard against EOF race condition: if creds.json exists but is empty/corrupt,
  // remove it so Baileys initialises fresh keys instead of crashing on read.
  const credsPath = path.join(SESSION_DIR, 'creds.json');
  if (fs.existsSync(credsPath)) {
    try {
      const raw = fs.readFileSync(credsPath, 'utf8').trim();
      if (!raw || raw.length === 0) {
        logger.warn('⚠️  creds.json is empty (EOF race condition) — removing and re-initialising');
        fs.unlinkSync(credsPath);
      } else {
        JSON.parse(raw); // validate JSON — throws if malformed
      }
    } catch (e) {
      logger.warn({ err: e }, '⚠️  creds.json is corrupt — removing and re-initialising');
      try { fs.unlinkSync(credsPath); } catch (_) { /* ignore */ }
    }
  }

  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion();

  logger.info(`🟢 Baileys version: ${version.join('.')}`);

  // A silent pino logger for Baileys internals (avoids noisy output).
  const baileysLogger = pino({ level: 'silent' });

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
    },
    browser: Browsers.macOS('Safari'),
    logger: baileysLogger,
    printQRInTerminal: false,       // We handle QR ourselves
    syncFullHistory: false,
    generateHighQualityLinkPreview: true,
    getMessage: async () => ({ conversation: '' }),
  });

  // ── Credentials Save ─────────────────────────────────────────────────
  // Baileys' saveCreds can leave creds.json empty on Windows if the file
  // is read mid-write (EOF race). We wrap it with a safety-net that
  // verifies the file is valid JSON after every save. If it's empty/corrupt
  // we write fresh from the current creds state.
  //
  // NOTE: session/ lives inside OneDrive which holds file locks during sync,
  // making renameSync fail with EPERM. We use copyFileSync+unlinkSync
  // instead — this works on OneDrive and network drives.
  const safeCredsPath = path.join(SESSION_DIR, 'creds.json');
  const safeCredsTmp  = safeCredsPath + '.tmp';
  const atomicSaveCreds = async () => {
    try {
      await saveCreds();
    } catch (e) {
      logger.warn({ err: e }, 'saveCreds base error (non-fatal)');
    }
    // Safety-net: verify file is valid, rewrite via copy+delete if empty.
    try {
      const raw = fs.existsSync(safeCredsPath)
        ? fs.readFileSync(safeCredsPath, 'utf8').trim()
        : '';
      if (!raw || raw.length === 0) {
        // File is empty — write directly (no rename needed, Baileys already
        // has the data in memory via state.creds).
        logger.warn('⚠️  creds.json was empty after save — rewriting directly');
        fs.writeFileSync(safeCredsPath, JSON.stringify(state.creds, null, 2), 'utf8');
      } else {
        // File is valid — do a copy+delete swap to harden against partial reads.
        fs.writeFileSync(safeCredsTmp, raw, 'utf8');
        try {
          fs.copyFileSync(safeCredsTmp, safeCredsPath);
          fs.unlinkSync(safeCredsTmp);
        } catch (_) {
          // copy+delete failed (e.g. OneDrive lock) — file is still valid, ignore.
        }
      }
    } catch (e) {
      // Non-fatal: the file Baileys wrote is still usable.
    }
  };
  sock.ev.on('creds.update', atomicSaveCreds);

  // ── Connection Updates ────────────────────────────────────────────────
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr, pairingCode } = update;

    // ── QR Code ────────────────────────────────────────────────────────
    if (qr) {
      const qrcode = require('qrcode-terminal');
      logger.info('\n📱 Scan this QR code in WhatsApp → Linked Devices:\n');
      qrcode.generate(qr, { small: true });
    }

    // ── Pairing Code ───────────────────────────────────────────────────
    if (pairingCode) {
      logger.info(`\n🔗 Pairing Code: ${pairingCode}\n`);
    }

    // ── Connected ──────────────────────────────────────────────────────
    if (connection === 'open') {
      reconnectAttempts = 0;
      const user = sock.user;
      logger.info(`✅ Connected as: ${user?.name || 'Unknown'} (${user?.id})`);

      // Encode session only on a true fresh login (no SESSION_ID env var and
      // this is the first connection attempt, not a reconnect).
      const credsFilePath = path.join(SESSION_DIR, 'creds.json');
      if (!config.sessionId && reconnectAttempts === 0 && fs.existsSync(credsFilePath)) {
        // Small delay to let the atomic creds write complete before tarring.
        await sleep(1000);
        await encodeSession();
      }

      // Load plugins and attach event handlers.
      loadAllPlugins();
      attachEvents(sock);

      // ── Startup notification to the first sudo number ─────────────────
      if (config.sudoNumbers.length > 0) {
        const ownerJid = `${config.sudoNumbers[0]}@s.whatsapp.net`;

        // Send startup message — try immediately, then retry after 5s if it fails.
        // No readyState check: just attempt and catch errors.
        (async () => {
          const delays = [1000, 5000, 12000];
          for (const delay of delays) {
            await sleep(delay);
            try {
              const { runtime } = require('./utils');
              const { version: baileysVer } = require('@whiskeysockets/baileys/package.json');
              const startMsg = [
                `╔═══════════════════════════════╗`,
                `║  ⚡  *${config.botName} is Online!*  ⚡  ║`,
                `╚═══════════════════════════════╝`,
                ``,
                `✅ *Bot started successfully!*`,
                ``,
                `👤 *Account*   : ${user?.name || 'Unknown'}`,
                `👑 *Owner*     : ${config.ownerName}`,
                `🔖 *Prefix*    : \`${config.prefix}\``,
                `🌐 *Mode*      : ${config.workType}`,
                ``,
                `⏱️ *Runtime*   : ${runtime()}`,
                `📦 *Node.js*   : ${process.version}`,
                `📡 *Baileys*   : v${baileysVer}`,
                `🤖 *Version*   : v${config.version}`,
                ``,
                `_Type_ \`${config.prefix}menu\` _to see all 45 commands._`,
              ].join('\n');
              await sock.sendMessage(ownerJid, { text: startMsg });
              logger.info(`📩 Startup message sent to ${config.sudoNumbers[0]}`);
              break; // success
            } catch (err) {
              logger.warn(`Startup msg attempt failed: ${err.message} — retrying...`);
            }
          }
        })();
      }
    }

    // ── Disconnected ───────────────────────────────────────────────────
    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const reason = DisconnectReason[statusCode] || 'Unknown';
      const errMsg = lastDisconnect?.error?.message || '';

      logger.warn(`⚠️  Disconnected — reason: ${reason} (${statusCode})`);

      // 401 = logged out — clear stale session so next restart re-pairs cleanly.
      if (statusCode === DisconnectReason.loggedOut) {
        logger.error('🔴 Logged out from WhatsApp (device unlinked).');
        logger.info('🗑️  Clearing stale session files so the next restart does a fresh login…');
        clearSession();
        logger.error('🔄 Please restart the bot to scan a new QR / pairing code.');
        process.exit(1);
      }

      // 440 = connectionReplaced — another instance of the bot is running.
      // DO NOT reconnect: that would create an infinite replacement loop.
      // Exit so the operator can kill duplicate processes and restart once.
      if (statusCode === DisconnectReason.connectionReplaced) {
        logger.error('🔴 connectionReplaced (440): another bot instance is already running.');
        logger.error('   Kill all other node processes and restart once.');
        process.exit(1);
      }

      // Signal session corruption: MessageCounterError or Bad MAC means
      // the stored session keys no longer match the server → clear & re-pair.
      const isSessionCorrupt =
        errMsg.includes('MessageCounterError') ||
        errMsg.includes('Bad MAC') ||
        statusCode === 500;

      if (isSessionCorrupt) {
        logger.error('🔴 Session keys corrupted (Bad MAC / MessageCounterError). Clearing session…');
        clearSession();
        logger.error('🔄 Please restart the bot to scan a new QR / pairing code.');
        process.exit(1);
      }

      // Exponential back-off: 2s, 4s, 8s … capped at 60s.
      reconnectAttempts++;
      const delay = Math.min(2 ** reconnectAttempts * 1000, MAX_RECONNECT_DELAY_MS);
      logger.info(`🔄 Reconnecting in ${delay / 1000}s… (attempt ${reconnectAttempts})`);
      await sleep(delay);
      createSocket();
    }
  });

  // ── Pairing Code Request (if no QR desired) ───────────────────────────────
  // Request pairing code when there is no existing session and no SESSION_ID.
  if (!config.sessionId && !fs.existsSync(path.join(SESSION_DIR, 'creds.json'))) {
    // Wait a moment for the socket to initialise before requesting the code.
    await sleep(3000);

    if (!sock.authState.creds.registered) {
      // Prompt user for their number.
      const readline = require('readline');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

      rl.question('\n📱 Enter your WhatsApp number with country code (e.g. 919876543210): ', async (number) => {
        rl.close();
        try {
          const code = await sock.requestPairingCode(number.trim());
          logger.info(`\n🔗 Pairing Code: ${code}\n`);
          logger.info('Enter this code in WhatsApp → Linked Devices → Link with phone number\n');
        } catch (err) {
          logger.error({ err }, 'Failed to request pairing code — switching to QR');
        }
      });
    }
  }

  return sock;
}

module.exports = { createSocket, startKeepAliveServer };
