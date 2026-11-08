import { useEffect, useRef, useState } from 'react';
import {
  SCOPE_LABELS,
  TTS_SETTINGS_DEFAULTS,
  TTS_STYLE_MAX_CHARS,
  VOICE_DIRECTOR_IDS,
  VOICE_MODE_IDS,
  VOICE_SETTINGS_DEFAULT,
  VOICE_SPEED_DEFAULT,
  VOICE_SPEED_MAX,
  VOICE_SPEED_MIN,
  VOICE_SUGGESTIONS,
  clearTtsSettings,
  clearTtsStyleLayer,
  clearVoiceSetting,
  describeScopeTarget,
  describeTtsError,
  describeVoiceDirector,
  describeVoiceDirectorRejection,
  describeVoiceMode,
  describeVoiceSettingsError,
  fetchTtsSettings,
  fetchTtsStyleLayers,
  fetchVoiceSettings,
  normalizeScopeId,
  saveTtsSettings,
  saveTtsStyleLayer,
  saveVoiceSetting,
  testTtsSettings,
  type Scope,
  type TtsDialect,
  type TtsDialectOption,
  type TtsSettingsSnapshot,
  type TtsStyleLayer,
  type VoiceSettingsDefault,
  type VoiceSettingsRow,
  type VoiceSettingsSnapshot,
} from '../api';
import ScopeField from '../components/ScopeField';

// 语音卡片的行查找与生效值：与回复页前两张卡同一套兜底规则（命中本层 → global → 默认）。
function findVoiceRow(items: VoiceSettingsRow[], scope: Scope, scopeId: string): VoiceSettingsRow | undefined {
  const target = normalizeScopeId(scope, scopeId);
  return items.find((item) => item.scope === scope && item.scopeId === target);
}

interface VoiceEffectiveValue {
  mode: number;
  director: number;
  voice: string;
  speed: number;
  /** 命中的那一层；null = 三层都没配，用的是接口的 default。 */
  from: VoiceSettingsRow | null;
}

// 频道这一层只知道频道 ID、不知道它属于哪个服务器，所以 guild 层不参与；要按服务器兜请直接选服务器层。
function resolveVoiceEffectiveValue(
  items: VoiceSettingsRow[],
  scope: Scope,
  scopeId: string,
  fallback: VoiceSettingsDefault,
): VoiceEffectiveValue {
  const self = findVoiceRow(items, scope, scopeId);
  if (self !== undefined) {
    return { mode: self.mode, director: self.director, voice: self.voice, speed: self.speed, from: self };
  }
  if (scope !== 'global') {
    const globalRow = findVoiceRow(items, 'global', '');
    if (globalRow !== undefined) {
      return {
        mode: globalRow.mode,
        director: globalRow.director,
        voice: globalRow.voice,
        speed: globalRow.speed,
        from: globalRow,
      };
    }
  }
  return { mode: fallback.mode, director: fallback.director, voice: fallback.voice, speed: fallback.speed, from: null };
}

// 某一套方言的地址占位 / 音色建议；接口没给这一项就退回内置那份，下拉不能空着。
function resolveTtsDialectOption(dialects: TtsDialectOption[], dialect: TtsDialect): TtsDialectOption {
  const found = dialects.find((option) => option.id === dialect);
  if (found !== undefined) return found;
  const builtin = TTS_SETTINGS_DEFAULTS.dialects.find((option) => option.id === dialect);
  return builtin === undefined ? TTS_SETTINGS_DEFAULTS.dialects[0] : builtin;
}

// 语气层只按 scope + scopeId 定位：global 固定空串，与语音回复卡同一套归一规则。
function findStyleLayer(items: TtsStyleLayer[], scope: Scope, scopeId: string): TtsStyleLayer | undefined {
  const target = normalizeScopeId(scope, scopeId);
  return items.find((item) => item.scope === scope && item.scopeId === target);
}

// 列表里只放摘要：原文可能两千字，一行放不下；要改就切到那一层，原文会填回 textarea。
function summarizeStyleContent(content: string): string {
  const flat = content.replace(/\s+/gu, ' ').trim();
  return flat.length <= 48 ? flat : flat.slice(0, 48) + '…';
}

// 语气示例都按 MiMo 的标签写法给：点一下只填当前层的草稿，不新增层，也不落库。
const TTS_STYLE_EXAMPLES: string[] = ['(怅然)', '(温柔，语速放缓)', '(东北话)', '(唱歌)'];

// 试听回显：有标签就「标签 + 正文」，正文原样（[音频标签] 不动）；老响应没有 speechUsed 时只剩标签。
function describeTtsActual(styleUsed: string | null, speechUsed: string | undefined): string {
  const speech = typeof speechUsed === 'string' && speechUsed.trim() !== '' ? speechUsed : '';
  if (styleUsed === null) return speech;
  return speech === '' ? styleUsed : styleUsed + speech;
}

// 一行说清「怎么发 / 导演模式 / 什么音色 / 多快」：生效值与列表两处共用，省得文案慢慢走偏。
function describeVoiceConfig(mode: number, voice: string, speed: number, director: number): string {
  const voiceLabel = voice === '' ? '服务器默认' : voice;
  return (
    describeVoiceMode(mode) +
    ' · 导演 ' +
    describeVoiceDirector(director) +
    ' · 音色 ' +
    voiceLabel +
    ' · 语速 ' +
    String(speed) +
    '%'
  );
}

// 只到秒：库里是 ISO，毫秒对排查没意义，还会把列表行撑宽。
function formatUpdatedAt(updatedAt: string): string {
  if (updatedAt === '') return '未知时间';
  const value = new Date(updatedAt);
  if (Number.isNaN(value.getTime())) return updatedAt;
  return value.toLocaleString('zh-CN', { hour12: false });
}

// 输入框存原样字符串：用户打到一半（空、'-'、'1.'）时不该被改写成 100。
function parseIntInRange(raw: string, min: number, max: number): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  // Number.isInteger 同时挡掉 NaN 与 Infinity。
  if (!Number.isInteger(value)) return null;
  return value < min || value > max ? null : value;
}

// mp3 字节要按字节还原：atob 出来的是 latin1 字符串，直接丢给 Blob 会当 UTF-8 再编一遍，声音就废了。
function decodeBase64(base64: string): Uint8Array<ArrayBuffer> | null {
  const cleaned = base64.replace(/\s+/gu, '');
  if (cleaned === '') return null;
  let binary = '';
  try {
    binary = atob(cleaned);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export default function VoicePage() {
  // 语音合成接口卡片：GET 回来的快照是唯一事实来源，输入框只是它的草稿。
  const [ttsSettings, setTtsSettings] = useState<TtsSettingsSnapshot | null>(null);
  const [ttsUrl, setTtsUrl] = useState('');
  const [ttsKey, setTtsKey] = useState('');
  const [ttsVoice, setTtsVoice] = useState('');
  // 情绪判断模型三项：Key 只镜像掩码，输入框留空 = 不改库里那把。
  const [ttsJudgeUrl, setTtsJudgeUrl] = useState('');
  const [ttsJudgeKey, setTtsJudgeKey] = useState('');
  const [ttsJudgeModel, setTtsJudgeModel] = useState('');
  const [ttsDialect, setTtsDialect] = useState<TtsDialect>(TTS_SETTINGS_DEFAULTS.defaultDialect);
  const [ttsBusy, setTtsBusy] = useState('');
  const [ttsMessage, setTtsMessage] = useState('');
  const [ttsError, setTtsError] = useState('');
  // 朗读语气卡片：三层原文 + 单层上限；草稿只属于当前选中的那一层。
  const [styleLayers, setStyleLayers] = useState<TtsStyleLayer[]>([]);
  const [styleMaxChars, setStyleMaxChars] = useState(TTS_STYLE_MAX_CHARS);
  const [styleScope, setStyleScope] = useState<Scope>('global');
  const [styleScopeId, setStyleScopeId] = useState('');
  const [styleDraft, setStyleDraft] = useState('');
  const [styleBusy, setStyleBusy] = useState('');
  const [styleMessage, setStyleMessage] = useState('');
  const [styleError, setStyleError] = useState('');
  const [previewMessage, setPreviewMessage] = useState('');
  const [previewError, setPreviewError] = useState('');
  // 只影响这次试听：正式回复的导演档在下面「语音回复」卡片里按三层存。
  const [previewDirector, setPreviewDirector] = useState(VOICE_SETTINGS_DEFAULT.director);
  // 试听换一次就停掉上一段：两个声音叠着放，听不出哪段是新的。
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string>('');

  // 语音回复卡片第三套 state：同样只脏自己的提示，不牵连上面那张接口卡片。
  const [voiceItems, setVoiceItems] = useState<VoiceSettingsRow[]>([]);
  const [voiceDefault, setVoiceDefault] = useState<VoiceSettingsDefault>(VOICE_SETTINGS_DEFAULT);
  const [voiceModes, setVoiceModes] = useState<number[]>(VOICE_MODE_IDS);
  const [voiceDirectorModes, setVoiceDirectorModes] = useState<number[]>(VOICE_DIRECTOR_IDS);
  const [voiceSpeedMin, setVoiceSpeedMin] = useState(VOICE_SPEED_MIN);
  const [voiceSpeedMax, setVoiceSpeedMax] = useState(VOICE_SPEED_MAX);
  const [voiceLoaded, setVoiceLoaded] = useState(false);
  const [voiceScope, setVoiceScope] = useState<Scope>('global');
  const [voiceScopeId, setVoiceScopeId] = useState('');
  const [voiceDraftMode, setVoiceDraftMode] = useState(VOICE_SETTINGS_DEFAULT.mode);
  const [voiceDraftDirector, setVoiceDraftDirector] = useState(VOICE_SETTINGS_DEFAULT.director);
  const [voiceDraftName, setVoiceDraftName] = useState(VOICE_SETTINGS_DEFAULT.voice);
  const [voiceDraftSpeed, setVoiceDraftSpeed] = useState(String(VOICE_SPEED_DEFAULT));
  const [voiceBusy, setVoiceBusy] = useState('');
  const [voiceMessage, setVoiceMessage] = useState('');
  const [voiceError, setVoiceError] = useState('');

  // 四个框只镜像库里存的值：留空就真的空着，切方言也不会塞别家的默认值进来。
  function fillTtsDraft(snapshot: TtsSettingsSnapshot): void {
    setTtsDialect(resolveTtsDialectOption(snapshot.defaults.dialects, snapshot.dialect).id);
    setTtsUrl(snapshot.url);
    setTtsVoice(snapshot.voice);
    setTtsJudgeUrl(snapshot.judgeUrl);
    setTtsJudgeModel(snapshot.judgeModel);
  }

  // 切换只换选中项：地址 / 模型 / 音色都是用户已经打过的草稿，覆盖掉就白填了。
  // 上面两条提示属于上一套方言，跟着清掉。
  function selectTtsDialect(next: TtsDialect): void {
    setTtsDialect(next);
    setTtsMessage('');
    setTtsError('');
    setPreviewMessage('');
    setPreviewError('');
  }

  async function loadTts(): Promise<void> {
    try {
      const snapshot = await fetchTtsSettings();
      setTtsSettings(snapshot);
      fillTtsDraft(snapshot);
    } catch (err) {
      setTtsError(describeTtsError(err));
    }
  }

  // 回列表给调用方：保存 / 删除后要按新列表重算这一层的草稿，等 setState 生效会读到上一份。
  async function loadTtsStyle(): Promise<TtsStyleLayer[] | null> {
    try {
      const snapshot = await fetchTtsStyleLayers();
      setStyleLayers(snapshot.items);
      setStyleMaxChars(snapshot.maxChars);
      return snapshot.items;
    } catch (err) {
      setStyleError(describeTtsError(err));
      return null;
    }
  }

  // 回快照给调用方：保存 / 清除后要拿新列表立刻算生效值，等 setState 生效会读到上一份。
  async function loadVoice(): Promise<VoiceSettingsSnapshot | null> {
    try {
      const snapshot = await fetchVoiceSettings();
      setVoiceItems(snapshot.items);
      setVoiceDefault(snapshot.default);
      setVoiceModes(snapshot.modes);
      setVoiceDirectorModes(snapshot.directorModes);
      setVoiceSpeedMin(snapshot.speedMin);
      setVoiceSpeedMax(snapshot.speedMax);
      setVoiceLoaded(true);
      return snapshot;
    } catch (err) {
      setVoiceError(describeVoiceSettingsError(err));
      return null;
    }
  }

  useEffect(() => {
    void loadTts();
    void loadVoice();
    void loadTtsStyle();
  }, []);

  // 离开页面时把还在响的那段停掉、把 object URL 还回去，别让音频一直占着。
  useEffect(() => {
    return () => {
      if (audioRef.current !== null) audioRef.current.pause();
      if (audioUrlRef.current !== '') URL.revokeObjectURL(audioUrlRef.current);
    };
  }, []);

  // 同一件事给语音卡片：首屏列表到手后，档位 / 音色 / 语速预填成「当前选中层实际生效的值」。
  useEffect(() => {
    if (!voiceLoaded) return;
    fillVoiceDraft(resolveVoiceEffectiveValue(voiceItems, voiceScope, voiceScopeId, voiceDefault));
  }, [voiceLoaded]);

  const ttsConfigured = ttsSettings !== null && ttsSettings.configured;
  const ttsDefaults = ttsSettings === null ? TTS_SETTINGS_DEFAULTS : ttsSettings.defaults;
  // 当前方言的那一份：地址占位与音色建议都取它，切换时只换这一份。
  const ttsDialectOption = resolveTtsDialectOption(ttsDefaults.dialects, ttsDialect);
  // 已保存的音色不一定在这一套方言的建议里：只有它属于当前方言时才并进去，否则会把上一套的音色混进来。
  const ttsVoiceOptions =
    ttsSettings !== null &&
    ttsSettings.dialect === ttsDialect &&
    ttsSettings.voice !== '' &&
    !ttsDialectOption.voices.includes(ttsSettings.voice)
      ? ttsDialectOption.voices.concat([ttsSettings.voice])
      : ttsDialectOption.voices;
  // MiMo 走 chat/completions，没有语速参数：语速只影响 OpenAI 兼容那套。
  const ttsSpeedIgnored = ttsDialectOption.id === 'mimo';
  const ttsSaveDisabled = ttsBusy !== '' || ttsUrl.trim() === '';

  async function saveTts(): Promise<void> {
    if (ttsSaveDisabled) return;
    setTtsMessage('');
    setTtsError('');
    setTtsBusy('save');
    try {
      const saved = await saveTtsSettings({
        url: ttsUrl.trim(),
        key: ttsKey,
        voice: ttsVoice,
        dialect: ttsDialect,
        judgeUrl: ttsJudgeUrl.trim(),
        judgeKey: ttsJudgeKey,
        judgeModel: ttsJudgeModel.trim(),
      });
      setTtsSettings(saved);
      fillTtsDraft(saved);
      // 掩码已经回来了，输入框里的明文没有必要再留着。
      setTtsKey('');
      setTtsJudgeKey('');
      setTtsMessage(saved.configured ? '已保存：' + saved.keyHint : '已保存，但地址或 Key 还缺一份，仍算未配置');
    } catch (err) {
      setTtsError(describeTtsError(err));
    } finally {
      setTtsBusy('');
    }
  }

  async function removeTts(): Promise<void> {
    if (ttsBusy !== '') return;
    if (!window.confirm('清除后语音回复不会发出声音，确定要清除这份配置吗？')) return;
    setTtsMessage('');
    setTtsError('');
    setPreviewMessage('');
    setPreviewError('');
    setTtsBusy('delete');
    try {
      await clearTtsSettings();
      setTtsKey('');
      setTtsJudgeKey('');
      await loadTts();
      setTtsMessage('已清除：现在是未配置状态');
    } catch (err) {
      setTtsError(describeTtsError(err));
    } finally {
      setTtsBusy('');
    }
  }

  async function previewTts(): Promise<void> {
    if (ttsBusy !== '') return;
    setPreviewMessage('');
    setPreviewError('');
    setTtsBusy('test');
    try {
      // 空字段不带：后端回落库里已存的值，Key 空着就用解密值；方言总带当前选中的那一项。
      const result = await testTtsSettings({
        url: ttsUrl.trim(),
        key: ttsKey,
        voice: ttsVoice,
        dialect: ttsDialect,
        director: previewDirector,
      });
      const bytes = decodeBase64(result.audioBase64);
      if (bytes === null) {
        setPreviewError('上游回来的音频是空的（0 字节）');
        return;
      }
      const objectUrl = URL.createObjectURL(new Blob([bytes], { type: result.contentType }));
      if (audioRef.current !== null) audioRef.current.pause();
      if (audioUrlRef.current !== '') URL.revokeObjectURL(audioUrlRef.current);
      const audio = new Audio(objectUrl);
      audioRef.current = audio;
      audioUrlRef.current = objectUrl;
      audio.onended = () => {
        URL.revokeObjectURL(objectUrl);
        if (audioUrlRef.current === objectUrl) audioUrlRef.current = '';
      };
      audio.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        if (audioUrlRef.current === objectUrl) audioUrlRef.current = '';
        setPreviewError('浏览器解不开这段音频');
      };
      void audio.play().catch(() => setPreviewError('浏览器拒绝播放，检查一下自动播放策略'));
      // 字节数 / 耗时是排查数据；导演档写清这次是放行还是退回原文；「实际发送」最后给标签 + 正文原样。
      const lines = [String(result.bytes) + ' 字节 / ' + String(result.durationMs) + ' ms'];
      if (typeof result.director === 'number') {
        const rejected = result.directorRejected ?? null;
        let line = '导演模式：' + describeVoiceDirector(result.director);
        if (result.director > 0) {
          line +=
            rejected === null
              ? '（这次放行了改写）'
              : '（退回原文：' + describeVoiceDirectorRejection(rejected) + '）';
        }
        lines.push(line);
      }
      // 退回了才把 judge 的原话贴出来：次数不多，正好用它判断是没写、写歪还是超时
      if (result.directorRejected != null && typeof result.judgeLine === 'string' && result.judgeLine !== '') {
        lines.push('判断模型写的是：' + result.judgeLine);
      }
      const actual = describeTtsActual(result.styleUsed, result.speechUsed);
      if (actual !== '') lines.push('实际发送：' + actual);
      setPreviewMessage(lines.join('\n'));
    } catch (err) {
      setPreviewError(describeTtsError(err));
    } finally {
      setTtsBusy('');
    }
  }

  // 换层时把这一层已有的值填回输入框（没配就填它当前沿用的值），免得上层的数字被误存到这一层。
  function selectVoiceScope(next: Scope): void {
    setVoiceScope(next);
    setVoiceMessage('');
    setVoiceError('');
    fillVoiceDraft(resolveVoiceEffectiveValue(voiceItems, next, voiceScopeId, voiceDefault));
  }

  // 四个输入框永远一起换：只换一个会留下「上层音色 + 本层语速」这种没人配过的组合。
  function fillVoiceDraft(value: VoiceEffectiveValue): void {
    setVoiceDraftMode(value.mode);
    setVoiceDraftDirector(value.director);
    setVoiceDraftName(value.voice);
    setVoiceDraftSpeed(String(value.speed));
  }

  const voiceTargetId = normalizeScopeId(voiceScope, voiceScopeId);
  const voiceTargetLabel = describeScopeTarget(voiceScope, voiceTargetId);
  const voiceEffective = resolveVoiceEffectiveValue(voiceItems, voiceScope, voiceScopeId, voiceDefault);
  const voiceEffectiveLabel = describeVoiceConfig(
    voiceEffective.mode,
    voiceEffective.voice,
    voiceEffective.speed,
    voiceEffective.director,
  );
  const voiceDefaultLabel = describeVoiceConfig(
    voiceDefault.mode,
    voiceDefault.voice,
    voiceDefault.speed,
    voiceDefault.director,
  );
  // guild / channel 层没填 ID 时后端一定 400，先禁用。
  const voiceScopeReady = voiceScope === 'global' || voiceTargetId !== '';
  const parsedVoiceSpeed = parseIntInRange(voiceDraftSpeed, voiceSpeedMin, voiceSpeedMax);
  // mimo 不认语速：填坏了也不拦保存，否则用户会被一个不生效的参数卡住。
  const voiceSaveDisabled = voiceBusy !== '' || !voiceScopeReady || (!ttsSpeedIgnored && parsedVoiceSpeed === null);
  const voiceClearDisabled = voiceBusy !== '' || !voiceScopeReady;

  async function saveVoice(): Promise<void> {
    // 语速填坏了而当前方言又不认它：库里仍旧存现在生效的那个值，不把没意义的数字写进去。
    const speedToSave = parsedVoiceSpeed === null ? voiceEffective.speed : parsedVoiceSpeed;
    if (voiceSaveDisabled) return;
    setVoiceMessage('');
    setVoiceError('');
    setVoiceBusy('save');
    try {
      const saved = await saveVoiceSetting({
        scope: voiceScope,
        scopeId: voiceTargetId,
        mode: voiceDraftMode,
        director: voiceDraftDirector,
        voice: voiceDraftName,
        speed: speedToSave,
      });
      setVoiceMessage(
        '已保存 ' +
          describeScopeTarget(saved.scope, saved.scopeId) +
          '：' +
          describeVoiceConfig(saved.mode, saved.voice, saved.speed, saved.director),
      );
      // 刷新列表与生效值；拉取失败只落在 voiceError，不把这次保存说成失败。
      const snapshot = await loadVoice();
      if (snapshot !== null) {
        fillVoiceDraft(resolveVoiceEffectiveValue(snapshot.items, voiceScope, voiceScopeId, snapshot.default));
      }
    } catch (err) {
      setVoiceError(describeVoiceSettingsError(err));
    } finally {
      setVoiceBusy('');
    }
  }

  async function removeVoice(): Promise<void> {
    if (voiceClearDisabled) return;
    setVoiceMessage('');
    setVoiceError('');
    setVoiceBusy('delete');
    try {
      await clearVoiceSetting({ scope: voiceScope, scopeId: voiceTargetId });
      setVoiceMessage('已清除 ' + voiceTargetLabel + ' 的配置（这一层恢复上层）');
      const snapshot = await loadVoice();
      if (snapshot !== null) {
        fillVoiceDraft(resolveVoiceEffectiveValue(snapshot.items, voiceScope, voiceScopeId, snapshot.default));
      }
    } catch (err) {
      setVoiceError(describeVoiceSettingsError(err));
    } finally {
      setVoiceBusy('');
    }
  }

  const styleTargetId = normalizeScopeId(styleScope, styleScopeId);
  const styleTargetLabel = describeScopeTarget(styleScope, styleTargetId);
  // guild / channel 层没填 ID 时后端一定 400，先禁用。
  const styleScopeReady = styleScope === 'global' || styleTargetId !== '';
  const styleOver = styleDraft.length > styleMaxChars;
  // 超了后端必拒：计数变红、保存锁住，别让用户白等一次 400。
  const styleSaveDisabled = styleBusy !== '' || !styleScopeReady || styleOver;
  const styleClearDisabled = styleBusy !== '' || !styleScopeReady;
  const styleLayerConfigured = findStyleLayer(styleLayers, styleScope, styleTargetId) !== undefined;

  function fillStyleDraft(scope: Scope, scopeId: string, items: TtsStyleLayer[]): void {
    const row = findStyleLayer(items, scope, scopeId);
    setStyleDraft(row === undefined ? '' : row.content);
  }

  // 保存 / 删除后重拉列表，并把当前层的草稿对齐到库里最新的原文。
  async function refreshStyleLayers(): Promise<void> {
    const items = await loadTtsStyle();
    if (items !== null) fillStyleDraft(styleScope, styleScopeId, items);
  }

  // 换层时把这一层已有的原文填回输入框：留白保存会删掉这一层，不能拿上一层的文字顶上。
  function selectStyleScope(next: Scope): void {
    setStyleScope(next);
    setStyleMessage('');
    setStyleError('');
    fillStyleDraft(next, styleScopeId, styleLayers);
  }

  async function saveStyle(): Promise<void> {
    if (styleSaveDisabled) return;
    setStyleMessage('');
    setStyleError('');
    setStyleBusy('save');
    try {
      const result = await saveTtsStyleLayer({ scope: styleScope, scopeId: styleTargetId, content: styleDraft });
      setStyleMessage(
        result.removed
          ? '已清空 ' + styleTargetLabel + ' 的语气提示词（这一层不再生效）'
          : '已保存 ' + styleTargetLabel + ' 的语气提示词',
      );
      await refreshStyleLayers();
    } catch (err) {
      setStyleError(describeTtsError(err));
    } finally {
      setStyleBusy('');
    }
  }

  // 恢复默认 = 清空当前层：这一层从库里删掉，合成时自然落到下一层。
  async function resetStyle(): Promise<void> {
    if (styleClearDisabled) return;
    setStyleMessage('');
    setStyleError('');
    setStyleBusy('delete');
    try {
      await clearTtsStyleLayer(styleScope, styleTargetId);
      setStyleMessage('已恢复默认：' + styleTargetLabel + ' 这一层不再带语气提示词');
      await refreshStyleLayers();
    } catch (err) {
      setStyleError(describeTtsError(err));
    } finally {
      setStyleBusy('');
    }
  }

  async function removeStyleLayer(scope: Scope, scopeId: string): Promise<void> {
    if (styleBusy !== '') return;
    setStyleMessage('');
    setStyleError('');
    setStyleBusy('row');
    try {
      await clearTtsStyleLayer(scope, scopeId);
      setStyleMessage('已删除 ' + describeScopeTarget(scope, scopeId) + ' 的语气提示词');
      await refreshStyleLayers();
    } catch (err) {
      setStyleError(describeTtsError(err));
    } finally {
      setStyleBusy('');
    }
  }

  return (
    <div className="page voice">
      <section className="card">
        <h2>语音合成接口</h2>
        <p className="hint">
          这里的配置是 TTS 的唯一来源：Key 用 AES 加密入库，接口只回掩码；改了立刻生效，不用重启。
        </p>
        <p className={ttsConfigured ? 'tts-status on' : 'tts-status'}>
          {ttsConfigured
            ? '已配置（' + (ttsSettings === null || ttsSettings.keyHint === '' ? '已保存 Key' : ttsSettings.keyHint) + '）'
            : '未配置：语音回复不会发出声音'}
        </p>
        {ttsSettings !== null && ttsSettings.updatedAt !== '' ? (
          <p className="hint">上次更新：{formatUpdatedAt(ttsSettings.updatedAt)}</p>
        ) : null}
        {ttsSettings !== null && ttsSettings.envPresent ? (
          <p className="hint">服务器还留着 VOICE_TTS_* 环境变量，这一版只认后台配置，可以删掉</p>
        ) : null}
        <label className="field">
          <span>接口类型</span>
          <select
            value={ttsDialect}
            onChange={(event) => selectTtsDialect(event.target.value === 'mimo' ? 'mimo' : 'openai')}
          >
            {ttsDefaults.dialects.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        {ttsDialectOption.id === 'mimo' ? (
          <p className="hint">
            MiMo 走 chat/completions，不支持语速参数（语速对这一套不生效）；音色留空时用服务端默认的 mimo_default。
          </p>
        ) : null}
        <label className="field">
          <span>接口地址（必填）</span>
          <input
            type="text"
            value={ttsUrl}
            placeholder={ttsDialectOption.urlPlaceholder}
            onChange={(event) => setTtsUrl(event.target.value)}
          />
        </label>
        <label className="field">
          <span>Key（加密入库，留空不改）</span>
          <input
            type="password"
            autoComplete="new-password"
            value={ttsKey}
            placeholder={
              ttsConfigured ? '已保存 ' + (ttsSettings === null ? '' : ttsSettings.keyHint) + '，留空不改' : '首次配置必须填'
            }
            onChange={(event) => setTtsKey(event.target.value)}
          />
        </label>
        <label className="field">
          <span>默认音色（留空 = 用服务端默认音色）</span>
          <input
            type="text"
            list="tts-voice-options"
            value={ttsVoice}
            placeholder={'例如 ' + ttsDialectOption.voices[0]}
            onChange={(event) => setTtsVoice(event.target.value)}
          />
          <datalist id="tts-voice-options">
            {ttsVoiceOptions.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </label>
        <div className="tts-judge">
          <p className="tts-judge-title">情绪判断模型（可选）</p>
          <label className="field">
            <span>判断模型地址</span>
            <input
              type="text"
              value={ttsJudgeUrl}
              placeholder="https://api.deepseek.com/v1"
              onChange={(event) => setTtsJudgeUrl(event.target.value)}
            />
          </label>
          <label className="field">
            <span>判断模型 Key（加密入库，留空不改）</span>
            <input
              type="password"
              autoComplete="new-password"
              value={ttsJudgeKey}
              placeholder={
                ttsSettings !== null && ttsSettings.judgeKeyHint !== ''
                  ? '已保存 ' + ttsSettings.judgeKeyHint + '，留空不改'
                  : '留空 = 只用语气提示词'
              }
              onChange={(event) => setTtsJudgeKey(event.target.value)}
            />
          </label>
          <label className="field">
            <span>判断模型名</span>
            <input
              type="text"
              value={ttsJudgeModel}
              placeholder="例如 deepseek-chat"
              onChange={(event) => setTtsJudgeModel(event.target.value)}
            />
          </label>
          <p className="hint">
            填全三项后，每条语音合成前先让这个模型读一遍回复、写一行语气指令；不填就只用下面的语气提示词，再空就不带语气。
          </p>
          <p className="hint">
            {ttsSettings !== null && ttsSettings.judgeConfigured
              ? '判断模型已填全：合成前会先写一行语气指令'
              : '判断模型没填全：合成时只按下面的语气提示词走'}
          </p>
        </div>
        {ttsMessage === '' ? null : <p className="ok">{ttsMessage}</p>}
        {ttsError === '' ? null : <p className="error">{ttsError}</p>}
        <div className="field">
          <span>导演模式（仅这次试听）</span>
          <select
            value={String(previewDirector)}
            disabled={ttsBusy !== ''}
            onChange={(event) => setPreviewDirector(Number(event.target.value))}
          >
            {voiceDirectorModes.map((director) => (
              <option key={String(director)} value={String(director)}>
                {String(director)} {describeVoiceDirector(director)}
              </option>
            ))}
          </select>
        </div>
        <div className="actions">
          <button type="button" className="primary" disabled={ttsSaveDisabled} onClick={() => void saveTts()}>
            {ttsBusy === 'save' ? '保存中…' : '保存'}
          </button>
          <button type="button" className="danger" disabled={ttsBusy !== ''} onClick={() => void removeTts()}>
            {ttsBusy === 'delete' ? '清除中…' : '清除'}
          </button>
          <button type="button" disabled={ttsBusy !== ''} onClick={() => void previewTts()}>
            {ttsBusy === 'test' ? '试听中…' : '试听'}
          </button>
        </div>
        <p className="hint">
          试听用固定短句合成，直接在这里播放；地址 / 音色按表单里填的来，Key 留空就用已存的那把；带不带语气看下面「朗读语气」这一层。导演模式选 1 或 2 时，结果里会写清这次是放行改写还是退回原文、为什么退回。
        </p>
        {previewMessage === '' ? null : <p className="ok tts-preview">{previewMessage}</p>}
        {previewError === '' ? null : <p className="error">{previewError}</p>}
      </section>

      <section className="card">
        <h2>语音回复</h2>
        <p className="hint">
          0 = 关闭（默认），1 = 她说了才发（回复里出现 <code>[[voice]]</code> 才发），2 = 每条回复都发。
        </p>
        <p className="hint">语音是整段回复合成后作为单独一条 mp3 附件发出去，不跟着假流式切片走。</p>
        <p className="voice-warn">TTS 没配时这里存了也不会发声音——去上面的「语音合成接口」配。</p>
        <ScopeField
          scope={voiceScope}
          scopeId={voiceScopeId}
          onScopeChange={selectVoiceScope}
          onScopeIdChange={setVoiceScopeId}
        />
        <div className="field">
          <span>发送档位</span>
          <div className="voice-modes">
            {voiceModes.map((mode) => (
              <label key={String(mode)}>
                <input
                  type="radio"
                  name="voice-mode"
                  checked={voiceDraftMode === mode}
                  onChange={() => setVoiceDraftMode(mode)}
                />
                {String(mode)} {describeVoiceMode(mode)}
              </label>
            ))}
          </div>
        </div>
        <div className="row voice-row">
          <label className="field">
            <span>音色（留空 = 用服务端默认音色）</span>
            <input
              type="text"
              list="voice-voice-suggestions"
              value={voiceDraftName}
              placeholder="例如 nova"
              onChange={(event) => setVoiceDraftName(event.target.value)}
            />
            <datalist id="voice-voice-suggestions">
              {VOICE_SUGGESTIONS.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </label>
          <label className={ttsSpeedIgnored ? 'field voice-speed-off' : 'field'}>
            <span>
              语速（{String(voiceSpeedMin)}–{String(voiceSpeedMax)} %，默认 {String(VOICE_SPEED_DEFAULT)}）
            </span>
            <input
              type="number"
              min={voiceSpeedMin}
              max={voiceSpeedMax}
              step={1}
              value={voiceDraftSpeed}
              onChange={(event) => setVoiceDraftSpeed(event.target.value)}
            />
          </label>
          <label className="field">
            <span>导演模式</span>
            <select
              value={String(voiceDraftDirector)}
              onChange={(event) => setVoiceDraftDirector(Number(event.target.value))}
            >
              {voiceDirectorModes.map((director) => (
                <option key={String(director)} value={String(director)}>
                  {String(director)} {describeVoiceDirector(director)}
                </option>
              ))}
            </select>
          </label>
        </div>
        {ttsSpeedIgnored ? (
          <p className="voice-warn">MiMo 不支持语速，此项不生效</p>
        ) : parsedVoiceSpeed === null ? (
          <p className="hint">
            语速要填 {String(voiceSpeedMin)}–{String(voiceSpeedMax)} 的整数（%）
          </p>
        ) : (
          <p className="hint">填 {String(parsedVoiceSpeed)} 就按 {String(parsedVoiceSpeed)}% 合成</p>
        )}
        <p className="hint">
          {voiceTargetLabel} 现在生效：{voiceEffectiveLabel}（来自
          {voiceEffective.from === null
            ? '接口默认值'
            : describeScopeTarget(voiceEffective.from.scope, voiceEffective.from.scopeId)}
          ）
        </p>
        {voiceMessage === '' ? null : <p className="ok">{voiceMessage}</p>}
        {voiceError === '' ? null : <p className="error">{voiceError}</p>}
        <div className="actions">
          <button type="button" className="primary" disabled={voiceSaveDisabled} onClick={() => void saveVoice()}>
            {voiceBusy === 'save' ? '保存中…' : '保存这一层'}
          </button>
          <button type="button" className="danger" disabled={voiceClearDisabled} onClick={() => void removeVoice()}>
            {voiceBusy === 'delete' ? '清除中…' : '清除这一层'}
          </button>
        </div>
        <p className="hint">
          已配置的层（优先级 channel &gt; guild &gt; global）；三层都没配时按默认的 {voiceDefaultLabel}。
        </p>
        {voiceItems.length === 0 ? (
          <p className="hint">三层都还没有配置，现在用的是默认值（{voiceDefaultLabel}）。</p>
        ) : (
          <ul className="reply-list">
            {voiceItems.map((item) => (
              <li key={item.scope + ':' + item.scopeId}>
                <span className="reply-scope">{SCOPE_LABELS[item.scope]}</span>
                <span className="reply-id">{item.scopeId === '' ? '—' : item.scopeId}</span>
                <span className="voice-value">
                  {describeVoiceConfig(item.mode, item.voice, item.speed, item.director)}
                </span>
                <span className="reply-time">{formatUpdatedAt(item.updatedAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h2>朗读语气</h2>
        <p className="hint">
          按小米 MiMo 的标签写法填：标签写在正文开头，如 (怅然)、(温柔，语速放缓)、(唱歌)歌词；半角 ()、全角（）、方括号 []
          都认，括号后面的字就是正文。只写纯文字也行，服务端会自动补一层括号。
        </p>
        <p className="hint">
          正文里可以插 [轻笑] [叹气] [语速加快] 这类音频标签，它们只影响念法，正文文字一个字都不会改。
        </p>
        <p className="hint">
          只在接口类型为小米 MiMo 时生效；OpenAI 形状没有对应参数，会被忽略。三层按 频道 &gt; 服务器 &gt; 全局 取第一个非空的。
        </p>
        <ScopeField
          scope={styleScope}
          scopeId={styleScopeId}
          onScopeChange={selectStyleScope}
          onScopeIdChange={setStyleScopeId}
        />
        <div className="tts-style-chips">
          <span className="hint">点一下填进当前层：</span>
          {TTS_STYLE_EXAMPLES.map((example) => (
            <button
              key={example}
              type="button"
              className="tts-style-chip"
              disabled={styleBusy !== ''}
              onClick={() => setStyleDraft(example)}
            >
              {example}
            </button>
          ))}
        </div>
        <label className="field">
          <span>语气提示词（留空保存 = 删掉这一层）</span>
          <textarea
            className="tts-style-textarea"
            rows={4}
            value={styleDraft}
            placeholder="(温柔，语速放缓)今天辛苦啦，先歇一会儿。"
            onChange={(event) => setStyleDraft(event.target.value)}
          />
        </label>
        <div className="tts-style-meta">
          <span className="hint">上限按接口回的 maxChars；超了后端会拒，所以先锁住保存。</span>
          <span className={styleOver ? 'tts-style-count over' : 'tts-style-count'}>
            {String(styleDraft.length)} / {String(styleMaxChars)}
          </span>
        </div>
        {styleMessage === '' ? null : <p className="ok">{styleMessage}</p>}
        {styleError === '' ? null : <p className="error">{styleError}</p>}
        <div className="actions">
          <button type="button" className="primary" disabled={styleSaveDisabled} onClick={() => void saveStyle()}>
            {styleBusy === 'save' ? '保存中…' : '保存这一层'}
          </button>
          <button type="button" className="danger" disabled={styleClearDisabled} onClick={() => void resetStyle()}>
            {styleBusy === 'delete' ? '清空中…' : '恢复默认（清空这一层）'}
          </button>
        </div>
        <p className="hint">
          已配置的层（按生效优先级排列）；{styleTargetLabel}
          {styleLayerConfigured ? ' 已配置这一层' : ' 还没配，会沿下一层'}。
        </p>
        {styleLayers.length === 0 ? (
          <p className="hint">三层都还没有语气提示词：现在合成不带任何语气。</p>
        ) : (
          <ul className="tts-style-list">
            {styleLayers.map((item) => (
              <li key={item.scope + ':' + item.scopeId}>
                <span className="reply-scope">{SCOPE_LABELS[item.scope]}</span>
                <span className="reply-id">{item.scopeId === '' ? '—' : item.scopeId}</span>
                <span className="tts-style-excerpt">{summarizeStyleContent(item.content)}</span>
                <span className="reply-time">{formatUpdatedAt(item.updatedAt)}</span>
                <button
                  type="button"
                  className="link tts-style-remove"
                  disabled={styleBusy !== ''}
                  onClick={() => void removeStyleLayer(item.scope, item.scopeId)}
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
