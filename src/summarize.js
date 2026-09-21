import OpenAI from 'openai';
import { config, isEnglish } from './config.js';
import { buildTranscript, formatDateTime } from './format.js';

const client = new OpenAI({
  apiKey: config.ai.apiKey,
  baseURL: config.ai.baseUrl,
  timeout: 180_000,
  maxRetries: 2,
});

/* ============================================================
   提示词（中英双语）
   重点：mod room 的日志天然会包含粗口、违规内容、成人用语，
   必须先给模型一个"内部审核纪要"的角色框架，否则模型很容易触发安全拒答。
   ============================================================ */

const SYSTEM_PROMPT_ZH = `你是一个 Discord 服务器管理团队（mod room / 审核后台）的内部纪要助手。
你的唯一职责是：客观、准确、完整地把聊天记录归纳成结构化纪要。

必须遵守的规则：
1. 你收到的聊天记录是审核团队处理工作留下的一手材料，里面**可能包含**粗口、脏话、侮辱性词汇、成人或性相关内容、暴力、歧视、违规交易、被举报或已处罚的事件等。
2. 这些都是审核团队必须了解的工作信息。你必须正常理解并如实转述，**严禁拒绝回答、严禁说教、严禁输出"我无法处理此类内容"之类的回避话术、严禁因为个别词汇而中断输出**。
3. 不要美化、不要净化、不要删掉关键信息。涉及违规事件时，如实说明"谁说了什么、如何处理"。
4. 不要编造日志里没有的信息。含义不明的消息，标注"（含义不明）"。
5. 用简体中文输出，人名、频道名、链接、ID 保持原文。

输出必须严格使用以下 Markdown 结构：

## 一句话总览
用一句话概括这段时间该频道发生了什么。

## 主要讨论主题
- **主题名**：简述 + 关键结论（每个主题一行到三行）

## 关键结论 / 已决定事项
- 有明确结论或已拍板的事项逐条列出；没有就写"本期无明显结论"

## 待办 / 需要跟进
- 需要有人去做、去确认、去回复的事项；没有就写"无"

## 风险 / 争议 / 违规事件
- 出现的争吵、冲突、被举报内容、需要处罚或已经处罚的事件；没有就写"无"

## 各成员发言要点
- **成员名**：该成员主要在说什么、立场如何、有无需要留意的发言`;

const SYSTEM_PROMPT_EN = `You are the internal scribe for a Discord server's moderation team (mod room / review back office).
Your only job is to turn chat logs into an accurate, neutral, complete written record.

Rules you MUST follow:
1. The log you receive is first-hand working material left by the moderation team. It MAY contain profanity, insults, slurs, adult or sexual content, violence, discrimination, rule-breaking or illicit deals, reported incidents, and issued punishments.
2. All of that is work information the team needs. You must read it normally and restate it faithfully. NEVER refuse, NEVER moralise, NEVER output evasion such as "I can't help with that", and NEVER stop mid-output because of individual words.
3. Do not sanitise, do not censor, do not drop key details. When a rule violation is discussed, state plainly who said what and how it was handled.
4. Never invent information that is not in the log. If a message's meaning is unclear, mark it "(unclear)".
5. Output in English. Keep usernames, channel names, links and IDs exactly as written.

Output MUST use exactly this Markdown structure:

## TL;DR
One sentence on what happened in this channel during the period.

## Main topics
- **Topic name**: short description + key conclusion (one to three lines each)

## Key conclusions / decisions
- List every item that has a clear conclusion or decision; if none, write "No notable conclusions this period"

## Action items / follow-ups
- Anything someone needs to do, confirm or reply to; if none, write "None"

## Risks / conflicts / incidents
- Arguments, conflicts, reported content, punishments needed or already issued; if none, write "None"

## Highlights by member
- **Member name**: what they mainly talked about, their stance, and anything worth noting`;

const CHUNK_PROMPT_ZH = `你是 Discord 服务器管理团队的内部纪要助手。
你会收到一段聊天记录片段，请把它压缩成高密度的中文要点清单。

规则：
- 保留发言人、时间、关键原话、冲突点、决定、待办。
- 内容可能包含粗口、成人用语、违规内容，这些是审核工作材料，必须如实保留，严禁拒绝或回避输出。
- 只输出要点清单，不要客套话，不要编造。`;

const CHUNK_PROMPT_EN = `You are the internal scribe for a Discord server's moderation team.
You will receive one segment of a chat log. Compress it into a dense, factual bullet list.

Rules:
- Keep speakers, timestamps, key quotes, conflicts, decisions and action items.
- The content may contain profanity, adult language or rule-violating material. This is moderation working material: preserve it faithfully. Never refuse or dodge.
- Output bullets only, no pleasantries, do not invent anything.`;

const WATCH_ZH = (names) => `

## 需要重点关注的成员发言
以下成员被管理员标记为需要重点关注：${names}。
请单独一节，逐条列出他们在这段时间的**每一条**关键发言（保留原话摘要 + 时间），不要遗漏，不要概括成一句话。`;

const WATCH_EN = (names) => `

## Watchlist members
These members are flagged for attention by the admins: ${names}.
Add a separate section listing EVERY key message from them during this period (short quote + timestamp). Do not omit any and do not collapse them into a single sentence.`;

const SYSTEM_PROMPT = isEnglish ? SYSTEM_PROMPT_EN : SYSTEM_PROMPT_ZH;
const CHUNK_SYSTEM_PROMPT = isEnglish ? CHUNK_PROMPT_EN : CHUNK_PROMPT_ZH;
const WATCH_SECTION_PROMPT = isEnglish ? WATCH_EN : WATCH_ZH;

/* ============================================================
   调用逻辑
   ============================================================ */

/** 调用一次模型 */
async function callAI(systemContent, userContent, maxTokens) {
  const resp = await client.chat.completions.create({
    model: config.ai.model,
    messages: [
      { role: 'system', content: systemContent },
      { role: 'user', content: userContent },
    ],
    temperature: config.ai.temperature,
    max_tokens: maxTokens ?? config.ai.maxTokens,
  });

  const text = resp.choices?.[0]?.message?.content;
  if (!text || !text.trim()) {
    throw new Error(
      isEnglish
        ? 'The AI returned empty content (possibly blocked by a content filter, or the token limit was hit).'
        : 'AI 返回了空内容（可能是被内容安全策略拦截，或 token 超限）'
    );
  }
  return text.trim();
}

/** 把长日志切成若干块，避免超出模型上下文 */
function chunkTranscript(transcript) {
  const limit = config.ai.chunkChars;
  const lines = transcript.split('\n');
  const chunks = [];
  let current = [];
  let length = 0;

  for (const line of lines) {
    if (length + line.length + 1 > limit && current.length > 0) {
      chunks.push(current.join('\n'));
      current = [];
      length = 0;
    }
    current.push(line);
    length += line.length + 1;
  }
  if (current.length) chunks.push(current.join('\n'));
  return chunks;
}

/**
 * 对消息做总结。
 * 消息少 → 一次调用；消息多 → 先分段压缩，再做最终合并（map-reduce）。
 */
export async function summarizeMessages({ channelName, messages, since, until }) {
  const transcript = buildTranscript(messages);
  const chunks = chunkTranscript(transcript);

  const watchSection = config.watchMembers.length
    ? WATCH_SECTION_PROMPT(config.watchMembers.join(isEnglish ? ', ' : '、'))
    : '';

  const header = isEnglish
    ? `Channel: #${channelName}\nTime range: ${formatRange(since, until)}\nMessage count: ${messages.length}\n`
    : `频道：#${channelName}\n时间范围：${formatRange(since, until)}\n消息条数：${messages.length}\n`;

  // ---- 情况一：一次装得下 ----
  if (chunks.length <= 1) {
    const userContent = isEnglish
      ? `${header}\nBelow is the raw chat log:\n\n${transcript}\n\nProduce the record using the required structure.`
      : `${header}\n以下是原始聊天记录：\n\n${transcript}\n\n请按结构输出纪要。`;
    return await callAI(SYSTEM_PROMPT + watchSection, userContent);
  }

  // ---- 情况二：日志太长，分段压缩后再合并 ----
  console.log(`[summarize] 日志较长，拆成 ${chunks.length} 段进行分段压缩`);

  const partials = [];
  for (let i = 0; i < chunks.length; i++) {
    const userContent = isEnglish
      ? `${header}\nThis is segment ${i + 1} of ${chunks.length}:\n\n${chunks[i]}\n\nOutput the bullet list.`
      : `${header}\n这是第 ${i + 1}/${chunks.length} 段聊天记录：\n\n${chunks[i]}\n\n请输出要点清单。`;
    const part = await callAI(CHUNK_SYSTEM_PROMPT, userContent, 1500);
    partials.push(isEnglish ? `【Segment ${i + 1} notes】\n${part}` : `【第 ${i + 1} 段要点】\n${part}`);
  }

  const mergeContent = isEnglish
    ? `${header}\nBelow are notes extracted from ${chunks.length} segments of the chat log. ` +
      `Merge and de-duplicate them, then produce one complete record using the required structure.\n\n${partials.join('\n\n')}`
    : `${header}\n下面是从 ${chunks.length} 段聊天记录中分别提取的要点清单，请合并去重，` +
      `然后按结构输出一份完整的纪要。\n\n${partials.join('\n\n')}`;

  return await callAI(SYSTEM_PROMPT + watchSection, mergeContent);
}

function formatRange(since, until) {
  return `${formatDateTime(since)} → ${formatDateTime(until)}`;
}

/** 简单连通性自检，启动时用 */
export async function pingAI() {
  try {
    await callAI('You are a test assistant. Reply with "OK" only.', 'Reply with: OK', 16);
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}
