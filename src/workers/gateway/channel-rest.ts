/**
 * 普通消息的出口：频道消息 REST（Bot token 鉴权）。
 *
 * 斜杠命令那条路走 ./rest.ts 的 interaction webhook（靠 interaction token），
 * 这里补的是「主动发消息」——只有 Bot token 才能 POST /channels/{id}/messages。
 * §29 起这里还负责流式：首个 token 到了才 POST 第一条（拿回消息 id），之后不断 PATCH 它。
 */

import { sendChannelFile } from '../discord/rest';

export const DISCORD_API_BASE = 'https://discord.com/api/v10';

export interface ChannelClientOptions {
  botToken: string;
  apiBase?: string;
  /**
   * 注入点：测试传假 fetch。生产留空时用箭头函数转调 globalThis.fetch ——
   * 不能把裸 fetch 引用塞进对象再当方法调用，workerd 会 brand-check 报 Illegal invocation。
   */
  fetch?: typeof fetch;
}

export interface ChannelClient {
  sendMessage(channelId: string, content: string): Promise<void>;
  sendTyping(channelId: string): Promise<void>;
  /** §29：发一条消息并拿回它的消息 id（POST ?wait=true），流式编辑要有 id 才能 PATCH */
  createMessage(channelId: string, content: string): Promise<string>;
  /** §29：改写自己发出去的那条消息 */
  editMessage(channelId: string, messageId: string, content: string): Promise<void>;
  /** 附件：单独一条消息发一个文件；没有这条能力的通道不必实现，调用方跳过即可。
   *  不给 file 时按语音 mp3 发（既有调用点），给了就按它自己的文件名与类型发（图片） */
  sendFile?(channelId: string, bytes: Uint8Array, file?: { name: string; contentType: string }): Promise<void>;
}

export function createChannelClient(options: ChannelClientOptions): ChannelClient {
  const apiBase = options.apiBase ?? DISCORD_API_BASE;
  const doFetch =
    options.fetch ??
    ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => globalThis.fetch(input, init));
  const authorization = 'Bot ' + options.botToken;

  async function request(method: string, path: string, body: unknown): Promise<unknown> {
    const res = await doFetch(apiBase + path, {
      method,
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text();
      throw new Error('discord HTTP ' + String(res.status) + ': ' + detail.slice(0, 300));
    }
    if (method !== 'POST' || !path.includes('wait=true')) return undefined;
    const payload = (await res.json()) as { id?: unknown };
    return payload;
  }

  // 只解析用户提及：模型写的 @everyone / @角色 不该真的 ping，别人写的 <@id> 要能真 ping 到人
  const messageBody = (content: string): unknown => ({ content, allowed_mentions: { parse: ['users'] } });

  return {
    sendMessage: async (channelId: string, content: string): Promise<void> => {
      await request('POST', '/channels/' + channelId + '/messages', messageBody(content));
    },
    sendTyping: async (channelId: string): Promise<void> => {
      await request('POST', '/channels/' + channelId + '/typing', {});
    },
    createMessage: async (channelId: string, content: string): Promise<string> => {
      const payload = (await request(
        'POST',
        '/channels/' + channelId + '/messages?wait=true',
        messageBody(content),
      )) as { id?: unknown } | undefined;
      const id = typeof payload?.id === 'string' ? payload.id : '';
      if (id === '') throw new Error('discord 没有返回消息 id：' + JSON.stringify(payload).slice(0, 200));
      return id;
    },
    editMessage: async (channelId: string, messageId: string, content: string): Promise<void> => {
      await request('PATCH', '/channels/' + channelId + '/messages/' + messageId, messageBody(content));
    },
    sendFile: async (
      channelId: string,
      bytes: Uint8Array,
      file?: { name: string; contentType: string },
    ): Promise<void> => {
      // multipart 的实现只留一份（discord/rest.ts）：两条发送路径共用同一个附件形状
      await sendChannelFile(options, channelId, bytes, file);
    },
  };
}
