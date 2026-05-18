'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getActiveProductLine } from '@/lib/api';

/**
 * Hard scope gate. Use at the top of any page that requires a product line:
 *
 *   const ready = useRequireProductLine();
 *   if (!ready) return null;
 *
 * If no product line cookie is set, the user is redirected to /select.
 * Returns true once the cookie has been verified client-side.
 * Returns false during the initial mount or while redirect is in flight.
 *
 * The hook reads the cookie only on the client; SSR always returns false
 * which is correct — render nothing until we know what the scope is.
 */
export function useRequireProductLine(): boolean {
  const router = useRouter();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const slug = getActiveProductLine();
    if (!slug) {
      router.replace('/select');
    } else {
      setReady(true);
    }
  }, [router]);

  return ready;
}
