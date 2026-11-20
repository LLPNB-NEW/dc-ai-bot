import type { TtsDialect, TtsStyleLayer } from '../types';
import { judgeTimeoutMs } from '../timeouts';
import { isVoiceDirector, VOICE_DIRECTOR_FREE, VOICE_DIRECTOR_OFF, VOICE_DIRECTOR_TAGS } from './settings';

/** 语气提示词的上限：一份提示词不该比一段正文还长，超了多半是贴错了东西 */
export const TTS_STYLE_MAX_CHARS = 2000;

/** 语气标签的上限：标签只标情绪，40 字已经够长，再长就会盖住正文 */
export const STYLE_TAG_MAX_CHARS = 40;

/** 没有括号的一行能当标签的最长字数：超过这个长度就是在复述正文，不能被当成标签 */
const SHORT_TAG_MAX_CHARS = 20;

/** 标签的括号：半角括号是官方形状，全角与方括号是模型常见的等价写法，一并认 */
const TAG_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['(', ')'],
  ['（', '）'],
  ['[', ']'],
  ['【', '】'],
];

/** 判断情绪用的模型配置：url / key / model 三字段都非空才算配好 */
export interface TtsStyleJudgeConfig {
  url: string;
  key: string;
  model: string;
}

/**
 * 判断情绪的超时：模型要把整段正文念一遍再抄回来，耗时随字数线性增长。
 * 固定 8 秒在生产上把 150 字的真实回复整条掐断（实测这条要 8.1 秒才回），
 * 于是按字数给预算：默认 15 秒起步、每字 40 毫秒、最多 45 秒，三档都能在后台「超时」改（`judgeTimeoutMs`）。
 */
/**
 * 判断情绪的输出上限：模型要把正文原样抄回来，而正文本身不设字数上限，
 * 上限只防跑飞；真抄不全也只是逐字校验不过、标签留着、正文退回原文。
 */
const JUDGE_MAX_TOKENS = 4_000;
const JUDGE_TEMPERATURE = 0.4;

/**
 * 内置判断指令：教模型写 MiMo 要求的形状 —— 一行「(标签)原文」。
 * 标签放括号里，原文必须逐字相同（只许插入 [音频标签]），解析才不必猜格式。
 */
export const JUDGE_SYSTEM =
  '读下面这句话，只输出一行，形如「(怅然)原文」：开头是半角括号包住的语气标签（可以多个词用空格分隔，不超过 20 字），' +
  '后面紧跟原文。原文必须与输入逐字相同；需要时只能在原文里插入 [音频标签]（如 [轻笑]、[叹气]、[语速加快]），' +
  '一个字都不能增删改。不要解释、不要引号、不要换行。';

/**
 * 导演两档共用的规则：开头是整体风格组，正文里可以插细粒度音频标签。
 * 两档的差别只在「正文能不能改」，所以形状与风格的来源写在这里。
 */
export const JUDGE_DIRECTOR_COMMON =
  '开头 (风格1 风格2) 是整体风格；紧跟其后的正文每一句前面都要加一个括号标签写语气或说话方式' +
  '（如（轻声）、（语速加快）、（笑着）），' +
  '正文任意位置还可以插 [音频标签] 做细粒度控制，括号可以用半角 ()、全角（）或 []；' +
  '唱歌时整体风格组里要有一个 (唱歌)，并且整段歌词只在这一个地方标一次，不要给每句歌词加标签，歌词用中文。' +
  '风格按这一条内容自己挑，后台给的【风格要求】只当偏好，与内容冲突时以内容为准。';

/**
 * Gemini 的标签形状：与 MiMo 同一个「(风格)正文」外形，但只认英文单词。
 * 实测（2026-11-09，relay 探针）：中文标签会被逐字念出来 —— [轻笑] 让同一句从 2.2 秒变 2.8 秒、
 * [轻笑啊呀这是] 变 5.6 秒；英文的 [whispers] 与 (whispering) 则明显改变发音而不占时长。
 * 所以给 gemini 方言单独一份指令：外形不变，所有标签换成英文。
 */
export const GEMINI_TAG_RULE =
  '所有标签都必须用英文小写单词：开头的风格组如 (wistful soft)、(cheerful)、(nervous)，' +
  '正文里的音频标签如 [chuckles]、[laughs]、[sigh]、[whispers]、[gasp]、[faster]、[slow]、[sarcasm]；' +
  '写中文标签会被原样念出来，一个字都不要翻译成中文。';

/** Gemini 版的逐字指令：外形与 JUDGE_SYSTEM 相同，只把示例换成英文标签 */
export const GEMINI_JUDGE_SYSTEM =
  '读下面这句话，只输出一行，形如「(wistful)原文」：开头是半角括号包住的英文语气组（可以多个词用空格分隔，不超过 20 字），' +
  '后面紧跟原文。原文必须与输入逐字相同；需要时只能在原文里插入英文音频标签（如 [chuckles]、[sigh]、[faster]），' +
  '一个字都不能增删改。不要解释、不要引号、不要换行。' +
  GEMINI_TAG_RULE;

/** Gemini 版的导演通用规则：中文标签会被念出来，这里只教英文标签 */
export const GEMINI_JUDGE_DIRECTOR_COMMON =
  '开头 (风格1 风格2) 是整体风格；紧跟其后的正文每一句前面都要加一个括号标签写语气或说话方式' +
  '（如 (soft)、(faster)、(teasing)），' +
  '正文任意位置还可以插 [音频标签] 做细粒度控制，括号可以用半角 ()、全角（）或 []；' +
  GEMINI_TAG_RULE +
  '唱歌时整体风格组里要有一个 (singing)，并且整段歌词只在这一个地方标一次，不要给每句歌词加标签，歌词保持中文。' +
  '风格按这一条内容自己挑，后台给的【风格要求】只当偏好，与内容冲突时以内容为准。';

/** director = 1 追加的规则：正文一个字都不许改，只许插标签 */
export const JUDGE_DIRECTOR_TAGS_RULE =
  '不许改一个字，只能插标签：正文必须与输入逐字相同，只允许新增或保留括号组与方括号组。';

/** director = 2 追加的规则：可以顺句改写，但事实、称呼、人称不许动，长度有护栏 */
export const JUDGE_DIRECTOR_FREE_RULE =
  '可以口语化改写，但事实、称呼、人称不许改，长度控制在原文的 0.3 到 3 倍。';

/** 导演两档共用的输出形状：只要一行，不要解释 */
const JUDGE_DIRECTOR_SHAPE = '只输出这一行：不要解释、不要引号、不要换行。';

/**
 * 按导演档位拼系统指令：0 档沿用逐字朗读的旧指令（一个字都不变），
 * 1 / 2 档换成「开头风格组 + 正文可插标签」的新指令，有风格要求就附在最后。
 */
export function judgeSystemFor(director: number, prompt: string, dialect?: TtsDialect): string {
  const withPrompt = (base: string): string =>
    prompt === '' ? base : base + '\n【风格要求】' + prompt;
  // gemini 只认英文标签：中文标签会被它当正文念出来，所以整套指令换成英文示例
  const gemini = dialect === 'gemini';
  if (director === VOICE_DIRECTOR_TAGS) {
    return withPrompt(
      '读下面这段内容，把它念出来：只输出一行，开头是整体风格组，正文照原文不许改字，只许插标签。' +
        (gemini ? GEMINI_JUDGE_DIRECTOR_COMMON : JUDGE_DIRECTOR_COMMON) +
        JUDGE_DIRECTOR_TAGS_RULE +
        JUDGE_DIRECTOR_SHAPE,
    );
  }
  if (director === VOICE_DIRECTOR_FREE) {
    return withPrompt(
      '读下面这段内容，把它念出来：只输出一行，开头是整体风格组，正文按内容口语化改写。' +
        (gemini ? GEMINI_JUDGE_DIRECTOR_COMMON : JUDGE_DIRECTOR_COMMON) +
        JUDGE_DIRECTOR_FREE_RULE +
        JUDGE_DIRECTOR_SHAPE,
    );
  }
  return withPrompt(gemini ? GEMINI_JUDGE_SYSTEM : JUDGE_SYSTEM);
}

/** 三层语气提示词：channel / guild / global 各自可空 */
export interface TtsStyleLayers {
  channel: TtsStyleLayer | null;
  guild: TtsStyleLayer | null;
  global: TtsStyleLayer | null;
}

/**
 * 导演模式没拿到 judge 那一行的原因：护栏退回（empty/verbatim/residue/ratio）之外，
 * 还有「判断模型根本没回话」这一类（judge 没配、超时、报错、JSON 坏），单独记作 judge。
 */
export type VoiceDirectorRejection = 'empty' | 'verbatim' | 'residue' | 'ratio' | 'judge';

/** 一条语音的最终形状：标签（含括号，空串 = 无标签）+ 要念的正文 + 导演模式的风格组原文 */
export interface VoiceSpeech {
  tag: string;
  text: string;
  /**
   * 导演模式下开头那个风格组的原文（含括号，空串 = 没有）。
   * 这时风格已经长在正文里、tag 必为空串，日志只能靠它看出这条用了什么风格。
   */
  styleLabel: string;
  /** 只有导演模式退回原文时才有值：后台试听靠它看出是哪条护栏拦下的 */
  directorRejected?: VoiceDirectorRejection;
}

/** 三字段都非空才算配好了 judge；空白字段等于没配 */
export function isJudgeConfigured(
  judge: TtsStyleJudgeConfig | null | undefined,
): judge is TtsStyleJudgeConfig {
  return (
    judge !== null &&
    judge !== undefined &&
    judge.url.trim() !== '' &&
    judge.key.trim() !== '' &&
    judge.model.trim() !== ''
  );
}

/**
 * 三层按 channel -> guild -> global 取第一个 trim 非空的正文；全空返回空串。
 * 这里返回 trim 后的值：提示词首尾的空白进 system 没有意义，留着只会让请求体不可比。
 */
export function resolveStylePrompt(layers: TtsStyleLayers): string {
  for (const layer of [layers.channel, layers.guild, layers.global]) {
    if (layer === null) continue;
    const content = layer.content.trim();
    if (content !== '') return content;
  }
  return '';
}

/**
 * 去掉整段包裹的括号：模型常把标签写成「(怅然)」「【怅然】」甚至套两层。
 * 只剥首尾成对的那一层，剥到不能再剥为止；句中括号（「(笑)着说」）不在此列。
 */
function unwrapTagBrackets(raw: string): string {
  let current = raw;
  for (;;) {
    const trimmed = current.trim();
    const pair = TAG_PAIRS.find(
      ([open, close]) =>
        trimmed.length >= open.length + close.length &&
        trimmed.startsWith(open) &&
        trimmed.endsWith(close),
    );
    if (pair === undefined) return trimmed;
    current = trimmed.slice(pair[0].length, trimmed.length - pair[1].length);
  }
}

/**
 * 去掉整体包裹的引号：模型常把整句话装进引号里。
 * 只剥一层且必须首尾成对，句中的引号（「他说“好”」）原样保留。
 */
function unwrapQuotes(raw: string): string {
  const pairs: ReadonlyArray<readonly [string, string]> = [
    ['"', '"'],
    ['「', '」'],
    ["'", "'"],
  ];
  for (const [open, close] of pairs) {
    if (raw.length >= 2 && raw.startsWith(open) && raw.endsWith(close)) {
      return raw.slice(open.length, raw.length - close.length).trim();
    }
  }
  return raw;
}

/**
 * 标签归一化：一个标签在库里、线缆上、日志里都只有这一种写法 —— 半角括号包一层。
 * 空白压成单空格、剥引号、剥已有的括号，再截到 40 字；空标签返回空串（= 没有语气）。
 */
export function normalizeStyleTag(raw: string): string {
  if (typeof raw !== 'string') return '';
  let value = raw.replace(/\s+/gu, ' ').trim();
  value = unwrapQuotes(value);
  value = unwrapTagBrackets(value);
  value = value.replace(/\s+/gu, ' ').trim();
  value = value.slice(0, STYLE_TAG_MAX_CHARS).trim();
  return value === '' ? '' : '(' + value + ')';
}

/** 把指定的一对括号里的内容全部丢掉；没有配对的收尾就原样留着，不猜模型想说什么 */
function dropPaired(text: string, open: string, close: string): string {
  let kept = '';
  let rest = text;
  for (;;) {
    const start = rest.indexOf(open);
    if (start < 0) return kept + rest;
    const end = rest.indexOf(close, start + open.length);
    if (end < 0) return kept + rest;
    kept += rest.slice(0, start);
    rest = rest.slice(end + close.length);
  }
}

/**
 * 只用于校验「正文有没有被改字」：去掉所有成对段（(...)（...）[...]【...】）再把空白压成一个。
 * 它不产出可以念的文本，所以丢掉的段不补回来。
 */
export function stripVoiceTags(text: string): string {
  let out = text;
  for (const [open, close] of TAG_PAIRS) out = dropPaired(out, open, close);
  // 英文标签天生带空格：「累，(soft) 你」删掉标签会留下「， 你」，与原文「，你」就不再逐字相同。
  // 中文标点两侧本来就不该有空格，所以这里两边一起去掉，避免「标签写得对、空格把它判成改字」。
  return out
    .replace(/\s+/gu, ' ')
    .replace(/\s*([，。！？；：、）】」』…])\s*/gu, '$1')
    .trim();
}

/** 一行是不是「短到只能当标签」：没有句读、点号，且不超过 20 字 */
function looksLikeBareTag(line: string): boolean {
  if (line === '') return false;
  if (Array.from(line).length > SHORT_TAG_MAX_CHARS) return false;
  return !/[。！？；]/u.test(line);
}

/**
 * 把 judge 回的一行拆成「标签 + 正文」，正文一个字都不许改。
 * 四种结局：
 * 1. 行首是括号且配对，剩下的正文与原文逐字相同（只多/少了可被 stripVoiceTags 抹掉的段）→ 标签与 judge 那句正文都用；
 * 2. 行首是括号且配对，但正文被动过（多抄一个标点、追加一句解释）→ 标签留下，正文退回原文：
 *    语气不该因为 judge 多写一个字就整条消失，但改过的正文一个字都不能念；
 * 3. 行首不是括号，但整行短得像标签（≤20 字、没有句读）→ 整行当标签，正文仍用原文；
 * 4. 其余（括号后没有正文、括号没有配对收尾）一律不认：tag 空串、text 原文。
 */
export function applyJudgeLine(original: string, line: string): VoiceSpeech {
  const trimmed = line.trim();
  const pair = TAG_PAIRS.find(([open]) => trimmed.startsWith(open));
  if (pair !== undefined) {
    const end = trimmed.indexOf(pair[1], pair[0].length);
    // 行首有括号却没有配对的收尾：这一行没法拆，按「没有可用标签」处理
    if (end < 0) return { tag: '', text: original, styleLabel: '' };
    const remainder = trimmed.slice(end + pair[1].length).trim();
    // 括号里的东西已经解析出来了：成不成都先认它当标签
    const bracketTag = normalizeStyleTag(trimmed.slice(pair[0].length, end));
    // 括号后什么都没有：没有正文可念，整行作废
    if (remainder === '') return { tag: '', text: original, styleLabel: '' };
    return stripVoiceTags(remainder) === stripVoiceTags(original)
      ? { tag: bracketTag, text: remainder, styleLabel: '' }
      : { tag: bracketTag, text: original, styleLabel: '' };
  }
  if (looksLikeBareTag(trimmed))
    return { tag: normalizeStyleTag(trimmed), text: original, styleLabel: '' };
  return { tag: '', text: original, styleLabel: '' };
}

/** 取出开头那个括号组的原文（含括号）；开头不是括号组、或括号没配对，都返回空串 */
function leadingStyleGroup(line: string): string {
  const pair = TAG_PAIRS.find(([open]) => line.startsWith(open));
  if (pair === undefined) return '';
  const end = line.indexOf(pair[1], pair[0].length);
  return end < 0 ? '' : line.slice(0, end + pair[1].length);
}

/** 按码点数字数：中文与 emoji 都算一个字，与日志里的「字数」同一口径 */
function charCount(text: string): number {
  return Array.from(text).length;
}

/** [[voice]] 这类指令残留：两侧双方括号的段落不是能念的内容，出现即判不合格 */
const INSTRUCTION_RESIDUE = /\[\[[^\[\]]*\]\]/u;

/** 导演模式改写长度的护栏：默认 0.3–3 倍，原文太短时上限换成「原文 + 200 字」 */
const DIRECTOR_MIN_RATIO = 0.3;
const DIRECTOR_MAX_RATIO = 3;
const DIRECTOR_SHORT_CHARS = 20;
const DIRECTOR_SHORT_SLACK = 200;

/**
 * 导演模式（1 / 2）把 judge 回的那一行变成要念的语音。
 * 放行：正文用候选全文（开头风格组与中途标签都留在里面），tag 一定是空串 ——
 * 风格组已经长在正文里，再当标签拼前缀就会被念两遍；styleLabel 只把这组原文留给日志。
 * 不放行：正文退回原文，标签退回提示词的兜底语义（与 judge 失败时的旧口径一致）。
 *
 * 1 档只允许插标签：候选与原文都删掉成对的标签段之后必须逐字相同，一个字都不许改。
 * 2 档允许改写：只留护栏 —— 非空、去标签后的字数在 0.3–3 倍（短文本放宽到原文 + 200 字）、
 * 没有 [[voice]] 这类指令残留。事实与人称靠提示词约束，代码不去猜。
 */
function applyDirectedLine(
  original: string,
  line: string,
  director: 1 | 2,
  fallbackTag: string,
): VoiceSpeech {
  const candidate = line.trim();
  const styleLabel = leadingStyleGroup(candidate);
  const reject = (reason: VoiceDirectorRejection): VoiceSpeech => ({
    tag: fallbackTag,
    text: original,
    styleLabel,
    directorRejected: reason,
  });
  if (candidate === '') return reject('empty');
  const body = stripVoiceTags(candidate);
  // 删完标签什么都不剩：没有正文可念，整行作废
  if (body === '') return reject('empty');
  if (director === VOICE_DIRECTOR_TAGS) {
    const unchanged = body === stripVoiceTags(original);
    return unchanged ? { tag: '', text: candidate, styleLabel } : reject('verbatim');
  }
  if (INSTRUCTION_RESIDUE.test(candidate)) return reject('residue');
  const originalChars = charCount(stripVoiceTags(original));
  const bodyChars = charCount(body);
  const ceiling =
    originalChars < DIRECTOR_SHORT_CHARS
      ? originalChars + DIRECTOR_SHORT_SLACK
      : originalChars * DIRECTOR_MAX_RATIO;
  const floor = originalChars * DIRECTOR_MIN_RATIO;
  return bodyChars >= floor && bodyChars <= ceiling
    ? { tag: '', text: candidate, styleLabel }
    : reject('ratio');
}

/** 只把真正的对象当前进：数组、null、标量都不算「有这一层」 */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 取 choices[0].message.content；缺任何一层都返回 null（结构照 OpenAI 兼容接口，不猜别的字段名） */
function readJudgeContent(payload: unknown): string | null {
  const root = asRecord(payload);
  if (root === null) return null;
  const choices = root['choices'];
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const message = asRecord(asRecord(choices[0])?.['message']);
  if (message === null) return null;
  const content = message['content'];
  return typeof content === 'string' ? content : null;
}

/** 去尾斜杠：后台常常把地址贴成末尾带斜杠的样子 */
function trimTrailingSlash(url: string): string {
  return url.trim().replace(/\/+$/u, '');
}

/** 判断模型 + 导演档位的入参 */
export interface VoiceSpeechInput {
  text: string;
  prompt: string;
  judge: TtsStyleJudgeConfig | null;
  /**
   * 导演模式：0 = 关（逐字朗读），1 = 只许插标签，2 = 允许顺句改写。
   * 缺省（含后台试听这类不传的老调用点）按 0 处理，行为与改动前逐字一致。
   */
  director?: number;
  /**
   * 合成方言：决定 judge 用哪套标签示例。gemini 只认英文标签（中文会被念出来），
   * 缺省按 mimo 处理，行为与加这个字段之前逐字相同。
   */
  dialect?: TtsDialect;
  fetchImpl?: typeof fetch;
  /**
   * 诊断出口：judge 真的回了一行时，把整行交出去（成功日志写 judge=…，试听原样回显）。
   * 只在拿回可用内容时调用一次；judge 没回、超时、报错都不调用。回调抛错不影响这次判断。
   */
  onJudgeLine?: (line: string) => void;
}

/**
 * 每条语音的最终形状：先按「这句话」问一次 judge 要一行「(标签)原文」，
 * 拆不开或判断失败就退回三层提示词本身当标签、正文用原文。
 * 导演模式（1 / 2）把 judge 当改写器：过了护栏就用它写的那一份全文，风格组只在正文里出现一次。
 * 绝不抛：判断失败只是少一层语气，语音该照发。
 */
export async function composeVoiceSpeech(input: VoiceSpeechInput): Promise<VoiceSpeech> {
  const original = input.text;
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  // 脏值（3、1.5、字符串）当作没配导演模式：读坏了不该改掉逐字朗读的老行为
  const director = isVoiceDirector(input.director) ? input.director : VOICE_DIRECTOR_OFF;
  // 未配置 / 失败时的兜底：提示词本身就是标签，正文永远用原文
  const fallback: VoiceSpeech = { tag: normalizeStyleTag(prompt), text: original, styleLabel: '' };
  // 导演模式另外记一笔「judge 没回话」，否则后台看到的和护栏退回长得一样
  const judgeFailed = (): VoiceSpeech =>
    director === VOICE_DIRECTOR_OFF ? fallback : { ...fallback, directorRejected: 'judge' };

  try {
    const judge = input.judge;
    if (!isJudgeConfigured(judge)) return judgeFailed();

    // 有风格要求就拼在系统指令后面：同一段 system 里既说「写一行」也说「照这个风格」
    const system = judgeSystemFor(director, prompt, input.dialect);
    const body = {
      model: judge.model.trim(),
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: original },
      ],
      max_tokens: JUDGE_MAX_TOKENS,
      temperature: JUDGE_TEMPERATURE,
    };
    const doFetch = input.fetchImpl ?? ((raw: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
      globalThis.fetch(raw, init));
    const response = await doFetch(trimTrailingSlash(judge.url) + '/chat/completions', {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + judge.key.trim(),
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(judgeTimeoutMs(charCount(original))),
    });
    if (!response.ok) return judgeFailed();
    const content = readJudgeContent(await response.json());
    if (content === null) return judgeFailed();

    // 只认首行：模型偶尔会多带一行解释，第二行起一律不看
    const line = unwrapQuotes((content.split(/\r?\n/u)[0] ?? '').trim());
    // 诊断：把 judge 写的这一整行交出去。回调抛错只是少一条日志，不能算判断失败。
    if (line !== '') {
      try {
        input.onJudgeLine?.(line);
      } catch {
        // 诊断不该改变念法
      }
    }
    // 导演模式不走逐字校验：它允许改写，护栏在 applyDirectedLine 里
    if (director !== VOICE_DIRECTOR_OFF) {
      return applyDirectedLine(original, line, director, fallback.tag);
    }
    const applied = applyJudgeLine(original, line);
    // 判定无标签时，标签退回提示词；正文仍用 judge 那句（此时它就是原文）
    const result =
      applied.tag === '' ? { tag: fallback.tag, text: applied.text, styleLabel: '' } : applied;
    // 最后一道保险：正文除了可被 stripVoiceTags 抹掉的部分，必须与原文一致
    return stripVoiceTags(result.text) === stripVoiceTags(original)
      ? result
      : { tag: result.tag, text: original, styleLabel: '' };
  } catch {
    // 网络、超时、坏 JSON、结构不符、异常：都按「没判断出来」处理
    return judgeFailed();
  }
}
