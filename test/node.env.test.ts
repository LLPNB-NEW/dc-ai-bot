import { describe, expect, it } from 'vitest';
import { API_SECRETS, DISCORD_SECRETS, firstMissingSecret, readNodeEnv, type NodeEnv } from '../src/node/env';

const SECRETS: Record<string, string> = {
  DISCORD_BOT_TOKEN: 'bot-token',
  DISCORD_PUBLIC_KEY: 'a'.repeat(64),
  DISCORD_APPLICATION_ID: '1234567890',
  ADMIN_PASSWORD: 'admin-pw',
  SESSION_SECRET: 'session-secret',
  KEY_ENCRYPTION_SECRET: 'key-secret',
};

const REQUIRED_SECRETS = [
  'DISCORD_BOT_TOKEN',
  'DISCORD_PUBLIC_KEY',
  'DISCORD_APPLICATION_ID',
  'ADMIN_PASSWORD',
  'SESSION_SECRET',
  'KEY_ENCRYPTION_SECRET',
] as const;

function source(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return { ...SECRETS, ...overrides };
}

describe('readNodeEnv 默认值', () => {
  it('缺 PORT 与 DB_PATH 时给出默认值', () => {
    const env = readNodeEnv(source());
    expect(env.port).toBe(8787);
    expect(env.dbPath).toBe('/data/dc-ai-bot.sqlite3');
  });

  it('空白值等同于没写', () => {
    const env = readNodeEnv(source({ PORT: '   ', DB_PATH: '' }));
    expect(env.port).toBe(8787);
    expect(env.dbPath).toBe('/data/dc-ai-bot.sqlite3');
  });

  it('读到的值覆盖默认值', () => {
    const env = readNodeEnv(source({ PORT: '3000', DB_PATH: 'E:/tmp/x.sqlite3' }));
    expect(env.port).toBe(3000);
    expect(env.dbPath).toBe('E:/tmp/x.sqlite3');
  });

  it('secret 原样保留，不做裁剪以外的改写', () => {
    const env = readNodeEnv(source());
    for (const name of REQUIRED_SECRETS) expect(env[name]).toBe(SECRETS[name]);
  });
});

describe('readNodeEnv 必填项', () => {
  for (const name of REQUIRED_SECRETS) {
    it(`缺少 ${name} 时抛错并点名`, () => {
      expect(() => readNodeEnv(source({ [name]: undefined }))).toThrow(`缺环境变量：${name}`);
    });

    it(`${name} 为空白时同样抛错`, () => {
      expect(() => readNodeEnv(source({ [name]: '   ' }))).toThrow(`缺环境变量：${name}`);
    });
  }
});

describe('readNodeEnv 端口校验', () => {
  it('边界值 1 与 65535 合法', () => {
    expect(readNodeEnv(source({ PORT: '1' })).port).toBe(1);
    expect(readNodeEnv(source({ PORT: '65535' })).port).toBe(65535);
  });

  for (const bad of ['0', '65536', '-1', '87abc', '8.5', 'NaN']) {
    it(`非法端口 ${bad} 抛错且带原值`, () => {
      expect(() => readNodeEnv(source({ PORT: bad }))).toThrow(`PORT 不是合法端口（1-65535）：${bad}`);
    });
  }
});

describe('secret 名单', () => {
  it('API 与 Discord 分支的名单与 Workers 侧逐项一致', () => {
    expect(API_SECRETS).toEqual(['KEY_ENCRYPTION_SECRET', 'ADMIN_PASSWORD', 'SESSION_SECRET']);
    expect(DISCORD_SECRETS).toEqual(['KEY_ENCRYPTION_SECRET', 'DISCORD_PUBLIC_KEY', 'DISCORD_APPLICATION_ID']);
  });
});

describe('firstMissingSecret', () => {
  const full: NodeEnv = readNodeEnv(source());

  it('全部就位时返回 null', () => {
    expect(firstMissingSecret(full, [...API_SECRETS, ...DISCORD_SECRETS])).toBeNull();
  });

  it('返回第一个空值而不是抛错', () => {
    const blank: NodeEnv = { ...full, SESSION_SECRET: '  ' };
    expect(firstMissingSecret(blank, API_SECRETS)).toBe('SESSION_SECRET');
  });

  it('空名单视为无缺失', () => {
    expect(firstMissingSecret(full, [])).toBeNull();
  });

  it('名单外的名字按缺失处理，避免拼错名字时静默放行', () => {
    expect(firstMissingSecret(full, ['SESSION_SECRETT'])).toBe('SESSION_SECRETT');
  });
});
