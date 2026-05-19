import { pool } from "../db.js";

const RISK = {
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
};

const toNumber = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const hasText = (value, min = 1) =>
  typeof value === "string" && value.trim().length >= min;

const SCAM_WORDS = [
  "wire transfer", "western union", "money gram", "no show needed",
  "owner abroad", "below market", "too good to be true", "act now",
  "guaranteed return", "100% financing", "no credit check",
  "cash only deal", "send money first", "urgent liquidation",
];

const OFFENSIVE_WORDS = [
  "nigga", "nigger", "faggot", "retard", "spic", "chink",
  "kike", "gook", "wetback", "raghead", "camel jockey",
  "paki", "sand nigger", "beaner",
];

const containsAny = (text, words) => {
  if (!text) return [];
  const lower = text.toLowerCase();
  return words.filter(w => lower.includes(w));
};

export const evaluateListingRisk = async ({ listing, user, userHistory }) => {
  const flags = [];
  let score = 0;

  const latitude = toNumber(listing.latitude);
  const longitude = toNumber(listing.longitude);
  const price = toNumber(listing.price);

  // ── Title checks ──
  if (!hasText(listing.title, 5)) {
    score += 15;
    flags.push({ code: "SHORT_TITLE", label: "Title is too short.", severity: "medium" });
  }

  // ── Scam wording check ──
  const scamWords = containsAny(
    [listing.title, listing.description].filter(Boolean).join(" "),
    SCAM_WORDS,
  );
  if (scamWords.length > 0) {
    score += 30;
    flags.push({
      code: "SCAM_WORDING",
      label: `Contains scam-like wording: ${scamWords.join(", ")}`,
      severity: "high",
      details: scamWords,
    });
  }

  // ── Offensive content check ──
  const offensiveWords = containsAny(
    [listing.title, listing.description].filter(Boolean).join(" "),
    OFFENSIVE_WORDS,
  );
  if (offensiveWords.length > 0) {
    score += 50;
    flags.push({
      code: "OFFENSIVE_CONTENT",
      label: `Contains offensive content: ${offensiveWords.join(", ")}`,
      severity: "high",
      details: offensiveWords,
    });
  }

  // ── Missing/weak location ──
  if (!hasText(listing.address, 5)) {
    score += 25;
    flags.push({ code: "MISSING_ADDRESS", label: "Address is missing or too short.", severity: "high" });
  }

  if (!listing.country || !listing.city) {
    score += 20;
    flags.push({ code: "MISSING_LOCATION", label: "Country or city is missing.", severity: "high" });
  }

  if (latitude === null || longitude === null) {
    score += 30;
    flags.push({ code: "MISSING_COORDS", label: "Latitude or longitude is missing.", severity: "high" });
  }

  if (latitude !== null && (latitude < -90 || latitude > 90)) {
    score += 30;
    flags.push({ code: "INVALID_LATITUDE", label: "Latitude is invalid.", severity: "high" });
  }

  if (longitude !== null && (longitude < -180 || longitude > 180)) {
    score += 30;
    flags.push({ code: "INVALID_LONGITUDE", label: "Longitude is invalid.", severity: "high" });
  }

  // ── Price checks ──
  if (!price || price <= 0) {
    score += 25;
    flags.push({ code: "INVALID_PRICE", label: "Price is invalid.", severity: "high" });
  }

  if (price && price < 1000) {
    score += 10;
    flags.push({ code: "SUSPICIOUS_LOW_PRICE", label: "Price looks unusually low.", severity: "medium" });
  }

  if (price && price > 10000000) {
    score += 15;
    flags.push({ code: "SUSPICIOUS_HIGH_PRICE", label: "Price is unusually high.", severity: "medium" });
  }

  // ── Price per sqft suspicious ──
  const sqft = toNumber(listing.square_feet) || toNumber(listing.building_area_sqft);
  if (price && sqft && sqft > 0) {
    const ppsf = price / sqft;
    if (ppsf < 10) {
      score += 10;
      flags.push({ code: "SUSPICIOUS_PRICE_PER_SQFT", label: `Price per sqft ($${ppsf.toFixed(0)}) is unusually low.`, severity: "medium" });
    }
    if (ppsf > 5000) {
      score += 10;
      flags.push({ code: "SUSPICIOUS_PRICE_PER_SQFT", label: `Price per sqft ($${ppsf.toFixed(0)}) is unusually high.`, severity: "medium" });
    }
  }

  // ── Media quality ──
  const photos = Array.isArray(listing.photos) ? listing.photos : [];
  if (photos.length === 0) {
    score += 25;
    flags.push({ code: "NO_PHOTOS", label: "No property photos uploaded.", severity: "high" });
  } else if (photos.length < 3) {
    score += 10;
    flags.push({ code: "FEW_PHOTOS", label: `Only ${photos.length} photo(s) uploaded — minimum 3 recommended.`, severity: "low" });
  }

  // ── Description check ──
  if (!hasText(listing.description, 20)) {
    score += 10;
    flags.push({ code: "SHORT_DESCRIPTION", label: "Description is too short.", severity: "medium" });
  }

  // ── Legal / title document check ──
  const hasDoc = listing.title_document_file &&
    (Array.isArray(listing.title_document_file)
      ? listing.title_document_file.length > 0
      : Object.keys(listing.title_document_file).length > 0);
  if (!hasDoc && (listing.property_type === "land" || listing.property_type === "commercial")) {
    score += 20;
    flags.push({ code: "MISSING_TITLE_DOC", label: "Title/legal document missing for land/commercial listing.", severity: "medium" });
  }

  // ── User verification ──
  if (!user?.is_verified && user?.verification_status !== "approved") {
    if (user?.verification_status === "rejected") {
      score += 60;
      flags.push({ code: "USER_REJECTED", label: "User verification was rejected.", severity: "high" });
    } else {
      score += 40;
      flags.push({ code: "USER_UNVERIFIED", label: "User is not verified.", severity: "high" });
    }
  }

  // ── Suspicious contact behavior ──
  if (listing.show_contact_phone === false && listing.contact_phone) {
    score += 10;
    flags.push({ code: "HIDDEN_CONTACT", label: "Contact phone hidden from listing.", severity: "low" });
  }

  // ── Duplicate / cloned listing ──
  if (user?.unique_id && hasText(listing.title, 3)) {
    try {
      const dupCheck = await pool.query(
        `SELECT COUNT(*)::int AS cnt FROM listings
         WHERE uploaded_by_id = $1::uuid
           AND title ILIKE $2
           AND status NOT IN ('rejected', 'archived')
           AND created_at > NOW() - INTERVAL '90 days'
           AND product_id != $3`,
        [String(user.unique_id), listing.title.trim(), listing.product_id || ""],
      );
      if (dupCheck.rows[0]?.cnt > 0) {
        const dupCount = dupCheck.rows[0].cnt;
        score += Math.min(20 + dupCount * 5, 50);
        flags.push({
          code: "DUPLICATE_LISTING",
          label: `Similar listing already exists (${dupCount} other listing${dupCount > 1 ? "s" : ""} in last 90 days).`,
          severity: "high",
          details: { count: dupCount },
        });
      }
    } catch (err) {
      console.warn("[evaluateListingRisk] Duplicate check failed:", err.message);
    }
  }

  // ── Repeated suspicious behavior ──
  if (userHistory) {
    let repeatPenalty = 0;

    if (userHistory.rejected_count > 0) {
      repeatPenalty += userHistory.rejected_count * 10;
      flags.push({
        code: "REPEATED_REJECTIONS",
        label: `${userHistory.rejected_count} previous listing(s) rejected.`,
        severity: "medium",
        details: { count: userHistory.rejected_count },
      });
    }

    if (userHistory.flagged_count > 0) {
      repeatPenalty += userHistory.flagged_count * 15;
      flags.push({
        code: "REPEATED_FLAGS",
        label: `${userHistory.flagged_count} previous listing(s) flagged.`,
        severity: "high",
        details: { count: userHistory.flagged_count },
      });
    }

    if (userHistory.reports_received > 1) {
      repeatPenalty += 20;
      flags.push({
        code: "REPEATED_REPORTS",
        label: `${userHistory.reports_received} report(s) on this user's listings.`,
        severity: "high",
        details: { count: userHistory.reports_received },
      });
    }

    score += repeatPenalty;
  }

  let riskLevel = RISK.LOW;

  if (score >= 60) {
    riskLevel = RISK.HIGH;
  } else if (score >= 25) {
    riskLevel = RISK.MEDIUM;
  }

  const shouldPublishImmediately =
    riskLevel === RISK.LOW &&
    (user?.is_verified || user?.verification_status === "approved");

  const flatFlags = flags.map(f => f.label);
  const flagCodes = flags.map(f => f.code);
  const hasHighRisk =
    flags.some(f => f.severity === "high") ||
    (userHistory?.rejected_count > 0 && userHistory.rejected_count >= 2) ||
    (userHistory?.reports_received > 2);

  return {
    score,
    risk_level: riskLevel,
    flags: flatFlags,
    flagDetails: flags,
    flagCodes,
    should_publish_immediately: shouldPublishImmediately,
    requires_review: !shouldPublishImmediately,
    hasHighRisk,
    repeatOffender: (userHistory?.rejected_count || 0) >= 2 || (userHistory?.reports_received || 0) >= 3,
  };
};
