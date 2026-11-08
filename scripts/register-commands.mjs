#!/usr/bin/env node
/**
 * 把 src/workers/discord/commands.ts 里的 COMMANDS 全量注册到 Discord。
 *
 * 单一事实来源：命令定义只在 commands.ts 存在一份，本脚本不内嵌任何命令副本。
 * 读取方式：Node 22.13+ 直接 import .ts（--experimental-strip-types）；新版本 Node 默认剥离类型，
 * 就先尝试进程内 import。两条路都不通时报错退出，绝不退回"手工维护的快照"。
 *
 * 用法：
 *   DISCORD_APPLICATION_ID=... DISCORD_BOT_TOKEN=... npm run register
 *   DISCORD_APPLICATION_ID=... DISCORD_BOT_TOKEN=... npm run register -- --dry-run
 */
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const API_BASE = 'https://discord.com/api/v10';
const here = dirname(fileURLToPath(import.meta.url));
const commandsPath = join(here, '..', 'src', 'workers', 'discord', 'commands.ts');
const dryRun = process.argv.includes('--dry-run');

function fail(message) {
  console.error(message);
  process.exit(1);
}

/** 读取 commands.ts 的 COMMANDS：先进程内 import，失败再开带 --experimental-strip-types 的子进程 */
async function loadCommands() {
  try {
    const module = await import(pathToFileURL(commandsPath).href);
    if (Array.isArray(module.COMMANDS)) return { commands: module.COMMANDS, loader: 'in-process' };
  } catch {
    // Node 22.13 未开类型剥离，落到子进程
  }

  const bootstrap =
    'import(' + JSON.stringify(pathToFileURL(commandsPath).href) + ').then((m) => {' +
    ' if (!Array.isArray(m.COMMANDS)) { console.error("COMMANDS is not an array"); process.exit(3); }' +
    ' process.stdout.write(JSON.stringify(m.COMMANDS));' +
    '}).catch((error) => { console.error(error); process.exit(4); });';

  const child = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', bootstrap],
    { encoding: 'utf8' },
  );
  if (child.status !== 0) {
    fail(
      '无法从 ' + commandsPath + ' 读取 COMMANDS。\n' +
        '需要 Node >= 22.13 的类型剥离支持（--experimental-strip-types）。当前版本：' + process.version + '\n' +
        (child.stderr || ''),
    );
  }
  const parsed = JSON.parse(child.stdout);
  if (!Array.isArray(parsed)) fail('commands.ts 的 COMMANDS 不是数组');
  return { commands: parsed, loader: 'child --experimental-strip-types' };
}

function assertCommands(commands) {
  if (commands.length === 0) fail('commands.ts 里没有任何命令');
  for (const command of commands) {
    if (typeof command.name !== 'string' || command.name === '') fail('命令缺少 name');
    if (typeof command.type !== 'number') fail('命令 ' + command.name + ' 缺少 type');
    if (typeof command.description !== 'string' || command.description === '') {
      fail('命令 ' + command.name + ' 缺少 description（Discord 必填）');
    }
  }
}

async function main() {
  const applicationId = (process.env.DISCORD_APPLICATION_ID ?? '').trim();
  const botToken = (process.env.DISCORD_BOT_TOKEN ?? '').trim();
  if (applicationId === '') fail('缺少环境变量 DISCORD_APPLICATION_ID');
  if (botToken === '') fail('缺少环境变量 DISCORD_BOT_TOKEN');

  const { commands, loader } = await loadCommands();
  assertCommands(commands);

  const url = API_BASE + '/applications/' + applicationId + '/commands';
  console.log('命令定义来源：' + commandsPath + '（共 ' + commands.length + ' 条，读取方式：' + loader + '）');

  if (dryRun) {
    console.log('[dry-run] 不发送请求。目标：PUT ' + url);
    console.log(JSON.stringify({ body: commands }, null, 2));
    return;
  }

  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      authorization: 'Bot ' + botToken,
      'content-type': 'application/json',
    },
    body: JSON.stringify(commands),
  });

  const text = await response.text();
  if (!response.ok) {
    console.error('注册失败：HTTP ' + response.status);
    console.error(text);
    process.exit(1);
  }

  let registered;
  try {
    registered = JSON.parse(text);
  } catch {
    console.error('Discord 返回了非 JSON 响应，原样输出：');
    console.error(text);
    process.exit(1);
  }
  if (!Array.isArray(registered)) {
    console.error('Discord 返回体不是数组，原样输出：');
    console.error(text);
    process.exit(1);
  }

  console.log('注册成功，共 ' + registered.length + ' 条：');
  for (const command of registered) {
    console.log('  /' + String(command.name) + '  ->  ' + String(command.id));
  }
}

await main();