// middleware/globalErrorHandler.js
// ============================================================================
// GLOBAL ERROR HANDLER - Catches all unhandled errors
// ============================================================================

export const globalErrorHandler = (err, req, res, next) => {
  console.error("❌ [ERROR HANDLER]", {
    message: err.message,
    status: err.status || 500,
    path: req.path,
    method: req.method,
    stack: err.stack,
  });

  // Don't expose internal error details to client
  const statusCode = err.status || 500;
  const message = err.message || "Internal Server Error";

  // Hide stack trace in production
  const response = {
    success: false,
    message:
      process.env.NODE_ENV === "production"
        ? "An error occurred. Please try again later."
        : message,
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
