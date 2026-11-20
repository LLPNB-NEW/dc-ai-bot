import { useEffect, useState, type ChangeEvent } from 'react';
import {
  ApiError,
  CONVERSATION_LINK_KIND_LABELS,
  CONVERSATION_PLATFORM_LABELS,
  MEMORY_DEFAULTS,
  SCOPE_LABELS,
  api,
  describeError,
  type ChannelMemoryConfig,
  type ConversationLink,
  type ConversationLinkKind,
  type ConversationPlatform,
  type ConversationRecord,
  type PromptConfig,
  type PromptItem,
  type PromptSegment,
  type QQPreset,
  type QQPresetInput,
} from '../api';

// 与 §26.4 的频道记忆校验保持一致：注入条数 ≥ 2，阈值 0 = 关闭否则 ≥ 2。
const MEMORY_MIN = 2;
// PromptConfig 的最小合法形状：新建预设时先给一个空段配置，用户再往里加段。
// 新预设先给一段可编辑的骨架：后端 readPromptSegments 拒绝空数组，空 segments 存不进去。
const NEW_PRESET_CONFIG_TEXT = JSON.stringify(
  {
    segments: [
      {
        id: 'seg-system',
        name: '系统提示词',
        role: 'system',
        content: '',
        enabled: true,
        placement: 'before',
      },
    ],
  },
  null,
  2,
);

function promptLayerKey(item: PromptItem): string {
  return item.scope + ':' + item.scopeId;
}

export function describePromptLayer(item: PromptItem): string {
  return item.scopeId === '' ? SCOPE_LABELS[item.scope] : SCOPE_LABELS[item.scope] + ' · ' + item.scopeId;
}

export function defaultPresetNameFromLayer(item: PromptItem): string {
  const suffix =
    item.scope === 'global' ? '全局' : item.scope === 'guild' ? '服务器 ' + item.scopeId : '频道 ' + item.scopeId;
  return 'DC 复制 · ' + suffix;
}

/**
 * Discord 提示词层 → QQ 预设输入：整份复制段与采样参数，源层不动。
 * 名称留空时按来源层生成一个能区分的默认名。
 */
export function qqPresetInputFromPromptLayer(item: PromptItem, name: string): QQPresetInput {
  const config: PromptConfig = {
    segments: item.segments.map((segment) => ({ ...segment })),
  };
  if (item.temperature !== undefined) config.temperature = item.temperature;
  if (item.maxTokens !== undefined) config.maxTokens = item.maxTokens;
  const trimmed = name.trim();
  return { name: trimmed === '' ? defaultPresetNameFromLayer(item) : trimmed, config };
}

/** 每行的编辑草稿：名称与预设先留在本地，点「保存」才 PATCH 回后端。 */
interface ConversationDraft {
  name: string;
  presetId: string;
}

/** 预设编辑器：id 为 null 时是新建，否则编辑已有预设。 */
interface PresetEditor {
  id: string | null;
  name: string;
  configText: string;
}

/** 只接受整数：空串与非纯数字返回 null，调用方负责报出是哪一项。 */
export function parseMemoryNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
}

function toPromptRole(raw: unknown): PromptSegment['role'] | null {
  return raw === 'system' || raw === 'user' ? raw : null;
}

function toPromptPlacement(raw: unknown): PromptSegment['placement'] | null {
  return raw === 'before' || raw === 'after' ? raw : null;
}

/**
 * 预设 JSON 文本框 → PromptConfig。保存前必须整份校验：段缺 id / role / placement 时
 * 后端会拒，前端先报出是第几段，用户才改得动。
 */
export function parsePresetConfig(text: string): PromptConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error('config 不是合法 JSON：' + (error instanceof Error ? error.message : String(error)));
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('config 必须是 JSON 对象，例如 { "segments": [] }');
  }
  const source = parsed as Record<string, unknown>;
  if (!Array.isArray(source.segments)) {
    throw new Error('config 必须包含 segments 数组（PromptConfig 的段列表）');
  }
  if (source.segments.length === 0) {
    throw new Error('config 至少要有一段：空预设存不进去，删空请直接取消');
  }
  const segments: PromptSegment[] = [];
  source.segments.forEach((entry, index) => {
    const label = '第 ' + String(index + 1) + ' 段';
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(label + '必须是 JSON 对象');
    }
    const segment = entry as Record<string, unknown>;
    const id = typeof segment.id === 'string' ? segment.id.trim() : '';
    if (id === '') throw new Error(label + '缺少非空的 id');
    const name = typeof segment.name === 'string' ? segment.name.trim() : '';
    if (name === '') throw new Error(label + '缺少非空的 name');
    const role = toPromptRole(segment.role);
    if (role === null) throw new Error(label + '的 role 只能是 system 或 user');
    const placement = toPromptPlacement(segment.placement);
    if (placement === null) throw new Error(label + '的 placement 只能是 before 或 after');
    if (typeof segment.content !== 'string') throw new Error(label + '的 content 必须是字符串');
    if (typeof segment.enabled !== 'boolean') throw new Error(label + '的 enabled 必须是 true / false');
    segments.push({
      id,
      name,
      role,
      content: segment.content,
      enabled: segment.enabled,
      placement,
      position: typeof segment.position === 'number' && Number.isFinite(segment.position) ? segment.position : index,
    });
  });
  const config: PromptConfig = { segments };
  if (source.temperature !== undefined) {
    if (typeof source.temperature !== 'number' || !Number.isFinite(source.temperature)) {
      throw new Error('temperature 必须是数字');
    }
    config.temperature = source.temperature;
  }
  if (source.maxTokens !== undefined) {
    if (typeof source.maxTokens !== 'number' || !Number.isFinite(source.maxTokens)) {
      throw new Error('maxTokens 必须是数字');
    }
    config.maxTokens = source.maxTokens;
  }
  return config;
}

function formatUpdatedAt(updatedAt: string): string {
  if (updatedAt === '') return '未知时间';
  const value = new Date(updatedAt);
  if (Number.isNaN(value.getTime())) return updatedAt;
  return value.toLocaleString('zh-CN', { hour12: false });
}

function describeQqError(error: unknown): string {
  if (error instanceof ApiError) {
    // 合并两边都有摘要时会撞 SUMMARY_CONFLICT（见 ports.ConversationDirectory.merge 的契约）。
    if (error.code === 'SUMMARY_CONFLICT') {
      return '合并失败：两个会话都已经有摘要；请先删掉其中一边的摘要，再重新绑定';
    }
    if (error.code === 'CONVERSATION_HAS_HISTORY') {
      return '来源会话里还有原文或摘要：勾选「合并历史与摘要」再绑定，或先把来源会话清空';
    }
    if (error.code === 'CONVERSATION_NOT_EMPTY') {
      return '这个会话里还有聊天原文，不能删除；先清空原文或保留会话';
    }
    if (error.code === 'DISCORD_CONVERSATION_MISMATCH') {
      return 'Discord 链接只能绑到它自己那条服务器 / 频道会话上';
    }
    if (error.status === 401) return describeError(error);
  }
  return '操作失败：' + describeError(error);
}

function describeLink(link: ConversationLink): string {
  return (
    CONVERSATION_PLATFORM_LABELS[link.platform] +
    ' · ' +
    CONVERSATION_LINK_KIND_LABELS[link.kind] +
    ' · ' +
    (link.displayName === '' ? link.externalId : link.displayName + '（' + link.externalId + '）')
  );
}

function describeMemory(config: ChannelMemoryConfig): string {
  const threshold =
    config.summaryEveryMessages === 0 ? '关闭自动总结' : '阈值 ' + String(config.summaryEveryMessages);
  return '窗口 ' + String(config.historyMaxMessages) + ' · ' + threshold;
}

function kindOptions(platform: ConversationPlatform): ConversationLinkKind[] {
  return platform === 'discord' ? ['discord_channel'] : ['qq_group', 'qq_c2c'];
}

export default function QqPage() {
  const [conversations, setConversations] = useState<ConversationRecord[]>([]);
  const [presets, setPresets] = useState<QQPreset[]>([]);
  const [promptLayers, setPromptLayers] = useState<PromptItem[]>([]);
  const [edits, setEdits] = useState<Record<string, ConversationDraft>>({});
  // 同一时刻只允许一件事在跑：所有写操作因此天然单飞。
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  // 新建 Discord 频道会话
  const [newGuildId, setNewGuildId] = useState('');
  const [newChannelId, setNewChannelId] = useState('');
  const [newName, setNewName] = useState('');

  // 绑定已有 QQ / Discord 链接
  const [bindTarget, setBindTarget] = useState('');
  const [bindPlatform, setBindPlatform] = useState<ConversationPlatform>('qq');
  const [bindKind, setBindKind] = useState<ConversationLinkKind>('qq_group');
  const [bindExternalId, setBindExternalId] = useState('');
  const [bindGuildId, setBindGuildId] = useState('');
  // 默认合并：QQ 与 Discord 互通的目标就是让两边看到同一份历史；
  // 不合并只在来源没有历史时才成立（后端会拒 CONVERSATION_HAS_HISTORY）。
  const [bindMerge, setBindMerge] = useState(true);

  // 记忆：选中一个会话后才显示表单
  const [memoryId, setMemoryId] = useState('');
  const [historyMax, setHistoryMax] = useState(String(MEMORY_DEFAULTS.historyMaxMessages));
  const [summaryEvery, setSummaryEvery] = useState(String(MEMORY_DEFAULTS.summaryEveryMessages));
  const [contextTool, setContextTool] = useState(false);
  const [memoryUpdatedAt, setMemoryUpdatedAt] = useState('');
  const [memoryLoaded, setMemoryLoaded] = useState(false);

  // QQ 预设
  const [presetEditor, setPresetEditor] = useState<PresetEditor | null>(null);
  const [importName, setImportName] = useState('');
  const [importText, setImportText] = useState('');
  const [copySource, setCopySource] = useState('');
  const [copyName, setCopyName] = useState('');

  useEffect(() => {
    void refreshAll();
    // 只在首次挂载时拉一遍；之后的刷新由各操作自己触发。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refreshAll(): Promise<void> {
    setBusy('refresh');
    setMessage('');
    setError('');
    try {
      const [convs, list, layers] = await Promise.all([
        api.listConversations(),
        api.listQqPresets(),
        api.listPrompts(),
      ]);
      applyConversations(convs);
      setPresets(list);
      setPromptLayers(layers);
      const first = layers[0];
      if (first !== undefined && !layers.some((item) => promptLayerKey(item) === copySource)) {
        setCopySource(promptLayerKey(first));
        setCopyName(defaultPresetNameFromLayer(first));
      }
    } catch (err) {
      setError(describeQqError(err));
    } finally {
      setBusy('');
    }
  }

  function applyConversations(items: ConversationRecord[]): void {
    setConversations(items);
    // 保留已有草稿（用户可能正改到一半），只为新出现的会话补一条。
    setEdits((prev) => {
      const next: Record<string, ConversationDraft> = {};
      for (const item of items) {
        next[item.id] = prev[item.id] ?? { name: item.name, presetId: item.presetId ?? '' };
      }
      return next;
    });
  }

  function replaceConversation(record: ConversationRecord): void {
    setConversations((prev) => prev.map((item) => (item.id === record.id ? record : item)));
    setEdits((prev) => ({ ...prev, [record.id]: { name: record.name, presetId: record.presetId ?? '' } }));
  }

  // POST 是幂等的 ensureLink：同一个频道重复新建会回同一条会话，不能再往后追一行。
  function upsertConversation(record: ConversationRecord): void {
    setConversations((prev) => {
      const exists = prev.some((item) => item.id === record.id);
      return exists ? prev.map((item) => (item.id === record.id ? record : item)) : [...prev, record];
    });
    setEdits((prev) => ({ ...prev, [record.id]: { name: record.name, presetId: record.presetId ?? '' } }));
  }

  function upsertPreset(preset: QQPreset): void {
    setPresets((prev) => {
      const exists = prev.some((item) => item.id === preset.id);
      return exists ? prev.map((item) => (item.id === preset.id ? preset : item)) : [...prev, preset];
    });
  }

  function updateDraft(id: string, patch: Partial<ConversationDraft>): void {
    setEdits((prev) => ({ ...prev, [id]: { ...(prev[id] ?? { name: '', presetId: '' }), ...patch } }));
  }

  async function createConversation(): Promise<void> {
    if (busy !== '') return;
    const guildId = newGuildId.trim();
    const channelId = newChannelId.trim();
    if (guildId === '' || channelId === '') {
      setError('新建会话需要服务器 ID 和频道 ID');
      return;
    }
    setBusy('create');
    setMessage('');
    setError('');
    const name = newName.trim();
    try {
      const record = await api.createConversation({
        platform: 'discord',
        kind: 'discord_channel',
        externalId: channelId,
        guildId,
        ...(name === '' ? {} : { name }),
      });
      upsertConversation(record);
      setNewGuildId('');
      setNewChannelId('');
      setNewName('');
      setMessage('已新建会话：' + (record.name === '' ? record.id : record.name));
    } catch (err) {
      setError(describeQqError(err));
    } finally {
      setBusy('');
    }
  }

  async function saveConversation(id: string): Promise<void> {
    if (busy !== '') return;
    const draft = edits[id];
    if (draft === undefined) return;
    const name = draft.name.trim();
    if (name === '') {
      setError('会话名称不能为空');
      return;
    }
    setBusy('save-conversation');
    setMessage('');
    setError('');
    try {
      const record = await api.updateConversation(id, {
        name,
        presetId: draft.presetId === '' ? null : draft.presetId,
      });
      replaceConversation(record);
      setMessage('已保存会话：' + name);
    } catch (err) {
      setError(describeQqError(err));
    } finally {
      setBusy('');
    }
  }

  async function deleteConversation(item: ConversationRecord): Promise<void> {
    if (busy !== '') return;
    const label = item.name === '' ? item.id : item.name;
    if (!window.confirm('确定删除会话「' + label + '」？链接与目录记录会一起移除，操作不可撤销。')) return;
    setBusy('delete-conversation');
    setMessage('');
    setError('');
    try {
      await api.deleteConversation(item.id);
      setConversations((prev) => prev.filter((row) => row.id !== item.id));
      setEdits((prev) => {
        const next = { ...prev };
        delete next[item.id];
        return next;
      });
      if (memoryId === item.id) {
        setMemoryId('');
        setMemoryLoaded(false);
      }
      setMessage('已删除会话：' + label);
    } catch (err) {
      setError(describeQqError(err));
    } finally {
      setBusy('');
    }
  }

  async function unlink(item: ConversationRecord, link: ConversationLink): Promise<void> {
    if (busy !== '') return;
    setBusy('unlink');
    setMessage('');
    setError('');
    try {
      await api.unlinkConversation(item.id, {
        platform: link.platform,
        kind: link.kind,
        externalId: link.externalId,
      });
      setConversations((prev) =>
        prev.map((row) =>
          row.id === item.id
            ? {
                ...row,
                links: row.links.filter(
                  (entry) =>
                    !(
                      entry.platform === link.platform &&
                      entry.kind === link.kind &&
                      entry.externalId === link.externalId
                    ),
                ),
              }
            : row,
        ),
      );
      setMessage('已解绑：' + describeLink(link));
    } catch (err) {
      setError(describeQqError(err));
    } finally {
      setBusy('');
    }
  }

  async function bind(): Promise<void> {
    if (busy !== '') return;
    const target = bindTarget;
    if (target === '') {
      setError('先选择要绑定到哪个会话');
      return;
    }
    const externalId = bindExternalId.trim();
    if (externalId === '') {
      setError('绑定需要外部 ID（Discord 频道 ID / QQ openid）');
      return;
    }
    const guildId = bindGuildId.trim();
    if (bindPlatform === 'discord' && guildId === '') {
      setError('绑定 Discord 频道还必须填服务器 ID（guildId）');
      return;
    }
    setBusy('bind');
    setMessage('');
    setError('');
    try {
      const record = await api.bindConversation(target, {
        platform: bindPlatform,
        kind: bindKind,
        externalId,
        ...(bindPlatform === 'discord' ? { guildId } : {}),
        ...(bindMerge ? { merge: true } : {}),
      });
      replaceConversation(record);
      setBindExternalId('');
      setBindMerge(true);
      setMessage('已绑定到会话：' + (record.name === '' ? record.id : record.name));
    } catch (err) {
      setError(describeQqError(err));
    } finally {
      setBusy('');
    }
  }

  function changeBindPlatform(platform: ConversationPlatform): void {
    setBindPlatform(platform);
    // 平台换了，旧的 kind 一定不匹配，直接落到该平台的第一个合法取值。
    setBindKind(kindOptions(platform)[0] ?? 'qq_group');
    if (platform === 'qq') setBindGuildId('');
  }

  async function readMemory(item: ConversationRecord): Promise<void> {
    setBusy('memory-read');
    setMessage('');
    setError('');
    try {
      const config = await api.fetchConversationMemory(item.id);
      setHistoryMax(String(config.historyMaxMessages));
      setSummaryEvery(String(config.summaryEveryMessages));
      setContextTool(config.contextTool);
      setMemoryUpdatedAt(config.updatedAt);
      setMemoryLoaded(true);
      setMessage(
        config.updatedAt === ''
          ? '这个会话还没单独设置过，显示的是默认值'
          : '已读取记忆：' + describeMemory(config) + '（更新于 ' + formatUpdatedAt(config.updatedAt) + '）',
      );
    } catch (err) {
      setMemoryLoaded(false);
      setError(describeQqError(err));
    } finally {
      setBusy('');
    }
  }

  function selectMemory(item: ConversationRecord): void {
    if (busy !== '') return;
    setMemoryId(item.id);
    setMemoryLoaded(false);
    setMemoryUpdatedAt('');
    setMessage('');
    setError('');
    void readMemory(item);
  }

  async function saveMemory(): Promise<void> {
    if (busy !== '') return;
    const item = conversations.find((row) => row.id === memoryId);
    if (item === undefined) {
      setError('先选择一个会话再保存记忆');
      return;
    }
    if (!memoryLoaded) {
      setError('记忆还没读回来：请重新点「记忆」载入后再保存');
      return;
    }
    const history = parseMemoryNumber(historyMax);
    if (history === null || history < MEMORY_MIN) {
      setError('注入条数必须是 ≥ 2 的整数');
      return;
    }
    const threshold = parseMemoryNumber(summaryEvery);
    if (threshold === null || (threshold !== 0 && threshold < MEMORY_MIN)) {
      setError('自动总结阈值只能填 0（关闭）或 ≥ 2 的整数');
      return;
    }
    setBusy('memory-save');
    setMessage('');
    setError('');
    try {
      const saved = await api.saveConversationMemory(item.id, {
        historyMaxMessages: history,
        summaryEveryMessages: threshold,
        contextTool,
      });
      setHistoryMax(String(saved.historyMaxMessages));
      setSummaryEvery(String(saved.summaryEveryMessages));
      setContextTool(saved.contextTool);
      setMemoryUpdatedAt(saved.updatedAt);
      setMemoryLoaded(true);
      setMessage('已保存记忆：' + describeMemory(saved) + '（更新于 ' + formatUpdatedAt(saved.updatedAt) + '）');
    } catch (err) {
      setError(describeQqError(err));
    } finally {
      setBusy('');
    }
  }

  async function resetMemory(): Promise<void> {
    if (busy !== '') return;
    const item = conversations.find((row) => row.id === memoryId);
    if (item === undefined) return;
    if (
      !window.confirm(
        '确定删掉会话「' +
          (item.name === '' ? item.id : item.name) +
          '」的单独记忆设置？恢复后回到窗口 ' +
          String(MEMORY_DEFAULTS.historyMaxMessages) +
          ' · 阈值 ' +
          String(MEMORY_DEFAULTS.summaryEveryMessages) +
          '。',
      )
    ) {
      return;
    }
    setBusy('memory-reset');
    setMessage('');
    setError('');
    try {
      await api.deleteConversationMemory(item.id);
      setHistoryMax(String(MEMORY_DEFAULTS.historyMaxMessages));
      setSummaryEvery(String(MEMORY_DEFAULTS.summaryEveryMessages));
      setContextTool(false);
      setMemoryUpdatedAt('');
      setMemoryLoaded(true);
      setMessage('已恢复默认记忆参数（该会话不再有单独设置）');
    } catch (err) {
      setError(describeQqError(err));
    } finally {
      setBusy('');
    }
  }

  function startPresetCreate(): void {
    setMessage('');
    setError('');
    setPresetEditor({ id: null, name: '', configText: NEW_PRESET_CONFIG_TEXT });
  }

  function startPresetEdit(preset: QQPreset): void {
    setMessage('');
    setError('');
    setPresetEditor({
      id: preset.id,
      name: preset.name,
      configText: JSON.stringify(preset.config, null, 2),
    });
  }

  function changeCopySource(key: string): void {
    setCopySource(key);
    const layer = promptLayers.find((item) => promptLayerKey(item) === key);
    if (layer !== undefined) setCopyName(defaultPresetNameFromLayer(layer));
  }

  async function copyPresetFromPrompt(): Promise<void> {
    if (busy !== '') return;
    const layer = promptLayers.find((item) => promptLayerKey(item) === copySource);
    if (layer === undefined) {
      setError('先选择一个 Discord 提示词层');
      return;
    }
    if (layer.segments.length === 0) {
      setError('这个提示词层没有段，复制不出预设');
      return;
    }
    setBusy('preset-copy');
    setMessage('');
    setError('');
    try {
      const saved = await api.createQqPreset(qqPresetInputFromPromptLayer(layer, copyName));
      upsertPreset(saved);
      setMessage(
        '已从 ' + describePromptLayer(layer) + ' 复制 QQ 预设：' + (saved.name === '' ? saved.id : saved.name),
      );
    } catch (err) {
      setError(describeQqError(err));
    } finally {
      setBusy('');
    }
  }

  async function savePreset(): Promise<void> {
    if (busy !== '' || presetEditor === null) return;
    const name = presetEditor.name.trim();
    if (name === '') {
      setError('预设名称不能为空');
      return;
    }
    let config: PromptConfig;
    try {
      config = parsePresetConfig(presetEditor.configText);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    setBusy('preset-save');
    setMessage('');
    setError('');
    try {
      const saved =
        presetEditor.id === null
          ? await api.createQqPreset({ name, config })
          : await api.updateQqPreset(presetEditor.id, { name, config });
      upsertPreset(saved);
      setPresetEditor(null);
      setMessage('已保存 QQ 预设：' + (saved.name === '' ? saved.id : saved.name));
    } catch (err) {
      setError(describeQqError(err));
    } finally {
      setBusy('');
    }
  }

  async function deletePreset(preset: QQPreset): Promise<void> {
    if (busy !== '') return;
    const label = preset.name === '' ? preset.id : preset.name;
    if (!window.confirm('确定删除 QQ 预设「' + label + '」？删除后不可恢复，仍选中它的会话请在会话里重新选一个预设。')) {
      return;
    }
    setBusy('preset-delete');
    setMessage('');
    setError('');
    try {
      await api.deleteQqPreset(preset.id);
      setPresets((prev) => prev.filter((item) => item.id !== preset.id));
      if (presetEditor !== null && presetEditor.id === preset.id) setPresetEditor(null);
      setMessage('已删除 QQ 预设：' + label);
    } catch (err) {
      setError(describeQqError(err));
    } finally {
      setBusy('');
    }
  }

  async function importPreset(): Promise<void> {
    if (busy !== '') return;
    const raw = importText.trim();
    if (raw === '') {
      setError('先粘贴酒馆预设 JSON，或选择一份 .json 文件');
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      setError('导入内容不是合法 JSON：' + (err instanceof Error ? err.message : String(err)));
      return;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      setError('酒馆预设 JSON 必须是一个对象');
      return;
    }
    const fromJson = typeof (parsed as Record<string, unknown>).name === 'string' ? String((parsed as Record<string, unknown>).name).trim() : '';
    const name = importName.trim() === '' ? (fromJson === '' ? '导入的 QQ 预设' : fromJson) : importName.trim();
    setBusy('preset-import');
    setMessage('');
    setError('');
    try {
      const saved = await api.importQqPreset({ name, preset: parsed });
      upsertPreset(saved);
      setImportText('');
      setImportName('');
      setMessage('已导入 QQ 预设：' + (saved.name === '' ? saved.id : saved.name));
    } catch (err) {
      setError(describeQqError(err));
    } finally {
      setBusy('');
    }
  }

  async function pickImportFile(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    // 允许下一次选同一个文件：input 的 value 不清空就不会再触发 change。
    event.target.value = '';
    if (file === undefined) return;
    try {
      const text = await file.text();
      setImportText(text);
      if (importName.trim() === '') {
        setImportName(file.name.replace(/\.json$/i, ''));
      }
      setMessage('已读取文件：' + file.name + '，确认后点「导入」');
      setError('');
    } catch (err) {
      setError('读取文件失败：' + (err instanceof Error ? err.message : String(err)));
    }
  }

  const memoryItem = conversations.find((row) => row.id === memoryId);
  const copyLayer = promptLayers.find((item) => promptLayerKey(item) === copySource);
  const memoryBusy = busy.startsWith('memory');
  const saveMemoryDisabled = busy !== '' || memoryItem === undefined || !memoryLoaded;

  return (
    <div className="page qq">
      {message === '' ? null : <p className="ok qq-status">{message}</p>}
      {error === '' ? null : <p className="error qq-status">{error}</p>}

      <div className="qq-col">
        <section className="card">
          <h2>会话</h2>
          <p className="hint">
            一个会话 = 一份共享的历史与摘要。Discord 会话的记忆键恒为真实「服务器 / 频道」；QQ 群和单聊先用合成键
            （qq:group / qq:c2c + openid）存，绑定到 Discord 会话后 QQ 来源的数据会并入 Discord 的键。
          </p>
          {conversations.length === 0 ? (
            <p className="hint">还没有会话：QQ 群 / 单聊会在第一条消息时自动登记；Discord 频道可以用下面的表单手动登记。</p>
          ) : (
            <ul className="items qq-list">
              {conversations.map((item) => {
                const draft = edits[item.id] ?? { name: item.name, presetId: item.presetId ?? '' };
                return (
                  <li key={item.id}>
                    <div className="qq-conv-head">
                      <strong className="qq-conv-name">{item.name === '' ? '（未命名会话）' : item.name}</strong>
                      <span className="badge" title="记忆键的 guild_id">
                        {item.memoryGuildId}
                      </span>
                      <span className="badge" title="记忆键的 channel_id">
                        {item.memoryChannelId}
                      </span>
                    </div>
                    <div className="qq-links">
                      {item.links.length === 0 ? (
                        <span className="hint">还没有绑定任何链接</span>
                      ) : (
                        item.links.map((link) => (
                          <span
                            key={link.platform + ':' + link.kind + ':' + link.externalId}
                            className="qq-link"
                          >
                            <span>{describeLink(link)}</span>
                            <button
                              type="button"
                              className="link"
                              disabled={busy !== ''}
                              onClick={() => void unlink(item, link)}
                            >
                              解绑
                            </button>
                          </span>
                        ))
                      )}
                    </div>
                    <div className="row qq-conv-edit">
                      <label className="field">
                        <span>名称</span>
                        <input
                          type="text"
                          value={draft.name}
                          placeholder="例如 主聊天频道"
                          onChange={(event) => updateDraft(item.id, { name: event.target.value })}
                        />
                      </label>
                      <label className="field">
                        <span>QQ 预设（只影响 QQ）</span>
                        <select
                          value={draft.presetId}
                          onChange={(event) => updateDraft(item.id, { presetId: event.target.value })}
                        >
                          <option value="">（未选择，QQ 侧走内置默认）</option>
                          {presets.map((preset) => (
                            <option key={preset.id} value={preset.id}>
                              {preset.name === '' ? preset.id : preset.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <div className="actions qq-conv-actions">
                        <button
                          type="button"
                          className="primary small"
                          disabled={busy !== ''}
                          onClick={() => void saveConversation(item.id)}
                        >
                          保存
                        </button>
                        <button
                          type="button"
                          className="small"
                          disabled={busy !== ''}
                          onClick={() => selectMemory(item)}
                        >
                          记忆
                        </button>
                        <button
                          type="button"
                          className="danger small"
                          disabled={busy !== ''}
                          onClick={() => void deleteConversation(item)}
                        >
                          删除
                        </button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          <h3>新建 Discord 频道会话</h3>
          <div className="row qq-create">
            <label className="field">
              <span>服务器 ID（guildId）</span>
              <input
                type="text"
                value={newGuildId}
                placeholder="例如 1234567890123456789"
                onChange={(event) => setNewGuildId(event.target.value)}
              />
            </label>
            <label className="field">
              <span>频道 ID（channelId）</span>
              <input
                type="text"
                value={newChannelId}
                placeholder="例如 9876543210987654321"
                onChange={(event) => setNewChannelId(event.target.value)}
              />
            </label>
            <label className="field">
              <span>名称（可选）</span>
              <input
                type="text"
                value={newName}
                placeholder="留空 = 服务器按频道自动命名"
                onChange={(event) => setNewName(event.target.value)}
              />
            </label>
            <div className="actions qq-inline-actions">
              <button type="button" className="primary" disabled={busy !== ''} onClick={() => void createConversation()}>
                新建
              </button>
            </div>
          </div>

          <h3>绑定已有链接</h3>
          <p className="hint">
            把一条已经存在于 QQ 群 / 单聊的链接（或 Discord 频道）绑到会话上；默认勾选「合并」，会把来源会话的历史与摘要并入目标会话。
          </p>
          <div className="row qq-bind">
            <label className="field">
              <span>目标会话</span>
              <select value={bindTarget} onChange={(event) => setBindTarget(event.target.value)}>
                <option value="">（选择会话）</option>
                {conversations.map((item) => (
                  <option key={item.id} value={item.id}>
                    {(item.name === '' ? item.id : item.name) + ' · ' + item.memoryGuildId + '/' + item.memoryChannelId}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>平台</span>
              <select
                value={bindPlatform}
                onChange={(event) => changeBindPlatform(event.target.value as ConversationPlatform)}
              >
                <option value="qq">{CONVERSATION_PLATFORM_LABELS.qq}</option>
                <option value="discord">{CONVERSATION_PLATFORM_LABELS.discord}</option>
              </select>
            </label>
            <label className="field">
              <span>链接类型</span>
              <select value={bindKind} onChange={(event) => setBindKind(event.target.value as ConversationLinkKind)}>
                {kindOptions(bindPlatform).map((kind) => (
                  <option key={kind} value={kind}>
                    {CONVERSATION_LINK_KIND_LABELS[kind]}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>外部 ID（QQ openid / Discord 频道 ID）</span>
              <input
                type="text"
                value={bindExternalId}
                placeholder="例如 0A1B2C3D4E5F60718293A4B5C6D7E8F9"
                onChange={(event) => setBindExternalId(event.target.value)}
              />
            </label>
            {bindPlatform === 'discord' ? (
              <label className="field">
                <span>服务器 ID（guildId）</span>
                <input
                  type="text"
                  value={bindGuildId}
                  placeholder="Discord 频道必须带服务器 ID"
                  onChange={(event) => setBindGuildId(event.target.value)}
                />
              </label>
            ) : null}
          </div>
          <label className="row checkbox">
            <input type="checkbox" checked={bindMerge} onChange={(event) => setBindMerge(event.target.checked)} />
            <span>合并历史与摘要（两边都有摘要时会报冲突，需要先删掉一边的摘要）</span>
          </label>
          <div className="actions">
            <button type="button" className="primary" disabled={busy !== ''} onClick={() => void bind()}>
              绑定
            </button>
          </div>
        </section>

        <section className="card">
          <h2>记忆</h2>
          {memoryItem === undefined ? (
            <p className="hint">在上面点某个会话的「记忆」按钮：这里会载入它的记忆参数，保存后立即对 QQ 与 Discord 两侧生效。</p>
          ) : (
            <>
              <p className="hint">
                会话：{memoryItem.name === '' ? memoryItem.id : memoryItem.name} · 规范记忆键 {memoryItem.memoryGuildId} /{' '}
                {memoryItem.memoryChannelId}
                {memoryUpdatedAt === '' ? ' · 未单独设置（显示默认值）' : ' · 更新于 ' + formatUpdatedAt(memoryUpdatedAt)}
              </p>
              <div className="row">
                <label className="field">
                  <span>注入条数（默认 50，≥ 2，不设上限）</span>
                  <input
                    type="number"
                    min={MEMORY_MIN}
                    step={1}
                    value={historyMax}
                    onChange={(event) => setHistoryMax(event.target.value)}
                  />
                </label>
                <label className="field">
                  <span>自动总结阈值（默认 50；0 = 关闭，否则 ≥ 2）</span>
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={summaryEvery}
                    onChange={(event) => setSummaryEvery(event.target.value)}
                  />
                </label>
              </div>
              <label className="row checkbox">
                <input
                  type="checkbox"
                  checked={contextTool}
                  onChange={(event) => setContextTool(event.target.checked)}
                />
                <span>上下文工具模式（把预设与历史塞进 context 工具，只发一条用户消息）</span>
              </label>
              <div className="actions">
                <button
                  type="button"
                  className="primary"
                  disabled={saveMemoryDisabled}
                  onClick={() => void saveMemory()}
                >
                  {busy === 'memory-save' ? '保存中…' : '保存记忆'}
                </button>
                <button
                  type="button"
                  className="danger"
                  disabled={busy !== '' || memoryItem === undefined}
                  onClick={() => void resetMemory()}
                >
                  {busy === 'memory-reset' ? '恢复中…' : '恢复默认'}
                </button>
                <button
                  type="button"
                  className="ghost"
                  disabled={memoryBusy}
                  onClick={() => {
                    setMemoryId('');
                    setMemoryLoaded(false);
                    setMemoryUpdatedAt('');
                  }}
                >
                  关闭
                </button>
              </div>
            </>
          )}
        </section>
      </div>

      <section className="card">
        <h2>QQ 预设</h2>
        <p className="hint">
          这里的命名预设只被 QQ 群 / 单聊读取；Discord 仍走原来的三层提示词（默认 / 服务器 / 频道），不受影响。
        </p>
        {presets.length === 0 ? (
          <p className="hint">还没有 QQ 预设：点「新建预设」或从下面导入一份酒馆预设。</p>
        ) : (
          <ul className="items qq-preset-list">
            {presets.map((preset) => (
              <li key={preset.id}>
                <div className="qq-preset-head">
                  <strong>{preset.name === '' ? preset.id : preset.name}</strong>
                  <span className="badge">{String(preset.config.segments.length)} 段</span>
                  <span className="hint">
                    {preset.updatedAt === '' ? '时间未知' : formatUpdatedAt(preset.updatedAt)}
                  </span>
                </div>
                <div className="actions">
                  <button
                    type="button"
                    className="small"
                    disabled={busy !== ''}
                    onClick={() => startPresetEdit(preset)}
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    className="danger small"
                    disabled={busy !== ''}
                    onClick={() => void deletePreset(preset)}
                  >
                    删除
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className="actions">
          <button type="button" className="primary" disabled={busy !== ''} onClick={startPresetCreate}>
            新建预设
          </button>
        </div>

        <h3>从 Discord 提示词复制</h3>
        <p className="hint">
          选一个 Discord 提示词层（全局 / 服务器 / 频道），把它的段和采样参数整份复制成新的 QQ 预设；源层和 Discord 都不动。
        </p>
        {promptLayers.length === 0 ? (
          <p className="hint">Discord 还没有配置任何提示词层；先到「提示词」页配好一层，再回来复制。</p>
        ) : (
          <>
            <div className="row">
              <label className="field">
                <span>源提示词层</span>
                <select value={copySource} onChange={(event) => changeCopySource(event.target.value)}>
                  {promptLayers.map((item) => (
                    <option key={promptLayerKey(item)} value={promptLayerKey(item)}>
                      {describePromptLayer(item)}（{String(item.segments.length)} 段）
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>新预设名称</span>
                <input
                  type="text"
                  value={copyName}
                  placeholder="留空 = 按来源层自动命名"
                  onChange={(event) => setCopyName(event.target.value)}
                />
              </label>
            </div>
            <div className="actions">
              <button
                type="button"
                className="primary"
                disabled={busy !== '' || copyLayer === undefined || copyLayer.segments.length === 0}
                onClick={() => void copyPresetFromPrompt()}
              >
                {busy === 'preset-copy' ? '复制中…' : '复制为 QQ 预设'}
              </button>
            </div>
            {copyLayer === undefined ? null : (
              <p className="hint">
                将复制 {String(copyLayer.segments.length)} 段
                {copyLayer.temperature === undefined ? '' : ' · temperature ' + String(copyLayer.temperature)}
                {copyLayer.maxTokens === undefined ? '' : ' · maxTokens ' + String(copyLayer.maxTokens)}
              </p>
            )}
          </>
        )}

        {presetEditor === null ? null : (
          <form
            className="qq-editor"
            onSubmit={(event) => {
              event.preventDefault();
              void savePreset();
            }}
          >
            <h3>{presetEditor.id === null ? '新建 QQ 预设' : '编辑 QQ 预设'}</h3>
            <label className="field">
              <span>名称</span>
              <input
                type="text"
                value={presetEditor.name}
                placeholder="例如 群里的人格预设"
                onChange={(event) => setPresetEditor({ ...presetEditor, name: event.target.value })}
              />
            </label>
            <label className="field">
              <span>config JSON（PromptConfig：必须有 segments 数组，段含 id / role / placement / content / enabled）</span>
              <textarea
                className="qq-json"
                rows={16}
                value={presetEditor.configText}
                onChange={(event) => setPresetEditor({ ...presetEditor, configText: event.target.value })}
              />
            </label>
            <div className="actions">
              <button type="submit" className="primary" disabled={busy !== ''}>
                {busy === 'preset-save' ? '保存中…' : '保存预设'}
              </button>
              <button type="button" className="ghost" disabled={busy !== ''} onClick={() => setPresetEditor(null)}>
                取消
              </button>
            </div>
          </form>
        )}

        <h3>导入酒馆预设</h3>
        <p className="hint">
          粘贴 SillyTavern 预设 JSON（或选一份 .json 文件），服务端会把它转成 QQ 专用命名预设；导入的是新预设，不会覆盖已有条目。
        </p>
        <div className="row">
          <label className="field">
            <span>预设名称（留空 = 用 JSON 里的 name 或文件名）</span>
            <input
              type="text"
              value={importName}
              placeholder="例如 酒馆导入 · 群聊"
              onChange={(event) => setImportName(event.target.value)}
            />
          </label>
          <label className="field qq-file">
            <span>选择 .json 文件</span>
            <input type="file" accept=".json,application/json" onChange={(event) => void pickImportFile(event)} />
          </label>
        </div>
        <label className="field">
          <span>酒馆预设 JSON</span>
          <textarea
            className="qq-json"
            rows={10}
            value={importText}
            placeholder='{"name": "…", "prompts": [...], "prompt_order": [...]}'
            onChange={(event) => setImportText(event.target.value)}
          />
        </label>
        <div className="actions">
          <button
            type="button"
            className="primary"
            disabled={busy !== '' || importText.trim() === ''}
            onClick={() => void importPreset()}
          >
            {busy === 'preset-import' ? '导入中…' : '导入'}
          </button>
        </div>
      </section>
    </div>
  );
}
