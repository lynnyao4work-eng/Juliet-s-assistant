/**
 * /purge-media 的离线自检：不连 Discord，用假对象跑 src/purge.js 的真实逻辑。
 *
 * 用法：npm run purge-test
 *
 * 覆盖：媒体识别（图片/视频/普通文件/嵌入）→ 汇总 → 分页扫描与过滤
 *       → 14 天内批量删除 / 更早逐条删除 → 已被删除的消息视为成功
 */
process.env.DISCORD_TOKEN ||= 'test-token';
process.env.AI_API_KEY ||= 'test-key';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'test-key';
process.env.TRACK_CHANNEL_IDS ||= '1402129979525038154';

const {
  mediaOf,
  summarize,
  collectMediaMessages,
  deleteMediaMessages,
  formatBytes,
  buildPurgeMediaCommand,
} = await import('../src/purge.js');

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

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

/** 造一条消息；attachments / embeds 用 discord.js 的字段名 */
function msg(id, { authorId = '1503511121607528568', at = NOW, attachments = [], embeds = [], pinned = false, thread = null } = {}) {
  const m = {
    id: String(id),
    author: { id: authorId },
    createdTimestamp: at,
    createdAt: new Date(at),
    pinned,
    thread,
    content: '',
    attachments: new Map(attachments.map((a, i) => [String(i), a])),
    embeds,
    deleted: false,
    async delete() {
      m.deleted = true;
    },
  };
  return m;
}

const img = (name = 'a.png', size = 1000) => ({ contentType: 'image/png', name, url: `https://cdn/${name}`, size });
const vid = (name = 'b.mp4', size = 2000) => ({ contentType: 'video/mp4', name, url: `https://cdn/${name}`, size });

console.log('\n===== /purge-media 自检 =====\n');

/* ---------- 1. 媒体识别 ---------- */
console.log('【1/5】媒体识别');
check('图片附件命中', mediaOf(msg(1, { attachments: [img()] })).map((m) => m.kind), ['image']);
check('视频附件命中', mediaOf(msg(1, { attachments: [vid()] })).map((m) => m.kind), ['video']);
check('一条里多个附件都算', mediaOf(msg(1, { attachments: [img(), vid()] })).length, 2);
check(
  '按扩展名兜底（无 contentType）',
  mediaOf(msg(1, { attachments: [{ name: 'x.jpeg', url: 'https://cdn/x.jpeg' }] })).map((m) => m.kind),
  ['image']
);
check(
  '普通文件不命中（pdf）',
  mediaOf(msg(1, { attachments: [{ contentType: 'application/pdf', name: 'a.pdf', url: 'https://cdn/a.pdf' }] })),
  []
);
check('纯文字消息不命中', mediaOf(msg(1)), []);
check('图片嵌入命中', mediaOf(msg(1, { embeds: [{ type: 'image', image: { url: 'https://x/1.png' } }] })).length, 1);
check(
  '链接预览（只有缩略图）不命中',
  mediaOf(msg(1, { embeds: [{ type: 'link', thumbnail: { url: 'https://x/t.png' } }] })),
  []
);

/* ---------- 2. 汇总 ---------- */
console.log('\n【2/5】汇总统计');
const sample = [
  { media: [{ kind: 'image', name: 'a', size: 1000 }], createdAt: new Date(NOW), hasThread: false },
  { media: [{ kind: 'video', name: 'b', size: 3000 }], createdAt: new Date(NOW - DAY), hasThread: true },
];
const stat = summarize(sample);
check('消息数', stat.messages, 2);
check('图片数', stat.images, 1);
check('视频数', stat.videos, 1);
check('总字节', stat.bytes, 4000);
check('帖子数', stat.threads, 1);
check('最早时间取最小值', stat.earliest.getTime(), NOW - DAY);
check('大小格式化', formatBytes(4000), '3.9 KB');

/* ---------- 3. 分页扫描与过滤 ---------- */
console.log('\n【3/5】分页扫描与过滤');

/**
 * 造一个假频道：fetch 同时支持
 *   fetch({ limit, before }) → 一页消息
 *   fetch(id)                → 单条消息
 */
function fakeChannel(messages, { bulkFails = false } = {}) {
  const store = [...messages].sort((a, b) => Number(b.id) - Number(a.id));
  const calls = { bulk: [], single: [], pages: 0 };

  const channel = {
    name: 'test-channel',
    id: '1402576773341904906',
    messages: {
      async fetch(arg) {
        if (typeof arg === 'string') {
          const found = store.find((m) => m.id === arg);
          if (!found) throw new Error('Unknown Message');
          return found;
        }
        calls.pages += 1;
        const { limit = 100, before } = arg || {};
        const pool = before ? store.filter((m) => Number(m.id) < Number(before)) : store;
        const page = pool.slice(0, limit);
        const map = new Map(page.map((m) => [m.id, m]));
        return { size: map.size, values: () => map.values() };
      },
    },
    async bulkDelete(ids) {
      if (bulkFails) throw new Error('Invalid Form Body');
      calls.bulk.push(ids);
      for (const id of ids) {
        const found = store.find((m) => m.id === id);
        if (found) found.deleted = true;
      }
      return { size: ids.length };
    },
  };
  channel._calls = calls;
  channel._store = store;
  return channel;
}

const TARGET = '1503511121607528568';
const other = '999';

// 250 条：ID 随时间递增（和真实雪花 ID 一致）；目标成员每 5 条一条，偶数条带图
const many = [];
for (let i = 1; i <= 250; i += 1) {
  const isTarget = i % 5 === 0;
  many.push(
    msg(1000 + i, {
      authorId: isTarget ? TARGET : other,
      attachments: i % 2 === 0 ? [img()] : [],
      at: NOW - (250 - i) * 1000,
    })
  );
}
const ch = fakeChannel(many);
const scan = await collectMediaMessages(ch, TARGET, {});
check('翻页次数 = 3（250 条 / 每页 100）', scan.pages, 3);
check('扫描消息数', scan.scanned, 250);
check('只命中目标成员的带图消息（25 条）', scan.hits.length, 25);
check('命中项一定有媒体', scan.hits.every((h) => h.media.length > 0), true);
check('没有重复命中', new Set(scan.hits.map((h) => h.id)).size, scan.hits.length);

const pinnedCh = fakeChannel([
  msg(1, { attachments: [img()], pinned: true }),
  msg(2, { attachments: [img()] }),
]);
const kept = await collectMediaMessages(pinnedCh, TARGET, { keepPinned: true });
check('keepPinned 时置顶消息被跳过', kept.hits.map((h) => h.id), ['2']);

/* ---------- 4. 删除策略 ---------- */
console.log('\n【4/5】删除策略（14 天内批量 / 更早逐条）');

const fresh = [msg(2001, { attachments: [img()], at: NOW - DAY })];
const stale = [msg(2002, { attachments: [vid()], at: NOW - 30 * DAY })];
const mix = fakeChannel([...fresh, ...stale]);
const del = await deleteMediaMessages(mix, [
  { id: '2001', createdAt: new Date(NOW - DAY), media: [{ kind: 'image', size: 1 }] },
  { id: '2002', createdAt: new Date(NOW - 30 * DAY), media: [{ kind: 'video', size: 1 }] },
]);
check('14 天内的走批量删除', mix._calls.bulk.length, 1);
check('批量删除只含 1 条', mix._calls.bulk[0].length, 1);
check('超过 14 天的逐条删除（已被删除）', mix._store.find((m) => m.id === '2002').deleted, true);
check('删除总数 2', del.deleted, 2);
check('无失败', del.failures.length, 0);

// 批量失败 → 自动退回逐条
const fallback = fakeChannel([msg(3001, { attachments: [img()], at: NOW - DAY })], { bulkFails: true });
const fb = await deleteMediaMessages(fallback, [
  { id: '3001', createdAt: new Date(NOW - DAY), media: [{ kind: 'image', size: 1 }] },
]);
check('批量失败后逐条删除成功', fallback._store[0].deleted, true);
check('逐条删除计入总数', fb.deleted, 1);
check('批量失败不算失败', fb.failures.length, 0);

// 消息已被别人删掉 → 视为成功，不报错
const goneChannel = fakeChannel([]);
const gone = await deleteMediaMessages(goneChannel, [
  { id: '9999', createdAt: new Date(NOW - DAY), media: [{ kind: 'image', size: 1 }] },
]);
check('Unknown Message 视为已删除', gone.deleted, 1);
check('Unknown Message 不记为失败', gone.failures.length, 0);

/* ---------- 5. 命令定义 ---------- */
console.log('\n【5/5】命令定义（离线校验 slash 命令结构）');
const cmd = buildPurgeMediaCommand().toJSON();
check('命令名', cmd.name, 'purge-media');
check('选项顺序与名称', cmd.options.map((o) => o.name), ['user', 'channel', 'confirm', 'keep_pinned']);
check('user 为必填', cmd.options.find((o) => o.name === 'user').required, true);
check('confirm 非必填（默认就是 dry run）', !!cmd.options.find((o) => o.name === 'confirm').required, false);
check('user 是字符串类型（支持已离服成员的 ID）', cmd.options.find((o) => o.name === 'user').type, 3);

/* ---------- 汇总 ---------- */
console.log(`\n===== 结果：${passed} 通过，${failed} 失败 =====\n`);
if (failed > 0) process.exit(1);
