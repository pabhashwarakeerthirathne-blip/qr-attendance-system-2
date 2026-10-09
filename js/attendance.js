/**
 * js/attendance.js
 * Unified Attendance Service (QR + Manual), Event Management, Session Management,
 * End-of-Session LEAVING_NOT_SCANNED Processing, Offline Queue Sync, and Manual Corrections.
 */

import {
  initSupabase,
  getDevDb,
  saveDevDb,
  recordAuditLog,
  enqueuePendingScan,
  getPendingScans,
  removePendingScanById
} from './supabase.js';
import { verifyRoleAccess, getCurrentProfile } from './auth.js';
import {
  validateStudentNumber,
  calculateDurationMinutes,
  formatTime12h,
  getTodayDateString,
  getCurrentTimeString
} from './utils.js';

/**
 * Checks if a session has passed its configured end_time and should automatically close (Section 17).
 */
function hasSessionExpired(session) {
  if (!session || session.status !== 'OPEN') return false;
  const today = getTodayDateString();
  const sDate = String(session.session_date).slice(0, 10);
  if (today > sDate) return true;
  if (today === sDate) {
    const nowTime = getCurrentTimeString().slice(0, 5);
    const endTime = String(session.end_time || '23:59').slice(0, 5);
    if (nowTime >= endTime) return true;
  }
  return false;
}

/**
 * Lists all events ordered by date descending.
 */
export async function listEvents() {
  await verifyRoleAccess(['SUPER_ADMIN', 'ADMIN']);
  const client = initSupabase();
  if (client) {
    const { data, error } = await client
      .from('events')
      .select('*')
      .order('event_date', { ascending: false });
    if (error) throw new Error(error.message);
    return data || [];
  }

  const db = getDevDb();
  return [...db.events].sort((a, b) => String(b.event_date).localeCompare(String(a.event_date)));
}

/**
 * Creates a new Event and an associated Attendance Session (Super Admin only - Section 41).
 */
export async function createEvent({
  event_name,
  description = '',
  event_date,
  start_time = '08:00',
  end_time = '17:00',
  openImmediately = true
}) {
  await verifyRoleAccess(['SUPER_ADMIN']);
  const cleanName = (event_name || '').trim();
  if (cleanName.length < 2) throw new Error('Event Name must be at least 2 characters.');
  if (!event_date) throw new Error('Event Date is required.');
  if (end_time <= start_time) throw new Error('End Time must be later than Start Time.');

  const client = initSupabase();
  if (client) {
    const { data: ev, error: evErr } = await client
      .from('events')
      .insert({
        event_name: cleanName,
        description: (description || '').trim(),
        event_date,
        start_time,
        end_time,
        status: 'ACTIVE'
      })
      .select()
      .single();

    if (evErr) throw new Error(evErr.message);

    const { data: ses, error: sesErr } = await client
      .from('attendance_sessions')
      .insert({
        event_id: ev.id,
        session_date: event_date,
        start_time,
        end_time,
        status: openImmediately ? 'OPEN' : 'CLOSED'
      })
      .select()
      .single();

    if (sesErr) throw new Error(sesErr.message);

    await recordAuditLog('Event created', 'events', ev.id, {
      event_name: cleanName,
      event_date,
      session_id: ses.id
    });

    return { event: ev, session: ses };
  }

  const db = getDevDb();
  const now = new Date().toISOString();
  const newEvent = {
    id: `evt-${Date.now()}`,
    event_name: cleanName,
    description: (description || '').trim(),
    event_date,
    start_time,
    end_time,
    status: 'ACTIVE',
    created_at: now
  };
  const newSession = {
    id: `ses-${Date.now()}`,
    event_id: newEvent.id,
    session_date: event_date,
    start_time,
    end_time,
    status: openImmediately ? 'OPEN' : 'CLOSED',
    created_at: now,
    closed_at: null
  };

  db.events.unshift(newEvent);
  db.attendance_sessions.unshift(newSession);
  saveDevDb(db);

  await recordAuditLog('Event created', 'events', newEvent.id, {
    event_name: cleanName,
    event_date,
    session_id: newSession.id
  });

  return { event: newEvent, session: newSession };
}

/**
 * Lists all attendance sessions with their linked event metadata.
 */
export async function listSessions() {
  await verifyRoleAccess(['SUPER_ADMIN', 'ADMIN']);
  const client = initSupabase();
  if (client) {
    const { data, error } = await client
      .from('attendance_sessions')
      .select('*, events(id, event_name, description, event_date, status)')
      .order('session_date', { ascending: false });

    if (error) throw new Error(error.message);
    return (data || []).map((s) => ({
      ...s,
      event_name: s.events?.event_name || 'Event'
    }));
  }

  const db = getDevDb();
  return db.attendance_sessions
    .map((s) => {
      const ev = db.events.find((e) => e.id === s.event_id);
      return {
        ...s,
        event_name: ev?.event_name || 'Event'
      };
    })
    .sort((a, b) => String(b.session_date).localeCompare(String(a.session_date)));
}

/**
 * Gets the current active/latest attendance session (auto-closing if past end_time).
 */
export async function getActiveOrLatestSession(preferredSessionId = null) {
  const sessions = await listSessions();
  if (sessions.length === 0) return null;

  let target = null;
  if (preferredSessionId) {
    target = sessions.find((s) => s.id === preferredSessionId);
  }
  if (!target) {
    target = sessions.find((s) => s.status === 'OPEN') || sessions[0];
  }

  // Enforce automatic closing if current time >= configured end_time (Section 17)
  if (target && target.status === 'OPEN' && hasSessionExpired(target)) {
    try {
      await closeAttendanceSessionInternal(target.id);
      target.status = 'CLOSED';
    } catch (_) {
      // If caller is ADMIN without direct update rights, the RPC will enforce it on scan
    }
  }

  return target;
}

/**
 * Internal helper to close session and mark missing leaving records as LEAVING_NOT_SCANNED.
 */
async function closeAttendanceSessionInternal(sessionId) {
  const client = initSupabase();
  if (client) {
    const { data, error } = await client.rpc('close_attendance_session', {
      p_session_id: sessionId
    });
    if (error) throw new Error(error.message);
    return data;
  }

  const db = getDevDb();
  const session = db.attendance_sessions.find((s) => s.id === sessionId);
  if (!session) throw new Error('Attendance session not found.');

  const now = new Date().toISOString();
  session.status = 'CLOSED';
  session.closed_at = now;

  let missingMarked = 0;
  db.attendance_records.forEach((rec) => {
    if (rec.session_id === sessionId && rec.entry_time && !rec.leaving_time) {
      rec.status = 'LEAVING_NOT_SCANNED';
      rec.leaving_status = 'LEAVING_NOT_SCANNED';
      // CRITICAL (Sections 14 & 49): Do NOT invent a fake leaving_time!
      rec.leaving_time = null;
      rec.duration_minutes = null;
      rec.updated_at = now;
      missingMarked += 1;
    }
  });

  saveDevDb(db);
  await recordAuditLog('Session closed', 'attendance_sessions', sessionId, {
    missing_leaving_marked: missingMarked
  });

  return {
    success: true,
    session_id: sessionId,
    status: 'CLOSED',
    missing_leaving_marked: missingMarked
  };
}

/**
 * Super Admin action: Close Attendance Session & process missing leaving scans (Sections 14, 16, 49).
 */
export async function closeAttendanceSession(sessionId) {
  await verifyRoleAccess(['SUPER_ADMIN']);
  return closeAttendanceSessionInternal(sessionId);
}

/**
 * Super Admin action: Open Attendance Session (Section 16).
 */
export async function openAttendanceSession(sessionId) {
  await verifyRoleAccess(['SUPER_ADMIN']);

  const client = initSupabase();
  if (client) {
    const { data, error } = await client.rpc('open_attendance_session', {
      p_session_id: sessionId
    });
    if (error) throw new Error(error.message);
    if (data && !data.success) throw new Error(data.message);
    return data;
  }

  const db = getDevDb();
  const session = db.attendance_sessions.find((s) => s.id === sessionId);
  if (!session) throw new Error('Attendance session not found.');

  // If session end_time was already passed today, extend end_time to 23:59 so it stays open
  const today = getTodayDateString();
  if (session.session_date === today && getCurrentTimeString().slice(0, 5) >= session.end_time.slice(0, 5)) {
    session.end_time = '23:59';
  }

  session.status = 'OPEN';
  session.closed_at = null;

  // Restore records that were marked LEAVING_NOT_SCANNED back to CURRENTLY_ATTENDING while session is open
  db.attendance_records.forEach((rec) => {
    if (rec.session_id === sessionId && !rec.leaving_time && rec.status === 'LEAVING_NOT_SCANNED') {
      rec.status = 'CURRENTLY_ATTENDING';
      rec.leaving_status = null;
      rec.updated_at = new Date().toISOString();
    }
  });

  saveDevDb(db);
  await recordAuditLog('Session opened', 'attendance_sessions', sessionId, {
    status: 'OPEN'
  });

  return {
    success: true,
    session_id: sessionId,
    status: 'OPEN'
  };
}

/**
 * Updates Session Settings (Event Name, Date, Start Time, End Time, Status - Section 16).
 */
export async function updateSessionSettings(sessionId, { event_name, session_date, start_time, end_time, status }) {
  await verifyRoleAccess(['SUPER_ADMIN']);
  if (end_time <= start_time) {
    throw new Error('End Time must be after Start Time.');
  }

  const client = initSupabase();
  if (client) {
    const { data: existingSession, error: fetchErr } = await client
      .from('attendance_sessions')
      .select('event_id, status')
      .eq('id', sessionId)
      .single();

    if (fetchErr) throw new Error(fetchErr.message);

    if (event_name) {
      await client
        .from('events')
        .update({ event_name: event_name.trim(), event_date: session_date, start_time, end_time })
        .eq('id', existingSession.event_id);
    }

    const { error: updErr } = await client
      .from('attendance_sessions')
      .update({ session_date, start_time, end_time })
      .eq('id', sessionId);

    if (updErr) throw new Error(updErr.message);

    if (status === 'CLOSED' && existingSession.status !== 'CLOSED') {
      await closeAttendanceSession(sessionId);
    } else if (status === 'OPEN' && existingSession.status !== 'OPEN') {
      await openAttendanceSession(sessionId);
    }

    await recordAuditLog('Session settings updated', 'attendance_sessions', sessionId, {
      event_name,
      session_date,
      start_time,
      end_time,
      status
    });
    return true;
  }

  const db = getDevDb();
  const session = db.attendance_sessions.find((s) => s.id === sessionId);
  if (!session) throw new Error('Session not found.');

  session.session_date = session_date;
  session.start_time = start_time;
  session.end_time = end_time;

  const ev = db.events.find((e) => e.id === session.event_id);
  if (ev && event_name) {
    ev.event_name = event_name.trim();
    ev.event_date = session_date;
    ev.start_time = start_time;
    ev.end_time = end_time;
  }

  saveDevDb(db);

  if (status === 'CLOSED' && session.status !== 'CLOSED') {
    await closeAttendanceSession(sessionId);
  } else if (status === 'OPEN' && session.status !== 'OPEN') {
    await openAttendanceSession(sessionId);
  }

  return true;
}

// ============================================================================
// UNIFIED ATTENDANCE RECORDING SERVICE (QR & MANUAL - Sections 10-14, 24, 55-56)
// ============================================================================

/**
 * Records an attendance scan (ENTRY or LEAVING) using identical validation and business rules
 * for both QR Code scanning and Manual Student Number entry.
 *
 * @param {string} rawStudentNumber - e.g. "PS/2023/174"
 * @param {object} options
 * @param {string} options.sessionId - Target attendance session ID
 * @param {'QR'|'MANUAL'} options.method - Scan method ('QR' or 'MANUAL')
 * @param {'AUTO'|'ENTRY_ONLY'|'LEAVING_ONLY'|'FORCE_LEAVING'} options.scanMode - Mode control
 */
export async function recordAttendanceScan(
  rawStudentNumber,
  { sessionId = null, method = 'QR', scanMode = 'AUTO' } = {}
) {
  const profile = await verifyRoleAccess(['SUPER_ADMIN', 'ADMIN']);
  const cleanMethod = method === 'MANUAL' ? 'MANUAL' : 'QR';

  // Step 1: Validate Student Number Format (^PS/\d{4}/\d{3,}$)
  const validation = validateStudentNumber(rawStudentNumber);
  if (!validation.valid) {
    return {
      success: false,
      code: 'INVALID_FORMAT',
      student_number: validation.normalized || String(rawStudentNumber || '').trim(),
      message: 'Invalid Student ID: This code does not contain a valid Student Number (PS/YYYY/NNN).'
    };
  }

  const studentNumber = validation.normalized;

  // Step 2: Resolve Session
  let targetSessionId = sessionId;
  if (!targetSessionId) {
    const activeSession = await getActiveOrLatestSession();
    targetSessionId = activeSession?.id || null;
  }

  if (!targetSessionId) {
    return {
      success: false,
      code: 'SESSION_NOT_FOUND',
      student_number: studentNumber,
      message: 'No active attendance session found.'
    };
  }

  // Step 3: Check network status for offline queue support (Section 40)
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    const queuedCount = enqueuePendingScan({
      studentNumber,
      sessionId: targetSessionId,
      method: cleanMethod,
      scanMode
    });
    return {
      success: true,
      queued: true,
      code: 'QUEUED_OFFLINE',
      student_number: studentNumber,
      action: 'QUEUED',
      status: 'PENDING_SYNC',
      time: formatTime12h(new Date().toISOString()),
      queued_count: queuedCount,
      message: 'Network disconnected. Scan saved to local pending queue and will sync automatically.'
    };
  }

  // Step 4: Execute Atomic Database RPC on Live Supabase
  const client = initSupabase();
  if (client) {
    try {
      const effectiveMode = scanMode === 'FORCE_LEAVING' ? 'LEAVING_ONLY' : scanMode;
      const { data, error } = await client.rpc('record_attendance_scan', {
        p_student_number: studentNumber,
        p_session_id: targetSessionId,
        p_method: cleanMethod,
        p_scan_mode: effectiveMode
      });

      if (error) throw error;
      return data;
    } catch (err) {
      // If network failed mid-request, queue locally
      if (err.message && /fetch|network|offline/i.test(err.message)) {
        const queuedCount = enqueuePendingScan({
          studentNumber,
          sessionId: targetSessionId,
          method: cleanMethod,
          scanMode
        });
        return {
          success: true,
          queued: true,
          code: 'QUEUED_OFFLINE',
          student_number: studentNumber,
          action: 'QUEUED',
          status: 'PENDING_SYNC',
          time: formatTime12h(new Date().toISOString()),
          queued_count: queuedCount,
          message: 'Network error. Scan queued locally for automatic retry.'
        };
      }
      throw new Error(err.message || 'Database error while recording attendance.');
    }
  }

  // Step 5: Execute Atomic Transaction in Development Sandbox (mirrors record_attendance_scan RPC)
  const db = getDevDb();
  const session = db.attendance_sessions.find((s) => s.id === targetSessionId);

  if (!session) {
    return {
      success: false,
      code: 'SESSION_NOT_FOUND',
      student_number: studentNumber,
      message: 'Attendance session not found.'
    };
  }

  // Automatic session closing check if Current Time >= Session End Time
  if (session.status === 'OPEN' && hasSessionExpired(session)) {
    await closeAttendanceSessionInternal(session.id);
    return {
      success: false,
      code: 'SESSION_CLOSED',
      student_number: studentNumber,
      message: 'Attendance Session Closed: Configured session end time has passed.'
    };
  }

  if (session.status !== 'OPEN') {
    return {
      success: false,
      code: 'SESSION_CLOSED',
      student_number: studentNumber,
      message: 'Attendance Session Closed: This attendance session is no longer accepting scans.'
    };
  }

  // Find registered student
  const student = db.students.find(
    (s) => s.student_number === studentNumber && s.active !== false
  );

  if (!student) {
    return {
      success: false,
      code: 'STUDENT_NOT_FOUND',
      student_number: studentNumber,
      message: `${studentNumber} is not registered in this event. Please contact the administrator.`
    };
  }

  const nowIso = new Date().toISOString();
  const existing = db.attendance_records.find(
    (r) => r.session_id === targetSessionId && r.student_id === student.id
  );

  // Case A: No record yet -> Record ENTRY
  if (!existing) {
    if (scanMode === 'LEAVING_ONLY') {
      return {
        success: false,
        code: 'NOT_CHECKED_IN',
        student_number: studentNumber,
        message: `No entry scan found for ${studentNumber} in this session.`
      };
    }

    const newRec = {
      id: `rec-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      session_id: targetSessionId,
      student_id: student.id,
      entry_time: nowIso,
      leaving_time: null,
      entry_method: cleanMethod,
      leaving_method: null,
      entry_admin_id: profile.id,
      leaving_admin_id: null,
      status: 'CURRENTLY_ATTENDING',
      leaving_status: null,
      duration_minutes: null,
      notes: '',
      created_at: nowIso,
      updated_at: nowIso
    };

    db.attendance_records.unshift(newRec);
    saveDevDb(db);

    await recordAuditLog('Attendance created', 'attendance_records', newRec.id, {
      student_number: studentNumber,
      action: 'ENTRY',
      method: cleanMethod
    });

    return {
      success: true,
      student_number: studentNumber,
      action: 'ENTRY',
      status: 'CURRENTLY_ATTENDING',
      method: cleanMethod,
      time: formatTime12h(nowIso),
      entry_time: nowIso,
      message: 'Attendance recorded'
    };
  }

  // Case B: Already checked out (LEFT)
  if (existing.leaving_time) {
    return {
      success: false,
      code: 'ALREADY_LEFT',
      student_number: studentNumber,
      action: 'ALREADY_LEFT',
      status: existing.status,
      time: formatTime12h(existing.leaving_time),
      entry_time: existing.entry_time,
      leaving_time: existing.leaving_time,
      duration_minutes: existing.duration_minutes,
      message: 'Already Checked Out for this session.'
    };
  }

  // Case C: Currently attending (entry_time exists, leaving_time is null)
  const secondsSinceEntry = (Date.now() - new Date(existing.entry_time).getTime()) / 1000;

  // Duplicate entry prevention (Section 12):
  // If scanned within 15 seconds in AUTO mode (or in ENTRY_ONLY mode), prevent accidental double scan
  if (
    scanMode === 'ENTRY_ONLY' ||
    (scanMode === 'AUTO' && secondsSinceEntry < 15)
  ) {
    return {
      success: false,
      code: 'ALREADY_CHECKED_IN',
      student_number: studentNumber,
      action: 'ALREADY_CHECKED_IN',
      status: 'CURRENTLY_ATTENDING',
      time: formatTime12h(existing.entry_time),
      entry_time: existing.entry_time,
      message: 'Already Checked In'
    };
  }

  // Record LEAVING
  const durationMins = calculateDurationMinutes(existing.entry_time, nowIso);
  existing.leaving_time = nowIso;
  existing.leaving_method = cleanMethod;
  existing.leaving_admin_id = profile.id;
  existing.status = 'LEFT';
  existing.leaving_status = 'LEFT_NORMALLY';
  existing.duration_minutes = durationMins;
  existing.updated_at = nowIso;

  saveDevDb(db);

  await recordAuditLog('Attendance leaving recorded', 'attendance_records', existing.id, {
    student_number: studentNumber,
    action: 'LEAVING',
    method: cleanMethod,
    duration_minutes: durationMins
  });

  return {
    success: true,
    student_number: studentNumber,
    action: 'LEAVING',
    status: 'LEFT',
    leaving_status: 'LEFT_NORMALLY',
    method: cleanMethod,
    time: formatTime12h(nowIso),
    entry_time: existing.entry_time,
    leaving_time: nowIso,
    duration_minutes: durationMins,
    message: 'Leaving recorded'
  };
}

/**
 * Synchronizes any offline queued scans when network connectivity returns (Section 40).
 */
export async function syncPendingScans() {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { synced: 0, remaining: getPendingScans().length };
  }

  const queue = getPendingScans();
  if (queue.length === 0) return { synced: 0, remaining: 0 };

  let synced = 0;
  for (const item of queue) {
    try {
      const res = await recordAttendanceScan(item.studentNumber, {
        sessionId: item.sessionId,
        method: item.method,
        scanMode: item.scanMode
      });
      if (!res.queued) {
        removePendingScanById(item.id);
        synced += 1;
      }
    } catch (_) {
      // Keep in queue if still failing due to network
    }
  }

  return { synced, remaining: getPendingScans().length };
}

// ============================================================================
// SUPER ADMIN MANUAL ATTENDANCE ADDITION & CORRECTION (Section 25)
// ============================================================================

/**
 * Manually edits an existing attendance record (Super Admin only - Section 25).
 * Records full before/after details in the audit log.
 */
export async function correctAttendanceRecord(
  recordId,
  { entry_time, leaving_time, status, notes }
) {
  await verifyRoleAccess(['SUPER_ADMIN']);

  const client = initSupabase();
  if (client) {
    const { data: before, error: fetchErr } = await client
      .from('attendance_records')
      .select('*, students(student_number)')
      .eq('id', recordId)
      .single();

    if (fetchErr || !before) throw new Error('Attendance record not found.');

    const updatedEntry = entry_time || before.entry_time;
    let updatedLeaving = leaving_time !== undefined ? leaving_time : before.leaving_time;
    let updatedStatus = status || before.status;
    let updatedLeavingStatus = before.leaving_status;

    if (updatedStatus === 'LEAVING_NOT_SCANNED') {
      updatedLeaving = null;
      updatedLeavingStatus = 'LEAVING_NOT_SCANNED';
    } else if (updatedStatus === 'CURRENTLY_ATTENDING') {
      updatedLeaving = null;
      updatedLeavingStatus = null;
    } else if (updatedLeaving) {
      updatedLeavingStatus = 'LEFT_NORMALLY';
      if (updatedStatus !== 'MANUALLY_RECORDED') {
        updatedStatus = 'LEFT';
      }
    }

    const durationMins = updatedLeaving
      ? calculateDurationMinutes(updatedEntry, updatedLeaving)
      : null;

    if (updatedLeaving && new Date(updatedLeaving) < new Date(updatedEntry)) {
      throw new Error('Leaving Time cannot be earlier than Entry Time.');
    }

    const { data: updated, error: updErr } = await client
      .from('attendance_records')
      .update({
        entry_time: updatedEntry,
        leaving_time: updatedLeaving,
        status: updatedStatus,
        leaving_status: updatedLeavingStatus,
        duration_minutes: durationMins,
        notes: notes !== undefined ? notes.trim() : before.notes
      })
      .eq('id', recordId)
      .select()
      .single();

    if (updErr) throw new Error(updErr.message);

    await recordAuditLog('Attendance manually edited', 'attendance_records', recordId, {
      student_number: before.students?.student_number,
      before: {
        entry_time: before.entry_time,
        leaving_time: before.leaving_time,
        status: before.status
      },
      after: {
        entry_time: updatedEntry,
        leaving_time: updatedLeaving,
        status: updatedStatus,
        duration_minutes: durationMins,
        notes
      }
    });

    return updated;
  }

  // Development sandbox manual correction
  const db = getDevDb();
  const rec = db.attendance_records.find((r) => r.id === recordId);
  if (!rec) throw new Error('Attendance record not found.');

  const student = db.students.find((s) => s.id === rec.student_id);
  const beforeSnapshot = {
    entry_time: rec.entry_time,
    leaving_time: rec.leaving_time,
    status: rec.status,
    duration_minutes: rec.duration_minutes
  };

  const updatedEntry = entry_time || rec.entry_time;
  let updatedLeaving = leaving_time !== undefined ? leaving_time : rec.leaving_time;
  let updatedStatus = status || rec.status;
  let updatedLeavingStatus = rec.leaving_status;

  if (updatedStatus === 'LEAVING_NOT_SCANNED') {
    updatedLeaving = null;
    updatedLeavingStatus = 'LEAVING_NOT_SCANNED';
  } else if (updatedStatus === 'CURRENTLY_ATTENDING') {
    updatedLeaving = null;
    updatedLeavingStatus = null;
  } else if (updatedLeaving) {
    updatedLeavingStatus = 'LEFT_NORMALLY';
    if (updatedStatus !== 'MANUALLY_RECORDED') {
      updatedStatus = 'LEFT';
    }
  }

  if (updatedLeaving && new Date(updatedLeaving) < new Date(updatedEntry)) {
    throw new Error('Leaving Time cannot be earlier than Entry Time.');
  }

  rec.entry_time = updatedEntry;
  rec.leaving_time = updatedLeaving || null;
  rec.status = updatedStatus;
  rec.leaving_status = updatedLeavingStatus;
  rec.duration_minutes = updatedLeaving
    ? calculateDurationMinutes(updatedEntry, updatedLeaving)
    : null;
  if (notes !== undefined) rec.notes = notes.trim();
  rec.updated_at = new Date().toISOString();

  saveDevDb(db);

  await recordAuditLog('Attendance manually edited', 'attendance_records', recordId, {
    student_number: student?.student_number,
    before: beforeSnapshot,
    after: {
      entry_time: rec.entry_time,
      leaving_time: rec.leaving_time,
      status: rec.status,
      duration_minutes: rec.duration_minutes,
      notes: rec.notes
    }
  });

  return rec;
}

/**
 * Super Admin manual creation of a full attendance record (Section 3, 25).
 */
export async function manualCreateAttendanceRecord({
  sessionId,
  studentNumber,
  entryTime,
  leavingTime = null,
  status = 'MANUALLY_RECORDED',
  notes = ''
}) {
  const profile = await verifyRoleAccess(['SUPER_ADMIN']);
  const validation = validateStudentNumber(studentNumber);
  if (!validation.valid) throw new Error(validation.error);

  const normNumber = validation.normalized;
  const durationMins = leavingTime ? calculateDurationMinutes(entryTime, leavingTime) : null;
  if (leavingTime && new Date(leavingTime) < new Date(entryTime)) {
    throw new Error('Leaving Time cannot be earlier than Entry Time.');
  }

  const client = initSupabase();
  if (client) {
    const { data: student } = await client
      .from('students')
      .select('id')
      .eq('student_number', normNumber)
      .maybeSingle();

    if (!student) throw new Error(`Student ${normNumber} is not registered.`);

    const { data, error } = await client
      .from('attendance_records')
      .insert({
        session_id: sessionId,
        student_id: student.id,
        entry_time: entryTime,
        leaving_time: leavingTime || null,
        entry_method: 'MANUAL',
        leaving_method: leavingTime ? 'MANUAL' : null,
        entry_admin_id: profile.id,
        leaving_admin_id: leavingTime ? profile.id : null,
        status,
        leaving_status: leavingTime
          ? 'LEFT_NORMALLY'
          : status === 'LEAVING_NOT_SCANNED'
          ? 'LEAVING_NOT_SCANNED'
          : null,
        duration_minutes: durationMins,
        notes: (notes || '').trim()
      })
      .select()
      .single();

    if (error) {
      throw new Error(
        error.message.includes('uq_attendance_session_student')
          ? `${normNumber} already has an attendance record in this session. Use Edit instead.`
          : error.message
      );
    }

    await recordAuditLog('Attendance manually created', 'attendance_records', data.id, {
      student_number: normNumber,
      status,
      duration_minutes: durationMins
    });
    return data;
  }

  const db = getDevDb();
  const student = db.students.find((s) => s.student_number === normNumber);
  if (!student) throw new Error(`Student ${normNumber} is not registered.`);

  const duplicate = db.attendance_records.find(
    (r) => r.session_id === sessionId && r.student_id === student.id
  );
  if (duplicate) {
    throw new Error(
      `${normNumber} already has an attendance record in this session. Use Edit to modify it.`
    );
  }

  const nowIso = new Date().toISOString();
  const newRec = {
    id: `rec-${Date.now()}`,
    session_id: sessionId,
    student_id: student.id,
    entry_time: entryTime,
    leaving_time: leavingTime || null,
    entry_method: 'MANUAL',
    leaving_method: leavingTime ? 'MANUAL' : null,
    entry_admin_id: profile.id,
    leaving_admin_id: leavingTime ? profile.id : null,
    status,
    leaving_status: leavingTime
      ? 'LEFT_NORMALLY'
      : status === 'LEAVING_NOT_SCANNED'
      ? 'LEAVING_NOT_SCANNED'
      : null,
    duration_minutes: durationMins,
    notes: (notes || '').trim(),
    created_at: nowIso,
    updated_at: nowIso
  };

  db.attendance_records.unshift(newRec);
  saveDevDb(db);

  await recordAuditLog('Attendance manually created', 'attendance_records', newRec.id, {
    student_number: normNumber,
    status,
    duration_minutes: durationMins
  });
  return newRec;
}

/**
 * Deletes an attendance record (Super Admin only - Section 26).
 */
export async function deleteAttendanceRecord(recordId) {
  await verifyRoleAccess(['SUPER_ADMIN']);

  const client = initSupabase();
  if (client) {
    const { error } = await client.from('attendance_records').delete().eq('id', recordId);
    if (error) throw new Error(error.message);
    await recordAuditLog('Attendance deleted', 'attendance_records', recordId, {});
    return true;
  }

  const db = getDevDb();
  const idx = db.attendance_records.findIndex((r) => r.id === recordId);
  if (idx === -1) throw new Error('Record not found.');
  const removed = db.attendance_records[idx];
  db.attendance_records.splice(idx, 1);
  saveDevDb(db);

  await recordAuditLog('Attendance deleted', 'attendance_records', recordId, {
    session_id: removed.session_id
  });
  return true;
}
