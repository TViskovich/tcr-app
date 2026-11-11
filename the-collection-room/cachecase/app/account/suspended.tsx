import { Stack } from 'expo-router';

import { SuspendedAccountScreen } from '@/components/account/suspended-account-screen';

// The only screen (with Delete Account) a collector whose account is
// suspended can reach — app/_layout.tsx redirects here and back out again
// when the suspension is lifted or expires (Phase 2B M3).
export default function SuspendedAccountRoute() {
  return (
    <>
      <Stack.Screen options={{ headerShown: false, gestureEnabled: false }} />
      <SuspendedAccountScreen />
    </>
  );
}
