import { toNextJsHandler } from 'better-auth/next-js';
import { handleAuthRequest } from '@/lib/auth-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// v1.7.5 accepts a function, so unconfigured public builds never initialize auth.
export const { GET, POST } = toNextJsHandler((request) => handleAuthRequest(request));
