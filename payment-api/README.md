# Kif Market Payment API

This is a reference Node.js API for the Zarinpal integration. It is intentionally isolated from the current cPanel app and must not be copied over the live `app.js` until a backup and Sandbox validation are complete.

## Runtime
- Node.js 20+ (current cPanel runtime: Node 24)
- No third-party npm dependencies; uses built-in `http` and `fetch`.
- Startup file when deliberately deployed: `app.js`.

## Environment variables
Set these only in cPanel's Node.js application environment. Never commit real values.

- `SUPABASE_URL`: Supabase project URL.
- `SUPABASE_SERVICE_ROLE_KEY`: secret service-role key; server only.
- `ZARINPAL_MERCHANT_ID`: merchant ID from the adult account holder's gateway.
- `ZARINPAL_BASE_URL`: use `https://sandbox.zarinpal.com` for testing; production host is `https://payment.zarinpal.com`.
- `API_PUBLIC_URL`: exact public API origin, e.g. `https://api.kif-market.ir`.
- `SITE_ORIGIN`: website origin. Defaults to `https://mzmzmzmmax-source.github.io`.
- `ZARINPAL_VERIFY_UNIT`: deliberately has no default. Set to `rial` or `toman` only after the request/verify unit behavior is proven in Sandbox or confirmed in writing by Zarinpal.

## Routes
- `GET /health`
- `GET /ip-check`
- `POST /payments/create` with `order_id`, `idempotency_key`, and the order's `customer_phone`.
- `GET /payments/zarinpal/callback` (gateway callback).
- `GET /payments/status?order_id=...` (returns payment status only; never customer details).

## Important business rule
The online amount is `orders.subtotal` (product total in Toman). Shipping is postpaid and must not be added to the gateway amount.

## Before deployment
1. Apply the SQL migration only to a Supabase development branch and validate grants/RLS/function behavior.
2. Test Request with `currency=IRT` and amount in Toman.
3. Confirm the amount unit for Verify; the supplied docs are ambiguous across Request and Verify.
4. Test duplicate callbacks, callback with NOK, interrupted callback, and already-verified response.
5. Confirm the exact callback domain is registered in the Zarinpal panel.
6. Back up the existing cPanel `app.js`; do not replace it until the current contents are reviewed.
7. Never put the service-role key or merchant secret in frontend code or GitHub.

The API intentionally does not mark an order paid from the browser's return URL or the gateway's `Status=OK` parameter. Only server-side Verify code 100 calls the database completion function. Code 101 is held for reconciliation unless the database already recorded the payment as verified.
