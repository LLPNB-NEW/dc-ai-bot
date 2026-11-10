import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  WORLD_BOOK_NAME_RULE,
  createWorldBookEntry,
  deleteWorldBookEntry,
  describeWorldBookEntryError,
} from './api';
import type { WorldBookEntry } from './api';

// 契约 world-book：web 侧只负责按形状发请求、按错误码翻文案，POST 与 DELETE 各验一遍。

const GUILD = '111111111111111111';

interface CapturedCall {
  path: string;
  init: RequestInit;
}

function stubFetch(payload: unknown, status = 200): CapturedCall[] {
  const calls: CapturedCall[] = [];
  vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
    calls.push({ path, init });
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
  return calls;
}

function bodyOf(call: CapturedCall | undefined): Record<string, unknown> {
  if (call === undefined) throw new Error('没有捕获到请求');
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

function draftEntry(): WorldBookEntry {
  return {
    id: 0,
    name: '开场白',
    keys: ['开场'],
    secondaryKeys: [],
    content: '欢迎来到这个世界。',
    enabled: true,
    constant: false,
    selective: false,
    selectiveLogic: 'andAny',
    order: 0,
    caseSensitive: false,
    wholeWords: false,
    position: 'anTop',
    depth: 4,
    role: 'system',
    probability: 100,
    useProbability: false,
    group: '',
    groupWeight: 100,
    sticky: 0,
    cooldown: 0,
    delay: 0,
    scanDepth: null,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('web 侧世界书新建（POST /api/world-book/entry）', () => {
  it('请求体是 { scope, scopeId, bookName, entry }，id 原样 0 交给后端分配', async () => {
    const calls = stubFetch({
      entry: { ...draftEntry(), id: 7 },
      name: '新的一本',
      entryCount: 1,
      importedAt: '2026-11-11T00:00:00.000Z',
      createdBook: true,
    });

    const created = await createWorldBookEntry({ scope: 'global', scopeId: '', bookName: ' 新的一本 ', entry: draftEntry() });

    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe('/api/world-book/entry');
    expect(calls[0].init.method).toBe('POST');
    expect((calls[0].init.headers as Record<string, string>)['content-type']).toBe('application/json');
    const body = bodyOf(calls[0]);
    expect(body.scope).toBe('global');
    expect(body.scopeId).toBe('');
    expect(body.bookName).toBe('新的一本');
    expect((body.entry as Record<string, unknown>).id).toBe(0);
    expect((body.entry as Record<string, unknown>).content).toBe('欢迎来到这个世界。');
    // 回执里的 id 由后端给，前端照抄；书名与 createdBook 一并解析出来。
    expect(created.entry.id).toBe(7);
    expect(created.name).toBe('新的一本');
    expect(created.entryCount).toBe(1);
    expect(created.createdBook).toBe(true);
  });

  it('书名空白 / 不传时发 null：这一层已经有书就别让后端收到空串', async () => {
    const calls = stubFetch({ entry: { ...draftEntry(), id: 9 }, name: '旧书', entryCount: 2, importedAt: '', createdBook: false });

    await createWorldBookEntry({ scope: 'guild', scopeId: GUILD, bookName: '   ', entry: draftEntry() });
    await createWorldBookEntry({ scope: 'guild', scopeId: GUILD, entry: draftEntry() });

    expect(calls).toHaveLength(2);
    expect(bodyOf(calls[0]).bookName).toBe(null);
    expect(bodyOf(calls[1]).bookName).toBe(null);
    expect(bodyOf(calls[0]).scope).toBe('guild');
    expect(bodyOf(calls[0]).scopeId).toBe(GUILD);
  });

  it('失败：BAD_BOOK_NAME 翻成页面统一那句', async () => {
    stubFetch({ error: 'BAD_BOOK_NAME' }, 400);

    const failure = await createWorldBookEntry({ scope: 'global', scopeId: '', bookName: '', entry: draftEntry() }).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(ApiError);
    expect(describeWorldBookEntryError(failure)).toBe(WORLD_BOOK_NAME_RULE);
  });

  it('失败：BAD_WORLD_ENTRY 继续用后端 detail', async () => {
    const failure = new ApiError(400, { error: 'BAD_WORLD_ENTRY', detail: 'delay 必须是 0..10000 的整数' }, 'BAD_WORLD_ENTRY');

    expect(describeWorldBookEntryError(failure)).toBe('条目没保存：delay 必须是 0..10000 的整数');
  });
});

describe('web 侧世界书删除（DELETE /api/world-book/entry）', () => {
  it('请求体是 { scope, scopeId, id }，回执带 entryCount / removedBook', async () => {
    const calls = stubFetch({ ok: true, entryCount: 0, removedBook: true });

    const result = await deleteWorldBookEntry({ scope: 'guild', scopeId: GUILD, id: 3 });

    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe('/api/world-book/entry');
    expect(calls[0].init.method).toBe('DELETE');
    expect(bodyOf(calls[0])).toEqual({ scope: 'guild', scopeId: GUILD, id: 3 });
    expect(result).toEqual({ ok: true, entryCount: 0, removedBook: true });
  });

  it('删中间一条：removedBook false 原样透传', async () => {
    stubFetch({ ok: true, entryCount: 2, removedBook: false });

    const result = await deleteWorldBookEntry({ scope: 'global', scopeId: '', id: 1 });

    expect(result.removedBook).toBe(false);
    expect(result.entryCount).toBe(2);
  });
});
