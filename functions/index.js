const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule }         = require('firebase-functions/v2/scheduler');
const admin                  = require('firebase-admin');
const crypto                 = require('crypto');

admin.initializeApp();
const db = admin.firestore();

// ─────────────────────────────────────────────────────────────────────────────
// Helper: verify the calling user is an admin of the given group,
// or is a super admin.
// ─────────────────────────────────────────────────────────────────────────────
async function assertGroupAdmin(callerUid, groupId) {
  const [memberSnap, superSnap] = await Promise.all([
    db.doc(`groups/${groupId}/members/${callerUid}`).get(),
    db.doc(`superAdmins/${callerUid}`).get()
  ]);
  const isAdmin  = memberSnap.exists && memberSnap.data().role === 'admin';
  const isSuper  = superSnap.exists;
  if (!isAdmin && !isSuper) {
    throw new HttpsError('permission-denied', 'Admin access required for this group.');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// createGroupUser
//
// Called by an admin to invite a new user to their group.
// Creates a Firebase Auth account, seeds Firestore, triggers password-reset
// email (which acts as the "welcome, set your password" flow).
//
// Input:  { email: string, groupId: string }
// Output: { uid: string, email: string }
// ─────────────────────────────────────────────────────────────────────────────
exports.createGroupUser = onCall(async (request) => {
  const callerUid = request.auth?.uid;
  if (!callerUid) throw new HttpsError('unauthenticated', 'Sign in required.');

  const { email, groupId } = request.data || {};
  if (!email || !groupId) {
    throw new HttpsError('invalid-argument', 'email and groupId are required.');
  }

  // Validate email format
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpsError('invalid-argument', 'Invalid email address.');
  }

  await assertGroupAdmin(callerUid, groupId);

  // Check the email isn't already registered
  try {
    await admin.auth().getUserByEmail(email);
    throw new HttpsError('already-exists', `${email} is already registered.`);
  } catch (e) {
    if (e.code !== 'auth/user-not-found') throw e;
  }

  // Generate a secure random temporary password — this is never shown to anyone.
  // The user sets their real password via the reset-email link.
  const tempPassword = crypto.randomBytes(24).toString('base64url');

  // Create the Firebase Auth user
  const newUser = await admin.auth().createUser({
    email,
    password: tempPassword,
    emailVerified: false
  });

  const now          = admin.firestore.FieldValue.serverTimestamp();
  const callerEmail  = request.auth.token?.email || '';

  // Default preferences seeded at creation — user can change after first login
  const defaultPreferences = {
    hubTz:              'Australia/Sydney',
    hubCols:            3,
    hubLogoSize:        'medium',
    hubTimerDivider:    false,
    hubTeamDisplayMode: 'name',
    hubRangeStart:      null,
    hubRangeEnd:        null,
    hubTodayMode:       false,
    calendarDate:       null,
    dismissedMatches:   []
  };

  // Write group membership + user profile in one batch
  const batch = db.batch();

  batch.set(db.doc(`groups/${groupId}/members/${newUser.uid}`), {
    email,
    role:     'view-operator',   // default — admin can promote after creation
    addedAt:  now,
    addedBy:  callerUid,
    addedByEmail: callerEmail
  });

  batch.set(db.doc(`userProfiles/${newUser.uid}`), {
    email,
    groupId,
    role:        'view-operator',
    createdAt:   now,
    createdBy:   callerUid,
    preferences: defaultPreferences
  });

  await batch.commit();

  // Send password-reset email — this is the user's "Welcome, set your password" email.
  // Customise the template in Firebase Console → Authentication → Templates → Password reset.
  await admin.auth().generatePasswordResetLink(email);
  // The actual send is triggered client-side via sendPasswordResetEmail() after this returns,
  // because the Admin SDK's generatePasswordResetLink() only returns the link — it doesn't
  // send the email. The client call uses the Firebase Auth REST endpoint which does send it.

  return { uid: newUser.uid, email };
});

// ─────────────────────────────────────────────────────────────────────────────
// updateUserRole
//
// Called by an admin to change a group member's role.
//
// Input:  { targetUid: string, groupId: string, newRole: string }
// Output: { ok: true }
// ─────────────────────────────────────────────────────────────────────────────
exports.updateUserRole = onCall(async (request) => {
  const callerUid = request.auth?.uid;
  if (!callerUid) throw new HttpsError('unauthenticated', 'Sign in required.');

  const { targetUid, groupId, newRole } = request.data || {};
  const validRoles = ['view-operator', 'view-hub', 'admin'];
  if (!targetUid || !groupId || !validRoles.includes(newRole)) {
    throw new HttpsError('invalid-argument', 'targetUid, groupId, and a valid newRole are required.');
  }

  await assertGroupAdmin(callerUid, groupId);

  // Prevent admins from demoting themselves
  if (targetUid === callerUid && newRole !== 'admin') {
    throw new HttpsError('failed-precondition', 'You cannot change your own admin role.');
  }

  // Verify the target user is actually in this group
  const memberSnap = await db.doc(`groups/${groupId}/members/${targetUid}`).get();
  if (!memberSnap.exists) {
    throw new HttpsError('not-found', 'User is not a member of this group.');
  }

  const batch = db.batch();
  batch.update(db.doc(`groups/${groupId}/members/${targetUid}`), { role: newRole });
  batch.update(db.doc(`userProfiles/${targetUid}`), { role: newRole });
  await batch.commit();

  return { ok: true };
});

// ─────────────────────────────────────────────────────────────────────────────
// superAdminTakeGroup
//
// Allows a super admin to self-assign as admin to any group.
//
// Input:  { groupId: string }
// Output: { ok: true }
// ─────────────────────────────────────────────────────────────────────────────
exports.superAdminTakeGroup = onCall(async (request) => {
  const callerUid = request.auth?.uid;
  if (!callerUid) throw new HttpsError('unauthenticated', 'Sign in required.');

  const superSnap = await db.doc(`superAdmins/${callerUid}`).get();
  if (!superSnap.exists) {
    throw new HttpsError('permission-denied', 'Super admin access required.');
  }

  const { groupId } = request.data || {};
  if (!groupId) throw new HttpsError('invalid-argument', 'groupId is required.');

  const callerEmail = request.auth.token?.email || '';
  const now         = admin.firestore.FieldValue.serverTimestamp();

  const batch = db.batch();

  // Add to group members as admin
  batch.set(db.doc(`groups/${groupId}/members/${callerUid}`), {
    email:    callerEmail,
    role:     'admin',
    addedAt:  now,
    addedBy:  callerUid,
    addedByEmail: callerEmail,
    isSuperAdminOverride: true
  }, { merge: true });

  // Record which groups this super admin has taken
  batch.update(db.doc(`superAdmins/${callerUid}`), {
    groupOverrides: admin.firestore.FieldValue.arrayUnion(groupId)
  });

  await batch.commit();
  return { ok: true };
});

// ─────────────────────────────────────────────────────────────────────────────
// superAdminReleaseGroup
//
// Removes a super admin's self-assigned membership from a group.
//
// Input:  { groupId: string }
// Output: { ok: true }
// ─────────────────────────────────────────────────────────────────────────────
exports.superAdminReleaseGroup = onCall(async (request) => {
  const callerUid = request.auth?.uid;
  if (!callerUid) throw new HttpsError('unauthenticated', 'Sign in required.');

  const superSnap = await db.doc(`superAdmins/${callerUid}`).get();
  if (!superSnap.exists) {
    throw new HttpsError('permission-denied', 'Super admin access required.');
  }

  const { groupId } = request.data || {};
  if (!groupId) throw new HttpsError('invalid-argument', 'groupId is required.');

  const batch = db.batch();
  batch.delete(db.doc(`groups/${groupId}/members/${callerUid}`));
  batch.update(db.doc(`superAdmins/${callerUid}`), {
    groupOverrides: admin.firestore.FieldValue.arrayRemove(groupId)
  });

  await batch.commit();
  return { ok: true };
});

// ─────────────────────────────────────────────────────────────────────────────
// fetchGroupApiData  (STUB — Phase 6)
//
// Manually triggered fetch from an external API for groups using API-type parsers.
// Full implementation deferred until CMS scope is confirmed.
//
// Input:  { groupId: string, parserId: string }
// Output: { matchesImported: number, fetchedAt: string }
// ─────────────────────────────────────────────────────────────────────────────
exports.fetchGroupApiData = onCall(async (request) => {
  const callerUid = request.auth?.uid;
  if (!callerUid) throw new HttpsError('unauthenticated', 'Sign in required.');

  const { groupId, parserId } = request.data || {};
  if (!groupId || !parserId) {
    throw new HttpsError('invalid-argument', 'groupId and parserId are required.');
  }

  await assertGroupAdmin(callerUid, groupId);

  // TODO (Phase 6): Load parser apiConfig, fetch credentials from Secret Manager,
  // call external endpoint, map fields, write to groups/{groupId}/calendar/*.
  throw new HttpsError('unimplemented', 'API integration not yet active for this group.');
});

// ─────────────────────────────────────────────────────────────────────────────
// pollApiSources  (STUB — Phase 6, scheduled)
//
// Runs every 5 minutes to auto-fetch from all active API parsers that have
// a pollInterval set. Deferred until CMS scope is confirmed.
// ─────────────────────────────────────────────────────────────────────────────
exports.pollApiSources = onSchedule('every 5 minutes', async () => {
  // TODO (Phase 6): Query parsers where type=="api" and pollInterval != null.
  // For each, check if pollInterval has elapsed since lastFetchedAt.
  // Call the same fetch logic as fetchGroupApiData.
  console.log('pollApiSources: stub — no active API parsers yet.');
});

// ─────────────────────────────────────────────────────────────────────────────
// receiveApiWebhook  (STUB — Phase 6, inbound HTTP)
//
// Receives pushed data from external systems (e.g. CMS webhook).
// Deferred until CMS scope is confirmed.
// ─────────────────────────────────────────────────────────────────────────────
const { onRequest } = require('firebase-functions/v2/https');

exports.receiveApiWebhook = onRequest(async (req, res) => {
  // TODO (Phase 6):
  // 1. Extract groupId + parserId from query params
  // 2. Verify HMAC signature using secret from Secret Manager
  // 3. Parse body using parser fieldMappings
  // 4. Batch-write to groups/{groupId}/calendar/*
  res.status(501).json({ error: 'Webhook integration not yet active.' });
});
