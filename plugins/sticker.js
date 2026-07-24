'use strict';

/**
 * plugins/sticker.js — Sticker and photo conversion.
 *
 * Commands:
 *   .sticker — Convert image / video / GIF to a WhatsApp sticker
 *   .photo   — Convert a sticker back to an image or video
 *
 * Uses:
 *   sharp         — image WebP conversion
 *   fluent-ffmpeg — video / GIF → animated WebP
 *   @ffmpeg-installer/ffmpeg — bundled FFmpeg binary (no system dep)
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');

const config = require('../config');
const { logger, ensureDir } = require('../lib/utils');

// Point fluent-ffmpeg at the bundled binary.
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const MEDIA_DIR = path.resolve(config.mediaDir);
ensureDir(MEDIA_DIR);

// Maximum sticker dimensions (WhatsApp limit).
const STICKER_SIZE = 512;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Add WhatsApp sticker EXIF metadata (pack name + author) to a WebP buffer.
 * This is done by writing a custom EXIF-like JSON payload that WhatsApp reads.
 *
 * @param {Buffer} webpBuffer
 * @param {string} packName
 * @param {string} author
 * @returns {Buffer}
 */
function addStickerMetadata(webpBuffer, packName, author) {
  const json = {
    'sticker-pack-id': `ryzen.${Date.now()}`,
    'sticker-pack-name': packName,
    'sticker-pack-publisher': author,
    'android-app-store-link': '',
    'ios-app-store-link': '',
    emojis: ['🤖'],
  };

  const jsonStr = JSON.stringify(json);
  const jsonBuf = Buffer.from(jsonStr, 'utf-8');

  // EXIF header boilerplate for WebP sticker metadata.
  const exifHeader = Buffer.from([
    0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00,
    0x41, 0x57, 0x07, 0x00,
  ]);

  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(jsonBuf.length, 0);

  const exifData = Buffer.concat([exifHeader, lenBuf, jsonBuf]);

  // Insert EXIF chunk into the WebP file after the RIFF/WEBP header.
  const exifChunk = Buffer.concat([
    Buffer.from('EXIF'),
    (() => { const b = Buffer.alloc(4); b.writeUInt32LE(exifData.length, 0); return b; })(),
    exifData,
  ]);

  // WebP RIFF structure: bytes 0-3 = "RIFF", 4-7 = file size, 8-11 = "WEBP"
  const riffHeader = webpBuffer.slice(0, 12);
  const rest = webpBuffer.slice(12);
  const newFileSize = webpBuffer.length + exifChunk.length - 8;
  const fileSizeBuf = Buffer.alloc(4);
  fileSizeBuf.writeUInt32LE(newFileSize, 0);

  return Buffer.concat([
    riffHeader.slice(0, 4),  // "RIFF"
    fileSizeBuf,
    riffHeader.slice(8, 12), // "WEBP"
    exifChunk,
    rest,
  ]);
}

/**
 * Convert an image buffer to a properly-sized sticker WebP buffer.
 * @param {Buffer} inputBuffer
 * @returns {Promise<Buffer>}
 */
async function imageToStickerBuffer(inputBuffer) {
  const webp = await sharp(inputBuffer)
    .resize(STICKER_SIZE, STICKER_SIZE, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .webp({ quality: 80 })
    .toBuffer();

  return addStickerMetadata(webp, config.stickerName, config.stickerAuthor);
}

/**
 * Convert a video or GIF file to an animated WebP sticker.
 * @param {string} inputPath — path to the input video/gif file
 * @param {string} outputPath — path to write the .webp file
 * @returns {Promise<void>}
 */
function videoToAnimatedWebP(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .output(outputPath)
      .outputOptions([
        '-vf', `scale=${STICKER_SIZE}:${STICKER_SIZE}:force_original_aspect_ratio=decrease,pad=${STICKER_SIZE}:${STICKER_SIZE}:(ow-iw)/2:(oh-ih)/2:color=black@0`,
        '-vcodec', 'libwebp',
        '-lossless', '0',
        '-compression_level', '6',
        '-q:v', '50',
        '-loop', '0',
        '-preset', 'default',
        '-an',
        '-vsync', '0',
        '-t', '8',          // WhatsApp sticker max duration: 8s
      ])
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

// ─── Commands ────────────────────────────────────────────────────────────────

module.exports = [
  // ── .sticker ───────────────────────────────────────────────────────────────
  {
    name: 'sticker',
    description: 'Convert image, GIF, or video to a WhatsApp sticker',
    usage: '.sticker [reply to media]',
    command: ['sticker', 's', 'stiker'],
    category: 'Sticker',

    async execute(sock, msg, args) {
      // Determine the source message (direct media or quoted media).
      const source = msg.type !== 'text' ? msg : msg.quoted;

      if (!source || !['image', 'video', 'sticker'].includes(source.type)) {
        await msg.reply(
          '📎 Please send or reply to an image, GIF, or short video (max 8s).\n' +
          `Example: *${config.prefix}sticker*`
        );
        return;
      }

      await msg.react('⏳');

      try {
        const mediaBuffer = await source.download();
        const isVideo = source.type === 'video';

        let stickerBuffer;

        if (isVideo) {
          // Save input, convert with FFmpeg, read output.
          const tmpIn = path.join(MEDIA_DIR, `stk-in-${Date.now()}.mp4`);
          const tmpOut = path.join(MEDIA_DIR, `stk-out-${Date.now()}.webp`);

          fs.writeFileSync(tmpIn, mediaBuffer);
          await videoToAnimatedWebP(tmpIn, tmpOut);

          stickerBuffer = fs.readFileSync(tmpOut);
          stickerBuffer = addStickerMetadata(stickerBuffer, config.stickerName, config.stickerAuthor);

          // Clean up temp files.
          fs.unlinkSync(tmpIn);
          fs.unlinkSync(tmpOut);
        } else {
          stickerBuffer = await imageToStickerBuffer(mediaBuffer);
        }

        await sock.sendMessage(msg.chatJid, {
          sticker: stickerBuffer,
        }, { quoted: msg });

        await msg.react('✅');
      } catch (err) {
        logger.error({ err }, 'sticker conversion failed');
        await msg.react('❌');
        await msg.reply(`❌ Failed to create sticker: ${err.message}`);
      }
    },
  },

  // ── .photo ─────────────────────────────────────────────────────────────────
  {
    name: 'photo',
    description: 'Convert a sticker back to an image or video',
    usage: '.photo [reply to sticker]',
    command: ['photo', 'toimage', 'tovideo'],
    category: 'Sticker',

    async execute(sock, msg, args) {
      const source = msg.type === 'sticker' ? msg : msg.quoted;

      if (!source || source.type !== 'sticker') {
        await msg.reply(
          '📎 Please send or reply to a sticker.\n' +
          `Example: *${config.prefix}photo*`
        );
        return;
      }

      await msg.react('⏳');

      try {
        const stickerBuffer = await source.download();

        // Determine if it's animated by checking for 'ANIM' WebP chunk.
        const isAnimated = stickerBuffer.toString('binary').includes('ANIM');

        if (isAnimated) {
          // Animated sticker → GIF via FFmpeg
          const tmpIn = path.join(MEDIA_DIR, `sti-in-${Date.now()}.webp`);
          const tmpOut = path.join(MEDIA_DIR, `sti-out-${Date.now()}.gif`);

          fs.writeFileSync(tmpIn, stickerBuffer);

          await new Promise((resolve, reject) => {
            ffmpeg(tmpIn)
              .output(tmpOut)
              .outputOptions(['-vf', 'scale=512:512:flags=lanczos'])
              .on('end', resolve)
              .on('error', reject)
              .run();
          });

          const gifBuffer = fs.readFileSync(tmpOut);
          fs.unlinkSync(tmpIn);
          fs.unlinkSync(tmpOut);

          await sock.sendMessage(msg.chatJid, {
            video: gifBuffer,
            gifPlayback: true,
            caption: `🖼️ Converted by *${config.botName}*`,
          }, { quoted: msg });
        } else {
          // Static sticker → PNG via sharp.
          const pngBuffer = await sharp(stickerBuffer).png().toBuffer();

          await sock.sendMessage(msg.chatJid, {
            image: pngBuffer,
            caption: `🖼️ Converted by *${config.botName}*`,
          }, { quoted: msg });
        }

        await msg.react('✅');
      } catch (err) {
        logger.error({ err }, 'photo conversion failed');
        await msg.react('❌');
        await msg.reply(`❌ Failed to convert sticker: ${err.message}`);
      }
    },
  },
];
