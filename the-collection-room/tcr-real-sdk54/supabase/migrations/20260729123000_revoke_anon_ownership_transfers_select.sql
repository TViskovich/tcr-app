REVOKE SELECT ON TABLE public.ownership_transfers FROM anon;

NOTIFY pgrst, 'reload schema';
