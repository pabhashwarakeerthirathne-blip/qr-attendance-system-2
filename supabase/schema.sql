-- ============================================================================
-- STUDENT EVENT ATTENDANCE MANAGEMENT SYSTEM
-- Phase 1: Database Schema, Constraints & Indexes (Supabase PostgreSQL)
-- ============================================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================================
-- 1. PROFILES TABLE (SUPER_ADMIN & ADMIN)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    auth_user_id UUID UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('SUPER_ADMIN', 'ADMIN')),
    name TEXT NOT NULL CHECK (char_length(trim(name)) >= 2),
    email TEXT NOT NULL UNIQUE CHECK (position('@' in email) > 1),
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_profiles_auth_user_id ON public.profiles(auth_user_id);
CREATE INDEX IF NOT EXISTS idx_profiles_role_status ON public.profiles(role, status);

-- ============================================================================
-- 2. STUDENTS TABLE
-- Primary identifier is strictly student_number in format PS/YYYY/NNN
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.students (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    student_number TEXT NOT NULL UNIQUE,
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT students_number_format_chk CHECK (student_number ~ '^PS/[0-9]{4}/[0-9]{3,}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_students_student_number ON public.students(student_number);
CREATE INDEX IF NOT EXISTS idx_students_active ON public.students(active);

-- ============================================================================
-- 3. EVENTS TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_name TEXT NOT NULL CHECK (char_length(trim(event_name)) >= 2),
    description TEXT NOT NULL DEFAULT '',
    event_date DATE NOT NULL,
    start_time TIME NOT NULL DEFAULT '08:00:00',
    end_time TIME NOT NULL DEFAULT '17:00:00',
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('UPCOMING', 'ACTIVE', 'COMPLETED', 'ARCHIVED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT events_time_order_chk CHECK (end_time > start_time)
);

CREATE INDEX IF NOT EXISTS idx_events_date_status ON public.events(event_date DESC, status);

-- ============================================================================
-- 4. ATTENDANCE SESSIONS TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.attendance_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    session_date DATE NOT NULL,
    start_time TIME NOT NULL DEFAULT '08:00:00',
    end_time TIME NOT NULL DEFAULT '17:00:00',
    status TEXT NOT NULL DEFAULT 'CLOSED' CHECK (status IN ('OPEN', 'CLOSED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at TIMESTAMPTZ,
    CONSTRAINT sessions_time_order_chk CHECK (end_time > start_time)
);

CREATE INDEX IF NOT EXISTS idx_sessions_event_id ON public.attendance_sessions(event_id);
CREATE INDEX IF NOT EXISTS idx_sessions_date_status ON public.attendance_sessions(session_date DESC, status);

-- ============================================================================
-- 5. ATTENDANCE RECORDS TABLE
-- Prevents duplicate attendance records per student per session via UNIQUE constraint
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.attendance_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES public.attendance_sessions(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES public.students(id) ON DELETE RESTRICT,
    entry_time TIMESTAMPTZ NOT NULL DEFAULT now(),
    leaving_time TIMESTAMPTZ,
    entry_method TEXT NOT NULL CHECK (entry_method IN ('QR', 'MANUAL')),
    leaving_method TEXT CHECK (leaving_method IS NULL OR leaving_method IN ('QR', 'MANUAL')),
    entry_admin_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    leaving_admin_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'CURRENTLY_ATTENDING' CHECK (
        status IN (
            'PRESENT',
            'CURRENTLY_ATTENDING',
            'LEFT',
            'LEAVING_NOT_SCANNED',
            'MANUALLY_RECORDED'
        )
    ),
    leaving_status TEXT CHECK (
        leaving_status IS NULL OR leaving_status IN ('LEFT_NORMALLY', 'LEAVING_NOT_SCANNED')
    ),
    duration_minutes INTEGER CHECK (duration_minutes IS NULL OR duration_minutes >= 0),
    notes TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_attendance_session_student UNIQUE (session_id, student_id),
    CONSTRAINT chk_leaving_after_entry CHECK (leaving_time IS NULL OR leaving_time >= entry_time)
);

CREATE INDEX IF NOT EXISTS idx_attendance_session_id ON public.attendance_records(session_id);
CREATE INDEX IF NOT EXISTS idx_attendance_student_id ON public.attendance_records(student_id);
CREATE INDEX IF NOT EXISTS idx_attendance_status ON public.attendance_records(status);
CREATE INDEX IF NOT EXISTS idx_attendance_entry_time ON public.attendance_records(entry_time DESC);

-- ============================================================================
-- 6. AUDIT LOGS TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    table_name TEXT NOT NULL,
    record_id TEXT,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON public.audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON public.audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON public.audit_logs(action);

-- ============================================================================
-- 7. AUTOMATIC UPDATED_AT TRIGGER
-- ============================================================================
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_students_updated_at ON public.students;
CREATE TRIGGER trg_students_updated_at
BEFORE UPDATE ON public.students
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_attendance_records_updated_at ON public.attendance_records;
CREATE TRIGGER trg_attendance_records_updated_at
BEFORE UPDATE ON public.attendance_records
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

-- ============================================================================
-- 8. REALTIME CONFIGURATION
-- Enable Supabase Realtime for live counters and scan feed
-- ============================================================================
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.attendance_records;
        ALTER PUBLICATION supabase_realtime ADD TABLE public.attendance_sessions;
    END IF;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;
