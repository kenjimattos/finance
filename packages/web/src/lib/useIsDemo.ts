import { useQuery } from '@tanstack/react-query';
import { api } from './api';

/**
 * Whether the logged-in user is a sandboxed demo account. Demo accounts can
 * use everything that only touches their own data, but the API blocks
 * Pluggy connect/sync and fatura import — this hook lets screens hide those
 * affordances instead of surfacing 403 toasts. Shares the App-level ['auth']
 * query cache, so it never fires an extra request.
 */
export function useIsDemo(): boolean {
  const q = useQuery({ queryKey: ['auth'], queryFn: api.getAuthMe, retry: false });
  return q.data?.demo ?? false;
}
