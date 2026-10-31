/**
 * 反刷屏守卫：监控指定频道，命中规则后记录证据、私信报告人、执行封禁 / 禁言。
 *
 * 触发规则（任一命中即触发）：
 *   1. 单条消息字符数 > guard.maxChars（默认 400）
 *   2. 窗口期（默认 5 分钟）内消息数 > guard.maxMessages（默认 2）
 *      且这些消息合计字符数 > guard.windowChars（默认 500）
 *
 * 处置方式：
 *   - 服务器所有者 / 拥有 Administrator 权限 / 拥有配置的管理员角色 → 完全跳过
 *   - 拥有 premium 角色 → 删除本批消息 + 禁言（默认 7 天），不封禁
 *   - 其他成员 → 先私信报告，再封禁（默认连带删除 24 小时消息），最后私信封禁结果
 *
 * 设计取舍：
 *   - 窗口、占用、冷却全部放在内存里，重启即清空。这只会「漏判」，不会「误判」。
 *   - 处置失败后会进入冷却期，避免同一个人连续触发、把报告人的私信箱刷爆。
 *   - 本模块不写数据库：命中消息的原文直接写进私信报告里，够复核用。
 */
import { PermissionFlagsBits } from 'discord.js';
import { config } from './config.js';
import { splitMessage } from './format.js';

const g = config.guard;

/** 窗口长度（毫秒） */
const WINDOW_MS = g.windowMinutes * 60 * 1000;
/** 禁言时长（毫秒） */
const TIMEOUT_MS = g.timeoutDays * 24 * 60 * 60 * 1000;
/** 单个成员最多保留多少条窗口内记录，防止内存无限增长 */
const MAX_TRACKED = 20;
/** 定期清理陈旧窗口的间隔 */
const SWEEP_INTERVAL_MS = 60 * 1000;
/** 报告里最多列出多少条消息、每条最多截断到多少字符 */
const MAX_REPORTED = 10;
const TRUNCATE_TO = 1000;

/** userId → 窗口内的消息记录 */
const windows = new Map();
/** 正在处置中的成员，避免同一批消息被多条并发处理 */
const enforcing = new Set();
/** userId → 冷却到期时间戳 */
const cooldownUntil = new Map();
let lastSweepAt = 0;

/**
 * 统计字符数。按码点计数，一个 emoji 算 1 个字符（`'👍'.length === 2`，这里算 1）。
 */
export function countChars(text) {
  return [...String(text ?? '')].length;
}

/**
 * 找出这条消息属于哪个被监控的频道。
 * 帖子（线程）里的消息用 parentId 归到父频道，否则线程内的刷屏会漏掉。
 */
export function watchedChannelId(msg) {
  if (g.channelIds.includes(msg.channelId)) return msg.channelId;
  const parentId = msg.channel?.parentId;
  if (parentId && g.channelIds.includes(parentId)) return parentId;
  return null;
}

/** 是否豁免：服务器所有者、Administrator 权限、配置里的管理员角色 */
export function isExemptMember(member, guild) {
  // 拿不到成员对象就不处置 —— 宁可漏判，也不能误封
  if (!member) return true;
  if (guild && guild.ownerId === member.id) return true;
  if (member.permissions?.has?.(PermissionFlagsBits.Administrator)) return true;
  for (const roleId of g.adminRoleIds) {
    if (member.roles?.cache?.has(roleId)) return true;
  }
  return false;
}

/** 是否持有 premium 角色 */
export function isPremiumMember(member) {
  if (!member) return false;
  for (const roleId of g.premiumRoleIds) {
    if (member.roles?.cache?.has(roleId)) return true;
  }
  return false;
}

/**
 * 判定是否触发。`entries` 按时间正序，最后一条是刚收到的消息。
 * 返回 null 表示未触发。
 */
export function detectTrigger(entries, now = Date.now()) {
  if (!entries || entries.length === 0) return null;

  // 规则 1：单条超长
  const last = entries[entries.length - 1];
  if (last.chars > g.maxChars) {
    return {
      kind: 'length',
      entries: [last],
      messageCount: 1,
      totalChars: last.chars,
    };
  }

  // 规则 2：窗口内条数与合计字符同时超限
  const recent = entries.filter((e) => now - e.at <= WINDOW_MS);
  const totalChars = recent.reduce((sum, e) => sum + e.chars, 0);
  if (recent.length > g.maxMessages && totalChars > g.windowChars) {
    return {
      kind: 'flood',
      entries: recent,
      messageCount: recent.length,
      totalChars,
    };
  }

  return null;
}

/** 写入窗口记录，同时裁掉过期的和超量的 */
function recordEntry(userId, entry) {
  const existing = windows.get(userId) ?? [];
  existing.push(entry);
  const fresh = existing.filter((e) => entry.at - e.at <= WINDOW_MS);
  windows.set(userId, fresh.slice(-MAX_TRACKED));
}

/** 定期清理陈旧数据（每个清理周期最多扫一次） */
function sweepIfDue(now) {
  if (now - lastSweepAt < SWEEP_INTERVAL_MS) return;
  lastSweepAt = now;
  const cutoff = now - WINDOW_MS;
  for (const [userId, entries] of windows) {
    const fresh = entries.filter((e) => e.at >= cutoff);
    if (fresh.length === 0) windows.delete(userId);
    else if (fresh.length !== entries.length) windows.set(userId, fresh);
  }
  for (const [userId, until] of cooldownUntil) {
    if (until <= now) cooldownUntil.delete(userId);
  }
}

/** 把一条消息压成报告里的一行（避免过长或多行撑爆私信） */
function quoteContent(content) {
  const raw = String(content ?? '').replace(/\r\n/g, '\n');
  const text = raw.length > TRUNCATE_TO ? `${raw.slice(0, TRUNCATE_TO)}…（已截断）` : raw;
  if (!text.trim()) return '> （无文本内容，可能是纯图片/附件）';
  return text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

function formatTime(ts) {
  // 统一按配置时区展示，避免报告里时间对不上
  try {
    return new Date(ts).toLocaleString('zh-CN', { timeZone: config.timezone, hour12: false });
  } catch {
    return new Date(ts).toISOString();
  }
}

/** 组装触发报告（发给报告人） */
export function buildTriggerReport({ member, trigger, channelNames }) {
  const shown = trigger.entries.slice(-MAX_REPORTED);
  const hidden = trigger.entries.length - shown.length;
  const rule =
    trigger.kind === 'length'
      ? `single message over ${g.maxChars} chars (${trigger.totalChars} chars)`
      : `more than ${g.maxMessages} messages totalling over ${g.windowChars} chars within ${g.windowMinutes} min`;

  const lines = [];
  lines.push('🛡️ **Spam guard triggered**');
  lines.push(`Rule: ${rule}`);
  lines.push(
    `Member: ${member.user.username} (${member.displayName || member.user.username}) · ID \`${member.id}\``
  );
  lines.push(`Channel: ${channelNames.join(', ')}`);
  lines.push(`Total: ${trigger.messageCount} message(s) / ${trigger.totalChars} chars`);
  lines.push('');
  shown.forEach((entry, index) => {
    lines.push(`--- message ${index + 1} · ${entry.channelName} · ${formatTime(entry.at)} ---`);
    lines.push(quoteContent(entry.content));
  });
  if (hidden > 0) lines.push(`_(${hidden} earlier message(s) omitted)_`);

  return lines.join('\n');
}

/** 通过私信发给所有报告人；失败只记日志，绝不因此取消处置 */
async function sendReport(client, text) {
  let delivered = 0;
  for (const userId of g.reportUserIds) {
    try {
      const user = await client.users.fetch(userId);
      for (const chunk of splitMessage(text)) {
        await user.send({ content: chunk, allowedMentions: { parse: [] } });
      }
      delivered += 1;
    } catch (e) {
      console.error(
        `[守卫] 私信报告人 ${userId} 失败：${e.message}\n` +
          `（报告内容如下，请手动查看）\n${text}`
      );
    }
  }
  return delivered;
}

/** 删除一批消息，返回成功与失败数量 */
async function deleteEntries(entries) {
  let deleted = 0;
  let failed = 0;
  for (const entry of entries) {
    try {
      await entry.message.delete();
      deleted += 1;
    } catch {
      failed += 1;
    }
  }
  return { deleted, failed };
}

/** premium 成员：删消息 + 禁言，不封禁 */
async function enforcePremium(member, trigger, channelNames) {
  const { deleted, failed } = await deleteEntries(trigger.entries);

  let timeoutNote;
  try {
    await member.timeout(TIMEOUT_MS, `spam guard: ${trigger.kind}`);
    timeoutNote = `applied ${g.timeoutDays} day timeout`;
  } catch (e) {
    timeoutNote = `⚠️ timeout FAILED: ${e.message} — needs manual action`;
    console.error(`[守卫] 对 ${member.user.tag} 执行禁言失败：${e.message}`);
  }

  return [
    '⏳ **Premium member — not banned**',
    `Member: ${member.user.username} (${member.displayName || member.user.username}) · ID \`${member.id}\``,
    `Channel: ${channelNames.join(', ')}`,
    `Messages deleted: ${deleted} succeeded, ${failed} failed`,
    `Timeout: ${timeoutNote}`,
  ].join('\n');
}

/** 普通成员：先报告，再封禁，最后报告结果 */
async function enforceBan(client, member, trigger, channelNames) {
  const report = buildTriggerReport({ member, trigger, channelNames });
  await sendReport(client, report);

  let resultText;
  try {
    await member.ban({
      deleteMessageSeconds: g.banDeleteSeconds,
      reason: `spam guard: ${trigger.kind}`,
    });
    const hours = Math.round(g.banDeleteSeconds / 3600);
    resultText = [
      '🔨 **Ban result — SUCCESS**',
      `Member: ${member.user.username} (${member.displayName || member.user.username}) · ID \`${member.id}\``,
      `Reason: spam guard (${trigger.kind})`,
      `Also removed the last ${hours} hour(s) of their messages`,
    ].join('\n');
    console.log(`[守卫] 已封禁 ${member.user.tag}（${member.id}），原因：${trigger.kind}`);
  } catch (e) {
    resultText = [
      '🔨 **Ban result — ❌ FAILED (manual action needed)**',
      `Member: ${member.user.username} (${member.displayName || member.user.username}) · ID \`${member.id}\``,
      `Error: ${e.message}`,
      'The bot could not ban this member. Please check its role position and the "Ban Members" permission.',
    ].join('\n');
    console.error(`[守卫] 封禁 ${member.user.tag} 失败：${e.message}`);
  }

  await sendReport(client, resultText);
}

/**
 * 守卫入口：每条消息调用一次。
 * 内部已做完整的异常兜底，调用方不需要 try/catch，但**不要 await**（避免拖慢消息记录）。
 */
export async function handleGuardMessage(msg) {
  if (!g.enabled) return;
  if (!msg.inGuild?.()) return;
  if (msg.author?.bot) return;

  const channelId = watchedChannelId(msg);
  if (!channelId) return;

  const member = msg.member;
  if (isExemptMember(member, msg.guild)) return;

  const now = Date.now();
  sweepIfDue(now);

  const entry = {
    message: msg,
    channelId,
    channelName: msg.channel?.name ?? channelId,
    content: msg.content ?? '',
    chars: countChars(msg.content),
    at: now,
  };

  recordEntry(member.id, entry);

  const trigger = detectTrigger(windows.get(member.id) ?? [], now);
  if (!trigger) return;

  const cooldown = cooldownUntil.get(member.id) ?? 0;
  if (now < cooldown) {
    console.warn(
      `[守卫] ${member.user.tag}（${member.id}）在冷却期内再次触发，已忽略（剩余 ${Math.ceil((cooldown - now) / 1000)} 秒）`
    );
    windows.delete(member.id);
    return;
  }

  if (enforcing.has(member.id)) {
    console.warn(`[守卫] ${member.user.tag}（${member.id}）正在处置中，跳过重复触发`);
    return;
  }
  enforcing.add(member.id);

  const channelNames = [...new Set(trigger.entries.map((e) => `#${e.channelName}`))];
  console.log(
    `[守卫] 触发：${member.user.tag}（${member.id}）· 规则 ${trigger.kind} · ` +
      `${trigger.messageCount} 条 / ${trigger.totalChars} 字符 · 频道 ${channelNames.join(', ')}`
  );

  try {
    if (isPremiumMember(member)) {
      const text = await enforcePremium(member, trigger, channelNames);
      console.log(`[守卫] premium 处置完成：${member.user.tag}（${member.id}）`);
      await sendReport(msg.client, text);
    } else {
      await enforceBan(msg.client, member, trigger, channelNames);
    }
    cooldownUntil.set(member.id, Date.now() + g.cooldownMinutes * 60 * 1000);
  } catch (e) {
    // 处置本身出错也要进冷却，否则会不断重试、把报告人刷爆
    cooldownUntil.set(member.id, Date.now() + g.cooldownMinutes * 60 * 1000);
    console.error(`[守卫] 处置 ${member.user.tag}（${member.id}）时出错：${e.message}`);
  } finally {
    windows.delete(member.id);
    enforcing.delete(member.id);
  }
}

/** 仅供测试脚本使用：清空全部内存状态 */
export function resetGuardState() {
  windows.clear();
  enforcing.clear();
  cooldownUntil.clear();
  lastSweepAt = 0;
}
