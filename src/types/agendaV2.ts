export type AgendaNodeKind = 'segment' | 'leaf'
export type AgendaBudgetMode = 'independent' | 'hard_cap'
export type AgendaSpeakerRole = 'host' | 'speaker' | 'guest' | 'other'
export type AgendaStatusCode = 'initial' | 'qualified' | 'warning' | 'overtime' | 'severe_overtime'
export type AgendaStatusColor = 'blue' | 'green' | 'yellow' | 'red' | 'red_soft' | 'purple'
export type AgendaRuleProfile = 'gt5m' | 'lte5m'
export type ActorNameSource = 'wechat_profile' | 'manual_input' | 'unknown'
export type AgendaOpType = 'create_item' | 'update_item' | 'delete_item' | 'move_item' | 'timer_checkpoint' | 'status_change'
export type AgendaOpApplyStatus = 'applied' | 'conflict' | 'rejected' | 'replayed'
export type AgendaLivePhase = 'host_opening' | 'prep' | 'speech' | 'host_bridge' | 'host_closing' | 'other'
export type ObserverRole = 'timer_officer' | 'grammarian' | 'ah_counter' | 'host' | 'other'
export type GrammarNoteType = 'good_word' | 'good_phrase' | 'great_sentence' | 'grammar_issue'
export type MeetingRole = 'timer_officer' | 'grammarian' | 'ah_counter' | 'voting_admin' | 'viewer'
export type VoteTraceMode = 'anonymous' | 'auditable_private' | 'named'
export type AgendaRpcErrorCode =
  | 'AUTH_REQUIRED'
  | 'FORBIDDEN'
  | 'MEETING_NOT_FOUND'
  | 'VERSION_CONFLICT'
  | 'OPS_EMPTY'
  | string

export interface UserIdentityProfileV2 {
  user_id: string
  app_id: string
  wechat_openid?: string | null
  wechat_unionid?: string | null
  display_name: string
  avatar_url?: string | null
  name_source: ActorNameSource
  profile_completed: boolean
  created_at: number
  updated_at: number
}

export interface AgendaItemV2 {
  id: string
  meeting_id: string
  item_key: string
  parent_item_key?: string | null
  node_kind: AgendaNodeKind
  depth: number
  order_index: number
  title: string
  speaker?: string | null
  speaker_role: AgendaSpeakerRole
  slot_group_key?: string | null
  planned_duration: number
  budget_mode: AgendaBudgetMode
  budget_limit_seconds?: number | null
  consume_parent_budget: boolean
  actual_duration?: number | null
  actual_start_time?: number | null
  actual_end_time?: number | null
  start_time?: string | null
  item_type: string
  rule_id: string
  disabled: boolean
  parent_title?: string | null
  status_code: AgendaStatusCode
  status_color: AgendaStatusColor
  status_rule_profile: AgendaRuleProfile
  status_updated_at?: number | null
  row_version: number
  created_by_user_id?: string | null
  created_by_name: string
  updated_by_user_id?: string | null
  updated_by_name: string
  updated_by_name_source: ActorNameSource
  created_at: number
  updated_at: number
  deleted_at?: number | null
}

export interface MeetingParticipantV2 {
  id: string
  meeting_id: string
  participant_key: string
  display_name: string
  linked_user_id?: string | null
  role_tags: string[]
  created_by_user_id?: string | null
  row_version: number
  created_at: number
  updated_at: number
  deleted_at?: number | null
}

export interface MeetingLiveCursorV2 {
  meeting_id: string
  current_item_key?: string | null
  current_participant_key?: string | null
  current_phase: AgendaLivePhase
  remaining_seconds?: number | null
  agenda_version: number
  row_version: number
  updated_by_user_id?: string | null
  updated_by_name: string
  updated_at: number
}

export interface AgendaOpV2 {
  op_id: string
  meeting_id: string
  item_key?: string | null
  op_type: AgendaOpType
  base_agenda_version: number
  applied_agenda_version?: number | null
  payload: Record<string, unknown>
  actor_user_id?: string | null
  actor_name: string
  actor_name_source: ActorNameSource
  client_ts?: number | null
  server_ts: number
  apply_status: AgendaOpApplyStatus
  conflict_reason?: string | null
}

export interface GrammarianNoteV2 {
  id: string
  meeting_id: string
  participant_key: string
  note_type: GrammarNoteType
  content: string
  related_item_key?: string | null
  observer_user_id?: string | null
  observer_name: string
  observer_role: ObserverRole
  row_version: number
  created_at: number
  updated_at: number
  deleted_at?: number | null
}

export interface AhCounterRecordV2 {
  id: string
  meeting_id: string
  participant_key: string
  filler_word: string
  hit_count: number
  sample_quote?: string | null
  related_item_key?: string | null
  observer_user_id?: string | null
  observer_name: string
  observer_role: ObserverRole
  row_version: number
  created_at: number
  updated_at: number
  deleted_at?: number | null
}

export interface MeetingRoleAssignmentV2 {
  id: string
  meeting_id: string
  user_id: string
  role: MeetingRole
  assigned_by_user_id?: string | null
  assigned_at: number
}

export interface VotingAdminOpV2 {
  op_id: string
  meeting_id: string
  voting_session_id?: string | null
  op_type: string
  payload: Record<string, unknown>
  actor_user_id: string
  actor_name: string
  server_ts: number
}

export interface AgendaMutationActor {
  userId?: string | null
  name?: string
  nameSource?: ActorNameSource
}

export interface AgendaOpInput {
  opId: string
  type: AgendaOpType
  itemKey?: string
  expectedRowVersion?: number
  payload: Record<string, unknown>
}

export interface ApplyAgendaOpsResult {
  success: boolean
  newVersion?: number
  appliedCount?: number
  replayedCount?: number
  currentVersion?: number
  code?: AgendaRpcErrorCode
  error?: string
}

export interface AgendaServiceResult<T = void> {
  success: boolean
  data?: T
  error?: string
}
