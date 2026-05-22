/**
 * Re-exported because Next.js' route handler at
 * `app/api/auth/[...nextauth]/route.ts` needs a single import point for
 * `handlers`, and so do server components that call `auth()` to read
 * the current session.
 *
 * The actual config lives in `src/lib/auth/config.ts`; this file is a
 * thin shim per the Auth.js v5 convention.
 */
import NextAuth from 'next-auth';
import { resolveAuthConfig } from './lib/auth/config.js';
import './lib/auth/types.js'; // module augmentation side-effect

export const { handlers, auth, signIn, signOut, unstable_update } = NextAuth(resolveAuthConfig());
