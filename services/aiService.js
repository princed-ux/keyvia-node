import axios from "axios";
import {
  RekognitionClient,
  DetectModerationLabelsCommand,
  DetectLabelsCommand,
} from "@aws-sdk/client-rekognition";

const rekognition = new RekognitionClient({
  region: process.env.AWS_REGION || "us-east-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const SUSPICIOUS_LABELS = new Set([
  "weapon", "gun", "knife", "drug", "alcohol", "cigarette",
  "money", "cash", "credit card",
]);

const PROPERTY_LABELS = new Set([
  "house", "building", "apartment", "real estate", "property",
  "home", "condominium", "villa", "townhouse", "room",
  "kitchen", "bathroom", "bedroom", "living room", "dining room",
  "garage", "pool", "swimming pool", "garden", "yard",
  "floor", "wall", "window", "door", "roof",
  "furniture", "interior design", "architecture",
]);

async function analyzeImage(buffer) {
  const results = { moderation: [], labels: [] };

  try {
    const modCmd = new DetectModerationLabelsCommand({
      Image: { Bytes: buffer },
      MinConfidence: 70,
    });
    const modRes = await rekognition.send(modCmd);
    results.moderation = modRes.ModerationLabels || [];
  } catch (err) {
    if (err.name === "InvalidImageFormatException") throw err;
    console.error("Rekognition moderation error:", err.message);
  }

  try {
    const labelCmd = new DetectLabelsCommand({
      Image: { Bytes: buffer },
      MaxLabels: 20,
      MinConfidence: 60,
    });
    const labelRes = await rekognition.send(labelCmd);
    results.labels = labelRes.Labels || [];
  } catch (err) {
    if (err.name === "InvalidImageFormatException") throw err;
    console.error("Rekognition labels error:", err.message);
  }

  return results;
}

function scoreResults(results) {
  const flags = [];
  let score = 100;

  for (const label of results.moderation) {
    const name = (label.Name || "").toLowerCase();
    const confidence = label.Confidence || 0;
    flags.push(`Moderation: ${name} (${confidence.toFixed(0)}%)`);
    score -= 30;
  }

  const labelNames = results.labels.map((l) => (l.Name || "").toLowerCase());

  for (const name of labelNames) {
    if (SUSPICIOUS_LABELS.has(name)) {
      flags.push(`Suspicious content detected: ${name}`);
      score -= 25;
    }
  }

  const hasPropertyLabel = labelNames.some((n) => PROPERTY_LABELS.has(n));
  if (!hasPropertyLabel && results.labels.length > 0) {
    flags.push("No property-related content detected in images");
    score -= 15;
  }

  return { score: Math.max(0, score), flags };
}

const VALID_IMAGE_TYPES = new Set([
  "image/jpeg", "image/png", "image/webp", "image/bmp",
]);

const IMAGE_SIGNATURES = {
  "image/jpeg": [[0xFF, 0xD8, 0xFF]],
  "image/png": [[0x89, 0x50, 0x4E, 0x47]],
  "image/webp": [[0x52, 0x49, 0x46, 0x46]],
  "image/bmp": [[0x42, 0x4D]],
};

function isValidImageBuffer(buffer) {
  if (buffer.length < 4) return false;
  const firstBytes = Array.from(buffer.slice(0, 8));
  for (const sigs of Object.values(IMAGE_SIGNATURES)) {
    for (const sig of sigs) {
      if (sig.every((b, i) => firstBytes[i] === b)) return true;
    }
  }
  return false;
}

export const analyzeListingWithPython = async (photoUrls, _title, _description, _propertyType) => {
  try {
    let filesAnalyzed = 0;
    const maxPhotos = Math.min(photoUrls.length, 5);
    const allFlags = [];

    for (let i = 0; i < maxPhotos; i++) {
      const url = photoUrls[i]?.url || photoUrls[i];
      if (!url) continue;

      try {
        const imgRes = await axios.get(url, {
          responseType: "arraybuffer",
          timeout: 15000,
          headers: { "User-Agent": "KeyviaBot/1.0" },
          validateStatus: (status) => status === 200,
        });

        const contentType = imgRes.headers["content-type"] || "";
        if (!VALID_IMAGE_TYPES.has(contentType)) {
          console.error(`Image ${i}: invalid content-type "${contentType}" for ${url}`);
          allFlags.push(`Image ${i}: unsupported format (${contentType})`);
          continue;
        }

        const buffer = Buffer.from(imgRes.data);
        if (buffer.length < 100) {
          console.error(`Image ${i}: too small (${buffer.length} bytes)`);
          continue;
        }

        if (!isValidImageBuffer(buffer)) {
          console.error(`Image ${i}: invalid image signature for ${url}`);
          allFlags.push(`Image ${i}: invalid image data`);
          continue;
        }

        const results = await analyzeImage(buffer);
        const { score: imgScore, flags: imgFlags } = scoreResults(results);

        allFlags.push(...imgFlags);
        filesAnalyzed++;
      } catch (err) {
        if (err.name === "InvalidImageFormatException") {
          allFlags.push(`Image ${i}: Rekognition rejected format`);
          continue;
        }
        console.error(`Failed to download image ${i}: ${err.message}`);
      }
    }

    if (filesAnalyzed === 0) {
      return {
        score: 0,
        flags: ["System could not access listing photos (Download Failed)."],
        verdict: "Rejected",
        details: { image_check: "failed" },
      };
    }

    const avgScore = Math.max(0, 100 - allFlags.length * 15);
    const hasModerationFlag = allFlags.some((f) => f.startsWith("Moderation:"));

    return {
      score: hasModerationFlag ? Math.min(avgScore, 30) : avgScore,
      flags: allFlags,
      verdict: hasModerationFlag ? "Rejected" : avgScore >= 60 ? "Approved" : "Manual Review",
      details: { image_check: hasModerationFlag ? "failed" : "passed" },
    };
  } catch (err) {
    console.error("Rekognition AI Error:", err.message);
    return {
      score: 0,
      flags: [`AI Service Error: ${err.message}`],
      verdict: "Manual Review",
      details: { image_check: "failed" },
    };
  }
};

export const analyzeVideoWithPython = async (_videoUrl) => {
  return { valid: true, score: 0, reason: "Video analysis skipped (not yet supported)" };
};
