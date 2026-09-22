import express from 'express';
import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
  ChannelType,
  MessageFlags,
} from 'discord.js';

import { config, printConfigSummary } from './config.js';

// Command UI text (descriptions, replies, errors) is ALWAYS English,
// per the original requirement that "all command explanations must be in English".
// Only the AI summary body follows SUMMARY_LANGUAGE (handled in summarize.js).
const isEnglish = true;
import {
  upsertMessages,
  getNewestMessageTime,
  getLastCheckTime,
  getMessagesBetween,
  saveCheckRecord,
  deleteMessagesOlderThan,
} from './db.js';
import { summarizeMessages, pingAI } from './summarize.js';
import { buildTranscript, countByAuthor, formatDateTime, humanDuration, splitMessage } from './format.js';

/* ============================================================
   Discord 客户端
   MessageContent 意图是必须的，否则读不到消息正文
   ============================================================ */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

/* 运行状态，供 /status / HTTP 健康检查使用 */
const state = {
  startedAt: Date.now(),
  lastMessageAt: null,
  savedCount: 0,
  lastError: null,
};

/* ============================================================
   工具函数
   ============================================================ */

/** 把 discord.js 的 Message 转成数据库行 */
function toRow(msg) {
  return {
    discord_message_id: msg.id,
    channel_id: msg.channelId,
    channel_name: msg.channel?.name ?? null,
    guild_id: msg.guildId ?? null,
    author_id: msg.author?.id ?? 'unknown',
    author_name: msg.author?.username ?? 'unknown',
    author_display_name: msg.member?.displayName ?? msg.author?.globalName ?? msg.author?.username ?? null,
    content: msg.content ?? '',
    attachments: [...(msg.attachments?.values?.() ?? [])].map((a) => ({
      url: a.url,
      name: a.name,
      contentType: a.contentType,
    })),
    reply_to_id: msg.reference?.messageId ?? null,
    created_at: (msg.createdAt ?? new Date()).toISOString(),
  };
}

/** 启动时补齐机器人离线期间错过的消息 */
async function backfillChannel(channelId) {
  let channel;
  try {
    channel = await client.channels.fetch(channelId);
  } catch (e) {
    console.warn(`[补齐] 无法访问频道 ${channelId}：${e.message}（请检查机器人是否已加入服务器并有查看权限）`);
    return;
  }
  if (!channel?.isTextBased?.()) {
    console.warn(`[补齐] 频道 ${channelId} 不是文字频道，已跳过`);
    return;
  }

  const newest = await getNewestMessageTime(channelId);
  const MAX_MESSAGES = 3000;
  let before;
  let scanned = 0;
  let saved = 0;
  let reachedKnown = false;

  while (!reachedKnown && scanned < MAX_MESSAGES) {
    const batch = await channel.messages.fetch({ limit: 100, before });
    if (batch.size === 0) break;

    const sorted = [...batch.values()].sort((a, b) => b.createdAt - a.createdAt); // 新 → 旧
    const rows = [];

    for (const m of sorted) {
      if (newest && m.createdAt <= newest) {
        reachedKnown = true;
        break;
      }
      scanned += 1;
      if (m.author?.bot) continue;
      rows.push(toRow(m));
    }

    if (rows.length) {
      try {
        await upsertMessages(rows);
        saved += rows.length;
      } catch (e) {
        console.error(`[补齐] 写入失败：${e.message}`);
      }
    }

    before = sorted[sorted.length - 1].id;
    if (batch.size < 100) break;
  }

  console.log(`[补齐] 频道 ${channelId} 完成：扫描 ${scanned} 条，新增 ${saved} 条`);
}

/* ============================================================
   命令定义
   ============================================================ */

/** 把所有命令注册到指定服务器（按服务器注册，秒级生效） */
async function registerCommandsForGuild(guildId) {
  try {
    const rest = new REST({ version: '10' }).setToken(config.discord.token);
    await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), {
      body: [
        buildCheckCommand().toJSON(),
        buildStatusCommand().toJSON(),
        buildLookupCommand().toJSON(),
        buildSearchCommand().toJSON(),
        buildRecentCommand().toJSON(),
      ],
    });
    console.log(
      `[命令注册] 已注册到服务器 ${guildId}：/${config.checkCommandName}, /status, /lookup, /search, /recent`
    );
  } catch (e) {
    console.error(`[命令注册] 服务器 ${guildId} 失败：${e.message}`);
  }
}

/** 启动时：通过被监控频道反查它所属的服务器，逐个注册 */
async function registerCommands() {
  const guildIds = new Set();
  for (const id of config.trackChannelIds) {
    try {
      const ch = await client.channels.fetch(id);
      if (ch?.guildId) guildIds.add(ch.guildId);
    } catch (e) {
      console.warn(`[命令注册] 无法解析频道 ${id}：${e.message}`);
    }
  }

  for (const guild of client.guilds.cache.values()) guildIds.add(guild.id);

  if (guildIds.size === 0) {
    console.warn('[命令注册] 没有解析到任何服务器，命令可能无法使用（机器人尚未加入服务器？）');
    return;
  }

  for (const guildId of guildIds) await registerCommandsForGuild(guildId);
}

/* ============================================================
   权限校验 + 投递工具
   ============================================================ */

function isAllowedUser(interaction) {
  if (config.allowedUserIds.length === 0) return true;
  return config.allowedUserIds.includes(interaction.user.id);
}

/** 权限校验 + deferReply，失败直接回复一条拒绝后返回 false */
async function guardAndDefer(interaction) {
  if (!isAllowedUser(interaction)) {
    console.warn(
      `[权限拦截] 未授权用户尝试使用 /${interaction.commandName}：` +
        `${interaction.user.username}（ID ${interaction.user.id}）`
    );
    const denyText = isEnglish
      ? '⛔ **You are not authorised to use this command.**\n' +
        'This command is restricted to specific users. If you believe this is a mistake, contact the server owner.'
      : '⛔ 你没有使用此命令的权限。\n此命令仅对指定用户开放。如果你认为这是误判，请联系服务器所有者。';
    await interaction.reply({ content: denyText, flags: MessageFlags.Ephemeral });
    return false;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  return true;
}

/** 通过 DM 投递；DMs 关闭则退回频道内 ephemeral 多段消息 */
async function deliverDmOrFallback(interaction, content) {
  try {
    const chunks = splitMessage(content);
    for (const c of chunks) {
      await interaction.user.send({ content: c });
    }
    const ack = isEnglish ? '✅ Summary sent to your DMs.' : '✅ 已通过私信发送。';
    await interaction.editReply({ content: ack, flags: MessageFlags.Ephemeral });
    return { via: 'dm' };
  } catch (e) {
    console.warn(
      `[DM 失败] ${interaction.user.username}（${interaction.user.id}）：${e.message} → 退回频道内私密回复`
    );
    const chunks = splitMessage(content);
    await interaction.editReply({ content: chunks[0], flags: MessageFlags.Ephemeral });
    for (const c of chunks.slice(1)) {
      await interaction.followUp({ content: c, flags: MessageFlags.Ephemeral });
    }
    return { via: 'channel-fallback' };
  }
}

/** 把频道 ID 解析成 "频道名" 字符串（fetch 失败就退回 ID） */
async function resolveChannelName(channelId) {
  try {
    const ch = await client.channels.fetch(channelId);
    return ch?.name ?? channelId;
  } catch {
    return channelId;
  }
}

/**
 * 在所有被监控频道里取一段时间的消息，平铺到一个数组。
 * `newestFirst=true` 时每个频道都取"最新"的 limit 条（而不是最早的）。
 * 返回值统一按时间正序（老 → 新）排列。
 */
async function fetchAllTracked(sinceIso, untilIso, perChannelLimit, newestFirst = false) {
  const out = [];
  for (const id of config.trackChannelIds) {
    try {
      const rows = await getMessagesBetween(id, sinceIso, untilIso, perChannelLimit, newestFirst);
      out.push(...rows);
    } catch (e) {
      console.warn(`[查询] 频道 ${id}：${e.message}`);
    }
  }
  // 跨频道合并后重新按时间排序，保证全局正序
  return out.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
}

/* ============================================================
   各命令的 SlashCommandBuilder
   ============================================================ */

function buildCheckCommand() {
  const c = new SlashCommandBuilder()
    .setName(config.checkCommandName)
    .addIntegerOption((o) =>
      o.setName('hours').setMinValue(1).setMaxValue(720)
    )
    .addIntegerOption((o) =>
      o.setName('limit').setMinValue(50).setMaxValue(10000)
    )
    .addBooleanOption((o) => o.setName('raw'))
    .addChannelOption((o) =>
      o.setName('channel').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
    );
  if (isEnglish) {
    c.setDescription('Summarise new messages in this channel since the last check');
    for (const o of c.options) {
      if (o.name === 'hours') o.setDescription('Optional: summarise the last N hours instead of since the last check');
      else if (o.name === 'limit') o.setDescription(`Optional: max messages to summarise (default ${config.maxSummaryMessages})`);
      else if (o.name === 'raw') o.setDescription('Optional: dump the raw message list without AI summary (debug)');
      else if (o.name === 'channel') o.setDescription('Optional: target channel (defaults to the current one)');
    }
  } else {
    c.setDescription('总结本频道自上次 check 以来的新消息');
    for (const o of c.options) {
      if (o.name === 'hours') o.setDescription('可选：改为总结最近 N 小时（默认从上次的 check 开始）');
      else if (o.name === 'limit') o.setDescription(`可选：最多总结多少条消息（默认 ${config.maxSummaryMessages}）`);
      else if (o.name === 'raw') o.setDescription('可选：只导出原始消息列表，不做 AI 总结（调试用）');
      else if (o.name === 'channel') o.setDescription('可选：指定要总结的频道（默认当前频道）');
    }
  }
  return c;
}

function buildStatusCommand() {
  const c = new SlashCommandBuilder().setName('status');
  if (isEnglish) c.setDescription('Show the bot running state, last error, and AI config');
  else c.setDescription('查看机器人运行状态（在线时长、消息数、最近错误、AI 配置）');
  return c;
}

function buildLookupCommand() {
  const c = new SlashCommandBuilder()
    .setName('lookup')
    .addUserOption((o) => o.setName('user').setRequired(true))
    .addIntegerOption((o) => o.setName('hours').setMinValue(1).setMaxValue(720))
    .addIntegerOption((o) => o.setName('limit').setMinValue(1).setMaxValue(500));
  if (isEnglish) {
    c.setDescription('Find every message from a specific member in the last N hours');
    for (const o of c.options) {
      if (o.name === 'user') o.setDescription('the member to look up');
      else if (o.name === 'hours') o.setDescription('how far back to look, in hours (default 24)');
      else if (o.name === 'limit') o.setDescription('max messages to return (default 50)');
    }
  } else {
    c.setDescription('查找某个成员最近 N 小时的所有发言');
    for (const o of c.options) {
      if (o.name === 'user') o.setDescription('要查询的成员');
      else if (o.name === 'hours') o.setDescription('查询最近多少小时（默认 24）');
      else if (o.name === 'limit') o.setDescription('最多返回多少条（默认 50）');
    }
  }
  return c;
}

function buildSearchCommand() {
  const c = new SlashCommandBuilder()
    .setName('search')
    .addStringOption((o) => o.setName('keyword').setRequired(true).setMinLength(1).setMaxLength(100))
    .addIntegerOption((o) => o.setName('hours').setMinValue(1).setMaxValue(720))
    .addIntegerOption((o) => o.setName('limit').setMinValue(1).setMaxValue(200));
  if (isEnglish) {
    c.setDescription('Search recent messages by keyword (content + usernames)');
    for (const o of c.options) {
      if (o.name === 'keyword') o.setDescription('keyword to search (case-insensitive)');
      else if (o.name === 'hours') o.setDescription('how far back to look, in hours (default 24)');
      else if (o.name === 'limit') o.setDescription('max matches to return (default 50)');
    }
  } else {
    c.setDescription('按关键词搜索最近 N 小时的消息（内容 + 用户名）');
    for (const o of c.options) {
      if (o.name === 'keyword') o.setDescription('要搜索的关键词（不区分大小写）');
      else if (o.name === 'hours') o.setDescription('搜索最近多少小时（默认 24）');
      else if (o.name === 'limit') o.setDescription('最多返回多少条（默认 50）');
    }
  }
  return c;
}

function buildRecentCommand() {
  const c = new SlashCommandBuilder()
    .setName('recent')
    .addIntegerOption((o) => o.setName('hours').setMinValue(1).setMaxValue(720))
    .addIntegerOption((o) => o.setName('limit').setMinValue(1).setMaxValue(500));
  if (isEnglish) {
    c.setDescription('Show the most recent raw messages (no AI summary)');
    for (const o of c.options) {
      if (o.name === 'hours') o.setDescription('how far back to look, in hours (default 6)');
      else if (o.name === 'limit') o.setDescription('max messages to return (default 30)');
    }
  } else {
    c.setDescription('查看最近 N 条原始消息（不做 AI 总结）');
    for (const o of c.options) {
      if (o.name === 'hours') o.setDescription('查看最近多少小时（默认 6）');
      else if (o.name === 'limit') o.setDescription('最多返回多少条（默认 30）');
    }
  }
  return c;
}

/* ============================================================
   /check 主逻辑
   ============================================================ */
async function handleCheck(interaction) {
  if (!(await guardAndDefer(interaction))) return;

  // 1. 决定要总结哪个频道
  const picked = interaction.options.getChannel('channel');
  let channelId = picked?.id ?? interaction.channelId;

  if (!config.trackChannelIds.includes(channelId)) {
    if (picked) {
      // 用户明确指定了一个未被监控的频道 → 直接告知，不做静默替换
      const text = isEnglish
        ? `❌ Channel <#${picked.id}> is not in the tracked list.\n` +
          `Currently tracked: ${config.trackChannelIds.map((id) => `<#${id}>`).join(', ')}\n` +
          'To track a new channel, add its ID to `TRACK_CHANNEL_IDS` and give the bot access to it.'
        : `❌ 频道 <#${picked.id}> 不在监控列表中。\n` +
          `当前监控：${config.trackChannelIds.map((id) => `<#${id}>`).join('、')}\n` +
          '要监控新频道，请把它的 ID 加入 `TRACK_CHANNEL_IDS`，并给机器人开通该频道权限。';
      await interaction.editReply({ content: text });
      return;
    }
    if (config.trackChannelIds.length === 1) {
      // 没指定频道（例如在别的频道输入 /check）→ 自动回退到唯一的监控频道
      channelId = config.trackChannelIds[0];
    } else {
      const text = isEnglish
        ? `❌ Channel <#${channelId}> is not in the tracked list.\n` +
          `Currently tracked: ${config.trackChannelIds.map((id) => `<#${id}>`).join(', ')}\n` +
          'Use the `channel` option to pick one, or add that channel to the tracked list.'
        : `❌ 频道 <#${channelId}> 不在监控列表中。\n` +
          `当前监控：${config.trackChannelIds.map((id) => `<#${id}>`).join('、')}\n` +
          '请用 `channel` 参数指定，或把该频道加入监控列表。';
      await interaction.editReply({ content: text });
      return;
    }
  }

  const channelName = await resolveChannelName(channelId);

  // 2. 计算时间区间
  const until = new Date();
  const hours = interaction.options.getInteger('hours');
  const limit = interaction.options.getInteger('limit') ?? config.maxSummaryMessages;
  const rawMode = interaction.options.getBoolean('raw') ?? false;

  let since;
  let sinceSource;
  if (hours) {
    since = new Date(until.getTime() - hours * 3600 * 1000);
    sinceSource = isEnglish ? `last ${hours} hour(s)` : `最近 ${hours} 小时`;
  } else {
    const last = await getLastCheckTime(channelId);
    if (last) {
      since = last;
      sinceSource = isEnglish ? 'since the last check' : '上次 check 之后';
    } else {
      since = new Date(until.getTime() - 24 * 3600 * 1000);
      sinceSource = isEnglish ? 'first run, defaulted to the last 24 hours' : '首次使用，默认最近 24 小时';
    }
  }

  // 3. 取消息（优先取"最近"的 limit 条：消息量过大时保住最新内容）
  const messages = await getMessagesBetween(channelId, since.toISOString(), until.toISOString(), limit, true);
  const truncated = messages.length >= limit;
  const truncNote = truncated
    ? isEnglish
      ? `\n> ⚠️ Message count hit the ${limit} cap — only the most recent ${limit} messages were analysed.`
      : `\n> ⚠️ 消息数达到上限 ${limit} 条，仅分析了最近 ${limit} 条。`
    : '';

  if (messages.length === 0) {
    await deliverDmOrFallback(
      interaction,
      isEnglish
        ? `📭 No new messages in **#${channelName}** after ${formatDateTime(since)} (${sinceSource}).`
        : `📭 **#${channelName}** 在 ${formatDateTime(since)} 之后没有新消息（${sinceSource}）。`
    );
    return;
  }

  const authors = countByAuthor(messages);
  const rangeText = `${formatDateTime(since)} → ${formatDateTime(until)}`;
  const durationText = humanDuration(until.getTime() - since.getTime());

  // 4a. 调试模式：只发原始列表（DM 给用户）
  if (rawMode) {
    const text = isEnglish
      ? `📋 **#${channelName} · raw messages**\nRange: ${rangeText} (${durationText})\n${messages.length} messages · ${authors.length} participants\n${truncNote}\n` +
        buildTranscript(messages)
      : `📋 **#${channelName} · 原始消息**\n区间：${rangeText}（${durationText}）\n共 ${messages.length} 条 · ${authors.length} 人发言\n${truncNote}\n` +
        buildTranscript(messages);
    await deliverDmOrFallback(interaction, text);
    return;
  }

  // 4b. 正常模式：调 AI 总结
  let aiText;
  try {
    aiText = await summarizeMessages({ channelName, messages, since, until });
  } catch (e) {
    state.lastError = `${new Date().toISOString()} ${e.message}`;
    console.error('[summarize] 失败：', e);
    const fallbackText = isEnglish
      ? `⚠️ **AI summary failed**: ${e.message}\n\nBelow is the raw log (you can reproduce with \`/${config.checkCommandName} raw:True\`):\n\n` +
        buildTranscript(messages)
      : `⚠️ **AI 总结失败**：${e.message}\n\n下面是原始消息（可用 \`/${config.checkCommandName} raw:True\` 复现）：\n\n` +
        buildTranscript(messages);
    await deliverDmOrFallback(interaction, fallbackText);
    return;
  }

  const summaryText = isEnglish
    ? `📋 **#${channelName} · summary**\n` +
      `**Range**: ${rangeText} (${durationText})\n` +
      `**Messages**: ${messages.length} · **Participants**: ${authors.length}\n` +
      `**Top posters**: ${authors.slice(0, 10).map(([n, c]) => `${n}(${c})`).join(', ')}\n` +
      `**Window**: ${sinceSource}\n` +
      `${truncNote}\n` +
      `────────────────────\n\n` +
      aiText
    : `📋 **#${channelName} · 消息总结**\n` +
      `**统计区间**：${rangeText}（${durationText}）\n` +
      `**消息总数**：${messages.length} 条 · **参与成员**：${authors.length} 人\n` +
      `**发言排行**：${authors.slice(0, 10).map(([n, c]) => `${n}(${c})`).join('、')}\n` +
      `**数据来源**：${sinceSource}\n` +
      `${truncNote}\n` +
      `────────────────────\n\n` +
      aiText;
  const result = await deliverDmOrFallback(interaction, summaryText);

  await saveCheckRecord({
    channel_id: channelId,
    period_start: since.toISOString(),
    period_end: until.toISOString(),
    message_count: messages.length,
    summary: aiText,
    requested_by_id: interaction.user.id,
    requested_by_name: interaction.user.username,
  });

  console.log(
    `[check] ${interaction.user.username} 在 #${channelName} 触发总结：${messages.length} 条消息，投递方式=${result.via}`
  );
}

/* ============================================================
   /status：机器人运行状态
   ============================================================ */
async function handleStatus(interaction) {
  if (!(await guardAndDefer(interaction))) return;

  const uptime = humanDuration(process.uptime() * 1000);
  const lastMsg = state.lastMessageAt ? formatDateTime(state.lastMessageAt) : (isEnglish ? '(none)' : '（无）');
  const lastErr = state.lastError ?? (isEnglish ? '(none)' : '（无）');
  const channelsText = config.trackChannelIds.map((id) => `<#${id}>`).join(isEnglish ? ', ' : '、');

  const text = isEnglish
    ? `📊 **Bot status**\n` +
      `**Uptime**: ${uptime}\n` +
      `**Messages saved this run**: ${state.savedCount}\n` +
      `**Last message at**: ${lastMsg}\n` +
      `**Last error**: ${lastErr}\n` +
      `**AI**: ${config.ai.baseUrl} / ${config.ai.model}\n` +
      `**Tracked channels**: ${channelsText}\n` +
      `**Output language**: ${config.summaryLanguage}\n` +
      `**Authorised users**: ${config.allowedUserIds.join(', ') || '(none — everyone allowed!)'}`
    : `📊 **运行状态**\n` +
      `**在线时长**：${uptime}\n` +
      `**本次保存消息**：${state.savedCount} 条\n` +
      `**最后一条消息**：${lastMsg}\n` +
      `**最后一次错误**：${lastErr}\n` +
      `**AI**：${config.ai.baseUrl} / ${config.ai.model}\n` +
      `**监控频道**：${channelsText}\n` +
      `**输出语言**：${config.summaryLanguage}\n` +
      `**授权用户**：${config.allowedUserIds.join(', ') || '（无——任何人都能用！）'}`;

  await deliverDmOrFallback(interaction, text);
}

/* ============================================================
   /lookup <user> [hours] [limit]
   ============================================================ */
async function handleLookup(interaction) {
  if (!(await guardAndDefer(interaction))) return;

  const user = interaction.options.getUser('user');
  const hours = interaction.options.getInteger('hours') ?? 24;
  const limit = interaction.options.getInteger('limit') ?? 50;

  const until = new Date();
  const since = new Date(until.getTime() - hours * 3600 * 1000);
  const rangeText = `${formatDateTime(since)} → ${formatDateTime(until)}`;
  const durText = humanDuration(hours * 3600 * 1000);

  // 在所有监控频道里查最近的消息，再筛出该成员；取"最新"的 limit 条
  const scan = Math.min(Math.max(limit * 20, 500), 5000);
  const rows = await fetchAllTracked(since.toISOString(), until.toISOString(), scan, true);
  const allFromUser = rows.filter((m) => m.author_id === user.id);
  const matched = allFromUser.slice(-limit); // rows 正序，末尾即最新
  const hiddenCount = allFromUser.length - matched.length;

  if (matched.length === 0) {
    await deliverDmOrFallback(
      interaction,
      isEnglish
        ? `🔍 No messages from **${user.username}** in the last ${hours}h across tracked channels.`
        : `🔍 **${user.username}** 在最近 ${hours} 小时内的监控频道里没有发言。`
    );
    return;
  }

  // 频道名字（第一条所在频道就行）
  const firstChannelId = matched[0].channel_id;
  const channelName = matched[0].channel_name || (await resolveChannelName(firstChannelId));
  const moreNote = hiddenCount > 0
    ? isEnglish
      ? `\n_(+${hiddenCount} earlier messages omitted; showing the most recent ${matched.length})_`
      : `\n_（另有 ${hiddenCount} 条更早的消息未显示，这里只列最近的 ${matched.length} 条）_`
    : '';

  const text = isEnglish
    ? `🔍 **#${channelName} · messages by ${user.username}**\nRange: ${rangeText} (${durText})\n${matched.length} messages${moreNote}\n\n` +
      buildTranscript(matched)
    : `🔍 **#${channelName} · ${user.username} 的发言**\n区间：${rangeText}（${durText}）\n共 ${matched.length} 条${moreNote}\n\n` +
      buildTranscript(matched);
  await deliverDmOrFallback(interaction, text);
}

/* ============================================================
   /search <keyword> [hours] [limit]
   ============================================================ */
async function handleSearch(interaction) {
  if (!(await guardAndDefer(interaction))) return;

  const keyword = interaction.options.getString('keyword');
  const hours = interaction.options.getInteger('hours') ?? 24;
  const limit = interaction.options.getInteger('limit') ?? 50;

  const until = new Date();
  const since = new Date(until.getTime() - hours * 3600 * 1000);
  const rangeText = `${formatDateTime(since)} → ${formatDateTime(until)}`;
  const durText = humanDuration(hours * 3600 * 1000);

  const scan = Math.min(Math.max(limit * 20, 500), 5000);
  const rows = await fetchAllTracked(since.toISOString(), until.toISOString(), scan, true);
  const lcKw = keyword.toLowerCase();
  const allMatched = rows.filter(
    (m) =>
      (m.content ?? '').toLowerCase().includes(lcKw) ||
      (m.author_name ?? '').toLowerCase().includes(lcKw) ||
      (m.author_display_name ?? '').toLowerCase().includes(lcKw)
  );
  const matched = allMatched.slice(-limit); // 正序，末尾即最新
  const hiddenCount = allMatched.length - matched.length;

  if (matched.length === 0) {
    await deliverDmOrFallback(
      interaction,
      isEnglish
        ? `🔍 No matches for "${keyword}" in the last ${hours}h.`
        : `🔍 在最近 ${hours} 小时内没找到包含「${keyword}」的消息。`
    );
    return;
  }

  const firstChannelId = matched[0].channel_id;
  const channelName = matched[0].channel_name || (await resolveChannelName(firstChannelId));
  const moreNote = hiddenCount > 0
    ? isEnglish
      ? `\n_(+${hiddenCount} earlier matches omitted; showing the most recent ${matched.length})_`
      : `\n_（另有 ${hiddenCount} 条更早的匹配未显示，这里只列最近的 ${matched.length} 条）_`
    : '';

  const text = isEnglish
    ? `🔍 **#${channelName} · search "${keyword}"**\nRange: ${rangeText} (${durText})\n${matched.length} matches${moreNote}\n\n` +
      buildTranscript(matched)
    : `🔍 **#${channelName} · 搜索 "${keyword}"**\n区间：${rangeText}（${durText}）\n匹配 ${matched.length} 条${moreNote}\n\n` +
      buildTranscript(matched);
  await deliverDmOrFallback(interaction, text);
}

/* ============================================================
   /recent [hours] [limit]
   ============================================================ */
async function handleRecent(interaction) {
  if (!(await guardAndDefer(interaction))) return;

  const hours = interaction.options.getInteger('hours') ?? 6;
  const limit = interaction.options.getInteger('limit') ?? 30;

  const until = new Date();
  const since = new Date(until.getTime() - hours * 3600 * 1000);
  const rangeText = `${formatDateTime(since)} → ${formatDateTime(until)}`;
  const durText = humanDuration(hours * 3600 * 1000);

  // 取"最新"的 limit 条（返回值已按时间正序排列）
  const rows = await fetchAllTracked(since.toISOString(), until.toISOString(), limit, true);

  if (rows.length === 0) {
    await deliverDmOrFallback(
      interaction,
      isEnglish
        ? `🔍 No messages in tracked channels in the last ${hours}h.`
        : `🔍 监控频道在最近 ${hours} 小时内没有消息。`
    );
    return;
  }

  const sliced = rows;
  const channelName = sliced[sliced.length - 1].channel_name || (await resolveChannelName(sliced[sliced.length - 1].channel_id));

  const text = isEnglish
    ? `📜 **#${channelName} · recent messages**\nRange: ${rangeText} (${durText})\n${sliced.length} messages\n\n` +
      buildTranscript(sliced)
    : `📜 **#${channelName} · 最近消息**\n区间：${rangeText}（${durText}）\n共 ${sliced.length} 条\n\n` +
      buildTranscript(sliced);
  await deliverDmOrFallback(interaction, text);
}

/* ============================================================
   事件绑定
   ============================================================ */

client.on(Events.MessageCreate, async (msg) => {
  try {
    if (msg.author?.bot) return;
    if (!config.trackChannelIds.includes(msg.channelId)) return;
    await upsertMessages([toRow(msg)]);
    state.savedCount += 1;
    state.lastMessageAt = new Date().toISOString();
  } catch (e) {
    state.lastError = `${new Date().toISOString()} ${e.message}`;
    console.error('[messageCreate] 保存失败：', e.message);
  }
});

const COMMAND_HANDLERS = {
  [config.checkCommandName]: handleCheck,
  status: handleStatus,
  lookup: handleLookup,
  search: handleSearch,
  recent: handleRecent,
};

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const handler = COMMAND_HANDLERS[interaction.commandName];
  if (!handler) return;

  try {
    await handler(interaction);
  } catch (e) {
    state.lastError = `${new Date().toISOString()} ${e.message}`;
    console.error('[interactionCreate] 处理失败：', e);
    const text = isEnglish ? `❌ Command failed: ${e.message}` : `❌ 执行出错：${e.message}`;
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: text });
      } else {
        await interaction.reply({ content: text, flags: MessageFlags.Ephemeral });
      }
    } catch {
      /* 忽略二次失败 */
    }
  }
});

/* 机器人被重新邀请进服务器时：自动注册全部命令并补齐历史消息 */
client.on(Events.GuildCreate, async (guild) => {
  console.log(`[机器人] 加入服务器：${guild.name}（${guild.id}）`);
  await registerCommandsForGuild(guild.id);
  for (const id of config.trackChannelIds) {
    try {
      await backfillChannel(id);
    } catch (e) {
      console.error(`[补齐] 频道 ${id} 出错：${e.message}`);
    }
  }
});

client.once(Events.ClientReady, async () => {
  console.log(`[机器人] 登录成功：${client.user.tag}`);
  state.ready = true;

  await registerCommands();

  for (const id of config.trackChannelIds) {
    try {
      await backfillChannel(id);
    } catch (e) {
      console.error(`[补齐] 频道 ${id} 出错：${e.message}`);
    }
  }

  if (config.retentionDays > 0) {
    try {
      const removed = await deleteMessagesOlderThan(config.retentionDays);
      console.log(`[清理] 已删除超过 ${config.retentionDays} 天的旧消息（约 ${removed} 条）`);
    } catch (e) {
      console.error(`[清理] 失败：${e.message}`);
    }
  }

  const ai = await pingAI();
  console.log(ai.ok ? '[自检] AI 接口连通正常' : `[自检] AI 接口异常：${ai.message}`);
});

client.on(Events.Error, (e) => {
  console.error('[Discord 错误]', e.message);
});

client.rest.on('rateLimited', (info) => {
  console.warn(`[限流] 路由 ${info.route} 需要等待 ${info.timeToReset}ms`);
});

/* ============================================================
   HTTP 服务（Render 需要一个端口才能当 Web Service 跑）
   /health → 保持唤醒（给 UptimeRobot / Better Stack 定时请求）
   /status → 详细的运行状态（可选监控）
   ============================================================ */
const app = express();

app.get('/', (_req, res) => {
  res.status(200).send('discord-mod-tracker is running');
});

app.get('/health', (_req, res) => {
  res.status(200).json({ ok: true, uptimeSeconds: Math.floor(process.uptime()) });
});

app.get('/status', (_req, res) => {
  const payload = {
    ok: Boolean(client.isReady()),
    botTag: client.user?.tag ?? null,
    ready: client.isReady(),
    startedAt: new Date(state.startedAt).toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    trackedChannels: config.trackChannelIds,
    messagesSavedThisRun: state.savedCount,
    lastMessageAt: state.lastMessageAt,
    lastError: state.lastError,
    ai: { baseUrl: config.ai.baseUrl, model: config.ai.model },
  };
  res.status(client.isReady() ? 200 : 503).json(payload);
});

app.listen(config.port, '0.0.0.0', () => {
  console.log(`[HTTP] 监听端口 ${config.port}（/health 用于保活，/status 用于监控）`);
});

/* ============================================================
   启动
   ============================================================ */
printConfigSummary();

process.on('unhandledRejection', (reason) => {
  console.error('[未处理的 Promise 拒绝]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[未捕获异常]', err);
});

client.login(config.discord.token).catch((e) => {
  console.error('❌ Discord 登录失败：', e.message);
  console.error('   常见原因：Token 填错 / Token 已被重置 / 网络无法访问 discord.com');
});