import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationsRoot = resolve(process.cwd(), '..', '..', 'supabase', 'migrations');

describe('append-only migration compatibility', () => {
  it('keeps every portal team audit action when adding PDF authorization', async () => {
    const migration = await readFile(
      resolve(migrationsRoot, '20260828010000_portal_pdf_delivery_audit.sql'),
      'utf8',
    );
    const actionConstraint = migration.match(
      /ADD CONSTRAINT portal_audit_events_action_check[\s\S]*?CHECK \(action IN \(([\s\S]*?)\)\),/u,
    )?.[1];
    const allowlistConstraint = migration.match(
      /ADD CONSTRAINT portal_audit_events_changed_fields_allowlist_check[\s\S]*?CHECK \(([\s\S]*?)\),\s*ADD CONSTRAINT portal_audit_events_entity_check/u,
    )?.[1];

    expect(actionConstraint).toBeDefined();
    expect(allowlistConstraint).toBeDefined();
    for (const action of [
      'settings_updated',
      'assistant_updated',
      'team_member_invited',
      'team_member_role_updated',
      'team_member_disabled',
      'pdf_download_authorized',
    ]) {
      expect(actionConstraint).toContain(`'${action}'`);
      expect(allowlistConstraint).toContain(`action = '${action}'`);
    }
  });
});
