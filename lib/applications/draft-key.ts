import 'server-only';
import { hkdfSync, timingSafeEqual } from 'node:crypto';
import { PrivateConfigurationError } from '../private-db/config.ts';

export function readDraftKeyConfig(env: Record<string, string | undefined> = process.env) {
  const raw = env.WORKIE_DRAFT_ENCRYPTION_KEY ?? '';
  const key = Buffer.from(raw, 'base64');
  const keyVersion = env.WORKIE_DRAFT_KEY_VERSION ?? '';
  const auth = env.BETTER_AUTH_SECRET?.trim() ?? '';
  const authForms = [Buffer.from(auth), Buffer.from(auth, 'base64'), Buffer.from(auth, 'hex')];
  if (key.length !== 32 || key.toString('base64') !== raw || !/^[1-9]\d{0,8}$/.test(keyVersion) ||
      raw === auth || authForms.some((bytes) => bytes.length === 32 && timingSafeEqual(key, bytes))) {
    throw new PrivateConfigurationError();
  }
  return { key, keyVersion };
}

/** Only the per-principal HKDF output leaves the server, never the deployment key. */
export function getDraftKey(ownerId: string, env: Record<string, string | undefined> = process.env) {
  if (!ownerId || ownerId.length > 256) throw new PrivateConfigurationError();
  const { key, keyVersion } = readDraftKeyConfig(env);
  const derived = hkdfSync('sha256', key, 'workie.profile.draft.v1', JSON.stringify([ownerId, keyVersion]), 32);
  return { ownerId, keyVersion, key: Buffer.from(derived).toString('base64') };
}
