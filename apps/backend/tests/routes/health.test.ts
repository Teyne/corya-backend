import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app, version } from '../../src/index.js';

interface HealthBody {
  status: string;
  version: string;
  timestamp: string;
}

async function getHealth(): Promise<{ status: number; body: HealthBody }> {
  const res = await request(app).get('/health');
  return { status: res.status, body: res.body as HealthBody };
}

describe('GET /health', () => {
  it('returns HTTP 200', async () => {
    const { status } = await getHealth();
    expect(status).toBe(200);
  });

  it('returns a body with status, version and timestamp', async () => {
    const { body } = await getHealth();
    expect(body.status).toBe('ok');
    expect(body.version).toBe(version);
    expect(typeof body.timestamp).toBe('string');
  });

  it('returns a valid ISO 8601 timestamp', async () => {
    const { body } = await getHealth();
    const ts = body.timestamp;
    expect(typeof ts).toBe('string');
    // Must round-trip through Date without losing information.
    const parsed = new Date(ts);
    expect(Number.isNaN(parsed.getTime())).toBe(false);
    expect(parsed.toISOString()).toBe(ts);
  });
});
