-- Corrects a real error in the immediately preceding migration
-- (20260804120000_add_collection_item_transferred_out_state.sql): a
-- column-specific REVOKE has NO effect when the same role still holds a
-- broader table-level GRANT for that privilege — PostgreSQL's privilege
-- model is additive across levels; a narrower REVOKE cannot subtract from
-- a wider GRANT. Confirmed live after applying that migration:
-- `authenticated` still showed UPDATE on collection_status/
-- transferred_out_at/transferred_registered_card_id in
-- information_schema.column_privileges, proving the column-level REVOKE
-- alone was a no-op against the pre-existing blanket table-level grant.
--
-- Fix: revoke the blanket table-level UPDATE grant from `authenticated`
-- entirely, then re-grant UPDATE on exactly the columns with a real,
-- confirmed client call site — nothing broader. Audited every direct
-- `supabase.from('collection_items').update(...)` call in this codebase:
--   - app/item/[id].tsx's handleSave: title, player, team, year, brand,
--     grade, grading_company, serial_number, estimated_value, description
--   - lib/item-images.ts's gallery-sync update: image_url
--   - lib/registry-claim.ts's post-claim image attach: image_url
-- No call site anywhere updates folder_id, id, user_id, or created_at —
-- there is no "move item to another folder" feature, and the other three
-- are identity/audit columns with no legitimate client-update path.
-- Excluding them (not just the three new lifecycle columns) is a
-- deliberate tightening to the smallest allowlist the app's actual,
-- already-shipped behavior requires, not merely "whatever existed before."
--
-- RLS (items_update_own, USING auth.uid() = user_id, WITH CHECK
-- unspecified — defaults to re-applying the same condition to the new
-- row) continues to independently restrict which ROWS a user may touch,
-- unchanged; this migration only narrows which COLUMNS may appear in that
-- UPDATE's SET clause. SECURITY DEFINER functions (accept_ownership_transfer,
-- register_card, link_registered_card_collection_item) are unaffected:
-- their internal UPDATE statements execute as the function owner
-- (postgres), whose own separate blanket grant was never touched by
-- either this or the previous migration. service_role's own separate
-- blanket grant is likewise untouched. Only UPDATE privilege changes here —
-- INSERT, DELETE, SELECT, and every RLS policy are unaffected.

REVOKE UPDATE ON public.collection_items FROM authenticated;

GRANT UPDATE (
  title, player, team, year, brand, grade, grading_company, serial_number,
  estimated_value, image_url, description
) ON public.collection_items TO authenticated;

NOTIFY pgrst, 'reload schema';
