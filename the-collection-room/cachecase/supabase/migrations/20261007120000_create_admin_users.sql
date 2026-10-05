-- CacheCase admin role — first pass (waitlist admin screen).
--
-- Membership = admin. Kept off public.profiles on purpose: profiles is
-- world-readable (profiles_select_public USING true) and self-updatable
-- (profiles_update_own has no column restriction), so a flag there would be
-- both publicly enumerable and self-grantable without a guard trigger.
--
-- Clients can only read their OWN row (to gate UI). No client write path at
-- all — rows are added manually in the SQL editor. Server-side authorization
-- (Edge Functions, service role) is the real enforcement; this table only
-- tells them who is an admin.

CREATE TABLE public.admin_users (
  user_id    uuid        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.admin_users ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_users_select_own
  ON public.admin_users FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- Defense in depth: this project's public schema grants anon/authenticated
-- full table privileges by default. Revoke all, re-grant SELECT only.
REVOKE ALL ON TABLE public.admin_users FROM anon, authenticated;
GRANT SELECT ON TABLE public.admin_users TO authenticated;

NOTIFY pgrst, 'reload schema';
