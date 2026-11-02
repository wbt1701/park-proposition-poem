// =====================================================================
// Supabase 연결 정보 — 이 파일만 고치면 됩니다.
//   Supabase 대시보드 → Project Settings → API (또는 Data API / API Keys)
//   - SUPABASE_URL      : Project URL  (예: https://abcdefgh.supabase.co)
//   - SUPABASE_ANON_KEY : anon public 키 또는 publishable 키 (sb_publishable_...)
//
// ⚠ service_role 키 / secret 키(sb_secret_...)는 절대 넣지 마세요.
//   이 파일은 누구나 볼 수 있는 공개 파일입니다. 넣으면 앱이 실행을 거부합니다.
// =====================================================================
window.APP_CONFIG = {
  SUPABASE_URL: "https://wxsakturiapojlckjeac.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_UFiXRNW8GCuRp9l5ZBlgbQ_d0FohMCN",

  // 교사 화면은 비밀번호만 입력. 안에서는 이 고정 주소의 계정으로 로그인합니다.
  // (Supabase → Authentication → Users 에 이 주소로 교사 계정을 만들어 두세요. 메일은 오지 않는 주소입니다)
  TEACHER_LOGIN_EMAIL: "park-poem-teacher@example.com",
};
