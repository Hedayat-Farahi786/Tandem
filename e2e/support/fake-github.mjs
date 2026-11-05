/**
 * A pretend GitHub for the tests: the OAuth code exchange and /user, for a few people. Tandem signs
 * people in with GitHub; nothing else of GitHub is used here. The OAuth "authorize" page answers at
 * once, signed in as the person whose code is in ?login= (Mona by default), like a browser would
 * after "Authorize".
 */
import { createServer } from 'node:http';

export const PEOPLE = {
  'code-mona': { id: 101, login: 'mona', name: 'Mona Lisa' },
  'code-hubot': { id: 102, login: 'hubot', name: 'Hubot' },
  'code-eve': { id: 103, login: 'eve', name: 'Eve' },
};

/** Starts it on a free port of 127.0.0.1; returns its address and a way to stop it. */
export async function startFakeGitHub() {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c.toString()));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://github.test');
      if (req.method === 'GET' && url.pathname === '/login/oauth/authorize') {
        const back = new URL(url.searchParams.get('redirect_uri') ?? '');
        back.searchParams.set('code', `code-${url.searchParams.get('login') ?? 'mona'}`);
        back.searchParams.set('state', url.searchParams.get('state') ?? '');
        res.writeHead(302, { location: back.toString() });
        return res.end();
      }
      res.setHeader('content-type', 'application/json');
      if (req.method === 'POST' && url.pathname === '/login/oauth/access_token') {
        const { code, grant_type } = JSON.parse(body || '{}');
        if (grant_type === 'refresh_token') return res.end(JSON.stringify({ error: 'bad_refresh_token' }));
        return res.end(JSON.stringify(code && PEOPLE[code] ? { access_token: `ghu_${code}`, expires_in: 28_800, refresh_token: `ghr_${code}`, refresh_token_expires_in: 15_897_600 } : { error: 'bad_verification_code' }));
      }
      if (url.pathname === '/user') {
        const p = PEOPLE[String(req.headers.authorization ?? '').replace('Bearer ghu_', '')];
        res.statusCode = p ? 200 : 401;
        return res.end(JSON.stringify(p ? { ...p, email: null, avatar_url: null } : { message: 'Bad credentials' }));
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  return { url: `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`, close: () => new Promise((r) => server.close(r)) };
}

/** The settings that point Tandem at this pretend GitHub (and at the test's own address). */
export function webAppEnv({ github, url, secretKey }) {
  return {
    TANDEM_PUBLIC_URL: url,
    TANDEM_LISTEN_HOST: '127.0.0.1',
    TANDEM_GITHUB_CLIENT_ID: 'Iv1.e2e',
    TANDEM_GITHUB_CLIENT_SECRET: 'e2e-secret',
    TANDEM_GITHUB_APP_SLUG: 'tandem-e2e',
    TANDEM_GITHUB_WEB_URL: github,
    TANDEM_GITHUB_API_URL: github,
    TANDEM_SECRET_KEY: secretKey,
    TANDEM_GITHUB_WEBHOOK_SECRET: 'e2e-webhook-secret-0123456789',
  };
}
