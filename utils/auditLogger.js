// utils/auditLogger.js
import monitoringService from "../services/monitoringService.js";
import logger from "./logger.js";

/**
 * Log an admin action to the audit trail
 * @param {string} adminId - The ID of the admin performing the action
 * @param {string} action - The action performed (e.g., "user_deleted", "listing_flagged")
 * @param {string} targetType - Type of resource being modified (e.g., "user", "listing")
 * @param {string} targetId - ID of the resource being modified
 * @param {object} changes - Object containing the changes made
 */
export const logAdminAction = async (
  adminId,
  action,
  targetType,
  targetId,
  changes = {},
) => {
  try {
    await monitoringService.recordAdminAction(
      adminId,
      action,
      targetType,
      targetId,
      changes,
    );
    logger.info(
      `📋 Audit: ${action} on ${targetType} ${targetId} by admin ${adminId}`,
    );
  } catch (error) {
    logger.error("Error logging admin action:", error);
  }
};

/**
 * Log rate limit violation
 * @param {string} userId - The ID of the user being rate limited
 * @param {string} endpoint - The endpoint that was rate limited
 */
export const logRateLimitViolation = async (userId, endpoint) => {
  try {
    await monitoringService.recordRateLimit(userId, endpoint);
    logger.warn(`🚦 Rate limit exceeded: ${userId} on ${endpoint}`);
  } catch (error) {
    logger.error("Error logging rate limit violation:", error);
  }
};

export default { logAdminAction, logRateLimitViolation };
