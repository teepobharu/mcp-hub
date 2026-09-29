import { describe, expect, it } from 'vitest';
import request from 'supertest';
import app, { parseOAuthCallbackUrl } from '../src/server.js';
import { buildInfo, getHealthBuildInfo } from '../src/utils/build-info.js';

describe('hub build identity', () => {
  it('keeps the health summary compact and capability based', () => {
    const health = getHealthBuildInfo();
    expect(health.features.clearAuth).toBe(true);
    expect(health.features.leanProxy).toBe(true);
    expect(health.features.stdioAuthCommand).toBe(true);
    expect(health.features.stopHub).toBe(true);
    expect(health).not.toHaveProperty('changelog');
  });

  it('does not stop a process when the service has not started', async () => {
    const response = await request(app).post('/api/stop').set('X-MCPHub-Action', 'stop');
    expect(response.status).toBe(503);
  });

  it('rejects an unconfirmed stop POST', async () => {
    const response = await request(app).post('/api/stop');
    expect(response.status).toBe(403);
  });

  it('serves static build identity with current process runtime', async () => {
    const response = await request(app).get('/api/build-info');
    expect(response.status).toBe(200);
    expect(response.body.build).toEqual(buildInfo);
    expect(response.body.runtime.pid).toBe(process.pid);
    expect(response.body.runtime.node).toBe(process.version);
    expect(response.body.runtime.uptimeMs).toBeGreaterThanOrEqual(0);
  });
});

describe('manual OAuth callback URL parsing', () => {
  it('accepts the compatible path form without a server_name query', () => {
    expect(parseOAuthCallbackUrl('http://127.0.0.1:37373/callback/superset?code=abc')).toEqual({
      code: 'abc', server_name: 'superset',
    });
  });

  it('preserves the legacy query form', () => {
    expect(parseOAuthCallbackUrl('http://localhost:37373/api/oauth/callback?server_name=gitlab&code=xyz')).toEqual({
      code: 'xyz', server_name: 'gitlab',
    });
  });
});
