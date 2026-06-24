# The Collection Room — Project Overview

Social collectibles app for trading card enthusiasts. Users catalog items, follow collectors, post to a feed, like/comment, and DM each other.

---

## Architecture

**Stack**
- Expo SDK 54 / React Native 0.81.5 / React 19 / TypeScript
- Expo Router v6 — file-based routing, stack + tab navigation
- Supabase — Postgres + Auth + Storage
- react-native-reanimated for animations
- expo-image-picker + expo-file-system for uploads
- New Architecture enabled; React Compiler experiments enabled

**Folder layout**
```
tcr-real-sdk54/
├── app/               # Expo Router screens (routes = file paths)
│   ├── _layout.tsx    # Root: AuthProvider + Stack, handles auth redirects
│   ├── (auth)/        # Unauthenticated screens
│   ├── (tabs)/        # Bottom tab group
│   ├── folder/        # Dynamic: [id].tsx
│   ├── item/          # Dynamic: [id].tsx, new.tsx
│   ├── post/          # Dynamic: [id].tsx
│   ├── user/          # Dynamic: [username].tsx
│   └── conversation/  # Dynamic: [id].tsx
├── lib/
│   ├── supabase.ts    # Supabase client (AsyncStorage session)
│   ├── auth.tsx       # AuthContext provider + useAuth hook
│   └── storage.ts     # Upload helpers for item-images / avatars buckets
├── hooks/
│   ├── use-collection.ts   # useFolders, useItems
│   └── use-profile.ts      # useProfile
├── components/        # Shared UI components
├── constants/
│   └── theme.ts       # Color tokens (light + dark)
├── types/
│   └── index.ts       # Folder, CollectionItem, Profile, Post types
└── supabase/
    └── schema.sql     # Full Postgres schema + RLS + storage policies
```

**Auth flow**
Root `_layout.tsx` wraps everything in `<AuthProvider>`. On mount it calls `supabase.auth.getSession()` and subscribes to `onAuthStateChange`. A `useEffect` on `[session, loading, segments]` redirects:
- unauthenticated + not in `(auth)` → `/(auth)/login`
- authenticated + in `(auth)` → `/(tabs)`

---

## Routing Structure

```
(auth)/
  login.tsx              Email/password login
  sign-up.tsx            Registration

(tabs)/
  index.tsx              Home feed (all posts)
  collection.tsx         My collection (folders grid)
  messages.tsx           DM inbox (conversation list)
  notifications.tsx      Notifications
  profile.tsx            Current user's profile
  settings.tsx           Settings (href: null — hidden from tab bar)

folder/[id].tsx          Folder detail — items grid
item/new.tsx             Add new item to a folder
item/[id].tsx            Item detail
post/[id].tsx            Post detail + comments
user/[username].tsx      Another user's public profile
conversation/[id].tsx    DM thread
modal.tsx                Modal presentation screen
```

---

## Database Schema

> Full SQL in `supabase/schema.sql`. All tables have RLS enabled.

### Tables

**`profiles`** — one row per auth user (created by trigger on signup)
| column | type | notes |
|---|---|---|
| id | uuid PK | FK → auth.users |
| username | text UNIQUE | |
| display_name | text | |
| bio | text | |
| avatar_url | text | |
| created_at | timestamptz | |

**`follows`** — social graph
| column | type | notes |
|---|---|---|
| follower_id | uuid | FK → profiles |
| following_id | uuid | FK → profiles |
| created_at | timestamptz | |
— Composite PK (follower_id, following_id). CHECK prevents self-follow.

**`folders`** — collection organizational units
| column | type | notes |
|---|---|---|
| id | uuid PK | |
| user_id | uuid | FK → profiles |
| name | text | |
| cover_image_url | text | |
| is_public | boolean | DEFAULT true |
| created_at | timestamptz | |

**`collection_items`** — individual cards / collectibles
| column | type | notes |
|---|---|---|
| id | uuid PK | |
| folder_id | uuid | FK → folders |
| user_id | uuid | FK → profiles |
| title | text | |
| year | smallint | |
| brand | text | |
| player | text | |
| team | text | |
| grade | text | |
| grading_company | text | |
| serial_number | text | |
| estimated_value | numeric(10,2) | |
| image_url | text | |
| description | text | |
| created_at | timestamptz | |

**`posts`** — feed posts
| column | type | notes |
|---|---|---|
| id | uuid PK | |
| user_id | uuid | FK → profiles |
| item_id | uuid nullable | FK → collection_items (SET NULL on delete) |
| image_url | text | required |
| caption | text | |
| created_at | timestamptz | |

**`likes`** — post likes (fire reaction)
| column | type | notes |
|---|---|---|
| user_id | uuid | FK → profiles |
| post_id | uuid | FK → posts |
| created_at | timestamptz | |
— Composite PK (user_id, post_id).

**`comments`** — post comments (referenced in code, add to schema if not present)

**`conversation_participants`** — DM membership (referenced in code, add to schema if not present)

### RLS policy pattern
All tables follow the same pattern:
- `SELECT` — public (`USING (true)`)
- `INSERT` — own rows only (`WITH CHECK (auth.uid() = user_id)`)
- `UPDATE` / `DELETE` — own rows only (`USING (auth.uid() = user_id)`)

### Storage buckets
Both buckets are public (unauthenticated read). Write access is user-scoped: upload path must be `{userId}/{filename}`.

| bucket | purpose |
|---|---|
| `item-images` | Collection item photos |
| `avatars` | Profile pictures |

### Trigger
`handle_new_user()` fires `AFTER INSERT ON auth.users` and creates a `profiles` row, falling back to the email prefix if no username/display_name metadata was provided.

---

## Major Features

| Feature | Status | Key files |
|---|---|---|
| Email auth (signup/login) | Done | `(auth)/login.tsx`, `(auth)/sign-up.tsx`, `lib/auth.tsx` |
| Profile editing + avatar upload | Done | `(tabs)/profile.tsx`, `lib/storage.ts` |
| View other user profiles | Done | `user/[username].tsx` |
| Collection folders (CRUD) | Done | `(tabs)/collection.tsx`, `folder/[id].tsx` |
| Collection items (CRUD + image) | Done | `item/new.tsx`, `item/[id].tsx` |
| Social feed | Done | `(tabs)/index.tsx` |
| Post creation | Done | tied to item, requires image |
| Post detail + comments | Done | `post/[id].tsx` |
| Likes (fire reaction) | Done | inline on feed + post detail |
| Follow / unfollow | Done | `user/[username].tsx`, profile screen |
| Direct messaging | Done | `(tabs)/messages.tsx`, `conversation/[id].tsx` |
| Notifications | Done | `(tabs)/notifications.tsx` |

---

## Coding Conventions

**Language & types**
- TypeScript throughout. Types live in `types/index.ts` — one file, add to it.
- No `any`. Nullable fields are `T | null`, not optional (`?`).

**Component style**
- Functional components only, default-exported from their file.
- Props typed inline or as a local `type Props = { ... }` above the component.
- `StyleSheet.create` for styles at the bottom of each file.

**Data fetching**
- Supabase queries go in custom hooks (`hooks/`) or directly in the screen component. No service layer.
- Hook pattern: `useState` + `useCallback` load function + `useEffect` to call it. Return `{ data, loading, refresh }`.
- Errors are silently ignored (no `error` state) unless the screen needs to display them.

**Auth**
- Always get the current user via `useAuth()` from `lib/auth.tsx`. Never call `supabase.auth.getUser()` directly in screens.
- `session.user.id` is the user's UUID throughout — matches `user_id` / `id` on all tables.

**Navigation**
- Use `useRouter()` from `expo-router` for programmatic navigation.
- Use `<Link href="...">` for declarative links.
- Dynamic route params come from `useLocalSearchParams()`.

**Imports**
- Use the `@/` alias for everything inside `tcr-real-sdk54/` (maps to root of that folder).
- Import order: React → React Native → Expo → third-party → local (`@/`).

**Naming**
- Files: `kebab-case.tsx`
- Components / types: `PascalCase`
- Hooks: `useCamelCase`
- Variables / functions: `camelCase`
- Database columns: `snake_case` (match Supabase schema exactly in queries)

**No comments by default.** Only add a comment when the WHY is non-obvious.

---

*Keep this file updated when new tables, routes, or major features are added.*
