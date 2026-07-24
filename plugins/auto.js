'use strict';

/**
 * plugins/auto.js — Auto features and AFK system.
 *
 * Features:
 *   - Welcome message when someone joins a group
 *   - Goodbye message when someone leaves a group
 *   - AFK status (bot announces when an AFK user is mentioned)
 *
 * Commands:
 *   .welcome on [message]   — enable welcome with optional custom message
 *   .welcome off            — disable welcome
 *   .goodbye on [message]   — enable goodbye with optional custom message
 *   .goodbye off            — disable goodbye
 *   .afk [reason]           — set yourself as AFK
 *   .unafk                  — remove AFK status
 *
 * Note: AUTO_READ, AUTO_REACT, and AUTO_STATUS_SEEN are handled in events.js
 *       directly from config since they require no per-command storage.
 */

const db = require('../lib/database');
const config = require('../config');
const { logger, cleanJid, phoneFromJid } = require('../lib/utils');

// Default messages — can be overridden per group.
const DEFAULT_WELCOME = `👋 Welcome to *{groupName}*, @{number}!\n\nWe're glad to have you here. Please read the group rules.`;
const DEFAULT_GOODBYE = `😢 *{name}* has left the group. Goodbye!`;

// ─── Welcome / Goodbye ───────────────────────────────────────────────────────

/**
 * Handle group-participants.update events (join / leave).
 * Called by events.js.
 *
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {{ id: string, participants: string[], action: string }} update
 */
async function handleGroupParticipantUpdate(sock, update) {
  const { id: groupJid, participants, action } = update;

  for (const participantJid of participants) {
    const number = phoneFromJid(participantJid);

    if (action === 'add') {
      // ── Welcome ──────────────────────────────────────────────────────────
      try {
        const enabled = await db.chatSetting(groupJid, 'welcome');
        if (enabled !== 'on') continue;

        const meta = await sock.groupMetadata(groupJid);
        const customMsg = await db.chatSetting(groupJid, 'welcome_message');

        let text = (customMsg || DEFAULT_WELCOME)
          .replace('{groupName}', meta.subject)
          .replace('{number}', number)
          .replace('{name}', number);

        await sock.sendMessage(groupJid, {
          text,
          mentions: [participantJid],
        });
      } catch (err) {
        logger.error({ err }, 'Welcome message failed');
      }
    } else if (action === 'remove') {
      // ── Goodbye ──────────────────────────────────────────────────────────
      try {
        const enabled = await db.chatSetting(groupJid, 'goodbye');
        if (enabled !== 'on') continue;

        const customMsg = await db.chatSetting(groupJid, 'goodbye_message');
        const text = (customMsg || DEFAULT_GOODBYE)
          .replace('{number}', number)
          .replace('{name}', number);

        await sock.sendMessage(groupJid, { text });
      } catch (err) {
        logger.error({ err }, 'Goodbye message failed');
      }
    }
  }
}

// ─── AFK ─────────────────────────────────────────────────────────────────────

/**
 * Check if a mentioned user is AFK and notify the group.
 * Called by events.js when a message has mentions.
 *
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {object} msg — serialized message
 */
async function checkAfk(sock, msg) {
  for (const mentionedJid of msg.mention) {
    const row = await db.get(
      'SELECT reason, since FROM afk_users WHERE jid = ?',
      [cleanJid(mentionedJid)]
    );

    if (!row) continue;

    const sinceDate = new Date(row.since * 1000).toLocaleString();
    await msg.reply(
      `⏸️ @${phoneFromJid(mentionedJid)} is currently AFK.\n` +
      `📝 Reason: ${row.reason}\n` +
      `🕐 Since: ${sinceDate}`,
      { mentions: [mentionedJid] }
    );
  }

  // Check if the message sender was AFK — remove them automatically.
  const senderRow = await db.get(
    'SELECT reason FROM afk_users WHERE jid = ?',
    [msg.sender]
  );

  if (senderRow) {
    await db.run('DELETE FROM afk_users WHERE jid = ?', [msg.sender]);
    await msg.reply(
      `✅ Welcome back, @${phoneFromJid(msg.sender)}! Your AFK status has been removed.`,
      { mentions: [msg.sender] }
    );
  }
}

// ─── Commands ────────────────────────────────────────────────────────────────

module.exports = [
  // ── .welcome ───────────────────────────────────────────────────────────────
  {
    name: 'welcome',
    description: 'Enable or disable welcome messages in this group',
    usage: '.welcome on [custom message] | .welcome off',
    command: 'welcome',
    category: 'Group',
    isGroupOnly: true,
    isOwnerOnly: true,

    async execute(sock, msg, args) {
      const action = args[0]?.toLowerCase();

      if (action === 'on') {
        await db.setChatSetting(msg.chatJid, 'welcome', 'on');
        const customMsg = args.slice(1).join(' ');
        if (customMsg) {
          await db.setChatSetting(msg.chatJid, 'welcome_message', customMsg);
        }
        await msg.reply(
          `✅ Welcome messages *enabled*.\n\n` +
          `Variables: {groupName} {number} {name}\n` +
          (customMsg ? `Message: ${customMsg}` : `Using default message.`)
        );
      } else if (action === 'off') {
        await db.setChatSetting(msg.chatJid, 'welcome', 'off');
        await msg.reply('❌ Welcome messages *disabled*.');
      } else {
        const enabled = await db.chatSetting(msg.chatJid, 'welcome');
        const customMsg = await db.chatSetting(msg.chatJid, 'welcome_message');
        await msg.reply(
          `👋 *Welcome Settings*\n\n` +
          `Status: ${enabled === 'on' ? '✅ Enabled' : '❌ Disabled'}\n` +
          `Message: ${customMsg || '(default)'}`
        );
      }
    },
  },

  // ── .goodbye ───────────────────────────────────────────────────────────────
  {
    name: 'goodbye',
    description: 'Enable or disable goodbye messages in this group',
    usage: '.goodbye on [custom message] | .goodbye off',
    command: ['goodbye', 'bye'],
    category: 'Group',
    isGroupOnly: true,
    isOwnerOnly: true,

    async execute(sock, msg, args) {
      const action = args[0]?.toLowerCase();

      if (action === 'on') {
        await db.setChatSetting(msg.chatJid, 'goodbye', 'on');
        const customMsg = args.slice(1).join(' ');
        if (customMsg) {
          await db.setChatSetting(msg.chatJid, 'goodbye_message', customMsg);
        }
        await msg.reply(
          `✅ Goodbye messages *enabled*.\n\n` +
          `Variables: {number} {name}\n` +
          (customMsg ? `Message: ${customMsg}` : `Using default message.`)
        );
      } else if (action === 'off') {
        await db.setChatSetting(msg.chatJid, 'goodbye', 'off');
        await msg.reply('❌ Goodbye messages *disabled*.');
      } else {
        const enabled = await db.chatSetting(msg.chatJid, 'goodbye');
        const customMsg = await db.chatSetting(msg.chatJid, 'goodbye_message');
        await msg.reply(
          `😢 *Goodbye Settings*\n\n` +
          `Status: ${enabled === 'on' ? '✅ Enabled' : '❌ Disabled'}\n` +
          `Message: ${customMsg || '(default)'}`
        );
      }
    },
  },

  // ── .afk ───────────────────────────────────────────────────────────────────
  {
    name: 'afk',
    description: 'Set yourself as Away From Keyboard',
    usage: '.afk [reason]',
    command: 'afk',
    category: 'General',

    async execute(sock, msg, args) {
      const reason = args.join(' ') || 'AFK';
      const now = Math.floor(Date.now() / 1000);

      await db.run(
        'INSERT OR REPLACE INTO afk_users (jid, reason, since) VALUES (?, ?, ?)',
        [msg.sender, reason, now]
      );

      await msg.reply(
        `⏸️ You are now AFK.\n📝 Reason: ${reason}\n\nSend any message to remove AFK status.`
      );
    },
  },

  // ── .unafk ─────────────────────────────────────────────────────────────────
  {
    name: 'unafk',
    description: 'Remove your AFK status',
    usage: '.unafk',
    command: 'unafk',
    category: 'General',

    async execute(sock, msg) {
      const row = await db.get('SELECT reason FROM afk_users WHERE jid = ?', [msg.sender]);

      if (!row) {
        await msg.reply("You are not currently AFK.");
        return;
      }

      await db.run('DELETE FROM afk_users WHERE jid = ?', [msg.sender]);
      await msg.reply('✅ Your AFK status has been removed. Welcome back!');
    },
  },

  // ── .restart ───────────────────────────────────────────────────────────────
  {
    name: 'restart',
    description: 'Restart the bot process',
    usage: '.restart',
    command: 'restart',
    category: 'Owner',
    isOwnerOnly: true,

    async execute(sock, msg) {
      await msg.reply('🔄 Restarting RYZEN…');
      setTimeout(() => process.exit(0), 1000);
    },
  },

  // ── .shutdown ──────────────────────────────────────────────────────────────
  {
    name: 'shutdown',
    description: 'Shut down the bot process',
    usage: '.shutdown',
    command: 'shutdown',
    category: 'Owner',
    isOwnerOnly: true,

    async execute(sock, msg) {
      await msg.reply('🛑 Shutting down RYZEN. Goodbye!');
      setTimeout(() => process.exit(0), 1000);
    },
  },
];

// ─── Exported for events.js ──────────────────────────────────────────────────
module.exports.handleGroupParticipantUpdate = handleGroupParticipantUpdate;
module.exports.checkAfk = checkAfk;
