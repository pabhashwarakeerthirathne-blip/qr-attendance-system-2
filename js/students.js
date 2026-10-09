/**
 * js/students.js
 * Student Management (Add, Bulk CSV Import, Search, Edit, Delete) and
 * Public Student Attendance Lookup (strictly isolated by Student Number).
 */

import {
  initSupabase,
  getDevDb,
  saveDevDb,
  recordAuditLog
} from './supabase.js';
import { verifyRoleAccess } from './auth.js';
import {
  validateStudentNumber,
  normalizeStudentNumber
} from './utils.js';

/**
 * Public Student Lookup (Sections 5, 32, 46, 47).
 * Returns ONLY the attendance summary and records for the exact Student Number entered.
 * Never exposes internal database IDs, admin profiles, audit logs, or other students.
 */
export async function lookupStudentAttendancePublic(rawStudentNumber) {
  const validation = validateStudentNumber(rawStudentNumber);
  if (!validation.valid) {
    return {
      success: false,
      code: 'INVALID_FORMAT',
      student_number: validation.normalized || String(rawStudentNumber || '').trim(),
      message: 'Invalid Student Number'
    };
  }

  const studentNumber = validation.normalized;
  const client = initSupabase();

  if (client) {
    const { data, error } = await client.rpc('get_student_attendance_public', {
      p_student_number: studentNumber
    });
    if (error) {
      throw new Error(error.message);
    }
    return data;
  }

  // Development test sandbox lookup (mirrors get_student_attendance_public RPC)
  const db = getDevDb();
  const student = db.students.find(
    (s) => s.student_number === studentNumber && s.active !== false
  );

  if (!student) {
    return {
      success: false,
      code: 'STUDENT_NOT_FOUND',
      student_number: studentNumber,
      message: `Student Not Found: ${studentNumber} is not registered in the system.`
    };
  }

  const rawRecords = db.attendance_records
    .filter((r) => r.student_id === student.id)
    .map((r) => {
      const session = db.attendance_sessions.find((s) => s.id === r.session_id);
      const event = session ? db.events.find((e) => e.id === session.event_id) : null;
      return {
        session_date: session?.session_date || r.entry_time.slice(0, 10),
        event_name: event?.event_name || 'University Event',
        entry_time: r.entry_time,
        leaving_time: r.leaving_time,
        duration_minutes: r.duration_minutes,
        status: r.status,
        leaving_status: r.leaving_status
      };
    })
    .sort((a, b) => {
      const dateCmp = String(b.session_date).localeCompare(String(a.session_date));
      if (dateCmp !== 0) return dateCmp;
      return String(b.entry_time).localeCompare(String(a.entry_time));
    });

  const daysAttended = rawRecords.length;
  const totalMinutes = rawRecords.reduce(
    (sum, r) => sum + (Number.isFinite(Number(r.duration_minutes)) ? Number(r.duration_minutes) : 0),
    0
  );
  const currentStatus = rawRecords.length > 0 ? rawRecords[0].status : 'NO_RECORDS';

  return {
    success: true,
    student_number: studentNumber,
    days_attended: daysAttended,
    total_minutes: totalMinutes,
    current_status: currentStatus,
    records: rawRecords
  };
}

/**
 * Searches and lists students with pagination (Staff: ADMIN or SUPER_ADMIN).
 */
export async function listStudents({ search = '', page = 1, pageSize = 25 } = {}) {
  await verifyRoleAccess(['SUPER_ADMIN', 'ADMIN']);
  const queryText = normalizeStudentNumber(search);
  const offset = Math.max(0, (page - 1) * pageSize);

  const client = initSupabase();
  if (client) {
    let query = client
      .from('students')
      .select('id, student_number, active, created_at, updated_at', { count: 'exact' })
      .order('student_number', { ascending: true })
      .range(offset, offset + pageSize - 1);

    if (queryText) {
      query = query.ilike('student_number', `%${queryText}%`);
    }

    const { data, count, error } = await query;
    if (error) throw new Error(error.message);

    return {
      students: data || [],
      total: count || 0,
      page,
      pageSize
    };
  }

  const db = getDevDb();
  let filtered = db.students.filter((s) => s.active !== false);
  if (queryText) {
    filtered = filtered.filter((s) => s.student_number.includes(queryText));
  }
  filtered.sort((a, b) => a.student_number.localeCompare(b.student_number));

  const paged = filtered.slice(offset, offset + pageSize);
  return {
    students: paged,
    total: filtered.length,
    page,
    pageSize
  };
}

/**
 * Adds a single student after validating PS/YYYY/NNN format (Super Admin only).
 */
export async function addStudent(rawStudentNumber) {
  await verifyRoleAccess(['SUPER_ADMIN']);

  const validation = validateStudentNumber(rawStudentNumber);
  if (!validation.valid) {
    throw new Error(validation.error);
  }
  const studentNumber = validation.normalized;

  const client = initSupabase();
  if (client) {
    const { data: existing } = await client
      .from('students')
      .select('id, student_number')
      .eq('student_number', studentNumber)
      .maybeSingle();

    if (existing) {
      throw new Error(`Duplicate Student Number: ${studentNumber} is already registered.`);
    }

    const { data, error } = await client
      .from('students')
      .insert({ student_number: studentNumber, active: true })
      .select()
      .single();

    if (error) throw new Error(error.message);

    await recordAuditLog('Student added', 'students', data.id, {
      student_number: studentNumber
    });
    return data;
  }

  const db = getDevDb();
  const existing = db.students.find((s) => s.student_number === studentNumber);
  if (existing) {
    throw new Error(`Duplicate Student Number: ${studentNumber} is already registered.`);
  }

  const now = new Date().toISOString();
  const newStudent = {
    id: `stu-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    student_number: studentNumber,
    active: true,
    created_at: now,
    updated_at: now
  };

  db.students.push(newStudent);
  saveDevDb(db);
  await recordAuditLog('Student added', 'students', newStudent.id, {
    student_number: studentNumber
  });
  return newStudent;
}

/**
 * Updates an existing student's Student Number (Super Admin only).
 */
export async function updateStudent(studentId, newRawStudentNumber) {
  await verifyRoleAccess(['SUPER_ADMIN']);

  const validation = validateStudentNumber(newRawStudentNumber);
  if (!validation.valid) {
    throw new Error(validation.error);
  }
  const normalized = validation.normalized;

  const client = initSupabase();
  if (client) {
    const { data: duplicate } = await client
      .from('students')
      .select('id')
      .eq('student_number', normalized)
      .neq('id', studentId)
      .maybeSingle();

    if (duplicate) {
      throw new Error(`Student Number ${normalized} already belongs to another record.`);
    }

    const { data, error } = await client
      .from('students')
      .update({ student_number: normalized })
      .eq('id', studentId)
      .select()
      .single();

    if (error) throw new Error(error.message);

    await recordAuditLog('Student updated', 'students', studentId, {
      student_number: normalized
    });
    return data;
  }

  const db = getDevDb();
  const target = db.students.find((s) => s.id === studentId);
  if (!target) throw new Error('Student not found.');

  const duplicate = db.students.find(
    (s) => s.student_number === normalized && s.id !== studentId
  );
  if (duplicate) {
    throw new Error(`Student Number ${normalized} already exists.`);
  }

  const oldNumber = target.student_number;
  target.student_number = normalized;
  target.updated_at = new Date().toISOString();
  saveDevDb(db);

  await recordAuditLog('Student updated', 'students', studentId, {
    old_student_number: oldNumber,
    new_student_number: normalized
  });
  return target;
}

/**
 * Deletes a student record (Super Admin only).
 */
export async function deleteStudent(studentId) {
  await verifyRoleAccess(['SUPER_ADMIN']);

  const client = initSupabase();
  if (client) {
    const { data: target } = await client
      .from('students')
      .select('student_number')
      .eq('id', studentId)
      .maybeSingle();

    const { error } = await client.from('students').delete().eq('id', studentId);
    if (error) {
      throw new Error(
        error.message.includes('foreign key')
          ? 'Cannot delete student with existing attendance history.'
          : error.message
      );
    }

    await recordAuditLog('Student deleted', 'students', studentId, {
      student_number: target?.student_number || studentId
    });
    return true;
  }

  const db = getDevDb();
  const idx = db.students.findIndex((s) => s.id === studentId);
  if (idx === -1) throw new Error('Student not found.');

  const target = db.students[idx];
  const hasRecords = db.attendance_records.some((r) => r.student_id === studentId);
  if (hasRecords) {
    throw new Error(
      `Cannot delete ${target.student_number} because attendance records exist for this student.`
    );
  }

  db.students.splice(idx, 1);
  saveDevDb(db);
  await recordAuditLog('Student deleted', 'students', studentId, {
    student_number: target.student_number
  });
  return true;
}

/**
 * Bulk imports students from CSV content (Section 9).
 * Validates every Student Number, detects duplicates, and returns a detailed breakdown.
 */
export async function bulkImportStudentsFromCSV(csvText) {
  await verifyRoleAccess(['SUPER_ADMIN']);

  const lines = String(csvText || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    throw new Error('The CSV file is empty.');
  }

  const importedRecords = [];
  const duplicateRecords = [];
  const invalidRecords = [];
  const seenInFile = new Set();

  // Fetch existing student numbers to detect database duplicates
  const existingSet = new Set();
  const client = initSupabase();
  if (client) {
    const { data, error } = await client.from('students').select('student_number');
    if (error) throw new Error(error.message);
    (data || []).forEach((s) => existingSet.add(s.student_number));
  } else {
    const db = getDevDb();
    db.students.forEach((s) => existingSet.add(s.student_number));
  }

  const toInsert = [];

  lines.forEach((line, index) => {
    // Extract first column if comma-separated
    const firstCol = line.split(',')[0].replace(/^["']|["']$/g, '').trim();

    // Skip header row if it is "student_number" or "student number"
    if (index === 0 && /^student[_\s]?number$/i.test(firstCol)) {
      return;
    }

    const validation = validateStudentNumber(firstCol);
    if (!validation.valid) {
      invalidRecords.push({
        line: index + 1,
        value: firstCol,
        reason: 'Invalid format (must match PS/YYYY/NNN)'
      });
      return;
    }

    const norm = validation.normalized;
    if (seenInFile.has(norm)) {
      duplicateRecords.push({
        line: index + 1,
        student_number: norm,
        reason: 'Duplicate within uploaded CSV'
      });
      return;
    }

    if (existingSet.has(norm)) {
      duplicateRecords.push({
        line: index + 1,
        student_number: norm,
        reason: 'Already registered in database'
      });
      return;
    }

    seenInFile.add(norm);
    toInsert.push(norm);
  });

  if (toInsert.length > 0) {
    if (client) {
      const rows = toInsert.map((student_number) => ({
        student_number,
        active: true
      }));
      const { error } = await client.from('students').insert(rows);
      if (error) throw new Error(error.message);
    } else {
      const db = getDevDb();
      const now = new Date().toISOString();
      toInsert.forEach((student_number, idx) => {
        db.students.push({
          id: `stu-${Date.now()}-${idx}`,
          student_number,
          active: true,
          created_at: now,
          updated_at: now
        });
      });
      saveDevDb(db);
    }

    importedRecords.push(...toInsert);
    await recordAuditLog('Bulk students imported', 'students', null, {
      imported_count: importedRecords.length,
      duplicate_count: duplicateRecords.length,
      invalid_count: invalidRecords.length
    });
  }

  return {
    importedCount: importedRecords.length,
    importedRecords,
    duplicateCount: duplicateRecords.length,
    duplicateRecords,
    invalidCount: invalidRecords.length,
    invalidRecords
  };
}
