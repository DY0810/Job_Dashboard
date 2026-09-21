import { z } from 'zod';

export const PROVIDER_PROTOCOL_VERSION = 1;
const revision = z.number().int().nonnegative().safe();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const provider = z.string().trim().min(1).max(100);

export const ProviderConfigRequestSchema = z.strictObject({
  protocolVersion: z.literal(PROVIDER_PROTOCOL_VERSION),
  providerProtocolVersion: z.literal(PROVIDER_PROTOCOL_VERSION),
});
export const ProviderConfigSchema = z.strictObject({
  providerProtocolVersion: z.literal(PROVIDER_PROTOCOL_VERSION),
  ownerId: z.string().min(1).max(256), profileRevision: revision,
  policyRevision: revision, policyVersion: revision, policyHash: hash.nullable(),
  enabled: z.boolean(), provider: z.enum(['none', 'typesafe_jev']),
  model: z.string().trim().min(1).max(100).nullable(),
  endpoint: z.url({ protocol: /^https?$/ }).nullable(),
  privacy: z.enum(['local_inference_only', 'fully_local', 'approved_remote']),
  remoteProviderConsent: z.boolean(), allowedProviders: z.array(provider).max(20),
  fallbackOrder: z.array(provider).max(20), maxUsd: z.number().finite().min(0).max(10),
});
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
