// middleware/upload.js
import multer from "multer";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { randomUUID } from "crypto";
import path from "path";

const AWS_REGION = process.env.AWS_REGION || "eu-west-1";
const AWS_S3_BUCKET = process.env.AWS_S3_BUCKET;
const MEDIA_CDN_URL = process.env.MEDIA_CDN_URL || "";

export const s3 = new S3Client({
  region: AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const storage = multer.memoryStorage();

const allowedMimeTypes = [
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

const allowedExtensions = [
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".gif",
  ".pdf",
  ".mp4",
  ".webm",
  ".mov",
];

export const upload = multer({
  storage,
  limits: {
    fileSize: 25 * 1024 * 1024,
  },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();

    if (allowedMimeTypes.includes(file.mimetype) || allowedExtensions.includes(ext)) {
      cb(null, true);
    } else {
      cb(
        new Error(
          "File type not allowed. Use JPG, PNG, WEBP, GIF, PDF, MP4, WEBM, or MOV.",
        ),
        false,
      );
    }
  },
});

const buildCdnUrl = (key) => {
  if (!MEDIA_CDN_URL) return null;
  return `${MEDIA_CDN_URL.replace(/\/$/, "")}/${key}`;
};

export const uploadToS3 = async (file, folder = "general", options = {}) => {
  if (!AWS_S3_BUCKET) {
    throw new Error("Missing env: AWS_S3_BUCKET");
  }

  const ext = path.extname(file.originalname).toLowerCase() || ".bin";
  const key = `${folder}/${randomUUID()}${ext}`;

  const command = new PutObjectCommand({
    Bucket: AWS_S3_BUCKET,
    Key: key,
    Body: file.buffer,
    ContentType: file.mimetype || "application/octet-stream",
    CacheControl:
      options.cacheControl ||
      (file.mimetype?.startsWith("image/") || file.mimetype?.startsWith("video/")
        ? "public, max-age=31536000, immutable"
        : "private, max-age=0, no-cache"),
    Metadata: {
      original_name: file.originalname || "upload",
      visibility: options.visibility || "public",
    },
  });

  await s3.send(command);

  return {
    bucket: AWS_S3_BUCKET,
    key,
    url: options.visibility === "private" ? null : buildCdnUrl(key),
  };
};