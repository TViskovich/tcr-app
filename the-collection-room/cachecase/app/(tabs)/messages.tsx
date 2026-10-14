import { MessagesInbox } from '@/components/messages/messages-inbox';

// Standalone inbox route — still the target of the own-profile "open inbox"
// link and the conversation header's back fallback. The same inbox is also
// embedded in Home's Messages tab (app/(tabs)/index.tsx).
export default function MessagesScreen() {
  return <MessagesInbox />;
}
