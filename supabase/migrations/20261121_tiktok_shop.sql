-- ============================================================
-- CERISH CRM — Migration: Kết nối TikTok Shop (Giai đoạn 1: đơn hàng) — 21/11/2026
--   Chạy 1 lần trong Supabase → SQL Editor. Chỉ TẠO MỚI bảng/hàm tts_*, không đụng dữ liệu cũ.
--   - tts_shops        : shop đã uỷ quyền + mã truy cập (CHỈ Edge Function đọc được)
--   - tts_oauth_states : mã chống giả mạo khi bấm "Kết nối shop"
--   - tts_orders       : đơn hàng đồng bộ từ TikTok Shop (không lưu địa chỉ/SĐT người mua)
--   Trình duyệt chỉ đọc qua 2 hàm cerish_tts_status / cerish_tts_orders (kiểm tra phiên đăng nhập CRM).
-- ============================================================

create table if not exists tts_shops (
  shop_id              text primary key,
  shop_cipher          text not null,
  shop_name            text,
  region               text,
  seller_name          text,
  access_token         text not null,
  access_expires_at    timestamptz,
  refresh_token        text not null,
  refresh_expires_at   timestamptz,
  connected_by         bigint,
  connected_at         timestamptz default now(),
  last_order_sync_at   timestamptz,          -- mốc update_time đã đồng bộ tới
  last_sync_run_at     timestamptz,
  last_sync_status     text,                 -- ok | error
  last_sync_message    text,
  updated_at           timestamptz default now()
);

create table if not exists tts_oauth_states (
  state       text primary key,
  user_id     bigint,
  created_at  timestamptz default now()
);

create table if not exists tts_orders (
  order_id           text primary key,
  shop_id            text references tts_shops(shop_id) on delete cascade,
  status             text,
  create_time        timestamptz,
  update_time        timestamptz,
  paid_time          timestamptz,
  currency           text,
  total_amount       numeric default 0,   -- khách trả
  sub_total          numeric default 0,   -- tiền hàng sau giảm giá
  shipping_fee       numeric default 0,
  seller_discount    numeric default 0,
  platform_discount  numeric default 0,
  items_count        int default 0,
  items              jsonb default '[]'::jsonb,   -- [{product_id, product_name, sku_name, seller_sku, sale_price, qty}]
  cancel_reason      text,
  raw                jsonb,                       -- bản gốc đã bỏ thông tin cá nhân người mua
  synced_at          timestamptz default now()
);
create index if not exists tts_orders_create_idx on tts_orders(create_time desc);
create index if not exists tts_orders_status_idx on tts_orders(status);

-- Khoá bảng: bật RLS, không tạo policy → anon/publishable key KHÔNG đọc được. Edge Function dùng service role.
alter table tts_shops enable row level security;
alter table tts_oauth_states enable row level security;
alter table tts_orders enable row level security;
revoke all on tts_shops, tts_oauth_states, tts_orders from anon, authenticated;

-- Edge Function gọi hàm này để biết token CRM thuộc ai (chỉ service_role được gọi)
create or replace function cerish_tts_whoami(p_token text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare u cerish_users := cerish_session_user(p_token);
begin
  if u.id is null then return jsonb_build_object('ok', false, 'code', 401, 'error', 'Phiên đăng nhập đã hết hạn'); end if;
  return jsonb_build_object('ok', true, 'id', u.id, 'role', u.role, 'name', u.name);
end; $$;
revoke execute on function cerish_tts_whoami(text) from public, anon, authenticated;
grant execute on function cerish_tts_whoami(text) to service_role;

-- Trạng thái kết nối (mọi tài khoản đăng nhập được xem; KHÔNG trả token)
create or replace function cerish_tts_status(p_token text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare u cerish_users := cerish_session_user(p_token);
begin
  if u.id is null then return jsonb_build_object('ok', false, 'code', 401, 'error', 'Phiên đăng nhập đã hết hạn'); end if;
  return jsonb_build_object('ok', true, 'role', u.role,
    'shops', coalesce((select jsonb_agg(jsonb_build_object(
        'shop_id', shop_id, 'shop_name', shop_name, 'region', region, 'seller_name', seller_name,
        'connected_at', connected_at, 'refresh_expires_at', refresh_expires_at,
        'last_sync_run_at', last_sync_run_at, 'last_sync_status', last_sync_status,
        'last_sync_message', last_sync_message, 'last_order_sync_at', last_order_sync_at) order by connected_at)
      from tts_shops), '[]'::jsonb),
    'orders_total', (select count(*) from tts_orders));
end; $$;
grant execute on function cerish_tts_status(text) to anon, authenticated;

-- Danh sách đơn + tổng hợp theo khoảng ngày (ngày tính theo giờ Việt Nam)
create or replace function cerish_tts_orders(p_token text, p_from date default null, p_to date default null,
                                             p_status text default null, p_search text default null,
                                             p_limit int default 50, p_offset int default 0)
returns jsonb language plpgsql security definer set search_path = public as $$
declare u cerish_users := cerish_session_user(p_token);
        lim int := least(greatest(coalesce(p_limit,50),1),200);
        res jsonb;
begin
  if u.id is null then return jsonb_build_object('ok', false, 'code', 401, 'error', 'Phiên đăng nhập đã hết hạn'); end if;
  with f as (
    select * from tts_orders o
    where (p_from is null or (o.create_time at time zone 'Asia/Ho_Chi_Minh')::date >= p_from)
      and (p_to   is null or (o.create_time at time zone 'Asia/Ho_Chi_Minh')::date <= p_to)
  ), fs as (
    select * from f
    where (coalesce(p_status,'') = '' or f.status = p_status)
      and (coalesce(p_search,'') = '' or f.order_id ilike '%'||p_search||'%'
           or exists (select 1 from jsonb_array_elements(f.items) it
                      where it->>'product_name' ilike '%'||p_search||'%' or it->>'seller_sku' ilike '%'||p_search||'%'))
  )
  select jsonb_build_object('ok', true,
    'summary', (select jsonb_build_object(
        'orders', count(*),
        'gmv', coalesce(sum(total_amount) filter (where status not in ('CANCELLED','UNPAID')),0),
        'valid_orders', count(*) filter (where status not in ('CANCELLED','UNPAID')),
        'cancelled', count(*) filter (where status = 'CANCELLED'),
        'unpaid', count(*) filter (where status = 'UNPAID'),
        'completed', count(*) filter (where status in ('COMPLETED','DELIVERED')),
        'units', coalesce(sum(items_count) filter (where status not in ('CANCELLED','UNPAID')),0)) from f),
    'by_status', (select coalesce(jsonb_object_agg(status, c),'{}'::jsonb) from (select status, count(*) c from f group by status) s),
    'by_day', (select coalesce(jsonb_agg(jsonb_build_object('day', d, 'orders', c, 'gmv', g) order by d),'[]'::jsonb) from (
        select (create_time at time zone 'Asia/Ho_Chi_Minh')::date d, count(*) c,
               coalesce(sum(total_amount) filter (where status not in ('CANCELLED','UNPAID')),0) g
        from f group by 1) x),
    'top_products', (select coalesce(jsonb_agg(t order by (t->>'gmv')::numeric desc),'[]'::jsonb) from (
        select jsonb_build_object('product_name', it->>'product_name', 'units', sum(coalesce((it->>'qty')::int,1)),
               'gmv', sum(coalesce((it->>'sale_price')::numeric,0)*coalesce((it->>'qty')::int,1))) t
        from f, jsonb_array_elements(f.items) it
        where f.status not in ('CANCELLED','UNPAID')
        group by it->>'product_name'
        order by sum(coalesce((it->>'sale_price')::numeric,0)*coalesce((it->>'qty')::int,1)) desc limit 10) y),
    'total', (select count(*) from fs),
    'rows', (select coalesce(jsonb_agg(jsonb_build_object(
        'order_id', order_id, 'status', status, 'create_time', create_time, 'paid_time', paid_time,
        'total_amount', total_amount, 'currency', currency, 'items_count', items_count,
        'items', items, 'cancel_reason', cancel_reason) order by create_time desc),'[]'::jsonb)
      from (select * from fs order by create_time desc limit lim offset greatest(coalesce(p_offset,0),0)) r)
  ) into res;
  return res;
end; $$;
grant execute on function cerish_tts_orders(text,date,date,text,text,int,int) to anon, authenticated;
