import { pool } from "../db.js";
import { analyzeProfile } from "../services/aiProfileService.js";

// =========================================================
// 1. GET PENDING VERIFICATIONS (The Queue)
// =========================================================
export const getPendingProfiles = async (req, res) => {
  try {
    // We MUST JOIN with the users table to grab the document URLs!
    const result = await pool.query(`
      SELECT 
        p.unique_id, 
        p.full_name, 
        p.username, 
        p.email, 
        p.avatar_url, 
        p.country, 
        p.city, 
        p.phone, 
        p.role, 
        p.license_number, 
        p.agency_name, 
        p.experience,
        p.special_id,
        p.bio, 
        p.created_at, 
        p.verification_status,
        COALESCE(u.license_document_url, u.identity_document_url) AS document_url
      FROM profiles p
      JOIN users u ON p.unique_id = u.unique_id
      WHERE p.verification_status = 'pending' 
      ORDER BY p.created_at DESC
    `);

    // Explicit return to close the request and stop the frontend spinner
    return res.status(200).json(result.rows);
  } catch (err) {
    console.error("[GetPending] Error:", err);
    return res.status(500).json({ message: "Server Error" });
  }
};

// =========================================================
// 2. ANALYZE SINGLE PROFILE (AI Scan)
// =========================================================
export const analyzeAgentProfile = async (req, res) => {
  try {
    const { id } = req.params;

    // Fetch profile data
    const result = await pool.query(
      `SELECT * FROM profiles WHERE unique_id = $1`,
      [id],
    );
    if (result.rows.length === 0)
      return res.status(404).json({ message: "Profile not found" });

    const profile = result.rows[0];

    // 🧠 Run AI Service
    const report = await analyzeProfile(profile);

    res.json(report);
  } catch (err) {
    console.error("[AI Analyze] Error:", err);
    res.status(500).json({ message: "Analysis Failed" });
  }
};

// =========================================================
// 3. 🚀 BULK AI SCAN (Auto-Pilot)
// =========================================================
export const analyzeAllPendingProfiles = async (req, res) => {
  try {
    // ✅ FIX: Only scan 'pending'. Do not scan empty/new profiles to save AI costs.
    const pendingRes = await pool.query(
      "SELECT * FROM profiles WHERE verification_status = 'pending'",
    );
    const profiles = pendingRes.rows;

    let approved = 0;
    let rejected = 0;
    let manual = 0;

    // 2. Loop and Analyze
    for (const profile of profiles) {
      const aiReport = await analyzeProfile(profile);

      let newStatus = "pending";
      let reason = null;

      // 🧠 AI Rules
      if (aiReport.score < 50 || aiReport.verdict === "Auto-Reject") {
        newStatus = "rejected";
        reason = `AI Auto-Reject: ${aiReport.flags.join(", ") || "Low Quality Data"}`;
        rejected++;
      } else if (aiReport.score >= 90) {
        // Only auto-approve High Confidence
        newStatus = "approved";
        approved++;
      } else {
        manual++;
      }

      // 3. If Status Changed, Update DB
      if (newStatus !== "pending") {
        // Update Profile Table
        await pool.query(
          `UPDATE profiles SET 
                 verification_status=$1, 
                 rejection_reason=$2, 
                 ai_score=$3, 
                 ai_flags=$4,
                 updated_at=NOW()
                 WHERE unique_id=$5`,
          [
            newStatus,
            reason,
            aiReport.score,
            aiReport.flags.join(", "),
            profile.unique_id,
          ],
        );

        // If Approved, we MUST update the User Table permissions
        if (newStatus === "approved") {
          // Determine Tier
          const tier = profile.license_number ? "licensed" : "identity";

          await pool.query(
            `UPDATE users 
                     SET is_verified_agent = ($1 = 'agent'), 
                         is_owner = ($1 = 'owner' OR $1 = 'landlord'),
                         verification_tier = $2,
                         is_verified = TRUE 
                     WHERE unique_id = $3`,
            [profile.role, tier, profile.unique_id],
          );
        }

        // Notification
        const msg =
          newStatus === "approved"
            ? "Your profile has been verified! You can now post listings."
            : `Profile verification failed. Reason: ${reason}`;

        await pool.query(
          `INSERT INTO notifications (receiver_id, type, title, message)
                 VALUES ($1, 'system', 'Verification Update', $2)`,
          [profile.unique_id, msg],
        );
      }
    }

    res.json({ success: true, approved, rejected, remaining: manual });
  } catch (err) {
    console.error("Bulk Analysis Error:", err);
    res.status(500).json({ message: "Bulk scan failed" });
  }
};

// =========================================================
// 4. MANUAL APPROVE/REJECT (The Gatekeeper)
// =========================================================
export const updateProfileStatus = async (req, res) => {
  const client = await pool.connect(); // Transaction Client
  try {
    const { id } = req.params; // Profile ID
    const { status, reason } = req.body; // 'approved' | 'rejected'

    if (!["approved", "rejected"].includes(status)) {
      return res.status(400).json({ message: "Invalid status" });
    }

    await client.query("BEGIN"); // Start Transaction

    // 1. Update PROFILE status
    const updateProfile = await client.query(
      `UPDATE profiles 
       SET verification_status = $1, rejection_reason = $2, updated_at = NOW() 
       WHERE unique_id = $3 
       RETURNING role, license_number, country`,
      [status, reason || null, id],
    );

    if (updateProfile.rows.length === 0) {
      throw new Error("Profile not found");
    }

    const { role, license_number } = updateProfile.rows[0];

    // 2. If Approved, Grant Permissions in USER Table
    if (status === "approved") {
      let tier = "none";

      // Strict Tier Logic
      if (role === "AgencyAgent" || role === "IndependentAgent") {
        tier = license_number ? "licensed" : "identity";
      } else if (role === "BrokerageOwner" || role === "Landlord") {
        tier = "identity"; // Owners get Identity tier
      }

      await client.query(
        `UPDATE users 
             SET is_verified_agent = ($1 = 'AgencyAgent' OR $1 = 'IndependentAgent'), 
                 is_owner = ($1 = 'BrokerageOwner' OR $1 = 'Landlord'),
                 verification_tier = $2,
                 is_verified = TRUE 
             WHERE unique_id = $3`,
        [role, tier, id],
      );
    } else if (status === "rejected") {
      // Revoke Permissions
      await client.query(
        `UPDATE users 
             SET is_verified_agent = FALSE, 
                 verification_tier = 'none',
                 is_verified = FALSE 
             WHERE unique_id = $1`,
        [id],
      );
    }

    // 3. Send Notification
    const msg =
      status === "approved"
        ? `Congratulations! Your ${role} account is verified. You can now post listings.`
        : `Verification Rejected: ${reason}`;

    await client.query(
      `INSERT INTO notifications (receiver_id, type, title, message)
       VALUES ($1, 'system', 'Verification Update', $2)`,
      [id, msg],
    );

    await client.query("COMMIT"); // Commit Transaction
    res.json({ success: true, message: `Profile ${status}` });
  } catch (err) {
    await client.query("ROLLBACK"); // Revert on Error
    console.error("Verification Update Error:", err);
    res.status(500).json({ message: "Update Failed" });
  } finally {
    client.release();
  }
};
