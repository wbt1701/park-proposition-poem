# 공원에서 쓰는 명제 시 🌳

고1 수학 「집합과 명제」 야외수업용 웹앱입니다. 학생은 휴대폰으로 공원 사진을 찍고 **명제 → 역·대우 → 참·거짓 판별 → 명제 시**를 써서 반 전체와 익명으로 나눕니다. 교사는 노트북의 `teacher.html`에서 학번·이름과 함께 결과를 봅니다.

- 빌드 과정 없는 정적 파일 (HTML/CSS/JS) → GitHub Pages로 배포
- Supabase: Database · Storage(사진) · Auth(학생 익명 로그인, 교사 이메일 로그인) · Realtime

```
index.html          학생 화면 (입장 → 1·2·3단계 → 갤러리)
teacher.html        교사 화면 (제출 목록, 상세, 숨기기·삭제, CSV)
config.js           ← Supabase 주소와 anon 키를 넣는 유일한 파일
css/style.css
js/common.js        공통 도구 (사진 압축, "p이면 q이다" 문장 만들기 등)
js/student.js
js/teacher.js
supabase/setup.sql        테이블·RLS·뷰·Realtime·Storage를 한 번에 설정
supabase/sample-data.sql  테스트용 예시 글 4편
```

---

## 1. Supabase 프로젝트 만들기

1. <https://supabase.com> 로그인 → **New project**
2. 이름(예: `park-proposition-poem`), 데이터베이스 비밀번호(안전한 곳에 보관), 지역 **Northeast Asia (Seoul)** 선택 → **Create**
3. 1~2분 기다리면 프로젝트가 준비됩니다.

> 무료 요금제는 활성 프로젝트가 2개까지입니다. 이미 2개가 있으면 안 쓰는 프로젝트를 일시정지(Pause)하세요.

## 2. 익명 로그인 켜기

1. 왼쪽 메뉴 **Authentication → Sign In / Providers**
2. **Allow anonymous sign-ins** 켜기 → **Save**
3. (중요) **Authentication → Rate Limits** 에서 *Anonymous sign-ins* 한도를 **시간당 100 이상**으로 올리세요.
   기본값은 IP당 시간당 30회라서, 학교 와이파이처럼 한 IP로 30명 넘게 들어오면 막힐 수 있습니다.

## 3. SQL 실행

1. 왼쪽 메뉴 **SQL Editor → New query**
2. `supabase/setup.sql` 내용을 전부 붙여 넣고 **Run**
3. `Success. No rows returned` 가 나오면 완료. (여러 번 실행해도 괜찮습니다)

만들어지는 것

| 이름 | 내용 | 누가 읽나 |
|---|---|---|
| `posts` | 사진 주소, p, q, 원래 명제, 역, 대우, 참·거짓, 이유/반례, 제목, 시, 사용한 문장, 숨김 | 로그인한 학생(숨긴 글 제외), 교사(전체) |
| `authors` | 익명 ID ↔ **학번·이름** | **교사만** |
| `likes` | 누가 어떤 글에 좋아요 (글·사람당 1번) | 로그인한 사람 |
| `teachers` | 교사 계정 목록 | 교사만 |
| `post_list` (뷰) | 글 목록 + 좋아요 수 (정렬용) | 부르는 사람의 권한 그대로 |
| `photos` (버킷) | 사진. 공개 읽기, 자기 폴더에만 업로드 | 누구나(주소를 아는 경우) |

## 4. 교사 계정 등록 (비밀번호 하나로 로그인)

교사 화면은 **비밀번호만** 입력합니다. 안에서는 `config.js` 의 `TEACHER_LOGIN_EMAIL`
(기본값 `park-poem-teacher@example.com`, 메일이 오지 않는 예약 주소) 계정으로 로그인합니다.

1. **Authentication → Users → Add user → Create new user**
   - Email: `park-poem-teacher@example.com` (config.js 와 똑같이)
   - Password: 교사용 비밀번호
   - **Auto Confirm User** 체크 → **Create user**
2. **SQL Editor** 에서 아래를 실행

```sql
insert into public.teachers (user_id, email)
select id, email from auth.users where email = 'park-poem-teacher@example.com'
on conflict (user_id) do nothing;
```

3. 확인: `select * from public.teachers;` 에 한 줄이 나오면 됩니다.

> 교사 권한은 `teachers` 표에 있는 계정에만 생깁니다. 다른 사람이 가입해도 교사 화면은 열리지 않습니다.
> 로그인 주소가 공개 코드에 있으므로 **비밀번호만이 유일한 보호막**입니다. 길고 추측하기 어렵게 정하고, 학생에게 보이지 않게 하세요.
> 비밀번호를 바꾸려면 Authentication → Users → 해당 계정 → 비밀번호 변경(Reset/Update password).

## 5. config.js 채우기

**Project Settings → API Keys** (또는 **Data API**) 에서

- **Project URL** → `SUPABASE_URL`
- **anon public** 키 또는 **publishable** 키(`sb_publishable_...`) → `SUPABASE_ANON_KEY`

```js
window.APP_CONFIG = {
  SUPABASE_URL: "https://abcdefghijk.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_xxxxxxxx",
};
```

> ⚠ **service_role / secret 키는 절대 넣지 마세요.** 이 파일은 누구나 볼 수 있습니다. 실수로 넣으면 앱이 실행을 멈추고 경고를 띄웁니다.
> anon 키는 공개되어도 괜찮도록 설계되어 있고, 실제 보호는 RLS 정책이 합니다.

## 6. GitHub 저장소에 올리기

PowerShell 또는 Git Bash 에서 (GitHub CLI `gh` 사용 시)

```bash
cd park-proposition-poem
git init -b main
git add .
git commit -m "공원에서 쓰는 명제 시 첫 버전"
gh repo create park-proposition-poem --public --source . --push
```

`gh` 가 없으면 github.com 에서 **New repository**(Public)를 만든 뒤 안내에 나오는 `git remote add origin ...` / `git push -u origin main` 을 실행합니다.

> GitHub Pages 무료 요금제는 **공개(Public) 저장소**에서만 동작합니다. 저장소에는 비밀값이 없어야 합니다(anon 키는 괜찮음).

## 7. GitHub Pages 배포

1. 저장소 **Settings → Pages**
2. **Source: Deploy from a branch**, **Branch: `main` / `(root)`** → **Save**
3. 1~2분 뒤 주소가 나옵니다: `https://<아이디>.github.io/park-proposition-poem/`
   - 학생용: 위 주소 (QR코드로 만들어 나눠 주세요)
   - 교사용: 위 주소 + `teacher.html`

코드를 고친 뒤에는 `git add . && git commit -m "수정" && git push` 만 하면 자동으로 다시 배포됩니다.

## 8. 테스트용 예시 글 넣기 (3~4편)

**방법 A — SQL로 한 번에 (추천)**
SQL Editor 에서 `supabase/sample-data.sql` 을 실행하면 예시 학생 4명(학번 99901~99904)과 시 4편, 좋아요 몇 개가 들어갑니다.
수업 전에 파일 맨 아래의 지우기 문장을 실행하면 깨끗하게 지워집니다.

```sql
delete from auth.users where id::text like '00000000-0000-4000-8000-00000000000%';
```

**방법 B — 앱으로 직접**
휴대폰이나 PC 브라우저의 **시크릿 창**을 3~4개 열어 각각 다른 학번(예: 99901, 99902…)으로 입장해 글을 씁니다. 시크릿 창마다 다른 익명 학생으로 처리됩니다. 시험 후에는 교사 화면에서 삭제하세요.

---

## 수업 때 알아 둘 것

- **새로고침해도 이어서 쓸 수 있습니다.** 입력 중인 내용은 휴대폰에 자동 저장됩니다.
- **같은 휴대폰·같은 브라우저**에서만 자기 시를 고칠 수 있습니다. 브라우저 기록을 지우거나 다른 폰으로 들어오면 새 학생으로 처리됩니다(교사 화면에 같은 학번이 두 번 보일 수 있음).
- 학생은 **자기 시를 공유한 뒤에** 갤러리를 볼 수 있습니다(베끼기 방지).
- 교사가 숨긴 글은 다른 학생 갤러리에서 사라집니다(최대 30초 안에 반영). 작성 학생 본인에게는 "선생님이 숨김"으로 보입니다.
- 사진은 업로드 전에 가로 1280px 이하 JPEG로 줄여서 올라갑니다(보통 200~500KB).
- 사진 버킷은 공개입니다. 숨기거나 지운 글의 사진도 **주소를 아는 사람**은 볼 수 있으니, 부적절한 글은 숨기기보다 **삭제**를 쓰세요(삭제하면 사진도 지워집니다).

## 익명 처리와 보안 구조

- `posts` 에는 학번·이름이 없습니다. 학생 화면은 `posts`, `post_list`, `likes` 만 읽고, 여기에는 익명 로그인 ID(무작위 UUID)만 있습니다.
- 학번·이름은 `authors` 에만 있고, **읽기 정책이 교사 전용**입니다. 학생은 `register_author()` 함수로 자기 행만 쓸 수 있고 읽을 수는 없습니다. 개발자 도구로 API를 직접 불러도 다른 학생 정보는 0건이 나옵니다.
- 학생이 `hidden`(숨김)·`user_id`·작성 시각을 바꾸려 해도 서버 트리거가 원래 값으로 되돌립니다.
- 글의 사진 주소는 자기 폴더(`photos/<내 ID>/...`)의 파일만 허용합니다.
- 비로그인(anon) 역할은 모든 테이블에 접근할 수 없습니다.
- RLS 기준 문서: <https://supabase.com/docs/guides/database/postgres/row-level-security>

## 문제 해결

| 증상 | 확인할 것 |
|---|---|
| "config.js 에 Supabase 주소와 anon 키를 넣어 주세요" | 5단계. 저장 후 push 했는지 |
| "익명 로그인이 꺼져 있어요" | 2단계 Allow anonymous sign-ins |
| "접속이 몰렸어요" | 2단계 Rate Limits 올리기 |
| 교사 로그인 후 "교사로 등록되지 않은 계정" | 4단계 `teachers` 에 넣었는지 |
| 사진 업로드 실패 | setup.sql 의 Storage 부분이 실행됐는지, 사진이 5MB 이하 이미지인지 |
| 좋아요 수가 바로 안 바뀜 | Database → Publications → `supabase_realtime` 에 posts, likes 가 있는지 |
