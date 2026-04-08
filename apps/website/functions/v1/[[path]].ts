/**
 * 将同源 /v1/* 转发到官方 API，避免浏览器直连 maliapi.215.im 时的跨域问题。
 * 开发环境仍使用 vite.config.ts 的 server.proxy。
 */
export async function onRequest(context: { request: Request }): Promise<Response> {
  const { request } = context;
  const dest = new URL(request.url);
  dest.hostname = "maliapi.215.im";
  dest.protocol = "https:";

  const headers = new Headers(request.headers);
  headers.delete("Host");

  return fetch(
    new Request(dest.toString(), {
      method: request.method,
      headers,
      body: request.body,
      redirect: "manual",
    }),
  );
}
