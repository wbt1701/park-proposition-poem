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
2. **Allow new users to sign up** 과 **Allow anonymous sign-ins** 를 **둘 다** 켜기 → **Save**
   (가입 허용이 꺼져 있으면 익명 로그인도 막힙니다. 이메일 가입자가 생겨도 교사 권한은 없으니 괜찮습니다)
3. (중요) **Authentication → Rate Limits** 에서 *Anonymous sign-ins* 한도를 **시간당 100 이상**으로 올리세요.
   기본값은 IP당 시간당 30회라서, 학교 와이파이처럼 한 IP로 30명 넘게 들어오면 막힐 수 있습니다.

## 3. SQL 실행

1. 왼쪽 메뉴 **SQL Editor → New query**
2. `supabase/setup.sql` 내용을 전부 붙여 넣고 **Run**
3. `Success. No rows returned` 가 나오면 완료. (여러 번 실행해도 괜찮습니다)
4. 이어서 `supabase/mission.sql`(보물찾기 미션·AI 사용 여부), `supabase/class-gallery.sql`(반별 갤러리), `supabase/mission-relocate.sql`(마감 시 자동 재배정) 순서로 같은 방법으로 실행
5. 보물찾기 문제는 `supabase/mission-puzzles.local.sql` 로 넣습니다.
   - 이 파일은 공개 저장소에 올리지 않습니다(`.gitignore` 의 `*.local.sql`).
   - 장소와 문제가 함께 공개되면 학생이 풀지 않고도 답을 알 수 있기 때문입니다.
   - 새로 설치할 때는 교사가 이 파일을 따로 보관해 두었다가 실행하세요.

만들어지는 것

| 이름 | 내용 | 누가 읽나 |
|---|---|---|
| `posts` | 사진 주소, p, q, 원래 명제, 역, 대우, 참·거짓, 이유/반례, 제목, 시, 사용한 문장, 숨김 | 로그인한 학생(숨긴 글 제외), 교사(전체) |
| `authors` | 익명 ID ↔ **학번·이름** | **교사만** |
| `likes` | 누가 어떤 글에 좋아요 (글·사람당 1번) | 로그인한 사람 |
| `teachers` | 교사 계정 목록 | 교사만 |
| `post_list` (뷰) | 글 목록 + 좋아요 수 (정렬용) | 부르는 사람의 권한 그대로 |
| `photos` (버킷) | 사진. 공개 읽기, 자기 폴더에만 업로드 | 누구나(주소를 아는 경우) |

## 4. 교사 비밀번호 정하기 (교사 계정 없음)

교사 화면은 **비밀번호 하나만** 입력합니다. 교사 화면도 익명 로그인한 뒤,
비밀번호가 맞으면 그 접속에 **12시간 동안** 교사 권한을 줍니다(로그아웃하면 바로 사라짐).

- 비밀번호는 원문이 아니라 `salt + sha256` 해시로만 `private.teacher_secret`(API로 볼 수 없는 곳)에 저장됩니다.
- 틀린 시도는 한 접속당 10분에 5번, 전체 10분에 30번까지만 받고 잠깁니다.

**비밀번호 정하기·바꾸기** — 원문이 SQL 기록에 남지 않도록 해시를 내 컴퓨터에서 만든 뒤 넣습니다.

1. 내 컴퓨터(Node.js 설치됨)에서 실행하고, 물어보면 새 비밀번호를 입력

```bash
node -e "const c=require('crypto'),r=require('readline').createInterface({input:process.stdin,output:process.stdout});r.question('새 교사 비밀번호: ',p=>{const s=c.randomBytes(16).toString('hex');console.log(\"select private.set_teacher_password_hash('\"+s+\"', '\"+c.createHash('sha256').update(s+p).digest('hex')+\"');\");r.close()})"
```

2. 출력된 `select private.set_teacher_password_hash(...)` 한 줄을 **SQL Editor** 에 붙여 넣고 **Run**
3. 바꾸면 이미 들어와 있던 교사 화면은 모두 로그아웃됩니다.

> 교사 화면에는 학생들의 학번·이름이 있습니다. **비밀번호만이 보호막**이니 길고 추측하기 어렵게 정하고, 수업 중 학생에게 보이지 않게 하세요.
> (예전 방식처럼 이메일 계정을 `teachers` 표에 직접 넣어도 교사로 인정됩니다.)

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

## 9. 보물찾기 비밀 미션

**미션 대상:** 사진을 올렸고, 시 본문이 **5줄 이상**(빈 줄 제외)이며, 선생님이 숨기지 않은 글의 학생.
- 대상 학생에게만 갤러리 위에 **🎁 비밀 미션이 도착했어요!** 버튼이 생깁니다(대상이 아니면 아무 안내도 없음).
- 나중에 시를 고쳐 조건을 채우면 그때 버튼이 생깁니다.

**흐름**
1. 학생이 버튼을 처음 누르면 마감되지 않은 장소 중 하나가 무작위로 배정됩니다. 다시 뽑을 수 없습니다.
2. 동물 다섯 마리의 말(두 마리는 거짓말)을 보고 장소를 추리해 찾아갑니다.
3. 봉투 속 확인 코드를 입력합니다.
   - 맞으면 큰 **🎉 보물 획득 성공!** 화면(학번 끝 두 자리, 획득 시각)이 나오고, 다시 들어와도 유지됩니다.
   - 다른 장소의 코드면 "이 보물은 당신의 보물이 아니에요", 없는 코드면 "코드를 다시 확인해 주세요".
   - 10분에 10번 넘게 틀리면 잠시 잠깁니다.

**수업 전 준비 (교사 화면 → 🎁 장소 관리 탭)**
- 장소 5곳마다 봉투에 넣을 **확인 코드**를 입력하고 [저장]합니다.
  - 장소마다 달라야 하고, 대소문자·띄어쓰기는 구분하지 않습니다.
  - 예: 짐작하기 어렵게 `K7Q2` 처럼 정하세요.
- 장소를 **[마감]** 하면 새로 배정되지 않고, 이미 배정됐지만 **아직 못 찾은 학생은 열린 장소로 자동으로 바뀝니다**(학생 화면에 크게 "📍 장소가 변경되었습니다!", 20초 안에 반영). 이미 찾은 학생은 그대로입니다.
- 장소가 모두 마감이면 학생에게 "🔒 보물찾기가 모두 마감되었습니다."가 나오고 문제는 보이지 않습니다. 장소를 다시 열면 기다리던 학생이 그 장소로 옮겨집니다.

**제출 목록 표에 추가된 열:** AI 사용, 미션 대상, 배정 장소, 획득, 획득 시각, 상품 지급(체크)
- 배정 장소 칸에서 학생의 장소를 바꿀 수 있습니다. 바꾸면 그 학생의 획득 기록은 지워집니다.
- CSV와 학생별 PDF에도 같은 내용이 들어갑니다.

**보안**
- `locations`(장소·코드·문제)와 `assignments`(배정·획득)는 학생이 직접 읽을 수 없습니다.
- 학생은 함수 두 개(`get_or_assign_mission`, `submit_confirm_code`)로만 미션을 진행하며, 장소 이름·코드·ID는 응답에 들어가지 않습니다.

## 수업 때 알아 둘 것
- 시 쓰기 마지막에 **AI 사용 여부**(사용하지 않았어요 / 사용했어요)를 반드시 고르게 되어 있습니다. 이 기능 전에 쓴 글은 교사 화면에 "-"로 보입니다.

- **새로고침해도 이어서 쓸 수 있습니다.** 입력 중인 내용은 휴대폰에 자동 저장됩니다.
- **같은 휴대폰·같은 브라우저**에서만 자기 시를 고칠 수 있습니다. 브라우저 기록을 지우거나 다른 폰으로 들어오면 새 학생으로 처리됩니다(교사 화면에 같은 학번이 두 번 보일 수 있음).
- 학생은 **자기 시를 공유한 뒤에** 갤러리를 볼 수 있습니다(베끼기 방지).
- 갤러리는 **반별**입니다. 학번 앞 3자리(예: 10305 → 1학년 3반)가 같은 학생의 시만 보입니다. 서버(RLS)가 막으므로 다른 반 글은 개발자 도구로도 볼 수 없습니다. 교사 화면은 전체가 보이고, 위쪽 "전체 반" 상자로 반별로 골라 볼 수 있습니다(CSV도 고른 반만).
- 보물 획득 성공 화면에는 학번 5자리와 이름이 크게 나옵니다(본인 화면에만).
- 교사 화면 로그인은 12시간 동안 유지됩니다. 수업이 끝나면 [로그아웃]을 눌러 주세요.
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
| 교사 화면 "비밀번호가 맞지 않습니다" | 4단계 비밀번호를 정했는지, 10분 잠금에 걸렸는지 |
| 사진 업로드 실패 | setup.sql 의 Storage 부분이 실행됐는지, 사진이 5MB 이하 이미지인지 |
| 좋아요 수가 바로 안 바뀜 | Database → Publications → `supabase_realtime` 에 posts, likes 가 있는지 |
