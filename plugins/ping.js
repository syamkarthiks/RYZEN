'use strict';

/**
 * plugins/ping.js — System status commands.
 *
 * Commands:
 *   .ping    — latency + quick system snapshot
 *   .alive   — confirm bot is running
 *   .runtime — uptime only
 *   .system  — detailed system stats
 */

const os = require('os');
const { version: baileysVersion } = require('@whiskeysockets/baileys/package.json');
const config = require('../config');
const { runtime, formatBytes, formatMs, getMemoryUsage, getCpuUsage } = require('../lib/utils');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Format an OS uptime (seconds) into a human-readable string. */
function formatOsUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${d}d ${h}h ${m}m ${s}s`;
}

// ─── Commands ────────────────────────────────────────────────────────────────

module.exports = [
  // ── .ping ──────────────────────────────────────────────────────────────────
  {
    name: 'ping',
    description: 'Check bot latency and basic system stats',
    usage: '.ping',
    command: 'ping',
    category: 'General',

    async execute(sock, msg) {
      const start = Date.now();

      // Sending the message itself measures the round-trip time.
      await msg.reply('🏓 Pinging…');

      const latency = Date.now() - start;
      const mem = getMemoryUsage();
      const cpu = await getCpuUsage();

      const text = [
        `*🏓 PONG — ${config.botName} is Alive!*`,
        '',
        `⚡ *Latency*   : ${formatMs(latency)}`,
        `⏱️  *Runtime*   : ${runtime()}`,
        `🧠 *Memory*    : ${mem.heap} MB heap / ${mem.rss} MB`,
        `📦 *Node*      : ${process.version}`,
      ].join('\n');

      await msg.reply(text);
    },
  },

  // ── .alive ─────────────────────────────────────────────────────────────────
  {
    name: 'alive',
    description: 'Check if the bot is running',
    usage: '.alive',
    command: 'alive',
    category: 'General',

    async execute(sock, msg) {
      await msg.reply(
        `✅ *${config.botName}* is alive and kicking!\n\n` +
        `⏱️ Uptime: *${runtime()}*\n` +
        `👤 Owner: *${config.ownerName}*`
      );
    },
  },

  // ── .runtime ───────────────────────────────────────────────────────────────
  {
    name: 'runtime',
    description: 'Show how long the bot has been running',
    usage: '.runtime',
    command: ['runtime', 'uptime'],
    category: 'General',

    async execute(sock, msg) {
      await msg.reply(`⏱️ *Bot Runtime*\n\n${runtime()}`);
    },
  },

  // ── .system ────────────────────────────────────────────────────────────────
  {
    name: 'system',
    description: 'Show detailed system information',
    usage: '.system',
    command: 'system',
    category: 'General',
    isOwnerOnly: true,

    async execute(sock, msg) {
      const mem = getMemoryUsage();
      const cpu = await getCpuUsage();
      const freeMem = formatBytes(os.freemem());
      const totalMem = formatBytes(os.totalmem());
      const cpuModel = os.cpus()[0]?.model || 'Unknown';
      const cpuCount = os.cpus().length;

      const text = [
        `*🖥️  System Information*`,
        '',
        `📛 *Bot*        : ${config.botName} v${config.version}`,
        `⏱️  *Bot Uptime* : ${runtime()}`,
        `🖥️  *OS Uptime*  : ${formatOsUptime(os.uptime())}`,
        '',
        `🖥️  *Platform*   : ${os.platform()} ${os.arch()}`,
        `🖥️  *CPU*        : ${cpuModel} (${cpuCount} cores)`,
        `🖥️  *CPU Load*   : ${cpu}%`,
        '',
        `🧠 *Heap Used*  : ${mem.heap} MB`,
        `🧠 *RSS*        : ${mem.rss} MB`,
        `🧠 *Free RAM*   : ${freeMem} / ${totalMem}`,
        '',
        `📦 *Node.js*    : ${process.version}`,
        `📡 *Baileys*    : v${baileysVersion}`,
      ].join('\n');

      await msg.reply(text);
    },
  },
];
