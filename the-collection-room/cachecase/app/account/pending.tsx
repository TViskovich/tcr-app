import { Stack } from 'expo-router';

import { PendingDeletionScreen } from '@/components/account/pending-deletion-screen';

// The only screen a collector whose account is pending deletion (or being
// deleted) can reach — app/_layout.tsx redirects here and back out again
// when the account is active.
export default function PendingDeletionRoute() {
  return (
    <>
      <Stack.Screen options={{ headerShown: false, gestureEnabled: false }} />
      <PendingDeletionScreen />
    </>
  );
}
