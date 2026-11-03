-- =====================================================================
-- 보물찾기: 장소를 마감하면 아직 못 찾은 학생을 열린 장소로 자동 재배정
--   실행 순서: setup → mission → class-gallery → 이 파일. 여러 번 실행해도 안전합니다.
--
--   - 교사가 장소를 [마감]하면 그 장소에 배정된 "아직 못 찾은" 학생을 즉시 열린 장소로 옮김
--     (이미 찾은 학생은 그대로). 옮긴 시각은 assignments.moved_at
--   - 모든 장소가 마감이면 옮길 곳이 없으므로 그대로 두고, 학생에게는 'all_closed' (문제 없음)
--   - 나중에 장소를 다시 열면, 학생이 미션 화면을 열 때 열린 장소로 옮겨 줌
--   되돌리기: 맨 아래 "되돌리기" 부분
-- =====================================================================

alter table public.assignments add column if not exists moved_at timestamptz;

-- 열린 장소 중 하나를 무작위로 (p_exclude 는 빼고)
create or replace function public.pick_open_location(p_exclude smallint)
returns smallint
language sql
volatile
security definer
set search_path = ''
as $$
  select l.id from public.locations l
   where not l.is_closed and l.id is distinct from p_exclude
   order by random() limit 1;
$$;
revoke execute on function public.pick_open_location(smallint) from public, anon, authenticated;

-- 마감하는 순간 재배정 (학생마다 따로 무작위)
create or replace function public.locations_reassign_on_close()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  v smallint;
begin
  if new.is_closed and not old.is_closed then
    for r in select a.user_id from public.assignments a
              where a.location_id = new.id and a.found_at is null loop
      v := public.pick_open_location(new.id);
      exit when v is null;              -- 열린 장소가 없으면 그대로 (학생에게는 '모두 마감')
      update public.assignments
         set location_id = v, moved_at = now(), updated_at = now()
       where user_id = r.user_id;
    end loop;
  end if;
  return null;
end;
$$;
revoke execute on function public.locations_reassign_on_close() from public, anon, authenticated;

drop trigger if exists locations_reassign_on_close on public.locations;
create trigger locations_reassign_on_close
  after update of is_closed on public.locations
  for each row execute function public.locations_reassign_on_close();

-- 학생용: 배정 장소가 마감됐고 아직 못 찾았으면 열린 장소로 옮기고, 열린 곳이 없으면 'all_closed'
-- 반환 status: 'ineligible' | 'ready' | 'no_open' | 'all_closed' | 'assigned' | 'found'
--   (장소 이름·ID·확인 코드·풀이는 반환하지 않음)
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
    v_loc := public.pick_open_location(null);
    if v_loc is null then
      return jsonb_build_object('status', 'no_open');
    end if;
    insert into public.assignments (user_id, location_id) values (v_uid, v_loc)
    on conflict (user_id) do nothing;
    select * into v_asg from public.assignments where user_id = v_uid;
  elsif v_asg.found_at is null
        and exists (select 1 from public.locations l where l.id = v_asg.location_id and l.is_closed) then
    v_loc := public.pick_open_location(v_asg.location_id);
    if v_loc is null then
      return jsonb_build_object('status', 'all_closed');
    end if;
    update public.assignments set location_id = v_loc, moved_at = now(), updated_at = now()
     where user_id = v_uid
     returning * into v_asg;
  end if;

  select * into v_me from public.authors a where a.user_id = v_uid;

  return jsonb_build_object(
    'status',     case when v_asg.found_at is null then 'assigned' else 'found' end,
    'puzzle',     (select coalesce(l.puzzle, '[]'::jsonb) from public.locations l where l.id = v_asg.location_id),
    'found_at',   v_asg.found_at,
    'assigned_at', v_asg.assigned_at,   -- 같은 배정 안에서 문제가 바뀌었는지(장소 변경) 학생 화면이 알아보는 데 씀
    'student_id', v_me.student_id,
    'name',       v_me.name);
end;
$$;

-- =====================================================================
-- 되돌리기 (마감해도 배정된 학생을 그대로 두던 예전 방식으로)
-- drop trigger if exists locations_reassign_on_close on public.locations;
-- 그리고 supabase/class-gallery.sql 의 get_or_assign_mission 부분을 다시 실행
-- =====================================================================
