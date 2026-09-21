import 'server-only';
import { z } from 'zod';
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { lookupApplicant, privateJson, privateResponse } from '../applicant-access';
import { getPrivateDb, type PrivateDb } from '../private-db';
import type { ApplicantAuth } from '../auth';
import {
  authorizeBlobGrant, completeBlobDocument, createDocumentGrant, downloadDocument,
  listDocuments, receiveLocalDocument, retryDocumentValidation,
} from './documents';
import { boundedDocumentBytes, DocumentError, documentStorageConfig, type DocumentStorage } from './documents-storage';
import { ApplicantPreconditionError, assertExpectedApplicant } from './applicant-precondition';

type Dependencies = { db?: PrivateDb; storage?: DocumentStorage; auth?: ApplicantAuth };
type Action = 'list' | 'create' | 'local-upload' | 'download' | 'validate';
const grantPayload = z.strictObject({ grantId: z.uuid() });
const tokenRequest = z.strictObject({
  type: z.literal('blob.generate-client-token'),
  payload: z.strictObject({
    pathname: z.string().min(1).max(1024), clientPayload: z.string().max(4096), multipart: z.literal(false),
  }),
});
async function jsonBody(request: Request): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') {
    throw new DocumentError(415, 'JSON required.');
  }
  const bytes = await boundedDocumentBytes(request.body, 16_384);
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new DocumentError(400, 'Invalid JSON.'); }
}
function documentFailure(error: unknown, headers?: HeadersInit) {
  if (error instanceof DocumentError || error instanceof ApplicantPreconditionError) {
    return privateJson({ error: error.message }, { status: error.status, headers });
  }
  return privateJson({ error: 'Private document storage is unavailable.' }, { status: 503, headers });
}
function validationResponse(document: Awaited<ReturnType<typeof retryDocumentValidation>>, headers: HeadersInit) {
  const status = document.state === 'available' ? 200 : document.state === 'rejected' ? 422 : 202;
  return privateJson({ document, ...(status === 422 ? { error: 'Document failed safety checks.' } : {}) }, { status, headers });
}
export async function handleDocumentRequest(request: Request, action: Action, id?: string, dependencies: Dependencies = {}) {
  let headers: Headers | undefined;
  try {
    const access = await lookupApplicant(request, dependencies.auth);
    if (access instanceof Response) return access;
    headers = access.response.headers;
    const ownerId = access.applicant.ownerId;
    assertExpectedApplicant(request, ownerId);
    const db = dependencies.db ?? getPrivateDb();
    const storage = dependencies.storage ?? documentStorageConfig();
    if (action === 'list') return privateJson({ documents: await listDocuments(db, ownerId), storage: storage.mode }, { headers });
    if (action === 'create') return privateJson(await createDocumentGrant(db, ownerId, await jsonBody(request), storage), { status: 201, headers });
    if (!z.uuid().safeParse(id).success) throw new DocumentError(404, 'Document not found.');
    if (action === 'local-upload') return validationResponse(await receiveLocalDocument(db, ownerId, id!, request, storage), headers);
    if (action === 'validate') return validationResponse(await retryDocumentValidation(db, ownerId, id!, storage), headers);
    const { document, bytes } = await downloadDocument(db, ownerId, id!, storage);
    const responseHeaders = new Headers(headers);
    responseHeaders.set('Content-Type', document.mime);
    responseHeaders.set('Content-Length', String(bytes.length));
    const encodedName = encodeURIComponent(document.name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    responseHeaders.set('Content-Disposition', `attachment; filename="document.${document.mime === 'application/pdf' ? 'pdf' : 'docx'}"; filename*=UTF-8''${encodedName}`);
    return privateResponse(new Response(Buffer.from(bytes), { headers: responseHeaders }));
  } catch (error) { return documentFailure(error, headers); }
}
export async function handleDocumentBlobRequest(request: Request, dependencies: Dependencies = {}) {
  let headers: Headers | undefined;
  let verifiedCallback = false;
  try {
    let ownerId: string | undefined;
    const callback = request.headers.has('x-vercel-signature');
    if (!callback) {
      const access = await lookupApplicant(request, dependencies.auth);
      if (access instanceof Response) return access;
      headers = access.response.headers;
      ownerId = access.applicant.ownerId;
      assertExpectedApplicant(request, ownerId);
    }
    const storage = dependencies.storage ?? documentStorageConfig();
    if (storage.mode !== 'blob') throw new DocumentError(503, 'Private Blob upload is unavailable.');
    // Preserve parsed object keys and order: the SDK signs JSON.stringify(body).
    // Structural validation of the callback payload happens AFTER SDK verification.
    const raw = await jsonBody(request);
    if (!raw || typeof raw !== 'object' || !('type' in raw) ||
      !['blob.generate-client-token', 'blob.upload-completed'].includes(String(raw.type))) {
      throw new DocumentError(400, 'Invalid upload event.');
    }
    // A signature header selects only the SDK-verified callback path, never token issuance.
    if (callback && raw.type !== 'blob.upload-completed') throw new DocumentError(403, 'Invalid callback event.');
    if (!callback && !tokenRequest.safeParse(raw).success) throw new DocumentError(400, 'Invalid upload event.');
    const result = await handleUpload({
      token: storage.token, request, body: raw as HandleUploadBody,
      onBeforeGenerateToken: async (pathname, clientPayload, multipart) => {
        if (!ownerId) throw new ApplicantPreconditionError();
        if (multipart !== false || typeof clientPayload !== 'string') throw new DocumentError(400, 'Invalid upload grant.');
        let parsed: z.infer<typeof grantPayload>;
        try { parsed = grantPayload.parse(JSON.parse(clientPayload)); }
        catch { throw new DocumentError(400, 'Invalid upload grant.'); }
        const { grant, document } = await authorizeBlobGrant(
          dependencies.db ?? getPrivateDb(), ownerId, parsed.grantId, pathname,
        );
        return {
          allowedContentTypes: [document.mime], maximumSizeInBytes: document.size,
          validUntil: grant.expiresAt, addRandomSuffix: false, allowOverwrite: false,
          tokenPayload: JSON.stringify({ grantId: grant.id }), callbackUrl: storage.callbackUrl,
        };
      },
      onUploadCompleted: async ({ blob, tokenPayload }) => {
        verifiedCallback = true;
        const schema = z.object({ url: z.string(), pathname: z.string(), contentType: z.string() });
        let payload: z.infer<typeof grantPayload>;
        try { payload = grantPayload.parse(JSON.parse(tokenPayload ?? '')); }
        catch { throw new DocumentError(400, 'Invalid signed upload grant.'); }
        const parsed = schema.safeParse(blob);
        if (!parsed.success) throw new DocumentError(400, 'Invalid signed upload object.');
        await completeBlobDocument(dependencies.db ?? getPrivateDb(), payload.grantId, parsed.data, storage);
      },
    });
    return privateJson(result, { headers });
  } catch (error) {
    if (!verifiedCallback && /Missing callback signature|Invalid callback signature/.test(String(error))) {
      return privateJson({ error: 'Invalid callback signature.' }, { status: 403 });
    }
    return documentFailure(error, headers);
  }
}
