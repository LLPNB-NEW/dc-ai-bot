import { useEffect, useState } from 'react';
import {
  SCOPE_LABELS,
  VISION_ENABLED_DEFAULT,
  clearImageSetting,
  clearReplySettings,
  clearVisionSetting,
  describeImageSettingsError,
  describeReplySettingsError,
  describeScopeTarget,
  describeVisionSettingsError,
  fetchImageSettings,
  fetchReplySettings,
  fetchVisionSettings,
  normalizeScopeId,
  saveImageSetting,
  saveReplySettings,
  saveVisionSetting,
  type ImageSettingsRow,
  type ImageSettingsSnapshot,
  type RevealStepsRow,
  type Scope,
  type VisionSettingsRow,
  type VisionSettingsSnapshot,
} from '../api';
import ScopeField from '../components/ScopeField';

// 首屏还没拉到列表时按契约的静态值渲染，真正的 default / min / max 以 GET 回来的为准。
const BOOTSTRAP_DEFAULT = 6;
const BOOTSTRAP_MIN = 0;
const BOOTSTRAP_MAX = 10;

// 契约 fake-stream-2：每片之间至少 1200ms。
const REVEAL_STEP_DELAY_MS = 1200;

// 0 = 关闭，别把它显示成「多花 1.2 秒」。
function describeRevealCost(steps: number): string {
  if (steps === 0) return '关闭（直接一次发全文）';
  return '大约多花 ' + (((steps + 1) * REVEAL_STEP_DELAY_MS) / 1000).toFixed(1) + ' 秒';
}

// 只到秒：库里是 ISO，毫秒对排查没意义，还会把列表行撑宽。
function formatUpdatedAt(updatedAt: string): string {
  if (updatedAt === '') return '未知时间';
  const value = new Date(updatedAt);
  if (Number.isNaN(value.getTime())) return updatedAt;
  return value.toLocaleString('zh-CN', { hour12: false });
}

// 一层的 key 就是 scope + scopeId（global 的 scopeId 固定空串），与后端同一套定位方式。
function findRow(items: RevealStepsRow[], scope: Scope, scopeId: string): RevealStepsRow | undefined {
  const target = normalizeScopeId(scope, scopeId);
  return items.find((item) => item.scope === scope && item.scopeId === target);
}

interface EffectiveValue {
  revealSteps: number;
  /** 命中的那一层；null = 三层都没配，用的是接口的 default。 */
  from: RevealStepsRow | null;
}

// 生效值按「从选中目标往上兜」：命中这一层就用它，否则落回 global，三层都没有就用 default。
// 频道这一层只知道频道 ID、不知道它属于哪个服务器，所以 guild 层不参与；要按服务器兜请直接选 guild 层。
function resolveEffectiveValue(
  items: RevealStepsRow[],
  scope: Scope,
  scopeId: string,
  fallback: number,
): EffectiveValue {
  const self = findRow(items, scope, scopeId);
  if (self !== undefined) return { revealSteps: self.revealSteps, from: self };
  if (scope !== 'global') {
    const globalRow = findRow(items, 'global', '');
    if (globalRow !== undefined) return { revealSteps: globalRow.revealSteps, from: globalRow };
  }
  return { revealSteps: fallback, from: null };
}

// 输入框存原样字符串：用户打到一半（空、'-'、'1.'）时不该被改写成 0；切片次数与语速共用这一套。
function parseIntInRange(raw: string, min: number, max: number): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  // Number.isInteger 同时挡掉 NaN 与 Infinity。
  if (!Number.isInteger(value)) return null;
  return value < min || value > max ? null : value;
}

// 识图卡片的行查找与生效值：与假流式同一套兜底规则（命中本层 → global → 默认），只是值域是布尔。
function findVisionRow(items: VisionSettingsRow[], scope: Scope, scopeId: string): VisionSettingsRow | undefined {
  const target = normalizeScopeId(scope, scopeId);
  return items.find((item) => item.scope === scope && item.scopeId === target);
}

interface VisionEffectiveValue {
  enabled: boolean;
  /** 命中的那一层；null = 三层都没配，用的是接口的 default。 */
  from: VisionSettingsRow | null;
}

// 频道这一层只知道频道 ID、不知道它属于哪个服务器，所以 guild 层不参与；要按服务器兜请直接选 guild 层。
function resolveVisionEffectiveValue(
  items: VisionSettingsRow[],
  scope: Scope,
  scopeId: string,
  fallback: boolean,
): VisionEffectiveValue {
  const self = findVisionRow(items, scope, scopeId);
  if (self !== undefined) return { enabled: self.enabled, from: self };
  if (scope !== 'global') {
    const globalRow = findVisionRow(items, 'global', '');
    if (globalRow !== undefined) return { enabled: globalRow.enabled, from: globalRow };
  }
  return { enabled: fallback, from: null };
}

// 值域是布尔，文案必须把「开 = 主模型能看图」说清楚，只写开 / 关会让人以为表情模型也停了。
function describeVisionState(enabled: boolean): string {
  return enabled ? '开（主模型能看图）' : '关（主模型不看图）';
}

// 生图卡片的行查找与生效值：model / baseUrl / Key 三个字段各自从本层往上取第一个非空，
// 不是整行覆盖，所以逐字段兜底，并把命中的来源层显示出来。
function findImageRow(items: ImageSettingsRow[], scope: Scope, scopeId: string): ImageSettingsRow | undefined {
  const target = normalizeScopeId(scope, scopeId);
  return items.find((item) => item.scope === scope && item.scopeId === target);
}

interface ImageEffectiveField {
  value: string;
  /** 命中的那一层；null = 整条链都没配，落回 defaultModel / 当前聊天 Key。 */
  from: ImageSettingsRow | null;
}

// 频道这一层只知道频道 ID、不知道它属于哪个服务器，所以 guild 层不参与；要按服务器兜请直接选 guild 层。
function resolveImageField(
  items: ImageSettingsRow[],
  scope: Scope,
  scopeId: string,
  pick: (row: ImageSettingsRow) => string,
): ImageEffectiveField {
  const chain: ImageSettingsRow[] = [];
  const self = findImageRow(items, scope, scopeId);
  if (self !== undefined) chain.push(self);
  if (scope !== 'global') {
    const globalRow = findImageRow(items, 'global', '');
    if (globalRow !== undefined) chain.push(globalRow);
  }
  for (const row of chain) {
    const value = pick(row).trim();
    if (value !== '') return { value, from: row };
  }
  return { value: '', from: null };
}

// 保存只换这一层的行：别的层没动，列表不用整份重拉，输入框也不会闪一下。
function upsertImageRow(items: ImageSettingsRow[], row: ImageSettingsRow): ImageSettingsRow[] {
  const index = items.findIndex((item) => item.scope === row.scope && item.scopeId === row.scopeId);
  if (index < 0) return [...items, row];
  const next = items.slice();
  next[index] = row;
  return next;
}

function describeImageModelValue(field: ImageEffectiveField, defaultModel: string): string {
  if (field.value !== '') return field.value;
  return defaultModel === '' ? '接口默认模型' : defaultModel;
}

function describeImageModelSource(field: ImageEffectiveField): string {
  return field.from === null ? '接口默认模型' : describeScopeTarget(field.from.scope, field.from.scopeId);
}

function describeImageBaseUrlValue(field: ImageEffectiveField): string {
  return field.value === '' ? '当前聊天 Key 的地址' : field.value;
}

function describeImageKeyValue(field: ImageEffectiveField): string {
  return field.value === '' ? '当前聊天 Key' : '已保存 ' + field.value;
}

function describeImageFallbackSource(field: ImageEffectiveField): string {
  return field.from === null ? '当前聊天 Key' : describeScopeTarget(field.from.scope, field.from.scopeId);
}

function describeImageRowSummary(row: ImageSettingsRow): string {
  const parts: string[] = [];
  if (row.model !== '') parts.push('模型 ' + row.model);
  if (row.baseUrl !== '') parts.push('地址 ' + row.baseUrl);
  if (row.keyHint !== '') parts.push('Key ' + row.keyHint);
  return parts.length === 0 ? '空（三个字段全部沿用上层）' : parts.join(' · ');
}

export default function ReplyPage() {
  const [items, setItems] = useState<RevealStepsRow[]>([]);
  const [fallbackDefault, setFallbackDefault] = useState(BOOTSTRAP_DEFAULT);
  const [min, setMin] = useState(BOOTSTRAP_MIN);
  const [max, setMax] = useState(BOOTSTRAP_MAX);
  const [loaded, setLoaded] = useState(false);
  const [scope, setScope] = useState<Scope>('global');
  const [scopeId, setScopeId] = useState('');
  const [draft, setDraft] = useState(String(BOOTSTRAP_DEFAULT));
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  // 识图卡片与假流式卡片各一套 state：一边请求失败只脏它自己的提示，不许牵连另一张卡片。
  const [visionItems, setVisionItems] = useState<VisionSettingsRow[]>([]);
  const [visionDefault, setVisionDefault] = useState<boolean>(VISION_ENABLED_DEFAULT);
  const [visionLoaded, setVisionLoaded] = useState(false);
  const [visionScope, setVisionScope] = useState<Scope>('global');
  const [visionScopeId, setVisionScopeId] = useState('');
  const [visionDraft, setVisionDraft] = useState<boolean>(VISION_ENABLED_DEFAULT);
  const [visionBusy, setVisionBusy] = useState('');
  const [visionMessage, setVisionMessage] = useState('');
  const [visionError, setVisionError] = useState('');

  // 生图卡片独立一套 state：三个字段各有草稿，请求失败只脏它自己的提示。
  const [imageItems, setImageItems] = useState<ImageSettingsRow[]>([]);
  const [imageDefaultModel, setImageDefaultModel] = useState('');
  const [imageLimits, setImageLimits] = useState({ model: 0, baseUrl: 0 });
  const [imageLoaded, setImageLoaded] = useState(false);
  const [imageScope, setImageScope] = useState<Scope>('global');
  const [imageScopeId, setImageScopeId] = useState('');
  const [imageModel, setImageModel] = useState('');
  const [imageBaseUrl, setImageBaseUrl] = useState('');
  const [imageApiKey, setImageApiKey] = useState('');
  const [imageBusy, setImageBusy] = useState('');
  const [imageMessage, setImageMessage] = useState('');
  const [imageError, setImageError] = useState('');

  async function load(): Promise<void> {
    try {
      const snapshot = await fetchReplySettings();
      setItems(snapshot.items);
      setFallbackDefault(snapshot.default);
      setMin(snapshot.min);
      setMax(snapshot.max);
      setLoaded(true);
    } catch (err) {
      setError(describeReplySettingsError(err));
    }
  }

  // 回快照给调用方：保存 / 清除后要拿新列表立刻算生效值，等 setState 生效会读到上一份。
  async function loadVision(): Promise<VisionSettingsSnapshot | null> {
    try {
      const snapshot = await fetchVisionSettings();
      setVisionItems(snapshot.items);
      setVisionDefault(snapshot.default);
      setVisionLoaded(true);
      return snapshot;
    } catch (err) {
      setVisionError(describeVisionSettingsError(err));
      return null;
    }
  }

  // 草稿填的是「这一层自己存的值」，不是生效值：留空本来就表示沿用上层，预填生效值会把上层值抄下来。
  function fillImageDraft(items: ImageSettingsRow[], scope: Scope, scopeId: string): void {
    const row = findImageRow(items, scope, scopeId);
    setImageModel(row === undefined ? '' : row.model);
    setImageBaseUrl(row === undefined ? '' : row.baseUrl);
    setImageApiKey('');
  }

  async function loadImage(): Promise<ImageSettingsSnapshot | null> {
    try {
      const snapshot = await fetchImageSettings();
      setImageItems(snapshot.items);
      setImageDefaultModel(snapshot.defaultModel);
      setImageLimits(snapshot.limits);
      setImageLoaded(true);
      fillImageDraft(snapshot.items, imageScope, imageScopeId);
      return snapshot;
    } catch (err) {
      setImageError(describeImageSettingsError(err));
      return null;
    }
  }

  useEffect(() => {
    void load();
    void loadVision();
    void loadImage();
  }, []);

  // 首屏拿到列表后把输入框预填成「当前选中层实际生效的值」：空输入框配上被禁用的保存按钮，
  // 看起来像这一层坏了。之后换层由 selectScope 负责预填。
  useEffect(() => {
    if (!loaded) return;
    setDraft(String(resolveEffectiveValue(items, scope, scopeId, fallbackDefault).revealSteps));
  }, [loaded]);

  // 同一件事给识图卡片：首屏列表到手后，开关预填成「当前选中层实际生效的值」，免得空选中态骗人。
  useEffect(() => {
    if (!visionLoaded) return;
    setVisionDraft(resolveVisionEffectiveValue(visionItems, visionScope, visionScopeId, visionDefault).enabled);
  }, [visionLoaded]);

  // 换层时把这一层已有的值填回输入框（没配就填它当前沿用的值），免得上层的数字被误存到这一层。
  function selectScope(next: Scope): void {
    setScope(next);
    setMessage('');
    setError('');
    setDraft(String(resolveEffectiveValue(items, next, scopeId, fallbackDefault).revealSteps));
  }

  // 换层同样把这一层已有的开关填回来，免得上层的值被误存到这一层。
  function selectVisionScope(next: Scope): void {
    setVisionScope(next);
    setVisionMessage('');
    setVisionError('');
    setVisionDraft(resolveVisionEffectiveValue(visionItems, next, visionScopeId, visionDefault).enabled);
  }

  // 换层把这一层存的值填回表单；没配就留空 = 沿用，不会把上层的值存下来。
  function selectImageScope(next: Scope): void {
    setImageScope(next);
    setImageMessage('');
    setImageError('');
    fillImageDraft(imageItems, next, imageScopeId);
  }

  // 填 ID 时只有表单还全空才载入这一层已存的值：已经打好的字不能被换 ID 洗掉。
  function selectImageScopeId(next: string): void {
    setImageScopeId(next);
    setImageMessage('');
    setImageError('');
    if (imageModel.trim() === '' && imageBaseUrl.trim() === '' && imageApiKey.trim() === '') {
      fillImageDraft(imageItems, imageScope, next);
    }
  }

  const targetId = normalizeScopeId(scope, scopeId);
  const targetLabel = describeScopeTarget(scope, targetId);
  const parsed = parseIntInRange(draft, min, max);
  const effective = resolveEffectiveValue(items, scope, scopeId, fallbackDefault);
  // guild / channel 层没填 ID 时后端一定 400，干脆先禁用。
  const scopeReady = scope === 'global' || targetId !== '';
  const saveDisabled = busy !== '' || !scopeReady || parsed === null;
  const clearDisabled = busy !== '' || !scopeReady;

  async function save(): Promise<void> {
    if (saveDisabled || parsed === null) return;
    setMessage('');
    setError('');
    setBusy('save');
    try {
      const saved = await saveReplySettings({ scope, scopeId: targetId, revealSteps: parsed });
      setMessage(
        '已保存 ' +
          describeScopeTarget(saved.scope, saved.scopeId) +
          '：' +
          String(saved.revealSteps) +
          ' 次（' +
          describeRevealCost(saved.revealSteps) +
          '）',
      );
      await load();
    } catch (err) {
      setError(describeReplySettingsError(err));
    } finally {
      setBusy('');
    }
  }

  async function remove(): Promise<void> {
    if (clearDisabled) return;
    setMessage('');
    setError('');
    setBusy('delete');
    try {
      await clearReplySettings({ scope, scopeId: targetId });
      setMessage('已删除 ' + targetLabel + ' 的配置（这一层恢复上层）');
      await load();
    } catch (err) {
      setError(describeReplySettingsError(err));
    } finally {
      setBusy('');
    }
  }

  const visionTargetId = normalizeScopeId(visionScope, visionScopeId);
  const visionTargetLabel = describeScopeTarget(visionScope, visionTargetId);
  const visionEffective = resolveVisionEffectiveValue(visionItems, visionScope, visionScopeId, visionDefault);
  // guild / channel 层没填 ID 时后端一定 400，先禁用。
  const visionScopeReady = visionScope === 'global' || visionTargetId !== '';
  const visionSaveDisabled = visionBusy !== '' || !visionScopeReady;
  const visionClearDisabled = visionBusy !== '' || !visionScopeReady;

  async function saveVision(): Promise<void> {
    if (visionSaveDisabled) return;
    setVisionMessage('');
    setVisionError('');
    setVisionBusy('save');
    try {
      const saved = await saveVisionSetting({
        scope: visionScope,
        scopeId: visionTargetId,
        enabled: visionDraft,
      });
      setVisionMessage(
        '已保存 ' +
          describeScopeTarget(saved.scope, saved.scopeId) +
          '：' +
          describeVisionState(saved.enabled) +
          '（下一条消息就按它走）',
      );
      // 刷新列表与生效值；拉取失败只落在 visionError，不把这次保存说成失败。
      const snapshot = await loadVision();
      if (snapshot !== null) {
        setVisionDraft(
          resolveVisionEffectiveValue(snapshot.items, visionScope, visionScopeId, snapshot.default).enabled,
        );
      }
    } catch (err) {
      setVisionError(describeVisionSettingsError(err));
    } finally {
      setVisionBusy('');
    }
  }

  async function removeVision(): Promise<void> {
    if (visionClearDisabled) return;
    setVisionMessage('');
    setVisionError('');
    setVisionBusy('delete');
    try {
      await clearVisionSetting({ scope: visionScope, scopeId: visionTargetId });
      setVisionMessage('已清除 ' + visionTargetLabel + ' 的配置（这一层恢复上层）');
      const snapshot = await loadVision();
      if (snapshot !== null) {
        setVisionDraft(
          resolveVisionEffectiveValue(snapshot.items, visionScope, visionScopeId, snapshot.default).enabled,
        );
      }
    } catch (err) {
      setVisionError(describeVisionSettingsError(err));
    } finally {
      setVisionBusy('');
    }
  }

  const imageTargetId = normalizeScopeId(imageScope, imageScopeId);
  const imageTargetLabel = describeScopeTarget(imageScope, imageTargetId);
  const imageRow = findImageRow(imageItems, imageScope, imageTargetId);
  const imageModelEffective = resolveImageField(imageItems, imageScope, imageTargetId, (row) => row.model);
  const imageBaseUrlEffective = resolveImageField(imageItems, imageScope, imageTargetId, (row) => row.baseUrl);
  const imageKeyEffective = resolveImageField(imageItems, imageScope, imageTargetId, (row) => row.keyHint);
  // guild / channel 层没填 ID 时后端一定 400，先禁用。
  const imageScopeReady = imageScope === 'global' || imageTargetId !== '';
  const imageDraftEmpty = imageModel.trim() === '' && imageBaseUrl.trim() === '' && imageApiKey.trim() === '';
  // 新层三个字段全空 = 没有可存的东西；已存在的层允许用空值把某个字段改回「沿用上层」。
  const imageSaveDisabled = imageBusy !== '' || !imageScopeReady || (imageRow === undefined && imageDraftEmpty);
  const imageClearKeyDisabled =
    imageBusy !== '' || !imageScopeReady || imageRow === undefined || imageRow.keyHint === '';
  const imageRemoveDisabled = imageBusy !== '' || !imageScopeReady;

  async function saveImage(): Promise<void> {
    if (imageSaveDisabled) return;
    setImageMessage('');
    setImageError('');
    setImageBusy('save');
    const typedKey = imageApiKey.trim();
    try {
      const saved = await saveImageSetting({
        scope: imageScope,
        scopeId: imageTargetId,
        model: imageModel,
        baseUrl: imageBaseUrl,
        // 留空 = 保留本层已存的密文：整个字段不送，而不是送空串。
        ...(typedKey === '' ? {} : { apiKey: typedKey }),
      });
      // 只更新这一层的行：别的层没动，列表不重拉，草稿也不会闪。
      setImageItems((previous) => upsertImageRow(previous, saved));
      setImageModel(saved.model);
      setImageBaseUrl(saved.baseUrl);
      setImageApiKey('');
      setImageMessage(
        '已保存 ' +
          describeScopeTarget(saved.scope, saved.scopeId) +
          '：' +
          (saved.model === '' ? '模型留空（沿用上层）' : '模型 ' + saved.model) +
          ' · ' +
          (saved.baseUrl === '' ? '地址留空（沿用上层）' : '地址 ' + saved.baseUrl) +
          (typedKey === '' ? '' : ' · 已写入本层 Key'),
      );
    } catch (err) {
      // 失败只写表单错误，输入原样留着，改完可以直接再点保存。
      setImageError(describeImageSettingsError(err));
    } finally {
      setImageBusy('');
    }
  }

  async function clearImageKey(): Promise<void> {
    if (imageClearKeyDisabled || imageRow === undefined) return;
    setImageMessage('');
    setImageError('');
    setImageBusy('key');
    try {
      // 只清 Key：model / baseUrl 原样送回，免得把这一层另外两项也清掉。
      const saved = await saveImageSetting({
        scope: imageScope,
        scopeId: imageTargetId,
        model: imageRow.model,
        baseUrl: imageRow.baseUrl,
        apiKey: '',
      });
      setImageItems((previous) => upsertImageRow(previous, saved));
      setImageApiKey('');
      setImageMessage('已清除 ' + imageTargetLabel + ' 的本层 Key（回到上层 / 当前聊天 Key）');
    } catch (err) {
      setImageError(describeImageSettingsError(err));
    } finally {
      setImageBusy('');
    }
  }

  async function removeImage(): Promise<void> {
    if (imageRemoveDisabled) return;
    setImageMessage('');
    setImageError('');
    setImageBusy('delete');
    try {
      await clearImageSetting({ scope: imageScope, scopeId: imageTargetId });
      setImageMessage('已删除 ' + imageTargetLabel + ' 的配置（这一层恢复上层）');
      // 删的是整层，按契约刷新列表；拉取失败只落在 imageError，不把这次删除说成失败。
      await loadImage();
    } catch (err) {
      setImageError(describeImageSettingsError(err));
    } finally {
      setImageBusy('');
    }
  }

  return (
    <div className="page reply">
      <section className="card">
        <h2>假流式（整段到手后切片挤出去）</h2>
        <p className="hint">
          模型整段一次性返回时，网关先把整段拿到手、再按节奏分几片改写同一条消息；0 = 关闭（直接一次发全文）。
        </p>
        <p className="hint">每片之间至少 {String(REVEAL_STEP_DELAY_MS)}ms，所以填 N 大约多花 (N+1)×1.2 秒。</p>
        <ScopeField scope={scope} scopeId={scopeId} onScopeChange={selectScope} onScopeIdChange={setScopeId} />
        <label className="field">
          <span>
            切片次数（{String(min)}–{String(max)}，0 = 关闭）
          </span>
          <input
            type="number"
            min={min}
            max={max}
            step={1}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
        </label>
        {parsed === null ? (
          <p className="hint">
            切片次数要填 {String(min)}–{String(max)} 的整数（0 = 关闭）
          </p>
        ) : (
          <p className="hint">填 {String(parsed)} 就是{describeRevealCost(parsed)}</p>
        )}
        <p className="hint">
          {targetLabel} 现在生效 {String(effective.revealSteps)} 次 · {describeRevealCost(effective.revealSteps)}
          （来自
          {effective.from === null
            ? '接口默认值'
            : describeScopeTarget(effective.from.scope, effective.from.scopeId)}
          ）
        </p>
        {message === '' ? null : <p className="ok">{message}</p>}
        {error === '' ? null : <p className="error">{error}</p>}
        <div className="actions">
          <button type="button" className="primary" disabled={saveDisabled} onClick={() => void save()}>
            {busy === 'save' ? '保存中…' : '保存本层'}
          </button>
          <button type="button" className="danger" disabled={clearDisabled} onClick={() => void remove()}>
            {busy === 'delete' ? '删除中…' : '恢复上层（删除本层）'}
          </button>
        </div>
      </section>

      <section className="card">
        <h2>已配置的层</h2>
        <p className="hint">
          优先级 channel &gt; guild &gt; global：命中哪层用哪层的次数；三层都没配就用默认的{' '}
          {String(fallbackDefault)} 次。
        </p>
        {items.length === 0 ? (
          <p className="hint">三层都还没有配置，现在用的是默认值。</p>
        ) : (
          <ul className="reply-list">
            {items.map((item) => (
              <li key={item.scope + ':' + item.scopeId}>
                <span className="reply-scope">{SCOPE_LABELS[item.scope]}</span>
                <span className="reply-id">{item.scopeId === '' ? '—' : item.scopeId}</span>
                <span className="reply-value">
                  {item.revealSteps === 0 ? '0（关闭）' : String(item.revealSteps) + ' 次'}
                </span>
                <span className="reply-time">{formatUpdatedAt(item.updatedAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h2>识图（主模型看图）</h2>
        <p className="hint">
          默认开：三层都没配时主模型能看图。关掉只影响主对话模型，表情模型照旧能看图。
        </p>
        <p className="hint">改完立刻生效：每条消息读一次这一层的开关，不用重启。</p>
        <ScopeField
          scope={visionScope}
          scopeId={visionScopeId}
          onScopeChange={selectVisionScope}
          onScopeIdChange={setVisionScopeId}
        />
        <div className="field">
          <span>主模型能否看图</span>
          <div className="vision-toggle">
            <label>
              <input type="radio" name="vision-enabled" checked={visionDraft} onChange={() => setVisionDraft(true)} />
              开（主模型能看图）
            </label>
            <label>
              <input type="radio" name="vision-enabled" checked={!visionDraft} onChange={() => setVisionDraft(false)} />
              关（主模型不看图，表情模型照旧能看图）
            </label>
          </div>
        </div>
        <p className="hint">
          {visionTargetLabel} 现在生效：{describeVisionState(visionEffective.enabled)}（来自
          {visionEffective.from === null
            ? '接口默认值'
            : describeScopeTarget(visionEffective.from.scope, visionEffective.from.scopeId)}
          ）
        </p>
        <p className="hint">以下按选中层 → 全局 → 默认兜底展示；要按服务器兜请直接选服务器层。</p>
        {visionMessage === '' ? null : <p className="ok">{visionMessage}</p>}
        {visionError === '' ? null : <p className="error">{visionError}</p>}
        <div className="actions">
          <button type="button" className="primary" disabled={visionSaveDisabled} onClick={() => void saveVision()}>
            {visionBusy === 'save' ? '保存中…' : '保存这一层'}
          </button>
          <button type="button" className="danger" disabled={visionClearDisabled} onClick={() => void removeVision()}>
            {visionBusy === 'delete' ? '清除中…' : '清除这一层'}
          </button>
        </div>
        <p className="hint">
          已配置的层（优先级 channel &gt; guild &gt; global）；三层都没配时按默认的
          {visionDefault ? '开' : '关'}。
        </p>
        {visionItems.length === 0 ? (
          <p className="hint">三层都还没有配置，现在用的是默认值（{visionDefault ? '开' : '关'}）。</p>
        ) : (
          <ul className="reply-list">
            {visionItems.map((item) => (
              <li key={item.scope + ':' + item.scopeId}>
                <span className="reply-scope">{SCOPE_LABELS[item.scope]}</span>
                <span className="reply-id">{item.scopeId === '' ? '—' : item.scopeId}</span>
                <span className={'vision-value' + (item.enabled ? '' : ' off')}>{item.enabled ? '开' : '关'}</span>
                <span className="reply-time">{formatUpdatedAt(item.updatedAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h2>生图（自定义模型 / 地址 / Key）</h2>
        <p className="hint">
          三层配置 channel &gt; guild &gt; global：模型 / 地址 / Key 各自取第一个非空值；三项都空才用默认模型与当前聊天 Key。
        </p>
        <p className="hint">保存只写选中这一层；输入留空 = 沿用上层，不会把上层的值抄到本层。</p>
        <ScopeField
          scope={imageScope}
          scopeId={imageScopeId}
          onScopeChange={selectImageScope}
          onScopeIdChange={selectImageScopeId}
        />
        {imageLoaded ? null : <p className="hint">正在读取生图配置…</p>}
        <label className="field">
          <span>
            生图模型（model）
            {imageLimits.model > 0 ? '，最多 ' + String(imageLimits.model) + ' 字' : ''}
          </span>
          <input
            type="text"
            value={imageModel}
            maxLength={imageLimits.model > 0 ? imageLimits.model : undefined}
            placeholder={
              imageDefaultModel === ''
                ? '留空 = 沿用上层 / 接口默认模型'
                : '留空 = 沿用上层 / 默认 ' + imageDefaultModel
            }
            onChange={(event) => setImageModel(event.target.value)}
          />
        </label>
        <label className="field">
          <span>
            生图地址（baseUrl）
            {imageLimits.baseUrl > 0 ? '，最多 ' + String(imageLimits.baseUrl) + ' 字' : ''}
          </span>
          <input
            type="text"
            value={imageBaseUrl}
            maxLength={imageLimits.baseUrl > 0 ? imageLimits.baseUrl : undefined}
            placeholder="留空 = 沿用上层 / 当前聊天 Key 的地址"
            onChange={(event) => setImageBaseUrl(event.target.value)}
          />
        </label>
        <label className="field">
          <span>生图 Key（apiKey）</span>
          <input
            type="password"
            autoComplete="new-password"
            value={imageApiKey}
            placeholder={
              imageRow === undefined || imageRow.keyHint === ''
                ? '留空 = 沿用上层 / 当前聊天 Key'
                : '已保存 ' + imageRow.keyHint + '；留空 = 保留本层 Key'
            }
            onChange={(event) => setImageApiKey(event.target.value)}
          />
        </label>
        <div className="field">
          <span>当前生效值（按选中层 → 全局 → 默认）</span>
          <ul className="reply-list image-effective">
            <li>
              <span className="reply-scope">模型</span>
              <span className="image-effective-value">
                {describeImageModelValue(imageModelEffective, imageDefaultModel)}
              </span>
              <span className="reply-time">来自 {describeImageModelSource(imageModelEffective)}</span>
            </li>
            <li>
              <span className="reply-scope">地址</span>
              <span className="image-effective-value">{describeImageBaseUrlValue(imageBaseUrlEffective)}</span>
              <span className="reply-time">来自 {describeImageFallbackSource(imageBaseUrlEffective)}</span>
            </li>
            <li>
              <span className="reply-scope">Key</span>
              <span className="image-effective-value">{describeImageKeyValue(imageKeyEffective)}</span>
              <span className="reply-time">来自 {describeImageFallbackSource(imageKeyEffective)}</span>
            </li>
          </ul>
        </div>
        <p className="hint">
          频道所属的服务器在后台定位不到，所以生效值只按「选中层 → 全局 → 默认」兜；要按服务器兜请直接选服务器层。
        </p>
        {imageMessage === '' ? null : <p className="ok">{imageMessage}</p>}
        {imageError === '' ? null : <p className="error">{imageError}</p>}
        <div className="actions">
          <button type="button" className="primary" disabled={imageSaveDisabled} onClick={() => void saveImage()}>
            {imageBusy === 'save' ? '保存中…' : '保存这一层'}
          </button>
          <button type="button" className="ghost" disabled={imageClearKeyDisabled} onClick={() => void clearImageKey()}>
            {imageBusy === 'key' ? '清除中…' : '清除本层 Key'}
          </button>
          <button type="button" className="danger" disabled={imageRemoveDisabled} onClick={() => void removeImage()}>
            {imageBusy === 'delete' ? '删除中…' : '清除这一层'}
          </button>
        </div>
        <p className="hint">已配置的层（优先级 channel &gt; guild &gt; global）；空字段表示这一层没设、继续沿用上层。</p>
        {imageItems.length === 0 ? (
          <p className="hint">
            三层都还没有配置，现在用
            {imageDefaultModel === '' ? '接口默认模型' : '默认模型 ' + imageDefaultModel}
            与当前聊天 Key。
          </p>
        ) : (
          <ul className="reply-list">
            {imageItems.map((item) => (
              <li key={item.scope + ':' + item.scopeId}>
                <span className="reply-scope">{SCOPE_LABELS[item.scope]}</span>
                <span className="reply-id">{item.scopeId === '' ? '—' : item.scopeId}</span>
                <span className="image-row-summary">{describeImageRowSummary(item)}</span>
                <span className="reply-time">{formatUpdatedAt(item.updatedAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
