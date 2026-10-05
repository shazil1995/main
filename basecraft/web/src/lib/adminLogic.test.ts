import { describe, expect, it } from 'vitest';
import { assignableRoles, canManageMember, capabilityMatrix, inviteLink, inviteStatus, invitableRoles, metaSummary, parseDays, tokenStatus } from './adminLogic';
import { automationToDraft, draftToBody, emptyDraft, fieldsToRows, insertPlaceholder, rowsToFields, validateDraft, type ApiAutomation } from './automationLogic';

describe('roles', () => {
  it('owner can assign everything, admin only below', () => {
    expect(assignableRoles('owner')).toContain('owner');
    expect(assignableRoles('admin')).toEqual(['viewer', 'commenter', 'editor']);
    expect(invitableRoles('owner')).not.toContain('owner');
    expect(invitableRoles('owner')).toContain('admin');
  });
  it('member management', () => {
    expect(canManageMember('admin', 'admin')).toBe(false);
    expect(canManageMember('admin', 'editor')).toBe(true);
    expect(canManageMember('owner', 'owner')).toBe(true);
  });
  it('matrix reflects inheritance', () => {
    const m = Object.fromEntries(capabilityMatrix().map((r) => [r.label, r.roles]));
    expect(m['View data']!.viewer).toBe(true);
    expect(m['Edit records']!.commenter).toBe(false);
    expect(m['Edit records']!.editor).toBe(true);
    expect(m['Manage members']!.editor).toBe(false);
    expect(m['Manage members']!.admin).toBe(true);
  });
});
describe('misc', () => {
  it('invite link and status', () => {
    expect(inviteLink('https://x.test', 'bci_a+b')).toBe('https://x.test/invite?token=bci_a%2Bb');
    const now = Date.parse('2026-01-02');
    expect(inviteStatus({ expires_at: '2026-01-01', revoked_at: null, accepted_at: null }, now)).toBe('expired');
    expect(inviteStatus({ expires_at: '2026-02-01', revoked_at: null, accepted_at: null }, now)).toBe('pending');
    expect(inviteStatus({ expires_at: '2026-02-01', revoked_at: 'x', accepted_at: null }, now)).toBe('revoked');
    expect(inviteStatus({ expires_at: '2026-02-01', revoked_at: null, accepted_at: 'x' }, now)).toBe('accepted');
    expect(tokenStatus({ revoked_at: null, expires_at: null })).toBe('active');
  });
  it('parseDays', () => {
    expect(parseDays('', 1, 30)).toBeNull();
    expect(parseDays('7', 1, 30)).toBe(7);
    expect(parseDays('31', 1, 30)).toBeUndefined();
    expect(parseDays('1.5', 1, 30)).toBeUndefined();
  });
  it('metaSummary truncates', () => {
    expect(metaSummary({ a: 1 })).toBe('{"a":1}');
    expect(metaSummary('x'.repeat(500), 10).length).toBe(10);
    expect(metaSummary(null)).toBe('');
  });
});
describe('automation drafts', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  it('round-trips refs and literals', () => {
    const fields = { a: 'x', b: { $ref: id }, c: false };
    expect(rowsToFields(fieldsToRows(fields))).toEqual(fields);
  });
  it('builds bodies', () => {
    const d = emptyDraft(); d.name = ' N '; d.trigger = 'record_updated'; d.watch = [id];
    d.actions[0]!.rows[0] = { key: 'r', fieldId: 'f', mode: 'value', value: 1, refId: '' };
    expect(draftToBody(d)).toEqual({ name: 'N', enabled: true, trigger: { type: 'record_updated', watch_fields: [id] }, conditions: null, actions: [{ type: 'update_record', fields: { f: 1 } }] });
  });
  it('converts api automation', () => {
    const a: ApiAutomation = { id: '1', table_id: 't', name: 'n', enabled: false, trigger: { type: 'record_created' }, conditions: null, actions: [{ type: 'create_record', table_id: 't2', fields: { f: 'v' } }] };
    const d = automationToDraft(a);
    expect(d.actions[0]!.tableId).toBe('t2');
    expect(draftToBody(d).actions[0]).toEqual({ type: 'create_record', table_id: 't2', fields: { f: 'v' } });
  });
  it('validates', () => {
    const d = emptyDraft(); d.trigger = 'condition_matched'; d.actions = [{ key: 'x', type: 'create_record', tableId: '', rows: [{ key: 'r', fieldId: '', mode: 'value', value: null, refId: '' }] }];
    const e = validateDraft(d, false);
    expect(Object.keys(e).sort()).toEqual(['actions.0.fields', 'actions.0.table_id', 'conditions', 'name']);
  });
  it('placeholder', () => expect(insertPlaceholder('Hi ', 'abc')).toBe('Hi {{abc}}'));
});
