// services/listingRiskService.js

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

export const evaluateListingRisk = ({ listing, user }) => {
  const flags = [];
  let score = 0;

  const latitude = toNumber(listing.latitude);
  const longitude = toNumber(listing.longitude);
  const price = toNumber(listing.price);

  if (!hasText(listing.title, 5)) {
    score += 15;
    flags.push("Title is too short.");
  }

  if (!hasText(listing.address, 5)) {
    score += 25;
    flags.push("Address is missing or too short.");
  }

  if (!listing.country || !listing.city) {
    score += 20;
    flags.push("Country or city is missing.");
  }

  if (latitude === null || longitude === null) {
    score += 30;
    flags.push("Latitude or longitude is missing.");
  }

  if (latitude !== null && (latitude < -90 || latitude > 90)) {
    score += 30;
    flags.push("Latitude is invalid.");
  }

  if (longitude !== null && (longitude < -180 || longitude > 180)) {
    score += 30;
    flags.push("Longitude is invalid.");
  }

  if (!price || price <= 0) {
    score += 25;
    flags.push("Price is invalid.");
  }

  if (price && price < 1000) {
    score += 10;
    flags.push("Price looks unusually low.");
  }

  if (!Array.isArray(listing.photos) || listing.photos.length === 0) {
    score += 25;
    flags.push("No property photos uploaded.");
  }

  if (!hasText(listing.description, 20)) {
    score += 10;
    flags.push("Description is too short.");
  }

  if (!user?.is_verified && user?.verification_status !== "approved") {
    score += 40;
    flags.push("User is not verified.");
  }

  if (user?.verification_status === "rejected") {
    score += 60;
    flags.push("User verification was rejected.");
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

  return {
    score,
    risk_level: riskLevel,
    flags,
    should_publish_immediately: shouldPublishImmediately,
    requires_review: !shouldPublishImmediately,
  };
};