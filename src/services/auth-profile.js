async function authProfile(db, verified) {
  const user = await db("users").where({ auth_user_id: verified.user.id })
    .first("id", "auth_user_id", "group_id", "first_name", "family_name", "phone");
  if (!user) throw Object.assign(new Error("Verified account has no linked application profile"), { status: 409 });
  const group = await db("groups").where({ id: user.group_id }).first("id", "name", "slug");
  if (!group) throw Object.assign(new Error("Verified account has no linked group"), { status: 409 });
  return { success: true, user, group, session: {
    access_token: verified.access_token,
    refresh_token: verified.refresh_token,
    token_type: verified.token_type,
    expires_in: verified.expires_in,
    expires_at: verified.expires_at,
  } };
}

module.exports = authProfile;
