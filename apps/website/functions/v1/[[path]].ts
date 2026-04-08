/**
 * 将同源 /v1/* 转发到官方 API，避免浏览器直连 maliapi.215.im 时的跨域问题。
 * 开发环境仍使用 vite.config.ts 的 server.proxy。
 *
 * 若 Cloudflare Pages 的「根目录」设为仓库根而非 apps/website，需在仓库根执行
 * `pnpm build`（会同步 ./functions），否则会找不到 Functions，POST /v1 易变为 405。
 */
export async function onRequest(context: { request: Request }): Promise<Response> {
  const { request } = context;
  const url = new URL(request.url);
  url.hostname = "maliapi.215.im";
  url.protocol = "https:";
  // 使用 Request 克隆保留 method / body / headers；Workers 会按目标 URL 设置 Host
  return fetch(new Request(url, request));
}
