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
 * @param {string|null} adminName - Name of the admin
 * @param {string|null} ipAddress - IP address of the admin
 */
export const logAdminAction = async (
  adminId,
  action,
  targetType,
  targetId,
  changes = {},
  adminName = null,
  ipAddress = null,
) => {
  try {
    await monitoringService.recordAdminAction(
      adminId,
      action,
      targetType,
      targetId,
      changes,
      adminName,
      ipAddress,
    );
    logger.info(
      `Audit: ${action} on ${targetType} ${targetId} by admin ${adminId}`,
    );
  } catch (error) {
    logger.error("Error logging admin action:", error);
  }
};

/**
 * Request-aware audit helper — captures admin id, admin name and IP from the
 * request so callers don't have to thread them through manually.
 * @param {object} req - Express request (must have req.user)
 */
export const auditLog = async (req, action, targetType, targetId, changes = {}) => {
  const adminId = req?.user?.unique_id || null;
  const adminName = req?.user?.name || req?.user?.email || null;
  const ip =
    (req?.headers?.["x-forwarded-for"] || "").split(",")[0].trim() ||
    req?.ip ||
    req?.socket?.remoteAddress ||
    null;

  return logAdminAction(adminId, action, targetType, targetId, changes, adminName, ip);
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
