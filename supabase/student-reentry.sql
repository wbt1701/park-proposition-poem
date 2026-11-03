-- =====================================================================
-- 같은 학번·이름으로 다시 들어오면 내 기록 이어 쓰기 + 보물찾기 리셋
--   실행 순서: setup → mission → class-gallery → mission-relocate → 이 파일. 여러 번 실행해도 안전합니다.
--
--   1) enter_student(학번, 이름): 입장할 때 부름. 같은 학번·이름으로 다른 로그인(다른 기기·브라우저)에서
--      쓴 기록이 있으면 시·좋아요·미션 배정·학번 정보를 지금 로그인으로 옮김
--      ⚠ 학번과 이름을 아는 사람은 그 학생의 기록을 이어받을 수 있음(교사 요청에 따른 설계)
--   2) 글의 user_id 를 옮겨도 사진 주소가 막히지 않도록, "사진은 내 폴더 것만" 검사를
--      RLS 정책에서 posts_guard 트리거로 옮김 (사진을 새로 바꿀 때만 검사)
--   3) reset_mission(): 교사 전용. 확인 코드·미션 배정·코드 시도 기록을 모두 지우고 장소를 모두 엶
--   되돌리기: 맨 아래
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. posts_guard: user_id 는 enter_student 의 옮기기 때만 바뀜, 사진 검사 추가
-- ---------------------------------------------------------------------
create or replace function public.posts_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_student  boolean := auth.uid() is not null and not public.is_teacher();
  v_transfer boolean := coalesce(current_setting('app.transfer', true), '') = 'on';
  v_mine     text := '%/storage/v1/object/public/photos/' || coalesce(auth.uid()::text, '-') || '/%';
begin
  if tg_op = 'INSERT' then
    if v_student then
      new.user_id := auth.uid();
      new.hidden  := false;
      if new.photo_url is not null and new.photo_url not like v_mine then
        raise exception '사진은 내가 올린 것만 쓸 수 있어요.' using errcode = '42501';
      end if;
    end if;
    new.created_at := now();
  else
    if v_student then
      new.hidden := old.hidden;
      if new.photo_url is distinct from old.photo_url
         and new.photo_url is not null and new.photo_url not like v_mine then
        raise exception '사진은 내가 올린 것만 쓸 수 있어요.' using errcode = '42501';
      end if;
    elsif auth.uid() is not null then
      new.class_code := old.class_code;
    end if;
    if not v_transfer then
      new.user_id := old.user_id;
    end if;
    new.created_at := old.created_at;
  end if;
  if v_student then
    new.class_code := public.my_class_code();
  end if;
  new.updated_at := now();
  return new;
end;
$$;

-- 사진 검사는 트리거로 옮겼으므로 정책에서는 "본인 글"만 확인
drop policy if exists "posts_insert_own" on public.posts;
create policy "posts_insert_own" on public.posts
  for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "posts_update_own_or_teacher" on public.posts;
create policy "posts_update_own_or_teacher" on public.posts
  for update to authenticated
  using (user_id = (select auth.uid()) or (select public.is_teacher()))
  with check (user_id = (select auth.uid()) or (select public.is_teacher()));

-- ---------------------------------------------------------------------
-- 2. enter_student: register_author + 같은 학번·이름 기록 이어받기
-- ---------------------------------------------------------------------
create or replace function public.enter_student(p_student_id text, p_name text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := auth.uid();
  v_name text := btrim(coalesce(p_name, ''));
  v_old  uuid;
  v_restored boolean := false;
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

  -- 같은 학번·이름의 다른 로그인 기록 (글이 있는 것, 그중 최근 것 우선)
  select a.user_id into v_old
    from public.authors a
    left join public.posts p on p.user_id = a.user_id
   where a.student_id = p_student_id and btrim(a.name) = v_name and a.user_id <> v_uid
   order by (p.id is not null) desc, coalesce(p.updated_at, a.updated_at) desc
   limit 1;

  -- 지금 로그인에 아직 쓴 글이 없을 때만 옮김(이미 쓴 글을 덮어쓰지 않음)
  if v_old is not null and not exists (select 1 from public.posts where user_id = v_uid) then
    perform set_config('app.transfer', 'on', true);
    delete from public.assignments where user_id = v_uid;
    delete from public.likes l
     where l.user_id = v_uid
       and exists (select 1 from public.likes o where o.user_id = v_old and o.post_id = l.post_id);
    delete from public.authors where user_id = v_uid;
    update public.authors     set user_id = v_uid, updated_at = now() where user_id = v_old;  -- 먼저: 반(class_code) 계산에 쓰임
    update public.posts       set user_id = v_uid where user_id = v_old;
    update public.likes       set user_id = v_uid where user_id = v_old;
    update public.assignments set user_id = v_uid where user_id = v_old;
    perform set_config('app.transfer', 'off', true);
    v_restored := true;
  end if;

  insert into public.authors (user_id, student_id, name, post_id)
  values (v_uid, p_student_id, v_name, (select p.id from public.posts p where p.user_id = v_uid))
  on conflict (user_id) do update
    set student_id = excluded.student_id,
        name       = excluded.name,
        post_id    = excluded.post_id,
        updated_at = now();

  update public.posts set class_code = left(p_student_id, 3)
   where user_id = v_uid and class_code is distinct from left(p_student_id, 3);

  return jsonb_build_object('restored', v_restored);
end;
$$;
revoke execute on function public.enter_student(text, text) from public, anon;
grant  execute on function public.enter_student(text, text) to authenticated;

-- ---------------------------------------------------------------------
-- 3. 보물찾기 리셋 (교사 전용): 확인 코드·배정·시도 기록 삭제, 장소 모두 열기
--    시·사진·좋아요·학번 정보는 그대로
-- ---------------------------------------------------------------------
create or replace function public.reset_mission()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_asg int;
begin
  if not public.is_teacher() then
    raise exception '교사만 할 수 있습니다.' using errcode = '42501';
  end if;
  delete from public.assignments where true;
  get diagnostics v_asg = row_count;
  delete from private.mission_attempts where true;
  update public.locations set confirm_code = null, is_closed = false, updated_at = now() where true;
  return jsonb_build_object('assignments_removed', v_asg);
end;
$$;
revoke execute on function public.reset_mission() from public, anon;
grant  execute on function public.reset_mission() to authenticated;

-- =====================================================================
-- 되돌리기 (사진 검사를 정책으로 되돌리고 이어받기를 끄려면, 아래를 선택해 실행)
-- drop policy if exists "posts_insert_own" on public.posts;
-- create policy "posts_insert_own" on public.posts for insert to authenticated
--   with check (user_id = (select auth.uid()) and (photo_url is null
--     or photo_url like '%/storage/v1/object/public/photos/' || (select auth.uid())::text || '/%'));
-- drop policy if exists "posts_update_own_or_teacher" on public.posts;
-- create policy "posts_update_own_or_teacher" on public.posts for update to authenticated
--   using (user_id = (select auth.uid()) or (select public.is_teacher()))
--   with check ((user_id = (select auth.uid()) and (photo_url is null
--     or photo_url like '%/storage/v1/object/public/photos/' || (select auth.uid())::text || '/%'))
--     or (select public.is_teacher()));
-- drop function if exists public.enter_student(text, text);
-- drop function if exists public.reset_mission();
-- 그리고 supabase/class-gallery.sql 의 posts_guard 부분을 다시 실행
-- =====================================================================
