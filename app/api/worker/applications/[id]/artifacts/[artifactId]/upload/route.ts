import { workerArtifactUploadEndpoint } from '@/lib/applications/worker-http';

export const POST = async (request: Request, context: { params: Promise<{ id: string; artifactId: string }> }) => {
  const params = await context.params;
  return workerArtifactUploadEndpoint(request, params.id, params.artifactId);
};
