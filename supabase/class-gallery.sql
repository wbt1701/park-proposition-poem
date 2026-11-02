-- =====================================================================
-- 반별 갤러리 + 보물 획득 화면에 학번·이름 — 추가 설정 SQL
--   setup.sql, mission.sql 다음에 실행. 여러 번 실행해도 안전합니다.
--
--   - posts.class_code : 학번 앞 3자리(예: 10305 → '103'). 서버 트리거가 정하므로 학생이 바꿀 수 없음
--   - 학생은 자기 반(class_code 가 같은) 글만 읽기. 자기 글·교사는 그대로 전체
--   - 좋아요도 볼 수 있는 글의 것만 읽기
--   - get_or_assign_mission() 이 성공 화면용으로 본인 학번 5자리와 이름을 돌려줌
--   되돌리기: 맨 아래 "되돌리기" 부분
-- =====================================================================

alter table public.posts add column if not exists class_code text;
create index if not exists posts_class_code_idx on public.posts (class_code);

-- 지금 로그인한 학생의 반(학번 앞 3자리)
create or replace function public.my_class_code()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select left(a.student_id, 3) from public.authors a where a.user_id = (select auth.uid());
$$;
revoke execute on function public.my_class_code() from public, anon;
grant  execute on function public.my_class_code() to authenticated;

-- 학생이 고칠 수 없는 칸(user_id, hidden, class_code, 시각)을 서버에서 고정
create or replace function public.posts_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_student boolean := auth.uid() is not null and not public.is_teacher();
begin
  if tg_op = 'INSERT' then
    if v_student then
      new.user_id := auth.uid();
      new.hidden  := false;
    end if;
    new.created_at := now();
  else
    if v_student then
      new.hidden := old.hidden;
    elsif auth.uid() is not null then
      new.class_code := old.class_code;      -- 교사 화면에서 숨기기 등을 해도 반은 그대로
    end if;
    new.user_id    := old.user_id;
    new.created_at := old.created_at;
  end if;
  if v_student then
    new.class_code := public.my_class_code();
  end if;
  new.updated_at := now();
  return new;
end;
$$;

-- 입장(학번 입력) 때 이미 쓴 글의 반도 맞춰 줌
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

  update public.posts set class_code = left(p_student_id, 3)
   where user_id = v_uid and class_code is distinct from left(p_student_id, 3);
end;
$$;

-- 이미 있는 글의 반 채우기
update public.posts p set class_code = left(a.student_id, 3)
  from public.authors a
 where a.user_id = p.user_id and p.class_code is distinct from left(a.student_id, 3);

-- 읽기 규칙: 자기 반 글만 (자기 글·교사는 전체)
drop policy if exists "posts_select" on public.posts;
create policy "posts_select" on public.posts
  for select to authenticated
  using (user_id = (select auth.uid())
         or (select public.is_teacher())
         or (hidden = false and class_code is not null and class_code = (select public.my_class_code())));

drop policy if exists "likes_select" on public.likes;
create policy "likes_select" on public.likes
  for select to authenticated
  using (exists (select 1 from public.posts p where p.id = post_id));

-- 성공 화면: 본인 학번 5자리와 이름 (본인 것만)
create or replace function public.get_or_assign_mission(p_assign boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_asg public.assignments%rowtype;
  v_loc smallint;
  v_me  public.authors%rowtype;
begin
  if v_uid is null then
    raise exception '로그인이 필요합니다.';
  end if;

  select * into v_asg from public.assignments where user_id = v_uid;

  if not found then
    if not public.mission_eligible(v_uid) then
      return jsonb_build_object('status', 'ineligible');
    end if;
    if not p_assign then
      return jsonb_build_object('status', 'ready');
    end if;
    select l.id into v_loc from public.locations l where not l.is_closed order by random() limit 1;
    if v_loc is null then
      return jsonb_build_object('status', 'no_open');
    end if;
    insert into public.assignments (user_id, location_id) values (v_uid, v_loc)
    on conflict (user_id) do nothing;
    select * into v_asg from public.assignments where user_id = v_uid;
  end if;

  select * into v_me from public.authors a where a.user_id = v_uid;

  return jsonb_build_object(
    'status',     case when v_asg.found_at is null then 'assigned' else 'found' end,
    'puzzle',     (select coalesce(l.puzzle, '[]'::jsonb) from public.locations l where l.id = v_asg.location_id),
    'found_at',   v_asg.found_at,
    'student_id', v_me.student_id,
    'name',       v_me.name);
end;
$$;

-- =====================================================================
-- 되돌리기 (반별 갤러리를 끄고 전체 공유로 돌아갈 때, 아래를 선택해 실행)
-- drop policy if exists "posts_select" on public.posts;
-- create policy "posts_select" on public.posts for select to authenticated
--   using (hidden = false or user_id = (select auth.uid()) or (select public.is_teacher()));
-- drop policy if exists "likes_select" on public.likes;
-- create policy "likes_select" on public.likes for select to authenticated using (true);
-- (class_code 칸과 트리거는 남겨 둬도 동작에 영향 없음)
-- =====================================================================
