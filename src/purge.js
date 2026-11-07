/**
 * 批量清理某个成员在某个频道里发布的图片 / 视频消息。
 *
 * 设计原则：
 *   - **只扫不删**是默认行为，必须显式传 confirm 才会真正删除。
 *   - 先算清楚「会删多少条」再动手，删除过程逐批汇报进度。
 *   - 14 天内的消息用 Discord 的批量删除接口（一次最多 100 条），更早的逐条删。
 *   - 删除不可恢复；如果命中的是帖子（thread）的起始消息，帖子会一并消失，报告里会标出来。
 *
 * 只处理附件与图片/视频嵌入；普通文件（pdf、zip 等）与链接预览的缩略图不算。
 */

import { SlashCommandBuilder, ChannelType } from 'discord.js';

/** 14 天是 Discord 批量删除的硬上限，留 1 分钟余量 */
const BULK_DELETE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000 - 60 * 1000;

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|avif|heic|tiff?)(\?|$)/i;
const VIDEO_EXT = /\.(mp4|mov|webm|m4v|avi|mkv|mpe?g|wmv|flv)(\?|$)/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 兼容 discord.js 的 Collection 与普通数组 */
function toArray(coll) {
  if (!coll) return [];
  if (Array.isArray(coll)) return coll;
  if (typeof coll.values === 'function') return [...coll.values()];
  return [];
}

/**
 * 取出一条消息里的图片 / 视频。
 * 同时兼容 discord.js 的对象（contentType / name）与 REST 返回的原始 JSON（content_type / filename）。
 */
export function mediaOf(message) {
  const found = [];

  for (const att of toArray(message?.attachments)) {
    const type = String(att.contentType || att.content_type || '').toLowerCase();
    const probe = att.url || att.name || att.filename || '';
    const name = att.name || att.filename || '(未命名)';

    let kind = null;
    if (type.startsWith('image/')) kind = 'image';
    else if (type.startsWith('video/')) kind = 'video';
    else if (IMAGE_EXT.test(probe)) kind = 'image';
    else if (VIDEO_EXT.test(probe)) kind = 'video';

    if (kind) found.push({ kind, name, size: att.size || 0 });
  }

  // 只认明确的图片 / 视频嵌入；缩略图多半是链接预览，容易误判，不算
  for (const embed of toArray(message?.embeds)) {
    if (embed?.type === 'image' || embed?.image?.url) {
      found.push({ kind: 'image', name: '(embed)', size: 0 });
    }
    if (embed?.type === 'video' || embed?.video?.url) {
      found.push({ kind: 'video', name: '(embed)', size: 0 });
    }
  }

  return found;
}

/**
 * /purge-media 的命令定义。
 * 默认只统计、不删除；必须显式传 confirm:true 才会真的删。
 */
export function buildPurgeMediaCommand() {
  return new SlashCommandBuilder()
    .setName('purge-media')
    .setDescription(
      'Delete every image / video posted by one member in a channel (dry run unless confirm:true)'
    )
    .addStringOption((o) =>
      o.setName('user').setDescription('Target member ID (17-20 digits)').setRequired(true)
    )
    .addChannelOption((o) =>
      o
        .setName('channel')
        .setDescription('Channel to clean (default: this channel)')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
    )
    .addBooleanOption((o) =>
      o.setName('confirm').setDescription('Set true to actually delete (default: dry run)')
    )
    .addBooleanOption((o) =>
      o.setName('keep_pinned').setDescription('Keep pinned messages (default: false)')
    );
}

/** 人类可读的文件大小，用于回复与日志 */
export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}

/** 汇总命中结果，用于回复里展示 */
export function summarize(hits) {
  let images = 0;
  let videos = 0;
  let bytes = 0;
  for (const hit of hits) {
    for (const m of hit.media) {
      if (m.kind === 'image') images += 1;
      else videos += 1;
      bytes += m.size || 0;
    }
  }
  const times = hits.map((h) => h.createdAt.getTime()).filter(Number.isFinite);
  return {
    messages: hits.length,
    images,
    videos,
    bytes,
    threads: hits.filter((h) => h.hasThread).length,
    earliest: times.length ? new Date(Math.min(...times)) : null,
    latest: times.length ? new Date(Math.max(...times)) : null,
  };
}

/**
 * 倒序翻完频道历史，找出该成员发布的、带图片或视频的消息。
 *
 * @param {object} channel discord.js 的频道对象
 * @param {string} userId  目标成员 ID
 * @param {object} opts    keepPinned（保留置顶）/ maxMessages（最多扫描多少条，0=不限）/ onProgress
 */
export async function collectMediaMessages(channel, userId, opts = {}) {
  const { keepPinned = false, maxMessages = 0, onProgress } = opts;
  const hits = [];
  let before;
  let scanned = 0;
  let pages = 0;

  for (;;) {
    const batch = await channel.messages.fetch({ limit: 100, before });
    if (!batch || batch.size === 0) break;

    pages += 1;

    // 游标要推进到本页**最旧**的一条。Discord 的 before 参数按雪花 ID 比较，
    // 所以直接取最小 ID，而不是按时间戳排序（时间戳可能并列）。
    let oldestId = null;

    for (const msg of toArray(batch)) {
      scanned += 1;
      if (oldestId === null || BigInt(msg.id) < BigInt(oldestId)) oldestId = msg.id;

      if (msg.author?.id !== userId) continue;
      if (keepPinned && msg.pinned) continue;
      const media = mediaOf(msg);
      if (media.length === 0) continue;
      hits.push({
        id: msg.id,
        createdAt: msg.createdAt,
        pinned: !!msg.pinned,
        hasThread: !!msg.thread,
        media,
        content: msg.content || '',
      });
    }

    if (onProgress && pages % 10 === 0) onProgress({ scanned, hits: hits.length, pages });
    if (maxMessages && scanned >= maxMessages) break;
    if (batch.size < 100) break;

    before = oldestId;
    await sleep(250);
  }

  return { hits, scanned, pages };
}

/**
 * 真正执行删除。
 * 返回 { deleted, failures }；已被别人删掉的消息（Unknown Message）视为成功。
 */
export async function deleteMediaMessages(channel, hits, opts = {}) {
  const { onProgress } = opts;
  const now = Date.now();
  const recent = hits.filter((h) => now - h.createdAt.getTime() < BULK_DELETE_WINDOW_MS);
  const old = hits.filter((h) => now - h.createdAt.getTime() >= BULK_DELETE_WINDOW_MS);

  let deleted = 0;
  const failures = [];
  const gone = /unknown message|10008/i;

  // 14 天内的：走批量删除，一次 100 条
  for (let i = 0; i < recent.length; i += 100) {
    const chunk = recent.slice(i, i + 100);
    try {
      const result = await channel.bulkDelete(
        chunk.map((h) => h.id),
        true
      );
      deleted += result?.size ?? chunk.length;
    } catch (e) {
      // 批量失败就退回逐条，避免整批卡住
      for (const hit of chunk) {
        try {
          const msg = await channel.messages.fetch(hit.id);
          await msg.delete();
          deleted += 1;
        } catch (err) {
          if (gone.test(err.message)) deleted += 1;
          else failures.push({ id: hit.id, error: err.message });
        }
        await sleep(350);
      }
    }
    if (onProgress) onProgress({ deleted, total: hits.length });
    await sleep(500);
  }

  // 超过 14 天的：只能逐条删（Discord 的硬限制）
  for (const hit of old) {
    try {
      const msg = await channel.messages.fetch(hit.id);
      await msg.delete();
      deleted += 1;
    } catch (err) {
      if (gone.test(err.message)) deleted += 1;
      else failures.push({ id: hit.id, error: err.message });
    }
    if (onProgress) onProgress({ deleted, total: hits.length });
    await sleep(350);
  }

  return { deleted, failures, bulkCount: recent.length, singleCount: old.length };
}
