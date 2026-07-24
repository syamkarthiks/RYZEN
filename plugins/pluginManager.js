'use strict';

/**
 * plugins/pluginManager.js — Runtime plugin management.
 *
 * Commands (owner-only):
 *   .plugin <gist-url>  — Download & install a plugin from GitHub Gist
 *   .remove <name>      — Unload and delete a plugin
 *   .plugins            — List all installed plugins
 *   .reload             — Reload all plugins from disk (hot-reload)
 *   .update             — Placeholder for future auto-update feature
 *
 * Security measures:
 *   - Only GitHub Gist URLs are accepted
 *   - Downloaded file must be valid JavaScript (syntax check via require)
 *   - Duplicate plugin names are rejected
 *   - Rate limit: max 1 install per 10 seconds
 */

const path = require('path');
const fs = require('fs');
const axios = require('axios');
const config = require('../config');
const { logger, isUrl } = require('../lib/utils');
const {
  loadPlugin,
  unloadPlugin,
  loadAllPlugins,
  pluginRegistry,
} = require('../lib/pluginLoader');

const PLUGINS_DIR = path.resolve(config.pluginsDir);

// ─── Rate limiter for plugin installs ────────────────────────────────────────
const installRateLimit = new Map(); // senderJid → lastInstallTimestamp
const RATE_LIMIT_MS = 10_000;

function isRateLimited(senderJid) {
  const last = installRateLimit.get(senderJid) || 0;
  return Date.now() - last < RATE_LIMIT_MS;
}

function markInstall(senderJid) {
  installRateLimit.set(senderJid, Date.now());
}

// ─── Gist URL parser ─────────────────────────────────────────────────────────

/**
 * Extract the raw content URL from a GitHub Gist URL.
 * Supports:
 *   https://gist.github.com/user/id
 *   https://gist.github.com/user/id/raw/file.js
 *   https://gist.githubusercontent.com/user/id/raw/...
 *
 * @param {string} url
 * @returns {string|null} raw content URL or null if not a gist
 */
async function resolveGistRawUrl(url) {
  // Already a raw URL.
  if (url.includes('gist.githubusercontent.com')) return url;

  // gist.github.com/user/gistId — fetch the Gist API to get the raw URL.
  const match = url.match(/gist\.github\.com\/([^/]+)\/([a-f0-9]+)/i);
  if (!match) return null;

  const [, user, gistId] = match;

  const apiResponse = await axios.get(`https://api.github.com/gists/${gistId}`, {
    timeout: 10000,
    headers: { 'User-Agent': 'RYZEN-Bot' },
  });

  const files = apiResponse.data.files;
  const jsFile = Object.values(files).find((f) => f.filename.endsWith('.js'));

  if (!jsFile) throw new Error('No .js file found in this Gist.');

  return jsFile.raw_url;
}

// ─── Commands ────────────────────────────────────────────────────────────────

module.exports = [
  // ── .plugin <gist-url> ─────────────────────────────────────────────────────
  {
    name: 'plugin',
    description: 'Install a plugin from a GitHub Gist URL',
    usage: '.plugin <gist-url>',
    command: ['plugin', 'installplugin'],
    category: 'Plugins',
    isOwnerOnly: true,

    async execute(sock, msg, args) {
      const url = args[0];

      if (!url || !isUrl(url)) {
        await msg.reply(
          `Usage: ${config.prefix}plugin <github-gist-url>\n\n` +
          `Example:\n${config.prefix}plugin https://gist.github.com/user/abc123`
        );
        return;
      }

      // Only allow GitHub Gist URLs.
      if (!url.includes('gist.github')) {
        await msg.reply('❌ Only GitHub Gist URLs are accepted for security.');
        return;
      }

      // Rate limit check.
      if (isRateLimited(msg.sender)) {
        await msg.reply('⏳ Please wait 10 seconds between plugin installs.');
        return;
      }

      await msg.react('⏳');

      try {
        // Resolve to raw content URL.
        const rawUrl = await resolveGistRawUrl(url);
        if (!rawUrl) {
          await msg.react('❌');
          await msg.reply('❌ Could not resolve Gist URL. Make sure it is a valid GitHub Gist.');
          return;
        }

        // Download the raw JavaScript content.
        const response = await axios.get(rawUrl, {
          timeout: 15000,
          headers: { 'User-Agent': 'RYZEN-Bot' },
        });

        const code = response.data;
        if (typeof code !== 'string' || code.trim().length === 0) {
          throw new Error('Downloaded content is empty or not text.');
        }

        // Basic syntax check — try parsing with Node's vm module.
        const vm = require('vm');
        try {
          new vm.Script(code);
        } catch (syntaxErr) {
          await msg.react('❌');
          await msg.reply(`❌ Plugin has a syntax error:\n\`${syntaxErr.message}\``);
          return;
        }

        // Determine the file name from the Gist URL or use a timestamp.
        const gistMatch = rawUrl.match(/([^/]+\.js)/);
        const filename = gistMatch ? gistMatch[1] : `custom-${Date.now()}.js`;
        const destPath = path.join(PLUGINS_DIR, filename);
        const pluginName = filename.replace('.js', '').toLowerCase();

        // Prevent overwriting built-in plugins (without explicit removal).
        if (
          fs.existsSync(destPath) ||
          pluginRegistry.has(pluginName)
        ) {
          await msg.react('❌');
          await msg.reply(
            `❌ A plugin named *${pluginName}* is already installed.\n` +
            `Use \`${config.prefix}remove ${pluginName}\` first to replace it.`
          );
          return;
        }

        // Write to disk.
        fs.writeFileSync(destPath, code, 'utf-8');

        // Load the plugin immediately (no restart needed).
        const count = loadPlugin(destPath);
        if (count === 0) {
          // Plugin loaded but no commands found — remove the file.
          fs.unlinkSync(destPath);
          await msg.react('❌');
          await msg.reply('❌ Plugin was downloaded but exported no valid commands.');
          return;
        }

        markInstall(msg.sender);

        await msg.react('✅');
        await msg.reply(
          `✅ Plugin *${filename}* installed successfully!\n` +
          `📦 Commands loaded: ${count}\n\n` +
          `Use \`${config.prefix}menu\` to see new commands.`
        );
      } catch (err) {
        logger.error({ err }, '.plugin install failed');
        await msg.react('❌');
        await msg.reply(`❌ Failed to install plugin: ${err.message}`);
      }
    },
  },

  // ── .remove <pluginName> ───────────────────────────────────────────────────
  {
    name: 'remove',
    description: 'Unload and delete an installed plugin',
    usage: '.remove <plugin-name>',
    command: ['remove', 'removeplugin', 'delplugin'],
    category: 'Plugins',
    isOwnerOnly: true,

    async execute(sock, msg, args) {
      const name = args[0]?.toLowerCase();

      if (!name) {
        await msg.reply(`Usage: ${config.prefix}remove <plugin-name>\nUse \`${config.prefix}plugins\` to list installed plugins.`);
        return;
      }

      const plugin = pluginRegistry.get(name);
      if (!plugin) {
        await msg.reply(`❌ Plugin *${name}* not found. Use \`${config.prefix}plugins\` to see installed plugins.`);
        return;
      }

      const filePath = plugin.filePath;

      // Unload from registry and command map.
      unloadPlugin(filePath);

      // Delete the file.
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }

      await msg.reply(`✅ Plugin *${name}* has been unloaded and deleted.`);
    },
  },

  // ── .plugins ───────────────────────────────────────────────────────────────
  {
    name: 'plugins',
    description: 'List all installed plugins',
    usage: '.plugins',
    command: 'plugins',
    category: 'Plugins',

    async execute(sock, msg) {
      if (pluginRegistry.size === 0) {
        await msg.reply('📦 No plugins installed.');
        return;
      }

      const lines = [`📦 *Installed Plugins* (${pluginRegistry.size})\n`];

      // Sort by category, then name.
      const sorted = [...pluginRegistry.values()].sort((a, b) => {
        const catCmp = (a.category || 'Misc').localeCompare(b.category || 'Misc');
        return catCmp !== 0 ? catCmp : a.name.localeCompare(b.name);
      });

      for (const plugin of sorted) {
        const aliases = Array.isArray(plugin.command) ? plugin.command : [plugin.command];
        const primary = aliases[0];
        const ownerTag = plugin.isOwnerOnly ? ' 👑' : '';
        lines.push(`• *${plugin.name}*${ownerTag} — ${plugin.category || 'Misc'}`);
        lines.push(`  \`${config.prefix}${primary}\` — ${plugin.description}`);
      }

      lines.push(`\nUse \`${config.prefix}help <name>\` for details on any plugin.`);

      await msg.reply(lines.join('\n'));
    },
  },

  // ── .reload ────────────────────────────────────────────────────────────────
  {
    name: 'reload',
    description: 'Reload all plugins from disk',
    usage: '.reload',
    command: 'reload',
    category: 'Plugins',
    isOwnerOnly: true,

    async execute(sock, msg) {
      await msg.react('⏳');
      loadAllPlugins();
      await msg.react('✅');
      await msg.reply(
        `🔄 All plugins reloaded.\n` +
        `📦 Total commands: ${[...pluginRegistry.values()].length}`
      );
    },
  },

  // ── .update ────────────────────────────────────────────────────────────────
  {
    name: 'update',
    description: 'Check for RYZEN bot updates',
    usage: '.update',
    command: 'update',
    category: 'Owner',
    isOwnerOnly: true,

    async execute(sock, msg) {
      await msg.react('⏳');
      try {
        const response = await axios.get(
          'https://api.github.com/repos/SY4M/RYZEN/releases/latest',
          { timeout: 10000, headers: { 'User-Agent': 'RYZEN-Bot' } }
        );

        const latest = response.data.tag_name || 'Unknown';
        const current = config.version;
        const isLatest = latest === `v${current}` || latest === current;

        await msg.reply(
          `🔄 *RYZEN Update Check*\n\n` +
          `Current Version : v${current}\n` +
          `Latest Release  : ${latest}\n` +
          `Status          : ${isLatest ? '✅ Up to date' : '⚠️ Update available!'}`
        );
        await msg.react('✅');
      } catch {
        await msg.reply(
          `🔄 *RYZEN Update Check*\n\n` +
          `Current Version : v${config.version}\n` +
          `GitHub check    : Could not reach GitHub.\n\n` +
          `Visit https://github.com/SY4M/RYZEN for the latest version.`
        );
        await msg.react('✅');
      }
    },
  },
];
