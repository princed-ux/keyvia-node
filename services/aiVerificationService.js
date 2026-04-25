import {
  RekognitionClient,
  DetectFacesCommand,
  CompareFacesCommand,
} from "@aws-sdk/client-rekognition";
import {
  TextractClient,
  DetectDocumentTextCommand,
} from "@aws-sdk/client-textract"; 

const REGION = "eu-west-1";

const rekognition = new RekognitionClient({
  region: REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const textract = new TextractClient({
  region: REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

async function safeAwsCall(fn, retries = 2, delayMs = 600) {
  try {
    return await fn();
  } catch (err) {
    if (retries <= 0) throw err;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return safeAwsCall(fn, retries - 1, delayMs);
  }
}

function parseS3Url(url) {
  if (!url) return null;

  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    const pathname = decodeURIComponent(parsed.pathname).replace(/^\/+/, "");

    // virtual-hosted-style:
    // https://keyvia-images.s3.eu-west-1.amazonaws.com/folder/file.jpg
    if (host.startsWith("keyvia-images.s3.")) {
      return {
        bucket: "keyvia-images",
        key: pathname,
      };
    }

    // generic virtual-hosted-style fallback
    if (host.includes(".s3.")) {
      const bucket = host.split(".s3")[0];
      return {
        bucket,
        key: pathname,
      };
    }

    // path-style:
    // https://s3.eu-west-1.amazonaws.com/keyvia-images/folder/file.jpg
    const parts = pathname.split("/");
    const bucket = parts.shift();
    const key = parts.join("/");

    if (!bucket || !key) return null; 

    return { bucket, key };
  } catch {
    return null;
  }
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function textIncludes(haystack, needle) {
  if (!haystack || !needle) return false;
  return normalizeText(haystack).includes(normalizeText(needle));
}

function nameMatches(documentText, fullName) {
  const hay = normalizeText(documentText);
  const words = normalizeText(fullName).split(" ").filter(Boolean);

  if (!hay || words.length === 0) return false;

  // Require all name parts of reasonable length to appear
  const importantWords = words.filter((w) => w.length >= 2);
  if (importantWords.length === 0) return false;

  return importantWords.every((w) => hay.includes(w));
}

async function detectFaceFromS3(s3Url) {
  const parsed = parseS3Url(s3Url);

  if (!parsed) {
    return { ok: false, reason: "Invalid S3 image URL" };
  }

  try {
    const result = await safeAwsCall(() =>
      rekognition.send(
        new DetectFacesCommand({
          Image: {
            S3Object: {
              Bucket: parsed.bucket,
              Name: parsed.key,
            },
          },
          Attributes: ["DEFAULT"],
        })
      )
    );

    const faceCount = result.FaceDetails?.length || 0;

    return {
      ok: faceCount > 0,
      faceCount,
      details: result.FaceDetails || [],
    };
  } catch (err) {
    return {
      ok: false,
      reason: `DetectFaces failed: ${err.message}`,
    };
  }
}

async function compareFacesFromS3(sourceUrl, targetUrl) {
  const source = parseS3Url(sourceUrl);
  const target = parseS3Url(targetUrl);

  if (!source || !target) {
    return {
      matched: false,
      similarity: 0,
      reason: "Invalid S3 image URL for face comparison",
    };
  }

  try {
    const result = await safeAwsCall(() =>
      rekognition.send(
        new CompareFacesCommand({
          SourceImage: {
            S3Object: {
              Bucket: source.bucket,
              Name: source.key,
            },
          },
          TargetImage: {
            S3Object: {
              Bucket: target.bucket,
              Name: target.key,
            },
          },
          SimilarityThreshold: 70,
        })
      )
    );

    const match = result.FaceMatches?.[0];

    return {
      matched: !!match,
      similarity: match?.Similarity || 0,
      unmatchedFaces: result.UnmatchedFaces?.length || 0,
    };
  } catch (err) {
    return {
      matched: false,
      similarity: 0,
      reason: `CompareFaces failed: ${err.message}`,
    };
  }
}

async function extractDocumentTextFromS3(s3Url) {
  const parsed = parseS3Url(s3Url);

  if (!parsed) {
    return { ok: false, text: "", reason: "Invalid S3 document URL" };
  }

  try {
    const result = await safeAwsCall(() =>
      textract.send(
        new DetectDocumentTextCommand({
          Document: {
            S3Object: {
              Bucket: parsed.bucket,
              Name: parsed.key,
            },
          },
        })
      )
    );

    const lines =
      result.Blocks?.filter((b) => b.BlockType === "LINE").map((b) => b.Text) ||
      [];

    return {
      ok: true,
      text: lines.join(" "),
      lines,
    };
  } catch (err) {
    return {
      ok: false,
      text: "",
      reason: `DetectDocumentText failed: ${err.message}`,
    };
  }
}

function buildVerificationScore({
  faceDetected,
  faceMatch,
  fullName,
  companyName,
  documentText,
  role,
}) {
  let score = 100;
  const flags = [];

  if (!faceDetected.ok) {
    score -= 60;
    flags.push(faceDetected.reason || "No face detected in profile image");
  }

  if (faceDetected.ok && faceDetected.faceCount > 1) {
    score -= 15;
    flags.push("Multiple faces detected in profile image");
  }

  if (faceMatch) {
    if (!faceMatch.matched) {
      score -= 35;
      flags.push(faceMatch.reason || "Profile face does not match document");
    } else if (faceMatch.similarity < 80) {
      score -= 15;
      flags.push(`Low face match confidence (${Math.round(faceMatch.similarity)}%)`);
    }
  }

  if (!documentText?.trim()) {
    score -= 20;
    flags.push("Document text extraction uncertain");
  } else {
    if (fullName && !nameMatches(documentText, fullName)) {
      score -= 20;
      flags.push("Submitted full name does not clearly match document");
    }

    if (
      role.includes("brokerage") &&
      companyName &&
      !textIncludes(documentText, companyName)
    ) {
      score -= 25;
      flags.push("Company name does not clearly match uploaded document");
    }
  }

  if (score < 0) score = 0;
  if (score > 100) score = 100;

  let verdict = "Manual Review Needed";

  if (score >= 90 && (!faceMatch || faceMatch.similarity >= 85)) {
    verdict = "Safe to Approve";
  } else if (score < 50) {
    verdict = "Auto-Reject";
  }

  return { score, flags, verdict };
}

export async function analyzeVerification(profile) {
  const report = {
    unique_id: profile.unique_id,
    score: 50,
    flags: [],
    verdict: "Manual Review Needed",
    face_detected: false,
    face_count: 0,
    face_match_score: 0,
    document_name_match: false,
    document_company_match: false,
    document_text_excerpt: "",
  };

  try {
    const avatarUrl = profile.avatar_url;
    const documentUrl = profile.document_url;

    const faceDetected = avatarUrl
      ? await detectFaceFromS3(avatarUrl)
      : { ok: false, reason: "Missing profile image" };

    const documentTextResult = documentUrl
      ? await extractDocumentTextFromS3(documentUrl)
      : { ok: false, text: "", reason: "Missing legal document" };

    let faceMatch = null;

    const lowerDoc = String(documentUrl || "").toLowerCase();
    const isImageDoc = /\.(jpg|jpeg|png|webp|jfif)(\?|$)/i.test(lowerDoc);

    if (avatarUrl && documentUrl && isImageDoc) {
      faceMatch = await compareFacesFromS3(avatarUrl, documentUrl);
    }

    const scoreData = buildVerificationScore({
      faceDetected,
      faceMatch,
      fullName: profile.full_name,
      companyName: profile.company_name,
      documentText: documentTextResult.text,
      role: String(profile.role || "").toLowerCase(),
    });

    report.score = scoreData.score;
    report.flags = scoreData.flags;
    report.verdict = scoreData.verdict;
    report.face_detected = !!faceDetected.ok;
    report.face_count = faceDetected.faceCount || 0;
    report.face_match_score = faceMatch?.similarity || 0;
    report.document_name_match = nameMatches(
      documentTextResult.text,
      profile.full_name
    );
    report.document_company_match = textIncludes(
      documentTextResult.text,
      profile.company_name
    );
    report.document_text_excerpt = (documentTextResult.text || "").slice(0, 500);

    return report;
  } catch (err) {
    console.error("[AI Verification] Error:", err);
    return {
      ...report,
      score: 50,
      verdict: "Manual Review Needed",
      flags: ["AWS verification service error"],
    };
  }
}

export async function analyzeVerificationBulk(profiles = []) {
  const CONCURRENCY = 5;

  const chunks = [];
  for (let i = 0; i < profiles.length; i += CONCURRENCY) {
    chunks.push(profiles.slice(i, i + CONCURRENCY));
  }

  const results = [];

  for (const chunk of chunks) {
    const res = await Promise.all(chunk.map((p) => analyzeVerification(p)));
    results.push(...res);
  }

  return results;
}