-- ============================================================================
-- Pre-history baseline (local/fresh databases only).
--
-- The migration history starts at 20260711193000, which ALTERs public.posts,
-- but posts and 21 other tables were created in the Supabase dashboard (or
-- from supabase/schema.sql) before migrations were tracked, so a fresh
-- database (`supabase start` / `supabase db reset`) failed on the very first
-- migration with: relation "public.posts" does not exist.
--
-- This file recreates ONLY the objects that no later migration creates, in
-- the shape they had before the migrations that extend them. It was derived
-- from a read-only `supabase db dump --linked --schema public` of production:
--   * tables no migration CREATEs, minus every column a later migration ADDs;
--   * their keys, foreign keys (to other baseline tables only), indexes,
--     RLS enablement, policies and grants, minus any whose name a later
--     migration creates/drops (those migrations recreate them in order);
--   * the functions/triggers that predate the history:
--     get_or_create_conversation, is_conversation_participant, generate_cc_id,
--     set_registered_card_cc_id (+ trg_set_registered_card_cc_id),
--     handle_showcase_insert (+ trg_showcase_before_insert), and the original
--     handle_new_user (supabase/schema.sql) + on_auth_user_created on
--     auth.users;
--   * the avatars (public) and item-images (private) storage buckets and
--     their five storage.objects policies, which also predate the history.
-- No RLS, grant or ownership semantics differ from production: the final
-- state after all migrations was compared against the production dump.
--
-- PRODUCTION ALREADY HAS ALL OF THIS. Before the next `supabase db push`,
-- mark this version as applied on the hosted project (no SQL is executed):
--   supabase migration repair --status applied 20260701000000
-- ============================================================================

-- ── Tables ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "public"."registered_cards" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "cc_id" "text" NOT NULL,
    "card_type_id" "uuid",
    "current_owner_id" "uuid",
    "serial_number" "text",
    "grade_company" "text",
    "grade" "text",
    "cert_number" "text",
    "trust_score" integer DEFAULT 0,
    "status" "text" DEFAULT 'owner_registered'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

CREATE TABLE IF NOT EXISTS "public"."collection_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "folder_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "title" "text",
    "year" smallint,
    "brand" "text",
    "player" "text",
    "team" "text",
    "grade" "text",
    "grading_company" "text",
    "serial_number" "text",
    "estimated_value" numeric(10,2),
    "image_url" "text",
    "description" "text",
    "created_at" timestamp with time zone DEFAULT "now"()
);

CREATE TABLE IF NOT EXISTS "public"."businesses" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "type" "text",
    "website" "text",
    "logo_url" "text",
    "claimed_by_user_id" "uuid",
    "verification_status" "text" DEFAULT 'unclaimed'::"text",
    "created_at" timestamp with time zone DEFAULT "now"()
);

CREATE TABLE IF NOT EXISTS "public"."card_images" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "registered_card_id" "uuid",
    "image_url" "text" NOT NULL,
    "image_type" "text",
    "uploaded_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"()
);

CREATE TABLE IF NOT EXISTS "public"."card_types" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "sport" "text",
    "year" integer,
    "brand" "text",
    "set_name" "text",
    "player_name" "text",
    "team" "text",
    "card_number" "text",
    "parallel" "text",
    "variation" "text",
    "print_run" integer,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

CREATE TABLE IF NOT EXISTS "public"."comments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid",
    "post_id" "uuid",
    "body" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "comments_body_check" CHECK (("char_length"("body") > 0))
);

CREATE TABLE IF NOT EXISTS "public"."conversation_participants" (
    "conversation_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "last_read_at" timestamp with time zone
);

CREATE TABLE IF NOT EXISTS "public"."conversations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_message_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

CREATE TABLE IF NOT EXISTS "public"."folders" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "cover_image_url" "text",
    "is_public" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "cover_source" "text" DEFAULT 'upload'::"text" NOT NULL
);

CREATE TABLE IF NOT EXISTS "public"."follows" (
    "follower_id" "uuid" NOT NULL,
    "following_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "follows_check" CHECK (("follower_id" <> "following_id"))
);

CREATE TABLE IF NOT EXISTS "public"."likes" (
    "user_id" "uuid" NOT NULL,
    "post_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"()
);

CREATE TABLE IF NOT EXISTS "public"."messages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "conversation_id" "uuid",
    "sender_id" "uuid",
    "body" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

CREATE TABLE IF NOT EXISTS "public"."notifications" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "actor_id" "uuid" NOT NULL,
    "type" "text" NOT NULL,
    "post_id" "uuid",
    "comment_id" "uuid",
    "conversation_id" "uuid",
    "read" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

CREATE TABLE IF NOT EXISTS "public"."ownership_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "registered_card_id" "uuid",
    "from_user_id" "uuid",
    "to_user_id" "uuid",
    "transfer_type" "text" DEFAULT 'registered'::"text" NOT NULL,
    "price" numeric(12,2),
    "currency" "text" DEFAULT 'USD'::"text",
    "event_date" timestamp with time zone DEFAULT "now"(),
    "verification_status" "text" DEFAULT 'unverified'::"text",
    "created_at" timestamp with time zone DEFAULT "now"()
);

CREATE TABLE IF NOT EXISTS "public"."posts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "item_id" "uuid",
    "image_url" "text",
    "caption" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "content" "text",
    "post_type" "text" DEFAULT 'item'::"text" NOT NULL,
    CONSTRAINT "posts_content_length" CHECK ((("content" IS NULL) OR ("length"("content") <= 280))),
    CONSTRAINT "posts_item_requires_image" CHECK ((("post_type" <> 'item'::"text") OR ("image_url" IS NOT NULL)))
);

CREATE TABLE IF NOT EXISTS "public"."profile_showcase_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "item_id" "uuid" NOT NULL,
    "display_order" smallint DEFAULT 0 NOT NULL,
    "note" "text",
    "badge_type" "text",
    "added_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "profile_showcase_items_display_order_check" CHECK (("display_order" >= 0)),
    CONSTRAINT "profile_showcase_items_note_check" CHECK (("char_length"("note") <= 280))
);

CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "username" "text" NOT NULL,
    "display_name" "text",
    "bio" "text",
    "avatar_url" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "hero_image_url" "text",
    "showcase_badge_url" "text",
    "hero_display_name" "text",
    "hero_theme" "text" DEFAULT 'classic'::"text" NOT NULL
);

CREATE TABLE IF NOT EXISTS "public"."sales_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "registered_card_id" "uuid",
    "card_type_id" "uuid",
    "sale_price" numeric(12,2) NOT NULL,
    "currency" "text" DEFAULT 'USD'::"text",
    "sale_date" "date",
    "source" "text",
    "source_business_id" "uuid",
    "verification_level" "text" DEFAULT 'community_reported'::"text",
    "external_url" "text",
    "created_at" timestamp with time zone DEFAULT "now"()
);

CREATE TABLE IF NOT EXISTS "public"."saved_cards" (
    "user_id" "uuid" NOT NULL,
    "item_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

CREATE TABLE IF NOT EXISTS "public"."saved_folders" (
    "user_id" "uuid" NOT NULL,
    "folder_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

CREATE TABLE IF NOT EXISTS "public"."saved_grails" (
    "user_id" "uuid" NOT NULL,
    "owner_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

CREATE TABLE IF NOT EXISTS "public"."verification_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "registered_card_id" "uuid",
    "verified_by_type" "text",
    "verified_by_id" "uuid",
    "verification_type" "text",
    "confidence_level" integer,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"()
);

-- ── Primary keys / unique constraints ─────────────────────────────────────

ALTER TABLE ONLY "public"."businesses"
    ADD CONSTRAINT "businesses_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."card_images"
    ADD CONSTRAINT "card_images_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."card_types"
    ADD CONSTRAINT "card_types_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."collection_items"
    ADD CONSTRAINT "collection_items_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."comments"
    ADD CONSTRAINT "comments_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."conversation_participants"
    ADD CONSTRAINT "conversation_participants_pkey" PRIMARY KEY ("conversation_id", "user_id");

ALTER TABLE ONLY "public"."conversations"
    ADD CONSTRAINT "conversations_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."folders"
    ADD CONSTRAINT "folders_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."follows"
    ADD CONSTRAINT "follows_pkey" PRIMARY KEY ("follower_id", "following_id");

ALTER TABLE ONLY "public"."likes"
    ADD CONSTRAINT "likes_pkey" PRIMARY KEY ("user_id", "post_id");

ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."ownership_events"
    ADD CONSTRAINT "ownership_events_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."posts"
    ADD CONSTRAINT "posts_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."profile_showcase_items"
    ADD CONSTRAINT "profile_showcase_items_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_username_key" UNIQUE ("username");

ALTER TABLE ONLY "public"."registered_cards"
    ADD CONSTRAINT "registered_cards_cc_id_key" UNIQUE ("cc_id");

ALTER TABLE ONLY "public"."registered_cards"
    ADD CONSTRAINT "registered_cards_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."sales_events"
    ADD CONSTRAINT "sales_events_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."saved_cards"
    ADD CONSTRAINT "saved_cards_pkey" PRIMARY KEY ("user_id", "item_id");

ALTER TABLE ONLY "public"."saved_folders"
    ADD CONSTRAINT "saved_folders_pkey" PRIMARY KEY ("user_id", "folder_id");

ALTER TABLE ONLY "public"."saved_grails"
    ADD CONSTRAINT "saved_grails_pkey" PRIMARY KEY ("user_id", "owner_id");

ALTER TABLE ONLY "public"."profile_showcase_items"
    ADD CONSTRAINT "uq_showcase_user_item" UNIQUE ("user_id", "item_id");

ALTER TABLE ONLY "public"."verification_events"
    ADD CONSTRAINT "verification_events_pkey" PRIMARY KEY ("id");

-- ── Foreign keys ──────────────────────────────────────────────────────────

ALTER TABLE ONLY "public"."businesses"
    ADD CONSTRAINT "businesses_claimed_by_user_id_fkey" FOREIGN KEY ("claimed_by_user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;

ALTER TABLE ONLY "public"."card_images"
    ADD CONSTRAINT "card_images_registered_card_id_fkey" FOREIGN KEY ("registered_card_id") REFERENCES "public"."registered_cards"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."card_images"
    ADD CONSTRAINT "card_images_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;

ALTER TABLE ONLY "public"."collection_items"
    ADD CONSTRAINT "collection_items_folder_id_fkey" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."collection_items"
    ADD CONSTRAINT "collection_items_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."comments"
    ADD CONSTRAINT "comments_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."comments"
    ADD CONSTRAINT "comments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."conversation_participants"
    ADD CONSTRAINT "conversation_participants_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."conversation_participants"
    ADD CONSTRAINT "conversation_participants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."folders"
    ADD CONSTRAINT "folders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."follows"
    ADD CONSTRAINT "follows_follower_id_fkey" FOREIGN KEY ("follower_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."follows"
    ADD CONSTRAINT "follows_following_id_fkey" FOREIGN KEY ("following_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."likes"
    ADD CONSTRAINT "likes_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."likes"
    ADD CONSTRAINT "likes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_comment_id_fkey" FOREIGN KEY ("comment_id") REFERENCES "public"."comments"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."ownership_events"
    ADD CONSTRAINT "ownership_events_from_user_id_fkey" FOREIGN KEY ("from_user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;

ALTER TABLE ONLY "public"."ownership_events"
    ADD CONSTRAINT "ownership_events_registered_card_id_fkey" FOREIGN KEY ("registered_card_id") REFERENCES "public"."registered_cards"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."ownership_events"
    ADD CONSTRAINT "ownership_events_to_user_id_fkey" FOREIGN KEY ("to_user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;

ALTER TABLE ONLY "public"."posts"
    ADD CONSTRAINT "posts_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "public"."collection_items"("id") ON DELETE SET NULL;

ALTER TABLE ONLY "public"."posts"
    ADD CONSTRAINT "posts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."profile_showcase_items"
    ADD CONSTRAINT "profile_showcase_items_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "public"."collection_items"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."profile_showcase_items"
    ADD CONSTRAINT "profile_showcase_items_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."registered_cards"
    ADD CONSTRAINT "registered_cards_card_type_id_fkey" FOREIGN KEY ("card_type_id") REFERENCES "public"."card_types"("id") ON DELETE SET NULL;

ALTER TABLE ONLY "public"."registered_cards"
    ADD CONSTRAINT "registered_cards_current_owner_id_fkey" FOREIGN KEY ("current_owner_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;

ALTER TABLE ONLY "public"."sales_events"
    ADD CONSTRAINT "sales_events_card_type_id_fkey" FOREIGN KEY ("card_type_id") REFERENCES "public"."card_types"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."sales_events"
    ADD CONSTRAINT "sales_events_registered_card_id_fkey" FOREIGN KEY ("registered_card_id") REFERENCES "public"."registered_cards"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."saved_cards"
    ADD CONSTRAINT "saved_cards_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "public"."collection_items"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."saved_cards"
    ADD CONSTRAINT "saved_cards_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."saved_folders"
    ADD CONSTRAINT "saved_folders_folder_id_fkey" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."saved_folders"
    ADD CONSTRAINT "saved_folders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."saved_grails"
    ADD CONSTRAINT "saved_grails_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."saved_grails"
    ADD CONSTRAINT "saved_grails_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."verification_events"
    ADD CONSTRAINT "verification_events_registered_card_id_fkey" FOREIGN KEY ("registered_card_id") REFERENCES "public"."registered_cards"("id") ON DELETE CASCADE;

-- ── Indexes ───────────────────────────────────────────────────────────────

CREATE INDEX "idx_card_images_registered_card" ON "public"."card_images" USING "btree" ("registered_card_id");

CREATE INDEX "idx_ownership_events_card" ON "public"."ownership_events" USING "btree" ("registered_card_id");

CREATE INDEX "idx_registered_cards_card_type" ON "public"."registered_cards" USING "btree" ("card_type_id");

CREATE INDEX "idx_registered_cards_cc_id" ON "public"."registered_cards" USING "btree" ("cc_id");

CREATE INDEX "idx_registered_cards_owner" ON "public"."registered_cards" USING "btree" ("current_owner_id");

CREATE INDEX "idx_sales_events_card_type" ON "public"."sales_events" USING "btree" ("card_type_id");

CREATE INDEX "idx_sales_events_registered_card" ON "public"."sales_events" USING "btree" ("registered_card_id");

CREATE INDEX "idx_showcase_item_id" ON "public"."profile_showcase_items" USING "btree" ("item_id");

CREATE INDEX "idx_showcase_user_order" ON "public"."profile_showcase_items" USING "btree" ("user_id", "display_order");

CREATE UNIQUE INDEX "notifications_follow_unique" ON "public"."notifications" USING "btree" ("user_id", "actor_id") WHERE ("type" = 'follow'::"text");

CREATE UNIQUE INDEX "notifications_like_unique" ON "public"."notifications" USING "btree" ("user_id", "actor_id", "post_id") WHERE ("type" = 'like'::"text");

-- ── Functions and triggers not defined by any migration ───────────────────

CREATE OR REPLACE FUNCTION "public"."generate_cc_id"() RETURNS "text"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
declare
  chars text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  result text := 'CC-';
  i int;
begin
  for i in 1..4 loop
    result := result || substr(chars, floor(random() * length(chars) + 1)::int, 1);
  end loop;

  result := result || '-';

  for i in 1..4 loop
    result := result || substr(chars, floor(random() * length(chars) + 1)::int, 1);
  end loop;

  return result;
end;
$$;

CREATE OR REPLACE FUNCTION "public"."get_or_create_conversation"("other_user_id" "uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  conv_id uuid;
  caller_id uuid;
  lock_key bigint;
BEGIN
  caller_id := auth.uid();

  IF caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF other_user_id IS NULL THEN
    RAISE EXCEPTION 'Recipient is required';
  END IF;

  IF caller_id = other_user_id THEN
    RAISE EXCEPTION 'Cannot create a conversation with yourself';
  END IF;

  -- Deterministic, order-independent lock key for this pair: canonicalize
  -- via (LEAST, GREATEST) so A→B and B→A calls always compute the
  -- identical key, then reduce the pair's 256 bits into one 64-bit
  -- advisory-lock key via hashtextextended — a built-in deterministic
  -- hash that produces the same output for the same input across
  -- concurrent calls on this database. Unrelated pairs can theoretically
  -- map to the same 64-bit key (256 bits of input onto a 64-bit key
  -- space). That only matters if two such unrelated pairs happen to
  -- attempt conversation creation at the same time — the consequence is
  -- one pair briefly, unnecessarily waiting on the other's lock, nothing
  -- more. It can never return the wrong conversation or corrupt data:
  -- the lookup below runs after the lock is acquired and is still keyed
  -- on the real caller_id/other_user_id values, not on the lock key
  -- itself, so a collision can only cost time, never correctness.
  lock_key := hashtextextended(
    LEAST(caller_id, other_user_id)::text || ':' || GREATEST(caller_id, other_user_id)::text,
    0
  );

  -- Transaction-scoped: released automatically on COMMIT or ROLLBACK, no
  -- matching unlock call exists or is needed. Only this exact pair's key
  -- is locked, so unrelated pairs' creation calls are normally unaffected
  -- by this — this is not a global serializing lock.
  PERFORM pg_advisory_xact_lock(lock_key);

  -- The authoritative lookup — performed only now, after the lock is
  -- held, never before. Any concurrent call for this same pair that
  -- arrived first is either still running (this call is blocked above,
  -- waiting on the lock) or has already committed (this lookup now sees
  -- its result) — either way, this SELECT can be trusted from this line on.
  SELECT cp1.conversation_id INTO conv_id
  FROM public.conversation_participants cp1
  JOIN public.conversation_participants cp2
    ON cp1.conversation_id = cp2.conversation_id
  WHERE cp1.user_id = caller_id
    AND cp2.user_id = other_user_id
  LIMIT 1;

  IF conv_id IS NOT NULL THEN
    RETURN conv_id;
  END IF;

  INSERT INTO public.conversations DEFAULT VALUES RETURNING id INTO conv_id;

  INSERT INTO public.conversation_participants (conversation_id, user_id)
  VALUES (conv_id, caller_id), (conv_id, other_user_id);

  RETURN conv_id;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."handle_showcase_insert"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_count int;
  v_max int := 9;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.collection_items
    WHERE id = NEW.item_id
    AND user_id = NEW.user_id
  ) THEN
    RAISE EXCEPTION 'showcase_ownership_error';
  END IF;

  SELECT COUNT(*)
  INTO v_count
  FROM public.profile_showcase_items
  WHERE user_id = NEW.user_id;

  IF v_count >= v_max THEN
    RAISE EXCEPTION 'showcase_limit_error';
  END IF;

  IF NEW.display_order = 0 THEN
    SELECT COALESCE(MAX(display_order), 0) + 1
    INTO NEW.display_order
    FROM public.profile_showcase_items
    WHERE user_id = NEW.user_id;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."is_conversation_participant"("conv_id" "uuid", "uid" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.conversation_participants
    WHERE conversation_id = conv_id AND user_id = uid
  );
$$;

CREATE OR REPLACE FUNCTION "public"."set_registered_card_cc_id"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
begin
  if new.cc_id is null or new.cc_id = '' then
    loop
      new.cc_id := generate_cc_id();

      exit when not exists (
        select 1
        from registered_cards
        where cc_id = new.cc_id
      );
    end loop;
  end if;

  return new;
end;
$$;

REVOKE ALL ON FUNCTION "public"."generate_cc_id"() FROM PUBLIC;

GRANT ALL ON FUNCTION "public"."generate_cc_id"() TO "authenticated";

GRANT ALL ON FUNCTION "public"."generate_cc_id"() TO "service_role";

REVOKE ALL ON FUNCTION "public"."get_or_create_conversation"("other_user_id" "uuid") FROM PUBLIC;

GRANT ALL ON FUNCTION "public"."get_or_create_conversation"("other_user_id" "uuid") TO "authenticated";

GRANT ALL ON FUNCTION "public"."get_or_create_conversation"("other_user_id" "uuid") TO "service_role";

GRANT ALL ON FUNCTION "public"."handle_showcase_insert"() TO "anon";

GRANT ALL ON FUNCTION "public"."handle_showcase_insert"() TO "authenticated";

GRANT ALL ON FUNCTION "public"."handle_showcase_insert"() TO "service_role";

REVOKE ALL ON FUNCTION "public"."is_conversation_participant"("conv_id" "uuid", "uid" "uuid") FROM PUBLIC;

GRANT ALL ON FUNCTION "public"."is_conversation_participant"("conv_id" "uuid", "uid" "uuid") TO "authenticated";

GRANT ALL ON FUNCTION "public"."is_conversation_participant"("conv_id" "uuid", "uid" "uuid") TO "service_role";

REVOKE ALL ON FUNCTION "public"."set_registered_card_cc_id"() FROM PUBLIC;

GRANT ALL ON FUNCTION "public"."set_registered_card_cc_id"() TO "authenticated";

GRANT ALL ON FUNCTION "public"."set_registered_card_cc_id"() TO "service_role";

-- Original new-user trigger function (supabase/schema.sql); replaced by
-- 20261008120000_enforce_username_rules.sql.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
BEGIN
  INSERT INTO public.profiles (id, username, display_name)
  VALUES (
    NEW.id,
    COALESCE(
      NULLIF(trim(NEW.raw_user_meta_data->>'username'), ''),
      split_part(NEW.email, '@', 1)
    ),
    COALESCE(
      NULLIF(trim(NEW.raw_user_meta_data->>'display_name'), ''),
      split_part(NEW.email, '@', 1)
    )
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

CREATE OR REPLACE TRIGGER "trg_set_registered_card_cc_id" BEFORE INSERT ON "public"."registered_cards" FOR EACH ROW EXECUTE FUNCTION "public"."set_registered_card_cc_id"();

CREATE OR REPLACE TRIGGER "trg_showcase_before_insert" BEFORE INSERT ON "public"."profile_showcase_items" FOR EACH ROW EXECUTE FUNCTION "public"."handle_showcase_insert"();

-- ── Row level security ────────────────────────────────────────────────────

ALTER TABLE "public"."businesses" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."card_images" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."card_types" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."collection_items" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."comments" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."conversation_participants" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."conversations" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."folders" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."follows" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."likes" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."messages" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."notifications" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."ownership_events" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."posts" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."profile_showcase_items" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."registered_cards" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."sales_events" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."saved_cards" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."saved_folders" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."saved_grails" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."verification_events" ENABLE ROW LEVEL SECURITY;

-- ── Policies ──────────────────────────────────────────────────────────────

CREATE POLICY "Authenticated users can create businesses" ON "public"."businesses" FOR INSERT TO "authenticated" WITH CHECK (true);

CREATE POLICY "Authenticated users can create card types" ON "public"."card_types" FOR INSERT TO "authenticated" WITH CHECK (true);

CREATE POLICY "Authenticated users can create sales events" ON "public"."sales_events" FOR INSERT TO "authenticated" WITH CHECK (true);

CREATE POLICY "Authenticated users can read businesses" ON "public"."businesses" FOR SELECT TO "authenticated" USING (true);

CREATE POLICY "Authenticated users can read card types" ON "public"."card_types" FOR SELECT TO "authenticated" USING (true);

CREATE POLICY "Authenticated users can read sales events" ON "public"."sales_events" FOR SELECT TO "authenticated" USING (true);

CREATE POLICY "Claimed business owners can update businesses" ON "public"."businesses" FOR UPDATE TO "authenticated" USING (("claimed_by_user_id" = "auth"."uid"())) WITH CHECK (("claimed_by_user_id" = "auth"."uid"()));

CREATE POLICY "Users can add images to their registered cards" ON "public"."card_images" FOR INSERT TO "authenticated" WITH CHECK ((("uploaded_by" = "auth"."uid"()) AND (EXISTS ( SELECT 1
   FROM "public"."registered_cards" "rc"
  WHERE (("rc"."id" = "card_images"."registered_card_id") AND ("rc"."current_owner_id" = "auth"."uid"()))))));

CREATE POLICY "Users can create ownership events to themselves" ON "public"."ownership_events" FOR INSERT TO "authenticated" WITH CHECK (("to_user_id" = "auth"."uid"()));

CREATE POLICY "Users can create verification events for their cards" ON "public"."verification_events" FOR INSERT TO "authenticated" WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."registered_cards" "rc"
  WHERE (("rc"."id" = "verification_events"."registered_card_id") AND ("rc"."current_owner_id" = "auth"."uid"())))));

CREATE POLICY "Users can read images for their registered cards" ON "public"."card_images" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."registered_cards" "rc"
  WHERE (("rc"."id" = "card_images"."registered_card_id") AND ("rc"."current_owner_id" = "auth"."uid"())))));

CREATE POLICY "Users can read ownership events involving them" ON "public"."ownership_events" FOR SELECT TO "authenticated" USING ((("from_user_id" = "auth"."uid"()) OR ("to_user_id" = "auth"."uid"())));

CREATE POLICY "Users can read verification events for their cards" ON "public"."verification_events" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."registered_cards" "rc"
  WHERE (("rc"."id" = "verification_events"."registered_card_id") AND ("rc"."current_owner_id" = "auth"."uid"())))));

CREATE POLICY "comments_delete_own" ON "public"."comments" FOR DELETE TO "authenticated" USING (("user_id" = "auth"."uid"()));

CREATE POLICY "comments_insert_own" ON "public"."comments" FOR INSERT TO "authenticated" WITH CHECK (("user_id" = "auth"."uid"()));

CREATE POLICY "comments_select_all" ON "public"."comments" FOR SELECT USING (true);

CREATE POLICY "conversations_select" ON "public"."conversations" FOR SELECT USING ("public"."is_conversation_participant"("id", "auth"."uid"()));

CREATE POLICY "conversations_update" ON "public"."conversations" FOR UPDATE TO "authenticated" USING ("public"."is_conversation_participant"("id", "auth"."uid"())) WITH CHECK ("public"."is_conversation_participant"("id", "auth"."uid"()));

CREATE POLICY "folders_delete_own" ON "public"."folders" FOR DELETE USING (("auth"."uid"() = "user_id"));

CREATE POLICY "follows_delete_own" ON "public"."follows" FOR DELETE USING (("auth"."uid"() = "follower_id"));

CREATE POLICY "follows_insert_own" ON "public"."follows" FOR INSERT WITH CHECK (("auth"."uid"() = "follower_id"));

CREATE POLICY "follows_select_public" ON "public"."follows" FOR SELECT USING (true);

CREATE POLICY "items_delete_own" ON "public"."collection_items" FOR DELETE USING (("auth"."uid"() = "user_id"));

CREATE POLICY "items_update_own" ON "public"."collection_items" FOR UPDATE USING (("auth"."uid"() = "user_id"));

CREATE POLICY "likes_delete_own" ON "public"."likes" FOR DELETE USING (("auth"."uid"() = "user_id"));

CREATE POLICY "likes_insert_own" ON "public"."likes" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));

CREATE POLICY "likes_select_public" ON "public"."likes" FOR SELECT USING (true);

CREATE POLICY "messages_insert" ON "public"."messages" FOR INSERT TO "authenticated" WITH CHECK ((("sender_id" = "auth"."uid"()) AND "public"."is_conversation_participant"("conversation_id", "auth"."uid"())));

CREATE POLICY "messages_select" ON "public"."messages" FOR SELECT USING ("public"."is_conversation_participant"("conversation_id", "auth"."uid"()));

CREATE POLICY "notifications_delete_by_actor" ON "public"."notifications" FOR DELETE TO "authenticated" USING (("actor_id" = "auth"."uid"()));

CREATE POLICY "notifications_select_own" ON "public"."notifications" FOR SELECT USING (("user_id" = "auth"."uid"()));

CREATE POLICY "notifications_update_own" ON "public"."notifications" FOR UPDATE TO "authenticated" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));

CREATE POLICY "participants_select" ON "public"."conversation_participants" FOR SELECT USING ("public"."is_conversation_participant"("conversation_id", "auth"."uid"()));

CREATE POLICY "participants_update_own" ON "public"."conversation_participants" FOR UPDATE TO "authenticated" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));

CREATE POLICY "posts_delete_own" ON "public"."posts" FOR DELETE USING (("auth"."uid"() = "user_id"));

CREATE POLICY "posts_insert_own" ON "public"."posts" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));

CREATE POLICY "posts_select_public" ON "public"."posts" FOR SELECT USING (true);

CREATE POLICY "posts_update_own" ON "public"."posts" FOR UPDATE USING (("auth"."uid"() = "user_id"));

CREATE POLICY "profiles_insert_own" ON "public"."profiles" FOR INSERT WITH CHECK (("auth"."uid"() = "id"));

CREATE POLICY "profiles_select_public" ON "public"."profiles" FOR SELECT USING (true);

CREATE POLICY "profiles_update_own" ON "public"."profiles" FOR UPDATE USING (("auth"."uid"() = "id"));

CREATE POLICY "saved_cards: owner can delete" ON "public"."saved_cards" FOR DELETE USING (("user_id" = "auth"."uid"()));

CREATE POLICY "saved_cards: owner can insert" ON "public"."saved_cards" FOR INSERT WITH CHECK (("user_id" = "auth"."uid"()));

CREATE POLICY "saved_cards: owner can select" ON "public"."saved_cards" FOR SELECT USING (("user_id" = "auth"."uid"()));

CREATE POLICY "saved_folders: owner can delete" ON "public"."saved_folders" FOR DELETE USING (("user_id" = "auth"."uid"()));

CREATE POLICY "saved_folders: owner can insert" ON "public"."saved_folders" FOR INSERT WITH CHECK (("user_id" = "auth"."uid"()));

CREATE POLICY "saved_folders: owner can select" ON "public"."saved_folders" FOR SELECT USING (("user_id" = "auth"."uid"()));

CREATE POLICY "saved_grails: owner can delete" ON "public"."saved_grails" FOR DELETE USING (("user_id" = "auth"."uid"()));

CREATE POLICY "saved_grails: owner can insert" ON "public"."saved_grails" FOR INSERT WITH CHECK (("user_id" = "auth"."uid"()));

CREATE POLICY "saved_grails: owner can select" ON "public"."saved_grails" FOR SELECT USING (("user_id" = "auth"."uid"()));

CREATE POLICY "showcase_delete_own" ON "public"."profile_showcase_items" FOR DELETE TO "authenticated" USING (("auth"."uid"() = "user_id"));

CREATE POLICY "showcase_insert_own" ON "public"."profile_showcase_items" FOR INSERT TO "authenticated" WITH CHECK ((("auth"."uid"() = "user_id") AND (EXISTS ( SELECT 1
   FROM "public"."collection_items"
  WHERE (("collection_items"."id" = "profile_showcase_items"."item_id") AND ("collection_items"."user_id" = "auth"."uid"()))))));

CREATE POLICY "showcase_select_public" ON "public"."profile_showcase_items" FOR SELECT USING (true);

CREATE POLICY "showcase_update_own" ON "public"."profile_showcase_items" FOR UPDATE TO "authenticated" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));

-- ── Grants ────────────────────────────────────────────────────────────────

GRANT ALL ON TABLE "public"."registered_cards" TO "anon";

GRANT ALL ON TABLE "public"."registered_cards" TO "authenticated";

GRANT ALL ON TABLE "public"."registered_cards" TO "service_role";

GRANT ALL ON TABLE "public"."collection_items" TO "anon";

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN ON TABLE "public"."collection_items" TO "authenticated";

GRANT ALL ON TABLE "public"."collection_items" TO "service_role";

GRANT UPDATE("folder_id") ON TABLE "public"."collection_items" TO "authenticated";

GRANT UPDATE("title") ON TABLE "public"."collection_items" TO "authenticated";

GRANT UPDATE("year") ON TABLE "public"."collection_items" TO "authenticated";

GRANT UPDATE("brand") ON TABLE "public"."collection_items" TO "authenticated";

GRANT UPDATE("player") ON TABLE "public"."collection_items" TO "authenticated";

GRANT UPDATE("team") ON TABLE "public"."collection_items" TO "authenticated";

GRANT UPDATE("grade") ON TABLE "public"."collection_items" TO "authenticated";

GRANT UPDATE("grading_company") ON TABLE "public"."collection_items" TO "authenticated";

GRANT UPDATE("serial_number") ON TABLE "public"."collection_items" TO "authenticated";

GRANT UPDATE("estimated_value") ON TABLE "public"."collection_items" TO "authenticated";

GRANT UPDATE("image_url") ON TABLE "public"."collection_items" TO "authenticated";

GRANT UPDATE("description") ON TABLE "public"."collection_items" TO "authenticated";

GRANT ALL ON TABLE "public"."businesses" TO "anon";

GRANT ALL ON TABLE "public"."businesses" TO "authenticated";

GRANT ALL ON TABLE "public"."businesses" TO "service_role";

GRANT ALL ON TABLE "public"."card_images" TO "anon";

GRANT ALL ON TABLE "public"."card_images" TO "authenticated";

GRANT ALL ON TABLE "public"."card_images" TO "service_role";

GRANT ALL ON TABLE "public"."card_types" TO "anon";

GRANT ALL ON TABLE "public"."card_types" TO "authenticated";

GRANT ALL ON TABLE "public"."card_types" TO "service_role";

GRANT ALL ON TABLE "public"."comments" TO "anon";

GRANT ALL ON TABLE "public"."comments" TO "authenticated";

GRANT ALL ON TABLE "public"."comments" TO "service_role";

GRANT ALL ON TABLE "public"."conversation_participants" TO "anon";

GRANT ALL ON TABLE "public"."conversation_participants" TO "authenticated";

GRANT ALL ON TABLE "public"."conversation_participants" TO "service_role";

GRANT ALL ON TABLE "public"."conversations" TO "anon";

GRANT ALL ON TABLE "public"."conversations" TO "authenticated";

GRANT ALL ON TABLE "public"."conversations" TO "service_role";

GRANT ALL ON TABLE "public"."folders" TO "anon";

GRANT ALL ON TABLE "public"."folders" TO "authenticated";

GRANT ALL ON TABLE "public"."folders" TO "service_role";

GRANT ALL ON TABLE "public"."follows" TO "anon";

GRANT ALL ON TABLE "public"."follows" TO "authenticated";

GRANT ALL ON TABLE "public"."follows" TO "service_role";

GRANT ALL ON TABLE "public"."likes" TO "anon";

GRANT ALL ON TABLE "public"."likes" TO "authenticated";

GRANT ALL ON TABLE "public"."likes" TO "service_role";

GRANT ALL ON TABLE "public"."messages" TO "anon";

GRANT ALL ON TABLE "public"."messages" TO "authenticated";

GRANT ALL ON TABLE "public"."messages" TO "service_role";

GRANT ALL ON TABLE "public"."notifications" TO "anon";

GRANT ALL ON TABLE "public"."notifications" TO "authenticated";

GRANT ALL ON TABLE "public"."notifications" TO "service_role";

GRANT ALL ON TABLE "public"."ownership_events" TO "anon";

GRANT ALL ON TABLE "public"."ownership_events" TO "authenticated";

GRANT ALL ON TABLE "public"."ownership_events" TO "service_role";

GRANT ALL ON TABLE "public"."posts" TO "anon";

GRANT ALL ON TABLE "public"."posts" TO "authenticated";

GRANT ALL ON TABLE "public"."posts" TO "service_role";

GRANT ALL ON TABLE "public"."profile_showcase_items" TO "anon";

GRANT ALL ON TABLE "public"."profile_showcase_items" TO "authenticated";

GRANT ALL ON TABLE "public"."profile_showcase_items" TO "service_role";

GRANT ALL ON TABLE "public"."profiles" TO "anon";

GRANT ALL ON TABLE "public"."profiles" TO "authenticated";

GRANT ALL ON TABLE "public"."profiles" TO "service_role";

GRANT ALL ON TABLE "public"."sales_events" TO "anon";

GRANT ALL ON TABLE "public"."sales_events" TO "authenticated";

GRANT ALL ON TABLE "public"."sales_events" TO "service_role";

GRANT ALL ON TABLE "public"."saved_cards" TO "anon";

GRANT ALL ON TABLE "public"."saved_cards" TO "authenticated";

GRANT ALL ON TABLE "public"."saved_cards" TO "service_role";

GRANT ALL ON TABLE "public"."saved_folders" TO "anon";

GRANT ALL ON TABLE "public"."saved_folders" TO "authenticated";

GRANT ALL ON TABLE "public"."saved_folders" TO "service_role";

GRANT ALL ON TABLE "public"."saved_grails" TO "anon";

GRANT ALL ON TABLE "public"."saved_grails" TO "authenticated";

GRANT ALL ON TABLE "public"."saved_grails" TO "service_role";

GRANT ALL ON TABLE "public"."verification_events" TO "anon";

GRANT ALL ON TABLE "public"."verification_events" TO "authenticated";

GRANT ALL ON TABLE "public"."verification_events" TO "service_role";

-- ── Storage buckets and policies that predate the migration history ──────
-- (avatars: public; item-images: private, read through signed URLs only).

INSERT INTO storage.buckets (id, name, public)
VALUES
  ('avatars', 'avatars', true),
  ('item-images', 'item-images', false)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "avatars_insert_own" ON "storage"."objects" FOR INSERT TO "authenticated" WITH CHECK ((("bucket_id" = 'avatars'::"text") AND (("storage"."foldername"("name"))[1] = ("auth"."uid"())::"text")));

CREATE POLICY "avatars_select_public" ON "storage"."objects" FOR SELECT USING (("bucket_id" = 'avatars'::"text"));

CREATE POLICY "item_images_delete_own" ON "storage"."objects" FOR DELETE USING ((("bucket_id" = 'item-images'::"text") AND (("storage"."foldername"("name"))[1] = ("auth"."uid"())::"text")));

CREATE POLICY "item_images_insert_own" ON "storage"."objects" FOR INSERT WITH CHECK ((("bucket_id" = 'item-images'::"text") AND ("auth"."role"() = 'authenticated'::"text") AND (("storage"."foldername"("name"))[1] = ("auth"."uid"())::"text")));

CREATE POLICY "item_images_update_own" ON "storage"."objects" FOR UPDATE USING ((("bucket_id" = 'item-images'::"text") AND (("storage"."foldername"("name"))[1] = ("auth"."uid"())::"text")));
