// utils/logger.js
// ============================================================================
// WINSTON LOGGER - Production-grade logging
// ============================================================================

import winston from "winston";
import fs from "fs";
import path from "path";

// Create logs directory if it doesn't exist
const logsDir = "./logs";
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir);
}

// Define log levels
const levels = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
};

// Define colors for console output
const colors = {
  error: "red",
  warn: "yellow",
  info: "green",
  debug: "blue",
  trace: "cyan",
};

winston.addColors(colors);

// Create logger instance
const logger = winston.createLogger({
  levels,
  format: winston.format.combine(
    winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    winston.format.printf(
      (info) =>
        `${info.timestamp} [${info.level.toUpperCase()}]: ${info.message}`,
    ),
  ),
  transports: [
    // ===== ERROR LOGS =====
    new winston.transports.File({
      filename: path.join(logsDir, "error.log"),
      level: "error",
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    }),

    // ===== COMBINED LOGS (All levels) =====
    new winston.transports.File({
      filename: path.join(logsDir, "combined.log"),
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    }),

    // ===== CONSOLE OUTPUT (Development) =====
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize({ all: true }),
        winston.format.printf(
          (info) => `${info.timestamp} [${info.level}]: ${info.message}`,
        ),
      ),
    }),
  ],
});

// Export logger
export default logger;
