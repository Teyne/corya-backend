import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { app } from '../../src/index.js';
import { CORRELATION_HEADER } from '../../src/middleware/correlation.js';

const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

describe('early request pipeline failures', () => {
  it('returns a bounded correlated error for a refused Origin', async () => {
    const forbiddenOrigin =
      'https://synthetic-forbidden-origin-with-secret.invalid';

    const response = await request(app)
      .get('/health')
      .set('Origin', forbiddenOrigin)
      .set('Authorization', 'Bearer synthetic-origin-auth-secret')
      .expect(500);

    expect(response.headers[CORRELATION_HEADER.toLowerCase()]).toMatch(
      UUID_V4_REGEX,
    );
    expect(response.body).toEqual({
      error: 'internal_server_error',
      error_name: 'Error',
    });
    expect(response.text).not.toContain(forbiddenOrigin);
    expect(response.text).not.toContain('synthetic-origin-auth-secret');
  });

  it('returns a bounded correlated error for malformed JSON', async () => {
    const malformedBody =
      '{"synthetic_patient_secret":"must-never-be-reflected"';

    const response = await request(app)
      .post('/webhooks/retell')
      .set('Content-Type', 'application/json')
      .set('X-Health-Token', 'synthetic-json-health-secret')
      .send(malformedBody)
      .expect(500);

    expect(response.headers[CORRELATION_HEADER.toLowerCase()]).toMatch(
      UUID_V4_REGEX,
    );
    expect(response.body).toEqual({
      error: 'internal_server_error',
      error_name: 'SyntaxError',
    });
    expect(response.text).not.toContain('must-never-be-reflected');
    expect(response.text).not.toContain('synthetic-json-health-secret');
  });
});
