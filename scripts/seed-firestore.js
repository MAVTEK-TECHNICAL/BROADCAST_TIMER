/**
 * seed-firestore.js
 *
 * One-time setup script. Run ONCE after deploying security rules to populate
 * the initial Firestore documents for all 5 groups and the parser registry.
 *
 * Prerequisites:
 *   1. Firebase CLI installed:  npm install -g firebase-tools
 *   2. Logged in:               firebase login
 *   3. Project selected:        firebase use mavtek-broadcast-timer
 *   4. Admin SDK credentials:   set GOOGLE_APPLICATION_CREDENTIALS env var
 *      OR run via:              node scripts/seed-firestore.js
 *      from a machine where `firebase login` has been run (ADC credentials).
 *
 * Usage:
 *   cd /path/to/BROADCAST_TIMER
 *   npm install firebase-admin   (or: cd scripts && npm init -y && npm i firebase-admin)
 *   node scripts/seed-firestore.js
 *
 * Safe to run again — all writes use { merge: true } so existing data is preserved.
 */

const admin = require('firebase-admin');

// ── Use Application Default Credentials (set by firebase login or GOOGLE_APPLICATION_CREDENTIALS)
admin.initializeApp({
  projectId: 'mavtek-broadcast-timer'
});

const db  = admin.firestore();
const now = admin.firestore.FieldValue.serverTimestamp();

// ─────────────────────────────────────────────────────────────────────────────
// Group definitions
// ─────────────────────────────────────────────────────────────────────────────
const GROUPS = [
  {
    id:   'champion-data',
    name: 'Champion Data',
    assignedParsers: {
      callsheet: ['parser-nep-callsheet', 'parser-cd-callsheet'],
      schedule:  ['parser-cd-schedule'],
      api:       []
    }
  },
  {
    id:   'nep',
    name: 'NEP',
    assignedParsers: {
      callsheet: ['parser-nep-callsheet'],
      schedule:  [],
      api:       []
    }
  },
  {
    id:   'apac',
    name: 'APAC',
    assignedParsers: {
      callsheet: ['parser-nep-callsheet'],
      schedule:  [],
      api:       []
    }
  },
  {
    id:   'cms',
    name: 'CMS',
    assignedParsers: {
      callsheet: [],
      schedule:  [],
      api:       ['parser-cms-api']   // inactive until Phase 6
    }
  },
  {
    id:   'mavtek',
    name: 'MAVTEK',
    assignedParsers: {
      callsheet: ['parser-nep-callsheet'],
      schedule:  ['parser-cd-schedule'],
      api:       []
    }
  }
];

// Default group display settings — admins can change these via the app
const DEFAULT_GROUP_SETTINGS = {
  brandColor:         '#ff6b35',
  showClockSeconds:   false,
  opTimerDivider:     false,
  teamDisplayMode:    'name',
  logoSizeMode:       'medium',
  logoBgMode:         false
};

// ─────────────────────────────────────────────────────────────────────────────
// Parser definitions
// ─────────────────────────────────────────────────────────────────────────────
const PARSERS = [
  {
    id:          'parser-nep-callsheet',
    name:        'NEP Callsheet',
    type:        'callsheet',
    formatKey:   'nep',
    description: 'NEP standard callsheet format — accepts .xlsx, .xls, .pdf',
    fileAccept:  '.xlsx,.xls,.pdf',
    isActive:    true,
    apiConfig:   null
  },
  {
    id:          'parser-cd-callsheet',
    name:        'Champion Data Callsheet',
    type:        'callsheet',
    formatKey:   'champion-data-cs',
    description: 'Champion Data callsheet format — accepts .xlsx, .pdf',
    fileAccept:  '.xlsx,.pdf',
    isActive:    true,
    apiConfig:   null
  },
  {
    id:          'parser-cd-schedule',
    name:        'Champion Data Schedule',
    type:        'schedule',
    formatKey:   'champion-data',
    description: 'Champion Data schedule format — accepts .pdf (+ TSV paste fallback)',
    fileAccept:  '.pdf',
    isActive:    true,
    apiConfig:   null
  },
  {
    id:          'parser-cms-api',
    name:        'CMS API Integration',
    type:        'api',
    formatKey:   'cms-api',
    description: 'CMS schedule data via REST poll and/or inbound webhook (Phase 6)',
    fileAccept:  null,
    isActive:    false,   // activate when CMS integration is ready
    apiConfig: {
      // Pattern A — outbound poll
      endpoint:       null,
      authType:       null,
      authConfig:     null,
      pollInterval:   null,
      // Pattern B — inbound webhook
      webhookEnabled: false,
      // Shared field mappings (fill in when CMS API spec is known)
      fieldMappings: {
        home:       null,
        away:       null,
        isoDate:    null,
        location:   null,
        sport:      null,
        matchStart: null
      }
    }
  }
];

// ─────────────────────────────────────────────────────────────────────────────
// Seed function
// ─────────────────────────────────────────────────────────────────────────────
async function seed() {
  console.log('\n🌱  Seeding Firestore for mavtek-broadcast-timer...\n');

  // ── Groups ──────────────────────────────────────────────────────────────────
  console.log('📁  Writing group documents...');
  for (const group of GROUPS) {
    const { id, name, assignedParsers } = group;
    await db.doc(`groups/${id}`).set({
      name,
      settings:        DEFAULT_GROUP_SETTINGS,
      assignedParsers,
      createdAt:       now
    }, { merge: true });
    console.log(`    ✓  groups/${id}  (${name})`);
  }

  // ── Parsers ─────────────────────────────────────────────────────────────────
  console.log('\n📋  Writing parser documents...');
  for (const parser of PARSERS) {
    const { id, ...data } = parser;
    await db.doc(`parsers/${id}`).set({ ...data, createdAt: now }, { merge: true });
    console.log(`    ✓  parsers/${id}  (${data.name})`);
  }

  // ── Instructions for the Super Admin document ────────────────────────────────
  console.log('\n⚠️   MANUAL STEP REQUIRED — Super Admin setup:');
  console.log('    The superAdmins document cannot be seeded by this script');
  console.log('    because it requires your own Firebase UID.');
  console.log('');
  console.log('    1. Find your UID:');
  console.log('       Firebase Console → Authentication → Users → copy your UID');
  console.log('');
  console.log('    2. In Firestore Console, create this document manually:');
  console.log('       Collection: superAdmins');
  console.log('       Document ID: <your-uid>');
  console.log('       Fields:');
  console.log('         email:          (your email address)');
  console.log('         addedAt:        (current timestamp)');
  console.log('         groupOverrides: [] (empty array)');
  console.log('');
  console.log('    Once this document exists, you will have Super Admin access');
  console.log('    in the app and can use the Super Admin panel to manage everything else.');
  console.log('');
  console.log('✅  Seed complete.\n');

  process.exit(0);
}

seed().catch(err => {
  console.error('❌  Seed failed:', err);
  process.exit(1);
});
