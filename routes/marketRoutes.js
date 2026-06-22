// GET /api/market/narrative?city=Lagos&property_type=apartment
// Public endpoint — no auth required.
// Calls Haiku to generate a 2-3 sentence Nigeria market summary, cached 7 days in memory.

import express from "express";
import Anthropic from "@anthropic-ai/sdk";

const router = express.Router();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const narrativeCache = new Map();

const VALID_TYPES = new Set([
  "apartment", "house", "flat", "duplex", "studio", "bungalow",
  "terrace", "mansion", "land", "commercial", "office", "warehouse", "shortlet",
]);

router.get("/narrative", async (req, res) => {
  const city = String(req.query.city || "").trim();
  const property_type = String(req.query.property_type || "").trim().toLowerCase();

  if (!city) return res.status(400).json({ error: "city is required" });

  const cacheKey = `${city.toLowerCase()}:${property_type || "residential"}`;
  const cached = narrativeCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return res.json({ narrative: cached.narrative, cached: true });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: "AI service not configured." });
  }

  try {
    const typeLabel = VALID_TYPES.has(property_type) ? property_type : "residential";
    const prompt = `You are a Nigerian real estate market analyst. Summarize the current ${typeLabel} property market in ${city}, Nigeria in exactly 2-3 sentences. Focus on demand trends, price direction, and investment outlook. Be specific, factual, and concise. Do not use markdown formatting.`;

    const message = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      messages: [{ role: "user", content: prompt }],
    });

    const narrative = message.content[0]?.text?.trim() || "";
    if (!narrative) return res.status(502).json({ error: "Empty response from AI." });

    narrativeCache.set(cacheKey, { narrative, cachedAt: Date.now() });

    return res.json({ narrative, cached: false });
  } catch (err) {
    console.error("[MarketNarrative] Error:", err.message);
    return res.status(500).json({ error: "Failed to generate market narrative." });
  }
});

export default router;
