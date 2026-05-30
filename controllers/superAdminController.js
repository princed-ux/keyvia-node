import { pool } from "../db.js";
import { sendEmailNotification } from "../utils/emailService.js";

const tableExists = async (tableName) => {
  const result = await pool.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1 LIMIT 1`,
    [tableName],
  );
  return result.rows.length > 0;
};

const safeCount = async (query, params = []) => {
  try {
    const result = await pool.query(query, params);
    return parseInt(result.rows[0]?.count || 0);
  } catch {
    return 0;
  }
};

const safeQuery = async (query, params = []) => {
  try {
    const result = await pool.query(query, params);
    return result.rows;
  } catch {
    return [];
  }
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// =========================================================
// 1. DASHBOARD STATS
// =========================================================
export const getDashboardStats = async (req, res) => {
  try {
    const [
      userCounts,
      revenueRes,
      monthlyRevenueRes,
      listingStatusRes,
      pendingVerifRes,
      visitTotalRes,
      visitDailyRes,
      subscriptionRes,
      topPropsRes,
      activityRes,
      apmRes,
    ] = await Promise.all([
      safeQuery(`SELECT LOWER(role::text) AS role, COUNT(*)::int AS count FROM users GROUP BY LOWER(role::text)`),
      safeQuery(`SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE status IN ('success', 'successful', 'completed')`),
      safeQuery(`
        SELECT COALESCE(SUM(amount), 0) AS total FROM payments
        WHERE status IN ('success', 'successful', 'completed')
        AND created_at >= DATE_TRUNC('month', CURRENT_DATE)
      `),
      safeQuery(`
        SELECT
          COUNT(*) FILTER (WHERE status IN ('active', 'approved'))::int AS active,
          COUNT(*) FILTER (WHERE status = 'draft')::int AS draft,
          COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
          COUNT(*)::int AS total
        FROM listings
      `),
      safeQuery(`SELECT COUNT(*)::int AS count FROM users WHERE verification_status = 'pending'`),
      safeQuery(`SELECT COUNT(*)::int AS count FROM platform_visits`),
      safeQuery(`
        SELECT DATE(visited_at) AS date, COUNT(*)::int AS visitors
        FROM platform_visits
        WHERE visited_at > NOW() - INTERVAL '30 days'
        GROUP BY DATE(visited_at)
        ORDER BY date ASC
      `),
      safeQuery(`SELECT COUNT(*)::int AS count, COALESCE(SUM(amount), 0) AS total FROM subscription_payments WHERE status = 'active'`),
      safeQuery(`
        SELECT product_id, title, city, state, views_count
        FROM listings
        WHERE views_count IS NOT NULL AND views_count > 0
        ORDER BY views_count DESC
        LIMIT 10
      `),
      safeQuery(`
        SELECT u.name AS user_name, 'user_signup' AS action_type, u.role::text AS details,
               u.created_at AS created_at, 'success' AS status
        FROM users u
        ORDER BY u.created_at DESC LIMIT 8
      `),
      safeQuery(`SELECT * FROM apm_metrics ORDER BY timestamp DESC LIMIT 1`),
    ]);

    // User distribution
    const userDist = [];
    let totalUsers = 0;
    let totalAgents = 0;
    let totalOwners = 0;
    let totalBrokerages = 0;
    const userCountRows = userCounts?.rows || userCounts || [];
    for (const row of userCountRows) {
      const name = row.role.charAt(0).toUpperCase() + row.role.slice(1);
      const count = row.count;
      if (name !== 'Super_admin') {
        userDist.push({ name, value: count });
      }
      totalUsers += count;
      if (row.role.includes('agent')) totalAgents += count;
      if (row.role === 'owner') totalOwners += count;
      if (row.role.includes('brokerage')) totalBrokerages += count;
    }

    const totalRevenue = parseFloat(revenueRes?.[0]?.total || revenueRes?.rows?.[0]?.total || 0);
    const monthlyRevenue = parseFloat(monthlyRevenueRes?.[0]?.total || monthlyRevenueRes?.rows?.[0]?.total || 0);

    const listings = listingStatusRes?.[0] || listingStatusRes?.rows?.[0] || { active: 0, draft: 0, pending: 0, total: 0 };
    const activeListings = listings.active;
    const draftListings = listings.draft;
    const pendingListings = listings.pending;

    const pendingVerifications = parseInt(pendingVerifRes?.[0]?.count || pendingVerifRes?.rows?.[0]?.count || 0);

    // Visitors
    const totalVisitors = parseInt(visitTotalRes?.[0]?.count || visitTotalRes?.rows?.[0]?.count || 0);
    const visitorSeries = visitDailyRes.map((r) => ({
      name: r.date ? new Date(r.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '',
      visitors: r.visitors,
    }));

    // Build revenue series from actual monthly data
    const revenueMonthRes = await safeQuery(`
      SELECT DATE_TRUNC('month', created_at) AS month, COALESCE(SUM(amount), 0) AS amount
      FROM payments WHERE status IN ('success', 'successful', 'completed')
        AND created_at > NOW() - INTERVAL '12 months'
      GROUP BY DATE_TRUNC('month', created_at)
      ORDER BY month ASC
    `);
    const revenueSeries = revenueMonthRes.map((r) => ({
      name: MONTHS[new Date(r.month).getMonth()],
      amount: parseFloat(r.amount),
    }));
    if (revenueSeries.length === 0) {
      // Fallback empty series
      for (let i = 0; i < 6; i++) {
        const d = new Date();
        d.setMonth(d.getMonth() - (5 - i));
        revenueSeries.push({ name: MONTHS[d.getMonth()], amount: 0 });
      }
    }

    // Property pipeline
    const propPipelineRes = await safeQuery(`
      SELECT status, COUNT(*)::int AS value
      FROM listings GROUP BY status ORDER BY value DESC
    `);
    const statusLabels = { active: 'Active', approved: 'Active', draft: 'Draft', pending: 'Pending', rejected: 'Rejected' };
    const propertySeries = propPipelineRes.map((r) => ({
      name: statusLabels[r.status] || r.status,
      value: r.value,
      percent: listings.total > 0 ? Math.round((r.value / listings.total) * 100) : 0,
    }));

    // Subscriptions
    const subsRow = subscriptionRes?.[0] || {};
    const activeSubscriptions = parseInt(subsRow.count || 0);

    // Support tickets (safe: count where inquiry_type = 'support' or escalation)
    const supportTicketsRes = await safeQuery(`
      SELECT COUNT(*)::int AS count FROM listing_inquiries WHERE inquiry_type IN ('support', 'escalation', 'complaint')
    `);
    const openSupportTickets = parseInt(supportTicketsRes?.[0]?.count || 0);

    // System health
    const apmRow = apmRes?.[0] || {};
    const errorRate = parseFloat(apmRow.error_rate || 0);
    const systemHealth = Math.max(0, Math.min(100, Math.round(100 - errorRate * 100)));

    // Top properties
    const topPropsRows = topPropsRes?.rows || topPropsRes || [];
    const topProperties = Array.isArray(topPropsRows) ? topPropsRows.map((r) => ({
      id: r.product_id,
      title: r.title || 'Untitled',
      location: [r.city, r.state].filter(Boolean).join(', ') || 'No location',
      views_count: r.views_count || 0,
    })) : [];

    // Activity
    const activity = activityRes?.rows || activityRes || [];

    res.json({
      stats: {
        totalUsers,
        totalVisitors,
        totalAgents,
        totalOwners,
        totalBrokerages,
        totalRevenue,
        monthlyRevenue,
        activeListings,
        draftListings,
        pendingListings,
        pendingVerifications,
        openSupportTickets,
        activeSubscriptions,
        systemHealth,
        revenueSeries,
        visitorSeries,
        propertySeries,
        userDistribution: userDist,
      },
      activity,
      topProperties,
    });

  } catch (err) {
    console.error("Dashboard Stats Error:", err);
    res.status(500).json({ message: "Server error fetching stats" });
  }
};

// =========================================================
// 2. GET ALL USERS
// =========================================================
export const getAllUsers = async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const offset = (page - 1) * limit;
    const search = (req.query.search || "").trim();
    const role = (req.query.role || "").trim().toLowerCase();
    const status = (req.query.status || "").trim().toLowerCase();
    const includeAdmins = req.query.include_admins !== "false";

    let where = [];
    let params = [];
    let idx = 1;

    if (!includeAdmins) {
      where.push(`LOWER(u.role::text) NOT IN ('admin', 'super_admin')`);
    }

    if (search) {
      where.push(`(u.name ILIKE $${idx} OR u.email ILIKE $${idx} OR u.unique_id::text ILIKE $${idx})`);
      params.push(`%${search}%`);
      idx++;
    }

    if (role) {
      where.push(`LOWER(u.role::text) = $${idx}`);
      params.push(role);
      idx++;
    }

    if (status === "suspended") {
      where.push(`(u.is_banned = TRUE OR u.account_status = 'suspended')`);
    } else if (status === "flagged") {
      where.push(`COALESCE(r.cnt, 0) > 0`);
    } else if (status === "pending_review") {
      where.push(`(u.verification_status = 'pending' OR u.account_status = 'pending_review')`);
    } else if (status === "active") {
      where.push(`(u.is_banned IS NULL OR u.is_banned = FALSE) AND (u.account_status IS NULL OR u.account_status = 'active')`);
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

    const flaggedSubquery = `
      SELECT listing_owner_id, COUNT(*)::int AS cnt
      FROM listing_reports
      WHERE status = 'open'
      GROUP BY listing_owner_id
    `;

    const countResult = await pool.query(`
      SELECT COUNT(*)::int AS total
      FROM users u
      LEFT JOIN (${flaggedSubquery}) r ON r.listing_owner_id::text = u.unique_id::text
      ${whereClause}
    `, params);

    const total = countResult.rows[0]?.total || 0;

    const result = await pool.query(`
      SELECT
        u.unique_id, u.name, u.email, u.role, u.avatar_url,
        u.verification_status, u.is_banned, u.banned_until, u.ban_reason,
        u.risk_score, u.phone, u.created_at, u.last_active AS last_seen_at,
        u.account_status, u.suspension_until, u.suspension_reason,
        u.ai_risk_notes, u.is_flagged,
        COALESCE(r.cnt, 0)::int AS flagged_listings_count
      FROM users u
      LEFT JOIN (${flaggedSubquery}) r ON r.listing_owner_id::text = u.unique_id::text
      ${whereClause}
      ORDER BY u.created_at DESC
      LIMIT $${idx} OFFSET $${idx + 1}
    `, [...params, limit, offset]);

    const users = result.rows.map((u) => ({
      ...u,
      name: u.name || null,
      account_status: u.account_status ||
        (u.is_banned ? "suspended" : "active"),
      risk_score: u.risk_score ?? 0,
    }));

    const totalUsers = total;
    const activeUsers = await safeCount(`
      SELECT COUNT(*)::int FROM users u
      WHERE (u.is_banned IS NULL OR u.is_banned = FALSE)
        AND LOWER(u.role::text) NOT IN ('admin', 'super_admin')
    `);
    const suspendedUsers = await safeCount(`
      SELECT COUNT(*)::int FROM users u
      WHERE u.is_banned = TRUE
        AND LOWER(u.role::text) NOT IN ('admin', 'super_admin')
    `);
    const highRiskUsers = await safeCount(`
      SELECT COUNT(*)::int FROM users u
      WHERE (u.risk_score IS NOT NULL AND u.risk_score >= 70)
        AND LOWER(u.role::text) NOT IN ('admin', 'super_admin')
    `);
    const flaggedResult = await pool.query(`
      SELECT COUNT(DISTINCT u.unique_id)::int AS count
      FROM users u
      INNER JOIN (${flaggedSubquery}) r ON r.listing_owner_id::text = u.unique_id::text
      WHERE LOWER(u.role::text) NOT IN ('admin', 'super_admin')
    `);
    const flaggedUsers = flaggedResult.rows[0]?.count || 0;

    res.json({
      users,
      summary: { totalUsers, activeUsers, suspendedUsers, flaggedUsers, highRiskUsers },
      page,
      limit,
      total,
    });
  } catch (err) {
    console.error("Get All Users Error:", err);
    res.status(500).json({ message: "Server error fetching users" });
  }
};

// =========================================================
// 3. DELETE USER
// =========================================================
export const deleteUser = async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query("DELETE FROM users WHERE unique_id = $1 RETURNING *", [id]);
    if (result.rowCount === 0) return res.status(404).json({ message: "User not found" });
    res.json({ message: "User deleted successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Delete failed" });
  }
};

// =========================================================
// 4. BAN / UNBAN USER
// =========================================================
export const toggleBanUser = async (req, res) => {
  const { id } = req.params;
  const { is_banned, ban_reason } = req.body;

  try {
    await pool.query(
      "UPDATE users SET is_banned = $1, ban_reason = $2, updated_at = NOW() WHERE unique_id = $3",
      [is_banned, is_banned ? (ban_reason || null) : null, id]
    );
    res.json({ message: is_banned ? "User banned successfully." : "User unbanned successfully." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Action failed" });
  }
};

// =========================================================
// 4b. SUSPENSION / ENFORCEMENT
// =========================================================
export const suspensionUser = async (req, res) => {
  try {
    const { uniqueId } = req.params;
    const { action, reason, send_email } = req.body;
    const adminId = req.user?.unique_id;
    const adminName = req.user?.name || "Super Admin";

    if (!action) {
      return res.status(400).json({ error: "Action is required" });
    }

    const userResult = await pool.query(
      `SELECT * FROM users WHERE unique_id = $1`,
      [uniqueId],
    );
    if (userResult.rowCount === 0) {
      return res.status(404).json({ error: "User not found" });
    }
    const user = userResult.rows[0];

    let isBanned = false;
    let banReason = null;
    let bannedUntil = null;
    let suspensionUntil = null;
    let accountStatus = "active";
    let suspensionReason = null;
    let actionLabel = "";
    let duration = null;
    let riskDelta = 0;

    switch (action) {
      case "warning":
        actionLabel = "warning";
        riskDelta = 5;
        suspensionReason = reason;
        break;

      case "7_days":
        isBanned = true;
        banReason = reason;
        bannedUntil = new Date(Date.now() + 7 * 86400000);
        suspensionUntil = new Date(Date.now() + 7 * 86400000);
        accountStatus = "suspended";
        suspensionReason = reason;
        actionLabel = "suspend_7";
        duration = "7_days";
        riskDelta = 15;
        break;

      case "14_days":
        isBanned = true;
        banReason = reason;
        bannedUntil = new Date(Date.now() + 14 * 86400000);
        suspensionUntil = new Date(Date.now() + 14 * 86400000);
        accountStatus = "suspended";
        suspensionReason = reason;
        actionLabel = "suspend_14";
        duration = "14_days";
        riskDelta = 20;
        break;

      case "30_days":
        isBanned = true;
        banReason = reason;
        bannedUntil = new Date(Date.now() + 30 * 86400000);
        suspensionUntil = new Date(Date.now() + 30 * 86400000);
        accountStatus = "suspended";
        suspensionReason = reason;
        actionLabel = "suspend_30";
        duration = "30_days";
        riskDelta = 25;
        break;

      case "indefinite":
        isBanned = true;
        banReason = reason;
        accountStatus = "suspended";
        suspensionReason = reason;
        actionLabel = "suspend_indefinite";
        duration = "indefinite";
        riskDelta = 30;
        break;

      case "permanent":
        isBanned = true;
        banReason = reason;
        accountStatus = "suspended";
        suspensionReason = reason;
        actionLabel = "expel";
        duration = "permanent";
        riskDelta = 40;
        break;

      case "restore":
        actionLabel = "restore";
        riskDelta = -20;
        break;

      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }

    const updateResult = await pool.query(`
      UPDATE users SET
        is_banned = $1,
        ban_reason = $2,
        banned_until = $3,
        account_status = $4,
        suspension_until = $5,
        suspension_reason = $6,
        risk_score = GREATEST(0, LEAST(100, COALESCE(risk_score, 0) + $7)),
        updated_at = NOW()
      WHERE unique_id = $8
      RETURNING unique_id, name, email, role, avatar_url, verification_status,
        is_banned, banned_until, ban_reason, account_status,
        suspension_until, suspension_reason, risk_score,
        phone, created_at, last_active AS last_seen_at, is_flagged
    `, [
      isBanned, banReason, bannedUntil, accountStatus,
      suspensionUntil, suspensionReason, riskDelta, uniqueId,
    ]);

    await pool.query(`
      INSERT INTO user_enforcement_logs
        (target_user_id, action, reason, admin_id, admin_name, duration, send_email, details)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [
      uniqueId, actionLabel, reason, adminId, adminName,
      duration, send_email || false,
      JSON.stringify({ previousStatus: user.account_status }),
    ]);

    if (send_email) {
      const subjectMap = {
        warning: "Warning Notice — Keyvia",
        suspend_7: "Your Account Has Been Suspended (7 Days) — Keyvia",
        suspend_14: "Your Account Has Been Suspended (14 Days) — Keyvia",
        suspend_30: "Your Account Has Been Suspended (30 Days) — Keyvia",
        suspend_indefinite: "Your Account Has Been Suspended Indefinitely — Keyvia",
        expel: "Your Account Has Been Permanently Removed — Keyvia",
        restore: "Your Account Has Been Restored — Keyvia",
      };
      const subject = subjectMap[actionLabel] || "Account Update — Keyvia";
      const message = `Hello ${user.name || "User"},\n\n${reason || "An enforcement action has been applied to your account."}\n\nIf you have questions, please contact support.\n\n— Keyvia Team`;

      try {
        await sendEmailNotification(user.email, subject, message);
      } catch (_) {}
    }

    const flaggedRes = await pool.query(`
      SELECT COALESCE(COUNT(*), 0)::int AS cnt
      FROM listing_reports
      WHERE listing_owner_id::text = $1 AND status = 'open'
    `, [uniqueId]);

    const updatedUser = {
      ...updateResult.rows[0],
      flagged_listings_count: flaggedRes.rows[0]?.cnt || 0,
      risk_score: updateResult.rows[0]?.risk_score ?? 0,
    };

    res.json({
      message: `Enforcement action '${actionLabel}' applied successfully.`,
      user: updatedUser,
    });
  } catch (err) {
    console.error("Suspension Error:", err);
    res.status(500).json({ error: "Failed to apply enforcement action" });
  }
};

export const aiReviewUser = async (req, res) => {
  try {
    const { uniqueId } = req.params;

    const userResult = await pool.query(
      `SELECT * FROM users WHERE unique_id = $1`,
      [uniqueId],
    );
    if (userResult.rowCount === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const listingsRes = await pool.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'active')::int AS active,
        COUNT(*) FILTER (WHERE status = 'pending')::int AS pending
      FROM listings WHERE uploaded_by_id::text = $1
    `, [uniqueId]);
    const listings = listingsRes.rows[0] || { total: 0, active: 0, pending: 0 };

    const reportsRes = await pool.query(`
      SELECT COUNT(*)::int AS total
      FROM listing_reports WHERE listing_owner_id::text = $1 AND status = 'open'
    `, [uniqueId]);
    const reports = reportsRes.rows[0]?.total || 0;

    const enfRes = await pool.query(`
      SELECT COUNT(*)::int AS total
      FROM user_enforcement_logs WHERE target_user_id = $1
    `, [uniqueId]);
    const enforcements = enfRes.rows[0]?.total || 0;

    const userAgeDays = (Date.now() - new Date(userResult.rows[0].created_at).getTime()) / 86400000;

    let riskScore = 0;
    const signals = [];

    if (listings.total === 0) {
      riskScore += 5;
      signals.push("No listings");
    }
    if (reports > 0) {
      const r = Math.min(reports * 15, 40);
      riskScore += r;
      signals.push(`${reports} open report(s) (+${r})`);
    }
    if (enforcements > 0) {
      const e = Math.min(enforcements * 10, 30);
      riskScore += e;
      signals.push(`${enforcements} prior enforcement(s) (+${e})`);
    }
    if (listings.pending > 5) {
      riskScore += 10;
      signals.push(`${listings.pending} pending listings (+10)`);
    }
    if (userAgeDays < 7) {
      riskScore += 15;
      signals.push("New account <7 days (+15)");
    } else if (userAgeDays < 30) {
      riskScore += 8;
      signals.push("Account <30 days (+8)");
    }

    riskScore = Math.min(riskScore, 100);

    const notes = signals.length > 0
      ? `AI scan: ${signals.join("; ")}. Score: ${riskScore}/100.`
      : "AI scan completed. No risk signals detected.";

    await pool.query(`
      UPDATE users SET
        risk_score = $1, ai_risk_notes = $2,
        flagged_listings_count = $3, updated_at = NOW()
      WHERE unique_id = $4
    `, [riskScore, notes, reports, uniqueId]);

    res.json({
      riskScore,
      flaggedListings: reports,
      notes,
      user: {
        risk_score: riskScore,
        ai_risk_notes: notes,
        flagged_listings_count: reports,
      },
    });
  } catch (err) {
    console.error("AI Review Error:", err);
    res.status(500).json({ error: "AI review failed" });
  }
};

// =========================================================
// 5. ADMIN MANAGEMENT
// =========================================================
export const getAdmins = async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        u.id, u.unique_id, u.name, u.email, u.role,
        u.is_admin, u.is_super_admin, u.created_at, u.last_active AS last_seen_at,
        COALESCE(p.avatar_url, u.avatar_url) AS avatar_url,
        p.full_name
      FROM users u
      LEFT JOIN profiles p ON p.unique_id::text = u.unique_id::text
      WHERE u.role::text IN ('admin', 'super_admin')
      ORDER BY u.created_at DESC
    `);
    res.json({ admins: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
};

const columnExists = async (tableName, columnName) => {
  try {
    const result = await pool.query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2 LIMIT 1`,
      [tableName, columnName],
    );
    return result.rows.length > 0;
  } catch {
    return false;
  }
};

export const searchAdminCandidates = async (req, res) => {
  try {
    const query = (req.query.query || "").trim();
    if (!query) {
      return res.json({ users: [] });
    }

    const searchTerm = `%${query}%`;

    const hasUsername = await columnExists("users", "username");
    const hasProfileImage = await columnExists("profiles", "profile_image");

    let selectAvatar = "COALESCE(p.avatar_url, u.avatar_url) AS avatar_url";
    if (hasProfileImage) {
      selectAvatar = `COALESCE(p.profile_image, p.avatar_url, u.avatar_url) AS avatar_url`;
    }

    let usernameSelect = "NULL::varchar AS username";
    if (hasUsername) {
      usernameSelect = "u.username";
    }

    const result = await pool.query(`
      SELECT
        u.id, u.unique_id, u.name, u.email, u.role, u.created_at,
        ${usernameSelect},
        ${selectAvatar},
        p.full_name
      FROM users u
      LEFT JOIN profiles p ON p.unique_id::text = u.unique_id::text
      WHERE LOWER(u.role::text) NOT IN ('admin', 'super_admin')
        AND (
          u.email ILIKE $1
          OR u.name ILIKE $1
          OR u.unique_id::text ILIKE $1
          OR u.id::text ILIKE $1
          ${hasUsername ? "OR u.username ILIKE $1" : ""}
          OR p.full_name ILIKE $1
        )
      ORDER BY u.created_at DESC
      LIMIT 25
    `, [searchTerm]);

    res.json({ users: result.rows });
  } catch (err) {
    console.error("[searchAdminCandidates] Error:", err);
    res.status(500).json({ message: "Failed to search users" });
  }
};

export const promoteAdmin = async (req, res) => {
  try {
    const { unique_id, user_id, role } = req.body;

    if (role !== "admin") {
      return res.status(400).json({ success: false, message: "Role must be 'admin'" });
    }

    if (!unique_id && !user_id) {
      return res.status(400).json({ success: false, message: "unique_id or user_id is required" });
    }

    const identifier = unique_id || user_id;
    const idField = unique_id ? "unique_id" : "id";

    const userResult = await pool.query(
      `SELECT id, unique_id, name, email, role FROM users WHERE ${idField} = $1 LIMIT 1`,
      [identifier],
    );

    if (!userResult.rows.length) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const user = userResult.rows[0];

    if (user.role === "super_admin") {
      return res.status(400).json({ success: false, message: "Cannot promote a super admin" });
    }

    await pool.query(
      `UPDATE users SET role = 'admin', is_admin = TRUE, is_super_admin = FALSE, updated_at = NOW() WHERE ${idField} = $1`,
      [identifier],
    );

    const hasProfileRole = await columnExists("profiles", "role");
    if (hasProfileRole) {
      await pool.query(
        `UPDATE profiles SET role = 'admin' WHERE unique_id::text = $1`,
        [user.unique_id],
      );
    }

    const updatedResult = await pool.query(
      `SELECT
        u.id, u.unique_id, u.name, u.email, u.role,
        u.is_admin, u.is_super_admin, u.created_at, u.last_active AS last_seen_at,
        COALESCE(p.avatar_url, u.avatar_url) AS avatar_url,
        p.full_name
      FROM users u
      LEFT JOIN profiles p ON p.unique_id::text = u.unique_id::text
      WHERE u.${idField} = $1
      LIMIT 1`,
      [identifier],
    );

    res.json({
      success: true,
      message: `${user.name || user.email} promoted to admin.`,
      admin: updatedResult.rows[0],
    });
  } catch (err) {
    console.error("[promoteAdmin] Error:", err);
    res.status(500).json({ success: false, message: "Failed to promote user" });
  }
};

export const removeAdmin = async (req, res) => {
  try {
    const { uniqueId } = req.params;

    const userResult = await pool.query(
      `SELECT id, unique_id, name, email, role FROM users WHERE unique_id = $1 LIMIT 1`,
      [uniqueId],
    );

    if (!userResult.rows.length) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const user = userResult.rows[0];

    if (user.role === "super_admin") {
      return res.status(400).json({ success: false, message: "Super admin cannot be removed" });
    }

    if (user.role !== "admin") {
      return res.status(400).json({ success: false, message: "User is not an admin" });
    }

    await pool.query(
      `UPDATE users SET role = 'pending', is_admin = FALSE, updated_at = NOW() WHERE unique_id = $1`,
      [uniqueId],
    );

    const hasProfileRole = await columnExists("profiles", "role");
    if (hasProfileRole) {
      await pool.query(
        `UPDATE profiles SET role = 'pending' WHERE unique_id::text = $1`,
        [uniqueId],
      );
    }

    const auditExists = await tableExists("admin_audit_log");
    if (auditExists) {
      await pool.query(`
        INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details, created_at)
        VALUES ($1, 'remove_admin', 'user', $2, $3, NOW())
      `, [
        req.user?.unique_id,
        uniqueId,
        JSON.stringify({ removed_admin: user.name || user.email }),
      ]);
    }

    res.json({ success: true, message: "Admin privileges removed. User set to pending." });
  } catch (err) {
    console.error("[removeAdmin] Error:", err);
    res.status(500).json({ success: false, message: "Failed to remove admin" });
  }
};

// =========================================================
// 6. LISTINGS
// =========================================================
export const getListings = async (req, res) => {
  try {
    const { page = 1, limit = 20, status, search } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    let where = "WHERE 1=1";
    const params = [];
    let idx = 1;

    if (status) {
      where += ` AND l.status = $${idx++}`;
      params.push(status);
    }
    if (search) {
      where += ` AND (l.title ILIKE $${idx} OR l.city ILIKE $${idx} OR l.state ILIKE $${idx})`;
      params.push(`%${search}%`);
      idx++;
    }

    const countResult = await pool.query(`SELECT COUNT(*)::int AS total FROM listings l ${where}`, params);
    const result = await pool.query(`
      SELECT l.id, l.product_id, l.title, l.price, l.status, l.city, l.state,
        l.created_at,
        COALESCE(u.name, 'Unknown') AS created_by_name
      FROM listings l
      LEFT JOIN users u ON u.unique_id::text = l.uploaded_by_id::text
      ${where}
      ORDER BY l.created_at DESC
      LIMIT $${idx++} OFFSET $${idx++}
    `, [...params, parseInt(limit), offset]);

    res.json({
      listings: result.rows,
      total: countResult.rows[0]?.total || 0,
      page: parseInt(page),
      limit: parseInt(limit),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
};

export const getListingStats = async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status IN ('active', 'approved'))::int AS active,
        COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
        COUNT(*) FILTER (WHERE status = 'sold')::int AS sold,
        COUNT(*)::int AS total
      FROM listings
    `);
    res.json(result.rows[0] || { active: 0, pending: 0, sold: 0, total: 0 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
};

export const deleteListing = async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      "DELETE FROM listings WHERE product_id = $1 RETURNING id, title, product_id",
      [id]
    );
    if (result.rowCount === 0) {
      const r2 = await pool.query(
        "DELETE FROM listings WHERE id::text = $1 RETURNING id, title, product_id",
        [id]
      );
      if (r2.rowCount === 0) return res.status(404).json({ message: "Listing not found" });
      return res.json({ message: "Listing deleted", listing: r2.rows[0] });
    }
    res.json({ message: "Listing deleted", listing: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Delete failed" });
  }
};

// =========================================================
// 7. PAYMENTS
// =========================================================
export const getPayments = async (req, res) => {
  try {
    const { page = 1, limit = 20, status } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    let where = "WHERE 1=1";
    const params = [];
    let idx = 1;

    if (status) {
      where += ` AND p.status = $${idx++}`;
      params.push(status);
    }

    const countResult = await pool.query(`SELECT COUNT(*)::int AS total FROM payments p ${where}`, params);
    const result = await pool.query(`
      SELECT p.id, p.transaction_id, p.amount, p.currency, p.status,
        p.payment_method, p.description, p.created_at,
        COALESCE(payer.name, 'Unknown') AS payer_name,
        COALESCE(payee.name, 'Platform') AS payee_name
      FROM payments p
      LEFT JOIN users payer ON payer.id = p.payer_id
      LEFT JOIN users payee ON payee.id = p.payee_id
      ${where}
      ORDER BY p.created_at DESC
      LIMIT $${idx++} OFFSET $${idx++}
    `, [...params, parseInt(limit), offset]);

    res.json({
      payments: result.rows,
      total: countResult.rows[0]?.total || 0,
      page: parseInt(page),
      limit: parseInt(limit),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
};

// =========================================================
// 8. FEATURE FLAGS
// =========================================================
const ensureFeatureFlagsTable = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS feature_flags (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      key VARCHAR(100) UNIQUE NOT NULL,
      label VARCHAR(200) NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      description TEXT,
      updated_by UUID REFERENCES users(unique_id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
};

export const getFeatureFlags = async (req, res) => {
  try {
    const exists = await tableExists("feature_flags");
    if (!exists) return res.json({ flags: [] });

    const result = await pool.query("SELECT * FROM feature_flags ORDER BY key ASC");
    res.json({ flags: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
};

export const createFeatureFlag = async (req, res) => {
  try {
    await ensureFeatureFlagsTable();
    const { key, label, enabled = false, description } = req.body;
    if (!key || !label) return res.status(400).json({ message: "key and label are required" });

    const result = await pool.query(
      `INSERT INTO feature_flags (key, label, enabled, description, updated_by) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [key, label, enabled, description || null, req.user?.unique_id]
    );
    res.status(201).json({ flag: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ message: "Feature flag key already exists" });
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
};

export const updateFeatureFlag = async (req, res) => {
  try {
    const { id } = req.params;
    const { key, label, enabled, description } = req.body;

    const sets = [];
    const params = [];
    let idx = 1;
    if (key !== undefined) { sets.push(`key = $${idx++}`); params.push(key); }
    if (label !== undefined) { sets.push(`label = $${idx++}`); params.push(label); }
    if (enabled !== undefined) { sets.push(`enabled = $${idx++}`); params.push(enabled); }
    if (description !== undefined) { sets.push(`description = $${idx++}`); params.push(description); }
    sets.push(`updated_at = NOW()`);
    params.push(id);

    const result = await pool.query(
      `UPDATE feature_flags SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
      params
    );
    if (result.rowCount === 0) return res.status(404).json({ message: "Feature flag not found" });
    res.json({ flag: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
};

export const deleteFeatureFlag = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query("DELETE FROM feature_flags WHERE id = $1 RETURNING id", [id]);
    if (result.rowCount === 0) return res.status(404).json({ message: "Feature flag not found" });
    res.json({ message: "Feature flag deleted" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
};

// =========================================================
// 9. PLATFORM SETTINGS
// =========================================================
const ensurePlatformSettingsTable = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS platform_settings (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      key VARCHAR(100) UNIQUE NOT NULL,
      value TEXT NOT NULL,
      type VARCHAR(40) NOT NULL DEFAULT 'text',
      description TEXT,
      updated_by UUID REFERENCES users(unique_id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    INSERT INTO platform_settings (key, value, type, description) VALUES
      ('platform_name', 'Keyvia', 'text', 'The display name of the platform'),
      ('default_currency', 'USD', 'text', 'Default currency for listing prices'),
      ('maintenance_mode', 'false', 'boolean', 'Restrict public access during updates'),
      ('ai_auto_scan_listings', 'false', 'boolean', 'When enabled, AI scans new pending listings automatically on submission'),
      ('ai_auto_scan_verifications', 'false', 'boolean', 'When enabled, AI scans new verification/profile submissions automatically'),
      ('ai_auto_approve_low_risk', 'true', 'boolean', 'When enabled, AI can auto-approve low-risk listings in batch scan'),
      ('ai_auto_reject_high_risk', 'true', 'boolean', 'When enabled, AI can auto-reject high-risk/critical listings in batch scan'),
      ('ai_require_manual_review_medium_risk', 'true', 'boolean', 'When enabled, medium-risk items stay pending for manual admin review')
    ON CONFLICT (key) DO NOTHING
  `);
};

export const getPlatformSettings = async (req, res) => {
  try {
    const exists = await tableExists("platform_settings");
    if (!exists) return res.json({ settings: [] });

    const result = await pool.query("SELECT * FROM platform_settings ORDER BY key ASC");
    res.json({ settings: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
};

// =========================================================
// 10. TRACK VISIT (Public)
// =========================================================
export const trackVisit = async (req, res) => {
  try {
    const { visitorId, page, referrer } = req.body;
    if (!visitorId) {
      return res.status(200).json({ success: true }); // Silently accept
    }

    const exists = await tableExists("platform_visits");
    if (!exists) {
      return res.status(200).json({ success: true });
    }

    await pool.query(
      `INSERT INTO platform_visits (visitor_id, page, referrer, user_agent, ip_address)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        visitorId,
        page || '/',
        referrer || null,
        req.headers?.['user-agent'] || null,
        req.ip || req.headers?.['x-forwarded-for'] || req.connection?.remoteAddress || null,
      ],
    );

    return res.status(200).json({ success: true });
  } catch {
    return res.status(200).json({ success: true });
  }
};

export const updatePlatformSetting = async (req, res) => {
  try {
    await ensurePlatformSettingsTable();
    const { key, value } = req.body;
    if (!key || value === undefined) return res.status(400).json({ message: "key and value are required" });

    const result = await pool.query(
      `UPDATE platform_settings SET value = $1, updated_at = NOW(), updated_by = $2 WHERE key = $3 RETURNING *`,
      [String(value), req.user?.unique_id, key]
    );
    if (result.rowCount === 0) return res.status(404).json({ message: "Setting not found" });
    res.json({ setting: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
};

// =========================================================
// GLOBAL SEARCH
// =========================================================
export const globalSearch = async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.trim().length < 2) return res.json({ users: [], listings: [], payments: [], admins: [] });

    const term = `%${q.trim()}%`;

    const [users, listings, payments, admins] = await Promise.all([
      safeQuery(
        `SELECT unique_id, name, email, role, avatar_url, created_at, is_banned, verification_status
         FROM users WHERE name ILIKE $1 OR email ILIKE $1 OR unique_id ILIKE $1 LIMIT 10`,
        [term]
      ),
      safeQuery(
        `SELECT product_id, title, property_purpose, property_type, status, price, created_at, city
         FROM listings WHERE title ILIKE $1 OR product_id ILIKE $1 OR city ILIKE $1 LIMIT 10`,
        [term]
      ),
      safeQuery(
        `SELECT id, email, amount, status, created_at, payment_method
         FROM payments WHERE email ILIKE $1 OR id::text ILIKE $1 LIMIT 10`,
        [term]
      ),
      safeQuery(
        `SELECT unique_id, name, email, role, created_at
         FROM users WHERE (role = 'admin' OR role = 'super_admin') AND (name ILIKE $1 OR email ILIKE $1) LIMIT 10`,
        [term]
      ),
    ]);

    res.json({ users, listings, payments, admins });
  } catch (err) {
    console.error("Global search error:", err);
    res.status(500).json({ message: "Search failed" });
  }
};
