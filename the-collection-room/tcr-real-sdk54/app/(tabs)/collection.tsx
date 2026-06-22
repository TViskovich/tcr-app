import { StyleSheet, Text, View } from 'react-native';

export default function CollectionScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.heading}>Collection</Text>
      <Text style={styles.body}>Your folders will appear here.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  heading: {
    fontSize: 24,
    fontWeight: '600',
    marginBottom: 8,
    color: '#11181C',
  },
  body: {
    fontSize: 15,
    color: '#687076',
    textAlign: 'center',
  },
});
