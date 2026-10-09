-- ============================================================================
-- STUDENT EVENT ATTENDANCE MANAGEMENT SYSTEM
-- Phase 1: Row Level Security (RLS) Policies
-- ============================================================================

-- Enable RLS on all tables
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.students ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- HELPER AUTHORIZATION FUNCTIONS (SECURITY DEFINER)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.profiles
        WHERE auth_user_id = auth.uid()
          AND role = 'SUPER_ADMIN'
          AND status = 'ACTIVE'
    );
$$;

CREATE OR REPLACE FUNCTION public.is_active_admin_or_super()
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.profiles
        WHERE auth_user_id = auth.uid()
          AND role IN ('SUPER_ADMIN', 'ADMIN')
          AND status = 'ACTIVE'
    );
$$;

CREATE OR REPLACE FUNCTION public.current_profile_id()
RETURNS UUID
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
    SELECT id
    FROM public.profiles
    WHERE auth_user_id = auth.uid()
      AND status = 'ACTIVE'
    LIMIT 1;
$$;

-- ============================================================================
-- 1. PROFILES POLICIES
-- ============================================================================
DROP POLICY IF EXISTS "Users can view own profile" ON public.profiles;
CREATE POLICY "Users can view own profile"
ON public.profiles
FOR SELECT
TO authenticated
USING (auth_user_id = auth.uid() OR public.is_super_admin());

DROP POLICY IF EXISTS "Super Admin full control over profiles" ON public.profiles;
CREATE POLICY "Super Admin full control over profiles"
ON public.profiles
FOR ALL
TO authenticated
USING (public.is_super_admin())
WITH CHECK (public.is_super_admin());

-- ============================================================================
-- 2. STUDENTS POLICIES
-- Students table is never directly readable by anon users; student lookup
-- goes strictly through the get_student_attendance_public() RPC.
-- ============================================================================
DROP POLICY IF EXISTS "Staff can view students" ON public.students;
CREATE POLICY "Staff can view students"
ON public.students
FOR SELECT
TO authenticated
USING (public.is_active_admin_or_super());

DROP POLICY IF EXISTS "Super Admin can insert students" ON public.students;
CREATE POLICY "Super Admin can insert students"
ON public.students
FOR INSERT
TO authenticated
WITH CHECK (public.is_super_admin());

DROP POLICY IF EXISTS "Super Admin can update students" ON public.students;
CREATE POLICY "Super Admin can update students"
ON public.students
FOR UPDATE
TO authenticated
USING (public.is_super_admin())
WITH CHECK (public.is_super_admin());

DROP POLICY IF EXISTS "Super Admin can delete students" ON public.students;
CREATE POLICY "Super Admin can delete students"
ON public.students
FOR DELETE
TO authenticated
USING (public.is_super_admin());

-- ============================================================================
-- 3. EVENTS POLICIES
-- ============================================================================
DROP POLICY IF EXISTS "Staff can view events" ON public.events;
CREATE POLICY "Staff can view events"
ON public.events
FOR SELECT
TO authenticated
USING (public.is_active_admin_or_super());

DROP POLICY IF EXISTS "Super Admin can manage events" ON public.events;
CREATE POLICY "Super Admin can manage events"
ON public.events
FOR ALL
TO authenticated
USING (public.is_super_admin())
WITH CHECK (public.is_super_admin());

-- ============================================================================
-- 4. ATTENDANCE SESSIONS POLICIES
-- ============================================================================
DROP POLICY IF EXISTS "Staff can view attendance sessions" ON public.attendance_sessions;
CREATE POLICY "Staff can view attendance sessions"
ON public.attendance_sessions
FOR SELECT
TO authenticated
USING (public.is_active_admin_or_super());

DROP POLICY IF EXISTS "Super Admin can manage attendance sessions" ON public.attendance_sessions;
CREATE POLICY "Super Admin can manage attendance sessions"
ON public.attendance_sessions
FOR ALL
TO authenticated
USING (public.is_super_admin())
WITH CHECK (public.is_super_admin());

-- ============================================================================
-- 5. ATTENDANCE RECORDS POLICIES
-- ============================================================================
DROP POLICY IF EXISTS "Staff can view attendance records" ON public.attendance_records;
CREATE POLICY "Staff can view attendance records"
ON public.attendance_records
FOR SELECT
TO authenticated
USING (public.is_active_admin_or_super());

DROP POLICY IF EXISTS "Super Admin can manage attendance records" ON public.attendance_records;
CREATE POLICY "Super Admin can manage attendance records"
ON public.attendance_records
FOR ALL
TO authenticated
USING (public.is_super_admin())
WITH CHECK (public.is_super_admin());

DROP POLICY IF EXISTS "Active Admin can insert attendance during open session" ON public.attendance_records;
CREATE POLICY "Active Admin can insert attendance during open session"
ON public.attendance_records
FOR INSERT
TO authenticated
WITH CHECK (
    public.is_active_admin_or_super()
    AND EXISTS (
        SELECT 1
        FROM public.attendance_sessions s
        WHERE s.id = session_id
          AND s.status = 'OPEN'
    )
);

DROP POLICY IF EXISTS "Active Admin can update leaving time during open session" ON public.attendance_records;
CREATE POLICY "Active Admin can update leaving time during open session"
ON public.attendance_records
FOR UPDATE
TO authenticated
USING (
    public.is_active_admin_or_super()
    AND EXISTS (
        SELECT 1
        FROM public.attendance_sessions s
        WHERE s.id = session_id
          AND s.status = 'OPEN'
    )
)
WITH CHECK (
    public.is_active_admin_or_super()
);

-- ============================================================================
-- 6. AUDIT LOGS POLICIES
-- Audit logs are append-only for active staff and viewable only by Super Admin
-- ============================================================================
DROP POLICY IF EXISTS "Super Admin can view audit logs" ON public.audit_logs;
CREATE POLICY "Super Admin can view audit logs"
ON public.audit_logs
FOR SELECT
TO authenticated
USING (public.is_super_admin());

DROP POLICY IF EXISTS "Active staff can insert audit logs" ON public.audit_logs;
CREATE POLICY "Active staff can insert audit logs"
ON public.audit_logs
FOR INSERT
TO authenticated
WITH CHECK (public.is_active_admin_or_super());
