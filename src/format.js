import { config } from './config.js';

const fmtDateTime = new Intl.DateTimeFormat('zh-CN', {
  timeZone: config.timezone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const fmtShort = new Intl.DateTimeFormat('zh-CN', {
  timeZone: config.timezone,
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** 2026/09/21 10:46 */
export function formatDateTime(value) {
  return fmtDateTime.format(new Date(value));
}

/** 09/21 10:46 */
export function formatShort(value) {
  return fmtShort.format(new Date(value));
}

/** 把毫秒差转成「2 天 3 小时 15 分钟」 */
export function humanDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts = [];
  if (days) parts.push(`${days} 天`);
  if (hours) parts.push(`${hours} 小时`);
  if (minutes) parts.push(`${minutes} 分钟`);
  if (parts.length === 0) parts.push(`${seconds} 秒`);
  return parts.join(' ');
}

/** 统计发言人数与每人条数 */
export function countByAuthor(messages) {
  const map = new Map();
  for (const m of messages) {
    const key = m.author_display_name || m.author_name || m.author_id;
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
}

/** 把消息数组转成给 AI 看的纯文本日志 */
export function buildTranscript(messages) {
  return messages
    .map((m) => {
      const name = m.author_display_name || m.author_name || m.author_id;
      const text = (m.content ?? '').replace(/\r?\n/g, ' ⏎ ').trim();
      const files = Array.isArray(m.attachments) && m.attachments.length
        ? ` [附件×${m.attachments.length}]`
        : '';
      const reply = m.reply_to_id ? ' [回复]' : '';
      return `[${formatDateTime(m.created_at)}] ${name}${reply}: ${text || '(空消息)'}${files}`;
    })
    .join('\n');
}

/** 把长文本切成若干条 ≤ limit 字符的消息（Discord 单条上限 2000） */
export function splitMessage(text, limit = 1900) {
  const source = String(text ?? '');
  if (source.length <= limit) return [source];

  const chunks = [];
  let current = '';

  for (const block of source.split('\n')) {
    const candidate = current ? `${current}\n${block}` : block;

    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }

    if (current) {
      chunks.push(current);
      current = '';
    }

    // 单行本身就超长，硬切
    let rest = block;
    while (rest.length > limit) {
      chunks.push(rest.slice(0, limit));
      rest = rest.slice(limit);
    }
    current = rest;
  }

  if (current) chunks.push(current);
  return chunks;
}
