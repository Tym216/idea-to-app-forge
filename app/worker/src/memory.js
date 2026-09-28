import { admin, executionOf } from './supabase.js';
import { config } from './config.js';
import { chat, parseJson } from './llm.js';
import { logger } from './logger.js';

/**
 * 记忆策略(两种范围):
 *  - scope='user'   : 跨项目的用户偏好(语言、技术栈口味、代码风格)
 *  - scope='project': 单项目已确认的产品/技术约定
 * 每轮任务结束后由模型抽取候选记忆,再做 upsert / 删除,注入下一轮上下文。
 */

export async function loadMemories(userId, projectId) {
  const { data, error } = await admin
    .from('ita_memories')
    .select('scope, key, value, weight, enabled')
    .eq('user_id', userId)
    .or(`project_id.eq.${projectId},and(project_id.is.null,enabled.eq.true)`)
    .order('weight', { ascending: false })
    .limit(40);
  if (error) throw new Error(`loadMemories failed: ${error.message}`);
  return activeMemories(data || []);
}

/** 停用的默认偏好(scope=user, enabled=false)不注入后续生成任务。 */
export function activeMemories(list) {
  return list.filter((m) => m.scope !== 'user' || m.enabled !== false);
}

/** 全局偏好只生成「保存为默认偏好?」建议,用户确认后才跨项目使用。 */
export async function suggestMemory(taskId, { key, value }) {
  const { error } = await admin.rpc('ita_worker_suggest_memory', {
    p_task_id: taskId,
    p_worker_id: config.workerId,
    p_execution_id: executionOf(taskId),
    p_key: key,
    p_value: value,
  });
  if (error) logger.warn('memory.suggest.failed', { taskId, error: error.message, key });
}

export function renderMemories(memories) {
  if (!memories.length) return '(暂无已记录的偏好或约定)';
  const user = memories.filter((m) => m.scope === 'user');
  // 设计约定以结构化形式单独注入 Build 提示词,这里不再重复
  const project = memories.filter((m) => m.scope === 'project' && m.key !== 'design_system');
  const fmt = (list) => list.map((m) => `- ${m.key}: ${m.value}`).join('\n') || '- (无)';
  return `【用户偏好】\n${fmt(user)}\n【项目约定】\n${fmt(project)}`;
}

/**
 * Worker 专用原子写入:调用 ita_worker_upsert_memory。
 * 不传 user_id / project_id,归属由数据库从「本 Worker 持有租约的 running 任务」推导。
 */
export async function upsertMemory(taskId, { scope, key, value, weight = 1 }) {
  const { error } = await admin.rpc('ita_worker_upsert_memory', {
    p_task_id: taskId,
    p_worker_id: config.workerId,
    p_execution_id: executionOf(taskId),
    p_scope: scope,
    p_key: key,
    p_value: value,
    p_weight: weight,
  });
  if (error) logger.warn('memory.upsert.failed', { taskId, error: error.message, key, scope });
}

export async function deleteMemory(userId, projectId, scope, key) {
  const query = admin.from('ita_memories').delete().eq('user_id', userId).eq('scope', scope).eq('key', key);
  if (scope === 'project') query.eq('project_id', projectId);
  else query.is('project_id', null);
  const { error } = await query;
  if (error) logger.warn('memory.delete.failed', { error: error.message, key });
}

/** 让模型从本轮对话中抽取需要长期保留/失效的记忆项。 */
export async function extractMemories({ userId, projectId, userPrompt, summary, taskId }, deps = { chat, upsertMemory, suggestMemory, deleteMemory }) {
  const raw = await deps.chat(
    [
      {
        role: 'system',
        content:
          '你负责维护长期记忆。只抽取稳定、可复用的信息,不要记录一次性的临时指令。' +
          '输出 JSON: {"upsert":[{"scope":"user|project","key":"短标识","value":"一句话","weight":1}],"remove":[{"scope":"user|project","key":"短标识"}]}。' +
          '没有可记录内容时返回空数组。',
      },
      { role: 'user', content: `用户需求:\n${userPrompt}\n\n本轮执行结果摘要:\n${summary}` },
    ],
    { json: true, temperature: 0, taskId }
  );

  let payload;
  try {
    payload = parseJson(raw);
  } catch (error) {
    logger.warn('memory.extract.parse_failed', { taskId, error: String(error) });
    return;
  }

  // 设计约定只由 resolveDesign 维护,避免自动抽取把它覆盖或删除
  const isDesign = (item) => item?.key === 'design_system';
  for (const item of payload.upsert || []) {
    if (!item?.key || !item?.value || isDesign(item)) continue;
    if (item.scope === 'project') await deps.upsertMemory(taskId, item);
    else if (item.scope === 'user') await deps.suggestMemory(taskId, item); // 不自动写入全局偏好
  }
  // 只允许自动移除项目约定;全局偏好只能由用户在记忆面板管理
  for (const item of payload.remove || []) {
    if (item?.key && item.scope === 'project' && !isDesign(item)) {
      await deps.deleteMemory(userId, projectId, item.scope, item.key);
    }
  }
}
