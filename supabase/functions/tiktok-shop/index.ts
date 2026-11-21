// CERISH CRM — Edge Function kết nối TikTok Shop (Giai đoạn 1: uỷ quyền + đồng bộ đơn hàng)
// Deploy:  supabase functions deploy tiktok-shop --no-verify-jwt
// Secrets (Supabase → Edge Functions → Secrets):
//   TTS_APP_KEY, TTS_APP_SECRET   — lấy từ TikTok Shop Partner Center (KHÔNG đặt trong HTML)
//   TTS_SERVICE_ID                — Service ID của app (dùng để tạo link uỷ quyền)
//   TTS_CRON_SECRET               — chuỗi ngẫu nhiên, để lịch chạy tự động gọi đồng bộ
//   CRM_URL (tuỳ chọn)            — mặc định https://crm.cerish.store
// SUPABASE_URL & SUPABASE_SERVICE_ROLE_KEY do Supabase tự cấp.
//
// Các action (?action=...):
//   connect  (POST {token})  — admin: trả link uỷ quyền TikTok
//   callback (GET)           — TikTok gọi về sau khi uỷ quyền: đổi code lấy token, lưu shop
//   sync     (POST {token} hoặc header x-cron-secret) — đồng bộ đơn hàng mới/cập nhật

import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const API_BASE = "https://open-api.tiktokglobalshop.com";
const AUTH_BASE = "https://auth.tiktok-shops.com";
const AUTHORIZE_URL = "https://services.tiktokshop.com/open/authorize";

const env = (k: string, d = "") => Deno.env.get(k) ?? d;
const APP_KEY = env("TTS_APP_KEY");
const APP_SECRET = env("TTS_APP_SECRET");
const SERVICE_ID = env("TTS_SERVICE_ID");
const CRON_SECRET = env("TTS_CRON_SECRET");
const CRM_URL = env("CRM_URL", "https://crm.cerish.store").replace(/\/$/, "");
const ALLOWED_ORIGINS = [CRM_URL, "https://crm.cerish.store", "http://localhost:8000"];

const sb = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false },
});

function cors(req: Request): Record<string, string> {
  const o = req.headers.get("origin") ?? "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(o) ? o : CRM_URL,
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Vary": "Origin",
  };
}
function json(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(req), "Content-Type": "application/json" },
  });
}
class Fail extends Error {
  constructor(public code: number, msg: string) { super(msg); }
}

// ---------- Ký request TikTok Shop (HMAC-SHA256) ----------
async function hmacHex(secret: string, msg: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export async function signRequest(path: string, params: Record<string, string>, body: string, secret: string) {
  const keys = Object.keys(params).filter((k) => k !== "sign" && k !== "access_token").sort();
  const base = path + keys.map((k) => k + params[k]).join("") + (body || "");
  return await hmacHex(secret, secret + base + secret);
}

async function ttsCall(method: "GET" | "POST", path: string, query: Record<string, string>,
  bodyObj: unknown, accessToken: string) {
  const params: Record<string, string> = {
    ...query, app_key: APP_KEY, timestamp: String(Math.floor(Date.now() / 1000)),
  };
  const body = bodyObj === undefined ? "" : JSON.stringify(bodyObj);
  params.sign = await signRequest(path, params, body, APP_SECRET);
  const url = API_BASE + path + "?" + new URLSearchParams(params).toString();
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", "x-tts-access-token": accessToken },
    body: method === "POST" ? body : undefined,
  });
  const out = await res.json().catch(() => ({ code: res.status, message: "Phản hồi không hợp lệ" }));
  if (out.code !== 0) throw new Fail(502, `TikTok báo lỗi ${out.code}: ${out.message ?? ""}`);
  return out.data ?? {};
}

// ---------- Token ----------
type TokenData = {
  access_token: string; access_token_expire_in: number;
  refresh_token: string; refresh_token_expire_in: number;
  seller_name?: string; seller_base_region?: string;
};
async function tokenRequest(path: string, extra: Record<string, string>): Promise<TokenData> {
  const q = new URLSearchParams({ app_key: APP_KEY, app_secret: APP_SECRET, ...extra });
  const res = await fetch(`${AUTH_BASE}${path}?${q}`);
  const out = await res.json().catch(() => ({}));
  if (out.code !== 0 || !out.data?.access_token) {
    throw new Fail(502, `Không lấy được mã truy cập TikTok (${out.code ?? res.status}: ${out.message ?? ""})`);
  }
  return out.data;
}
const tsToIso = (s?: number) => (s ? new Date(s * 1000).toISOString() : null);

type ShopRow = {
  shop_id: string; shop_cipher: string; access_token: string; refresh_token: string;
  access_expires_at: string | null; refresh_expires_at: string | null; last_order_sync_at: string | null;
};
async function freshToken(shop: ShopRow): Promise<string> {
  const exp = shop.access_expires_at ? Date.parse(shop.access_expires_at) : 0;
  if (exp - Date.now() > 24 * 3600 * 1000) return shop.access_token;
  const t = await tokenRequest("/api/v2/token/refresh", {
    refresh_token: shop.refresh_token, grant_type: "refresh_token",
  });
  await sb.from("tts_shops").update({
    access_token: t.access_token, access_expires_at: tsToIso(t.access_token_expire_in),
    refresh_token: t.refresh_token, refresh_expires_at: tsToIso(t.refresh_token_expire_in),
    updated_at: new Date().toISOString(),
  }).eq("shop_id", shop.shop_id);
  return t.access_token;
}

// ---------- Phiên CRM ----------
async function whoami(token: string) {
  if (!token) throw new Fail(401, "Vui lòng đăng nhập");
  const { data, error } = await sb.rpc("cerish_tts_whoami", { p_token: token });
  if (error) throw new Fail(500, "Không kiểm tra được phiên: " + error.message);
  if (!data?.ok) throw new Fail(data?.code ?? 401, data?.error ?? "Phiên đăng nhập đã hết hạn");
  return data as { id: number; role: string; name: string };
}
function requireConfig() {
  if (!APP_KEY || !APP_SECRET) {
    throw new Fail(503, "Chưa cấu hình TTS_APP_KEY / TTS_APP_SECRET trong Supabase Secrets");
  }
}

// ---------- Actions ----------
async function connect(token: string) {
  requireConfig();
  const u = await whoami(token);
  if (u.role !== "admin") throw new Fail(403, "Chỉ quản trị viên được kết nối shop");
  if (!SERVICE_ID) throw new Fail(503, "Chưa cấu hình TTS_SERVICE_ID trong Supabase Secrets");
  const state = crypto.randomUUID();
  await sb.from("tts_oauth_states").delete().lt("created_at", new Date(Date.now() - 3600e3).toISOString());
  await sb.from("tts_oauth_states").insert({ state, user_id: u.id });
  return { url: `${AUTHORIZE_URL}?service_id=${encodeURIComponent(SERVICE_ID)}&state=${state}` };
}

async function callback(url: URL) {
  requireConfig();
  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  if (!code) throw new Fail(400, "TikTok không gửi mã uỷ quyền");
  const { data: st } = await sb.from("tts_oauth_states").select("*").eq("state", state).maybeSingle();
  if (!st || Date.now() - Date.parse(st.created_at) > 30 * 60e3) {
    throw new Fail(400, "Link uỷ quyền đã hết hạn hoặc không hợp lệ. Vào CRM bấm Kết nối shop lại.");
  }
  await sb.from("tts_oauth_states").delete().eq("state", state);

  const t = await tokenRequest("/api/v2/token/get", { auth_code: code, grant_type: "authorized_code" });
  const shopsData = await ttsCall("GET", "/authorization/202309/shops", {}, undefined, t.access_token);
  const shops = (shopsData.shops ?? []) as Array<{ id: string; cipher: string; name: string; region: string }>;
  if (!shops.length) throw new Fail(400, "Tài khoản này chưa có shop nào được uỷ quyền");
  for (const s of shops) {
    const { error } = await sb.from("tts_shops").upsert({
      shop_id: s.id, shop_cipher: s.cipher, shop_name: s.name, region: s.region,
      seller_name: t.seller_name ?? null,
      access_token: t.access_token, access_expires_at: tsToIso(t.access_token_expire_in),
      refresh_token: t.refresh_token, refresh_expires_at: tsToIso(t.refresh_token_expire_in),
      connected_by: st.user_id, connected_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }, { onConflict: "shop_id" });
    if (error) throw new Fail(500, "Không lưu được shop: " + error.message);
  }
  return shops.length;
}

const num = (v: unknown) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
// deno-lint-ignore no-explicit-any
function mapOrder(o: any, shopId: string) {
  // Gộp line_items theo SKU (TikTok trả mỗi đơn vị hàng là 1 dòng)
  const grouped = new Map<string, Record<string, unknown>>();
  for (const li of o.line_items ?? []) {
    const k = String(li.sku_id ?? li.product_id ?? li.id);
    const cur = grouped.get(k);
    if (cur) cur.qty = (cur.qty as number) + num(li.quantity ?? 1);
    else grouped.set(k, {
      product_id: li.product_id, product_name: li.product_name, sku_name: li.sku_name,
      seller_sku: li.seller_sku, sale_price: num(li.sale_price), qty: num(li.quantity ?? 1),
    });
  }
  const items = [...grouped.values()];
  const raw = { ...o };
  // Không lưu thông tin cá nhân người mua
  delete raw.recipient_address; delete raw.buyer_email; delete raw.buyer_message;
  delete raw.cpf; delete raw.cpf_name;
  const p = o.payment ?? {};
  return {
    order_id: String(o.id), shop_id: shopId, status: o.status,
    create_time: tsToIso(o.create_time), update_time: tsToIso(o.update_time), paid_time: tsToIso(o.paid_time),
    currency: p.currency ?? null, total_amount: num(p.total_amount), sub_total: num(p.sub_total),
    shipping_fee: num(p.shipping_fee), seller_discount: num(p.seller_discount),
    platform_discount: num(p.platform_discount),
    items_count: items.reduce((a, i) => a + (i.qty as number), 0),
    items, cancel_reason: o.cancel_reason ?? null, raw, synced_at: new Date().toISOString(),
  };
}

const MAX_PAGES_PER_RUN = 40; // 40 × 50 = 2.000 đơn mỗi lần chạy; phần còn lại chạy tiếp lần sau
async function syncShop(shop: ShopRow) {
  const accessToken = await freshToken(shop);
  const nowSec = Math.floor(Date.now() / 1000);
  // Lần đầu lấy 30 ngày gần nhất; các lần sau lùi 10 phút để không sót đơn
  const fromSec = shop.last_order_sync_at
    ? Math.floor(Date.parse(shop.last_order_sync_at) / 1000) - 600
    : nowSec - 30 * 86400;
  let pageToken = "";
  let saved = 0;
  let maxUpdate = fromSec;
  let finished = false;
  for (let page = 0; page < MAX_PAGES_PER_RUN; page++) {
    const q: Record<string, string> = {
      shop_cipher: shop.shop_cipher, page_size: "50", sort_field: "update_time", sort_order: "ASC",
    };
    if (pageToken) q.page_token = pageToken;
    const data = await ttsCall("POST", "/order/202309/orders/search", q,
      { update_time_ge: fromSec, update_time_lt: nowSec }, accessToken);
    const orders = data.orders ?? [];
    if (orders.length) {
      const rows = orders.map((o: unknown) => mapOrder(o, shop.shop_id));
      const { error } = await sb.from("tts_orders").upsert(rows, { onConflict: "order_id" });
      if (error) throw new Fail(500, "Không lưu được đơn: " + error.message);
      saved += rows.length;
      for (const o of orders) maxUpdate = Math.max(maxUpdate, num(o.update_time));
    }
    pageToken = data.next_page_token ?? "";
    if (!pageToken || !orders.length) { finished = true; break; }
  }
  // Hết trang → đã đồng bộ tới "bây giờ"; còn trang → lần sau chạy tiếp từ đơn cuối
  const syncedTo = finished ? nowSec : maxUpdate;
  await sb.from("tts_shops").update({
    last_order_sync_at: new Date(syncedTo * 1000).toISOString(),
    last_sync_run_at: new Date().toISOString(), last_sync_status: "ok",
    last_sync_message: `Đã cập nhật ${saved} đơn${finished ? "" : " (còn tiếp, lần sau chạy nối)"}`,
  }).eq("shop_id", shop.shop_id);
  return { shop_id: shop.shop_id, saved, finished };
}

async function syncAll() {
  requireConfig();
  const { data: shops, error } = await sb.from("tts_shops").select("*");
  if (error) throw new Fail(500, error.message);
  if (!shops?.length) throw new Fail(404, "Chưa có shop nào được kết nối");
  const results = [];
  for (const s of shops as ShopRow[]) {
    try {
      results.push(await syncShop(s));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await sb.from("tts_shops").update({
        last_sync_run_at: new Date().toISOString(), last_sync_status: "error", last_sync_message: msg.slice(0, 500),
      }).eq("shop_id", s.shop_id);
      results.push({ shop_id: s.shop_id, error: msg });
    }
  }
  return results;
}

function htmlPage(title: string, msg: string, ok: boolean) {
  const back = `${CRM_URL}/?tts=${ok ? "ok" : "error"}`;
  const safe = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${safe(title)}</title><body style="font:14px system-ui;background:#efe5dc;color:#261f23;display:grid;place-items:center;min-height:100vh;margin:0">
<div style="background:#fff;padding:32px;border-radius:14px;max-width:440px;text-align:center">
<h2 style="color:#6d425b">${safe(title)}</h2><p>${safe(msg)}</p>
<a href="${back}" style="display:inline-block;margin-top:12px;background:#6d425b;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">Quay lại CERISH CRM</a></div>
${ok ? `<script>setTimeout(()=>location.href=${JSON.stringify(back)},2500)</script>` : ""}</body>`,
    { status: ok ? 200 : 400, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors(req) });
  const url = new URL(req.url);
  const action = url.searchParams.get("action") ?? "";
  try {
    if (action === "callback") {
      try {
        const n = await callback(url);
        return htmlPage("Kết nối thành công 🎉", `Đã kết nối ${n} shop TikTok. Đơn hàng sẽ tự đồng bộ mỗi giờ.`, true);
      } catch (e) {
        return htmlPage("Chưa kết nối được", e instanceof Error ? e.message : String(e), false);
      }
    }
    if (req.method !== "POST") throw new Fail(405, "Phương thức không hợp lệ");
    const body = await req.json().catch(() => ({}));
    if (action === "connect") return json(req, { ok: true, ...(await connect(String(body.token ?? ""))) });
    if (action === "sync") {
      const cron = req.headers.get("x-cron-secret") ?? "";
      if (!(CRON_SECRET && cron === CRON_SECRET)) {
        const u = await whoami(String(body.token ?? ""));
        if (u.role !== "admin" && u.role !== "manager") throw new Fail(403, "Chỉ quản trị/quản lý được đồng bộ");
      }
      return json(req, { ok: true, results: await syncAll() });
    }
    throw new Fail(404, "Action không hợp lệ");
  } catch (e) {
    const code = e instanceof Fail ? e.code : 500;
    return json(req, { ok: false, code, error: e instanceof Error ? e.message : String(e) }, code >= 400 && code < 600 ? code : 500);
  }
});
