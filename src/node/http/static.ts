import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';

/**
 * 复刻 wrangler [assets] not_found_handling = "single-page-application" 的行为：
 * 无扩展名且文件不存在时回 index.html，带扩展名时回 404。
 * 差别在于是"给人看的页面"还是"给程序用的资源"——后者被悄悄换成 HTML 只会更难查。
 */

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const FALLBACK_CONTENT_TYPE = 'application/octet-stream';
const INDEX_FILE = 'index.html';

function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? FALLBACK_CONTENT_TYPE;
}

/** 404 而不是 403：403 等于确认"这个路径存在但你不能看"，把目录结构漏给了探测者 */
function notFound(): Response {
  return new Response('Not Found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

/**
 * 返回相对 root 的路径；返回 null 表示请求本身可疑，直接 404。
 * 先解码再分段：%2e%2e 这类编码逃逸必须按解码后的结果判定。
 */
function decodePathname(pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const segments = decoded.split('/');
  // '..' 一律拒绝：没有任何正当理由让静态资源去访问自己的父目录
  if (segments.some((segment) => segment === '..')) return null;
  return segments.filter((segment) => segment !== '' && segment !== '.').join('/');
}

async function readFileIfExists(path: string): Promise<Uint8Array | null> {
  try {
    const info = await stat(path);
    // 目录、设备文件都不算静态资源；命中不到就当不存在，交给上层决定 404 还是回退
    if (!info.isFile()) return null;
    return new Uint8Array(await readFile(path));
  } catch {
    return null;
  }
}

function assetResponse(request: Request, body: Uint8Array, contentType: string): Response {
  const headers: Record<string, string> = { 'content-type': contentType };
  return new Response(request.method === 'HEAD' ? null : body, { status: 200, headers });
}

export function createStaticHandler(options: { root: string }): (request: Request) => Promise<Response> {
  const root = resolve(options.root);
  const rootPrefix = root.endsWith(sep) ? root : root + sep;

  return async (request: Request): Promise<Response> => {
    // 静态资源是只读的：别的动词到这里说明路由配错了，别让它读到文件
    if (request.method !== 'GET' && request.method !== 'HEAD') return notFound();

    const relativePath = decodePathname(new URL(request.url).pathname);
    if (relativePath === null) return notFound();

    const candidate = resolve(root, relativePath);
    // 第二道闸（'..' 已被拒）：resolve 之后仍在 root 之外，说明还有别的写法能逃逸
    if (candidate !== root && !candidate.startsWith(rootPrefix)) return notFound();

    const asset = await readFileIfExists(candidate);
    if (asset !== null) return assetResponse(request, asset, contentTypeFor(candidate));

    if (extname(relativePath) !== '') return notFound();

    const index = await readFileIfExists(join(root, INDEX_FILE));
    if (index === null) return notFound();
    return assetResponse(request, index, contentTypeFor(INDEX_FILE));
  };
}
