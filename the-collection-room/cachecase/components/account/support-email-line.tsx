import { Alert, Linking, Text, type StyleProp, type TextStyle } from 'react-native';

import { SUPPORT_CONTACT, supportMailto } from '@/lib/support-contact';

// "<prefix> info@… ." with the address as a link that opens an email draft
// to support. Renders nothing when no support email is configured.
export function SupportEmailLine({ prefix, subject, style }: { prefix: string; subject: string; style?: StyleProp<TextStyle> }) {
  const address = SUPPORT_CONTACT.email;
  const url = supportMailto(subject);
  if (!address || !url) return null;
  async function open() {
    try {
      await Linking.openURL(url!);
    } catch {
      Alert.alert('No mail app available', `You can email ${address} from any mail app.`);
    }
  }
  return (
    <Text style={style}>
      {prefix}{' '}
      <Text
        onPress={open}
        accessibilityRole="link"
        accessibilityLabel={`Email support at ${address}`}
        style={{ textDecorationLine: 'underline' }}>
        {address}
      </Text>
      .
    </Text>
  );
}
