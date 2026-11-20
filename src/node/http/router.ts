/**
 * Workers 入口的三分支路由（src/workers/index.ts:246-252）在 Node 侧的等价物。
 * 分支顺序本身就是语义：interactions 先于 /api，/api 只认整段而不是 /apix。
 * 这里不 import Workers 入口——两边各自装配，共享模块只到 core 为止。
 */

export interface EntryDeps {
  interactionPaths: readonly string[];
  handleInteraction(request: Request): Promise<Response>;
  handleApi(request: Request, pathname: string): Promise<Response>;
  serveAssets(request: Request): Promise<Response>;
}

export function createEntryHandler(deps: EntryDeps): (request: Request) => Promise<Response> {
  return (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url);
    if (deps.interactionPaths.includes(pathname)) return deps.handleInteraction(request);
    // '/api' 与 '/api/...' 两种写法都要接住，但 '/apix' 不能误入
    if (pathname === '/api' || pathname.startsWith('/api/')) return deps.handleApi(request, pathname);
    return deps.serveAssets(request);
  };
}
