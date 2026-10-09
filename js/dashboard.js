/**
 * js/dashboard.js
 * Live Dashboard Statistics, Current Event Student Counts, Recent Scans,
 * Currently Attending List, and Missing Leaving Scans ("ID Not Scanned for Leaving").
 */

import { initSupabase, getDevDb } from './supabase.js';
import { verifyRoleAccess } from './auth.js';
import { getActiveOrLatestSession } from './attendance.js';

/**
 * Fetches live attendance statistics and recent activity for the active or specified session.
 */
export async function getLiveDashboardData(sessionId = null) {
  await verifyRoleAccess(['SUPER_ADMIN', 'ADMIN']);

  const session = await getActiveOrLatestSession(sessionId);
  const targetSessionId = session?.id || null;

  const client = initSupabase();
  if (client) {
    // 1. Call RPC for fast aggregated counts
    const { data: statsData, error: statsErr } = await client.rpc('get_live_session_stats', {
      p_session_id: targetSessionId
    });
    if (statsErr) throw new Error(statsErr.message);

    // 2. Fetch recent records for this session
    let recentRecords = [];
    if (targetSessionId) {
      const { data: recs, error: recErr } = await client
        .from('attendance_records')
        .select(`
          id,
          session_id,
          student_id,
          entry_time,
          leaving_time,
          entry_method,
          leaving_method,
          status,
          leaving_status,
          duration_minutes,
          notes,
          updated_at,
          students ( student_number )
        `)
        .eq('session_id', targetSessionId)
        .order('updated_at', { ascending: false })
        .limit(100);

      if (recErr) throw new Error(recErr.message);
      recentRecords = (recs || []).map((r) => ({
        ...r,
        student_number: r.students?.student_number || 'UNKNOWN',
        event_name: session?.event_name || 'Event',
        session_date: session?.session_date || ''
      }));
    }

    const registered = statsData?.registered_students || 0;
    const entered = statsData?.entered || 0;
    const currentlyInside = statsData?.currently_inside || 0;
    const left = statsData?.left || 0;
    const leavingNotScanned = statsData?.leaving_not_scanned || 0;
    const attendancePercentage =
      registered > 0 ? Math.min(100, Math.round((entered / registered) * 100)) : 0;

    return {
      session,
      stats: {
        registered_students: registered,
        entered,
        currently_inside: currentlyInside,
        left,
        leaving_not_scanned: leavingNotScanned,
        attendance_percentage: attendancePercentage
      },
      recentScans: recentRecords.slice(0, 15),
      currentlyAttending: recentRecords.filter(
        (r) =>
          r.status === 'CURRENTLY_ATTENDING' ||
          (r.entry_time && !r.leaving_time && r.status !== 'LEAVING_NOT_SCANNED')
      ),
      missingLeavingScans: recentRecords.filter(
        (r) =>
          r.status === 'LEAVING_NOT_SCANNED' ||
          r.leaving_status === 'LEAVING_NOT_SCANNED'
      ),
      allSessionRecords: recentRecords
    };
  }

  // Development test sandbox implementation
  const db = getDevDb();
  const registered = db.students.filter((s) => s.active !== false).length;

  const sessionRecords = targetSessionId
    ? db.attendance_records
        .filter((r) => r.session_id === targetSessionId)
        .map((r) => {
          const stu = db.students.find((s) => s.id === r.student_id);
          const entryAdm = db.profiles.find((p) => p.id === r.entry_admin_id);
          const leaveAdm = db.profiles.find((p) => p.id === r.leaving_admin_id);
          return {
            ...r,
            student_number: stu?.student_number || 'UNKNOWN',
            event_name: session?.event_name || 'Event',
            session_date: session?.session_date || '',
            admin_name: leaveAdm?.name || entryAdm?.name || 'Admin'
          };
        })
        .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
    : [];

  const entered = sessionRecords.length;
  const currentlyInside = sessionRecords.filter(
    (r) =>
      r.status === 'CURRENTLY_ATTENDING' ||
      (r.entry_time && !r.leaving_time && r.status !== 'LEAVING_NOT_SCANNED')
  ).length;
  const left = sessionRecords.filter(
    (r) => r.status === 'LEFT' || Boolean(r.leaving_time)
  ).length;
  const leavingNotScanned = sessionRecords.filter(
    (r) =>
      r.status === 'LEAVING_NOT_SCANNED' ||
      r.leaving_status === 'LEAVING_NOT_SCANNED'
  ).length;

  const attendancePercentage =
    registered > 0 ? Math.min(100, Math.round((entered / registered) * 100)) : 0;

  return {
    session,
    stats: {
      registered_students: registered,
      entered,
      currently_inside: currentlyInside,
      left,
      leaving_not_scanned: leavingNotScanned,
      attendance_percentage: attendancePercentage
    },
    recentScans: sessionRecords.slice(0, 15),
    currentlyAttending: sessionRecords.filter(
      (r) =>
        r.status === 'CURRENTLY_ATTENDING' ||
        (r.entry_time && !r.leaving_time && r.status !== 'LEAVING_NOT_SCANNED')
    ),
    missingLeavingScans: sessionRecords.filter(
      (r) =>
        r.status === 'LEAVING_NOT_SCANNED' ||
        r.leaving_status === 'LEAVING_NOT_SCANNED'
    ),
    allSessionRecords: sessionRecords
  };
}
