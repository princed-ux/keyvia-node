import { pool } from "../db.js";
import { uploadToS3 } from "../middleware/upload.js";

export const uploadAvatar = async (req, res) => {
  const client = await pool.connect();

  try {
    if (!req.file) {
      return res.status(400).json({ message: "No file uploaded" });
    }

    const userId = req.user.unique_id;

    // Upload avatar to S3
    const avatarUrl = await uploadToS3(req.file, "avatars");

    await client.query("BEGIN");

    // Update users
    await client.query(
      `
      UPDATE users
      SET
        avatar_url = $1,
        updated_at = NOW()
      WHERE unique_id = $2
      `,
      [avatarUrl, userId]
    );

    // Update shared profile
    await client.query(
      `
      INSERT INTO profiles (unique_id, avatar_url, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (unique_id)
      DO UPDATE SET
        avatar_url = EXCLUDED.avatar_url,
        updated_at = NOW()
      `,
      [userId, avatarUrl]
    );

    await client.query("COMMIT");

    return res.json({
      success: true,
      message: "Avatar updated successfully.",
      avatar_url: avatarUrl,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Avatar Upload Error:", err);
    return res.status(500).json({
      message: "Server error during avatar upload",
      details: err.message,
    });
  } finally {
    client.release();
  }
};