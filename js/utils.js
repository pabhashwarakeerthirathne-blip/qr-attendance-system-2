/**
 * js/utils.js
 * Core validation, formatting, audio/haptic feedback, and CSV/Excel export utilities.
 */

// Accepts any 2-letter uppercase prefix followed by /YYYY/NNN
export const STUDENT_NUMBER_REGEX = /^([A-Z]{2})\/\d{4}\/\d{3,}$/;

/**
 * Normalizes a student number (trims whitespace, converts to uppercase).
 * Example: " tt/2023/152 " -> "TT/2023/152"
 */
export function normalizeStudentNumber(raw) {
  if (typeof raw !== 'string') return '';
  return raw.trim().toUpperCase();
}

/**
 * Validates that a student number strictly matches XX/YYYY/NNN (e.g. AC/2023/152)
 */
export function validateStudentNumber(raw) {
  const normalized = normalizeStudentNumber(raw);
  const valid = STUDENT_NUMBER_REGEX.test(normalized);
  return {
    valid,
    normalized,
    error: valid
      ? null
      : 'Invalid Student Number. Format must be XX/YYYY/NNN (e.g., AC/2023/152)'
  };
}

/**
 * Calculates duration in integer minutes between two ISO timestamps.
 */
export function calculateDurationMinutes(entryTime, leavingTime) {
  if (!entryTime || !leavingTime) return null;
  const start = new Date(entryTime).getTime();
  const end = new Date(leavingTime).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return 0;
  return Math.floor((end - start) / 60000);
}

/**
 * Formats duration in minutes to "Xh Ym" (e.g., 473 -> "7h 53m").
 * Never uses rounded display values for totals.
 */
export function formatDurationMinutes(minutes) {
  if (minutes === null || minutes === undefined || Number.isNaN(Number(minutes))) {
    return '-';
  }
  const total = Math.max(0, Math.floor(Number(minutes)));
  const hrs = Math.floor(total / 60);
  const mins = total % 60;
  return `${hrs}h ${String(mins).padStart(2, '0')}m`;
}

/**
 * Formats an ISO timestamp or HH:MM:SS string to 12-hour format (e.g., "08:42 AM").
 */
export function formatTime12h(value) {
  if (!value) return '-';
  if (/^\d{2}:\d{2}(:\d{2})?$/.test(value)) {
    const [hStr, mStr] = value.split(':');
    let h = parseInt(hStr, 10);
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${String(h).padStart(2, '0')}:${mStr} ${ampm}`;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  });
}

/**
 * Formats an ISO timestamp to 24-hour HH:MM (e.g., "08:42" or "16:35").
 */
export function formatTime24h(value) {
  if (!value) return '-';
  if (/^\d{2}:\d{2}(:\d{2})?$/.test(value)) {
    return value.slice(0, 5);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
}

/**
 * Formats a YYYY-MM-DD date string to readable format (e.g., "08 October 2026").
 */
export function formatDateLong(dateStr) {
  if (!dateStr) return '-';
  const parts = String(dateStr).slice(0, 10).split('-');
  if (parts.length === 3) {
    const d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleDateString('en-GB', {
        day: '2-digit',
        month: 'long',
        year: 'numeric'
      });
    }
  }
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return String(dateStr);
  return d.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'long',
    year: 'numeric'
  });
}

/**
 * Formats a YYYY-MM-DD date string to compact format (e.g., "08 Oct 2026").
 */
export function formatDateShort(dateStr) {
  if (!dateStr) return '-';
  const parts = String(dateStr).slice(0, 10).split('-');
  if (parts.length === 3) {
    const d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleDateString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric'
      });
    }
  }
  return String(dateStr);
}

/**
 * Returns today's local date in YYYY-MM-DD format.
 */
export function getTodayDateString() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Returns current local time in HH:MM:SS format.
 */
export function getCurrentTimeString() {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, '0');
  const m = String(now.getMinutes()).padStart(2, '0');
  const s = String(now.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

/**
 * Escapes HTML special characters to prevent XSS.
 */
export function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Returns structured status metadata (label, CSS class, icon) for accessibility.
 */
export function getStatusMeta(status, leavingStatus = null) {
  const code = status || 'UNKNOWN';
  if (code === 'LEAVING_NOT_SCANNED' || leavingStatus === 'LEAVING_NOT_SCANNED') {
    return {
      code: 'LEAVING_NOT_SCANNED',
      label: 'ID Not Scanned for Leaving',
      shortLabel: 'NOT SCANNED',
      conceptNote: 'ID not scan For the leaving',
      badgeClass: 'badge-warning',
      icon: '⚠'
    };
  }
  switch (code) {
    case 'CURRENTLY_ATTENDING':
    case 'PRESENT':
      return {
        code,
        label: 'Currently Attending',
        shortLabel: 'PRESENT',
        badgeClass: 'badge-primary',
        icon: '●'
      };
    case 'LEFT':
      return {
        code: 'LEFT',
        label: 'Left Normally',
        shortLabel: 'LEFT',
        badgeClass: 'badge-success',
        icon: '✓'
      };
    case 'MANUALLY_RECORDED':
      return {
        code: 'MANUALLY_RECORDED',
        label: 'Manually Recorded',
        shortLabel: 'MANUAL',
        badgeClass: 'badge-neutral',
        icon: '✎'
      };
    default:
      return {
        code,
        label: code.replace(/_/g, ' '),
        shortLabel: code,
        badgeClass: 'badge-neutral',
        icon: '•'
      };
  }
}

/**
 * Renders an accessible status badge HTML snippet.
 */
export function renderStatusBadge(status, leavingStatus = null, compact = false) {
  const meta = getStatusMeta(status, leavingStatus);
  const text = compact ? meta.shortLabel : meta.label;
  const titleAttr = meta.conceptNote ? ` title="${escapeHtml(meta.conceptNote)}"` : '';
  return `<span class="status-badge ${meta.badgeClass}"${titleAttr}><span aria-hidden="true">${meta.icon}</span> ${escapeHtml(text)}</span>`;
}

/**
 * Audio & haptic feedback for QR scanner (optional/toggleable by user).
 */
let audioCtx = null;

export function isSoundEnabled() {
  return localStorage.getItem('uniattend_sound') !== 'off';
}

export function setSoundEnabled(enabled) {
  localStorage.setItem('uniattend_sound', enabled ? 'on' : 'off');
}

export function triggerScanFeedback(type = 'success') {
  // Haptic vibration where supported
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function' && isSoundEnabled()) {
    try {
      if (type === 'success') navigator.vibrate(70);
      else if (type === 'warning') navigator.vibrate([50, 40, 50]);
      else navigator.vibrate([120, 60, 120]);
    } catch (_) {
      // Ignore vibration restrictions
    }
  }

  if (!isSoundEnabled()) return;

  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    if (!audioCtx) audioCtx = new AudioContextClass();
    if (audioCtx.state === 'suspended') audioCtx.resume();

    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);

    const now = audioCtx.currentTime;
    if (type === 'success') {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, now);
      osc.frequency.setValueAtTime(1174.66, now + 0.07);
      gain.gain.setValueAtTime(0.12, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
      osc.start(now);
      osc.stop(now + 0.18);
    } else if (type === 'warning') {
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(520, now);
      gain.gain.setValueAtTime(0.12, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
      osc.start(now);
      osc.stop(now + 0.22);
    } else {
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(260, now);
      osc.frequency.setValueAtTime(195, now + 0.1);
      gain.gain.setValueAtTime(0.12, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
      osc.start(now);
      osc.stop(now + 0.28);
    }
  } catch (_) {
    // Ignore audio context errors on restricted browsers
  }
}

/**
 * Exports tabular data to a UTF-8 BOM CSV file compatible with Excel, Google Sheets, and LibreOffice.
 */
export function exportToCSV(filename, headers, rows) {
  const escapeCell = (val) => {
    const str = val === null || val === undefined ? '' : String(val);
    if (/[",\r\n]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const lines = [
    headers.map(escapeCell).join(','),
    ...rows.map((row) => row.map(escapeCell).join(','))
  ];

  // Include UTF-8 BOM (\uFEFF) so Microsoft Excel opens UTF-8 characters and columns properly
  const csvContent = '\uFEFF' + lines.join('\r\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  link.setAttribute('href', url);
  link.setAttribute('download', filename.endsWith('.csv') ? filename : `${filename}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Exports tabular data to an Excel-compatible SpreadsheetML (.xls / .xlsx compatible XML) file.
 */
export function exportToExcelXML(filename, sheetTitle, headers, rows) {
  const xmlEscape = (v) =>
    String(v ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  const headerCells = headers
    .map((h) => `<Cell ss:StyleID="sHeader"><Data ss:Type="String">${xmlEscape(h)}</Data></Cell>`)
    .join('');

  const bodyRows = rows
    .map(
      (r) =>
        `<Row>${r
          .map((c) => `<Cell><Data ss:Type="String">${xmlEscape(c)}</Data></Cell>`)
          .join('')}</Row>`
    )
    .join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <Styles>
  <Style ss:ID="sHeader">
   <Font ss:Bold="1"/>
  </Style>
 </Styles>
 <Worksheet ss:Name="${xmlEscape(sheetTitle.slice(0, 31))}">
  <Table>
   <Row>${headerCells}</Row>
   ${bodyRows}
  </Table>
 </Worksheet>
</Workbook>`;

  const blob = new Blob([xml], { type: 'application/vnd.ms-excel;charset=utf-8;' });
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  link.setAttribute('href', url);
  link.setAttribute('download', filename.endsWith('.xls') ? filename : `${filename}.xls`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Displays a non-blocking toast notification.
 */
export function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-live', 'polite');

  const iconMap = {
    success: '✓',
    error: '✕',
    warning: '⚠',
    info: 'ℹ'
  };

  toast.innerHTML = `
    <span class="toast-icon" aria-hidden="true">${iconMap[type] || 'ℹ'}</span>
    <span class="toast-msg">${escapeHtml(message)}</span>
  `;

  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('toast-hide');
    setTimeout(() => toast.remove(), 250);
  }, 3400);
}
