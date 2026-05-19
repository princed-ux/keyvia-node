import express from "express";
import {
  autocompleteLocation,
  geocodeLocation,
  getCityScope,
  reverseLocation,
} from "../services/locationService.js";

const router = express.Router();

const sendError = (res, error) => {
  const statusCode = error?.statusCode || 500;
  res.status(statusCode).json({
    success: false,
    message:
      statusCode >= 500
        ? "Location lookup is unavailable right now."
        : error.message,
  });
};

router.get("/autocomplete", async (req, res) => {
  try {
    const result = await autocompleteLocation(req.query);
    res.json({ success: true, ...result });
  } catch (error) {
    sendError(res, error);
  }
});

router.get("/geocode", async (req, res) => {
  try {
    const result = await geocodeLocation(req.query);
    res.json({ success: true, result });
  } catch (error) {
    sendError(res, error);
  }
});

router.get("/reverse", async (req, res) => {
  try {
    const result = await reverseLocation(req.query);
    res.json({ success: true, result });
  } catch (error) {
    sendError(res, error);
  }
});

router.get("/city-scope", async (req, res) => {
  try {
    const scope = await getCityScope(req.query);
    res.json({ success: true, scope });
  } catch (error) {
    sendError(res, error);
  }
});

router.get("/ip-country", (req, res) => {
  const country =
    req.headers["cloudfront-viewer-country"] ||
    req.headers["cf-ipcountry"] ||
    req.headers["x-country"] ||
    req.query.default ||
    "";
  res.json({ success: true, country, country_name: country, name: country });
});

export default router;
