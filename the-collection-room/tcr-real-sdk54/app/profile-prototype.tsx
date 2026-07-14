import { Stack } from 'expo-router';
import {
    SafeAreaView,
    ScrollView,
    StyleSheet,
    Text,
    View,
} from 'react-native';

export default function ProfilePrototypeScreen() {
  return (
    <>
      <Stack.Screen
        options={{
          headerShown: false,
        }}
      />

      <SafeAreaView style={styles.safeArea}>
        <ScrollView
          style={styles.scrollView}
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.testCard}>
            <Text style={styles.eyebrow}>CACHECASE DEVELOPMENT</Text>

            <Text style={styles.title}>Figma Profile Prototype</Text>

            <Text style={styles.description}>
              This is a separate testing area. Changes made here will not alter
              the current profile screen.
            </Text>
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Hero area</Text>
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Profile information</Text>
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Collector dashboard</Text>
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Collection grid</Text>
          </View>
        </ScrollView>
      </SafeAreaView>
    </>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#08080d',
  },

  scrollView: {
    flex: 1,
  },

  content: {
    paddingHorizontal: 16,
    paddingTop: 24,
    paddingBottom: 80,
    gap: 16,
  },

  testCard: {
    padding: 24,
    borderWidth: 1,
    borderColor: '#292933',
    borderRadius: 24,
    backgroundColor: '#101017',
  },

  eyebrow: {
    marginBottom: 10,
    color: '#8e8e9b',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.8,
  },

  title: {
    color: '#ffffff',
    fontSize: 28,
    fontWeight: '800',
  },

  description: {
    marginTop: 12,
    color: '#9999a6',
    fontSize: 15,
    lineHeight: 22,
  },

  section: {
    minHeight: 180,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#24242d',
    borderRadius: 20,
    backgroundColor: '#0d0d13',
  },

  sectionTitle: {
    color: '#686875',
    fontSize: 15,
    fontWeight: '600',
  },
});