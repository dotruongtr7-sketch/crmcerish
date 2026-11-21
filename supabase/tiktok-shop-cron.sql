-- ============================================================
-- CERISH CRM — Lịch tự đồng bộ đơn TikTok Shop mỗi giờ (chạy SAU khi đã deploy Edge Function)
-- 1) Supabase → Database → Extensions: bật pg_cron và pg_net
-- 2) Thay CHUOI_BI_MAT bên dưới bằng đúng giá trị Anh đã đặt cho TTS_CRON_SECRET
--    (chạy trong SQL Editor, KHÔNG gửi chuỗi này cho ai / không lưu vào GitHub)
-- ============================================================
select vault.create_secret('CHUOI_BI_MAT', 'tts_cron_secret');

select cron.schedule('tts-sync-orders', '7 * * * *', $$
  select net.http_post(
    url := 'https://miszniovmycefxtpssyn.supabase.co/functions/v1/tiktok-shop?action=sync',
    headers := jsonb_build_object('Content-Type','application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'tts_cron_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000);
$$);

-- Tắt lịch nếu cần:  select cron.unschedule('tts-sync-orders');
