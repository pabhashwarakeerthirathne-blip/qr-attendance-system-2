-- ============================================================================
-- STUDENT EVENT ATTENDANCE MANAGEMENT SYSTEM
-- Phase 1: Initial Super Admin Setup & Optional Development Seed Data
-- ============================================================================
-- IMPORTANT:
-- Do NOT run the Development Test Data section in a live production database.
-- ============================================================================

-- ============================================================================
-- PART A: CONTROLLED FIRST SUPER ADMIN SETUP (PRODUCTION & DEVELOPMENT)
-- ============================================================================
-- Step 1: In Supabase Dashboard -> Authentication -> Users -> "Add User" -> "Create New User"
--         Enter your Super Admin email (e.g., superadmin@university.edu) and a strong password,
--         check "Auto Confirm User", and click "Create User".
-- Step 2: Run the query below (replace the email with your Super Admin email) to promote
--         that user to SUPER_ADMIN in public.profiles:

/*
INSERT INTO public.profiles (auth_user_id, role, name, email, status)
SELECT
    id AS auth_user_id,
    'SUPER_ADMIN' AS role,
    'System Super Admin' AS name,
    email,
    'ACTIVE' AS status
FROM auth.users
WHERE email = 'superadmin@university.edu'
ON CONFLICT (email) DO UPDATE
SET role = 'SUPER_ADMIN',
    status = 'ACTIVE';
*/

-- ============================================================================
-- PART B: DEVELOPMENT TEST DATA ONLY (Section 67)
-- Only run this block in local/development environments for testing!
-- ============================================================================

-- 1. Insert the 5 required development test students
INSERT INTO public.students (student_number, active)
VALUES
    ('PS/2023/001', true),
    ('PS/2023/002', true),
    ('PS/2023/003', true),
    ('PS/2023/174', true),
    ('PS/2023/250', true)
ON CONFLICT (student_number) DO NOTHING;

-- 2. Insert a development test event and open session for 2026-10-08
DO $$
DECLARE
    v_event_id UUID;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.events WHERE event_name = 'University Annual Program 2026') THEN
        INSERT INTO public.events (event_name, description, event_date, start_time, end_time, status)
        VALUES (
            'University Annual Program 2026',
            'Annual university orientation and academic symposium.',
            '2026-10-08',
            '08:00:00',
            '17:00:00',
            'ACTIVE'
        )
        RETURNING id INTO v_event_id;

        INSERT INTO public.attendance_sessions (event_id, session_date, start_time, end_time, status)
        VALUES (
            v_event_id,
            '2026-10-08',
            '08:00:00',
            '17:00:00',
            'OPEN'
        );
    END IF;
END $$;
