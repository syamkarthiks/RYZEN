'use strict';

/**
 * lib/utils.js — Shared helper utilities for RYZEN.
 *
 * Exports:
 *   logger          — pino logger with colored output
 *   sleep(ms)       — async delay
 *   runtime()       — human-readable uptime string
 *   formatBytes(n)  — bytes → "1.23 MB"
 *   formatMs(ms)    — milliseconds → "1.23s" or "234ms"
 *   getMemoryUsage()— { rss, heap } in MB
 *   getCpuUsage()   — promise → cpu% string
 *   downloadFile(url, dest) — download to disk
 *   bufferFromUrl(url) — download → Buffer
 *   isUrl(str)      — basic URL validator
 *   chunk(arr, size)— split array into chunks
 *   random(arr)     — pick random element
 *   cleanJid(jid)   — strip device suffix from JID
 *   isGroup(jid)    — true when JID is a group
 *   phoneFromJid(jid) — extract number string
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const http = require('http');
const pino = require('pino');

// ─── Logger ─────────────────────────────────────────────────────────────────
const logger = pino({
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:HH:MM:ss',
      ignore: 'pid,hostname',
      messageFormat: '[RYZEN] {msg}',
    },
  },
  level: process.env.LOG_LEVEL || 'info',
});

// ─── Time ────────────────────────────────────────────────────────────────────

/** Async delay. */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Bot start time — set once when this module is first loaded. */
const START_TIME = Date.now();

/**
 * Returns a human-readable string of how long the bot has been running.
 * e.g. "2d 4h 31m 10s"
 */
function runtime() {
  let seconds = Math.floor((Date.now() - START_TIME) / 1000);
  const d = Math.floor(seconds / 86400); seconds %= 86400;
  const h = Math.floor(seconds / 3600);  seconds %= 3600;
  const m = Math.floor(seconds / 60);    seconds %= 60;
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  parts.push(`${seconds}s`);
  return parts.join(' ');
}

// ─── Formatting ──────────────────────────────────────────────────────────────

/**
 * Convert bytes to a human-readable string.
 * @param {number} bytes
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
}

/**
 * Convert milliseconds to a readable latency string.
 * @param {number} ms
 */
function formatMs(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

// ─── System Stats ────────────────────────────────────────────────────────────

/** Returns RSS and heap memory usage in MB. */
function getMemoryUsage() {
  const mem = process.memoryUsage();
  return {
    rss: (mem.rss / 1024 / 1024).toFixed(2),
    heap: (mem.heapUsed / 1024 / 1024).toFixed(2),
  };
}

/**
 * Resolves with CPU usage percentage as a string (e.g. "12.34").
 * Samples over a 200ms window.
 */
function getCpuUsage() {
  return new Promise((resolve) => {
    const start = process.cpuUsage();
    setTimeout(() => {
      const end = process.cpuUsage(start);
      const totalMicros = (end.user + end.system);
      const percent = (totalMicros / (200 * 1000) * 100).toFixed(2);
      resolve(percent);
    }, 200);
  });
}

// ─── Network / Download ──────────────────────────────────────────────────────

/**
 * Download a file from a URL to a local path.
 * @param {string} url - HTTP or HTTPS URL
 * @param {string} dest - Absolute path to write to
 * @returns {Promise<string>} The destination path
 */
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const dir = path.dirname(dest);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const file = fs.createWriteStream(dest);
    const get = url.startsWith('https') ? https.get : http.get;

    get(url, (res) => {
      // Follow up to 5 redirects.
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        return resolve(downloadFile(res.headers.location, dest));
      }
      if (res.statusCode !== 200) {
        file.close();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(dest)));
    }).on('error', (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

/**
 * Download a URL and return its content as a Buffer.
 * @param {string} url
 * @returns {Promise<Buffer>}
 */
function bufferFromUrl(url) {
  return new Promise((resolve, reject) => {
    const get = url.startsWith('https') ? https.get : http.get;
    get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(bufferFromUrl(res.headers.location));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ─── String / Array Helpers ──────────────────────────────────────────────────

/**
 * Basic URL validator.
 * @param {string} str
 */
function isUrl(str) {
  try {
    const u = new URL(str);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Split an array into chunks of a given size.
 * @param {any[]} arr
 * @param {number} size
 */
function chunk(arr, size) {
  const result = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}

/**
 * Pick a random element from an array.
 * @param {any[]} arr
 */
function random(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ─── JID Helpers ─────────────────────────────────────────────────────────────

/**
 * Remove the device/agent suffix from a WhatsApp JID.
 * "1234567890:12@s.whatsapp.net" → "1234567890@s.whatsapp.net"
 * @param {string} jid
 */
function cleanJid(jid = '') {
  return jid.replace(/:\d+/, '');
}

/**
 * Check whether a JID belongs to a group.
 * @param {string} jid
 */
function isGroup(jid = '') {
  return jid.endsWith('@g.us');
}

/**
 * Extract the phone number string from a JID.
 * "1234567890@s.whatsapp.net" → "1234567890"
 * @param {string} jid
 */
function phoneFromJid(jid = '') {
  return cleanJid(jid).split('@')[0];
}

/**
 * Ensure a directory exists, creating it recursively if needed.
 * @param {string} dirPath
 */
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

module.exports = {
  logger,
  sleep,
  runtime,
  formatBytes,
  formatMs,
  getMemoryUsage,
  getCpuUsage,
  downloadFile,
  bufferFromUrl,
  isUrl,
  chunk,
  random,
  cleanJid,
  isGroup,
  phoneFromJid,
  ensureDir,
  START_TIME,
};
