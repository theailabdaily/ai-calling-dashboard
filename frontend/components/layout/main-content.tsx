'use client';
import { usePathname } from 'next/navigation';

// Tiny wrapper: adds the 56px top padding on mobile only when the mobile
// top-bar is actually rendered. On /lookup routes the mobile nav returns
// null, so we don't want a mystery gap above the page.
export default function MainContent({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isLookup = pathname?.startsWith('/lookup');
  return (
    <main className={`flex-1 min-w-0 ${isLookup ? '' : 'pt-14 lg:pt-0'}`}>
      {children}
    </main>
  );
}
