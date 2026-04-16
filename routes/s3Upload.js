// routes/s3Upload.js
// ============================================================================
// S3 PRESIGNED URL GENERATION
// Purpose: Generate secure presigned URLs for direct client-to-S3 uploads
// Prevents server load and enables fast uploads from browser
// ============================================================================

import express from 'express';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../db.js';

const router = express.Router();

// Initialize S3 Client
const s3Client = new S3Client({
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const S3_BUCKET = process.env.AWS_S3_BUCKET || 'keyvia-real-estate';

/**
 * ============================================================================
 * 1. GENERATE PRESIGNED URL FOR UPLOAD
 * ============================================================================
 * POST /api/s3/generate-presigned-url
 * 
 * Purpose: Generate a presigned URL that allows client-side upload to S3
 * 
 * Request Body:
 * {
 *   "file_name": "photo.jpg",
 *   "file_type": "image/jpeg",
 *   "resource_type": "listing", // listing, profile, document
 *   "resource_id": "uuid-here"  // Optional: ID of resource
 * }
 * 
 * Response:
 * {
 *   "presigned_url": "https://s3.amazonaws.com/...",
 *   "s3_key": "listings/uuid/photo.jpg",
 *   "s3_url": "https://keyvia.s3.amazonaws.com/listings/uuid/photo.jpg",
 *   "upload_id": "uuid"  // Track this for confirmation
 * }
 * ============================================================================
 */
router.post('/generate-presigned-url', async (req, res) => {
  try {
    const { file_name, file_type, resource_type, resource_id } = req.body;
    const userId = req.headers['x-user-id'] || req.user?.id;

    // Validation
    if (!file_name || !file_type || !resource_type) {
      return res.status(400).json({
        error: 'Missing required fields: file_name, file_type, resource_type',
      });
    }

    // Security: Validate file type
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'];
    if (!allowedTypes.includes(file_type)) {
      return res.status(400).json({
        error: 'File type not allowed. Allowed types: images (JPEG, PNG, WebP, GIF) and PDFs',
      });
    }

    // Security: Validate resource type
    const validResourceTypes = ['listing', 'profile', 'document', 'license'];
    if (!validResourceTypes.includes(resource_type)) {
      return res.status(400).json({
        error: 'Invalid resource type',
      });
    }

    // Generate unique key
    const uploadId = uuidv4();
    const fileExtension = file_name.split('.').pop();
    const s3Key = `${resource_type}s/${resource_id || 'temp'}/${uploadId}.${fileExtension}`;

    // S3 Presigned URL (valid for 15 minutes)
    const command = new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: s3Key,
      ContentType: file_type,
      Metadata: {
        'uploaded-by': userId,
        'resource-type': resource_type,
        'resource-id': resource_id || 'temp',
      },
    });

    const presignedUrl = await getSignedUrl(s3Client, command, { expiresIn: 900 }); // 15 min

    // Store upload record in database for tracking
    const s3Url = `https://${S3_BUCKET}.s3.amazonaws.com/${s3Key}`;
    
    await pool.query(
      `INSERT INTO s3_uploads (uploaded_by, file_name, file_type, s3_bucket, s3_key, s3_url, resource_type, resource_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [userId, file_name, file_type, S3_BUCKET, s3Key, s3Url, resource_type, resource_id || null]
    );

    res.json({
      presigned_url: presignedUrl,
      s3_key: s3Key,
      s3_url: s3Url,
      upload_id: uploadId,
      expires_in: 900, // 15 minutes
      bucket: S3_BUCKET,
    });
  } catch (error) {
    console.error('❌ S3 Presigned URL Error:', error);
    res.status(500).json({ error: 'Failed to generate presigned URL' });
  }
});

/**
 * ============================================================================
 * 2. CONFIRM UPLOAD (After client completes upload to S3)
 * ============================================================================
 * POST /api/s3/confirm-upload
 * 
 * Purpose: Confirm that upload was successful and finalize in database
 * 
 * Request Body:
 * {
 *   "s3_key": "listings/uuid/photo.jpg",
 *   "resource_type": "listing",
 *   "resource_id": "uuid-of-listing"
 * }
 * ============================================================================
 */
router.post('/confirm-upload', async (req, res) => {
  try {
    const { s3_key, resource_type, resource_id } = req.body;
    const userId = req.headers['x-user-id'] || req.user?.id;

    if (!s3_key || !resource_type || !resource_id) {
      return res.status(400).json({
        error: 'Missing required fields: s3_key, resource_type, resource_id',
      });
    }

    // Verify upload exists and belongs to user
    const uploadCheck = await pool.query(
      `SELECT id, s3_url FROM s3_uploads WHERE s3_key = $1 AND uploaded_by = $2`,
      [s3_key, userId]
    );

    if (uploadCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Upload record not found' });
    }

    const { s3_url } = uploadCheck.rows[0];

    // Update upload status
    await pool.query(
      `UPDATE s3_uploads SET upload_status = $1, resource_id = $2 
       WHERE s3_key = $3`,
      ['completed', resource_id, s3_key]
    );

    res.json({
      success: true,
      message: 'Upload confirmed',
      s3_url: s3_url,
      s3_key: s3_key,
    });
  } catch (error) {
    console.error('❌ Upload Confirmation Error:', error);
    res.status(500).json({ error: 'Failed to confirm upload' });
  }
});

/**
 * ============================================================================
 * 3. BULK PRESIGNED URLS (For multiple files)
 * ============================================================================
 * POST /api/s3/generate-bulk-urls
 * 
 * Purpose: Generate multiple presigned URLs for batch uploads
 * 
 * Request Body:
 * {
 *   "files": [
 *     { "file_name": "photo1.jpg", "file_type": "image/jpeg" },
 *     { "file_name": "photo2.jpg", "file_type": "image/jpeg" }
 *   ],
 *   "resource_type": "listing",
 *   "resource_id": "uuid"
 * }
 * ============================================================================
 */
router.post('/generate-bulk-urls', async (req, res) => {
  try {
    const { files, resource_type, resource_id } = req.body;
    const userId = req.headers['x-user-id'] || req.user?.id;

    if (!Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: 'Files array is required' });
    }

    if (files.length > 10) {
      return res.status(400).json({ error: 'Maximum 10 files per batch' });
    }

    const presignedUrls = [];

    for (const file of files) {
      const { file_name, file_type } = file;

      // Generate S3 key and presigned URL
      const uploadId = uuidv4();
      const fileExtension = file_name.split('.').pop();
      const s3Key = `${resource_type}s/${resource_id}/${uploadId}.${fileExtension}`;

      const command = new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: s3Key,
        ContentType: file_type,
      });

      const presignedUrl = await getSignedUrl(s3Client, command, { expiresIn: 900 });
      const s3Url = `https://${S3_BUCKET}.s3.amazonaws.com/${s3Key}`;

      presignedUrls.push({
        file_name,
        s3_key: s3Key,
        presigned_url: presignedUrl,
        s3_url: s3Url,
        upload_id: uploadId,
      });

      // Store in database
      await pool.query(
        `INSERT INTO s3_uploads (uploaded_by, file_name, file_type, s3_bucket, s3_key, s3_url, resource_type, resource_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [userId, file_name, file_type, S3_BUCKET, s3Key, s3Url, resource_type, resource_id]
      );
    }

    res.json({
      success: true,
      urls: presignedUrls,
      expires_in: 900,
    });
  } catch (error) {
    console.error('❌ Bulk URL Generation Error:', error);
    res.status(500).json({ error: 'Failed to generate bulk URLs' });
  }
});

/**
 * ============================================================================
 * 4. GET OBJECT PRESIGNED URL (For downloading/viewing files)
 * ============================================================================
 * GET /api/s3/get-presigned-url?s3_key=...
 * ============================================================================
 */
router.get('/get-presigned-url', async (req, res) => {
  try {
    const { s3_key } = req.query;

    if (!s3_key) {
      return res.status(400).json({ error: 's3_key is required' });
    }

    const command = new GetObjectCommand({
      Bucket: S3_BUCKET,
      Key: s3_key,
    });

    const presignedUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 }); // 1 hour

    res.json({
      presigned_url: presignedUrl,
      s3_key: s3_key,
    });
  } catch (error) {
    console.error('❌ Get Presigned URL Error:', error);
    res.status(500).json({ error: 'Failed to generate download URL' });
  }
});

/**
 * ============================================================================
 * 5. DELETE S3 OBJECT (Admin only)
 * ============================================================================
 * DELETE /api/s3/delete?s3_key=...
 * ============================================================================
 */
router.delete('/delete', async (req, res) => {
  try {
    const { s3_key } = req.query;
    const userId = req.headers['x-user-id'] || req.user?.id;

    if (!s3_key) {
      return res.status(400).json({ error: 's3_key is required' });
    }

    // Verify user owns this upload
    const uploadRecord = await pool.query(
      `SELECT id, uploaded_by FROM s3_uploads WHERE s3_key = $1`,
      [s3_key]
    );

    if (uploadRecord.rows.length === 0) {
      return res.status(404).json({ error: 'Upload not found' });
    }

    // Check authorization (user must own or be admin)
    const { uploaded_by } = uploadRecord.rows[0];
    if (uploaded_by !== userId) {
      return res.status(403).json({ error: 'Unauthorized to delete this file' });
    }

    // Delete from S3
    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
    const deleteCommand = new DeleteObjectCommand({
      Bucket: S3_BUCKET,
      Key: s3_key,
    });

    await s3Client.send(deleteCommand);

    // Update database
    await pool.query(
      `UPDATE s3_uploads SET upload_status = $1 WHERE s3_key = $2`,
      ['deleted', s3_key]
    );

    res.json({
      success: true,
      message: 'File deleted successfully',
      s3_key: s3_key,
    });
  } catch (error) {
    console.error('❌ S3 Delete Error:', error);
    res.status(500).json({ error: 'Failed to delete file' });
  }
});

export default router;
