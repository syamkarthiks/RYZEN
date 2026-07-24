'use strict';

/**
 * plugins/vv.js — View-Once media recovery.
 *
 * Two modes:
 *  1. AUTO  — When any view-once message arrives it is silently forwarded
 *             to the owner's DM (no command needed, always active).
 *  2. MANUAL — .vv reply to a view-once message to reveal it in the chat.
 */

const { downloadMediaMessage, getContentType } = require('@whiskeysockets/baileys');
const config = require('../config');
const { logger } = require('../lib/utils');

/** Media types we accept as potential view-once content. */
const VV_TYPES = ['viewOnce', 'image', 'video'];

// ─── View-Once type helpers ───────────────────────────────────────────────────

const VIEW_ONCE_KEYS = [
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
];

/**
 * Returns true if the serialized msg contains a view-once envelope.
 * The serialized msg spreads the raw WAMessage, so msg.message is
 * the WAMessage.message body (same as rawMsg.message in Baileys).
 * @param {object} msg  — serialized message from serialize.js
 */
function isViewOnce(msg) {
  const msgObj = msg?.message;
  if (!msgObj) return false;
  return VIEW_ONCE_KEYS.some((k) => k in msgObj);
}

/**
 * Download the media from a view-once message and forward it to the owner.
 * Called automatically by events.js whenever a view-once message is received.
 *
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {object} msg  — serialized message
 */
async function handleViewOnce(sock, msg) {
  try {
    if (config.sudoNumbers.length === 0) return;
    const ownerJid = `${config.sudoNumbers[0]}@s.whatsapp.net`;

    // msg spreads the raw WAMessage, so msg.message is WAMessage.message
    // and msg.key is WAMessage.key
    const msgObj  = msg?.message;
    if (!msgObj) return;

    const qType = VIEW_ONCE_KEYS.find((k) => k in msgObj);
    if (!qType) return;

    const inner     = msgObj[qType]?.message;
    if (!inner) return;

    const innerType = getContentType(inner);
    const isVideo   = innerType === 'videoMessage';

    if (innerType !== 'imageMessage' && innerType !== 'videoMessage') return;

    // Download via the view-once envelope so Baileys can decrypt correctly.
    const mediaBuffer = await downloadMediaMessage(
      { key: msg.key, message: { [qType]: msgObj[qType] } },
      'buffer',
      {},
      { logger, reuploadRequest: sock.updateMediaMessage }
    );

    if (!mediaBuffer || mediaBuffer.length === 0) return;

    const senderNum = msg.sender?.split('@')[0] || '?';
    const chatName  = msg.isGroup ? ` in *${msg.chatJid}*` : ' (DM)';
    const caption   =
      `👁️ *View Once* intercepted by *${config.botName}*\n\n` +
      `👤 From: @${senderNum}${chatName}\n` +
      `🕐 Time: ${new Date().toLocaleString()}`;

    if (isVideo) {
      await sock.sendMessage(ownerJid, {
        video:    mediaBuffer,
        caption,
        mentions: [msg.sender],
      });
    } else {
      await sock.sendMessage(ownerJid, {
        image:    mediaBuffer,
        caption,
        mentions: [msg.sender],
      });
    }

    logger.info(`👁️ View-once from ${senderNum} forwarded to owner`);
  } catch (err) {
    logger.warn({ err }, 'handleViewOnce auto-forward failed (non-fatal)');
  }
}

// ─── Plugin export ────────────────────────────────────────────────────────────

module.exports = [
  {
    name: 'vv',
    description: 'Recover a View Once image or video (reply to reveal it in chat)',
    usage: '.vv [reply to view-once message]',
    command: ['vv', 'viewonce', 'vo'],
    category: 'Media',
    isOwnerOnly: true,

    async execute(sock, msg) {
      // Must be replying to a message that contains media.
      if (!msg.quoted || !VV_TYPES.includes(msg.quoted.type)) {
        await msg.reply(
          '📎 Reply to a *View Once* image or video to reveal it.\n' +
          `Example: *${config.prefix}vv*`
        );
        return;
      }

      await msg.react('⏳');

      try {
        const quotedMsg  = msg.quoted;
        const rawQuoted  = quotedMsg.message;
        const qType      = getContentType(rawQuoted);

        let mediaBuffer;
        let isVideo = false;

        // ── Path A: Baileys kept the viewOnce wrapper ──────────────────────
        if (qType && VIEW_ONCE_KEYS.includes(qType)) {
          const inner = rawQuoted[qType]?.message;
          if (!inner) {
            await msg.reply('❌ Could not find media inside this View Once message.');
            return;
          }

          const innerType = getContentType(inner);
          isVideo = innerType === 'videoMessage';

          if (innerType !== 'imageMessage' && innerType !== 'videoMessage') {
            await msg.reply('❌ Only View Once images and videos are supported.');
            return;
          }

          mediaBuffer = await downloadMediaMessage(
            {
              key:     quotedMsg.key,
              message: { [qType]: rawQuoted[qType] },
            },
            'buffer',
            {},
            { logger, reuploadRequest: sock.updateMediaMessage }
          );

        // ── Path B: Baileys unwrapped it — qType is imageMessage / videoMessage
        } else {
          isVideo = qType === 'videoMessage' || msg.quoted.type === 'video';
          mediaBuffer = await quotedMsg.download();
        }

        if (!mediaBuffer || mediaBuffer.length === 0) {
          await msg.reply('❌ Media could not be downloaded — it may have expired on WhatsApp servers.');
          return;
        }

        const senderNum = quotedMsg.sender?.split('@')[0] || '?';
        const caption   =
          `👁️ *View Once* revealed by *${config.botName}*\n\n` +
          `👤 From: @${senderNum}`;

        if (isVideo) {
          await sock.sendMessage(msg.chatJid, {
            video:    mediaBuffer,
            caption,
            mentions: [quotedMsg.sender],
          }, { quoted: msg });
        } else {
          await sock.sendMessage(msg.chatJid, {
            image:    mediaBuffer,
            caption,
            mentions: [quotedMsg.sender],
          }, { quoted: msg });
        }

        await msg.react('✅');
      } catch (err) {
        logger.error({ err }, 'vv command failed');
        await msg.react('❌');
        await msg.reply(`❌ Failed to recover media: ${err.message}`);
      }
    },
  },
];

// ─── Exported utility (used by events.js) ────────────────────────────────────
module.exports.handleViewOnce = handleViewOnce;
module.exports.isViewOnce     = isViewOnce;
