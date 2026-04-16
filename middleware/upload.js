// middleware/upload.js
import multer from "multer";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { randomUUID } from "crypto";
import path from "path";

/* ======================================================
   🪣 S3 CLIENT
====================================================== */
export const s3 = new S3Client({
  region: "eu-west-3", // Hardcode it here or use a specific S3_REGION env var
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

/* ======================================================
   📁 MULTER (memory storage — same as before)
====================================================== */
const storage = multer.memoryStorage();

export const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    // 1. Define allowed mimetypes
    const allowedMimeTypes = [
      "image/jpeg",
      "image/jpg",
      "image/png",
      "image/webp",
      "application/pdf"
    ];

    // 2. Define allowed extensions (as a backup)
    const allowedExtensions = [".jpg", ".jpeg", ".png", ".webp", ".pdf"];
    const ext = path.extname(file.originalname).toLowerCase();

    // Check if EITHER the mimetype is correct OR the extension is correct
    if (allowedMimeTypes.includes(file.mimetype) || allowedExtensions.includes(ext)) {
      cb(null, true);
    } else {
      // We pass the error message exactly as you had it
      cb(new Error("File type not allowed. Use JPG, PNG, WEBP, or PDF."), false);
    }
  },
});

/* ======================================================
   🚀 UPLOAD BUFFER TO S3
   Call this manually inside any controller after multer runs.
   Returns the public URL of the uploaded file.
====================================================== */
export const uploadToS3 = async (file, folder = "general") => {
  const ext = path.extname(file.originalname).toLowerCase();
  const key = `${folder}/${randomUUID()}${ext}`;

  const command = new PutObjectCommand({
    Bucket: process.env.AWS_S3_BUCKET,
    Key: key,
    Body: file.buffer,
    ContentType: file.mimetype,
    ACL: "public-read",
  });

  await s3.send(command);

  // Returns the public URL
  return `https://${process.env.AWS_S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;
};