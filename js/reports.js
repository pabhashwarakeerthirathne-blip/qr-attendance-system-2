/**
 * js/reports.js
 * Attendance Reporting, Advanced Filtering, Event History Summaries,
 * Audit Logs Querying, and CSV / Excel Export (Sections 20-23, 26, 42, 50-51).
 */

import { initSupabase, getDevDb, recordAuditLog } from './supabase.js';
import { verifyRoleAccess } from './auth.js';
import {
  normalizeStudentNumber,
  formatTime24h,
  formatDurationMinutes,
  getStatusMeta,
  exportToCSV,
  exportToExcelXML
} from './utils.js';

/**
 * Queries attendance records with comprehensive filters (Sections 20, 21, 22):
 * - date (single date YYYY-MM-DD)
 * - startDate & endDate (date range)
 * - eventId
 * - sessionId
 * - studentNumber (partial or exact match)
 * - status ('ALL', 'CURRENTLY_ATTENDING', 'LEFT', 'LEAVING_NOT_SCANNED', 'MANUALLY_RECORDED')
 */
export async function queryAttendanceReport({
  date = '',
  startDate = '',
  endDate = '',
  eventId = '',
  sessionId = '',
  studentNumber = '',
  status = 'ALL'
} = {}) {
  await verifyRoleAccess(['SUPER_ADMIN', 'ADMIN']);
  const normSearch = normalizeStudentNumber(studentNumber);

  const client = initSupabase();
  let records = [];
  let totalRegisteredStudents = 0;

  if (client) {
    const { count: stuCount } = await client
      .from('students')
      .select('id', { count: 'exact', head: true })
      .eq('active', true);
    totalRegisteredStudents = stuCount || 0;

    let query = client
      .from('attendance_records')
      .select(`
        id,
        session_id,
        student_id,
        entry_time,
        leaving_time,
        entry_method,
        leaving_method,
        entry_admin_id,
        leaving_admin_id,
        status,
        leaving_status,
        duration_minutes,
        notes,
        created_at,
        updated_at,
        students!inner ( id, student_number ),
        attendance_sessions!inner (
          id,
          event_id,
          session_date,
          start_time,
          end_time,
          status,
          events ( id, event_name )
        )
      `)
      .order('entry_time', { ascending: false });

    if (sessionId) {
      query = query.eq('session_id', sessionId);
    }
    if (eventId) {
      query = query.eq('attendance_sessions.event_id', eventId);
    }
    if (date) {
      query = query.eq('attendance_sessions.session_date', date);
    }
    if (startDate) {
      query = query.gte('attendance_sessions.session_date', startDate);
    }
    if (endDate) {
      query = query.lte('attendance_sessions.session_date', endDate);
    }
    if (normSearch) {
      query = query.ilike('students.student_number', `%${normSearch}%`);
    }
    if (status && status !== 'ALL') {
      query = query.eq('status', status);
    }

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    records = (data || []).map((r) => ({
      id: r.id,
      session_id: r.session_id,
      student_id: r.student_id,
      student_number: r.students?.student_number || 'UNKNOWN',
      event_id: r.attendance_sessions?.event_id || '',
      event_name: r.attendance_sessions?.events?.event_name || 'Event',
      session_date: r.attendance_sessions?.session_date || '',
      entry_time: r.entry_time,
      leaving_time: r.leaving_time,
      entry_method: r.entry_method,
      leaving_method: r.leaving_method || '-',
      status: r.status,
      leaving_status: r.leaving_status,
      duration_minutes: r.duration_minutes,
      notes: r.notes || ''
    }));
  } else {
    // Development test sandbox report query
    const db = getDevDb();
    totalRegisteredStudents = db.students.filter((s) => s.active !== false).length;

    records = db.attendance_records
      .map((r) => {
        const stu = db.students.find((s) => s.id === r.student_id);
        const ses = db.attendance_sessions.find((s) => s.id === r.session_id);
        const ev = ses ? db.events.find((e) => e.id === ses.event_id) : null;
        const adm = db.profiles.find((p) => p.id === (r.leaving_admin_id || r.entry_admin_id));
        return {
          id: r.id,
          session_id: r.session_id,
          student_id: r.student_id,
          student_number: stu?.student_number || 'UNKNOWN',
          event_id: ev?.id || '',
          event_name: ev?.event_name || 'Event',
          session_date: ses?.session_date || r.entry_time.slice(0, 10),
          entry_time: r.entry_time,
          leaving_time: r.leaving_time,
          entry_method: r.entry_method,
          leaving_method: r.leaving_method || '-',
          admin_name: adm?.name || 'Admin',
          status: r.status,
          leaving_status: r.leaving_status,
          duration_minutes: r.duration_minutes,
          notes: r.notes || ''
        };
      })
      .filter((r) => {
        if (sessionId && r.session_id !== sessionId) return false;
        if (eventId && r.event_id !== eventId) return false;
        if (date && r.session_date !== date) return false;
        if (startDate && r.session_date < startDate) return false;
        if (endDate && r.session_date > endDate) return false;
        if (normSearch && !r.student_number.includes(normSearch)) return false;
        if (status && status !== 'ALL') {
          if (status === 'LEAVING_NOT_SCANNED') {
            return r.status === 'LEAVING_NOT_SCANNED' || r.leaving_status === 'LEAVING_NOT_SCANNED';
          }
          return r.status === status;
        }
        return true;
      })
      .sort((a, b) => String(b.entry_time).localeCompare(String(a.entry_time)));
  }

  // Calculate exact summary metrics using stored integer minutes (Section 47)
  const uniqueStudentsInReport = new Set(records.map((r) => r.student_number)).size;
  const totalMinutes = records.reduce(
    (sum, r) => sum + (Number.isFinite(Number(r.duration_minutes)) ? Number(r.duration_minutes) : 0),
    0
  );
  const currentlyPresent = records.filter(
    (r) =>
      r.status === 'CURRENTLY_ATTENDING' ||
      (r.entry_time && !r.leaving_time && r.status !== 'LEAVING_NOT_SCANNED')
  ).length;
  const leftCount = records.filter((r) => r.status === 'LEFT' || Boolean(r.leaving_time)).length;
  const missingLeavingCount = records.filter(
    (r) => r.status === 'LEAVING_NOT_SCANNED' || r.leaving_status === 'LEAVING_NOT_SCANNED'
  ).length;

  return {
    records,
    summary: {
      total_registered_students: totalRegisteredStudents,
      unique_students_in_report: uniqueStudentsInReport,
      total_records: records.length,
      total_minutes: totalMinutes,
      currently_present: currentlyPresent,
      left_count: leftCount,
      missing_leaving_count: missingLeavingCount
    }
  };
}

/**
 * Fetches Event History with attendance statistics per event (Section 42).
 */
export async function getEventsWithStats() {
  await verifyRoleAccess(['SUPER_ADMIN', 'ADMIN']);

  const client = initSupabase();
  if (client) {
    const { count: regCount } = await client
      .from('students')
      .select('id', { count: 'exact', head: true })
      .eq('active', true);

    const { data: events, error: evErr } = await client
      .from('events')
      .select(`
        *,
        attendance_sessions (
          id,
          session_date,
          start_time,
          end_time,
          status,
          attendance_records ( id, status, leaving_time, duration_minutes )
        )
      `)
      .order('event_date', { ascending: false });

    if (evErr) throw new Error(evErr.message);

    return (events || []).map((ev) => {
      const sessions = ev.attendance_sessions || [];
      const allRecs = sessions.flatMap((s) => s.attendance_records || []);
      const totalMins = allRecs.reduce((sum, r) => sum + (r.duration_minutes || 0), 0);
      return {
        ...ev,
        registered_students: regCount || 0,
        attended_count: allRecs.length,
        total_minutes: totalMins,
        sessions
      };
    });
  }

  const db = getDevDb();
  const regCount = db.students.filter((s) => s.active !== false).length;

  return [...db.events]
    .sort((a, b) => String(b.event_date).localeCompare(String(a.event_date)))
    .map((ev) => {
      const sessions = db.attendance_sessions.filter((s) => s.event_id === ev.id);
      const sessionIds = new Set(sessions.map((s) => s.id));
      const allRecs = db.attendance_records.filter((r) => sessionIds.has(r.session_id));
      const totalMins = allRecs.reduce((sum, r) => sum + (r.duration_minutes || 0), 0);
      return {
        ...ev,
        registered_students: regCount,
        attended_count: allRecs.length,
        total_minutes: totalMins,
        sessions
      };
    });
}

/**
 * Fetches Audit Logs for Super Admin (Section 26).
 */
export async function listAuditLogs({ actionFilter = '', limit = 100 } = {}) {
  await verifyRoleAccess(['SUPER_ADMIN']);

  const client = initSupabase();
  if (client) {
    let query = client
      .from('audit_logs')
      .select(`
        id,
        user_id,
        action,
        table_name,
        record_id,
        details,
        created_at,
        profiles ( name, email, role )
      `)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (actionFilter) {
      query = query.ilike('action', `%${actionFilter}%`);
    }

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    return (data || []).map((log) => ({
      ...log,
      user_name: log.profiles?.name || 'System',
      user_email: log.profiles?.email || ''
    }));
  }

  const db = getDevDb();
  let logs = db.audit_logs.map((log) => {
    const prof = db.profiles.find((p) => p.id === log.user_id);
    return {
      ...log,
      user_name: prof?.name || 'Super Admin',
      user_email: prof?.email || ''
    };
  });

  if (actionFilter) {
    const q = actionFilter.toLowerCase();
    logs = logs.filter((l) => l.action.toLowerCase().includes(q));
  }

  return logs.slice(0, limit);
}

/**
 * Exports a list of attendance records to CSV or Excel (.xls) with standard columns (Sections 23, 50, 51).
 */
export async function exportAttendanceRecords(records, filenameBase, format = 'csv') {
  await verifyRoleAccess(['SUPER_ADMIN']);

  const headers = [
    'Student Number',
    'Event',
    'Date',
    'Entry Time',
    'Leaving Time',
    'Duration',
    'Duration (Minutes)',
    'Entry Method',
    'Leaving Method',
    'Status',
    'Notes'
  ];

  const rows = (records || []).map((r) => {
    const statusMeta = getStatusMeta(r.status, r.leaving_status);
    return [
      r.student_number,
      r.event_name || 'Event',
      r.session_date || '',
      formatTime24h(r.entry_time),
      r.leaving_time ? formatTime24h(r.leaving_time) : '-',
      r.duration_minutes !== null && r.duration_minutes !== undefined
        ? formatDurationMinutes(r.duration_minutes)
        : '-',
      r.duration_minutes !== null && r.duration_minutes !== undefined
        ? String(r.duration_minutes)
        : '',
      r.entry_method || 'QR',
      r.leaving_method || '-',
      statusMeta.label,
      r.notes || ''
    ];
  });

  const cleanFileBase = filenameBase.replace(/\.(csv|xls|xlsx)$/i, '');

  if (format === 'xls') {
    exportToExcelXML(`${cleanFileBase}.xls`, 'Attendance Report', headers, rows);
  } else {
    exportToCSV(`${cleanFileBase}.csv`, headers, rows);
  }

  await recordAuditLog('Report exported', 'attendance_records', null, {
    filename: `${cleanFileBase}.${format}`,
    record_count: rows.length
  });
}
