import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  QQ_DEFAULT_TOKEN_FILE,
  parseCredentialText,
  resolveQqCredentials,
} from '../src/node/qq/credentials';

const ASCII = 'Appid:123456\nAppSecret:abcdef';
const FULL_WIDTH = 'Appid：123456\nAppSecret：abcdef';

describe('token 文件解析器', () => {
  it('认 ASCII 冒号', () => {
    expect(parseCredentialText(ASCII)).toEqual({ appId: '123456', appSecret: 'abcdef' });
  });

  it('认全角冒号', () => {
    expect(parseCredentialText(FULL_WIDTH)).toEqual({ appId: '123456', appSecret: 'abcdef' });
  });

  it('Windows 换行、BOM、空行、注释与多余空白都能跳过', () => {
    const text = '\uFEFF# QQ bot 凭证\r\n\r\n  Appid ： 123456 \r\n  App Secret ："abcdef" \r\n';
    expect(parseCredentialText(text)).toEqual({ appId: '123456', appSecret: 'abcdef' });
  });

  it('缺字段返回 null，绝不返回半份凭证', () => {
    expect(parseCredentialText('Appid:123456')).toBeNull();
    expect(parseCredentialText('AppSecret:abcdef')).toBeNull();
    expect(parseCredentialText('')).toBeNull();
    expect(parseCredentialText('Appid:\nAppSecret:')).toBeNull();
    expect(parseCredentialText('Appid:123\nOther:1\nAppSecret:abc')).toEqual({ appId: '123', appSecret: 'abc' });
  });
});

describe('凭证来源', () => {
  it('两个环境变量齐全时直接用，不读文件', async () => {
    let reads = 0;
    const credentials = await resolveQqCredentials({
      env: { QQ_BOT_APP_ID: 'env-id', QQ_BOT_APP_SECRET: 'env-secret' },
      readFile: async () => {
        reads += 1;
        return ASCII;
      },
    });
    expect(credentials).toEqual({ appId: 'env-id', appSecret: 'env-secret' });
    expect(reads).toBe(0);
  });

  it('只配了半个环境变量时不和文件混用', async () => {
    let reads = 0;
    const credentials = await resolveQqCredentials({
      env: { QQ_BOT_APP_ID: 'env-id' },
      readFile: async () => {
        reads += 1;
        return ASCII;
      },
    });
    expect(credentials).toBeNull();
    expect(reads).toBe(0);
  });

  it('没有环境变量时读工作目录下缺省的 "QQ bot.token"', async () => {
    const seen: string[] = [];
    const credentials = await resolveQqCredentials({
      env: {},
      cwd: 'E:/work',
      readFile: async (path) => {
        seen.push(path);
        return FULL_WIDTH;
      },
    });
    expect(credentials).toEqual({ appId: '123456', appSecret: 'abcdef' });
    expect(seen).toEqual([join('E:/work', QQ_DEFAULT_TOKEN_FILE)]);
  });

  it('QQ_BOT_TOKEN_FILE 指定绝对路径时原样读取', async () => {
    const seen: string[] = [];
    const credentials = await resolveQqCredentials({
      env: { QQ_BOT_TOKEN_FILE: '/secrets/qq.token' },
      cwd: 'E:/work',
      readFile: async (path) => {
        seen.push(path);
        return ASCII;
      },
    });
    expect(credentials).toEqual({ appId: '123456', appSecret: 'abcdef' });
    expect(seen).toEqual(['/secrets/qq.token']);
  });

  it('文件读不到或解析不出来都只是「没配 QQ」，不抛错', async () => {
    const missing = await resolveQqCredentials({
      env: {},
      cwd: 'E:/work',
      readFile: async () => {
        throw new Error('ENOENT');
      },
    });
    expect(missing).toBeNull();

    const incomplete = await resolveQqCredentials({
      env: {},
      cwd: 'E:/work',
      readFile: async () => 'Appid:1',
    });
    expect(incomplete).toBeNull();
  });
});
