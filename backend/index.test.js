'use strict';

const { after, before, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const runtimePrefix = '/teams/platform/repo-forge-2026';
process.env.BASE_PATH = runtimePrefix;
process.env.GITLAB_TOKEN = 'test-token-value';
process.env.GITLAB_API_URL = 'https://gitlab.example.com/api/v4';
process.env.GITLAB_WEB_URL = 'https://gitlab.example.com';
process.env.TEMPLATE_REPO_PREFIX = 'https://gitlab.example.com/templates/';
process.env.NAMESPACE_MAP = '{"Team A":101}';
process.env.TEMPLATE_MAP = '{"embark-go-image":201}';

const { applyCspNonce, normalizeBasePath, startServer, PROJECT_VISIBILITY } = require('./index');

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const clientRequest = http.request({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: options.method || 'GET',
      headers: { connection: 'close', ...(options.headers || {}) },
      agent: false
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: response.statusCode,
          headers: { get: (name) => response.headers[name.toLowerCase()] ?? null },
          json: async () => JSON.parse(body)
        });
      });
    });
    clientRequest.on('error', reject);
    if (options.body) clientRequest.write(options.body);
    clientRequest.end();
  });
}

describe('RepoForge HTTP server', () => {
  let server;
  let origin;

  before(async () => {
    server = startServer(0);
    if (!server.listening) await once(server, 'listening');
    origin = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  });

  it('normalizes safe base paths and rejects traversal', () => {
    assert.equal(normalizeBasePath('git-repo/'), '/git-repo');
    assert.equal(normalizeBasePath('/products/finance/repo-ui/'), '/products/finance/repo-ui');
    assert.equal(normalizeBasePath('/'), '/');
    assert.throws(() => normalizeBasePath('/../admin'));
    assert.throws(() => normalizeBasePath('/team/./admin'));
  });

  it('creates projects with the private visibility promised by the UI', () => {
    assert.equal(PROJECT_VISIBILITY, 'private');
  });

  it('serves health with defensive browser headers', async () => {
    const response = await request(`${origin}/healthz`);
    assert.equal(response.status, 200);
    const policy = response.headers.get('content-security-policy');
    assert.match(policy, /frame-ancestors 'none'/);
    assert.match(policy, /script-src 'self' 'nonce-[A-Za-z0-9+/]+=*'/);
    assert.match(policy, /style-src 'self' 'nonce-[A-Za-z0-9+/]+=*'/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(response.headers.get('x-request-id'));
  });

  it('injects the per-request nonce required by Angular component styles', () => {
    const source = fs.readFileSync(path.join(__dirname, '../frontend/src/index.html'), 'utf8');
    const rendered = applyCspNonce(source, 'test-nonce');
    assert.match(rendered, /<app-root ngCspNonce="test-nonce">/);
    assert.doesNotMatch(rendered, /__CSP_NONCE__/);
  });

  it('redirects the path root to a trailing slash', async () => {
    const response = await request(`${origin}${runtimePrefix}`, { redirect: 'manual' });
    assert.equal(response.status, 308);
    assert.equal(response.headers.get('location'), `${runtimePrefix}/`);
  });

  it('serves configuration below the base path', async () => {
    const response = await request(`${origin}${runtimePrefix}/api/config/subgroups`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), [{ label: 'Team A', value: 'Team A' }]);
  });

  it('rejects invalid create payloads before contacting GitLab', async () => {
    const response = await request(`${origin}${runtimePrefix}/api/create_repo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'validation-test-1' },
      body: JSON.stringify({ projectName: '../bad', subgroup: 'Team A', technology: 'Go', artifactType: 'Image' })
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /Project name/);
  });

  it('rejects malformed JSON', async () => {
    const response = await request(`${origin}${runtimePrefix}/api/create_repo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{'
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'Malformed JSON request' });
  });
});
