/**
 * Auth.js v5 route handler. Mounts `/api/auth/{signin,callback,csrf,...}`
 * on the App Router — the single owner of the session cookie.
 *
 * NextAuth v5 exposes `handlers` as `{ GET, POST }`; we re-export.
 */
import { handlers } from '../../../../auth.js';

export const { GET, POST } = handlers;
