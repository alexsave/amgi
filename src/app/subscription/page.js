'use client';

import { Suspense } from 'react';
import ProtectedRoute from '../../components/Auth/ProtectedRoute';
import SubscriptionComponent from '../../components/Subscription/SubscriptionComponent';

export default function SubscriptionPage() {
  return (
    <ProtectedRoute>
      <Suspense fallback={null}>
        <SubscriptionComponent />
      </Suspense>
    </ProtectedRoute>
  );
}
