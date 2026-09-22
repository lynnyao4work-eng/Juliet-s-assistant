import { createClient } from '@supabase/supabase-js';
import { config } from './config.js';

export const supabase = createClient(config.supabase.url, config.supabase.serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { headers: { 'x-application-name': 'discord-mod-tracker' } },
});

/**
 * 批量写入消息。使用 upsert + ignoreDuplicates，
 * 所以同一条消息重复写入不会报错，也不会产生重复数据。
 */
export async function upsertMessages(rows) {
  if (!rows || rows.length === 0) return 0;
  const { error } = await supabase
    .from('messages')
    .upsert(rows, { onConflict: 'discord_message_id', ignoreDuplicates: true });
  if (error) throw new Error(`写入 messages 失败：${error.message}`);
  return rows.length;
}

/** 某个频道里已保存的最新一条消息时间（用于启动时补齐消息） */
export async function getNewestMessageTime(channelId) {
  const { data, error } = await supabase
    .from('messages')
    .select('created_at')
    .eq('channel_id', channelId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`读取最新消息时间失败：${error.message}`);
  return data?.created_at ? new Date(data.created_at) : null;
}

/** 上次 /check 的结束时间（也就是本次总结的起点） */
export async function getLastCheckTime(channelId) {
  const { data, error } = await supabase
    .from('check_records')
    .select('period_end')
    .eq('channel_id', channelId)
    .order('period_end', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`读取 check 记录失败：${error.message}`);
  return data?.period_end ? new Date(data.period_end) : null;
}

/**
 * 查询某个频道在 (since, until] 区间内的消息。
 * Supabase 单次请求最多返回 1000 行，所以这里做了分页。
 *
 * @param {boolean} newestFirst
 *   false（默认）：取区间内**最早**的 maxMessages 条（适合按时间顺序整理）
 *   true：取区间内**最新**的 maxMessages 条（适合"看最近发生了什么"）
 * 无论哪种，返回值都按时间**正序**（老 → 新）排列，方便直接展示。
 */
export async function getMessagesBetween(channelId, sinceIso, untilIso, maxMessages, newestFirst = false) {
  const pageSize = 1000;
  const rows = [];
  let from = 0;

  while (rows.length < maxMessages) {
    const to = from + pageSize - 1;
    const { data, error } = await supabase
      .from('messages')
      .select('created_at, channel_id, channel_name, author_id, author_name, author_display_name, content, attachments, reply_to_id')
      .eq('channel_id', channelId)
      .gt('created_at', sinceIso)
      .lte('created_at', untilIso)
      .order('created_at', { ascending: !newestFirst })
      .range(from, to);

    if (error) throw new Error(`读取 messages 失败：${error.message}`);
    if (!data || data.length === 0) break;

    rows.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }

  const sliced = rows.slice(0, maxMessages);
  // 当按"最新优先"读取时，rows 是从新到老的，反转成正序返回
  return newestFirst ? sliced.reverse() : sliced;
}

/** 保存一条 check 记录 */
export async function saveCheckRecord(row) {
  const { error } = await supabase.from('check_records').insert(row);
  if (error) throw new Error(`写入 check_records 失败：${error.message}`);
}

/** 删除超过 N 天的旧消息，返回是否执行成功 */
export async function deleteMessagesOlderThan(days) {
  if (!days || days <= 0) return 0;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const { error, count } = await supabase
    .from('messages')
    .delete({ count: 'estimated' })
    .lt('created_at', cutoff);
  if (error) throw new Error(`清理旧消息失败：${error.message}`);
  return count ?? 0;
}
