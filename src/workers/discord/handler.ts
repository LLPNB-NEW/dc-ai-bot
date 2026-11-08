import type {
  PromptRepository,
  ReplySettingsStore,
  RouteRepository,
  TtsSettingsStore,
  TtsStyleStore,
  VoiceSettingsStore,
} from '../../core/ports';
import type {
  ChannelKey,
  ConversationSummary,
  PromptConfig,
  PromptSegment,
  ProviderId,
  RouteConfig,
  Scope,
  ScopedKey,
  SummaryOutcome,
  TurnContext,
  VoiceSettingsConfig,
} from '../../core/types';
import {
  INTERACTION_TYPE_APPLICATION_COMMAND,
  INTERACTION_TYPE_PING,
  MESSAGE_FLAG_EPHEMERAL,
  RESPONSE_TYPE_DEFERRED,
  RESPONSE_TYPE_MESSAGE,
  RESPONSE_TYPE_PONG,
  findCommand,
  hasManageGuildPermission,
  isModelViewRequest,
  isPersonaViewRequest,
  isProviderId,
  parseCommandOptions,
  readBooleanOption,
  readStringOption,
  requiresManageGuild,
  type CommandOptionMap,
  type DiscordInteraction,
} from './commands';
import type { ChatRunner } from './ports';
import { createDiscordRestClient, sendChannelFile, type ChannelRestOptions, type DiscordRestClient } from './rest';
import { resolveBotDisplayName } from './bot-name';
import { maybeSendVoice } from './voice-reply';
import { readSignatureHeaders, verifyEd25519Signature } from './verify';
import { readRevealSteps } from '../../core/chat/reply-view';
import { VOICE_MODE_ON_REQUEST, readVoiceSettings } from '../../core/voice/settings';
import { isJudgeConfigured, resolveStylePrompt, type TtsStyleJudgeConfig } from '../../core/voice/style';
import { createUnconfiguredTts, type TtsPort } from '../../core/voice/tts';
import { formatDayMinute } from '../../core/chat/stamp';
import { SYSTEM_CLOCK, TRUNCATION_SUFFIX, clampForDiscord, createProgressiveEditor, type Clock } from './editor';
import { mentionPrefix, withMention } from './mention';

// §29：渐进编辑的节流与预算规则提到 ./editor.ts 共用（@ 路径也用它）
export type { Clock } from './editor';

const DEFAULT_EDIT_INTERVAL_MS = 1200;
const DEFAULT_MAX_EDITS = 12;
const DEFAULT_MAX_CHARS = 1900;
const DEFAULT_BOT_NAME = 'DC AI BOT';

export interface InteractionHandlerLimits {
  editIntervalMs?: number;
  maxEdits?: number;
  maxChars?: number;
}

export interface InteractionHandlerDeps {
  /** DISCORD_PUBLIC_KEY，hex */
  publicKeyHex: string;
  applicationId: string;
  botToken?: string;
  botName?: string;
  chat: ChatRunner;
  routes: RouteRepository;
  prompts: PromptRepository;
  /** §38：假流式切片次数的三层配置；不装配就按编辑器默认值走 */
  replySettings?: ReplySettingsStore;
  /** 语音回复的三层配置；不装配就当作没配（不念） */
  voiceSettings?: VoiceSettingsStore;
  /** 语音合成端口；不装配就当作没配 TTS（合成时抛错，只 warn，不影响回复） */
  tts?: TtsPort;
  /** 语音合成那一行配置：斜杠命令要在发语音前现读 judge 三字段；不装配就当作没配 judge */
  ttsSettings?: TtsSettingsStore;
  /** 三层语气提示词（channel / guild / global）；不装配就当三层全空，语音照发 */
  ttsStyles?: TtsStyleStore;
  /** Discord REST 用的 fetch，测试注入 */
  fetch?: typeof fetch;
  apiBase?: string;
  clock?: Clock;
  limits?: InteractionHandlerLimits;
  log?: (message: string, error?: unknown) => void;
}

export interface InteractionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface InteractionResponseBody {
  type: number;
  data?: { content?: string; flags?: number };
}

export type InteractionHandler = (request: Request, ctx: InteractionContext) => Promise<Response>;

function scopeLabel(scope: Scope): string {
  if (scope === 'channel') return '频道';
  if (scope === 'guild') return '服务器';
  return '全局';
}

function jsonResponse(body: InteractionResponseBody): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function textResponse(body: string, status: number): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

function ephemeralMessage(content: string): InteractionResponseBody {
  return { type: RESPONSE_TYPE_MESSAGE, data: { content, flags: MESSAGE_FLAG_EPHEMERAL } };
}

function privateMessage(content: string): InteractionResponseBody {
  return { type: RESPONSE_TYPE_MESSAGE, data: { content, flags: MESSAGE_FLAG_EPHEMERAL } };
}

function publicMessage(content: string): InteractionResponseBody {
  return { type: RESPONSE_TYPE_MESSAGE, data: { content } };
}

function deferredResponse(): InteractionResponseBody {
  return { type: RESPONSE_TYPE_DEFERRED, data: {} };
}

const HELP_TEXT = [
  '可用命令：',
  '/chat prompt:<内容> — 与模型对话（所有人）',
  '/model view:true — 查看本频道当前模型（所有人）',
  '/model provider:<供应商> model:<模型名> — 设置本频道模型（需管理服务器）',
  '/persona — 查看本频道提示词（需管理服务器）',
  '/persona persona:<人格> system:<基本设定> — 写入本频道提示词的两个固定段（需管理服务器）',
  '/reset — 清空本频道会话记忆（需管理服务器）',
  '/summary — 把本频道还没总结的对话合并进长期记忆（所有人）',
  '/summary view:true — 只看当前长期记忆摘要，不重新总结（所有人）',
  '/help — 显示本说明（所有人）',
  '提示：用「回复」引用某条消息时我能看懂引用的是哪句；我也可能在你那条消息上贴个表情（斜杠命令不贴）。',
].join('\n');

interface HandlerRuntime {
  deps: InteractionHandlerDeps;
  limits: Required<InteractionHandlerLimits>;
  clock: Clock;
  log: (message: string, error?: unknown) => void;
}

function scopeChain(interaction: DiscordInteraction): ScopedKey[] {
  const chain: ScopedKey[] = [];
  const channelId = interaction.channel_id ?? '';
  const guildId = interaction.guild_id ?? '';
  if (channelId) chain.push({ scope: 'channel', scopeId: channelId });
  if (guildId) chain.push({ scope: 'guild', scopeId: guildId });
  chain.push({ scope: 'global', scopeId: '' });
  return chain;
}

async function resolveFirstRoute(
  routes: RouteRepository,
  chain: ScopedKey[],
): Promise<{ cfg: RouteConfig; scope: Scope } | null> {
  for (const key of chain) {
    const cfg = await routes.get(key);
    if (cfg) return { cfg, scope: key.scope };
  }
  return null;
}

async function resolveFirstPrompt(
  prompts: PromptRepository,
  chain: ScopedKey[],
): Promise<{ cfg: PromptConfig; scope: Scope } | null> {
  for (const key of chain) {
    const cfg = await prompts.get(key);
    if (cfg) return { cfg, scope: key.scope };
  }
  return null;
}

function formatRouteView(found: { cfg: RouteConfig; scope: Scope } | null): string {
  if (!found) {
    return '本频道还没有配置模型路由。用法：/model provider:openai-compat model:gpt-4o-mini（也可在 Web 后台「路由」页配置）';
  }
  const lines = ['当前生效模型（来源：' + scopeLabel(found.scope) + '）'];
  lines.push('主模型：' + found.cfg.primary.provider + ' / ' + found.cfg.primary.model);
  if (found.cfg.fallbacks.length > 0) {
    lines.push('备用：' + found.cfg.fallbacks.map((f) => f.provider + ' / ' + f.model).join('、'));
  }
  return lines.join('\n');
}

const NO_PROMPT_VIEW =
  '本频道还没有自定义提示词，当前使用内置默认。用法：/persona persona:温柔助手 system:你是一位{{user_name}}的助手';

/** 段正文在 Discord 里只露头 120 字：一条消息 2000 字上限，段可以很长 */
const PROMPT_VIEW_CONTENT_MAX = 120;

function formatPromptSegment(segment: PromptSegment): string {
  // role='user' 的段不进 system，没有前后置之分，角标不写 placement
  const badge = segment.role === 'user' ? 'user' : 'system/' + (segment.placement === 'after' ? '后置' : '前置');
  const state = segment.enabled ? '启用' : '已停用';
  const content =
    segment.content.length > PROMPT_VIEW_CONTENT_MAX
      ? segment.content.slice(0, PROMPT_VIEW_CONTENT_MAX) + '…'
      : segment.content;
  return '· ' + segment.name + '［' + badge + '］' + state + '：' + content;
}

function formatPromptView(found: { cfg: PromptConfig; scope: Scope } | null): string {
  if (found === null || found.cfg.segments.length === 0) return NO_PROMPT_VIEW;
  const lines = ['当前提示词（来源：' + scopeLabel(found.scope) + '）'];
  for (const segment of [...found.cfg.segments].sort((left, right) => left.position - right.position)) {
    lines.push(formatPromptSegment(segment));
  }
  return lines.join('\n');
}

async function handleModelSet(
  runtime: HandlerRuntime,
  interaction: DiscordInteraction,
  options: CommandOptionMap,
): Promise<string> {
  const channelId = interaction.channel_id ?? '';
  if (!channelId) return '这个命令只能在服务器频道里使用。';

  const providerRaw = readStringOption(options, 'provider');
  const modelRaw = readStringOption(options, 'model');
  if (providerRaw !== undefined && !isProviderId(providerRaw)) {
    return '供应商无效，可选：openai-compat / anthropic / gemini';
  }

  const channelKey: ScopedKey = { scope: 'channel', scopeId: channelId };
  const existing = await runtime.deps.routes.get(channelKey);
  const effective = await resolveFirstRoute(runtime.deps.routes, scopeChain(interaction));
  const inherited = existing ?? effective?.cfg ?? null;

  let provider: ProviderId;
  let model: string;
  if (providerRaw !== undefined && modelRaw !== undefined) {
    provider = providerRaw as ProviderId;
    model = modelRaw;
  } else if (modelRaw !== undefined) {
    if (!inherited) return '请同时提供 provider，例如 /model provider:openai-compat model:gpt-4o-mini';
    provider = inherited.primary.provider;
    model = modelRaw;
  } else if (providerRaw !== undefined) {
    if (!inherited || inherited.primary.provider !== providerRaw) {
      return '换了供应商就要一起给 model，例如 /model provider:' + providerRaw + ' model:<模型名>';
    }
    provider = inherited.primary.provider;
    model = inherited.primary.model;
  } else {
    return formatRouteView(effective);
  }

  const next: RouteConfig = {
    primary: { provider, model },
    fallbacks: existing?.fallbacks ?? [],
    temperature: existing?.temperature,
    maxTokens: existing?.maxTokens,
  };
  await runtime.deps.routes.put(channelKey, next);
  return '已设置本频道模型：' + provider + ' / ' + model;
}

/** /persona 写进库的两段固定 id：命令执行多次只改内容，不会一段段越堆越多 */
const SLASH_PERSONA_SEGMENT_ID = 'slash-persona';
const SLASH_MAIN_SEGMENT_ID = 'slash-main';

/** 按 id 更新段的正文；没有同 id 段就追加一段新的 system/前置段（position 由调用方统一重排） */
function upsertSlashSegment(segments: PromptSegment[], id: string, name: string, content: string): void {
  const found = segments.find((segment) => segment.id === id);
  if (found !== undefined) {
    found.content = content;
    return;
  }
  segments.push({ id, name, role: 'system', content, enabled: true, placement: 'before', position: segments.length });
}

async function handlePersonaSet(
  runtime: HandlerRuntime,
  interaction: DiscordInteraction,
  options: CommandOptionMap,
): Promise<string> {
  const channelId = interaction.channel_id ?? '';
  if (!channelId) return '这个命令只能在服务器频道里使用。';

  const personaRaw = readStringOption(options, 'persona');
  const systemRaw = readStringOption(options, 'system');
  const effective = await resolveFirstPrompt(runtime.deps.prompts, scopeChain(interaction));
  // 两个参数都没给 = 只想看（与 /model 一致），别为了看一次就把继承来的段抄成频道自己的行
  if (personaRaw === undefined && systemRaw === undefined) return formatPromptView(effective);

  const channelKey: ScopedKey = { scope: 'channel', scopeId: channelId };
  const existing = await runtime.deps.prompts.get(channelKey);
  // 频道没有自己的行时以继承层为底复制一份再改：整组覆盖会把继承的其它段一起丢掉
  const base = existing ?? effective?.cfg ?? null;
  const segments = (base?.segments ?? []).map((segment) => ({ ...segment }));

  const changed: string[] = [];
  if (personaRaw !== undefined) {
    upsertSlashSegment(segments, SLASH_PERSONA_SEGMENT_ID, '人格', personaRaw);
    changed.push('人格');
  }
  if (systemRaw !== undefined) {
    upsertSlashSegment(segments, SLASH_MAIN_SEGMENT_ID, '基本设定', systemRaw);
    changed.push('基本设定');
  }
  // position 重排成 0..n-1：改过 / 删过之后不留空洞
  segments.forEach((segment, index) => {
    segment.position = index;
  });

  const next: PromptConfig = { segments };
  if (base?.temperature !== undefined) next.temperature = base.temperature;
  if (base?.maxTokens !== undefined) next.maxTokens = base.maxTokens;

  await runtime.deps.prompts.put(channelKey, next);
  return '已更新本频道的' + changed.join('与') + '。';
}

function buildTurnContext(runtime: HandlerRuntime, interaction: DiscordInteraction, userText: string): TurnContext {
  const user = interaction.member?.user ?? interaction.user;
  return {
    guildId: interaction.guild_id ?? '',
    channelId: interaction.channel_id ?? '',
    userId: user?.id ?? '',
    userName: interaction.member?.nick ?? user?.global_name ?? user?.username ?? '未知用户',
    // 交互 payload 不带名称，取名称需要额外 REST 调用（3 秒预算内不值得）
    guildName: '',
    channelName: '',
    botName: runtime.deps.botName ?? DEFAULT_BOT_NAME,
    userText,
  };
}

function describeChatError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('NO_ROUTE_CONFIGURED')) {
    return '本频道还没有配置模型路由。请到 Web 后台「路由」页添加一条路由，或用 /model provider:<供应商> model:<模型名> 设置本频道模型，然后再试。';
  }
  return '回复生成失败：' + message;
}

/**
 * 斜杠命令的语音附件：走 Bot token 直连频道（interaction token 只能改它自己那条原始消息）。
 * 没配 Bot token / 没拿到频道 id 就直接跳过 —— 语音是附加项，缺能力不是错误。
 */
async function sendVoiceReply(
  runtime: HandlerRuntime,
  interaction: DiscordInteraction,
  settings: VoiceSettingsConfig | null,
  text: string,
  wanted: boolean,
): Promise<void> {
  const channelId = interaction.channel_id ?? '';
  const botToken = (runtime.deps.botToken ?? '').trim();
  if (channelId === '' || botToken === '') return;

  const options: ChannelRestOptions = { botToken };
  if (runtime.deps.apiBase !== undefined) options.apiBase = runtime.deps.apiBase;
  if (runtime.deps.fetch !== undefined) options.fetch = runtime.deps.fetch;

  // judge 每次现读：后台改完下一条命令就生效。读失败当作没配（只 warn），语音照发。
  let judge: TtsStyleJudgeConfig | null = null;
  const ttsSettings = runtime.deps.ttsSettings;
  if (ttsSettings !== undefined) {
    try {
      const stored = await ttsSettings.get();
      const candidate = {
        url: stored?.judgeUrl ?? '',
        key: stored?.judgeKey ?? '',
        model: stored?.judgeModel ?? '',
      };
      if (stored !== null && isJudgeConfigured(candidate)) judge = candidate;
    } catch (error) {
      runtime.log('[voice] 读取判断模型配置失败', error);
    }
  }

  // 三层提示词在真的发语音时才读（maybeSendVoice 确认过开关才调用它）；没装表就当全空。
  const stylePrompt = async (): Promise<string> => {
    const store = runtime.deps.ttsStyles;
    if (store === undefined) return '';
    try {
      const guildId = interaction.guild_id ?? '';
      const channelLayer = await store.get({ scope: 'channel', scopeId: channelId });
      const guildLayer = guildId === '' ? null : await store.get({ scope: 'guild', scopeId: guildId });
      const globalLayer = await store.get({ scope: 'global', scopeId: '' });
      return resolveStylePrompt({ channel: channelLayer, guild: guildLayer, global: globalLayer });
    } catch (error) {
      runtime.log('[voice] 读取语气提示词失败', error);
      return '';
    }
  };

  await maybeSendVoice({
    settings,
    tts: runtime.deps.tts ?? createUnconfiguredTts(),
    text,
    wanted,
    judge,
    stylePrompt,
    send: (audio: Uint8Array): Promise<void> => sendChannelFile(options, channelId, audio),
    log: (line: string): void => runtime.log(line),
    logInfo: (line: string): void => runtime.log(line),
  });
}

async function runChat(
  runtime: HandlerRuntime,
  rest: DiscordRestClient,
  interaction: DiscordInteraction,
  prompt: string,
): Promise<void> {
  // §38：切片次数按这次交互解析一次（channel > guild > global）。runtime 是进程级的、解析必须落在每条交互上；
  // 私聊没有服务器，guildId 传空串让服务器层自动跳过，只查 channel + global。
  // 没装配 store 或读库失败都退回编辑器默认值 —— 读不出开关不许让这条回复发不出去。
  const revealSteps =
    runtime.deps.replySettings === undefined
      ? undefined
      : await readRevealSteps(runtime.deps.replySettings, {
          guildId: interaction.guild_id ?? '',
          channelId: interaction.channel_id ?? '',
        });
  // 语音三层配置同理：每次交互解析一次，读失败落 null（= 不念）
  const voiceSettings =
    runtime.deps.voiceSettings === undefined
      ? null
      : await readVoiceSettings(runtime.deps.voiceSettings, {
          guildId: interaction.guild_id ?? '',
          channelId: interaction.channel_id ?? '',
        });

  // 回复开头 @ 提问者：只在服务器频道点名（私聊点自己没有意义），私聊让前缀保持空串。
  // 编辑器每一次 send 都过 withMention —— 首条、每次进度编辑、收尾全文都得带，否则观感中途掉。
  const asker = interaction.member?.user ?? interaction.user;
  let mention = (interaction.guild_id ?? '') === '' ? '' : mentionPrefix(asker?.id ?? '');

  // 正文预算要把「@ 前缀」和「截断提示」两段都扣掉：编辑器截断后的长度是 maxChars + 后缀长度，
  // 只扣前缀的话这条会被 withMention 再切一次，尾部连同那句「…(已截断)」一起消失。
  const reserve = mention === '' ? 0 : mention.length + TRUNCATION_SUFFIX.length;

  const editor = createProgressiveEditor({
    send: (content) => rest.editOriginalMessage(withMention(content, mention, runtime.limits.maxChars)),
    clock: runtime.clock,
    intervalMs: runtime.limits.editIntervalMs,
    maxEdits: runtime.limits.maxEdits,
    maxChars: Math.max(0, runtime.limits.maxChars - reserve),
    revealSteps,
    onError: (error) => runtime.log('discord 渐进编辑失败', error),
  });

  try {
    const context = buildTurnContext(runtime, interaction, prompt);
    // §64：与网关同一条规则，群里挂的是服务器昵称；取不到就留 deps 给的常量
    const botDisplayName = await resolveBotDisplayName(
      {
        botToken: runtime.deps.botToken ?? '',
        botId: runtime.deps.applicationId,
        apiBase: runtime.deps.apiBase,
        fetch: runtime.deps.fetch,
      },
      interaction.guild_id ?? '',
    );
    if (botDisplayName !== '') context.botName = botDisplayName;
    // 语音的「按指令」提示段只在 mode 1 挂上：其余模式连键都不设
    if (voiceSettings?.mode === VOICE_MODE_ON_REQUEST) context.voiceHint = true;
    const result = await runtime.deps.chat.run(context, {
      onProgress: (text) => editor.push(text),
    });
    const finalText = result.text.trim().length > 0 ? result.text : '（模型没有返回内容）';
    await editor.finish(finalText);
    // 正文发出去了才轮到自己：空回复的兜底文案不是模型的话，不念
    await sendVoiceReply(
      runtime,
      interaction,
      voiceSettings,
      finalText,
      result.voiceRequested === true && result.text.trim() !== '',
    );
  } catch (error) {
    runtime.log('discord 对话失败', error);
    // 故障提示不是聊天回复，不加 @
    mention = '';
    await editor.finish(describeChatError(error));
  }
}

/** §17.5 的四种文案之一二：成功带条数与模型；null 说明游标已追平，没有未总结内容 */
function formatSummaryOutcome(outcome: SummaryOutcome | null): string {
  if (outcome === null) return '这个频道还没有可总结的内容';
  return (
    '已总结 ' + String(outcome.summarizedMessages) + ' 条消息（模型 ' + outcome.model + '）\n\n' + outcome.summary
  );
}

/** view:true 路径：只回显游标与摘要，不带条数（这一路根本没调模型） */
function formatSummaryView(found: ConversationSummary | null): string {
  if (found === null) return '这个频道还没有摘要';
  return (
    '当前长期记忆摘要（更新于 ' +
    (formatDayMinute(found.updatedAt) || found.updatedAt) +
    '，已覆盖到消息 #' +
    String(found.coveredUntilId) +
    '）\n\n' +
    found.summary
  );
}

/** 与 describeChatError 同一套中文口径：摘要失败也要说清下一步能做什么 */
function describeSummaryError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('NO_ROUTE_CONFIGURED')) {
    return '总结失败：本频道还没有配置模型路由。请到 Web 后台「路由」页添加一条路由，或用 /model provider:<供应商> model:<模型名> 设置本频道模型，然后再试。';
  }
  if (message.includes('ALL_PROVIDERS_FAILED')) {
    return '总结失败：所有模型都调用失败，请到 Web 后台检查 Key 与模型名。';
  }
  if (message.includes('SUMMARY_EMPTY')) {
    return '总结失败：模型返回了空摘要，请重试或换一个模型。';
  }
  return '总结失败：' + message;
}

/**
 * 摘要要跑一次完整的模型调用，远超 Discord 的 3 秒预算，所以 ACK 之后单独跑这一路。
 * 任何结果（含异常）都靠编辑原消息兜住：这条路径上没有第二次机会，静默就等于用户看不到结果。
 */
async function runSummary(
  runtime: HandlerRuntime,
  rest: DiscordRestClient,
  key: ChannelKey,
  viewOnly: boolean,
): Promise<void> {
  let text: string;
  if (key.channelId === '') {
    text = '这个命令需要频道上下文，请在服务器频道里使用。';
  } else {
    try {
      text = viewOnly
        ? formatSummaryView(await runtime.deps.chat.getSummary(key))
        : formatSummaryOutcome(await runtime.deps.chat.summarize(key));
    } catch (error) {
      runtime.log('discord 总结失败', error);
      text = describeSummaryError(error);
    }
  }
  try {
    await rest.editOriginalMessage(clampForDiscord(text, runtime.limits.maxChars));
  } catch (error) {
    runtime.log('discord 总结结果编辑失败', error);
  }
}

function createRuntime(deps: InteractionHandlerDeps): HandlerRuntime {
  return {
    deps,
    limits: {
      editIntervalMs: deps.limits?.editIntervalMs ?? DEFAULT_EDIT_INTERVAL_MS,
      maxEdits: deps.limits?.maxEdits ?? DEFAULT_MAX_EDITS,
      maxChars: deps.limits?.maxChars ?? DEFAULT_MAX_CHARS,
    },
    clock: deps.clock ?? SYSTEM_CLOCK,
    log: deps.log ?? ((message, error) => {
      if (error === undefined) console.warn(message);
      else console.error(message, error);
    }),
  };
}

export function createInteractionHandler(deps: InteractionHandlerDeps): InteractionHandler {
  const runtime = createRuntime(deps);
  return async (request, ctx) => {
    if (request.method !== 'POST') return textResponse('method not allowed', 405);

    const rawBody = await request.text();
    const headers = readSignatureHeaders(request);
    const valid = await verifyEd25519Signature({
      publicKeyHex: deps.publicKeyHex,
      signatureHex: headers.signatureHex,
      timestamp: headers.timestamp,
      body: rawBody,
    });
    if (!valid) return textResponse('invalid request signature', 401);

    let interaction: DiscordInteraction;
    try {
      interaction = JSON.parse(rawBody) as DiscordInteraction;
    } catch {
      return textResponse('invalid payload', 400);
    }

    if (interaction.type === INTERACTION_TYPE_PING) return jsonResponse({ type: RESPONSE_TYPE_PONG });
    if (interaction.type !== INTERACTION_TYPE_APPLICATION_COMMAND) {
      return textResponse('unsupported interaction type', 400);
    }

    const commandName = interaction.data?.name ?? '';
    if (!findCommand(commandName)) {
      return jsonResponse(ephemeralMessage('未知命令。输入 /help 查看可用命令。'));
    }
    const options = parseCommandOptions(interaction.data?.options);

    if (requiresManageGuild(commandName, options) && !hasManageGuildPermission(interaction)) {
      return jsonResponse(ephemeralMessage('需要「管理服务器」权限才能执行 /' + commandName + ' 的这个操作。'));
    }

    switch (commandName) {
      case 'chat': {
        const prompt = readStringOption(options, 'prompt');
        if (prompt === undefined) {
          return jsonResponse(ephemeralMessage('请提供要发送的内容，例如 /chat prompt:你好'));
        }
        const token = interaction.token;
        if (!token) return jsonResponse(ephemeralMessage('交互缺少 token，无法回复。'));
        const rest = createDiscordRestClient({
          applicationId: interaction.application_id || deps.applicationId,
          interactionToken: token,
          botToken: deps.botToken,
          apiBase: deps.apiBase,
          fetch: deps.fetch,
        });
        // Discord 要求 3 秒内应答；真正的模型调用与渐进编辑全部交给 waitUntil
        ctx.waitUntil(runChat(runtime, rest, interaction, prompt));
        return jsonResponse(deferredResponse());
      }
      case 'model': {
        if (isModelViewRequest(options)) {
          const found = await resolveFirstRoute(deps.routes, scopeChain(interaction));
          return jsonResponse(privateMessage(formatRouteView(found)));
        }
        return jsonResponse(privateMessage(await handleModelSet(runtime, interaction, options)));
      }
      case 'persona': {
        if (isPersonaViewRequest(options)) {
          const found = await resolveFirstPrompt(deps.prompts, scopeChain(interaction));
          return jsonResponse(privateMessage(formatPromptView(found)));
        }
        return jsonResponse(privateMessage(await handlePersonaSet(runtime, interaction, options)));
      }
      case 'reset': {
        await deps.chat.reset({
          guildId: interaction.guild_id ?? '',
          channelId: interaction.channel_id ?? '',
        });
        return jsonResponse(privateMessage('已清空本频道的对话记录与长期记忆摘要。'));
      }
      case 'summary': {
        const token = interaction.token;
        if (!token) return jsonResponse(ephemeralMessage('交互缺少 token，无法回复。'));
        const rest = createDiscordRestClient({
          applicationId: interaction.application_id || deps.applicationId,
          interactionToken: token,
          botToken: deps.botToken,
          apiBase: deps.apiBase,
          fetch: deps.fetch,
        });
        const key: ChannelKey = { guildId: interaction.guild_id ?? '', channelId: interaction.channel_id ?? '' };
        const viewOnly = readBooleanOption(options, 'view') === true;
        // 与 /chat 同一条路径：先 ACK 再用 waitUntil 跑模型，否则 3 秒内必超时
        ctx.waitUntil(runSummary(runtime, rest, key, viewOnly));
        return jsonResponse(deferredResponse());
      }
      case 'help':
      default:
        return jsonResponse(publicMessage(HELP_TEXT));
    }
  };
}
