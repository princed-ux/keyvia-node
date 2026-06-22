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

const publicResourceTypes = ["listing", "profile", "message_attachment"];
const privateResourceTypes = ["document", "license"];
const validResourceTypes = [...publicResourceTypes, ...privateResourceTypes];

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

const imageTypes = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
];

const videoTypes = ["video/mp4", "video/webm", "video/quicktime"];

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const isUuid = (value) => {
  return typeof value === "string" && UUID_RE.test(value.trim());
};

const normalizeUuidOrNull = (value) => {
  if (!value) return null;

  const v = String(value).trim();

  if (!v || v === "temp") return null;

  return isUuid(v) ? v : null;
};

const normalizeProductIdOrNull = (value) => {
  if (!value) return null;

  const v = String(value).trim();

  if (!v || v === "temp") return null;

  return isUuid(v) ? null : v;
};

const isPrivateResource = (resourceType) => {
  return privateResourceTypes.includes(resourceType);
};

const sanitizeExtension = (fileName = "") => {
  const ext = fileName.includes(".") ? fileName.split(".").pop() : "bin";

  return String(ext || "bin")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "") || "bin";
};

const buildPublicFileUrl = (key) => {
  if (!MEDIA_CDN_URL) {
    return `https://${S3_BUCKET}.s3.${AWS_REGION}.amazonaws.com/${key}`;
  }

  return `${MEDIA_CDN_URL.replace(/\/$/, "")}/${key}`;
};


const buildPrivateStorageUrl = (key) => {
  return `s3://${S3_BUCKET}/${key}`;
};

const getStoredFileUrl = (key, privateFile) => {
  return privateFile ? buildPrivateStorageUrl(key) : buildPublicFileUrl(key);
};

const getResponseFileUrl = (storedFileUrl, privateFile) => {
  return privateFile ? null : storedFileUrl;
};



const getFolder = (resourceType) => {
  if (resourceType === "listing") return "listings";
  if (resourceType === "profile") return "profiles";
  if (resourceType === "message_attachment") return "messages";
  if (resourceType === "document") return "private/documents";
  if (resourceType === "license") return "private/licenses";

  return "general";
};

const buildS3Key = ({ fileName, resourceType, folderId }) => {
  const uploadId = uuidv4();
  const fileExtension = sanitizeExtension(fileName);
  const safeFolderId = folderId || "temp";
  const folder = getFolder(resourceType);

  return `${folder}/${safeFolderId}/${uploadId}.${fileExtension}`;
};

const getCacheControl = (fileType, privateFile) => {
  if (privateFile) return "private, max-age=0, no-cache";

  if (imageTypes.includes(fileType) || videoTypes.includes(fileType)) {
    return "public, max-age=31536000, immutable";
  }

  return "public, max-age=86400";
};

const getSafeFolderId = ({
  productId,
  draftListingId,
  listingUuid,
  resourceId,
}) => {
  return (
    productId ||
    draftListingId ||
    listingUuid ||
    resourceId ||
    "temp"
  );
};

const insertUploadRecord = async ({
  userId,
  s3Key,
  fileUrl,
  fileName,
  fileType,
  resourceType,
  resourceId,
  productId,
  draftListingId,
  listingUuid,
  visibility,
}) => {
  const normalizedResourceId = normalizeUuidOrNull(resourceId);
  const normalizedListingUuid = normalizeUuidOrNull(listingUuid);

  const normalizedProductId =
    productId ||
    draftListingId ||
    normalizeProductIdOrNull(resourceId);

  const result = await pool.query(
    `
    INSERT INTO s3_uploads (
      uploader_id,
      s3_key,
      s3_url,
      file_name,
      file_type,
      resource_type,
      resource_id,
      product_id,
      draft_listing_id,
      listing_uuid,
      visibility
    )
    VALUES (
      $1::uuid,
      $2,
      $3,
      $4,
      $5,
      $6,
      $7::uuid,
      $8,
      $9,
      $10::uuid,
      $11
    )
    RETURNING id, s3_url, s3_key, visibility
    `,
    [
      userId,
      s3Key,
      fileUrl,
      fileName,
      fileType,
      resourceType,
      normalizedResourceId,
      normalizedProductId,
      draftListingId || normalizedProductId,
      normalizedListingUuid,
      visibility,
    ],
  );

  return result.rows[0];
};

router.post("/generate-presigned-url", async (req, res) => {
  try {
    const {
      file_name,
      file_type,
      resource_type,
      resource_id,
      product_id,
      draft_listing_id,
      listing_uuid,
    } = req.body;

    const userId = getUserId(req);

    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    if (!S3_BUCKET) {
      return res.status(500).json({
        error: "AWS_S3_BUCKET is not configured",
      });
    }

    if (!file_name || !file_type || !resource_type) {
      return res.status(400).json({
        error: "Missing required fields: file_name, file_type, resource_type",
      });
    }

    if (!allowedTypes.includes(file_type)) {
      return res.status(400).json({
        error: "File type not allowed. Allowed types: images, videos, and PDFs.",
      });
    }

    if (!validResourceTypes.includes(resource_type)) {
      return res.status(400).json({ error: "Invalid resource type" });
    }

    const privateFile = isPrivateResource(resource_type);
    const visibility = privateFile ? "private" : "public";

    const safeFolderId = getSafeFolderId({
      productId: product_id,
      draftListingId: draft_listing_id,
      listingUuid: listing_uuid,
      resourceId: resource_id,
    });

    const s3Key = buildS3Key({
      fileName: file_name,
      resourceType: resource_type,
      folderId: safeFolderId,
    });

    const command = new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: s3Key,
      ContentType: file_type,
      CacheControl: getCacheControl(file_type, privateFile),
      Metadata: {
        uploaded_by: String(userId),
        resource_type: String(resource_type),
        resource_id: String(resource_id || ""),
        product_id: String(product_id || draft_listing_id || ""),
        draft_listing_id: String(draft_listing_id || product_id || ""),
        listing_uuid: String(listing_uuid || ""),
        visibility,
      },
    });

    const presignedUrl = await getSignedUrl(s3Client, command, {
      expiresIn: 900,
    });

    const storedFileUrl = getStoredFileUrl(s3Key, privateFile);
const responseFileUrl = getResponseFileUrl(storedFileUrl, privateFile);

const uploadRecord = await insertUploadRecord({
  userId,
  s3Key,
  fileUrl: storedFileUrl,
  fileName: file_name,
  fileType: file_type,
  resourceType: resource_type,
  resourceId: resource_id,
  productId: product_id,
  draftListingId: draft_listing_id,
  listingUuid: listing_uuid,
  visibility,
});

return res.json({
  success: true,
  presigned_url: presignedUrl,
  s3_key: s3Key,

  // Public files get CDN/public URL. Private files return null.
  s3_url: responseFileUrl,

  // This is now the real DB upload row ID.
  upload_id: uploadRecord.id,

  expires_in: 900,
  bucket: S3_BUCKET,
  visibility,
  cdn_enabled: Boolean(MEDIA_CDN_URL),
});
  } catch (error) {
    console.error("S3 Presigned URL Error:", error);
    return res.status(500).json({
      error: "Failed to generate presigned URL",
      details: error?.message,
    });
  }
});

router.post("/generate-bulk-urls", async (req, res) => {
  try {
    const {
      files,
      resource_type,
      resource_id,
      product_id,
      draft_listing_id,
      listing_uuid,
    } = req.body;

    const userId = getUserId(req);

    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    if (!S3_BUCKET) {
      return res.status(500).json({
        error: "AWS_S3_BUCKET is not configured",
      });
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

    const privateFile = isPrivateResource(resource_type);
    const visibility = privateFile ? "private" : "public";

    const safeFolderId = getSafeFolderId({
      productId: product_id,
      draftListingId: draft_listing_id,
      listingUuid: listing_uuid,
      resourceId: resource_id,
    });

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

      const s3Key = buildS3Key({
        fileName: file_name,
        resourceType: resource_type,
        folderId: safeFolderId,
      });

      const command = new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: s3Key,
        ContentType: file_type,
        CacheControl: getCacheControl(file_type, privateFile),
        Metadata: {
          uploaded_by: String(userId),
          resource_type: String(resource_type),
          resource_id: String(resource_id || ""),
          product_id: String(product_id || draft_listing_id || ""),
          draft_listing_id: String(draft_listing_id || product_id || ""),
          listing_uuid: String(listing_uuid || ""),
          visibility,
        },
      });

      const presignedUrl = await getSignedUrl(s3Client, command, {
        expiresIn: 900,
      });

      const fileUrl = privateFile ? null : buildPublicFileUrl(s3Key);

      presignedUrls.push({
        file_name,
        file_type,
        s3_key: s3Key,
        presigned_url: presignedUrl,
        s3_url: fileUrl,
        upload_id: uuidv4(),
        visibility,
      });

      await insertUploadRecord({
        userId,
        s3Key,
        fileUrl,
        fileName: file_name,
        fileType: file_type,
        resourceType: resource_type,
        resourceId: resource_id,
        productId: product_id,
        draftListingId: draft_listing_id,
        listingUuid: listing_uuid,
        visibility,
      });
    }

    return res.json({
      success: true,
      urls: presignedUrls,
      expires_in: 900,
      bucket: S3_BUCKET,
      visibility,
      cdn_enabled: Boolean(MEDIA_CDN_URL),
    });
  } catch (error) {
    console.error("Bulk URL Generation Error:", error);
    return res.status(500).json({
      error: "Failed to generate bulk URLs",
      details: error?.message,
    });
  }
});

router.post("/confirm-upload", async (req, res) => {
  try {
    const {
      s3_key,
      resource_type,
      resource_id,
      product_id,
      draft_listing_id,
      listing_uuid,
    } = req.body;

    const userId = getUserId(req);

    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    if (!s3_key || !resource_type || (!resource_id && !product_id && !draft_listing_id)) {
      return res.status(400).json({
        error:
          "Missing required fields: s3_key, resource_type, and one of resource_id/product_id/draft_listing_id",
      });
    }

    const uploadCheck = await pool.query(
      `
      SELECT id, s3_url, visibility
      FROM s3_uploads
      WHERE s3_key = $1
        AND uploader_id = $2::uuid
      LIMIT 1
      `,
      [s3_key, userId],
    );

    if (!uploadCheck.rows.length) {
      return res.status(404).json({ error: "Upload record not found" });
    }

    const { s3_url, visibility } = uploadCheck.rows[0];

    const normalizedProductId =
      product_id ||
      draft_listing_id ||
      normalizeProductIdOrNull(resource_id);

    await pool.query(
      `
      UPDATE s3_uploads
      SET
        resource_id = $1::uuid,
        product_id = COALESCE($2, product_id),
        draft_listing_id = COALESCE($3, draft_listing_id),
        listing_uuid = COALESCE($4::uuid, listing_uuid)
      WHERE s3_key = $5
        AND uploader_id = $6::uuid
      `,
      [
        normalizeUuidOrNull(resource_id),
        normalizedProductId,
        draft_listing_id || normalizedProductId,
        normalizeUuidOrNull(listing_uuid),
        s3_key,
        userId,
      ],
    );

    return res.json({
      success: true,
      message: "Upload confirmed",
      s3_url,
      s3_key,
      visibility,
    });
  } catch (error) {
    console.error("Upload Confirmation Error:", error);
    return res.status(500).json({
      error: "Failed to confirm upload",
      details: error?.message,
    });
  }
});

router.get("/get-presigned-url", async (req, res) => {
  try {
    const { s3_key } = req.query;
    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (!s3_key) {
      return res.status(400).json({ error: "s3_key is required" });
    }

    const normalizedKey = String(s3_key).trim();

    const isAdmin =
      req.user?.is_admin === true ||
      req.user?.is_super_admin === true ||
      String(req.user?.role || "").toLowerCase() === "admin" ||
      String(req.user?.role || "").toLowerCase() === "super_admin" ||
      String(req.user?.role || "").toLowerCase() === "superadmin";

    const uploadRecord = await pool.query(
      `
      SELECT uploader_id, resource_type, visibility
      FROM s3_uploads
      WHERE s3_key = $1
      LIMIT 1
      `,
      [normalizedKey],
    );

    const record = uploadRecord.rows[0];

    if (record) {
      if (record.visibility !== "private") {
        return res.status(400).json({
          error: "This file is public. Use its CDN URL instead.",
        });
      }

      const isPrivateDocument =
        record.visibility === "private" &&
        ["document", "license"].includes(record.resource_type);

      if (isPrivateDocument && !isAdmin) {
        return res.status(403).json({
          error: "Only admins can access private verification documents",
        });
      }

      if (
        !isPrivateDocument &&
        String(record.uploader_id) !== String(userId) &&
        !isAdmin
      ) {
        return res.status(403).json({
          error: "Unauthorized to access this file",
        });
      }
    } else {
      const looksLikeVerificationDoc =
        normalizedKey.startsWith("documents/") ||
        normalizedKey.startsWith("private/documents/") ||
        normalizedKey.startsWith("private/licenses/");

      if (!isAdmin || !looksLikeVerificationDoc) {
        return res.status(404).json({ error: "Upload not found" });
      }
    }

    const command = new GetObjectCommand({
      Bucket: S3_BUCKET,
      Key: normalizedKey,
    });

    const presignedUrl = await getSignedUrl(s3Client, command, {
      expiresIn: 600,
    });

    return res.json({
      presigned_url: presignedUrl,
      s3_key: normalizedKey,
      expires_in: 600,
    });
  } catch (error) {
    console.error("Get Presigned URL Error:", error);
    return res.status(500).json({
      error: "Failed to generate download URL",
      details: error?.message,
    });
  }
});

router.delete("/delete", async (req, res) => {
  try {
    const { s3_key } = req.query;
    const userId = getUserId(req);

    if (!userId) return res.status(401).json({ error: "Unauthorized" });

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

    await s3Client.send(
      new DeleteObjectCommand({
        Bucket: S3_BUCKET,
        Key: s3_key,
      }),
    );

    await pool.query(
      `
      DELETE FROM s3_uploads
      WHERE s3_key = $1
        AND uploader_id = $2::uuid
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
    return res.status(500).json({
      error: "Failed to delete file",
      details: error?.message,
    });
  }
});

export default router;