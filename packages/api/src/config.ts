import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  PLUGGY_CLIENT_ID: z.string().min(1, 'PLUGGY_CLIENT_ID is required'),
  PLUGGY_CLIENT_SECRET: z.string().min(1, 'PLUGGY_CLIENT_SECRET is required'),
  PORT: z.coerce.number().default(3333),
  CORS_ORIGIN: z.string().optional(),
  DATABASE_PATH: z.string().min(1, 'DATABASE_PATH is required'),
});

export const config = schema.parse(process.env);
