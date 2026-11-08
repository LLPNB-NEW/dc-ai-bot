/** 频道预设（「示例角色」）要求模型把正文包进 <game>…</game>：Discord 不渲染这些标记，只会把标记当正文显示。 */

/** 预设的包裹标签名：文本里成对出现才剥，只出现一边就整段原样 */
const WRAPPER_TAGS: readonly string[] = ['game', 'game_content'];

/** 剥掉成对的包裹标签：只删两串标记，中间正文一个字都不动（换行、缩进、<think_nya> 全留） */
export function stripWrapperTags(raw: string): string {
  let text = raw;
  for (const tag of WRAPPER_TAGS) {
    const open = '<' + tag + '>';
    const close = '</' + tag + '>';
    // 两串标记同时出现才算包裹：只出现一边时整段不动，免得把正文里的半截标记吃掉
    if (!raw.includes(open) || !raw.includes(close)) continue;
    text = text.split(open).join('').split(close).join('');
  }
  return text;
}
