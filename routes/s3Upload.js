import express from "express";
import {
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { v4 as uuidv4 } from "uuid";
import { pool } from "../db.js";
import { authenticateAndAttachUser } from "../middleware/authMiddleware.js";

const router = express.Router();

const AWS_REGION = process.env.AWS_REGION || "eu-west-1";
const S3_BUCKET = process.env.AWS_S3_BUCKET;
const MEDIA_CDN_URL = process.env.MEDIA_CDN_URL || "";

const s3Client = new S3Client({
  region: AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

router.use(authenticateAndAttachUser);

const getUserId = (req) => req.user?.unique_id || null;

const allowedTypes = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
  "application/pdf",
  "video/mp4",
  "video/webm",
  "video/quicktime",
];

const validResourceTypes = ["listing", "profile", "document", "license"];

const buildFileUrl = (bucket, key) => {
  if (MEDIA_CDN_URL) {
    return `${MEDIA_CDN_URL.replace(/\/$/, "")}/${key}`;
  }

  return `https://${bucket}.s3.${AWS_REGION}.amazonaws.com/${key}`;
};

const sanitizeExtension = (fileName = "") => {
  const ext = fileName.includes(".") ? fileName.split(".").pop() : "bin";
  return String(ext || "bin").toLowerCase().replace(/[^a-z0-9]/g, "") || "bin";
};

// ============================================================================
// 1. GENERATE PRESIGNED URL
// ============================================================================
router.post("/generate-presigned-url", async (req, res) => {
  try {
    const { file_name, file_type, resource_type, resource_id } = req.body;
    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (!S3_BUCKET) {
      return res.status(500).json({ error: "AWS_S3_BUCKET is not configured" });
    }

    if (!file_name || !file_type || !resource_type) {
      return res.status(400).json({
        error: "Missing required fields: file_name, file_type, resource_type",
      });
    }

    if (!allowedTypes.includes(file_type)) {
      return res.status(400).json({
        error:
          "File type not allowed. Allowed types: images, videos, and PDFs.",
      });
    }

    if (!validResourceTypes.includes(resource_type)) {
      return res.status(400).json({
        error: "Invalid resource type",
      });
    }

    const uploadId = uuidv4();
    const fileExtension = sanitizeExtension(file_name);
    const safeResourceId = resource_id || "temp";

    const folder =
      resource_type === "listing"
        ? "listings"
        : resource_type === "profile"
          ? "profiles"
          : resource_type === "document"
            ? "documents"
            : "licenses";

    const s3Key = `${folder}/${safeResourceId}/${uploadId}.${fileExtension}`;

    const command = new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: s3Key,
      ContentType: file_type,
      Metadata: {
        uploaded_by: String(userId),
        resource_type: String(resource_type),
        resource_id: String(safeResourceId),
      },
    });

    const presignedUrl = await getSignedUrl(s3Client, command, {
      expiresIn: 900,
    });

    const fileUrl = buildFileUrl(S3_BUCKET, s3Key);

    await pool.query(
      `
      INSERT INTO s3_uploads (
        uploader_id,
        s3_key,
        s3_url,
        file_name,
        file_type,
        resource_type,
        resource_id
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      `,
      [
        userId,
        s3Key,
        fileUrl,
        file_name,
        file_type,
        resource_type,
        resource_id || null,
      ],
    );

    return res.json({
      presigned_url: presignedUrl,
      s3_key: s3Key,
      s3_url: fileUrl,
      upload_id: uploadId,
      expires_in: 900,
      bucket: S3_BUCKET,
      cdn_enabled: Boolean(MEDIA_CDN_URL),
    });
  } catch (error) {
    console.error("S3 Presigned URL Error:", error);
    return res.status(500).json({ error: "Failed to generate presigned URL" });
  }
});

// ============================================================================
// 2. CONFIRM UPLOAD
// ============================================================================
router.post("/confirm-upload", async (req, res) => {
  try {
    const { s3_key, resource_type, resource_id } = req.body;
    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (!s3_key || !resource_type || !resource_id) {
      return res.status(400).json({
        error: "Missing required fields: s3_key, resource_type, resource_id",
      });
    }

    const uploadCheck = await pool.query(
      `
      SELECT id, s3_url
      FROM s3_uploads
      WHERE s3_key = $1
        AND uploader_id = $2
      LIMIT 1
      `,
      [s3_key, userId],
    );

    if (!uploadCheck.rows.length) {
      return res.status(404).json({ error: "Upload record not found" });
    }

    const { s3_url } = uploadCheck.rows[0];

    await pool.query(
      `
      UPDATE s3_uploads
      SET resource_id = $1
      WHERE s3_key = $2
        AND uploader_id = $3
      `,
      [resource_id, s3_key, userId],
    );

    return res.json({
      success: true,
      message: "Upload confirmed",
      s3_url,
      s3_key,
    });
  } catch (error) {
    console.error("Upload Confirmation Error:", error);
    return res.status(500).json({ error: "Failed to confirm upload" });
  }
});

// ============================================================================
// 3. GENERATE BULK URLS
// ============================================================================
router.post("/generate-bulk-urls", async (req, res) => {
  try {
    const { files, resource_type, resource_id } = req.body;
    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (!S3_BUCKET) {
      return res.status(500).json({ error: "AWS_S3_BUCKET is not configured" });
    }

    if (!Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: "Files array is required" });
    }

    if (files.length > 15) {
      return res.status(400).json({ error: "Maximum 15 files per batch" });
    }

    if (!validResourceTypes.includes(resource_type)) {
      return res.status(400).json({ error: "Invalid resource type" });
    }

    const presignedUrls = [];

    for (const file of files) {
      const { file_name, file_type } = file;

      if (!file_name || !file_type) {
        return res.status(400).json({
          error: "Each file must include file_name and file_type",
        });
      }

      if (!allowedTypes.includes(file_type)) {
        return res.status(400).json({
          error: `File type not allowed for ${file_name}`,
        });
      }

      const uploadId = uuidv4();
      const fileExtension = sanitizeExtension(file_name);
      const safeResourceId = resource_id || "temp";

      const folder =
        resource_type === "listing"
          ? "listings"
          : resource_type === "profile"
            ? "profiles"
            : resource_type === "document"
              ? "documents"
              : "licenses";

      const s3Key = `${folder}/${safeResourceId}/${uploadId}.${fileExtension}`;

      const command = new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: s3Key,
        ContentType: file_type,
        Metadata: {
          uploaded_by: String(userId),
          resource_type: String(resource_type),
          resource_id: String(safeResourceId),
        },
      });

      const presignedUrl = await getSignedUrl(s3Client, command, {
        expiresIn: 900,
      });

      const fileUrl = buildFileUrl(S3_BUCKET, s3Key);

      presignedUrls.push({
        file_name,
        file_type,
        s3_key: s3Key,
        presigned_url: presignedUrl,
        s3_url: fileUrl,
        upload_id: uploadId,
      });

      await pool.query(
        `
        INSERT INTO s3_uploads (
          uploader_id,
          s3_key,
          s3_url,
          file_name,
          file_type,
          resource_type,
          resource_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        `,
        [
          userId,
          s3Key,
          fileUrl,
          file_name,
          file_type,
          resource_type,
          resource_id || null,
        ],
      );
    }

    return res.json({
      success: true,
      urls: presignedUrls,
      expires_in: 900,
      bucket: S3_BUCKET,
      cdn_enabled: Boolean(MEDIA_CDN_URL),
    });
  } catch (error) {
    console.error("Bulk URL Generation Error:", error);
    return res.status(500).json({ error: "Failed to generate bulk URLs" });
  }
});

// ============================================================================
// 4. GET OBJECT PRESIGNED URL
// ============================================================================
router.get("/get-presigned-url", async (req, res) => {
  try {
    const { s3_key } = req.query;

    if (!s3_key) {
      return res.status(400).json({ error: "s3_key is required" });
    }

    const command = new GetObjectCommand({
      Bucket: S3_BUCKET,
      Key: s3_key,
    });

    const presignedUrl = await getSignedUrl(s3Client, command, {
      expiresIn: 3600,
    });

    return res.json({
      presigned_url: presignedUrl,
      s3_key,
    });
  } catch (error) {
    console.error("Get Presigned URL Error:", error);
    return res.status(500).json({ error: "Failed to generate download URL" });
  }
});

// ============================================================================
// 5. DELETE S3 OBJECT
// ============================================================================
router.delete("/delete", async (req, res) => {
  try {
    const { s3_key } = req.query;
    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (!s3_key) {
      return res.status(400).json({ error: "s3_key is required" });
    }

    const uploadRecord = await pool.query(
      `
      SELECT id, uploader_id
      FROM s3_uploads
      WHERE s3_key = $1
      LIMIT 1
      `,
      [s3_key],
    );

    if (!uploadRecord.rows.length) {
      return res.status(404).json({ error: "Upload not found" });
    }

    const { uploader_id } = uploadRecord.rows[0];

    if (String(uploader_id) !== String(userId)) {
      return res.status(403).json({
        error: "Unauthorized to delete this file",
      });
    }

    const deleteCommand = new DeleteObjectCommand({
      Bucket: S3_BUCKET,
      Key: s3_key,
    });

    await s3Client.send(deleteCommand);

    await pool.query(
      `
      DELETE FROM s3_uploads
      WHERE s3_key = $1
        AND uploader_id = $2
      `,
      [s3_key, userId],
    );

    return res.json({
      success: true,
      message: "File deleted successfully",
      s3_key,
    });
  } catch (error) {
    console.error("S3 Delete Error:", error);
    return res.status(500).json({ error: "Failed to delete file" });
  }
});

export default router;