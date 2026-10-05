import { Stack } from 'expo-router';

import { PendingInviteProvider } from '@/lib/pending-invite';

export default function AuthLayout() {
  return (
    <PendingInviteProvider>
      <Stack screenOptions={{ headerShown: false }} />
    </PendingInviteProvider>
  );
}
