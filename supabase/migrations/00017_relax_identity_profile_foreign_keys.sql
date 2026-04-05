-- Decouple core business writes from user_identity_profiles.
-- user_identity_profiles remains a profile/audit helper table, but missing profile rows
-- should never block agenda, timer, note, or voting writes.

INSERT INTO public.user_identity_profiles (
  user_id,
  app_id,
  wechat_openid,
  wechat_unionid,
  display_name,
  avatar_url,
  name_source,
  profile_completed,
  created_at,
  updated_at
)
SELECT
  au.id,
  'toamaster_app',
  NULLIF(COALESCE(au.raw_user_meta_data->>'wechat_openid', au.raw_user_meta_data->>'openid'), ''),
  NULLIF(COALESCE(au.raw_user_meta_data->>'wechat_unionid', au.raw_user_meta_data->>'unionid'), ''),
  COALESCE(
    NULLIF(au.raw_user_meta_data->>'nickname', ''),
    NULLIF(au.raw_user_meta_data->>'wechat_nickname', ''),
    NULLIF(au.raw_user_meta_data->>'name', ''),
    NULLIF(au.raw_user_meta_data->>'full_name', ''),
    NULLIF(split_part(COALESCE(au.email, ''), '@', 1), ''),
    '微信用户'
  ),
  NULLIF(COALESCE(au.raw_user_meta_data->>'avatar_url', au.raw_user_meta_data->>'picture'), ''),
  CASE
    WHEN COALESCE(NULLIF(au.raw_user_meta_data->>'nickname', ''), NULLIF(au.raw_user_meta_data->>'wechat_nickname', '')) IS NOT NULL
      THEN 'wechat_profile'::public.actor_name_source
    ELSE 'unknown'::public.actor_name_source
  END,
  TRUE,
  COALESCE((EXTRACT(EPOCH FROM au.created_at) * 1000)::BIGINT, EXTRACT(EPOCH FROM NOW())::BIGINT * 1000),
  EXTRACT(EPOCH FROM NOW())::BIGINT * 1000
FROM auth.users au
LEFT JOIN public.user_identity_profiles uip
  ON uip.user_id = au.id
WHERE uip.user_id IS NULL;

ALTER TABLE public.agenda_items_v2 DROP CONSTRAINT IF EXISTS agenda_items_v2_created_by_user_id_fkey;
ALTER TABLE public.agenda_items_v2 DROP CONSTRAINT IF EXISTS agenda_items_v2_updated_by_user_id_fkey;

ALTER TABLE public.agenda_ops_v2 DROP CONSTRAINT IF EXISTS agenda_ops_v2_actor_user_id_fkey;

ALTER TABLE public.ah_counter_records_v2 DROP CONSTRAINT IF EXISTS ah_counter_records_v2_observer_user_id_fkey;
ALTER TABLE public.grammarian_notes_v2 DROP CONSTRAINT IF EXISTS grammarian_notes_v2_observer_user_id_fkey;

ALTER TABLE public.meeting_live_cursor_v2 DROP CONSTRAINT IF EXISTS meeting_live_cursor_v2_updated_by_user_id_fkey;

ALTER TABLE public.meeting_participants_v2 DROP CONSTRAINT IF EXISTS meeting_participants_v2_created_by_user_id_fkey;
ALTER TABLE public.meeting_participants_v2 DROP CONSTRAINT IF EXISTS meeting_participants_v2_linked_user_id_fkey;

ALTER TABLE public.meeting_user_roles_v2 DROP CONSTRAINT IF EXISTS meeting_user_roles_v2_assigned_by_user_id_fkey;
ALTER TABLE public.meeting_user_roles_v2 DROP CONSTRAINT IF EXISTS meeting_user_roles_v2_user_id_fkey;

ALTER TABLE public.votes DROP CONSTRAINT IF EXISTS votes_voter_user_id_fkey;

ALTER TABLE public.voting_admin_ops_v2 DROP CONSTRAINT IF EXISTS voting_admin_ops_v2_actor_user_id_fkey;

ALTER TABLE public.voting_candidates DROP CONSTRAINT IF EXISTS voting_candidates_created_by_user_id_fkey;
ALTER TABLE public.voting_candidates DROP CONSTRAINT IF EXISTS voting_candidates_updated_by_user_id_fkey;

ALTER TABLE public.voting_groups DROP CONSTRAINT IF EXISTS voting_groups_created_by_user_id_fkey;
ALTER TABLE public.voting_groups DROP CONSTRAINT IF EXISTS voting_groups_updated_by_user_id_fkey;

ALTER TABLE public.voting_sessions DROP CONSTRAINT IF EXISTS voting_sessions_created_by_user_id_fkey;
ALTER TABLE public.voting_sessions DROP CONSTRAINT IF EXISTS voting_sessions_updated_by_user_id_fkey;
