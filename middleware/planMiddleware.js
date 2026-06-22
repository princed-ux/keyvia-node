import { getEffectivePlanForUser } from "../utils/effectivePlan.js";

/**
 * Middleware factory that enforces analytics plan entitlement.
 * level='basic'    → requires limits.analytics === true
 * level='advanced' → requires limits.advancedAnalytics === true
 *
 * On failure: 403 { upgrade_required: true, current_plan, required_level }
 * On success: attaches req.effectivePlan and calls next()
 */
export const requireAnalytics = (level = "basic") =>
  async (req, res, next) => {
    const userId = String(req.user?.unique_id || req.user?.id || "");
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    try {
      const effective = await getEffectivePlanForUser(userId);
      const allowed =
        level === "advanced"
          ? effective?.limits?.advancedAnalytics === true
          : effective?.limits?.analytics === true;

      if (!allowed) {
        return res.status(403).json({
          error: "Plan upgrade required",
          upgrade_required: true,
          current_plan: effective?.planId || "free",
          required_level: level,
        });
      }

      req.effectivePlan = effective;
      next();
    } catch (err) {
      console.error("[planMiddleware] requireAnalytics error:", err.message);
      return res.status(500).json({ error: "Server error" });
    }
  };

/**
 * Middleware factory that enforces any single plan feature flag.
 * featureName must match a key in planCatalog limits (e.g. 'aiChecks').
 *
 * On failure: 403 { upgrade_required: true, code: 'FEATURE_NOT_AVAILABLE' }
 * On success: attaches req.effectivePlan and calls next()
 */
export const requireFeature = (featureName) =>
  async (req, res, next) => {
    const userId = String(req.user?.unique_id || req.user?.id || "");
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    try {
      const effective = await getEffectivePlanForUser(userId);
      const allowed = effective?.limits?.[featureName] === true;

      if (!allowed) {
        return res.status(403).json({
          success: false,
          upgrade_required: true,
          code: "FEATURE_NOT_AVAILABLE",
          feature: featureName,
          current_plan: effective?.planId || "free",
          message: `Your current plan does not include this feature. Please upgrade to access it.`,
        });
      }

      req.effectivePlan = effective;
      next();
    } catch (err) {
      console.error("[planMiddleware] requireFeature error:", err.message);
      return res.status(500).json({ error: "Server error" });
    }
  };
