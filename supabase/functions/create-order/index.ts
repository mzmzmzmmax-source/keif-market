import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "npm:@supabase/server@1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "https://mzmzmzmmax-source.github.io",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default {
  fetch: withSupabase(
    { auth: "publishable" },
    async (req, ctx) => {
      if (req.method === "OPTIONS") {
        return new Response("ok", { headers: corsHeaders });
      }
      if (req.method !== "POST") {
        return jsonResponse({ error: "Method not allowed" }, 405);
      }

      try {
        // Bound request size before JSON parsing.
        const contentLength = Number(req.headers.get("content-length") || "0");
        if (contentLength > 64 * 1024) {
          return jsonResponse({ error: "درخواست بیش از حد بزرگ است." }, 413);
        }

        const rawBody = await req.text();
        if (new TextEncoder().encode(rawBody).byteLength > 64 * 1024) {
          return jsonResponse({ error: "درخواست بیش از حد بزرگ است." }, 413);
        }

        const body = JSON.parse(rawBody);
        if (
          !body ||
          typeof body !== "object" ||
          !body.customer ||
          typeof body.customer !== "object" ||
          !Array.isArray(body.items)
        ) {
          return jsonResponse({ error: "اطلاعات سفارش نامعتبر است." }, 400);
        }

        const idempotencyKey = body.idempotency_key;
        if (typeof idempotencyKey !== "string" || !UUID_V4.test(idempotencyKey)) {
          return jsonResponse({ error: "شناسه درخواست سفارش معتبر نیست." }, 400);
        }

        const payload = {
          customer: body.customer,
          items: body.items,
        };

        const { data, error } = await ctx.supabaseAdmin.rpc(
          "create_store_order_api",
          {
            payload,
            p_idempotency_key: idempotencyKey,
          },
        );

        if (error) {
          // Keep database details in server logs only.
          console.error("Order creation failed:", error.message);
          return jsonResponse(
            { error: "ثبت سفارش انجام نشد. اطلاعات را بررسی کنید." },
            400,
          );
        }

        return jsonResponse({
          success: true,
          order_id: data,
          message: "سفارش با موفقیت ثبت شد.",
        });
      } catch (error) {
        console.error("Unexpected order request error:", error);
        return jsonResponse(
          { error: "خطای غیرمنتظره در ثبت سفارش." },
          500,
        );
      }
    },
  ),
};
