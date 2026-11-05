// 自社API(edge-api)への中継。本家に無い自社ファイルで、edge-one/patches/ で管理する。
import { Hono } from 'hono';
import type { Env } from '../index.js';

type EdgeEnv = {
  Bindings: Env['Bindings'] & { EDGE_API?: Fetcher; EDGE_INTERNAL_SECRET?: string };
  Variables: Env['Variables'];
};

// 許可リスト方式。Cookie / Authorization / X-CSRF-Token / x-admin-api-key /
// クライアントが偽装した X-Edge-* は、ここに無いので転送されない。
const FORWARD_HEADERS = ['accept', 'accept-language', 'content-type', 'idempotency-key'];

export const edgeExt = new Hono<EdgeEnv>();

edgeExt.all('/api/ext/*', async (c) => {
  // 担当者を特定できないリクエストは転送しない
  const staff = c.get('staff');
  if (!staff) return c.json({ success: false, error: 'Unauthorized' }, 401);
  if (!c.env.EDGE_API || !c.env.EDGE_INTERNAL_SECRET) {
    return c.json({ success: false, error: 'Service unavailable' }, 503);
  }

  const headers = new Headers();
  for (const name of FORWARD_HEADERS) {
    const value = c.req.header(name);
    if (value) headers.set(name, value);
  }
  headers.set('X-Edge-Internal-Secret', c.env.EDGE_INTERNAL_SECRET);
  // 日本語の担当者名はそのままではヘッダーに入らないためエンコードする
  headers.set('X-Edge-Staff-Id', encodeURIComponent(staff.id));
  headers.set('X-Edge-Staff-Name', encodeURIComponent(staff.name));
  headers.set('X-Edge-Staff-Role', staff.role);

  const source = new URL(c.req.url);
  const method = c.req.method;
  const init: RequestInit & { duplex?: 'half' } = { method, headers, redirect: 'manual' };
  if (method !== 'GET' && method !== 'HEAD') {
    init.body = c.req.raw.body;
    init.duplex = 'half';
  }
  try {
    const response = await c.env.EDGE_API.fetch(
      new Request(`https://edge-api.internal${source.pathname}${source.search}`, init),
    );
    const out = new Response(response.body, response);
    out.headers.delete('Set-Cookie');
    return out;
  } catch {
    return c.json({ success: false, error: 'Bad gateway' }, 502);
  }
});
