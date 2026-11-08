import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GATEWAY_ENSURE_PATH,
  GATEWAY_INTERNAL_ORIGIN,
  GatewayPresence,
  type GatewayEnv,
} from '../src/workers/gateway/durable-object';

const BOT_ID = '150000000000000001';
// createSecretBox 要求 32 字节 base64；记录路径只需要它构造成功，不做加解密
const SECRET = btoa('k'.repeat(32));

interface PutRecord {
  key: string;
  value: unknown;
}

interface FakeStorage {
  readonly puts: PutRecord[];
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number | Date): Promise<void>;
}

function createFakeStorage(): FakeStorage {
  const data = new Map<string, unknown>();
  const puts: PutRecord[] = [];
  return {
    puts,
    async get<T>(key: string): Promise<T | undefined> {
      return data.get(key) as T | undefined;
    },
    async put(key: string, value: unknown): Promise<void> {
      data.set(key, value);
      puts.push({ key, value });
    },
    async getAlarm(): Promise<number | null> {
      return null;
    },
    async setAlarm(): Promise<void> {},
  };
}

/** 断言用的「一条 INSERT 的参数」，按 append 里的 bind 顺序下标命名 */
interface BoundStatement {
  sql: string;
  args: unknown[];
}

function createFakeDb(): { db: D1Database; batches: BoundStatement[][] } {
  const batches: BoundStatement[][] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]): BoundStatement {
          return { sql, args };
        },
      };
    },
    async batch(statements: BoundStatement[]): Promise<unknown[]> {
      batches.push(statements);
      return [];
    },
  };
  return { db: db as unknown as D1Database, batches };
}

/** DO 的 #connect 会 new WebSocket(...)：这里只截住实例与监听器，绝不出网 */
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static readonly instances: FakeWebSocket[] = [];

  readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  readonly sent: string[] = [];
  readonly url: string;
  readyState = FakeWebSocket.OPEN;
  binaryType = 'blob';

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }
}

interface Harness {
  presence: GatewayPresence;
  batches: BoundStatement[][];
  /** ctx.waitUntil 收到的 promise：#handleMessage 在这里面跑完 */
  pending: Promise<unknown>[];
}

function createHarness(env: GatewayEnv): Harness {
  const { db, batches } = createFakeDb();
  const pending: Promise<unknown>[] = [];
  const state = {
    storage: createFakeStorage(),
    waitUntil: (promise: Promise<unknown>) => {
      pending.push(promise);
    },
  } as unknown as DurableObjectState;
  const presence = new GatewayPresence(state, { DB: db, ...env });
  return { presence, batches, pending };
}

async function flush(times = 24): Promise<void> {
  for (let index = 0; index < times; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** 先把 socket 建起来（只走 #ensure → #connect，无出网），再灌一帧 MESSAGE_CREATE 进 #handleMessage */
async function dispatchMessage(harness: Harness, raw: unknown): Promise<void> {
  await harness.presence.fetch(new Request(GATEWAY_INTERNAL_ORIGIN + GATEWAY_ENSURE_PATH, { method: 'POST' }));
  const socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  if (socket === undefined) throw new Error('前置失败：没有建立 WebSocket');
  for (const listener of socket.listeners.get('message') ?? []) {
    listener({ data: JSON.stringify({ op: 0, t: 'MESSAGE_CREATE', s: 7, d: raw }) });
  }
  await flush();
  await Promise.all(harness.pending);
}

function channelPayload(content: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'msg-1',
    channel_id: 'chan-1',
    guild_id: 'guild-1',
    content,
    author: { id: 'user-1', username: 'alice', global_name: 'Alice', bot: false },
    mentions: [],
    ...overrides,
  };
}

describe('DO 频道记忆：未 @ 的人类发言也落库', () => {
  beforeEach(() => {
    FakeWebSocket.instances.length = 0;
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('没 @ 我的频道发言：#recordMessage 写一条 user 行，列与值都对得上', async () => {
    const harness = createHarness({ DISCORD_BOT_TOKEN: 'tok', DISCORD_APPLICATION_ID: BOT_ID, KEY_ENCRYPTION_SECRET: SECRET });
    await dispatchMessage(harness, channelPayload('今晚有人打排位吗'));

    expect(harness.batches).toHaveLength(1);
    const rows = harness.batches[0] as BoundStatement[];
    expect(rows).toHaveLength(1);
    expect(String(rows[0]?.sql)).toContain('INSERT INTO messages');
    const args = rows[0]?.args ?? [];
    expect(args.slice(0, 6)).toEqual(['guild-1', 'chan-1', 'user-1', 'user', '今晚有人打排位吗', 'Alice']);
    expect(typeof args[6]).toBe('string');
  });

  it('没有 globalName 时回落 username', async () => {
    const harness = createHarness({ DISCORD_BOT_TOKEN: 'tok', DISCORD_APPLICATION_ID: BOT_ID, KEY_ENCRYPTION_SECRET: SECRET });
    await dispatchMessage(
      harness,
      channelPayload('随便说说', { author: { id: 'user-9', username: 'bob', global_name: null, bot: false } }),
    );

    const args = (harness.batches[0] as BoundStatement[])[0]?.args ?? [];
    expect(args.slice(2, 6)).toEqual(['user-9', 'user', '随便说说', 'bob']);
  });

  it('设了服务器昵称就用昵称落库（§60）', async () => {
    const harness = createHarness({ DISCORD_BOT_TOKEN: 'tok', DISCORD_APPLICATION_ID: BOT_ID, KEY_ENCRYPTION_SECRET: SECRET });
    await dispatchMessage(harness, channelPayload('随便说说', { member: { nick: '小苏' } }));

    const args = (harness.batches[0] as BoundStatement[])[0]?.args ?? [];
    expect(args.slice(2, 6)).toEqual(['user-1', 'user', '随便说说', '小苏']);
  });

  it('带 referenced_message 的普通发言：正文/作者口径不变，reply 四列随仓库落地', async () => {
    const harness = createHarness({ DISCORD_BOT_TOKEN: 'tok', DISCORD_APPLICATION_ID: BOT_ID, KEY_ENCRYPTION_SECRET: SECRET });
    await dispatchMessage(
      harness,
      channelPayload('我也想知道', {
        id: 'msg-2',
        referenced_message: {
          id: 'msg-0',
          author: { id: 'user-2', username: 'bob', global_name: 'Bob' },
          content: '上一条原文',
        },
      }),
    );

    const rows = harness.batches[0] as BoundStatement[];
    expect(rows).toHaveLength(1);
    const args = rows[0]?.args ?? [];
    // 解析出的 replyTo 不会挪动既有列的位置
    expect(args.slice(0, 6)).toEqual(['guild-1', 'chan-1', 'user-1', 'user', '我也想知道', 'Alice']);

    // §18.2 的四个 reply 列排在 created_at 之后：id / 作者名 / 作者 id / 原文
    expect(String(rows[0]?.sql)).toContain('reply_to_id');
    expect(args.slice(7, 11)).toEqual(['msg-0', 'Bob', 'user-2', '上一条原文']);
  });

  it('机器人发言 / 空正文 / 没正文：一条都不写', async () => {
    const cases: Record<string, unknown>[] = [
      channelPayload('bot 播报', { author: { id: 'bot-2', username: 'other', global_name: null, bot: true } }),
      channelPayload(''),
      channelPayload('   '),
    ];
    for (const raw of cases) {
      const harness = createHarness({ DISCORD_BOT_TOKEN: 'tok', DISCORD_APPLICATION_ID: BOT_ID, KEY_ENCRYPTION_SECRET: SECRET });
      FakeWebSocket.instances.length = 0;
      await dispatchMessage(harness, raw);
      expect(harness.batches).toHaveLength(0);
    }
  });

  it('缺 DB / 缺 KEY_ENCRYPTION_SECRET：只打一条错误日志，不抛错也不写库', async () => {
    const noSecret = createHarness({ DISCORD_BOT_TOKEN: 'tok', DISCORD_APPLICATION_ID: BOT_ID });
    await expect(dispatchMessage(noSecret, channelPayload('还在吗'))).resolves.toBeUndefined();
    expect(noSecret.batches).toHaveLength(0);

    FakeWebSocket.instances.length = 0;
    const pending: Promise<unknown>[] = [];
    const state = {
      storage: createFakeStorage(),
      waitUntil: (promise: Promise<unknown>) => {
        pending.push(promise);
      },
    } as unknown as DurableObjectState;
    const noDb = new GatewayPresence(state, {
      DISCORD_BOT_TOKEN: 'tok',
      DISCORD_APPLICATION_ID: BOT_ID,
      KEY_ENCRYPTION_SECRET: SECRET,
    });
    await noDb.fetch(new Request(GATEWAY_INTERNAL_ORIGIN + GATEWAY_ENSURE_PATH, { method: 'POST' }));
    const socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    for (const listener of socket?.listeners.get('message') ?? []) {
      listener({ data: JSON.stringify({ op: 0, t: 'MESSAGE_CREATE', s: 8, d: channelPayload('还在吗') }) });
    }
    await flush();
    await expect(Promise.all(pending)).resolves.toBeDefined();
  });
});
