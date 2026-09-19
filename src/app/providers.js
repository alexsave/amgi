'use client';

import { useReportWebVitals } from 'next/web-vitals';
import { sendToVercelAnalytics } from '../vitals';

// No account, no auth provider: amgi is a local tool now, and the only
// thing every page needs wired up globally is anonymous web-vitals
// reporting. Anki-specific state (DeckProvider) is scoped to the app shell
// (src/components/AppShell.js), not the whole document.
export default function Providers({ children }) {
  useReportWebVitals(sendToVercelAnalytics);

  return children;
}
