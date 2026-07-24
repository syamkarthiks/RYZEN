'use strict';

/**
 * index.js — RYZEN WhatsApp AI Userbot entry point.
 *
 * This file:
 *  1. Prints the startup banner
 *  2. Installs global error handlers (so the bot never crashes silently)
 *  3. Starts the keep-alive HTTP server
 *  4. Creates the Baileys socket and connects
 */

const figlet = require('figlet');
const chalk = require('chalk');
const { createSocket, startKeepAliveServer } = require('./lib/connection');
const { logger } = require('./lib/utils');
const config = require('./config');

// ─── Startup Banner ──────────────────────────────────────────────────────────
function printBanner() {
  const banner = figlet.textSync('RYZEN', {
    font: 'ANSI Shadow',
    horizontalLayout: 'default',
  });

  console.log(chalk.cyanBright(banner));
  console.log(chalk.gray('─'.repeat(60)));
  console.log(chalk.white(`  Bot Name   : ${chalk.cyan(config.botName)}`));
  console.log(chalk.white(`  Owner      : ${chalk.cyan(config.ownerName)}`));
  console.log(chalk.white(`  Prefix     : ${chalk.cyan(config.prefix)}`));
  console.log(chalk.white(`  Work Type  : ${chalk.cyan(config.workType)}`));
  console.log(chalk.white(`  Version    : ${chalk.cyan(config.version)}`));
  console.log(chalk.white(`  Node       : ${chalk.cyan(process.version)}`));
  console.log(chalk.gray('─'.repeat(60)));
  console.log();
}

// ─── Global Error Handlers ───────────────────────────────────────────────────
// These catch any unhandled error so a buggy plugin never kills the process.

process.on('uncaughtException', (err) => {
  logger.error({ err }, '💥 Uncaught Exception — the bot will continue running');
});

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, '💥 Unhandled Promise Rejection — the bot will continue running');
});

// Graceful shutdown on Ctrl+C / SIGTERM (Render, Railway, etc.)
process.on('SIGINT', () => {
  logger.info('👋 SIGINT received — shutting down gracefully');
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('👋 SIGTERM received — shutting down gracefully');
  process.exit(0);
});

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  printBanner();

  // Start the HTTP keep-alive server first so the hosting platform considers
  // the service healthy immediately.
  startKeepAliveServer();

  // Create the WhatsApp socket. This handles sessions, QR, pairing code,
  // plugin loading, and auto-reconnect internally.
  await createSocket();
}

main().catch((err) => {
  logger.error({ err }, 'Fatal startup error');
  process.exit(1);
});
