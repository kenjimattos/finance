import { PluggyClient } from 'pluggy-sdk';
import { config } from '../config.js';

export const pluggy = new PluggyClient({
  clientId: config.PLUGGY_CLIENT_ID,
  clientSecret: config.PLUGGY_CLIENT_SECRET,
});
