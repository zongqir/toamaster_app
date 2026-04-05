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
  MeetingRoleAssignmentV2,
  TimerOfficerEventV2,
  UserIdentityProfileV2,
  WordOfDayHitV2
} from '../types/agendaV2'
import type {ImpromptuSpeechRecord, MeetingSession} from '../types/meeting'
import {buildAgendaPlacements, getAgendaItemType} from '../utils/agendaBusiness'

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

function extractErrorDetails(error: unknown) {
  if (!error || typeof error !== 'object') {
    return {message: typeof error === 'string' ? error : undefined}
  }

  const record = error as Record<string, unknown>
  return {
    message: typeof record.message === 'string' ? record.message : undefined,
    details: typeof record.details === 'string' ? record.details : undefined,
    hint: typeof record.hint === 'string' ? record.hint : undefined,
    code: typeof record.code === 'string' ? record.code : undefined,
    name: typeof record.name === 'string' ? record.name : undefined,
    status: typeof record.status === 'number' ? record.status : undefined
  }
}

function isVersionConflictError(error: unknown) {
  const details = extractErrorDetails(error)
  if (details.code === 'VERSION_CONFLICT' || details.code === 'ROW_VERSION_CONFLICT') {
    return true
  }

  const message = details.message || (typeof error === 'string' ? error : '')
  return message.includes('VERSION_CONFLICT') || message.includes('ROW_VERSION_CONFLICT')
}

function logAgendaError(context: string, error: unknown, extra?: Record<string, unknown>) {
  const logMethod = isVersionConflictError(error) ? console.warn : console.error
  logMethod(`[agenda-v2] ${context}`, {
    ...extractErrorDetails(error),
    raw: error,
    ...extra
  })
}

function normalizeActor(actor?: AgendaMutationActor) {
  return {
    userId: actor?.userId || null,
    name: actor?.name || UNKNOWN_ACTOR_NAME,
    nameSource: actor?.nameSource || 'unknown'
  }
}

function normalizeParticipantKey(value?: string | null) {
  return value?.trim() || ''
}

async function ensureParticipantExists(
  meetingId: string,
  participantKey: string | null | undefined,
  actor: ReturnType<typeof normalizeActor>
) {
  const normalizedKey = normalizeParticipantKey(participantKey)
  if (!normalizedKey) {
    return {success: true as const, participantKey: null}
  }

  const {data: existing, error: fetchError} = await supabase
    .from('meeting_participants_v2')
    .select('participant_key')
    .eq('meeting_id', meetingId)
    .eq('participant_key', normalizedKey)
    .is('deleted_at', null)
    .maybeSingle()

  if (fetchError) {
    logAgendaError('ensureParticipantExists:fetch', fetchError, {
      meetingId,
      participantKey: normalizedKey
    })
    return {success: false as const, error: fetchError.message}
  }

  if (existing?.participant_key) {
    return {success: true as const, participantKey: normalizedKey}
  }

  const timestamp = nowMs()
  const {error: upsertError} = await supabase.from('meeting_participants_v2').upsert(
    {
      meeting_id: meetingId,
      participant_key: normalizedKey,
      display_name: normalizedKey,
      role_tags: ['speaker'],
      created_by_user_id: actor.userId,
      created_at: timestamp,
      updated_at: timestamp,
      deleted_at: null
    },
    {onConflict: 'meeting_id,participant_key'}
  )

  if (upsertError) {
    logAgendaError('ensureParticipantExists:upsert', upsertError, {
      meetingId,
      participantKey: normalizedKey
    })
    return {success: false as const, error: upsertError.message}
  }

  return {success: true as const, participantKey: normalizedKey}
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

type AppendTimerOfficerEventInput = {
  meetingId: string
  agendaVersion: number
  eventType: TimerOfficerEventV2['event_type']
  itemKey?: string | null
  participantKey?: string | null
  currentPhase?: TimerOfficerEventV2['current_phase']
  remainingSeconds?: number | null
  payload?: Record<string, unknown>
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

type DecrementAhCounterRecordInput = {
  id: string
  actor?: AgendaMutationActor
}

type AdjustAhCounterRecordByWordInput = {
  meetingId: string
  participantKey: string
  fillerWord: string
  delta: number
  sampleQuote?: string | null
  relatedItemKey?: string | null
  actor?: AgendaMutationActor
}

type CreateWordOfDayHitInput = {
  meetingId: string
  participantKey: string
  wordText: string
  delta: 1 | -1
  relatedItemKey?: string | null
  actor?: AgendaMutationActor
}

type AdjustWordOfDayHitInput = {
  meetingId: string
  participantKey: string
  wordText: string
  delta: number
  relatedItemKey?: string | null
  actor?: AgendaMutationActor
}

type CreateImpromptuSpeechRecordInput = {
  meetingId: string
  agendaItemId: string
  speakerName: string
  sortOrder: number
  poolDurationSeconds?: number
  speechPlannedDurationSeconds?: number
  actor?: AgendaMutationActor
}

type UpdateImpromptuSpeechRecordInput = {
  id: string
  meetingId: string
  patch: Partial<{
    speakerName: string
    speakerKey: string
    status: ImpromptuSpeechRecord['status']
    poolDurationSeconds: number
    poolRemainingSecondsAtStart: number | null
    startedWithLowRemaining: boolean
    speechPlannedDurationSeconds: number
    speechStartedAt: number | null
    speechEndedAt: number | null
    speechDurationSeconds: number | null
    isOvertime: boolean | null
    notes: string | null
    deletedAt: number | null
  }>
  actor?: AgendaMutationActor
}

function mapImpromptuSpeechRecord(row: Record<string, unknown>): ImpromptuSpeechRecord {
  return {
    id: String(row.id),
    meetingId: String(row.meeting_id),
    agendaItemId: String(row.agenda_item_id),
    sortOrder: Number(row.sort_order || 0),
    speakerName: String(row.speaker_name || ''),
    speakerKey: String(row.speaker_key || ''),
    status: row.status as ImpromptuSpeechRecord['status'],
    poolDurationSeconds: Number(row.pool_duration_seconds || 1500),
    poolRemainingSecondsAtStart:
      row.pool_remaining_seconds_at_start === null || row.pool_remaining_seconds_at_start === undefined
        ? undefined
        : Number(row.pool_remaining_seconds_at_start),
    startedWithLowRemaining: Boolean(row.started_with_low_remaining),
    speechPlannedDurationSeconds: Number(row.speech_planned_duration_seconds || 120),
    speechStartedAt:
      row.speech_started_at === null || row.speech_started_at === undefined ? undefined : Number(row.speech_started_at),
    speechEndedAt:
      row.speech_ended_at === null || row.speech_ended_at === undefined ? undefined : Number(row.speech_ended_at),
    speechDurationSeconds:
      row.speech_duration_seconds === null || row.speech_duration_seconds === undefined
        ? undefined
        : Number(row.speech_duration_seconds),
    isOvertime: row.is_overtime === null || row.is_overtime === undefined ? undefined : Boolean(row.is_overtime),
    notes: typeof row.notes === 'string' ? row.notes : undefined,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    deletedAt: row.deleted_at === null || row.deleted_at === undefined ? undefined : Number(row.deleted_at)
  }
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
        logAgendaError('applyAgendaOps:rpc', error, {
          meetingId: input.meetingId,
          baseAgendaVersion: input.baseAgendaVersion,
          ops: input.ops
        })
        return {success: false, error: error.message}
      }

      const result = (data || {}) as ApplyAgendaOpsResult
      if (!result.success) {
        logAgendaError('applyAgendaOps:result', result, {
          meetingId: input.meetingId,
          baseAgendaVersion: input.baseAgendaVersion,
          ops: input.ops
        })
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
        logAgendaError('listAgendaItems', error, {meetingId})
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
        logAgendaError('bootstrapAgendaFromSession:count', countError, {meetingId: session.id})
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
          logAgendaError('bootstrapAgendaFromSession:meetingVersion', meetingVersionError, {meetingId: session.id})
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
      const placements = buildAgendaPlacements(session.items)
      const rows = session.items.map((item, index) => {
        const placement = placements.get(item.id)
        return {
          meeting_id: session.id,
          item_key: item.id,
          parent_item_key: placement?.parentItemKey ?? null,
          node_kind: placement?.nodeKind || 'leaf',
          depth: placement?.depth ?? 1,
          order_index: placement?.orderIndex ?? index,
          title: item.title,
          speaker: item.speaker || null,
          speaker_role: item.speaker ? 'speaker' : 'host',
          planned_duration: item.plannedDuration,
          slot_group_key: item.slotGroupKey || null,
          budget_mode: placement?.budgetMode || 'independent',
          budget_limit_seconds: placement?.budgetLimitSeconds ?? null,
          consume_parent_budget: placement?.consumeParentBudget ?? true,
          actual_duration: item.actualDuration ?? null,
          actual_start_time: item.actualStartTime ?? null,
          actual_end_time: item.actualEndTime ?? null,
          start_time: item.startTime || null,
          item_type: getAgendaItemType(item),
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
        }
      })

      if (rows.length > 0) {
        const {error: insertError} = await supabase.from('agenda_items_v2').upsert(rows, {
          onConflict: 'meeting_id,item_key'
        })

        if (insertError) {
          logAgendaError('bootstrapAgendaFromSession:upsertRows', insertError, {
            meetingId: session.id,
            rowCount: rows.length,
            rows
          })
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
        logAgendaError('listParticipants', error, {meetingId})
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
        logAgendaError('getLiveCursor', error, {meetingId})
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
        logAgendaError('upsertUserIdentityProfile', error, {payload})
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
        logAgendaError('assignMeetingRole', error, {
          meetingId: input.meetingId,
          userId: input.userId,
          role: input.role
        })
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
        logAgendaError('createAgendaItem', error, {payload})
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
        logAgendaError('updateAgendaItem', error, {
          meetingId: input.meetingId,
          itemKey: input.itemKey,
          patch: input.patch,
          expectedRowVersion: input.expectedRowVersion
        })
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
        logAgendaError('softDeleteAgendaItem', error, {
          meetingId: input.meetingId,
          itemKey: input.itemKey,
          expectedRowVersion: input.expectedRowVersion
        })
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
        logAgendaError('upsertParticipant', error, {
          meetingId: input.meetingId,
          participantKey: input.participantKey,
          displayName: input.displayName
        })
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
      const participantResult = await ensureParticipantExists(input.meetingId, input.currentParticipantKey, actor)
      if (!participantResult.success) {
        return {success: false, error: participantResult.error}
      }

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
            current_participant_key: participantResult.participantKey,
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
        logAgendaError('setLiveCursor', error, {
          meetingId: input.meetingId,
          currentItemKey: input.currentItemKey,
          currentParticipantKey: input.currentParticipantKey,
          currentPhase: input.currentPhase,
          agendaVersion: input.agendaVersion,
          remainingSeconds: input.remainingSeconds
        })
        return {success: false, error: error.message}
      }

      return {success: true, data: data as MeetingLiveCursorV2}
    } catch (error) {
      return {success: false, error: toErrorMessage(error, '更新实时游标失败')}
    }
  },

  async appendTimerOfficerEvent(
    input: AppendTimerOfficerEventInput
  ): Promise<AgendaServiceResult<TimerOfficerEventV2>> {
    const actor = normalizeActor(input.actor)
    const timestamp = nowMs()

    try {
      const participantResult = await ensureParticipantExists(input.meetingId, input.participantKey, actor)
      if (!participantResult.success) {
        return {success: false, error: participantResult.error}
      }

      const {data, error} = await supabase
        .from('timer_officer_events_v2')
        .insert({
          meeting_id: input.meetingId,
          item_key: input.itemKey ?? null,
          participant_key: participantResult.participantKey,
          event_type: input.eventType,
          current_phase: input.currentPhase || 'other',
          remaining_seconds: input.remainingSeconds ?? null,
          agenda_version: input.agendaVersion,
          payload: input.payload || {},
          operator_user_id: actor.userId,
          operator_name: actor.name,
          operator_name_source: actor.nameSource,
          created_at: timestamp
        })
        .select('*')
        .single()

      if (error) {
        logAgendaError('appendTimerOfficerEvent', error, {
          meetingId: input.meetingId,
          itemKey: input.itemKey,
          participantKey: input.participantKey,
          eventType: input.eventType
        })
        return {success: false, error: error.message}
      }

      return {success: true, data: data as TimerOfficerEventV2}
    } catch (error) {
      return {success: false, error: toErrorMessage(error, '写入时间官事件失败')}
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
        logAgendaError('appendAgendaOp', error, {payload})
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
        logAgendaError('createGrammarianNote', error, {
          meetingId: input.meetingId,
          participantKey: input.participantKey
        })
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
      const normalizedFillerWord = input.fillerWord.trim()
      const increment = Math.max(1, input.hitCount || 1)
      const {data: existing, error: fetchError} = await supabase
        .from('ah_counter_records_v2')
        .select('*')
        .eq('meeting_id', input.meetingId)
        .eq('participant_key', input.participantKey)
        .eq('filler_word', normalizedFillerWord)
        .is('deleted_at', null)
        .maybeSingle()

      if (fetchError) {
        logAgendaError('createAhCounterRecord:fetchExisting', fetchError, {
          meetingId: input.meetingId,
          participantKey: input.participantKey,
          fillerWord: normalizedFillerWord
        })
        return {success: false, error: fetchError.message}
      }

      let data: unknown
      let error: {message: string} | null = null

      if (!existing) {
        const insertResult = await supabase
          .from('ah_counter_records_v2')
          .insert({
            meeting_id: input.meetingId,
            participant_key: input.participantKey,
            filler_word: normalizedFillerWord,
            hit_count: increment,
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

        data = insertResult.data
        error = insertResult.error
      } else {
        const updateResult = await supabase
          .from('ah_counter_records_v2')
          .update({
            hit_count: Number(existing.hit_count || 0) + increment,
            sample_quote: input.sampleQuote?.trim() ? input.sampleQuote.trim() : (existing.sample_quote ?? null),
            related_item_key: input.relatedItemKey ?? existing.related_item_key ?? null,
            observer_user_id: actor.userId,
            observer_name: actor.name,
            observer_role: 'ah_counter',
            updated_at: timestamp,
            deleted_at: null,
            row_version: Number(existing.row_version || 1) + 1
          })
          .eq('id', existing.id)
          .eq('row_version', existing.row_version)
          .select('*')
          .single()

        data = updateResult.data
        error = updateResult.error
      }

      if (error) {
        logAgendaError('createAhCounterRecord', error, {
          meetingId: input.meetingId,
          participantKey: input.participantKey,
          fillerWord: normalizedFillerWord
        })
        return {success: false, error: error.message}
      }

      return {success: true, data: data as AhCounterRecordV2}
    } catch (error) {
      return {success: false, error: toErrorMessage(error, '写入哼哈官记录失败')}
    }
  },

  async decrementAhCounterRecord(
    input: DecrementAhCounterRecordInput
  ): Promise<AgendaServiceResult<AhCounterRecordV2 | null>> {
    const actor = normalizeActor(input.actor)
    const timestamp = nowMs()

    try {
      const {data: existing, error: fetchError} = await supabase
        .from('ah_counter_records_v2')
        .select('*')
        .eq('id', input.id)
        .is('deleted_at', null)
        .maybeSingle()

      if (fetchError) {
        logAgendaError('decrementAhCounterRecord:fetchExisting', fetchError, {id: input.id})
        return {success: false, error: fetchError.message}
      }

      if (!existing) {
        return {success: false, error: 'RECORD_NOT_FOUND'}
      }

      const nextHitCount = Number(existing.hit_count || 0) - 1

      if (nextHitCount <= 0) {
        const {error} = await supabase
          .from('ah_counter_records_v2')
          .update({
            deleted_at: timestamp,
            updated_at: timestamp,
            observer_user_id: actor.userId,
            observer_name: actor.name,
            observer_role: 'ah_counter',
            row_version: Number(existing.row_version || 1) + 1
          })
          .eq('id', existing.id)
          .eq('row_version', existing.row_version)

        if (error) {
          logAgendaError('decrementAhCounterRecord:deleteWhenZero', error, {id: input.id})
          return {success: false, error: error.message}
        }

        return {success: true, data: null}
      }

      const {data, error} = await supabase
        .from('ah_counter_records_v2')
        .update({
          hit_count: nextHitCount,
          updated_at: timestamp,
          observer_user_id: actor.userId,
          observer_name: actor.name,
          observer_role: 'ah_counter',
          row_version: Number(existing.row_version || 1) + 1
        })
        .eq('id', existing.id)
        .eq('row_version', existing.row_version)
        .select('*')
        .single()

      if (error) {
        logAgendaError('decrementAhCounterRecord:update', error, {id: input.id})
        return {success: false, error: error.message}
      }

      return {success: true, data: data as AhCounterRecordV2}
    } catch (error) {
      return {success: false, error: toErrorMessage(error, '减少哼哈次数失败')}
    }
  },

  async adjustAhCounterRecordByWord(
    input: AdjustAhCounterRecordByWordInput
  ): Promise<AgendaServiceResult<AhCounterRecordV2 | null>> {
    const actor = normalizeActor(input.actor)
    const timestamp = nowMs()
    const normalizedFillerWord = input.fillerWord.trim()
    const delta = Math.trunc(input.delta)

    if (!normalizedFillerWord) {
      return {success: false, error: 'FILLER_WORD_REQUIRED'}
    }

    if (!delta) {
      return {success: true, data: null}
    }

    try {
      const {data: existing, error: fetchError} = await supabase
        .from('ah_counter_records_v2')
        .select('*')
        .eq('meeting_id', input.meetingId)
        .eq('participant_key', input.participantKey)
        .eq('filler_word', normalizedFillerWord)
        .is('deleted_at', null)
        .maybeSingle()

      if (fetchError) {
        logAgendaError('adjustAhCounterRecordByWord:fetchExisting', fetchError, {
          meetingId: input.meetingId,
          participantKey: input.participantKey,
          fillerWord: normalizedFillerWord,
          delta
        })
        return {success: false, error: fetchError.message}
      }

      const existingCount = Number(existing?.hit_count || 0)
      const nextHitCount = existingCount + delta

      if (!existing) {
        if (nextHitCount <= 0) {
          return {success: true, data: null}
        }

        const {data, error} = await supabase
          .from('ah_counter_records_v2')
          .insert({
            meeting_id: input.meetingId,
            participant_key: input.participantKey,
            filler_word: normalizedFillerWord,
            hit_count: nextHitCount,
            sample_quote: input.sampleQuote?.trim() ? input.sampleQuote.trim() : null,
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
          logAgendaError('adjustAhCounterRecordByWord:insert', error, {
            meetingId: input.meetingId,
            participantKey: input.participantKey,
            fillerWord: normalizedFillerWord,
            delta
          })
          return {success: false, error: error.message}
        }

        return {success: true, data: data as AhCounterRecordV2}
      }

      if (nextHitCount <= 0) {
        const {error} = await supabase
          .from('ah_counter_records_v2')
          .update({
            deleted_at: timestamp,
            updated_at: timestamp,
            observer_user_id: actor.userId,
            observer_name: actor.name,
            observer_role: 'ah_counter',
            row_version: Number(existing.row_version || 1) + 1
          })
          .eq('id', existing.id)
          .eq('row_version', existing.row_version)

        if (error) {
          logAgendaError('adjustAhCounterRecordByWord:deleteWhenZero', error, {
            meetingId: input.meetingId,
            participantKey: input.participantKey,
            fillerWord: normalizedFillerWord,
            delta
          })
          return {success: false, error: error.message}
        }

        return {success: true, data: null}
      }

      const {data, error} = await supabase
        .from('ah_counter_records_v2')
        .update({
          hit_count: nextHitCount,
          sample_quote: input.sampleQuote?.trim() ? input.sampleQuote.trim() : (existing.sample_quote ?? null),
          related_item_key: input.relatedItemKey ?? existing.related_item_key ?? null,
          observer_user_id: actor.userId,
          observer_name: actor.name,
          observer_role: 'ah_counter',
          updated_at: timestamp,
          deleted_at: null,
          row_version: Number(existing.row_version || 1) + 1
        })
        .eq('id', existing.id)
        .eq('row_version', existing.row_version)
        .select('*')
        .single()

      if (error) {
        logAgendaError('adjustAhCounterRecordByWord:update', error, {
          meetingId: input.meetingId,
          participantKey: input.participantKey,
          fillerWord: normalizedFillerWord,
          delta
        })
        return {success: false, error: error.message}
      }

      return {success: true, data: data as AhCounterRecordV2}
    } catch (error) {
      return {success: false, error: toErrorMessage(error, '调整哼哈官记录失败')}
    }
  },

  async createWordOfDayHit(input: CreateWordOfDayHitInput): Promise<AgendaServiceResult<WordOfDayHitV2>> {
    const actor = normalizeActor(input.actor)
    const timestamp = nowMs()

    try {
      const {data: existing, error: fetchError} = await supabase
        .from('word_of_day_hits_v2')
        .select('*')
        .eq('meeting_id', input.meetingId)
        .eq('participant_key', input.participantKey)
        .eq('word_text', input.wordText)
        .is('deleted_at', null)
        .maybeSingle()

      if (fetchError) {
        logAgendaError('createWordOfDayHit:fetchExisting', fetchError, {
          meetingId: input.meetingId,
          participantKey: input.participantKey,
          wordText: input.wordText
        })
        return {success: false, error: fetchError.message}
      }

      const nextHitCount = Math.max(0, Number(existing?.hit_count || 0) + input.delta)

      let data: unknown
      let error: {message: string} | null = null

      if (!existing) {
        const insertResult = await supabase
          .from('word_of_day_hits_v2')
          .insert({
            meeting_id: input.meetingId,
            participant_key: input.participantKey,
            word_text: input.wordText,
            hit_count: nextHitCount,
            related_item_key: input.relatedItemKey ?? null,
            observer_user_id: actor.userId,
            observer_name: actor.name,
            observer_role: 'grammarian',
            created_at: timestamp,
            updated_at: timestamp
          })
          .select('*')
          .single()

        data = insertResult.data
        error = insertResult.error
      } else {
        const updateResult = await supabase
          .from('word_of_day_hits_v2')
          .update({
            hit_count: nextHitCount,
            related_item_key: input.relatedItemKey ?? existing.related_item_key ?? null,
            observer_user_id: actor.userId,
            observer_name: actor.name,
            observer_role: 'grammarian',
            updated_at: timestamp,
            deleted_at: null,
            row_version: Number(existing.row_version || 1) + 1
          })
          .eq('id', existing.id)
          .eq('row_version', existing.row_version)
          .select('*')
          .single()

        data = updateResult.data
        error = updateResult.error
      }

      if (error) {
        logAgendaError('createWordOfDayHit', error, {
          meetingId: input.meetingId,
          participantKey: input.participantKey,
          adjustment: input.delta
        })
        return {success: false, error: error.message}
      }

      return {success: true, data: data as WordOfDayHitV2}
    } catch (error) {
      return {success: false, error: toErrorMessage(error, '写入每日一词记录失败')}
    }
  },

  async adjustWordOfDayHit(input: AdjustWordOfDayHitInput): Promise<AgendaServiceResult<WordOfDayHitV2 | null>> {
    const actor = normalizeActor(input.actor)
    const timestamp = nowMs()
    const normalizedWordText = input.wordText.trim()
    const delta = Math.trunc(input.delta)

    if (!normalizedWordText) {
      return {success: false, error: 'WORD_TEXT_REQUIRED'}
    }

    if (!delta) {
      return {success: true, data: null}
    }

    try {
      const {data: existing, error: fetchError} = await supabase
        .from('word_of_day_hits_v2')
        .select('*')
        .eq('meeting_id', input.meetingId)
        .eq('participant_key', input.participantKey)
        .eq('word_text', normalizedWordText)
        .is('deleted_at', null)
        .maybeSingle()

      if (fetchError) {
        logAgendaError('adjustWordOfDayHit:fetchExisting', fetchError, {
          meetingId: input.meetingId,
          participantKey: input.participantKey,
          wordText: normalizedWordText,
          delta
        })
        return {success: false, error: fetchError.message}
      }

      const existingCount = Number(existing?.hit_count || 0)
      const nextHitCount = Math.max(0, existingCount + delta)

      if (!existing) {
        if (nextHitCount <= 0) {
          return {success: true, data: null}
        }

        const {data, error} = await supabase
          .from('word_of_day_hits_v2')
          .insert({
            meeting_id: input.meetingId,
            participant_key: input.participantKey,
            word_text: normalizedWordText,
            hit_count: nextHitCount,
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
          logAgendaError('adjustWordOfDayHit:insert', error, {
            meetingId: input.meetingId,
            participantKey: input.participantKey,
            wordText: normalizedWordText,
            delta
          })
          return {success: false, error: error.message}
        }

        return {success: true, data: data as WordOfDayHitV2}
      }

      const {data, error} = await supabase
        .from('word_of_day_hits_v2')
        .update({
          hit_count: nextHitCount,
          related_item_key: input.relatedItemKey ?? existing.related_item_key ?? null,
          observer_user_id: actor.userId,
          observer_name: actor.name,
          observer_role: 'grammarian',
          updated_at: timestamp,
          deleted_at: nextHitCount <= 0 ? timestamp : null,
          row_version: Number(existing.row_version || 1) + 1
        })
        .eq('id', existing.id)
        .eq('row_version', existing.row_version)
        .select('*')
        .single()

      if (error) {
        logAgendaError('adjustWordOfDayHit:update', error, {
          meetingId: input.meetingId,
          participantKey: input.participantKey,
          wordText: normalizedWordText,
          delta
        })
        return {success: false, error: error.message}
      }

      if (nextHitCount <= 0) {
        return {success: true, data: null}
      }

      return {success: true, data: data as WordOfDayHitV2}
    } catch (error) {
      return {success: false, error: toErrorMessage(error, '调整每日一词记录失败')}
    }
  },

  async listImpromptuSpeechRecords(
    meetingId: string,
    agendaItemId?: string
  ): Promise<AgendaServiceResult<ImpromptuSpeechRecord[]>> {
    try {
      let query = supabase
        .from('impromptu_speeches_v2')
        .select('*')
        .eq('meeting_id', meetingId)
        .is('deleted_at', null)
        .order('agenda_item_id', {ascending: true})
        .order('sort_order', {ascending: true})
        .order('created_at', {ascending: true})

      if (agendaItemId) {
        query = query.eq('agenda_item_id', agendaItemId)
      }

      const {data, error} = await query

      if (error) {
        logAgendaError('listImpromptuSpeechRecords', error, {meetingId, agendaItemId})
        return {success: false, error: error.message}
      }

      return {success: true, data: ((data || []) as Record<string, unknown>[]).map(mapImpromptuSpeechRecord)}
    } catch (error) {
      return {success: false, error: toErrorMessage(error, '获取即兴记录失败')}
    }
  },

  async createImpromptuSpeechRecord(
    input: CreateImpromptuSpeechRecordInput
  ): Promise<AgendaServiceResult<ImpromptuSpeechRecord>> {
    const actor = normalizeActor(input.actor)
    const timestamp = nowMs()
    const speakerName = input.speakerName.trim()
    const speakerKey = speakerName

    if (!speakerName) {
      return {success: false, error: 'SPEAKER_NAME_REQUIRED'}
    }

    const participantResult = await ensureParticipantExists(input.meetingId, speakerKey, actor)
    if (!participantResult.success) {
      return {success: false, error: participantResult.error}
    }

    try {
      const {data, error} = await supabase
        .from('impromptu_speeches_v2')
        .insert({
          meeting_id: input.meetingId,
          agenda_item_id: input.agendaItemId,
          sort_order: input.sortOrder,
          speaker_name: speakerName,
          speaker_key: participantResult.participantKey,
          status: 'pending',
          pool_duration_seconds: input.poolDurationSeconds || 25 * 60,
          speech_planned_duration_seconds: input.speechPlannedDurationSeconds || 2 * 60,
          created_at: timestamp,
          updated_at: timestamp
        })
        .select('*')
        .single()

      if (error) {
        logAgendaError('createImpromptuSpeechRecord', error, {
          meetingId: input.meetingId,
          agendaItemId: input.agendaItemId,
          speakerName
        })
        return {success: false, error: error.message}
      }

      return {success: true, data: mapImpromptuSpeechRecord((data || {}) as Record<string, unknown>)}
    } catch (error) {
      return {success: false, error: toErrorMessage(error, '创建即兴记录失败')}
    }
  },

  async updateImpromptuSpeechRecord(
    input: UpdateImpromptuSpeechRecordInput
  ): Promise<AgendaServiceResult<ImpromptuSpeechRecord>> {
    const actor = normalizeActor(input.actor)
    const timestamp = nowMs()
    const patch = {...input.patch}
    let normalizedSpeakerKey: string | null = null

    if (typeof patch.speakerName === 'string') {
      patch.speakerName = patch.speakerName.trim()
      if (!patch.speakerName) {
        return {success: false, error: 'SPEAKER_NAME_REQUIRED'}
      }
    }

    if (typeof patch.speakerKey === 'string') {
      normalizedSpeakerKey = patch.speakerKey.trim()
    } else if (typeof patch.speakerName === 'string') {
      normalizedSpeakerKey = patch.speakerName
    }

    if (normalizedSpeakerKey) {
      const participantResult = await ensureParticipantExists(input.meetingId, normalizedSpeakerKey, actor)
      if (!participantResult.success) {
        return {success: false, error: participantResult.error}
      }
      normalizedSpeakerKey = participantResult.participantKey
    }

    try {
      const {data, error} = await supabase
        .from('impromptu_speeches_v2')
        .update({
          speaker_name: patch.speakerName,
          speaker_key: normalizedSpeakerKey ?? undefined,
          status: patch.status,
          pool_duration_seconds: patch.poolDurationSeconds,
          pool_remaining_seconds_at_start: patch.poolRemainingSecondsAtStart,
          started_with_low_remaining: patch.startedWithLowRemaining,
          speech_planned_duration_seconds: patch.speechPlannedDurationSeconds,
          speech_started_at: patch.speechStartedAt,
          speech_ended_at: patch.speechEndedAt,
          speech_duration_seconds: patch.speechDurationSeconds,
          is_overtime: patch.isOvertime,
          notes: patch.notes,
          deleted_at: patch.deletedAt,
          updated_at: timestamp
        })
        .eq('id', input.id)
        .eq('meeting_id', input.meetingId)
        .select('*')
        .single()

      if (error) {
        logAgendaError('updateImpromptuSpeechRecord', error, {
          id: input.id,
          meetingId: input.meetingId,
          patch
        })
        return {success: false, error: error.message}
      }

      return {success: true, data: mapImpromptuSpeechRecord((data || {}) as Record<string, unknown>)}
    } catch (error) {
      return {success: false, error: toErrorMessage(error, '更新即兴记录失败')}
    }
  },

  async clearImpromptuSpeechRecords(meetingId: string, agendaItemId?: string): Promise<AgendaServiceResult<number>> {
    const timestamp = nowMs()

    try {
      let query = supabase
        .from('impromptu_speeches_v2')
        .update({
          deleted_at: timestamp,
          updated_at: timestamp,
          status: 'cancelled'
        })
        .eq('meeting_id', meetingId)
        .is('deleted_at', null)

      if (agendaItemId) {
        query = query.eq('agenda_item_id', agendaItemId)
      }

      const {data, error} = await query.select('id')

      if (error) {
        logAgendaError('clearImpromptuSpeechRecords', error, {meetingId, agendaItemId})
        return {success: false, error: error.message}
      }

      return {success: true, data: (data || []).length}
    } catch (error) {
      return {success: false, error: toErrorMessage(error, '清空即兴记录失败')}
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
        logAgendaError('listGrammarianNotes', error, {meetingId})
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
        .gt('hit_count', 0)
        .is('deleted_at', null)
        .order('updated_at', {ascending: false})

      if (error) {
        logAgendaError('listAhCounterRecords', error, {meetingId})
        return {success: false, error: error.message}
      }

      return {success: true, data: (data || []) as AhCounterRecordV2[]}
    } catch (error) {
      return {success: false, error: toErrorMessage(error, '获取哼哈官记录失败')}
    }
  },

  async listWordOfDayHits(meetingId: string): Promise<AgendaServiceResult<WordOfDayHitV2[]>> {
    try {
      const {data, error} = await supabase
        .from('word_of_day_hits_v2')
        .select('*')
        .eq('meeting_id', meetingId)
        .is('deleted_at', null)
        .order('updated_at', {ascending: false})

      if (error) {
        logAgendaError('listWordOfDayHits', error, {meetingId})
        return {success: false, error: error.message}
      }

      return {success: true, data: (data || []) as WordOfDayHitV2[]}
    } catch (error) {
      return {success: false, error: toErrorMessage(error, '获取每日一词记录失败')}
    }
  }
}
