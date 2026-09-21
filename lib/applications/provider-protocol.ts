import { z } from 'zod';

export const PROVIDER_PROTOCOL_VERSION = 1;
export const TYPESAFE_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const TYPESAFE_MODEL = 'jev-latest';
export const TYPESAFE_PROVIDER_ID = 'typesafe:jev';
export const TYPESAFE_INPUT_PRICE_USD_PER_BILLION = 42;
export const LOCAL_OLLAMA_PROVIDER_ID = 'local:ollama';
export const OMNIROUTE_PROVIDER_ID = 'omniroute:compatible';
export const BYOK_PROVIDER_ID = 'byok:compatible';
export const LOCAL_OLLAMA_ENDPOINT = 'http://127.0.0.1:11434/api/chat';
const revision = z.number().int().nonnegative().safe();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const provider = z.string().trim().min(1).max(100);
const providerKind = z.enum(['none', 'typesafe_jev', 'local_ollama', 'omniroute', 'byok']);
const providerProtocol = z.enum(['typesafe_systemone', 'ollama_native', 'openai_compatible']);
const locality = z.enum(['none', 'local', 'remote']);
const credential = z.enum(['none', 'os_keychain', 'hosted_envelope']);
const budget = z.strictObject({
  perRequestUsd: z.number().finite().min(0).max(1000),
  perRunUsd: z.number().finite().min(0).max(10_000),
  perDayUsd: z.number().finite().min(0).max(10_000),
  allowUnknownCost: z.literal(false),
}).default({ perRequestUsd: 0, perRunUsd: 0, perDayUsd: 0, allowUnknownCost: false });
const pricing = z.strictObject({
  known: z.boolean(), inputUsdPerMillion: z.number().finite().min(0).max(100_000),
  outputUsdPerMillion: z.number().finite().min(0).max(100_000),
}).default({ known: false, inputUsdPerMillion: 0, outputUsdPerMillion: 0 });
export const ProviderCapabilitySchema = z.strictObject({
  checkedAt: z.iso.datetime(), protocol: providerProtocol, model: z.string().trim().min(1).max(100),
  locality, structuredOutput: z.boolean(), tools: z.literal(false),
  maxContextTokens: z.number().int().positive().nullable(), maxOutputTokens: z.number().int().positive().nullable(),
}).nullable().default(null);
export type ProviderCapability = z.infer<typeof ProviderCapabilitySchema>;

export const ProviderConfigRequestSchema = z.strictObject({
  protocolVersion: z.literal(PROVIDER_PROTOCOL_VERSION),
  providerProtocolVersion: z.literal(PROVIDER_PROTOCOL_VERSION),
});
export const ProviderConfigSchema = z.strictObject({
  providerProtocolVersion: z.literal(PROVIDER_PROTOCOL_VERSION),
  ownerId: z.string().min(1).max(256), profileRevision: revision,
  policyRevision: revision, policyVersion: revision, policyHash: hash.nullable(),
  enabled: z.boolean(), provider: providerKind,
  model: z.string().trim().min(1).max(100).nullable(),
  endpoint: z.url({ protocol: /^https?$/ }).nullable(),
  privacy: z.enum(['local_inference_only', 'fully_local', 'approved_remote']),
  remoteProviderConsent: z.boolean(), allowedProviders: z.array(provider).max(20),
  fallbackOrder: z.array(provider).max(20), maxUsd: z.number().finite().min(0).max(10),
  protocol: providerProtocol.nullable().default(null), locality: locality.default('none'),
  credential: credential.default('none'), budget, pricing, capability: ProviderCapabilitySchema,
});
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
