import type { RouteConfig, Scope } from '../types';

/** channel > guild > global；三层全空返回 null——路由缺失才是错误（§6.6 第 1 条） */
export function resolveRoute(
  channel: RouteConfig | null,
  guild: RouteConfig | null,
  global: RouteConfig | null,
): { cfg: RouteConfig; scope: Scope } | null {
  if (channel) return { cfg: channel, scope: 'channel' };
  if (guild) return { cfg: guild, scope: 'guild' };
  if (global) return { cfg: global, scope: 'global' };
  return null;
}
