'use strict';

/**
 * plugins/menu.js — Dynamic command menu.
 *
 * Commands:
 *   .menu           — full categorised command list
 *   .help <command> — usage info for a specific command
 *   .owner          — show owner contact info
 */

const config = require('../config');
const { getCommandsByCategory, pluginRegistry } = require('../lib/pluginLoader');
const { runtime } = require('../lib/utils');

// ─── Emoji per category ──────────────────────────────────────────────────────
const CATEGORY_EMOJI = {
  General:    '⚙️',
  Sticker:    '🎭',
  Media:      '📸',
  Group:      '👥',
  AI:         '🤖',
  Downloader: '📥',
  Utility:    '🔧',
  Owner:      '👑',
  Plugins:    '🧩',
  Misc:       '📦',
};

module.exports = [
  // ── .menu ──────────────────────────────────────────────────────────────────
  {
    name: 'menu',
    description: 'Display all available commands',
    usage: '.menu',
    command: ['menu', 'help', 'cmds', 'commands'],
    category: 'General',

    async execute(sock, msg, args) {
      // If an argument is provided, route to the help handler.
      if (args.length > 0) {
        return helpCommand(sock, msg, args);
      }

      const categories = getCommandsByCategory();
      const totalCommands = [...categories.values()].reduce((n, cmds) => n + cmds.length, 0);

      const lines = [
        `╔══════════════════════════════╗`,
        `║   🤖  *${config.botName}*  🤖       ║`,
        `╚══════════════════════════════╝`,
        '',
        `👤 *Owner*    : ${config.ownerName}`,
        `⏱️  *Uptime*  : ${runtime()}`,
        `📦 *Commands* : ${totalCommands}`,
        `🔖 *Prefix*   : \`${config.prefix}\``,
        '',
        '─────────────────────────────────',
      ];

      // Sort categories alphabetically but put General first.
      const sortedCategories = [...categories.keys()].sort((a, b) => {
        if (a === 'General') return -1;
        if (b === 'General') return 1;
        return a.localeCompare(b);
      });

      for (const cat of sortedCategories) {
        const cmds = categories.get(cat);
        const emoji = CATEGORY_EMOJI[cat] || '📌';
        lines.push('');
        lines.push(`${emoji} *${cat}*`);

        // Sort commands alphabetically within each category.
        const sorted = cmds.slice().sort((a, b) => a.name.localeCompare(b.name));
        for (const cmd of sorted) {
          const aliases = Array.isArray(cmd.command) ? cmd.command : [cmd.command];
          const primary = aliases[0];
          const ownerTag = cmd.isOwnerOnly ? ' 👑' : '';
          lines.push(`  ${config.prefix}${primary}${ownerTag} — ${cmd.description}`);
        }
      }

      lines.push('');
      lines.push('─────────────────────────────────');
      lines.push(`💡 Use \`${config.prefix}help <command>\` for details.`);
      lines.push(`👑 = Owner only`);

      await msg.reply(lines.join('\n'));
    },
  },

  // ── .help <command> ────────────────────────────────────────────────────────
  {
    name: 'help',
    description: 'Get detailed usage for a specific command',
    usage: '.help <command>',
    command: 'helpme',   // "help" is an alias of menu above; this is a fallback
    category: 'General',

    async execute(sock, msg, args) {
      await helpCommand(sock, msg, args);
    },
  },

  // ── .owner ─────────────────────────────────────────────────────────────────
  {
    name: 'owner',
    description: 'Show bot owner contact information',
    usage: '.owner',
    command: 'owner',
    category: 'General',

    async execute(sock, msg) {
      const ownerNumber = config.sudoNumbers[0];

      const text = [
        `👑 *Bot Owner*`,
        '',
        `📛 Name   : ${config.ownerName}`,
        ownerNumber
          ? `📱 Number : wa.me/${ownerNumber}`
          : `📱 Number : Not configured`,
        '',
        `🤖 Bot    : ${config.botName} v${config.version}`,
      ].join('\n');

      await msg.reply(text);

      // Also send as a contact card if the owner number is configured.
      if (ownerNumber) {
        await sock.sendMessage(msg.chatJid, {
          contacts: {
            displayName: config.ownerName,
            contacts: [
              {
                vcard:
                  `BEGIN:VCARD\nVERSION:3.0\nFN:${config.ownerName}\n` +
                  `TEL;type=CELL;type=VOICE;waid=${ownerNumber}:+${ownerNumber}\nEND:VCARD`,
              },
            ],
          },
        }, { quoted: msg });
      }
    },
  },
];

// ─── Shared helper ───────────────────────────────────────────────────────────

async function helpCommand(sock, msg, args) {
  const commandName = args[0]?.toLowerCase().replace(/^\./, '');

  if (!commandName) {
    await msg.reply(`Usage: \`${config.prefix}help <command>\`\nExample: \`${config.prefix}help sticker\``);
    return;
  }

  const plugin = pluginRegistry.get(commandName);
  if (!plugin) {
    await msg.reply(`❌ Command *${commandName}* not found.\nUse \`${config.prefix}menu\` to see all commands.`);
    return;
  }

  const aliases = Array.isArray(plugin.command) ? plugin.command : [plugin.command];

  const lines = [
    `📌 *Command Info*`,
    '',
    `🔖 *Name*        : ${plugin.name}`,
    `📋 *Description* : ${plugin.description}`,
    `💡 *Usage*       : \`${plugin.usage}\``,
    `📁 *Category*    : ${plugin.category || 'Misc'}`,
    `🔗 *Aliases*     : ${aliases.map((a) => `\`${config.prefix}${a}\``).join(', ')}`,
    `👑 *Owner Only*  : ${plugin.isOwnerOnly ? 'Yes' : 'No'}`,
    `👥 *Group Only*  : ${plugin.isGroupOnly ? 'Yes' : 'No'}`,
    `💬 *DM Only*     : ${plugin.isDmOnly ? 'Yes' : 'No'}`,
  ];

  await msg.reply(lines.join('\n'));
}
