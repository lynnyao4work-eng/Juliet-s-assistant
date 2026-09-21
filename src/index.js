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

/* 运行状态，供 /status 健康检查使用 */
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

/** 注册斜杠命令到命令所在的所有服务器（按服务器注册，秒级生效） */
async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(config.discord.token);

  const command = new SlashCommandBuilder()
    .setName(config.checkCommandName)
    .setDescription('总结本频道自上次 check 以来的新消息')
    .addIntegerOption((o) =>
      o
        .setName('hours')
        .setDescription('可选：改为总结最近 N 小时的消息（默认从上次 check 之后开始）')
        .setMinValue(1)
        .setMaxValue(720)
    )
    .addIntegerOption((o) =>
      o
        .setName('limit')
        .setDescription(`可选：最多总结多少条消息（默认 ${config.maxSummaryMessages}）`)
        .setMinValue(50)
        .setMaxValue(10000)
    )
    .addBooleanOption((o) =>
      o.setName('raw').setDescription('可选：只导出原始消息列表，不做 AI 总结（调试用）')
    )
    .addChannelOption((o) =>
      o
        .setName('channel')
        .setDescription('可选：指定要总结的频道（默认当前频道）')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
    );

  const body = [command.toJSON()];

  // 通过被监控频道反查它所属的服务器
  const guildIds = new Set();
  for (const id of config.trackChannelIds) {
    try {
      const ch = await client.channels.fetch(id);
      if (ch?.guildId) guildIds.add(ch.guildId);
    } catch (e) {
      console.warn(`[命令注册] 无法解析频道 ${id}：${e.message}`);
    }
  }

  if (guildIds.size === 0) {
    console.warn('[命令注册] 没有解析到任何服务器，/check 可能无法使用');
    return;
  }

  for (const guildId of guildIds) {
    try {
      await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), { body });
      console.log(`[命令注册] /${config.checkCommandName} 已注册到服务器 ${guildId}`);
    } catch (e) {
      console.error(`[命令注册] 服务器 ${guildId} 失败：${e.message}`);
    }
  }
}

/* ============================================================
   /check 主逻辑
   ============================================================ */
async function handleCheck(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // 1. 决定要总结哪个频道
  const picked = interaction.options.getChannel('channel');
  let channelId = picked?.id ?? interaction.channelId;

  if (!config.trackChannelIds.includes(channelId)) {
    if (config.trackChannelIds.length === 1) {
      channelId = config.trackChannelIds[0];
    } else {
      await interaction.editReply({
        content:
          `❌ 频道 <#${channelId}> 不在监控列表中。\n` +
          `当前监控：${config.trackChannelIds.map((id) => `<#${id}>`).join('、')}\n` +
          `请用 \`channel\` 参数指定，或把该频道加入监控列表。`,
      });
      return;
    }
  }

  const channel = await client.channels.fetch(channelId).catch(() => null);
  const channelName = channel?.name ?? channelId;

  // 2. 计算时间区间
  const until = new Date();
  const hours = interaction.options.getInteger('hours');
  const limit = interaction.options.getInteger('limit') ?? config.maxSummaryMessages;
  const rawMode = interaction.options.getBoolean('raw') ?? false;

  let since;
  let sinceSource;
  if (hours) {
    since = new Date(until.getTime() - hours * 3600 * 1000);
    sinceSource = `最近 ${hours} 小时`;
  } else {
    const last = await getLastCheckTime(channelId);
    if (last) {
      since = last;
      sinceSource = '上次 check 之后';
    } else {
      since = new Date(until.getTime() - 24 * 3600 * 1000);
      sinceSource = '首次使用，默认最近 24 小时';
    }
  }

  // 3. 取消息
  const messages = await getMessagesBetween(channelId, since.toISOString(), until.toISOString(), limit);

  if (messages.length === 0) {
    await interaction.editReply({
      content: `📭 **#${channelName}** 在 ${formatDateTime(since)} 之后没有新消息（${sinceSource}）。`,
    });
    return;
  }

  const authors = countByAuthor(messages);
  const rangeText = `${formatDateTime(since)} → ${formatDateTime(until)}`;
  const durationText = humanDuration(until.getTime() - since.getTime());

  // 4a. 调试模式：只要原始列表
  if (rawMode) {
    const header =
      `📋 **#${channelName} · 原始消息**\n` +
      `区间：${rangeText}（${durationText}）\n` +
      `共 ${messages.length} 条 · ${authors.length} 人发言\n\n`;
    const chunks = splitMessage(header + buildTranscript(messages));
    await interaction.editReply({ content: chunks[0] });
    for (const c of chunks.slice(1)) {
      await interaction.followUp({ content: c, flags: MessageFlags.Ephemeral });
    }
    return;
  }

  // 4b. 正常模式：调 AI 总结
  let aiText;
  try {
    aiText = await summarizeMessages({ channelName, messages, since, until });
  } catch (e) {
    state.lastError = `${new Date().toISOString()} ${e.message}`;
    console.error('[summarize] 失败：', e);
    await interaction.editReply({
      content:
        `⚠️ **AI 总结失败**：${e.message}\n\n` +
        `下面是原始消息（可用 \`/check raw:True\` 复现此效果）：\n\n` +
        splitMessage(buildTranscript(messages), 1700)[0],
    });
    return;
  }

  const header =
    `📋 **#${channelName} · 消息总结**\n` +
    `**统计区间**：${rangeText}（${durationText}）\n` +
    `**消息总数**：${messages.length} 条 · **参与成员**：${authors.length} 人\n` +
    `**发言排行**：${authors.slice(0, 10).map(([n, c]) => `${n}(${c})`).join('、')}\n` +
    `**数据来源**：${sinceSource}\n` +
    `────────────────────\n\n`;

  const chunks = splitMessage(header + aiText);
  await interaction.editReply({ content: chunks[0] });
  for (const c of chunks.slice(1)) {
    await interaction.followUp({ content: c, flags: MessageFlags.Ephemeral });
  }

  // 5. 记录本次 check，作为下次的起点
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
    `[check] ${interaction.user.username} 在 #${channelName} 触发总结：${messages.length} 条消息，${chunks.length} 段输出`
  );
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

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== config.checkCommandName) return;

  try {
    await handleCheck(interaction);
  } catch (e) {
    state.lastError = `${new Date().toISOString()} ${e.message}`;
    console.error('[interactionCreate] 处理失败：', e);
    const text = `❌ 执行出错：${e.message}`;
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

  // AI 连通性自检（失败也不影响启动）
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
