'use client';

import { createAuthClient } from 'better-auth/react';

// Relative URLs keep cookies and auth calls on this origin; no server config in the bundle.
export const authClient = createAuthClient({
  fetchOptions: { cache: 'no-store' },
});
