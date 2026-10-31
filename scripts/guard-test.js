/**
 * 反刷屏守卫的离线自检：不连 Discord、不连数据库，只验证判定逻辑。
 *
 * 用法：npm run guard-test
 *
 * 覆盖：字符计数口径 → 单条超长 → 窗口刷屏 → 边界值 → 线程归属 → 豁免判断 → 报告文本
 */
process.env.DISCORD_TOKEN ||= 'test-token';
process.env.AI_API_KEY ||= 'test-key';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'test-key';
process.env.TRACK_CHANNEL_IDS ||= '1402129979525038154';

const { config } = await import('../src/config.js');
const {
  countChars,
  detectTrigger,
  watchedChannelId,
  isExemptMember,
  isPremiumMember,
  buildTriggerReport,
  resetGuardState,
} = await import('../src/guard.js');

let passed = 0;
let failed = 0;

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed += 1;
    console.log(`✅ ${name}`);
  } else {
    failed += 1;
    console.log(`❌ ${name}\n   期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

const g = config.guard;
const WATCHED = g.channelIds[0];
const NOW = 1_760_000_000_000;

/** 造一条窗口记录 */
function entry(chars, { at = NOW, channelId = WATCHED, channelName = 'general' } = {}) {
  return {
    message: {},
    channelId,
    channelName,
    content: 'x'.repeat(chars),
    chars,
    at,
  };
}

/** 造一个假成员 */
function member({ id = '100', admin = false, isOwner = false, roles = [] } = {}) {
  return {
    id,
    displayName: 'Test User',
    user: { id, username: 'testuser' },
    permissions: { has: () => admin },
    roles: { cache: new Map(roles.map((r) => [r, {}])) },
    _isOwner: isOwner,
  };
}

console.log('\n===== 反刷屏守卫自检 =====\n');
console.log(
  `配置：阈值 ${g.maxChars} 字符 / ${g.windowMinutes} 分钟内 >${g.maxMessages} 条且 >${g.windowChars} 字符，` +
    `监控 ${g.channelIds.length} 个频道\n`
);

/* ---------- 1. 字符计数 ---------- */
console.log('【1/7】字符计数口径');
check('400 个 ASCII 字符 = 400', countChars('x'.repeat(400)), 400);
check('一个 emoji 算 1 个字符', countChars('👍'), 1);
check('emoji 组合串按码点计', countChars('👍👍👍'), 3);
check('空内容算 0', countChars(''), 0);
check('null 安全', countChars(null), 0);

/* ---------- 2. 规则 1：单条超长 ---------- */
console.log('\n【2/7】规则 1：单条超长（严格大于）');
check('399 字符不触发', detectTrigger([entry(399)], NOW), null);
check('400 字符不触发（边界）', detectTrigger([entry(400)], NOW), null);
const t401 = detectTrigger([entry(401)], NOW);
check('401 字符触发且规则为 length', t401?.kind, 'length');
check('触发时只带这一条', t401?.messageCount, 1);
check('触发时字符数正确', t401?.totalChars, 401);

/* ---------- 3. 规则 2：窗口刷屏 ---------- */
console.log('\n【3/7】规则 2：窗口刷屏（条数与字符数都要超）');
check(
  '3 条各 300 字符不触发（条数未超）',
  detectTrigger([entry(300), entry(300), entry(300)], NOW),
  null
);
check(
  '4 条共 600 字符不触发（字符数未超）',
  detectTrigger([entry(150), entry(150), entry(150), entry(150)], NOW),
  null
);
const flood = detectTrigger([entry(151), entry(151), entry(151), entry(151)], NOW);
check('4 条共 604 字符触发', flood?.kind, 'flood');
check('触发时统计 4 条', flood?.messageCount, 4);
check('触发时合计字符 604', flood?.totalChars, 604);
check(
  '5 条共 605 字符也触发',
  detectTrigger([entry(121), entry(121), entry(121), entry(121), entry(121)], NOW)?.kind,
  'flood'
);

/* ---------- 4. 窗口边界 ---------- */
console.log('\n【4/7】窗口边界（5 分钟）');
const expired = [
  entry(200, { at: NOW - 6 * 60 * 1000 }),
  entry(200, { at: NOW - 6 * 60 * 1000 }),
  entry(200, { at: NOW - 6 * 60 * 1000 }),
  entry(200, { at: NOW }),
];
check('窗口外的旧消息不计入', detectTrigger(expired, NOW)?.kind, undefined);
const inWindow = [
  entry(200, { at: NOW - 4 * 60 * 1000 }),
  entry(200, { at: NOW - 3 * 60 * 1000 }),
  entry(200, { at: NOW - 2 * 60 * 1000 }),
  entry(200, { at: NOW }),
];
check('窗口内的消息计入', detectTrigger(inWindow, NOW)?.kind, 'flood');
check('空数组不触发', detectTrigger([], NOW), null);

/* ---------- 5. 频道归属与豁免 ---------- */
console.log('\n【5/7】频道归属与豁免判断');
check('监控频道本身命中', watchedChannelId({ channelId: WATCHED, channel: {} }), WATCHED);
check(
  '线程消息按父频道归属',
  watchedChannelId({ channelId: '999', channel: { parentId: WATCHED } }),
  WATCHED
);
check('无关频道不命中', watchedChannelId({ channelId: '999', channel: { parentId: '888' } }), null);
check('拿不到成员对象 → 豁免（宁漏不误）', isExemptMember(null, {}), true);
check('Administrator 权限 → 豁免', isExemptMember(member({ admin: true }), { ownerId: 'someone' }), true);
check('服务器所有者 → 豁免', isExemptMember(member({ id: '555' }), { ownerId: '555' }), true);
check('普通成员 → 不豁免', isExemptMember(member(), { ownerId: '555' }), false);
check(
  'premium 角色识别',
  isPremiumMember(member({ roles: g.premiumRoleIds })),
  true
);
check('无 premium 角色', isPremiumMember(member({ roles: ['999'] })), false);

/* ---------- 6. 报告文本 ---------- */
console.log('\n【6/7】报告文本');
resetGuardState();
const reportMember = member({ id: '123456789', roles: [] });
const report = buildTriggerReport({
  member: reportMember,
  trigger: { kind: 'length', entries: [entry(401, { channelName: 'general' })], messageCount: 1, totalChars: 401 },
  channelNames: ['#general'],
});
check('报告含规则说明', report.includes('over 400 chars'), true);
check('报告含用户 ID', report.includes('123456789'), true);
check('报告含频道名', report.includes('#general'), true);
check('报告含引用块', report.includes('> xxx'), true);

const longReport = buildTriggerReport({
  member: reportMember,
  trigger: {
    kind: 'flood',
    entries: Array.from({ length: 12 }, () => entry(1500, { channelName: 'general' })),
    messageCount: 12,
    totalChars: 18000,
  },
  channelNames: ['#general'],
});
check('超过 10 条时提示省略', longReport.includes('2 earlier message(s) omitted'), true);
check('单条过长时截断', longReport.includes('已截断'), true);

/* ---------- 7. 完整处置流程（用假对象跑真代码） ---------- */
console.log('\n【7/7】完整处置流程');

/** 造一个假成员，记录 ban / timeout 是否被调用 */
function fakeMember({ id = '200', admin = false, roles = [], banRejects = false } = {}) {
  const calls = { ban: 0, timeout: 0, timeoutMs: null, deleteSeconds: null };
  const member = {
    id,
    displayName: 'Fake User',
    user: { id, username: 'fakeuser', tag: 'fakeuser#0001' },
    permissions: { has: () => admin },
    roles: { cache: new Map(roles.map((r) => [r, {}])) },
    ban: async (opts) => {
      calls.ban += 1;
      calls.deleteSeconds = opts?.deleteMessageSeconds ?? null;
      if (banRejects) throw new Error('Missing Permissions');
    },
    timeout: async (ms) => {
      calls.timeout += 1;
      calls.timeoutMs = ms;
    },
    _calls: calls,
  };
  return member;
}

/** 造一条假消息 */
function fakeMessage(member, { content = '', channelId = WATCHED, deleted = [] } = {}) {
  const msg = {
    inGuild: () => true,
    author: { bot: false },
    channelId,
    channel: { name: 'general', parentId: null },
    member,
    content,
    id: `msg-${Math.random().toString(36).slice(2, 8)}`,
    createdTimestamp: NOW,
    delete: async () => {
      deleted.push(msg.id);
    },
  };
  msg.client = {
    users: {
      fetch: async (userId) => ({
        id: userId,
        send: async () => {
          dmCount += 1;
        },
      }),
    },
  };
  return msg;
}

let dmCount = 0;
const { handleGuardMessage } = await import('../src/guard.js');

// 7-1 普通成员发 401 字符 → 封禁 + 两条私信（报告 + 结果）
resetGuardState();
dmCount = 0;
const normalMember = fakeMember();
await handleGuardMessage(fakeMessage(normalMember, { content: 'x'.repeat(401) }));
check('普通成员被 ban 一次', normalMember._calls.ban, 1);
check('封禁参数带 24 小时删除', normalMember._calls.deleteSeconds, g.banDeleteSeconds);
check('发出 2 条私信（报告 + 结果）', dmCount, 2);
check('未调用禁言', normalMember._calls.timeout, 0);

// 7-2 400 字符不触发
resetGuardState();
dmCount = 0;
const edgeMember = fakeMember();
await handleGuardMessage(fakeMessage(edgeMember, { content: 'x'.repeat(400) }));
check('400 字符不触发（边界）', edgeMember._calls.ban, 0);
check('400 字符不发私信', dmCount, 0);

// 7-3 管理员完全跳过
resetGuardState();
dmCount = 0;
const adminMember = fakeMember({ admin: true });
await handleGuardMessage(fakeMessage(adminMember, { content: 'x'.repeat(2000) }));
check('管理员不被 ban', adminMember._calls.ban, 0);
check('管理员不发私信', dmCount, 0);

// 7-4 premium：删消息 + 禁言，不封禁
resetGuardState();
dmCount = 0;
const premiumMember = fakeMember({ roles: g.premiumRoleIds });
const deletedIds = [];
await handleGuardMessage(
  fakeMessage(premiumMember, { content: 'x'.repeat(401), deleted: deletedIds })
);
check('premium 不被 ban', premiumMember._calls.ban, 0);
check('premium 被禁言一次', premiumMember._calls.timeout, 1);
check('禁言时长 = 7 天', premiumMember._calls.timeoutMs, g.timeoutDays * 24 * 60 * 60 * 1000);
check('premium 的消息被删除', deletedIds.length, 1);
check('premium 也发 1 条私信', dmCount, 1);

// 7-5 非监控频道不做任何事
resetGuardState();
dmCount = 0;
const otherChannelMember = fakeMember();
await handleGuardMessage(
  fakeMessage(otherChannelMember, { content: 'x'.repeat(900), channelId: '999999999' })
);
check('非监控频道不处置', otherChannelMember._calls.ban, 0);

// 7-6 封禁失败：仍然只处理一次，且进入冷却
resetGuardState();
dmCount = 0;
const rejectMember = fakeMember({ banRejects: true });
for (let i = 0; i < 8; i += 1) {
  await handleGuardMessage(fakeMessage(rejectMember, { content: 'x'.repeat(401) }));
}
check('封禁失败只尝试一次（冷却生效）', rejectMember._calls.ban, 1);
check('封禁失败仍发 2 条私信（报告 + 失败说明）', dmCount, 2);

// 7-7 刷屏规则：4 条 151 字符 → 第 4 条触发
resetGuardState();
dmCount = 0;
const floodMember = fakeMember({ id: '300' });
for (let i = 0; i < 3; i += 1) {
  await handleGuardMessage(fakeMessage(floodMember, { content: 'x'.repeat(151) }));
}
check('前 3 条不触发', floodMember._calls.ban, 0);
await handleGuardMessage(fakeMessage(floodMember, { content: 'x'.repeat(151) }));
check('第 4 条触发封禁', floodMember._calls.ban, 1);

/* ---------- 汇总 ---------- */
console.log(`\n===== 结果：${passed} 通过，${failed} 失败 =====\n`);
if (failed > 0) process.exit(1);
