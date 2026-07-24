'use strict';

/**
 * plugins/downloader.js — YouTube audio and video downloader.
 *
 * Commands:
 *   .play  <query>  — Search YouTube and send the best match as an audio file
 *   .song  <query>  — Alias for .play
 *   .video <query>  — Search YouTube and send the best match as a video
 *   .youtube <url>  — Download a specific YouTube video (auto-detect format)
 *
 * Uses:
 *   youtubei.js   — YouTube scraping (no API key required)
 *   fluent-ffmpeg — Convert to audio format
 *   @ffmpeg-installer/ffmpeg — Bundled FFmpeg binary
 *
 * Note: Downloads are streamed to disk in /media/ and cleaned up after send.
 */

const path = require('path');
const fs = require('fs');
const { Innertube } = require('youtubei.js');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');

const config = require('../config');
const { logger, ensureDir, downloadFile } = require('../lib/utils');

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const MEDIA_DIR = path.resolve(config.mediaDir);
ensureDir(MEDIA_DIR);

// File size limits (WhatsApp upload limits).
const MAX_AUDIO_MB = 64;
const MAX_VIDEO_MB = 64;

// ─── YouTube client (initialised once) ───────────────────────────────────────
let yt = null;

async function getYT() {
  if (!yt) {
    yt = await Innertube.create({ cache: false, generate_session_locally: true });
  }
  return yt;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Search YouTube and return the best matching video info.
 * @param {string} query
 * @returns {Promise<object>} video info object
 */
async function searchYouTube(query) {
  const youtube = await getYT();
  const results = await youtube.search(query, { type: 'video' });
  if (!results.videos || results.videos.length === 0) {
    throw new Error('No results found for: ' + query);
  }
  return results.videos[0];
}

/**
 * Get YouTube video info by URL or ID.
 * @param {string} urlOrId
 */
async function getVideoInfo(urlOrId) {
  const youtube = await getYT();

  // Extract video ID from URL if needed.
  let videoId = urlOrId;
  const match = urlOrId.match(
    /(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/
  );
  if (match) videoId = match[1];

  return youtube.getInfo(videoId);
}

/**
 * Format duration in seconds to MM:SS or HH:MM:SS.
 * @param {number} seconds
 */
function formatDuration(seconds) {
  if (!seconds) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Download the best audio stream and convert to MP3.
 * @param {string} videoId
 * @param {string} outputPath — destination .mp3 path
 */
async function downloadAudio(videoId, outputPath) {
  const youtube = await getYT();
  const info = await youtube.getInfo(videoId);

  // Get the best audio-only format.
  const format = info.chooseFormat({ quality: 'best', type: 'audio' });
  const streamUrl = format.decipher(youtube.session.player);

  const rawPath = outputPath.replace('.mp3', '.raw');
  await downloadFile(streamUrl, rawPath);

  // Convert to MP3 with FFmpeg.
  await new Promise((resolve, reject) => {
    ffmpeg(rawPath)
      .audioCodec('libmp3lame')
      .audioBitrate(128)
      .output(outputPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });

  fs.unlinkSync(rawPath);
}

/**
 * Download the best video+audio stream (merged).
 * @param {string} videoId
 * @param {string} outputPath — destination .mp4 path
 */
async function downloadVideo(videoId, outputPath) {
  const youtube = await getYT();
  const info = await youtube.getInfo(videoId);

  // Prefer 720p, fall back to 480p or best available.
  let format;
  try {
    format = info.chooseFormat({ quality: '720p', type: 'video+audio' });
  } catch {
    try {
      format = info.chooseFormat({ quality: '480p', type: 'video+audio' });
    } catch {
      format = info.chooseFormat({ quality: 'best', type: 'video+audio' });
    }
  }

  const streamUrl = format.decipher(youtube.session.player);
  await downloadFile(streamUrl, outputPath);
}

// ─── Commands ────────────────────────────────────────────────────────────────

module.exports = [
  // ── .play / .song ──────────────────────────────────────────────────────────
  {
    name: 'play',
    description: 'Search YouTube and send a song as audio',
    usage: '.play <song name or URL>',
    command: ['play', 'song', 'music'],
    category: 'Downloader',

    async execute(sock, msg, args) {
      const query = args.join(' ');
      if (!query) {
        await msg.reply(`Usage: ${config.prefix}play <song name>\nExample: ${config.prefix}play Imagine Dragons Believer`);
        return;
      }

      await msg.react('⏳');

      try {
        // Determine if query is a direct URL or a search term.
        const isDirectUrl = /youtu(be\.com|\.be)/.test(query);
        let videoId, title, duration, thumbnail, channelName;

        if (isDirectUrl) {
          const info = await getVideoInfo(query);
          const basicInfo = info.basic_info;
          videoId = basicInfo.id;
          title = basicInfo.title;
          duration = basicInfo.duration;
          channelName = basicInfo.channel?.name || 'Unknown';
          thumbnail = basicInfo.thumbnail?.[0]?.url;
        } else {
          const result = await searchYouTube(query);
          videoId = result.id;
          title = result.title?.text || query;
          duration = result.duration?.seconds || 0;
          channelName = result.author?.name || 'Unknown';
          thumbnail = result.thumbnails?.[0]?.url;
        }

        // Reject very long videos (>10 min for audio).
        if (duration > 600) {
          await msg.react('❌');
          await msg.reply(`❌ Video too long (${formatDuration(duration)}). Maximum is 10 minutes for audio.`);
          return;
        }

        const outputPath = path.join(MEDIA_DIR, `audio-${Date.now()}.mp3`);
        await downloadAudio(videoId, outputPath);

        const stats = fs.statSync(outputPath);
        if (stats.size > MAX_AUDIO_MB * 1024 * 1024) {
          fs.unlinkSync(outputPath);
          await msg.react('❌');
          await msg.reply(`❌ Audio file too large to send (>${MAX_AUDIO_MB}MB).`);
          return;
        }

        const audioBuffer = fs.readFileSync(outputPath);
        fs.unlinkSync(outputPath);

        await sock.sendMessage(msg.chatJid, {
          audio: audioBuffer,
          mimetype: 'audio/mpeg',
          fileName: `${title}.mp3`,
          pttAudio: false,
        }, { quoted: msg });

        // Send info card after the audio.
        await msg.reply(
          `🎵 *${title}*\n` +
          `👤 ${channelName}\n` +
          `⏱️ ${formatDuration(duration)}`
        );

        await msg.react('✅');
      } catch (err) {
        logger.error({ err }, 'play command failed');
        await msg.react('❌');
        await msg.reply(`❌ Download failed: ${err.message}`);
      }
    },
  },

  // ── .video ─────────────────────────────────────────────────────────────────
  {
    name: 'video',
    description: 'Search YouTube and send a video',
    usage: '.video <search query or URL>',
    command: ['video', 'yt', 'youtube'],
    category: 'Downloader',

    async execute(sock, msg, args) {
      const query = args.join(' ');
      if (!query) {
        await msg.reply(`Usage: ${config.prefix}video <title or URL>\nExample: ${config.prefix}video Coldplay Yellow`);
        return;
      }

      await msg.react('⏳');

      try {
        const isDirectUrl = /youtu(be\.com|\.be)/.test(query);
        let videoId, title, duration, channelName;

        if (isDirectUrl) {
          const info = await getVideoInfo(query);
          const basicInfo = info.basic_info;
          videoId = basicInfo.id;
          title = basicInfo.title;
          duration = basicInfo.duration;
          channelName = basicInfo.channel?.name || 'Unknown';
        } else {
          const result = await searchYouTube(query);
          videoId = result.id;
          title = result.title?.text || query;
          duration = result.duration?.seconds || 0;
          channelName = result.author?.name || 'Unknown';
        }

        // Reject videos over 5 minutes for video download (file size concern).
        if (duration > 300) {
          await msg.react('❌');
          await msg.reply(`❌ Video too long (${formatDuration(duration)}). Maximum is 5 minutes for video.`);
          return;
        }

        const outputPath = path.join(MEDIA_DIR, `video-${Date.now()}.mp4`);
        await downloadVideo(videoId, outputPath);

        const stats = fs.statSync(outputPath);
        if (stats.size > MAX_VIDEO_MB * 1024 * 1024) {
          fs.unlinkSync(outputPath);
          await msg.react('❌');
          await msg.reply(`❌ Video file too large to send (>${MAX_VIDEO_MB}MB).`);
          return;
        }

        const videoBuffer = fs.readFileSync(outputPath);
        fs.unlinkSync(outputPath);

        await sock.sendMessage(msg.chatJid, {
          video: videoBuffer,
          caption: `🎬 *${title}*\n👤 ${channelName}\n⏱️ ${formatDuration(duration)}`,
          fileName: `${title}.mp4`,
        }, { quoted: msg });

        await msg.react('✅');
      } catch (err) {
        logger.error({ err }, 'video command failed');
        await msg.react('❌');
        await msg.reply(`❌ Download failed: ${err.message}`);
      }
    },
  },
];
