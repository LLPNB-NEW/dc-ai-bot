import type { ProviderId } from '../../core/types';

/** §16.4：M4 不得 import src/core/providers/**，key 连通性测试由 M6 注入实现 */
export type KeyProber = (input: { provider: ProviderId; apiKey: string; baseUrl?: string }) => Promise<string[]>;
