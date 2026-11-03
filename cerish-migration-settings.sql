-- ============================================================
-- CERISH CRM — Migration: quản lý nhân sự & mật khẩu (3/11/2026)
--   1) Thêm hàm xóa nhân sự (cerish_user_delete) — chỉ admin
--   2) Bỏ giới hạn tối thiểu 10 ký tự mật khẩu (chỉ cần không trống)
--   3) Chặn nhân viên đổi mật khẩu — chỉ admin được đổi (cerish_password)
--   (Tất cả chỉ CREATE OR REPLACE hàm cerish_*, không đụng dữ liệu/bảng.)
-- ============================================================

-- 1) Đổi mật khẩu — CHỈ admin, bỏ giới hạn 10 ký tự
create or replace function cerish_password(p_token text, p_current_password text, p_new_password text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare u cerish_users := cerish_session_user(p_token);
begin
  if u.id is null then return jsonb_build_object('ok', false, 'code', 401, 'error', 'Phiên đăng nhập đã hết hạn'); end if;
  if u.role <> 'admin' then return jsonb_build_object('ok', false, 'code', 403, 'error', 'Chỉ quản trị viên được đổi mật khẩu'); end if;
  if length(coalesce(p_new_password,'')) < 1 then return jsonb_build_object('ok', false, 'code', 422, 'error', 'Mật khẩu không được để trống'); end if;
  if u.password_hash <> crypt(coalesce(p_current_password,''), u.password_hash) then
    return jsonb_build_object('ok', false, 'code', 403, 'error', 'Mật khẩu hiện tại chưa đúng');
  end if;
  update cerish_users set password_hash = crypt(p_new_password, gen_salt('bf')) where id = u.id;
  return jsonb_build_object('ok', true);
end; $$;

-- 2) Tạo nhân sự — bỏ giới hạn 10 ký tự (chỉ cần không trống)
create or replace function cerish_user_create(p_token text, p_name text, p_email text, p_password text, p_role text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare u cerish_users := cerish_session_user(p_token); nid bigint; em text := lower(trim(p_email)); nm text := trim(p_name);
begin
  if u.id is null then return jsonb_build_object('ok', false, 'code', 401, 'error', 'Phiên đăng nhập đã hết hạn'); end if;
  if u.role <> 'admin' then return jsonb_build_object('ok', false, 'code', 403, 'error', 'Chỉ quản trị viên có quyền'); end if;
  if nm = '' or length(nm) > 120 or position('@' in em) = 0 or length(em) > 200 then
    return jsonb_build_object('ok', false, 'code', 422, 'error', 'Tên hoặc email chưa hợp lệ'); end if;
  if p_role not in ('admin','manager','staff') then return jsonb_build_object('ok', false, 'code', 422, 'error', 'Vai trò không hợp lệ'); end if;
  if length(coalesce(p_password,'')) < 1 then return jsonb_build_object('ok', false, 'code', 422, 'error', 'Mật khẩu không được để trống'); end if;
  if exists (select 1 from cerish_users where lower(email) = em) then return jsonb_build_object('ok', false, 'code', 409, 'error', 'Email đã có trong hệ thống'); end if;
  nid := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  insert into cerish_users(id, email, name, role, active, password_hash, created_at)
    values (nid, em, nm, p_role, 1, crypt(p_password, gen_salt('bf')), now());
  return jsonb_build_object('ok', true, 'id', nid, 'user', jsonb_build_object(
    'id', nid, 'email', em, 'name', nm, 'role', p_role, 'active', 1, 'created_at', now()));
end; $$;

-- 3) Cập nhật nhân sự (admin reset mật khẩu) — bỏ giới hạn 10 ký tự
create or replace function cerish_user_update(p_token text, p_id bigint, p_data jsonb)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare u cerish_users := cerish_session_user(p_token); t cerish_users;
begin
  if u.id is null then return jsonb_build_object('ok', false, 'code', 401, 'error', 'Phiên đăng nhập đã hết hạn'); end if;
  if u.role <> 'admin' then return jsonb_build_object('ok', false, 'code', 403, 'error', 'Chỉ quản trị viên có quyền'); end if;
  select * into t from cerish_users where id = p_id;
  if t.id is null then return jsonb_build_object('ok', false, 'code', 404, 'error', 'Không có tài khoản'); end if;
  if (p_data ? 'role') and (p_data->>'role') not in ('admin','manager','staff') then
    return jsonb_build_object('ok', false, 'code', 422, 'error', 'Vai trò không hợp lệ'); end if;
  if t.id = u.id and (((p_data ? 'active') and (p_data->>'active') in ('0','false')) or ((p_data ? 'role') and (p_data->>'role') <> 'admin')) then
    return jsonb_build_object('ok', false, 'code', 409, 'error', 'Không thể tự tắt hoặc tự hạ quyền quản trị'); end if;
  if p_data ? 'name' then
    if trim(p_data->>'name') = '' or length(p_data->>'name') > 120 then return jsonb_build_object('ok', false, 'code', 422, 'error', 'Họ tên chưa hợp lệ'); end if;
    update cerish_users set name = trim(p_data->>'name') where id = p_id;
  end if;
  if p_data ? 'role'   then update cerish_users set role = p_data->>'role' where id = p_id; end if;
  if p_data ? 'active' then update cerish_users set active = case when (p_data->>'active') in ('0','false') then 0 else 1 end where id = p_id; end if;
  if (p_data ? 'password') and coalesce(p_data->>'password','') <> '' then
    update cerish_users set password_hash = crypt(p_data->>'password', gen_salt('bf')) where id = p_id;
  end if;
  return jsonb_build_object('ok', true);
end; $$;

-- 4) Xóa nhân sự — chỉ admin, không tự xóa mình, không xóa admin cuối cùng
create or replace function cerish_user_delete(p_token text, p_id bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare u cerish_users := cerish_session_user(p_token); t cerish_users; admin_count int;
begin
  if u.id is null then return jsonb_build_object('ok', false, 'code', 401, 'error', 'Phiên đăng nhập đã hết hạn'); end if;
  if u.role <> 'admin' then return jsonb_build_object('ok', false, 'code', 403, 'error', 'Chỉ quản trị viên có quyền'); end if;
  if p_id = u.id then return jsonb_build_object('ok', false, 'code', 409, 'error', 'Không thể tự xóa tài khoản của mình'); end if;
  select * into t from cerish_users where id = p_id;
  if t.id is null then return jsonb_build_object('ok', false, 'code', 404, 'error', 'Không có tài khoản'); end if;
  if t.role = 'admin' then
    select count(*) into admin_count from cerish_users where role = 'admin' and active = 1;
    if admin_count <= 1 then return jsonb_build_object('ok', false, 'code', 409, 'error', 'Không thể xóa quản trị viên cuối cùng'); end if;
  end if;
  delete from cerish_users where id = p_id;
  return jsonb_build_object('ok', true);
end; $$;

grant execute on function cerish_user_delete(text,bigint) to anon, authenticated;
