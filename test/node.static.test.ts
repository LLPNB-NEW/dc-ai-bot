import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createStaticHandler } from '../src/node/http/static';

/**
 * 默认 vitest 池是 workerd，那里的 node:fs 看不见真实磁盘（只接受 file: URL），
 * 所以本文件必须在 Node 里跑；读不到磁盘时显式跳过，而不是假装通过。
 */
interface DiskProbe {
  ok: boolean;
  tmpRoot: string;
}

async function probeDisk(): Promise<DiskProbe> {
  const candidates: string[] = [];
  for (const name of ['TEMP', 'TMP', 'TMPDIR']) {
    const value = process.env[name];
    if (typeof value === 'string' && value !== '') candidates.push(value);
  }
  try {
    // 动态导入：池里根本没有 node:os，静态导入会让整个文件连加载都失败
    const os = await import('node:os');
    candidates.push(os.tmpdir());
  } catch {
    // 没有 node:os 就等于没有真实磁盘，交给后面的试探统一判定
  }
  for (const tmpRoot of candidates) {
    try {
      const dir = mkdtempSync(join(tmpRoot, 'dc-ai-bot-probe-'));
      writeFileSync(join(dir, 'probe.txt'), 'ok');
      const ok = readFileSync(join(dir, 'probe.txt'), 'utf8') === 'ok';
      rmSync(dir, { recursive: true, force: true });
      if (ok) return { ok: true, tmpRoot };
    } catch {
      // 换下一个候选根目录
    }
  }
  return { ok: false, tmpRoot: '' };
}

const DISK = await probeDisk();
const REAL_DISK = DISK.ok;
const TMP_ROOT = DISK.tmpRoot;

describe.skipIf(!REAL_DISK)('createStaticHandler', () => {
  let sandbox: string;
  let root: string;
  let handle: (request: Request) => Promise<Response>;

  beforeAll(() => {
    sandbox = mkdtempSync(join(TMP_ROOT, 'dc-ai-bot-static-'));
    root = join(sandbox, 'web');
    mkdirSync(join(root, 'assets'), { recursive: true });

    writeFileSync(join(root, 'index.html'), '<!doctype html><title>spa</title>');
    writeFileSync(join(root, 'app.js'), 'console.log(1);');
    writeFileSync(join(root, 'style.css'), 'body{margin:0}');
    writeFileSync(join(root, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    writeFileSync(join(root, 'data.json'), '{"ok":true}');
    writeFileSync(join(root, 'note.txt'), 'hello');
    writeFileSync(join(root, 'font.woff2'), 'wOF2');
    writeFileSync(join(root, 'picture.png'), 'PNG');
    writeFileSync(join(root, 'picture.webp'), 'WEBP');
    writeFileSync(join(root, 'icon.ico'), 'ICO');
    writeFileSync(join(root, 'bundle.bin'), 'BIN');
    writeFileSync(join(root, 'LICENSE'), 'no extension here');
    writeFileSync(join(root, 'assets', 'nested.js'), 'nested');
    // root 的兄弟目录：用来证明越界访问真的被挡住，而不是"恰好不存在"
    writeFileSync(join(sandbox, 'secret.txt'), 'TOP SECRET');

    handle = createStaticHandler({ root });
  });

  afterAll(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  const get = (path: string, init?: RequestInit): Promise<Response> =>
    handle(new Request(`http://localhost${path}`, init));

  it('根路径回 index.html', async () => {
    const response = await get('/');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(await response.text()).toContain('spa');
  });

  it('显式请求 index.html 同样命中', async () => {
    const response = await get('/index.html');
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('spa');
  });

  it('无扩展名且文件不存在时回退到 index.html（200）', async () => {
    const response = await get('/dashboard/settings');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(await response.text()).toContain('spa');
  });

  it('带扩展名且文件不存在时是 404，不拿 HTML 冒充资源', async () => {
    const response = await get('/missing.js');
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('spa');
    expect((await get('/deep/missing.png')).status).toBe(404);
  });

  it.each([
    ['/app.js', 'text/javascript'],
    ['/style.css', 'text/css'],
    ['/logo.svg', 'image/svg+xml'],
    ['/picture.png', 'image/png'],
    ['/picture.webp', 'image/webp'],
    ['/icon.ico', 'image/x-icon'],
    ['/data.json', 'application/json'],
    ['/font.woff2', 'font/woff2'],
    ['/note.txt', 'text/plain'],
  ])('%s 按扩展名给出 content-type', async (path, expected) => {
    const response = await get(path);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain(expected);
  });

  it('未知扩展名按 octet-stream 下发', async () => {
    const response = await get('/bundle.bin');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
  });

  it('存在的无扩展名文件照常命中，不触发回退', async () => {
    const response = await get('/LICENSE');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('no extension here');
  });

  it('子目录里的资源可命中', async () => {
    const response = await get('/assets/nested.js');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('nested');
  });

  it('忽略查询串', async () => {
    const response = await get('/app.js?v=2&t=1');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/javascript');
  });

  it('目录本身不当文件下发，按 SPA 回退处理', async () => {
    const response = await get('/assets');
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('spa');
  });

  it.each([['/%2e%2e/secret.txt'], ['/assets/%2e%2e/%2e%2e/secret.txt'], ['/%2e%2e%2fsecret.txt']])(
    '%s 这类编码逃逸一律 404',
    async (path) => {
      const response = await get(path);
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain('TOP SECRET');
    },
  );

  it('绝对路径注入落在 root 之外时 404', async () => {
    // Windows 上 'C:/windows/win.ini' 会被 path.resolve 当成绝对路径，正好压到包含检查那一支
    const response = await get('/C:/windows/win.ini');
    expect(response.status).toBe(404);
  });

  it('404 响应不暴露根目录', async () => {
    const body = await (await get('/missing.js')).text();
    expect(body).not.toContain(root);
    expect(body).not.toContain(sandbox);
  });

  it('HEAD 只回头不回体', async () => {
    const response = await get('/app.js', { method: 'HEAD' });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
  });

  it('非 GET/HEAD 动词不读文件', async () => {
    expect((await get('/app.js', { method: 'POST' })).status).toBe(404);
  });
});
