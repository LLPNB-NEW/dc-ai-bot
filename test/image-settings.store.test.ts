import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createSecretBox } from '../src/workers/crypto/secretbox';
import { createRepositories } from '../src/workers/db/d1-repository';

// 生图三层自定义（global / guild / channel）：只测 image_settings 仓储，不经 HTTP

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const MASTER_KEY = toBase64(new Uint8Array(32).fill(11));

function makeRepos() {
  return createRepositories(env.DB, createSecretBox(MASTER_KEY));
}

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM image_settings').run();
});

describe('imageSettings 仓储：key 只存密文与掩码', () => {
  it('put 落库并回后台形状：model / baseUrl 去空白后写库，keyHint 是末四位掩码', async () => {
    const { imageSettings } = makeRepos();
    const apiKey = 'sk-image-SECRET-0042';

    const saved = await imageSettings.put({
      scope: 'global',
      scopeId: '',
      model: '  gemini-custom  ',
      baseUrl: '  https://img.example.com/v1  ',
      apiKey,
    });
    expect(saved).toEqual({
      scope: 'global',
      scopeId: '',
      model: 'gemini-custom',
      baseUrl: 'https://img.example.com/v1',
      keyHint: '…0042',
      updatedAt: expect.any(String),
    });
    expect(JSON.stringify(saved)).not.toContain(apiKey);

    const row = await env.DB
      .prepare('SELECT model, base_url, key_sealed, key_hint, updated_at FROM image_settings WHERE scope = ? AND scope_id = ?')
      .bind('global', '')
      .first<{ model: string; base_url: string; key_sealed: string; key_hint: string; updated_at: string }>();
    expect(row?.model).toBe('gemini-custom');
    expect(row?.base_url).toBe('https://img.example.com/v1');
    expect(row?.key_sealed).not.toBe('');
    expect(row?.key_sealed).not.toBe(apiKey);
    expect(row?.key_hint).toBe('…0042');
    expect(row?.updated_at).toBe(saved.updatedAt);
  });

  it('get 解密 apiKey（密文只进库，出仓储的是明文）', async () => {
    const { imageSettings } = makeRepos();
    const apiKey = 'sk-image-SECRET-1111';

    await imageSettings.put({ scope: 'channel', scopeId: 'c1', model: 'm1', baseUrl: 'https://a.example/v1', apiKey });
    expect(await imageSettings.get({ scope: 'channel', scopeId: 'c1' })).toEqual({
      scope: 'channel',
      scopeId: 'c1',
      model: 'm1',
      baseUrl: 'https://a.example/v1',
      keyHint: '…1111',
      updatedAt: expect.any(String),
      apiKey,
    });
  });

  it('list 一次列全表：按 scope / scope_id 升序，形状里没有 apiKey，也没有明文', async () => {
    const { imageSettings } = makeRepos();
    const apiKey = 'sk-image-SECRET-9999';

    await imageSettings.put({ scope: 'guild', scopeId: 'g1', model: 'guild-m', baseUrl: '', apiKey });
    await imageSettings.put({ scope: 'channel', scopeId: 'c2', model: 'c2-m', baseUrl: '', apiKey });
    await imageSettings.put({ scope: 'global', scopeId: '', model: 'global-m', baseUrl: '', apiKey });
    await imageSettings.put({ scope: 'channel', scopeId: 'c1', model: 'c1-m', baseUrl: '', apiKey });

    const listed = await imageSettings.list();
    expect(listed.map((item) => [item.scope, item.scopeId, item.model])).toEqual([
      ['channel', 'c1', 'c1-m'],
      ['channel', 'c2', 'c2-m'],
      ['global', '', 'global-m'],
      ['guild', 'g1', 'guild-m'],
    ]);
    expect(JSON.stringify(listed)).not.toContain(apiKey);
    for (const item of listed) expect('apiKey' in item).toBe(false);
  });

  it('apiKey 省略 = 保留旧密文与旧掩码：只改 model 不会把 Key 弄丢', async () => {
    const { imageSettings } = makeRepos();
    const apiKey = 'sk-image-SECRET-2222';

    await imageSettings.put({ scope: 'channel', scopeId: 'c1', model: 'old', baseUrl: '', apiKey });
    const saved = await imageSettings.put({ scope: 'channel', scopeId: 'c1', model: 'next', baseUrl: '' });
    expect(saved).toEqual({
      scope: 'channel',
      scopeId: 'c1',
      model: 'next',
      baseUrl: '',
      keyHint: '…2222',
      updatedAt: expect.any(String),
    });
    expect((await imageSettings.get({ scope: 'channel', scopeId: 'c1' }))?.apiKey).toBe(apiKey);
  });

  it("apiKey 空串 = 清掉本层：密文与掩码一起清空，get 回空串而不是 null", async () => {
    const { imageSettings } = makeRepos();

    await imageSettings.put({ scope: 'global', scopeId: '', model: 'm', baseUrl: '', apiKey: 'sk-image-SECRET-3333' });
    const saved = await imageSettings.put({ scope: 'global', scopeId: '', model: 'm', baseUrl: '', apiKey: '' });
    expect(saved.keyHint).toBe('');

    const row = await env.DB
      .prepare('SELECT key_sealed, key_hint FROM image_settings WHERE scope = ? AND scope_id = ?')
      .bind('global', '')
      .first<{ key_sealed: string; key_hint: string }>();
    expect(row).toEqual({ key_sealed: '', key_hint: '' });
    expect((await imageSettings.get({ scope: 'global', scopeId: '' }))?.apiKey).toBe('');
  });

  it('remove 之后 get 回 null、list 里也没有这一行；删不存在的层也算成功', async () => {
    const { imageSettings } = makeRepos();

    await imageSettings.put({ scope: 'guild', scopeId: 'g1', model: 'm', baseUrl: '', apiKey: 'sk-image-4444' });
    await expect(imageSettings.remove({ scope: 'guild', scopeId: 'g1' })).resolves.toBeUndefined();

    expect(await imageSettings.get({ scope: 'guild', scopeId: 'g1' })).toBeNull();
    expect(await imageSettings.list()).toEqual([]);
    await expect(imageSettings.remove({ scope: 'channel', scopeId: 'c404' })).resolves.toBeUndefined();
  });

  it('scope 隔离：同 id 的 channel 与 guild 各是一行，global 不串味', async () => {
    const { imageSettings } = makeRepos();

    await imageSettings.put({ scope: 'channel', scopeId: 'same', model: 'channel-m', baseUrl: 'https://c.example/v1', apiKey: 'sk-c-0001' });
    await imageSettings.put({ scope: 'guild', scopeId: 'same', model: 'guild-m', baseUrl: 'https://g.example/v1', apiKey: 'sk-g-0002' });
    await imageSettings.put({ scope: 'global', scopeId: '', model: 'global-m', baseUrl: '', apiKey: '' });

    expect((await imageSettings.get({ scope: 'channel', scopeId: 'same' }))?.model).toBe('channel-m');
    expect((await imageSettings.get({ scope: 'guild', scopeId: 'same' }))?.model).toBe('guild-m');
    expect((await imageSettings.get({ scope: 'global', scopeId: '' }))?.model).toBe('global-m');
    // 不存在的层不会被别的层「顺带」命中
    expect(await imageSettings.get({ scope: 'channel', scopeId: 'other' })).toBeNull();
    expect((await imageSettings.list()).map((item) => item.scopeId)).toEqual(['same', '', 'same']);
  });
});
