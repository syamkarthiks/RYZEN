'use strict';

/**
 * RYZEN-PAIR — Frontend JavaScript
 *
 * Manages the multi-step UI flow using Socket.io for real-time
 * communication with the Express server.
 *
 * Flow:
 *   Step 1: method-select  → user picks QR or Pairing Code
 *   Step 2a: phone-input   → user enters number (pairing code only)
 *   Step 2b: auth-display  → shows QR image or 8-digit code
 *   Step 3: result         → displays SESSION_ID with copy button
 */

// ─── DOM Refs ─────────────────────────────────────────────────────────────────
const steps = {
  method: document.getElementById('step-method'),
  phone:  document.getElementById('step-phone'),
  auth:   document.getElementById('step-auth'),
  result: document.getElementById('step-result'),
};

const els = {
  btnQr:          document.getElementById('btn-qr'),
  btnCode:        document.getElementById('btn-code'),
  btnBackMethod:  document.getElementById('btn-back-method'),
  btnGetCode:     document.getElementById('btn-get-code'),
  btnCopy:        document.getElementById('btn-copy'),
  btnRestart:     document.getElementById('btn-restart'),

  phoneInput:     document.getElementById('phone-input'),

  // Auth step
  authTitle:      document.getElementById('auth-title'),
  statusBar:      document.getElementById('status-bar'),
  statusDot:      document.getElementById('status-dot'),
  statusText:     document.getElementById('status-text'),

  qrContainer:    document.getElementById('qr-container'),
  qrImage:        document.getElementById('qr-image'),

  codeContainer:  document.getElementById('code-container'),
  pairingCode:    document.getElementById('pairing-code'),

  spinnerContainer: document.getElementById('spinner-container'),

  // Result step
  sessionOutput:  document.getElementById('session-id-output'),
  copyIcon:       document.getElementById('copy-icon'),
  copyText:       document.getElementById('copy-text'),
};

// ─── State ────────────────────────────────────────────────────────────────────
let socket = null;
let currentMode = 'qr'; // 'qr' | 'code'

// ─── Step Navigation ─────────────────────────────────────────────────────────

/** Show only the specified step, hiding all others. */
function showStep(name) {
  Object.entries(steps).forEach(([key, el]) => {
    el.classList.toggle('hidden', key !== name);
  });
}

// ─── Socket.io Connection ─────────────────────────────────────────────────────

/** Create (or recreate) the Socket.io connection. */
function connectSocket() {
  // Disconnect previous session if any.
  if (socket) {
    socket.disconnect();
    socket = null;
  }

  socket = io();

  // ── Inbound Events ──────────────────────────────────────────────────────

  /** Real-time status update from the server. */
  socket.on('status', ({ status, message }) => {
    updateStatus(status, message);
  });

  /** QR code image (data URL). */
  socket.on('qr', ({ qr }) => {
    showQR(qr);
  });

  /** 8-digit pairing code. */
  socket.on('pairing-code', ({ code }) => {
    showPairingCode(code);
  });

  /** SESSION_ID generated — show result step. */
  socket.on('session-id', ({ sessionId }) => {
    showResult(sessionId);
  });

  /** Error from the server. */
  socket.on('error', ({ message }) => {
    updateStatus('error', `Error: ${message}`);
    els.spinnerContainer.classList.remove('hidden');
    els.spinnerContainer.querySelector('.spinner-text').textContent = message;
    els.spinnerContainer.querySelector('.spinner').style.borderTopColor = '#ff4d6d';
  });

  /** Connection established — start the appropriate session. */
  socket.on('connect', () => {
    if (currentMode === 'qr') {
      socket.emit('start-qr');
    }
    // Pairing code mode is triggered after phone number is submitted.
  });
}

// ─── Status Helpers ───────────────────────────────────────────────────────────

const STATUS_DOT_CLASSES = ['connecting', 'waiting', 'connected', 'done', 'error'];

/**
 * Update the status bar.
 * @param {'starting'|'waiting_scan'|'waiting_code'|'connected'|'done'|'disconnected'|'error'} status
 * @param {string} message
 */
function updateStatus(status, message) {
  els.statusText.textContent = message;

  // Remove all status classes from the dot.
  els.statusDot.classList.remove(...STATUS_DOT_CLASSES);

  if (['starting', 'disconnected'].includes(status)) {
    els.statusDot.classList.add('connecting');
  } else if (['waiting_scan', 'waiting_code'].includes(status)) {
    els.statusDot.classList.add('waiting');
  } else if (status === 'connected') {
    els.statusDot.classList.add('connected');
  } else if (status === 'done') {
    els.statusDot.classList.add('done');
  } else if (status === 'error' || status === 'logged_out') {
    els.statusDot.classList.add('error');
  }
}

// ─── QR / Code Display ────────────────────────────────────────────────────────

/** Show the QR code image, hiding spinner and code. */
function showQR(qrDataUrl) {
  els.spinnerContainer.classList.add('hidden');
  els.codeContainer.classList.add('hidden');
  els.qrContainer.classList.remove('hidden');
  els.qrImage.src = qrDataUrl;
  els.authTitle.textContent = 'Scan the QR Code';
}

/** Show the pairing code, hiding spinner and QR. */
function showPairingCode(code) {
  els.spinnerContainer.classList.add('hidden');
  els.qrContainer.classList.add('hidden');
  els.codeContainer.classList.remove('hidden');

  // Format as: "XXXX - XXXX"
  const formatted = code.length === 8
    ? code.slice(0, 4) + ' - ' + code.slice(4)
    : code;

  els.pairingCode.textContent = formatted;
  els.authTitle.textContent = 'Enter Pairing Code';
}

// ─── Result ───────────────────────────────────────────────────────────────────

/** Show the SESSION_ID result step. */
function showResult(sessionId) {
  els.sessionOutput.value = sessionId;
  showStep('result');
}

// ─── Copy Button ──────────────────────────────────────────────────────────────

els.btnCopy.addEventListener('click', async () => {
  const text = els.sessionOutput.value;
  if (!text) return;

  try {
    await navigator.clipboard.writeText(text);

    // Visual feedback.
    els.copyIcon.textContent = '✅';
    els.copyText.textContent = 'Copied!';
    els.btnCopy.classList.add('copied');

    setTimeout(() => {
      els.copyIcon.textContent = '📋';
      els.copyText.textContent = 'Copy';
      els.btnCopy.classList.remove('copied');
    }, 2500);
  } catch {
    // Fallback: select text for manual copy.
    els.sessionOutput.select();
    document.execCommand('copy');
  }
});

// ─── Event Listeners ─────────────────────────────────────────────────────────

/** QR Code login */
els.btnQr.addEventListener('click', () => {
  currentMode = 'qr';
  showStep('auth');
  els.authTitle.textContent = 'Generating QR Code…';
  resetAuthDisplay();
  connectSocket();
});

/** Pairing Code login — go to phone input first */
els.btnCode.addEventListener('click', () => {
  currentMode = 'code';
  showStep('phone');
  els.phoneInput.value = '';
  els.phoneInput.focus();
});

/** Back to method selection */
els.btnBackMethod.addEventListener('click', () => {
  showStep('method');
  if (socket) { socket.disconnect(); socket = null; }
});

/** Submit phone number and start pairing code flow */
els.btnGetCode.addEventListener('click', () => {
  const number = els.phoneInput.value.trim().replace(/\D/g, '');

  if (number.length < 7 || number.length > 15) {
    els.phoneInput.style.borderColor = '#ff4d6d';
    els.phoneInput.focus();
    setTimeout(() => { els.phoneInput.style.borderColor = ''; }, 1500);
    return;
  }

  showStep('auth');
  els.authTitle.textContent = 'Requesting Pairing Code…';
  resetAuthDisplay();
  connectSocket();

  // Wait for the connect event, then emit start-code.
  socket.once('connect', () => {
    socket.emit('start-code', { phoneNumber: number });
  });

  // If socket already connected (rare), emit immediately.
  if (socket.connected) {
    socket.emit('start-code', { phoneNumber: number });
  }
});

/** Allow pressing Enter to submit the phone number */
els.phoneInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') els.btnGetCode.click();
});

/** Restart — go back to step 1 */
els.btnRestart.addEventListener('click', () => {
  if (socket) { socket.disconnect(); socket = null; }
  els.sessionOutput.value = '';
  showStep('method');
  resetAuthDisplay();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Reset the auth step to its initial loading state. */
function resetAuthDisplay() {
  els.qrContainer.classList.add('hidden');
  els.codeContainer.classList.add('hidden');
  els.spinnerContainer.classList.remove('hidden');
  els.spinnerContainer.querySelector('.spinner-text').textContent = 'Connecting to WhatsApp…';
  els.spinnerContainer.querySelector('.spinner').style.borderTopColor = '';
  updateStatus('starting', 'Connecting…');
}

// ─── Init ─────────────────────────────────────────────────────────────────────
showStep('method');
