'use strict';

/**
 * plugins/antidelete.js — Anti-delete message recovery.
 *
 * Features:
 *   - Tracks all incoming messages in an in-memory store (last 500 per chat).
 *   - When a message is deleted, checks if the chat has anti-delete enabled.
 *   - If enabled: recovers and re-sends the original content.
 *   - Supports text, images, videos, audio, stickers, and documents.
 *
 * Commands:
 *   .antidelete on  — enable anti-delete in this chat
 *   .antidelete off — disable anti-delete in this chat
 *   .antidelete     — check current status
 *
 * Storage: database (chat_settings table, key = "antidelete")
 */

const db = require('../lib/database');
const config = require('../config');
const { logger, cleanJid } = require('../lib/utils');

// ─── In-memory message store ─────────────────────────────────────────────────
// Map of messageId → serialized message object.
// Limited to the last 500 messages per chat to avoid memory bloat.
const messageStore = new Map();
const MAX_STORED_PER_CHAT = 500;

/** Per-chat linked list to track insertion order for eviction. */
const chatMessageIds = new Map(); // chatJid → string[]

/**
 * Store a message in memory so it can be recovered if deleted.
 * Called by events.js for every non-bot incoming message.
 * @param {object} msg — serialized message
 */
function trackMessage(msg) {
  if (msg.isBotMessage) return;
  if (!msg.chatJid || !msg.key?.id) return;

  const id = msg.key.id;
  const chatJid = msg.chatJid;

  // Maintain per-chat message list.
  if (!chatMessageIds.has(chatJid)) chatMessageIds.set(chatJid, []);
  const chatIds = chatMessageIds.get(chatJid);
  chatIds.push(id);

  // Evict oldest if over limit.
  if (chatIds.length > MAX_STORED_PER_CHAT) {
    const oldId = chatIds.shift();
    messageStore.delete(`${chatJid}:${oldId}`);
  }

  messageStore.set(`${chatJid}:${id}`, msg);
}

/**
 * Check whether anti-delete is enabled for a given JID.
 * @param {string} jid
 * @returns {boolean}
 */
async function isEnabled(jid) {
  const value = await db.chatSetting(jid, 'antidelete');
  return value === 'on';
}

/**
 * Handle a message deletion event.
 * Called by events.js when messages.delete fires.
 *
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {object} key — WAMessageKey of the deleted message
 */
async function handleAntiDelete(sock, key) {
  try {
    const chatJid = key.remoteJid;
    if (!chatJid) return;

    const storeKey = `${chatJid}:${key.id}`;
    const original = messageStore.get(storeKey);
    if (!original) return; // Message not in our store (too old or bot's own message).

    const sender       = original.sender;
    const senderNumber = sender.split('@')[0];
    const senderPhone  = `+${senderNumber}`;

    // Format date & time nicely
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    const timeStr = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });

    // Determine if antidelete is on for this chat (send back to the chat).
    const chatEnabled  = await isEnabled(chatJid);

    // Always forward to owner DM.
    const ownerJid = config.sudoNumbers.length > 0
      ? `${config.sudoNumbers[0]}@s.whatsapp.net`
      : null;

    // Resolve chat name: for groups fetch the group subject, for DMs use the number.
    let chatName = chatJid;
    const isGroupChat = chatJid.endsWith('@g.us');
    if (isGroupChat) {
      try {
        const meta = await sock.groupMetadata(chatJid);
        chatName = meta?.subject || chatJid;
      } catch (_) {
        chatName = chatJid;
      }
    } else {
      chatName = `+${chatJid.split('@')[0]}` + ' (DM)';
    }

    const header =
      `🗑️ *Deleted Message Recovered*\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `👤 *Deleted by* : ${senderPhone}\n` +
      `💬 *From*       : ${isGroupChat ? '👥 ' : '💬 '}${chatName}\n` +
      `📅 *Date*       : ${dateStr}\n` +
      `🕐 *Time*       : ${timeStr}\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;

    const type = original.type;

    /**
     * Send the recovered content to a given JID.
     * @param {string} targetJid
     */
    async function sendRecovered(targetJid) {
      if (type === 'text') {
        await sock.sendMessage(targetJid, {
          text: header + (original.text || '(empty)'),
          mentions: [sender],
        });
      } else if (['image', 'video', 'audio', 'document', 'sticker'].includes(type)) {
        try {
          const mediaBuffer  = await original.download();
          const mediaPayload = { mentions: [sender] };

          if (type === 'image') {
            mediaPayload.image   = mediaBuffer;
            mediaPayload.caption = header + (original.text || '');
          } else if (type === 'video') {
            mediaPayload.video   = mediaBuffer;
            mediaPayload.caption = header + (original.text || '');
          } else if (type === 'audio') {
            await sock.sendMessage(targetJid, { text: header, mentions: [sender] });
            mediaPayload.audio    = mediaBuffer;
            mediaPayload.mimetype = 'audio/mpeg';
          } else if (type === 'sticker') {
            await sock.sendMessage(targetJid, { text: header, mentions: [sender] });
            mediaPayload.sticker = mediaBuffer;
          } else if (type === 'document') {
            mediaPayload.document = mediaBuffer;
            mediaPayload.fileName = original._raw?.documentMessage?.fileName || 'file';
            mediaPayload.caption  = header;
          }

          await sock.sendMessage(targetJid, mediaPayload);
        } catch (mediaErr) {
          await sock.sendMessage(targetJid, {
            text: header + `[Media unavailable — could not download ${type}]`,
            mentions: [sender],
          });
        }
      } else {
        await sock.sendMessage(targetJid, {
          text: header + `[${type} message]`,
          mentions: [sender],
        });
      }
    }

    // ── Send to original chat if antidelete is enabled there ──────────────
    if (chatEnabled) {
      await sendRecovered(chatJid);
    }

    // ── Always forward to owner DM ────────────────────────────────────────
    // Skip if the deleted message was already in the owner's own DM.
    if (ownerJid && chatJid !== ownerJid) {
      await sendRecovered(ownerJid);
    }

  } catch (err) {
    logger.error({ err }, 'handleAntiDelete failed');
  }
}

// ─── Commands ────────────────────────────────────────────────────────────────

module.exports = [
  {
    name: 'antidelete',
    description: 'Recover deleted messages in this chat',
    usage: '.antidelete on | off',
    command: ['antidelete', 'ad'],
    category: 'General',
    isOwnerOnly: true,   // sudo users + the bot's own number only

    async execute(sock, msg, args) {
      const action = args[0]?.toLowerCase();
      const chatJid = msg.chatJid;

      if (action === 'on') {
        await db.setChatSetting(chatJid, 'antidelete', 'on');
        await msg.reply('✅ Anti-delete is now *enabled* in this chat.\nDeleted messages will be recovered automatically.');
      } else if (action === 'off') {
        await db.setChatSetting(chatJid, 'antidelete', 'off');
        await msg.reply('❌ Anti-delete is now *disabled* in this chat.');
      } else {
        const enabled = await isEnabled(chatJid);
        await msg.reply(
          `🗑️ *Anti-Delete Status*\n\n` +
          `Status: ${enabled ? '✅ Enabled' : '❌ Disabled'}\n\n` +
          `Use *${config.prefix}antidelete on* to enable.\n` +
          `Use *${config.prefix}antidelete off* to disable.`
        );
      }
    },
  },
];

// ─── Exported utilities (used by events.js) ──────────────────────────────────
module.exports.trackMessage = trackMessage;
module.exports.handleAntiDelete = handleAntiDelete;
