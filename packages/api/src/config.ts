import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  PLUGGY_CLIENT_ID: z.string().min(1, 'PLUGGY_CLIENT_ID is required'),
  PLUGGY_CLIENT_SECRET: z.string().min(1, 'PLUGGY_CLIENT_SECRET is required'),
  PORT: z.coerce.number().default(3333),
  CORS_ORIGIN: z.string().optional(),
  DATABASE_DIR: z.string().min(1, 'DATABASE_DIR is required'),
  SESSION_SECRET: z.string().optional(),
});

export const config = schema.parse(process.env);

// Multi-user credentials. Each user is declared as a separate env var:
//   USER_KENJI_PASSWORD=hunter2
//   USER_ALICE_PASSWORD=correct-horse
// The username is derived from the env var name (lowercased), so it must be
// a valid env-var middle word (letters, digits, underscore). That same
// constraint makes it a safe SQLite filename without any escaping.
export type UserCredentials = Map<string, string>;

function parseUsers(env: NodeJS.ProcessEnv): UserCredentials {
  const users = new Map<string, string>();
  const re = /^USER_([A-Z0-9_]+)_PASSWORD$/;
  for (const [key, value] of Object.entries(env)) {
    const m = key.match(re);
    if (!m || !value) continue;
    users.set(m[1].toLowerCase(), value);
  }
  return users;
}

export const users = parseUsers(process.env);

// When no users are configured the app falls back to an open mode for local
// development (single anonymous user, DB file `default.sqlite`). The session
// secret is still required in production for cookie signing.
export const AUTH_ENABLED = users.size > 0;
