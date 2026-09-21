/**
 * 自检脚本：不启动完整机器人，只逐项验证各个配置能不能用。
 *
 * 用法：npm run selftest
 *
 * 它会依次检查：配置 → Supabase 连库/建表/读写 → AI 接口 → Discord 登录与频道权限
 */
import { config } from '../src/config.js';
import { supabase } from '../src/db.js';
import { pingAI } from '../src/summarize.js';
import { Client, GatewayIntentBits, Partials, Events } from 'discord.js';

const results = [];

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  const icon = ok === true ? '✅' : ok === false ? '❌' : '⚠️';
  console.log(`${icon} ${name}${detail ? `\n   ${detail}` : ''}`);
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms)),
  ]);
}

console.log('\n===== Discord Mod Tracker 自检 =====\n');

/* ---------- 1. 配置 ---------- */
console.log('【1/4】检查环境变量');
try {
  record(
    '环境变量加载',
    true,
    `监控频道 ${config.trackChannelIds.join(', ')} · 模型 ${config.ai.model} · 时区 ${config.timezone}`
  );
} catch (e) {
  record('环境变量加载', false, e.message);
  process.exit(1);
}

/* ---------- 2. Supabase ---------- */
console.log('\n【2/4】检查 Supabase');
try {
  const { error: readError } = await withTimeout(
    supabase.from('messages').select('id').limit(1),
    15000,
    'Supabase 读请求'
  );

  if (readError) {
    if (/does not exist|Could not find the table|relation/i.test(readError.message)) {
      record(
        'messages 表是否存在',
        false,
        '表还没建。请打开 Supabase → SQL Editor，粘贴 supabase/schema.sql 的全部内容并 Run。'
      );
    } else {
      record('Supabase 连接', false, `错误信息：${readError.message}`);
    }
  } else {
    record('Supabase 连接 + messages 表', true, '读取正常');
  }

  const { error: checkError } = await withTimeout(
    supabase.from('check_records').select('id').limit(1),
    15000,
    'Supabase 读请求'
  );
  if (checkError && /does not exist|Could not find the table|relation/i.test(checkError.message)) {
    record('check_records 表是否存在', false, '表还没建。请执行 supabase/schema.sql。');
  } else if (checkError) {
    record('check_records 表', false, checkError.message);
  } else {
    record('check_records 表', true, '读取正常');
  }

  // 写入 + 删除测试
  if (!readError && !checkError) {
    const marker = `__selftest_${Date.now()}__`;
    const { error: writeError } = await withTimeout(
      supabase.from('messages').insert({
        discord_message_id: marker,
        channel_id: 'selftest',
        author_id: 'selftest',
        author_name: 'selftest',
        content: 'selftest row, safe to delete',
        created_at: new Date().toISOString(),
      }),
      15000,
      'Supabase 写请求'
    );
    if (writeError) {
      record('写入权限（service_role）', false, writeError.message);
    } else {
      const { error: delError } = await supabase.from('messages').delete().eq('discord_message_id', marker);
      record('写入权限（service_role）', !delError, delError ? `删除测试数据失败：${delError.message}` : '写入并清理成功');
    }
  }
} catch (e) {
  record('Supabase 连接', false, e.message);
}

/* ---------- 3. AI ---------- */
console.log('\n【3/4】检查 AI 接口');
try {
  const started = Date.now();
  const ai = await withTimeout(pingAI(), 60000, 'AI 请求');
  record(
    ai.ok ? 'AI 接口连通' : 'AI 接口',
    ai.ok,
    ai.ok
      ? `${config.ai.baseUrl} · ${config.ai.model} · 耗时 ${Date.now() - started}ms`
      : `${ai.message}\n   请检查 AI_API_KEY 是否正确、账户是否有余额、AI_BASE_URL 是否可访问。`
  );
} catch (e) {
  record('AI 接口', false, e.message);
}

/* ---------- 4. Discord ---------- */
console.log('\n【4/4】检查 Discord 登录与权限');
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel],
});

try {
  await withTimeout(client.login(config.discord.token), 30000, 'Discord 登录');
  await withTimeout(
    new Promise((resolve) => (client.isReady() ? resolve() : client.once(Events.ClientReady, resolve))),
    30000,
    'Discord 就绪'
  );
  record('Discord 登录', true, `已登录为 ${client.user.tag}（${client.user.id}）`);

  const guilds = [...client.guilds.cache.values()];
  if (guilds.length === 0) {
    record(
      '机器人已加入服务器',
      false,
      '机器人还没有加入任何服务器。请用 README 第三步里的邀请链接把它邀请进去。'
    );
  } else {
    record('机器人已加入服务器', true, guilds.map((g) => `${g.name}（${g.id}）`).join('、'));
  }

  for (const channelId of config.trackChannelIds) {
    try {
      const ch = await withTimeout(client.channels.fetch(channelId), 15000, '获取频道');
      if (!ch) {
        record(`监控频道 ${channelId}`, false, '找不到该频道，ID 可能填错了');
      } else {
        record(
          `监控频道 #${ch.name}`,
          true,
          `类型 ${ch.type} · 所属服务器 ${ch.guild?.name ?? ch.guildId}`
        );

        // 试着读一条历史消息，验证「读取消息历史」权限
        if (ch.isTextBased?.()) {
          const batch = await withTimeout(ch.messages.fetch({ limit: 1 }), 15000, '读取历史消息');
          record(
            `#${ch.name} 读取消息历史`,
            true,
            batch.size > 0 ? '可以读到历史消息 ✅' : '频道内暂无消息（权限看起来正常）'
          );
        }
      }
    } catch (e) {
      record(`监控频道 ${channelId}`, false, `无法访问：${e.message}\n   请确认机器人已加入该服务器，且在该频道有查看权限。`);
    }
  }
} catch (e) {
  record('Discord 登录', false, `${e.message}\n   常见原因：Token 填错 / Token 已被重置 / 网络无法访问 discord.com`);
} finally {
  try {
    client.destroy();
  } catch {
    /* ignore */
  }
}

/* ---------- 汇总 ---------- */
const failed = results.filter((r) => r.ok === false);
console.log('\n===== 自检结果 =====');
console.log(`通过 ${results.filter((r) => r.ok === true).length} 项，失败 ${failed.length} 项。`);
if (failed.length) {
  console.log('\n需要处理：');
  for (const f of failed) console.log(`  ❌ ${f.name} —— ${f.detail}`);
}
console.log('');

process.exit(failed.length ? 1 : 0);
