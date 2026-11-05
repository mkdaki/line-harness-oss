import { describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import worker, { type Env } from '../index.js';
import { edgeExt } from './edge-ext.js';

const SECRET = 'synthetic-internal-secret';
const API_KEY = 'synthetic-api-key';
const ADMIN_ORIGIN = 'https://admin.example.test';
const ORIGIN = 'https://worker.example.test';
const STAFF = { id: 'staff-1', name: '山田 太郎', role: 'staff' } as const;

type Handler = (request: Request) => Response | Promise<Response>;

function edgeApi(handler: Handler = () => Response.json({ data: [] })) {
  return { fetch: vi.fn(handler) };
}

function isolatedApp(staff: Env['Variables']['staff'] | null = STAFF) {
  const app = new Hono<Env>();
  app.use('*', async (c, next) => {
    if (staff) c.set('staff', staff);
    await next();
  });
  app.route('/', edgeExt);
  return app;
}

function bindings(api: unknown, secret: string | undefined = SECRET) {
  return { EDGE_API: api, EDGE_INTERNAL_SECRET: secret };
}

describe('edge-ext proxy', () => {
  test('rejects a request without staff and does not forward it', async () => {
    const api = edgeApi();
    const response = await isolatedApp(null).request('/api/ext/x', {}, bindings(api));
    expect(response.status).toBe(401);
    expect(api.fetch).not.toHaveBeenCalled();
  });

  test.each([
    ['EDGE_API', { EDGE_INTERNAL_SECRET: SECRET }],
    ['EDGE_INTERNAL_SECRET', { EDGE_API: edgeApi() }],
  ])('returns 503 when %s is not configured', async (_name, env) => {
    const response = await isolatedApp().request('/api/ext/x', {}, env);
    expect(response.status).toBe(503);
  });

  test('forwards only allowed headers, the path and the query', async () => {
    const api = edgeApi();
    const response = await isolatedApp().request('/api/ext/a/b?q=1', {
      headers: {
        Accept: 'application/json',
        Cookie: 'lh_admin_session=synthetic',
        Authorization: 'Bearer synthetic',
        'X-CSRF-Token': 'synthetic',
        'x-admin-api-key': 'synthetic',
        'X-Edge-Internal-Secret': 'forged',
        'X-Edge-Staff-Id': 'forged',
        'X-Edge-Staff-Name': 'forged',
        'X-Edge-Staff-Role': 'owner',
        'X-Edge-Other': 'forged',
      },
    }, bindings(api));

    expect(response.status).toBe(200);
    const forwarded = api.fetch.mock.calls[0][0];
    expect(forwarded.url).toBe('https://edge-api.internal/api/ext/a/b?q=1');
    expect(forwarded.redirect).toBe('manual');
    expect(Object.fromEntries(forwarded.headers)).toEqual({
      accept: 'application/json',
      'x-edge-internal-secret': SECRET,
      'x-edge-staff-id': 'staff-1',
      'x-edge-staff-name': encodeURIComponent(STAFF.name),
      'x-edge-staff-role': 'staff',
    });
  });

  test('forwards the method and body of a write request', async () => {
    const api = edgeApi(async (request) => Response.json({
      method: request.method,
      body: await request.text(),
      contentType: request.headers.get('content-type'),
    }));
    const response = await isolatedApp().request('/api/ext/x', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"a":1}',
    }, bindings(api));
    expect(await response.json()).toEqual({
      method: 'POST', body: '{"a":1}', contentType: 'application/json',
    });
  });

  test('passes the upstream response through without Set-Cookie', async () => {
    const api = edgeApi(() => new Response('teapot', {
      status: 418,
      headers: { 'Set-Cookie': 'a=b', 'X-From-Edge': 'yes' },
    }));
    const response = await isolatedApp().request('/api/ext/x', {}, bindings(api));
    expect(response.status).toBe(418);
    expect(await response.text()).toBe('teapot');
    expect(response.headers.get('X-From-Edge')).toBe('yes');
    expect(response.headers.get('Set-Cookie')).toBeNull();
  });

  test('returns 502 without details when the binding throws', async () => {
    const api = edgeApi(() => { throw new Error('internal detail'); });
    const response = await isolatedApp().request('/api/ext/x', {}, bindings(api));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ success: false, error: 'Bad gateway' });
  });
});

describe('edge-ext mounted on the real Worker', () => {
  function realEnv(api: unknown) {
    return {
      API_KEY,
      ADMIN_ORIGIN,
      WORKER_URL: ORIGIN,
      // getStaffByApiKey が担当者なしを返し、API_KEY のフォールバックに進むための最小のD1
      DB: { prepare: () => ({ bind: () => ({ first: async () => null, run: async () => ({}) }) }) },
      ...bindings(api),
    } as unknown as Env['Bindings'];
  }

  test('rejects an unauthenticated request in authMiddleware', async () => {
    const api = edgeApi();
    const response = await worker.fetch(new Request(`${ORIGIN}/api/ext/x`), realEnv(api));
    expect(response.status).toBe(401);
    expect(api.fetch).not.toHaveBeenCalled();
  });

  test('only forwards the exact /api/ext/ prefix', async () => {
    const api = edgeApi();
    const response = await worker.fetch(new Request(`${ORIGIN}/apix/ext/x`), realEnv(api));
    expect(response.status).toBe(404);
    expect(api.fetch).not.toHaveBeenCalled();
  });

  test('forwards an authenticated request with the staff identity and CORS headers', async () => {
    const api = edgeApi();
    const response = await worker.fetch(new Request(`${ORIGIN}/api/ext/x`, {
      headers: { Authorization: `Bearer ${API_KEY}`, Origin: ADMIN_ORIGIN },
    }), realEnv(api));

    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(ADMIN_ORIGIN);
    expect(response.headers.get('Access-Control-Allow-Credentials')).toBe('true');
    const forwarded = api.fetch.mock.calls[0][0];
    expect(forwarded.headers.get('X-Edge-Staff-Id')).toBe('env-owner');
    expect(forwarded.headers.get('X-Edge-Staff-Role')).toBe('owner');
    expect(forwarded.headers.get('Authorization')).toBeNull();
  });
});
