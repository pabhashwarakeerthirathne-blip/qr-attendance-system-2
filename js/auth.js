/**
 * js/auth.js
 * Authentication, Role Verification, and Super Admin Administrator Management.
 * Enforces database-backed role checks and prevents disabled admins from accessing the system.
 */

import {
  initSupabase,
  createEphemeralSupabaseClient,
  getDevDb,
  saveDevDb,
  getDevSessionUser,
  setDevSessionUser,
  recordAuditLog
} from './supabase.js';

/**
 * Fetches and validates the currently authenticated user profile from the database.
 * Never trusts client-side role flags without verifying against profiles table.
 */
export async function getCurrentProfile() {
  const client = initSupabase();
  if (client) {
    const { data: { session }, error: sessionErr } = await client.auth.getSession();
    if (sessionErr || !session?.user) return null;

    const { data: profile, error: profErr } = await client
      .from('profiles')
      .select('id, auth_user_id, role, name, email, status, created_at')
      .eq('auth_user_id', session.user.id)
      .maybeSingle();

    if (profErr || !profile) return null;

    if (profile.status !== 'ACTIVE') {
      await client.auth.signOut();
      return null;
    }

    return profile;
  }

  // Development sandbox verification
  return getDevSessionUser();
}

/**
 * Authenticates an Admin or Super Admin with email and password.
 * Enforces role check (e.g. prevents ADMIN from logging into SUPER_ADMIN portal).
 */
export async function loginWithEmailPassword(email, password, requiredRole = null) {
  const cleanEmail = (email || '').trim().toLowerCase();
  const cleanPassword = password || '';

  if (!cleanEmail || !cleanPassword) {
    throw new Error('Please enter both email address and password.');
  }

  const client = initSupabase();
  if (client) {
    const { data, error } = await client.auth.signInWithPassword({
      email: cleanEmail,
      password: cleanPassword
    });

    if (error || !data?.user) {
      throw new Error(error?.message || 'Invalid email or password.');
    }

    const { data: profile, error: profErr } = await client
      .from('profiles')
      .select('id, auth_user_id, role, name, email, status, created_at')
      .eq('auth_user_id', data.user.id)
      .maybeSingle();

    if (profErr || !profile) {
      await client.auth.signOut();
      throw new Error('Profile not found or unauthorized account.');
    }

    if (profile.status !== 'ACTIVE') {
      await client.auth.signOut();
      throw new Error('Account Disabled: Your administrator account has been disabled.');
    }

    if (requiredRole === 'SUPER_ADMIN' && profile.role !== 'SUPER_ADMIN') {
      await client.auth.signOut();
      throw new Error('Access Denied: Super Admin privileges are required to access System Management.');
    }

    return profile;
  }

  // Development test sandbox authentication
  const db = getDevDb();
  const profile = db.profiles.find(
    (p) => p.email.toLowerCase() === cleanEmail && p.password_hash === cleanPassword
  );

  if (!profile) {
    throw new Error('Invalid email or password.');
  }

  if (profile.status !== 'ACTIVE') {
    throw new Error('Account Disabled: Your administrator account has been disabled.');
  }

  if (requiredRole === 'SUPER_ADMIN' && profile.role !== 'SUPER_ADMIN') {
    throw new Error('Access Denied: Super Admin privileges are required to access System Management.');
  }

  setDevSessionUser(profile);
  return {
    id: profile.id,
    auth_user_id: profile.auth_user_id,
    role: profile.role,
    name: profile.name,
    email: profile.email,
    status: profile.status,
    created_at: profile.created_at
  };
}

/**
 * Logs out the current user.
 */
export async function logout() {
  const client = initSupabase();
  if (client) {
    await client.auth.signOut();
  }
  setDevSessionUser(null);
}

/**
 * Verifies that the current user holds one of the allowed roles.
 * Throws "Access Denied" if unauthorized (Test Scenario 10).
 */
export async function verifyRoleAccess(allowedRoles = ['SUPER_ADMIN']) {
  const profile = await getCurrentProfile();
  if (!profile) {
    throw new Error('Access Denied: Authentication required.');
  }
  if (profile.status !== 'ACTIVE') {
    throw new Error('Access Denied: Account is disabled.');
  }
  if (!allowedRoles.includes(profile.role)) {
    throw new Error('Access Denied: Insufficient permissions for this operation.');
  }
  return profile;
}

/**
 * Lists all administrator accounts (Super Admin only).
 */
export async function listAdmins() {
  await verifyRoleAccess(['SUPER_ADMIN']);

  const client = initSupabase();
  if (client) {
    const { data, error } = await client
      .from('profiles')
      .select('id, auth_user_id, role, name, email, status, created_at')
      .order('created_at', { ascending: false });

    if (error) throw new Error(error.message);
    return data || [];
  }

  const db = getDevDb();
  return db.profiles.map(({ password_hash, ...safeProfile }) => safeProfile);
}

/**
 * Creates a new Admin or Super Admin account (Super Admin only).
 */
export async function createAdminAccount({ name, email, password, role = 'ADMIN' }) {
  await verifyRoleAccess(['SUPER_ADMIN']);

  const cleanName = (name || '').trim();
  const cleanEmail = (email || '').trim().toLowerCase();
  const cleanPassword = password || '';
  const cleanRole = (role || 'ADMIN').trim().toUpperCase();

  if (cleanName.length < 2) {
    throw new Error('Admin Name must be at least 2 characters.');
  }
  if (!cleanEmail.includes('@')) {
    throw new Error('Please enter a valid email address.');
  }
  if (cleanPassword.length < 6) {
    throw new Error('Password must be at least 6 characters.');
  }
  if (!['ADMIN', 'SUPER_ADMIN'].includes(cleanRole)) {
    throw new Error('Invalid role specified. Must be ADMIN or SUPER_ADMIN.');
  }

  const client = initSupabase();
  if (client) {
    const tempClient = createEphemeralSupabaseClient();
    const { data: signUpData, error: signUpErr } = await tempClient.auth.signUp({
      email: cleanEmail,
      password: cleanPassword,
      options: {
        data: { name: cleanName, role: cleanRole }
      }
    });

    if (signUpErr || !signUpData?.user) {
      throw new Error(signUpErr?.message || 'Failed to create Admin auth user.');
    }

    // Note: Ensure your Supabase SQL function `register_admin_profile` 
    // accepts `p_role` if you store the role explicitly via RPC.
    const { data: rpcResult, error: rpcErr } = await client.rpc('register_admin_profile', {
      p_auth_user_id: signUpData.user.id,
      p_name: cleanName,
      p_email: cleanEmail,
      p_role: cleanRole
    });

    if (rpcErr) throw new Error(rpcErr.message);
    if (rpcResult && !rpcResult.success) {
      throw new Error(rpcResult.message || 'Failed to register Admin profile.');
    }

    return rpcResult;
  }

  // Development sandbox Admin creation
  const db = getDevDb();
  if (db.profiles.some((p) => p.email.toLowerCase() === cleanEmail)) {
    throw new Error(`An account with email ${cleanEmail} already exists.`);
  }

  const newProfile = {
    id: `prof-${Date.now()}`,
    auth_user_id: `usr-${Date.now()}`,
    role: cleanRole,
    name: cleanName,
    email: cleanEmail,
    password_hash: cleanPassword,
    status: 'ACTIVE',
    created_at: new Date().toISOString()
  };

  db.profiles.push(newProfile);
  saveDevDb(db);
  await recordAuditLog('Admin created', 'profiles', newProfile.id, {
    name: cleanName,
    email: cleanEmail,
    role: cleanRole
  });

  const { password_hash, ...safe } = newProfile;
  return safe;
}

/**
 * Enables or disables an Admin account (Super Admin only - Section 30).
 */
export async function updateAdminStatus(profileId, newStatus) {
  const caller = await verifyRoleAccess(['SUPER_ADMIN']);
  const normalizedStatus = newStatus === 'ACTIVE' ? 'ACTIVE' : 'DISABLED';

  if (caller.id === profileId && normalizedStatus === 'DISABLED') {
    throw new Error('You cannot disable your own active Super Admin account.');
  }

  const client = initSupabase();
  if (client) {
    const { data: target, error: fetchErr } = await client
      .from('profiles')
      .select('id, role, name, email')
      .eq('id', profileId)
      .maybeSingle();

    if (fetchErr || !target) throw new Error('Admin account not found.');
    if (target.role === 'SUPER_ADMIN' && normalizedStatus === 'DISABLED') {
      throw new Error('Super Admin accounts cannot be disabled here.');
    }

    const { error } = await client
      .from('profiles')
      .update({ status: normalizedStatus })
      .eq('id', profileId);

    if (error) throw new Error(error.message);

    await recordAuditLog(
      normalizedStatus === 'DISABLED' ? 'Admin disabled' : 'Admin enabled',
      'profiles',
      profileId,
      { email: target.email, status: normalizedStatus }
    );
    return true;
  }

  const db = getDevDb();
  const target = db.profiles.find((p) => p.id === profileId);
  if (!target) throw new Error('Admin account not found.');
  if (target.role === 'SUPER_ADMIN' && normalizedStatus === 'DISABLED') {
    throw new Error('Super Admin accounts cannot be disabled.');
  }

  target.status = normalizedStatus;
  saveDevDb(db);
  await recordAuditLog(
    normalizedStatus === 'DISABLED' ? 'Admin disabled' : 'Admin enabled',
    'profiles',
    profileId,
    { email: target.email, status: normalizedStatus }
  );
  return true;
}
