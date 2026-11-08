import type { ProviderId } from '../../core/types';

/** 交互 payload 里本层用到的字段（Discord 实际字段的超集裁剪，未用字段不声明） */
export interface DiscordInteractionUser {
  id: string;
  username: string;
  global_name?: string | null;
}

export interface DiscordInteractionMember {
  user?: DiscordInteractionUser;
  nick?: string | null;
  /** 权限位图，十进制字符串（如 ManageGuild = 32） */
  permissions?: string;
}

export interface DiscordInteractionOption {
  name: string;
  type: number;
  value?: string | number | boolean;
  options?: DiscordInteractionOption[];
}

export interface DiscordInteractionData {
  name?: string;
  options?: DiscordInteractionOption[];
}

export interface DiscordInteraction {
  id: string;
  application_id: string;
  type: number;
  token?: string;
  data?: DiscordInteractionData;
  guild_id?: string;
  channel_id?: string;
  member?: DiscordInteractionMember;
  user?: DiscordInteractionUser;
}

export const INTERACTION_TYPE_PING = 1;
export const INTERACTION_TYPE_APPLICATION_COMMAND = 2;
export const RESPONSE_TYPE_PONG = 1;
export const RESPONSE_TYPE_MESSAGE = 4;
export const RESPONSE_TYPE_DEFERRED = 5;
/** Discord 的 ephemeral 标志位，只能出现在响应 body 里 */
export const MESSAGE_FLAG_EPHEMERAL = 64;
export const OPTION_TYPE_STRING = 3;
export const OPTION_TYPE_BOOLEAN = 5;
/** ManageGuild */
export const MANAGE_GUILD = 0x20n;

export const PROVIDER_IDS: readonly ProviderId[] = ['openai-compat', 'anthropic', 'gemini'];

const PROVIDER_LABELS: Record<ProviderId, string> = {
  'openai-compat': 'OpenAI 兼容（OpenAI / DeepSeek / Kimi / Qwen…）',
  anthropic: 'Anthropic',
  gemini: 'Google Gemini',
};

export interface DiscordCommandChoice {
  name: string;
  value: ProviderId;
}

export interface DiscordCommandOptionDefinition {
  type: number;
  name: string;
  description: string;
  required?: boolean;
  choices?: DiscordCommandChoice[];
}

export interface DiscordCommandDefinition {
  name: string;
  type: 1;
  description: string;
  options?: DiscordCommandOptionDefinition[];
}

const PROVIDER_CHOICES: DiscordCommandChoice[] = PROVIDER_IDS.map((id) => ({ name: PROVIDER_LABELS[id], value: id }));

/**
 * 命令集（architecture §12 表格）。scripts/register-commands.mjs 必须与此逐字一致：
 * 命令名、选项名、类型、required、choices 的 value 都是对外契约。
 */
export const COMMANDS: readonly DiscordCommandDefinition[] = [
  {
    name: 'chat',
    type: 1,
    description: '与模型对话',
    options: [{ type: OPTION_TYPE_STRING, name: 'prompt', description: '你想对模型说的话', required: true }],
  },
  {
    name: 'model',
    type: 1,
    description: '查看或设置本频道使用的模型',
    options: [
      { type: OPTION_TYPE_BOOLEAN, name: 'view', description: '只看当前生效的模型配置' },
      { type: OPTION_TYPE_STRING, name: 'provider', description: '供应商', choices: PROVIDER_CHOICES },
      { type: OPTION_TYPE_STRING, name: 'model', description: '模型名，例如 gpt-4o-mini' },
    ],
  },
  {
    name: 'persona',
    type: 1,
    description: '查看或设置本频道的人格与系统提示词',
    options: [
      { type: OPTION_TYPE_BOOLEAN, name: 'view', description: '只看当前生效的人格与系统提示词' },
      { type: OPTION_TYPE_STRING, name: 'persona', description: '人格描述，留空表示不修改' },
      { type: OPTION_TYPE_STRING, name: 'system', description: '系统提示词，可用 {{user_name}} 等变量' },
    ],
  },
  {
    name: 'reset',
    type: 1,
    description: '清空本频道的会话记忆',
  },
  {
    name: 'help',
    type: 1,
    description: '查看命令用法',
  },
  {
    name: 'summary',
    type: 1,
    description: '总结这个频道的长期记忆',
    options: [{ type: OPTION_TYPE_BOOLEAN, name: 'view', description: '只看当前摘要，不重新总结' }],
  },
];

export type CommandOptionMap = Record<string, string | number | boolean>;

export function findCommand(name: string): DiscordCommandDefinition | undefined {
  return COMMANDS.find((command) => command.name === name);
}

/** 只处理一层（本 v1 不用 subcommand / subcommand group） */
export function parseCommandOptions(
  options?: readonly DiscordInteractionOption[] | null,
): CommandOptionMap {
  const map: CommandOptionMap = {};
  for (const option of options ?? []) {
    if (option.value !== undefined) map[option.name] = option.value;
  }
  return map;
}

export function readStringOption(map: CommandOptionMap, name: string): string | undefined {
  const value = map[name];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function readBooleanOption(map: CommandOptionMap, name: string): boolean | undefined {
  const value = map[name];
  return typeof value === 'boolean' ? value : undefined;
}

/** 没有提供 provider/model 视为查看；显式 view:true 也视为查看 */
export function isModelViewRequest(options: CommandOptionMap): boolean {
  if (readBooleanOption(options, 'view') === true) return true;
  return readStringOption(options, 'provider') === undefined && readStringOption(options, 'model') === undefined;
}

export function isPersonaViewRequest(options: CommandOptionMap): boolean {
  if (readBooleanOption(options, 'view') === true) return true;
  return readStringOption(options, 'persona') === undefined && readStringOption(options, 'system') === undefined;
}

/** architecture §12：/model 只在 set 路径上要求 ManageGuild；/persona、/reset 全路径要求 */
export function requiresManageGuild(commandName: string, options: CommandOptionMap): boolean {
  switch (commandName) {
    case 'model':
      return !isModelViewRequest(options);
    case 'persona':
    case 'reset':
      return true;
    default:
      return false;
  }
}

export function hasManageGuildPermission(interaction: DiscordInteraction): boolean {
  const raw = interaction.member?.permissions;
  if (typeof raw !== 'string' || raw.length === 0) return false;
  try {
    return (BigInt(raw) & MANAGE_GUILD) === MANAGE_GUILD;
  } catch {
    // 非法位图当作无权限，不能因为脏数据就放行
    return false;
  }
}

export function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value);
}
