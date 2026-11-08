import { useEffect, useState } from 'react';
import {
  ApiError,
  BODY_EMOJI_GUIDE_MAX_CHARS,
  PROVIDER_IDS,
  REACTION_GUIDE_MAX_CHARS,
  REACTION_MODEL_DEFAULTS,
  REACTION_TEMPLATE_MAX_CHARS,
  REACTION_TEMPLATE_VARS,
  deleteBodyEmojiGuide,
  deleteEmojiAlias,
  deleteReactionGuide,
  deleteReactionTemplate,
  describeBodyEmojiRejection,
  describeEmojis,
  describeError,
  describeGuideRejection,
  describeScopeTarget,
  describeTemplateRejection,
  describeTemplateVar,
  fetchBodyEmojiGuides,
  fetchEmojiAliases,
  fetchEmojiDescriptions,
  fetchLiveEmojis,
  fetchReactionGuides,
  fetchReactionModel,
  fetchReactionTemplates,
  listTemplateVars,
  normalizeScopeId,
  saveBodyEmojiGuide,
  saveEmojiAlias,
  saveReactionGuide,
  saveReactionModel,
  saveReactionTemplate,
  type BodyEmojiGuideItem,
  type EmojiAlias,
  type EmojiDescription,
  type LiveEmoji,
  type ProviderId,
  type ReactionGuideItem,
  type ReactionModelConfig,
  type ReactionTemplateItem,
  type Scope,
} from '../api';
import ScopeField from '../components/ScopeField';

// 下拉框给中文说明，值仍是后端枚举（§21.5）。
const PROVIDER_LABELS: Record<ProviderId, string> = {
  'openai-compat': 'openai-compat（OpenAI 兼容接口 / 中转站）',
  anthropic: 'anthropic（Claude）',
  gemini: 'gemini（Google Gemini）',
};

// §23.6 已认描述一次只渲染前 50 条，避免上千个表情把页面拉成无限长。
const EMOJI_PREVIEW_LIMIT = 50;

// §24.8 服务器 ID 是边打边生效的输入框，停下 400ms 再拉表情与别名，免得每敲一位就打两次接口。
const ALIAS_LOAD_DELAY = 400;

// 切 Tab 会卸载本组件，上次填的服务器 ID 存在模块作用域里（不落 localStorage，刷新页面即清空）。
let rememberedGuildId = '';

// 后端这两条只回错误码（§23.6），翻成中文再显示，不把码直接甩给用户。
function describeEmojiError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'BAD_GUILD_ID') return '服务器 ID 不合法：请填纯数字的服务器 ID';
    if (error.code === 'DESCRIBE_UNAVAILABLE') return '服务端没有可用的表情描述能力（没有配置视觉模型）';
    // 401 的 message 本身就是中文（登录已失效），不再加前缀。
    if (error.status === 401) return describeError(error);
  }
  return '认表情失败：' + describeError(error);
}

// §24.6 别名四条路由的错误码同样只回码，翻成中文再显示。
function describeAliasError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'BAD_GUILD_ID') return '服务器 ID 不合法：请填纯数字的服务器 ID';
    if (error.code === 'BAD_ALIAS') return '别名不合法：1–24 个字符，不能含冒号、空白、尖括号';
    if (error.code === 'BAD_EMOJI') return '目标表情不合法：请从下拉里选该服务器的真实表情';
    if (error.code === 'EMOJI_LIST_UNAVAILABLE') return '服务端没有接上 Discord 表情清单，暂时无法选目标表情';
    if (error.code === 'EMOJI_LIST_FAILED') return '拉取该服务器表情失败：确认机器人仍在该服务器里';
    // 401 的 message 本身就是中文（登录已失效），不再加前缀。
    if (error.status === 401) return describeError(error);
  }
  return '表情别名失败：' + describeError(error);
}

// 门牌 reaction-guide-1 / reaction-template-1：一层的 key 就是 scope + scopeId（global 的 scopeId 固定空串）。
function scopeKey(scope: Scope, scopeId: string): string {
  return scope + ':' + normalizeScopeId(scope, scopeId);
}

// 换层时按同一个 key 找回这一层已保存的文案，找不到就是这一层没有配置。
function findGuide(items: ReactionGuideItem[], scope: Scope, scopeId: string): ReactionGuideItem | undefined {
  const target = normalizeScopeId(scope, scopeId);
  return items.find((item) => item.scope === scope && item.scopeId === target);
}

function findTemplate(
  items: ReactionTemplateItem[],
  scope: Scope,
  scopeId: string,
): ReactionTemplateItem | undefined {
  const target = normalizeScopeId(scope, scopeId);
  return items.find((item) => item.scope === scope && item.scopeId === target);
}

function findBodyEmoji(
  items: BodyEmojiGuideItem[],
  scope: Scope,
  scopeId: string,
): BodyEmojiGuideItem | undefined {
  const target = normalizeScopeId(scope, scopeId);
  return items.find((item) => item.scope === scope && item.scopeId === target);
}

// 6 个占位符各自展开成什么（键是不带花括号的变量名，跟服务端 vars 同一套写法）；
// 服务端哪天多回一个没见过的，就如实说是新占位符，别硬猜它的内容。
const TEMPLATE_VAR_HINTS: Record<string, string> = {
  最近对话: '＝ 最近 20 条聊天记录（带发言人名字，按时间正序）',
  对方的消息: '＝ 这次要回复的那条消息原文',
  我的回复: '＝ 我准备发出去的那句回复',
  自定义表情: '＝ 本服务器所有自定义表情的名字与 ID',
  可贴表情的消息: '＝ 最近 20 条里能贴表情的消息（带可用的消息 ID）',
  表情规则: '＝ 上面「贴表情提示词」正文的一份拷贝（默认不写，写了就是重复一份）',
};

function templateVarHint(name: string): string {
  return TEMPLATE_VAR_HINTS[name] ?? '＝ 服务端新增的占位符，页面还没有它的说明';
}

// 只到秒：库里是 ISO，毫秒对排查没意义，还会把列表行撑宽。
function formatUpdatedAt(updatedAt: string): string {
  if (updatedAt === '') return '未知时间';
  const value = new Date(updatedAt);
  if (Number.isNaN(value.getTime())) return updatedAt;
  return value.toLocaleString('zh-CN', { hour12: false });
}

export default function ReactionPage() {
  const [enabled, setEnabled] = useState(REACTION_MODEL_DEFAULTS.enabled);
  const [provider, setProvider] = useState<ProviderId>(REACTION_MODEL_DEFAULTS.provider);
  const [model, setModel] = useState(REACTION_MODEL_DEFAULTS.model);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [guildId, setGuildId] = useState(rememberedGuildId);
  const [emojiItems, setEmojiItems] = useState<EmojiDescription[]>([]);
  const [emojiBusy, setEmojiBusy] = useState<'' | 'new' | 'all'>('');
  const [emojiMessage, setEmojiMessage] = useState('');
  const [emojiError, setEmojiError] = useState('');
  const [aliasItems, setAliasItems] = useState<EmojiAlias[]>([]);
  const [liveEmojis, setLiveEmojis] = useState<LiveEmoji[]>([]);
  const [aliasDraft, setAliasDraft] = useState('');
  const [targetEmojiId, setTargetEmojiId] = useState('');
  const [aliasBusy, setAliasBusy] = useState<'' | 'add' | 'remove'>('');
  const [aliasMessage, setAliasMessage] = useState('');
  const [aliasError, setAliasError] = useState('');
  const [guideScope, setGuideScope] = useState<Scope>('global');
  const [guideScopeId, setGuideScopeId] = useState('');
  const [guidePrompt, setGuidePrompt] = useState('');
  const [guideItems, setGuideItems] = useState<ReactionGuideItem[]>([]);
  const [guideDefault, setGuideDefault] = useState('');
  const [guideBusy, setGuideBusy] = useState<'' | 'save' | 'delete'>('');
  const [guideMessage, setGuideMessage] = useState('');
  const [guideError, setGuideError] = useState('');
  const [bodyScope, setBodyScope] = useState<Scope>('global');
  const [bodyScopeId, setBodyScopeId] = useState('');
  const [bodyPrompt, setBodyPrompt] = useState('');
  const [bodyItems, setBodyItems] = useState<BodyEmojiGuideItem[]>([]);
  const [bodySuggestion, setBodySuggestion] = useState('');
  const [bodyBusy, setBodyBusy] = useState<'' | 'save' | 'delete'>('');
  const [bodyMessage, setBodyMessage] = useState('');
  const [bodyError, setBodyError] = useState('');
  const [templateScope, setTemplateScope] = useState<Scope>('global');
  const [templateScopeId, setTemplateScopeId] = useState('');
  const [templateDraft, setTemplateDraft] = useState('');
  const [templateItems, setTemplateItems] = useState<ReactionTemplateItem[]>([]);
  const [templateDefault, setTemplateDefault] = useState('');
  const [templateVars, setTemplateVars] = useState<string[]>(REACTION_TEMPLATE_VARS);
  const [templateBusy, setTemplateBusy] = useState<'' | 'save' | 'delete'>('');
  const [templateMessage, setTemplateMessage] = useState('');
  const [templateError, setTemplateError] = useState('');

  useEffect(() => {
    void load();
    void loadGuides();
    void loadBodyEmojiGuides();
    void loadTemplates();
    const remembered = rememberedGuildId.trim();
    if (remembered !== '') {
      void refreshDescriptions(remembered).catch((err: unknown) => setEmojiError(describeEmojiError(err)));
    }
  }, []);

  useEffect(() => {
    const target = guildId.trim();
    // 换了服务器 ID 就不是同一批表情了，已选的目标作废。
    setTargetEmojiId('');
    if (target === '') {
      setAliasItems([]);
      setLiveEmojis([]);
      return;
    }
    const timer = window.setTimeout(() => void loadAliases(target), ALIAS_LOAD_DELAY);
    return () => window.clearTimeout(timer);
  }, [guildId]);

  function apply(config: ReactionModelConfig): void {
    setEnabled(config.enabled);
    setProvider(config.provider);
    setModel(config.model);
  }

  async function load(): Promise<void> {
    try {
      apply(await fetchReactionModel());
    } catch (err) {
      setError(describeError(err));
    }
  }

  async function save(): Promise<void> {
    if (busy) return;
    setMessage('');
    setError('');
    const trimmed = model.trim();
    // 后端对 enabled:true + 空 model 一律 400，先在前端说清楚。
    if (enabled && trimmed === '') {
      setError('启用表情模型后必须填写模型名称');
      return;
    }
    setBusy(true);
    try {
      apply(await saveReactionModel({ enabled, provider, model: trimmed }));
      setMessage('已保存');
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  function updateGuildId(next: string): void {
    rememberedGuildId = next;
    setGuildId(next);
  }

  async function refreshDescriptions(target: string): Promise<void> {
    setEmojiItems(await fetchEmojiDescriptions(target));
  }

  async function describe(force: boolean): Promise<void> {
    const target = guildId.trim();
    if (emojiBusy !== '' || target === '') return;
    // 全部重认会覆盖已有的中文描述，先要一次明确确认。
    if (force && !window.confirm('全部重认会覆盖已有的中文描述，确定继续？')) return;
    setEmojiBusy(force ? 'all' : 'new');
    setEmojiMessage('');
    setEmojiError('');
    try {
      const result = await describeEmojis(target, force);
      setEmojiMessage('已认 ' + String(result.described) + ' 个，失败 ' + String(result.failed) + ' 个');
      try {
        await refreshDescriptions(target);
      } catch (err) {
        setEmojiError('描述已生成，但刷新列表失败：' + describeError(err));
      }
    } catch (err) {
      setEmojiError(describeEmojiError(err));
    } finally {
      setEmojiBusy('');
    }
  }

  async function loadAliases(target: string): Promise<void> {
    setAliasError('');
    try {
      // 先别名再表情：后端没注入表情清单（501）时别名列表照样显示出来。
      setAliasItems(await fetchEmojiAliases(target));
      setLiveEmojis(await fetchLiveEmojis(target));
    } catch (err) {
      setAliasError(describeAliasError(err));
    }
  }

  async function addAlias(): Promise<void> {
    const target = guildId.trim();
    const alias = aliasDraft.trim();
    const picked = liveEmojis.find((item) => item.id === targetEmojiId);
    if (aliasBusy !== '' || target === '' || alias === '' || picked === undefined) return;
    setAliasBusy('add');
    setAliasMessage('');
    setAliasError('');
    try {
      const saved = await saveEmojiAlias({ guildId: target, alias, emojiId: picked.id, emojiName: picked.name });
      setAliasDraft('');
      setAliasMessage('已添加：' + saved.alias + ' → ' + saved.emojiName + '(' + saved.emojiId + ')');
      await loadAliases(target);
    } catch (err) {
      setAliasError(describeAliasError(err));
    } finally {
      setAliasBusy('');
    }
  }

  async function removeAlias(alias: string): Promise<void> {
    const target = guildId.trim();
    if (aliasBusy !== '' || target === '') return;
    setAliasBusy('remove');
    setAliasMessage('');
    setAliasError('');
    try {
      await deleteEmojiAlias(target, alias);
      setAliasMessage('已删除别名：' + alias);
      await loadAliases(target);
    } catch (err) {
      setAliasError(describeAliasError(err));
    } finally {
      setAliasBusy('');
    }
  }

  function currentGuideTarget(): { scope: Scope; scopeId: string } {
    return { scope: guideScope, scopeId: normalizeScopeId(guideScope, guideScopeId) };
  }

  async function loadGuides(): Promise<void> {
    try {
      const payload = await fetchReactionGuides();
      setGuideItems(payload.items);
      setGuideDefault(payload.default);
    } catch (err) {
      setGuideError(describeError(err));
    }
  }

  // 换层时把这一层已有的文案填回编辑框（没有配置就清空），免得上层的正文被误存到这一层。
  function fillGuideDraft(scope: Scope, scopeId: string): void {
    const existing = findGuide(guideItems, scope, scopeId);
    setGuidePrompt(existing === undefined ? '' : existing.prompt);
  }

  function selectGuideScope(next: Scope): void {
    setGuideScope(next);
    setGuideMessage('');
    setGuideError('');
    fillGuideDraft(next, guideScopeId);
  }

  function loadGuideItem(item: ReactionGuideItem): void {
    setGuideScope(item.scope);
    setGuideScopeId(item.scope === 'global' ? '' : item.scopeId);
    setGuidePrompt(item.prompt);
    setGuideMessage('已载入 ' + describeScopeTarget(item.scope, item.scopeId));
    setGuideError('');
  }

  // 只填进编辑框，不落库：默认文案要不要用由用户自己决定。
  function restoreGuideDefault(): void {
    setGuidePrompt(guideDefault);
    setGuideMessage('已填入内置默认文案，改完点「保存」才会生效');
    setGuideError('');
  }

  async function saveGuide(): Promise<void> {
    if (guideBusy !== '') return;
    setGuideMessage('');
    setGuideError('');
    const target = currentGuideTarget();
    // 本地先拦一遍（对齐后端 BAD_REQUEST / BAD_REACTION_GUIDE），提示能具体到原因。
    if (target.scope !== 'global' && target.scopeId === '') {
      setGuideError('guild / channel 层要填服务器或频道 ID');
      return;
    }
    // 后端 PUT 空串一律 400：留空回上层是「删除这一层」的语义。
    if (guidePrompt.trim() === '') {
      setGuideError('提示词不能为空：留空等于这一层没有配置，请点「删除这一层」落回上一层');
      return;
    }
    if (guidePrompt.length > REACTION_GUIDE_MAX_CHARS) {
      setGuideError('提示词不能超过 ' + String(REACTION_GUIDE_MAX_CHARS) + ' 字符');
      return;
    }
    setGuideBusy('save');
    try {
      const saved = await saveReactionGuide({ scope: target.scope, scopeId: target.scopeId, prompt: guidePrompt });
      setGuideMessage('已保存 ' + describeScopeTarget(saved.scope, saved.scopeId));
      await loadGuides();
    } catch (err) {
      setGuideError(describeGuideRejection(err));
    } finally {
      setGuideBusy('');
    }
  }

  async function removeGuide(target: { scope: Scope; scopeId: string }): Promise<void> {
    if (guideBusy !== '') return;
    const label = describeScopeTarget(target.scope, target.scopeId);
    if (!window.confirm('确定删除 ' + label + ' 的贴表情提示词？删除后这一层落回上一层')) return;
    setGuideMessage('');
    setGuideError('');
    setGuideBusy('delete');
    try {
      await deleteReactionGuide(target);
      setGuideMessage('已删除 ' + label + '（这一层落回上一层）');
      await loadGuides();
    } catch (err) {
      setGuideError(describeGuideRejection(err));
    } finally {
      setGuideBusy('');
    }
  }

  function currentBodyEmojiTarget(): { scope: Scope; scopeId: string } {
    return { scope: bodyScope, scopeId: normalizeScopeId(bodyScope, bodyScopeId) };
  }

  async function loadBodyEmojiGuides(): Promise<void> {
    try {
      const payload = await fetchBodyEmojiGuides();
      setBodyItems(payload.items);
      setBodySuggestion(payload.suggestion);
    } catch (err) {
      setBodyError(describeError(err));
    }
  }

  // 换层时把这一层已有的文案填回编辑框（没有配置就清空），免得上层的正文被误存到这一层。
  function fillBodyDraft(scope: Scope, scopeId: string): void {
    const existing = findBodyEmoji(bodyItems, scope, scopeId);
    setBodyPrompt(existing === undefined ? '' : existing.prompt);
  }

  function selectBodyScope(next: Scope): void {
    setBodyScope(next);
    setBodyMessage('');
    setBodyError('');
    fillBodyDraft(next, bodyScopeId);
  }

  function loadBodyItem(item: BodyEmojiGuideItem): void {
    setBodyScope(item.scope);
    setBodyScopeId(item.scope === 'global' ? '' : item.scopeId);
    setBodyPrompt(item.prompt);
    setBodyMessage('已载入 ' + describeScopeTarget(item.scope, item.scopeId));
    setBodyError('');
  }

  // 只填进编辑框，不落库：推荐文案要不要用由用户自己决定，点「保存」才生效。
  function applyBodySuggestion(): void {
    setBodyPrompt(bodySuggestion);
    setBodyMessage('已写入推荐文案（还没保存，点「保存」才生效）');
    setBodyError('');
  }

  async function saveBodyEmoji(): Promise<void> {
    if (bodyBusy !== '') return;
    setBodyMessage('');
    setBodyError('');
    const target = currentBodyEmojiTarget();
    // 本地先拦一遍（对齐后端 BAD_REQUEST / BAD_BODY_EMOJI_GUIDE），提示能具体到原因。
    if (target.scope !== 'global' && target.scopeId === '') {
      setBodyError('guild / channel 层要填服务器或频道 ID');
      return;
    }
    // 后端 PUT 空串一律 400：留空回上层是「删除这一层」的语义。
    if (bodyPrompt.trim() === '') {
      setBodyError('提示词不能为空：留空等于这一层没有配置，请点「删除这一层」落回上一层');
      return;
    }
    if (bodyPrompt.length > BODY_EMOJI_GUIDE_MAX_CHARS) {
      setBodyError('提示词不能超过 ' + String(BODY_EMOJI_GUIDE_MAX_CHARS) + ' 字符');
      return;
    }
    setBodyBusy('save');
    try {
      const saved = await saveBodyEmojiGuide({ scope: target.scope, scopeId: target.scopeId, prompt: bodyPrompt });
      setBodyMessage('已保存 ' + describeScopeTarget(saved.scope, saved.scopeId));
      await loadBodyEmojiGuides();
    } catch (err) {
      setBodyError(describeBodyEmojiRejection(err));
    } finally {
      setBodyBusy('');
    }
  }

  async function removeBodyEmoji(target: { scope: Scope; scopeId: string }): Promise<void> {
    if (bodyBusy !== '') return;
    const label = describeScopeTarget(target.scope, target.scopeId);
    if (!window.confirm('确定删除 ' + label + ' 的正文表情提示词？删除后这一层落回上一层')) return;
    setBodyMessage('');
    setBodyError('');
    setBodyBusy('delete');
    try {
      await deleteBodyEmojiGuide(target);
      setBodyMessage('已删除 ' + label + '（这一层落回上一层）');
      await loadBodyEmojiGuides();
    } catch (err) {
      setBodyError(describeBodyEmojiRejection(err));
    } finally {
      setBodyBusy('');
    }
  }

  function currentTemplateTarget(): { scope: Scope; scopeId: string } {
    return { scope: templateScope, scopeId: normalizeScopeId(templateScope, templateScopeId) };
  }

  async function loadTemplates(): Promise<void> {
    try {
      const payload = await fetchReactionTemplates();
      setTemplateItems(payload.items);
      setTemplateDefault(payload.default);
      setTemplateVars(payload.vars);
    } catch (err) {
      setTemplateError(describeError(err));
    }
  }

  // 换层时把这一层已有的模板填回编辑框（没有配置就清空），免得上层的正文被误存到这一层。
  function fillTemplateDraft(scope: Scope, scopeId: string): void {
    const existing = findTemplate(templateItems, scope, scopeId);
    setTemplateDraft(existing === undefined ? '' : existing.template);
  }

  function selectTemplateScope(next: Scope): void {
    setTemplateScope(next);
    setTemplateMessage('');
    setTemplateError('');
    fillTemplateDraft(next, templateScopeId);
  }

  function loadTemplateItem(item: ReactionTemplateItem): void {
    setTemplateScope(item.scope);
    setTemplateScopeId(item.scope === 'global' ? '' : item.scopeId);
    setTemplateDraft(item.template);
    setTemplateMessage('已载入 ' + describeScopeTarget(item.scope, item.scopeId));
    setTemplateError('');
  }

  // 只填进编辑框，不落库：默认模板要不要用由用户自己决定，保存一次才生效。
  function restoreTemplateDefault(): void {
    setTemplateDraft(templateDefault);
    setTemplateMessage('已填入内置默认模板，改完点「保存这一层」才会生效');
    setTemplateError('');
  }

  async function saveTemplate(): Promise<void> {
    if (templateBusy !== '') return;
    setTemplateMessage('');
    setTemplateError('');
    const target = currentTemplateTarget();
    // 本地先拦一遍（对齐后端 BAD_REQUEST / BAD_REACTION_TEMPLATE / UNKNOWN_TEMPLATE_VAR），提示能具体到原因。
    if (target.scope !== 'global' && target.scopeId === '') {
      setTemplateError('guild / channel 层要填服务器或频道 ID');
      return;
    }
    // 后端 PUT 空串一律 400：留空回上层是「删除这一层」的语义。
    if (templateDraft.trim() === '') {
      setTemplateError('模板不能为空：留空等于这一层没有配置，请点「删除这一层」落回上一层');
      return;
    }
    if (templateDraft.length > REACTION_TEMPLATE_MAX_CHARS) {
      setTemplateError('模板不能超过 ' + String(REACTION_TEMPLATE_MAX_CHARS) + ' 字符');
      return;
    }
    const written = listTemplateVars(templateDraft);
    const unknown = written.filter((name) => !templateVars.includes(name));
    if (unknown.length > 0) {
      setTemplateError(
        '模板里有不支持的占位符：' +
          unknown.map(describeTemplateVar).join('、') +
          '。可用的占位符只有 ' +
          templateVars.map(describeTemplateVar).join(' '),
      );
      return;
    }
    // 后端还要求至少有一个已知占位符：一个都没有就没有素材可插，先在前端说清楚。
    if (written.length === 0) {
      setTemplateError(
        '模板里至少要留一个占位符，否则没有任何素材会插进来。可用的是 ' +
          templateVars.map(describeTemplateVar).join(' '),
      );
      return;
    }
    setTemplateBusy('save');
    try {
      const saved = await saveReactionTemplate({
        scope: target.scope,
        scopeId: target.scopeId,
        template: templateDraft,
      });
      setTemplateMessage('已保存 ' + describeScopeTarget(saved.scope, saved.scopeId));
      await loadTemplates();
    } catch (err) {
      setTemplateError(describeTemplateRejection(err));
    } finally {
      setTemplateBusy('');
    }
  }

  async function removeTemplate(target: { scope: Scope; scopeId: string }): Promise<void> {
    if (templateBusy !== '') return;
    const label = describeScopeTarget(target.scope, target.scopeId);
    if (!window.confirm('确定删除 ' + label + ' 的表情素材模板？删除后这一层落回上一层')) return;
    setTemplateMessage('');
    setTemplateError('');
    setTemplateBusy('delete');
    try {
      await deleteReactionTemplate(target);
      setTemplateMessage('已删除 ' + label + '（这一层落回上一层）');
      // 删掉的正是编辑中的那一层时，把编辑框也清掉，免得看起来还配着。
      if (target.scope === templateScope && target.scopeId === normalizeScopeId(templateScope, templateScopeId)) {
        setTemplateDraft('');
      }
      await loadTemplates();
    } catch (err) {
      setTemplateError(describeTemplateRejection(err));
    } finally {
      setTemplateBusy('');
    }
  }

  const emojiDisabled = emojiBusy !== '' || guildId.trim() === '';
  // 别名按钮多一条：没选目标表情时后端一定 400（§24.6 BAD_EMOJI），干脆先禁用。
  const aliasDisabled = aliasBusy !== '' || guildId.trim() === '' || aliasDraft.trim() === '' || targetEmojiId === '';
  // guild / channel 层没填 ID 时后端一定 400（BAD_REQUEST），干脆先禁用；保存另外要求正文非空。
  const guideTargetDisabled = guideBusy !== '' || (guideScope !== 'global' && guideScopeId.trim() === '');
  const guideSaveDisabled = guideTargetDisabled || guidePrompt.trim() === '';
  // 正文表情卡片同样：guild / channel 层没填 ID 后端一定 400，保存另外要求正文非空。
  const bodyTargetDisabled = bodyBusy !== '' || (bodyScope !== 'global' && bodyScopeId.trim() === '');
  const bodySaveDisabled = bodyTargetDisabled || bodyPrompt.trim() === '';
  // 模板卡片同理：guild / channel 层没填 ID 后端一定 400，保存另外要求正文非空。
  const templateTargetDisabled =
    templateBusy !== '' || (templateScope !== 'global' && templateScopeId.trim() === '');
  const templateSaveDisabled = templateTargetDisabled || templateDraft.trim() === '';

  return (
    <div className="page reaction">
      <form
        className="card"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <h2>表情</h2>
        <p className="hint">
          每轮回复后会单独问一次这个模型要不要贴表情；不启用就只用主模型自己的表情指令
        </p>
        <label className="row checkbox">
          <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
          <span>启用表情模型（每轮回复后多一次调用）</span>
        </label>
        <label className="field">
          <span>供应商</span>
          <select value={provider} onChange={(event) => setProvider(event.target.value as ProviderId)}>
            {PROVIDER_IDS.map((item) => (
              <option key={item} value={item}>
                {PROVIDER_LABELS[item]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>模型名（供应商原始名称，不做别名映射）</span>
          <input
            type="text"
            value={model}
            placeholder="例如 gpt-4o-mini"
            onChange={(event) => setModel(event.target.value)}
          />
        </label>
        <p className="hint">该供应商下没有可用密钥时这轮不贴表情，也不会影响正文与摘要。</p>
        {message === '' ? null : <p className="ok">{message}</p>}
        {error === '' ? null : <p className="error">{error}</p>}
        <div className="actions">
          <button type="submit" className="primary" disabled={busy}>
            {busy ? '保存中…' : '保存'}
          </button>
        </div>
      </form>

      <section className="card">
        <h2>贴表情提示词</h2>
        <p className="hint">
          主模型的【表情】引导与兜底的表情模型共用这一份文案；优先级 channel &gt; guild &gt; global，命中哪层用哪层的整份文案。
        </p>
        <p className="hint">
          某一层留空或删除 = 这一层没有配置 → 用上一层 → 三层都没有就用内置默认。「给大家贴」写
          @all / @everyone / @大家 / @所有人 / @全员 / @*；一行一个 <code>{'[[react:…]]'}</code>，不贴表情就输出 NONE。
        </p>
        <ScopeField
          scope={guideScope}
          scopeId={guideScopeId}
          onScopeChange={selectGuideScope}
          onScopeIdChange={setGuideScopeId}
        />
        <label className="field">
          <span>
            提示词正文（{String(guidePrompt.length)} / {String(REACTION_GUIDE_MAX_CHARS)} 字符）
          </span>
          <textarea
            rows={14}
            value={guidePrompt}
            placeholder={guideDefault === '' ? '还没有取到内置默认文案' : guideDefault}
            onChange={(event) => setGuidePrompt(event.target.value)}
          />
        </label>
        {guideMessage === '' ? null : <p className="ok">{guideMessage}</p>}
        {guideError === '' ? null : <p className="error">{guideError}</p>}
        <div className="actions">
          <button type="button" className="primary" disabled={guideSaveDisabled} onClick={() => void saveGuide()}>
            {guideBusy === 'save' ? '保存中…' : '保存'}
          </button>
          <button
            type="button"
            className="danger"
            disabled={guideTargetDisabled}
            onClick={() => void removeGuide(currentGuideTarget())}
          >
            {guideBusy === 'delete' ? '删除中…' : '删除这一层'}
          </button>
          <button type="button" className="ghost" disabled={guideDefault === ''} onClick={restoreGuideDefault}>
            恢复默认文案
          </button>
        </div>
        <h2>已配置的层</h2>
        {guideItems.length === 0 ? (
          <p className="hint">三层都还没有配置，现在用的是内置默认文案。</p>
        ) : (
          <ul className="emoji-list guide-list">
            {guideItems.map((item) => (
              <li key={scopeKey(item.scope, item.scopeId)}>
                <span className="guide-scope">{describeScopeTarget(item.scope, item.scopeId)}</span>
                <span className="guide-count">{String(item.prompt.length)} 字符</span>
                <div className="guide-actions">
                  <button
                    type="button"
                    className="ghost small"
                    disabled={guideBusy !== ''}
                    onClick={() => loadGuideItem(item)}
                  >
                    载入
                  </button>
                  <button
                    type="button"
                    className="danger small"
                    disabled={guideBusy !== ''}
                    onClick={() => void removeGuide({ scope: item.scope, scopeId: item.scopeId })}
                  >
                    删除
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h2>正文表情</h2>
        <p className="hint">
          这一段管正文里夹不夹 :名字:，清单由服务器的自定义表情自动带出；优先级 channel &gt; guild &gt; global，命中哪层用哪层的整份文案。
        </p>
        <p className="hint">
          某一层没配或已删除 = 这一层没有配置 → 用上一层 → 三层都没有 = 关：正文里不夹 :名字:，正文提示词与现在逐字相同。
        </p>
        <ScopeField
          scope={bodyScope}
          scopeId={bodyScopeId}
          onScopeChange={selectBodyScope}
          onScopeIdChange={setBodyScopeId}
        />
        <label className="field">
          <span>
            提示词正文（{String(bodyPrompt.length)} / {String(BODY_EMOJI_GUIDE_MAX_CHARS)} 字符）
          </span>
          <textarea
            rows={14}
            value={bodyPrompt}
            placeholder="三层都不配 = 关：正文里不夹 :名字:"
            onChange={(event) => setBodyPrompt(event.target.value)}
          />
        </label>
        {bodyMessage === '' ? null : <p className="ok">{bodyMessage}</p>}
        {bodyError === '' ? null : <p className="error">{bodyError}</p>}
        <div className="actions">
          <button type="button" className="primary" disabled={bodySaveDisabled} onClick={() => void saveBodyEmoji()}>
            {bodyBusy === 'save' ? '保存中…' : '保存'}
          </button>
          <button
            type="button"
            className="danger"
            disabled={bodyTargetDisabled}
            onClick={() => void removeBodyEmoji(currentBodyEmojiTarget())}
          >
            {bodyBusy === 'delete' ? '删除中…' : '删除这一层'}
          </button>
          <button type="button" className="ghost" disabled={bodySuggestion === ''} onClick={applyBodySuggestion}>
            写入推荐文案
          </button>
        </div>
        <h2>已配置的层</h2>
        {bodyItems.length === 0 ? (
          <p className="hint">三层都还没有配置 = 现在是关：正文里不夹 :名字:。</p>
        ) : (
          <ul className="emoji-list guide-list">
            {bodyItems.map((item) => (
              <li key={scopeKey(item.scope, item.scopeId)}>
                <span className="guide-scope">{describeScopeTarget(item.scope, item.scopeId)}</span>
                <span className="guide-count">{String(item.prompt.length)} 字符</span>
                <div className="guide-actions">
                  <button
                    type="button"
                    className="ghost small"
                    disabled={bodyBusy !== ''}
                    onClick={() => loadBodyItem(item)}
                  >
                    载入
                  </button>
                  <button
                    type="button"
                    className="danger small"
                    disabled={bodyBusy !== ''}
                    onClick={() => void removeBodyEmoji({ scope: item.scope, scopeId: item.scopeId })}
                  >
                    删除
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h2>表情素材模板</h2>
        <p className="hint">
          贴表情时喂给模型的素材模板；优先级 channel &gt; guild &gt; global，命中哪层就用哪层的整份模板，三层都没有就用内置默认。
        </p>
        <p className="hint">
          模板里写哪些占位符就展开哪几段，删掉某个占位符 = 那一段整段不出现（哪一段都可以删）；
          这里留空 = 这一层没有配置，用「删除这一层」落回上一层。
        </p>
        <ScopeField
          scope={templateScope}
          scopeId={templateScopeId}
          onScopeChange={selectTemplateScope}
          onScopeIdChange={setTemplateScopeId}
        />
        <label className="field">
          <span>
            模板正文（{String(templateDraft.length)} / {String(REACTION_TEMPLATE_MAX_CHARS)} 字符）
          </span>
          <textarea
            rows={14}
            value={templateDraft}
            placeholder={templateDefault === '' ? '还没有取到内置默认模板' : templateDefault}
            onChange={(event) => setTemplateDraft(event.target.value)}
          />
        </label>
        <ul className="template-hint-list">
          {templateVars.map((name) => (
            <li key={name}>
              <code>{describeTemplateVar(name)}</code>
              {templateVarHint(name)}
            </li>
          ))}
        </ul>
        {templateMessage === '' ? null : <p className="ok">{templateMessage}</p>}
        {templateError === '' ? null : <p className="error">{templateError}</p>}
        <div className="actions">
          <button
            type="button"
            className="primary"
            disabled={templateSaveDisabled}
            onClick={() => void saveTemplate()}
          >
            {templateBusy === 'save' ? '保存中…' : '保存这一层'}
          </button>
          <button
            type="button"
            className="danger"
            disabled={templateTargetDisabled}
            onClick={() => void removeTemplate(currentTemplateTarget())}
          >
            {templateBusy === 'delete' ? '删除中…' : '删除这一层'}
          </button>
          <button type="button" className="ghost" disabled={templateDefault === ''} onClick={restoreTemplateDefault}>
            恢复默认
          </button>
        </div>
        <h2>已配置的层</h2>
        {templateItems.length === 0 ? (
          <p className="hint">三层都还没有配置，现在用的是内置默认模板。</p>
        ) : (
          <ul className="emoji-list template-list">
            {templateItems.map((item) => (
              <li key={scopeKey(item.scope, item.scopeId)}>
                <span className="template-scope">{describeScopeTarget(item.scope, item.scopeId)}</span>
                <span className="template-time">
                  {String(listTemplateVars(item.template).length)} 个占位符 · 更新于{' '}
                  {formatUpdatedAt(item.updatedAt)}
                </span>
                <div className="template-actions">
                  <button
                    type="button"
                    className="ghost small"
                    disabled={templateBusy !== ''}
                    onClick={() => loadTemplateItem(item)}
                  >
                    载入
                  </button>
                  <button
                    type="button"
                    className="danger small"
                    disabled={templateBusy !== ''}
                    onClick={() => void removeTemplate({ scope: item.scope, scopeId: item.scopeId })}
                  >
                    删除
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h2>认表情（让模型看表情图，生成中文描述）</h2>
        <p className="hint">
          填服务器 ID 后认新表情：只处理还没有描述的自定义表情；全部重认会覆盖已有描述
        </p>
        <label className="field">
          <span>服务器 ID</span>
          <input
            type="text"
            value={guildId}
            placeholder="例如 1234567890123456789"
            onChange={(event) => updateGuildId(event.target.value)}
          />
        </label>
        {emojiMessage === '' ? null : <p className="ok">{emojiMessage}</p>}
        {emojiError === '' ? null : <p className="error">{emojiError}</p>}
        <div className="actions">
          <button type="button" className="primary" disabled={emojiDisabled} onClick={() => void describe(false)}>
            {emojiBusy === 'new' ? '认图中…' : '认新表情'}
          </button>
          <button type="button" className="ghost" disabled={emojiDisabled} onClick={() => void describe(true)}>
            {emojiBusy === 'all' ? '重认中…' : '全部重认'}
          </button>
        </div>
        {emojiItems.length === 0 ? null : (
          <>
            <ul className="emoji-list">
              {emojiItems.slice(0, EMOJI_PREVIEW_LIMIT).map((item) => (
                <li key={item.emojiId}>
                  <span className="emoji-head">
                    {item.name}({item.emojiId}) →
                  </span>{' '}
                  {item.description}
                </li>
              ))}
            </ul>
            {emojiItems.length > EMOJI_PREVIEW_LIMIT ? (
              <p className="hint">还有 {String(emojiItems.length - EMOJI_PREVIEW_LIMIT)} 条</p>
            ) : null}
          </>
        )}
      </section>

      <section className="card">
        <h2>表情别名（管理员手工配）</h2>
        <p className="hint">
          配了别名之后，模型看到 <code>:laugh:</code> 也知道它叫「奶龙」，你直接让它贴奶龙就行。
        </p>
        <div className="row alias">
          <label className="field">
            <span>别名</span>
            <input
              type="text"
              value={aliasDraft}
              placeholder="例如：奶龙"
              onChange={(event) => setAliasDraft(event.target.value)}
            />
          </label>
          <label className="field">
            <span>目标表情</span>
            <select value={targetEmojiId} onChange={(event) => setTargetEmojiId(event.target.value)}>
              <option value="">
                {liveEmojis.length === 0
                  ? guildId.trim() === ''
                    ? '先填服务器 ID，再从这里选表情'
                    : '该服务器没有自定义表情'
                  : '选择表情'}
              </option>
              {liveEmojis.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} ({item.id})
                </option>
              ))}
            </select>
          </label>
          <div className="actions">
            <button type="button" className="primary" disabled={aliasDisabled} onClick={() => void addAlias()}>
              {aliasBusy === 'add' ? '添加中…' : '添加'}
            </button>
          </div>
        </div>
        {aliasMessage === '' ? null : <p className="ok">{aliasMessage}</p>}
        {aliasError === '' ? null : <p className="error">{aliasError}</p>}
        {aliasItems.length === 0 ? (
          <p className="hint">
            {guildId.trim() === '' ? '填上面的服务器 ID 后会列出已配的别名' : '这个服务器还没有配别名'}
          </p>
        ) : (
          <ul className="emoji-list alias-list">
            {aliasItems.map((item) => (
              <li key={item.alias}>
                <span className="alias-name">{item.alias} →</span>
                <span className="emoji-head">
                  {item.emojiName} ({item.emojiId})
                </span>
                <button
                  type="button"
                  className="danger small"
                  disabled={aliasBusy !== ''}
                  onClick={() => void removeAlias(item.alias)}
                >
                  删除
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
