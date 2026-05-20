'use client';

/**
 * TanStack Query provider — keyed once per browser tab.
 *
 * Defaults: 30s stale time so a focus-flip doesn't burn round-trips;
 * 5min cache time so a page-hop doesn't re-fetch what we just had.
 * Retries are off — our API errors are typed and shouldn't be
 * silently retried; let the consumer decide.
 */
import { QueryClient, QueryClientProvider as RQProvider } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';

export function QueryClientProvider({ children }: { readonly children: ReactNode }): ReactNode {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            gcTime: 5 * 60_000,
            retry: false,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );
  return <RQProvider client={client}>{children}</RQProvider>;
}
