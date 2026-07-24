'use strict';

/**
 * plugins/ai.js — Explicit AI commands.
 *
 * Unlike the chatbot plugin (which auto-responds when chatbot mode is on),
 * these commands require the user to explicitly invoke them with a prefix.
 *
 * Commands:
 *   .ask <question>          — Single-turn question (no memory)
 *   .ai  <question>          — Same as .ask
 *   .chat <message>          — Multi-turn with conversation memory per chat
 *   .imagine <prompt>        — Generate an image with DALL-E (requires key)
 *   .analyze [reply to img]  — Analyze an image with GPT-4o Vision
 */

const OpenAI = require('openai');
const config = require('../config');
const { logger } = require('../lib/utils');

// ─── Per-chat conversation memory (for .chat command) ────────────────────────
const chatHistory = new Map(); // chatJid → Message[]
const MAX_HISTORY = 20;

let openai = null;

function getOpenAI() {
  if (!openai && config.openAiKey) {
    openai = new OpenAI({ apiKey: config.openAiKey });
  }
  return openai;
}

function requireOpenAI(msg) {
  const ai = getOpenAI();
  if (!ai) {
    msg.reply('❌ OpenAI API key is not configured.\nSet OPENAI_API_KEY in your environment variables.');
    return null;
  }
  return ai;
}

/** Add a message to per-chat conversation history. */
function addHistory(jid, role, content) {
  if (!chatHistory.has(jid)) chatHistory.set(jid, []);
  const hist = chatHistory.get(jid);
  hist.push({ role, content });
  if (hist.length > MAX_HISTORY * 2) hist.splice(0, 2);
}

const SYSTEM_PROMPT =
  `You are ${config.botName}, a knowledgeable and concise AI assistant. ` +
  `Respond in plain text only (no markdown). Keep answers under 400 words.`;

// ─── Commands ────────────────────────────────────────────────────────────────

module.exports = [
  // ── .ask / .ai ─────────────────────────────────────────────────────────────
  {
    name: 'ask',
    description: 'Ask the AI a single question (no memory)',
    usage: '.ask <question>',
    command: ['ask', 'ai', 'gpt'],
    category: 'AI',

    async execute(sock, msg, args) {
      const question = args.join(' ');
      if (!question) {
        await msg.reply(`Usage: ${config.prefix}ask <question>\nExample: ${config.prefix}ask What is the speed of light?`);
        return;
      }

      const ai = requireOpenAI(msg);
      if (!ai) return;

      await msg.react('⏳');
      await sock.sendPresenceUpdate('composing', msg.chatJid);

      try {
        const completion = await ai.chat.completions.create({
          model: config.aiModel,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: question },
          ],
          max_tokens: 600,
          temperature: 0.7,
        });

        const answer = completion.choices[0]?.message?.content?.trim() || 'No response generated.';
        await sock.sendPresenceUpdate('paused', msg.chatJid);
        await msg.reply(answer);
        await msg.react('✅');
      } catch (err) {
        await sock.sendPresenceUpdate('paused', msg.chatJid);
        logger.error({ err }, '.ask command failed');
        await msg.react('❌');
        await msg.reply(`❌ AI error: ${err.message}`);
      }
    },
  },

  // ── .chat ──────────────────────────────────────────────────────────────────
  {
    name: 'chat',
    description: 'Chat with AI — maintains conversation memory per chat',
    usage: '.chat <message>',
    command: 'chat',
    category: 'AI',

    async execute(sock, msg, args) {
      const message = args.join(' ');
      if (!message) {
        await msg.reply(`Usage: ${config.prefix}chat <message>`);
        return;
      }

      const ai = requireOpenAI(msg);
      if (!ai) return;

      await msg.react('⏳');
      await sock.sendPresenceUpdate('composing', msg.chatJid);

      try {
        addHistory(msg.chatJid, 'user', message);
        const history = chatHistory.get(msg.chatJid) || [];

        const completion = await ai.chat.completions.create({
          model: config.aiModel,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            ...history,
          ],
          max_tokens: 600,
          temperature: 0.7,
        });

        const reply = completion.choices[0]?.message?.content?.trim() || 'No response.';
        addHistory(msg.chatJid, 'assistant', reply);

        await sock.sendPresenceUpdate('paused', msg.chatJid);
        await msg.reply(reply);
        await msg.react('✅');
      } catch (err) {
        await sock.sendPresenceUpdate('paused', msg.chatJid);
        logger.error({ err }, '.chat command failed');
        await msg.react('❌');
        await msg.reply(`❌ AI error: ${err.message}`);
      }
    },
  },

  // ── .imagine ───────────────────────────────────────────────────────────────
  {
    name: 'imagine',
    description: 'Generate an AI image with DALL-E',
    usage: '.imagine <description>',
    command: ['imagine', 'dalle', 'generate'],
    category: 'AI',

    async execute(sock, msg, args) {
      const prompt = args.join(' ');
      if (!prompt) {
        await msg.reply(`Usage: ${config.prefix}imagine <description>\nExample: ${config.prefix}imagine a futuristic city at sunset`);
        return;
      }

      const ai = requireOpenAI(msg);
      if (!ai) return;

      await msg.react('⏳');

      try {
        const response = await ai.images.generate({
          model: 'dall-e-3',
          prompt,
          n: 1,
          size: '1024x1024',
          quality: 'standard',
          response_format: 'url',
        });

        const imageUrl = response.data[0]?.url;
        if (!imageUrl) throw new Error('No image URL returned');

        const { bufferFromUrl } = require('../lib/utils');
        const imageBuffer = await bufferFromUrl(imageUrl);

        await sock.sendMessage(msg.chatJid, {
          image: imageBuffer,
          caption: `🎨 *Generated by DALL-E 3*\n\n📝 Prompt: ${prompt}`,
        }, { quoted: msg });

        await msg.react('✅');
      } catch (err) {
        logger.error({ err }, '.imagine command failed');
        await msg.react('❌');
        await msg.reply(`❌ Image generation failed: ${err.message}`);
      }
    },
  },

  // ── .analyze ───────────────────────────────────────────────────────────────
  {
    name: 'analyze',
    description: 'Analyze an image using GPT-4o Vision',
    usage: '.analyze [reply to image] [optional question]',
    command: ['analyze', 'vision', 'describe'],
    category: 'AI',

    async execute(sock, msg, args) {
      const source = msg.type === 'image' ? msg : msg.quoted;

      if (!source || source.type !== 'image') {
        await msg.reply(
          `📎 Reply to an image with *${config.prefix}analyze* to analyze it.\n` +
          `You can also include a question: *${config.prefix}analyze What is in this image?*`
        );
        return;
      }

      const ai = requireOpenAI(msg);
      if (!ai) return;

      await msg.react('⏳');
      await sock.sendPresenceUpdate('composing', msg.chatJid);

      try {
        const imageBuffer = await source.download();
        const base64Image = imageBuffer.toString('base64');

        const userQuestion = args.join(' ') || 'Describe this image in detail.';

        const completion = await ai.chat.completions.create({
          model: 'gpt-4o',
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'image_url',
                  image_url: {
                    url: `data:image/jpeg;base64,${base64Image}`,
                    detail: 'high',
                  },
                },
                {
                  type: 'text',
                  text: userQuestion,
                },
              ],
            },
          ],
          max_tokens: 800,
        });

        const analysis = completion.choices[0]?.message?.content?.trim() || 'Could not analyze image.';

        await sock.sendPresenceUpdate('paused', msg.chatJid);
        await msg.reply(`🔍 *Image Analysis*\n\n${analysis}`);
        await msg.react('✅');
      } catch (err) {
        await sock.sendPresenceUpdate('paused', msg.chatJid);
        logger.error({ err }, '.analyze command failed');
        await msg.react('❌');
        await msg.reply(`❌ Vision analysis failed: ${err.message}`);
      }
    },
  },
];
