-- =====================================================================
-- 보물찾기 비밀 미션 + AI 사용 여부 — 추가 설정 SQL (setup.sql 다음에 실행)
--   여러 번 실행해도 안전합니다.
--
--   ⚠ 문제(puzzle) 내용과 확인 코드는 이 파일에 넣지 않습니다.
--     공개 저장소에 문제와 장소가 함께 있으면 학생이 풀지 않고도 답을 알 수 있기 때문.
--     문제는 supabase/mission-puzzles.local.sql (Git 제외 파일)로 넣고,
--     확인 코드는 교사 화면 [장소 관리] 탭에서 입력합니다.
--
--   보안 요약
--   - locations, assignments : 학생은 직접 읽기·쓰기 불가, 교사만
--   - 학생 동작은 RPC 두 개만:
--       get_or_assign_mission(p_assign) → 문제 문장과 획득 여부만 (장소 이름·코드·ID 없음)
--       submit_confirm_code(p_code)     → 'success' | 'wrong_location' | 'invalid'
--   - 미션 조건(사진 있음 + 본문 5줄 이상 + 숨김 아님)은 서버에서 다시 확인
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. AI 사용 여부 (시 쓰기 마지막 단계)
-- ---------------------------------------------------------------------
alter table public.posts add column if not exists ai_used boolean;

-- ---------------------------------------------------------------------
-- 2. 테이블
-- ---------------------------------------------------------------------
create table if not exists public.locations (
  id           smallint primary key,
  name         text not null unique,
  confirm_code text,                         -- 교사가 입력. 대소문자·공백 무시하고 비교
  is_closed    boolean not null default false,
  puzzle       jsonb not null default '[]',  -- [{ "animal": "다람쥐", "emoji": "🐿️", "text": "..." }, ...]
  updated_at   timestamptz not null default now()
);
create unique index if not exists locations_confirm_code_key
  on public.locations (upper(regexp_replace(confirm_code, '\s', '', 'g')))
  where confirm_code is not null;

insert into public.locations (id, name) values
  (1, '놀이터'), (2, '정자'), (3, '운동기구'), (4, '화장실 건물'), (5, '인라인스케이트장')
on conflict (id) do nothing;

create table if not exists public.assignments (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  location_id smallint not null references public.locations (id),
  assigned_at timestamptz not null default now(),
  found_at    timestamptz,
  prize_given boolean not null default false,
  updated_at  timestamptz not null default now()
);
create index if not exists assignments_location_idx on public.assignments (location_id);

create table if not exists private.mission_attempts (
  id         bigint generated always as identity primary key,
  user_id    uuid not null,
  result     text not null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 3. 권한과 RLS — 학생(authenticated)은 두 테이블에 직접 접근 불가, 교사만
-- ---------------------------------------------------------------------
revoke all on public.locations, public.assignments from anon;
revoke truncate, references, trigger on public.locations, public.assignments from authenticated;
revoke insert, delete on public.locations from authenticated;   -- 장소 5곳은 고정

alter table public.locations   enable row level security;
alter table public.assignments enable row level security;

drop policy if exists "locations_select_teacher" on public.locations;
drop policy if exists "locations_update_teacher" on public.locations;
create policy "locations_select_teacher" on public.locations
  for select to authenticated using ((select public.is_teacher()));
create policy "locations_update_teacher" on public.locations
  for update to authenticated using ((select public.is_teacher())) with check ((select public.is_teacher()));

drop policy if exists "assignments_select_teacher" on public.assignments;
drop policy if exists "assignments_insert_teacher" on public.assignments;
drop policy if exists "assignments_update_teacher" on public.assignments;
drop policy if exists "assignments_delete_teacher" on public.assignments;
create policy "assignments_select_teacher" on public.assignments
  for select to authenticated using ((select public.is_teacher()));
create policy "assignments_insert_teacher" on public.assignments
  for insert to authenticated with check ((select public.is_teacher()));
create policy "assignments_update_teacher" on public.assignments
  for update to authenticated using ((select public.is_teacher())) with check ((select public.is_teacher()));
create policy "assignments_delete_teacher" on public.assignments
  for delete to authenticated using ((select public.is_teacher()));

-- ---------------------------------------------------------------------
-- 4. 미션 조건: 사진 있음 + 본문 5줄 이상(빈 줄 제외) + 숨긴 글 아님
-- ---------------------------------------------------------------------
create or replace function public.mission_eligible(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.posts p
     where p.user_id = p_user
       and p.hidden = false
       and coalesce(btrim(p.photo_url), '') <> ''
       and (select count(*) from regexp_split_to_table(p.body, E'\\r?\\n') as l(line)
             where btrim(l.line) <> '') >= 5);
$$;
revoke execute on function public.mission_eligible(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 5. 학생용 RPC
-- ---------------------------------------------------------------------
-- p_assign = false : 상태만 확인 (버튼을 보여 줄지)
-- p_assign = true  : 미배정이면 열린 장소 중 무작위로 배정
-- 반환 status: 'ineligible' | 'ready' | 'no_open' | 'assigned' | 'found'
--   (장소 이름·ID·확인 코드는 절대 반환하지 않음)
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
  v_sid text;
begin
  if v_uid is null then
    raise exception '로그인이 필요합니다.';
  end if;

  select * into v_asg from public.assignments where user_id = v_uid;

  if not found then
    -- 한 번 배정된 학생은 조건과 상관없이 유지. 미배정이면 조건 확인
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
    on conflict (user_id) do nothing;            -- 동시에 두 번 눌러도 하나만
    select * into v_asg from public.assignments where user_id = v_uid;
  end if;

  select a.student_id into v_sid from public.authors a where a.user_id = v_uid;

  return jsonb_build_object(
    'status',   case when v_asg.found_at is null then 'assigned' else 'found' end,
    'puzzle',   (select coalesce(l.puzzle, '[]'::jsonb) from public.locations l where l.id = v_asg.location_id),
    'found_at', v_asg.found_at,
    'sid_tail', right(coalesce(v_sid, ''), 2));
end;
$$;

-- 확인 코드 제출: 'success' | 'wrong_location' | 'invalid'
create or replace function public.submit_confirm_code(p_code text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := auth.uid();
  v_code text := upper(regexp_replace(coalesce(p_code, ''), '\s', '', 'g'));
  v_asg  public.assignments%rowtype;
  v_mine text;
  v_result text;
begin
  if v_uid is null then
    raise exception '로그인이 필요합니다.';
  end if;
  select * into v_asg from public.assignments where user_id = v_uid;
  if not found then
    raise exception '아직 미션을 받지 않았습니다.';
  end if;
  if v_asg.found_at is not null then
    return 'success';
  end if;
  -- 코드 짐작 막기: 10분에 10번 틀리면 잠시 잠금
  if (select count(*) from private.mission_attempts
       where user_id = v_uid and result <> 'success' and created_at > now() - interval '10 minutes') >= 10 then
    raise exception '너무 많이 틀렸어요. 10분 뒤에 다시 해 보세요.';
  end if;

  select upper(regexp_replace(l.confirm_code, '\s', '', 'g')) into v_mine
    from public.locations l where l.id = v_asg.location_id;

  if v_code <> '' and v_code = v_mine then
    update public.assignments set found_at = now(), updated_at = now() where user_id = v_uid;
    v_result := 'success';
  elsif v_code <> '' and exists (
      select 1 from public.locations l
       where l.confirm_code is not null and upper(regexp_replace(l.confirm_code, '\s', '', 'g')) = v_code) then
    v_result := 'wrong_location';
  else
    v_result := 'invalid';
  end if;

  insert into private.mission_attempts (user_id, result) values (v_uid, v_result);
  return v_result;
end;
$$;

revoke execute on function public.get_or_assign_mission(boolean) from public, anon;
revoke execute on function public.submit_confirm_code(text)      from public, anon;
grant  execute on function public.get_or_assign_mission(boolean) to authenticated;
grant  execute on function public.submit_confirm_code(text)      to authenticated;

-- 교사 화면에 획득 소식이 바로 뜨도록 (RLS 때문에 학생에게는 전달되지 않음)
do $$
begin
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'assignments') then
    alter publication supabase_realtime add table public.assignments;
  end if;
end;
$$;

-- =====================================================================
-- 다음: supabase/mission-puzzles.local.sql 로 문제를 넣고, 교사 화면에서 확인 코드를 입력하세요.
-- =====================================================================
