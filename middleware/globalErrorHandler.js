// middleware/globalErrorHandler.js
// ============================================================================
// GLOBAL ERROR HANDLER - Catches all unhandled errors
// ============================================================================

const CONNECTION_ERROR_CODES = new Set([
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "EPIPE",
  "57P01",
  "57014",
  "08003",
  "08006",
]);

const isConnectionError = (err = {}) => {
  const code = String(err.code || "").toUpperCase();
  const message = String(err.message || "").toLowerCase();

  return (
    CONNECTION_ERROR_CODES.has(code) ||
    message.includes("connection terminated") ||
    message.includes("connection timeout") ||
    message.includes("connection timed out") ||
    message.includes("terminating connection") ||
    message.includes("query timeout") ||
    message.includes("statement timeout") ||
    message.includes("network timeout")
  );
};

const getResourceLabel = (path = "") => {
  const value = String(path || "").toLowerCase();

  if (value.includes("/listings")) return "listings";
  if (value.includes("/profile") || value.includes("/social")) return "profile";
  if (value.includes("/notifications")) return "notifications";
  if (value.includes("/ivs") || value.includes("live-tour")) return "live tour";
  if (value.includes("/onboarding")) return "verification";
  if (value.includes("/messages")) return "messages";
  if (value.includes("/applications")) return "applications";

  return "this information";
};

const buildConnectionMessage = (req) => {
  const resource = getResourceLabel(req.path);
  const verb = String(req.method || "GET").toUpperCase();

  if (verb === "GET") {
    return `Could not load ${resource}. Your connection may be slow or unstable. Please try again.`;
  }

  if (resource === "verification") {
    return "Could not submit verification. Your connection may be slow or unstable. Please try again.";
  }

  return "Could not complete this request. Your connection may be slow or unstable. Please try again.";
};

export const globalErrorHandler = (err, req, res, next) => {
  console.error("[ERROR HANDLER]", {
    message: err.message,
    code: err.code,
    status: err.status || 500,
    path: req.path,
    method: req.method,
    stack: err.stack,
  });

  const connectionIssue = isConnectionError(err);
  const statusCode = connectionIssue ? 503 : err.status || 500;
  const message = connectionIssue
    ? buildConnectionMessage(req)
    : err.message || "Internal Server Error";

  const response = {
    success: false,
    message:
      process.env.NODE_ENV === "production"
        ? connectionIssue
          ? message
          : "An error occurred. Please try again later."
        : message,
    code: connectionIssue
      ? "SERVICE_TEMPORARILY_UNAVAILABLE"
      : err.code || "SERVER_ERROR",
    retryable: connectionIssue || undefined,
    ...(process.env.NODE_ENV !== "production" && { stack: err.stack }),
  };

  res.status(statusCode).json(response);
};

// ============================================================================
// Async Error Wrapper - Wraps async route handlers to catch errors
// ============================================================================
export const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};
