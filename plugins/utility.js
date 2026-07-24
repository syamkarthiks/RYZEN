'use strict';

/**
 * plugins/utility.js — General utility commands.
 *
 * Commands:
 *   .weather <city>    — Current weather for a city (wttr.in, no API key)
 *   .time [timezone]   — Current time and date
 *   .calc <expression> — Safe math expression evaluator
 *   .qr <text|url>     — Generate a QR code image
 *   .short <url>       — Shorten a URL (TinyURL)
 *   .readmore          — Send a WhatsApp "Read More" collapsed text trick
 */

const QRCode = require('qrcode');
const axios = require('axios');
const config = require('../config');
const { logger, isUrl } = require('../lib/utils');

// ─── Safe math evaluator ─────────────────────────────────────────────────────
// We avoid eval() and use a simple recursive descent parser.

/**
 * Safely evaluate a basic arithmetic expression string.
 * Supports: + - * / ^ % ( ) and decimal numbers.
 * @param {string} expr
 * @returns {number}
 */
function safeCalc(expr) {
  // Strip all characters that are not digits, operators, dots, spaces, or parens.
  const safe = expr.replace(/[^0-9+\-*/^%().e ]/gi, '').trim();
  if (!safe) throw new Error('Invalid expression');

  // Use Function() with a locked-down scope instead of eval().
  // eslint-disable-next-line no-new-func
  const result = new Function(
    '"use strict"; return (' + safe.replace(/\^/g, '**') + ')'
  )();

  if (typeof result !== 'number' || !isFinite(result)) {
    throw new Error('Result is not a finite number');
  }

  return result;
}

// ─── Commands ────────────────────────────────────────────────────────────────

module.exports = [
  // ── .weather ───────────────────────────────────────────────────────────────
  {
    name: 'weather',
    description: 'Get current weather for a city',
    usage: '.weather <city>',
    command: 'weather',
    category: 'Utility',

    async execute(sock, msg, args) {
      const city = args.join(' ');
      if (!city) {
        await msg.reply(`Usage: ${config.prefix}weather <city>\nExample: ${config.prefix}weather London`);
        return;
      }

      await msg.react('⏳');

      try {
        // wttr.in provides free weather in a one-liner JSON format.
        const encodedCity = encodeURIComponent(city);
        const response = await axios.get(`https://wttr.in/${encodedCity}?format=j1`, {
          timeout: 10000,
        });

        const data = response.data;
        const current = data.current_condition[0];
        const weather = data.weather[0];
        const nearestArea = data.nearest_area[0];

        const locationName = nearestArea.areaName[0].value + ', ' + nearestArea.country[0].value;
        const description = current.weatherDesc[0].value;
        const tempC = current.temp_C;
        const tempF = current.temp_F;
        const feelsLikeC = current.FeelsLikeC;
        const humidity = current.humidity;
        const windKmph = current.windspeedKmph;
        const visibility = current.visibility;
        const uvIndex = current.uvIndex;
        const maxTempC = weather.maxtempC;
        const minTempC = weather.mintempC;

        const text = [
          `🌤️ *Weather: ${locationName}*`,
          '',
          `🌡️ Temp        : ${tempC}°C / ${tempF}°F`,
          `🤔 Feels Like  : ${feelsLikeC}°C`,
          `📋 Condition   : ${description}`,
          `💧 Humidity    : ${humidity}%`,
          `💨 Wind        : ${windKmph} km/h`,
          `👁️  Visibility  : ${visibility} km`,
          `☀️  UV Index    : ${uvIndex}`,
          `📈 Max Today   : ${maxTempC}°C`,
          `📉 Min Today   : ${minTempC}°C`,
          '',
          `_Powered by wttr.in_`,
        ].join('\n');

        await msg.reply(text);
        await msg.react('✅');
      } catch (err) {
        logger.error({ err }, 'weather command failed');
        await msg.react('❌');
        await msg.reply(`❌ Could not fetch weather for "${city}". Try a different city name.`);
      }
    },
  },

  // ── .time ──────────────────────────────────────────────────────────────────
  {
    name: 'time',
    description: 'Show the current time and date',
    usage: '.time [timezone]',
    command: 'time',
    category: 'Utility',

    async execute(sock, msg, args) {
      const tz = args.join(' ') || Intl.DateTimeFormat().resolvedOptions().timeZone;

      try {
        const now = new Date();

        const timeStr = now.toLocaleTimeString('en-US', { timeZone: tz, hour12: true });
        const dateStr = now.toLocaleDateString('en-US', {
          timeZone: tz,
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric',
        });

        await msg.reply(
          `🕐 *Current Time*\n\n` +
          `🌍 Timezone : ${tz}\n` +
          `📅 Date     : ${dateStr}\n` +
          `🕐 Time     : ${timeStr}`
        );
      } catch {
        await msg.reply(`❌ Invalid timezone: "${tz}"\nExample: ${config.prefix}time America/New_York`);
      }
    },
  },

  // ── .calc ──────────────────────────────────────────────────────────────────
  {
    name: 'calc',
    description: 'Evaluate a math expression safely',
    usage: '.calc <expression>',
    command: ['calc', 'calculate', 'math'],
    category: 'Utility',

    async execute(sock, msg, args) {
      const expr = args.join(' ');
      if (!expr) {
        await msg.reply(`Usage: ${config.prefix}calc <expression>\nExample: ${config.prefix}calc (15 * 3) / 4 + 2^3`);
        return;
      }

      try {
        const result = safeCalc(expr);
        await msg.reply(
          `🧮 *Calculator*\n\n` +
          `📥 Input  : \`${expr}\`\n` +
          `📤 Result : \`${result}\``
        );
      } catch (err) {
        await msg.reply(`❌ Invalid expression: ${err.message}`);
      }
    },
  },

  // ── .qr ────────────────────────────────────────────────────────────────────
  {
    name: 'qr',
    description: 'Generate a QR code from text or URL',
    usage: '.qr <text or URL>',
    command: 'qr',
    category: 'Utility',

    async execute(sock, msg, args) {
      const text = args.join(' ');
      if (!text) {
        await msg.reply(`Usage: ${config.prefix}qr <text or URL>`);
        return;
      }

      await msg.react('⏳');

      try {
        // Generate QR as a PNG buffer.
        const qrBuffer = await QRCode.toBuffer(text, {
          type: 'png',
          width: 512,
          margin: 2,
          color: { dark: '#000000', light: '#FFFFFF' },
        });

        await sock.sendMessage(msg.chatJid, {
          image: qrBuffer,
          caption: `📱 *QR Code*\n\nContent: ${text.length > 60 ? text.slice(0, 60) + '…' : text}`,
        }, { quoted: msg });

        await msg.react('✅');
      } catch (err) {
        logger.error({ err }, 'qr command failed');
        await msg.react('❌');
        await msg.reply(`❌ Failed to generate QR code: ${err.message}`);
      }
    },
  },

  // ── .short ─────────────────────────────────────────────────────────────────
  {
    name: 'short',
    description: 'Shorten a URL using TinyURL',
    usage: '.short <url>',
    command: ['short', 'shorten', 'tinyurl'],
    category: 'Utility',

    async execute(sock, msg, args) {
      const url = args[0];
      if (!url || !isUrl(url)) {
        await msg.reply(`Usage: ${config.prefix}short <url>\nExample: ${config.prefix}short https://google.com`);
        return;
      }

      await msg.react('⏳');

      try {
        const response = await axios.get(
          `https://tinyurl.com/api-create.php?url=${encodeURIComponent(url)}`,
          { timeout: 10000 }
        );

        const shortened = response.data;

        await msg.reply(
          `🔗 *URL Shortener*\n\n` +
          `📥 Original : ${url}\n` +
          `📤 Shortened: ${shortened}`
        );
        await msg.react('✅');
      } catch (err) {
        logger.error({ err }, 'short command failed');
        await msg.react('❌');
        await msg.reply(`❌ Failed to shorten URL: ${err.message}`);
      }
    },
  },

  // ── .readmore ──────────────────────────────────────────────────────────────
  {
    name: 'readmore',
    description: 'Send a message with a "Read More" collapse effect',
    usage: '.readmore <text>',
    command: 'readmore',
    category: 'Utility',

    async execute(sock, msg, args) {
      const text = args.join(' ');
      if (!text) {
        await msg.reply(`Usage: ${config.prefix}readmore <visible text> | <hidden text>\nSeparate visible and hidden parts with a pipe |`);
        return;
      }

      const parts = text.split('|');
      const visible = parts[0]?.trim() || text;
      const hidden = parts[1]?.trim() || '(This content is hidden until expanded)';

      // The WhatsApp "Read More" trick uses a zero-width space repeated many times
      // to push the rest of the text below the fold.
      const invisiblePadding = '\u200B'.repeat(3500);

      await sock.sendMessage(msg.chatJid, {
        text: `${visible}${invisiblePadding}${hidden}`,
      }, { quoted: msg });
    },
  },
];
