import {
  ImportAcknowledgementSchema, ImportConfirmRequestSchema,
  ImportPreviewRequestSchema, ImportPreviewSchema,
} from '../../lib/applications/discovery-protocol';

export const ownerA = 'synthetic-owner-a';
export const ownerB = 'synthetic-owner-b';
const token = '00000000-0000-4000-8000-000000000003';
export const marks = {
  length: 2, key: (i: number) => ['workie-applied:1', 'workie-applied:999999'][i] ?? null,
  getItem: () => '1',
};

export class DiscoveryFixture {
  owner: string | null = ownerA;
  rejectConfirm = 0;
  loseNext = false;
  afterWrite?: () => void | Promise<void>;
  writes: { path: string; body: Record<string, unknown>; owner: string | null }[] = [];
  preview = ImportPreviewSchema.parse({
    ownerId: ownerA, previewToken: token, previewHash: 'a'.repeat(64), expiresAt: 1,
    rows: [
      { postingId: 1, company: 'Fixture employer', title: 'Engineer', url: 'https://jobs.example.test/1',
        identity: { ats: 'greenhouse', tenant: 'fixture', requisition: '1' }, resolution: 'resolved', reason: null },
      { postingId: 999999, company: null, title: null, url: 'javascript:alert(1)',
        identity: null, resolution: 'unresolved', reason: 'unsafe-secret-error' },
    ],
  });
  async handle(path: string, method: string, headers: Headers, body: Record<string, unknown> | null) {
    if (!this.owner) return { status: 401, json: { error: 'unsafe-secret-error' } };
    if (path === '/api/auth/applicant') return {
      status: 200, json: { ownerId: this.owner, name: 'Fixture applicant', email: `${this.owner}@example.test` },
    };
    if (path === '/api/auth/applicants') return { status: 200, json: { applicants: [
      { ownerId: this.owner, name: 'Fixture applicant', email: `${this.owner}@example.test`, active: true },
    ] } };
    if (headers.get('x-workie-applicant') !== this.owner) return {
      status: 403, json: { error: 'Applicant session changed. Unlock the current account.' },
    };
    if (method === 'POST') this.writes.push({ path, body: structuredClone(body!), owner: headers.get('x-workie-applicant') });
    let result: { status: number; json: unknown };
    if (path.endsWith('/preview')) {
      ImportPreviewRequestSchema.parse(body);
      result = { status: 200, json: this.preview };
    } else if (path.endsWith('/confirm')) {
      const input = ImportConfirmRequestSchema.parse(body);
      const resolvedCount = input.postingIds.filter((id) => this.preview.rows.find((row) => row.postingId === id)?.resolution === 'resolved').length;
      result = this.rejectConfirm ? { status: this.rejectConfirm, json: {
        code: this.rejectConfirm === 409 ? 'PREVIEW_EXPIRED' : 'UNAVAILABLE', error: 'unsafe-secret-error',
      } } : { status: 200, json: ImportAcknowledgementSchema.parse({
        ownerId: this.owner, previewToken: input.previewToken, requestId: input.requestId,
        status: 'manual_reported', importedPostingIds: input.postingIds, resolvedCount,
        unresolvedCount: input.postingIds.length - resolvedCount,
      }) };
    } else throw new Error(`Unexpected fixture path: ${path}`);
    await this.afterWrite?.();
    if (this.loseNext) { this.loseNext = false; throw new TypeError('unsafe-secret-error'); }
    return result;
  }
}
