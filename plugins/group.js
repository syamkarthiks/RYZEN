'use strict';

/**
 * plugins/group.js — Group management commands.
 *
 * Commands (all group-only, owner-only):
 *   .tagall           — mention every group member
 *   .hidetag [text]   — mention everyone without visible tags
 *   .promote @user    — promote to admin
 *   .demote @user     — demote from admin
 *   .kick @user       — remove from group
 *   .add <number>     — add a number to the group
 *   .link             — get the group invite link
 *   .revoke           — revoke the invite link and generate a new one
 *   .group open       — open the group (all members can send messages)
 *   .group close      — close the group (only admins can send messages)
 */

const config = require('../config');
const { logger, cleanJid, phoneFromJid } = require('../lib/utils');

// ─── Helper: get the bot's JID in a group ────────────────────────────────────
function getBotJid(sock) {
  return cleanJid(sock.user?.id || '');
}

/**
 * Check if the bot is an admin in the group.
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {string} groupJid
 * @returns {Promise<boolean>}
 */
async function isBotAdmin(sock, groupJid) {
  const meta = await sock.groupMetadata(groupJid);
  const botJid = getBotJid(sock);
  const participant = meta.participants.find((p) => cleanJid(p.id) === botJid);
  return participant?.admin === 'admin' || participant?.admin === 'superadmin';
}

/**
 * Check if a given JID is an admin in the group.
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {string} groupJid
 * @param {string} jid
 * @returns {Promise<boolean>}
 */
async function isAdmin(sock, groupJid, jid) {
  const meta = await sock.groupMetadata(groupJid);
  const participant = meta.participants.find((p) => cleanJid(p.id) === cleanJid(jid));
  return participant?.admin === 'admin' || participant?.admin === 'superadmin';
}

/**
 * Resolve the target JID from a mention or quoted message.
 * @param {object} msg — serialized message
 * @param {string[]} args
 * @returns {string|null}
 */
function resolveTarget(msg, args) {
  // Prefer quoted sender.
  if (msg.quoted?.sender) return msg.quoted.sender;

  // Prefer first mention.
  if (msg.mention?.length > 0) return msg.mention[0];

  // Fallback: first arg as phone number.
  if (args[0]) {
    const num = args[0].replace(/[^0-9]/g, '');
    if (num.length >= 7) return `${num}@s.whatsapp.net`;
  }

  return null;
}

// ─── Commands ────────────────────────────────────────────────────────────────

module.exports = [
  // ── .tagall ────────────────────────────────────────────────────────────────
  {
    name: 'tagall',
    description: 'Mention all members in the group',
    usage: '.tagall [message]',
    command: 'tagall',
    category: 'Group',
    isGroupOnly: true,
    isOwnerOnly: true,

    async execute(sock, msg, args) {
      const meta = await sock.groupMetadata(msg.chatJid);
      const members = meta.participants.map((p) => p.id);
      const customText = args.join(' ') || 'Attention everyone!';

      const mentions = members.map((jid) => `@${phoneFromJid(jid)}`).join(' ');
      const text = `📢 *${customText}*\n\n${mentions}`;

      await sock.sendMessage(msg.chatJid, { text, mentions: members });
    },
  },

  // ── .hidetag ───────────────────────────────────────────────────────────────
  {
    name: 'hidetag',
    description: 'Mention all members without visible tags',
    usage: '.hidetag [message]',
    command: 'hidetag',
    category: 'Group',
    isGroupOnly: true,
    isOwnerOnly: true,

    async execute(sock, msg, args) {
      const meta = await sock.groupMetadata(msg.chatJid);
      const members = meta.participants.map((p) => p.id);
      const text = args.join(' ') || '‎';

      // Sending mentions without @phone in text makes them invisible.
      await sock.sendMessage(msg.chatJid, { text, mentions: members });
    },
  },

  // ── .promote ───────────────────────────────────────────────────────────────
  {
    name: 'promote',
    description: 'Promote a member to group admin',
    usage: '.promote @user',
    command: 'promote',
    category: 'Group',
    isGroupOnly: true,
    isOwnerOnly: true,

    async execute(sock, msg, args) {
      if (!(await isBotAdmin(sock, msg.chatJid))) {
        await msg.reply('❌ I need to be a group admin to promote members.');
        return;
      }

      const target = resolveTarget(msg, args);
      if (!target) {
        await msg.reply(`Usage: ${config.prefix}promote @user`);
        return;
      }

      await sock.groupParticipantsUpdate(msg.chatJid, [target], 'promote');
      await msg.reply(`✅ @${phoneFromJid(target)} has been promoted to admin.`, {
        mentions: [target],
      });
    },
  },

  // ── .demote ────────────────────────────────────────────────────────────────
  {
    name: 'demote',
    description: 'Demote a group admin to member',
    usage: '.demote @user',
    command: 'demote',
    category: 'Group',
    isGroupOnly: true,
    isOwnerOnly: true,

    async execute(sock, msg, args) {
      if (!(await isBotAdmin(sock, msg.chatJid))) {
        await msg.reply('❌ I need to be a group admin to demote members.');
        return;
      }

      const target = resolveTarget(msg, args);
      if (!target) {
        await msg.reply(`Usage: ${config.prefix}demote @user`);
        return;
      }

      await sock.groupParticipantsUpdate(msg.chatJid, [target], 'demote');
      await msg.reply(`✅ @${phoneFromJid(target)} has been demoted.`, {
        mentions: [target],
      });
    },
  },

  // ── .kick ──────────────────────────────────────────────────────────────────
  {
    name: 'kick',
    description: 'Remove a member from the group',
    usage: '.kick @user',
    command: ['kick', 'remove'],
    category: 'Group',
    isGroupOnly: true,
    isOwnerOnly: true,

    async execute(sock, msg, args) {
      if (!(await isBotAdmin(sock, msg.chatJid))) {
        await msg.reply('❌ I need to be a group admin to kick members.');
        return;
      }

      const target = resolveTarget(msg, args);
      if (!target) {
        await msg.reply(`Usage: ${config.prefix}kick @user`);
        return;
      }

      // Prevent kicking admins.
      if (await isAdmin(sock, msg.chatJid, target)) {
        await msg.reply('❌ Cannot kick a group admin.');
        return;
      }

      await sock.groupParticipantsUpdate(msg.chatJid, [target], 'remove');
      await msg.reply(`✅ @${phoneFromJid(target)} has been removed.`, {
        mentions: [target],
      });
    },
  },

  // ── .add ───────────────────────────────────────────────────────────────────
  {
    name: 'add',
    description: 'Add a member to the group',
    usage: '.add <number>',
    command: 'add',
    category: 'Group',
    isGroupOnly: true,
    isOwnerOnly: true,

    async execute(sock, msg, args) {
      if (!(await isBotAdmin(sock, msg.chatJid))) {
        await msg.reply('❌ I need to be a group admin to add members.');
        return;
      }

      const number = args[0]?.replace(/[^0-9]/g, '');
      if (!number) {
        await msg.reply(`Usage: ${config.prefix}add <number with country code>\nExample: ${config.prefix}add 919876543210`);
        return;
      }

      const jid = `${number}@s.whatsapp.net`;

      const result = await sock.groupParticipantsUpdate(msg.chatJid, [jid], 'add');
      const status = result[0]?.status;

      if (status === '200') {
        await msg.reply(`✅ @${number} has been added to the group.`, { mentions: [jid] });
      } else if (status === '403') {
        await msg.reply(`❌ @${number}'s privacy settings prevent being added.`, { mentions: [jid] });
      } else if (status === '408') {
        await msg.reply(`❌ @${number} is not on WhatsApp or the number is invalid.`, { mentions: [jid] });
      } else {
        await msg.reply(`⚠️ Could not add @${number} — status: ${status}`, { mentions: [jid] });
      }
    },
  },

  // ── .link ──────────────────────────────────────────────────────────────────
  {
    name: 'link',
    description: 'Get the group invite link',
    usage: '.link',
    command: 'link',
    category: 'Group',
    isGroupOnly: true,
    isOwnerOnly: true,

    async execute(sock, msg) {
      if (!(await isBotAdmin(sock, msg.chatJid))) {
        await msg.reply('❌ I need admin rights to fetch the invite link.');
        return;
      }

      const code = await sock.groupInviteCode(msg.chatJid);
      const meta = await sock.groupMetadata(msg.chatJid);

      await msg.reply(
        `🔗 *Group Invite Link*\n\n` +
        `*${meta.subject}*\n` +
        `https://chat.whatsapp.com/${code}`
      );
    },
  },

  // ── .revoke ────────────────────────────────────────────────────────────────
  {
    name: 'revoke',
    description: 'Revoke and regenerate the group invite link',
    usage: '.revoke',
    command: 'revoke',
    category: 'Group',
    isGroupOnly: true,
    isOwnerOnly: true,

    async execute(sock, msg) {
      if (!(await isBotAdmin(sock, msg.chatJid))) {
        await msg.reply('❌ I need admin rights to revoke the invite link.');
        return;
      }

      await sock.groupRevokeInvite(msg.chatJid);
      const newCode = await sock.groupInviteCode(msg.chatJid);

      await msg.reply(
        `✅ Old invite link revoked!\n\n` +
        `🔗 *New Link:*\nhttps://chat.whatsapp.com/${newCode}`
      );
    },
  },

  // ── .group open/close ──────────────────────────────────────────────────────
  {
    name: 'group',
    description: 'Open or close the group for messaging',
    usage: '.group open | close',
    command: 'group',
    category: 'Group',
    isGroupOnly: true,
    isOwnerOnly: true,

    async execute(sock, msg, args) {
      if (!(await isBotAdmin(sock, msg.chatJid))) {
        await msg.reply('❌ I need to be a group admin to change group settings.');
        return;
      }

      const action = args[0]?.toLowerCase();

      if (action === 'open') {
        await sock.groupSettingUpdate(msg.chatJid, 'not_announcement');
        await msg.reply('✅ Group is now *open* — all members can send messages.');
      } else if (action === 'close') {
        await sock.groupSettingUpdate(msg.chatJid, 'announcement');
        await msg.reply('🔒 Group is now *closed* — only admins can send messages.');
      } else {
        await msg.reply(`Usage: ${config.prefix}group open | close`);
      }
    },
  },
];
