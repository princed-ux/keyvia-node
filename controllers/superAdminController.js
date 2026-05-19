import { pool } from "../db.js";

const tableExists = async (tableName) => {
  const result = await pool.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1 LIMIT 1`,
    [tableName],
  );
  return result.rows.length > 0;
};

// =========================================================
// 1. DASHBOARD STATS
// =========================================================
export const getDashboardStats = async (req, res) => {
  try {
    const userCounts = await pool.query(`
      SELECT role, COUNT(*) as count FROM users GROUP BY role
    `);

    const userDist = userCounts.rows.map(row => ({
      name: row.role.charAt(0).toUpperCase() + row.role.slice(1),
      value: parseInt(row.count)
    })).filter(u => u.name !== 'Super_admin');

    const totalUsers = userCounts.rows.reduce((acc, curr) => acc + parseInt(curr.count), 0);

    const revenueRes = await pool.query(`
      SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE status IN ('success', 'successful', 'completed')
    `);
    const totalRevenue = parseFloat(revenueRes.rows[0].total);

    const listingRes = await pool.query(`
      SELECT COUNT(*) as count FROM listings WHERE status IN ('active', 'approved')
    `);

    const pendingRes = await pool.query(`
      SELECT COUNT(*) as count FROM users WHERE verification_status = 'pending'
    `);

    const activityRes = await pool.query(`
      SELECT name as user_name, 'New User Signup' as action_type, role as details, created_at, 'success' as status 
      FROM users 
      ORDER BY created_at DESC LIMIT 5
    `);

    const revenueSeries = [
      { name: 'Jan', amount: 4000 },
      { name: 'Feb', amount: 3000 },
      { name: 'Mar', amount: 2000 },
      { name: 'Apr', amount: 2780 },
      { name: 'May', amount: 1890 },
      { name: 'Jun', amount: 2390 },
    ];

    res.json({
      stats: {
        totalUsers,
        totalAgents: userDist.find(d => d.name.toLowerCase().includes('agent'))?.value || 0,
        totalRevenue,
        activeListings: parseInt(listingRes.rows[0].count),
        pendingVerifications: parseInt(pendingRes.rows[0].count),
        revenueSeries,
        userDistribution: userDist
      },
      activity: activityRes.rows
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
    const result = await pool.query(`
      SELECT id, unique_id, name, email, role, created_at, is_banned, ban_reason
      FROM users 
      WHERE role::text NOT IN ('super_admin')
      ORDER BY created_at DESC
      LIMIT $1 OFFSET $2
    `, [limit, offset]);
    res.json({ users: result.rows, page, limit, total: result.rows.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
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
// 5. ADMIN MANAGEMENT
// =========================================================
export const getAdmins = async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, unique_id, name, email, role, is_admin, is_super_admin, created_at
      FROM users
      WHERE role::text IN ('admin', 'super_admin')
      ORDER BY created_at DESC
    `);
    res.json({ admins: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
};

export const createAdmin = async (req, res) => {
  const { email, unique_id } = req.body;
  try {
    let user;
    if (email) {
      const r = await pool.query(
        `UPDATE users SET role = 'admin', is_admin = TRUE, updated_at = NOW() WHERE email = $1 RETURNING id, unique_id, name, email, role`,
        [email]
      );
      user = r.rows[0];
    } else if (unique_id) {
      const r = await pool.query(
        `UPDATE users SET role = 'admin', is_admin = TRUE, updated_at = NOW() WHERE unique_id = $1 RETURNING id, unique_id, name, email, role`,
        [unique_id]
      );
      user = r.rows[0];
    }

    if (!user) return res.status(404).json({ message: "User not found" });
    res.json({ message: "Admin created successfully", admin: user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to create admin" });
  }
};

export const removeAdmin = async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      `UPDATE users SET role = 'owner', is_admin = FALSE, updated_at = NOW() WHERE unique_id = $1 AND role::text = 'admin' RETURNING id, unique_id, name, email, role`,
      [id]
    );
    if (result.rowCount === 0) return res.status(404).json({ message: "Admin not found or is super admin" });
    res.json({ message: "Admin privileges removed" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to remove admin" });
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
        l.created_at, l.flagged_reason,
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
