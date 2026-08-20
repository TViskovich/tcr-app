import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';

// Exported (not just module-local) so the one call site that can't use
// supabase.functions.invoke() — hooks/use-signed-item-images.ts, which needs
// to control the Authorization header itself rather than let the SDK's
// fetchWithAuth() inject the project key as a fallback bearer — can issue a
// request against this same project without duplicating or hardcoding it.
export const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL!;
export const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!;

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});
