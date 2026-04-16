import express from "express";
import { pool } from "../db.js";

const router = express.Router();

// ============================================================
// BROKERAGE DASHBOARD - Stats & Overview
// ============================================================

/**
 * GET /api/brokerage/stats
 * Get dashboard statistics (active projects, agents, properties, revenue)
 */
router.get("/stats", async (req, res) => {
  try {
    const userId = req.headers["x-user-id"]; // From auth middleware
    
    // Get stats from database
    const statsQuery = `
      SELECT
        (SELECT COUNT(*) FROM listings WHERE created_by = $1 AND status = 'active') as active_projects,
        (SELECT COUNT(*) FROM users WHERE role = 'agent' AND brokerage_id = $1) as total_agents,
        (SELECT COUNT(*) FROM listings WHERE created_by = $1) as total_properties,
        (SELECT COALESCE(SUM(CAST(amount AS DECIMAL)), 0) FROM payments WHERE receiver_id = $1 AND status = 'completed' AND EXTRACT(YEAR FROM created_at) = EXTRACT(YEAR FROM NOW())) as revenue_ytd
    `;
    
    const { rows } = await pool.query(statsQuery, [userId]);
    const stats = rows[0];

    res.json({
      projects: stats.active_projects || 0,
      agents: stats.total_agents || 0,
      properties: stats.total_properties || 0,
      revenue: stats.revenue_ytd || 0,
    });
  } catch (err) {
    console.error("Brokerage Stats Error:", err);
    res.status(500).json({ error: "Failed to fetch stats" });
  }
});

// ============================================================
// BROKERAGE PROJECTS
// ============================================================

/**
 * GET /api/brokerage/projects
 * Get all projects under the brokerage
 */
router.get("/projects", async (req, res) => {
  try {
    const userId = req.headers["x-user-id"];

    const { rows } = await pool.query(
      `SELECT 
        id, 
        title as name, 
        location, 
        status, 
        description,
        created_at,
        updated_at
      FROM listings 
      WHERE created_by = $1 
      ORDER BY created_at DESC`,
      [userId]
    );

    // Calculate progress percentage (mock for now)
    const projects = rows.map((p) => ({
      ...p,
      progress: Math.floor(Math.random() * 100),
      unitsLeft: Math.floor(Math.random() * 50),
    }));

    res.json(projects);
  } catch (err) {
    console.error("Get Projects Error:", err);
    res.status(500).json({ error: "Failed to fetch projects" });
  }
});

/**
 * POST /api/brokerage/projects
 * Create a new project
 */
router.post("/projects", async (req, res) => {
  const { title, location, description, status } = req.body;
  const userId = req.headers["x-user-id"];

  try {
    const { rows } = await pool.query(
      `INSERT INTO listings 
       (title, location, description, status, created_by, listing_type)
       VALUES ($1, $2, $3, $4, $5, 'sale')
       RETURNING id, title as name, location, status, created_at`,
      [title, location, description, status || "planning", userId]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error("Create Project Error:", err);
    res.status(500).json({ error: "Failed to create project" });
  }
});

/**
 * PATCH /api/brokerage/projects/:id
 * Update a project
 */
router.patch("/projects/:id", async (req, res) => {
  const { id } = req.params;
  const { title, location, description, status } = req.body;

  try {
    const { rows } = await pool.query(
      `UPDATE listings 
       SET title = COALESCE($1, title), 
           location = COALESCE($2, location),
           description = COALESCE($3, description),
           status = COALESCE($4, status),
           updated_at = NOW()
       WHERE id = $5
       RETURNING id, title as name, location, status`,
      [title, location, description, status, id]
    );

    if (!rows.length) return res.status(404).json({ error: "Project not found" });
    res.json(rows[0]);
  } catch (err) {
    console.error("Update Project Error:", err);
    res.status(500).json({ error: "Failed to update project" });
  }
});

/**
 * DELETE /api/brokerage/projects/:id
 * Delete a project
 */
router.delete("/projects/:id", async (req, res) => {
  const { id } = req.params;

  try {
    await pool.query("DELETE FROM listings WHERE id = $1", [id]);
    res.json({ success: true, message: "Project deleted" });
  } catch (err) {
    console.error("Delete Project Error:", err);
    res.status(500).json({ error: "Failed to delete project" });
  }
});

// ============================================================
// BROKERAGE AGENTS (Team Management)
// ============================================================

/**
 * GET /api/brokerage/agents
 * Get all agents under the brokerage
 */
router.get("/agents", async (req, res) => {
  try {
    const userId = req.headers["x-user-id"];

    const { rows } = await pool.query(
      `SELECT 
        u.id,
        u.unique_id,
        u.name,
        u.email,
        u.phone,
        u.role,
        p.avatar_url,
        COUNT(l.id) as listings_count
      FROM users u
      LEFT JOIN profiles p ON p.unique_id = u.unique_id
      LEFT JOIN listings l ON l.created_by = u.unique_id
      WHERE u.brokerage_id = $1 AND u.role = 'agent'
      GROUP BY u.id, u.unique_id, u.name, u.email, u.phone, u.role, p.avatar_url
      ORDER BY u.created_at DESC`,
      [userId]
    );

    res.json(rows);
  } catch (err) {
    console.error("Get Agents Error:", err);
    res.status(500).json({ error: "Failed to fetch agents" });
  }
});

/**
 * POST /api/brokerage/agents
 * Add an agent to the brokerage
 */
router.post("/agents", async (req, res) => {
  const { email, name, phone } = req.body;
  const brokerageId = req.headers["x-user-id"];

  if (!email || !name) {
    return res.status(400).json({ error: "Email and name are required" });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO users (name, email, phone, role, brokerage_id)
       VALUES ($1, $2, $3, 'agent', $4)
       ON CONFLICT (email) DO UPDATE
       SET brokerage_id = EXCLUDED.brokerage_id
       RETURNING id, unique_id, name, email, phone, role`,
      [name, email, phone, brokerageId]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error("Add Agent Error:", err);
    res.status(500).json({ error: "Failed to add agent" });
  }
});

/**
 * DELETE /api/brokerage/agents/:id
 * Remove an agent from the brokerage
 */
router.delete("/agents/:id", async (req, res) => {
  const { id } = req.params;

  try {
    await pool.query(
      "UPDATE users SET brokerage_id = NULL WHERE unique_id = $1",
      [id]
    );
    res.json({ success: true, message: "Agent removed from brokerage" });
  } catch (err) {
    console.error("Remove Agent Error:", err);
    res.status(500).json({ error: "Failed to remove agent" });
  }
});

// ============================================================
// BROKERAGE PAYMENTS & TRANSACTIONS
// ============================================================

/**
 * GET /api/brokerage/payments
 * Get payment history
 */
router.get("/payments", async (req, res) => {
  try {
    const userId = req.headers["x-user-id"];

    const { rows } = await pool.query(
      `SELECT 
        id,
        description,
        amount,
        status,
        created_at,
        updated_at
      FROM payments
      WHERE receiver_id = $1 OR sender_id = $1
      ORDER BY created_at DESC
      LIMIT 50`,
      [userId]
    );

    res.json(rows);
  } catch (err) {
    console.error("Get Payments Error:", err);
    res.status(500).json({ error: "Failed to fetch payments" });
  }
});

/**
 * GET /api/brokerage/payments/:id
 * Get payment receipt
 */
router.get("/payments/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const { rows } = await pool.query(
      `SELECT * FROM payments WHERE id = $1`,
      [id]
    );

    if (!rows.length) return res.status(404).json({ error: "Payment not found" });
    res.json(rows[0]);
  } catch (err) {
    console.error("Get Payment Error:", err);
    res.status(500).json({ error: "Failed to fetch payment" });
  }
});

// ============================================================
// BROKERAGE PROFILE & SETTINGS
// ============================================================

/**
 * GET /api/brokerage/profile
 * Get brokerage profile information
 */
router.get("/profile", async (req, res) => {
  try {
    const userId = req.headers["x-user-id"];

    const { rows } = await pool.query(
      `SELECT 
        u.id,
        u.unique_id,
        u.name,
        u.email,
        u.phone,
        u.role,
        p.avatar_url,
        p.bio,
        p.license_number,
        p.company_name
      FROM users u
      LEFT JOIN profiles p ON p.unique_id = u.unique_id
      WHERE u.unique_id = $1`,
      [userId]
    );

    if (!rows.length) return res.status(404).json({ error: "Profile not found" });
    res.json(rows[0]);
  } catch (err) {
    console.error("Get Profile Error:", err);
    res.status(500).json({ error: "Failed to fetch profile" });
  }
});

/**
 * PATCH /api/brokerage/profile
 * Update brokerage profile
 */
router.patch("/profile", async (req, res) => {
  const userId = req.headers["x-user-id"];
  const { name, phone, company_name, license_number, bio, address } = req.body;

  try {
    // Update users table
    await pool.query(
      `UPDATE users 
       SET name = COALESCE($1, name),
           phone = COALESCE($2, phone)
       WHERE unique_id = $3`,
      [name, phone, userId]
    );

    // Update profiles table
    await pool.query(
      `INSERT INTO profiles (unique_id, company_name, license_number, bio, address)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (unique_id) DO UPDATE
       SET company_name = COALESCE($2, company_name),
           license_number = COALESCE($3, license_number),
           bio = COALESCE($4, bio),
           address = COALESCE($5, address)`,
      [userId, company_name, license_number, bio, address]
    );

    res.json({ success: true, message: "Profile updated successfully" });
  } catch (err) {
    console.error("Update Profile Error:", err);
    res.status(500).json({ error: "Failed to update profile" });
  }
});

export default router;
