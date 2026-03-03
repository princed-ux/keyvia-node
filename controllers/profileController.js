import { pool } from "../db.js";

// ------------------ VALIDATION HELPER ------------------
const validateProfile = (data) => {
  const errors = {};
  if (!data.full_name?.trim()) errors.full_name = "Full name is required";
  if (!data.username?.trim()) errors.username = "Username is required";
  return errors;
};

// ------------------ 1. GET PRIVATE PROFILE ------------------
export const getProfile = async (req, res) => {
  try {
    const { unique_id, source, role } = req.user;

    // Use COALESCE to fallback to 'users' table data if 'profiles' is empty
    const columns = `
      p.unique_id, 
      COALESCE(p.full_name, u.name) as full_name, 
      p.username, 
      COALESCE(p.email, u.email) as email, 
      COALESCE(p.phone, u.phone) as phone, 
      p.gender, 
      COALESCE(p.country, u.country) as country, 
      p.city, 
      p.bio, 
      COALESCE(p.avatar_url, u.avatar_url) as avatar_url,
      p.social_tiktok, p.social_instagram, p.social_facebook, p.social_linkedin, p.social_twitter,
      p.role, p.special_id, p.created_at,
      p.verification_status, p.rejection_reason,
      p.agency_name, p.license_number, p.experience,
      p.preferred_location, p.budget_min, p.budget_max, p.property_type, p.move_in_date
    `;

    let result = await pool.query(
      `SELECT ${columns} 
       FROM profiles p
       RIGHT JOIN users u ON p.unique_id = u.unique_id
       WHERE p.unique_id = $1`,
      [unique_id]
    );

    // ✅ SELF-HEALING: If profile row is missing, create it now
    if (!result.rows.length && source === "users") {
      const needsVerification = ['agent', 'owner'].includes(role);
      // FIX: Use 'verified' instead of 'approved' to match your Admin system
      const initialStatus = needsVerification ? 'new' : 'verified'; 
      
      await pool.query(
        `INSERT INTO profiles (unique_id, full_name, email, role, verification_status, country, phone)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (unique_id) DO NOTHING`,
        [unique_id, req.user.name, req.user.email, role, initialStatus, req.user.country, req.user.phone]
      );
      
      // Fetch again to return the new row
      result = await pool.query(
        `SELECT ${columns} 
         FROM profiles p
         RIGHT JOIN users u ON p.unique_id = u.unique_id
         WHERE p.unique_id = $1`,
        [unique_id]
      );
    }

    if (!result.rows.length)
      return res.status(404).json({ message: "Profile not found" });

    res.json(result.rows[0]);
  } catch (err) {
    console.error("❌ GET /profile error:", err);
    res.status(500).json({ message: "Server error fetching profile" });
  }
};

// ------------------ 2. UPDATE PRIVATE PROFILE (Smart Logic) ------------------
export const updateProfile = async (req, res) => {
  try {
    const { unique_id, role } = req.user;
    const {
      full_name, username, phone, gender, country, city, bio,
      social_tiktok, social_instagram, social_facebook, social_linkedin, social_twitter,
      // Critical Fields
      agency_name, license_number, experience,
      // Buyer Fields
      preferred_location, budget_min, budget_max, property_type, move_in_date
    } = req.body;

    const errors = validateProfile({ full_name, username });
    if (Object.keys(errors).length) return res.status(400).json({ errors });

    // 1️⃣ FETCH CURRENT DATA FIRST (To compare)
    const currentRes = await pool.query(
        `SELECT full_name, agency_name, license_number, verification_status FROM profiles WHERE unique_id = $1`,
        [unique_id]
    );
    const currentProfile = currentRes.rows[0] || {};

    // 2️⃣ CHECK FOR CRITICAL CHANGES
    // We ONLY reset verification if they are an Agent/Owner AND they changed sensitive info.
    // Changing Avatar, Bio, or Socials is SAFE.
    let shouldResetVerification = false;

    if (['agent', 'owner'].includes(role)) {
        // Helper to normalize strings (treat null, undefined, and "" as the same)
        const normalize = (str) => (str || "").trim();

        const nameChanged = normalize(full_name) !== normalize(currentProfile.full_name);
        const licenseChanged = normalize(license_number) !== normalize(currentProfile.license_number);
        const agencyChanged = normalize(agency_name) !== normalize(currentProfile.agency_name);

        if (nameChanged || licenseChanged || agencyChanged) {
            shouldResetVerification = true;
        }
    }

    // 3️⃣ BUILD DYNAMIC SQL
    let statusUpdateSQL = "";
    if (shouldResetVerification) {
        statusUpdateSQL = `, verification_status = 'pending', rejection_reason = NULL`;
    }

    const result = await pool.query(
      `UPDATE profiles SET
        full_name = $1, username = $2, phone = $3, gender = $4, country = $5, city = $6, bio = $7,
        
        -- Agent/Owner Fields
        agency_name = $8, license_number = $9, experience = $10,
        
        -- Socials
        social_tiktok = $11, social_instagram = $12, social_facebook = $13, social_linkedin = $14, social_twitter = $15,

        -- Buyer Fields
        preferred_location = $17, budget_min = $18, budget_max = $19, property_type = $20, move_in_date = $21,
        
        updated_at = NOW()
        ${statusUpdateSQL} 

      WHERE unique_id = $16
      RETURNING *`,
      [
        full_name, username, phone || null, gender || null, country || null, city || null, bio || null,
        agency_name || null, license_number || null, experience || null,
        social_tiktok || null, social_instagram || null, social_facebook || null, social_linkedin || null, social_twitter || null,
        unique_id,
        preferred_location || null, budget_min || null, budget_max || null, property_type || null, move_in_date || null
      ]
    );

    // Sync Users Table (Important for Auth consistency)
    await pool.query(
        `UPDATE users SET name = $1, phone = $2, country = $3 WHERE unique_id = $4`, 
        [full_name, phone, country, unique_id]
    );

    res.json({
      message: shouldResetVerification 
        ? "Critical details changed. Profile is under review." 
        : "Profile updated successfully.",
      profile: result.rows[0],
      verification_status: result.rows[0].verification_status 
    });

  } catch (err) {
    console.error("❌ PUT /profile error:", err);
    if (err.code === "23505")
      return res.status(400).json({ message: "Username already exists" });
    res.status(500).json({ message: "Server error" });
  }
};

// ------------------ 3. GET PUBLIC PROFILE ------------------
export const getPublicProfile = async (req, res) => {
  try {
    const { username } = req.params;
    const result = await pool.query(
      `SELECT unique_id, full_name, username, bio, avatar_url, gender, country, city, role, verification_status
       FROM profiles WHERE username = $1`,
      [username]
    );
    if (!result.rows.length)
      return res.status(404).json({ message: "Profile not found" });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
};