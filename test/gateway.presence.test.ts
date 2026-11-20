import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  GATEWAY_DO_NAME,
  GATEWAY_ENSURE_PATH,
  GATEWAY_INTERNAL_ORIGIN,
  GATEWAY_STATE_KEY,
  GATEWAY_STATUS_PATH,
  GatewayPresence,
} from '../src/workers/gateway/durable-object';

declare global {
  namespace Cloudflare {
    interface Env {
      GATEWAY_PRESENCE: DurableObjectNamespace;
    }
  }
}

/**
 * 真实的 DO 实例只跑「不需要出网」的路径（/status 不建连接）。
 * 只要 env 里带 token，/ensure 与 alarm 就会真的去连 Discord，
 * 所以 token 相关分支用下面这套假 storage 直接把 class 实例化来测。
 */
function createFakeStorage(seed: Record<string, unknown> = {}): FakeStorage {
  const data = new Map<string, unknown>(Object.entries(seed));
  const puts: PutRecord[] = [];
  const alarms: number[] = [];
  const storage: FakeStorage = {
    puts,
    alarms,
    async get<T>(key: string): Promise<T | undefined> {
      const value = data.get(key);
      return value === undefined ? undefined : (value as T);
    },
    async put(key: string, value: unknown): Promise<void> {
      data.set(key, value);
      puts.push({ key, value });
    },
    async getAlarm(): Promise<number | null> {
      return alarms.length === 0 ? null : (alarms[alarms.length - 1] as number);
    },
    async setAlarm(scheduledTime: number | Date): Promise<void> {
      alarms.push(typeof scheduledTime === 'number' ? scheduledTime : scheduledTime.getTime());
    },
  };
  return storage;
}

interface PutRecord {
  key: string;
  value: unknown;
}

interface FakeStorage {
  readonly puts: PutRecord[];
  readonly alarms: number[];
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number | Date): Promise<void>;
}

function createFakeState(storage: FakeStorage): DurableObjectState {
  return { storage } as unknown as DurableObjectState;
}

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  const parsed: unknown = await response.json();
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('期望一个 JSON 对象');
  return parsed as Record<string, unknown>;
}

describe('GatewayPresence Durable Object', () => {
  it('通过 wrangler 的 DO 绑定能取到实例，/status 返回初始快照', async () => {
    const namespace = env.GATEWAY_PRESENCE;
    const stub = namespace.get(namespace.idFromName(GATEWAY_DO_NAME + '-status'));
    const response = await stub.fetch(GATEWAY_INTERNAL_ORIGIN + GATEWAY_STATUS_PATH);
    expect(response.status).toBe(200);
    const body = await bodyOf(response);
    expect(body['ok']).toBe(true);
    expect(body['connected']).toBe(false);
    expect(body['socketState']).toBe('none');
    expect(body['sessionId']).toBeNull();
    expect(body['hasResumeUrl']).toBe(false);
    expect(body['seq']).toBeNull();
    expect(body['awaitingAck']).toBe(false);
    expect(body['reconnectAttempt']).toBe(0);
    expect(typeof body['tokenConfigured']).toBe('boolean');
  });

  it('入口导出的 class 就是这条绑定背后的实现', async () => {
    const namespace = env.GATEWAY_PRESENCE;
    const stub = namespace.get(namespace.idFromName(GATEWAY_DO_NAME + '-class'));
    const matched = await runInDurableObject(stub, (instance) => instance instanceof GatewayPresence);
    expect(matched).toBe(true);
  });

  it('未知内部路径返回 404（DO 不对外开放）', async () => {
    const namespace = env.GATEWAY_PRESENCE;
    const stub = namespace.get(namespace.idFromName(GATEWAY_DO_NAME + '-404'));
    const response = await stub.fetch(GATEWAY_INTERNAL_ORIGIN + '/api/whatever');
    expect(response.status).toBe(404);
    const body = await bodyOf(response);
    expect(body['ok']).toBe(false);
  });

  it('缺 DISCORD_BOT_TOKEN：/ensure 不抛错、不建连接、不留 alarm', async () => {
    const storage = createFakeStorage();
    const presence = new GatewayPresence(createFakeState(storage), {});
    const response = await presence.fetch(new Request(GATEWAY_INTERNAL_ORIGIN + GATEWAY_ENSURE_PATH, { method: 'POST' }));
    expect(response.status).toBe(200);
    const body = await bodyOf(response);
    expect(body['ok']).toBe(true);
    expect(body['tokenConfigured']).toBe(false);
    expect(body['socketState']).toBe('none');
    expect(storage.alarms).toHaveLength(0);
  });

  it('缺 token 时 alarm 同样安静返回（被驱逐后也不会炸）', async () => {
    const storage = createFakeStorage();
    const presence = new GatewayPresence(createFakeState(storage), { DISCORD_BOT_TOKEN: '   ' });
    await expect(presence.alarm()).resolves.toBeUndefined();
    expect(storage.alarms).toHaveLength(0);
    expect(storage.puts).toHaveLength(0);
  });

  it('/status 会把持久化状态读回来，但瞬时标志一律复位', async () => {
    const storage = createFakeStorage({
      [GATEWAY_STATE_KEY]: {
        sessionId: 'sess-abc',
        resumeUrl: 'wss://gateway-us-east1-b.discord.gg',
        seq: 42,
        heartbeatIntervalMs: 41250,
        reconnectAttempt: 3,
      },
    });
    const presence = new GatewayPresence(createFakeState(storage), {});
    const response = await presence.fetch(new Request(GATEWAY_INTERNAL_ORIGIN + GATEWAY_STATUS_PATH));
    expect(response.status).toBe(200);
    const body = await bodyOf(response);
    expect(body['sessionId']).toBe('sess-abc');
    expect(body['hasResumeUrl']).toBe(true);
    expect(body['seq']).toBe(42);
    expect(body['heartbeatIntervalMs']).toBe(41250);
    expect(body['reconnectAttempt']).toBe(3);
    expect(body['awaitingAck']).toBe(false);
    expect(body['connected']).toBe(false);
    expect(body['socketState']).toBe('none');
  });
});
