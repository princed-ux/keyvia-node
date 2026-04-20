// middleware/inputValidation.js
// ============================================================================
// INPUT VALIDATION - Validates and sanitizes all user inputs
// ============================================================================

export const validatePaymentInput = (req, res, next) => {
  const { listingId, currency, amount } = req.body;

  if (!listingId || typeof listingId !== "string") {
    return res.status(400).json({ error: "Invalid listing ID" });
  }

  if (
    currency &&
    !["USD", "NGN", "GBP", "EUR", "ZAR"].includes(currency.toUpperCase())
  ) {
    return res.status(400).json({ error: "Unsupported currency" });
  }

  if (amount && (typeof amount !== "number" || amount <= 0)) {
    return res.status(400).json({ error: "Invalid amount" });
  }

  next();
};

export const validateListingInput = (req, res, next) => {
  const { title, description, price, bedrooms, bathrooms, property_type } =
    req.body;

  // Title validation
  if (
    title &&
    (typeof title !== "string" || title.length < 5 || title.length > 255)
  ) {
    return res.status(400).json({ error: "Title must be 5-255 characters" });
  }

  // Price validation
  if (
    price &&
    (typeof price !== "number" || price <= 0 || price > 1000000000)
  ) {
    return res.status(400).json({ error: "Invalid price (max: 1B)" });
  }

  // Bedrooms validation
  if (
    bedrooms &&
    (typeof bedrooms !== "number" || bedrooms < 0 || bedrooms > 100)
  ) {
    return res.status(400).json({ error: "Invalid bedrooms count" });
  }

  // Bathrooms validation
  if (
    bathrooms &&
    (typeof bathrooms !== "number" || bathrooms < 0 || bathrooms > 100)
  ) {
    return res.status(400).json({ error: "Invalid bathrooms count" });
  }

  next();
};

export const validateMessageInput = (req, res, next) => {
  const { message, conversationId } = req.body;

  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "Message is required" });
  }

  if (message.length < 1 || message.length > 5000) {
    return res.status(400).json({ error: "Message must be 1-5000 characters" });
  }

  if (!conversationId || typeof conversationId !== "string") {
    return res.status(400).json({ error: "Invalid conversation ID" });
  }

  next();
};

export const validateFileUpload = (req, res, next) => {
  const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
  const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"];

  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }

  // Check file size
  if (req.file.size > MAX_FILE_SIZE) {
    return res.status(413).json({ error: "File too large (max 5MB)" });
  }

  // Check MIME type
  if (!ALLOWED_MIME_TYPES.includes(req.file.mimetype)) {
    return res
      .status(415)
      .json({ error: "Invalid file type (jpeg, png, webp only)" });
  }

  next();
};
