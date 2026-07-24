'use strict';

/**
 * lib/events.js — Central event router for RYZEN.
 *
 * Binds to Baileys socket events and dispatches each message to the
 * appropriate plugin command, auto-features, and anti-delete handler.
 *
 * Responsibilities:
 *  - messages.upsert  → serialize → command dispatch
 *  - messages.delete  → anti-delete handler
 *  - group-participants.update → welcome / goodbye handler
 *  - Auto read / auto react / auto status-seen
 *  - Rate-limit per sender (1 command per 1.5 seconds)
 */

const config = require('../config');
const { serialize } = require('./serialize');
const { getCommand } = require('./pluginLoader');
const { logger, cleanJid } = require('./utils');

/** Simple rate-limit bucket: sender JID → last command timestamp. */
const rateLimitMap = new Map();
const RATE_LIMIT_MS = 1500;

/**
 * Determine whether a message should be processed based on WORK_TYPE.
 * @param {object} msg — serialized message
 */
function isAllowed(msg) {
  if (config.workType === 'public') return true;

  // private mode: only respond to the bot itself and sudo numbers.
  if (msg.fromMe) return true;
  if (msg.isOwner) return true;
  return false;
}

/**
 * Handle the messages.upsert event.
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {{ messages: object[], type: string }} upsert
 */
async function handleMessages(sock, upsert) {
  if (upsert.type !== 'notify') return;

  for (const rawMsg of upsert.messages) {
    // Skip status broadcasts.
    if (rawMsg.key?.remoteJid === 'status@broadcast') {
      if (config.autoStatusSeen) {
        await sock.readMessages([rawMsg.key]).catch(() => {});
      }
      continue;
    }

    const msg = serialize(sock, rawMsg);

    // Skip protocol / reaction / empty messages.
    if (!msg.message || msg.type === 'protocol' || msg.type === 'reaction') continue;

    // ── Auto Read ───────────────────────────────────────────────────────
    if (config.autoRead && !msg.fromMe) {
      await sock.readMessages([msg.key]).catch(() => {});
    }

    // ── Auto React ──────────────────────────────────────────────────────
    if (config.autoReact && !msg.fromMe) {
      const emojis = ['👍', '❤️', '🔥', '😊', '✅'];
      await msg.react(emojis[Math.floor(Math.random() * emojis.length)]).catch(() => {});
    }

    // ── View-Once auto-forward ───────────────────────────────────────────
    // If the message contains a view-once envelope, silently download it
    // and forward it to the owner's DM before WhatsApp marks it as seen.
    if (!msg.fromMe) {
      try {
        const { isViewOnce, handleViewOnce } = require('../plugins/vv');
        if (isViewOnce(msg)) {
          handleViewOnce(sock, msg).catch(() => {}); // fire-and-forget
        }
      } catch (_) { /* vv plugin not loaded */ }
    }

    // ── Anti-Delete tracking ────────────────────────────────────────────
    // Store every non-bot message so it can be recovered if deleted.
    if (!msg.fromMe) {
      try {
        const { trackMessage } = require('../plugins/antidelete');
        await trackMessage(msg);
      } catch (_) { /* antidelete plugin not loaded */ }
    }

    // ── AFK detection ───────────────────────────────────────────────────
    if (!msg.fromMe && msg.mention?.length > 0) {
      try {
        const { checkAfk } = require('../plugins/auto');
        await checkAfk(sock, msg);
      } catch (_) { /* auto plugin not loaded */ }
    }

    // ── ChatBot ─────────────────────────────────────────────────────────
    // Only process as chatbot if no command prefix is present.
    const hasPrefix = msg.text?.startsWith(config.prefix);
    if (!hasPrefix && !msg.fromMe) {
      try {
        const { handleChatbot } = require('../plugins/chatbot');
        const responded = await handleChatbot(sock, msg);
        if (responded) continue;
      } catch (_) { /* chatbot plugin not loaded */ }
    }

    // ── Command Dispatch ─────────────────────────────────────────────────
    if (!hasPrefix) continue;

    const [rawCommand, ...args] = msg.text.slice(config.prefix.length).trim().split(/\s+/);
    const command = rawCommand?.toLowerCase();
    if (!command) continue;

    const plugin = getCommand(command);
    if (!plugin) continue;

    // Work-type gate.
    if (!isAllowed(msg)) continue;

    // Owner-only gate.
    // Re-check sudo directly here as a reliable fallback — catches any edge
    // case where serialize()'s isOwner was computed on a differently-shaped JID.
    const senderNum   = msg.sender?.split('@')[0]   || '';
    const chatNum     = msg.chatJid?.split('@')[0]  || '';
    const directSudo  = config.sudoNumbers.some(
      (n) => n === senderNum || n === chatNum
    );
    const isAuthorised = msg.fromMe || msg.isOwner || directSudo;

    if (plugin.isOwnerOnly && !isAuthorised) {
      await msg.reply('🚫 This command is restricted to the bot owner.').catch(() => {});
      continue;
    }

    // Group-only gate.
    if (plugin.isGroupOnly && !msg.isGroup) {
      await msg.reply('🚫 This command can only be used in groups.').catch(() => {});
      continue;
    }

    // DM-only gate.
    if (plugin.isDmOnly && msg.isGroup) {
      await msg.reply('🚫 This command can only be used in private chats.').catch(() => {});
      continue;
    }

    // Rate limit.
    const now = Date.now();
    const last = rateLimitMap.get(msg.sender) || 0;
    if (now - last < RATE_LIMIT_MS) continue;
    rateLimitMap.set(msg.sender, now);

    // Execute the command inside a try/catch so a broken plugin never
    // takes down the whole bot.
    try {
      await plugin.execute(sock, msg, args);
    } catch (err) {
      logger.error({ err, command }, 'Plugin execution error');
      await msg
        .reply(`❌ An error occurred while running *${config.prefix}${command}*.\n\n\`${err.message}\``)
        .catch(() => {});
    }
  }
}

/**
 * Handle the messages.delete event (for anti-delete recovery).
 *
 * Baileys 6.x emits ONE object per event, NOT an array:
 *   { keys: WAMessageKey[] }          — specific messages deleted
 *   { jid: string, all: true }        — entire chat cleared
 *
 * Previous code tried to `for...of` the object (TypeError → silently caught),
 * so anti-delete recovery never fired. Fixed below.
 *
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {{ keys?: object[], jid?: string, all?: boolean }} update
 */
async function handleDelete(sock, update) {
  try {
    const { handleAntiDelete } = require('../plugins/antidelete');

    // Handle individual key deletions.
    if (Array.isArray(update.keys) && update.keys.length > 0) {
      for (const key of update.keys) {
        await handleAntiDelete(sock, key);
      }
      return;
    }

    // Some Baileys versions may still emit an array of objects — handle both.
    if (Array.isArray(update)) {
      for (const item of update) {
        const keys = item.keys || [];
        for (const key of keys) {
          await handleAntiDelete(sock, key);
        }
      }
    }
  } catch (err) {
    logger.warn({ err }, 'handleDelete error');
  }
}

/**
 * Handle the group-participants.update event (welcome / goodbye).
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {object} update
 */
async function handleGroupUpdate(sock, update) {
  try {
    const { handleGroupParticipantUpdate } = require('../plugins/auto');
    await handleGroupParticipantUpdate(sock, update);
  } catch (_) { /* auto plugin not loaded */ }
}

/**
 * Attach all event handlers to a Baileys socket.
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 */
function attachEvents(sock) {
  sock.ev.on('messages.upsert', (upsert) => handleMessages(sock, upsert));
  sock.ev.on('messages.delete', (deletions) => handleDelete(sock, deletions));
  sock.ev.on('group-participants.update', (update) => handleGroupUpdate(sock, update));

  logger.info('🔌 Event handlers attached');
}

module.exports = { attachEvents };
