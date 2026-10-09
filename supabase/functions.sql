-- ============================================================================
-- STUDENT EVENT ATTENDANCE MANAGEMENT SYSTEM
-- Phase 1: Atomic Database Functions & RPCs
-- ============================================================================

-- ============================================================================
-- 1. END-OF-SESSION / CLOSE ATTENDANCE SESSION FUNCTION
-- Marks all records with entry_time NOT NULL and leaving_time IS NULL as
-- status = 'LEAVING_NOT_SCANNED' without inventing a fake leaving_time.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.close_attendance_session(p_session_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_profile_id UUID;
    v_missing_count INTEGER := 0;
BEGIN
    IF NOT public.is_super_admin() THEN
        RETURN jsonb_build_object(
            'success', false,
            'code', 'ACCESS_DENIED',
            'message', 'Access Denied: Super Admin privileges required.'
        );
    END IF;

    v_profile_id := public.current_profile_id();

    UPDATE public.attendance_sessions
    SET status = 'CLOSED',
        closed_at = now()
    WHERE id = p_session_id;

    WITH updated AS (
        UPDATE public.attendance_records
        SET status = 'LEAVING_NOT_SCANNED',
            leaving_status = 'LEAVING_NOT_SCANNED',
            updated_at = now()
        WHERE session_id = p_session_id
          AND entry_time IS NOT NULL
          AND leaving_time IS NULL
          AND status != 'LEAVING_NOT_SCANNED'
        RETURNING id
    )
    SELECT count(*) INTO v_missing_count FROM updated;

    INSERT INTO public.audit_logs (user_id, action, table_name, record_id, details)
    VALUES (
        v_profile_id,
        'Session closed',
        'attendance_sessions',
        p_session_id::text,
        jsonb_build_object('missing_leaving_marked', v_missing_count)
    );

    RETURN jsonb_build_object(
        'success', true,
        'session_id', p_session_id,
        'status', 'CLOSED',
        'missing_leaving_marked', v_missing_count,
        'message', 'Attendance session closed and missing leaving scans processed.'
    );
END;
$$;

-- ============================================================================
-- 2. OPEN ATTENDANCE SESSION FUNCTION
-- ============================================================================
CREATE OR REPLACE FUNCTION public.open_attendance_session(p_session_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_profile_id UUID;
BEGIN
    IF NOT public.is_super_admin() THEN
        RETURN jsonb_build_object(
            'success', false,
            'code', 'ACCESS_DENIED',
            'message', 'Access Denied: Super Admin privileges required.'
        );
    END IF;

    v_profile_id := public.current_profile_id();

    UPDATE public.attendance_sessions
    SET status = 'OPEN',
        closed_at = NULL
    WHERE id = p_session_id;

    -- Restore any records that were marked LEAVING_NOT_SCANNED back to CURRENTLY_ATTENDING
    -- if the session is re-opened on the same day
    UPDATE public.attendance_records
    SET status = 'CURRENTLY_ATTENDING',
        leaving_status = NULL,
        updated_at = now()
    WHERE session_id = p_session_id
      AND leaving_time IS NULL
      AND status = 'LEAVING_NOT_SCANNED';

    INSERT INTO public.audit_logs (user_id, action, table_name, record_id, details)
    VALUES (
        v_profile_id,
        'Session opened',
        'attendance_sessions',
        p_session_id::text,
        jsonb_build_object('status', 'OPEN')
    );

    RETURN jsonb_build_object(
        'success', true,
        'session_id', p_session_id,
        'status', 'OPEN',
        'message', 'Attendance session opened.'
    );
END;
$$;

-- ============================================================================
-- 3. ATOMIC ATTENDANCE SCAN / MANUAL ENTRY RPC
-- Handles both QR and MANUAL methods using identical core business logic.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.record_attendance_scan(
    p_student_number TEXT,
    p_session_id UUID,
    p_method TEXT DEFAULT 'QR',
    p_scan_mode TEXT DEFAULT 'AUTO'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_profile_id UUID;
    v_norm_number TEXT;
    v_method TEXT;
    v_mode TEXT;
    v_session RECORD;
    v_student RECORD;
    v_existing RECORD;
    v_now TIMESTAMPTZ := now();
    v_seconds_since_entry NUMERIC;
    v_duration_mins INTEGER;
    v_new_record_id UUID;
BEGIN
    -- 1. Verify active Admin or Super Admin
    IF NOT public.is_active_admin_or_super() THEN
        RETURN jsonb_build_object(
            'success', false,
            'code', 'ACCESS_DENIED',
            'message', 'Unauthorized: Active Admin or Super Admin account required.'
        );
    END IF;

    v_profile_id := public.current_profile_id();
    v_norm_number := upper(trim(coalesce(p_student_number, '')));
    v_method := upper(trim(coalesce(p_method, 'QR')));
    v_mode := upper(trim(coalesce(p_scan_mode, 'AUTO')));

    IF v_method NOT IN ('QR', 'MANUAL') THEN
        v_method := 'QR';
    END IF;

    -- 2. Validate Student Number Format (^PS/\d{4}/\d{3,}$)
    IF v_norm_number !~ '^PS/[0-9]{4}/[0-9]{3,}$' THEN
        RETURN jsonb_build_object(
            'success', false,
            'code', 'INVALID_FORMAT',
            'student_number', v_norm_number,
            'message', 'Invalid Student Number. Expected format: PS/2023/174'
        );
    END IF;

    -- 3. Validate Session
    SELECT * INTO v_session
    FROM public.attendance_sessions
    WHERE id = p_session_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'success', false,
            'code', 'SESSION_NOT_FOUND',
            'message', 'No active attendance session selected.'
        );
    END IF;

    -- Automatic session closing check if Current Time >= Session End Time on session date
    IF v_session.status = 'OPEN' AND (
        CURRENT_DATE > v_session.session_date
        OR (CURRENT_DATE = v_session.session_date AND LOCALTIME >= v_session.end_time)
    ) THEN
        UPDATE public.attendance_sessions
        SET status = 'CLOSED',
            closed_at = v_now
        WHERE id = p_session_id;

        UPDATE public.attendance_records
        SET status = 'LEAVING_NOT_SCANNED',
            leaving_status = 'LEAVING_NOT_SCANNED',
            updated_at = v_now
        WHERE session_id = p_session_id
          AND entry_time IS NOT NULL
          AND leaving_time IS NULL;

        RETURN jsonb_build_object(
            'success', false,
            'code', 'SESSION_CLOSED',
            'message', 'Attendance Session Closed. Session end time has been reached.'
        );
    END IF;

    IF v_session.status != 'OPEN' THEN
        RETURN jsonb_build_object(
            'success', false,
            'code', 'SESSION_CLOSED',
            'message', 'Attendance Session Closed. This attendance session is no longer accepting scans.'
        );
    END IF;

    -- 4. Lookup Student
    SELECT * INTO v_student
    FROM public.students
    WHERE student_number = v_norm_number
      AND active = true;

    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'success', false,
            'code', 'STUDENT_NOT_FOUND',
            'student_number', v_norm_number,
            'message', format('Student Not Found: %s is not registered in this event.', v_norm_number)
        );
    END IF;

    -- 5. Check Existing Attendance Record for (session_id, student_id)
    SELECT * INTO v_existing
    FROM public.attendance_records
    WHERE session_id = p_session_id
      AND student_id = v_student.id
    FOR UPDATE;

    -- CASE A: No record yet -> Record ENTRY
    IF NOT FOUND THEN
        IF v_mode = 'LEAVING_ONLY' THEN
            RETURN jsonb_build_object(
                'success', false,
                'code', 'NOT_CHECKED_IN',
                'student_number', v_norm_number,
                'message', format('No entry scan found for %s today.', v_norm_number)
            );
        END IF;

        INSERT INTO public.attendance_records (
            session_id,
            student_id,
            entry_time,
            entry_method,
            entry_admin_id,
            status
        ) VALUES (
            p_session_id,
            v_student.id,
            v_now,
            v_method,
            v_profile_id,
            'CURRENTLY_ATTENDING'
        )
        RETURNING id INTO v_new_record_id;

        INSERT INTO public.audit_logs (user_id, action, table_name, record_id, details)
        VALUES (
            v_profile_id,
            'Attendance created',
            'attendance_records',
            v_new_record_id::text,
            jsonb_build_object(
                'student_number', v_norm_number,
                'action', 'ENTRY',
                'method', v_method
            )
        );

        RETURN jsonb_build_object(
            'success', true,
            'student_number', v_norm_number,
            'action', 'ENTRY',
            'status', 'CURRENTLY_ATTENDING',
            'method', v_method,
            'time', to_char(v_now AT TIME ZONE 'UTC', 'HH24:MI:SS'),
            'entry_time', v_now,
            'message', 'Attendance recorded'
        );
    END IF;

    -- CASE B: Record exists and student already left
    IF v_existing.leaving_time IS NOT NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'code', 'ALREADY_LEFT',
            'student_number', v_norm_number,
            'action', 'ALREADY_LEFT',
            'status', v_existing.status,
            'time', to_char(v_existing.leaving_time AT TIME ZONE 'UTC', 'HH24:MI:SS'),
            'entry_time', v_existing.entry_time,
            'leaving_time', v_existing.leaving_time,
            'duration_minutes', v_existing.duration_minutes,
            'message', 'Student has already checked out for this session.'
        );
    END IF;

    -- CASE C: Record exists and student is currently attending (leaving_time IS NULL)
    v_seconds_since_entry := EXTRACT(EPOCH FROM (v_now - v_existing.entry_time));

    -- Prevent accidental repeated entry scans (within 15 seconds in AUTO mode, or always in ENTRY_ONLY mode)
    IF v_mode = 'ENTRY_ONLY' OR (v_mode = 'AUTO' AND v_seconds_since_entry < 15) THEN
        RETURN jsonb_build_object(
            'success', false,
            'code', 'ALREADY_CHECKED_IN',
            'student_number', v_norm_number,
            'action', 'ALREADY_CHECKED_IN',
            'status', 'CURRENTLY_ATTENDING',
            'time', to_char(v_existing.entry_time AT TIME ZONE 'UTC', 'HH24:MI:SS'),
            'entry_time', v_existing.entry_time,
            'message', 'Already Checked In'
        );
    END IF;

    -- Record LEAVING attendance
    v_duration_mins := GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (v_now - v_existing.entry_time)) / 60.0)::INTEGER);

    UPDATE public.attendance_records
    SET leaving_time = v_now,
        leaving_method = v_method,
        leaving_admin_id = v_profile_id,
        status = 'LEFT',
        leaving_status = 'LEFT_NORMALLY',
        duration_minutes = v_duration_mins,
        updated_at = v_now
    WHERE id = v_existing.id;

    INSERT INTO public.audit_logs (user_id, action, table_name, record_id, details)
    VALUES (
        v_profile_id,
        'Attendance leaving recorded',
        'attendance_records',
        v_existing.id::text,
        jsonb_build_object(
            'student_number', v_norm_number,
            'action', 'LEAVING',
            'method', v_method,
            'duration_minutes', v_duration_mins
        )
    );

    RETURN jsonb_build_object(
        'success', true,
        'student_number', v_norm_number,
        'action', 'LEAVING',
        'status', 'LEFT',
        'leaving_status', 'LEFT_NORMALLY',
        'method', v_method,
        'time', to_char(v_now AT TIME ZONE 'UTC', 'HH24:MI:SS'),
        'entry_time', v_existing.entry_time,
        'leaving_time', v_now,
        'duration_minutes', v_duration_mins,
        'message', 'Leaving attendance recorded'
    );
END;
$$;

-- ============================================================================
-- 4. PUBLIC STUDENT LOOKUP RPC (SECURITY DEFINER)
-- Strictly returns ONLY the attendance records for the requested Student Number.
-- Never exposes internal IDs, admin info, or other students.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.get_student_attendance_public(p_student_number TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
    v_norm_number TEXT;
    v_student_id UUID;
    v_days_attended INTEGER := 0;
    v_total_minutes INTEGER := 0;
    v_current_status TEXT := 'NOT_ATTENDING';
    v_records JSONB := '[]'::jsonb;
BEGIN
    v_norm_number := upper(trim(coalesce(p_student_number, '')));

    IF v_norm_number !~ '^PS/[0-9]{4}/[0-9]{3,}$' THEN
        RETURN jsonb_build_object(
            'success', false,
            'code', 'INVALID_FORMAT',
            'message', 'Invalid Student Number. Please enter format PS/2023/174.'
        );
    END IF;

    SELECT id INTO v_student_id
    FROM public.students
    WHERE student_number = v_norm_number
      AND active = true;

    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'success', false,
            'code', 'STUDENT_NOT_FOUND',
            'student_number', v_norm_number,
            'message', format('Student %s is not registered in the system.', v_norm_number)
        );
    END IF;

    SELECT
        count(*)::INTEGER,
        coalesce(sum( coalesce(ar.duration_minutes, 0) ), 0)::INTEGER
    INTO v_days_attended, v_total_minutes
    FROM public.attendance_records ar
    WHERE ar.student_id = v_student_id;

    -- Determine latest status
    SELECT ar.status INTO v_current_status
    FROM public.attendance_records ar
    JOIN public.attendance_sessions s ON s.id = ar.session_id
    WHERE ar.student_id = v_student_id
    ORDER BY s.session_date DESC, ar.entry_time DESC
    LIMIT 1;

    IF v_current_status IS NULL THEN
        v_current_status := 'NO_RECORDS';
    END IF;

    SELECT coalesce(
        jsonb_agg(
            jsonb_build_object(
                'session_date', s.session_date,
                'event_name', e.event_name,
                'entry_time', ar.entry_time,
                'leaving_time', ar.leaving_time,
                'duration_minutes', ar.duration_minutes,
                'status', ar.status,
                'leaving_status', ar.leaving_status
            )
            ORDER BY s.session_date DESC, ar.entry_time DESC
        ),
        '[]'::jsonb
    )
    INTO v_records
    FROM public.attendance_records ar
    JOIN public.attendance_sessions s ON s.id = ar.session_id
    JOIN public.events e ON e.id = s.event_id
    WHERE ar.student_id = v_student_id;

    RETURN jsonb_build_object(
        'success', true,
        'student_number', v_norm_number,
        'days_attended', v_days_attended,
        'total_minutes', v_total_minutes,
        'current_status', v_current_status,
        'records', v_records
    );
END;
$$;

-- Allow anon and authenticated roles to invoke the student lookup RPC
GRANT EXECUTE ON FUNCTION public.get_student_attendance_public(TEXT) TO anon, authenticated;

-- ============================================================================
-- 5. LIVE SESSION STATISTICS RPC
-- ============================================================================
CREATE OR REPLACE FUNCTION public.get_live_session_stats(p_session_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
    v_registered INTEGER := 0;
    v_entered INTEGER := 0;
    v_currently_inside INTEGER := 0;
    v_left INTEGER := 0;
    v_missing_leaving INTEGER := 0;
BEGIN
    IF NOT public.is_active_admin_or_super() THEN
        RETURN jsonb_build_object('success', false, 'code', 'ACCESS_DENIED');
    END IF;

    SELECT count(*)::INTEGER INTO v_registered
    FROM public.students
    WHERE active = true;

    IF p_session_id IS NOT NULL THEN
        SELECT
            count(*)::INTEGER,
            count(*) FILTER (WHERE status = 'CURRENTLY_ATTENDING' OR (entry_time IS NOT NULL AND leaving_time IS NULL AND status != 'LEAVING_NOT_SCANNED'))::INTEGER,
            count(*) FILTER (WHERE status = 'LEFT' OR leaving_time IS NOT NULL)::INTEGER,
            count(*) FILTER (WHERE status = 'LEAVING_NOT_SCANNED' OR leaving_status = 'LEAVING_NOT_SCANNED')::INTEGER
        INTO v_entered, v_currently_inside, v_left, v_missing_leaving
        FROM public.attendance_records
        WHERE session_id = p_session_id;
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'registered_students', v_registered,
        'entered', v_entered,
        'currently_inside', v_currently_inside,
        'left', v_left,
        'leaving_not_scanned', v_missing_leaving
    );
END;
$$;

-- ============================================================================
-- 6. ADMIN PROFILE REGISTRATION RPC (SUPER ADMIN ONLY)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.register_admin_profile(
    p_auth_user_id UUID,
    p_name TEXT,
    p_email TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_new_profile_id UUID;
BEGIN
    IF NOT public.is_super_admin() THEN
        RETURN jsonb_build_object(
            'success', false,
            'code', 'ACCESS_DENIED',
            'message', 'Access Denied: Only Super Admin can create Admin accounts.'
        );
    END IF;

    INSERT INTO public.profiles (auth_user_id, role, name, email, status)
    VALUES (p_auth_user_id, 'ADMIN', trim(p_name), lower(trim(p_email)), 'ACTIVE')
    ON CONFLICT (email) DO UPDATE
    SET auth_user_id = EXCLUDED.auth_user_id,
        name = EXCLUDED.name,
        status = 'ACTIVE'
    RETURNING id INTO v_new_profile_id;

    INSERT INTO public.audit_logs (user_id, action, table_name, record_id, details)
    VALUES (
        public.current_profile_id(),
        'Admin created',
        'profiles',
        v_new_profile_id::text,
        jsonb_build_object('name', trim(p_name), 'email', lower(trim(p_email)))
    );

    RETURN jsonb_build_object(
        'success', true,
        'profile_id', v_new_profile_id,
        'message', 'Admin account created successfully.'
    );
END;
$$;
