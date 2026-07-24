'use strict';

/**
 * config.js — Central configuration for RYZEN.
 *
 * All environment variables are read here and exported as a
 * single frozen object. Every other module imports from this
 * file instead of touching process.env directly.
 */

require('dotenv').config();

const config = {
  // ─── Session ────────────────────────────────────────────
  /** Base64-encoded session string. Empty on first run. */
  sessionId: process.env.SESSION_ID || '',

  // ─── Bot Behaviour ──────────────────────────────────────
  /** Command trigger character (default ".") */
  prefix: process.env.PREFIX || '.',

  /**
   * "private" — only respond to DMs and sudo users.
   * "public"  — respond to everyone in all chats.
   */
  workType: (process.env.WORK_TYPE || 'public').toLowerCase(),

  // ─── Owner & Identity ───────────────────────────────────
  /**
   * Comma-separated list of sudo numbers (with country code, no "+").
   * Example: "919876543210,447911123456"
   */
  sudoNumbers: (process.env.SUDO || '919888280858')
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean),

  botName: process.env.BOT_NAME || 'RYZEN',
  ownerName: process.env.OWNER_NAME || 'SY4M',

  // ─── Sticker Metadata ───────────────────────────────────
  stickerName: process.env.STICKER_NAME || 'RYZEN',
  stickerAuthor: process.env.STICKER_AUTHOR || 'SY4M',

  // ─── AI / ChatBot ───────────────────────────────────────
  openAiKey: process.env.OPENAI_API_KEY || '',

  /** OpenAI model used for chat and AI commands */
  aiModel: 'gpt-4o-mini',

  // ─── Database ───────────────────────────────────────────
  /**
   * When set, the bot connects to PostgreSQL.
   * When empty, it falls back to SQLite.
   */
  databaseUrl: process.env.DATABASE_URL || '',

  /** SQLite database file path (used only when databaseUrl is empty) */
  sqlitePath: './database/ryzen.db',

  // ─── Server ─────────────────────────────────────────────
  /** HTTP port for the keep-alive server */
  port: parseInt(process.env.PORT || '3000', 10),

  // ─── Auto Features ──────────────────────────────────────
  autoRead: process.env.AUTO_READ === 'true',
  autoReact: process.env.AUTO_REACT === 'true',
  autoStatusSeen: process.env.AUTO_STATUS_SEEN === 'true',

  // ─── Paths ──────────────────────────────────────────────
  sessionDir: './session',
  pluginsDir: './plugins',
  mediaDir: './media',

  // ─── Bot Version ────────────────────────────────────────
  version: '1.0.0',
};

// Freeze so no module accidentally mutates global config.
module.exports = Object.freeze(config);
