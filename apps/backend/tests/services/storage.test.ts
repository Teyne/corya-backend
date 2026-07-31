/**
 * Unit tests — services/storage.ts
 *
 * The Supabase client is mocked at the module level. We prove:
 *   - object path is deterministic and derived from `date_appel`, NOT `now()`
 *   - signed URL TTL is CLAMPED to 30 min even if a caller passes more
 *   - `ensureBucketAccessible` fails LOUDLY when the bucket is absent
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface UploadOpts {
  contentType?: string;
  upsert?: boolean;
}
const uploadMock = vi.fn<
  (path: string, bytes: Buffer | Uint8Array, opts: UploadOpts) => Promise<{ error: { message: string } | null }>
>();
const createSignedUrlMock = vi.fn<
  (path: string, ttl: number) => Promise<{ data: { signedUrl: string } | null; error: { message: string } | null }>
>();
const listBucketsMock = vi.fn<
  () => Promise<{ data: { name: string }[] | null; error: { message: string } | null }>
>();

vi.mock('../../src/config/supabase.js', () => ({
  getServiceClient: () => ({
    storage: {
      from: (_name: string) => ({
        upload: uploadMock,
        createSignedUrl: createSignedUrlMock,
      }),
      listBuckets: listBucketsMock,
    },
  }),
}));

const {
  buildPdfObjectPath,
  createSignedPdfUrl,
  ensureBucketAccessible,
  MAX_SIGNED_URL_TTL_SECONDS,
  PDF_BUCKET,
  uploadPdf,
} = await import('../../src/services/storage.js');

beforeEach(() => {
  uploadMock.mockReset();
  createSignedUrlMock.mockReset();
  listBucketsMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('buildPdfObjectPath', () => {
  it('uses date_appel (UTC yyyy-mm), NOT the wall clock', () => {
    const path = buildPdfObjectPath(
      'cab-1',
      'appel-1',
      '2026-01-15T14:30:00.000Z',
    );
    expect(path).toBe('cab-1/2026-01/appel-1.pdf');
  });

  it('is stable across retries — the same input always yields the same path', () => {
    const args = ['cab-2', 'appel-2', '2026-07-31T09:00:00.000Z'] as const;
    expect(buildPdfObjectPath(...args)).toBe(buildPdfObjectPath(...args));
  });

  it('throws on a non-parseable date_appel', () => {
    expect(() => buildPdfObjectPath('a', 'b', 'not-a-date')).toThrow(
      /invalid_date_appel_iso/,
    );
  });
});

describe('uploadPdf', () => {
  it('upserts to the pdf-recaps bucket with application/pdf', async () => {
    uploadMock.mockResolvedValue({ error: null });
    const { objectPath } = await uploadPdf('cab/2026-07/appel.pdf', Buffer.from('pdf'));
    expect(objectPath).toBe('cab/2026-07/appel.pdf');
    expect(uploadMock).toHaveBeenCalledTimes(1);
    const [path, bytes, opts] = uploadMock.mock.calls[0];
    expect(path).toBe('cab/2026-07/appel.pdf');
    expect(Buffer.isBuffer(bytes)).toBe(true);
    expect(opts).toMatchObject({ upsert: true, contentType: 'application/pdf' });
  });

  it('throws with a redacted message on Storage error', async () => {
    uploadMock.mockResolvedValue({ error: { message: 'boom' } });
    await expect(uploadPdf('p', Buffer.from(''))).rejects.toThrow(/storage_upload_failed/);
  });
});

describe('createSignedPdfUrl', () => {
  it('clamps the TTL to MAX_SIGNED_URL_TTL_SECONDS (30 min)', async () => {
    createSignedUrlMock.mockResolvedValue({
      data: { signedUrl: 'https://example/sig' },
      error: null,
    });
    await createSignedPdfUrl('p', 24 * 3600); // caller tries 24 h
    const [, ttl] = createSignedUrlMock.mock.calls[0];
    expect(ttl).toBe(MAX_SIGNED_URL_TTL_SECONDS);
  });

  it('returns the signed URL on success', async () => {
    createSignedUrlMock.mockResolvedValue({
      data: { signedUrl: 'https://ex/x' },
      error: null,
    });
    await expect(createSignedPdfUrl('p')).resolves.toBe('https://ex/x');
  });

  it('throws when supabase returns an error', async () => {
    createSignedUrlMock.mockResolvedValue({ data: null, error: { message: 'nope' } });
    await expect(createSignedPdfUrl('p')).rejects.toThrow(/storage_sign_url_failed/);
  });
});

describe('ensureBucketAccessible', () => {
  it('resolves when the bucket is present', async () => {
    listBucketsMock.mockResolvedValue({
      data: [{ name: PDF_BUCKET }, { name: 'other' }],
      error: null,
    });
    await expect(ensureBucketAccessible()).resolves.toBeUndefined();
  });

  it('throws when Supabase Storage rejects listBuckets', async () => {
    listBucketsMock.mockResolvedValue({ data: null, error: { message: 'perm denied' } });
    await expect(ensureBucketAccessible()).rejects.toThrow(/storage_list_buckets_failed/);
  });

  it('throws when the pdf-recaps bucket is missing', async () => {
    listBucketsMock.mockResolvedValue({ data: [{ name: 'other' }], error: null });
    await expect(ensureBucketAccessible()).rejects.toThrow(/storage_bucket_missing/);
  });
});
