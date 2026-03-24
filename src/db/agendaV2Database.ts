import {supabase} from '../client/supabase'
import type {
  AgendaItemV2,
  AgendaMutationActor,
  AgendaOpInput,
  AgendaOpV2,
  AgendaServiceResult,
  AhCounterRecordV2,
  ApplyAgendaOpsResult,
  GrammarianNoteV2,
  MeetingLiveCursorV2,
  MeetingParticipantV2,
  MeetingRole,
  UserIdentityProfileV2
} from '../types/agendaV2'
import type {MeetingSession} from '../types/meeting'

const UNKNOWN_ACTOR_NAME = '未知用户'

function nowMs() {
  return Date.now()
}

function toErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) {
    return error.message
  }

  if (typeof error === 'object' && error && 'message' in error) {
    const maybeMessage = (error as {message?: unknown}).message
    if (typeof maybeMessage === 'string' && maybeMessage.length > 0) {
      return maybeMessage
    }
  }

  return fallback
}

function normalizeActor(actor?: AgendaMutationActor) {
  return {
    userId: actor?.userId || null,
    name: actor?.name || UNKNOWN_ACTOR_NAME,
    nameSource: actor?.nameSource || 'unknown'
  }
}

type CreateAgendaItemInput = {
  meetingId: string
  item: Pick<AgendaItemV2, 'item_key' | 'title' | 'order_index' | 'planned_duration'> &
    Partial<Omit<AgendaItemV2, 'meeting_id' | 'item_key' | 'title' | 'order_index' | 'planned_duration'>>
  actor?: AgendaMutationActor
}

type UpdateAgendaItemInput = {
  meetingId: string
  itemKey: string
  patch: Partial<AgendaItemV2>
  expectedRowVersion?: number
  actor?: AgendaMutationActor
}

type SoftDeleteAgendaItemInput = {
  meetingId: string
  itemKey: string
  expectedRowVersion?: number
  actor?: AgendaMutationActor
}

type UpsertParticipantInput = {
  meetingId: string
  participantKey: string
  displayName: string
  roleTags?: string[]
  linkedUserId?: string | null
  actor?: AgendaMutationActor
}

type SetLiveCursorInput = {
  meetingId: string
  agendaVersion: number
  currentItemKey?: string | null
  currentParticipantKey?: string | null
  currentPhase?: MeetingLiveCursorV2['current_phase']
  remainingSeconds?: number | null
  actor?: AgendaMutationActor
}

type AppendAgendaOpInput = {
  opId: string
  meetingId: string
  opType: AgendaOpV2['op_type']
  baseAgendaVersion: number
  payload: Record<string, unknown>
  itemKey?: string
  clientTs?: number
  applyStatus?: AgendaOpV2['apply_status']
  appliedAgendaVersion?: number
  conflictReason?: string
  actor?: AgendaMutationActor
}

type CreateGrammarianNoteInput = {
  meetingId: string
  participantKey: string
  noteType: GrammarianNoteV2['note_type']
  content: string
  relatedItemKey?: string | null
  actor?: AgendaMutationActor
}

type CreateAhCounterRecordInput = {
  meetingId: string
  participantKey: string
  fillerWord: string
  hitCount?: number
  sampleQuote?: string | null
  relatedItemKey?: string | null
  actor?: AgendaMutationActor
}

export const AgendaV2DatabaseService = {
  async applyAgendaOps(input: {
    meetingId: string
    baseAgendaVersion: number
    ops: AgendaOpInput[]
    clientTs?: number
  }): Promise<AgendaServiceResult<ApplyAgendaOpsResult>> {
    try {
      const {data, error} = await supabase.rpc('apply_agenda_ops_v2', {
        p_meeting_id: input.meetingId,
        p_base_agenda_version: input.baseAgendaVersion,
        p_ops: input.ops,
        p_client_ts: input.clientTs || nowMs()
      })

      if (error) {
        return {success: false, error: error.message}
      }

      const result = (data || {}) as ApplyAgendaOpsResult
      if (!result.success) {
        return {
          success: false,
          error: result.error || result.code || 'APPLY_AGENDA_OPS_FAILED',
          data: result
        }
      }

      return {success: true, data: result}
    } catch (error) {
      return {success: false, error: toErrorMessage(error, '应用 Agenda Ops 失败')}
    }
  },

  async listAgendaItems(meetingId: string): Promise<AgendaServiceResult<AgendaItemV2[]>> {
    try {
      const {data, error} = await supabase
        .from('agenda_items_v2')
        .select('*')
        .eq('meeting_id', meetingId)
        .is('deleted_at', null)
        .order('order_index', {ascending: true})

      if (error) {
        return {success: false, error: error.message}
      }

      return {success: true, data: (data || []) as AgendaItemV2[]}
    } catch (error) {
      return {success: false, error: toErrorMessage(error, '获取 Agenda V2 列表失败')}
    }
  },

  async bootstrapAgendaFromSession(
    session: MeetingSession
  ): Promise<AgendaServiceResult<{seeded: boolean; agendaVersion: number}>> {
    try {
      const {count, error: countError} = await supabase
        .from('agenda_items_v2')
        .select('id', {count: 'exact', head: true})
        .eq('meeting_id', session.id)
        .is('deleted_at', null)

      if (countError) {
        return {success: false, error: countError.message}
      }

      const agendaVersion = session.agendaVersion || 1

      if ((count || 0) > 0) {
        const {data: meetingData, error: meetingVersionError} = await supabase
          .from('meetings')
          .select('agenda_version')
          .eq('id', session.id)
          .maybeSingle()

        if (meetingVersionError) {
          return {success: false, error: meetingVersionError.message}
        }

        return {
          success: true,
          data: {
            seeded: false,
            agendaVersion: Number(meetingData?.agenda_version || agendaVersion)
          }
        }
      }

      const timestamp = nowMs()
      const rows = session.items.map((item, index) => ({
        meeting_id: session.id,
        item_key: item.id,
        parent_item_key: null,
        node_kind: 'leaf',
        depth: 1,
        order_index: index,
        title: item.title,
        speaker: item.speaker || null,
        speaker_role: item.speaker ? 'speaker' : 'host',
        planned_duration: item.plannedDuration,
        budget_mode: 'independent',
        consume_parent_budget: true,
        actual_duration: item.actualDuration ?? null,
        actual_start_time: item.actualStartTime ?? null,
        actual_end_time: item.actualEndTime ?? null,
        start_time: item.startTime || null,
        item_type: item.type || 'other',
        rule_id: item.ruleId || 'short',
        disabled: Boolean(item.disabled),
        parent_title: item.parentTitle || null,
        status_code: 'initial',
        status_color: 'blue',
        status_rule_profile: item.plannedDuration > 300 ? 'gt5m' : 'lte5m',
        status_updated_at: timestamp,
        created_by_name: UNKNOWN_ACTOR_NAME,
        updated_by_name: UNKNOWN_ACTOR_NAME,
        updated_by_name_source: 'unknown',
        created_at: timestamp,
        updated_at: timestamp
      }))

      if (rows.length > 0) {
        const {error: insertError} = await supabase.from('agenda_items_v2').upsert(rows, {
          onConflict: 'meeting_id,item_key'
        })

        if (insertError) {
          return {success: false, error: insertError.message}
        }
      }

      const {error: meetingVersionError} = await supabase
        .from('meetings')
        .update({agenda_version: agendaVersion})
        .eq('id', session.id)

      if (meetingVersionError) {
        return {success: false, error: meetingVersionError.message}
      }

      return {success: true, data: {seeded: true, agendaVersion}}
    } catch (error) {
      return {success: false, error: toErrorMessage(error, '初始化 Agenda V2 数据失败')}
    }
  },

  async listParticipants(meetingId: string): Promise<AgendaServiceResult<MeetingParticipantV2[]>> {
    try {
      const {data, error} = await supabase
        .from('meeting_participants_v2')
        .select('*')
        .eq('meeting_id', meetingId)
        .is('deleted_at', null)
        .order('updated_at', {ascending: false})

      if (error) {
        return {success: false, error: error.message}
      }

      return {success: true, data: (data || []) as MeetingParticipantV2[]}
    } catch (error) {
      return {success: false, error: toErrorMessage(error, '获取参会人列表失败')}
    }
  },

  async getLiveCursor(meetingId: string): Promise<AgendaServiceResult<MeetingLiveCursorV2 | null>> {
    try {
      const {data, error} = await supabase
        .from('meeting_live_cursor_v2')
        .select('*')
        .eq('meeting_id', meetingId)
        .maybeSingle()

      if (error) {
        return {success: false, error: error.message}
      }

      return {success: true, data: (data as MeetingLiveCursorV2 | null) || null}
    } catch (error) {
      return {success: false, error: toErrorMessage(error, '获取实时游标失败')}
    }
  },

  async upsertUserIdentityProfile(
    profile: Pick<UserIdentityProfileV2, 'user_id' | 'app_id'> &
      Partial<Omit<UserIdentityProfileV2, 'user_id' | 'app_id' | 'created_at' | 'updated_at'>>
  ): Promise<AgendaServiceResult<UserIdentityProfileV2>> {
    try {
      const timestamp = nowMs()
      const {data: existing, error: existingError} = await supabase
        .from('user_identity_profiles')
        .select('created_at')
        .eq('user_id', profile.user_id)
        .maybeSingle()

      if (existingError) {
        return {success: false, error: existingError.message}
      }

      const payload = {
        user_id: profile.user_id,
        app_id: profile.app_id,
        wechat_openid: profile.wechat_openid ?? null,
        wechat_unionid: profile.wechat_unionid ?? null,
        display_name: profile.display_name || '微信用户',
        avatar_url: profile.avatar_url ?? null,
        name_source: profile.name_source || 'unknown',
        profile_completed: Boolean(profile.profile_completed),
        created_at: existing?.created_at || timestamp,
        updated_at: timestamp
      }

      const {data, error} = await supabase
        .from('user_identity_profiles')
        .upsert(payload, {
          onConflict: 'user_id'
        })
        .select('*')
        .single()

      if (error) {
        return {success: false, error: error.message}
      }

      return {success: true, data: data as UserIdentityProfileV2}
    } catch (error) {
      return {success: false, error: toErrorMessage(error, '写入用户身份资料失败')}
    }
  },

  async assignMeetingRole(input: {
    meetingId: string
    userId: string
    role: MeetingRole
    assignedByUserId?: string | null
    assignedAt?: number
  }): Promise<AgendaServiceResult<MeetingRoleAssignmentV2>> {
    const payload = {
      meeting_id: input.meetingId,
      user_id: input.userId,
      role: input.role,
      assigned_by_user_id: input.assignedByUserId || null,
      assigned_at: input.assignedAt || nowMs()
    }

    try {
      const {data, error} = await supabase
        .from('meeting_user_roles_v2')
        .upsert(payload, {
          onConflict: 'meeting_id,user_id,role'
        })
        .select('*')
        .single()

      if (error) {
        return {success: false, error: error.message}
      }

      return {success: true, data: data as MeetingRoleAssignmentV2}
    } catch (error) {
      return {success: false, error: toErrorMessage(error, '分配会议角色失败')}
    }
  },

  async createAgendaItem(input: CreateAgendaItemInput): Promise<AgendaServiceResult<AgendaItemV2>> {
    const actor = normalizeActor(input.actor)
    const timestamp = nowMs()
    const payload = {
      meeting_id: input.meetingId,
      item_key: input.item.item_key,
      parent_item_key: input.item.parent_item_key ?? null,
      node_kind: input.item.node_kind || 'leaf',
      depth: input.item.depth ?? 1,
      order_index: input.item.order_index,
      title: input.item.title,
      speaker: input.item.speaker ?? null,
      speaker_role: input.item.speaker_role || 'speaker',
      slot_group_key: input.item.slot_group_key ?? null,
      planned_duration: input.item.planned_duration,
      budget_mode: input.item.budget_mode || 'independent',
      budget_limit_seconds: input.item.budget_limit_seconds ?? null,
      consume_parent_budget: input.item.consume_parent_budget ?? true,
      actual_duration: input.item.actual_duration ?? null,
      actual_start_time: input.item.actual_start_time ?? null,
      actual_end_time: input.item.actual_end_time ?? null,
      start_time: input.item.start_time ?? null,
      item_type: input.item.item_type || 'other',
      rule_id: input.item.rule_id || 'short',
      disabled: input.item.disabled ?? false,
      parent_title: input.item.parent_title ?? null,
      status_code: input.item.status_code || 'initial',
      status_color: input.item.status_color || 'blue',
      status_rule_profile: input.item.status_rule_profile || 'lte5m',
      status_updated_at: input.item.status_updated_at ?? null,
      created_by_user_id: actor.userId,
      created_by_name: actor.name,
      updated_by_user_id: actor.userId,
      updated_by_name: actor.name,
      updated_by_name_source: actor.nameSource,
      created_at: timestamp,
      updated_at: timestamp
    }

    try {
      const {data, error} = await supabase.from('agenda_items_v2').insert(payload).select('*').single()

      if (error) {
        return {success: false, error: error.message}
      }

      return {success: true, data: data as AgendaItemV2}
    } catch (error) {
      return {success: false, error: toErrorMessage(error, '新增 Agenda Item 失败')}
    }
  },

  async updateAgendaItem(input: UpdateAgendaItemInput): Promise<AgendaServiceResult<AgendaItemV2>> {
    const actor = normalizeActor(input.actor)
    const timestamp = nowMs()

    try {
      const {data: current, error: fetchError} = await supabase
        .from('agenda_items_v2')
        .select('*')
        .eq('meeting_id', input.meetingId)
        .eq('item_key', input.itemKey)
        .is('deleted_at', null)
        .maybeSingle()

      if (fetchError) {
        return {success: false, error: fetchError.message}
      }

      if (!current) {
        return {success: false, error: 'ITEM_NOT_FOUND'}
      }

      if (
        typeof input.expectedRowVersion === 'number' &&
        Number(input.expectedRowVersion) !== Number(current.row_version)
      ) {
        return {success: false, error: 'ROW_VERSION_CONFLICT'}
      }

      const nextRowVersion = Number(current.row_version || 1) + 1
      const patch = {
        ...input.patch,
        updated_by_user_id: actor.userId,
        updated_by_name: actor.name,
        updated_by_name_source: actor.nameSource,
        updated_at: timestamp,
        row_version: nextRowVersion
      }

      const updateQuery = supabase
        .from('agenda_items_v2')
        .update(patch)
        .eq('meeting_id', input.meetingId)
        .eq('item_key', input.itemKey)
        .eq('row_version', current.row_version)
        .select('*')
        .single()

      const {data, error} = await updateQuery
      if (error) {
        return {success: false, error: error.message}
      }

      return {success: true, data: data as AgendaItemV2}
    } catch (error) {
      return {success: false, error: toErrorMessage(error, '更新 Agenda Item 失败')}
    }
  },

  async softDeleteAgendaItem(input: SoftDeleteAgendaItemInput): Promise<AgendaServiceResult> {
    const actor = normalizeActor(input.actor)
    const timestamp = nowMs()

    try {
      const {data: current, error: fetchError} = await supabase
        .from('agenda_items_v2')
        .select('row_version')
        .eq('meeting_id', input.meetingId)
        .eq('item_key', input.itemKey)
        .is('deleted_at', null)
        .maybeSingle()

      if (fetchError) {
        return {success: false, error: fetchError.message}
      }

      if (!current) {
        return {success: false, error: 'ITEM_NOT_FOUND'}
      }

      if (
        typeof input.expectedRowVersion === 'number' &&
        Number(input.expectedRowVersion) !== Number(current.row_version)
      ) {
        return {success: false, error: 'ROW_VERSION_CONFLICT'}
      }

      const {error} = await supabase
        .from('agenda_items_v2')
        .update({
          deleted_at: timestamp,
          updated_at: timestamp,
          updated_by_user_id: actor.userId,
          updated_by_name: actor.name,
          updated_by_name_source: actor.nameSource,
          row_version: Number(current.row_version || 1) + 1
        })
        .eq('meeting_id', input.meetingId)
        .eq('item_key', input.itemKey)
        .eq('row_version', current.row_version)

      if (error) {
        return {success: false, error: error.message}
      }

      return {success: true}
    } catch (error) {
      return {success: false, error: toErrorMessage(error, '删除 Agenda Item 失败')}
    }
  },

  async upsertParticipant(input: UpsertParticipantInput): Promise<AgendaServiceResult<MeetingParticipantV2>> {
    const actor = normalizeActor(input.actor)
    const timestamp = nowMs()

    try {
      const {data: existing, error: fetchError} = await supabase
        .from('meeting_participants_v2')
        .select('*')
        .eq('meeting_id', input.meetingId)
        .eq('participant_key', input.participantKey)
        .maybeSingle()

      if (fetchError) {
        return {success: false, error: fetchError.message}
      }

      if (!existing) {
        const {data, error} = await supabase
          .from('meeting_participants_v2')
          .insert({
            meeting_id: input.meetingId,
            participant_key: input.participantKey,
            display_name: input.displayName,
            linked_user_id: input.linkedUserId ?? null,
            role_tags: input.roleTags || [],
            created_by_user_id: actor.userId,
            created_at: timestamp,
            updated_at: timestamp
          })
          .select('*')
          .single()

        if (error) {
          return {success: false, error: error.message}
        }

        return {success: true, data: data as MeetingParticipantV2}
      }

      const {data, error} = await supabase
        .from('meeting_participants_v2')
        .update({
          display_name: input.displayName,
          linked_user_id: input.linkedUserId ?? existing.linked_user_id ?? null,
          role_tags: input.roleTags || existing.role_tags || [],
          updated_at: timestamp,
          deleted_at: null,
          row_version: Number(existing.row_version || 1) + 1
        })
        .eq('id', existing.id)
        .eq('row_version', existing.row_version)
        .select('*')
        .single()

      if (error) {
        return {success: false, error: error.message}
      }

      return {success: true, data: data as MeetingParticipantV2}
    } catch (error) {
      return {success: false, error: toErrorMessage(error, '写入参会人失败')}
    }
  },

  async setLiveCursor(input: SetLiveCursorInput): Promise<AgendaServiceResult<MeetingLiveCursorV2>> {
    const actor = normalizeActor(input.actor)
    const timestamp = nowMs()

    try {
      const {data: existing, error: fetchError} = await supabase
        .from('meeting_live_cursor_v2')
        .select('*')
        .eq('meeting_id', input.meetingId)
        .maybeSingle()

      if (fetchError) {
        return {success: false, error: fetchError.message}
      }

      const rowVersion = Number(existing?.row_version || 0) + 1

      const {data, error} = await supabase
        .from('meeting_live_cursor_v2')
        .upsert(
          {
            meeting_id: input.meetingId,
            current_item_key: input.currentItemKey ?? null,
            current_participant_key: input.currentParticipantKey ?? null,
            current_phase: input.currentPhase || 'other',
            remaining_seconds: input.remainingSeconds ?? null,
            agenda_version: input.agendaVersion,
            row_version: rowVersion,
            updated_by_user_id: actor.userId,
            updated_by_name: actor.name,
            updated_at: timestamp
          },
          {onConflict: 'meeting_id'}
        )
        .select('*')
        .single()

      if (error) {
        return {success: false, error: error.message}
      }

      return {success: true, data: data as MeetingLiveCursorV2}
    } catch (error) {
      return {success: false, error: toErrorMessage(error, '更新实时游标失败')}
    }
  },

  async appendAgendaOp(input: AppendAgendaOpInput): Promise<AgendaServiceResult<AgendaOpV2>> {
    const actor = normalizeActor(input.actor)
    const timestamp = nowMs()
    const payload = {
      op_id: input.opId,
      meeting_id: input.meetingId,
      item_key: input.itemKey ?? null,
      op_type: input.opType,
      base_agenda_version: input.baseAgendaVersion,
      applied_agenda_version: input.appliedAgendaVersion ?? null,
      payload: input.payload,
      actor_user_id: actor.userId,
      actor_name: actor.name,
      actor_name_source: actor.nameSource,
      client_ts: input.clientTs ?? null,
      server_ts: timestamp,
      apply_status: input.applyStatus || 'applied',
      conflict_reason: input.conflictReason ?? null
    }

    try {
      const {data, error} = await supabase.from('agenda_ops_v2').insert(payload).select('*').single()

      if (error) {
        return {success: false, error: error.message}
      }

      return {success: true, data: data as AgendaOpV2}
    } catch (error) {
      return {success: false, error: toErrorMessage(error, '写入 Agenda 操作日志失败')}
    }
  },

  async createGrammarianNote(input: CreateGrammarianNoteInput): Promise<AgendaServiceResult<GrammarianNoteV2>> {
    const actor = normalizeActor(input.actor)
    const timestamp = nowMs()

    try {
      const {data, error} = await supabase
        .from('grammarian_notes_v2')
        .insert({
          meeting_id: input.meetingId,
          participant_key: input.participantKey,
          note_type: input.noteType,
          content: input.content,
          related_item_key: input.relatedItemKey ?? null,
          observer_user_id: actor.userId,
          observer_name: actor.name,
          observer_role: 'grammarian',
          created_at: timestamp,
          updated_at: timestamp
        })
        .select('*')
        .single()

      if (error) {
        return {success: false, error: error.message}
      }

      return {success: true, data: data as GrammarianNoteV2}
    } catch (error) {
      return {success: false, error: toErrorMessage(error, '写入语法官记录失败')}
    }
  },

  async createAhCounterRecord(input: CreateAhCounterRecordInput): Promise<AgendaServiceResult<AhCounterRecordV2>> {
    const actor = normalizeActor(input.actor)
    const timestamp = nowMs()

    try {
      const {data, error} = await supabase
        .from('ah_counter_records_v2')
        .insert({
          meeting_id: input.meetingId,
          participant_key: input.participantKey,
          filler_word: input.fillerWord,
          hit_count: Math.max(1, input.hitCount || 1),
          sample_quote: input.sampleQuote ?? null,
          related_item_key: input.relatedItemKey ?? null,
          observer_user_id: actor.userId,
          observer_name: actor.name,
          observer_role: 'ah_counter',
          created_at: timestamp,
          updated_at: timestamp
        })
        .select('*')
        .single()

      if (error) {
        return {success: false, error: error.message}
      }

      return {success: true, data: data as AhCounterRecordV2}
    } catch (error) {
      return {success: false, error: toErrorMessage(error, '写入哼哈官记录失败')}
    }
  },

  async listGrammarianNotes(meetingId: string): Promise<AgendaServiceResult<GrammarianNoteV2[]>> {
    try {
      const {data, error} = await supabase
        .from('grammarian_notes_v2')
        .select('*')
        .eq('meeting_id', meetingId)
        .is('deleted_at', null)
        .order('created_at', {ascending: false})

      if (error) {
        return {success: false, error: error.message}
      }

      return {success: true, data: (data || []) as GrammarianNoteV2[]}
    } catch (error) {
      return {success: false, error: toErrorMessage(error, '获取语法官记录失败')}
    }
  },

  async listAhCounterRecords(meetingId: string): Promise<AgendaServiceResult<AhCounterRecordV2[]>> {
    try {
      const {data, error} = await supabase
        .from('ah_counter_records_v2')
        .select('*')
        .eq('meeting_id', meetingId)
        .is('deleted_at', null)
        .order('created_at', {ascending: false})

      if (error) {
        return {success: false, error: error.message}
      }

      return {success: true, data: (data || []) as AhCounterRecordV2[]}
    } catch (error) {
      return {success: false, error: toErrorMessage(error, '获取哼哈官记录失败')}
    }
  }
}
