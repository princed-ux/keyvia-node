import sharp from "sharp";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const AWS_REGION = process.env.AWS_REGION || "eu-west-1";
const S3_BUCKET = process.env.AWS_S3_BUCKET;
const MEDIA_CDN_URL = process.env.MEDIA_CDN_URL;

const s3 = new S3Client({
  region: AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const sizes = [
  { label: "small", width: 480 },
  { label: "medium", width: 960 },
  { label: "large", width: 1600 },
];

const streamToBuffer = async (stream) => {
  const chunks = [];

  for await (const chunk of stream) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
};

const buildCdnUrl = (key) => {
  if (!MEDIA_CDN_URL) {
    return `https://${S3_BUCKET}.s3.${AWS_REGION}.amazonaws.com/${key}`;
  }

  return `${MEDIA_CDN_URL.replace(/\/$/, "")}/${key}`;
};

const getFileNameWithoutExtension = (key) => {
  const file = key.split("/").pop() || "image";
  return file.replace(/\.[^.]+$/, "");
};

export const processListingImageToWebP = async ({
  originalKey,
  productId,
}) => {
  if (!S3_BUCKET) {
    throw new Error("Missing env: AWS_S3_BUCKET");
  }

  if (!originalKey || !productId) {
    throw new Error("originalKey and productId are required");
  }

  const object = await s3.send(
    new GetObjectCommand({
      Bucket: S3_BUCKET,
      Key: originalKey,
    }),
  );

  const inputBuffer = await streamToBuffer(object.Body);
  const baseName = getFileNameWithoutExtension(originalKey);

  const variants = {};

  for (const size of sizes) {
    const outputKey = `listings/${productId}/processed/${baseName}_${size.width}.webp`;

    const outputBuffer = await sharp(inputBuffer)
      .rotate()
      .resize({
        width: size.width,
        withoutEnlargement: true,
        fit: "inside",
      })
      .webp({
        quality: 82,
        effort: 5,
      })
      .toBuffer();

    await s3.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: outputKey,
        Body: outputBuffer,
        ContentType: "image/webp",
        CacheControl: "public, max-age=31536000, immutable",
        Metadata: {
          source_key: originalKey,
          product_id: String(productId),
          variant: size.label,
        },
      }),
    );

    variants[size.label] = {
      width: size.width,
      key: outputKey,
      url: buildCdnUrl(outputKey),
    };
  }

  return variants;
};