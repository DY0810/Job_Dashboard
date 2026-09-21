import 'server-only';
import { z } from 'zod';
import { getDiscoveryCorpus } from './discovery-corpus.ts';
import { getPrivateDb } from '../private-db/index.ts';
import { getAuth } from '../auth.ts';
import { privateEndpoint, readPrivateJson, PrivateInputError } from './private-http.ts';
import { WorkerError } from './worker-store.ts';
import { previewLegacyImport, confirmLegacyImport } from './imports.ts';
import { abandonDiscovery, getDiscoveryStatus, reapplyApplication } from './discovery.ts';
import {
  ImportPreviewRequestSchema, ImportConfirmRequestSchema, ReapplyRequestSchema, AbandonDiscoverySchema,
} from './discovery-protocol.ts';

export async function discoveryEndpoint(request: Request, action: 'preview' | 'confirm' | 'status' | 'abandon' | 'reapply', runId?: string) {
  return privateEndpoint(request, async (ownerId) => {
    try {
      if (new URL(request.url).search || (runId !== undefined && !z.uuid().safeParse(runId).success)) {
        throw new PrivateInputError(400, 'Invalid request path.');
      }
      const db = getPrivateDb(), options = { isAllowedApplicant: getAuth().isAllowedApplicant };
      switch (action) {
        case 'preview': return await previewLegacyImport(db, ownerId, getDiscoveryCorpus, await readPrivateJson(request, ImportPreviewRequestSchema), options);
        case 'confirm': return await confirmLegacyImport(db, ownerId, await readPrivateJson(request, ImportConfirmRequestSchema), options);
        case 'status': return await getDiscoveryStatus(db, ownerId, runId!);
        case 'abandon': return await abandonDiscovery(db, ownerId, runId!, await readPrivateJson(request, AbandonDiscoverySchema), options);
        case 'reapply': return await reapplyApplication(db, ownerId, runId!, await readPrivateJson(request, ReapplyRequestSchema), options);
      }
    } catch (error) {
      if (error instanceof WorkerError) throw new PrivateInputError(error.status, error.message, error.code);
      throw error;
    }
  });
}
