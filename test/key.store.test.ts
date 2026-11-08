import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createSecretBox } from '../src/workers/crypto/secretbox';
import { createRepositories } from '../src/workers/db/d1-repository';

// §20.2/§20.3：Key 的 models 列与 listEnabled —— 只测仓储，不经 HTTP

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const MASTER_KEY = toBase64(new Uint8Array(32).fill(3));

function makeRepos() {
  return createRepositories(env.DB, createSecretBox(MASTER_KEY));
}

interface InsertedRow {
  id: string;
  label: string;
  createdAt: string;
  provider?: string;
  /** 不传 = 迁移前的老行（不带 models 列，靠 DEFAULT '' 成为「通用」） */
  models?: string;
  enabled?: number;
}

/** 绕过仓储直接插行：用来钉住老数据的空列、created_at/id 排序与 enabled=0 */
async function insertRow(row: InsertedRow): Promise<void> {
  const ciphertext = await createSecretBox(MASTER_KEY).encrypt('sk-' + row.id);
  const hint = '…' + row.id.slice(-4);
  const enabled = row.enabled ?? 1;
  const provider = row.provider ?? 'openai-compat';
  if (row.models === undefined) {
    await env.DB.prepare(
      'INSERT INTO provider_keys (id, provider, label, base_url, ciphertext, key_hint, enabled, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?)',
    )
      .bind(row.id, provider, row.label, ciphertext, hint, enabled, row.createdAt)
      .run();
    return;
  }
  await env.DB.prepare(
    'INSERT INTO provider_keys (id, provider, label, base_url, ciphertext, key_hint, enabled, created_at, models) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)',
  )
    .bind(row.id, provider, row.label, ciphertext, hint, enabled, row.createdAt, row.models)
    .run();
}

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM provider_keys').run();
});

describe('key models 列（§20.2/§20.3）', () => {
  it('models 往返：create → list → listEnabled/getDecrypted 都看得到，保留原始大小写与顺序', async () => {
    const { keys } = makeRepos();
    const models = ['DeepSeek-Chat', 'deepseek-*', 'gpt-4o-mini'];
    const apiKey = 'sk-deep-SECRET-0001';

    const created = await keys.create({ provider: 'openai-compat', label: 'DeepSeek', apiKey, models });
    expect(created.models).toEqual(models);

    const listed = await keys.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.models).toEqual(models);
    expect(JSON.stringify(listed)).not.toContain(apiKey);

    const enabled = await keys.listEnabled('openai-compat');
    expect(enabled).toHaveLength(1);
    expect(enabled[0]?.models).toEqual(models);
    expect(enabled[0]?.label).toBe('DeepSeek');
    expect(enabled[0]?.apiKey).toBe(apiKey);

    const decrypted = await keys.getDecrypted(created.id);
    expect(decrypted?.label).toBe('DeepSeek');
    expect(decrypted?.models).toEqual(models);

    // 库里存的是逗号分隔原文（大小写不折叠）
    const row = await env.DB.prepare('SELECT models FROM provider_keys WHERE id = ?').bind(created.id).first<{ models: string }>();
    expect(row?.models).toBe('DeepSeek-Chat,deepseek-*,gpt-4o-mini');
  });

  it('缺省的 [] 与老数据的空列都读成 []；读写都 trim + 丢空串', async () => {
    const { keys } = makeRepos();
    const noModels = await keys.create({ provider: 'anthropic', label: '通用', apiKey: 'sk-ant-0001' });
    expect(noModels.models).toEqual([]);

    const emptyModels = await keys.create({ provider: 'gemini', label: '空数组', apiKey: 'sk-gem-0002', models: [] });
    expect(emptyModels.models).toEqual([]);

    await insertRow({ id: 'legacy-anthropic', label: '老 Key', createdAt: '2024-01-01T00:00:00.000Z', provider: 'anthropic' });

    // 老行的列值就是 ''（DEFAULT），不需要回填
    const legacy = await env.DB.prepare('SELECT models FROM provider_keys WHERE id = ?')
      .bind('legacy-anthropic')
      .first<{ models: string }>();
    expect(legacy?.models).toBe('');

    expect((await keys.list()).map((key) => key.models)).toEqual([[], [], []]);
    expect((await keys.listEnabled('anthropic')).map((key) => key.models)).toEqual([[], []]);

    await env.DB.prepare("UPDATE provider_keys SET models = ' DeepSeek-Chat , ,gpt-4o-Mini ' WHERE id = ?")
      .bind(noModels.id)
      .run();
    expect((await keys.list()).find((key) => key.id === noModels.id)?.models).toEqual(['DeepSeek-Chat', 'gpt-4o-Mini']);
    expect((await keys.listEnabled('anthropic')).find((key) => key.id === noModels.id)?.models).toEqual([
      'DeepSeek-Chat',
      'gpt-4o-Mini',
    ]);
  });

  it('同一 provider 下两把 enabled 的 Key，listEnabled 两把都返回（旧 firstEnabled 只给最早那把）', async () => {
    const { keys } = makeRepos();
    const deepseek = await keys.create({ provider: 'openai-compat', label: 'DeepSeek', apiKey: 'sk-deep-1111', models: ['DeepSeek-Chat'] });
    const gg = await keys.create({ provider: 'openai-compat', label: 'gg', apiKey: 'sk-gg-2222', models: ['gg-*'] });

    // 时间钉死：DeepSeek 更早 —— 旧的 LIMIT 1 永远只回它，第二把形同虚设
    await env.DB.prepare('UPDATE provider_keys SET created_at = ? WHERE id = ?')
      .bind('2024-01-01T00:00:00.000Z', deepseek.id)
      .run();
    await env.DB.prepare('UPDATE provider_keys SET created_at = ? WHERE id = ?')
      .bind('2024-01-02T00:00:00.000Z', gg.id)
      .run();

    const enabled = await keys.listEnabled('openai-compat');
    expect(enabled).toHaveLength(2);
    expect(enabled.map((key) => key.label)).toEqual(['DeepSeek', 'gg']);
    expect(enabled.map((key) => key.apiKey)).toEqual(['sk-deep-1111', 'sk-gg-2222']);
    expect(enabled.map((key) => key.models)).toEqual([['DeepSeek-Chat'], ['gg-*']]);

    // 换供应商互不干扰
    expect(await keys.listEnabled('gemini')).toEqual([]);
  });

  it('listEnabled 按 created_at,id 升序，且跳过 enabled = 0', async () => {
    const { keys } = makeRepos();
    await insertRow({ id: 'key-b', label: '同刻 b', createdAt: '2024-02-01T00:00:00.000Z' });
    await insertRow({ id: 'key-a', label: '同刻 a', createdAt: '2024-02-01T00:00:00.000Z' });
    await insertRow({ id: 'key-earliest', label: '最早', createdAt: '2024-01-01T00:00:00.000Z' });
    await insertRow({ id: 'key-off', label: '停用', createdAt: '2024-01-01T00:00:00.000Z', enabled: 0 });

    expect((await keys.listEnabled('openai-compat')).map((key) => key.id)).toEqual(['key-earliest', 'key-a', 'key-b']);
    // list 不过滤 enabled
    expect((await keys.list()).map((key) => key.id)).toEqual(['key-earliest', 'key-off', 'key-a', 'key-b']);
  });
});
