'use strict';

/**
 * lib/serialize.js — Message normaliser for RYZEN.
 *
 * Baileys gives us a raw WAMessage object that can have dozens of different
 * shapes depending on message type. This module wraps every incoming message
 * in a unified `SerializedMessage` that plugins can rely on without worrying
 * about the raw Baileys internals.
 *
 * Key additions on top of the raw message:
 *   .text        — plain text body regardless of message type
 *   .type        — short type string ("text","image","video","sticker",…)
 *   .sender      — clean JID of the actual author
 *   .isGroup     — boolean
 *   .isOwner     — boolean (sender is a sudo user)
 *   .isBotMessage— boolean
 *   .quoted      — serialized quoted message or null
 *   .mention     — array of mentioned JIDs
 *   .download()  — downloads media and returns Buffer
 *   .reply(text) — shortcut: sends a text reply
 *   .react(emoji)— shortcut: sends a reaction
 */

const {
  downloadMediaMessage,
  getContentType,
  jidNormalizedUser,
} = require('@whiskeysockets/baileys');

const config = require('../config');
const { cleanJid, isGroup, logger } = require('./utils');

/**
 * Map Baileys content-type keys to short, human-readable type strings.
 */
const TYPE_MAP = {
  conversation: 'text',
  extendedTextMessage: 'text',
  imageMessage: 'image',
  videoMessage: 'video',
  audioMessage: 'audio',
  documentMessage: 'document',
  stickerMessage: 'sticker',
  contactMessage: 'contact',
  contactsArrayMessage: 'contacts',
  locationMessage: 'location',
  liveLocationMessage: 'liveLocation',
  reactionMessage: 'reaction',
  viewOnceMessage: 'viewOnce',
  viewOnceMessageV2: 'viewOnce',
  viewOnceMessageV2Extension: 'viewOnce',
  ephemeralMessage: 'ephemeral',
  protocolMessage: 'protocol',
  pollCreationMessage: 'poll',
  pollUpdateMessage: 'pollUpdate',
  buttonsMessage: 'buttons',
  listMessage: 'list',
  templateMessage: 'template',
};

/**
 * Extract the plain-text body from any message type.
 * @param {object} message — raw Baileys message.message object
 * @param {string} type    — result of getContentType(message)
 */
function extractText(message, type) {
  if (!message || !type) return '';

  switch (type) {
    case 'conversation':
      return message.conversation || '';
    case 'extendedTextMessage':
      return message.extendedTextMessage?.text || '';
    case 'imageMessage':
    case 'videoMessage':
    case 'documentMessage':
    case 'audioMessage':
      return message[type]?.caption || '';
    case 'viewOnceMessage':
    case 'viewOnceMessageV2':
    case 'viewOnceMessageV2Extension': {
      const inner = message[type]?.message;
      if (!inner) return '';
      const innerType = getContentType(inner);
      return inner[innerType]?.caption || '';
    }
    case 'ephemeralMessage': {
      const inner = message.ephemeralMessage?.message;
      if (!inner) return '';
      const innerType = getContentType(inner);
      return extractText(inner, innerType);
    }
    case 'buttonsResponseMessage':
      return message.buttonsResponseMessage?.selectedDisplayText || '';
    case 'listResponseMessage':
      return message.listResponseMessage?.title || '';
    default:
      return '';
  }
}

/**
 * Resolve the actual inner message object, unwrapping ephemeral/viewOnce
 * wrappers so media downloads work correctly.
 */
function resolveInnerMessage(message, type) {
  if (type === 'ephemeralMessage') {
    const inner = message.ephemeralMessage?.message;
    if (!inner) return { message, type };
    return resolveInnerMessage(inner, getContentType(inner));
  }
  if (type === 'viewOnceMessage' || type === 'viewOnceMessageV2' || type === 'viewOnceMessageV2Extension') {
    const inner = message[type]?.message;
    if (!inner) return { message, type };
    return resolveInnerMessage(inner, getContentType(inner));
  }
  return { message, type };
}

/**
 * Serialize a raw Baileys message event into a unified shape.
 *
 * @param {import('@whiskeysockets/baileys').WASocket} sock — Baileys socket
 * @param {object} rawMsg — raw message from messages.upsert
 * @returns {object} serialized message
 */
function serialize(sock, rawMsg) {
  const msg = { ...rawMsg };

  // ─── Basic Identity ────────────────────────────────────────────────────
  const chatJid = msg.key?.remoteJid || '';
  const fromMe = msg.key?.fromMe || false;
  const groupMeta = isGroup(chatJid);

  // In groups, the sender is in participant; in DMs it's the chatJid itself.
  const senderRaw = fromMe
    ? sock.user?.id
    : (msg.key?.participant || chatJid);
  const sender = cleanJid(senderRaw || '');

  // ─── Message Type ──────────────────────────────────────────────────────
  const rawMessage = msg.message;
  const rawType = rawMessage ? getContentType(rawMessage) : null;
  const shortType = rawType ? (TYPE_MAP[rawType] || rawType) : 'unknown';

  // Text body
  const text = extractText(rawMessage, rawType);

  // ─── Quoted Message ────────────────────────────────────────────────────
  let quoted = null;
  const extText = rawMessage?.extendedTextMessage;
  const ctxInfo =
    rawMessage?.[rawType]?.contextInfo ||
    extText?.contextInfo ||
    null;

  if (ctxInfo?.quotedMessage) {
    const qMsg = ctxInfo.quotedMessage;
    const qType = getContentType(qMsg);
    const qSender = cleanJid(ctxInfo.participant || chatJid);
    quoted = {
      key: {
        remoteJid: chatJid,
        fromMe: qSender === cleanJid(sock.user?.id || ''),
        id: ctxInfo.stanzaId,
        participant: ctxInfo.participant,
      },
      message: qMsg,
      sender: qSender,
      type: TYPE_MAP[qType] || qType,
      text: extractText(qMsg, qType),
      /** Download quoted media → Buffer */
      download: async () => {
        const { message: innerMsg, type: innerType } = resolveInnerMessage(qMsg, qType);
        return downloadMediaMessage(
          { message: innerMsg, key: { remoteJid: chatJid, fromMe: false, id: ctxInfo.stanzaId } },
          'buffer',
          {},
          { logger, reuploadRequest: sock.updateMediaMessage }
        );
      },
    };
  }

  // ─── Mentions ──────────────────────────────────────────────────────────
  const mention = ctxInfo?.mentionedJid || [];

  // ─── Permissions ──────────────────────────────────────────────────
  const botJid = cleanJid(sock.user?.id || '');

  // isBotMessage = only true when the LINKED DEVICE itself sent the message.
  // Do NOT mark owner’s phone messages as bot messages — the owner’s phone
  // and the bot share the same number, so sender === botJid for both, but
  // only key.fromMe is true when the actual bot process sent it.
  const isBotMessage = fromMe;

  // isOwner = sender’s phone number is in the sudo list.
  // Strip @s.whatsapp.net and any :device suffix before comparing.
  const senderPhone = sender.replace(/@.+$/, '').replace(/:\d+$/, '');
  const isOwner = config.sudoNumbers.some((n) => n === senderPhone);

  // ─── Shortcuts ────────────────────────────────────────────────────────
  /**
   * Reply to this message with plain text.
   * @param {string} content
   * @param {object} [extra] additional Baileys message options
   */
  const reply = (content, extra = {}) =>
    sock.sendMessage(chatJid, { text: String(content), ...extra }, { quoted: msg });

  /**
   * React to this message with an emoji.
   * @param {string} emoji
   */
  const react = (emoji) =>
    sock.sendMessage(chatJid, {
      react: { text: emoji, key: msg.key },
    });

  /**
   * Download this message's media as a Buffer.
   */
  const download = async () => {
    const { message: innerMsg } = resolveInnerMessage(rawMessage, rawType);
    return downloadMediaMessage(
      { message: innerMsg, key: msg.key },
      'buffer',
      {},
      { logger, reuploadRequest: sock.updateMediaMessage }
    );
  };

  return {
    // Raw Baileys fields preserved
    ...msg,

    // Normalised fields
    chatJid,
    sender,
    fromMe,
    isGroup: groupMeta,
    isBotMessage,
    isOwner,
    type: shortType,
    text,
    quoted,
    mention,

    // Shortcut methods
    reply,
    react,
    download,

    // Expose raw message object for advanced plugins
    _raw: rawMessage,
    _rawType: rawType,
  };
}

module.exports = { serialize };
