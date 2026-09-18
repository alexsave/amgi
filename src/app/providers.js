'use client';

import { useReportWebVitals } from 'next/web-vitals';
import { AuthProvider } from '../contexts/AuthContext';
import { sendToVercelAnalytics } from '../vitals';

export default function Providers({ children }) {
  useReportWebVitals(sendToVercelAnalytics);

  return <AuthProvider>{children}</AuthProvider>;
}
