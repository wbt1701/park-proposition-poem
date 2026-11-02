-- =====================================================================
-- 「공원에서 쓰는 명제 시」 Supabase 설정 SQL
--   Supabase 대시보드 → SQL Editor → New query 에 전체를 붙여 넣고 [Run]
--   여러 번 실행해도 안전하도록(idempotent) 작성했습니다.
--
--   보안 요약
--   - posts   : 학번·이름 없음. 로그인한 사람은 숨기지 않은 글 읽기,
--               본인 글만 작성·수정, 교사는 전체 읽기·숨기기·삭제
--   - authors : 학번·이름. 읽기는 교사만. 작성은 register_author() 함수로
--               "본인 행"만 (auth.uid() 기준)
--   - likes   : 로그인한 사람 읽기, 본인 좋아요만 추가·삭제
--   - teachers: 교사만 읽기 (등록은 SQL Editor 에서만)
--   - photos  : 공개 버킷(누구나 읽기), 로그인한 사람은 자기 폴더에만 업로드,
--               본인 파일만 덮어쓰기
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. 테이블
-- ---------------------------------------------------------------------
create table if not exists public.teachers (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  email      text,
  created_at timestamptz not null default now()
);

create table if not exists public.posts (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null unique default auth.uid()          -- 1인 1편
              references auth.users (id) on delete cascade,
  photo_url   text,
  p           text not null check (char_length(btrim(p)) between 1 and 200),
  q           text not null check (char_length(btrim(q)) between 1 and 200),
  original    text not null check (char_length(btrim(original)) between 1 and 400),  -- 완성된 원래 명제 문장
  converse    text not null check (char_length(btrim(converse)) between 1 and 400),  -- 역
  contrapositive text not null check (char_length(btrim(contrapositive)) between 1 and 400),  -- 대우
  is_true     boolean not null,
  reason_or_counterexample text not null
              check (char_length(btrim(reason_or_counterexample)) between 1 and 600),
  title       text not null check (char_length(btrim(title)) between 1 and 100),
  body        text not null check (char_length(btrim(body)) between 1 and 3000),
  used_sentences text[] not null
              check (cardinality(used_sentences) >= 2
                     and used_sentences <@ array['original', 'converse', 'contrapositive']),
  hidden      boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.authors (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  post_id    uuid unique references public.posts (id) on delete set null,
  student_id text not null check (student_id ~ '^[0-9]{5}$'),
  name       text not null check (char_length(btrim(name)) between 1 and 20),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.likes (
  id         bigint generated always as identity primary key,
  post_id    uuid not null references public.posts (id) on delete cascade,
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (post_id, user_id)
);
create index if not exists likes_user_id_idx on public.likes (user_id);

-- ---------------------------------------------------------------------
-- 2. 함수와 트리거
-- ---------------------------------------------------------------------
-- 지금 로그인한 사람이 교사인가?
create or replace function public.is_teacher()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.teachers t where t.user_id = (select auth.uid()));
$$;

-- 학생이 고칠 수 없는 칸(user_id, hidden, 시각)을 서버에서 고정
create or replace function public.posts_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if auth.uid() is not null and not public.is_teacher() then
      new.user_id := auth.uid();
      new.hidden  := false;
    end if;
    new.created_at := now();
  else
    if auth.uid() is not null and not public.is_teacher() then
      new.hidden := old.hidden;
    end if;
    new.user_id    := old.user_id;
    new.created_at := old.created_at;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists posts_guard on public.posts;
create trigger posts_guard
  before insert or update on public.posts
  for each row execute function public.posts_guard();

-- 글을 처음 올리면 authors.post_id 를 연결 (학생은 authors 를 직접 고칠 수 없으므로 definer)
create or replace function public.posts_link_author()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.authors set post_id = new.id, updated_at = now()
   where user_id = new.user_id;
  return new;
end;
$$;

drop trigger if exists posts_link_author on public.posts;
create trigger posts_link_author
  after insert on public.posts
  for each row execute function public.posts_link_author();

-- 학생 입장: 본인(auth.uid()) 행에만 학번·이름 저장. 다른 학생 정보는 돌려주지 않음
create or replace function public.register_author(p_student_id text, p_name text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := auth.uid();
  v_name text := btrim(coalesce(p_name, ''));
begin
  if v_uid is null then
    raise exception '로그인이 필요합니다.';
  end if;
  if coalesce(p_student_id, '') !~ '^[0-9]{5}$' then
    raise exception '학번은 5자리 숫자여야 합니다.';
  end if;
  if char_length(v_name) not between 1 and 20 then
    raise exception '이름은 1~20자로 입력해 주세요.';
  end if;

  insert into public.authors (user_id, student_id, name, post_id)
  values (v_uid, p_student_id, v_name,
          (select p.id from public.posts p where p.user_id = v_uid))
  on conflict (user_id) do update
    set student_id = excluded.student_id,
        name       = excluded.name,
        post_id    = excluded.post_id,
        updated_at = now();
end;
$$;

revoke execute on function public.is_teacher()                  from public, anon;
revoke execute on function public.register_author(text, text)   from public, anon;
revoke execute on function public.posts_guard()                 from public, anon, authenticated;
revoke execute on function public.posts_link_author()           from public, anon, authenticated;
grant  execute on function public.is_teacher()                  to authenticated;
grant  execute on function public.register_author(text, text)   to authenticated;

-- ---------------------------------------------------------------------
-- 3. 권한(GRANT) — 비로그인(anon)은 아무 테이블도 못 보게
-- ---------------------------------------------------------------------
revoke all on public.posts, public.authors, public.likes, public.teachers from anon;
revoke truncate, references, trigger on public.posts, public.authors, public.likes, public.teachers
  from authenticated;
-- authors 는 register_author() 로만 쓰기
revoke insert, update on public.authors from authenticated;
-- teachers 는 SQL Editor 에서만 등록
revoke insert, update, delete on public.teachers from authenticated;

-- ---------------------------------------------------------------------
-- 4. RLS 켜기 + 정책
-- ---------------------------------------------------------------------
alter table public.posts    enable row level security;
alter table public.authors  enable row level security;
alter table public.likes    enable row level security;
alter table public.teachers enable row level security;

-- posts ---------------------------------------------------------------
drop policy if exists "posts_select" on public.posts;
drop policy if exists "posts_insert_own" on public.posts;
drop policy if exists "posts_update_own_or_teacher" on public.posts;
drop policy if exists "posts_delete_teacher" on public.posts;

create policy "posts_select" on public.posts
  for select to authenticated
  using (hidden = false
         or user_id = (select auth.uid())
         or (select public.is_teacher()));

-- 본인 글만 작성. 사진 주소는 본인 폴더(photos/<내 uid>/...) 파일만 허용
create policy "posts_insert_own" on public.posts
  for insert to authenticated
  with check (user_id = (select auth.uid())
              and (photo_url is null
                   or photo_url like '%/storage/v1/object/public/photos/' || (select auth.uid())::text || '/%'));

create policy "posts_update_own_or_teacher" on public.posts
  for update to authenticated
  using (user_id = (select auth.uid()) or (select public.is_teacher()))
  with check ((user_id = (select auth.uid())
               and (photo_url is null
                    or photo_url like '%/storage/v1/object/public/photos/' || (select auth.uid())::text || '/%'))
              or (select public.is_teacher()));

create policy "posts_delete_teacher" on public.posts
  for delete to authenticated
  using ((select public.is_teacher()));

-- authors -------------------------------------------------------------
drop policy if exists "authors_select_teacher" on public.authors;
drop policy if exists "authors_delete_teacher" on public.authors;

create policy "authors_select_teacher" on public.authors
  for select to authenticated
  using ((select public.is_teacher()));

create policy "authors_delete_teacher" on public.authors
  for delete to authenticated
  using ((select public.is_teacher()));

-- likes ---------------------------------------------------------------
drop policy if exists "likes_select" on public.likes;
drop policy if exists "likes_insert_own" on public.likes;
drop policy if exists "likes_delete_own" on public.likes;

create policy "likes_select" on public.likes
  for select to authenticated
  using (true);

create policy "likes_insert_own" on public.likes
  for insert to authenticated
  with check (user_id = (select auth.uid())
              and exists (select 1 from public.posts p
                           where p.id = post_id and p.hidden = false));

create policy "likes_delete_own" on public.likes
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- teachers ------------------------------------------------------------
drop policy if exists "teachers_select_teacher" on public.teachers;

create policy "teachers_select_teacher" on public.teachers
  for select to authenticated
  using ((select public.is_teacher()));

-- ---------------------------------------------------------------------
-- 5. 좋아요 수 뷰 (부르는 사람의 RLS 가 그대로 적용되도록 security_invoker)
-- ---------------------------------------------------------------------
create or replace view public.post_list
with (security_invoker = true) as
select p.id,
       p.user_id,
       p.title,
       p.is_true,
       p.hidden,
       p.created_at,
       p.updated_at,
       (select count(*) from public.likes l where l.post_id = p.id)::int as like_count
  from public.posts p;

revoke all on public.post_list from anon;
grant select on public.post_list to authenticated;

-- ---------------------------------------------------------------------
-- 6. Realtime (글·좋아요 변경을 바로 반영)
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'posts') then
    alter publication supabase_realtime add table public.posts;
  end if;
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'likes') then
    alter publication supabase_realtime add table public.likes;
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- 7. Storage 버킷: photos (공개 읽기, 5MB, 이미지만)
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "photos_insert_own_folder" on storage.objects;
drop policy if exists "photos_select_own_or_teacher" on storage.objects;
drop policy if exists "photos_update_own" on storage.objects;
drop policy if exists "photos_delete_own_or_teacher" on storage.objects;

-- 로그인한 사람은 photos/<내 uid>/ 폴더에만 업로드
create policy "photos_insert_own_folder" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'photos'
              and (storage.foldername(name))[1] = (select auth.uid())::text);

-- 공개 버킷이라 사진 보기(공개 URL)에는 정책이 필요 없음.
-- 아래 SELECT 정책은 덮어쓰기·삭제 때 본인 파일을 찾기 위한 것 (목록 조회는 본인·교사만)
create policy "photos_select_own_or_teacher" on storage.objects
  for select to authenticated
  using (bucket_id = 'photos'
         and (owner_id = (select auth.uid())::text or (select public.is_teacher())));

create policy "photos_update_own" on storage.objects
  for update to authenticated
  using (bucket_id = 'photos' and owner_id = (select auth.uid())::text)
  with check (bucket_id = 'photos'
              and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "photos_delete_own_or_teacher" on storage.objects
  for delete to authenticated
  using (bucket_id = 'photos'
         and (owner_id = (select auth.uid())::text or (select public.is_teacher())));

-- =====================================================================
-- 끝. 다음 단계: README 의 "교사 계정 등록" 을 따라 teachers 에 본인 계정을 넣으세요.
-- =====================================================================
