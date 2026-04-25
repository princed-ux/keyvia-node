import crypto from "crypto";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import {
  SQSClient,
  SendMessageCommand,
} from "@aws-sdk/client-sqs";

const AWS_REGION = process.env.AWS_REGION || "eu-west-1";

export const s3 = new S3Client({
  region: AWS_REGION,
});

export const sqs = new SQSClient({
  region: AWS_REGION,
});

const ORIGINAL_BUCKET = process.env.S3_ORIGINAL_BUCKET;
const PROCESSED_BUCKET = process.env.S3_PROCESSED_BUCKET;
const MEDIA_CDN_URL = process.env.MEDIA_CDN_URL;
const SQS_MEDIA_QUEUE_URL = process.env.SQS_MEDIA_QUEUE_URL;

export const createAssetId = (prefix = "asset") => {
  return `${prefix}_${crypto.randomUUID().split("-")[0]}`;
};

export const getFileExtension = (filename = "") => {
  const parts = filename.split(".");
  return parts.length > 1 ? parts.pop().toLowerCase() : "bin";
};

export const buildOriginalKey = ({
  listingProductId,
  assetId,
  originalName,
  type = "image",
}) => {
  const ext = getFileExtension(originalName);

  return `originals/listings/${listingProductId}/${type}/${assetId}.${ext}`;
};

export const buildProcessedImageKey = ({
  listingProductId,
  assetId,
  width,
}) => {
  return `listings/${listingProductId}/${assetId}_${width}.webp`;
};

export const buildCdnUrl = (key) => {
  const base = String(MEDIA_CDN_URL || "").replace(/\/$/, "");
  return `${base}/${key}`;
};

export const uploadOriginalToS3 = async ({
  file,
  key,
  contentType,
}) => {
  if (!ORIGINAL_BUCKET) {
    throw new Error("Missing env: S3_ORIGINAL_BUCKET");
  }

  await s3.send(
    new PutObjectCommand({
      Bucket: ORIGINAL_BUCKET,
      Key: key,
      Body: file.buffer,
      ContentType: contentType || file.mimetype || "application/octet-stream",
      Metadata: {
        originalName: file.originalname || "upload",
      },
    })
  );

  return {
    bucket: ORIGINAL_BUCKET,
    key,
  };
};

export const uploadProcessedToS3 = async ({
  body,
  key,
  contentType = "image/webp",
  cacheControl = "public, max-age=31536000, immutable",
}) => {
  if (!PROCESSED_BUCKET) {
    throw new Error("Missing env: S3_PROCESSED_BUCKET");
  }

  await s3.send(
    new PutObjectCommand({
      Bucket: PROCESSED_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: cacheControl,
    })
  );

  return {
    bucket: PROCESSED_BUCKET,
    key,
    url: buildCdnUrl(key),
  };
};

export const getOriginalObject = async ({ key }) => {
  if (!ORIGINAL_BUCKET) {
    throw new Error("Missing env: S3_ORIGINAL_BUCKET");
  }

  return s3.send(
    new GetObjectCommand({
      Bucket: ORIGINAL_BUCKET,
      Key: key,
    })
  );
};

export const queueMediaProcessingJob = async ({
  productId,
  listingDbId = null,
  uploadedById,
  images = [],
  video = null,
}) => {
  if (!SQS_MEDIA_QUEUE_URL) {
    throw new Error("Missing env: SQS_MEDIA_QUEUE_URL");
  }

  const payload = {
    type: "LISTING_MEDIA_PROCESSING",
    productId,
    listingDbId,
    uploadedById,
    images,
    video,
    createdAt: new Date().toISOString(),
  };

  await sqs.send(
    new SendMessageCommand({
      QueueUrl: SQS_MEDIA_QUEUE_URL,
      MessageBody: JSON.stringify(payload),
    })
  );

  return payload;
};

export const createImageUploadRecord = ({
  productId,
  file,
}) => {
  const assetId = createAssetId("img");

  const originalKey = buildOriginalKey({
    listingProductId: productId,
    assetId,
    originalName: file.originalname,
    type: "image",
  });

  return {
    public_id: assetId,
    type: "image",
    status: "queued",
    original_key: originalKey,
    original_name: file.originalname,
    mime_type: file.mimetype,
    variants: {},
  };
};

export const createVideoUploadRecord = ({
  productId,
  file,
}) => {
  const assetId = createAssetId("vid");

  const originalKey = buildOriginalKey({
    listingProductId: productId,
    assetId,
    originalName: file.originalname,
    type: "video",
  });

  return {
    public_id: assetId,
    type: "video",
    status: "uploaded",
    original_key: originalKey,
    original_name: file.originalname,
    mime_type: file.mimetype,
    url: buildCdnUrl(originalKey.replace(/^originals\//, "")),
  };
};