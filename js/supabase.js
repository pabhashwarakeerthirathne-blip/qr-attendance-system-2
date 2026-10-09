/**
 * js/supabase.js
 * Supabase Client & Data Layer with:
 * 1. Live Supabase PostgreSQL + Auth + Realtime + RPC integration (using ONLY public URL & ANON_KEY)
 * 2. Offline Pending Scan Queue & Auto-Sync (Section 40)
 * 3. Built-in Development Test Sandbox (Section 67 & 68) when Supabase credentials are not yet configured
 */

import {
  validateStudentNumber,
  calculateDurationMinutes,
  getTodayDateString
} from './utils.js';

const STORAGE_KEYS = {
  CONFIG: 'uniattend_supabase_config',
  DEV_DB: 'uniattend_dev_db_v1',
  DEV_SESSION_USER: 'uniattend_dev_auth_session',
  PENDING_SCANS: 'uniattend_pending_scans_v1'
};

let supabaseClient = null;
let realtimeChannel = null;
const changeListeners = new Set();

/**
 * Reads Supabase configuration from environment variables, window config, or saved configuration.
 * NEVER uses or accepts service_role keys.
 */
export function getSupabaseConfig() {
  // HARDCODED CREDENTIALS FOR VERCEL DEPLOYMENT
  let envUrl = 'https://kygpngysspmfxqrzrsiw.supabase.co';
  let envAnonKey = 'sb_publishable_iQ8XRQ726ocIZoLRILpWFw_x54V6BId';

  try {
    if (typeof import.meta !== 'undefined' && import.meta.env) {
      envUrl = import.meta.env.VITE_SUPABASE_URL || envUrl;
      envAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || envAnonKey;
    }
  } catch (_) {
    // Standard ES module without Vite bundler
  }

  if (typeof window !== 'undefined' && window.__UNIATTEND_ENV__) {
    envUrl = window.__UNIATTEND_ENV__.SUPABASE_URL || envUrl;
    envAnonKey = window.__UNIATTEND_ENV__.SUPABASE_ANON_KEY || envAnonKey;
  }

  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEYS.CONFIG) || '{}');
    const url = (saved.url || envUrl).trim();
    const anonKey = (saved.anonKey || envAnonKey).trim();
    return {
      url,
      anonKey,
      isConfigured: Boolean(url && anonKey && url.startsWith('https://'))
    };
  } catch (_) {
    return { url: envUrl, anonKey: envAnonKey, isConfigured: true };
  }
}

/**
 * Saves public Supabase URL and Anon Key configuration.
 */
export function saveSupabaseConfig(url, anonKey) {
  const cleanUrl = (url || '').trim().replace(/\/+\$/, '');
  const cleanKey = (anonKey || '').trim();

  // Security guard: reject service_role keys if accidentally pasted
  if (cleanKey.includes('service_role')) {
    throw new Error('Security Error: Never use SUPABASE_SERVICE_ROLE_KEY in the frontend! Use the public anon key only.');
  }

  localStorage.setItem(
    STORAGE_KEYS.CONFIG,
    JSON.stringify({ url: cleanUrl, anonKey: cleanKey })
  );
  supabaseClient = null;
  return initSupabase();
}

/**
 * Initializes the Supabase client if credentials are configured and CDN library is available.
 */
export function initSupabase() {
  const config = getSupabaseConfig();
  if (config.isConfigured && typeof window !== 'undefined' && window.supabase?.createClient) {
    if (!supabaseClient) {
      supabaseClient = window.supabase.createClient(config.url, config.anonKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true
        }
      });
    }
    return supabaseClient;
  }
  ensureDevDatabase();
  return null;
}

export function isLiveSupabase() {
  return Boolean(initSupabase());
}

/**
 * Creates a non-persisting secondary Supabase client so Super Admin can register
 * new Admin accounts without overwriting their own active session.
 */
export function createEphemeralSupabaseClient() {
  const config = getSupabaseConfig();
  if (!config.isConfigured || !window.supabase?.createClient) return null;
  return window.supabase.createClient(config.url, config.anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    }
  });
}

// ============================================================================
// DEVELOPMENT TEST SANDBOX (Mirrors PostgreSQL Schema, Constraints & RPCs)
// Pre-seeded with Section 67 Test Students:
// PS/2023/001, PS/2023/002, PS/2023/003, PS/2023/174, PS/2023/250
// ============================================================================

function createInitialDevDatabase() {
  const today = getTodayDateString();
  const eventId = 'evt-2026-annual';
  const sessionId = 'ses-2026-today';
  const prevEventId = 'evt-2026-prev';
  const prevSessionId = 'ses-2026-prev';

  return {
    profiles: [
      {
        id: 'prof-super-admin',
        auth_user_id: 'usr-super-admin',
        role: 'SUPER_ADMIN',
        name: 'System Super Admin',
        email: 'superadmin@university.edu',
        password_hash: 'SuperAdmin@2026',
        status: 'ACTIVE',
        created_at: '2026-10-01T08:00:00.000Z'
      },
      {
        id: 'prof-admin-1',
        auth_user_id: 'usr-admin-1',
        role: 'ADMIN',
        name: 'Gate Scanner Admin',
        email: 'admin@university.edu',
        password_hash: 'Admin@2026',
        status: 'ACTIVE',
        created_at: '2026-10-01T08:15:00.000Z'
      }
    ],
    students: [
      { id: 'stu-001', student_number: 'PS/2023/001', active: true, created_at: '2026-10-01T09:00:00.000Z', updated_at: '2026-10-01T09:00:00.000Z' },
      { id: 'stu-002', student_number: 'PS/2023/002', active: true, created_at: '2026-10-01T09:00:00.000Z', updated_at: '2026-10-01T09:00:00.000Z' },
      { id: 'stu-003', student_number: 'PS/2023/003', active: true, created_at: '2026-10-01T09:00:00.000Z', updated_at: '2026-10-01T09:00:00.000Z' },
      { id: 'stu-174', student_number: 'PS/2023/174', active: true, created_at: '2026-10-01T09:00:00.000Z', updated_at: '2026-10-01T09:00:00.000Z' },
      { id: 'stu-250', student_number: 'PS/2023/250', active: true, created_at: '2026-10-01T09:00:00.000Z', updated_at: '2026-10-01T09:00:00.000Z' }
    ],
    events: [
      {
        id: eventId,
        event_name: 'University Annual Program 2026',
        description: 'Main university academic & student orientation event.',
        event_date: today,
        start_time: '08:00',
        end_time: '23:59',
        status: 'ACTIVE',
        created_at: '2026-10-01T08:00:00.000Z'
      },
      {
        id: prevEventId,
        event_name: 'Science Faculty Symposium 2026',
        description: 'Previous day academic workshop and poster session.',
        event_date: '2026-10-07',
        start_time: '08:00',
        end_time: '17:00',
        status: 'COMPLETED',
        created_at: '2026-10-01T08:00:00.000Z'
      }
    ],
    attendance_sessions: [
      {
        id: sessionId,
        event_id: eventId,
        session_date: today,
        start_time: '08:00',
        end_time: '23:59',
        status: 'OPEN',
        created_at: '2026-10-08T02:30:00.000Z',
        closed_at: null
      },
      {
        id: prevSessionId,
        event_id: prevEventId,
        session_date: '2026-10-07',
        start_time: '08:00',
        end_time: '17:00',
        status: 'CLOSED',
        created_at: '2026-10-07T02:30:00.000Z',
        closed_at: '2026-10-07T11:30:00.000Z'
      }
    ],
    attendance_records: [
      {
        id: 'rec-prev-174',
        session_id: prevSessionId,
        student_id: 'stu-174',
        entry_time: '2026-10-07T03:35:00.000Z',
        leaving_time: '2026-10-07T10:42:00.000Z',
        entry_method: 'QR',
        leaving_method: 'QR',
        entry_admin_id: 'prof-admin-1',
        leaving_admin_id: 'prof-admin-1',
        status: 'LEFT',
        leaving_status: 'LEFT_NORMALLY',
        duration_minutes: 427,
        notes: '',
        created_at: '2026-10-07T03:35:00.000Z',
        updated_at: '2026-10-07T10:42:00.000Z'
      },
      {
        id: 'rec-today-001',
        session_id: sessionId,
        student_id: 'stu-001',
        entry_time: new Date(Date.now() - 180 * 60000).toISOString(),
        leaving_time: new Date(Date.now() - 15 * 60000).toISOString(),
        entry_method: 'QR',
        leaving_method: 'QR',
        entry_admin_id: 'prof-admin-1',
        leaving_admin_id: 'prof-admin-1',
        status: 'LEFT',
        leaving_status: 'LEFT_NORMALLY',
        duration_minutes: 165,
        notes: '',
        created_at: new Date(Date.now() - 180 * 60000).toISOString(),
        updated_at: new Date(Date.now() - 15 * 60000).toISOString()
      },
      {
        id: 'rec-today-002',
        session_id: sessionId,
        student_id: 'stu-002',
        entry_time: new Date(Date.now() - 95 * 60000).toISOString(),
        leaving_time: null,
        entry_method: 'QR',
        leaving_method: null,
        entry_admin_id: 'prof-admin-1',
        leaving_admin_id: null,
        status: 'CURRENTLY_ATTENDING',
        leaving_status: null,
        duration_minutes: null,
        notes: '',
        created_at: new Date(Date.now() - 95 * 60000).toISOString(),
        updated_at: new Date(Date.now() - 95 * 60000).toISOString()
      }
    ],
    audit_logs: [
      {
        id: 'aud-init-1',
        user_id: 'prof-super-admin',
        action: 'Session opened',
        table_name: 'attendance_sessions',
        record_id: sessionId,
        details: { event_name: 'University Annual Program 2026', status: 'OPEN' },
        created_at: new Date(Date.now() - 200 * 60000).toISOString()
      }
    ]
  };
}

export function ensureDevDatabase() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.DEV_DB);
    if (!raw) {
      const initial = createInitialDevDatabase();
      localStorage.setItem(STORAGE_KEYS.DEV_DB, JSON.stringify(initial));
      return initial;
    }
    return JSON.parse(raw);
  } catch (_) {
    const initial = createInitialDevDatabase();
    localStorage.setItem(STORAGE_KEYS.DEV_DB, JSON.stringify(initial));
    return initial;
  }
}

export function getDevDb() {
  return ensureDevDatabase();
}

export function saveDevDb(db) {
  localStorage.setItem(STORAGE_KEYS.DEV_DB, JSON.stringify(db));
  notifyDataListeners();
}

export function resetDevDatabase() {
  const initial = createInitialDevDatabase();
  localStorage.setItem(STORAGE_KEYS.DEV_DB, JSON.stringify(initial));
  notifyDataListeners();
  return initial;
}

export function getDevSessionUser() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEYS.DEV_SESSION_USER) || localStorage.getItem(STORAGE_KEYS.DEV_SESSION_USER);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const db = getDevDb();
    // Always re-verify role & status against database (Section 64: Never trust localStorage role alone)
    const profile = db.profiles.find((p) => p.id === parsed.id && p.status === 'ACTIVE');
    return profile || null;
  } catch (_) {
    return null;
  }
}

export function setDevSessionUser(profile) {
  if (!profile) {
    sessionStorage.removeItem(STORAGE_KEYS.DEV_SESSION_USER);
    localStorage.removeItem(STORAGE_KEYS.DEV_SESSION_USER);
    return;
  }
  const safeData = { id: profile.id, email: profile.email };
  sessionStorage.setItem(STORAGE_KEYS.DEV_SESSION_USER, JSON.stringify(safeData));
  localStorage.setItem(STORAGE_KEYS.DEV_SESSION_USER, JSON.stringify(safeData));
}

/**
 * Records an audit log entry in either Live Supabase or Dev Database.
 */
export async function recordAuditLog(action, tableName, recordId, details = {}) {
  const client = initSupabase();
  if (client) {
    try {
      const { data: { user } } = await client.auth.getUser();
      if (!user) return;
      const { data: profile } = await client
        .from('profiles')
        .select('id')
        .eq('auth_user_id', user.id)
        .maybeSingle();

      await client.from('audit_logs').insert({
        user_id: profile?.id || null,
        action,
        table_name: tableName,
        record_id: recordId ? String(recordId) : null,
        details
      });
    } catch (err) {
      console.warn('Audit log warning:', err.message);
    }
    return;
  }

  const db = getDevDb();
  const user = getDevSessionUser();
  db.audit_logs.unshift({
    id: `aud-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    user_id: user?.id || null,
    action,
    table_name: tableName,
    record_id: recordId ? String(recordId) : null,
    details,
    created_at: new Date().toISOString()
  });
  saveDevDb(db);
}

// ============================================================================
// REALTIME SUBSCRIPTIONS & DATA CHANGE LISTENERS (Section 44)
// ============================================================================

export function subscribeToAttendanceChanges(callback) {
  changeListeners.add(callback);

  const client = initSupabase();
  if (client && !realtimeChannel) {
    realtimeChannel = client
      .channel('public:attendance_live')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'attendance_records' },
        () => notifyDataListeners()
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'attendance_sessions' },
        () => notifyDataListeners()
      )
      .subscribe();
  }

  return () => {
    changeListeners.delete(callback);
  };
}

export function notifyDataListeners() {
  changeListeners.forEach((cb) => {
    try {
      cb();
    } catch (e) {
      console.error('Listener error:', e);
    }
  });
}

// Listen for cross-tab storage updates in local/dev mode
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEYS.DEV_DB) {
      notifyDataListeners();
    }
  });
}

// ============================================================================
// OFFLINE PENDING SCAN QUEUE (Section 40)
// ============================================================================

export function getPendingScans() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEYS.PENDING_SCANS) || '[]');
  } catch (_) {
    return [];
  }
}

export function enqueuePendingScan(scanPayload) {
  const queue = getPendingScans();
  const normalized = validateStudentNumber(scanPayload.studentNumber).normalized;

  // Avoid duplicate pending queue items for the same student + session within 30 seconds
  const now = Date.now();
  const duplicate = queue.find(
    (item) =>
      item.studentNumber === normalized &&
      item.sessionId === scanPayload.sessionId &&
      now - item.queuedAt < 30000
  );
  if (duplicate) return queue.length;

  queue.push({
    id: `q-${now}-${Math.random().toString(36).slice(2, 6)}`,
    studentNumber: normalized,
    sessionId: scanPayload.sessionId,
    method: scanPayload.method || 'QR',
    scanMode: scanPayload.scanMode || 'AUTO',
    queuedAt: now
  });

  localStorage.setItem(STORAGE_KEYS.PENDING_SCANS, JSON.stringify(queue));
  notifyDataListeners();
  return queue.length;
}

export function clearPendingScans() {
  localStorage.removeItem(STORAGE_KEYS.PENDING_SCANS);
  notifyDataListeners();
}

export function removePendingScanById(id) {
  const queue = getPendingScans().filter((item) => item.id !== id);
  localStorage.setItem(STORAGE_KEYS.PENDING_SCANS, JSON.stringify(queue));
  notifyDataListeners();
}