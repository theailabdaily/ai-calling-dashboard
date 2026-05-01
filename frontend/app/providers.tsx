'use client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(() => new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 60_000,
        refetchInterval: 60_000,    // near-real-time refresh every 60s
        refetchOnWindowFocus: true,
      },
    },
  }));
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
