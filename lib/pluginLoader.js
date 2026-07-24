'use strict';

/**
 * lib/pluginLoader.js — Dynamic plugin loader for RYZEN.
 *
 * Scans the /plugins directory on startup and registers every exported
 * command object. Plugins can be hot-reloaded without restarting the bot.
 *
 * Plugin file contract — each file must export an array of objects:
 * [
 *   {
 *     name:        string   — unique identifier, e.g. "ping"
 *     description: string   — one-line description shown in .menu
 *     usage:       string   — usage example, e.g. ".ping"
 *     command:     string | string[]  — trigger word(s) without prefix
 *     category:    string   — menu category, e.g. "General"
 *     isOwnerOnly: boolean  — restrict to sudo users
 *     isGroupOnly: boolean  — only works in groups
 *     isDmOnly:    boolean  — only works in DMs
 *     execute:     async (sock, msg, args) => void
 *   }
 * ]
 */

const path = require('path');
const fs = require('fs');
const config = require('../config');
const { logger } = require('./utils');

/** Map of command string → plugin object. */
const commandMap = new Map();

/** Map of plugin name → plugin object (for .plugins / .remove). */
const pluginRegistry = new Map();

/**
 * Load (or reload) a single plugin file.
 * @param {string} filePath — absolute path to the plugin .js file
 * @returns {number} number of commands loaded from this file
 */
function loadPlugin(filePath) {
  // Bust the module cache so re-loading picks up file changes.
  delete require.cache[require.resolve(filePath)];

  let exports;
  try {
    exports = require(filePath);
  } catch (err) {
    logger.error({ err, filePath }, `Failed to load plugin: ${path.basename(filePath)}`);
    return 0;
  }

  // Normalise: accept both a single object and an array of objects.
  const commands = Array.isArray(exports) ? exports : [exports];
  let loaded = 0;

  for (const cmd of commands) {
    if (!cmd || typeof cmd.execute !== 'function') {
      logger.warn(`Plugin ${path.basename(filePath)} exported a non-command object — skipped`);
      continue;
    }
    if (!cmd.name || !cmd.command) {
      logger.warn(`Plugin ${path.basename(filePath)} is missing name or command fields — skipped`);
      continue;
    }

    // Register under every alias.
    const aliases = Array.isArray(cmd.command) ? cmd.command : [cmd.command];
    for (const alias of aliases) {
      commandMap.set(alias.toLowerCase(), cmd);
    }

    // Store in registry keyed by name.
    pluginRegistry.set(cmd.name.toLowerCase(), { ...cmd, filePath });
    loaded++;
  }

  return loaded;
}

/**
 * Unload all commands that came from a specific file.
 * @param {string} filePath
 */
function unloadPlugin(filePath) {
  const absPath = path.resolve(filePath);

  for (const [name, plugin] of pluginRegistry.entries()) {
    if (path.resolve(plugin.filePath) === absPath) {
      // Remove all command aliases.
      const aliases = Array.isArray(plugin.command) ? plugin.command : [plugin.command];
      for (const alias of aliases) {
        commandMap.delete(alias.toLowerCase());
      }
      pluginRegistry.delete(name);
    }
  }

  delete require.cache[require.resolve(absPath)];
}

/**
 * Load all .js files from the plugins directory.
 * Called once on startup and optionally after .reload.
 */
function loadAllPlugins() {
  const pluginsDir = path.resolve(config.pluginsDir);

  if (!fs.existsSync(pluginsDir)) {
    fs.mkdirSync(pluginsDir, { recursive: true });
  }

  // Clear existing registrations before re-scanning.
  commandMap.clear();
  pluginRegistry.clear();

  const files = fs
    .readdirSync(pluginsDir)
    .filter((f) => f.endsWith('.js'));

  let totalCommands = 0;

  for (const file of files) {
    const filePath = path.join(pluginsDir, file);
    const count = loadPlugin(filePath);
    if (count > 0) {
      logger.info(`  ✅ Loaded plugin: ${file} (${count} command${count > 1 ? 's' : ''})`);
      totalCommands += count;
    }
  }

  logger.info(`📦 Plugin loader: ${files.length} files → ${totalCommands} commands ready`);
}

/**
 * Find the command handler for a given trigger word.
 * @param {string} trigger — command word without prefix
 * @returns {object|undefined}
 */
function getCommand(trigger) {
  return commandMap.get(trigger.toLowerCase());
}

/**
 * Get all loaded commands grouped by category.
 * @returns {Map<string, object[]>}
 */
function getCommandsByCategory() {
  const categories = new Map();

  for (const cmd of pluginRegistry.values()) {
    const cat = cmd.category || 'Misc';
    if (!categories.has(cat)) categories.set(cat, []);
    categories.get(cat).push(cmd);
  }

  return categories;
}

/**
 * Get total number of loaded commands.
 */
function getCommandCount() {
  return commandMap.size;
}

module.exports = {
  loadAllPlugins,
  loadPlugin,
  unloadPlugin,
  getCommand,
  getCommandsByCategory,
  getCommandCount,
  commandMap,
  pluginRegistry,
};
