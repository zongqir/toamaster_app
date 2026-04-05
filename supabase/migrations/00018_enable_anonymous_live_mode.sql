-- Live mode: allow anonymous on-site use for agenda and officer workflows.
-- Product direction for this project is "现场优先", so anonymous access is
-- intentionally allowed for timer / timeline / officer-notes related tables.

CREATE OR REPLACE FUNCTION public.is_meeting_member_v2(target_meeting_id TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT TRUE;
$$;

CREATE OR REPLACE FUNCTION public.can_manage_meeting_roles_v2(target_meeting_id TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT TRUE;
$$;

CREATE OR REPLACE FUNCTION public.apply_agenda_ops_v2(
  p_meeting_id TEXT,
  p_base_agenda_version BIGINT,
  p_ops JSONB,
  p_client_ts BIGINT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current_version BIGINT;
  v_new_version BIGINT;
  v_actor_user_id UUID;
  v_actor_name TEXT;
  v_actor_name_source actor_name_source;
  v_op JSONB;
  v_op_id UUID;
  v_op_type agenda_op_type;
  v_item_key TEXT;
  v_payload JSONB;
  v_item JSONB;
  v_expected_row_version BIGINT;
  v_rows INTEGER;
  v_parent_item_key TEXT;
  v_applied_count INTEGER := 0;
  v_replayed_count INTEGER := 0;
  v_inserted_op_ids UUID[] := ARRAY[]::UUID[];
BEGIN
  v_actor_user_id := auth.uid();

  SELECT display_name, name_source
  INTO v_actor_name, v_actor_name_source
  FROM user_identity_profiles
  WHERE user_id = v_actor_user_id
  LIMIT 1;

  v_actor_name := COALESCE(v_actor_name, '未知用户');
  v_actor_name_source := COALESCE(v_actor_name_source, 'unknown');

  SELECT agenda_version
  INTO v_current_version
  FROM meetings
  WHERE id = p_meeting_id
  FOR UPDATE;

  IF v_current_version IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'MEETING_NOT_FOUND',
      'error', 'MEETING_NOT_FOUND'
    );
  END IF;

  IF v_current_version <> p_base_agenda_version THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'VERSION_CONFLICT',
      'error', 'VERSION_CONFLICT',
      'currentVersion', v_current_version
    );
  END IF;

  IF p_ops IS NULL OR jsonb_typeof(p_ops) <> 'array' OR jsonb_array_length(p_ops) = 0 THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'OPS_EMPTY',
      'error', 'OPS_EMPTY',
      'currentVersion', v_current_version
    );
  END IF;

  FOR v_op IN SELECT value FROM jsonb_array_elements(p_ops)
  LOOP
    v_op_id := NULLIF(v_op->>'opId', '')::UUID;
    IF v_op_id IS NULL THEN
      RAISE EXCEPTION 'INVALID_OP_ID';
    END IF;

    IF EXISTS (SELECT 1 FROM agenda_ops_v2 WHERE op_id = v_op_id) THEN
      v_replayed_count := v_replayed_count + 1;
      CONTINUE;
    END IF;

    v_op_type := (v_op->>'type')::agenda_op_type;
    v_payload := COALESCE(v_op->'payload', '{}'::jsonb);
    v_item := COALESCE(v_payload->'item', v_payload);
    v_item_key := COALESCE(NULLIF(v_op->>'itemKey', ''), NULLIF(v_item->>'itemKey', ''));
    v_expected_row_version := NULLIF(v_op->>'expectedRowVersion', '')::BIGINT;
    v_parent_item_key := NULL;

    IF v_op_type IN ('update_item', 'move_item', 'timer_checkpoint', 'status_change') THEN
      v_payload := COALESCE(v_payload->'patch', v_payload);
    END IF;

    CASE v_op_type
      WHEN 'create_item' THEN
        IF v_item_key IS NULL THEN
          RAISE EXCEPTION 'CREATE_ITEM_MISSING_KEY';
        END IF;

        INSERT INTO agenda_items_v2 (
          meeting_id,
          item_key,
          parent_item_key,
          node_kind,
          depth,
          order_index,
          title,
          speaker,
          speaker_role,
          slot_group_key,
          planned_duration,
          budget_mode,
          budget_limit_seconds,
          consume_parent_budget,
          actual_duration,
          actual_start_time,
          actual_end_time,
          start_time,
          item_type,
          rule_id,
          disabled,
          parent_title,
          status_code,
          status_color,
          status_rule_profile,
          status_updated_at,
          created_by_user_id,
          created_by_name,
          updated_by_user_id,
          updated_by_name,
          updated_by_name_source,
          created_at,
          updated_at
        ) VALUES (
          p_meeting_id,
          v_item_key,
          COALESCE(NULLIF(v_item->>'parent_item_key', ''), NULLIF(v_item->>'parentItemKey', '')),
          COALESCE(NULLIF(v_item->>'node_kind', ''), NULLIF(v_item->>'nodeKind', ''), 'leaf')::agenda_node_kind,
          COALESCE(NULLIF(v_item->>'depth', '')::SMALLINT, 1),
          COALESCE(
            NULLIF(v_item->>'order_index', '')::INTEGER,
            NULLIF(v_item->>'orderIndex', '')::INTEGER,
            0
          ),
          COALESCE(NULLIF(v_item->>'title', ''), '未命名环节'),
          NULLIF(v_item->>'speaker', ''),
          COALESCE(NULLIF(v_item->>'speaker_role', ''), NULLIF(v_item->>'speakerRole', ''), 'speaker')::agenda_speaker_role,
          COALESCE(NULLIF(v_item->>'slot_group_key', ''), NULLIF(v_item->>'slotGroupKey', '')),
          COALESCE(NULLIF(v_item->>'planned_duration', '')::INTEGER, NULLIF(v_item->>'plannedDuration', '')::INTEGER, 60),
          COALESCE(NULLIF(v_item->>'budget_mode', ''), NULLIF(v_item->>'budgetMode', ''), 'independent')::agenda_budget_mode,
          COALESCE(NULLIF(v_item->>'budget_limit_seconds', '')::INTEGER, NULLIF(v_item->>'budgetLimitSeconds', '')::INTEGER),
          CASE
            WHEN v_item ? 'consume_parent_budget' THEN COALESCE((v_item->>'consume_parent_budget')::BOOLEAN, TRUE)
            WHEN v_item ? 'consumeParentBudget' THEN COALESCE((v_item->>'consumeParentBudget')::BOOLEAN, TRUE)
            ELSE TRUE
          END,
          COALESCE(NULLIF(v_item->>'actual_duration', '')::INTEGER, NULLIF(v_item->>'actualDuration', '')::INTEGER),
          COALESCE(NULLIF(v_item->>'actual_start_time', '')::BIGINT, NULLIF(v_item->>'actualStartTime', '')::BIGINT),
          COALESCE(NULLIF(v_item->>'actual_end_time', '')::BIGINT, NULLIF(v_item->>'actualEndTime', '')::BIGINT),
          COALESCE(NULLIF(v_item->>'start_time', ''), NULLIF(v_item->>'startTime', '')),
          COALESCE(NULLIF(v_item->>'item_type', ''), NULLIF(v_item->>'itemType', ''), 'other'),
          COALESCE(NULLIF(v_item->>'rule_id', ''), NULLIF(v_item->>'ruleId', ''), 'short'),
          COALESCE((v_item->>'disabled')::BOOLEAN, FALSE),
          COALESCE(NULLIF(v_item->>'parent_title', ''), NULLIF(v_item->>'parentTitle', '')),
          COALESCE(NULLIF(v_item->>'status_code', ''), NULLIF(v_item->>'statusCode', ''), 'initial')::agenda_status_code,
          COALESCE(NULLIF(v_item->>'status_color', ''), NULLIF(v_item->>'statusColor', ''), 'blue')::agenda_status_color,
          COALESCE(NULLIF(v_item->>'status_rule_profile', ''), NULLIF(v_item->>'statusRuleProfile', ''), 'lte5m')::agenda_rule_profile,
          COALESCE(NULLIF(v_item->>'status_updated_at', '')::BIGINT, NULLIF(v_item->>'statusUpdatedAt', '')::BIGINT),
          v_actor_user_id,
          v_actor_name,
          v_actor_user_id,
          v_actor_name,
          v_actor_name_source,
          EXTRACT(EPOCH FROM NOW())::BIGINT * 1000,
          EXTRACT(EPOCH FROM NOW())::BIGINT * 1000
        );

        GET DIAGNOSTICS v_rows = ROW_COUNT;
        IF v_rows = 0 THEN
          RAISE EXCEPTION 'CREATE_ITEM_CONFLICT';
        END IF;

        SELECT parent_item_key
        INTO v_parent_item_key
        FROM agenda_items_v2
        WHERE meeting_id = p_meeting_id
          AND item_key = v_item_key
          AND deleted_at IS NULL;

      WHEN 'update_item' THEN
        IF v_item_key IS NULL THEN
          RAISE EXCEPTION 'UPDATE_ITEM_MISSING_KEY';
        END IF;

        UPDATE agenda_items_v2
        SET
          title = CASE WHEN v_payload ? 'title' THEN v_payload->>'title' ELSE title END,
          speaker = CASE WHEN v_payload ? 'speaker' THEN v_payload->>'speaker' ELSE speaker END,
          planned_duration = CASE
            WHEN v_payload ? 'planned_duration' THEN (v_payload->>'planned_duration')::INTEGER
            WHEN v_payload ? 'plannedDuration' THEN (v_payload->>'plannedDuration')::INTEGER
            ELSE planned_duration
          END,
          actual_duration = CASE
            WHEN v_payload ? 'actual_duration' THEN (v_payload->>'actual_duration')::INTEGER
            WHEN v_payload ? 'actualDuration' THEN (v_payload->>'actualDuration')::INTEGER
            ELSE actual_duration
          END,
          actual_start_time = CASE
            WHEN v_payload ? 'actual_start_time' THEN (v_payload->>'actual_start_time')::BIGINT
            WHEN v_payload ? 'actualStartTime' THEN (v_payload->>'actualStartTime')::BIGINT
            ELSE actual_start_time
          END,
          actual_end_time = CASE
            WHEN v_payload ? 'actual_end_time' THEN (v_payload->>'actual_end_time')::BIGINT
            WHEN v_payload ? 'actualEndTime' THEN (v_payload->>'actualEndTime')::BIGINT
            ELSE actual_end_time
          END,
          start_time = CASE
            WHEN v_payload ? 'start_time' THEN v_payload->>'start_time'
            WHEN v_payload ? 'startTime' THEN v_payload->>'startTime'
            ELSE start_time
          END,
          item_type = CASE
            WHEN v_payload ? 'item_type' THEN v_payload->>'item_type'
            WHEN v_payload ? 'itemType' THEN v_payload->>'itemType'
            ELSE item_type
          END,
          rule_id = CASE
            WHEN v_payload ? 'rule_id' THEN v_payload->>'rule_id'
            WHEN v_payload ? 'ruleId' THEN v_payload->>'ruleId'
            ELSE rule_id
          END,
          parent_item_key = CASE
            WHEN v_payload ? 'parent_item_key' THEN NULLIF(v_payload->>'parent_item_key', '')
            WHEN v_payload ? 'parentItemKey' THEN NULLIF(v_payload->>'parentItemKey', '')
            ELSE parent_item_key
          END,
          parent_title = CASE
            WHEN v_payload ? 'parent_title' THEN v_payload->>'parent_title'
            WHEN v_payload ? 'parentTitle' THEN v_payload->>'parentTitle'
            ELSE parent_title
          END,
          order_index = CASE
            WHEN v_payload ? 'order_index' THEN (v_payload->>'order_index')::INTEGER
            WHEN v_payload ? 'orderIndex' THEN (v_payload->>'orderIndex')::INTEGER
            ELSE order_index
          END,
          disabled = CASE
            WHEN v_payload ? 'disabled' THEN COALESCE((v_payload->>'disabled')::BOOLEAN, FALSE)
            ELSE disabled
          END,
          consume_parent_budget = CASE
            WHEN v_payload ? 'consume_parent_budget' THEN COALESCE((v_payload->>'consume_parent_budget')::BOOLEAN, TRUE)
            WHEN v_payload ? 'consumeParentBudget' THEN COALESCE((v_payload->>'consumeParentBudget')::BOOLEAN, TRUE)
            ELSE consume_parent_budget
          END,
          status_code = CASE
            WHEN v_payload ? 'status_code' THEN (v_payload->>'status_code')::agenda_status_code
            WHEN v_payload ? 'statusCode' THEN (v_payload->>'statusCode')::agenda_status_code
            ELSE status_code
          END,
          status_color = CASE
            WHEN v_payload ? 'status_color' THEN (v_payload->>'status_color')::agenda_status_color
            WHEN v_payload ? 'statusColor' THEN (v_payload->>'statusColor')::agenda_status_color
            ELSE status_color
          END,
          status_rule_profile = CASE
            WHEN v_payload ? 'status_rule_profile' THEN (v_payload->>'status_rule_profile')::agenda_rule_profile
            WHEN v_payload ? 'statusRuleProfile' THEN (v_payload->>'statusRuleProfile')::agenda_rule_profile
            ELSE status_rule_profile
          END,
          status_updated_at = CASE
            WHEN v_payload ? 'status_updated_at' THEN (v_payload->>'status_updated_at')::BIGINT
            WHEN v_payload ? 'statusUpdatedAt' THEN (v_payload->>'statusUpdatedAt')::BIGINT
            ELSE status_updated_at
          END,
          updated_by_user_id = v_actor_user_id,
          updated_by_name = v_actor_name,
          updated_by_name_source = v_actor_name_source,
          updated_at = EXTRACT(EPOCH FROM NOW())::BIGINT * 1000,
          row_version = row_version + 1
        WHERE meeting_id = p_meeting_id
          AND item_key = v_item_key
          AND deleted_at IS NULL
          AND (v_expected_row_version IS NULL OR row_version = v_expected_row_version)
        RETURNING parent_item_key INTO v_parent_item_key;

        GET DIAGNOSTICS v_rows = ROW_COUNT;
        IF v_rows = 0 THEN
          RAISE EXCEPTION 'ROW_VERSION_CONFLICT:%', v_item_key;
        END IF;

      WHEN 'delete_item' THEN
        IF v_item_key IS NULL THEN
          RAISE EXCEPTION 'DELETE_ITEM_MISSING_KEY';
        END IF;

        UPDATE agenda_items_v2
        SET
          deleted_at = EXTRACT(EPOCH FROM NOW())::BIGINT * 1000,
          updated_at = EXTRACT(EPOCH FROM NOW())::BIGINT * 1000,
          updated_by_user_id = v_actor_user_id,
          updated_by_name = v_actor_name,
          updated_by_name_source = v_actor_name_source,
          row_version = row_version + 1
        WHERE meeting_id = p_meeting_id
          AND item_key = v_item_key
          AND deleted_at IS NULL
          AND (v_expected_row_version IS NULL OR row_version = v_expected_row_version)
        RETURNING parent_item_key INTO v_parent_item_key;

        GET DIAGNOSTICS v_rows = ROW_COUNT;
        IF v_rows = 0 THEN
          RAISE EXCEPTION 'ROW_VERSION_CONFLICT:%', v_item_key;
        END IF;

      WHEN 'move_item' THEN
        IF v_item_key IS NULL THEN
          RAISE EXCEPTION 'MOVE_ITEM_MISSING_KEY';
        END IF;

        UPDATE agenda_items_v2
        SET
          parent_item_key = CASE
            WHEN v_payload ? 'parent_item_key' THEN NULLIF(v_payload->>'parent_item_key', '')
            WHEN v_payload ? 'parentItemKey' THEN NULLIF(v_payload->>'parentItemKey', '')
            ELSE parent_item_key
          END,
          order_index = CASE
            WHEN v_payload ? 'order_index' THEN (v_payload->>'order_index')::INTEGER
            WHEN v_payload ? 'orderIndex' THEN (v_payload->>'orderIndex')::INTEGER
            ELSE order_index
          END,
          depth = CASE
            WHEN v_payload ? 'depth' THEN (v_payload->>'depth')::SMALLINT
            ELSE depth
          END,
          updated_by_user_id = v_actor_user_id,
          updated_by_name = v_actor_name,
          updated_by_name_source = v_actor_name_source,
          updated_at = EXTRACT(EPOCH FROM NOW())::BIGINT * 1000,
          row_version = row_version + 1
        WHERE meeting_id = p_meeting_id
          AND item_key = v_item_key
          AND deleted_at IS NULL
          AND (v_expected_row_version IS NULL OR row_version = v_expected_row_version)
        RETURNING parent_item_key INTO v_parent_item_key;

        GET DIAGNOSTICS v_rows = ROW_COUNT;
        IF v_rows = 0 THEN
          RAISE EXCEPTION 'ROW_VERSION_CONFLICT:%', v_item_key;
        END IF;

      WHEN 'timer_checkpoint' THEN
        IF v_item_key IS NULL THEN
          RAISE EXCEPTION 'CHECKPOINT_MISSING_KEY';
        END IF;

        UPDATE agenda_items_v2
        SET
          actual_duration = CASE
            WHEN v_payload ? 'actual_duration' THEN (v_payload->>'actual_duration')::INTEGER
            WHEN v_payload ? 'actualDuration' THEN (v_payload->>'actualDuration')::INTEGER
            ELSE actual_duration
          END,
          actual_start_time = CASE
            WHEN v_payload ? 'actual_start_time' THEN (v_payload->>'actual_start_time')::BIGINT
            WHEN v_payload ? 'actualStartTime' THEN (v_payload->>'actualStartTime')::BIGINT
            ELSE actual_start_time
          END,
          actual_end_time = CASE
            WHEN v_payload ? 'actual_end_time' THEN (v_payload->>'actual_end_time')::BIGINT
            WHEN v_payload ? 'actualEndTime' THEN (v_payload->>'actualEndTime')::BIGINT
            ELSE actual_end_time
          END,
          updated_by_user_id = v_actor_user_id,
          updated_by_name = v_actor_name,
          updated_by_name_source = v_actor_name_source,
          updated_at = EXTRACT(EPOCH FROM NOW())::BIGINT * 1000,
          row_version = row_version + 1
        WHERE meeting_id = p_meeting_id
          AND item_key = v_item_key
          AND deleted_at IS NULL
          AND (v_expected_row_version IS NULL OR row_version = v_expected_row_version)
        RETURNING parent_item_key INTO v_parent_item_key;

        GET DIAGNOSTICS v_rows = ROW_COUNT;
        IF v_rows = 0 THEN
          RAISE EXCEPTION 'ROW_VERSION_CONFLICT:%', v_item_key;
        END IF;

      WHEN 'status_change' THEN
        IF v_item_key IS NULL THEN
          RAISE EXCEPTION 'STATUS_CHANGE_MISSING_KEY';
        END IF;

        UPDATE agenda_items_v2
        SET
          status_code = CASE
            WHEN v_payload ? 'status_code' THEN (v_payload->>'status_code')::agenda_status_code
            WHEN v_payload ? 'statusCode' THEN (v_payload->>'statusCode')::agenda_status_code
            ELSE status_code
          END,
          status_color = CASE
            WHEN v_payload ? 'status_color' THEN (v_payload->>'status_color')::agenda_status_color
            WHEN v_payload ? 'statusColor' THEN (v_payload->>'statusColor')::agenda_status_color
            ELSE status_color
          END,
          status_rule_profile = CASE
            WHEN v_payload ? 'status_rule_profile' THEN (v_payload->>'status_rule_profile')::agenda_rule_profile
            WHEN v_payload ? 'statusRuleProfile' THEN (v_payload->>'statusRuleProfile')::agenda_rule_profile
            ELSE status_rule_profile
          END,
          status_updated_at = CASE
            WHEN v_payload ? 'status_updated_at' THEN (v_payload->>'status_updated_at')::BIGINT
            WHEN v_payload ? 'statusUpdatedAt' THEN (v_payload->>'statusUpdatedAt')::BIGINT
            ELSE status_updated_at
          END,
          updated_by_user_id = v_actor_user_id,
          updated_by_name = v_actor_name,
          updated_by_name_source = v_actor_name_source,
          updated_at = EXTRACT(EPOCH FROM NOW())::BIGINT * 1000,
          row_version = row_version + 1
        WHERE meeting_id = p_meeting_id
          AND item_key = v_item_key
          AND deleted_at IS NULL
          AND (v_expected_row_version IS NULL OR row_version = v_expected_row_version)
        RETURNING parent_item_key INTO v_parent_item_key;

        GET DIAGNOSTICS v_rows = ROW_COUNT;
        IF v_rows = 0 THEN
          RAISE EXCEPTION 'ROW_VERSION_CONFLICT:%', v_item_key;
        END IF;

      ELSE
        RAISE EXCEPTION 'UNSUPPORTED_OP_TYPE:%', v_op_type;
    END CASE;

    PERFORM public.assert_segment_budget_v2(p_meeting_id, v_parent_item_key);

    INSERT INTO agenda_ops_v2 (
      op_id,
      meeting_id,
      item_key,
      op_type,
      base_agenda_version,
      applied_agenda_version,
      payload,
      actor_user_id,
      actor_name,
      actor_name_source,
      client_ts,
      server_ts,
      apply_status
    ) VALUES (
      v_op_id,
      p_meeting_id,
      v_item_key,
      v_op_type,
      p_base_agenda_version,
      NULL,
      v_payload,
      v_actor_user_id,
      v_actor_name,
      v_actor_name_source,
      COALESCE(p_client_ts, EXTRACT(EPOCH FROM NOW())::BIGINT * 1000),
      EXTRACT(EPOCH FROM NOW())::BIGINT * 1000,
      'applied'
    );

    v_inserted_op_ids := array_append(v_inserted_op_ids, v_op_id);
    v_applied_count := v_applied_count + 1;
  END LOOP;

  IF v_applied_count = 0 THEN
    RETURN jsonb_build_object(
      'success', true,
      'newVersion', v_current_version,
      'appliedCount', 0,
      'replayedCount', v_replayed_count
    );
  END IF;

  UPDATE meetings
  SET agenda_version = agenda_version + 1
  WHERE id = p_meeting_id
  RETURNING agenda_version INTO v_new_version;

  UPDATE agenda_ops_v2
  SET applied_agenda_version = v_new_version
  WHERE op_id = ANY(v_inserted_op_ids);

  RETURN jsonb_build_object(
    'success', true,
    'newVersion', v_new_version,
    'appliedCount', v_applied_count,
    'replayedCount', v_replayed_count
  );
EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', SQLSTATE,
      'error', SQLERRM,
      'currentVersion', v_current_version
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.apply_agenda_ops_v2(TEXT, BIGINT, JSONB, BIGINT) TO anon;
GRANT EXECUTE ON FUNCTION public.apply_agenda_ops_v2(TEXT, BIGINT, JSONB, BIGINT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.apply_agenda_ops_v2(TEXT, BIGINT, JSONB, BIGINT) TO service_role;

-- meeting_participants_v2
DROP POLICY IF EXISTS meeting_participants_v2_select_member ON meeting_participants_v2;
DROP POLICY IF EXISTS meeting_participants_v2_insert_timer ON meeting_participants_v2;
DROP POLICY IF EXISTS meeting_participants_v2_update_timer ON meeting_participants_v2;
DROP POLICY IF EXISTS meeting_participants_v2_delete_timer ON meeting_participants_v2;
DROP POLICY IF EXISTS meeting_participants_v2_select_authenticated ON meeting_participants_v2;
DROP POLICY IF EXISTS meeting_participants_v2_insert_authenticated ON meeting_participants_v2;
DROP POLICY IF EXISTS meeting_participants_v2_update_authenticated ON meeting_participants_v2;
DROP POLICY IF EXISTS meeting_participants_v2_delete_manager ON meeting_participants_v2;

CREATE POLICY meeting_participants_v2_select_live_mode ON meeting_participants_v2
FOR SELECT
USING (true);

CREATE POLICY meeting_participants_v2_insert_live_mode ON meeting_participants_v2
FOR INSERT
WITH CHECK (true);

CREATE POLICY meeting_participants_v2_update_live_mode ON meeting_participants_v2
FOR UPDATE
USING (true)
WITH CHECK (true);

CREATE POLICY meeting_participants_v2_delete_live_mode ON meeting_participants_v2
FOR DELETE
USING (true);

-- meeting_live_cursor_v2
DROP POLICY IF EXISTS live_cursor_v2_select_member ON meeting_live_cursor_v2;
DROP POLICY IF EXISTS live_cursor_v2_upsert_timer ON meeting_live_cursor_v2;
DROP POLICY IF EXISTS live_cursor_v2_update_timer ON meeting_live_cursor_v2;
DROP POLICY IF EXISTS live_cursor_v2_delete_timer ON meeting_live_cursor_v2;
DROP POLICY IF EXISTS live_cursor_v2_select_authenticated ON meeting_live_cursor_v2;

CREATE POLICY live_cursor_v2_select_live_mode ON meeting_live_cursor_v2
FOR SELECT
USING (true);

CREATE POLICY live_cursor_v2_insert_live_mode ON meeting_live_cursor_v2
FOR INSERT
WITH CHECK (true);

CREATE POLICY live_cursor_v2_update_live_mode ON meeting_live_cursor_v2
FOR UPDATE
USING (true)
WITH CHECK (true);

CREATE POLICY live_cursor_v2_delete_live_mode ON meeting_live_cursor_v2
FOR DELETE
USING (true);

-- agenda_ops_v2
DROP POLICY IF EXISTS agenda_ops_v2_select_member ON agenda_ops_v2;
DROP POLICY IF EXISTS agenda_ops_v2_insert_writer ON agenda_ops_v2;

CREATE POLICY agenda_ops_v2_select_live_mode ON agenda_ops_v2
FOR SELECT
USING (true);

CREATE POLICY agenda_ops_v2_insert_live_mode ON agenda_ops_v2
FOR INSERT
WITH CHECK (true);

-- grammarian_notes_v2
DROP POLICY IF EXISTS grammarian_notes_v2_select_member ON grammarian_notes_v2;
DROP POLICY IF EXISTS grammarian_notes_v2_insert_writer ON grammarian_notes_v2;
DROP POLICY IF EXISTS grammarian_notes_v2_update_writer ON grammarian_notes_v2;
DROP POLICY IF EXISTS grammarian_notes_v2_delete_writer ON grammarian_notes_v2;
DROP POLICY IF EXISTS grammarian_notes_v2_select_authenticated ON grammarian_notes_v2;
DROP POLICY IF EXISTS grammarian_notes_v2_insert_authenticated ON grammarian_notes_v2;
DROP POLICY IF EXISTS grammarian_notes_v2_update_owner ON grammarian_notes_v2;
DROP POLICY IF EXISTS grammarian_notes_v2_delete_owner ON grammarian_notes_v2;

CREATE POLICY grammarian_notes_v2_select_live_mode ON grammarian_notes_v2
FOR SELECT
USING (true);

CREATE POLICY grammarian_notes_v2_insert_live_mode ON grammarian_notes_v2
FOR INSERT
WITH CHECK (true);

CREATE POLICY grammarian_notes_v2_update_live_mode ON grammarian_notes_v2
FOR UPDATE
USING (true)
WITH CHECK (true);

CREATE POLICY grammarian_notes_v2_delete_live_mode ON grammarian_notes_v2
FOR DELETE
USING (true);

-- ah_counter_records_v2
DROP POLICY IF EXISTS ah_counter_records_v2_select_member ON ah_counter_records_v2;
DROP POLICY IF EXISTS ah_counter_records_v2_insert_writer ON ah_counter_records_v2;
DROP POLICY IF EXISTS ah_counter_records_v2_update_writer ON ah_counter_records_v2;
DROP POLICY IF EXISTS ah_counter_records_v2_delete_writer ON ah_counter_records_v2;
DROP POLICY IF EXISTS ah_counter_records_v2_select_authenticated ON ah_counter_records_v2;
DROP POLICY IF EXISTS ah_counter_records_v2_insert_authenticated ON ah_counter_records_v2;
DROP POLICY IF EXISTS ah_counter_records_v2_update_owner ON ah_counter_records_v2;
DROP POLICY IF EXISTS ah_counter_records_v2_delete_owner ON ah_counter_records_v2;

CREATE POLICY ah_counter_records_v2_select_live_mode ON ah_counter_records_v2
FOR SELECT
USING (true);

CREATE POLICY ah_counter_records_v2_insert_live_mode ON ah_counter_records_v2
FOR INSERT
WITH CHECK (true);

CREATE POLICY ah_counter_records_v2_update_live_mode ON ah_counter_records_v2
FOR UPDATE
USING (true)
WITH CHECK (true);

CREATE POLICY ah_counter_records_v2_delete_live_mode ON ah_counter_records_v2
FOR DELETE
USING (true);
