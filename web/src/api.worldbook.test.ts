import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  WORLD_BOOK_NAME_RULE,
  createWorldBookEntry,
  deleteWorldBook,
  deleteWorldBookEntry,
  describeWorldBookEntryError,
  fetchWorldBook,
  importWorldBook,
  renameWorldBook,
  updateWorldBookEnabled,
} from './api';
import type { WorldBookEntry } from './api';

// 契约 world-book：一层多本。web 侧按 bookId 定位、按形状发请求、按错误码翻文案。

const GUILD = '111111111111111111';
const BOOK_A = 'book-a';
const BOOK_B = 'book-b';

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

function bookPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    scope: 'global',
    scopeId: '',
    bookId: BOOK_A,
    name: '第一本',
    enabled: true,
    entryCount: 2,
    importedAt: '2026-11-11T00:00:00.000Z',
    entries: [],
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('web 侧世界书列表（GET /api/world-book）', () => {
  it('解析一层的多本：bookId / enabled 都在，缺 bookId 的行丢弃', async () => {
    stubFetch({
      items: [
        bookPayload(),
        bookPayload({ bookId: BOOK_B, name: '第二本', enabled: false }),
        bookPayload({ bookId: '' }),
      ],
    });

    const books = await fetchWorldBook();

    expect(books).toHaveLength(2);
    expect(books[0].bookId).toBe(BOOK_A);
    expect(books[0].enabled).toBe(true);
    expect(books[1].bookId).toBe(BOOK_B);
    expect(books[1].enabled).toBe(false);
  });
});

describe('web 侧世界书导入（POST /api/world-book/import）', () => {
  it('导入永远新增一本：回执解析 bookId 与 layerCount，不再有 replaced', async () => {
    const calls = stubFetch({
      scope: 'global',
      scopeId: '',
      bookId: BOOK_B,
      name: '重名（2）',
      entryCount: 3,
      ignored: [],
      warnings: [],
      layerCount: 2,
    });

    const result = await importWorldBook({ scope: 'global', scopeId: '', book: { entries: {} } });

    expect(calls[0].path).toBe('/api/world-book/import');
    expect(calls[0].init.method).toBe('POST');
    expect(bodyOf(calls[0]).scope).toBe('global');
    expect(bodyOf(calls[0]).scopeId).toBe('');
    expect(result.bookId).toBe(BOOK_B);
    expect(result.name).toBe('重名（2）');
    expect(result.layerCount).toBe(2);
    expect('replaced' in result).toBe(false);
  });
});

describe('web 侧整本开关 / 删除整本（PATCH / DELETE /api/world-book）', () => {
  it('PATCH body 只有 { bookId, enabled }，回执按 bookId 更新那一行', async () => {
    const calls = stubFetch({ bookId: BOOK_B, enabled: false });

    const result = await updateWorldBookEnabled(BOOK_B, false);

    expect(calls[0].path).toBe('/api/world-book');
    expect(calls[0].init.method).toBe('PATCH');
    expect(bodyOf(calls[0])).toEqual({ bookId: BOOK_B, enabled: false });
    expect(result).toEqual({ bookId: BOOK_B, enabled: false });
  });

  it('PATCH 回执漏了 enabled 时按请求值收，界面不回跳', async () => {
    stubFetch({ bookId: BOOK_A });

    const result = await updateWorldBookEnabled(BOOK_A, false);

    expect(result.enabled).toBe(false);
  });

  it('DELETE 整本只发 bookId：同层其它书不动', async () => {
    const calls = stubFetch({ ok: true });

    await deleteWorldBook(BOOK_A);

    expect(calls[0].path).toBe('/api/world-book');
    expect(calls[0].init.method).toBe('DELETE');
    expect(bodyOf(calls[0])).toEqual({ bookId: BOOK_A });
  });

  it('失败：BAD_BOOK_ID / BAD_BOOK_ENABLED 都有中文文案', () => {
    const badId = new ApiError(400, { error: 'BAD_BOOK_ID' }, 'BAD_BOOK_ID');
    const badEnabled = new ApiError(400, { error: 'BAD_BOOK_ENABLED' }, 'BAD_BOOK_ENABLED');

    expect(describeWorldBookEntryError(badId)).toContain('bookId 不合法');
    expect(describeWorldBookEntryError(badEnabled)).toContain('整本开关只接受');
  });
});

describe('web 侧整本书重命名（PATCH /api/world-book）', () => {
  it('PATCH body 只有 { bookId, name }，name 发 trim 后的值并带 JSON content-type', async () => {
    const calls = stubFetch({ bookId: BOOK_A, name: '新名字', enabled: true });

    const result = await renameWorldBook(BOOK_A, '  新名字  ');

    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe('/api/world-book');
    expect(calls[0].init.method).toBe('PATCH');
    expect(bodyOf(calls[0])).toEqual({ bookId: BOOK_A, name: '新名字' });
    expect(new Headers(calls[0].init.headers).get('content-type')).toBe('application/json');
    expect(result).toEqual({ bookId: BOOK_A, name: '新名字', enabled: true });
  });

  it('回执缺 name / enabled：抛 BAD_RESPONSE，不拿请求值顶上', async () => {
    stubFetch({ bookId: BOOK_A, enabled: true });

    const failure = await renameWorldBook(BOOK_A, '新名字').catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).payload).toEqual({ error: 'BAD_RESPONSE' });
    expect((failure as ApiError).message).toBe('重命名成功，但接口回的形状不认识');
  });

  it('失败：400 BAD_BOOK_NAME 继续用页面统一那句', async () => {
    stubFetch({ error: 'BAD_BOOK_NAME' }, 400);

    const failure = await renameWorldBook(BOOK_A, '').catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApiError);
    expect(describeWorldBookEntryError(failure)).toBe(WORLD_BOOK_NAME_RULE);
  });

  it('失败：400 BAD_BOOK_UPDATE 有中文文案', () => {
    const badUpdate = new ApiError(400, { error: 'BAD_BOOK_UPDATE' }, 'BAD_BOOK_UPDATE');

    expect(describeWorldBookEntryError(badUpdate)).toContain('至少要给一个');
  });
});

describe('web 侧世界书新建条目（POST /api/world-book/entry）', () => {
  it('带 bookId：请求体只有 { bookId, entry }，不再带 scope / bookName', async () => {
    const calls = stubFetch({
      entry: { ...draftEntry(), id: 7 },
      bookId: BOOK_A,
      name: '第一本',
      entryCount: 3,
      importedAt: '2026-11-11T00:00:00.000Z',
      createdBook: false,
    });

    const created = await createWorldBookEntry({
      scope: 'global',
      scopeId: '',
      bookId: BOOK_A,
      bookName: '不该被发送',
      entry: draftEntry(),
    });

    expect(calls[0].path).toBe('/api/world-book/entry');
    expect(calls[0].init.method).toBe('POST');
    expect(bodyOf(calls[0])).toEqual({ bookId: BOOK_A, entry: draftEntry() });
    expect(created.bookId).toBe(BOOK_A);
    expect(created.entry.id).toBe(7);
    expect(created.createdBook).toBe(false);
  });

  it('不带 bookId：请求体是 { scope, scopeId, bookName, entry }，bookName 空时发 null', async () => {
    const calls = stubFetch({
      entry: { ...draftEntry(), id: 1 },
      bookId: BOOK_B,
      name: '新的一本',
      entryCount: 1,
      importedAt: '2026-11-11T00:00:00.000Z',
      createdBook: true,
    });

    const created = await createWorldBookEntry({
      scope: 'guild',
      scopeId: GUILD,
      bookName: ' 新的一本 ',
      entry: draftEntry(),
    });

    expect(bodyOf(calls[0])).toEqual({
      scope: 'guild',
      scopeId: GUILD,
      bookName: '新的一本',
      entry: draftEntry(),
    });
    expect(created.bookId).toBe(BOOK_B);
    expect(created.createdBook).toBe(true);
  });

  it('这一层还没有书：bookName 不传时发 null，由后端报 BAD_BOOK_NAME', async () => {
    const calls = stubFetch({
      entry: { ...draftEntry(), id: 9 },
      bookId: BOOK_B,
      name: '旧书',
      entryCount: 2,
      importedAt: '',
      createdBook: false,
    });

    await createWorldBookEntry({ scope: 'global', scopeId: '', bookName: '   ', entry: draftEntry() });
    await createWorldBookEntry({ scope: 'global', scopeId: '', entry: draftEntry() });

    expect(calls).toHaveLength(2);
    expect(bodyOf(calls[0]).bookName).toBe(null);
    expect(bodyOf(calls[1]).bookName).toBe(null);
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

describe('web 侧世界书删除条目（DELETE /api/world-book/entry）', () => {
  it('请求体是 { bookId, id }，回执带 entryCount / removedBook', async () => {
    const calls = stubFetch({ ok: true, entryCount: 0, removedBook: true });

    const result = await deleteWorldBookEntry({ bookId: BOOK_B, id: 3 });

    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe('/api/world-book/entry');
    expect(calls[0].init.method).toBe('DELETE');
    expect(bodyOf(calls[0])).toEqual({ bookId: BOOK_B, id: 3 });
    expect(result).toEqual({ ok: true, entryCount: 0, removedBook: true });
  });

  it('删中间一条：removedBook false 原样透传', async () => {
    stubFetch({ ok: true, entryCount: 2, removedBook: false });

    const result = await deleteWorldBookEntry({ bookId: BOOK_A, id: 1 });

    expect(result.removedBook).toBe(false);
    expect(result.entryCount).toBe(2);
  });
});
