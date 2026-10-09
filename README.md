# UniAttend — Student Event Attendance Management Web Application

## 1. Project Description

**UniAttend** is a fast, lightweight, responsive Progressive Web App (PWA) for managing student attendance at university events using **Student ID QR Codes**.

The primary attendance workflow is:
**Student ID QR Code (`PS/2023/174`) → Admin Scans QR → System Identifies Student Number → Entry or Leaving Attendance Recorded → Live Counts & Reports Updated.**

Students are identified strictly by their **Student Number** (`PS/YYYY/NNN`), such as `PS/2023/174`.

---

## 2. Features

* **Three Role Portals**:
  * **Super Admin**: Full system management, live dashboard, event creation, session opening/closing, student CRUD + bulk CSV import, Admin account creation/disable/enable, manual attendance correction, comprehensive reports, CSV/Excel exports, and immutable audit logs.
  * **Admin**: Fast mobile/desktop QR camera scanner, manual Student Number entry fallback, live event counters, and today's attendance view.
  * **Student**: Passwordless, isolated Student Number lookup showing only that student's daily attendance records, duration per day, total days attended, and cumulative hours (`Xh Ym`).
* **Strict Student Number Validation**: Enforces `^PS\/\d{4}\/\d{3,}$` in both JavaScript and PostgreSQL `CHECK` constraints, normalizing lowercase input (`ps/2023/174` → `PS/2023/174`).
* **Smart Entry & Leaving Logic**:
  * First scan records `ENTRY` (`CURRENTLY_ATTENDING`).
  * Built-in lens debounce and duplicate-entry cooldown prevent accidental repeated scans (`ALREADY CHECKED IN`).
  * Subsequent scan when leaving records `LEAVING` (`LEFT` / `LEFT_NORMALLY`) and computes integer `duration_minutes`.
* **End-of-Session Missing Leaving Process**:
  * When a session closes, any student with an entry scan and no leaving scan is automatically marked `LEAVING_NOT_SCANNED` (**ID Not Scanned for Leaving** / *ID not scan For the leaving*) without inventing a fake leaving time.
* **Offline Queue & Auto-Sync**: Queues scans locally if event Wi-Fi/cellular drops and synchronizes when connectivity returns without creating duplicates.
* **Progressive Web App (PWA)**: Installable on Android, iOS/iPadOS, Windows, and macOS with light/dark mode support.

---

## 3. Architecture

```text
attendance-app/
├── index.html               # Single-page entry with semantic markup & PWA headers
├── manifest.json            # Web App Manifest for Android/iOS/Desktop installation
├── service-worker.js        # App shell caching for fast startup
├── vercel.json              # Vercel deployment headers & Camera Permissions-Policy
├── .env.example             # Public environment variable template
├── assets/
│   └── icons/
│       ├── icon-192.svg
│       └── icon-512.svg
├── css/
│   ├── style.css            # Core design system, Light/Dark themes, cards, tables
│   ├── scanner.css          # QR camera stage, targeting reticle, scan feedback banners
│   └── responsive.css       # Mobile (360px+) bottom nav & desktop sidebar layout
├── js/
│   ├── app.js               # Main router, role portals, UI state & view controllers
│   ├── auth.js              # Supabase Auth, role verification, Admin account management
│   ├── supabase.js          # Supabase client, Realtime listener, offline queue & dev sandbox
│   ├── scanner.js           # Native BarcodeDetector + jsQR fallback camera scanner
│   ├── attendance.js        # Unified QR/Manual attendance service, session & manual edits
│   ├── students.js          # Student CRUD, CSV bulk import, isolated student lookup
│   ├── reports.js           # Daily, Student, Event & All Attendance reports + CSV/XLS export
│   ├── dashboard.js         # Live session statistics & recent scan feeds
│   └── utils.js             # Regex validation, time/duration math, audio/haptic & CSV helpers
└── supabase/
    ├── schema.sql           # Normalized PostgreSQL tables, constraints, triggers, Realtime
    ├── policies.sql         # Row Level Security (RLS) policies for all tables
    ├── functions.sql        # Atomic RPC functions (record_attendance_scan, close_session, etc.)
    └── seed.sql             # Controlled Super Admin setup & development test data
```

---

## 4. Supabase Setup

1. Create a free account at [https://supabase.com](https://supabase.com) and create a new project.
2. In your Supabase project dashboard, open the **SQL Editor**.
3. Run the SQL scripts inside `supabase/` in the following exact order:
   1. `supabase/schema.sql`
   2. `supabase/policies.sql`
   3. `supabase/functions.sql`
   4. `supabase/seed.sql` (Follow Part A for your production Super Admin; only run Part B in development).

---

## 5. Database Setup

The PostgreSQL schema (`supabase/schema.sql`) creates 6 normalized tables:
* `public.profiles` — Links `auth.users` to application roles (`SUPER_ADMIN`, `ADMIN`) and status (`ACTIVE`, `DISABLED`).
* `public.students` — Stores unique `student_number` values constrained by `CHECK (student_number ~ '^PS/[0-9]{4}/[0-9]{3,}$')`.
* `public.events` — Stores university events (`event_name`, `event_date`, `start_time`, `end_time`, `status`).
* `public.attendance_sessions` — Links an attendance window (`OPEN` / `CLOSED`) to an event.
* `public.attendance_records` — Tracks `entry_time`, `leaving_time`, `entry_method` (`QR`/`MANUAL`), `leaving_method`, `status`, `leaving_status` (`LEFT_NORMALLY` / `LEAVING_NOT_SCANNED`), and `duration_minutes`, protected by `UNIQUE (session_id, student_id)`.
* `public.audit_logs` — Append-only audit trail of all administrative actions.

---

## 6. Authentication Setup

1. In Supabase Dashboard → **Authentication** → **Providers** → **Email**:
   * Enable **Email provider**.
   * Recommended: Turn **Confirm email** OFF if you want Super Admin to create Admin accounts that are immediately active without requiring email verification links.
2. Disable public signups for unauthorized users: all table access requires an `ACTIVE` row in `public.profiles`.

---

## 7. Environment Variables

Only public keys protected by Row Level Security are used in the frontend:

```env
VITE_SUPABASE_URL=https://your-project-id.supabase.co
VITE_SUPABASE_ANON_KEY=your-public-anon-key
```

* **Public (Safe for Browser)**: `SUPABASE_URL`, `SUPABASE_ANON_KEY`
* **Secret (NEVER Expose in Browser)**: `SUPABASE_SERVICE_ROLE_KEY` (The app actively rejects `service_role` keys if pasted).

You can also configure `SUPABASE_URL` and `SUPABASE_ANON_KEY` directly in the Super Admin **Settings** tab.

---

## 8. Local Development

You can serve the project using any static web server (no heavy build step required):

```bash
# Using Python 3
python -m http.server 3000

# OR using Node.js npx serve
npx serve . -l 3000
```

Open `http://localhost:3000` in your browser.

### Built-in Local Development Sandbox
When `SUPABASE_URL` is not configured yet, the application automatically runs in **Local Test Mode** pre-loaded with the Section 67 development test students (`PS/2023/001`, `PS/2023/002`, `PS/2023/003`, `PS/2023/174`, `PS/2023/250`) and two test staff accounts:
* **Super Admin**: `superadmin@university.edu` / `SuperAdmin@2026`
* **Scanner Admin**: `admin@university.edu` / `Admin@2026`

---

## 9. Vercel Deployment

1. Push this repository to **GitHub**.
2. Log in to [https://vercel.com](https://vercel.com) (Free Tier) and click **Add New Project**.
3. Import your GitHub repository.
4. Framework Preset: **Other** (Static HTML/JS) or **Vite** if bundled.
5. Click **Deploy**. Vercel automatically provisions HTTPS (required for mobile camera permissions) and applies `vercel.json` headers.

---

## 10. PWA Installation

* **Android (Chrome)**: Open the deployed Vercel URL → tap **Install App** in the top bar or browser menu **Add to Home screen**.
* **iPhone / iPad (Safari)**: Open the URL in Safari → tap the **Share** icon → tap **Add to Home Screen**.
* **Windows / macOS (Chrome / Edge)**: Click the **Install UniAttend** icon in the address bar.

---

## 11. Admin Creation

1. Sign in as **Super Admin**.
2. Open the **Admins** tab in the sidebar.
3. Enter **Admin Name**, **Email**, and **Password**, then click **Create Admin Account**.
4. You can disable or re-enable any Admin account at any time using the **Disable / Enable** button. Disabled Admins are immediately blocked from logging in or scanning.

---

## 12. Super Admin Creation

Public registration for Super Admin is prohibited. To create the first Super Admin in Supabase:
1. Go to Supabase Dashboard → **Authentication** → **Users** → **Add User** → **Create New User**.
2. Enter your Super Admin email and password, check **Auto Confirm User**, and create the user.
3. Open **SQL Editor** and run Part A of `supabase/seed.sql` (replacing `superadmin@university.edu` with your email) to insert the `SUPER_ADMIN` profile row.

---

## 13. Database Security

* **Row Level Security (RLS)** is enabled on all 6 tables (`supabase/policies.sql`).
* **Student Lookup Isolation**: Anonymous students cannot `SELECT` from `public.students` or `public.attendance_records`. They can only execute the `get_student_attendance_public(p_student_number)` RPC, which validates `^PS/[0-9]{4}/[0-9]{3,}$` and returns only that student's attendance dates and hours.
* **Atomic Scanning RPC**: `record_attendance_scan` runs inside PostgreSQL with `FOR UPDATE` row locking and a `UNIQUE (session_id, student_id)` constraint, preventing race conditions even when multiple Admins scan simultaneously.

---

## 14. QR Scanner Configuration

* Generate Student ID QR codes containing **plain text only**:
  ```text
  PS/2023/174
  ```
* The scanner uses the browser's hardware-accelerated `BarcodeDetector` API where available and automatically lazy-loads `jsQR` as a fallback.
* Use the **Mode** selector (`Auto (Entry → Leaving)`, `Entry Only`, `Leaving Only`) on the scanner screen to control entry/leaving behavior.

---

## 15. Troubleshooting

* **Camera Permission Denied**: Tap the lock/site-settings icon in your mobile browser's address bar, set **Camera** to **Allow**, and reload the page.
* **Camera Not Starting on Local Network IP**: Browsers require `https://` or `http://localhost` for `navigator.mediaDevices.getUserMedia`. Deploy to Vercel for automatic HTTPS on mobile devices.
* **Duplicate Entry Warning (`Already Checked In`)**: A 15-second cooldown prevents accidental double scans when a student holds their card in front of the lens. To immediately record a leaving scan during testing, click **Mark Leaving Attendance Instead** or switch the scanner mode to **Leaving Only**.
