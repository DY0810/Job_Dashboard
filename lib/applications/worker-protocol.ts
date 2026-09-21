import { z } from 'zod';
import { APPLICATION_STATES, SAFE_STAGES } from './state.ts';

export const WORKER_PROTOCOL_VERSION = 1;
export const LEASE_MS = 120_000;
export const HEARTBEAT_MS = 20_000;
export const PAIRING_TTL_MS = 600_000;
export const WORKER_CAPABILITIES = ['control-v1'] as const;
const uuid = z.uuid();
const revision = z.number().int().positive().safe();
const timestamp = z.number().int().nonnegative().safe();
const secret = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const name = z.string().trim().min(1).max(80);
const identity = z.string().min(1).max(256).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const capabilities = z.tuple([z.literal('control-v1')]);
const protocol = { protocolVersion: z.literal(WORKER_PROTOCOL_VERSION) };
const command = { requestId: uuid, expectedRevision: revision };
const clock = { ...protocol, serverTime: timestamp, heartbeatMs: z.literal(HEARTBEAT_MS), leaseMs: z.literal(LEASE_MS) };
export const ApplicationStateSchema = z.enum(APPLICATION_STATES);
export const PairingCreateSchema = z.strictObject({ ...command, expectedRevision: z.literal(0), label: name });
export const PairingGrantSchema = z.strictObject({
  pairingId: uuid, ownerId: z.string(), grant: secret, expiresAt: timestamp, revision: z.literal(1),
});
export const PairRequestSchema = z.strictObject({
  ...protocol, requestId: uuid, workerId: uuid, grant: secret, workerToken: secret,
  workerVersion: z.string().regex(/^[a-zA-Z0-9.+_-]{1,40}$/), capabilities,
});
export const PairResponseSchema = z.strictObject({ ...clock, workerId: uuid, ownerId: z.string(), revision });
export const RevisionCommandSchema = z.strictObject(command);
export const RevocationSchema = z.strictObject({ id: uuid, revision, revokedAt: timestamp });
export const WorkerSummarySchema = z.strictObject({
  id: uuid, label: name, revision, workerVersion: z.string(), capabilities,
  createdAt: timestamp, lastSeenAt: timestamp.nullable(), revokedAt: timestamp.nullable(), online: z.boolean(),
});
export const PairingSummarySchema = z.strictObject({
  id: uuid, label: name, revision, expiresAt: timestamp, consumedAt: timestamp.nullable(), revokedAt: timestamp.nullable(),
});
export const WorkerListSchema = z.strictObject({
  ownerId: z.string(), serverTime: timestamp, workers: z.array(WorkerSummarySchema), pairings: z.array(PairingSummarySchema),
});
export const PollRequestSchema = z.strictObject(protocol);
export const LeaseRefSchema = z.strictObject({ applicationId: uuid, fence: revision, expectedRevision: revision });
export const HeartbeatRequestSchema = z.strictObject({ ...protocol, lease: LeaseRefSchema.nullable() });
export const CheckpointSchema = z.strictObject({ stage: z.enum(SAFE_STAGES), sequence: timestamp });
export const LeaseSchema = z.strictObject({
  applicationId: uuid, runId: uuid, workerId: uuid, ownerId: z.string().min(1), policyRevision: revision,
  ats: identity, tenant: identity, requisition: identity,
  state: ApplicationStateSchema, revision, fence: revision, leaseUntil: timestamp,
  checkpoint: CheckpointSchema.nullable(), mode: z.enum(['safe', 'reconcile']),
});
export const PollResponseSchema = z.strictObject({ ...clock, lease: LeaseSchema.nullable() });
export const EventRequestSchema = z.strictObject({
  ...protocol, eventId: uuid, fence: revision, expectedRevision: revision,
  state: ApplicationStateSchema, checkpoint: CheckpointSchema, reasonCode: name.nullable(),
});
export const EventResponseSchema = z.strictObject({
  applicationId: uuid, eventId: uuid, revision, state: ApplicationStateSchema,
  replayed: z.boolean(), lease: LeaseSchema.nullable(), serverTime: timestamp,
});
export const RunCreateSchema = z.strictObject({ ...command, expectedRevision: z.literal(0), workerId: uuid });
export const RunCommandSchema = z.strictObject({ ...command, action: z.enum(['pause', 'resume', 'stop', 'emergency-stop']) });
export const ApplicationCommandSchema = z.strictObject({
  ...command, action: z.enum(['skip', 'retry-safe', 'cancel', 'emergency-stop']),
});
export const RunSchema = z.strictObject({
  id: uuid, workerId: uuid, revision, state: z.enum(['running', 'paused', 'stopped']), createdAt: timestamp,
});
export const ApplicationSummarySchema = z.strictObject({
  id: uuid, runId: uuid, workerId: uuid, ats: identity, tenant: identity, requisition: identity,
  state: ApplicationStateSchema, revision, reasonCode: name.nullable(), checkpoint: CheckpointSchema.nullable(),
});
export const RunListSchema = z.strictObject({
  ownerId: z.string(), runs: z.array(RunSchema), applications: z.array(ApplicationSummarySchema),
});
export const SubmitIntentSchema = z.strictObject({ ...protocol, eventId: uuid, fence: revision, expectedRevision: revision });
export const ApplicationIdentitySchema = z.strictObject({ ats: identity, tenant: identity, requisition: identity });
export type PairingCreate = z.infer<typeof PairingCreateSchema>;
export type PairingGrant = z.infer<typeof PairingGrantSchema>;
export type PairRequest = z.infer<typeof PairRequestSchema>;
export type PairResponse = z.infer<typeof PairResponseSchema>;
export type RevisionCommand = z.infer<typeof RevisionCommandSchema>;
export type Revocation = z.infer<typeof RevocationSchema>;
export type WorkerSummary = z.infer<typeof WorkerSummarySchema>;
export type PairingSummary = z.infer<typeof PairingSummarySchema>;
export type WorkerList = z.infer<typeof WorkerListSchema>;
export type PollRequest = z.infer<typeof PollRequestSchema>;
export type LeaseRef = z.infer<typeof LeaseRefSchema>;
export type HeartbeatRequest = z.infer<typeof HeartbeatRequestSchema>;
export type Checkpoint = z.infer<typeof CheckpointSchema>;
export type Lease = z.infer<typeof LeaseSchema>;
export type PollResponse = z.infer<typeof PollResponseSchema>;
export type EventRequest = z.infer<typeof EventRequestSchema>;
export type EventResponse = z.infer<typeof EventResponseSchema>;
export type RunCreate = z.infer<typeof RunCreateSchema>;
export type RunCommand = z.infer<typeof RunCommandSchema>;
export type ApplicationCommand = z.infer<typeof ApplicationCommandSchema>;
export type Run = z.infer<typeof RunSchema>;
export type ApplicationSummary = z.infer<typeof ApplicationSummarySchema>;
export type RunList = z.infer<typeof RunListSchema>;
export type SubmitIntent = z.infer<typeof SubmitIntentSchema>;
export type ApplicationIdentity = z.infer<typeof ApplicationIdentitySchema>;
