# Hướng dẫn kết nối TikTok Shop vào CERISH CRM (Giai đoạn 1: đơn hàng)

Làm lần lượt từ trên xuống. Các mã bí mật (App Secret, Service Role Key, chuỗi cron) **chỉ dán vào Supabase**, không gửi qua chat, không lưu vào GitHub.

## Bước 1. Tạo app trên TikTok Shop Partner Center
1. Vào https://partner.tiktokshop.com và đăng ký loại đối tác **Developer** (nhà phát triển), thị trường **Vietnam**. Điền thông tin doanh nghiệp và tải giấy phép kinh doanh lên, sau đó chờ TikTok duyệt.
2. Vào **App & Service**, bấm **Create app** và chọn **Custom app** (app tự dùng cho shop mình).
3. Dán vào ô **Redirect URL** (đường dẫn quay về sau khi uỷ quyền):
   `https://miszniovmycefxtpssyn.supabase.co/functions/v1/tiktok-shop?action=callback`
4. Ở phần **API scopes** (quyền dữ liệu), tick: Shop/Authorization, Order, Product, Finance, và Affiliate (nếu có).
5. Ghi lại 3 mã: **App Key**, **App Secret** và **Service ID**.

> Tên menu trên Partner Center có thể khác đôi chút so với hướng dẫn này. Em chưa xem trực tiếp giao diện bản Việt Nam.

## Bước 2. Chạy SQL tạo bảng
Vào Supabase, mở **SQL Editor**, dán toàn bộ file `supabase/migrations/20261121_tiktok_shop.sql` rồi bấm **Run**.
Bước này chỉ tạo bảng và hàm mới tên `tts_*` / `cerish_tts_*`, không đụng tới dữ liệu cũ.

## Bước 3. Cất mã bí mật vào Supabase Secrets
Vào Supabase, mở **Edge Functions**, chọn **Secrets** và thêm từng dòng:

| Tên | Giá trị |
|---|---|
| `TTS_APP_KEY` | App Key ở Bước 1 |
| `TTS_APP_SECRET` | App Secret ở Bước 1 |
| `TTS_SERVICE_ID` | Service ID ở Bước 1 |
| `TTS_CRON_SECRET` | Anh tự gõ một chuỗi ngẫu nhiên dài (ví dụ 30 ký tự lộn xộn) |

## Bước 4. Đưa hàm máy chủ (Edge Function) lên
**Cách A, bấm trên web (không cần cài gì):**
1. Vào Supabase, mở **Edge Functions**, chọn **Deploy a new function** rồi **Via Editor**.
2. Đặt tên **đúng** là `tiktok-shop`.
3. Xoá mã mẫu, dán toàn bộ file `supabase/functions/tiktok-shop/index.ts`, rồi bấm **Deploy**.
4. Vào phần **Settings** (hoặc Details) của function đó và **tắt** "Enforce JWT verification" (bắt buộc kiểm tra JWT). Lý do: hàm này tự kiểm tra phiên đăng nhập CRM, và TikTok cần gọi được vào link Redirect URL.

**Cách B, dùng dòng lệnh** (nếu có máy đã cài Supabase CLI):
`supabase functions deploy tiktok-shop --no-verify-jwt --project-ref miszniovmycefxtpssyn`

## Bước 5. Kết nối shop
1. Mở crm.cerish.store bằng tài khoản **admin** và vào menu **Đơn TikTok Shop**.
2. Bấm **Kết nối shop TikTok**, đăng nhập tài khoản shop CERISH rồi bấm **Đồng ý / Authorize**.
3. TikTok sẽ đưa Anh quay lại CRM. Bấm **Đồng bộ ngay**. Lần đầu, CRM lấy về đơn của **30 ngày gần nhất**.

## Bước 6. Bật tự đồng bộ mỗi giờ
1. Vào Supabase, mở **Database**, chọn **Extensions** và bật **pg_cron** cùng **pg_net**.
2. Mở **SQL Editor** và dán file `supabase/tiktok-shop-cron.sql`.
3. Thay chữ `CHUOI_BI_MAT` bằng đúng chuỗi Anh đã đặt cho `TTS_CRON_SECRET`, rồi bấm **Run**.

## CRM đọc được gì sau khi kết nối
- **Mỗi đơn:** mã đơn, thời gian đặt và thanh toán, trạng thái (chờ gửi, đang giao, hoàn thành, huỷ...), số tiền khách trả, tiền hàng, phí ship, giảm giá của shop và của sàn, danh sách sản phẩm/SKU kèm số lượng và giá, lý do huỷ.
- **Tổng hợp:** GMV (tổng giá trị đơn, không tính đơn huỷ hoặc chưa thanh toán), số đơn, tỷ lệ huỷ, GMV theo ngày, top sản phẩm.
- **Không lưu:** địa chỉ, số điện thoại, email của người mua.

## Khi có lỗi
- Trang Đơn TikTok Shop hiện dòng lỗi màu đỏ: chụp màn hình gửi em, nhớ che mã bí mật.
- Báo "Chưa cấu hình TTS_APP_KEY": kiểm tra lại Bước 3.
- Báo "Edge Function chưa deploy": kiểm tra lại Bước 4, nhất là tên phải đúng `tiktok-shop`.
