-- کیف مارکت: idempotent order API wrapper
-- Apply only after confirming the existing orders columns and create_store_order signature.
-- This creates a new overload; the currently deployed one-argument wrapper remains untouched.

BEGIN;

CREATE OR REPLACE FUNCTION public.create_store_order_api(
  payload jsonb,
  p_idempotency_key uuid
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_fingerprint text;
  v_existing_id bigint;
  v_existing_fingerprint text;
  v_order_id bigint;
  v_updated integer;
BEGIN
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'idempotency key is required'
      USING ERRCODE = '22023';
  END IF;

  IF payload IS NULL
     OR pg_catalog.jsonb_typeof(payload) IS DISTINCT FROM 'object'
     OR pg_catalog.jsonb_typeof(payload -> 'customer') IS DISTINCT FROM 'object'
     OR pg_catalog.jsonb_typeof(payload -> 'items') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'invalid order payload'
      USING ERRCODE = '22023';
  END IF;

  v_fingerprint := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(payload::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  -- Serialize concurrent requests that carry the same idempotency key.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_idempotency_key::text, 0)
  );

  SELECT o.id, o.request_fingerprint
    INTO v_existing_id, v_existing_fingerprint
  FROM public.orders AS o
  WHERE o.idempotency_key = p_idempotency_key
  FOR UPDATE;

  IF FOUND THEN
    IF v_existing_fingerprint IS DISTINCT FROM v_fingerprint THEN
      RAISE EXCEPTION 'idempotency key reused with different order data'
        USING ERRCODE = '22023';
    END IF;

    RETURN v_existing_id;
  END IF;

  -- Preserve the existing, already-tested stock/order transaction.
  v_order_id := public.create_store_order(
    payload -> 'customer',
    payload -> 'items'
  );

  UPDATE public.orders
     SET idempotency_key = p_idempotency_key,
         request_fingerprint = v_fingerprint
   WHERE id = v_order_id;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 1 THEN
    RAISE EXCEPTION 'could not attach idempotency identity to order'
      USING ERRCODE = '23514';
  END IF;

  RETURN v_order_id;
END;
$function$;

ALTER FUNCTION public.create_store_order_api(jsonb, uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.create_store_order_api(jsonb, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_store_order_api(jsonb, uuid)
  TO service_role;

COMMIT;
