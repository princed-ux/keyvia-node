// keyvia-node/routes/ai.js
// AI feature endpoints gated by aiChecks plan flag.
// POST /api/ai/property-description  — generate listing description (Haiku)
// POST /api/ai/listing-quality-score — score listing quality (Sonnet)

import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { authenticateAndAttachUser } from "../middleware/authMiddleware.js";
import { requireFeature } from "../middleware/planMiddleware.js";
import { pool } from "../db.js";

const router = express.Router();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

router.use(authenticateAndAttachUser);
router.use(requireFeature("aiChecks"));

// ── Daily quota enforcement ───────────────────────────────────────────────────
const AI_DAILY_LIMIT = 10;

async function checkAndIncrementDailyQuota(userId) {
  const { rows } = await pool.query(
    `SELECT ai_calls_today, ai_calls_reset_at FROM users WHERE unique_id = $1 LIMIT 1`,
    [userId]
  );
  const user = rows[0];
  if (!user) throw new Error("User not found");

  const now = new Date();
  const resetAt = user.ai_calls_reset_at ? new Date(user.ai_calls_reset_at) : null;
  const needsReset = !resetAt || now >= new Date(resetAt.getTime() + 24 * 60 * 60 * 1000);

  if (needsReset) {
    await pool.query(
      `UPDATE users SET ai_calls_today = 1, ai_calls_reset_at = NOW() WHERE unique_id = $1`,
      [userId]
    );
    return { allowed: true, remaining: AI_DAILY_LIMIT - 1 };
  }

  if (user.ai_calls_today >= AI_DAILY_LIMIT) {
    return { allowed: false, remaining: 0 };
  }

  await pool.query(
    `UPDATE users SET ai_calls_today = ai_calls_today + 1 WHERE unique_id = $1`,
    [userId]
  );
  return { allowed: true, remaining: AI_DAILY_LIMIT - user.ai_calls_today - 1 };
}

// ── POST /api/ai/property-description ────────────────────────────────────────
router.post("/property-description", async (req, res) => {
  try {
    const userId = req.user?.unique_id;
    const quota = await checkAndIncrementDailyQuota(userId);
    if (!quota.allowed) {
      return res.status(429).json({
        code: "AI_DAILY_LIMIT",
        message: `You have reached your daily AI limit of ${AI_DAILY_LIMIT} generations. It resets after 24 hours.`,
      });
    }

    const { title, propertyType, bedrooms, bathrooms, sqft, amenities, location, price } = req.body;

    if (!title && !propertyType) {
      return res.status(400).json({ error: "Provide at least a property title or type." });
    }

    const amenityList = Array.isArray(amenities) ? amenities.join(", ") : (amenities || "");
    const prompt = [
      `Write a professional real estate listing description for the following property.`,
      `Keep it between 150 and 200 words. Use a warm, persuasive tone suitable for the Nigerian real estate market.`,
      `Do NOT include a headline or title — write body copy only.`,
      ``,
      `Property details:`,
      title       ? `- Title: ${title}` : "",
      propertyType? `- Type: ${propertyType}` : "",
      bedrooms    ? `- Bedrooms: ${bedrooms}` : "",
      bathrooms   ? `- Bathrooms: ${bathrooms}` : "",
      sqft        ? `- Size: ${sqft} sqft` : "",
      location    ? `- Location: ${location}` : "",
      price       ? `- Price: ${price}` : "",
      amenityList ? `- Amenities: ${amenityList}` : "",
    ].filter(Boolean).join("\n");

    const message = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 400,
      messages: [{ role: "user", content: prompt }],
    });

    const description = message.content[0]?.text?.trim() || "";
    const wordCount = description.split(/\s+/).filter(Boolean).length;

    return res.json({
      success: true,
      description,
      wordCount,
      quota_remaining: quota.remaining,
    });
  } catch (err) {
    console.error("[AI] property-description error:", err.message);
    return res.status(500).json({ error: "Failed to generate description. Please try again." });
  }
});

// ── POST /api/ai/listing-quality-score ───────────────────────────────────────
router.post("/listing-quality-score", async (req, res) => {
  try {
    const userId = req.user?.unique_id;
    const quota = await checkAndIncrementDailyQuota(userId);
    if (!quota.allowed) {
      return res.status(429).json({
        code: "AI_DAILY_LIMIT",
        message: `You have reached your daily AI limit of ${AI_DAILY_LIMIT} analyses. It resets after 24 hours.`,
      });
    }

    const { product_id } = req.body;
    if (!product_id) return res.status(400).json({ error: "product_id is required" });

    const { rows } = await pool.query(
      `SELECT title, description, price,
              COALESCE(jsonb_array_length(
                CASE WHEN photos IS NULL THEN NULL
                     WHEN jsonb_typeof(photos::jsonb) = 'array' THEN photos::jsonb
                     ELSE NULL END
              ), 0) AS photo_count,
              amenities, city, bedrooms, bathrooms, property_type
       FROM listings WHERE product_id = $1 LIMIT 1`,
      [product_id]
    );
    if (!rows.length) return res.status(404).json({ error: "Listing not found" });

    const listing = rows[0];
    let score = 100;
    const issues = [];
    const suggestions = [];

    // Photo count scoring
    const photos = Number(listing.photo_count || 0);
    if (photos === 0) { score -= 25; issues.push("No photos uploaded"); suggestions.push("Add at least 8 high-quality photos"); }
    else if (photos < 5) { score -= 15; issues.push(`Only ${photos} photo(s)`); suggestions.push("Add at least 5–10 photos for better engagement"); }
    else if (photos < 8) { score -= 5; suggestions.push("Consider adding more photos (aim for 10+)"); }

    // Description length scoring
    const desc = listing.description || "";
    const wordCount = desc.split(/\s+/).filter(Boolean).length;
    if (wordCount === 0) { score -= 25; issues.push("No description provided"); suggestions.push("Write a compelling 150–200 word description"); }
    else if (wordCount < 50) { score -= 15; issues.push("Description is too short"); suggestions.push("Expand your description to at least 100 words"); }
    else if (wordCount < 100) { score -= 5; suggestions.push("A longer, more detailed description improves buyer confidence"); }

    // Amenities scoring
    const amenities = listing.amenities;
    const amenityCount = Array.isArray(amenities) ? amenities.length :
      (typeof amenities === "string" ? amenities.split(",").filter(Boolean).length : 0);
    if (amenityCount === 0) { score -= 15; issues.push("No amenities listed"); suggestions.push("List all available amenities (parking, generator, swimming pool, etc.)"); }
    else if (amenityCount < 3) { score -= 5; suggestions.push("List more amenities to highlight the property's value"); }

    // Price scoring
    if (!listing.price || Number(listing.price) <= 0) {
      score -= 10; issues.push("Price not set"); suggestions.push("Set a clear, competitive price");
    }

    // AI text quality analysis (20 pts of the score)
    let aiTextScore = 20;
    if (desc.length > 20) {
      try {
        const aiPrompt = `Evaluate the quality of this real estate listing description on a scale of 0 to 20.
Consider: clarity, professionalism, specificity, persuasiveness, and relevance to the Nigerian market.
Reply with ONLY a JSON object in this format:
{"score": <0-20>, "feedback": "<one sentence of the most important improvement>"}

Description:
${desc.slice(0, 800)}`;

        const aiRes = await anthropic.messages.create({
          model: "claude-sonnet-4-6",
          max_tokens: 100,
          messages: [{ role: "user", content: aiPrompt }],
        });

        const raw = aiRes.content[0]?.text?.trim() || "{}";
        const parsed = JSON.parse(raw.match(/\{.*\}/s)?.[0] || "{}");
        aiTextScore = Math.min(20, Math.max(0, Number(parsed.score) || 10));
        if (parsed.feedback) suggestions.push(`Description: ${parsed.feedback}`);
      } catch {
        aiTextScore = 10;
      }
    } else {
      aiTextScore = 0;
    }

    // Replace the flat 20-pt text portion with AI-assessed value
    score = Math.max(0, score - 20 + aiTextScore);
    score = Math.min(100, Math.max(0, Math.round(score)));

    const grade = score >= 85 ? "A" : score >= 70 ? "B" : score >= 55 ? "C" : "D";

    return res.json({
      success: true,
      score,
      grade,
      issues,
      suggestions,
      quota_remaining: quota.remaining,
    });
  } catch (err) {
    console.error("[AI] listing-quality-score error:", err.message);
    return res.status(500).json({ error: "Failed to score listing. Please try again." });
  }
});

// ── POST /api/ai/property-assistant ──────────────────────────────────────────
// action: "generate_title" | "improve_description" | "generate_highlights"
//       | "check_completeness" | "analyze_location"
router.post("/property-assistant", async (req, res) => {
  try {
    const userId = req.user?.unique_id;
    const quota = await checkAndIncrementDailyQuota(userId);
    if (!quota.allowed) {
      return res.status(429).json({
        code: "AI_DAILY_LIMIT",
        message: `You have reached your daily AI limit of ${AI_DAILY_LIMIT} generations. It resets after 24 hours.`,
      });
    }

    const { action, form_data = {}, product_id } = req.body;
    if (!action) return res.status(400).json({ error: "action is required" });

    const {
      title, propertyType, listingType, bedrooms, bathrooms, price, priceCurrency,
      city, state, country, description, amenities = [], features = [],
      latitude, longitude,
    } = form_data;

    const locationStr = [city, state, country].filter(Boolean).join(", ");
    const amenityStr  = Array.isArray(amenities) ? amenities.join(", ") : (amenities || "");
    const featureStr  = Array.isArray(features)  ? features.join(", ")  : (features || "");
    const priceStr    = price ? `${priceCurrency || "NGN"} ${Number(price).toLocaleString()}` : "";

    let prompt = "";
    let model = "claude-haiku-4-5-20251001";
    let maxTokens = 300;

    if (action === "generate_title") {
      prompt = [
        "Generate 3 professional real estate listing titles for the property below.",
        "Titles should be concise (max 10 words), compelling, and suitable for the Nigerian market.",
        "Reply with ONLY a JSON array of exactly 3 strings: [\"Title 1\", \"Title 2\", \"Title 3\"]",
        "",
        `Property type: ${propertyType || "residential"}`,
        `Listing type: ${listingType || "sale"}`,
        bedrooms   ? `Bedrooms: ${bedrooms}` : "",
        bathrooms  ? `Bathrooms: ${bathrooms}` : "",
        locationStr ? `Location: ${locationStr}` : "",
        priceStr    ? `Price: ${priceStr}` : "",
      ].filter(Boolean).join("\n");
      maxTokens = 120;

    } else if (action === "improve_description") {
      prompt = [
        "Rewrite or improve the real estate listing description below.",
        "Target length: 160–220 words. Tone: warm, professional, persuasive. Market: Nigerian real estate.",
        "Do NOT include a title or headline. Write body copy only.",
        "",
        `Property: ${propertyType || "property"} for ${listingType || "sale"} in ${locationStr || "Nigeria"}`,
        bedrooms  ? `Bedrooms: ${bedrooms}` : "",
        bathrooms ? `Bathrooms: ${bathrooms}` : "",
        priceStr  ? `Price: ${priceStr}` : "",
        amenityStr ? `Amenities: ${amenityStr}` : "",
        featureStr ? `Features: ${featureStr}` : "",
        description ? `\nExisting description to improve:\n${description.slice(0, 600)}` : "\nNo existing description provided — write one from scratch.",
      ].filter(Boolean).join("\n");
      model = "claude-sonnet-4-6";
      maxTokens = 400;

    } else if (action === "generate_highlights") {
      prompt = [
        "Generate 4–6 concise property highlights as bullet points for this listing.",
        "Each bullet should be a single compelling sentence. No headers.",
        "Reply with ONLY a JSON array of strings.",
        "",
        `Property: ${propertyType || "property"} for ${listingType || "sale"}`,
        locationStr ? `Location: ${locationStr}` : "",
        bedrooms   ? `Bedrooms: ${bedrooms}` : "",
        bathrooms  ? `Bathrooms: ${bathrooms}` : "",
        amenityStr ? `Amenities: ${amenityStr}` : "",
        featureStr ? `Features: ${featureStr}` : "",
      ].filter(Boolean).join("\n");
      maxTokens = 200;

    } else if (action === "check_completeness") {
      const fields = {
        title:        !!title,
        description:  !!(description && description.split(/\s+/).filter(Boolean).length >= 80),
        propertyType: !!propertyType,
        listingType:  !!listingType,
        bedrooms:     !!(bedrooms || !["House","Apartment","Duplex","Flat","Bungalow","Condo","Terraced"].includes(propertyType)),
        price:        !!(price && Number(price) > 0),
        city:         !!city,
        amenities:    !!(amenityStr && amenityStr.length > 0),
      };
      const missing = Object.entries(fields).filter(([, v]) => !v).map(([k]) => k);

      // Build location quality context
      const hasCoords = !!(latitude && longitude);
      const addressLen = (form_data.address || "").trim().length;
      const locationPrecision = form_data.locationPrecision || "";
      const locationIssues = [];
      if (!hasCoords) locationIssues.push("No coordinates — map pin not placed");
      if (!city) locationIssues.push("City is missing");
      if (addressLen > 0 && addressLen < 15) locationIssues.push(`Address appears too vague (${addressLen} chars)`);
      if (["area_level", "approximate", "manual"].includes(locationPrecision)) {
        locationIssues.push(`Location precision is low (${locationPrecision}) — pin should be placed at the exact property entrance`);
      }

      prompt = [
        "You are a real estate listing quality assistant for the Nigerian market.",
        "Review these listing details and return a structured quality report as JSON.",
        "Format: { \"score\": <0-100>, \"issues\": [\"...\"], \"suggestions\": [\"...\"], \"location_issues\": [\"...\"], \"verdict\": \"Ready|Needs work|Incomplete\" }",
        "location_issues should list specific location/address problems (empty array if none).",
        "",
        `Title: ${title || "(missing)"}`,
        `Description word count: ${(description || "").split(/\s+/).filter(Boolean).length}`,
        `Property type: ${propertyType || "(missing)"}`,
        `Listing type: ${listingType || "(missing)"}`,
        `Price: ${priceStr || "(missing)"}`,
        `Location: ${locationStr || "(missing)"}`,
        `Address length: ${addressLen} chars`,
        `Coordinates captured: ${hasCoords ? "Yes" : "No"}`,
        `Location precision: ${locationPrecision || "unknown"}`,
        `Amenities: ${amenityStr || "(none listed)"}`,
        `Missing fields: ${missing.join(", ") || "none"}`,
        locationIssues.length ? `Location issues detected: ${locationIssues.join("; ")}` : "",
      ].filter(Boolean).join("\n");
      model = "claude-sonnet-4-6";
      maxTokens = 400;

    } else if (action === "analyze_location") {
      let poiContext = "";
      if (product_id) {
        try {
          const { rows } = await pool.query(
            `SELECT schools, hospitals, transit, groceries_markets, restaurants_cafes,
                    parks_recreation, malls_shopping, lifestyle_summary
             FROM location_intelligence_snapshots WHERE product_id = $1
             ORDER BY created_at DESC LIMIT 1`,
            [product_id]
          );
          if (rows[0]) {
            const r = rows[0];
            const summarize = (label, arr) => {
              if (!Array.isArray(arr) || arr.length === 0) return "";
              return `${label}: ${arr.slice(0, 3).map((p) => p.name || p).join(", ")}`;
            };
            poiContext = [
              summarize("Schools", r.schools),
              summarize("Hospitals", r.hospitals),
              summarize("Transit", r.transit),
              summarize("Grocery/Markets", r.groceries_markets),
              summarize("Restaurants", r.restaurants_cafes),
              summarize("Parks", r.parks_recreation),
              summarize("Shopping", r.malls_shopping),
            ].filter(Boolean).join("\n");
          }
        } catch { /* silent */ }
      }

      prompt = [
        "Write a 3–4 sentence neighborhood summary for this property location. Be specific and appealing.",
        "Focus on convenience, lifestyle, and nearby amenities buyers/tenants would care about.",
        "Do NOT make up specific place names unless they appear in the data below.",
        "",
        `Location: ${locationStr || "(city not specified)"}`,
        latitude && longitude ? `Coordinates: ${latitude}, ${longitude}` : "",
        poiContext || "(no detailed POI data available — write based on general knowledge of the city)",
      ].filter(Boolean).join("\n");
      model = "claude-sonnet-4-6";
      maxTokens = 200;

    } else {
      return res.status(400).json({ error: `Unknown action: ${action}` });
    }

    const message = await anthropic.messages.create({
      model,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    });

    const raw = message.content[0]?.text?.trim() || "";

    // Parse JSON responses for structured actions
    let result = { text: raw };
    if (["generate_title", "generate_highlights"].includes(action)) {
      try {
        const arr = JSON.parse(raw.match(/\[[\s\S]*\]/)?.[0] || "[]");
        result = { items: arr };
      } catch { result = { items: [raw] }; }
    } else if (action === "check_completeness") {
      try {
        const obj = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || "{}");
        result = obj;
      } catch { result = { text: raw }; }
    } else {
      result = { text: raw };
    }

    return res.json({ success: true, action, result, quota_remaining: quota.remaining });
  } catch (err) {
    console.error("[AI] property-assistant error:", err.message);
    return res.status(500).json({ error: "AI assistant request failed. Please try again." });
  }
});

export default router;
