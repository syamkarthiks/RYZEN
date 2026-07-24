'use strict';

/**
 * lib/database.js — Database abstraction layer.
 *
 * SQLite backend: uses the built-in `node:sqlite` module (Node 22.5+).
 *   No native compilation required — zero Python / node-gyp dependencies.
 *
 * PostgreSQL backend: uses the `pg` npm package.
 *   Activated automatically when the DATABASE_URL environment variable is set.
 *
 * Exported API (identical regardless of backend):
 *   db.get(sql, params)            → single row object or undefined
 *   db.all(sql, params)            → array of row objects
 *   db.run(sql, params)            → { changes, lastInsertRowid }
 *   db.setting(key)                → string value or null
 *   db.setSetting(key, value)      → void
 *   db.chatSetting(jid, key)       → string value or null
 *   db.setChatSetting(jid,key,val) → void
 */

const path = require('path');
const fs = require('fs');
const config = require('../config');
const { logger } = require('./utils');

// ─── Ensure the /database directory exists ───────────────────────────────────
const dbDir = path.resolve('./database');
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

// ─── Schema (shared by both backends) ────────────────────────────────────────
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS chat_settings (
    jid   TEXT NOT NULL,
    key   TEXT NOT NULL,
    value TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (jid, key)
  );

  CREATE TABLE IF NOT EXISTS sudo_users (
    number   TEXT PRIMARY KEY,
    added_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS deleted_messages (
    id         TEXT PRIMARY KEY,
    chat_jid   TEXT NOT NULL,
    sender_jid TEXT NOT NULL,
    content    TEXT,
    media_type TEXT,
    media_data BLOB,
    deleted_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS conversation_memory (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_jid TEXT NOT NULL,
    role     TEXT NOT NULL,
    content  TEXT NOT NULL,
    ts       INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS afk_users (
    jid    TEXT PRIMARY KEY,
    reason TEXT NOT NULL DEFAULT 'AFK',
    since  INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS welcome_settings (
    jid     TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 0,
    message TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS goodbye_settings (
    jid     TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 0,
    message TEXT NOT NULL DEFAULT ''
  );
`;

// ────────────────────────────────────────────────────────────────────────────
//  SQLite backend — uses built-in node:sqlite (Node.js 22.5+, no gyp needed)
// ────────────────────────────────────────────────────────────────────────────
function createSQLiteDB() {
  // node:sqlite is a built-in module — no npm install required.
  const { DatabaseSync } = require('node:sqlite');

  const dbPath = path.resolve(config.sqlitePath);
  const db = new DatabaseSync(dbPath);

  // Performance pragmas.
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA synchronous = NORMAL;");

  // Initialise schema.
  db.exec(SCHEMA);

  logger.info('📦 Database: SQLite (node:sqlite built-in) connected');

  return {
    /**
     * Return a single row matching the query, or undefined.
     * @param {string} sql   - Parameterised SQL (uses ? placeholders)
     * @param {any[]}  params - Bind parameters
     * @returns {object|undefined}
     */
    get(sql, params = []) {
      return db.prepare(sql).get(...params);
    },

    /**
     * Return all matching rows.
     * @param {string} sql
     * @param {any[]}  params
     * @returns {object[]}
     */
    all(sql, params = []) {
      return db.prepare(sql).all(...params);
    },

    /**
     * Execute a write statement.
     * @param {string} sql
     * @param {any[]}  params
     * @returns {{ changes: number, lastInsertRowid: number|bigint }}
     */
    run(sql, params = []) {
      return db.prepare(sql).run(...params);
    },

    /** Read a global setting by key. Returns null if not found. */
    setting(key) {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
      return row ? row.value : null;
    },

    /** Write (upsert) a global setting. */
    setSetting(key, value) {
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
        .run(key, String(value));
    },

    /** Read a per-chat setting. Returns null if not found. */
    chatSetting(jid, key) {
      const row = db
        .prepare('SELECT value FROM chat_settings WHERE jid = ? AND key = ?')
        .get(jid, key);
      return row ? row.value : null;
    },

    /** Write (upsert) a per-chat setting. */
    setChatSetting(jid, key, value) {
      db.prepare(
        'INSERT OR REPLACE INTO chat_settings (jid, key, value) VALUES (?, ?, ?)'
      ).run(jid, key, String(value));
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
//  PostgreSQL backend — async, uses `pg` npm package
// ────────────────────────────────────────────────────────────────────────────
function createPostgresDB() {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: config.databaseUrl,
    ssl: { rejectUnauthorized: false },
  });

  // Translate SQLite schema to PostgreSQL DDL.
  const PG_SCHEMA = SCHEMA
    .replace(/INTEGER PRIMARY KEY AUTOINCREMENT/g, 'SERIAL PRIMARY KEY')
    .replace(/unixepoch\(\)/g, "EXTRACT(EPOCH FROM NOW())::BIGINT")
    .replace(/BLOB/g, 'BYTEA')
    .replace(/INSERT OR REPLACE/g, 'INSERT')
    .replace(/TEXT PRIMARY KEY/g, 'TEXT PRIMARY KEY');

  pool.query(PG_SCHEMA).then(() => {
    logger.info('📦 Database: PostgreSQL connected');
  }).catch((err) => {
    logger.error({ err }, 'PostgreSQL schema init failed');
  });

  // Convert SQLite ? placeholders → PostgreSQL $1, $2, …
  function toPg(sql) {
    let i = 0;
    return sql.replace(/\?/g, () => `$${++i}`);
  }

  // Helper to convert INSERT OR REPLACE → INSERT … ON CONFLICT DO UPDATE
  function toUpsert(sql) {
    return sql.replace(/INSERT OR REPLACE/g, 'INSERT');
  }

  return {
    async get(sql, params = []) {
      const res = await pool.query(toPg(sql), params);
      return res.rows[0];
    },
    async all(sql, params = []) {
      const res = await pool.query(toPg(sql), params);
      return res.rows;
    },
    async run(sql, params = []) {
      const res = await pool.query(toPg(toUpsert(sql)), params);
      return { changes: res.rowCount, lastInsertRowid: null };
    },
    async setting(key) {
      const res = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
      return res.rows[0]?.value ?? null;
    },
    async setSetting(key, value) {
      await pool.query(
        `INSERT INTO settings (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [key, String(value)]
      );
    },
    async chatSetting(jid, key) {
      const res = await pool.query(
        'SELECT value FROM chat_settings WHERE jid = $1 AND key = $2',
        [jid, key]
      );
      return res.rows[0]?.value ?? null;
    },
    async setChatSetting(jid, key, value) {
      await pool.query(
        `INSERT INTO chat_settings (jid, key, value) VALUES ($1, $2, $3)
         ON CONFLICT (jid, key) DO UPDATE SET value = EXCLUDED.value`,
        [jid, key, String(value)]
      );
    },
  };
}

// ─── Export the appropriate backend ─────────────────────────────────────────
const db = config.databaseUrl ? createPostgresDB() : createSQLiteDB();

module.exports = db;
