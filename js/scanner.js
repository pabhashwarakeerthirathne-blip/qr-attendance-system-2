/**
 * js/scanner.js
 * High-Performance QR Code Scanner Module
 * - Uses hardware-accelerated BarcodeDetector API where supported, with lazy-loaded jsQR fallback
 * - Low CPU/memory crop-based frame scanning (~12 FPS)
 * - Smart lens debounce + immediate auto-resume for next student
 * - Full Camera Permission & HTTPS error handling (Section 38)
 */

import { recordAttendanceScan } from './attendance.js';
import {
  formatTime12h,
  formatDurationMinutes,
  triggerScanFeedback,
  escapeHtml
} from './utils.js';

let videoStream = null;
let scanIntervalId = null;
let isProcessingScan = false;
let lastCode = '';
let lastCodeTime = 0;
let currentFacingMode = 'environment';
let torchEnabled = false;
let barcodeDetector = null;
let jsQrLoaded = false;

const LENS_DEBOUNCE_MS = 2800; // Prevents firing 10 requests/sec while same card is in frame

/**
 * Lazy-loads jsQR only if native BarcodeDetector is unavailable in the current browser.
 */
async function ensureQrDecoder() {
  if ('BarcodeDetector' in window) {
    try {
      const formats = await window.BarcodeDetector.getSupportedFormats();
      if (formats.includes('qr_code')) {
        barcodeDetector = new window.BarcodeDetector({ formats: ['qr_code'] });
        return 'NATIVE';
      }
    } catch (_) {
      // Fallback to jsQR
    }
  }

  if (window.jsQR) {
    jsQrLoaded = true;
    return 'JSQR';
  }

  return new Promise((resolve) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js';
    script.async = true;
    script.onload = () => {
      jsQrLoaded = true;
      resolve('JSQR');
    };
    script.onerror = () => resolve('NONE');
    document.head.appendChild(script);
  });
}

/**
 * Starts the camera video stream and QR detection loop inside the scanner view.
 */
export async function startQrScanner({
  videoElement,
  statusElement,
  onScanResult,
  getSessionId,
  getScanMode
}) {
  stopQrScanner();

  if (!videoElement) return;

  // Check HTTPS / Secure Context requirement (Section 38)
  if (!window.isSecureContext && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
    renderCameraMessage(
      statusElement,
      'HTTPS Required for Camera Access',
      'Browser security requires HTTPS (such as Vercel deployment) or localhost to access the camera. Please use HTTPS or enter Student Numbers manually below.',
      'error'
    );
    return;
  }

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    renderCameraMessage(
      statusElement,
      'Camera API Unsupported',
      'Your current browser does not support direct camera video streaming. Please use Chrome, Safari, or Edge, or use Manual Entry below.',
      'warning'
    );
    return;
  }

  renderCameraMessage(statusElement, 'Starting Camera...', 'Requesting camera access for fast QR detection.', 'loading');

  try {
    await ensureQrDecoder();

    const constraints = {
      audio: false,
      video: {
        facingMode: { ideal: currentFacingMode },
        width: { ideal: 1280 },
        height: { ideal: 720 }
      }
    };

    videoStream = await navigator.mediaDevices.getUserMedia(constraints);
    videoElement.srcObject = videoStream;
    videoElement.setAttribute('playsinline', 'true');
    await videoElement.play();

    if (statusElement) {
      statusElement.innerHTML = '';
      statusElement.classList.add('hidden');
    }

    // Offscreen canvas for lightweight center-region QR decoding
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    scanIntervalId = window.setInterval(async () => {
      if (isProcessingScan || videoElement.readyState !== videoElement.HAVE_ENOUGH_DATA) {
        return;
      }

      const vw = videoElement.videoWidth;
      const vh = videoElement.videoHeight;
      if (!vw || !vh) return;

      try {
        let detectedRaw = null;

        if (barcodeDetector) {
          const barcodes = await barcodeDetector.detect(videoElement);
          if (barcodes && barcodes.length > 0) {
            detectedRaw = barcodes[0].rawValue;
          }
        } else if (jsQrLoaded && window.jsQR) {
          const cropSize = Math.min(vw, vh, 480);
          const sx = Math.floor((vw - cropSize) / 2);
          const sy = Math.floor((vh - cropSize) / 2);
          canvas.width = 320;
          canvas.height = 320;
          ctx.drawImage(videoElement, sx, sy, cropSize, cropSize, 0, 0, 320, 320);
          const imageData = ctx.getImageData(0, 0, 320, 320);
          const code = window.jsQR(imageData.data, imageData.width, imageData.height, {
            inversionAttempts: 'dontInvert'
          });
          if (code && code.data) {
            detectedRaw = code.data;
          }
        }

        if (detectedRaw) {
          const now = Date.now();
          const trimmed = String(detectedRaw).trim();
          if (!trimmed) return;

          // Lens debounce: ignore identical frame within LENS_DEBOUNCE_MS
          if (trimmed === lastCode && now - lastCodeTime < LENS_DEBOUNCE_MS) {
            return;
          }

          lastCode = trimmed;
          lastCodeTime = now;

          await processDetectedCode({
            rawText: trimmed,
            method: 'QR',
            sessionId: typeof getSessionId === 'function' ? getSessionId() : null,
            scanMode: typeof getScanMode === 'function' ? getScanMode() : 'AUTO',
            onScanResult
          });
        }
      } catch (_) {
        // Ignore transient frame decode errors
      }
    }, 85);
  } catch (err) {
    handleCameraError(err, statusElement);
  }
}

/**
 * Stops active camera tracks and clears the QR detection interval.
 */
export function stopQrScanner() {
  if (scanIntervalId) {
    clearInterval(scanIntervalId);
    scanIntervalId = null;
  }
  if (videoStream) {
    videoStream.getTracks().forEach((track) => track.stop());
    videoStream = null;
  }
  isProcessingScan = false;
  torchEnabled = false;
}

/**
 * Switches between rear ('environment') and front ('user') cameras.
 */
export async function toggleCameraFacingMode(scannerOptions) {
  currentFacingMode = currentFacingMode === 'environment' ? 'user' : 'environment';
  await startQrScanner(scannerOptions);
  return currentFacingMode;
}

/**
 * Toggles camera flashlight/torch if supported by the mobile device hardware.
 */
export async function toggleCameraTorch() {
  if (!videoStream) return false;
  const track = videoStream.getVideoTracks()[0];
  if (!track || typeof track.getCapabilities !== 'function') return false;

  const capabilities = track.getCapabilities();
  if (!capabilities.torch) return false;

  torchEnabled = !torchEnabled;
  await track.applyConstraints({ advanced: [{ torch: torchEnabled }] });
  return torchEnabled;
}

/**
 * Executes the scan workflow:
 * Extract text -> Validate -> Database lookup -> Record attendance -> Display result immediately
 */
export async function processDetectedCode({
  rawText,
  method = 'QR',
  sessionId = null,
  scanMode = 'AUTO',
  onScanResult
}) {
  if (isProcessingScan) return null;
  isProcessingScan = true;

  if (typeof onScanResult === 'function') {
    onScanResult({ state: 'LOADING', student_number: rawText });
  }

  try {
    const result = await recordAttendanceScan(rawText, {
      sessionId,
      method,
      scanMode
    });

    if (result.success) {
      triggerScanFeedback('success');
    } else if (result.code === 'ALREADY_CHECKED_IN' || result.code === 'ALREADY_LEFT') {
      triggerScanFeedback('warning');
    } else {
      triggerScanFeedback('error');
    }

    if (typeof onScanResult === 'function') {
      onScanResult(result);
    }
    return result;
  } catch (err) {
    triggerScanFeedback('error');
    const errPayload = {
      success: false,
      code: 'ERROR',
      student_number: rawText,
      message: err.message || 'Failed to process attendance scan.'
    };
    if (typeof onScanResult === 'function') {
      onScanResult(errPayload);
    }
    return errPayload;
  } finally {
    isProcessingScan = false;
  }
}

/**
 * Renders the immediate visual feedback card on the scanner screen (Sections 11, 12, 39, 57).
 */
export function renderScanResultBanner(container, result, onForceLeaving = null) {
  if (!container) return;

  if (!result) {
    container.innerHTML = '';
    container.className = 'scan-feedback-panel hidden';
    return;
  }

  if (result.state === 'LOADING') {
    container.className = 'scan-feedback-panel feedback-loading';
    container.innerHTML = `
      <div class="feedback-header">
        <span class="spinner-sm" aria-hidden="true"></span>
        <strong>Checking student...</strong>
      </div>
      <div class="feedback-student">${escapeHtml(result.student_number || '')}</div>
    `;
    return;
  }

  // 1. Successful ENTRY
  if (result.success && result.action === 'ENTRY') {
    const timeFormatted = formatTime12h(result.entry_time || result.time);
    container.className = 'scan-feedback-panel feedback-success';
    container.innerHTML = `
      <div class="feedback-icon" aria-hidden="true">✓</div>
      <div class="feedback-title">ATTENDANCE RECORDED</div>
      <div class="feedback-grid">
        <div>
          <span class="feedback-label">Student Number</span>
          <strong class="feedback-value mono">${escapeHtml(result.student_number)}</strong>
        </div>
        <div>
          <span class="feedback-label">Entry Time</span>
          <strong class="feedback-value">${escapeHtml(timeFormatted)}</strong>
        </div>
        <div>
          <span class="feedback-label">Status</span>
          <strong class="feedback-value">Present</strong>
        </div>
      </div>
    `;
    return;
  }

  // 2. Successful LEAVING
  if (result.success && result.action === 'LEAVING') {
    const timeFormatted = formatTime12h(result.leaving_time || result.time);
    const durFormatted = formatDurationMinutes(result.duration_minutes);
    container.className = 'scan-feedback-panel feedback-success';
    container.innerHTML = `
      <div class="feedback-icon" aria-hidden="true">✓</div>
      <div class="feedback-title">LEAVING RECORDED</div>
      <div class="feedback-grid">
        <div>
          <span class="feedback-label">Student Number</span>
          <strong class="feedback-value mono">${escapeHtml(result.student_number)}</strong>
        </div>
        <div>
          <span class="feedback-label">Leaving Time</span>
          <strong class="feedback-value">${escapeHtml(timeFormatted)}</strong>
        </div>
        <div>
          <span class="feedback-label">Duration</span>
          <strong class="feedback-value">${escapeHtml(durFormatted)}</strong>
        </div>
      </div>
    `;
    return;
  }

  // 3. Offline Queued Scan
  if (result.queued) {
    container.className = 'scan-feedback-panel feedback-warning';
    container.innerHTML = `
      <div class="feedback-icon" aria-hidden="true">⟳</div>
      <div class="feedback-title">SAVED TO OFFLINE QUEUE</div>
      <div class="feedback-student mono">${escapeHtml(result.student_number)}</div>
      <p class="feedback-desc">${escapeHtml(result.message)}</p>
    `;
    return;
  }

  // 4. Duplicate Entry Scan ("Already Checked In" / "Already Recorded")
  if (result.code === 'ALREADY_CHECKED_IN') {
    const entryFormatted = formatTime12h(result.entry_time || result.time);
    container.className = 'scan-feedback-panel feedback-warning';
    container.innerHTML = `
      <div class="feedback-icon" aria-hidden="true">!</div>
      <div class="feedback-title">ALREADY CHECKED IN</div>
      <div class="feedback-grid">
        <div>
          <span class="feedback-label">Already Recorded</span>
          <strong class="feedback-value mono">${escapeHtml(result.student_number)}</strong>
        </div>
        <div>
          <span class="feedback-label">Entry</span>
          <strong class="feedback-value">${escapeHtml(entryFormatted)}</strong>
        </div>
      </div>
      <div class="feedback-actions">
        <button type="button" class="btn btn-sm btn-outline" id="btn-force-leaving-scan">
          Mark Leaving Attendance Instead
        </button>
      </div>
    `;

    const forceBtn = container.querySelector('#btn-force-leaving-scan');
    if (forceBtn && typeof onForceLeaving === 'function') {
      forceBtn.addEventListener('click', () => onForceLeaving(result.student_number));
    }
    return;
  }

  // 5. Already Checked Out
  if (result.code === 'ALREADY_LEFT') {
    const leavingFormatted = formatTime12h(result.leaving_time || result.time);
    container.className = 'scan-feedback-panel feedback-warning';
    container.innerHTML = `
      <div class="feedback-icon" aria-hidden="true">!</div>
      <div class="feedback-title">ALREADY CHECKED OUT</div>
      <div class="feedback-student mono">${escapeHtml(result.student_number)}</div>
      <p class="feedback-desc">Leaving recorded at ${escapeHtml(leavingFormatted)} (${escapeHtml(
      formatDurationMinutes(result.duration_minutes)
    )}).</p>
    `;
    return;
  }

  // 6. Friendly Error States (Section 39: Invalid QR, Student Not Found, Session Closed)
  let errorTitle = 'SCAN ERROR';
  let errorBody = result.message || 'Unable to record attendance.';

  if (result.code === 'INVALID_FORMAT') {
    errorTitle = 'INVALID STUDENT ID';
    errorBody = 'This QR code does not contain a valid Student Number (Expected: PS/2023/174).';
  } else if (result.code === 'STUDENT_NOT_FOUND') {
    errorTitle = 'STUDENT NOT FOUND';
    errorBody = `${result.student_number} is not registered in this event. Please contact the administrator.`;
  } else if (result.code === 'SESSION_CLOSED') {
    errorTitle = 'ATTENDANCE SESSION CLOSED';
    errorBody = 'This attendance session is no longer accepting scans.';
  }

  container.className = 'scan-feedback-panel feedback-error';
  container.innerHTML = `
    <div class="feedback-icon" aria-hidden="true">✕</div>
    <div class="feedback-title">${escapeHtml(errorTitle)}</div>
    ${
      result.student_number
        ? `<div class="feedback-student mono">${escapeHtml(result.student_number)}</div>`
        : ''
    }
    <p class="feedback-desc">${escapeHtml(errorBody)}</p>
  `;
}

function handleCameraError(err, statusElement) {
  const name = err?.name || '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    renderCameraMessage(
      statusElement,
      'Camera Permission Required',
      'Camera permission is required. Please allow camera access in your browser settings, or use Manual Student Number Entry below.',
      'error'
    );
  } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    renderCameraMessage(
      statusElement,
      'Camera Unavailable',
      'No camera hardware was detected on this device. Use the Manual Student Number input or the Quick Scan Simulator below.',
      'warning'
    );
  } else if (name === 'NotReadableError' || name === 'TrackStartError') {
    renderCameraMessage(
      statusElement,
      'Camera in Use',
      'Your camera is currently being used by another application or tab.',
      'warning'
    );
  } else {
    renderCameraMessage(
      statusElement,
      'Camera Unavailable',
      err?.message || 'Unable to start video stream. Please use Manual Student Number Entry below.',
      'warning'
    );
  }
}

function renderCameraMessage(el, title, message, type = 'info') {
  if (!el) return;
  el.classList.remove('hidden');
  el.innerHTML = `
    <div class="camera-status-box camera-status-${escapeHtml(type)}">
      <h4>${escapeHtml(title)}</h4>
      <p>${escapeHtml(message)}</p>
    </div>
  `;
}
