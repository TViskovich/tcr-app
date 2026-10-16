BEGIN;

-- ============================================================================
-- Sixth collectible type: "Other" — item_type 'other', with one shared
-- details table for every Other category (Sneakers, Watches, Art & Prints,
-- Toys, Books, Pins, and a collector-named custom category), plus one
-- owner-only table for private financial fields.
--
-- Same architecture as the per-type detail tables (trading_card_details,
-- 20261017120000): a one-to-one row keyed by the item, readable under the
-- parent item's own visibility, writable only by its owner, and written
-- together with the item by two SECURITY INVOKER RPCs (one transaction
-- each). Differences:
--   * category is a discriminator, fixed once the item is created (no
--     UPDATE privilege on it, and the update RPC never takes one);
--   * the category-specific fields live in one jsonb object, validated by
--     the database (other_item_details_valid, in a CHECK constraint) as well
--     as by the app — unknown keys, wrong types, values outside a field's
--     listed options, and conditional fields without their controlling
--     field are all rejected;
--   * search_identifier holds the one optional value collectors search by
--     (SKU / style code, reference number, ISBN, Pin ID, ...).
-- The shared fields stay on collection_items, so every existing screen
-- keeps working unchanged: title (the category's primary identifying field
-- — the only required field), brand, year, estimated_value, description
-- (notes) and is_public.
--
-- Private financial data (purchase price) is NOT in other_item_details,
-- which anyone who can see the item can read. It lives in
-- collection_item_private_details, whose every policy is owner-only — so
-- it is never returned to another user by any API path, not just hidden in
-- the UI.
--
-- Backward compatible: only ADDS 'other' to the item_type CHECK, two new
-- tables and new functions. No existing row, column, policy or function
-- changes. (20261022120000 added and 20261023120000 removed an earlier
-- column-based design; both stay in history and touch nothing here.)
-- ============================================================================

ALTER TABLE public.collection_items
  DROP CONSTRAINT IF EXISTS collection_items_item_type_check;

ALTER TABLE public.collection_items
  ADD CONSTRAINT collection_items_item_type_check
  CHECK (item_type IN ('sports_card', 'pokemon', 'figurine', 'comic_book', 'trading_card', 'other'));

-- ----------------------------------------------------------------------------
-- Field specs. One jsonb object per category: { "<key>": <rule>, ... }.
-- Keys and option lists mirror the app's forms exactly
-- (components/item-detail/*-details-form.tsx; lib/other-item-*.ts map form
-- state to these keys).
-- Rule kinds:
--   text        {"max":N}               non-blank string, at most N chars
--   enum        {"values":[...]}         exactly one listed string
--   option      {"max":N}               a listed option or the collector's
--               own text (an "Other" field) — non-blank, at most N chars,
--               never the bare word "Other"
--   enum_array  {"values":[...]}         non-empty array of distinct listed
--               strings
--   bool        true or false
--   integer     {"min":A,"max":B}       whole number in [A, B]
--   number      {"min":A,"max":B,"scale":S}  number in [A, B], at most S
--               decimals
-- Optional "when" on any rule — the field may only be present when the
-- condition holds (an array of conditions = any one of them):
--   {"key":K}                  key K is present
--   {"key":K,"in":[...]}       key K is present and one of these values
--   {"key":K,"not_in":[...]}   key K is present and none of these values
--   "or_missing": true         ...or key K is absent
-- Empty values are never stored: the app omits a field instead of sending
-- '', null, false or [] (null and empty values are rejected).
-- IMMUTABLE: changing a spec is a new migration, never an in-place edit.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.other_item_details_spec(p_category text)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE p_category
    WHEN 'sneakers' THEN $spec$
    {
      "colorway": {"kind":"text","max":120},
      "size": {"kind":"text","max":12},
      "size_system": {"kind":"enum","values":["US Men's","US Women's","GS / Youth","UK","EU"]},
      "condition": {"kind":"enum","values":["Deadstock (DS)","Very Near Deadstock (VNDS)","Used"]},
      "condition_score": {"kind":"enum","values":["10","9","8","7","6","5","4","3","2","1"],"when":{"key":"condition","in":["Used"]}},
      "box": {"kind":"enum","values":["Original Box","Damaged Box","Replacement Box","No Box"]},
      "extras": {"kind":"enum_array","values":["Extra Laces","Hangtag","Receipt","Special Packaging"]},
      "authenticated_by": {"kind":"option","max":60},
      "auth_tag_or_receipt": {"kind":"text","max":120,"when":{"key":"authenticated_by","not_in":["Not Authenticated"]}},
      "collab_partner": {"kind":"text","max":120},
      "limited_release": {"kind":"bool"}
    }
    $spec$::jsonb
    WHEN 'watches' THEN $spec$
    {
      "nickname": {"kind":"text","max":120},
      "case_size_mm": {"kind":"number","min":1,"max":100,"scale":2},
      "case_material": {"kind":"option","max":60},
      "dial": {"kind":"text","max":120},
      "movement": {"kind":"enum","values":["Automatic","Manual","Quartz"]},
      "caliber": {"kind":"text","max":60},
      "bracelet": {"kind":"option","max":60},
      "condition": {"kind":"enum","values":["Unworn","Excellent","Very Good","Good","Fair"]},
      "polish": {"kind":"enum","values":["Unpolished","Polished","Unknown"]},
      "box_and_papers": {"kind":"enum","values":["Full Set","Watch + Papers","Watch + Box","Watch Only"]},
      "warranty_card_date": {"kind":"text","max":20},
      "aftermarket_parts": {"kind":"enum_array","values":["Dial","Bezel","Bracelet","Hands","Crystal","Crown"]},
      "last_service_date": {"kind":"text","max":20},
      "serviced_by": {"kind":"text","max":120},
      "original_parts_kept": {"kind":"bool"}
    }
    $spec$::jsonb
    WHEN 'art_prints' THEN $spec$
    {
      "type": {"kind":"enum","values":["Original","Limited Edition Print","Open Edition Print","Poster"]},
      "print_year": {"kind":"integer","min":1000,"max":2100,"when":{"key":"type","not_in":["Original"],"or_missing":true}},
      "print_method": {"kind":"option","max":60,"when":{"key":"type","not_in":["Original"],"or_missing":true}},
      "edition_number": {"kind":"integer","min":1,"max":1000000,"when":{"key":"type","not_in":["Original","Open Edition Print"],"or_missing":true}},
      "edition_size": {"kind":"integer","min":1,"max":1000000,"when":{"key":"type","not_in":["Original","Open Edition Print"],"or_missing":true}},
      "edition_variant": {"kind":"enum","values":["Regular","Variant","AP (Artist's Proof)","PP (Printer's Proof)","Test Print"],"when":{"key":"type","not_in":["Original"],"or_missing":true}},
      "publisher": {"kind":"text","max":120,"when":{"key":"type","not_in":["Original"],"or_missing":true}},
      "signature": {"kind":"enum","values":["Hand-Signed","Plate-Signed (Printed)","Unsigned"]},
      "hand_numbered": {"kind":"bool"},
      "remarque": {"kind":"bool"},
      "medium": {"kind":"option","max":60,"when":{"key":"type","in":["Original"]}},
      "units": {"kind":"enum","values":["in","cm"]},
      "image_width": {"kind":"number","min":0.01,"max":10000,"scale":2},
      "image_height": {"kind":"number","min":0.01,"max":10000,"scale":2},
      "paper_width": {"kind":"number","min":0.01,"max":10000,"scale":2},
      "paper_height": {"kind":"number","min":0.01,"max":10000,"scale":2},
      "framing": {"kind":"enum","values":["Unframed","Framed","Framed with Archival / UV Glass"]}
    }
    $spec$::jsonb
    WHEN 'toys' THEN $spec$
    {
      "toy_type": {"kind":"enum","values":["Action Figure","Die-cast","Plush","Electronic","Other"]},
      "line": {"kind":"text","max":120},
      "release": {"kind":"enum","values":["Original Release","Reissue"]},
      "wave": {"kind":"text","max":60,"when":{"key":"toy_type","in":["Action Figure"],"or_missing":true}},
      "variants": {"kind":"enum_array","values":["Paint Variant","Card-Back Variant","Packaging Variant"]},
      "variant_details": {"kind":"text","max":200,"when":{"key":"variants"}},
      "exclusive": {"kind":"option","max":60},
      "packaging": {"kind":"enum","values":["MOC (Mint on Card)","MIB (Mint in Box)","NRFB (Never Removed from Box)","Opened, Complete","Loose"]},
      "package_issues": {"kind":"enum_array","values":["Card Creases","Bubble Dents","Bubble Yellowing","Box Wear"],"when":{"key":"packaging","not_in":["Loose"],"or_missing":true}},
      "accessories": {"kind":"enum","values":["Complete","Incomplete","Not Applicable"]},
      "missing_pieces": {"kind":"text","max":200,"when":{"key":"accessories","in":["Incomplete"]}},
      "condition": {"kind":"enum","values":["Mint","Excellent","Good","Played With"]},
      "condition_issues": {"kind":"enum_array","values":["Paint Wear","Loose Joints","Sun Fading","Broken Parts"]},
      "graded": {"kind":"bool"},
      "grading_company": {"kind":"option","max":60,"when":{"key":"graded","in":[true]}},
      "grade": {"kind":"text","max":20,"when":{"key":"graded","in":[true]}},
      "diecast_scale": {"kind":"option","max":60,"when":{"key":"toy_type","in":["Die-cast"]}},
      "treasure_hunt": {"kind":"enum","values":["None","Treasure Hunt","Super Treasure Hunt"],"when":{"key":"toy_type","in":["Die-cast"]}},
      "casting_name": {"kind":"text","max":120,"when":{"key":"toy_type","in":["Die-cast"]}},
      "hang_tag": {"kind":"enum","values":["Attached, Mint","Attached, Creased / Damaged","Missing"],"when":{"key":"toy_type","in":["Plush"]}},
      "tush_tag": {"kind":"enum","values":["Attached, Mint","Attached, Cut / Faded","Missing"],"when":{"key":"toy_type","in":["Plush"]}},
      "working": {"kind":"enum","values":["Working","Partially Working","Not Working","Untested"],"when":{"key":"toy_type","in":["Electronic"]}},
      "battery_corrosion": {"kind":"enum","values":["None","Light","Heavy","Unknown"],"when":{"key":"toy_type","in":["Electronic"]}}
    }
    $spec$::jsonb
    WHEN 'books' THEN $spec$
    {
      "illustrator": {"kind":"text","max":120},
      "publisher": {"kind":"text","max":120},
      "edition": {"kind":"enum","values":["First Edition","Later Edition","Special / Limited Edition"]},
      "printing": {"kind":"enum","values":["1st Printing","2nd Printing","3rd Printing","4th Printing","Later Printing","Unknown"]},
      "number_line": {"kind":"text","max":60},
      "format": {"kind":"enum","values":["Hardcover","Trade Paperback","Mass Market Paperback","Leatherbound"]},
      "special_publisher": {"kind":"option","max":60,"when":{"key":"edition","in":["Special / Limited Edition"]}},
      "limited_number": {"kind":"integer","min":1,"max":1000000,"when":{"key":"edition","in":["Special / Limited Edition"]}},
      "limited_size": {"kind":"integer","min":1,"max":1000000,"when":{"key":"edition","in":["Special / Limited Edition"]}},
      "book_club_edition": {"kind":"bool"},
      "dust_jacket": {"kind":"enum","values":["Present","Missing","Not Applicable"]},
      "price_clipped": {"kind":"bool","when":{"key":"dust_jacket","in":["Present"]}},
      "jacket_condition": {"kind":"enum","values":["Fine","Near Fine","Very Good","Good","Fair","Poor"],"when":{"key":"dust_jacket","in":["Present"]}},
      "signature": {"kind":"enum","values":["Unsigned","Signed","Flat-Signed (Signature Only)","Inscribed","Signed Limited Edition"]},
      "association_copy": {"kind":"bool","when":{"key":"signature","not_in":["Unsigned"]}},
      "association_notes": {"kind":"text","max":500,"when":{"key":"association_copy","in":[true]}},
      "condition": {"kind":"enum","values":["Fine","Near Fine","Very Good","Good","Fair","Poor"]},
      "flaws": {"kind":"enum_array","values":["Ex-Library","Remainder Mark","Foxing","Writing / Bookplate","Sunned Spine","Loose Binding"]}
    }
    $spec$::jsonb
    WHEN 'pins' THEN $spec$
    {
      "characters": {"kind":"text","max":200},
      "franchise": {"kind":"text","max":120},
      "origin": {"kind":"option","max":60},
      "edition": {"kind":"enum","values":["Open Edition (OE)","Limited Edition (LE)","Limited Release (LR)","Limited Edition, Size Not Stated","Artist Proof (AP) / Pre-production (PP)","Cast Exclusive"]},
      "edition_size": {"kind":"integer","min":1,"max":1000000,"when":{"key":"edition","in":["Limited Edition (LE)"]}},
      "trading_series": {"kind":"enum","values":["None","Hidden Mickey","Cast Lanyard","Hidden Disney"]},
      "completer": {"kind":"bool","when":{"key":"trading_series","in":["Hidden Mickey"]}},
      "chaser": {"kind":"bool","when":[{"key":"trading_series","not_in":["None"]},{"key":"mystery_box","in":[true]}]},
      "mystery_box": {"kind":"bool"},
      "mystery_set_name": {"kind":"text","max":120,"when":{"key":"mystery_box","in":[true]}},
      "mystery_number": {"kind":"integer","min":1,"max":1000000,"when":{"key":"mystery_box","in":[true]}},
      "event": {"kind":"text","max":120},
      "set_name": {"kind":"text","max":120},
      "set_number": {"kind":"integer","min":1,"max":1000000},
      "set_total": {"kind":"integer","min":1,"max":1000000},
      "pin_types": {"kind":"enum_array","values":["Standard","Slider","Spinner","Dangle","Hinged","Pin-on-Pin","3D","Light-up","Glitter","Jumbo","Frame"]},
      "size": {"kind":"text","max":20},
      "backing": {"kind":"enum","values":["On Original Card","Off Card"]},
      "certificate": {"kind":"enum","values":["Present","Missing","Not Applicable"]},
      "condition": {"kind":"enum","values":["New","Excellent","Minor Flaws"]},
      "flaws": {"kind":"enum_array","values":["Enamel Dips","Scratches","Bent Post"],"when":{"key":"condition","in":["Minor Flaws"]}},
      "backstamp": {"kind":"enum","values":["Authentic Backstamp Checked","Not Checked","Suspected Scrapper"]},
      "source": {"kind":"option","max":60},
      "trade_status": {"kind":"enum","values":["Not for Trade","Trader (Open to Trade)","ISO (In Search Of)","Keeper / PIC (Pin in Collection)"]}
    }
    $spec$::jsonb
    WHEN 'custom' THEN $spec$
    {
      "condition": {"kind":"enum","values":["New","Excellent","Good","Fair","Poor"]}
    }
    $spec$::jsonb
    ELSE NULL
  END;
$$;

-- True when p_details is a valid details object for p_category. Used by the
-- table's CHECK constraint and by both RPCs (for a readable error).
CREATE OR REPLACE FUNCTION public.other_item_details_valid(p_category text, p_details jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  v_spec   jsonb := public.other_item_details_spec(p_category);
  v_key    text;
  v_value  jsonb;
  v_rule   jsonb;
  v_kind   text;
  v_text   text;
  v_num    numeric;
  v_when   jsonb;
  v_cond   jsonb;
  v_other  jsonb;
  v_met    boolean;
BEGIN
  IF v_spec IS NULL OR p_details IS NULL OR jsonb_typeof(p_details) <> 'object' THEN
    RETURN false;
  END IF;

  FOR v_key, v_value IN SELECT key, value FROM jsonb_each(p_details) LOOP
    v_rule := v_spec -> v_key;
    IF v_rule IS NULL THEN
      RETURN false; -- unknown key
    END IF;
    v_kind := v_rule ->> 'kind';

    IF v_kind IN ('text', 'option', 'enum') THEN
      IF jsonb_typeof(v_value) <> 'string' THEN
        RETURN false;
      END IF;
      v_text := v_value #>> '{}';
      IF v_kind = 'enum' THEN
        IF NOT (v_rule -> 'values') ? v_text THEN
          RETURN false;
        END IF;
      ELSE
        IF btrim(v_text) = '' OR char_length(v_text) > (v_rule ->> 'max')::int THEN
          RETURN false;
        END IF;
        IF v_kind = 'option' AND lower(btrim(v_text)) = 'other' THEN
          RETURN false;
        END IF;
      END IF;

    ELSIF v_kind = 'enum_array' THEN
      IF jsonb_typeof(v_value) <> 'array' OR jsonb_array_length(v_value) = 0 THEN
        RETURN false;
      END IF;
      IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_value) AS e(elem)
        WHERE jsonb_typeof(e.elem) <> 'string' OR NOT (v_rule -> 'values') ? (e.elem #>> '{}')
      ) THEN
        RETURN false;
      END IF;
      IF (SELECT count(DISTINCT e.elem) FROM jsonb_array_elements(v_value) AS e(elem))
         <> jsonb_array_length(v_value) THEN
        RETURN false; -- duplicates
      END IF;

    ELSIF v_kind = 'bool' THEN
      IF jsonb_typeof(v_value) <> 'boolean' THEN
        RETURN false;
      END IF;

    ELSIF v_kind IN ('integer', 'number') THEN
      IF jsonb_typeof(v_value) <> 'number' THEN
        RETURN false;
      END IF;
      v_num := (v_value #>> '{}')::numeric;
      IF v_num < (v_rule ->> 'min')::numeric OR v_num > (v_rule ->> 'max')::numeric THEN
        RETURN false;
      END IF;
      IF v_kind = 'integer' AND v_num <> trunc(v_num) THEN
        RETURN false;
      END IF;
      IF v_kind = 'number' AND v_num <> round(v_num, (v_rule ->> 'scale')::int) THEN
        RETURN false;
      END IF;

    ELSE
      RETURN false; -- malformed spec
    END IF;

    -- Conditional field: only allowed when (any one of) its conditions hold.
    v_when := v_rule -> 'when';
    IF v_when IS NOT NULL THEN
      v_met := false;
      FOR v_cond IN
        SELECT c FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(v_when) = 'array' THEN v_when ELSE jsonb_build_array(v_when) END
        ) AS w(c)
      LOOP
        v_other := p_details -> (v_cond ->> 'key');
        IF v_other IS NULL THEN
          v_met := COALESCE((v_cond ->> 'or_missing')::boolean, false);
        ELSIF v_cond ? 'in' THEN
          v_met := (v_cond -> 'in') @> jsonb_build_array(v_other);
        ELSIF v_cond ? 'not_in' THEN
          v_met := NOT (v_cond -> 'not_in') @> jsonb_build_array(v_other);
        ELSE
          v_met := true;
        END IF;
        EXIT WHEN v_met;
      END LOOP;
      IF NOT v_met THEN
        RETURN false;
      END IF;
    END IF;
  END LOOP;

  RETURN true;
END;
$$;

-- ----------------------------------------------------------------------------
-- other_item_details — public collectible details (visible wherever the
-- item itself is visible).
-- category: the Other subcategory slug, fixed at creation.
-- custom_category_name: the collector's own category name — present exactly
-- when category = 'custom'; never blank or the bare word "Other"/"Custom".
-- search_identifier: optional SKU / reference / ISBN / Pin ID; trimmed,
-- never blank (NULL = not set). search_identifier_normalized is derived
-- from it (lowercase, letters and digits only) so a search for "dz5485612"
-- also finds "DZ5485-612" and an ISBN matches with or without hyphens.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.other_item_details (
  item_id                       uuid PRIMARY KEY REFERENCES public.collection_items(id) ON DELETE CASCADE,
  category                      text NOT NULL,
  custom_category_name          text,
  search_identifier             text,
  search_identifier_normalized  text GENERATED ALWAYS AS
                                  (lower(regexp_replace(search_identifier, '[^[:alnum:]]', '', 'g'))) STORED,
  details                       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT other_item_details_category_check
    CHECK (category IN ('sneakers', 'watches', 'art_prints', 'toys', 'books', 'pins', 'custom')),

  CONSTRAINT other_item_details_custom_category_name_check
    CHECK (
      (category = 'custom' AND custom_category_name IS NOT NULL
        AND custom_category_name = btrim(custom_category_name)
        AND char_length(custom_category_name) BETWEEN 1 AND 60
        AND lower(custom_category_name) NOT IN ('other', 'custom'))
      OR (category <> 'custom' AND custom_category_name IS NULL)
    ),

  CONSTRAINT other_item_details_search_identifier_check
    CHECK (
      search_identifier IS NULL
      OR (search_identifier = btrim(search_identifier)
          AND char_length(search_identifier) BETWEEN 1 AND 100)
    ),

  CONSTRAINT other_item_details_details_check
    CHECK (public.other_item_details_valid(category, details))
);

-- Identifier lookups (exact / prefix on the normalized form).
CREATE INDEX IF NOT EXISTS other_item_details_search_identifier_normalized_idx
  ON public.other_item_details (search_identifier_normalized text_pattern_ops)
  WHERE search_identifier_normalized IS NOT NULL;

ALTER TABLE public.other_item_details ENABLE ROW LEVEL SECURITY;

-- Same read rule as trading_card_details_* (parent item's visibility).
CREATE POLICY "other_item_details_select_public" ON public.other_item_details
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.collection_items ci
      WHERE ci.id = other_item_details.item_id
        AND public.folder_is_effectively_visible(ci.folder_id)
        AND (ci.is_public = true OR ci.user_id = auth.uid())
    )
  );

-- Insert: owner only, and only for an item of type 'other'.
CREATE POLICY "other_item_details_insert_own" ON public.other_item_details
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.collection_items ci
      WHERE ci.id = other_item_details.item_id
        AND ci.user_id = auth.uid()
        AND ci.item_type = 'other'
    )
  );

CREATE POLICY "other_item_details_update_own" ON public.other_item_details
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM public.collection_items ci
      WHERE ci.id = other_item_details.item_id AND ci.user_id = auth.uid()
    )
  );

-- No DELETE policy: a details row goes only with its item (ON DELETE
-- CASCADE), so a row can never be deleted and re-inserted under a different
-- category.

-- Table privileges: replace Supabase's default ALL grants with exactly
-- what the app and the RPCs need. category is insert-only (not updatable),
-- and nobody but the owner role / service_role can DELETE directly.
REVOKE ALL ON TABLE public.other_item_details FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.other_item_details TO anon, authenticated;
GRANT INSERT (item_id, category, custom_category_name, search_identifier, details)
  ON TABLE public.other_item_details TO authenticated;
GRANT UPDATE (custom_category_name, search_identifier, details, updated_at)
  ON TABLE public.other_item_details TO authenticated;

-- ----------------------------------------------------------------------------
-- collection_item_private_details — owner-only fields of any item. Keyed by
-- collection_items (not by other_item_details), so it is type-agnostic and
-- any collectible type can use it later without another table; today only
-- the Other RPCs write it. Holds purchase_price only — the one private
-- financial field in the Other forms. A row exists only while it holds a
-- value (the update RPC deletes it when cleared).
--
-- Every policy requires auth.uid() to be the item's owner, so no other
-- user — and no anonymous caller — can read it through any API path.
-- (collection_items.user_id is never updatable by clients, and ownership
-- transfers leave the sender's item, and its user_id, unchanged.)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.collection_item_private_details (
  item_id         uuid PRIMARY KEY REFERENCES public.collection_items(id) ON DELETE CASCADE,
  purchase_price  numeric(12, 2),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT collection_item_private_details_purchase_price_check
    CHECK (purchase_price IS NULL OR purchase_price >= 0)
);

ALTER TABLE public.collection_item_private_details ENABLE ROW LEVEL SECURITY;

CREATE POLICY "collection_item_private_details_select_own" ON public.collection_item_private_details
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.collection_items ci
      WHERE ci.id = collection_item_private_details.item_id AND ci.user_id = auth.uid()
    )
  );

CREATE POLICY "collection_item_private_details_insert_own" ON public.collection_item_private_details
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.collection_items ci
      WHERE ci.id = collection_item_private_details.item_id AND ci.user_id = auth.uid()
    )
  );

CREATE POLICY "collection_item_private_details_update_own" ON public.collection_item_private_details
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM public.collection_items ci
      WHERE ci.id = collection_item_private_details.item_id AND ci.user_id = auth.uid()
    )
  );

CREATE POLICY "collection_item_private_details_delete_own" ON public.collection_item_private_details
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM public.collection_items ci
      WHERE ci.id = collection_item_private_details.item_id AND ci.user_id = auth.uid()
    )
  );

-- No anon access at all.
REVOKE ALL ON TABLE public.collection_item_private_details FROM PUBLIC, anon, authenticated;
GRANT SELECT, DELETE ON TABLE public.collection_item_private_details TO authenticated;
GRANT INSERT (item_id, purchase_price) ON TABLE public.collection_item_private_details TO authenticated;
GRANT UPDATE (purchase_price, updated_at) ON TABLE public.collection_item_private_details TO authenticated;

-- ----------------------------------------------------------------------------
-- RPCs. Both are SECURITY INVOKER, so every write also passes the existing
-- collection_items policies and the policies above, and each runs as one
-- transaction: any error (a validation RAISE or a failed constraint) rolls
-- back every row it wrote. EXECUTE is revoked from anon explicitly
-- (Supabase's default privileges grant new functions to anon directly,
-- which REVOKE ... FROM PUBLIC doesn't remove); they also reject an
-- unauthenticated caller.
--
-- Shared columns: p_title is required (the category's primary identifying
-- field); p_brand / p_year / p_estimated_value / p_description are
-- optional. p_details must satisfy the category's spec (see above).
-- p_purchase_price is private (collection_item_private_details).
-- All validation runs before the first write.
-- ----------------------------------------------------------------------------

-- Shared checks for both RPCs; raises with a readable message.
CREATE OR REPLACE FUNCTION public.other_item_check_fields(
  p_category text,
  p_custom_category_name text,
  p_title text,
  p_brand text,
  p_year integer,
  p_estimated_value numeric,
  p_search_identifier text,
  p_details jsonb,
  p_purchase_price numeric
)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_custom text := NULLIF(btrim(p_custom_category_name), '');
BEGIN
  IF public.other_item_details_spec(p_category) IS NULL THEN
    RAISE EXCEPTION 'Unknown category';
  END IF;

  IF p_category = 'custom' AND (v_custom IS NULL OR lower(v_custom) IN ('other', 'custom')) THEN
    RAISE EXCEPTION 'Please specify the category';
  END IF;

  IF char_length(v_custom) > 60 THEN
    RAISE EXCEPTION 'Category name can be at most 60 characters';
  END IF;

  IF NULLIF(btrim(p_title), '') IS NULL THEN
    RAISE EXCEPTION 'Title is required';
  END IF;

  -- Brand is an "Other"-escape dropdown in these categories' forms; the
  -- bare word means nothing was typed. (Elsewhere brand is free text —
  -- an artist, author or maker — and any name is fine.)
  IF p_category IN ('sneakers', 'watches', 'toys') AND lower(btrim(p_brand)) = 'other' THEN
    RAISE EXCEPTION 'Please specify the brand';
  END IF;

  IF p_year IS NOT NULL AND (p_year < 1000 OR p_year > 2100) THEN
    RAISE EXCEPTION 'Year must be between 1000 and 2100';
  END IF;

  IF p_estimated_value IS NOT NULL
     AND (p_estimated_value < 0 OR p_estimated_value <> round(p_estimated_value, 2)) THEN
    RAISE EXCEPTION 'Estimated value must be a positive amount with at most two decimals';
  END IF;

  IF p_purchase_price IS NOT NULL
     AND (p_purchase_price < 0 OR p_purchase_price >= 10000000000
          OR p_purchase_price <> round(p_purchase_price, 2)) THEN
    RAISE EXCEPTION 'Purchase price must be a positive amount with at most two decimals';
  END IF;

  IF char_length(btrim(p_search_identifier)) > 100 THEN
    RAISE EXCEPTION 'Identifier can be at most 100 characters';
  END IF;

  IF NOT public.other_item_details_valid(p_category, COALESCE(p_details, '{}'::jsonb)) THEN
    RAISE EXCEPTION 'Some details aren''t valid for this category';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.create_other_item(
  p_folder_id uuid,
  p_category text,
  p_title text,
  p_custom_category_name text DEFAULT NULL,
  p_brand text DEFAULT NULL,
  p_year integer DEFAULT NULL,
  p_estimated_value numeric DEFAULT NULL,
  p_description text DEFAULT NULL,
  p_is_public boolean DEFAULT true,
  p_search_identifier text DEFAULT NULL,
  p_details jsonb DEFAULT '{}'::jsonb,
  p_purchase_price numeric DEFAULT NULL
)
RETURNS public.collection_items
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_caller  uuid := auth.uid();
  v_item    public.collection_items;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_folder_id IS NULL THEN
    RAISE EXCEPTION 'Folder is required';
  END IF;

  IF NOT public.folder_owned_by(p_folder_id, v_caller) THEN
    RAISE EXCEPTION 'Folder not found or not owned by caller';
  END IF;

  PERFORM public.other_item_check_fields(
    p_category, p_custom_category_name, p_title, p_brand, p_year, p_estimated_value,
    p_search_identifier, p_details, p_purchase_price
  );

  INSERT INTO public.collection_items (
    folder_id, user_id, item_type, title, brand, year, estimated_value, description, is_public
  ) VALUES (
    p_folder_id, v_caller, 'other', btrim(p_title), NULLIF(btrim(p_brand), ''), p_year,
    p_estimated_value, NULLIF(btrim(p_description), ''), COALESCE(p_is_public, true)
  )
  RETURNING * INTO v_item;

  INSERT INTO public.other_item_details (
    item_id, category, custom_category_name, search_identifier, details
  ) VALUES (
    v_item.id, p_category,
    CASE WHEN p_category = 'custom' THEN btrim(p_custom_category_name) END,
    NULLIF(btrim(p_search_identifier), ''),
    COALESCE(p_details, '{}'::jsonb)
  );

  IF p_purchase_price IS NOT NULL THEN
    INSERT INTO public.collection_item_private_details (item_id, purchase_price)
    VALUES (v_item.id, p_purchase_price);
  END IF;

  RETURN v_item;
END;
$$;

REVOKE ALL ON FUNCTION public.create_other_item(
  uuid, text, text, text, text, integer, numeric, text, boolean, text, jsonb, numeric
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_other_item(
  uuid, text, text, text, text, integer, numeric, text, boolean, text, jsonb, numeric
) TO authenticated;

-- Update: owner-only, 'other' items only. Item type and category never
-- change (there is no category parameter); the existing details row is
-- updated in place, and the private row is written, or removed when the
-- purchase price is cleared.
CREATE OR REPLACE FUNCTION public.update_other_item(
  p_item_id uuid,
  p_title text,
  p_custom_category_name text DEFAULT NULL,
  p_brand text DEFAULT NULL,
  p_year integer DEFAULT NULL,
  p_estimated_value numeric DEFAULT NULL,
  p_description text DEFAULT NULL,
  p_is_public boolean DEFAULT true,
  p_search_identifier text DEFAULT NULL,
  p_details jsonb DEFAULT '{}'::jsonb,
  p_purchase_price numeric DEFAULT NULL
)
RETURNS public.collection_items
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_caller    uuid := auth.uid();
  v_item_type text;
  v_category  text;
  v_item      public.collection_items;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT item_type INTO v_item_type
  FROM public.collection_items
  WHERE id = p_item_id AND user_id = v_caller;

  IF v_item_type IS NULL THEN
    RAISE EXCEPTION 'Item not found or not owned by caller';
  END IF;

  IF v_item_type <> 'other' THEN
    RAISE EXCEPTION 'This item is not an Other item';
  END IF;

  SELECT category INTO v_category
  FROM public.other_item_details
  WHERE item_id = p_item_id;

  IF v_category IS NULL THEN
    RAISE EXCEPTION 'Item details are missing';
  END IF;

  PERFORM public.other_item_check_fields(
    v_category, p_custom_category_name, p_title, p_brand, p_year, p_estimated_value,
    p_search_identifier, p_details, p_purchase_price
  );

  UPDATE public.collection_items
  SET title = btrim(p_title),
      brand = NULLIF(btrim(p_brand), ''),
      year = p_year,
      estimated_value = p_estimated_value,
      description = NULLIF(btrim(p_description), ''),
      is_public = COALESCE(p_is_public, true)
  WHERE id = p_item_id
  RETURNING * INTO v_item;

  UPDATE public.other_item_details
  SET custom_category_name =
        CASE WHEN v_category = 'custom' THEN btrim(p_custom_category_name) END,
      search_identifier = NULLIF(btrim(p_search_identifier), ''),
      details = COALESCE(p_details, '{}'::jsonb),
      updated_at = now()
  WHERE item_id = p_item_id;

  IF p_purchase_price IS NULL THEN
    DELETE FROM public.collection_item_private_details WHERE item_id = p_item_id;
  ELSE
    INSERT INTO public.collection_item_private_details (item_id, purchase_price)
    VALUES (p_item_id, p_purchase_price)
    ON CONFLICT (item_id) DO UPDATE
    SET purchase_price = EXCLUDED.purchase_price,
        updated_at = now();
  END IF;

  RETURN v_item;
END;
$$;

REVOKE ALL ON FUNCTION public.update_other_item(
  uuid, text, text, text, integer, numeric, text, boolean, text, jsonb, numeric
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_other_item(
  uuid, text, text, text, integer, numeric, text, boolean, text, jsonb, numeric
) TO authenticated;

-- The helpers are pure, but anon has no use for them. authenticated keeps
-- EXECUTE: the CHECK constraint and the RPCs run them as the caller.
REVOKE ALL ON FUNCTION public.other_item_details_spec(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.other_item_details_valid(text, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.other_item_check_fields(
  text, text, text, text, integer, numeric, text, jsonb, numeric
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.other_item_details_spec(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.other_item_details_valid(text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.other_item_check_fields(
  text, text, text, text, integer, numeric, text, jsonb, numeric
) TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
