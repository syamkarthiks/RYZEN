'use strict';

/**
 * plugins/chatbot.js — OpenAI-powered chatbot with per-chat conversation memory.
 *
 * Features:
 *   - Per-chat enable/disable stored in database
 *   - Conversation history kept in memory (last 20 exchanges)
 *   - Typing indicator while generating response
 *   - Graceful fallback when OPENAI_API_KEY is not set
 *
 * Commands:
 *   .chatbot on      — enable chatbot in current chat
 *   .chatbot off     — disable chatbot in current chat
 *   .chatbot on dm   — enable for all DMs
 *   .chatbot off dm  — disable for all DMs
 *   .chatbot on all  — enable everywhere
 *   .chatbot off all — disable everywhere
 *   .chatbot         — show current status
 *   .clearchat       — clear conversation memory for this chat
 */

const OpenAI = require('openai');
const db = require('../lib/database');
const config = require('../config');
const { logger } = require('../lib/utils');

// ─── OpenAI client (lazy-initialised so missing key doesn't crash startup) ───
let openai = null;

function getOpenAI() {
  if (!openai && config.openAiKey) {
    openai = new OpenAI({ apiKey: config.openAiKey });
  }
  return openai;
}

// ─── In-memory conversation history ─────────────────────────────────────────
// Map of chatJid → Array<{ role: 'user'|'assistant', content: string }>
const conversationHistory = new Map();
const MAX_HISTORY = 20; // keep last 20 exchanges (40 messages)

/** System prompt that defines the bot's personality. */
const SYSTEM_PROMPT = `You are ${config.botName}, a helpful and friendly AI assistant integrated into WhatsApp by ${config.ownerName}. 
You are concise, clear, and avoid using markdown formatting in your replies since WhatsApp renders plain text.
Keep responses under 300 words unless the user specifically asks for more detail.`;

/**
 * Add a message to conversation history, evicting oldest if over limit.
 * @param {string} jid
 * @param {'user'|'assistant'} role
 * @param {string} content
 */
function addToHistory(jid, role, content) {
  if (!conversationHistory.has(jid)) conversationHistory.set(jid, []);
  const history = conversationHistory.get(jid);
  history.push({ role, content });

  // Keep only last MAX_HISTORY * 2 messages (user + assistant pairs).
  if (history.length > MAX_HISTORY * 2) {
    history.splice(0, 2); // remove oldest pair
  }
}

/**
 * Check whether chatbot is enabled for a given JID.
 * @param {string} jid
 * @param {boolean} isGroup
 * @returns {Promise<boolean>}
 */
async function isChatbotEnabled(jid, isGroup) {
  // Check per-chat setting first.
  const chatValue = await db.chatSetting(jid, 'chatbot');
  if (chatValue === 'on') return true;
  if (chatValue === 'off') return false;

  // Fall back to global DM or group setting.
  const globalKey = isGroup ? 'chatbot_groups' : 'chatbot_dms';
  const globalValue = await db.setting(globalKey);
  return globalValue === 'on';
}

/**
 * Main chatbot handler — called by events.js for every non-command message.
 * Returns true if the chatbot responded (so events.js skips further processing).
 *
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {object} msg — serialized message
 * @returns {Promise<boolean>}
 */
async function handleChatbot(sock, msg) {
  if (!msg.text || msg.text.trim().length === 0) return false;
  if (msg.isBotMessage) return false;

  const enabled = await isChatbotEnabled(msg.chatJid, msg.isGroup);
  if (!enabled) return false;

  const ai = getOpenAI();
  if (!ai) {
    // OpenAI not configured — silently skip.
    return false;
  }

  try {
    // Show typing indicator.
    await sock.sendPresenceUpdate('composing', msg.chatJid);

    // Add user message to history.
    addToHistory(msg.chatJid, 'user', msg.text);

    const history = conversationHistory.get(msg.chatJid) || [];

    const completion = await ai.chat.completions.create({
      model: config.aiModel,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        ...history,
      ],
      max_tokens: 500,
      temperature: 0.7,
    });

    const reply = completion.choices[0]?.message?.content?.trim() || 'I could not generate a response.';

    // Add assistant reply to history.
    addToHistory(msg.chatJid, 'assistant', reply);

    // Clear typing indicator.
    await sock.sendPresenceUpdate('paused', msg.chatJid);

    await msg.reply(reply);
    return true;
  } catch (err) {
    await sock.sendPresenceUpdate('paused', msg.chatJid);
    logger.error({ err }, 'ChatBot OpenAI error');
    return false;
  }
}

// ─── Commands ────────────────────────────────────────────────────────────────

module.exports = [
  {
    name: 'chatbot',
    description: 'Enable or disable the AI chatbot in this chat',
    usage: '.chatbot on | off | on dm | off dm | on all | off all',
    command: 'chatbot',
    category: 'AI',
    isOwnerOnly: true,

    async execute(sock, msg, args) {
      const action = args[0]?.toLowerCase();
      const scope = args[1]?.toLowerCase();

      // ── .chatbot (no args) → status ──────────────────────────────────────
      if (!action) {
        const enabled = await isChatbotEnabled(msg.chatJid, msg.isGroup);
        const globalDm = await db.setting('chatbot_dms');
        const globalGroup = await db.setting('chatbot_groups');

        await msg.reply(
          `🤖 *ChatBot Status*\n\n` +
          `This chat  : ${enabled ? '✅ Enabled' : '❌ Disabled'}\n` +
          `All DMs    : ${globalDm === 'on' ? '✅' : '❌'}\n` +
          `All Groups : ${globalGroup === 'on' ? '✅' : '❌'}\n\n` +
          `AI Model   : ${config.aiModel}\n` +
          `API Key    : ${config.openAiKey ? '✅ Set' : '❌ Not configured'}`
        );
        return;
      }

      if (action !== 'on' && action !== 'off') {
        await msg.reply(`Usage: ${config.prefix}chatbot on | off | on dm | off dm | on all | off all`);
        return;
      }

      // ── Scope: dm ───────────────────────────────────────────────────────
      if (scope === 'dm') {
        await db.setSetting('chatbot_dms', action);
        await msg.reply(`✅ ChatBot ${action === 'on' ? 'enabled' : 'disabled'} for all DMs.`);
        return;
      }

      // ── Scope: group ────────────────────────────────────────────────────
      if (scope === 'group' || scope === 'groups') {
        await db.setSetting('chatbot_groups', action);
        await msg.reply(`✅ ChatBot ${action === 'on' ? 'enabled' : 'disabled'} for all groups.`);
        return;
      }

      // ── Scope: all ──────────────────────────────────────────────────────
      if (scope === 'all') {
        await db.setSetting('chatbot_dms', action);
        await db.setSetting('chatbot_groups', action);
        await msg.reply(`✅ ChatBot ${action === 'on' ? 'enabled' : 'disabled'} everywhere.`);
        return;
      }

      // ── No scope → current chat only ────────────────────────────────────
      await db.setChatSetting(msg.chatJid, 'chatbot', action);
      await msg.reply(`✅ ChatBot ${action === 'on' ? 'enabled' : 'disabled'} in this chat.`);
    },
  },

  {
    name: 'clearchat',
    description: 'Clear AI conversation memory for this chat',
    usage: '.clearchat',
    command: 'clearchat',
    category: 'AI',

    async execute(sock, msg) {
      conversationHistory.delete(msg.chatJid);
      await msg.reply('🧹 Conversation history cleared for this chat.');
    },
  },
];

// ─── Export handler for events.js ────────────────────────────────────────────
module.exports.handleChatbot = handleChatbot;
