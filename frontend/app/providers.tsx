'use client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(() => new QueryClient({
    defaultOptions: {
      queries: {
        // Cache analytics for 5min — they don't change second-to-second.
        // User can hit refresh / change filters to force a refetch.
        staleTime: 5 * 60_000,
        gcTime: 30 * 60_000,
        // Don't auto-refetch in the background. Avoids hitting Render free
        // tier on every tab switch and triggering cold starts.
        refetchInterval: false,
        refetchOnWindowFocus: false,
        refetchOnMount: false,
        retry: 1,
      },
    },
  }));
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
