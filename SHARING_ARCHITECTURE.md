# Broadcast Timer — Group Sharing Architecture (v2)

> Supersedes v1. Core change: showfiles are replaced by a live group calendar.
> Each company has one shared calendar that admins publish to and users read from in real time.

---

## 1. Conceptual Model

```
Before (v1):  User → loads showfile → edits locally → auto-saves to their own Firestore path
After  (v2):  Admin → publishes matches → group calendar (live) ← all group members read
```

There are no personal showfiles anymore. The group calendar *is* the app state for all members.
Admins edit the calendar directly. View-only users see the same calendar, read-only.

---

## 2. Companies (Groups)

Five groups, created once by Super Admin via Firebase console.

| groupId             | Display Name  |
|---------------------|---------------|
| `champion-data`     | Champion Data |
| `nep`               | NEP           |
| `apac`              | APAC          |
| `cms`               | CMS           |
| `mavtek`            | MAVTEK        |

---

## 3. Roles

| Role                | Operator view | Hub view         | Edit matches | Publish/delete | Create users | Manage roles | View all groups |
|---------------------|---------------|------------------|--------------|----------------|--------------|--------------|-----------------|
| `view-operator`     | ✅ (read only) | ❌ Hidden        | ❌           | ❌             | ❌           | ❌           | ❌              |
| `view-hub`          | ✅ (read only) | ✅ (read only)   | ❌           | ❌             | ❌           | ❌           | ❌              |
| `admin`             | ✅ Full        | ✅ Full          | ✅           | ✅             | ✅ (own group)| ✅ (own group)| ❌             |
| `super-admin`       | ✅ Full        | ✅ Full          | ✅           | ✅             | ✅ (any group)| ✅ (any group)| ✅             |

**View-only details:**
- `view-operator`: The HUB button is hidden. App boots directly into Operator view.
  Match edit modals, add/remove timer buttons, and all editing controls are hidden.
- `view-hub`: Both OPERATOR and HUB buttons are visible. Hub view is the default on login (intended
  for server-based PC / control room monitor output). All editing controls are hidden in both views.
  The app auto-locks to hub view for this role.

---

## 4. Firestore Data Model

### 4a. Groups
```
groups/{groupId}
  name:       string           // "Champion Data"
  settings:   {
    // ── Group-wide display defaults (set by admin, apply to all members) ──
    brandColor:         string    // hex, default "#ff6b35"
    showClockSeconds:   boolean
    opTimerDivider:     boolean
    teamDisplayMode:    string
    logoSizeMode:       string
    logoBgMode:         boolean

    // ── NOT stored here: hubTz, hubCols, hubLogoSize, hubTimerDivider ──
    // These are per-user preferences because users work from different
    // hub locations and may have different match counts on their display.
    // See userProfiles/{uid}.preferences below.
  }
```
Group settings are editable by any admin. All connected clients receive updates via
`onSnapshot` on this document and apply the new values in real time.

### 4b. Group members (subcollection — queryable)
```
groups/{groupId}/members/{uid}
  email:    string
  role:     "admin" | "view-operator" | "view-hub"
  addedAt:  timestamp
  addedBy:  uid       // which admin created this user
```
Using a subcollection (not a map on the parent doc) allows admins to query/list members easily.

### 4c. Group calendar (individual match documents)
```
groups/{groupId}/calendar/{matchId}
  // Match identity (matches current matchMeta shape)
  label:           string        // "MATCH 1" or custom
  home:            string
  homeColour:      string
  away:            string
  awayColour:      string
  sport:           string
  isoDate:         string        // "YYYY-MM-DD"
  location:        string
  host:            string
  hub:             string
  truck:           string
  main:            string
  backup:          string
  arCtrl:          string
  arRend:          string
  droneCtrl:       string
  droneRend:       string
  tactic:          string
  tracker:         string
  customFields:    array
  homeTeamRef:     string | null
  awayTeamRef:     string | null
  timerNameAlign:  string
  matchTz:         string        // IANA tz
  sortIndex:       number        // for ordering within a day

  // Timers (inlined array, mirrors matchTimers[i])
  timers: [
    { id: string, name: string, core: boolean, timeStr: string|null, refTz: string|null }
  ]

  // Publishing metadata
  publishedBy:      uid
  publishedByEmail: string
  publishedAt:      timestamp
  lastEditedBy:     uid
  lastEditedByEmail:string
  lastEditedAt:     timestamp
```
Each match is its own document. Admins can add, edit, or delete individual matches.
All changes propagate to all connected group members in real time via `onSnapshot`.

### 4d. User profiles + personal preferences
```
userProfiles/{uid}
  email:     string
  groupId:   string
  role:      "admin" | "view-operator" | "view-hub"
  createdAt: timestamp
  createdBy: uid

  // ── Per-user hub display preferences ─────────────────────────────────
  // Each user can have a completely independent hub view.
  // Kienan (AHS/Sydney) and Nic (AHM/Melbourne) are both Champion Data
  // admins but work from different hubs, see different match counts,
  // and need different timezone displays.
  preferences: {
    hubTz:              string    // IANA tz — e.g. "Australia/Sydney" or "Australia/Melbourne"
    hubCols:            number    // 2 | 3 | 4 | 6 | 8
    hubLogoSize:        string
    hubTimerDivider:    boolean
    hubTeamDisplayMode: string
    hubRangeStart:      string | null   // ISO date filter start
    hubRangeEnd:        string | null   // ISO date filter end
    hubTodayMode:       boolean
    calendarDate:       string          // last-used calendar date
  }
```
`preferences` is written by each user themselves. The Cloud Function seeds sensible defaults on
user creation (Sydney tz, 3 cols, etc.). Users change these via the same settings UI as today —
the save just goes to `userProfiles/{uid}.preferences` instead of a showfile.

Written on user creation (by Cloud Function). Super admins query this collection to list all users.
Role field is also updated when an admin changes a user's role.

### 4e. Super admins
```
superAdmins/{uid}
  email:          string
  addedAt:        timestamp
  groupOverrides: string[]   // groups the super admin has self-assigned to as admin
```
The first record is seeded manually in the Firebase console. Only super admins can write here.

---

## 5. Firestore Security Rules

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    function uid()    { return request.auth.uid; }
    function authed() { return request.auth != null; }

    function isSuperAdmin() {
      return authed() &&
        exists(/databases/$(database)/documents/superAdmins/$(uid()));
    }

    function memberDoc(groupId) {
      return get(/databases/$(database)/documents/groups/$(groupId)/members/$(uid())).data;
    }

    function isMember(groupId) {
      return authed() &&
        exists(/databases/$(database)/documents/groups/$(groupId)/members/$(uid()));
    }

    function isAdmin(groupId) {
      return authed() && (
        (isMember(groupId) && memberDoc(groupId).role == 'admin') ||
        isSuperAdmin()
      );
    }

    // ── Group config ─────────────────────────────────────────
    match /groups/{groupId} {
      allow read:  if isMember(groupId) || isSuperAdmin();
      allow write: if isAdmin(groupId);   // admins can update settings
    }

    // ── Group members ─────────────────────────────────────────
    match /groups/{groupId}/members/{memberId} {
      allow read:   if isMember(groupId) || isSuperAdmin();
      allow create: if isAdmin(groupId);
      allow update: if isAdmin(groupId);
      allow delete: if isAdmin(groupId);
    }

    // ── Group calendar (matches) ──────────────────────────────
    match /groups/{groupId}/calendar/{matchId} {
      allow read:   if isMember(groupId) || isSuperAdmin();
      allow create: if isAdmin(groupId);
      allow update: if isAdmin(groupId);
      allow delete: if isAdmin(groupId);
    }

    // ── User profiles ─────────────────────────────────────────
    match /userProfiles/{targetUid} {
      allow read:  if uid() == targetUid || isSuperAdmin();

      // Users can update ONLY their own preferences sub-field — not role/groupId/email.
      // Full writes (role changes, new user creation) are Cloud Function / admin only.
      allow update: if uid() == targetUid &&
                       request.resource.data.diff(resource.data).affectedKeys()
                         .hasOnly(['preferences']);

      allow create, delete: if isSuperAdmin();

      // Admins can read any profile in their own group for the user management panel.
      // Done via a separate getDocs query in the app rather than a security rule
      // (rules can't query subcollections); the app filters client-side by groupId.
      allow read: if authed() && isMember(resource.data.groupId) &&
                     memberDoc(resource.data.groupId).role == 'admin';
    }

    // ── Super admin registry ──────────────────────────────────
    match /superAdmins/{targetUid} {
      allow read, write: if isSuperAdmin();
    }
  }
}
```

---

## 6. Firebase Cloud Function — `createGroupUser`

User creation requires the Firebase Admin SDK (server-side). This is the only Cloud Function
needed. Deploy via `firebase deploy --only functions`.

```javascript
// functions/index.js
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const crypto = require('crypto');
admin.initializeApp();

exports.createGroupUser = onCall({ enforceAppCheck: false }, async (request) => {
  const { email, groupId } = request.data;
  const callerUid = request.auth?.uid;

  if (!callerUid) throw new HttpsError('unauthenticated', 'Sign in required');
  if (!email || !groupId) throw new HttpsError('invalid-argument', 'email and groupId required');

  // Verify caller is admin of this group (or super admin)
  const db = admin.firestore();
  const [memberSnap, superSnap] = await Promise.all([
    db.doc(`groups/${groupId}/members/${callerUid}`).get(),
    db.doc(`superAdmins/${callerUid}`).get()
  ]);
  const isCallerAdmin = (memberSnap.exists && memberSnap.data().role === 'admin') || superSnap.exists;
  if (!isCallerAdmin) throw new HttpsError('permission-denied', 'Admin access required');

  // Check email not already registered
  try {
    await admin.auth().getUserByEmail(email);
    throw new HttpsError('already-exists', 'A user with this email already exists');
  } catch (e) {
    if (e.code !== 'auth/user-not-found') throw e;
  }

  // Generate a secure random temporary password (never shown to anyone)
  const tempPassword = crypto.randomBytes(20).toString('base64url');

  // Create Auth user
  const newUser = await admin.auth().createUser({
    email,
    password: tempPassword,
    emailVerified: false
  });

  // Write Firestore records
  const now = admin.firestore.FieldValue.serverTimestamp();
  const callerEmail = request.auth.token.email || '';
  await Promise.all([
    db.doc(`groups/${groupId}/members/${newUser.uid}`).set({
      email,
      role: 'view-operator',   // default — admin can upgrade after
      addedAt: now,
      addedBy: callerUid
    }),
    db.doc(`userProfiles/${newUser.uid}`).set({
      email,
      groupId,
      role: 'view-operator',
      createdAt: now,
      createdBy: callerUid,
      // Seed sensible defaults — user can change after first login
      preferences: {
        hubTz:              'Australia/Sydney',  // safe default; user updates to their hub
        hubCols:            3,
        hubLogoSize:        'medium',
        hubTimerDivider:    false,
        hubTeamDisplayMode: 'name',
        hubRangeStart:      null,
        hubRangeEnd:        null,
        hubTodayMode:       false,
        calendarDate:       null
      }
    })
  ]);

  // Send password reset email — this IS their "welcome, set your password" flow.
  // Firebase's password reset email template can be customised in the console to read:
  // "Welcome to Broadcast Timer — click below to set your password."
  await admin.auth().generatePasswordResetLink(email);
  // Trigger the actual send via the client after this function returns (see below)

  return { uid: newUser.uid, email };
});
```

**Client-side after function returns:**
```javascript
// After createGroupUser Cloud Function resolves successfully:
import { sendPasswordResetEmail } from 'firebase/auth';
await sendPasswordResetEmail(auth, email);
// Firebase sends the "set your password" email to the new user automatically.
```

**Customise the email template** in Firebase Console → Authentication → Templates → Password reset.
Change subject to "Welcome to Broadcast Timer — set your password" and body accordingly.

---

## 7. Admin: User Management UI

### "GROUP USERS" panel (new modal, accessible to admins + super admins)

Triggered by a new button in the sidebar footer: `⚙ MANAGE USERS`

```
┌────────────────────────────────────────────────────────────┐
│  GROUP: CHAMPION DATA USERS                            [×] │
│                                                            │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ ✉  New user email           [ADD USER TO GROUP]     │  │
│  └─────────────────────────────────────────────────────┘  │
│  A password setup email will be sent automatically.       │
│                                                            │
│  ── 4 MEMBERS ─────────────────────────────────────────── │
│                                                            │
│  nic@champdata.com       [ADMIN]      ← you (can't demote self) │
│  steve@champdata.com     [VIEW OP ▾]  ← role dropdown     │
│  jane@champdata.com      [VIEW HUB ▾]                     │
│  bob@champdata.com       [ADMIN ▾]                        │
│                                                            │
│  Role dropdown options:  VIEW OPERATOR / VIEW HUB / ADMIN  │
│                                                            │
│  (Super Admin sees all 5 groups as separate tabs)         │
└────────────────────────────────────────────────────────────┘
```

**Role change flow:**
- Admin selects a new role from the dropdown next to a user
- `setDoc` (merge) on both `groups/{groupId}/members/{uid}` and `userProfiles/{uid}`
- Change takes effect immediately; user sees updated view on next action
  (optionally: `onSnapshot` on their member doc forces a re-login or live role update)

**User creation flow:**
1. Admin types email → clicks ADD USER TO GROUP
2. Loading spinner on button while Cloud Function runs
3. On success: user appears in the list as VIEW OPERATOR with a `📧 INVITE SENT` badge
4. On error (already exists, invalid email, etc.): inline error message below input

---

## 8. Real-time Updates via `onSnapshot`

Replace one-time `getDocs` calls with persistent listeners:

```javascript
// Subscribe to group calendar — replaces all match state on each update
onSnapshot(
  query(collection(db, 'groups', groupId, 'calendar'), orderBy('isoDate'), orderBy('sortIndex')),
  (snap) => {
    // Rebuild matchMeta, matchTimers etc. from snap.docs
    applyCalendarSnapshot(snap.docs);
    renderAll();
  }
);

// Subscribe to group settings — brand color, op display prefs, etc.
// (NOT hub timezone — that's per-user, see below)
onSnapshot(doc(db, 'groups', groupId), (snap) => {
  applyGroupSettings(snap.data().settings);
});

// Load own preferences once on boot, then keep a live listener so
// changes made on another device propagate immediately.
onSnapshot(doc(db, 'userProfiles', uid), (snap) => {
  const prefs = snap.data()?.preferences || {};
  applyUserPreferences(prefs);   // sets hubTz, hubCols, hub range, etc.
});

// Subscribe to own member doc — live role changes
onSnapshot(doc(db, 'groups', groupId, 'members', uid), (snap) => {
  applyRoleChange(snap.data().role);
});
```

When an admin publishes a new match or edits an existing one, all connected users see it
immediately with no refresh required.

---

## 9. Admin: Calendar Edit Flow

Since there are no showfiles, admins edit the live calendar directly:

- **Add match**: Creates a new `groups/{groupId}/calendar/{newId}` document. All members see it.
- **Edit match**: Updates the existing document + sets `lastEditedBy/At`. Conflict policy: last write wins.
- **Delete match**: `deleteDoc` on the calendar document. Confirmation dialog required.
- **Reorder**: Update `sortIndex` values. Could be drag-to-reorder in the UI.

**Concurrent edit protection** (simple): Show `lastEditedByEmail` + timestamp in the match header
so admins are aware if someone else recently edited. Full locking is out of scope for v1.

---

## 10. View-Only: What Changes in the UI

### `view-operator`
```javascript
function applyRoleToUI(role) {
  if (role === 'view-operator') {
    document.getElementById('vtb-hub').style.display = 'none';  // hide HUB tab
    switchView('operator');
    disableAllEditControls();
  }
  if (role === 'view-hub') {
    switchView('hub');  // default to hub on login
    disableAllEditControls();
    // Both tabs remain visible
  }
}
function disableAllEditControls() {
  // Hide: add match button, match edit buttons, timer add/remove, all settings dropdowns
  // Show: timers, match info, team names — all in read-only display mode
}
```

### `view-hub`
- App boots into Hub view by default (ideal for control room monitor output)
- Operator tab is still accessible (for users who want to check timer times)
- Hub view itself is already largely display-only; match cards just lose the edit tap target

---

## 11. Settings Ownership

Settings split into two tiers: group-wide (set once by any admin, everyone sees the same value)
and per-user (each person controls their own display, synced via Firestore so it follows them
across devices).

### Group-wide (admin sets, all members inherit)
| Setting                   | Stored in                     | Notes                             |
|---------------------------|-------------------------------|-----------------------------------|
| Brand colour              | `groups/{groupId}.settings`   | Consistent identity across group  |
| Clock seconds on/off      | `groups/{groupId}.settings`   | Consistency for broadcast timing  |
| Op timer divider          | `groups/{groupId}.settings`   |                                   |
| Op team display mode      | `groups/{groupId}.settings`   |                                   |
| Logo background mode      | `groups/{groupId}.settings`   |                                   |
| Logo size mode (op)       | `groups/{groupId}.settings`   |                                   |

### Per-user (each user controls their own)
| Setting                   | Stored in                              | Notes                                              |
|---------------------------|----------------------------------------|----------------------------------------------------|
| Hub timezone              | `userProfiles/{uid}.preferences`       | Kienan (AHS/Sydney) ≠ Nic (AHM/Melbourne)         |
| Hub columns               | `userProfiles/{uid}.preferences`       | Kienan may have 2 matches; Nic may have 8          |
| Hub logo size             | `userProfiles/{uid}.preferences`       |                                                    |
| Hub timer divider         | `userProfiles/{uid}.preferences`       |                                                    |
| Hub team display mode     | `userProfiles/{uid}.preferences`       |                                                    |
| Calendar date filter      | `userProfiles/{uid}.preferences`       | Each user navigates their own date independently   |
| Hub date range (from/to)  | `userProfiles/{uid}.preferences`       | Filter matches shown in hub — user-specific        |
| Hub today/week mode       | `userProfiles/{uid}.preferences`       |                                                    |

### Not user-settable
| Setting        | How it's controlled              |
|----------------|----------------------------------|
| View mode      | Locked by role (`view-operator` → operator only, `view-hub` → hub default) |

**Preference load order on app boot:**
1. Load `userProfiles/{uid}.preferences` from Firestore
2. Fall back to group defaults if a preference field is missing (e.g. first login)
3. Subscribe to `groups/{groupId}` for live group-setting changes
4. Apply both layers — group settings overlay first, user preferences on top

---

## 12. New Firebase Imports Needed

Add to the existing `import` block:
```javascript
import { onSnapshot, where, writeBatch, arrayUnion }
  from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { getFunctions, httpsCallable }
  from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js';
import { sendPasswordResetEmail }
  from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';  // already imported
```

---

## 13. Migration from v1 (showfiles → group calendar)

For MAVTEK (the existing Firebase project):
1. Deploy the new Firestore security rules
2. Create `groups/mavtek` with the MAVTEK settings
3. Create `groups/mavtek/members/{uid}` for all existing MAVTEK users
4. Existing showfile data at `users/{uid}/showfiles/*` can be migrated via a one-time
   admin script: read each showfile, extract match slots, write each to `groups/{groupId}/calendar/{newId}`
5. Old `users/*/showfiles` collection can be left in place or deleted after migration

---

## 14. Parser & Integration Registry

### Background — what exists today

The app has two separate import systems, both already structured around a "preset" concept:

| System           | Current state                                                          |
|------------------|------------------------------------------------------------------------|
| Schedule parser  | `SCHED_PARSERS` JS object — one entry: `champion-data` (PDF + TSV)    |
| Callsheet parser | Single hardcoded handler labelled "NEP PRESET" (XLSX + PDF)           |

Both need to become Firestore-managed resources. Super Admin registers parsers centrally and
assigns which ones each group can use. The client reads its group's assigned parsers at boot
and shows only those options in the import UI.

---

### 14a. Firestore: Parser Registry

```
parsers/{parserId}
  name:        string     // "NEP Callsheet", "Champion Data Schedule", "CMS API"
  type:        "callsheet" | "schedule" | "api"
  formatKey:   string     // maps to the JS handler — e.g. "nep", "champion-data", "cms-api"
                          // The client SCHED_PARSERS / CS_PARSERS registries use this key
  description: string     // short human note, e.g. "NEP XLSX + PDF callsheet format"
  fileAccept:  string     // ".xlsx,.xls,.pdf"  |  ".pdf"  |  null (for API type)
  isActive:    boolean    // soft-disable without deleting
  createdAt:   timestamp

  // ── API integration fields (type === "api" only) ─────────────────
  // Leave null for file-based parsers. Supports both delivery patterns:
  //   Pattern A — outbound poll: we fetch from their endpoint on a schedule
  //   Pattern B — inbound webhook: they push to our Cloud Function URL
  // Both can be active simultaneously for the same parser (poll as safety net).
  apiConfig: {
    // Pattern A — poll
    endpoint:       string | null   // REST/GraphQL URL to fetch from
    authType:       "apiKey" | "bearer" | "oauth2" | "none" | null
    authConfig:     object | null   // { headerName } etc. — key itself in Secret Manager
    pollInterval:   number | null   // seconds; null = manual "FETCH" button only

    // Pattern B — webhook
    webhookEnabled: boolean         // true once CMS has been configured to push to our URL

    // Shared
    fieldMappings: {                // JSONPath strings into the API response body
      home:       string | null
      away:       string | null
      isoDate:    string | null
      location:   string | null
      sport:      string | null
      matchStart: string | null     // maps to timer timeStr
      // … extend as needed
    } | null
  } | null
```

**Initial parser documents to seed (via Firebase console or migration script):**

| parserId                    | name                        | type       | formatKey          |
|-----------------------------|-----------------------------|------------|--------------------|
| `parser-nep-callsheet`      | NEP Callsheet               | callsheet  | `nep`              |
| `parser-cd-callsheet`       | Champion Data Callsheet     | callsheet  | `champion-data-cs` |
| `parser-cd-schedule`        | Champion Data Schedule      | schedule   | `champion-data`    |
| `parser-cms-api` *(future)* | CMS API Integration         | api        | `cms-api`          |

---

### 14b. Group parser assignment

Parser assignments live directly on the group document, split by type for clear UI rendering:

```
groups/{groupId}
  ...
  assignedParsers: {
    callsheet: string[]   // e.g. ["parser-nep-callsheet", "parser-cd-callsheet"]
    schedule:  string[]   // e.g. ["parser-cd-schedule"]
    api:       string[]   // e.g. [] or ["parser-cms-api"] in future
  }
```

**Example assignments for the 5 companies:**

| Group          | Callsheet parsers                              | Schedule parsers           |
|----------------|------------------------------------------------|----------------------------|
| Champion Data  | NEP Callsheet + Champion Data Callsheet        | Champion Data Schedule     |
| NEP            | NEP Callsheet                                  | *(tbd)*                    |
| APAC           | *(tbd)*                                        | *(tbd)*                    |
| CMS            | *(tbd)*                                        | *(future API)*             |
| MAVTEK         | NEP Callsheet                                  | Champion Data Schedule     |

Champion Data gets both callsheet parsers because it operates as a sub-contractor to both
NEP and Gravity Media, so two different callsheet formats are used on different jobs.

---

### 14c. Firestore security rules for parsers

```javascript
// ── Parser registry ───────────────────────────────────────
match /parsers/{parserId} {
  allow read:  if authed();          // any logged-in user can read parser metadata
  allow write: if isSuperAdmin();    // only super admins register / modify parsers
}
```

Group members need to read parser metadata to render the correct import UI. Super Admin
controls the registry — no admin can register new parsers, only use assigned ones.

---

### 14d. Client-side: loading assigned parsers

```javascript
// Called during showApp() after role resolution
async function loadGroupParsers(groupId) {
  const groupSnap = await getDoc(doc(db, 'groups', groupId));
  const assigned  = groupSnap.data().assignedParsers || { callsheet: [], schedule: [], api: [] };

  // Fetch parser metadata for all assigned IDs in one batch
  const allIds = [...assigned.callsheet, ...assigned.schedule, ...assigned.api];
  const parserDocs = await Promise.all(allIds.map(id => getDoc(doc(db, 'parsers', id))));

  window._groupParsers = {
    callsheet: [],
    schedule:  [],
    api:       []
  };
  parserDocs.forEach((snap, i) => {
    if (!snap.exists()) return;
    const p = { id: snap.id, ...snap.data() };
    window._groupParsers[p.type].push(p);
  });

  // Rebuild the schedule preset buttons dynamically
  renderSchedulePresetButtons(window._groupParsers.schedule);
  // Rebuild callsheet preset buttons if more than one assigned
  renderCallsheetPresetButtons(window._groupParsers.callsheet);
}
```

The existing `SCHED_PARSERS` JS object becomes a **client-side handler map** keyed by `formatKey`.
Firestore just controls *which* of those handlers a group is allowed to see:

```javascript
// Client-side handler registry (code, not Firestore)
const SCHED_PARSERS = {
  'champion-data':    { label: 'CHAMPION DATA', fileAccept: '.pdf', handleFile: handleScheduleFile, ... },
  // future entries added here as new formats are built
};

const CS_PARSERS = {
  'nep':              { label: 'NEP PRESET',          handleFile: _csProcessFile,    fileAccept: '.xlsx,.xls,.pdf' },
  'champion-data-cs': { label: 'CHAMPION DATA',       handleFile: _csCdProcessFile,  fileAccept: '.xlsx,.pdf' },
  // future entries added here
};
```

The UI renders only the buttons for `formatKey` values that appear in `window._groupParsers`.

---

### 14e. Super Admin: Parser Management UI

A "PARSERS" tab in the Super Admin panel — two sections side by side:

```
┌──────────────────────────────────────────────────────────────────┐
│  ⚙ SUPER ADMIN — PARSERS                                    [×]  │
│  [GROUPS]  [USERS]  [PARSERS]                                    │
│                                                                  │
│  ── REGISTERED PARSERS ─────────────────────────────────────────│
│  NEP Callsheet          callsheet  nep            ● active       │
│  Champion Data Callsheet callsheet champion-data-cs ● active     │
│  Champion Data Schedule  schedule  champion-data   ● active      │
│  CMS API *(future)*      api       cms-api         ○ inactive    │
│                                                                  │
│  ── ASSIGN PARSERS TO GROUPS ───────────────────────────────────│
│                                                                  │
│  CHAMPION DATA                                                   │
│  Callsheet:  ☑ NEP Callsheet  ☑ Champion Data Callsheet         │
│  Schedule:   ☑ Champion Data Schedule                            │
│  API:        ☐ CMS API                                           │
│                                                                  │
│  NEP                                                             │
│  Callsheet:  ☑ NEP Callsheet  ☐ Champion Data Callsheet         │
│  Schedule:   ☐ Champion Data Schedule                            │
│  API:        ☐ CMS API                                           │
│                                                                  │
│  CMS                                                             │
│  Callsheet:  ☐ NEP Callsheet  ☐ Champion Data Callsheet         │
│  Schedule:   ☐ Champion Data Schedule                            │
│  API:        ☐ CMS API  ← tick this when CMS integration ready  │
│                                                                  │
│  [ … APAC … ]   [ … MAVTEK … ]                                  │
└──────────────────────────────────────────────────────────────────┘
```

Toggling a checkbox does an immediate `setDoc` merge on `groups/{groupId}.assignedParsers`.
No save button needed — each toggle is atomic. All connected group members receive the updated
parser list via their `onSnapshot` group listener and the import UI updates in real time.

---

### 14f. Schedule import UI — dynamic preset buttons

Currently the schedule import modal has hardcoded preset buttons in HTML:
```html
<button class="sched-preset-btn active" data-preset="champion-data">CHAMPION DATA</button>
```

This changes to dynamically rendered buttons based on `window._groupParsers.schedule`:
```javascript
function renderSchedulePresetButtons(scheduleParsers) {
  const container = document.getElementById('sched-presets');
  container.innerHTML = scheduleParsers.map((p, i) =>
    `<button class="sched-preset-btn${i===0?' active':''}"
             data-preset="${p.formatKey}"
             onclick="schedSelectPreset(this)">
       ${p.name.toUpperCase()}
     </button>`
  ).join('');
  // Auto-select the first available preset
  if (scheduleParsers.length > 0) schedSelectPreset(container.firstChild);
}
```

---

### 14g. Callsheet import UI — dynamic preset selector

The callsheet modal currently shows a hardcoded "NEP PRESET" badge. When a group has multiple
callsheet parsers, this becomes a selector:

```
┌──────────────────────────────────────────────────────┐
│  ⬇ CALLSHEET IMPORT                                  │
│  PARSER PRESET  [NEP PRESET ▾]                       │  ← dropdown if >1 assigned
│                 [CHAMPION DATA ▾]                    │     (badge if only 1)
│  Accepts .xlsx and .pdf                              │
└──────────────────────────────────────────────────────┘
```

If a group only has one callsheet parser assigned, the badge stays as a static label (as today).
If two or more are assigned, it becomes a `<select>` or tab selector.

---

### 14h. Future: API integration (`type === "api"`)

There are two delivery patterns an external system like CMS might use. Since we don't yet know
which CMS will use, the architecture supports both. They share the same Firestore calendar write
path — the difference is only in *how* the data arrives.

---

#### Pattern A — Outbound poll (we fetch from them)

The app or a Cloud Function periodically calls the CMS API to check for new/updated data.

**When to use:** CMS exposes a REST or GraphQL endpoint that we can query on demand.

```
App / Scheduler
     │
     │  onCall or scheduled trigger
     ▼
fetchGroupApiData (Cloud Function)
     │  1. Read apiConfig from Firestore (endpoint, mappings)
     │  2. Load credentials from Secret Manager
     │  3. GET/POST to CMS API
     │  4. Map response → matchMeta shape
     │  5. Batch-write to groups/{groupId}/calendar/*
     ▼
Firestore calendar  ──onSnapshot──▶  All connected clients update live
```

**`apiConfig` fields used:**
```
pollInterval:  number | null   // seconds between auto-fetches; null = manual "FETCH" button only
endpoint:      string          // CMS REST or GraphQL URL
authType:      "apiKey" | "bearer" | "oauth2" | "none"
```

**Trigger options (can have both):**
- **Manual**: Admin presses "FETCH FROM API" button → calls `fetchGroupApiData` once
- **Scheduled**: A Firebase scheduled function (cron) calls the same function every N minutes,
  controlled by `pollInterval` stored in the parser config. Super Admin can adjust the interval.

```javascript
// Cloud Function A: on-demand fetch (callable from client)
exports.fetchGroupApiData = onCall(async (request) => {
  const { groupId, parserId } = request.data;
  // 1. Verify caller is admin of groupId
  // 2. Load parser apiConfig from Firestore
  // 3. Load API credentials from Secret Manager (never touches the client)
  // 4. Fetch from external endpoint
  // 5. Map fields using apiConfig.fieldMappings
  // 6. writeBatch → groups/{groupId}/calendar/*
  // 7. Return { matchesImported: n, fetchedAt: ISO }
});

// Cloud Function B: scheduled auto-poll (runs server-side, no client needed)
exports.pollApiSources = onSchedule('every 5 minutes', async () => {
  // Query all parsers where type=="api" and pollInterval != null
  // For each, check if pollInterval has elapsed since last fetch
  // Call the same fetch logic as above
  // Update parser doc: lastFetchedAt, lastFetchStatus
});
```

---

#### Pattern B — Inbound webhook (they push to us)

CMS sends data to a URL we provide whenever their schedule changes. No polling needed —
updates arrive as they happen.

**When to use:** CMS can be configured to POST a payload to an HTTPS endpoint on each
schedule change, game creation, or status update.

```
CMS system
     │
     │  POST to our webhook URL (with HMAC signature or shared secret)
     ▼
receiveApiWebhook (Cloud Function — HTTPS endpoint, not callable)
     │  1. Verify signature / shared secret from Secret Manager
     │  2. Parse payload → matchMeta shape using parser fieldMappings
     │  3. Identify groupId from payload or URL parameter
     │  4. Batch-write to groups/{groupId}/calendar/*
     ▼
Firestore calendar  ──onSnapshot──▶  All connected clients update live
```

**`apiConfig` fields used:**
```
webhookSecret:  null   // value stored in Secret Manager, not here
                       // Super Admin registers the secret via Firebase console
fieldMappings:  { ... }  // same shape as Pattern A
```

**Our webhook URL format:**
```
https://{region}-{projectId}.cloudfunctions.net/receiveApiWebhook?groupId=cms&parserId=parser-cms-api
```
This URL is what you give to CMS to configure in their system.

```javascript
// Cloud Function: inbound webhook receiver (public HTTPS, not callable)
exports.receiveApiWebhook = onRequest(async (req, res) => {
  // 1. Extract groupId + parserId from query params
  // 2. Load parser config from Firestore
  // 3. Verify HMAC signature using secret from Secret Manager
  //    → Reject with 401 if invalid (prevents spoofed pushes)
  // 4. Parse req.body using parser fieldMappings
  // 5. Batch-write to groups/{groupId}/calendar/*
  // 6. Respond 200 OK (CMS expects a fast response)
});
```

**Webhook security:** The HMAC verification step is critical — without it, anyone who discovers
the URL could inject matches into a group's calendar. The shared secret lives only in Secret
Manager, never in Firestore or client code.

---

#### Comparison

| Factor              | Pattern A — Poll                         | Pattern B — Webhook                     |
|---------------------|------------------------------------------|-----------------------------------------|
| Latency             | Up to N minutes delay                    | Near real-time (seconds)                |
| Requires from CMS   | Queryable endpoint + auth                | Ability to configure outbound webhooks  |
| We control timing   | Yes                                      | No — CMS decides when to push           |
| Handles missed data | Yes — full re-fetch on each poll         | No — missed pushes are missed updates   |
| Complexity          | Lower                                    | Slightly higher (signature verification)|
| Best for            | CMS has a read API; schedule changes slowly | CMS has webhook support; real-time is important |

**Recommended default:** Start with Pattern A (poll). It's easier to test and requires no
configuration on CMS's end beyond sharing credentials. Add Pattern B alongside it later if
real-time delivery becomes a requirement — both can coexist for the same parser, with the
webhook providing live updates and the scheduled poll as a catch-up safety net.

---

#### Parser document — both patterns combined

```
parsers/parser-cms-api
  name:        "CMS API Integration"
  type:        "api"
  formatKey:   "cms-api"
  description: "CMS schedule data via REST poll + optional webhook"
  fileAccept:  null
  isActive:    false   // ← activate when ready

  apiConfig: {
    // Pattern A fields
    endpoint:      "https://api.cms-provider.com/v2/schedule"
    authType:      "apiKey"
    authConfig:    { headerName: "X-API-Key" }  // key value stored in Secret Manager
    pollInterval:  300   // seconds; null to disable scheduled polling

    // Pattern B fields
    webhookEnabled: false   // flip to true when CMS webhook is configured
    // webhookSecret stored in Secret Manager only, not here

    // Shared
    fieldMappings: {
      home:       "homeTeam.name"        // JSONPath into CMS response
      away:       "awayTeam.name"
      isoDate:    "matchDate"
      location:   "venue.name"
      sport:      "sport.code"
      matchStart: "scheduledKickoff"     // mapped to timer timeStr
    }
  }
```

Super Admin activates the integration by flipping `isActive: true` and configuring the secrets
in Firebase console — no code changes required.

---

## 15. Per-user Transient State

Several pieces of state currently live in the showfile but are genuinely per-user — they describe
how *this person* is looking at the calendar, not what's in it. In the new model they live in
`userProfiles/{uid}.preferences` (Firestore, so they sync across devices) or localStorage
(acceptable for purely UI-cosmetic choices).

### 15a. Dismissed operator slots (`opDismissedSlots`)

Currently a `Set` of `"slotIdx:isoDate"` strings saved inside the showfile. Dismissing a match
from the operator view currently hides it for *everyone sharing that showfile* — which is probably
a bug even in the old model.

**New behaviour:** Dismissals are per-user, per-match, per-date. Stored in
`userProfiles/{uid}.preferences.dismissedMatches` as an array of `"matchId:isoDate"` strings
(using the Firestore `matchId` instead of a slot index, since slot indices no longer exist).

```
userProfiles/{uid}.preferences
  dismissedMatches: ["abc123:2026-04-06", "def456:2026-04-06", ...]
```

On `applyCalendarSnapshot()`, the renderer skips any match whose `"id:isoDate"` is in
the dismissed set. The ✕ button in the operator view writes back to this array via
`setDoc` merge. This also means a user dismissing a match never affects what another user sees.

---

### 15b. Match hub timezone (`matchHubTzs`)

Currently an array where each slot can have an independent hub timezone, saved in the showfile.
In practice, a user at a given hub uses the *same* timezone for all their matches — the
per-slot override was rarely used.

**New behaviour:** All matches display with the user's own `preferences.hubTz`. The `matchHubTzs`
array is gone. `getTimerRefTz(t, mi)` is updated so that `refTz: 'hub'` resolves to
`window._myPrefs.hubTz` (the current user's preference) rather than an array lookup.

If the edge case of a single user needing per-match hub overrides resurfaces, it can be added
back as a per-match field on the calendar document later — but it's not worth the complexity now.

---

### 15c. Timer sort mode (`timerSortMode`)

Currently a boolean array, one entry per match slot, saved in the showfile. "Sort by time"
vs "sort by name" is a reasonable group-level default for a match — the admin who sets up the
match probably has an opinion about how timers should be ordered.

**New behaviour:** `timerSortMode` moves to a field on the match document itself:

```
groups/{groupId}/calendar/{matchId}
  timerSortMode: boolean    // true = sort by time, false = manual order
```

This means it travels with the match data and all users see the same timer order. A user can
still toggle it locally — the toggle writes back to the match document (admin only) or is
treated as a local UI-only state for view-only users.

---

### 15d. Calendar date filter & hub range

Already accounted for in `userProfiles/{uid}.preferences`:

```
preferences.calendarDate:  string | null   // the date the operator view is parked on
preferences.hubRangeStart: string | null   // hub view date filter
preferences.hubRangeEnd:   string | null
preferences.hubTodayMode:  boolean
```

These are written back to `userProfiles` on every change (debounced, same pattern as the
old `scheduleSave()`). The key difference from `scheduleSave` is that only the `preferences`
field is written — the match data is untouched by a date navigation action.

---

## 16. Callsheet Data in the Group Model

### Current behaviour

Callsheets are parsed and saved to `users/{uid}/callsheets/{jobId}` — private to the user who
imported them. The `jobId` key is derived from the parsed job number on the callsheet.

### Problem

In the group model, any admin should be able to import a callsheet for a match and have the
crew details visible to other admins (and relevant view-only users) working that same match.
Storing callsheets privately breaks this.

### New structure

Callsheets become a subcollection of the match they belong to:

```
groups/{groupId}/calendar/{matchId}/callsheets/{jobId}
  jobName:      string
  jobId:        string
  venue:        string
  state:        string
  controlUnit:  string
  date:         string
  onAir:        string | null    // "HH:MM"
  matchStart:   string | null    // "HH:MM"
  roles:        [{ role, company, name, personState, timeOn, ... }]

  importedAt:   timestamp
  importedBy:   uid
  importedByEmail: string
  parserId:     string    // which callsheet parser was used
```

Each match can have multiple callsheets (one per job number) — e.g. a match might have separate
callsheets for the NEP crew and the host broadcaster crew.

### Security rules

```javascript
match /groups/{groupId}/calendar/{matchId}/callsheets/{jobId} {
  allow read:   if isMember(groupId) || isSuperAdmin();
  allow write:  if isAdmin(groupId);    // only admins import callsheets
}
```

View-only users can *see* crew callsheet data for matches (useful for an Operator checking
who's on site) but cannot import or modify.

### `_csSaveToDb` update

```javascript
async function _csSaveToDb(parsed, matchId) {
  const key = (parsed.jobId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
  const ref  = doc(db, 'groups', groupId, 'calendar', matchId, 'callsheets', key);
  await setDoc(ref, {
    ...parsed,
    importedAt:       serverTimestamp(),
    importedBy:       _user.uid,
    importedByEmail:  _user.email,
    parserId:         window._activeCallsheetParser || 'nep'
  });
}
```

The `matchId` is now passed in from `opImportCallsheet(col)` which maps the column to the
Firestore match document ID rather than a slot index.

---

## 17. Offline Resilience & PWA

### Current state

The service worker (`sw.js`) is a basic cache-first strategy for the app shell, but the
`index.html` header *actively unregisters all service workers* on every load:

```javascript
// Lines 12–18 of index.html — intentionally nukes the SW
navigator.serviceWorker.getRegistrations().then(regs => {
  regs.forEach(reg => reg.unregister());
});
```

This means the app has no meaningful offline capability today. For a broadcast environment
where a venue's internet connection can drop at exactly the wrong moment, this should be
addressed before the group-calendar model goes live.

### Plan

**Step 1 — Enable Firebase offline persistence.**
Firestore's SDK has built-in IndexedDB caching. Adding one line at initialisation means all
`onSnapshot` listeners automatically serve from the local cache when offline, and all writes
are queued and replayed when connectivity returns:

```javascript
import { enableIndexedDbPersistence } from
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// After const db = getFirestore(app):
enableIndexedDbPersistence(db).catch(err => {
  if (err.code === 'failed-precondition') {
    // Multiple tabs open — persistence only works in one tab at a time
    console.warn('Offline persistence disabled: multiple tabs open');
  } else if (err.code === 'unimplemented') {
    // Browser doesn't support IndexedDB (very rare)
    console.warn('Offline persistence not supported in this browser');
  }
});
```

With this enabled: when a user at a venue loses internet, their group calendar continues to
display and countdown timers keep running. Any match edits made offline are queued and
written to Firestore once connectivity returns.

**Step 2 — Restore the service worker for app shell caching.**
Remove the SW unregistration block from `index.html`. Update `sw.js` to cache only the app
shell (HTML, fonts) — not Firebase requests (those are handled by Firestore's own persistence).

**Step 3 — Connection state indicator.**
A small indicator in the top bar to show the user their connectivity state:

```
● LIVE        ← green, onSnapshot receiving updates
◌ OFFLINE     ← amber, running from cache, writes queued
✕ ERROR       ← red, something wrong with the Firestore connection
```

Firebase provides `onSnapshotsInSync` and network status events to power this.

### What works offline

| Feature                         | Offline behaviour                                    |
|---------------------------------|------------------------------------------------------|
| View group calendar             | ✅ Served from IndexedDB cache                       |
| Timer countdowns                | ✅ `targetUTC` values are cached — JS timer runs     |
| Edit a match                    | ✅ Write queued, syncs when reconnected              |
| Add/delete a match              | ✅ Write queued                                      |
| Import callsheet                | ✅ Write queued                                      |
| Import schedule (PDF/XLSX)      | ✅ File parsing is local, write queued               |
| User creation (Cloud Function)  | ❌ Requires network — show error gracefully          |
| API parser fetch/webhook        | ❌ Requires network — show "last synced at" timestamp|

---

## 18. Calendar Snapshot → Slot-Array Rendering Bridge

The existing renderer (`renderAll`, `renderHubGrid`) is built around flat arrays indexed 0–n:
`matchMeta[i]`, `matchTimers[i]`, `matchVisible[i]`, `matchEnabled[i]`, `matchTzs[i]`.

The new model is a collection of Firestore documents with no inherent slot indices.
The bridge function `applyCalendarSnapshot()` converts one to the other on every snapshot event.

```javascript
function applyCalendarSnapshot(docs) {
  // 1. Reset all arrays to empty/default
  matchMeta     = Array.from({length: MAX_MATCHES}, (_, i) => _defMeta(i));
  matchTimers   = Array.from({length: MAX_MATCHES}, () => _defTimers());
  matchVisible  = Array(MAX_MATCHES).fill(false);
  matchEnabled  = Array(MAX_MATCHES).fill(false);
  matchTzs      = Array(MAX_MATCHES).fill('Australia/Sydney');
  timerSortMode = Array(MAX_MATCHES).fill(false);

  // Also maintain a lookup: slotIndex → matchId (for writes)
  window._slotToMatchId = {};
  window._matchIdToSlot = {};

  // 2. Sort documents by isoDate, then sortIndex
  const sorted = docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => {
      if (a.isoDate < b.isoDate) return -1;
      if (a.isoDate > b.isoDate) return  1;
      return (a.sortIndex || 0) - (b.sortIndex || 0);
    });

  // 3. Assign each document to a slot index in order
  sorted.forEach((match, i) => {
    if (i >= MAX_MATCHES) return;
    window._slotToMatchId[i] = match.id;
    window._matchIdToSlot[match.id] = i;

    matchVisible[i]  = true;
    matchEnabled[i]  = true;
    matchTzs[i]      = match.matchTz || 'Australia/Sydney';
    timerSortMode[i] = !!match.timerSortMode;
    matchMeta[i]     = {
      ...match,
      label: match.label || `MATCH ${i + 1}`
    };
    matchTimers[i]   = (match.timers || []).map(t => ({
      ...t,
      targetUTC: t.timeStr
        ? localToUTC(t.timeStr, getTimerRefTz(t, i))
        : null
    }));
  });

  // 4. Re-render everything
  renderAll();
  if (viewMode === 'hub') renderHubGrid();
}
```

**All existing write paths** (`saveMatchEdit`, `addTimer`, `removeTimer`, `setTimerTime`, etc.)
need one change: instead of calling `scheduleSave()`, they call `saveMatchToGroup(slotIndex)`
which looks up `window._slotToMatchId[slotIndex]` and writes just that match document.

```javascript
async function saveMatchToGroup(i) {
  const matchId = window._slotToMatchId[i];
  if (!matchId) {
    // New match (add match button) — create a new document
    const ref = await addDoc(
      collection(db, 'groups', groupId, 'calendar'),
      buildMatchPayload(i)
    );
    window._slotToMatchId[i] = ref.id;
    window._matchIdToSlot[ref.id] = i;
    return;
  }
  await setDoc(
    doc(db, 'groups', groupId, 'calendar', matchId),
    buildMatchPayload(i),
    { merge: true }
  );
}

function buildMatchPayload(i) {
  return {
    ...matchMeta[i],
    matchTz:       matchTzs[i],
    timerSortMode: timerSortMode[i],
    timers:        matchTimers[i].map(t => ({
      id:       t.id,
      name:     t.name,
      core:     !!t.core,
      timeStr:  t.timeStr || null,
      refTz:    t.refTz   || null
    })),
    sortIndex:        i,
    lastEditedBy:     _user.uid,
    lastEditedByEmail: _user.email,
    lastEditedAt:     serverTimestamp()
  };
}
```

The `onSnapshot` callback will receive the write back almost immediately (Firestore's local
cache echoes it before the server confirms), so the UI doesn't visually flicker.

---

## 19. Firestore Read Patterns & Cost Management

### The concern

An `onSnapshot` on the full `groups/{groupId}/calendar` collection with 500 documents
triggers one read per document on initial load (500 reads) plus one read per changed document
on each update. Across 5 groups with active users, this is manageable but worth designing
consciously.

### Mitigations

**1. Date-window scoping (primary mitigation)**

Rather than listening to the entire calendar, scope the snapshot to a rolling window:

```javascript
const windowStart = subDays(today, 7);   // 7 days ago
const windowEnd   = addDays(today, 60);  // 60 days ahead

onSnapshot(
  query(
    collection(db, 'groups', groupId, 'calendar'),
    where('isoDate', '>=', windowStart.toISOString().slice(0, 10)),
    where('isoDate', '<=', windowEnd.toISOString().slice(0, 10)),
    orderBy('isoDate'),
    orderBy('sortIndex')
  ),
  applyCalendarSnapshot
);
```

A 67-day window covers a full broadcast season and limits the initial read to ~50–100 matches
in typical use, not 500.

When the user navigates the calendar past the window boundary, the window re-centres and a
new snapshot is started. A brief loading state is shown during the re-query.

**2. `lastSyncedAt` check for stale reads**

On app boot, before starting the snapshot, check `groups/{groupId}.lastCalendarUpdateAt`.
If the client's cached version matches, the snapshot still starts (for live updates) but the
initial render can use the IndexedDB cache immediately rather than waiting for the network.

**3. Separate snapshot for "today" priority**

Start two listeners:

```javascript
// Listener A — today only (fast, low-read, shown immediately)
onSnapshot(query(calendarRef, where('isoDate', '==', todayISO)), applyTodaySnapshot);

// Listener B — full window (starts in background, merges in when ready)
onSnapshot(query(calendarRef, where('isoDate', '>=', windowStart), ...), applyCalendarSnapshot);
```

This gives the user their day's matches in under 100ms, with the full calendar filling in
behind it. Useful for slow connections.

**4. Write coalescing**

The old `scheduleSave()` used a 1.5s debounce to avoid hammering Firestore during rapid
typing or timer adjustments. `saveMatchToGroup(i)` should use the same pattern:

```javascript
const _saveTimers = {};
function scheduleSaveMatch(i) {
  clearTimeout(_saveTimers[i]);
  _saveTimers[i] = setTimeout(() => saveMatchToGroup(i), 1500);
}
```

---

## 20. Implementation Order

Ordered by dependency. Items within a phase can be parallelised.

---

### Phase 1 — Foundation (nothing visible to users yet)

1. **Firestore setup** *(console + rules file)*
   - Deploy security rules (section 5)
   - Create `groups/{groupId}` documents for all 5 companies with `settings` defaults
   - Create `superAdmins/{uid}` for first super admin manually
   - Seed `parsers/*` documents (section 14a)

2. **Enable Firestore offline persistence** *(section 17)*
   - Add `enableIndexedDbPersistence(db)` call after `getFirestore()`
   - Remove the SW unregistration block from `index.html`
   - Restore SW to cache the app shell only

3. **Cloud Function deployment** *(section 6)*
   - Deploy `createGroupUser` function
   - Test user creation + password reset email flow end-to-end

---

### Phase 2 — Core group calendar (MAVTEK pilot — existing users only)

4. **Role resolution on login** *(section 10)*
   - `resolveUserRole()` in `showApp()` — reads `groups/{groupId}/members/{uid}`
   - `applyRoleToUI(role)` — hides/locks UI per role
   - Subscribe to own member doc for live role changes
   - Load `userProfiles/{uid}.preferences` — apply hub prefs (tz, cols, etc.)
   - Subscribe to group settings for live brand colour / op display changes

5. **Rendering bridge** *(section 18)*
   - `applyCalendarSnapshot(docs)` — maps Firestore docs → slot arrays
   - `buildMatchPayload(i)` — inverse: slot state → Firestore document shape
   - `saveMatchToGroup(i)` — replaces `scheduleSave()` for match writes
   - `scheduleSaveMatch(i)` — 1.5 s debounce wrapper

6. **Group calendar snapshot** *(section 19)*
   - Date-windowed `onSnapshot` on `groups/{groupId}/calendar`
   - "Today" priority listener starts first; full window fills in behind
   - Connection state indicator in top bar (LIVE / OFFLINE / ERROR)

7. **Admin calendar editing**
   - Wire add/edit/delete match → `saveMatchToGroup()` / `deleteDoc()`
   - Remove all showfile save/load/list logic (`sfColRef`, `sfDocRef`, `scheduleSave`,
     `refreshSfList`, `renderSfList`, `loadSf`, `confirmNewShowfile`, etc.)
   - `opDismissedSlots` now reads/writes to `userProfiles/{uid}.preferences.dismissedMatches`
   - `timerSortMode` toggle writes to the match document

---

### Phase 3 — User management & permissions

8. **Admin user management panel** (`GROUP USERS` modal, section 7)
   - Create user via Cloud Function → `sendPasswordResetEmail`
   - Role change dropdown → `setDoc` merge on member doc + `userProfiles`
   - Show "invite sent" badge on newly created users

9. **Super Admin panel** *(section 8)*
   - Groups tab: all 5 groups, member lists, take/release admin
   - Users tab: query `userProfiles` collection, show all users + roles
   - Parsers tab: toggle parser assignment per group (section 14e)

---

### Phase 4 — Parsers & callsheets

10. **Dynamic parser loading** *(sections 14d, 14f, 14g)*
    - `loadGroupParsers(groupId)` on login — reads assigned parsers from group doc
    - Render schedule preset buttons dynamically from `window._groupParsers.schedule`
    - Render callsheet preset selector dynamically from `window._groupParsers.callsheet`

11. **Callsheet group storage** *(section 16)*
    - Update `_csSaveToDb()` to write to `groups/{groupId}/calendar/{matchId}/callsheets/{jobId}`
    - Update `opImportCallsheet(col)` to pass Firestore `matchId` instead of slot index
    - Add callsheet read to `applyCalendarSnapshot()` or lazy-load on match expand

---

### Phase 5 — Rollout to remaining companies

12. **Onboard Champion Data, NEP, APAC, CMS**
    - Create their group documents, member subcollections, parser assignments
    - Super Admin creates first admin user per group via the panel
    - Each admin then creates their own team members

13. **Data migration** *(if needed for MAVTEK)*
    - One-time script: read `users/*/showfiles/*`, extract match slots,
      write to `groups/mavtek/calendar/*` preserving `isoDate` + `sortIndex`
    - Archive old `users/*/showfiles` collection (don't delete — keep as fallback)

---

### Phase 6 — API integrations *(deferred)*

14. **API integration — Pattern A (poll)** *(section 14h)*
    - Add `fetchGroupApiData` Cloud Function
    - Add scheduled auto-poll function
    - Add "FETCH FROM API" button to import UI for groups with API parsers assigned

15. **API integration — Pattern B (webhook)** *(section 14h)*
    - Add `receiveApiWebhook` Cloud Function
    - Configure CMS to push to the webhook URL
    - Activate by setting `webhookEnabled: true` on the parser document

---

### Dependency graph summary

```
Phase 1 (foundation)
  └─ Phase 2 (calendar + rendering bridge)   ← MAVTEK goes live here
       └─ Phase 3 (user management)
       └─ Phase 4 (parsers + callsheets)
            └─ Phase 5 (rollout)
                 └─ Phase 6 (API integrations, deferred)
```
