'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

// No welcome/login screen any more - amgi opens straight to the deck list.
export default function HomePage() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/decks');
  }, [router]);
  return null;
}
