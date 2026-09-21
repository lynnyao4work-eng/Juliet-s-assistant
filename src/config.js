import 'dotenv/config';

/** 读取必填环境变量，缺失就立刻报错（比运行到一半才崩要好） */
function req(name) {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(
      `[配置错误] 缺少必需的环境变量 ${name}。请检查 .env 文件（本地）或 Render 的 Environment 设置（线上）。`
    );
  }
  return v.trim();
}

/** 读取选填环境变量 */
function opt(name, fallback = '') {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : fallback;
}

/** 读取逗号分隔的列表 */
function list(name) {
  return opt(name)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 读取整数 */
function int(name, fallback) {
  const raw = opt(name);
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  // Render 会自动注入 PORT，本地默认 3000
  port: int('PORT', 3000),

  discord: {
    token: req('DISCORD_TOKEN'),
    clientId: opt('DISCORD_CLIENT_ID'),
  },

  ai: {
    apiKey: req('AI_API_KEY'),
    // DeepSeek 官方地址；OpenAI 兼容接口都可以直接换这里
    baseUrl: opt('AI_BASE_URL', 'https://api.deepseek.com'),
    model: opt('AI_MODEL', 'deepseek-chat'),
    maxTokens: int('AI_MAX_TOKENS', 4000),
    temperature: Number.parseFloat(opt('AI_TEMPERATURE', '0.3')),
    // 单次请求喂给模型的字符上限，超过就自动分段总结（map-reduce）
    chunkChars: int('AI_CHUNK_CHARS', 24000),
  },

  supabase: {
    // 用户常常会把 /rest/v1/ 也复制进来，这里自动去掉
    url: req('SUPABASE_URL').replace(/\/+$/, '').replace(/\/rest\/v1$/, ''),
    serviceKey: req('SUPABASE_SERVICE_KEY'),
  },

  // 要监控的频道 ID 列表
  trackChannelIds: list('TRACK_CHANNEL_IDS'),
  // 需要重点关注的成员（可选，留空则只做整体总结）
  watchMembers: list('WATCH_MEMBERS'),
  // 触发总结的命令名
  checkCommandName: opt('CHECK_COMMAND_NAME', 'check'),
  // 只有这些 Discord 用户 ID 能使用 /check（留空 = 所有人可用，会在启动日志里警告）
  allowedUserIds: list('ALLOWED_USER_IDS'),
  // 机器人回复 / AI 总结使用的语言：Chinese（默认）或 English
  summaryLanguage: opt('SUMMARY_LANGUAGE', 'Chinese'),
  timezone: opt('TIMEZONE', 'Asia/Shanghai'),
  // 消息保留天数，0 = 永久保留
  retentionDays: int('RETENTION_DAYS', 0),
  // 单次总结最多读取的消息条数
  maxSummaryMessages: int('MAX_SUMMARY_MESSAGES', 3000),
};

if (config.trackChannelIds.length === 0) {
  throw new Error(
    '[配置错误] TRACK_CHANNEL_IDS 为空。请填入至少一个要监控的 Discord 频道 ID（多个用英文逗号分隔）。'
  );
}

/** 输出语言是否为英文 */
export const isEnglish = !/^zh|chinese|中文/i.test(config.summaryLanguage);

export function printConfigSummary() {
  const mask = (s) => (s && s.length > 8 ? `${s.slice(0, 4)}****${s.slice(-4)}` : '****');
  console.log('======== 运行配置 ========');
  console.log(`监控频道      : ${config.trackChannelIds.join(', ')}`);
  console.log(`命令名        : /${config.checkCommandName}`);
  console.log(`AI 地址       : ${config.ai.baseUrl}`);
  console.log(`AI 模型       : ${config.ai.model}`);
  console.log(`输出语言      : ${config.summaryLanguage}`);
  console.log(
    `命令使用者    : ${config.allowedUserIds.length ? config.allowedUserIds.join(', ') : '（未限制，所有人可用）'}`
  );
  console.log(`关注成员      : ${config.watchMembers.length ? config.watchMembers.join(', ') : '（无，仅整体总结）'}`);
  console.log(`时区          : ${config.timezone}`);
  console.log(`消息保留      : ${config.retentionDays > 0 ? `${config.retentionDays} 天` : '永久'}`);
  console.log(`单次消息上限  : ${config.maxSummaryMessages} 条`);
  console.log(`Supabase      : ${config.supabase.url}`);
  console.log(`Discord Token : ${mask(config.discord.token)}`);
  console.log(`AI Key        : ${mask(config.ai.apiKey)}`);
  console.log('==========================');

  if (config.allowedUserIds.length === 0) {
    console.warn(
      '⚠️  [安全提醒] 未设置 ALLOWED_USER_IDS，目前服务器里任何人都能使用 /check。\n' +
        '    建议在 Render 的 Environment 里加上 ALLOWED_USER_IDS=<Juliet的用户ID>（多个用英文逗号分隔）。'
    );
  }
}

