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
// listAllUsers  (super-admin only)
//
// Returns all Firebase Auth accounts joined with their Firestore profile data.
// Used to populate the ALL USERS tab in the admin panel so super-admins can
// spot and assign unattached accounts.
//
// Input:  (none)
// Output: { users: [...], groups: [...] }
// ─────────────────────────────────────────────────────────────────────────────
exports.listAllUsers = onCall(async (request) => {
  const callerUid = request.auth?.uid;
  if (!callerUid) throw new HttpsError('unauthenticated', 'Sign in required.');

  const superSnap = await db.doc(`superAdmins/${callerUid}`).get();
  if (!superSnap.exists) throw new HttpsError('permission-denied', 'Super admin required.');

  // Fetch all auth users + all profiles + all group names + super-admins in parallel
  const [listResult, profilesSnap, groupsSnap, superAdminsSnap] = await Promise.all([
    admin.auth().listUsers(1000),
    db.collection('userProfiles').get(),
    db.collection('groups').get(),
    db.collection('superAdmins').get()
  ]);

  // Build lookup maps
  const profileMap    = {};
  const superAdminMap = {};
  profilesSnap.docs.forEach(d    => { profileMap[d.id]    = d.data(); });
  superAdminsSnap.docs.forEach(d => { superAdminMap[d.id] = true; });

  const groups = groupsSnap.docs
    .map(d => ({ id: d.id, name: d.data().name || d.id }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const users = listResult.users.map(authUser => {
    const profile    = profileMap[authUser.uid] || null;
    const isSuperAdm = superAdminMap[authUser.uid] || false;
    return {
      uid:            authUser.uid,
      email:          authUser.email || '',
      displayName:    authUser.displayName || profile?.displayName || '',
      groupId:        isSuperAdm ? null : (profile?.groupId || null),
      role:           isSuperAdm ? 'super-admin' : (profile?.role || null),
      selfRegistered: profile?.selfRegistered || false,
      hasProfile:     !!profile,
      isSuperAdmin:   isSuperAdm,
      createdAt:      authUser.metadata.creationTime   || null,
      lastSignIn:     authUser.metadata.lastSignInTime || null
    };
  });

  // Sort: super-admins first, then unassigned, then alphabetical by email
  users.sort((a, b) => {
    if (a.isSuperAdmin && !b.isSuperAdmin) return -1;
    if (!a.isSuperAdmin && b.isSuperAdmin) return  1;
    if (!a.groupId && b.groupId)  return -1;
    if (a.groupId  && !b.groupId) return  1;
    return (a.email || '').localeCompare(b.email || '');
  });

  return { users, groups };
});

// ─────────────────────────────────────────────────────────────────────────────
// assignUserToGroup  (super-admin only)
//
// Assigns any existing Firebase Auth user to a group with a given role.
// Removes them from their previous group's members subcollection if different.
// Creates or overwrites their userProfiles doc.
//
// Input:  { targetUid: string, groupId: string, role: string }
// Output: { ok: true }
// ─────────────────────────────────────────────────────────────────────────────
exports.assignUserToGroup = onCall(async (request) => {
  const callerUid = request.auth?.uid;
  if (!callerUid) throw new HttpsError('unauthenticated', 'Sign in required.');

  const superSnap = await db.doc(`superAdmins/${callerUid}`).get();
  if (!superSnap.exists) throw new HttpsError('permission-denied', 'Super admin required.');

  const { targetUid, groupId, role } = request.data || {};
  const validRoles = ['view-operator', 'view-hub', 'admin'];
  if (!targetUid || !groupId || !validRoles.includes(role)) {
    throw new HttpsError('invalid-argument', 'targetUid, groupId, and a valid role are required.');
  }

  // Fetch auth user + current profile in parallel
  const [authUser, profSnap] = await Promise.all([
    admin.auth().getUser(targetUid),
    db.doc(`userProfiles/${targetUid}`).get()
  ]);

  const email       = authUser.email || '';
  const displayName = authUser.displayName || profSnap.data()?.displayName || '';
  const oldGroupId  = profSnap.exists ? profSnap.data().groupId : null;
  const now         = admin.firestore.FieldValue.serverTimestamp();
  const batch       = db.batch();

  // Remove from old group members if switching groups
  if (oldGroupId && oldGroupId !== groupId) {
    batch.delete(db.doc(`groups/${oldGroupId}/members/${targetUid}`));
  }

  // Add/update new group membership
  batch.set(db.doc(`groups/${groupId}/members/${targetUid}`), {
    email,
    displayName,
    role,
    addedAt:      now,
    addedBy:      callerUid,
    addedByEmail: request.auth.token?.email || ''
  });

  // Create/update userProfile
  batch.set(db.doc(`userProfiles/${targetUid}`), {
    email,
    displayName,
    groupId,
    role,
    assignedAt: now,
    assignedBy: callerUid
  }, { merge: true });

  await batch.commit();
  console.log(`assignUserToGroup: ${email} → ${groupId} as ${role} (by ${callerUid})`);
  return { ok: true };
});

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

  const { email, groupId, displayName, role: requestedRole } = request.data || {};
  if (!email || !groupId) {
    throw new HttpsError('invalid-argument', 'email and groupId are required.');
  }

  const validRoles = ['view-operator', 'view-hub', 'admin'];
  const role = validRoles.includes(requestedRole) ? requestedRole : 'view-operator';

  // Validate email format
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpsError('invalid-argument', 'Invalid email address.');
  }

  await assertGroupAdmin(callerUid, groupId);

  // Check the email isn't already registered
  let existingUser = null;
  try {
    existingUser = await admin.auth().getUserByEmail(email);
  } catch (e) {
    if (e.code !== 'auth/user-not-found') {
      console.error('createGroupUser: getUserByEmail error:', e.code, e.message);
      throw new HttpsError('internal', `Auth lookup failed: ${e.message}`);
    }
    // auth/user-not-found = good, email is available, continue
  }
  if (existingUser) {
    throw new HttpsError('already-exists', `${email} is already registered.`);
  }

  // Generate a human-friendly temporary password: 4 groups of 4 chars separated by dashes.
  // Avoids ambiguous characters (0/O, 1/I/l). Shown to the admin, who shares it with the
  // new user out-of-band (Slack, Teams, etc.). User is forced to change it on first login.
  const charset = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const tempPassword = [0,1,2,3].map(() =>
    Array.from({length:4}, () => charset[Math.floor(Math.random() * charset.length)]).join('')
  ).join('-');

  // Create the Firebase Auth user
  const createParams = {
    email,
    password:      tempPassword,
    emailVerified: false
  };
  if (displayName) createParams.displayName = displayName;
  const newUser = await admin.auth().createUser(createParams);

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
    displayName:  displayName || '',
    role,
    addedAt:      now,
    addedBy:      callerUid,
    addedByEmail: callerEmail
  });

  batch.set(db.doc(`userProfiles/${newUser.uid}`), {
    email,
    displayName:       displayName || '',
    groupId,
    role,
    createdAt:         now,
    createdBy:         callerUid,
    mustChangePassword: true,   // Forced password-change on first login
    preferences:       defaultPreferences
  });

  await batch.commit();

  // Return the temporary password to the calling admin so they can share it
  // with the new user out-of-band (Slack, Teams, etc.).
  // The user is forced to change it on their first login — see mustChangePassword flag.
  return { uid: newUser.uid, email, tempPassword };
});

// ─────────────────────────────────────────────────────────────────────────────
// removeGroupMember
//
// Removes a user from a group. Deletes their group membership doc and clears
// their groupId in userProfiles so they land in the unassigned state.
// Works even if the Firebase Auth account has been deleted (orphan cleanup).
//
// Input:  { targetUid: string, groupId: string }
// Output: { ok: true }
// ─────────────────────────────────────────────────────────────────────────────
exports.removeGroupMember = onCall(async (request) => {
  const callerUid = request.auth?.uid;
  if (!callerUid) throw new HttpsError('unauthenticated', 'Sign in required.');

  const { targetUid, groupId } = request.data || {};
  if (!targetUid || !groupId) {
    throw new HttpsError('invalid-argument', 'targetUid and groupId are required.');
  }

  await assertGroupAdmin(callerUid, groupId);

  // Prevent removing yourself
  if (targetUid === callerUid) {
    throw new HttpsError('failed-precondition', 'You cannot remove yourself from the group.');
  }

  const batch = db.batch();

  // Delete group membership
  batch.delete(db.doc(`groups/${groupId}/members/${targetUid}`));

  // Clear groupId on userProfile if it exists (won't fail if doc is missing)
  const profSnap = await db.doc(`userProfiles/${targetUid}`).get();
  if (profSnap.exists && profSnap.data().groupId === groupId) {
    batch.update(db.doc(`userProfiles/${targetUid}`), {
      groupId: null,
      role:    'admin'
    });
  }

  await batch.commit();
  console.log(`removeGroupMember: ${targetUid} removed from ${groupId} by ${callerUid}`);
  return { ok: true };
});

// ─────────────────────────────────────────────────────────────────────────────
// getPasswordResetLink
//
// Generates a fresh Firebase password-reset link for a group member on demand.
// The caller must be an admin of the group. Generates exactly one link per call.
//
// Separating link generation from user creation prevents the common failure mode
// where the httpsCallable retries on a slow network, causing a second
// generatePasswordResetLink call that invalidates the first link.
//
// Input:  { targetUid: string, groupId: string }
// Output: { resetLink: string }
// ─────────────────────────────────────────────────────────────────────────────
exports.getPasswordResetLink = onCall(async (request) => {
  const callerUid = request.auth?.uid;
  if (!callerUid) throw new HttpsError('unauthenticated', 'Sign in required.');

  const { targetUid, groupId } = request.data || {};
  if (!targetUid || !groupId) {
    throw new HttpsError('invalid-argument', 'targetUid and groupId are required.');
  }

  await assertGroupAdmin(callerUid, groupId);

  // Verify the target user is actually a member of this group
  const memberSnap = await db.doc(`groups/${groupId}/members/${targetUid}`).get();
  if (!memberSnap.exists) {
    throw new HttpsError('not-found', 'User is not a member of this group.');
  }

  // Look up their email from Firebase Auth
  let userRecord;
  try {
    userRecord = await admin.auth().getUser(targetUid);
  } catch (e) {
    throw new HttpsError('not-found', `Auth account not found: ${e.message}`);
  }

  if (!userRecord.email) {
    throw new HttpsError('failed-precondition', 'User has no email address in Firebase Auth.');
  }

  const resetLink = await admin.auth().generatePasswordResetLink(userRecord.email);
  console.log(`getPasswordResetLink: generated link for ${userRecord.email} by ${callerUid}`);
  return { resetLink };
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
