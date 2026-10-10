/**
 * js/app.js
 * Main Application Controller, Router & UI View Renderer
 * Connects all 9 phases into a responsive, accessible, modular web application.
 */

import {
  validateStudentNumber,
  normalizeStudentNumber,
  formatTime12h,
  formatTime24h,
  formatDateLong,
  formatDateShort,
  formatDurationMinutes,
  getTodayDateString,
  escapeHtml,
  renderStatusBadge,
  isSoundEnabled,
  setSoundEnabled,
  showToast
} from './utils.js';

import {
  initSupabase,
  isLiveSupabase,
  getSupabaseConfig,
  saveSupabaseConfig,
  subscribeToAttendanceChanges,
  getPendingScans,
  resetDevDatabase
} from './supabase.js';

import {
  getCurrentProfile,
  loginWithEmailPassword,
  logout,
  verifyRoleAccess,
  listAdmins,
  createAdminAccount,
  updateAdminStatus
} from './auth.js';

import {
  lookupStudentAttendancePublic,
  listStudents,
  addStudent,
  updateStudent,
  deleteStudent,
  bulkImportStudentsFromCSV
} from './students.js';

import {
  listEvents,
  createEvent,
  listSessions,
  getActiveOrLatestSession,
  openAttendanceSession,
  closeAttendanceSession,
  updateSessionSettings,
  recordAttendanceScan,
  syncPendingScans,
  correctAttendanceRecord,
  manualCreateAttendanceRecord,
  deleteAttendanceRecord
} from './attendance.js';

import {
  startQrScanner,
  stopQrScanner,
  toggleCameraFacingMode,
  toggleCameraTorch,
  processDetectedCode,
  renderScanResultBanner
} from './scanner.js';

import { getLiveDashboardData } from './dashboard.js';

import {
  queryAttendanceReport,
  getEventsWithStats,
  listAuditLogs,
  exportAttendanceRecords
} from './reports.js';

// ============================================================================
// APPLICATION STATE
// ============================================================================

const state = {
  view: 'LANDING', // 'LANDING' | 'STUDENT' | 'LOGIN_ADMIN' | 'LOGIN_SUPER' | 'ADMIN' | 'SUPER_ADMIN'
  subView: 'dashboard',
  studentSubView: 'records', // 'records' | 'summary'
  studentLookupData: null,
  studentLookupQuery: '',
  currentUser: null,
  activeSessionId: null,
  scanMode: 'AUTO', // 'AUTO' | 'ENTRY_ONLY' | 'LEAVING_ONLY'
  lastScanResult: null,
  reportTab: 'DAILY', // 'DAILY' | 'STUDENT' | 'ALL' | 'MISSING'
  reportFilters: {
    date: getTodayDateString(),
    startDate: '',
    endDate: '',
    eventId: '',
    studentNumber: 'PS/2023/174',
    allStudentSearch: '',
    status: 'ALL'
  },
  studentsSearch: '',
  studentsPage: 1,
  lastCsvImportResult: null,
  deferredPwaPrompt: null
};

let unsubscribeRealtime = null;

// ============================================================================
// INITIALIZATION & THEME / PWA SETUP
// ============================================================================

function initTheme() {
  const savedTheme = localStorage.getItem('uniattend_theme') || 'light';
  document.documentElement.setAttribute('data-theme', savedTheme);
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'light';
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('uniattend_theme', next);
  renderApp();
}

function registerServiceWorkerAndPwa() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/service-worker.js').catch(() => {});
    });
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.deferredPwaPrompt = e;
    const installBtn = document.getElementById('btn-install-pwa');
    if (installBtn) installBtn.classList.remove('hidden');
  });

  // Auto-sync pending offline scans when network returns (Section 40)
  window.addEventListener('online', async () => {
    const pending = getPendingScans();
    if (pending.length > 0) {
      showToast(`Network restored. Synchronizing ${pending.length} pending scan(s)...`, 'info');
      const { synced } = await syncPendingScans();
      if (synced > 0) {
        showToast(`Synchronized ${synced} pending attendance scan(s).`, 'success');
        refreshCurrentViewData();
      }
    }
  });
}

async function bootstrap() {
  initTheme();
  initSupabase();
  registerServiceWorkerAndPwa();

  const profile = await getCurrentProfile();
  if (profile) {
    state.currentUser = profile;
    if (profile.role === 'SUPER_ADMIN') {
      state.view = 'SUPER_ADMIN';
      state.subView = 'dashboard';
    } else if (profile.role === 'ADMIN') {
      state.view = 'ADMIN';
      state.subView = 'scanner';
    }
  }

  unsubscribeRealtime = subscribeToAttendanceChanges(() => {
    refreshCurrentViewData();
  });

  await renderApp();
}

async function refreshCurrentViewData() {
  if (state.view === 'SUPER_ADMIN' && ['dashboard', 'attendance'].includes(state.subView)) {
    await renderMainContentOnly();
  } else if (state.view === 'ADMIN' && ['current-event', 'today-attendance'].includes(state.subView)) {
    await renderMainContentOnly();
  }
}

// ============================================================================
// TOP-LEVEL ROUTER & RENDERER
// ============================================================================

export async function navigateTo(view, subView = null) {
  stopQrScanner();
  state.view = view;
  if (subView) state.subView = subView;
  await renderApp();
}

async function renderApp() {
  const root = document.getElementById('app-root');
  if (!root) return;

  // Enforce role verification on protected views (Section 64 & Test Scenario 10)
  if (state.view === 'SUPER_ADMIN') {
    try {
      state.currentUser = await verifyRoleAccess(['SUPER_ADMIN']);
    } catch (err) {
      showToast(err.message || 'Access Denied', 'error');
      state.view = state.currentUser?.role === 'ADMIN' ? 'ADMIN' : 'LANDING';
    }
  } else if (state.view === 'ADMIN') {
    try {
      state.currentUser = await verifyRoleAccess(['ADMIN', 'SUPER_ADMIN']);
    } catch (err) {
      showToast(err.message || 'Authentication required', 'error');
      state.view = 'LANDING';
    }
  }

  switch (state.view) {
    case 'LANDING':
      stopQrScanner();
      renderLandingScreen(root);
      break;
    case 'STUDENT':
      stopQrScanner();
      renderStudentPortal(root);
      break;
    case 'LOGIN_ADMIN':
      stopQrScanner();
      renderLoginScreen(root, 'ADMIN');
      break;
    case 'LOGIN_SUPER':
      stopQrScanner();
      renderLoginScreen(root, 'SUPER_ADMIN');
      break;
    case 'ADMIN':
      await renderStaffShell(root, 'ADMIN');
      break;
    case 'SUPER_ADMIN':
      await renderStaffShell(root, 'SUPER_ADMIN');
      break;
    default:
      renderLandingScreen(root);
  }
}

// ============================================================================
// 1. LANDING PAGE (Section 6: Three Large Role Cards)
// ============================================================================

function renderLandingScreen(root) {
  const theme = document.documentElement.getAttribute('data-theme') || 'light';
  const liveMode = isLiveSupabase();

  root.innerHTML = `
    <div class="landing-wrapper">
      <header class="landing-header">
        <a href="#top" class="brand-logo" id="brand-home-link">
          <span class="brand-icon" aria-hidden="true">QR</span>
          <span>UniAttend</span>
        </a>
        <div class="topbar-actions">
          <span class="status-badge ${liveMode ? 'badge-success' : 'badge-primary'}" title="Database Connection Mode">
            ● ${liveMode ? 'Supabase Connected' : 'Local Test Mode'}
          </span>
          <button type="button" class="btn btn-sm btn-outline ${state.deferredPwaPrompt ? '' : 'hidden'}" id="btn-install-pwa">
            ⬇ Install App
          </button>
          <button type="button" class="btn btn-sm btn-outline" id="btn-theme-toggle" aria-label="Toggle color theme">
            ${theme === 'dark' ? '☀ Light' : '☾ Dark'}
          </button>
        </div>
      </header>

      <main>
        <section class="landing-hero">
          <h1>Student Event Attendance Management</h1>
          <p>Select your portal below to view attendance records, scan student ID QR codes, or manage university events.</p>
        </section>

        <section class="role-cards-grid" aria-label="User Role Portals">
          <!-- CARD 1: STUDENT -->
          <button type="button" class="role-card-btn role-card-student" id="card-role-student">
            <div class="role-card-icon" aria-hidden="true">🎓</div>
            <div>
              <span class="role-card-title">STUDENT</span>
              <span class="role-card-subtitle">View My Attendance</span>
            </div>
            <span class="role-card-arrow">Open Lookup →</span>
          </button>

          <!-- CARD 2: ADMIN -->
          <button type="button" class="role-card-btn role-card-admin" id="card-role-admin">
            <div class="role-card-icon" aria-hidden="true">📷</div>
            <div>
              <span class="role-card-title">ADMIN</span>
              <span class="role-card-subtitle">Attendance Scanner</span>
            </div>
            <span class="role-card-arrow">Open Scanner →</span>
          </button>

          <!-- CARD 3: SUPER ADMIN -->
          <button type="button" class="role-card-btn role-card-super" id="card-role-super">
            <div class="role-card-icon" aria-hidden="true">🛡</div>
            <div>
              <span class="role-card-title">SUPER ADMIN</span>
              <span class="role-card-subtitle">System Management</span>
            </div>
            <span class="role-card-arrow">Manage System →</span>
          </button>
        </section>
      </main>

      <footer style="text-align: center; color: var(--text-muted); font-size: 0.82rem; padding-top: 1rem; border-top: 1px solid var(--border-color);">
        Padura 2026 copyright © 2026 All Rights Reserved.
      </footer>
    </div>
  `;

  root.querySelector('#btn-theme-toggle')?.addEventListener('click', toggleTheme);
  root.querySelector('#btn-install-pwa')?.addEventListener('click', async () => {
    if (!state.deferredPwaPrompt) return;
    state.deferredPwaPrompt.prompt();
    await state.deferredPwaPrompt.userChoice;
    state.deferredPwaPrompt = null;
    renderApp();
  });

  root.querySelector('#card-role-student')?.addEventListener('click', () => {
    navigateTo('STUDENT');
  });

  root.querySelector('#card-role-admin')?.addEventListener('click', () => {
    if (state.currentUser && ['ADMIN', 'SUPER_ADMIN'].includes(state.currentUser.role)) {
      navigateTo('ADMIN', 'scanner');
    } else {
      navigateTo('LOGIN_ADMIN');
    }
  });

  root.querySelector('#card-role-super')?.addEventListener('click', () => {
    if (state.currentUser && state.currentUser.role === 'SUPER_ADMIN') {
      navigateTo('SUPER_ADMIN', 'dashboard');
    } else if (state.currentUser && state.currentUser.role === 'ADMIN') {
      showToast('Access Denied: Admin accounts cannot access Super Admin System Management.', 'error');
    } else {
      navigateTo('LOGIN_SUPER');
    }
  });
}

// ============================================================================
// 2. STUDENT LOOKUP PORTAL (Sections 5, 32, 46, 47, 61)
// ============================================================================

function renderStudentPortal(root) {
  const data = state.studentLookupData;

  root.innerHTML = `
    <div class="landing-wrapper" style="justify-content: flex-start;">
      <header class="landing-header">
        <div class="brand-logo">
          <span>Student Attendance Portal</span>
        </div>
        <div class="topbar-actions" role="navigation" aria-label="Student Navigation">
          <button type="button" class="btn btn-sm ${state.studentSubView === 'records' ? 'btn-primary' : 'btn-outline'}" id="stu-nav-records">
            My Attendance
          </button>
          <button type="button" class="btn btn-sm ${state.studentSubView === 'summary' ? 'btn-primary' : 'btn-outline'}" id="stu-nav-summary">
            Summary
          </button>
          <button type="button" class="btn btn-sm btn-outline" id="stu-nav-back">
            ← Back
          </button>
        </div>
      </header>

      <main class="student-portal-container" style="width: 100%;">
        <div class="card">
          <h2 class="card-title" style="margin-bottom: 0.35rem;">Check My Event Attendance</h2>
          <p style="color: var(--text-secondary); font-size: 0.9rem; margin-bottom: 1rem;">
            Enter your University Student Number to view your attendance history and total hours.
          </p>

          <form id="form-student-lookup">
            <div class="form-group">
              <label class="form-label" for="input-student-lookup">Enter Student Number</label>
              <div style="display: flex; gap: 0.6rem; flex-wrap: wrap;">
                <input
                  type="text"
                  id="input-student-lookup"
                  class="form-input mono"
                  style="flex: 1; min-width: 200px;"
                  placeholder="PS/XXXX/XXX"
                  value="${escapeHtml(state.studentLookupQuery)}"
                  autocomplete="off"
                  required
                />
                <button type="submit" class="btn btn-primary" id="btn-student-lookup">
                  View Attendance
                </button>
              </div>
            </div>
          </form>
        </div>

        <div id="student-lookup-results">
          ${renderStudentLookupResultHTML(data)}
        </div>
      </main>
      <footer style="text-align: center; color: var(--text-muted); font-size: 0.82rem; padding: 1rem 0; border-top: 1px solid var(--border-color); margin-top: auto;">
        Padura 2026 copyright © 2026 All Rights Reserved.
      </footer>
    </div>
  `;

  root.querySelector('#stu-nav-back')?.addEventListener('click', () => {
    state.studentLookupData = null;
    navigateTo('LANDING');
  });

  root.querySelector('#stu-nav-records')?.addEventListener('click', () => {
    state.studentSubView = 'records';
    renderStudentPortal(root);
  });

  root.querySelector('#stu-nav-summary')?.addEventListener('click', () => {
    state.studentSubView = 'summary';
    renderStudentPortal(root);
  });

  root.querySelectorAll('.stu-quick-chip').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-id');
      state.studentLookupQuery = id;
      await executeStudentLookup(id, root);
    });
  });

  root.querySelector('#form-student-lookup')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = root.querySelector('#input-student-lookup');
    const rawVal = input ? input.value : '';
    state.studentLookupQuery = rawVal;
    await executeStudentLookup(rawVal, root);
  });
}

async function executeStudentLookup(rawInput, root) {
  const resultsEl = root.querySelector('#student-lookup-results');
  if (resultsEl) {
    resultsEl.innerHTML = `
      <div class="card empty-state">
        <span class="spinner-sm"></span>
        <p style="margin-top: 0.5rem;">Loading attendance...</p>
      </div>
    `;
  }

  try {
    const res = await lookupStudentAttendancePublic(rawInput);
    state.studentLookupData = res;
    if (res.success) {
      state.studentLookupQuery = res.student_number;
    }
    renderStudentPortal(root);
  } catch (err) {
    showToast(err.message || 'Lookup failed', 'error');
  }
}

function renderStudentLookupResultHTML(data) {
  if (!data) return '';

  if (!data.success) {
    return `
      <div class="card feedback-error" role="alert">
        <div class="feedback-icon">✕</div>
        <div class="feedback-title">${escapeHtml(
          data.code === 'INVALID_FORMAT' ? 'Invalid Student Number' : 'Student Not Found'
        )}</div>
        <p class="feedback-desc">${escapeHtml(data.message)}</p>
      </div>
    `;
  }

  const records = data.records || [];
  const totalFormatted = formatDurationMinutes(data.total_minutes || 0);

  return `
    <div class="card">
      <div class="card-header" style="border-bottom: 1px solid var(--border-color); padding-bottom: 0.85rem;">
        <div>
          <span style="font-size: 0.78rem; text-transform: uppercase; color: var(--text-secondary); font-weight: 700;">Student Number</span>
          <h3 class="mono" style="font-size: 1.45rem; font-weight: 800;">${escapeHtml(data.student_number)}</h3>
        </div>
        <div>
          <span style="font-size: 0.78rem; display: block; color: var(--text-secondary); text-align: right; margin-bottom: 0.2rem;">Current Status</span>
          ${
            data.current_status === 'NO_RECORDS'
              ? '<span class="status-badge badge-neutral">No Attendance Yet</span>'
              : renderStatusBadge(data.current_status)
          }
        </div>
      </div>

      <h4 style="font-size: 0.9rem; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 0.75rem;">
        Attendance Summary
      </h4>

      <div class="stats-grid" style="margin-bottom: 1.25rem;">
        <div class="stat-card stat-primary">
          <span class="stat-label">Days Attended</span>
          <span class="stat-value">${escapeHtml(String(data.days_attended))}</span>
        </div>
        <div class="stat-card stat-success">
          <span class="stat-label">Total Hours</span>
          <span class="stat-value">${escapeHtml(totalFormatted)}</span>
        </div>
      </div>

      ${
        state.studentSubView === 'summary'
          ? `
            <div style="padding: 0.75rem; background: var(--bg-subtle); border-radius: var(--radius-sm); font-size: 0.9rem;">
              <p><strong>Student Number:</strong> <span class="mono">${escapeHtml(data.student_number)}</span></p>
              <p style="margin-top: 0.35rem;"><strong>Completed Attendance Sessions:</strong> ${escapeHtml(String(data.days_attended))}</p>
              <p style="margin-top: 0.35rem;"><strong>Cumulative Verified Duration:</strong> ${escapeHtml(totalFormatted)} (${escapeHtml(String(data.total_minutes || 0))} minutes)</p>
            </div>
          `
          : records.length === 0
          ? `
            <div class="empty-state">
              <div class="empty-state-icon">📋</div>
              <h3>No Attendance Records</h3>
              <p>There are no attendance records recorded for ${escapeHtml(data.student_number)} yet.</p>
            </div>
          `
          : `
            <div aria-label="Daily Attendance History">
              ${records
                .map(
                  (rec) => `
                  <div class="student-record-item">
                    <div>
                      <strong style="font-size: 1rem; display: block;">${escapeHtml(
                        formatDateLong(rec.session_date)
                      )}</strong>
                      <span style="font-size: 0.82rem; color: var(--text-secondary);">${escapeHtml(
                        rec.event_name || 'University Event'
                      )}</span>
                      <div style="margin-top: 0.45rem; font-size: 0.9rem; display: flex; flex-wrap: wrap; gap: 1rem;">
                        <span><strong>Entry:</strong> ${escapeHtml(formatTime12h(rec.entry_time))}</span>
                        <span><strong>Leaving:</strong> ${
                          rec.leaving_time ? escapeHtml(formatTime12h(rec.leaving_time)) : '-'
                        }</span>
                        <span><strong>Duration:</strong> ${escapeHtml(
                          formatDurationMinutes(rec.duration_minutes)
                        )}</span>
                      </div>
                    </div>
                    <div>
                      ${renderStatusBadge(rec.status, rec.leaving_status)}
                    </div>
                  </div>
                `
                )
                .join('')}
            </div>
          `
      }
    </div>
  `;
}

// ============================================================================
// 3. ADMIN & SUPER ADMIN LOGIN SCREEN (Sections 6, 30, 31)
// ============================================================================

function renderLoginScreen(root, targetRole) {
  const isSuper = targetRole === 'SUPER_ADMIN';
  const liveMode = isLiveSupabase();

  root.innerHTML = `
    <div class="landing-wrapper" style="justify-content: flex-start;">
      <header class="landing-header">
        <div class="brand-logo">
          <span class="brand-icon" aria-hidden="true">${isSuper ? '🛡' : '📷'}</span>
          <span>${isSuper ? 'Super Admin Login' : 'Admin Scanner Login'}</span>
        </div>
        <button type="button" class="btn btn-sm btn-outline" id="btn-login-back">
          ← Back to Portals
        </button>
      </header>

      <main class="auth-container" style="width: 100%;">
        <div class="card">
          <h2 class="card-title" style="margin-bottom: 0.25rem;">
            ${isSuper ? 'Super Admin System Management' : 'Admin Attendance Scanner'}
          </h2>
          <p style="color: var(--text-secondary); font-size: 0.9rem; margin-bottom: 1.25rem;">
            Sign in with your authorized university administrator credentials.
          </p>

          <div id="login-error-box" class="hidden" style="margin-bottom: 1rem;"></div>

          <form id="form-staff-login">
            <div class="form-group">
              <label class="form-label" for="login-email">Email Address</label>
              <input
                type="email"
                id="login-email"
                class="form-input"
                placeholder="${isSuper ? 'superadmin@university.edu' : 'admin@university.edu'}"
                required
                autocomplete="username"
              />
            </div>

            <div class="form-group">
              <label class="form-label" for="login-password">Password</label>
              <input
                type="password"
                id="login-password"
                class="form-input"
                placeholder="••••••••"
                required
                autocomplete="current-password"
              />
            </div>

            <button type="submit" class="btn btn-primary btn-block" id="btn-login-submit">
              Sign In as ${isSuper ? 'Super Admin' : 'Admin'}
            </button>
          </form>

          ${
            !liveMode
              ? `
                <div style="margin-top: 1.25rem; padding-top: 1rem; border-top: 1px solid var(--border-color); font-size: 0.82rem; color: var(--text-secondary);">
                  <strong style="display: block; margin-bottom: 0.4rem;">Development Test Mode Accounts:</strong>
                  <div style="display: flex; gap: 0.5rem; flex-wrap: wrap;">
                    <button type="button" class="btn btn-sm btn-outline" id="btn-fill-super">
                      Fill Super Admin
                    </button>
                    <button type="button" class="btn btn-sm btn-outline" id="btn-fill-admin">
                      Fill Scanner Admin
                    </button>
                  </div>
                </div>
              `
              : ''
          }
        </div>
      </main>
      <footer style="text-align: center; color: var(--text-muted); font-size: 0.82rem; padding: 1rem 0; border-top: 1px solid var(--border-color); margin-top: auto;">
        Padura 2026 copyright © 2026 All Rights Reserved
      </footer>
    </div>
  `;

  root.querySelector('#btn-login-back')?.addEventListener('click', () => navigateTo('LANDING'));

  root.querySelector('#btn-fill-super')?.addEventListener('click', () => {
    root.querySelector('#login-email').value = 'superadmin@university.edu';
    root.querySelector('#login-password').value = 'SuperAdmin@2026';
  });

  root.querySelector('#btn-fill-admin')?.addEventListener('click', () => {
    root.querySelector('#login-email').value = 'admin@university.edu';
    root.querySelector('#login-password').value = 'Admin@2026';
  });

  root.querySelector('#form-staff-login')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = root.querySelector('#login-email')?.value || '';
    const password = root.querySelector('#login-password')?.value || '';
    const submitBtn = root.querySelector('#btn-login-submit');
    const errBox = root.querySelector('#login-error-box');

    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Verifying credentials...';
    }
    if (errBox) errBox.classList.add('hidden');

    try {
      const profile = await loginWithEmailPassword(
        email,
        password,
        isSuper ? 'SUPER_ADMIN' : null
      );
      state.currentUser = profile;
      showToast(`Signed in as ${profile.name} (${profile.role})`, 'success');

      if (isSuper) {
        await navigateTo('SUPER_ADMIN', 'dashboard');
      } else {
        await navigateTo('ADMIN', 'scanner');
      }
    } catch (err) {
      if (errBox) {
        errBox.className = 'scan-feedback-panel feedback-error';
        errBox.style.padding = '0.75rem';
        errBox.innerHTML = `<strong>${escapeHtml(err.message)}</strong>`;
      }
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = `Sign In as ${isSuper ? 'Super Admin' : 'Admin'}`;
      }
    }
  });
}

// ============================================================================
// 4. STAFF SHELL: SIDEBAR + MOBILE BOTTOM NAV (Section 34 & 61)
// ============================================================================

function getNavItemsForRole(portalRole) {
  if (portalRole === 'SUPER_ADMIN') {
    // Exact Super Admin navigation items from Section 61
    return [
      { id: 'dashboard', label: 'Dashboard', icon: '', mobileBar: true },
      { id: 'events', label: 'Events', icon: '', mobileBar: false },
      { id: 'attendance', label: 'Attendance', icon: '', mobileBar: true },
      { id: 'students', label: 'Students', icon: '', mobileBar: true },
      { id: 'admins', label: 'Admins', icon: '', mobileBar: false },
      { id: 'reports', label: 'Reports', icon: '', mobileBar: true },
      { id: 'session-settings', label: 'Session Settings', icon: '', mobileBar: false },
      { id: 'audit-logs', label: 'Audit Logs', icon: '', mobileBar: false },
      { id: 'settings', label: 'Settings', icon: '', mobileBar: false }
    ];
  }

  // Exact Admin navigation items from Section 61
  return [
    { id: 'scanner', label: 'Scanner', icon: '', mobileBar: true },
    { id: 'manual-attendance', label: 'Manual Attendance', icon: '', mobileBar: true },
    { id: 'current-event', label: 'Current Event', icon: '', mobileBar: true },
    { id: 'today-attendance', label: "Today's Attendance", icon: '', mobileBar: true }
  ];
}

async function renderStaffShell(root, portalRole) {
  const navItems = getNavItemsForRole(portalRole);
  if (!navItems.some((item) => item.id === state.subView)) {
    state.subView = navItems[0].id;
  }

  const activeItem = navItems.find((item) => item.id === state.subView) || navItems[0];
  const pendingCount = getPendingScans().length;
  const theme = document.documentElement.getAttribute('data-theme') || 'light';

  root.innerHTML = `
    <div class="app-shell">
      <!-- Desktop / Drawer Sidebar -->
      <aside class="app-sidebar" id="app-sidebar" aria-label="Main Navigation">
        <div class="sidebar-header">
          <div class="brand-logo">
            <span class="brand-icon" aria-hidden="true">QR</span>
            <span>UniAttend</span>
          </div>
          <span class="sidebar-role-pill">${portalRole === 'SUPER_ADMIN' ? 'SUPER ADMIN' : 'ADMIN'}</span>
        </div>

        <nav class="sidebar-nav">
          ${navItems
            .map(
              (item) => `
              <button
                type="button"
                class="nav-item-btn ${state.subView === item.id ? 'active' : ''}"
                data-subview="${item.id}"
              >
                <span aria-hidden="true">${item.icon}</span>
                <span>${escapeHtml(item.label)}</span>
              </button>
            `
            )
            .join('')}

          ${
            portalRole === 'SUPER_ADMIN'
              ? `
                <div style="margin-top: 0.75rem; padding-top: 0.75rem; border-top: 1px solid var(--border-color);">
                  <button type="button" class="nav-item-btn" id="btn-super-open-scanner">
                    <span aria-hidden="true"></span>
                    <span>Open QR Scanner</span>
                  </button>
                </div>
              `
              : ''
          }
        </nav>

        <div class="sidebar-footer">
          <div style="font-size: 0.8rem; color: var(--text-secondary); margin-bottom: 0.5rem; overflow: hidden; text-overflow: ellipsis;">
            <strong>${escapeHtml(state.currentUser?.name || 'Administrator')}</strong><br/>
            <span>${escapeHtml(state.currentUser?.email || '')}</span>
          </div>
          <button type="button" class="btn btn-outline btn-block btn-sm" id="btn-sidebar-logout">
            Logout
          </button>
        </div>
      </aside>

      <!-- Main Area -->
      <div class="app-main">
        <header class="app-topbar">
          <div style="display: flex; align-items: center; gap: 0.75rem;">
            <button type="button" class="btn btn-sm btn-outline mobile-menu-toggle" id="btn-mobile-drawer" aria-label="Open menu">
              ☰
            </button>
            <h1 class="topbar-title">${escapeHtml(activeItem.label)}</h1>
          </div>

          <div class="topbar-actions">
            ${
              pendingCount > 0
                ? `<button type="button" class="btn btn-sm btn-warning" id="btn-sync-pending" title="Sync offline queued scans">
                    ⟳ Pending (${pendingCount})
                  </button>`
                : ''
            }
            <button type="button" class="btn btn-sm btn-outline" id="btn-topbar-theme" aria-label="Toggle theme">
              ${theme === 'dark' ? '☀' : '☾'}
            </button>
            <button type="button" class="btn btn-sm btn-outline" id="btn-topbar-logout">
              Logout
            </button>
          </div>
        </header>

        <main class="app-content" id="main-view-container">
          <div class="empty-state">
            <span class="spinner-sm"></span>
            <p style="margin-top: 0.5rem;">Loading ${escapeHtml(activeItem.label)}...</p>
          </div>
        </main>
        <footer style="text-align: center; color: var(--text-muted); font-size: 0.82rem; padding: 1rem 1rem 5rem 1rem; border-top: 1px solid var(--border-color); margin-top: auto;">
           Padura 2026 copyright © 2026 All Rights Reserved.
        </footer>
      </div>

      <!-- Mobile Bottom Navigation -->
      <nav class="mobile-bottom-nav" aria-label="Mobile Navigation">
        ${navItems
          .filter((i) => i.mobileBar)
          .map(
            (item) => `
            <button
              type="button"
              class="mobile-nav-btn ${state.subView === item.id ? 'active' : ''}"
              data-subview="${item.id}"
            >
              <span class="mobile-nav-icon" aria-hidden="true">${item.icon}</span>
              <span>${escapeHtml(item.label)}</span>
            </button>
          `
          )
          .join('')}
      </nav>
    </div>
  `;

  // Bind navigation events
  root.querySelectorAll('[data-subview]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const targetSub = btn.getAttribute('data-subview');
      stopQrScanner();
      state.subView = targetSub;
      root.querySelector('#app-sidebar')?.classList.remove('mobile-open');
      await renderStaffShell(root, portalRole);
    });
  });

  root.querySelector('#btn-mobile-drawer')?.addEventListener('click', () => {
    root.querySelector('#app-sidebar')?.classList.toggle('mobile-open');
  });

  root.querySelector('#btn-super-open-scanner')?.addEventListener('click', async () => {
    await navigateTo('ADMIN', 'scanner');
  });

  root.querySelector('#btn-topbar-theme')?.addEventListener('click', toggleTheme);

  root.querySelector('#btn-sync-pending')?.addEventListener('click', async () => {
    const { synced } = await syncPendingScans();
    showToast(`Synchronized ${synced} pending scan(s).`, 'success');
    await renderStaffShell(root, portalRole);
  });

  const handleLogout = async () => {
    stopQrScanner();
    await logout();
    state.currentUser = null;
    await navigateTo('LANDING');
  };

  root.querySelector('#btn-sidebar-logout')?.addEventListener('click', handleLogout);
  root.querySelector('#btn-topbar-logout')?.addEventListener('click', handleLogout);

  await renderMainContentOnly();
}

async function renderMainContentOnly() {
  const container = document.getElementById('main-view-container');
  if (!container) return;

  try {
    if (state.view === 'ADMIN') {
      switch (state.subView) {
        case 'scanner':
          await renderAdminScannerView(container);
          break;
        case 'manual-attendance':
          await renderAdminManualView(container);
          break;
        case 'current-event':
          await renderCurrentEventView(container);
          break;
        case 'today-attendance':
          await renderTodayAttendanceView(container);
          break;
        default:
          await renderAdminScannerView(container);
      }
    } else if (state.view === 'SUPER_ADMIN') {
      switch (state.subView) {
        case 'dashboard':
          await renderSuperDashboardView(container);
          break;
        case 'events':
          await renderSuperEventsView(container);
          break;
        case 'attendance':
          await renderSuperAttendanceView(container);
          break;
        case 'students':
          await renderSuperStudentsView(container);
          break;
        case 'admins':
          await renderSuperAdminsView(container);
          break;
        case 'reports':
          await renderSuperReportsView(container);
          break;
        case 'session-settings':
          await renderSessionSettingsView(container);
          break;
        case 'audit-logs':
          await renderAuditLogsView(container);
          break;
        case 'settings':
          await renderSystemSettingsView(container);
          break;
        default:
          await renderSuperDashboardView(container);
      }
    }
  } catch (err) {
    container.innerHTML = `
      <div class="card feedback-error" role="alert">
        <h3>Error Loading View</h3>
        <p>${escapeHtml(err.message || 'An unexpected error occurred.')}</p>
      </div>
    `;
  }
}

// ============================================================================
// 5. ADMIN VIEWS: QR SCANNER, MANUAL ENTRY, CURRENT EVENT, TODAY'S ATTENDANCE
// ============================================================================

async function renderAdminScannerView(container) {
  const dashData = await getLiveDashboardData(state.activeSessionId);
  const session = dashData.session;
  state.activeSessionId = session?.id || null;
  const stats = dashData.stats;
  const soundOn = isSoundEnabled();

  container.innerHTML = `
    ${
      state.currentUser?.role === 'SUPER_ADMIN'
        ? `<div style="margin-bottom: 1rem;">
            <button type="button" class="btn btn-sm btn-outline" id="btn-back-to-super">
              ← Return to Super Admin Dashboard
            </button>
          </div>`
        : ''
    }

    <div class="scanner-layout">
      <!-- LEFT COLUMN: DEDICATED QR CAMERA VIEWPORT (Section 11) -->
      <div class="scanner-viewport-card">
        <div class="scanner-session-bar">
          <div>
            <strong style="font-size: 0.95rem;">${escapeHtml(
              session?.event_name || 'No Active Event'
            )}</strong>
            <span style="font-size: 0.8rem; color: var(--text-secondary); display: block;">
              ${session ? `${escapeHtml(session.session_date)} (${escapeHtml(session.start_time.slice(0, 5))} - ${escapeHtml(session.end_time.slice(0, 5))})` : ''}
            </span>
          </div>
          <span class="status-badge ${
            session?.status === 'OPEN' ? 'badge-success' : 'badge-danger'
          }">
            ● Session ${escapeHtml(session?.status || 'CLOSED')}
          </span>
        </div>

        <div class="scanner-camera-stage">
          <video id="qr-video-element" class="scanner-video" muted playsinline></video>
          <div class="scan-reticle-overlay">
            <div class="scan-reticle-box">
              <div class="scan-laser-line"></div>
            </div>
            <div class="scan-reticle-hint">Point Student ID QR here</div>
          </div>
          <div id="camera-status-overlay" class="camera-overlay-message hidden"></div>
        </div>

        <div class="scanner-controls-bar">
          <div style="display: flex; gap: 0.45rem; flex-wrap: wrap;">
            <button type="button" class="btn btn-sm btn-outline" id="btn-flip-camera">
              🔄 Flip Camera
            </button>
            <button type="button" class="btn btn-sm btn-outline" id="btn-toggle-torch">
              🔦 Torch
            </button>
            <button type="button" class="btn btn-sm btn-outline" id="btn-toggle-sound">
              ${soundOn ? '🔊 Sound On' : '🔇 Muted'}
            </button>
          </div>

          <div style="display: flex; align-items: center; gap: 0.4rem;">
            <label for="select-scan-mode" style="font-size: 0.8rem; font-weight: 600; color: var(--text-secondary);">Mode:</label>
            <select id="select-scan-mode" class="form-select" style="min-height: 34px; padding: 0.25rem 0.5rem; font-size: 0.82rem; width: auto;">
              <option value="AUTO" ${state.scanMode === 'AUTO' ? 'selected' : ''}>Auto (Entry → Leaving)</option>
              <option value="ENTRY_ONLY" ${state.scanMode === 'ENTRY_ONLY' ? 'selected' : ''}>Entry Only</option>
              <option value="LEAVING_ONLY" ${state.scanMode === 'LEAVING_ONLY' ? 'selected' : ''}>Leaving Only</option>
            </select>
          </div>
        </div>

        <!-- Inline Manual Input right under Camera as shown in Section 11 wireframe -->
        <div style="padding: 1rem; border-top: 1px solid var(--border-color); background: var(--bg-subtle);">
          <form id="form-inline-manual-scan" style="display: flex; gap: 0.5rem; flex-wrap: wrap;">
            <input
              type="text"
              id="input-inline-student-number"
              class="form-input mono"
              style="flex: 1; min-width: 180px;"
              placeholder="Enter Student Number (e.g. PS/2023/174)"
              autocomplete="off"
              aria-label="Enter Student Number"
            />
            <button type="submit" class="btn btn-primary">
              Mark Attendance
            </button>
          </form>

          <!-- Quick QR Test Simulator for instant desktop verification of all test scenarios -->
          <div style="margin-top: 0.75rem; padding-top: 0.65rem; border-top: 1px dashed var(--border-color);">
            <span style="font-size: 0.75rem; font-weight: 700; color: var(--text-secondary); text-transform: uppercase;">
              Simulate QR Camera Scan (Test Scenarios):
            </span>
            <div class="sim-chips-row">
              <button type="button" class="btn btn-sm btn-outline sim-qr-btn" data-qr="PS/2023/174">
                QR: PS/2023/174
              </button>
              <button type="button" class="btn btn-sm btn-outline sim-qr-btn" data-qr="PS/2023/003">
                QR: PS/2023/003
              </button>
              <button type="button" class="btn btn-sm btn-outline sim-qr-btn" data-qr="PS/2023/250">
                QR: PS/2023/250
              </button>
              <button type="button" class="btn btn-sm btn-outline sim-qr-btn" data-qr="PS/2023/999" title="Test Scenario 5: Unregistered student">
                QR: PS/2023/999 (Unregistered)
              </button>
              <button type="button" class="btn btn-sm btn-outline sim-qr-btn" data-qr="ABC123" title="Test Scenario 4: Invalid QR">
                QR: ABC123 (Invalid)
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- RIGHT COLUMN: IMMEDIATE SCAN RESULT + LIVE EVENT COUNTS -->
      <div>
        <div id="scanner-result-banner" class="scan-feedback-panel hidden" aria-live="assertive"></div>

        <div class="card">
          <div class="card-header">
            <h3 class="card-title">Live Event Count</h3>
            <span class="status-badge badge-primary">● Live</span>
          </div>
          <div class="stats-grid" style="grid-template-columns: repeat(2, 1fr); margin-bottom: 0;">
            <div class="stat-card stat-primary">
              <span class="stat-label">Registered</span>
              <span class="stat-value" id="live-stat-registered">${stats.registered_students}</span>
            </div>
            <div class="stat-card stat-indigo">
              <span class="stat-label">Entered</span>
              <span class="stat-value" id="live-stat-entered">${stats.entered}</span>
            </div>
            <div class="stat-card stat-success">
              <span class="stat-label">Currently Inside</span>
              <span class="stat-value" id="live-stat-inside">${stats.currently_inside}</span>
            </div>
            <div class="stat-card stat-warning">
              <span class="stat-label">Left</span>
              <span class="stat-value" id="live-stat-left">${stats.left}</span>
            </div>
          </div>
        </div>

        <div class="card">
          <h3 class="card-title" style="margin-bottom: 0.75rem;">Recent Scans</h3>
          <div id="scanner-recent-list">
            ${renderCompactRecentListHTML(dashData.recentScans.slice(0, 6))}
          </div>
        </div>
      </div>
    </div>
  `;

  const videoEl = container.querySelector('#qr-video-element');
  const statusEl = container.querySelector('#camera-status-overlay');
  const bannerEl = container.querySelector('#scanner-result-banner');

  const handleScanResultUpdate = async (result) => {
    state.lastScanResult = result;
    renderScanResultBanner(bannerEl, result, async (studentNum) => {
      // Force leaving when Admin clicks "Mark Leaving Attendance Instead" on duplicate entry prompt
      await processDetectedCode({
        rawText: studentNum,
        method: 'QR',
        sessionId: state.activeSessionId,
        scanMode: 'FORCE_LEAVING',
        onScanResult: handleScanResultUpdate
      });
    });

    if (result && result.state !== 'LOADING') {
      // Refresh live counters and recent scans list without stopping camera!
      try {
        const fresh = await getLiveDashboardData(state.activeSessionId);
        const regEl = container.querySelector('#live-stat-registered');
        const entEl = container.querySelector('#live-stat-entered');
        const insEl = container.querySelector('#live-stat-inside');
        const lftEl = container.querySelector('#live-stat-left');
        const recEl = container.querySelector('#scanner-recent-list');
        if (regEl) regEl.textContent = fresh.stats.registered_students;
        if (entEl) entEl.textContent = fresh.stats.entered;
        if (insEl) insEl.textContent = fresh.stats.currently_inside;
        if (lftEl) lftEl.textContent = fresh.stats.left;
        if (recEl) recEl.innerHTML = renderCompactRecentListHTML(fresh.recentScans.slice(0, 6));
      } catch (_) {}
    }
  };

  if (state.lastScanResult) {
    renderScanResultBanner(bannerEl, state.lastScanResult, async (studentNum) => {
      await processDetectedCode({
        rawText: studentNum,
        method: 'QR',
        sessionId: state.activeSessionId,
        scanMode: 'FORCE_LEAVING',
        onScanResult: handleScanResultUpdate
      });
    });
  }

  const scannerOpts = {
    videoElement: videoEl,
    statusElement: statusEl,
    onScanResult: handleScanResultUpdate,
    getSessionId: () => state.activeSessionId,
    getScanMode: () => state.scanMode
  };

  // Start camera
  startQrScanner(scannerOpts);

  container.querySelector('#btn-back-to-super')?.addEventListener('click', () => {
    navigateTo('SUPER_ADMIN', 'dashboard');
  });

  container.querySelector('#select-scan-mode')?.addEventListener('change', (e) => {
    state.scanMode = e.target.value;
  });

  container.querySelector('#btn-flip-camera')?.addEventListener('click', () => {
    toggleCameraFacingMode(scannerOpts);
  });

  container.querySelector('#btn-toggle-torch')?.addEventListener('click', async () => {
    const supported = await toggleCameraTorch();
    if (!supported) {
      showToast('Flashlight/Torch is not supported on this camera device.', 'info');
    }
  });

  container.querySelector('#btn-toggle-sound')?.addEventListener('click', (e) => {
    const next = !isSoundEnabled();
    setSoundEnabled(next);
    e.currentTarget.textContent = next ? '🔊 Sound On' : '🔇 Muted';
  });

  // Inline manual entry form
  container.querySelector('#form-inline-manual-scan')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = container.querySelector('#input-inline-student-number');
    const raw = input?.value || '';
    if (!raw.trim()) return;
    await processDetectedCode({
      rawText: raw,
      method: 'MANUAL',
      sessionId: state.activeSessionId,
      scanMode: state.scanMode,
      onScanResult: handleScanResultUpdate
    });
    if (input) input.value = '';
  });

  // Simulated QR buttons
  container.querySelectorAll('.sim-qr-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const code = btn.getAttribute('data-qr');
      await processDetectedCode({
        rawText: code,
        method: 'QR',
        sessionId: state.activeSessionId,
        scanMode: state.scanMode,
        onScanResult: handleScanResultUpdate
      });
    });
  });
}

function renderCompactRecentListHTML(records) {
  if (!records || records.length === 0) {
    return `<p style="color: var(--text-muted); font-size: 0.88rem;">No scans recorded in this session yet.</p>`;
  }

  return records
    .map(
      (r) => `
      <div style="display: flex; align-items: center; justify-content: space-between; padding: 0.55rem 0; border-bottom: 1px solid var(--border-color); font-size: 0.88rem;">
        <div>
          <strong class="mono">${escapeHtml(r.student_number)}</strong>
          <span style="color: var(--text-secondary); font-size: 0.78rem; margin-left: 0.4rem;">
            ${r.leaving_time ? `Out: ${escapeHtml(formatTime12h(r.leaving_time))}` : `In: ${escapeHtml(formatTime12h(r.entry_time))}`}
          </span>
        </div>
        ${renderStatusBadge(r.status, r.leaving_status, true)}
      </div>
    `
    )
    .join('');
}

/**
 * Dedicated Admin Manual Entry & Student Search View (Section 24).
 * Uses the exact same recordAttendanceScan function with method = 'MANUAL'.
 */
async function renderAdminManualView(container) {
  const dashData = await getLiveDashboardData(state.activeSessionId);
  const session = dashData.session;
  state.activeSessionId = session?.id || null;

  container.innerHTML = `
    <div style="max-width: 640px; margin: 0 auto;">
      <div class="card">
        <div class="card-header">
          <div>
            <h2 class="card-title">Manual Student Attendance</h2>
            <p style="font-size: 0.88rem; color: var(--text-secondary);">
              Use this form if a student's ID QR code is damaged or cannot be scanned by camera.
            </p>
          </div>
          <span class="status-badge ${session?.status === 'OPEN' ? 'badge-success' : 'badge-danger'}">
            Session ${escapeHtml(session?.status || 'CLOSED')}
          </span>
        </div>

        <div id="manual-result-banner" class="scan-feedback-panel hidden"></div>

        <form id="form-dedicated-manual-entry">
          <div class="form-group">
            <label class="form-label" for="input-dedicated-manual">Enter Student Number</label>
            <input
              type="text"
              id="input-dedicated-manual"
              class="form-input mono"
              placeholder="PS/2023/174"
              required
              autocomplete="off"
              style="font-size: 1.1rem;"
            />
            <div class="form-hint">Format: <code class="mono">PS/YYYY/NNN</code> (Method recorded as <code class="mono">MANUAL</code>)</div>
          </div>

          <div class="form-group">
            <label class="form-label" for="select-manual-action-mode">Attendance Action</label>
            <select id="select-manual-action-mode" class="form-select">
              <option value="AUTO">Auto Detect (Entry → Leaving)</option>
              <option value="ENTRY_ONLY">Mark Entry Only</option>
              <option value="LEAVING_ONLY">Mark Leaving Only</option>
            </select>
          </div>

          <button type="submit" class="btn btn-primary btn-block">
            MARK ATTENDANCE
          </button>
        </form>
      </div>

      <!-- Fast Student Verification Search for Admin -->
      <div class="card">
        <h3 class="card-title" style="margin-bottom: 0.75rem;">Search Registered Student</h3>
        <form id="form-admin-student-search" style="display: flex; gap: 0.5rem;">
          <input
            type="text"
            id="input-admin-stu-search"
            class="form-input mono"
            placeholder="Search e.g. PS/2023/174"
          />
          <button type="submit" class="btn btn-outline">Search</button>
        </form>
        <div id="admin-student-search-results" style="margin-top: 1rem;"></div>
      </div>
    </div>
  `;

  const bannerEl = container.querySelector('#manual-result-banner');

  const handleManualResult = (res) => {
    renderScanResultBanner(bannerEl, res, async (stuNum) => {
      await processDetectedCode({
        rawText: stuNum,
        method: 'MANUAL',
        sessionId: state.activeSessionId,
        scanMode: 'FORCE_LEAVING',
        onScanResult: handleManualResult
      });
    });
  };

  container.querySelector('#form-dedicated-manual-entry')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = container.querySelector('#input-dedicated-manual');
    const modeSelect = container.querySelector('#select-manual-action-mode');
    const raw = input?.value || '';
    const mode = modeSelect?.value || 'AUTO';

    await processDetectedCode({
      rawText: raw,
      method: 'MANUAL',
      sessionId: state.activeSessionId,
      scanMode: mode,
      onScanResult: handleManualResult
    });

    if (input) input.select();
  });

  container.querySelector('#form-admin-student-search')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = container.querySelector('#input-admin-stu-search')?.value || '';
    const resBox = container.querySelector('#admin-student-search-results');
    if (!resBox) return;

    const { students } = await listStudents({ search: q, page: 1, pageSize: 10 });
    if (students.length === 0) {
      resBox.innerHTML = `<p style="color: var(--text-secondary); font-size: 0.9rem;">No matching students found.</p>`;
      return;
    }

    resBox.innerHTML = `
      <div class="table-responsive">
        <table class="data-table">
          <thead>
            <tr>
              <th>Student Number</th>
              <th>Status</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            ${students
              .map(
                (s) => `
                <tr>
                  <td class="mono"><strong>${escapeHtml(s.student_number)}</strong></td>
                  <td><span class="status-badge badge-success">Registered</span></td>
                  <td>
                    <button type="button" class="btn btn-sm btn-primary btn-quick-mark" data-stu="${escapeHtml(s.student_number)}">
                      Mark Attendance
                    </button>
                  </td>
                </tr>
              `
              )
              .join('')}
          </tbody>
        </table>
      </div>
    `;

    resBox.querySelectorAll('.btn-quick-mark').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const stuNum = btn.getAttribute('data-stu');
        await processDetectedCode({
          rawText: stuNum,
          method: 'MANUAL',
          sessionId: state.activeSessionId,
          scanMode: 'AUTO',
          onScanResult: handleManualResult
        });
      });
    });
  });
}

/**
 * Current Event Live Student Count & Currently Attending List (Section 18).
 */
async function renderCurrentEventView(container) {
  const data = await getLiveDashboardData(state.activeSessionId);
  const { session, stats, currentlyAttending } = data;

  container.innerHTML = `
    <div class="card">
      <div class="card-header">
        <div>
          <span style="font-size: 0.78rem; text-transform: uppercase; font-weight: 700; color: var(--text-secondary);">CURRENT EVENT</span>
          <h2 class="card-title" style="font-size: 1.3rem;">${escapeHtml(session?.event_name || 'No Event Selected')}</h2>
          <p style="font-size: 0.88rem; color: var(--text-secondary);">
            Date: ${escapeHtml(formatDateLong(session?.session_date))} • Session Hours: ${escapeHtml(session?.start_time?.slice(0, 5) || '08:00')} to ${escapeHtml(session?.end_time?.slice(0, 5) || '17:00')}
          </p>
        </div>
        <span class="status-badge ${session?.status === 'OPEN' ? 'badge-success' : 'badge-danger'}">
          Session ${escapeHtml(session?.status || 'CLOSED')}
        </span>
      </div>

      <div class="stats-grid">
        <div class="stat-card stat-primary">
          <span class="stat-label">Students Registered</span>
          <span class="stat-value">${stats.registered_students}</span>
        </div>
        <div class="stat-card stat-indigo">
          <span class="stat-label">Entered</span>
          <span class="stat-value">${stats.entered}</span>
        </div>
        <div class="stat-card stat-success">
          <span class="stat-label">Currently Inside</span>
          <span class="stat-value">${stats.currently_inside}</span>
        </div>
        <div class="stat-card stat-primary">
          <span class="stat-label">Left</span>
          <span class="stat-value">${stats.left}</span>
        </div>
        <div class="stat-card stat-warning">
          <span class="stat-label">Leaving Not Scanned</span>
          <span class="stat-value">${stats.leaving_not_scanned}</span>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <h3 class="card-title">Currently Attending Students (${currentlyAttending.length})</h3>
      </div>
      ${
        currentlyAttending.length === 0
          ? `<div class="empty-state">
              <div class="empty-state-icon">👥</div>
              <h3>No Students Currently Inside</h3>
              <p>Students who have scanned entry and have not yet scanned leaving will appear here.</p>
            </div>`
          : `<div class="table-responsive">
              <table class="data-table">
                <thead>
                  <tr>
                    <th>Student Number</th>
                    <th>Entry Time</th>
                    <th>Method</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  ${currentlyAttending
                    .map(
                      (r) => `
                      <tr>
                        <td class="mono"><strong>${escapeHtml(r.student_number)}</strong></td>
                        <td>${escapeHtml(formatTime12h(r.entry_time))}</td>
                        <td><span class="mono">${escapeHtml(r.entry_method)}</span></td>
                        <td>${renderStatusBadge(r.status, r.leaving_status)}</td>
                      </tr>
                    `
                    )
                    .join('')}
                </tbody>
              </table>
            </div>`
      }
    </div>
  `;
}

/**
 * Today's Attendance View for Admin (Section 4).
 */
async function renderTodayAttendanceView(container) {
  const data = await getLiveDashboardData(state.activeSessionId);
  const records = data.allSessionRecords || [];

  container.innerHTML = `
    <div class="card">
      <div class="card-header">
        <h2 class="card-title">Today's Attendance (${records.length})</h2>
        <input
          type="text"
          id="input-filter-today"
          class="form-input mono"
          style="max-width: 240px;"
          placeholder="Filter PS/2023/..."
        />
      </div>

      <div id="today-table-wrapper">
        ${renderAttendanceTableHTML(records, false)}
      </div>
    </div>
  `;

  container.querySelector('#input-filter-today')?.addEventListener('input', (e) => {
    const q = normalizeStudentNumber(e.target.value);
    const filtered = q
      ? records.filter((r) => r.student_number.includes(q))
      : records;
    const wrapper = container.querySelector('#today-table-wrapper');
    if (wrapper) wrapper.innerHTML = renderAttendanceTableHTML(filtered, false);
  });
}

// ============================================================================
// 6. SUPER ADMIN DASHBOARD (Section 19 & 44)
// ============================================================================

async function renderSuperDashboardView(container) {
  const data = await getLiveDashboardData(state.activeSessionId);
  const { session, stats, recentScans, missingLeavingScans } = data;
  state.activeSessionId = session?.id || null;

  container.innerHTML = `
    <!-- 4 Main Dashboard Cards + Missing Leaving Card (Section 19) -->
    <div class="stats-grid">
      <div class="stat-card stat-primary">
        <span class="stat-value">${stats.registered_students}</span>
        <span class="stat-label">Students</span>
      </div>
      <div class="stat-card stat-indigo">
        <span class="stat-value">${stats.entered}</span>
        <span class="stat-label">Entered Today</span>
      </div>
      <div class="stat-card stat-success">
        <span class="stat-value">${stats.currently_inside}</span>
        <span class="stat-label">Currently Here</span>
      </div>
      <div class="stat-card stat-primary">
        <span class="stat-value">${stats.left}</span>
        <span class="stat-label">Left</span>
      </div>
      <div class="stat-card stat-warning">
        <span class="stat-value">${stats.leaving_not_scanned}</span>
        <span class="stat-label">ID Not Scanned for Leaving</span>
      </div>
    </div>

    <!-- Current Session Banner & Attendance Percentage -->
    <div class="card">
      <div class="card-header">
        <div>
          <span style="font-size: 0.75rem; font-weight: 700; text-transform: uppercase; color: var(--text-secondary);">
            ACTIVE EVENT SESSION
          </span>
          <h2 class="card-title" style="font-size: 1.25rem;">
            ${escapeHtml(session?.event_name || 'No Event Session Configured')}
          </h2>
          <p style="font-size: 0.88rem; color: var(--text-secondary);">
            Date: <strong>${escapeHtml(session?.session_date || '-')}</strong> •
            Start: <strong>${escapeHtml(formatTime12h(session?.start_time))}</strong> •
            End: <strong>${escapeHtml(formatTime12h(session?.end_time))}</strong>
          </p>
        </div>

        <div style="display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap;">
          <span class="status-badge ${session?.status === 'OPEN' ? 'badge-success' : 'badge-danger'}">
            ● ${escapeHtml(session?.status || 'CLOSED')}
          </span>
          ${
            session
              ? session.status === 'OPEN'
                ? `<button type="button" class="btn btn-sm btn-danger" id="btn-dash-close-session">
                    CLOSE SESSION
                  </button>`
                : `<button type="button" class="btn btn-sm btn-success" id="btn-dash-open-session">
                    OPEN SESSION
                  </button>`
              : ''
          }
          <button type="button" class="btn btn-sm btn-primary" id="btn-dash-launch-scanner">
            Launch Scanner
          </button>
        </div>
      </div>

      <div>
        <div style="display: flex; justify-content: space-between; font-size: 0.85rem; font-weight: 600;">
          <span>Attendance Participation Rate</span>
          <span>${stats.attendance_percentage}% (${stats.entered} / ${stats.registered_students} students)</span>
        </div>
        <div class="progress-bar-track">
          <div class="progress-bar-fill" style="width: ${stats.attendance_percentage}%;"></div>
        </div>
      </div>
    </div>

    <!-- Two Column Grid: Today's Recent Scans & Missing Leaving Scans -->
    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 1.25rem;">
      <div class="card">
        <div class="card-header">
          <h3 class="card-title">Recent Scans</h3>
          <button type="button" class="btn btn-sm btn-outline" id="btn-dash-view-all-attendance">
            View All
          </button>
        </div>
        ${renderAttendanceTableHTML(recentScans.slice(0, 8), true)}
      </div>

      <div class="card">
        <div class="card-header">
          <h3 class="card-title">ID Not Scanned for Leaving (${missingLeavingScans.length})</h3>
          <button type="button" class="btn btn-sm btn-outline" id="btn-dash-export-missing">
            Export CSV
          </button>
        </div>
        ${
          missingLeavingScans.length === 0
            ? `<div class="empty-state">
                <div class="empty-state-icon">✓</div>
                <h3>No Missing Leaving Scans</h3>
                <p>When a session closes, students who entered without a leaving scan are automatically listed here as "ID Not Scanned for Leaving".</p>
              </div>`
            : renderAttendanceTableHTML(missingLeavingScans, true)
        }
      </div>
    </div>
  `;

  container.querySelector('#btn-dash-launch-scanner')?.addEventListener('click', () => {
    navigateTo('ADMIN', 'scanner');
  });

  container.querySelector('#btn-dash-view-all-attendance')?.addEventListener('click', () => {
    navigateTo('SUPER_ADMIN', 'attendance');
  });

  container.querySelector('#btn-dash-close-session')?.addEventListener('click', async () => {
    if (!session) return;
    const res = await closeAttendanceSession(session.id);
    showToast(
      `Session closed. ${res.missing_leaving_marked || 0} student(s) marked as "ID Not Scanned for Leaving".`,
      'warning'
    );
    await renderSuperDashboardView(container);
  });

  container.querySelector('#btn-dash-open-session')?.addEventListener('click', async () => {
    if (!session) return;
    await openAttendanceSession(session.id);
    showToast('Attendance session opened.', 'success');
    await renderSuperDashboardView(container);
  });

  container.querySelector('#btn-dash-export-missing')?.addEventListener('click', async () => {
    const dateStr = session?.session_date || getTodayDateString();
    await exportAttendanceRecords(
      missingLeavingScans,
      `missing_leaving_${dateStr}.csv`,
      'csv'
    );
    showToast(`Exported missing_leaving_${dateStr}.csv`, 'success');
  });

  bindEditRecordButtons(container, () => renderSuperDashboardView(container));
}

// ============================================================================
// 7. SUPER ADMIN: EVENTS MANAGEMENT & EVENT HISTORY (Sections 41 & 42)
// ============================================================================

async function renderSuperEventsView(container) {
  const events = await getEventsWithStats();

  container.innerHTML = `
    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 1.25rem; align-items: start;">
      <!-- Create Event Card (Section 41) -->
      <div class="card">
        <h2 class="card-title" style="margin-bottom: 0.75rem;">Create New Event</h2>
        <form id="form-create-event">
          <div class="form-group">
            <label class="form-label" for="ev-name">Event Name</label>
            <input
              type="text"
              id="ev-name"
              class="form-input"
              placeholder="Annual Student Event 2026"
              required
            />
          </div>

          <div class="form-group">
            <label class="form-label" for="ev-date">Date</label>
            <input
              type="date"
              id="ev-date"
              class="form-input"
              value="${getTodayDateString()}"
              required
            />
          </div>

          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem;">
            <div class="form-group">
              <label class="form-label" for="ev-start">Start Time</label>
              <input type="time" id="ev-start" class="form-input" value="08:00" required />
            </div>
            <div class="form-group">
              <label class="form-label" for="ev-end">End Time</label>
              <input type="time" id="ev-end" class="form-input" value="17:00" required />
            </div>
          </div>

          <div class="form-group">
            <label class="form-label" for="ev-desc">Description (Optional)</label>
            <input
              type="text"
              id="ev-desc"
              class="form-input"
              placeholder="Location or event notes"
            />
          </div>

          <button type="submit" class="btn btn-primary btn-block">
            Create Event & Open Session
          </button>
        </form>
      </div>

      <!-- Event History List (Section 42) -->
      <div class="card">
        <h2 class="card-title" style="margin-bottom: 0.75rem;">Event History (${events.length})</h2>
        <p style="font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 1rem;">
          Click any event below to open its attendance report or activate its session.
        </p>

        ${
          events.length === 0
            ? `<div class="empty-state">
                <h3>No Events Created</h3>
                <p>Create your first event using the form on the left.</p>
              </div>`
            : events
                .map(
                  (ev) => `
                  <div class="student-record-item" style="cursor: pointer;" data-event-id="${escapeHtml(ev.id)}">
                    <div>
                      <strong style="font-size: 1.05rem;">${escapeHtml(ev.event_name)}</strong>
                      <div style="font-size: 0.85rem; color: var(--text-secondary); margin-top: 0.2rem;">
                        ${escapeHtml(formatDateShort(ev.event_date))} • ${escapeHtml(ev.start_time.slice(0, 5))} - ${escapeHtml(ev.end_time.slice(0, 5))}
                      </div>
                      <div style="margin-top: 0.45rem; display: flex; gap: 0.85rem; font-size: 0.85rem; font-weight: 600;">
                        <span>${ev.registered_students} Students</span>
                        <span style="color: var(--primary);">${ev.attended_count} Attended</span>
                        <span>${formatDurationMinutes(ev.total_minutes)} Total</span>
                      </div>
                    </div>
                    <div style="display: flex; flex-direction: column; gap: 0.4rem; align-items: flex-end;">
                      <button type="button" class="btn btn-sm btn-outline btn-open-event-report" data-event-id="${escapeHtml(ev.id)}">
                        View Report →
                      </button>
                      ${
                        ev.sessions && ev.sessions[0]
                          ? `<button type="button" class="btn btn-sm btn-primary btn-select-session" data-session-id="${escapeHtml(ev.sessions[0].id)}">
                              Set Active Session
                            </button>`
                          : ''
                      }
                    </div>
                  </div>
                `
                )
                .join('')
        }
      </div>
    </div>
  `;

  container.querySelector('#form-create-event')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const event_name = container.querySelector('#ev-name')?.value || '';
    const event_date = container.querySelector('#ev-date')?.value || '';
    const start_time = container.querySelector('#ev-start')?.value || '08:00';
    const end_time = container.querySelector('#ev-end')?.value || '17:00';
    const description = container.querySelector('#ev-desc')?.value || '';

    try {
      const { session } = await createEvent({
        event_name,
        event_date,
        start_time,
        end_time,
        description,
        openImmediately: true
      });
      state.activeSessionId = session.id;
      showToast(`Created event "${event_name}" and opened attendance session.`, 'success');
      await renderSuperEventsView(container);
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  container.querySelectorAll('.btn-open-event-report').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const eventId = btn.getAttribute('data-event-id');
      state.reportTab = 'ALL';
      state.reportFilters.eventId = eventId;
      state.reportFilters.date = '';
      await navigateTo('SUPER_ADMIN', 'reports');
    });
  });

  container.querySelectorAll('.btn-select-session').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const sessionId = btn.getAttribute('data-session-id');
      state.activeSessionId = sessionId;
      showToast('Selected active session for dashboard and scanner.', 'success');
      await navigateTo('SUPER_ADMIN', 'dashboard');
    });
  });
}

// ============================================================================
// 8. SUPER ADMIN: ATTENDANCE MANAGEMENT & MANUAL CORRECTION (Sections 20 & 25)
// ============================================================================

async function renderSuperAttendanceView(container) {
  const sessions = await listSessions();
  const activeSession =
    sessions.find((s) => s.id === state.activeSessionId) || sessions[0] || null;
  if (activeSession) state.activeSessionId = activeSession.id;

  const { records } = await queryAttendanceReport({
    sessionId: state.activeSessionId || ''
  });

  container.innerHTML = `
    <div class="card">
      <div class="card-header">
        <div>
          <h2 class="card-title">Attendance Management & Manual Corrections</h2>
          <p style="font-size: 0.88rem; color: var(--text-secondary);">
            View, search, manually record, or correct student entry and leaving times.
          </p>
        </div>
        <div style="display: flex; gap: 0.5rem; flex-wrap: wrap;">
          <button type="button" class="btn btn-sm btn-primary" id="btn-att-add-manual">
            + Manually Add Attendance
          </button>
          <button type="button" class="btn btn-sm btn-outline" id="btn-att-export-csv">
            ⬇ Export CSV
          </button>
        </div>
      </div>

      <div class="filter-bar">
        <div>
          <label class="form-label" for="att-session-select">Event Session</label>
          <select id="att-session-select" class="form-select">
            ${sessions
              .map(
                (s) => `
                <option value="${escapeHtml(s.id)}" ${
                  s.id === state.activeSessionId ? 'selected' : ''
                }>
                  ${escapeHtml(s.event_name)} (${escapeHtml(s.session_date)}) [${escapeHtml(s.status)}]
                </option>
              `
              )
              .join('')}
          </select>
        </div>

        <div>
          <label class="form-label" for="att-search-input">Search Student Number</label>
          <input
            type="text"
            id="att-search-input"
            class="form-input mono"
            placeholder="PS/2023/174"
          />
        </div>

        <div>
          <label class="form-label" for="att-status-select">Status Filter</label>
          <select id="att-status-select" class="form-select">
            <option value="ALL">All Statuses</option>
            <option value="CURRENTLY_ATTENDING">Currently Attending</option>
            <option value="LEFT">Left Normally</option>
            <option value="LEAVING_NOT_SCANNED">ID Not Scanned for Leaving</option>
            <option value="MANUALLY_RECORDED">Manually Recorded</option>
          </select>
        </div>
      </div>

      <div id="super-attendance-table-wrap">
        ${renderAttendanceTableHTML(records, true)}
      </div>
    </div>
  `;

  const applyLocalFilter = () => {
    const q = normalizeStudentNumber(container.querySelector('#att-search-input')?.value || '');
    const st = container.querySelector('#att-status-select')?.value || 'ALL';
    const filtered = records.filter((r) => {
      if (q && !r.student_number.includes(q)) return false;
      if (st !== 'ALL') {
        if (st === 'LEAVING_NOT_SCANNED') {
          return r.status === 'LEAVING_NOT_SCANNED' || r.leaving_status === 'LEAVING_NOT_SCANNED';
        }
        return r.status === st;
      }
      return true;
    });
    const wrap = container.querySelector('#super-attendance-table-wrap');
    if (wrap) {
      wrap.innerHTML = renderAttendanceTableHTML(filtered, true);
      bindEditRecordButtons(wrap, () => renderSuperAttendanceView(container));
    }
  };

  container.querySelector('#att-session-select')?.addEventListener('change', async (e) => {
    state.activeSessionId = e.target.value;
    await renderSuperAttendanceView(container);
  });

  container.querySelector('#att-search-input')?.addEventListener('input', applyLocalFilter);
  container.querySelector('#att-status-select')?.addEventListener('change', applyLocalFilter);

  container.querySelector('#btn-att-export-csv')?.addEventListener('click', async () => {
    const dateStr = activeSession?.session_date || getTodayDateString();
    await exportAttendanceRecords(records, `attendance_${dateStr}.csv`, 'csv');
    showToast(`Exported attendance_${dateStr}.csv`, 'success');
  });

  container.querySelector('#btn-att-add-manual')?.addEventListener('click', () => {
    openManualAddAttendanceModal(activeSession, () => renderSuperAttendanceView(container));
  });

  bindEditRecordButtons(container, () => renderSuperAttendanceView(container));
}

function renderAttendanceTableHTML(records, allowSuperEdit = false) {
  if (!records || records.length === 0) {
    return `
      <div class="empty-state">
        <div class="empty-state-icon">📋</div>
        <h3>No Attendance Records</h3>
        <p>There are no attendance records matching the selected criteria.</p>
      </div>
    `;
  }

  return `
    <div class="table-responsive">
      <table class="data-table">
        <thead>
          <tr>
            <th>Student Number</th>
            <th>Date</th>
            <th>Entry</th>
            <th>Leaving</th>
            <th>Duration</th>
            <th>Methods</th>
            <th>Status</th>
            ${allowSuperEdit ? '<th>Actions</th>' : ''}
          </tr>
        </thead>
        <tbody>
          ${records
            .map(
              (r) => `
              <tr>
                <td class="mono"><strong>${escapeHtml(r.student_number)}</strong></td>
                <td>${escapeHtml(r.session_date || r.entry_time?.slice(0, 10) || '-')}</td>
                <td>${escapeHtml(formatTime24h(r.entry_time))}</td>
                <td>${r.leaving_time ? escapeHtml(formatTime24h(r.leaving_time)) : '-'}</td>
                <td>${escapeHtml(formatDurationMinutes(r.duration_minutes))}</td>
                <td style="font-size: 0.8rem;">
                  In: <code class="mono">${escapeHtml(r.entry_method || 'QR')}</code>
                  ${r.leaving_method && r.leaving_method !== '-' ? ` / Out: <code class="mono">${escapeHtml(r.leaving_method)}</code>` : ''}
                </td>
                <td>
                  ${renderStatusBadge(r.status, r.leaving_status)}
                  ${
                    r.notes
                      ? `<div style="font-size: 0.75rem; color: var(--text-secondary); margin-top: 0.2rem;">Note: ${escapeHtml(r.notes)}</div>`
                      : ''
                  }
                </td>
                ${
                  allowSuperEdit
                    ? `<td>
                        <div style="display: flex; gap: 0.35rem;">
                          <button
                            type="button"
                            class="btn btn-sm btn-outline btn-edit-attendance"
                            data-record='${escapeHtml(JSON.stringify(r))}'
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            class="btn btn-sm btn-outline btn-delete-attendance"
                            data-id="${escapeHtml(r.id)}"
                            data-stu="${escapeHtml(r.student_number)}"
                          >
                            ✕
                          </button>
                        </div>
                      </td>`
                    : ''
                }
              </tr>
            `
            )
            .join('')}
        </tbody>
      </table>
    </div>
  `;
}

function bindEditRecordButtons(container, onDone) {
  container.querySelectorAll('.btn-edit-attendance').forEach((btn) => {
    btn.addEventListener('click', () => {
      const raw = btn.getAttribute('data-record');
      if (!raw) return;
      const record = JSON.parse(raw);
      openManualCorrectionModal(record, onDone);
    });
  });

  container.querySelectorAll('.btn-delete-attendance').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-id');
      const stu = btn.getAttribute('data-stu');
      if (!confirm(`Delete attendance record for ${stu}?`)) return;
      try {
        await deleteAttendanceRecord(id);
        showToast(`Deleted attendance record for ${stu}.`, 'info');
        if (onDone) await onDone();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });
}

/**
 * Super Admin Manual Correction Modal (Section 25).
 * Allows adding leaving time, editing entry time, changing status, and adding notes.
 */
function openManualCorrectionModal(record, onSaved) {
  const modalRoot = document.getElementById('modal-root');
  if (!modalRoot) return;

  const sessionDate = record.session_date || record.entry_time?.slice(0, 10) || getTodayDateString();
  const entryTimeHHMM = formatTime24h(record.entry_time) !== '-' ? formatTime24h(record.entry_time) : '08:30';
  const leavingTimeHHMM = record.leaving_time ? formatTime24h(record.leaving_time) : '';

  modalRoot.className = 'modal-backdrop';
  modalRoot.innerHTML = `
    <div class="modal-card">
      <div class="card-header">
        <h3 class="card-title">Correct Attendance — <span class="mono">${escapeHtml(record.student_number)}</span></h3>
        <button type="button" class="btn btn-sm btn-outline" id="btn-close-modal">✕</button>
      </div>

      <form id="form-manual-correction">
        <div class="form-group">
          <label class="form-label" for="corr-entry-time">Entry Time (${escapeHtml(sessionDate)})</label>
          <input type="time" id="corr-entry-time" class="form-input" value="${escapeHtml(entryTimeHHMM)}" required />
        </div>

        <div class="form-group">
          <label class="form-label" for="corr-leaving-time">Leaving Time (Leave blank if still inside or not scanned)</label>
          <input type="time" id="corr-leaving-time" class="form-input" value="${escapeHtml(leavingTimeHHMM)}" />
        </div>

        <div class="form-group">
          <label class="form-label" for="corr-status">Status</label>
          <select id="corr-status" class="form-select">
            <option value="CURRENTLY_ATTENDING" ${record.status === 'CURRENTLY_ATTENDING' ? 'selected' : ''}>CURRENTLY_ATTENDING</option>
            <option value="LEFT" ${record.status === 'LEFT' ? 'selected' : ''}>LEFT (Left Normally)</option>
            <option value="LEAVING_NOT_SCANNED" ${record.status === 'LEAVING_NOT_SCANNED' ? 'selected' : ''}>LEAVING_NOT_SCANNED (ID Not Scanned for Leaving)</option>
            <option value="MANUALLY_RECORDED" ${record.status === 'MANUALLY_RECORDED' ? 'selected' : ''}>MANUALLY_RECORDED</option>
          </select>
        </div>

        <div class="form-group">
          <label class="form-label" for="corr-notes">Audit / Correction Note</label>
          <input
            type="text"
            id="corr-notes"
            class="form-input"
            placeholder="Reason for manual correction"
            value="${escapeHtml(record.notes || '')}"
          />
        </div>

        <div style="display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 1rem;">
          <button type="button" class="btn btn-outline" id="btn-cancel-modal">Cancel</button>
          <button type="submit" class="btn btn-primary">Save Correction</button>
        </div>
      </form>
    </div>
  `;

  const closeModal = () => {
    modalRoot.className = 'hidden';
    modalRoot.innerHTML = '';
  };

  modalRoot.querySelector('#btn-close-modal')?.addEventListener('click', closeModal);
  modalRoot.querySelector('#btn-cancel-modal')?.addEventListener('click', closeModal);

  modalRoot.querySelector('#form-manual-correction')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const entryVal = modalRoot.querySelector('#corr-entry-time')?.value || '08:00';
    const leavingVal = modalRoot.querySelector('#corr-leaving-time')?.value || '';
    const statusVal = modalRoot.querySelector('#corr-status')?.value || 'MANUALLY_RECORDED';
    const notesVal = modalRoot.querySelector('#corr-notes')?.value || '';

    const entryIso = new Date(`${sessionDate}T${entryVal}:00`).toISOString();
    const leavingIso = leavingVal ? new Date(`${sessionDate}T${leavingVal}:00`).toISOString() : null;

    try {
      await correctAttendanceRecord(record.id, {
        entry_time: entryIso,
        leaving_time: leavingIso,
        status: statusVal,
        notes: notesVal
      });
      showToast(`Updated attendance for ${record.student_number} (logged in audit trail).`, 'success');
      closeModal();
      if (onSaved) await onSaved();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
}

function openManualAddAttendanceModal(session, onSaved) {
  const modalRoot = document.getElementById('modal-root');
  if (!modalRoot || !session) return;

  const sessionDate = session.session_date || getTodayDateString();

  modalRoot.className = 'modal-backdrop';
  modalRoot.innerHTML = `
    <div class="modal-card">
      <div class="card-header">
        <h3 class="card-title">Manually Add Attendance Record</h3>
        <button type="button" class="btn btn-sm btn-outline" id="btn-close-add-modal">✕</button>
      </div>

      <form id="form-manual-create-attendance">
        <div class="form-group">
          <label class="form-label" for="man-stu-num">Enter Student Number</label>
          <input
            type="text"
            id="man-stu-num"
            class="form-input mono"
            placeholder="PS/2023/174"
            required
          />
        </div>

        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem;">
          <div class="form-group">
            <label class="form-label" for="man-entry">Entry Time</label>
            <input type="time" id="man-entry" class="form-input" value="08:30" required />
          </div>
          <div class="form-group">
            <label class="form-label" for="man-leaving">Leaving Time (Optional)</label>
            <input type="time" id="man-leaving" class="form-input" value="" />
          </div>
        </div>

        <div class="form-group">
          <label class="form-label" for="man-notes">Note</label>
          <input type="text" id="man-notes" class="form-input" placeholder="Manual entry reason" />
        </div>

        <div style="display: flex; justify-content: flex-end; gap: 0.5rem;">
          <button type="button" class="btn btn-outline" id="btn-cancel-add-modal">Cancel</button>
          <button type="submit" class="btn btn-primary">Save Attendance</button>
        </div>
      </form>
    </div>
  `;

  const closeModal = () => {
    modalRoot.className = 'hidden';
    modalRoot.innerHTML = '';
  };

  modalRoot.querySelector('#btn-close-add-modal')?.addEventListener('click', closeModal);
  modalRoot.querySelector('#btn-cancel-add-modal')?.addEventListener('click', closeModal);

  modalRoot.querySelector('#form-manual-create-attendance')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const stuNum = modalRoot.querySelector('#man-stu-num')?.value || '';
    const entryVal = modalRoot.querySelector('#man-entry')?.value || '08:30';
    const leavingVal = modalRoot.querySelector('#man-leaving')?.value || '';
    const notesVal = modalRoot.querySelector('#man-notes')?.value || '';

    const entryIso = new Date(`${sessionDate}T${entryVal}:00`).toISOString();
    const leavingIso = leavingVal ? new Date(`${sessionDate}T${leavingVal}:00`).toISOString() : null;

    try {
      await manualCreateAttendanceRecord({
        sessionId: session.id,
        studentNumber: stuNum,
        entryTime: entryIso,
        leavingTime: leavingIso,
        status: leavingIso ? 'LEFT' : 'CURRENTLY_ATTENDING',
        notes: notesVal
      });
      showToast('Manual attendance record added.', 'success');
      closeModal();
      if (onSaved) await onSaved();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
}

// ============================================================================
// 9. SUPER ADMIN: STUDENT MANAGEMENT & BULK CSV IMPORT (Sections 8 & 9)
// ============================================================================

async function renderSuperStudentsView(container) {
  const { students, total, page, pageSize } = await listStudents({
    search: state.studentsSearch,
    page: state.studentsPage,
    pageSize: 25
  });

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const importRes = state.lastCsvImportResult;

  container.innerHTML = `
    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(310px, 1fr)); gap: 1.25rem; align-items: start;">
      <!-- Add Single Student (Section 8) -->
      <div class="card">
        <h2 class="card-title" style="margin-bottom: 0.5rem;">Add Student</h2>
        <form id="form-add-student">
          <div class="form-group">
            <label class="form-label" for="input-new-student" style="font-size: 1rem;">
              Enter Student Number
            </label>
            <input
              type="text"
              id="input-new-student"
              class="form-input mono"
              placeholder="PS/2023/174"
              required
              autocomplete="off"
            />
            <div class="form-hint">Required format: <code class="mono">PS/YYYY/NNN</code> (e.g., <code class="mono">PS/2023/174</code>)</div>
          </div>
          <button type="submit" class="btn btn-primary btn-block">
            Add Student
          </button>
        </form>
      </div>

      <!-- Bulk Student CSV Import (Section 9) -->
      <div class="card">
        <h2 class="card-title" style="margin-bottom: 0.5rem;">Bulk Add Students (CSV)</h2>
        <p style="font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 0.75rem;">
          Upload a CSV file or paste Student Numbers (one per line, header <code class="mono">student_number</code>).
        </p>

        <form id="form-bulk-csv-students">
          <div class="form-group">
            <input type="file" id="input-csv-file" accept=".csv, text/csv, text/plain, application/vnd.ms-excel" class="form-input" style="padding: 0.45rem;" />
          </div>
          <div class="form-group">
            <textarea
              id="textarea-csv-content"
              class="form-textarea mono"
              rows="4"
              placeholder="student_number&#10;PS/2023/001&#10;PS/2023/002&#10;PS/2023/174"
            ></textarea>
          </div>
          <button type="submit" class="btn btn-outline btn-block">
            Validate & Import CSV
          </button>
        </form>

        ${
          importRes
            ? `
              <div style="margin-top: 1rem; padding: 0.85rem; background: var(--bg-subtle); border-radius: var(--radius-sm); font-size: 0.84rem;">
                <strong>Last CSV Import Summary:</strong>
                <ul style="margin-top: 0.35rem; padding-left: 1.1rem;">
                  <li style="color: var(--success);">Successfully Imported: <strong>${importRes.importedCount}</strong></li>
                  <li style="color: var(--warning);">Duplicates Skipped: <strong>${importRes.duplicateCount}</strong></li>
                  <li style="color: var(--danger);">Invalid Format Rejected: <strong>${importRes.invalidCount}</strong></li>
                </ul>
                ${
                  importRes.invalidRecords.length > 0
                    ? `<div style="margin-top: 0.4rem; color: var(--danger);">
                        Invalid rows: ${importRes.invalidRecords
                          .slice(0, 5)
                          .map((r) => `Line ${r.line} (${escapeHtml(r.value)})`)
                          .join(', ')}
                      </div>`
                    : ''
                }
              </div>
            `
            : ''
        }
      </div>
    </div>

    <!-- Registered Students List & Fast Search -->
    <div class="card">
      <div class="card-header">
        <h3 class="card-title">Registered Students (${total})</h3>
        <form id="form-search-students" style="display: flex; gap: 0.5rem;">
          <input
            type="text"
            id="input-search-students"
            class="form-input mono"
            placeholder="Search PS/2023/174"
            value="${escapeHtml(state.studentsSearch)}"
          />
          <button type="submit" class="btn btn-outline">Search</button>
        </form>
      </div>

      ${
        students.length === 0
          ? `<div class="empty-state">
              <div class="empty-state-icon">🎓</div>
              <h3>No Students Found</h3>
              <p>No registered students match your search query.</p>
            </div>`
          : `
            <div class="table-responsive">
              <table class="data-table">
                <thead>
                  <tr>
                    <th>Student Number</th>
                    <th>Status</th>
                    <th>Registered Date</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  ${students
                    .map(
                      (s) => `
                      <tr>
                        <td class="mono"><strong>${escapeHtml(s.student_number)}</strong></td>
                        <td><span class="status-badge badge-success">Active</span></td>
                        <td>${escapeHtml(formatDateShort(s.created_at?.slice(0, 10)))}</td>
                        <td>
                          <div style="display: flex; gap: 0.4rem; flex-wrap: wrap;">
                            <button
                              type="button"
                              class="btn btn-sm btn-outline btn-stu-view-att"
                              data-stu="${escapeHtml(s.student_number)}"
                            >
                              View Attendance
                            </button>
                            <button
                              type="button"
                              class="btn btn-sm btn-outline btn-stu-edit"
                              data-id="${escapeHtml(s.id)}"
                              data-stu="${escapeHtml(s.student_number)}"
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              class="btn btn-sm btn-outline btn-stu-delete"
                              data-id="${escapeHtml(s.id)}"
                              data-stu="${escapeHtml(s.student_number)}"
                            >
                              Delete
                            </button>
                          </div>
                        </td>
                      </tr>
                    `
                    )
                    .join('')}
                </tbody>
              </table>
            </div>

            <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 1rem;">
              <span style="font-size: 0.85rem; color: var(--text-secondary);">
                Page ${page} of ${totalPages}
              </span>
              <div style="display: flex; gap: 0.4rem;">
                <button type="button" class="btn btn-sm btn-outline" id="btn-stu-prev" ${page <= 1 ? 'disabled' : ''}>
                  ← Prev
                </button>
                <button type="button" class="btn btn-sm btn-outline" id="btn-stu-next" ${page >= totalPages ? 'disabled' : ''}>
                  Next →
                </button>
              </div>
            </div>
          `
      }
    </div>
  `;

  // Single student add
  container.querySelector('#form-add-student')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = container.querySelector('#input-new-student');
    const raw = input?.value || '';
    try {
      const added = await addStudent(raw);
      showToast(`Added student ${added.student_number}.`, 'success');
      if (input) input.value = '';
      await renderSuperStudentsView(container);
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // File upload reader for CSV
  container.querySelector('#input-csv-file')?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const txt = container.querySelector('#textarea-csv-content');
      if (txt) txt.value = String(reader.result || '');
    };
    reader.readAsText(file);
  });

  // Bulk CSV submit
  container.querySelector('#form-bulk-csv-students')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const csvText = container.querySelector('#textarea-csv-content')?.value || '';
    try {
      const res = await bulkImportStudentsFromCSV(csvText);
      state.lastCsvImportResult = res;
      showToast(
        `CSV processed: ${res.importedCount} imported, ${res.duplicateCount} duplicates, ${res.invalidCount} invalid.`,
        res.importedCount > 0 ? 'success' : 'warning'
      );
      await renderSuperStudentsView(container);
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // Search students
  container.querySelector('#form-search-students')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    state.studentsSearch = container.querySelector('#input-search-students')?.value || '';
    state.studentsPage = 1;
    await renderSuperStudentsView(container);
  });

  container.querySelector('#btn-stu-prev')?.addEventListener('click', async () => {
    if (state.studentsPage > 1) {
      state.studentsPage -= 1;
      await renderSuperStudentsView(container);
    }
  });

  container.querySelector('#btn-stu-next')?.addEventListener('click', async () => {
    if (state.studentsPage < totalPages) {
      state.studentsPage += 1;
      await renderSuperStudentsView(container);
    }
  });

  // View student attendance shortcut -> opens Student Attendance Report tab
  container.querySelectorAll('.btn-stu-view-att').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const stu = btn.getAttribute('data-stu');
      state.reportTab = 'STUDENT';
      state.reportFilters.studentNumber = stu;
      await navigateTo('SUPER_ADMIN', 'reports');
    });
  });

  // Edit student number
  container.querySelectorAll('.btn-stu-edit').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-id');
      const currentNum = btn.getAttribute('data-stu');
      const nextNum = prompt('Enter updated Student Number (PS/YYYY/NNN):', currentNum);
      if (!nextNum || nextNum.trim() === currentNum) return;
      try {
        await updateStudent(id, nextNum);
        showToast('Student Number updated.', 'success');
        await renderSuperStudentsView(container);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  // Delete student
  container.querySelectorAll('.btn-stu-delete').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-id');
      const stu = btn.getAttribute('data-stu');
      if (!confirm(`Are you sure you want to delete student ${stu}?`)) return;
      try {
        await deleteStudent(id);
        showToast(`Deleted student ${stu}.`, 'info');
        await renderSuperStudentsView(container);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });
}

// ============================================================================
// 10. SUPER ADMIN: ADMIN ACCOUNTS MANAGEMENT (Section 30)
// ============================================================================

async function renderSuperAdminsView(container) {
  const admins = await listAdmins();

  container.innerHTML = `
    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(310px, 1fr)); gap: 1.25rem; align-items: start;">
      <!-- Create Admin Account Form (Section 30) -->
      <div class="card">
        <h2 class="card-title" style="margin-bottom: 0.5rem;">Create Admin Account</h2>
        <p style="font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 1rem;">
          Admins can log in to scan Student QR codes and mark attendance.
        </p>

        <form id="form-create-admin">
          <div class="form-group">
            <label class="form-label" for="adm-name">Admin Name</label>
            <input type="text" id="adm-name" class="form-input" placeholder="Scanner Officer" required />
          </div>

          <div class="form-group">
            <label class="form-label" for="adm-email">Email</label>
            <input type="email" id="adm-email" class="form-input" placeholder="scanner2@university.edu" required />
          </div>

          <div class="form-group">
            <label class="form-label" for="adm-password">Password</label>
            <input type="password" id="adm-password" class="form-input" placeholder="Minimum 6 characters" required minlength="6" />
          </div>

          <div class="form-group">
            <label class="form-label" for="adm-role">Admin Role</label>
            <select id="adm-role" class="form-select">
              <option value="ADMIN">Admin</option>
              <option value="SUPER_ADMIN">Super Admin</option>
            </select>
          </div>

          <button type="submit" class="btn btn-primary btn-block">
            Create Admin Account
          </button>
        </form>
      </div>

      <!-- Existing Administrators List -->
      <div class="card">
        <h2 class="card-title" style="margin-bottom: 0.75rem;">Administrator Accounts (${admins.length})</h2>
        <div class="table-responsive">
          <table class="data-table">
            <thead>
              <tr>
                <th>Name & Email</th>
                <th>Role</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              ${admins
                .map(
                  (a) => `
                  <tr>
                    <td>
                      <strong>${escapeHtml(a.name)}</strong><br/>
                      <span style="font-size: 0.8rem; color: var(--text-secondary);">${escapeHtml(a.email)}</span>
                    </td>
                    <td><span class="mono" style="font-size: 0.8rem; font-weight: 700;">${escapeHtml(a.role)}</span></td>
                    <td>
                      <span class="status-badge ${a.status === 'ACTIVE' ? 'badge-success' : 'badge-danger'}">
                        ${escapeHtml(a.status)}
                      </span>
                    </td>
                    <td>
                      ${
                        a.role === 'SUPER_ADMIN'
                          ? `<span style="font-size: 0.8rem; color: var(--text-muted);">Protected</span>`
                          : a.status === 'ACTIVE'
                          ? `<button type="button" class="btn btn-sm btn-outline btn-toggle-admin" data-id="${escapeHtml(a.id)}" data-next="DISABLED">
                              Disable
                            </button>`
                          : `<button type="button" class="btn btn-sm btn-primary btn-toggle-admin" data-id="${escapeHtml(a.id)}" data-next="ACTIVE">
                              Enable
                            </button>`
                      }
                    </td>
                  </tr>
                `
                )
                .join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;

  container.querySelector('#form-create-admin')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = container.querySelector('#adm-name')?.value || '';
    const email = container.querySelector('#adm-email')?.value || '';
    const password = container.querySelector('#adm-password')?.value || '';
    const role = container.querySelector('#adm-role')?.value || 'ADMIN';

    try {
      await createAdminAccount({ name, email, password, role });
      showToast(`Created ${role === 'SUPER_ADMIN' ? 'Super Admin' : 'Admin'} account for ${email}.`, 'success');
      await renderSuperAdminsView(container);
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  container.querySelectorAll('.btn-toggle-admin').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-id');
      const nextStatus = btn.getAttribute('data-next');
      try {
        await updateAdminStatus(id, nextStatus);
        showToast(`Admin account ${nextStatus === 'ACTIVE' ? 'enabled' : 'disabled'}.`, 'info');
        await renderSuperAdminsView(container);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });
}

// ============================================================================
// 11. SUPER ADMIN: REPORTS & CSV/EXCEL EXPORT (Sections 20, 21, 22, 23, 50, 51)
// ============================================================================

async function renderSuperReportsView(container) {
  const events = await listEvents();
  const tab = state.reportTab;
  const f = state.reportFilters;

  let reportData = { records: [], summary: {} };
  let studentReportData = null;

  if (tab === 'DAILY') {
    reportData = await queryAttendanceReport({ date: f.date });
  } else if (tab === 'STUDENT') {
    studentReportData = await lookupStudentAttendancePublic(f.studentNumber || 'PS/2023/174');
    if (studentReportData.success) {
      reportData = await queryAttendanceReport({ studentNumber: studentReportData.student_number });
    }
  } else if (tab === 'MISSING') {
    reportData = await queryAttendanceReport({
      date: f.date,
      status: 'LEAVING_NOT_SCANNED'
    });
  } else {
    // ALL ATTENDANCE REPORT (Section 22)
    reportData = await queryAttendanceReport({
      eventId: f.eventId,
      startDate: f.startDate,
      endDate: f.endDate,
      studentNumber: f.allStudentSearch,
      status: f.status
    });
  }

  const { records, summary } = reportData;

  container.innerHTML = `
    <!-- Report Type Selector Tabs -->
    <div style="display: flex; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 1.25rem;">
      <button type="button" class="btn ${tab === 'DAILY' ? 'btn-primary' : 'btn-outline'}" data-rtab="DAILY">
        Daily Attendance Report
      </button>
      <button type="button" class="btn ${tab === 'STUDENT' ? 'btn-primary' : 'btn-outline'}" data-rtab="STUDENT">
        Student Attendance Report
      </button>
      <button type="button" class="btn ${tab === 'ALL' ? 'btn-primary' : 'btn-outline'}" data-rtab="ALL">
        All Attendance Report
      </button>
      <button type="button" class="btn ${tab === 'MISSING' ? 'btn-primary' : 'btn-outline'}" data-rtab="MISSING">
        Missing Leaving Scans
      </button>
    </div>

    <div class="card">
      ${renderReportTabControlsHTML(tab, f, events, studentReportData)}

      <!-- Summary Metrics for All Attendance Report (Section 22) -->
      ${
        tab === 'ALL' && summary
          ? `
            <div class="stats-grid" style="margin-top: 1rem;">
              <div class="stat-card stat-primary">
                <span class="stat-label">Total Students</span>
                <span class="stat-value">${summary.unique_students_in_report || 0}</span>
              </div>
              <div class="stat-card stat-indigo">
                <span class="stat-label">Total Attendance Records</span>
                <span class="stat-value">${summary.total_records || 0}</span>
              </div>
              <div class="stat-card stat-success">
                <span class="stat-label">Total Attendance Hours</span>
                <span class="stat-value">${formatDurationMinutes(summary.total_minutes || 0)}</span>
              </div>
              <div class="stat-card stat-primary">
                <span class="stat-label">Currently Present</span>
                <span class="stat-value">${summary.currently_present || 0}</span>
              </div>
              <div class="stat-card stat-success">
                <span class="stat-label">Left</span>
                <span class="stat-value">${summary.left_count || 0}</span>
              </div>
              <div class="stat-card stat-warning">
                <span class="stat-label">Missing Leaving Scan</span>
                <span class="stat-value">${summary.missing_leaving_count || 0}</span>
              </div>
            </div>
          `
          : ''
      }

      <!-- Export Toolbar (Sections 23 & 51) -->
      <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 0.75rem; margin: 1rem 0;">
        <strong style="font-size: 0.95rem;">
          Showing ${records.length} Record(s)
        </strong>
        <div style="display: flex; gap: 0.5rem; flex-wrap: wrap;">
          <button type="button" class="btn btn-sm btn-primary" id="btn-export-csv">
            ⬇ Export CSV
          </button>
          <button type="button" class="btn btn-sm btn-outline" id="btn-export-xls">
            ⬇ Export Excel (.xls)
          </button>
        </div>
      </div>

      ${renderAttendanceTableHTML(records, true)}
    </div>
  `;

  // Bind report tab switching
  container.querySelectorAll('[data-rtab]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      state.reportTab = btn.getAttribute('data-rtab');
      await renderSuperReportsView(container);
    });
  });

  // Bind filter controls
  container.querySelector('#rep-daily-date')?.addEventListener('change', async (e) => {
    state.reportFilters.date = e.target.value;
    await renderSuperReportsView(container);
  });

  container.querySelector('#form-rep-student')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    state.reportFilters.studentNumber = container.querySelector('#rep-student-input')?.value || '';
    await renderSuperReportsView(container);
  });

  container.querySelector('#form-rep-all')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    state.reportFilters.eventId = container.querySelector('#rep-all-event')?.value || '';
    state.reportFilters.startDate = container.querySelector('#rep-all-start')?.value || '';
    state.reportFilters.endDate = container.querySelector('#rep-all-end')?.value || '';
    state.reportFilters.allStudentSearch = container.querySelector('#rep-all-student')?.value || '';
    state.reportFilters.status = container.querySelector('#rep-all-status')?.value || 'ALL';
    await renderSuperReportsView(container);
  });

  // Export filename logic matching Section 51
  const getExportFilenameBase = () => {
    const d = f.date || getTodayDateString();
    if (tab === 'DAILY') return `attendance_${d}`;
    if (tab === 'STUDENT') {
      const cleanStu = normalizeStudentNumber(f.studentNumber || 'PS-2023-174').replace(/\//g, '-');
      return `student_${cleanStu}_attendance`;
    }
    if (tab === 'MISSING') return `missing_leaving_${d}`;
    return 'event_attendance_report';
  };

  container.querySelector('#btn-export-csv')?.addEventListener('click', async () => {
    const base = getExportFilenameBase();
    await exportAttendanceRecords(records, base, 'csv');
    showToast(`Exported ${base}.csv`, 'success');
  });

  container.querySelector('#btn-export-xls')?.addEventListener('click', async () => {
    const base = getExportFilenameBase();
    await exportAttendanceRecords(records, base, 'xls');
    showToast(`Exported ${base}.xls`, 'success');
  });

  bindEditRecordButtons(container, () => renderSuperReportsView(container));
}

function renderReportTabControlsHTML(tab, f, events, studentReportData) {
  if (tab === 'DAILY' || tab === 'MISSING') {
    return `
      <div class="filter-bar">
        <div>
          <label class="form-label" for="rep-daily-date">
            ${tab === 'MISSING' ? 'Select Date ( Leave Blank for All Dates )' : 'Select Attendance Date'}
          </label>
          <input type="date" id="rep-daily-date" class="form-input" value="${escapeHtml(f.date)}" />
        </div>
      </div>
    `;
  }

  if (tab === 'STUDENT') {
    return `
      <form id="form-rep-student" class="filter-bar">
        <div>
          <label class="form-label" for="rep-student-input">Search Student Number</label>
          <input
            type="text"
            id="rep-student-input"
            class="form-input mono"
            placeholder="PS/2023/174"
            value="${escapeHtml(f.studentNumber)}"
            required
          />
        </div>
        <div>
          <button type="submit" class="btn btn-primary">Load Student Report</button>
        </div>
      </form>
      ${
        studentReportData && studentReportData.success
          ? `
            <div class="stats-grid" style="margin-top: 1rem;">
              <div class="stat-card stat-primary">
                <span class="stat-label">Student Number</span>
                <span class="stat-value mono" style="font-size: 1.4rem;">${escapeHtml(studentReportData.student_number)}</span>
              </div>
              <div class="stat-card stat-indigo">
                <span class="stat-label">Total Days</span>
                <span class="stat-value">${studentReportData.days_attended}</span>
              </div>
              <div class="stat-card stat-success">
                <span class="stat-label">Total Hours</span>
                <span class="stat-value">${formatDurationMinutes(studentReportData.total_minutes)}</span>
              </div>
            </div>
          `
          : studentReportData && !studentReportData.success
          ? `<div class="scan-feedback-panel feedback-error" style="margin-top: 0.75rem;">
              <strong>${escapeHtml(studentReportData.message)}</strong>
            </div>`
          : ''
      }
    `;
  }

  // ALL ATTENDANCE REPORT FILTERS (Section 22)
  return `
    <form id="form-rep-all" class="filter-bar">
      <div>
        <label class="form-label" for="rep-all-event">Event</label>
        <select id="rep-all-event" class="form-select">
          <option value="">All Events</option>
          ${events
            .map(
              (ev) => `
              <option value="${escapeHtml(ev.id)}" ${f.eventId === ev.id ? 'selected' : ''}>
                ${escapeHtml(ev.event_name)} (${escapeHtml(ev.event_date)})
              </option>
            `
            )
            .join('')}
        </select>
      </div>

      <div>
        <label class="form-label" for="rep-all-start">From Date</label>
        <input type="date" id="rep-all-start" class="form-input" value="${escapeHtml(f.startDate)}" />
      </div>

      <div>
        <label class="form-label" for="rep-all-end">To Date</label>
        <input type="date" id="rep-all-end" class="form-input" value="${escapeHtml(f.endDate)}" />
      </div>

      <div>
        <label class="form-label" for="rep-all-student">Student Number</label>
        <input
          type="text"
          id="rep-all-student"
          class="form-input mono"
          placeholder="PS/2023/..."
          value="${escapeHtml(f.allStudentSearch)}"
        />
      </div>

      <div>
        <label class="form-label" for="rep-all-status">Status</label>
        <select id="rep-all-status" class="form-select">
          <option value="ALL" ${f.status === 'ALL' ? 'selected' : ''}>All Statuses</option>
          <option value="CURRENTLY_ATTENDING" ${f.status === 'CURRENTLY_ATTENDING' ? 'selected' : ''}>Currently Present</option>
          <option value="LEFT" ${f.status === 'LEFT' ? 'selected' : ''}>Left Normally</option>
          <option value="LEAVING_NOT_SCANNED" ${f.status === 'LEAVING_NOT_SCANNED' ? 'selected' : ''}>ID Not Scanned for Leaving</option>
          <option value="MANUALLY_RECORDED" ${f.status === 'MANUALLY_RECORDED' ? 'selected' : ''}>Manually Recorded</option>
        </select>
      </div>

      <div>
        <button type="submit" class="btn btn-primary btn-block">Apply Filters</button>
      </div>
    </form>
  `;
}

// ============================================================================
// 12. SUPER ADMIN: SESSION SETTINGS (Sections 14, 16, 17, 49)
// ============================================================================

async function renderSessionSettingsView(container) {
  const sessions = await listSessions();
  const current =
    sessions.find((s) => s.id === state.activeSessionId) || sessions[0] || null;
  if (current) state.activeSessionId = current.id;

  container.innerHTML = `
    <div style="max-width: 640px; margin: 0 auto;">
      <div class="card">
        <div class="card-header">
          <h2 class="card-title">Attendance Session Settings</h2>
          <span class="status-badge ${current?.status === 'OPEN' ? 'badge-success' : 'badge-danger'}">
            Status: ${escapeHtml(current?.status || 'NONE')}
          </span>
        </div>

        ${
          !current
            ? `<div class="empty-state">
                <h3>No Session Available</h3>
                <p>Please create an event in the Events tab first.</p>
              </div>`
            : `
              <div class="form-group">
                <label class="form-label" for="ses-select-switcher">Select Session to Configure</label>
                <select id="ses-select-switcher" class="form-select">
                  ${sessions
                    .map(
                      (s) => `
                      <option value="${escapeHtml(s.id)}" ${s.id === current.id ? 'selected' : ''}>
                        ${escapeHtml(s.event_name)} — ${escapeHtml(s.session_date)} (${escapeHtml(s.status)})
                      </option>
                    `
                    )
                    .join('')}
                </select>
              </div>

              <form id="form-session-settings">
                <div class="form-group">
                  <label class="form-label" for="ses-event-name">Event Name</label>
                  <input
                    type="text"
                    id="ses-event-name"
                    class="form-input"
                    value="${escapeHtml(current.event_name)}"
                    required
                  />
                </div>

                <div class="form-group">
                  <label class="form-label" for="ses-date">Attendance Date</label>
                  <input
                    type="date"
                    id="ses-date"
                    class="form-input"
                    value="${escapeHtml(current.session_date)}"
                    required
                  />
                </div>

                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem;">
                  <div class="form-group">
                    <label class="form-label" for="ses-start">Start Time</label>
                    <input
                      type="time"
                      id="ses-start"
                      class="form-input"
                      value="${escapeHtml(current.start_time.slice(0, 5))}"
                      required
                    />
                  </div>
                  <div class="form-group">
                    <label class="form-label" for="ses-end">End Time</label>
                    <input
                      type="time"
                      id="ses-end"
                      class="form-input"
                      value="${escapeHtml(current.end_time.slice(0, 5))}"
                      required
                    />
                  </div>
                </div>

                <button type="submit" class="btn btn-primary btn-block" style="margin-bottom: 1rem;">
                  Save Session Configuration
                </button>
              </form>

              <div style="padding-top: 1rem; border-top: 1px solid var(--border-color); display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem;">
                <button
                  type="button"
                  class="btn btn-success"
                  id="btn-settings-open-session"
                  ${current.status === 'OPEN' ? 'disabled' : ''}
                >
                  OPEN SESSION
                </button>
                <button
                  type="button"
                  class="btn btn-danger"
                  id="btn-settings-close-session"
                  ${current.status === 'CLOSED' ? 'disabled' : ''}
                >
                  CLOSE SESSION
                </button>
              </div>
              <p class="form-hint" style="margin-top: 0.65rem;">
                <strong>End-of-Session Rule:</strong> Closing the session prevents normal attendance scans and automatically marks any student who entered without a leaving scan as <code class="mono">LEAVING_NOT_SCANNED</code> (<em>ID Not Scanned for Leaving</em>) without inventing a fake leaving time.
              </p>
            `
        }
      </div>
    </div>
  `;

  container.querySelector('#ses-select-switcher')?.addEventListener('change', async (e) => {
    state.activeSessionId = e.target.value;
    await renderSessionSettingsView(container);
  });

  container.querySelector('#form-session-settings')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!current) return;
    const event_name = container.querySelector('#ses-event-name')?.value || '';
    const session_date = container.querySelector('#ses-date')?.value || '';
    const start_time = container.querySelector('#ses-start')?.value || '08:00';
    const end_time = container.querySelector('#ses-end')?.value || '17:00';

    try {
      await updateSessionSettings(current.id, {
        event_name,
        session_date,
        start_time,
        end_time,
        status: current.status
      });
      showToast('Session settings saved.', 'success');
      await renderSessionSettingsView(container);
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  container.querySelector('#btn-settings-open-session')?.addEventListener('click', async () => {
    if (!current) return;
    await openAttendanceSession(current.id);
    showToast('Session is now OPEN for attendance scanning.', 'success');
    await renderSessionSettingsView(container);
  });

  container.querySelector('#btn-settings-close-session')?.addEventListener('click', async () => {
    if (!current) return;
    const res = await closeAttendanceSession(current.id);
    showToast(
      `Session CLOSED. ${res.missing_leaving_marked || 0} record(s) marked as ID Not Scanned for Leaving.`,
      'warning'
    );
    await renderSessionSettingsView(container);
  });
}

// ============================================================================
// 13. SUPER ADMIN: AUDIT LOGS VIEW (Section 26)
// ============================================================================

async function renderAuditLogsView(container) {
  const logs = await listAuditLogs({ limit: 100 });

  container.innerHTML = `
    <div class="card">
      <div class="card-header">
        <div>
          <h2 class="card-title">System Audit Logs (${logs.length})</h2>
          <p style="font-size: 0.85rem; color: var(--text-secondary);">
            Immutable audit trail of administrative actions, manual attendance edits, session transitions, and exports.
          </p>
        </div>
      </div>

      ${
        logs.length === 0
          ? `<div class="empty-state">
              <h3>No Audit Logs</h3>
              <p>System actions will be recorded here automatically.</p>
            </div>`
          : `
            <div class="table-responsive">
              <table class="data-table">
                <thead>
                  <tr>
                    <th>Timestamp</th>
                    <th>User</th>
                    <th>Action</th>
                    <th>Table / Record</th>
                    <th>Details</th>
                  </tr>
                </thead>
                <tbody>
                  ${logs
                    .map(
                      (log) => `
                      <tr>
                        <td style="white-space: nowrap; font-size: 0.82rem;">
                          ${escapeHtml(log.created_at?.slice(0, 10) || '')} ${escapeHtml(formatTime12h(log.created_at))}
                        </td>
                        <td>
                          <strong>${escapeHtml(log.user_name || 'Super Admin')}</strong>
                        </td>
                        <td>
                          <span class="status-badge badge-primary">${escapeHtml(log.action)}</span>
                        </td>
                        <td class="mono" style="font-size: 0.8rem;">
                          ${escapeHtml(log.table_name)}
                          ${log.record_id ? `<br/><span style="color: var(--text-muted);">${escapeHtml(String(log.record_id).slice(0, 16))}</span>` : ''}
                        </td>
                        <td class="mono" style="font-size: 0.78rem; max-width: 320px; overflow: hidden; text-overflow: ellipsis;">
                          ${escapeHtml(JSON.stringify(log.details || {}))}
                        </td>
                      </tr>
                    `
                    )
                    .join('')}
                </tbody>
              </table>
            </div>
          `
      }
    </div>
  `;
}

// ============================================================================
// 14. SUPER ADMIN: SYSTEM SETTINGS (Section 53 & 67)
// ============================================================================

async function renderSystemSettingsView(container) {
  const cfg = getSupabaseConfig();
  const soundOn = isSoundEnabled();
  const theme = document.documentElement.getAttribute('data-theme') || 'light';

  container.innerHTML = `
    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 1.25rem; align-items: start;">
      <div class="card">
        <h2 class="card-title" style="margin-bottom: 0.5rem;">Supabase Connection Configuration</h2>
        <p style="font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 1rem;">
          Connect to your live Supabase PostgreSQL project using your public Project URL and <code class="mono">anon</code> public key.
          Never enter a <code class="mono">service_role</code> secret key in the browser.
        </p>

        <form id="form-supabase-config">
          <div class="form-group">
            <label class="form-label" for="cfg-supa-url">SUPABASE_URL</label>
            <input
              type="url"
              id="cfg-supa-url"
              class="form-input mono"
              placeholder="https://xyzcompany.supabase.co"
              value="${escapeHtml(cfg.url)}"
            />
          </div>

          <div class="form-group">
            <label class="form-label" for="cfg-supa-key">SUPABASE_ANON_KEY (Public Key Only)</label>
            <input
              type="password"
              id="cfg-supa-key"
              class="form-input mono"
              placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6..."
              value="${escapeHtml(cfg.anonKey)}"
            />
          </div>

          <div style="display: flex; gap: 0.5rem;">
            <button type="submit" class="btn btn-primary">Save Connection</button>
            <button type="button" class="btn btn-outline" id="btn-clear-supa-config">
              Use Local Test Sandbox
            </button>
          </div>
        </form>
      </div>

      <div class="card">
        <h2 class="card-title" style="margin-bottom: 0.75rem;">Interface & Development Controls</h2>

        <div style="display: flex; flex-direction: column; gap: 0.85rem;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <div>
              <strong>Scanner Sound & Haptic Vibration</strong>
              <p style="font-size: 0.82rem; color: var(--text-secondary);">Audio beep and vibration on QR scan</p>
            </div>
            <button type="button" class="btn btn-sm btn-outline" id="btn-settings-sound">
              ${soundOn ? '🔊 Enabled' : '🔇 Disabled'}
            </button>
          </div>

          <div style="display: flex; justify-content: space-between; align-items: center;">
            <div>
              <strong>Color Theme</strong>
              <p style="font-size: 0.82rem; color: var(--text-secondary);">Switch between Light and Dark mode</p>
            </div>
            <button type="button" class="btn btn-sm btn-outline" id="btn-settings-theme">
              ${theme === 'dark' ? '☀ Switch to Light' : '☾ Switch to Dark'}
            </button>
          </div>

          <div style="padding-top: 0.85rem; border-top: 1px solid var(--border-color); display: flex; justify-content: space-between; align-items: center;">
            <div>
              <strong>Reset Development Test Data</strong>
              <p style="font-size: 0.82rem; color: var(--text-secondary);">
                Restores default test students (<code class="mono">PS/2023/001..250</code>) in local sandbox
              </p>
            </div>
            <button type="button" class="btn btn-sm btn-danger" id="btn-reset-dev-db">
              Reset Sandbox
            </button>
          </div>
        </div>
      </div>
    </div>
  `;

  container.querySelector('#form-supabase-config')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = container.querySelector('#cfg-supa-url')?.value || '';
    const key = container.querySelector('#cfg-supa-key')?.value || '';
    try {
      saveSupabaseConfig(url, key);
      showToast('Supabase configuration updated.', 'success');
      await renderApp();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  container.querySelector('#btn-clear-supa-config')?.addEventListener('click', async () => {
    saveSupabaseConfig('', '');
    showToast('Switched to built-in Local Development Sandbox.', 'info');
    await renderApp();
  });

  container.querySelector('#btn-settings-sound')?.addEventListener('click', async () => {
    setSoundEnabled(!isSoundEnabled());
    await renderSystemSettingsView(container);
  });

  container.querySelector('#btn-settings-theme')?.addEventListener('click', toggleTheme);

  container.querySelector('#btn-reset-dev-db')?.addEventListener('click', async () => {
    if (!confirm('Reset local development test data to initial state?')) return;
    resetDevDatabase();
    showToast('Development test database reset.', 'success');
    await renderSystemSettingsView(container);
  });
}

// Start the application
bootstrap();
