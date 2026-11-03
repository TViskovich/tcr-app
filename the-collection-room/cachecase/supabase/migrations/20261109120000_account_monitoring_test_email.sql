-- ============================================================================
-- Account monitoring test email — server-side rate limit.
--
-- account-monitor's {"action":"test"} sends one clearly labelled test notice
-- through the configured alert channels, so an operator can verify real
-- delivery without a deletion, a synthetic alert or any collector data.
--
-- Each authorized test attempt takes a slot here first, so a leaked or
-- misused maintenance secret can't turn the function into a mail cannon:
--   at most 1 test per 10 minutes, and 5 per 24 hours (all instances, as
--   the limit lives in the database, not in the function).
-- Rows hold only times and controlled outcome codes; kept 7 days.
--
-- Separate from the monitoring tables: a test never touches alerts, runs,
-- dispatches or monitoring state.
-- ============================================================================

CREATE TABLE private.account_monitoring_test_sends (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  requested_at timestamptz NOT NULL DEFAULT now(),
  outcome      text CHECK (outcome ~ '^[a-z_]{1,48}$'),   -- NULL while in flight
  channels     text[] NOT NULL DEFAULT '{}' CHECK (channels <@ ARRAY['email', 'webhook'])
);
CREATE INDEX account_monitoring_test_sends_at ON private.account_monitoring_test_sends (requested_at DESC);
REVOKE ALL ON private.account_monitoring_test_sends FROM PUBLIC, anon, authenticated, service_role;
ALTER TABLE private.account_monitoring_test_sends ENABLE ROW LEVEL SECURITY;

-- Takes a test slot, or says when the next one is available.
CREATE FUNCTION public.account_monitoring_take_test_slot()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_last timestamptz;
  v_day integer;
  v_oldest_today timestamptz;
  v_id bigint;
BEGIN
  -- One decision at a time, so concurrent requests can't both pass.
  PERFORM pg_advisory_xact_lock(hashtext('account_monitoring_test_send'));
  DELETE FROM private.account_monitoring_test_sends WHERE requested_at < now() - interval '7 days';
  SELECT max(requested_at), count(*) FILTER (WHERE requested_at > now() - interval '24 hours'),
         min(requested_at) FILTER (WHERE requested_at > now() - interval '24 hours')
    INTO v_last, v_day, v_oldest_today
    FROM private.account_monitoring_test_sends;
  IF v_last > now() - interval '10 minutes' THEN
    RETURN jsonb_build_object('allowed', false,
      'retry_after_seconds', ceil(extract(epoch FROM v_last + interval '10 minutes' - now()))::int);
  END IF;
  IF v_day >= 5 THEN
    RETURN jsonb_build_object('allowed', false,
      'retry_after_seconds', ceil(extract(epoch FROM v_oldest_today + interval '24 hours' - now()))::int);
  END IF;
  INSERT INTO private.account_monitoring_test_sends DEFAULT VALUES RETURNING id INTO v_id;
  RETURN jsonb_build_object('allowed', true, 'slot', v_id);
END;
$$;

-- Records how a test attempt ended.
CREATE FUNCTION public.account_monitoring_record_test(p_slot bigint, p_outcome text, p_channels text[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_slot IS NULL OR p_outcome IS NULL OR p_outcome !~ '^[a-z_]{1,48}$'
     OR NOT (COALESCE(p_channels, '{}') <@ ARRAY['email', 'webhook']) THEN
    RAISE EXCEPTION 'invalid_test_report' USING ERRCODE = '22023';
  END IF;
  UPDATE private.account_monitoring_test_sends
  SET outcome = p_outcome, channels = COALESCE(p_channels, '{}')
  WHERE id = p_slot AND outcome IS NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.account_monitoring_take_test_slot() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.account_monitoring_record_test(bigint, text, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.account_monitoring_take_test_slot() TO service_role;
GRANT EXECUTE ON FUNCTION public.account_monitoring_record_test(bigint, text, text[]) TO service_role;
