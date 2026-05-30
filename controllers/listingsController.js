import { pool } from "../db.js";

import { uploadToS3, s3 } from "../middleware/upload.js";

import { DeleteObjectCommand } from "@aws-sdk/client-s3";

import crypto from "crypto";

import axios from "axios";

import { performFullAnalysis } from "../services/analysisService.js";

import { getAiSettings } from "../services/aiSettingsService.js";

import { COUNTRY_ISO_MAP } from "../utils/countryMap.js";

import { evaluateListingRisk } from "../services/listingRiskService.js";
import { enforceListingLimit } from "../services/subscriptionService.js";
import {
  getLatestLocationIntelligence,
  scanLocationIntelligence,
} from "../services/locationIntelligenceService.js";
import { resolvePublicProfilePayload } from "./profileController.js";
import {

  createNotification,

  notifyListingAssigned,

  notifyListingStatusUpdate,

  notifyListingSubmitted,

} from "./notificationsController.js";

import {

  notifyPriceChange,

  notifyStatusChange,

  notifyNewListing,

} from "../services/buyerAlertService.js";


/* ----------------- helpers ----------------- */

async function generateUniqueProductId() {

  for (let attempt = 0; attempt < 8; attempt++) {

    const productId = "PRD-" + crypto.randomUUID().split("-")[0].toUpperCase();



    const exists = await pool.query(

      `SELECT 1 FROM listings WHERE product_id = $1 LIMIT 1`,

      [productId],

    );



    if (exists.rowCount === 0) return productId;

  }



  throw new Error("Unable to generate unique product ID.");

}



const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));



const toNumberOrNull = (value) => {

  if (value === undefined || value === null || value === "") return null;

  const n = Number(value);

  return Number.isFinite(n) ? n : null;

};



const safeJsonParse = (value, fallback = []) => {

  if (!value) return fallback;

  if (Array.isArray(value)) return value;



  try {

    return JSON.parse(value);

  } catch {

    return fallback;

  }

};



const normalizeFeatures = (features) => {

  let featuresArr = [];



  try {

    if (features) {

      featuresArr =

        typeof features === "string" ? JSON.parse(features) : features;



      if (!Array.isArray(featuresArr) && typeof featuresArr === "object") {

        featuresArr = Object.keys(featuresArr).filter(

          (key) => featuresArr[key],

        );

      }

    }

  } catch {

    featuresArr = [];

  }



  return Array.isArray(featuresArr) ? featuresArr : [];

};



const normalizeExistingPhotos = (existing = []) => {

  const parsed = safeJsonParse(existing, []);



  return parsed

    .map((photo) => {

      if (!photo) return null;



      if (typeof photo === "string") {

        return {

          url: photo,

          key: null,

          public_id: null,

          type: "image",

          provider: "legacy",

        };

      }



      return {

        url: photo.url || photo.secure_url || null,

        key: photo.key || photo.s3_key || null,

        public_id:

          photo.public_id ||

          photo.publicId ||

          photo.key ||

          photo.s3_key ||

          null,

        type: photo.type || "image",

        provider:

          photo.provider || (photo.key || photo.s3_key ? "s3" : "legacy"),

        bucket: photo.bucket || null,

      };

    })

    .filter(Boolean);

};



const normalizePhotosForResponse = (photosValue) => {

  return normalizeExistingPhotos(photosValue).map((photo) => ({

    ...photo,

    url: photo.url || photo,

    type: photo.type || "image",

  }));

};



const NEW_LISTING_DAYS = Number(process.env.NEW_LISTING_DAYS || 14);



const isFutureDate = (value) => {

  if (!value) return false;



  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return false;



  return date.getTime() > Date.now();

};



const getListingReferenceDate = (listing = {}) =>

  listing.published_at ||

  listing.listed_at ||

  listing.activated_at ||

  listing.created_at ||

  null;



const getListingAgeDays = (listing = {}) => {

  const referenceDate = getListingReferenceDate(listing);

  if (!referenceDate) return null;



  const date = new Date(referenceDate);

  if (Number.isNaN(date.getTime())) return null;



  return Math.max(

    0,

    Math.floor((Date.now() - date.getTime()) / (1000 * 60 * 60 * 24)),

  );

};



const normalizeListingType = (value) => {
  const type = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

  if (["sale", "buy", "for_sale"].includes(type)) return "sale";
  if (["rent", "rental", "for_rent"].includes(type)) return "rent";
  if (["lease", "for_lease", "long_lease", "commercial_lease"].includes(type)) return "lease";
  if (["shortlet", "short_let", "short_stay", "short_let_stay"].includes(type)) return "short-let";

  return value;
};

const getListingTypeLabel = (listingType) => {
  const type = normalizeListingType(listingType);

  if (type === "sale") return "For Sale";
  if (type === "rent") return "For Rent";
  if (type === "lease") return "For Lease";
  if (type === "short-let") return "Short Let";

  return listingType
    ? String(listingType)
        .replace(/[_-]+/g, " ")
        .replace(/\b\w/g, (letter) => letter.toUpperCase())
    : "Listing";
};


const isPriceDropListing = (listing = {}) => {

  const currentPrice = Number(listing.price || 0);

  const referencePrice = Number(

    listing.previous_price ||

      listing.original_price ||

      listing.old_price ||

      listing.price_before_discount ||

      0,

  );



  return (

    listing.is_price_drop === true ||

    listing.price_drop === true ||

    Boolean(listing.price_drop_amount || listing.price_cut) ||

    (currentPrice > 0 && referencePrice > currentPrice)

  );

};



const computeListingBadges = (
  listing = {},
  { photos = [], floorPlans = [], stagingPhotos = [], panoramaPhotos = [] } = {},
) => {
  const listingAgeDays = getListingAgeDays(listing);

  const listingTypeLabel = getListingTypeLabel(

    listing.listing_type || listing.transaction_type || listing.category,

  );



  const isNew =

    listingAgeDays !== null &&

    listingAgeDays >= 0 &&

    listingAgeDays <= NEW_LISTING_DAYS;



  const hasFeaturedExpiry = Boolean(listing.featured_until);
  const hasShowcaseExpiry = Boolean(listing.showcase_until);

  const isFeatured = hasFeaturedExpiry
    ? isFutureDate(listing.featured_until)
    : listing.is_featured === true ||
      listing.featured === true ||
      listing.featured_listing === true ||
      listing.featured_status === "active";

  const isShowcase = hasShowcaseExpiry
    ? isFutureDate(listing.showcase_until)
    : listing.is_showcase === true ||
      listing.showcase === true ||
      listing.showcase_enabled === true ||
      listing.showcase_status === "active";


  const isLive =

    listing.is_live === true ||

    listing.live_now === true ||

    listing.live_tour_live === true ||

    String(listing.live_tour_status || "").toLowerCase() === "live";



  const isPriceDrop = isPriceDropListing(listing);



  const badgeLabels = [];

  if (isShowcase) badgeLabels.push("Showcase");

  if (isFeatured) badgeLabels.push("Featured");

  if (isNew) badgeLabels.push("New");

  if (listing.title_verified === true) badgeLabels.push("Verified");

  if (isPriceDrop) badgeLabels.push("Price Drop");

  if (isLive) badgeLabels.push("Live Tour");

  if (listing.three_d_home_url) badgeLabels.push("3D Tour");

  if (listing.virtual_tour_url || listing.virtual_tour_file) {

    badgeLabels.push("Virtual Tour");

  }

  if (Array.isArray(floorPlans) && floorPlans.length > 0) {

    badgeLabels.push("Floor Plan");

  }

  if (Array.isArray(stagingPhotos) && stagingPhotos.length > 0) {

    badgeLabels.push("Virtual Staging");

  }

  if (

    (Array.isArray(photos) && photos.length >= 5) ||

    (Array.isArray(panoramaPhotos) && panoramaPhotos.length > 0)

  ) {

    badgeLabels.push("Photo Tour");

  }



  return {

    is_new: isNew,

    is_featured: isFeatured,

    is_showcase: isShowcase,

    is_price_drop: isPriceDrop,

    is_live: isLive,

    listing_age_days: listingAgeDays,

    listing_type_label: listingTypeLabel,

    badge_labels: [...new Set(badgeLabels)],
  };
};

const hashAnalyticsValue = (value) =>
  crypto
    .createHash("sha256")
    .update(String(value || "unknown"))
    .digest("hex");

const getRequestIp = (req) => {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }

  return req.ip || req.socket?.remoteAddress || "unknown";
};

const recordListingView = async ({ req, productId, viewerId }) => {
  if (!productId) return { counted: false, viewsCount: null };

  try {
    const viewerHash = hashAnalyticsValue(getRequestIp(req));
    const userAgentHash = hashAnalyticsValue(req.headers["user-agent"] || "");

    const insertResult = await pool.query(
      `
      INSERT INTO listing_view_events (
        product_id,
        viewer_id,
        viewer_hash,
        user_agent_hash,
        viewed_on,
        created_at
      )
      VALUES ($1, $2, $3, $4, CURRENT_DATE, NOW())
      ON CONFLICT DO NOTHING
      RETURNING id
      `,
      [productId, viewerId ? String(viewerId) : null, viewerHash, userAgentHash],
    );

    if (!insertResult.rowCount) {
      return { counted: false, viewsCount: null };
    }

    const updateResult = await pool.query(
      `
      UPDATE listings
      SET views_count = COALESCE(views_count, 0) + 1,
          updated_at = COALESCE(updated_at, NOW())
      WHERE product_id = $1
      RETURNING views_count
      `,
      [productId],
    );

    return {
      counted: true,
      viewsCount: updateResult.rows[0]?.views_count ?? null,
    };
  } catch (err) {
    console.warn("[Listings] View analytics skipped:", err?.message);
    return { counted: false, viewsCount: null };
  }
};

const buildListingAnalytics = (listing = {}, badgeMeta = {}) => {
  const views = Number(listing.views_count || 0);
  const saves = Number(listing.saves_count || listing.saved_count || 0);
  const shares = Number(listing.shares_count || 0);
  const contacts = Number(listing.contact_count || 0);
  const tours = Number(listing.tour_request_count || 0);
  const currentPrice = Number(listing.price || 0);
  const previousPrice = Number(
    listing.previous_price ||
      listing.original_price ||
      listing.old_price ||
      listing.price_before_discount ||
      0,
  );
  const computedDrop =
    previousPrice > currentPrice && currentPrice > 0
      ? previousPrice - currentPrice
      : Number(listing.price_drop_amount || listing.price_cut || 0);
  const priceDropPercent =
    previousPrice > currentPrice && previousPrice > 0
      ? Number((((previousPrice - currentPrice) / previousPrice) * 100).toFixed(1))
      : Number(listing.price_drop_percent || 0);
  const daysOnMarket =
    badgeMeta.listing_age_days !== null && badgeMeta.listing_age_days !== undefined
      ? Math.max(0, Number(badgeMeta.listing_age_days))
      : Number(listing.days_on_market || 0);

  return {
    views_count: views,
    saves_count: saves,
    shares_count: shares,
    contact_count: contacts,
    tour_request_count: tours,
    engagement_total: views + saves + shares + contacts + tours,
    views_per_day:
      daysOnMarket > 0 ? Number((views / daysOnMarket).toFixed(1)) : views,
    save_rate:
      views > 0 ? Number(((saves / views) * 100).toFixed(1)) : 0,
    contact_rate:
      views > 0 ? Number(((contacts / views) * 100).toFixed(1)) : 0,
    previous_price: previousPrice || null,
    price_drop_amount: computedDrop > 0 ? computedDrop : 0,
    price_drop_percent: priceDropPercent > 0 ? priceDropPercent : 0,
    is_price_drop: badgeMeta.is_price_drop || computedDrop > 0,
    last_price_drop_at: listing.last_price_drop_at || null,
  };
};

const LISTING_TYPE_FILTER_GROUPS = {
  buy: ["sale", "buy", "for_sale", "for sale"],
  sale: ["sale", "buy", "for_sale", "for sale"],
  rent: ["rent", "rental", "for_rent", "for rent"],
  lease: ["lease", "long_lease", "commercial_lease", "long lease"],
  shortlet: [
    "shortlet",
    "short-let",
    "short_let",
    "short let",
    "short stay",
    "short_let_stay",
  ],
};

const normalizeFilterToken = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

const parseCsv = (value) =>
  String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

const getListingTypeFilterValues = ({
  category,
  listing_type_group,
  listing_types,
  type,
}) => {
  const values = [];

  parseCsv(listing_types).forEach((item) => values.push(item));

  const groupKey = normalizeFilterToken(listing_type_group);
  if (LISTING_TYPE_FILTER_GROUPS[groupKey]) {
    values.push(...LISTING_TYPE_FILTER_GROUPS[groupKey]);
  } else if (listing_type_group) {
    values.push(listing_type_group);
  }

  if (type) values.push(type);
  if (category) values.push(category);

  return [...new Set(values.map(normalizeFilterToken).filter(Boolean))];
};

const getNumericQueryValue = (value) => {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
};

const getBooleanQueryValue = (value) => {
  if (value === true || value === "true" || value === "1" || value === 1) {
    return true;
  }

  if (value === false || value === "false" || value === "0" || value === 0) {
    return false;
  }

  return null;
};

const getLimitedResultCount = (value) => {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return 500;
  return Math.min(Math.max(Math.floor(numberValue), 1), 1000);
};

/* ----------------- AWS S3 MEDIA HELPERS ----------------- */


const AWS_S3_BUCKET = process.env.AWS_S3_BUCKET;

const LISTING_UPLOAD_CONCURRENCY = Number(

  process.env.LISTING_UPLOAD_CONCURRENCY || 3,

);

const LISTING_PHOTO_LIMITS = {

  free: 25,

  basic: 25,



  pro: 65,

  pro_agent: 65,

  professional: 65,



  elite: 100,

  elite_agent: 100,

  plus: 100,



  brokerage: 150,

  brokerage_basic: 75,

  brokerage_pro: 150,

  brokerage_elite: 250,

  enterprise: 250,

};



const getListingPhotoLimit = (user = {}) => {

  const plan = String(

    user.subscription_plan || user.plan || user.account_plan || "free",

  ).toLowerCase();



  return LISTING_PHOTO_LIMITS[plan] || 25;

};



const isVideoFile = (file) => String(file?.mimetype || "").startsWith("video/");

const isImageFile = (file) => String(file?.mimetype || "").startsWith("image/");



const chunkArray = (arr = [], size = 3) => {

  const chunks = [];



  for (let i = 0; i < arr.length; i += size) {

    chunks.push(arr.slice(i, i + size));

  }



  return chunks;

};



const uploadListingImageToS3 = async (file, listingId) => {

  if (!file) return null;



  if (!isImageFile(file)) {

    throw new Error(`Invalid image file type: ${file.mimetype}`);

  }



  const uploaded = await uploadToS3(file, `listings/${listingId}/photos`, {

    visibility: "public",

    cacheControl: "public, max-age=31536000, immutable",

  });



  return {

    url: uploaded.url,

    key: uploaded.key,

    public_id: uploaded.key,

    type: "image",

    provider: "s3",

    bucket: uploaded.bucket,

  };

};



const uploadListingVideoToS3 = async (file, listingId, kind = "video") => {

  if (!file) return null;



  if (!isVideoFile(file)) {

    throw new Error(`Invalid video file type: ${file.mimetype}`);

  }



  const folder =

    kind === "virtual_tour"

      ? `listings/${listingId}/virtual-tours`

      : `listings/${listingId}/videos`;



  const uploaded = await uploadToS3(file, folder, {

    visibility: "public",

    cacheControl: "public, max-age=31536000, immutable",

  });



  return {

    url: uploaded.url,

    key: uploaded.key,

    public_id: uploaded.key,

    type: "video",

    provider: "s3",

    bucket: uploaded.bucket,

  };

};



const deleteS3Asset = async (key) => {

  if (!key || !AWS_S3_BUCKET) return;



  try {

    await s3.send(

      new DeleteObjectCommand({

        Bucket: AWS_S3_BUCKET,

        Key: key,

      }),

    );

  } catch (err) {

    console.warn("⚠️ Failed to delete S3 asset:", key, err.message);

  }

};



const deleteListingAsset = async (asset) => {

  if (!asset) return;



  const key =

    typeof asset === "string"

      ? asset

      : asset.key || asset.s3_key || asset.public_id || null;



  if (!key) return;



  await deleteS3Asset(key);

};



const uploadPhotosWithLimit = async (

  photoFiles = [],

  listingId,

  photoLimit = 25,

) => {

  const uploadedPhotos = [];

  const validPhotos = photoFiles.filter(Boolean).slice(0, photoLimit);

  const chunks = chunkArray(validPhotos, LISTING_UPLOAD_CONCURRENCY);



  for (const chunk of chunks) {

    const results = await Promise.allSettled(

      chunk.map((file) => uploadListingImageToS3(file, listingId)),

    );



    for (const result of results) {

      if (result.status === "fulfilled" && result.value) {

        uploadedPhotos.push(result.value);

      } else {

        console.error(

          "❌ Photo upload failed:",

          result.reason?.message || result.reason,

        );

      }

    }

  }



  return uploadedPhotos;

};



/* ----------------- geocoding ----------------- */



const processGeolocation = async (address, city, state, country, zip) => {
  const userAgent = "KeyviaApp/1.0";
  const compact = (...parts) =>
    parts
      .map((part) => String(part || "").trim())
      .filter(Boolean)
      .join(", ");
  const queries = [
    compact(address, city, state, zip, country),
    compact(address, city, state, country),
    compact(address, city, country),
    compact(city, state, country),
    compact(state, country),
  ].filter(Boolean);
  const queryMap = new Map();
  queries.forEach((query) => queryMap.set(query.toLowerCase(), query));
  const uniqueQueries = Array.from(queryMap.values());

  if (!uniqueQueries.length) return null;


  for (let attempt = 1; attempt <= Math.min(5, uniqueQueries.length); attempt++) {
    try {

      await sleep(1000 * attempt);



      const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(

        uniqueQueries[Math.min(attempt - 1, uniqueQueries.length - 1)],
      )}&addressdetails=1&limit=1`;



      const res = await axios.get(url, {

        headers: { "User-Agent": userAgent },

        timeout: 10000,

      });



      if (res.data && res.data.length > 0) {

        const result = res.data[0];

        console.log("✅ Location found:", result.display_name);



        return {

          lat: parseFloat(result.lat),

          lng: parseFloat(result.lon),

        };

      }



      return null;

    } catch (error) {

      if (error.response?.status === 429) {

        console.warn(

          `⏳ Geocoding rate limit hit. Retrying attempt ${attempt}/3...`,

        );

      } else {

        console.error("❌ Geocoding API Error:", error.message);

        if (attempt === Math.min(5, uniqueQueries.length)) return null;
      }

    }

  }



  return null;

};



/* ----------------- background workers ----------------- */



const runBackgroundProcessing = async (

  listingId,

  photoFiles,

  addressData,

  videoFile,

  virtualFile,

) => {

  console.log(`⚙️ AWS background processing started for ${listingId}...`);



  try {

    const uploadedPhotos = await uploadPhotosWithLimit(

      photoFiles,

      listingId,

      25,

    );



    let finalVideoUrl = null;

    let finalVideoKey = null;



    if (videoFile) {

      try {

        const uploadedVideo = await uploadListingVideoToS3(

          videoFile,

          listingId,

          "video",

        );

        finalVideoUrl = uploadedVideo?.url || null;

        finalVideoKey = uploadedVideo?.key || null;

      } catch (err) {

        console.error("❌ Video upload failed:", err.message);

      }

    }



    let finalVirtualUrl = null;

    let finalVirtualKey = null;



    if (virtualFile) {

      try {

        const uploadedVirtual = await uploadListingVideoToS3(

          virtualFile,

          listingId,

          "virtual_tour",

        );

        finalVirtualUrl = uploadedVirtual?.url || null;

        finalVirtualKey = uploadedVirtual?.key || null;

      } catch (err) {

        console.error("❌ Virtual tour upload failed:", err.message);

      }

    }



    let coords = {

      lat: addressData?.lat,

      lng: addressData?.lng,

    };



    if (!coords.lat || !coords.lng) {

      const geo = await processGeolocation(

        addressData.address,

        addressData.city,

        addressData.state,

        addressData.country,

        addressData.zip,

      );



      if (geo) coords = geo;

    }



    await pool.query(

      `

      UPDATE listings

      SET

        photos = $1,

        latitude = $2,

        longitude = $3,

        video_url = $4,

        video_public_id = $5,

        virtual_tour_url = $6,

        virtual_tour_public_id = $7,

        status = CASE

          WHEN status = 'approved' THEN 'approved'

          ELSE 'pending'

        END,

        updated_at = NOW()

      WHERE product_id = $8

      `,

      [

        JSON.stringify(uploadedPhotos),

        coords.lat || 0,

        coords.lng || 0,

        finalVideoUrl,

        finalVideoKey,

        finalVirtualUrl,

        finalVirtualKey,

        listingId,

      ],

    );



    console.log(`✅ AWS media processing complete for ${listingId}.`);

  } catch (error) {

    console.error(

      `❌ AWS background processing failed for ${listingId}:`,

      error,

    );



    try {

      await pool.query(

        `

        UPDATE listings

        SET status = 'draft',

            admin_notes = $1,

            updated_at = NOW()

        WHERE product_id = $2

        `,

        [

          `System Error: Upload failed. Please try again. (${error.message})`,

          listingId,

        ],

      );

    } catch (dbErr) {

      console.error("❌ Failed to mark listing as draft:", dbErr.message);

    }

  }

};



const runUpdateBackgroundProcessing = async (listingId, data = {}) => {

  const {

    photoFiles = [],

    videoFile = null,

    virtualFile = null,

    removeList = [],

    addressData = {},

    addressChanged = false,

  } = data;



  console.log(`⚙️ AWS background update started for ${listingId}...`);



  try {

    if (removeList.length > 0) {

      Promise.allSettled(

        removeList.map((asset) => deleteListingAsset(asset)),

      ).catch((err) =>

        console.warn("⚠️ Background S3 delete failed:", err.message),

      );

    }



    const uploadedPhotos = await uploadPhotosWithLimit(

      photoFiles,

      listingId,

      25,

    );



    const currentRes = await pool.query(

      "SELECT photos FROM listings WHERE product_id = $1",

      [listingId],

    );



    let currentPhotos = normalizeExistingPhotos(

      currentRes.rows[0]?.photos || [],

    );



    if (removeList.length > 0) {

      const removeSet = new Set(

        removeList.map((item) =>

          typeof item === "string"

            ? item

            : item?.key || item?.s3_key || item?.public_id,

        ),

      );



      currentPhotos = currentPhotos.filter((photo) => {

        const key = photo.key || photo.s3_key || photo.public_id;

        return !removeSet.has(key);

      });

    }



    const finalPhotos = [...currentPhotos, ...uploadedPhotos].slice(0, 25);



    let geoUpdates = {};



    if (addressChanged) {

      const coords = await processGeolocation(

        addressData.address,

        addressData.city,

        addressData.state,

        addressData.country,

        addressData.zip,

      );



      if (coords) {

        geoUpdates.latitude = coords.lat;

        geoUpdates.longitude = coords.lng;

      }

    }



    let videoUpdates = {};



    if (videoFile) {

      try {

        const uploadedVideo = await uploadListingVideoToS3(

          videoFile,

          listingId,

          "video",

        );

        videoUpdates.video_url = uploadedVideo?.url || null;

        videoUpdates.video_public_id = uploadedVideo?.key || null;

      } catch (err) {

        console.error("❌ Video update upload failed:", err.message);

      }

    }



    if (virtualFile) {

      try {

        const uploadedVirtual = await uploadListingVideoToS3(

          virtualFile,

          listingId,

          "virtual_tour",

        );

        videoUpdates.virtual_tour_url = uploadedVirtual?.url || null;

        videoUpdates.virtual_tour_public_id = uploadedVirtual?.key || null;

      } catch (err) {

        console.error("❌ Virtual tour update upload failed:", err.message);

      }

    }



    const fields = ["photos = $1", "updated_at = NOW()"];

    const values = [JSON.stringify(finalPhotos)];

    let idx = 2;



    if (geoUpdates.latitude && geoUpdates.longitude) {

      fields.push(`latitude = $${idx++}`);

      values.push(geoUpdates.latitude);



      fields.push(`longitude = $${idx++}`);

      values.push(geoUpdates.longitude);

    }



    if (videoUpdates.video_url) {

      fields.push(`video_url = $${idx++}`);

      values.push(videoUpdates.video_url);



      fields.push(`video_public_id = $${idx++}`);

      values.push(videoUpdates.video_public_id);

    }



    if (videoUpdates.virtual_tour_url) {

      fields.push(`virtual_tour_url = $${idx++}`);

      values.push(videoUpdates.virtual_tour_url);



      fields.push(`virtual_tour_public_id = $${idx++}`);

      values.push(videoUpdates.virtual_tour_public_id);

    }



    values.push(listingId);



    await pool.query(

      `

      UPDATE listings

      SET ${fields.join(", ")}

      WHERE product_id = $${idx}

      `,

      values,

    );



    console.log(`✅ AWS listing update processing complete for ${listingId}.`);

  } catch (err) {

    console.error(`❌ AWS background update failed for ${listingId}:`, err);



    try {

      await pool.query(

        `

        UPDATE listings

        SET admin_notes = $1,

            updated_at = NOW()

        WHERE product_id = $2

        `,

        [`System Error: Media update failed. (${err.message})`, listingId],

      );

    } catch (dbErr) {

      console.error("❌ Failed to save update failure note:", dbErr.message);

    }

  }

};



const runDeleteBackgroundCleanup = async (assets = []) => {

  console.log(`🗑️ Starting AWS cleanup for ${assets.length} assets...`);



  try {

    const results = await Promise.allSettled(

      assets.map((asset) => deleteListingAsset(asset)),

    );

    const failed = results.filter((result) => result.status === "rejected");



    if (failed.length) {

      console.warn(`⚠️ ${failed.length} S3 assets failed to delete.`);

    }



    console.log("✅ AWS background cleanup complete.");

  } catch (err) {

    console.error("❌ AWS background cleanup error:", err.message);

  }

};



/* -------------------------------------------------------

   CREATE LISTING

------------------------------------------------------- */

export const createListing = async (req, res) => {

  try {

    const userId = req.user?.unique_id;



    if (!userId) {

      return res.status(401).json({

        message: "Unauthorized",

        code: "UNAUTHORIZED",

      });

    }



    const userRes = await pool.query(

      `

      SELECT

        unique_id,

        email,

        name,

        role,

        verification_status,

        is_verified,

        is_verified_agent,

        is_banned,

        subscription_plan,

        subscription_status,

        linked_agency_id,

        is_solo_agent,

        brokerage_name

      FROM users

      WHERE unique_id = $1::uuid

      LIMIT 1;

      `,

      [String(userId)],

    );



    const currentUser = userRes.rows[0];



    if (!currentUser) {

      return res.status(401).json({

        message: "User account not found.",

        code: "USER_NOT_FOUND",

      });

    }



    const photoLimit = getListingPhotoLimit(currentUser);



    if (currentUser.is_banned) {

      return res.status(403).json({

        message: "Your account is restricted from creating listings.",

        code: "ACCOUNT_RESTRICTED",

      });

    }



    const verificationStatus = String(

      currentUser.verification_status || req.user?.verification_status || "",

    ).toLowerCase();



    const isVerifiedUser =

      currentUser.is_verified === true ||

      verificationStatus === "approved" ||

      verificationStatus === "verified";



    if (!isVerifiedUser) {

      return res.status(403).json({

        message: "You must complete verification before creating listings.",

        code: "VERIFICATION_REQUIRED",

      });

    }



    const allowedListingRoles = new Set([

      "agent",

      "owner",

      "brokerage_owner",

      "admin",

      "super_admin",

    ]);



    const role = String(currentUser.role || req.user?.role || "").toLowerCase();



    if (!allowedListingRoles.has(role)) {

      return res.status(403).json({

        message: "Your account role cannot create property listings.",

        code: "ROLE_NOT_ALLOWED",

      });

    }



    const limitCheck = await enforceListingLimit({ userId });



    if (!limitCheck.allowed) {

      return res.status(403).json({

        message: limitCheck.message,

        code: "LISTING_LIMIT_REACHED",

      });

    }



    const b = req.body;
    if (b.listing_type) b.listing_type = normalizeListingType(b.listing_type);

    if (!b.title || !b.price || !b.address) {

      return res.status(400).json({
        message: "Missing required fields.",

        code: "MISSING_REQUIRED_FIELDS",

      });

    }



    const price = toNumberOrNull(b.price);



    if (!price || price <= 0) {

      return res.status(400).json({

        message: "Invalid listing price.",

        code: "INVALID_PRICE",

      });

    }



    const product_id = await generateUniqueProductId();



    const safePhotos = Array.isArray(b.photos)

      ? b.photos.slice(0, photoLimit)

      : [];



    const featuresArr = normalizeFeatures(b.features || b.amenities);



    const amenitiesArr = Array.isArray(b.amenities)

      ? b.amenities

      : normalizeFeatures(b.amenities);



    const paymentOptions = Array.isArray(b.payment_options)

      ? b.payment_options

      : safeJsonParse(b.payment_options, []);



    const preferredTourDays = Array.isArray(b.preferred_tour_days)

      ? b.preferred_tour_days

      : safeJsonParse(b.preferred_tour_days, []);



    const latitude = toNumberOrNull(b.latitude);

    const longitude = toNumberOrNull(b.longitude);



    const areaSqft = toNumberOrNull(

      b.area_sqft || b.square_footage || b.squareFootage,

    );



    const landAreaSqft = toNumberOrNull(

      b.land_area_sqft || b.lot_size || b.lotSize,

    );



    const videoUrl = b.video?.url || b.video_url || null;

    const videoKey = b.video?.key || b.video_public_id || null;



    const virtualUrl =

      b.virtual_tour_file?.url ||

      b.virtual_tour?.url ||

      b.virtual_tour_url ||

      null;



    const virtualKey =

      b.virtual_tour_file?.key ||

      b.virtual_tour?.key ||

      b.virtual_tour_public_id ||

      null;



    const isBrokerageCreator = ["brokerage", "brokerage_owner"].includes(role);

    const isAgencyAgentCreator =

      role === "agent" &&

      (currentUser.is_solo_agent === false || currentUser.linked_agency_id);

    const listingAgencyId =

      b.agency_id ||

      b.agencyId ||

      (isBrokerageCreator

        ? String(userId)

        : isAgencyAgentCreator

          ? currentUser.linked_agency_id

          : null);

    let assignedAgentId = b.assigned_agent_id || b.assignedAgentId || null;



    if (assignedAgentId) {

      if (!isBrokerageCreator || !listingAgencyId) {

        return res.status(403).json({

          message: "Only brokerages can assign a listing to an agency agent.",

          code: "ASSIGNMENT_NOT_ALLOWED",

        });

      }



      const assignedCheck = await pool.query(

        `

        SELECT u.unique_id

        FROM users u

        LEFT JOIN agent_profiles ap

          ON ap.unique_id::text = u.unique_id::text

        WHERE u.unique_id::text = $1::text

          AND LOWER(u.role::text) IN ('agent', 'agency_agent', 'agencyagent', 'brokerage_agent')

          AND (

            u.linked_agency_id::text = $2::text

            OR ap.linked_agency_id::text = $2::text

          )

        LIMIT 1

        `,

        [assignedAgentId, listingAgencyId],

      );



      if (!assignedCheck.rows.length) {

        return res.status(400).json({

          message: "Assigned agent is not connected to this brokerage.",

          code: "INVALID_ASSIGNED_AGENT",

        });

      }



      assignedAgentId = assignedCheck.rows[0].unique_id;

    }



    const result = await pool.query(

      `

      INSERT INTO listings (

        product_id,

        draft_listing_id,

        uploaded_by_id,

        created_by,

        agent_unique_id,

        agency_id,

        assigned_agent_id,



        title,

        description,



        property_type,

        property_subtype,

        listing_type,

        category,



        price,

        currency,

        price_currency,

        price_period,



        estimated_monthly_payment,

        down_payment_percent,

        interest_rate_estimate,

        hoa_fee,

        service_charge,

        property_tax_estimate,

        insurance_estimate,

        price_per_sqft,

        price_negotiable,

        payment_options,



        bedrooms,

        bathrooms,

        total_rooms,

        floors,

        floor_number,

        total_floors,

        garage_spaces,

        area_sqft,

        square_footage,

        land_area_sqft,

        lot_size,

        building_area_unit,

        land_area_unit,

        year_built,

        parking,

        furnishing,

        property_condition,

        construction_status,

        ownership_type,



        address,

        city,

        state,

        country,

        postal_code,

        zip_code,

        neighborhood,

        estate_name,

        landmark,

        road_access,



        latitude,

        longitude,

        geom,



        power_supply,

        water_supply,

        internet_available,

        drainage,

        security_type,

        generator_available,

        borehole,

        prepaid_meter,

        waste_disposal,



        caution_fee,

        agency_fee,

        legal_fee,

        refundable_deposit,

        minimum_rent_duration,

        rent_payment_frequency,

        pets_policy,

        smoking_policy,

        guest_policy,



        mortgage_available,

        installment_available,

        rent_to_own_available,

        closing_cost_estimate,



        title_document_type,

        title_verified,

        title_document_file,

        survey_available,

        building_approval_available,



        photos,

        floor_plans,

        staging_photos,

        panorama_photos,

        video_url,

        video_public_id,

        virtual_tour_url,

        virtual_tour_public_id,

        virtual_tour_file,

        three_d_home_url,



        allow_tour_requests,

        allow_video_tour,

        allow_in_person_tour,

        preferred_tour_days,

        preferred_tour_times,

        minimum_notice_hours,



        availability_status,

        available_from,



        contact_name,

        contact_email,

        contact_phone,

        contact_method,

        show_contact_phone,



        features,

        amenities,



        status,

        moderation_status,

        is_active,

        payment_status,

        listed_at,

        last_updated_at,

        created_at,

        updated_at,

        project_id,

        nightly_rate,

        min_stay,

        max_stay,

        cleaning_fee,

        lease_deposit,

        lease_term_months,

        lease_type

      )

      VALUES (

        $1,$2,$3::uuid,$3::uuid,$3::uuid,$4,$104::uuid,



        $5,$6,



        $7,$8,$9,$10,



        $11,$12,$12,$13,



        $14,$15,$16,$17,$18,$19,$20,$21,$22,$23::jsonb,



        $24,$25,$26,$27,$28,$29,$30,$31,$31,$32,$32,$33,$34,$35,$36,$37,$38,$39,$40,



        $41,$42,$43,$44,$45,$45,$46,$47,$48,$49,



        $50,$51,

        CASE

          WHEN $50::numeric IS NOT NULL AND $51::numeric IS NOT NULL

          THEN ST_SetSRID(ST_MakePoint($51::numeric, $50::numeric), 4326)

          ELSE NULL

        END,



        $52,$53,$54,$55,$56,$57,$58,$59,$60,



        $61,$62,$63,$64,$65,$66,$67,$68,$69,



        $70,$71,$72,$73,



        $74,$75,$76::jsonb,$77,$78,



        $79::jsonb,$80::jsonb,$81::jsonb,$82::jsonb,$83,$84,$85,$86,$87::jsonb,$88,



        $89,$90,$91,$92::jsonb,$93,$94,



        $95,$96,



        $97,$98,$99,$100,$101,



        $102::jsonb,$103::jsonb,



        'pending',

        'pending',

        false,

        'unpaid',

        NOW(),

        NOW(),

        NOW(),

        NOW(),

        $105::bigint,

        $106,$107,$108,$109,$110,$111,$112

      )

      RETURNING *;

      `,

      [

        product_id,

        b.draft_listing_id || b.draftListingId || product_id,

        String(userId),

        listingAgencyId,



        b.title,

        b.description || null,



        b.property_type || b.propertyType || null,

        b.property_subtype || b.propertySubtype || null,

        b.listing_type || b.listingType || null,

        b.category || b.listing_type || b.listingType || null,



        price,

        b.currency || b.price_currency || b.priceCurrency || "USD",

        b.price_period || b.pricePeriod || null,



        toNumberOrNull(b.estimated_monthly_payment),

        toNumberOrNull(b.down_payment_percent),

        toNumberOrNull(b.interest_rate_estimate),

        toNumberOrNull(b.hoa_fee),

        toNumberOrNull(b.service_charge),

        toNumberOrNull(b.property_tax_estimate),

        toNumberOrNull(b.insurance_estimate),

        toNumberOrNull(b.price_per_sqft),

        b.price_negotiable === true,

        JSON.stringify(paymentOptions),



        toNumberOrNull(b.bedrooms),

        toNumberOrNull(b.bathrooms),

        toNumberOrNull(b.total_rooms),

        toNumberOrNull(b.floors),

        toNumberOrNull(b.floor_number),

        toNumberOrNull(b.total_floors),

        toNumberOrNull(b.garage_spaces),

        areaSqft,

        landAreaSqft,

        b.building_area_unit || "sqft",

        b.land_area_unit || "sqft",

        toNumberOrNull(b.year_built || b.yearBuilt),

        b.parking || null,

        b.furnishing || null,

        b.property_condition || null,

        b.construction_status || null,

        b.ownership_type || null,



        b.address,

        b.city || null,

        b.state || null,

        b.country || null,

        b.postal_code || b.zip_code || b.zipCode || null,

        b.neighborhood || null,

        b.estate_name || b.estateName || null,

        b.landmark || null,

        b.road_access || b.roadAccess || null,



        latitude,

        longitude,



        b.power_supply || null,

        b.water_supply || null,

        b.internet_available === true,

        b.drainage || null,

        b.security_type || null,

        b.generator_available === true,

        b.borehole === true,

        b.prepaid_meter === true,

        b.waste_disposal || null,



        toNumberOrNull(b.caution_fee),

        toNumberOrNull(b.agency_fee),

        toNumberOrNull(b.legal_fee),

        toNumberOrNull(b.refundable_deposit),

        b.minimum_rent_duration || null,

        b.rent_payment_frequency || null,

        b.pets_policy || null,

        b.smoking_policy || null,

        b.guest_policy || null,



        b.mortgage_available === true,

        b.installment_available === true,

        b.rent_to_own_available === true,

        toNumberOrNull(b.closing_cost_estimate),



        b.title_document_type || null,

        false,

        b.title_document_file ? JSON.stringify(b.title_document_file) : null,

        b.survey_available === true,

        b.building_approval_available === true,



        JSON.stringify(safePhotos),

        JSON.stringify(Array.isArray(b.floor_plans) ? b.floor_plans : []),

        JSON.stringify(Array.isArray(b.staging_photos) ? b.staging_photos : []),

        JSON.stringify(

          Array.isArray(b.panorama_photos) ? b.panorama_photos : [],

        ),

        videoUrl,

        videoKey,

        virtualUrl,

        virtualKey,

        b.virtual_tour_file ? JSON.stringify(b.virtual_tour_file) : null,

        b.three_d_home_url || b.threeDHomeUrl || null,



        b.allow_tour_requests !== false,

        b.allow_video_tour !== false,

        b.allow_in_person_tour !== false,

        JSON.stringify(preferredTourDays),

        b.preferred_tour_times || null,

        toNumberOrNull(b.minimum_notice_hours) || 24,



        b.availability_status || "available_now",

        b.available_from || null,



        b.contact_name || b.contactName || currentUser.name || null,

        b.contact_email || b.contactEmail || currentUser.email || null,

        b.contact_phone || b.contactPhone || null,

        b.contact_method || b.contactMethod || "platform",

        b.show_contact_phone === true,



        JSON.stringify(featuresArr),

        JSON.stringify(amenitiesArr),

        assignedAgentId,

        b.project_id ? Number(b.project_id) : null,

        toNumberOrNull(b.nightly_rate || b.nightlyRate),

        toNumberOrNull(b.min_stay || b.minStay),

        toNumberOrNull(b.max_stay || b.maxStay),

        toNumberOrNull(b.cleaning_fee || b.cleaningFee),

        toNumberOrNull(b.lease_deposit || b.leaseDeposit),

        toNumberOrNull(b.lease_term_months || b.leaseTermMonths),

        b.lease_type || b.leaseType || null,

      ],

    );



    let listing = result.rows[0];
    listing = (await updateListingLocationMetadata(product_id, b)) || listing;
    listing = (await updateListingFinancialMetadata(product_id, b)) || listing;

    notifyListingSubmitted(listing, { io: req.io });
    maybeTriggerLocationScan(listing);

    if (assignedAgentId) {
      notifyListingAssigned({
        listing,
        agentId: assignedAgentId,
        brokerageId: listingAgencyId || userId,
        brokerageName: currentUser.brokerage_name || currentUser.name || "Keyvia Brokerage",
        io: req.io,
      });
    }

    return res.status(201).json({
      success: true,
      message: "Listing submitted for review.",

      listing: {

        ...listing,

        photos: normalizePhotosForResponse(listing.photos),

        floor_plans: safeJsonParse(listing.floor_plans, []),

        staging_photos: safeJsonParse(listing.staging_photos, []),

        panorama_photos: safeJsonParse(listing.panorama_photos, []),

        features: safeJsonParse(listing.features, []),

        amenities: safeJsonParse(listing.amenities, []),



        agent_unique_id: listing.uploaded_by_id,

        created_by: listing.uploaded_by_id,

        price_currency: listing.price_currency || listing.currency || "USD",

        square_footage: listing.square_footage || listing.area_sqft || null,

        zip_code: listing.zip_code || listing.postal_code || null,

        payment_status: listing.payment_status || "unpaid",

      },

    });

  } catch (err) {

    console.error("[CreateListing] Error:", err);



    return res.status(500).json({

      message: "Failed to create listing",

      code: "CREATE_LISTING_FAIL",

      details: err?.message,

    });

  }

};



/* -------------------------------------------------------

   UPDATE LISTING - DIRECT S3 / PRODUCTION STYLE

------------------------------------------------------- */

export const updateListing = async (req, res) => {

  try {

    const product_id =

      req.params.product_id || req.params.id || req.params.productId;



    const userId = req.user?.unique_id;

    const role = String(req.user?.role || "").toLowerCase();



    if (!userId) {

      return res.status(401).json({ message: "Unauthorized" });

    }



    const found = await pool.query(

      "SELECT * FROM listings WHERE product_id=$1",

      [product_id],

    );



    const listing = found.rows[0];



    if (!listing) {

      return res.status(404).json({ message: "Listing not found" });

    }



    const allowedIds = [

      listing.uploaded_by_id,

      listing.agent_unique_id,

      listing.created_by,

      listing.assigned_agent_id,

      listing.agency_id,

      listing.brokerage_id,

    ]

      .filter(Boolean)

      .map((v) => String(v));



    const canManage =

      allowedIds.includes(String(userId)) ||

      role === "admin" ||

      role === "super_admin";



    if (!canManage) {

      return res.status(403).json({ message: "Forbidden" });

    }

    const currentStatus = String(listing.status || "").toLowerCase();
    const reviewLockedStatuses = new Set([
      "pending",
      "under_review",
      "reviewing",
      "processing",
    ]);

    if (reviewLockedStatuses.has(currentStatus)) {
      return res.status(409).json({
        success: false,
        message:
          "This listing is already under review. You can edit it after the admin verdict.",
        code: "LISTING_UNDER_REVIEW",
      });
    }

    const b = req.body;
    if (b.listing_type) b.listing_type = normalizeListingType(b.listing_type);

    const toNum = (value, previous) => {

      if (value === undefined || value === null || value === "")
        return previous;

      const n = Number(value);

      return Number.isFinite(n) ? n : previous;

    };



    let currentPhotos = normalizeExistingPhotos(listing.photos || []);



    let removeList = [];

    try {

      if (b.removePhotos) {

        removeList =

          typeof b.removePhotos === "string"

            ? JSON.parse(b.removePhotos)

            : b.removePhotos;

      }

    } catch {

      removeList = [];

    }



    if (removeList.length > 0) {

      const removeSet = new Set(

        removeList.map((item) =>

          typeof item === "string"

            ? item

            : item?.key || item?.s3_key || item?.public_id,

        ),

      );



      currentPhotos = currentPhotos.filter((photo) => {

        const key = photo.key || photo.s3_key || photo.public_id;

        return !removeSet.has(key);

      });

    }



    const incomingPhotos = Array.isArray(b.photos)

      ? normalizeExistingPhotos(b.photos)

      : [];



    let finalPhotos = [...currentPhotos, ...incomingPhotos];



    if (b.existingPhotos) {

      const orderedPhotos = normalizeExistingPhotos(b.existingPhotos);

      const photoMap = new Map(

        finalPhotos.map((photo) => [

          photo.key || photo.s3_key || photo.public_id || photo.url,

          photo,

        ]),

      );



      const reordered = [];



      orderedPhotos.forEach((photo) => {

        const key = photo.key || photo.s3_key || photo.public_id || photo.url;

        if (photoMap.has(key)) {

          reordered.push(photoMap.get(key));

        }

      });



      finalPhotos.forEach((photo) => {

        const key = photo.key || photo.s3_key || photo.public_id || photo.url;

        const alreadyAdded = reordered.some((item) => {

          const itemKey = item.key || item.s3_key || item.public_id || item.url;

          return itemKey === key;

        });



        if (!alreadyAdded) {

          reordered.push(photo);

        }

      });



      finalPhotos = reordered;

    }



    const planRes = await pool.query(

      `

  SELECT subscription_plan, subscription_status

  FROM users

  WHERE unique_id = $1::uuid

  LIMIT 1

  `,

      [String(userId)],

    );



    const photoLimit = getListingPhotoLimit(planRes.rows[0] || {});



    finalPhotos = finalPhotos.slice(0, photoLimit);



    const featuresArr = normalizeFeatures(

      b.features || b.amenities || listing.features,

    );



    const newAddr = b.address ?? listing.address;

    const newCity = b.city ?? listing.city;

    const newState = b.state ?? listing.state;

    const newCountry = b.country ?? listing.country;

    const newZip = b.zip_code || b.zipCode || b.postal_code || listing.zip_code;



    const latitude =

      b.latitude !== undefined && b.latitude !== null && b.latitude !== ""

        ? Number(b.latitude)

        : listing.latitude;



    const longitude =

      b.longitude !== undefined && b.longitude !== null && b.longitude !== ""

        ? Number(b.longitude)

        : listing.longitude;



    const videoUrl =

      b.video?.url !== undefined

        ? b.video.url

        : b.video_url !== undefined

          ? b.video_url

          : listing.video_url;



    const videoKey =

      b.video?.key !== undefined

        ? b.video.key

        : b.video_public_id !== undefined

          ? b.video_public_id

          : listing.video_public_id;



    const virtualTourUrl =

      b.virtual_tour?.url !== undefined

        ? b.virtual_tour.url

        : b.virtual_tour_url !== undefined

          ? b.virtual_tour_url

          : listing.virtual_tour_url;



    const virtualTourKey =
      b.virtual_tour?.key !== undefined
        ? b.virtual_tour.key
        : b.virtual_tour_public_id !== undefined
          ? b.virtual_tour_public_id
          : listing.virtual_tour_public_id;

    const hasChanged = (incoming, previous) => {
      if (incoming === undefined || incoming === null) return false;
      return String(incoming).trim() !== String(previous ?? "").trim();
    };

    const majorChangedFields = [];
    [
      ["price", b.price, listing.price],
      ["listing_type", b.listing_type || b.listingType, listing.listing_type],
      ["property_type", b.property_type || b.propertyType, listing.property_type],
      [
        "property_subtype",
        b.property_subtype || b.propertySubtype,
        listing.property_subtype,
      ],
      ["address", newAddr, listing.address],
      ["city", newCity, listing.city],
      ["state", newState, listing.state],
      ["country", newCountry, listing.country],
      ["latitude", latitude, listing.latitude],
      ["longitude", longitude, listing.longitude],
      ["bedrooms", b.bedrooms, listing.bedrooms],
      ["bathrooms", b.bathrooms, listing.bathrooms],
      ["year_built", b.year_built || b.yearBuilt, listing.year_built],
      [
        "square_footage",
        b.square_footage || b.squareFootage || b.area_sqft,
        listing.square_footage,
      ],
      ["lot_size", b.lot_size || b.lotSize || b.land_area_sqft, listing.lot_size],
    ].forEach(([field, incoming, previous]) => {
      if (hasChanged(incoming, previous)) majorChangedFields.push(field);
    });

    const floorPlansChanged =
      (b.floor_plans || b.floorPlans) &&
      JSON.stringify(safeJsonParse(b.floor_plans || b.floorPlans, [])) !==
        JSON.stringify(safeJsonParse(listing.floor_plans, []));
    const videoChanged = hasChanged(
      b.video?.url ?? b.video_url,
      listing.video_url,
    );
    const virtualTourChanged = hasChanged(
      b.virtual_tour?.url ?? b.virtual_tour_url ?? b.virtualTourUrl,
      listing.virtual_tour_url,
    );
    const threeDChanged = hasChanged(
      b.three_d_home_url ?? b.threeDHomeUrl,
      listing.three_d_home_url,
    );

    if (
      incomingPhotos.length > 0 ||
      removeList.length > 0 ||
      floorPlansChanged ||
      videoChanged ||
      virtualTourChanged ||
      threeDChanged ||
      b.title_document_file
    ) {
      majorChangedFields.push("media");
    }

    const wasApproved = ["approved", "live", "published"].includes(
      currentStatus,
    );
    const keepLiveAfterEdit = wasApproved && majorChangedFields.length === 0;
    const nextStatus = keepLiveAfterEdit ? listing.status : "pending";
    const nextIsActive = keepLiveAfterEdit ? listing.is_active : false;
    const nextModerationStatus = keepLiveAfterEdit
      ? listing.moderation_status || "approved"
      : "pending";
    const nextModerationReason = keepLiveAfterEdit
      ? "Minor listing edit auto-checked."
      : `Listing edited after submission; review required for: ${[
          ...new Set(majorChangedFields),
        ].join(", ") || "updated listing details"}.`;

    const query = `
      UPDATE listings SET
        title=$1,

        description=$2,

        price=$3,

        price_currency=$4,

        price_period=$5,

        category=$6,

        property_type=$7,

        listing_type=$8,

        address=$9,

        city=$10,

        state=$11,

        country=$12,

        zip_code=$13,

        latitude=$14,

        longitude=$15,

        bedrooms=$16,

        bathrooms=$17,

        parking=$18,

        year_built=$19,

        square_footage=$20,

        furnishing=$21,

        lot_size=$22,

        features=$23,

        photos=$24,

        video_url=$25,

        video_public_id=$26,

        virtual_tour_url=$27,

        virtual_tour_public_id=$28,

        contact_name=$29,

        contact_email=$30,

        contact_phone=$31,

        contact_method=$32,
        status=$33,
        is_active=$34,
        moderation_status=$35,
        moderation_reason=$36,
        last_updated_at=NOW(),
        nightly_rate=$38,
        min_stay=$39,
        max_stay=$40,
        cleaning_fee=$41,
        lease_deposit=$42,
        lease_term_months=$43,
        lease_type=$44,
        updated_at=NOW()
      WHERE product_id=$44
      RETURNING *;
    `;


    const params = [

      b.title ?? listing.title,

      b.description ?? listing.description,

      toNum(b.price, listing.price),

      b.price_currency ||

        b.priceCurrency ||

        b.currency ||

        listing.price_currency,

      b.price_period ?? b.pricePeriod ?? listing.price_period,

      b.category ?? listing.category,

      b.property_type || b.propertyType || listing.property_type,

      b.listing_type || b.listingType || listing.listing_type,

      newAddr,

      newCity,

      newState,

      newCountry,

      newZip,

      latitude,

      longitude,

      toNum(b.bedrooms, listing.bedrooms),

      toNum(b.bathrooms, listing.bathrooms),

      b.parking ?? listing.parking,

      toNum(b.year_built || b.yearBuilt, listing.year_built),

      toNum(

        b.square_footage || b.squareFootage || b.area_sqft,

        listing.square_footage,

      ),

      b.furnishing ?? listing.furnishing,

      toNum(b.lot_size || b.lotSize || b.land_area_sqft, listing.lot_size),

      JSON.stringify(featuresArr),

      JSON.stringify(finalPhotos),

      videoUrl,

      videoKey,

      virtualTourUrl,

      virtualTourKey,

      b.contact_name || b.contactName || listing.contact_name,

      b.contact_email || b.contactEmail || listing.contact_email,
      b.contact_phone || b.contactPhone || listing.contact_phone,
      b.contact_method || b.contactMethod || listing.contact_method,
      nextStatus,
      nextIsActive,
      nextModerationStatus,
      nextModerationReason,
      toNum(b.nightly_rate || b.nightlyRate, listing.nightly_rate),
      toNum(b.min_stay || b.minStay, listing.min_stay),
      toNum(b.max_stay || b.maxStay, listing.max_stay),
      toNum(b.cleaning_fee || b.cleaningFee, listing.cleaning_fee),
      toNum(b.lease_deposit || b.leaseDeposit, listing.lease_deposit),
      toNum(b.lease_term_months || b.leaseTermMonths, listing.lease_term_months),
      b.lease_type || b.leaseType || listing.lease_type,
      product_id,
    ];


    const result = await pool.query(query, params);
    let updatedListing = result.rows[0];
    updatedListing =
      (await updateListingLocationMetadata(product_id, b)) || updatedListing;
    updatedListing =
      (await updateListingFinancialMetadata(product_id, b)) || updatedListing;

    await recordListingHistory({

      listing,

      productId: product_id,

      changedBy: userId,

      oldPrice: listing.price,

      newPrice: updatedListing.price,

      currency: updatedListing.price_currency || updatedListing.currency,

      oldStatus: listing.status,

      newStatus: updatedListing.status,

      reason: nextModerationReason,

    });



    const oldPrice = listing.price;

    const newPriceVal = updatedListing.price;

    if (String(oldPrice ?? "") !== String(newPriceVal ?? "")) {

      setImmediate(() => {

        notifyPriceChange(req.io, updatedListing, oldPrice, newPriceVal).catch(() => {});

      });

    }



    const locationChanged = ["address", "city", "state", "country", "latitude", "longitude"].some(

      (field) => majorChangedFields.includes(field),

    );
    if (locationChanged) {
      maybeTriggerLocationScan(updatedListing);
    }

    return res.json({
      success: true,
      outcome: keepLiveAfterEdit ? "updated_live" : "pending_review",
      requires_review: !keepLiveAfterEdit,
      changed_fields: [...new Set(majorChangedFields)],
      message: keepLiveAfterEdit
        ? "Listing updated successfully."
        : "Listing updated successfully and sent for review.",
      listing: updatedListing,
    });
  } catch (err) {

    console.error("UpdateListing Error:", err);



    return res.status(500).json({

      message: "Server Error",

      code: "UPDATE_FAIL",

      details: err?.message,

    });

  }

};



export const deleteListing = async (req, res) => {

  try {

    const product_id =

      req.params.product_id || req.params.id || req.params.productId;



    const userId = req.user?.unique_id;

    const role = String(req.user?.role || "").toLowerCase();



    if (!userId) {

      return res.status(401).json({

        message: "Unauthorized",

        code: "UNAUTHORIZED",

      });

    }



    const found = await pool.query(

      "SELECT photos, video_public_id, virtual_tour_public_id, uploaded_by_id, agent_unique_id, created_by, assigned_agent_id, agency_id, brokerage_id FROM listings WHERE product_id=$1",

      [product_id],

    );



    const listing = found.rows[0];



    if (!listing) {

      return res.status(404).json({

        message: "Listing not found",

        code: "LISTING_NOT_FOUND",

      });

    }



    const allowedIds = [

      listing.uploaded_by_id,

      listing.agent_unique_id,

      listing.created_by,

      listing.assigned_agent_id,

      listing.agency_id,

      listing.brokerage_id,

    ]

      .filter(Boolean)

      .map((v) => String(v));



    const canManage =

      allowedIds.includes(String(userId)) ||

      role === "admin" ||

      role === "super_admin";



    if (!canManage) {

      return res.status(403).json({

        message: "Not authorized",

        code: "FORBIDDEN",

      });

    }



    // ✅ collect S3 keys

    const assetsToDelete = [];

    const photos = normalizeExistingPhotos(listing.photos || []);



    photos.forEach((photo) => {

      const key = photo.key || photo.s3_key || photo.public_id;

      if (key) assetsToDelete.push(key);

    });



    if (listing.video_public_id) {

      assetsToDelete.push(listing.video_public_id);

    }



    if (listing.virtual_tour_public_id) {

      assetsToDelete.push(listing.virtual_tour_public_id);

    }



    // ✅ delete DB first (FAST)

    // Do not delete notifications by product_id unless the notifications table has that column.

    await pool.query("DELETE FROM listings WHERE product_id=$1", [product_id]);



    // ✅ respond immediately (DO NOT WAIT FOR S3)

    res.json({

      success: true,

      message: "Listing deleted successfully",

    });



    // ✅ async cleanup (lightweight, no background system)

    if (assetsToDelete.length > 0) {

      setImmediate(async () => {

        try {

          await Promise.allSettled(

            assetsToDelete.map((key) =>

              s3.send(

                new DeleteObjectCommand({

                  Bucket: process.env.AWS_S3_BUCKET,

                  Key: key,

                }),

              ),

            ),

          );

          console.log("🗑️ S3 cleanup complete");

        } catch (err) {

          console.warn("⚠️ S3 cleanup failed:", err.message);

        }

      });

    }

  } catch (err) {

    console.error("[DeleteListing] Error:", err);



    res.status(500).json({

      message: "Delete failed",

      code: "DELETE_LISTING_FAIL",

      details: err?.message,

    });

  }

};



/* -------------------------------------------------------

   GET LISTINGS - PUBLIC

------------------------------------------------------- */

export const getListings = async (req, res) => {

  try {

    console.log("\n========================================");

    console.log("🚀 GET /listings/public HIT");

    console.log("========================================");



    const {

      category,

      search,

      minLat,

      maxLat,

      minLng,
      maxLng,
      type,
      listing_type_group,
      listing_types,
      minPrice,
      maxPrice,
      city,
      country,
      property_type,
      propertyType,
      property_types,
      bedrooms,
      bathrooms,
      minBedrooms,
      minBathrooms,
      minSqft,
      maxSqft,
      furnishing,
      furnished,
      minHoa,
      maxHoa,
      minServiceCharge,
      maxServiceCharge,
      verifiedOnly,
      liveToursNow,
      videoTours,
      mortgage,
      installment,
      rentToOwn,
      newListings,
      priceReduced,
      propertyCondition,
      amenities,
      utilities,
      limit,
      polygon,
    } = req.query;

    let currentUserId = null;
    if (req.user && req.user.unique_id) currentUserId = req.user.unique_id;
    const listingTypeFilters = getListingTypeFilterValues({
      category,
      listing_type_group,
      listing_types,
      type,
    });
    const propertyTypeFilters = [
      ...parseCsv(property_types),
      property_type,
      propertyType,
    ]
      .map(normalizeFilterToken)
      .filter(Boolean);
    const minPriceValue = getNumericQueryValue(minPrice);
    const maxPriceValue = getNumericQueryValue(maxPrice);
    const minBedroomsValue = getNumericQueryValue(minBedrooms || bedrooms);
    const minBathroomsValue = getNumericQueryValue(minBathrooms || bathrooms);
    const minSqftValue = getNumericQueryValue(minSqft);
    const maxSqftValue = getNumericQueryValue(maxSqft);
    const minHoaValue = getNumericQueryValue(minHoa);
    const maxHoaValue = getNumericQueryValue(maxHoa);
    const minServiceChargeValue = getNumericQueryValue(minServiceCharge);
    const maxServiceChargeValue = getNumericQueryValue(maxServiceCharge);
    const verifiedOnlyValue = getBooleanQueryValue(verifiedOnly);
    const liveToursNowValue = getBooleanQueryValue(liveToursNow);
    const videoToursValue = getBooleanQueryValue(videoTours);
    const mortgageValue = getBooleanQueryValue(mortgage);
    const installmentValue = getBooleanQueryValue(installment);
    const rentToOwnValue = getBooleanQueryValue(rentToOwn);
    const newListingsValue = getBooleanQueryValue(newListings);
    const priceReducedValue = getBooleanQueryValue(priceReduced);
    const furnishingValue = normalizeFilterToken(furnishing || furnished);
    const propertyConditionValue = normalizeFilterToken(propertyCondition);
    const amenityFilters = parseCsv(amenities).map(normalizeFilterToken);
    const utilityFilters = parseCsv(utilities).map(normalizeFilterToken);
    const requestedLimit = getLimitedResultCount(limit);

    let queryText = `
      SELECT

        l.*,

        u.unique_id AS uploader_unique_id,

        u.name AS agent_name,

        u.avatar_url AS agent_avatar,

        u.username AS agent_username,

        u.email AS agent_email,

        u.role AS agent_role,

        u.phone AS agent_phone,

        u.brokerage_name AS user_brokerage_name,

        u.is_solo_agent AS user_is_solo_agent,

        u.verification_status AS user_verification_status,

        u.is_verified AS user_is_verified,

        u.is_verified_agent AS user_is_verified_agent,

        u.subscription_plan AS user_subscription_plan,

        u.subscription_status AS user_subscription_status,

        p.full_name AS profile_full_name,

        p.username AS profile_username,

        p.avatar_url AS profile_avatar_url,

        p.phone AS profile_phone,

        bp.company_name AS brokerage_company_name,

        assigned_u.unique_id AS assigned_agent_unique_id,

        assigned_u.name AS assigned_agent_name,

        assigned_u.username AS assigned_agent_username,

        assigned_u.avatar_url AS assigned_agent_avatar,

        assigned_u.role AS assigned_agent_role,

        assigned_u.verification_status AS assigned_agent_verification_status,

        assigned_u.is_verified AS assigned_agent_is_verified,

        assigned_u.is_verified_agent AS assigned_agent_is_verified_agent,

        assigned_u.subscription_plan AS assigned_agent_subscription_plan,

        assigned_u.subscription_status AS assigned_agent_subscription_status,

        assigned_p.full_name AS assigned_agent_full_name,

        assigned_p.username AS assigned_agent_profile_username,

        assigned_p.avatar_url AS assigned_agent_profile_avatar,

        assigned_ap.is_solo_agent AS assigned_agent_is_solo_agent,

        brokerage_u.unique_id AS listing_brokerage_unique_id,

        brokerage_u.name AS listing_brokerage_user_name,

        brokerage_u.username AS listing_brokerage_username,

        brokerage_u.avatar_url AS listing_brokerage_avatar,

        brokerage_u.verification_status AS listing_brokerage_verification_status,

        brokerage_u.is_verified AS listing_brokerage_is_verified,

        brokerage_u.verified_badge AS listing_brokerage_user_verified_badge,

        brokerage_bp.company_name AS listing_brokerage_company_name,

        brokerage_bp.logo_url AS listing_brokerage_logo_url,
        brokerage_bp.verified_badge AS listing_brokerage_verified_badge,
        legacy_b.id AS legacy_brokerage_id,
        active_lt.id AS active_live_tour_id,
        active_lt.current_viewers AS active_live_current_viewers,
        active_lt.total_viewers AS active_live_total_viewers,
        active_lt.peak_viewers AS active_live_peak_viewers,
        CASE WHEN f.product_id IS NOT NULL THEN true ELSE false END as is_favorited
      FROM listings l
      JOIN users u ON l.uploaded_by_id = u.unique_id

      LEFT JOIN profiles p ON p.unique_id::text = u.unique_id::text

      LEFT JOIN brokerage_profiles bp ON bp.unique_id::text = u.unique_id::text

      LEFT JOIN users assigned_u ON l.assigned_agent_id::text = assigned_u.unique_id::text

      LEFT JOIN profiles assigned_p ON assigned_p.unique_id::text = assigned_u.unique_id::text

      LEFT JOIN agent_profiles assigned_ap ON assigned_ap.unique_id::text = assigned_u.unique_id::text

      LEFT JOIN brokerages legacy_b ON legacy_b.id::text = l.agency_id::text

      LEFT JOIN users brokerage_u

        ON brokerage_u.unique_id::text = COALESCE(

          legacy_b.owner_id::text,

          CASE

            WHEN LOWER(u.role::text) IN ('brokerage_owner', 'brokerage') THEN u.unique_id::text

            ELSE u.linked_agency_id::text

          END,

          l.agency_id::text

        )

      LEFT JOIN brokerage_profiles brokerage_bp ON brokerage_bp.unique_id::text = brokerage_u.unique_id::text
      LEFT JOIN LATERAL (
        SELECT id, current_viewers, total_viewers, peak_viewers
        FROM live_tours
        WHERE property_id = l.id
          AND is_live = TRUE
        ORDER BY started_at DESC NULLS LAST, created_at DESC NULLS LAST
        LIMIT 1
      ) active_lt ON TRUE
      LEFT JOIN favorites f ON l.product_id = f.product_id AND f.user_id::text = $1::text
      WHERE l.status = 'approved'
      AND l.is_active = true
    `;


    const queryParams = [currentUserId];

    let paramCounter = 2;



    if (polygon) {

      try {

        const geoJson = JSON.parse(polygon);



        if (!geoJson.type || !geoJson.coordinates) {

          throw new Error("Invalid GeoJSON structure");

        }



        queryText += `
          AND l.longitude IS NOT NULL
          AND l.latitude IS NOT NULL
          AND l.longitude::text ~ '^-?[0-9]+(\\.[0-9]+)?$'
          AND l.latitude::text ~ '^-?[0-9]+(\\.[0-9]+)?$'
          AND ST_Intersects(
            ST_SetSRID(ST_GeomFromGeoJSON($${paramCounter}), 4326),
            ST_SetSRID(ST_MakePoint(l.longitude::float, l.latitude::float), 4326)
          )`;


        queryParams.push(JSON.stringify(geoJson));

        paramCounter++;

      } catch (err) {

        console.error("❌ Invalid Polygon JSON received:", err.message);

      }

    }



    if (listingTypeFilters.length > 0) {
      queryText += `
        AND (
          regexp_replace(LOWER(COALESCE(l.listing_type::text, '')), '[\\s-]+', '_', 'g') = ANY($${paramCounter}::text[])
          OR regexp_replace(LOWER(COALESCE(l.category::text, '')), '[\\s-]+', '_', 'g') = ANY($${paramCounter}::text[])
        )`;
      queryParams.push(listingTypeFilters);
      paramCounter++;
    }

    if (city) {
      queryText += ` AND l.city ILIKE $${paramCounter}`;
      queryParams.push(`%${city}%`);
      paramCounter++;
    }

    if (country) {
      queryText += ` AND l.country ILIKE $${paramCounter}`;
      queryParams.push(`%${country}%`);
      paramCounter++;
    }

    if (propertyTypeFilters.length > 0) {
      queryText += `
        AND regexp_replace(LOWER(COALESCE(l.property_type::text, '')), '[\\s-]+', '_', 'g') = ANY($${paramCounter}::text[])`;
      queryParams.push([...new Set(propertyTypeFilters)]);
      paramCounter++;
    }

    if (minPriceValue !== null) {
      queryText += ` AND l.price >= $${paramCounter}`;
      queryParams.push(minPriceValue);
      paramCounter++;
    }

    if (maxPriceValue !== null) {
      queryText += ` AND l.price <= $${paramCounter}`;
      queryParams.push(maxPriceValue);
      paramCounter++;
    }

    if (minBedroomsValue !== null) {
      queryText += ` AND COALESCE(l.bedrooms, 0) >= $${paramCounter}`;
      queryParams.push(minBedroomsValue);
      paramCounter++;
    }

    if (minBathroomsValue !== null) {
      queryText += ` AND COALESCE(l.bathrooms, 0) >= $${paramCounter}`;
      queryParams.push(minBathroomsValue);
      paramCounter++;
    }

    if (minSqftValue !== null) {
      queryText += `
        AND COALESCE(
          l.building_area_sqft,
          l.area_sqft,
          l.square_footage,
          l.land_area_sqft,
          l.lot_size,
          0
        ) >= $${paramCounter}`;
      queryParams.push(minSqftValue);
      paramCounter++;
    }

    if (maxSqftValue !== null) {
      queryText += `
        AND COALESCE(
          l.building_area_sqft,
          l.area_sqft,
          l.square_footage,
          l.land_area_sqft,
          l.lot_size,
          0
        ) <= $${paramCounter}`;
      queryParams.push(maxSqftValue);
      paramCounter++;
    }

    if (furnishingValue) {
      queryText += `
        AND regexp_replace(LOWER(COALESCE(l.furnishing::text, '')), '[\\s-]+', '_', 'g') = $${paramCounter}`;
      queryParams.push(furnishingValue);
      paramCounter++;
    }

    if (propertyConditionValue) {
      queryText += `
        AND regexp_replace(LOWER(COALESCE(l.property_condition::text, '')), '[\\s-]+', '_', 'g') = $${paramCounter}`;
      queryParams.push(propertyConditionValue);
      paramCounter++;
    }

    if (minHoaValue !== null) {
      queryText += ` AND COALESCE(l.hoa_fee, 0) >= $${paramCounter}`;
      queryParams.push(minHoaValue);
      paramCounter++;
    }

    if (maxHoaValue !== null) {
      queryText += ` AND COALESCE(l.hoa_fee, 0) <= $${paramCounter}`;
      queryParams.push(maxHoaValue);
      paramCounter++;
    }

    if (minServiceChargeValue !== null) {
      queryText += ` AND COALESCE(l.service_charge, 0) >= $${paramCounter}`;
      queryParams.push(minServiceChargeValue);
      paramCounter++;
    }

    if (maxServiceChargeValue !== null) {
      queryText += ` AND COALESCE(l.service_charge, 0) <= $${paramCounter}`;
      queryParams.push(maxServiceChargeValue);
      paramCounter++;
    }

    if (verifiedOnlyValue === true) {
      queryText += `
        AND (
          l.title_verified = TRUE
          OR u.is_verified = TRUE
          OR u.is_verified_agent = TRUE
          OR LOWER(COALESCE(u.verification_status::text, '')) IN ('approved', 'verified')
          OR brokerage_u.is_verified = TRUE
          OR brokerage_bp.verified_badge = TRUE
        )`;
    }

    if (liveToursNowValue === true) {
      queryText += ` AND active_lt.id IS NOT NULL`;
    }

    if (videoToursValue === true) {
      queryText += `
        AND (
          COALESCE(l.allow_video_tour, FALSE) = TRUE
          OR NULLIF(l.video_url, '') IS NOT NULL
          OR NULLIF(l.virtual_tour_url, '') IS NOT NULL
          OR NULLIF(l.three_d_home_url, '') IS NOT NULL
          OR NULLIF(l.video_public_id, '') IS NOT NULL
          OR NULLIF(l.virtual_tour_public_id, '') IS NOT NULL
        )`;
    }

    if (mortgageValue === true) {
      queryText += ` AND COALESCE(l.mortgage_available, FALSE) = TRUE`;
    }

    if (installmentValue === true) {
      queryText += ` AND COALESCE(l.installment_available, FALSE) = TRUE`;
    }

    if (rentToOwnValue === true) {
      queryText += ` AND COALESCE(l.rent_to_own_available, FALSE) = TRUE`;
    }

    if (newListingsValue === true) {
      queryText += `
        AND COALESCE(l.published_at, l.activated_at, l.listed_at, l.created_at) >= NOW() - INTERVAL '14 days'`;
    }

    if (priceReducedValue === true) {
      queryText += `
        AND (
          COALESCE(l.price_drop_amount, 0) > 0
          OR l.last_price_drop_at IS NOT NULL
          OR (
            l.previous_price IS NOT NULL
            AND l.previous_price > l.price
          )
        )`;
    }

    if (amenityFilters.length > 0) {
      queryText += `
        AND EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(
            CASE
              WHEN jsonb_typeof(l.amenities::jsonb) = 'array' THEN l.amenities::jsonb
              ELSE '[]'::jsonb
            END
          ) AS amenity(value)
          WHERE regexp_replace(LOWER(amenity.value), '[\\s-]+', '_', 'g') = ANY($${paramCounter}::text[])
        )`;
      queryParams.push([...new Set(amenityFilters)]);
      paramCounter++;
    }

    if (utilityFilters.length > 0) {
      const utilityConditions = {
        internet: "COALESCE(l.internet_available, FALSE) = TRUE",
        generator: "COALESCE(l.generator_available, FALSE) = TRUE",
        borehole: "COALESCE(l.borehole, FALSE) = TRUE",
        prepaid_meter: "COALESCE(l.prepaid_meter, FALSE) = TRUE",
      };
      const selectedUtilityConditions = [...new Set(utilityFilters)]
        .map((token) => utilityConditions[token])
        .filter(Boolean);

      if (selectedUtilityConditions.length > 0) {
        queryText += ` AND (${selectedUtilityConditions.join(" OR ")})`;
      }
    }

    if (search) {
      queryText += ` AND (
        l.city ILIKE $${paramCounter} OR
        l.address ILIKE $${paramCounter} OR
        l.state ILIKE $${paramCounter} OR
        l.country ILIKE $${paramCounter} OR
        l.zip_code ILIKE $${paramCounter} OR
        l.neighborhood ILIKE $${paramCounter} OR
        l.estate_name ILIKE $${paramCounter} OR
        l.landmark ILIKE $${paramCounter} OR
        l.property_type ILIKE $${paramCounter}
      )`;
      queryParams.push(`%${search}%`);
      paramCounter++;
    }



    if (

      !polygon &&

      minLat &&

      maxLat &&

      minLng &&
      maxLng &&
      [minLat, maxLat, minLng, maxLng].every(
        (value) => getNumericQueryValue(value) !== null,
      )
    ) {
      queryText += `
        AND l.latitude IS NOT NULL
        AND l.longitude IS NOT NULL
        AND l.latitude::text ~ '^-?[0-9]+(\\.[0-9]+)?$'
        AND l.longitude::text ~ '^-?[0-9]+(\\.[0-9]+)?$'
        AND l.latitude::numeric >= $${paramCounter}
        AND l.latitude::numeric <= $${paramCounter + 1}
        AND l.longitude::numeric >= $${paramCounter + 2}
        AND l.longitude::numeric <= $${paramCounter + 3}
      `;
      queryParams.push(
        getNumericQueryValue(minLat),
        getNumericQueryValue(maxLat),
        getNumericQueryValue(minLng),
        getNumericQueryValue(maxLng),
      );
      paramCounter += 4;
    }

    queryText += ` ORDER BY COALESCE(l.activated_at, l.created_at) DESC NULLS LAST LIMIT $${paramCounter}`;
    queryParams.push(requestedLimit);


    const result = await pool.query(queryText, queryParams);



    const getRoleLabel = (role, isSoloAgent) => {

      const r = String(role || "").toLowerCase();



      if (r === "agent") {

        return isSoloAgent === false ? "Agency Agent" : "Real Estate Agent";

      }



      if (r === "brokerage" || r === "brokerage_owner")

        return "Brokerage Company";

      if (r === "owner" || r === "landlord") return "Property Owner";

      if (r === "admin" || r === "super_admin") return "Admin";



      return role || "Keyvia Member";

    };



    const listings = result.rows.map((listing) => {

      const photos = normalizePhotosForResponse(listing.photos);

      const features = safeJsonParse(listing.features, []);

      const floorPlans = safeJsonParse(listing.floor_plans, []);

      const stagingPhotos = safeJsonParse(listing.staging_photos, []);

      const panoramaPhotos = safeJsonParse(listing.panorama_photos, []);

      const amenities = safeJsonParse(listing.amenities, []);

      const verificationStatus = String(

        listing.user_verification_status || "",

      ).toLowerCase();

      const isVerified =

        listing.user_is_verified === true ||

        listing.user_is_verified_agent === true ||

        verificationStatus === "approved" ||

        verificationStatus === "verified";

      const companyName =

        listing.listing_brokerage_company_name ||

        listing.brokerage_company_name ||

        listing.user_brokerage_name ||

        listing.company_name ||

        null;

      const publicPhone =

        listing.show_contact_phone === true

          ? listing.contact_phone ||

            listing.profile_phone ||

            listing.agent_phone

          : null;

      const brokerageIsVerified =

        listing.listing_brokerage_is_verified === true ||

        listing.listing_brokerage_verified_badge === true ||

        listing.listing_brokerage_user_verified_badge === true ||

        ["approved", "verified"].includes(

          String(

            listing.listing_brokerage_verification_status || "",

          ).toLowerCase(),

        );

      const brokerageSummary =

        listing.listing_brokerage_unique_id || companyName

          ? {

              id:

                listing.legacy_brokerage_id ||

                listing.listing_brokerage_unique_id ||

                null,

              unique_id: listing.listing_brokerage_unique_id || null,

              name:

                listing.listing_brokerage_company_name ||

                listing.listing_brokerage_user_name ||

                companyName,

              company_name:

                listing.listing_brokerage_company_name ||

                listing.listing_brokerage_user_name ||

                companyName,

              username: listing.listing_brokerage_username || null,

              avatar_url:

                listing.listing_brokerage_logo_url ||

                listing.listing_brokerage_avatar ||

                null,

              logo_url:

                listing.listing_brokerage_logo_url ||

                listing.listing_brokerage_avatar ||

                null,

              role: "brokerage",

              role_label: "Brokerage Company",

              is_verified: brokerageIsVerified,

              verification_status: brokerageIsVerified

                ? "verified"

                : listing.listing_brokerage_verification_status || "unverified",

            }

          : null;

      const assignedVerificationStatus = String(

        listing.assigned_agent_verification_status || "",

      ).toLowerCase();

      const assignedAgentIsVerified =

        listing.assigned_agent_is_verified === true ||

        listing.assigned_agent_is_verified_agent === true ||

        assignedVerificationStatus === "approved" ||

        assignedVerificationStatus === "verified";

      const assignedAgent = listing.assigned_agent_unique_id

        ? {

            unique_id: listing.assigned_agent_unique_id,

            name:

              listing.assigned_agent_full_name || listing.assigned_agent_name,

            full_name:

              listing.assigned_agent_full_name || listing.assigned_agent_name,

            avatar_url:

              listing.assigned_agent_profile_avatar ||

              listing.assigned_agent_avatar,

            avatar:

              listing.assigned_agent_profile_avatar ||

              listing.assigned_agent_avatar,

            username:

              listing.assigned_agent_profile_username ||

              listing.assigned_agent_username,

            role: listing.assigned_agent_role || "agent",

            role_label: getRoleLabel(

              listing.assigned_agent_role || "agent",

              listing.assigned_agent_is_solo_agent,

            ),

            is_solo_agent: listing.assigned_agent_is_solo_agent,

            company_name: companyName,

            agency_name: companyName,

            brokerage_name: brokerageSummary?.company_name || companyName,

            verification_status: assignedAgentIsVerified

              ? "verified"

              : listing.assigned_agent_verification_status || "unverified",

            is_verified: assignedAgentIsVerified,

            is_verified_agent:

              listing.assigned_agent_is_verified_agent === true,

            subscription_plan:

              listing.assigned_agent_subscription_plan || null,

            subscription_status:

              listing.assigned_agent_subscription_status || null,

          }

        : null;

      const uploaderAgent = {

        unique_id: listing.uploader_unique_id || listing.uploaded_by_id,

        name: listing.profile_full_name || listing.agent_name,

        full_name: listing.profile_full_name || listing.agent_name,

        avatar_url: listing.profile_avatar_url || listing.agent_avatar,

        avatar: listing.profile_avatar_url || listing.agent_avatar,

        username: listing.profile_username || listing.agent_username,

        email: listing.agent_email,

        phone: publicPhone,

        role: listing.agent_role,

        role_label: getRoleLabel(

          listing.agent_role,

          listing.user_is_solo_agent,

        ),

        is_solo_agent: listing.user_is_solo_agent,

        company_name: companyName,

        agency_name:

          String(listing.agent_role || "").toLowerCase() === "agent" &&

          listing.user_is_solo_agent === false

            ? companyName

            : null,

        brokerage_name: ["brokerage", "brokerage_owner"].includes(

          String(listing.agent_role || "").toLowerCase(),

        )

          ? companyName

          : null,

        verification_status: isVerified

          ? "verified"

          : listing.user_verification_status || "unverified",

        is_verified: isVerified,

        is_verified_agent: listing.user_is_verified_agent === true,

        subscription_plan: listing.user_subscription_plan || null,

        subscription_status: listing.user_subscription_status || null,

      };

      const primaryAgent = assignedAgent || uploaderAgent;

      const badgeMeta = computeListingBadges(listing, {

        photos,

        floorPlans: Array.isArray(floorPlans) ? floorPlans : [],

        stagingPhotos: Array.isArray(stagingPhotos) ? stagingPhotos : [],

        panoramaPhotos: Array.isArray(panoramaPhotos) ? panoramaPhotos : [],

      });



      return {

        ...listing,

        ...badgeMeta,

        photos,

        floor_plans: Array.isArray(floorPlans) ? floorPlans : [],

        staging_photos: Array.isArray(stagingPhotos) ? stagingPhotos : [],

        panorama_photos: Array.isArray(panoramaPhotos) ? panoramaPhotos : [],

        features,

        amenities,

        title_document_file: null,

        draft_data: undefined,

        admin_notes: undefined,

        risk_score: undefined,

        risk_level: undefined,

        risk_flags: undefined,

        moderation_reason: undefined,

        reviewed_by: undefined,

        reviewed_at: undefined,

        listing_score: undefined,

        payment_status: undefined,

        latitude: listing.latitude ? parseFloat(listing.latitude) : null,

        longitude: listing.longitude ? parseFloat(listing.longitude) : null,

        uploaded_by_id: listing.uploaded_by_id,

        agent_unique_id: listing.agent_unique_id || listing.uploaded_by_id,

        created_by: listing.created_by || listing.uploaded_by_id,

        price_currency: listing.price_currency || listing.currency || "USD",
        live_now: Boolean(listing.active_live_tour_id),
        live_tour_status: listing.active_live_tour_id ? "live" : null,
        live_tour_id: listing.active_live_tour_id || null,
        current_viewers: Number(listing.active_live_current_viewers || 0),
        total_viewers: Number(listing.active_live_total_viewers || 0),
        peak_viewers: Number(listing.active_live_peak_viewers || 0),
        building_area_sqft:
          listing.building_area_sqft ||
          listing.area_sqft ||
          listing.square_footage ||

          null,

        land_area_sqft: listing.land_area_sqft || listing.lot_size || null,

        agent: primaryAgent,

        creator: uploaderAgent,

        submitter: uploaderAgent,

        assigned_agent: assignedAgent,

        brokerage: brokerageSummary,

      };

    });



    res.json({
      success: true,
      data: listings,
      listings,
      count: listings.length,
      filters: {
        listing_types: listingTypeFilters,
        property_types: [...new Set(propertyTypeFilters)],
        min_price: minPriceValue,
        max_price: maxPriceValue,
        min_bedrooms: minBedroomsValue,
        min_bathrooms: minBathroomsValue,
        furnishing: furnishingValue || null,
        property_condition: propertyConditionValue || null,
        verified_only: verifiedOnlyValue === true,
        live_tours_now: liveToursNowValue === true,
        video_tours: videoToursValue === true,
        mortgage: mortgageValue === true,
        installment: installmentValue === true,
        rent_to_own: rentToOwnValue === true,
        new_listings: newListingsValue === true,
        price_reduced: priceReducedValue === true,
        amenities: [...new Set(amenityFilters)],
        utilities: [...new Set(utilityFilters)],
      },
    });
  } catch (err) {
    console.error("❌ CRITICAL ERROR in getListings:", err);
    res.status(500).json({
      success: false,
      message: "Failed to fetch public listings.",
    });
  }
};


export const reportListing = async (req, res) => {
  try {

    const { product_id } = req.params;

    const reporterId = req.user?.unique_id || null;

    const { reason, details, message, email, reporter_email } = req.body || {};


    if (!product_id) {

      return res.status(400).json({

        success: false,

        message: "Listing product ID is required.",

      });

    }



    if (!reason || !String(reason).trim()) {

      return res.status(400).json({

        success: false,

        message: "Please include a reason for the report.",

      });

    }



    const listingResult = await pool.query(

      `SELECT id, product_id, title, uploaded_by_id FROM listings WHERE product_id = $1 LIMIT 1`,

      [product_id],

    );



    const listing = listingResult.rows[0];



    if (!listing) {

      return res.status(404).json({

        success: false,

        message: "Listing not found.",

      });

    }



    const reportDetails = [details, message].find((value) =>
      String(value || "").trim(),
    );
    const reporterEmail = [email, reporter_email].find((value) =>
      String(value || "").trim(),
    );
    const reportSummary = [
      String(reason).trim(),
      reportDetails ? `Details: ${String(reportDetails).trim()}` : null,
      reporterEmail ? `Reporter email: ${String(reporterEmail).trim()}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    try {
      await pool.query(
        `

        INSERT INTO listing_reports (

          product_id,

          listing_id,

          reporter_id,

          listing_owner_id,

          reason,

          status,

          created_at

        )

        VALUES ($1, $2, $3::uuid, $4, $5, 'open', NOW())

        `,

        [

          product_id,

          listing.id,

          reporterId ? String(reporterId) : null,

          listing.uploaded_by_id,

          reportSummary,
        ],
      );
    } catch (reportErr) {

      console.warn(

        "[ReportListing] listing_reports insert failed, falling back to admin_notes:",

        reportErr?.message,

      );



      await pool.query(

        `

        UPDATE listings

        SET admin_notes = CONCAT(

          COALESCE(admin_notes || E'\n', ''),

          '[Public report] ',

          $1,

          ' - ',

          NOW()::text

        )

        WHERE product_id = $2

        `,

        [reportSummary, product_id],
      );
    }



    pool
      .query(
        `
        SELECT unique_id
        FROM users
        WHERE LOWER(role::text) IN ('admin', 'super_admin')
           OR is_admin = true
           OR is_super_admin = true
        `,
      )
      .then(async ({ rows }) => {
        await Promise.allSettled(
          rows.map((admin) =>
            createNotification({
              recipientId: admin.unique_id,
              type: "listing_reported",
              title: "Listing Report Submitted",
              message: `A public report was submitted for "${listing.title || product_id}".`,
              entityType: "listing",
              entityId: product_id,
              productId: product_id,
              actionUrl: "/admin/listings",
              actionLabel: "Review Listing",
              data: {
                product_id,
                reporter_id: reporterId,
                reason: reportSummary,
              },
            }),
          ),
        );
      })
      .catch((notifyErr) => {
        console.warn(
          "[ReportListing] Admin notification failed:",
          notifyErr?.message,
        );
      });


    return res.status(201).json({

      success: true,

      message: "Report submitted for review.",

    });

  } catch (err) {

    console.error("[ReportListing] Error:", err);



    return res.status(500).json({

      success: false,

      message: "Failed to submit listing report.",

      details: err?.message,

    });

  }
};

const getListingInteractionRecipient = (listing = {}) =>
  listing.assigned_agent_id ||
  listing.assigned_agent?.unique_id ||
  listing.contact_profile?.unique_id ||
  listing.agent?.unique_id ||
  listing.creator?.unique_id ||
  listing.uploaded_by_id ||
  listing.agent_unique_id ||
  listing.created_by ||
  listing.brokerage?.unique_id ||
  listing.brokerage_id ||
  null;

const getTourTypeLabel = (tourType) => {
  const type = String(tourType || "").toLowerCase();

  if (type === "video" || type === "video_live") return "video/live tour";
  if (type === "live") return "live tour";
  if (type === "in_person") return "in-person tour";

  return "property tour";
};

const getInteractionListing = async (productId) => {
  const result = await pool.query(
    `
    SELECT *
    FROM listings
    WHERE product_id = $1
    LIMIT 1
    `,
    [productId],
  );

  return result.rows[0] || null;
};

const ensureBuyerInteraction = (req, res) => {
  const userId = req.user?.unique_id;
  const role = String(req.user?.role || "").toLowerCase();

  if (!userId) {
    res.status(401).json({ success: false, message: "Please sign in first." });
    return false;
  }

  if (role !== "buyer") {
    res.status(403).json({
      success: false,
      message: "Switch to a buyer profile to use this action.",
    });
    return false;
  }

  return true;
};

const isListingAvailableForBuyerInteraction = (listing = {}) =>
  String(listing.status || "").toLowerCase() === "approved" &&
  listing.is_active === true;

export const requestListingTour = async (req, res) => {
  try {
    if (!ensureBuyerInteraction(req, res)) return;

    const { product_id } = req.params;
    const {
      requested_date,
      requested_time,
      preferred_date,
      preferred_time,
      tour_type = "in_person",
      message = null,
      note = null,
      source = "listing_detail",
    } = req.body || {};

    if (!product_id) {
      return res.status(400).json({
        success: false,
        message: "Listing product ID is required.",
      });
    }

    const listing = await getInteractionListing(product_id);

    if (!listing || !isListingAvailableForBuyerInteraction(listing)) {
      return res.status(404).json({
        success: false,
        message: "This listing is not available for tour requests.",
      });
    }

    const normalizedTourType =
      String(tour_type || "in_person").toLowerCase() === "video_live"
        ? "video_live"
        : String(tour_type || "in_person").toLowerCase();

    if (listing.allow_tour_requests === false) {
      return res.status(400).json({
        success: false,
        message: "Tour requests are not enabled for this listing.",
      });
    }

    if (
      ["video", "video_live", "live"].includes(normalizedTourType) &&
      listing.allow_video_tour === false
    ) {
      return res.status(400).json({
        success: false,
        message: "Video tours are not enabled for this listing.",
      });
    }

    if (
      normalizedTourType === "in_person" &&
      listing.allow_in_person_tour === false
    ) {
      return res.status(400).json({
        success: false,
        message: "In-person tours are not enabled for this listing.",
      });
    }

    const recipientId = getListingInteractionRecipient(listing);
    const buyerId = req.user.unique_id;

    if (!recipientId) {
      return res.status(404).json({
        success: false,
        message: "Listing contact is not available.",
      });
    }

    if (String(recipientId) === String(buyerId)) {
      return res.status(400).json({
        success: false,
        message: "You cannot request a tour for your own listing.",
      });
    }

    await pool
      .query(
        `
        UPDATE listings
        SET tour_request_count = COALESCE(tour_request_count, 0) + 1,
        contact_count = COALESCE(contact_count, 0) + 1
        WHERE product_id = $1
        `,
        [product_id],
      )
      .catch(() => null);

    await ensureListingInquiriesTable().catch(() => null);
    await pool
      .query(
        `
        INSERT INTO listing_inquiries (
          listing_id,
          product_id,
          buyer_id,
          agent_id,
          owner_id,
          inquiry_status,
          crm_status,
          source,
          metadata,
          last_contacted_at
        )
        VALUES ($1, $2, $3::uuid, $4::uuid, $5::uuid, 'viewing_scheduled', 'viewing_scheduled', $6, $7::jsonb, NOW())
        ON CONFLICT (product_id, buyer_id, source)
        DO UPDATE SET
          inquiry_status = 'viewing_scheduled',
          crm_status = 'viewing_scheduled',
          metadata = listing_inquiries.metadata || EXCLUDED.metadata,
          last_contacted_at = NOW(),
          updated_at = NOW()
        `,
        [
          listing.id,
          product_id,
          buyerId,
          recipientId,
          recipientId,
          source || "listing_detail",
          JSON.stringify({
            inquiry_type: "tour_request",
            tour_type: normalizedTourType,
            preferred_date: preferred_date || requested_date || null,
            preferred_time: preferred_time || requested_time || null,
            message: message || note || null,
          }),
        ],
      )
      .catch((err) => console.warn("[RequestListingTour] inquiry tracking skipped:", err?.message));

    await createNotification({
      io: req.io,
      recipientId,
      senderId: buyerId,
      type: "tour_request",
      title: "Tour Request Received",
      message: `${req.user?.name || "A buyer"} requested a ${getTourTypeLabel(normalizedTourType)} for "${listing.title || listing.address || product_id}".`,
      entityType: "listing",
      entityId: product_id,
      productId: product_id,
      actionUrl: `/listing/${product_id}`,
      actionLabel: "View Listing",
      data: {
        product_id,
        buyer_id: buyerId,
        buyer_name: req.user?.name || null,
        requested_date: preferred_date || requested_date || null,
        requested_time: preferred_time || requested_time || null,
        tour_type: normalizedTourType,
        note: message || note,
        source,
      },
    });

    return res.status(201).json({
      success: true,
      message: "Tour request sent.",
      data: {
        product_id,
        requested_date: preferred_date || requested_date || null,
        requested_time: preferred_time || requested_time || null,
        tour_type: normalizedTourType,
      },
    });
  } catch (err) {
    console.error("[RequestListingTour] Error:", err);
    return res.status(500).json({
      success: false,
      message: "Could not send tour request.",
    });
  }
};

export const notifyLiveTourInterest = async (req, res) => {
  try {
    if (!ensureBuyerInteraction(req, res)) return;

    const { product_id } = req.params;

    if (!product_id) {
      return res.status(400).json({
        success: false,
        message: "Listing product ID is required.",
      });
    }

    const listing = await getInteractionListing(product_id);

    if (!listing || !isListingAvailableForBuyerInteraction(listing)) {
      return res.status(404).json({
        success: false,
        message: "This listing is not available.",
      });
    }

    const recipientId = getListingInteractionRecipient(listing);
    const buyerId = req.user.unique_id;

    if (!recipientId) {
      return res.status(404).json({
        success: false,
        message: "Listing contact is not available.",
      });
    }

    if (String(recipientId) === String(buyerId)) {
      return res.status(400).json({
        success: false,
        message: "You cannot subscribe to your own live tour.",
      });
    }

    await createNotification({
      io: req.io,
      recipientId,
      senderId: buyerId,
      type: "live_tour_interest",
      title: "Live Tour Interest",
      message: `${req.user?.name || "A buyer"} wants to be notified when "${listing.title || listing.address || product_id}" goes live.`,
      entityType: "listing",
      entityId: product_id,
      productId: product_id,
      actionUrl: `/listing/${product_id}`,
      actionLabel: "View Listing",
      data: {
        product_id,
        buyer_id: buyerId,
        buyer_name: req.user?.name || null,
      },
    });

    return res.json({
      success: true,
      message: "Live tour notification enabled.",
      data: { product_id },
    });
  } catch (err) {
    console.error("[NotifyLiveTourInterest] Error:", err);
    return res.status(500).json({
      success: false,
      message: "Could not enable live tour notification.",
    });
  }
};

const tableExists = async (tableName) => {
  const result = await pool.query(
    `
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = $1
    LIMIT 1
    `,
    [tableName],
  );

  return result.rowCount > 0;
};

const ensureListingInquiriesTable = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS listing_inquiries (
      inquiry_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      listing_id UUID REFERENCES listings(id) ON DELETE SET NULL,
      product_id VARCHAR(80) NOT NULL,
      buyer_id UUID REFERENCES users(unique_id) ON DELETE SET NULL,
      guest_name TEXT,
      guest_email TEXT,
      guest_phone TEXT,
      agent_id UUID REFERENCES users(unique_id) ON DELETE SET NULL,
      brokerage_id UUID,
      owner_id UUID,
      inquiry_status VARCHAR(40) NOT NULL DEFAULT 'new',
      crm_status VARCHAR(60) NOT NULL DEFAULT 'interested',
      source VARCHAR(80) NOT NULL DEFAULT 'listing_detail',
      message_thread_id VARCHAR(120),
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      last_contacted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(product_id, buyer_id, source)
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_listing_inquiries_listing
      ON listing_inquiries(product_id, created_at DESC);
  `);

  await pool.query(`
    ALTER TABLE listing_inquiries
      ADD COLUMN IF NOT EXISTS guest_name TEXT,
      ADD COLUMN IF NOT EXISTS guest_email TEXT,
      ADD COLUMN IF NOT EXISTS guest_phone TEXT;
  `);
};

const userCanManageListing = (user = {}, listing = {}) => {
  const role = String(user?.role || "").toLowerCase();
  if (["admin", "super_admin", "superadmin"].includes(role)) return true;

  const userId = String(user?.unique_id || user?.id || "");
  if (!userId) return false;

  return [
    listing.uploaded_by_id,
    listing.agent_unique_id,
    listing.created_by,
    listing.assigned_agent_id,
    listing.agency_id,
    listing.brokerage_id,
  ]
    .filter(Boolean)
    .some((value) => String(value) === userId);
};

const canViewListingPublicData = (user = {}, listing = {}) => {
  if (!listing) return false;
  if (
    String(listing.status || "").toLowerCase() === "approved" &&
    listing.is_active === true
  ) {
    return true;
  }
  return userCanManageListing(user, listing);
};

const maybeTriggerLocationScan = (listing = {}) => {
  if (!listing?.product_id || !listing?.latitude || !listing?.longitude) return;

  scanLocationIntelligence({
    listingId: listing.id || null,
    productId: listing.product_id,
    latitude: listing.latitude,
    longitude: listing.longitude,
  }).catch((err) => {
    console.warn("[LocationIntelligence] background scan skipped:", err?.message);
  });
};

const recordListingHistory = async ({
  listing,
  productId,
  changedBy,
  oldPrice,
  newPrice,
  currency,
  oldStatus,
  newStatus,
  reason = null,
} = {}) => {
  try {
    if (oldPrice !== undefined && newPrice !== undefined) {
      const oldValue = toNumberOrNull(oldPrice);
      const newValue = toNumberOrNull(newPrice);
      if (newValue !== null && String(oldValue ?? "") !== String(newValue)) {
        await pool.query(
          `
          INSERT INTO listing_price_history (
            listing_id,
            product_id,
            old_price,
            new_price,
            currency,
            changed_by,
            source
          )
          VALUES ($1, $2, $3, $4, $5, $6::uuid, 'listing_update')
          `,
          [
            listing?.id || null,
            productId,
            oldValue,
            newValue,
            currency || listing?.price_currency || listing?.currency || null,
            changedBy || null,
          ],
        );
      }
    }

    if (
      oldStatus !== undefined &&
      newStatus !== undefined &&
      String(oldStatus || "") !== String(newStatus || "")
    ) {
      await pool.query(
        `
        INSERT INTO listing_status_history (
          listing_id,
          product_id,
          old_status,
          new_status,
          changed_by,
          reason
        )
        VALUES ($1, $2, $3, $4, $5::uuid, $6)
        `,
        [
          listing?.id || null,
          productId,
          oldStatus || null,
          newStatus || null,
          changedBy || null,
          reason,
        ],
      );
    }
  } catch (err) {
    console.warn("[ListingHistory] record skipped:", err?.message);
  }
};

const updateListingLocationMetadata = async (productId, body = {}) => {
  const formattedAddress = body.formatted_address || body.formattedAddress || null;
  const placeId = body.place_id || body.placeId || null;
  const locationConfidence = body.location_confidence || body.locationConfidence || null;

  if (!formattedAddress && !placeId && !locationConfidence) return null;

  try {
    const result = await pool.query(
      `
      UPDATE listings
      SET
        formatted_address = COALESCE($2, formatted_address),
        place_id = COALESCE($3, place_id),
        location_confidence = COALESCE($4, location_confidence),
        updated_at = NOW()
      WHERE product_id = $1
      RETURNING *
      `,
      [productId, formattedAddress, placeId, locationConfidence],
    );
    return result.rows[0] || null;
  } catch (err) {
    console.warn("[Listings] location metadata update skipped:", err?.message);
    return null;
  }
};

const updateListingFinancialMetadata = async (productId, body = {}) => {
  const values = {
    property_tax_frequency:
      body.property_tax_frequency || body.propertyTaxFrequency || null,
    insurance_frequency:
      body.insurance_frequency || body.insuranceFrequency || null,
    estate_service_charge:
      toNumberOrNull(body.estate_service_charge ?? body.estateServiceCharge),
    estate_service_charge_frequency:
      body.estate_service_charge_frequency ||
      body.estateServiceChargeFrequency ||
      null,
    service_charge_frequency:
      body.service_charge_frequency || body.serviceChargeFrequency || null,
  };

  if (Object.values(values).every((value) => value === null || value === "")) {
    return null;
  }

  try {
    const result = await pool.query(
      `
      UPDATE listings
      SET
        property_tax_frequency = COALESCE($2, property_tax_frequency),
        insurance_frequency = COALESCE($3, insurance_frequency),
        estate_service_charge = COALESCE($4, estate_service_charge),
        estate_service_charge_frequency = COALESCE($5, estate_service_charge_frequency),
        service_charge_frequency = COALESCE($6, service_charge_frequency),
        updated_at = NOW()
      WHERE product_id = $1
      RETURNING *
      `,
      [
        productId,
        values.property_tax_frequency,
        values.insurance_frequency,
        values.estate_service_charge,
        values.estate_service_charge_frequency,
        values.service_charge_frequency,
      ],
    );
    return result.rows[0] || null;
  } catch (err) {
    console.warn("[Listings] financial metadata update skipped:", err?.message);
    return null;
  }
};

export const createListingInquiry = async (req, res) => {
  try {
    const { product_id } = req.params;
    const buyerId = req.user?.unique_id || null;
    const {
      message = "",
      source = "listing_detail",
      contact_method = "keyvia",
      preferred_contact_method = contact_method,
      inquiry_type = "general",
      name = "",
      email = "",
      phone = "",
    } = req.body || {};

    if (!buyerId && !String(email || "").trim()) {
      return res.status(400).json({
        success: false,
        message: "Please include your email so the listing contact can reply.",
      });
    }

    const listing = await getInteractionListing(product_id);
    if (!listing || !isListingAvailableForBuyerInteraction(listing)) {
      return res.status(404).json({
        success: false,
        message: "This listing is not available for inquiries.",
      });
    }

    const recipientId = getListingInteractionRecipient(listing);
    if (!recipientId) {
      return res.status(404).json({
        success: false,
        message: "Listing contact is not available.",
      });
    }

    if (buyerId && String(recipientId) === String(buyerId)) {
      return res.status(400).json({
        success: false,
        message: "You cannot inquire about your own listing.",
      });
    }

    await ensureListingInquiriesTable();

    const result = await pool.query(
      `
      INSERT INTO listing_inquiries (
        listing_id,
        product_id,
        buyer_id,
        guest_name,
        guest_email,
        guest_phone,
        agent_id,
        owner_id,
        inquiry_status,
        crm_status,
        source,
        metadata,
        last_contacted_at
      )
      VALUES ($1, $2, $3::uuid, $4, $5, $6, $7::uuid, $8::uuid, 'new', 'interested', $9, $10::jsonb, NOW())
      ON CONFLICT (product_id, buyer_id, source)
      DO UPDATE SET
        inquiry_status = 'contacted',
        crm_status = 'interested',
        metadata = listing_inquiries.metadata || EXCLUDED.metadata,
        last_contacted_at = NOW(),
        updated_at = NOW()
      RETURNING *
      `,
      [
        listing.id,
        product_id,
        buyerId,
        buyerId ? null : String(name || "").trim() || null,
        buyerId ? null : String(email || "").trim(),
        buyerId ? null : String(phone || "").trim() || null,
        recipientId,
        recipientId,
        String(source || "listing_detail"),
        JSON.stringify({
          message: String(message || "").trim(),
          preferred_contact_method,
          inquiry_type,
          buyer_name: req.user?.name || name || null,
          buyer_email: req.user?.email || email || null,
          buyer_phone: phone || null,
        }),
      ],
    );

    await pool
      .query(
        `
        UPDATE listings
        SET contact_count = COALESCE(contact_count, 0) + 1
        WHERE product_id = $1
        `,
        [product_id],
      )
      .catch(() => null);

    await createNotification({
      io: req.io,
      recipientId,
      senderId: buyerId || null,
      type: "listing_inquiry",
      title: "New Listing Inquiry",
      message: `${req.user?.name || name || "A buyer"} sent an inquiry for "${listing.title || listing.address || product_id}".`,
      entityType: "listing",
      entityId: product_id,
      productId: product_id,
      actionUrl: `/listing/${product_id}`,
      actionLabel: "View Listing",
      data: {
        product_id,
        buyer_id: buyerId,
        guest_email: buyerId ? null : email || null,
        source,
      },
    }).catch((err) => {
      console.warn("[CreateListingInquiry] notification skipped:", err?.message);
      return null;
    });

    return res.status(201).json({
      success: true,
      message: "Inquiry sent.",
      inquiry: result.rows[0],
    });
  } catch (err) {
    console.error("[CreateListingInquiry] Error:", err);
    return res.status(500).json({
      success: false,
      message: "Could not send inquiry.",
    });
  }
};

export const trackListingShare = async (req, res) => {
  try {
    const { product_id } = req.params;

    await pool
      .query(
        `
        UPDATE listings
        SET shares_count = COALESCE(shares_count, 0) + 1
        WHERE product_id = $1
        `,
        [product_id],
      )
      .catch(() => null);

    return res.json({ success: true });
  } catch (err) {
    return res.json({ success: true });
  }
};

export const trackListingContactClick = async (req, res) => {
  try {
    const { product_id } = req.params;

    await pool
      .query(
        `
        UPDATE listings
        SET contact_count = COALESCE(contact_count, 0) + 1
        WHERE product_id = $1
        `,
        [product_id],
      )
      .catch(() => null);

    return res.json({ success: true });
  } catch (err) {
    return res.json({ success: true });
  }
};

export const getListingAnalytics = async (req, res) => {
  try {
    const { product_id } = req.params;
    const listing = await getInteractionListing(product_id);

    if (!listing) {
      return res.status(404).json({
        success: false,
        message: "Listing not found.",
      });
    }

    if (!userCanManageListing(req.user, listing)) {
      return res.status(403).json({
        success: false,
        message: "You do not have access to analytics for this listing.",
      });
    }

    const hasViewEvents = await tableExists("listing_view_events");
    const hasInquiries = await tableExists("listing_inquiries");
    const hasReports = await tableExists("safety_reports");

    const [viewsRes, inquiryRes, reportRes] = await Promise.all([
      hasViewEvents
        ? pool.query(
            `
            SELECT
              COUNT(*)::int AS unique_views,
              viewed_on::date AS day,
              COUNT(*)::int AS views
            FROM listing_view_events
            WHERE product_id = $1
              AND viewed_on >= CURRENT_DATE - INTERVAL '29 days'
            GROUP BY viewed_on
            ORDER BY viewed_on ASC
            `,
            [product_id],
          )
        : Promise.resolve({ rows: [] }),
      hasInquiries
        ? pool.query(
            `SELECT COUNT(*)::int AS total FROM listing_inquiries WHERE product_id = $1`,
            [product_id],
          )
        : Promise.resolve({ rows: [{ total: 0 }] }),
      hasReports
        ? pool.query(
            `SELECT COUNT(*)::int AS total FROM safety_reports WHERE product_id = $1`,
            [product_id],
          )
        : Promise.resolve({ rows: [{ total: 0 }] }),
    ]);

    const daily = viewsRes.rows.map((row) => ({
      date: row.day,
      views: Number(row.views || 0),
    }));

    const uniqueViews = daily.reduce((sum, row) => sum + Number(row.views || 0), 0);

    pool.query(

      `

      INSERT INTO listing_engagement_snapshots (product_id, views_count, saves_count, shares_count, contact_count, tour_request_count, snapshot_date)

      VALUES ($1, $2, $3, $4, $5, $6, CURRENT_DATE)

      ON CONFLICT (product_id, snapshot_date)

      DO UPDATE SET

        views_count = EXCLUDED.views_count,

        saves_count = EXCLUDED.saves_count,

        shares_count = EXCLUDED.shares_count,

        contact_count = EXCLUDED.contact_count,

        tour_request_count = EXCLUDED.tour_request_count

      `,

      [

        product_id,

        Number(listing.views_count || 0),

        Number(listing.saves_count || 0),

        Number(listing.shares_count || 0),

        Number(listing.contact_count || 0),

        Number(listing.tour_request_count || 0),

      ],

    ).catch(() => {});



    return res.json({

      success: true,

      analytics: {

        product_id,

        title: listing.title,

        status: listing.status,

        is_active: listing.is_active,

        last_updated_at: listing.last_updated_at || listing.updated_at,

        views: Number(listing.views_count || 0),

        unique_views: uniqueViews,

        saves: Number(listing.saves_count || 0),

        shares: Number(listing.shares_count || 0),

        inquiries: Number(inquiryRes.rows[0]?.total || listing.contact_count || 0),

        contact_clicks: Number(listing.contact_count || 0),

        tour_requests: Number(listing.tour_request_count || 0),

        reports: Number(reportRes.rows[0]?.total || 0),

        daily,

      },

    });

  } catch (err) {

    console.error("[GetListingAnalytics] Error:", err);

    return res.status(500).json({

      success: false,

      message: "Analytics unavailable right now.",

    });

  }

};

export const getListingLocationIntelligence = async (req, res) => {
  try {
    const { product_id } = req.params;
    const listing = await getInteractionListing(product_id);

    if (!listing || !canViewListingPublicData(req.user || {}, listing)) {
      return res.status(404).json({
        success: false,
        message: "Location intelligence is not available for this listing.",
      });
    }

    const snapshot = await getLatestLocationIntelligence(product_id);
    if (!snapshot) {
      const hasCoords = listing.latitude && listing.longitude;
      if (hasCoords) {
        scanLocationIntelligence({
          listingId: listing.id,
          productId: product_id,
          latitude: listing.latitude,
          longitude: listing.longitude,
          provider: "auto",
        }).catch((err) => {
          console.warn("[GetListingLocationIntelligence] Background scan failed:", err?.message);
        });
      }
      return res.json({
        success: true,
        status: hasCoords ? "scanning" : "unavailable",
        location_intelligence: {
          product_id,
          status: hasCoords ? "scanning" : "unavailable",
          schools: [],
          hospitals: [],
          transit: [],
          groceries_markets: [],
          restaurants_cafes: [],
          parks_recreation: [],
          malls_shopping: [],
          lifestyle_summary: {},
          street_view: { available: false },
        },
      });
    }

    return res.json({
      success: true,
      status: snapshot.status,
      location_intelligence: snapshot,
    });
  } catch (err) {
    console.error("[GetListingLocationIntelligence] Error:", err);
    return res.status(500).json({
      success: false,
      message: "Neighborhood data is being prepared for this listing.",
    });
  }
};

export const scanListingLocationIntelligence = async (req, res) => {
  try {
    const { product_id } = req.params;
    const listing = await getInteractionListing(product_id);

    if (!listing) {
      return res.status(404).json({
        success: false,
        message: "Listing not found.",
      });
    }

    if (!userCanManageListing(req.user || {}, listing)) {
      return res.status(403).json({
        success: false,
        message: "You do not have permission to rescan this listing.",
      });
    }

    const latitude = req.body?.latitude ?? listing.latitude;
    const longitude = req.body?.longitude ?? listing.longitude;

    if (!latitude || !longitude) {
      return res.status(400).json({
        success: false,
        message: "Confirmed listing coordinates are required before scanning nearby places.",
      });
    }

    const snapshot = await scanLocationIntelligence({
      listingId: listing.id,
      productId: product_id,
      latitude,
      longitude,
      provider: req.body?.provider || "auto",
    });

    return res.status(201).json({
      success: true,
      location_intelligence: snapshot,
    });
  } catch (err) {
    console.error("[ScanListingLocationIntelligence] Error:", err);
    return res.status(500).json({
      success: false,
      message: "Neighborhood data is being prepared for this listing.",
    });
  }
};

export const getListingMarketHistory = async (req, res) => {
  try {
    const { product_id } = req.params;
    const listing = await getInteractionListing(product_id);

    if (!listing || !canViewListingPublicData(req.user || {}, listing)) {
      return res.status(404).json({
        success: false,
        message: "Market history is not available for this listing.",
      });
    }

    const [priceHistory, statusHistory, engagementSnapshots] = await Promise.all([
      tableExists("listing_price_history").then((exists) =>
        exists
          ? pool.query(
              `
              SELECT old_price, new_price, currency, change_type, source, created_at
              FROM listing_price_history
              WHERE product_id = $1
              ORDER BY created_at ASC
              `,
              [product_id],
            )
          : { rows: [] },
      ),
      tableExists("listing_status_history").then((exists) =>
        exists
          ? pool.query(
              `
              SELECT old_status, new_status, reason, created_at
              FROM listing_status_history
              WHERE product_id = $1
              ORDER BY created_at ASC
              `,
              [product_id],
            )
          : { rows: [] },
      ),
      tableExists("listing_engagement_snapshots").then((exists) =>
        exists
          ? pool.query(
              `
              SELECT views_count, saves_count, shares_count, contact_count, tour_request_count, snapshot_date
              FROM listing_engagement_snapshots
              WHERE product_id = $1
              ORDER BY snapshot_date ASC
              LIMIT 60
              `,
              [product_id],
            )
          : { rows: [] },
      ),
    ]);

    return res.json({
      success: true,
      market_history: {
        product_id,
        price_history: priceHistory.rows,
        status_history: statusHistory.rows,
        engagement_snapshots: engagementSnapshots.rows,
      },
    });
  } catch (err) {
    console.error("[GetListingMarketHistory] Error:", err);
    return res.status(500).json({
      success: false,
      message: "Could not load listing history right now.",
    });
  }
};

/* -------------------------------------------------------
   GET AGENT LISTINGS
------------------------------------------------------- */
export const getAgentListings = async (req, res) => {
  try {

    const userId = req.user?.unique_id;



    if (!userId) {

      return res.status(401).json({

        message: "Unauthorized",

        code: "UNAUTHORIZED",

      });

    }



    const query = `

      SELECT

        l.*,



        u.unique_id AS uploader_unique_id,

        u.name AS uploader_name,

        u.email AS uploader_email,

        u.phone AS uploader_phone,

        u.role AS uploader_role,

        u.avatar_url AS uploader_avatar_url,

        u.bio AS uploader_bio,

        u.country AS uploader_country,

        u.city AS uploader_city,

        u.brokerage_name AS uploader_brokerage_name,

        u.verification_status AS uploader_verification_status,

        u.is_verified AS uploader_is_verified,

        u.is_verified_agent AS uploader_is_verified_agent



      FROM listings l

      LEFT JOIN users u

        ON l.uploaded_by_id = u.unique_id



      WHERE l.uploaded_by_id = $1::uuid



      ORDER BY l.created_at DESC

      LIMIT $2 OFFSET $3;

    `;



    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);

    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);

    const offset = (page - 1) * limit;

    const result = await pool.query(query, [String(userId), limit, offset]);



    const rows = result.rows.map((row) => {

      // Calculate display_status based on status and is_active

      let display_status = "draft";

      if (row.status === "draft") {

        display_status = "draft";

      } else if (row.status === "pending") {

        display_status = "pending";

      } else if (row.status === "rejected") {

        display_status = "rejected";

      } else if (row.status === "approved") {

        display_status = row.is_active ? "live" : "approved";

      }



      return {

        ...row,



        photos: normalizePhotosForResponse(row.photos),

        features: safeJsonParse(row.features, []),

        amenities: safeJsonParse(row.amenities, []),



        latitude: row.latitude ? parseFloat(row.latitude) : null,

        longitude: row.longitude ? parseFloat(row.longitude) : null,



        // Frontend compatibility with older UI names

        agent_unique_id: row.uploaded_by_id,

        created_by: row.uploaded_by_id,

        price_currency: row.price_currency || row.currency || "USD",

        square_footage: row.square_footage || row.area_sqft || null,

        zip_code: row.zip_code || row.postal_code || null,

        payment_status: row.payment_status || "unpaid",



        agent_role: row.uploader_role,

        role: row.uploader_role,



        // Normalized fields for frontend

        display_status,

        is_draft: row.status === "draft",

        current_step: row.current_step || null,

        autosaved_at: row.autosaved_at || null,



        agent: {

          unique_id: row.uploader_unique_id,

          name: row.uploader_name,

          full_name: row.uploader_name,

          email: row.uploader_email,

          phone: row.uploader_phone,

          role: row.uploader_role,

          avatar_url: row.uploader_avatar_url,

          bio: row.uploader_bio,

          country: row.uploader_country,

          city: row.uploader_city,

          brokerage_name: row.uploader_brokerage_name,

          verification_status: row.uploader_verification_status,

          is_verified: row.uploader_is_verified,

          is_verified_agent: row.uploader_is_verified_agent,

        },

      };

    });



    return res.json(rows);

  } catch (err) {

    console.error("[GetUserListings] Error:", err);



    return res.status(500).json({

      message: "Failed to fetch listings",

      code: "GET_USER_LISTINGS_FAIL",

      details: err?.message,

    });

  }

};



/* -------------------------------------------------------

   GET LISTING BY PRODUCT ID

   Route: GET /api/listings/:product_id



   Public + owner/admin-safe:

   - Public can view only approved + active listings

   - Owner/admin can view inactive/pending/draft/rejected listing

   - Uses uploaded_by_id, not old created_by profile join

   - Does NOT depend on profiles.agency_name

   - Hides private/legal document files from public viewers

------------------------------------------------------- */

export const getListingByProductId = async (req, res) => {

  try {

    const { product_id } = req.params;

    const viewerId = req.user?.unique_id || null;

    const viewerRole = String(req.user?.role || "").toLowerCase();



    if (!product_id) {

      return res.status(400).json({

        success: false,

        message: "Listing product ID is required.",

        code: "MISSING_PRODUCT_ID",

      });

    }



    const parseAnyJson = (value, fallback = null) => {

      if (value === undefined || value === null || value === "")

        return fallback;

      if (Array.isArray(value)) return value;

      if (typeof value === "object") return value;



      try {

        return JSON.parse(value);

      } catch {

        return fallback;

      }

    };



    const pick = (...values) => {

      for (const value of values) {

        if (value !== undefined && value !== null && value !== "") {

          return value;

        }

      }



      return null;

    };



    const toBool = (value) => {

      return value === true || value === "true";

    };



    const getRoleLabel = (role, isSoloAgent) => {

      const r = String(role || "").toLowerCase();



      if (r === "agent") {

        return isSoloAgent === false ? "Agency Agent" : "Real Estate Agent";

      }



      if (r === "agency_agent") return "Agency Agent";

      if (r === "brokerage_agent") return "Brokerage Agent";

      if (r === "brokerage" || r === "brokerage_owner")

        return "Brokerage Company";

      if (r === "owner" || r === "landlord") return "Property Owner";

      if (r === "admin" || r === "super_admin") return "Admin";



      return role || "Keyvia Member";

    };



    const result = await pool.query(

      `

      SELECT

        l.*,



        u.unique_id AS uploader_unique_id,

        u.name AS user_name,

        u.username AS user_username,

        u.email AS user_email,

        u.phone AS user_phone,

        u.role AS user_role,

        u.avatar_url AS user_avatar_url,

        u.bio AS user_bio,

        u.country AS user_country,

        u.city AS user_city,

        u.brokerage_name AS user_brokerage_name,

        u.is_solo_agent AS user_is_solo_agent,

        u.verification_status AS user_verification_status,

        u.is_verified AS user_is_verified,

        u.is_verified_agent AS user_is_verified_agent,

        u.subscription_plan AS user_subscription_plan,

        u.subscription_status AS user_subscription_status,

        u.created_at AS user_created_at,



        p.full_name AS profile_full_name,

        p.username AS profile_username,

        p.avatar_url AS profile_avatar_url,

        p.bio AS profile_bio,

        p.email AS profile_email,

        p.phone AS profile_phone,

        p.country AS profile_country,

        p.city AS profile_city,



        ap.experience_years AS agent_experience_years,



        bp.company_name AS brokerage_company_name,

        bp.logo_url AS uploader_brokerage_logo_url,

        bp.verified_badge AS uploader_brokerage_verified_badge,



        assigned_u.unique_id AS assigned_agent_unique_id,

        assigned_u.name AS assigned_agent_user_name,

        assigned_u.username AS assigned_agent_user_username,

        assigned_u.email AS assigned_agent_user_email,

        assigned_u.phone AS assigned_agent_user_phone,

        assigned_u.role AS assigned_agent_user_role,

        assigned_u.avatar_url AS assigned_agent_user_avatar_url,

        assigned_u.bio AS assigned_agent_user_bio,

        assigned_u.country AS assigned_agent_user_country,

        assigned_u.city AS assigned_agent_user_city,

        assigned_u.verification_status AS assigned_agent_verification_status,

        assigned_u.is_verified AS assigned_agent_is_verified,

        assigned_u.is_verified_agent AS assigned_agent_is_verified_agent,

        assigned_u.created_at AS assigned_agent_created_at,

        assigned_u.subscription_plan AS assigned_agent_subscription_plan,

        assigned_u.subscription_status AS assigned_agent_subscription_status,

        assigned_p.full_name AS assigned_agent_profile_full_name,

        assigned_p.username AS assigned_agent_profile_username,

        assigned_p.avatar_url AS assigned_agent_profile_avatar_url,

        assigned_p.bio AS assigned_agent_profile_bio,

        assigned_p.email AS assigned_agent_profile_email,

        assigned_p.phone AS assigned_agent_profile_phone,

        assigned_ap.experience_years AS assigned_agent_experience_years,

        assigned_ap.is_solo_agent AS assigned_agent_is_solo_agent,



        brokerage_u.unique_id AS listing_brokerage_unique_id,

        brokerage_u.name AS listing_brokerage_user_name,

        brokerage_u.username AS listing_brokerage_user_username,

        brokerage_u.email AS listing_brokerage_user_email,

        brokerage_u.phone AS listing_brokerage_user_phone,

        brokerage_u.avatar_url AS listing_brokerage_user_avatar_url,

        brokerage_u.verification_status AS listing_brokerage_verification_status,

        brokerage_u.is_verified AS listing_brokerage_is_verified,

        brokerage_u.verified_badge AS listing_brokerage_user_verified_badge,

        brokerage_p.full_name AS listing_brokerage_profile_name,

        brokerage_p.username AS listing_brokerage_profile_username,

        brokerage_p.avatar_url AS listing_brokerage_profile_avatar_url,

        brokerage_bp.company_name AS listing_brokerage_company_name,

        brokerage_bp.brokerage_address AS listing_brokerage_address,

        brokerage_bp.website AS listing_brokerage_website,

        brokerage_bp.logo_url AS listing_brokerage_logo_url,

        brokerage_bp.verified_badge AS listing_brokerage_verified_badge,

        legacy_b.id AS legacy_brokerage_id,



        CASE

          WHEN $2::uuid IS NOT NULL AND f.product_id IS NOT NULL THEN true

          ELSE false

        END AS is_favorited



      FROM listings l



      LEFT JOIN users u

        ON l.uploaded_by_id::text = u.unique_id::text



      LEFT JOIN profiles p

        ON p.unique_id::text = u.unique_id::text



      LEFT JOIN agent_profiles ap

        ON ap.unique_id::text = u.unique_id::text



      LEFT JOIN brokerage_profiles bp

        ON bp.unique_id::text = u.unique_id::text



      LEFT JOIN users assigned_u

        ON l.assigned_agent_id::text = assigned_u.unique_id::text



      LEFT JOIN profiles assigned_p

        ON assigned_p.unique_id::text = assigned_u.unique_id::text



      LEFT JOIN agent_profiles assigned_ap

        ON assigned_ap.unique_id::text = assigned_u.unique_id::text



      LEFT JOIN brokerages legacy_b

        ON legacy_b.id::text = l.agency_id::text



      LEFT JOIN users brokerage_u

        ON brokerage_u.unique_id::text = COALESCE(

          legacy_b.owner_id::text,

          CASE

            WHEN LOWER(u.role::text) IN ('brokerage_owner', 'brokerage') THEN u.unique_id::text

            ELSE u.linked_agency_id::text

          END,

          l.agency_id::text

        )



      LEFT JOIN profiles brokerage_p

        ON brokerage_p.unique_id::text = brokerage_u.unique_id::text



      LEFT JOIN brokerage_profiles brokerage_bp

        ON brokerage_bp.unique_id::text = brokerage_u.unique_id::text



      LEFT JOIN favorites f

        ON f.product_id = l.product_id

        AND $2::uuid IS NOT NULL

        AND f.user_id = $2::uuid



      WHERE l.product_id = $1

      LIMIT 1;

      `,

      [product_id, viewerId ? String(viewerId) : null],

    );



    const row = result.rows[0];



    if (!row) {

      return res.status(404).json({

        success: false,

        message: "Listing not found.",

        code: "LISTING_NOT_FOUND",

      });

    }



    const ownerId = pick(

      row.uploaded_by_id,

      row.agent_unique_id,

      row.created_by,

    );



    const isOwner = viewerId && ownerId && String(ownerId) === String(viewerId);



    const isAdmin =

      viewerRole === "admin" ||

      viewerRole === "super_admin" ||

      req.user?.is_admin === true;



    const isPublicReady = row.status === "approved" && row.is_active === true;



    if (!isPublicReady && !isOwner && !isAdmin) {

      return res.status(403).json({

        success: false,

        message: "This listing is not currently active.",

        code: "LISTING_NOT_ACTIVE",

      });

    }



    const canViewPrivateAdminFields = isOwner || isAdmin;

    if (isPublicReady && !isOwner && !isAdmin) {
      const viewResult = await recordListingView({
        req,
        productId: row.product_id,
        viewerId,
      });

      if (viewResult.viewsCount !== null && viewResult.viewsCount !== undefined) {
        row.views_count = viewResult.viewsCount;
      }
    }

    const draftData = parseAnyJson(row.draft_data, {}) || {};


    const photos = normalizePhotosForResponse(

      pick(row.photos, draftData.photos, []),

    );



    const floorPlans = parseAnyJson(

      pick(row.floor_plans, draftData.floorPlans, draftData.floor_plans),

      [],

    );



    const stagingPhotos = parseAnyJson(

      pick(

        row.staging_photos,

        draftData.stagingPhotos,

        draftData.staging_photos,

      ),

      [],

    );



    const panoramaPhotos = parseAnyJson(

      pick(

        row.panorama_photos,

        draftData.panoramaPhotos,

        draftData.panorama_photos,

      ),

      [],

    );



    const features = parseAnyJson(

      pick(row.features, draftData.features, draftData.amenities),

      [],

    );



    const amenities = parseAnyJson(

      pick(row.amenities, draftData.amenities, draftData.features),

      [],

    );



    const paymentOptions = parseAnyJson(

      pick(

        row.payment_options,

        draftData.paymentOptions,

        draftData.payment_options,

      ),

      [],

    );



    const preferredTourDays = parseAnyJson(

      pick(

        row.preferred_tour_days,

        draftData.preferredTourDays,

        draftData.preferred_tour_days,

      ),

      [],

    );



    const finalRole = row.user_role;



    const verificationStatus = String(

      row.user_verification_status || "",

    ).toLowerCase();



    const isVerified =

      row.user_is_verified === true ||

      row.user_is_verified_agent === true ||

      verificationStatus === "approved" ||

      verificationStatus === "verified";



    const subscriptionPlan = String(

      row.user_subscription_plan || "free",

    ).toLowerCase();



    const subscriptionStatus = String(

      row.user_subscription_status || "",

    ).toLowerCase();



    const hasActiveSubscription = subscriptionStatus === "active";



    let publicBadge = null;



    if (

      isVerified &&

      hasActiveSubscription &&

      ["elite_agent", "elite_owner", "elite_brokerage", "enterprise"].includes(

        subscriptionPlan,

      )

    ) {

      publicBadge = "elite_verified";

    } else if (

      isVerified &&

      hasActiveSubscription &&

      ["pro_agent", "pro_owner", "pro_brokerage"].includes(subscriptionPlan)

    ) {

      publicBadge = "pro_verified";

    } else if (isVerified) {

      publicBadge = "verified";

    }



    const agentName = pick(

      row.profile_full_name,

      row.user_name,

      row.contact_name,

      "Keyvia User",

    );



    const agentAvatar = pick(row.profile_avatar_url, row.user_avatar_url);



    const companyName = pick(

      row.listing_brokerage_company_name,

      row.brokerage_company_name,

      row.user_brokerage_name,

      draftData.companyName,

      draftData.company_name,

      draftData.agencyName,

      draftData.agency_name,

    );



    const assignedAgentName = pick(

      row.assigned_agent_profile_full_name,

      row.assigned_agent_user_name,

    );



    const assignedAgentVerificationStatus = String(

      row.assigned_agent_verification_status || "",

    ).toLowerCase();



    const assignedAgentIsVerified =

      row.assigned_agent_is_verified === true ||

      row.assigned_agent_is_verified_agent === true ||

      assignedAgentVerificationStatus === "approved" ||

      assignedAgentVerificationStatus === "verified";



    const assignedAgent = row.assigned_agent_unique_id

      ? {

          unique_id: row.assigned_agent_unique_id,

          name: assignedAgentName || "Keyvia Agent",

          full_name: assignedAgentName || "Keyvia Agent",

          username: pick(

            row.assigned_agent_profile_username,

            row.assigned_agent_user_username,

          ),

          avatar_url: pick(

            row.assigned_agent_profile_avatar_url,

            row.assigned_agent_user_avatar_url,

          ),

          avatar: pick(

            row.assigned_agent_profile_avatar_url,

            row.assigned_agent_user_avatar_url,

          ),

          bio: pick(

            row.assigned_agent_profile_bio,

            row.assigned_agent_user_bio,

          ),

          country: row.assigned_agent_user_country,

          city: row.assigned_agent_user_city,

          email: pick(

            row.assigned_agent_profile_email,

            row.assigned_agent_user_email,

          ),

          phone:

            canViewPrivateAdminFields ||

            row.show_contact_phone === true ||

            draftData.showContactPhone === true

              ? pick(

                  row.assigned_agent_profile_phone,

                  row.assigned_agent_user_phone,

                )

              : null,

          role: row.assigned_agent_user_role || "agent",

          role_label: getRoleLabel(

            row.assigned_agent_user_role || "agent",

            row.assigned_agent_is_solo_agent,

          ),

          is_solo_agent: row.assigned_agent_is_solo_agent,

          company_name: companyName,

          agency_name: companyName,

          brokerage_name: companyName,

          experience_years: row.assigned_agent_experience_years || null,

          verification_status: assignedAgentIsVerified

            ? "verified"

            : row.assigned_agent_verification_status || "unverified",

          is_verified: assignedAgentIsVerified,

          is_verified_agent: row.assigned_agent_is_verified_agent === true,

          subscription_plan: row.assigned_agent_subscription_plan || null,

          subscription_status: row.assigned_agent_subscription_status || null,

          created_at: row.assigned_agent_created_at,

        }

      : null;



    const brokerageName = pick(

      row.listing_brokerage_company_name,

      row.listing_brokerage_profile_name,

      row.listing_brokerage_user_name,

      ["brokerage", "brokerage_owner"].includes(

        String(finalRole || "").toLowerCase(),

      )

        ? companyName || agentName

        : null,

    );



    const brokerageIsVerified =

      row.listing_brokerage_is_verified === true ||

      row.listing_brokerage_verified_badge === true ||

      row.listing_brokerage_user_verified_badge === true ||

      ["approved", "verified"].includes(

        String(row.listing_brokerage_verification_status || "").toLowerCase(),

      ) ||

      (["brokerage", "brokerage_owner"].includes(

        String(finalRole || "").toLowerCase(),

      ) &&

        isVerified);



    const brokerageSummary =

      row.listing_brokerage_unique_id || brokerageName

        ? {

            id:

              row.legacy_brokerage_id ||

              row.listing_brokerage_unique_id ||

              null,

            unique_id: row.listing_brokerage_unique_id || null,

            name: brokerageName,

            company_name: brokerageName,

            username: pick(

              row.listing_brokerage_profile_username,

              row.listing_brokerage_user_username,

            ),

            avatar_url: pick(

              row.listing_brokerage_logo_url,

              row.listing_brokerage_profile_avatar_url,

              row.listing_brokerage_user_avatar_url,

              row.uploader_brokerage_logo_url,

            ),

            logo_url: pick(

              row.listing_brokerage_logo_url,

              row.uploader_brokerage_logo_url,

              row.listing_brokerage_profile_avatar_url,

              row.listing_brokerage_user_avatar_url,

            ),

            address: row.listing_brokerage_address || null,

            website: row.listing_brokerage_website || null,

            email: row.listing_brokerage_user_email || null,

            phone:

              canViewPrivateAdminFields ||

              row.show_contact_phone === true ||

              draftData.showContactPhone === true

                ? row.listing_brokerage_user_phone || null

                : null,

            role: "brokerage",

            role_label: "Brokerage Company",

            verification_status: brokerageIsVerified

              ? "verified"

              : row.listing_brokerage_verification_status || "unverified",

            is_verified: brokerageIsVerified,

          }

        : null;



    const uploaderAgent = {

      unique_id: pick(row.uploader_unique_id, row.uploaded_by_id),

      name: agentName,

      full_name: agentName,

      username: pick(row.profile_username, row.user_username),

      avatar_url: agentAvatar,

      avatar: agentAvatar,

      bio: pick(row.profile_bio, row.user_bio),

      country: pick(row.profile_country, row.user_country),

      city: pick(row.profile_city, row.user_city),



      // Keep public-safe contact. Do not expose phone unless permitted.

      email: pick(row.profile_email, row.user_email),

      phone:

        canViewPrivateAdminFields ||

        row.show_contact_phone === true ||

        draftData.showContactPhone === true

          ? pick(row.profile_phone, row.user_phone, row.contact_phone)

          : null,



      role: finalRole,

      role_label: getRoleLabel(finalRole, row.user_is_solo_agent),

      is_solo_agent: row.user_is_solo_agent,



      company_name: companyName,

      agency_name:

        String(finalRole || "").toLowerCase() === "agent" &&

        row.user_is_solo_agent === false

          ? companyName

          : null,

      brokerage_name: ["brokerage", "brokerage_owner"].includes(

        String(finalRole || "").toLowerCase(),

      )

        ? companyName

        : null,



      experience_years: row.agent_experience_years || null,



      verification_status: isVerified

        ? "verified"

        : row.user_verification_status || "unverified",



      is_verified: isVerified,

      is_verified_agent: row.user_is_verified_agent === true,

      subscription_plan: row.user_subscription_plan || null,

      subscription_status: row.user_subscription_status || null,

      public_badge: publicBadge,

      created_at: row.user_created_at,

    };



    const primaryContactProfile = assignedAgent || uploaderAgent;



    const latitude = pick(row.latitude, draftData.latitude);

    const longitude = pick(row.longitude, draftData.longitude);



    const legalPayload = canViewPrivateAdminFields

      ? {

          title_document_file: parseAnyJson(

            pick(

              row.title_document_file,

              draftData.titleDocumentFile,

              draftData.title_document_file,

            ),

            null,

          ),

        }

      : {

          // Public users only get trust signals, not private files.

          title_document_file: null,

        };



    const badgeMeta = computeListingBadges(row, {
      photos,
      floorPlans: Array.isArray(floorPlans) ? floorPlans : [],
      stagingPhotos: Array.isArray(stagingPhotos) ? stagingPhotos : [],
      panoramaPhotos: Array.isArray(panoramaPhotos) ? panoramaPhotos : [],
    });
    const analyticsMeta = buildListingAnalytics(row, badgeMeta);
    const locationIntelligence = await getLatestLocationIntelligence(product_id);

    const response = {
      ...row,
      ...badgeMeta,
      analytics: analyticsMeta,
      location_intelligence: locationIntelligence,

      success: true,


      draft_data: canViewPrivateAdminFields ? draftData : undefined,



      photos,

      floor_plans: Array.isArray(floorPlans) ? floorPlans : [],

      staging_photos: Array.isArray(stagingPhotos) ? stagingPhotos : [],

      panorama_photos: Array.isArray(panoramaPhotos) ? panoramaPhotos : [],

      features,

      amenities,

      payment_options: paymentOptions,

      preferred_tour_days: preferredTourDays,



      latitude:

        latitude !== null && latitude !== undefined && latitude !== ""

          ? parseFloat(latitude)

          : null,



      longitude:

        longitude !== null && longitude !== undefined && longitude !== ""

          ? parseFloat(longitude)

          : null,



      agent_unique_id: pick(row.agent_unique_id, row.uploaded_by_id),

      created_by: pick(row.created_by, row.uploaded_by_id),

      uploaded_by_id: row.uploaded_by_id,



      price_currency: pick(

        row.price_currency,

        row.currency,

        draftData.priceCurrency,

        draftData.price_currency,

        "USD",

      ),



      currency: pick(

        row.currency,

        row.price_currency,

        draftData.priceCurrency,

        draftData.price_currency,

        "USD",

      ),



      price_period: pick(row.price_period, draftData.pricePeriod),



      property_type: pick(row.property_type, draftData.propertyType),

      property_subtype: pick(row.property_subtype, draftData.propertySubtype),

      listing_type: pick(row.listing_type, draftData.listingType),

      category: pick(row.category, row.listing_type, draftData.listingType),



      square_footage: pick(

        row.square_footage,

        row.area_sqft,

        row.building_area_sqft,

        draftData.squareFootage,

        draftData.buildingAreaSqft,

      ),



      area_sqft: pick(

        row.area_sqft,

        row.square_footage,

        row.building_area_sqft,

        draftData.buildingAreaSqft,

      ),



      building_area_sqft: pick(

        row.building_area_sqft,

        row.area_sqft,

        row.square_footage,

        draftData.buildingAreaSqft,

        draftData.building_area_sqft,

      ),



      land_area_sqft: pick(

        row.land_area_sqft,

        row.lot_size,

        draftData.landAreaSqft,

        draftData.land_area_sqft,

      ),



      lot_size: pick(

        row.lot_size,

        row.land_area_sqft,

        draftData.landAreaSqft,

        draftData.lotSize,

      ),



      building_area_unit: pick(

        row.building_area_unit,

        draftData.buildingAreaUnit,

        "sqft",

      ),



      land_area_unit: pick(row.land_area_unit, draftData.landAreaUnit, "sqft"),



      zip_code: pick(row.zip_code, row.postal_code, draftData.zipCode),

      postal_code: pick(row.postal_code, row.zip_code, draftData.zipCode),



      neighborhood: pick(row.neighborhood, draftData.neighborhood),

      estate_name: pick(row.estate_name, draftData.estateName),

      landmark: pick(row.landmark, draftData.landmark),

      road_access: pick(row.road_access, draftData.roadAccess),



      total_rooms: pick(row.total_rooms, draftData.totalRooms),

      floors: pick(row.floors, draftData.floors),

      floor_number: pick(row.floor_number, draftData.floorNumber),

      total_floors: pick(row.total_floors, draftData.totalFloors),

      garage_spaces: pick(row.garage_spaces, draftData.garageSpaces),



      property_condition: pick(

        row.property_condition,

        draftData.propertyCondition,

      ),



      construction_status: pick(

        row.construction_status,

        draftData.constructionStatus,

      ),



      ownership_type: pick(row.ownership_type, draftData.ownershipType),



      power_supply: pick(row.power_supply, draftData.powerSupply),

      water_supply: pick(row.water_supply, draftData.waterSupply),

      internet_available:

        row.internet_available !== null && row.internet_available !== undefined

          ? row.internet_available

          : toBool(draftData.internetAvailable),



      drainage: pick(row.drainage, draftData.drainage),

      security_type: pick(row.security_type, draftData.securityType),



      generator_available:

        row.generator_available !== null &&

        row.generator_available !== undefined

          ? row.generator_available

          : toBool(draftData.generatorAvailable),



      borehole:

        row.borehole !== null && row.borehole !== undefined

          ? row.borehole

          : toBool(draftData.borehole),



      prepaid_meter:

        row.prepaid_meter !== null && row.prepaid_meter !== undefined

          ? row.prepaid_meter

          : toBool(draftData.prepaidMeter),



      waste_disposal: pick(row.waste_disposal, draftData.wasteDisposal),



      service_charge: pick(row.service_charge, draftData.serviceCharge),

      caution_fee: pick(row.caution_fee, draftData.cautionFee),

      agency_fee: pick(row.agency_fee, draftData.agencyFee),

      legal_fee: pick(row.legal_fee, draftData.legalFee),

      refundable_deposit: pick(

        row.refundable_deposit,

        draftData.refundableDeposit,

      ),



      minimum_rent_duration: pick(

        row.minimum_rent_duration,

        draftData.minimumRentDuration,

      ),



      rent_payment_frequency: pick(

        row.rent_payment_frequency,

        draftData.rentPaymentFrequency,

      ),



      pets_policy: pick(row.pets_policy, draftData.petsPolicy),

      smoking_policy: pick(row.smoking_policy, draftData.smokingPolicy),

      guest_policy: pick(row.guest_policy, draftData.guestPolicy),



      mortgage_available:

        row.mortgage_available !== null && row.mortgage_available !== undefined

          ? row.mortgage_available

          : toBool(draftData.mortgageAvailable),



      installment_available:

        row.installment_available !== null &&

        row.installment_available !== undefined

          ? row.installment_available

          : toBool(draftData.installmentAvailable),



      rent_to_own_available:

        row.rent_to_own_available !== null &&

        row.rent_to_own_available !== undefined

          ? row.rent_to_own_available

          : toBool(draftData.rentToOwnAvailable),



      estimated_monthly_payment: pick(

        row.estimated_monthly_payment,

        draftData.estimatedMonthlyPayment,

      ),



      down_payment_percent: pick(

        row.down_payment_percent,

        draftData.downPaymentPercent,

      ),



      interest_rate_estimate: pick(

        row.interest_rate_estimate,

        draftData.interestRateEstimate,

      ),



      hoa_fee: pick(row.hoa_fee, draftData.hoaFee),



      property_tax_estimate: pick(

        row.property_tax_estimate,

        draftData.propertyTaxEstimate,

      ),



      insurance_estimate: pick(

        row.insurance_estimate,

        draftData.insuranceEstimate,

      ),



      price_per_sqft: pick(row.price_per_sqft, draftData.pricePerSqft),



      price_negotiable:

        row.price_negotiable !== null && row.price_negotiable !== undefined

          ? row.price_negotiable

          : toBool(draftData.priceNegotiable),



      closing_cost_estimate: pick(

        row.closing_cost_estimate,

        draftData.closingCostEstimate,

      ),



      title_document_type: pick(

        row.title_document_type,

        draftData.titleDocumentType,

      ),



      title_verified:

        row.title_verified !== null && row.title_verified !== undefined

          ? row.title_verified

          : toBool(draftData.titleVerified),



      survey_available:

        row.survey_available !== null && row.survey_available !== undefined

          ? row.survey_available

          : toBool(draftData.surveyAvailable),



      building_approval_available:

        row.building_approval_available !== null &&

        row.building_approval_available !== undefined

          ? row.building_approval_available

          : toBool(draftData.buildingApprovalAvailable),



      ...legalPayload,



      video_url: pick(row.video_url, draftData.video?.url),

      video_public_id: pick(

        row.video_public_id,

        draftData.video?.key,

        draftData.video?.public_id,

      ),



      virtual_tour_url: pick(

        row.virtual_tour_url,

        draftData.virtualTourUrl,

        draftData.virtual_tour_url,

        draftData.virtualTourFile?.url,

        draftData.virtual_tour_file?.url,

      ),



      virtual_tour_public_id: pick(

        row.virtual_tour_public_id,

        draftData.virtualTourFile?.key,

        draftData.virtual_tour_file?.key,

      ),



      virtual_tour_file: canViewPrivateAdminFields

        ? parseAnyJson(

            pick(

              row.virtual_tour_file,

              draftData.virtualTourFile,

              draftData.virtual_tour_file,

            ),

            null,

          )

        : null,



      three_d_home_url: pick(row.three_d_home_url, draftData.threeDHomeUrl),



      allow_tour_requests:

        row.allow_tour_requests !== null &&

        row.allow_tour_requests !== undefined

          ? row.allow_tour_requests

          : draftData.allowTourRequests !== false,



      allow_video_tour:

        row.allow_video_tour !== null && row.allow_video_tour !== undefined

          ? row.allow_video_tour

          : draftData.allowVideoTour !== false,



      allow_in_person_tour:

        row.allow_in_person_tour !== null &&

        row.allow_in_person_tour !== undefined

          ? row.allow_in_person_tour

          : draftData.allowInPersonTour !== false,



      preferred_tour_times: pick(

        row.preferred_tour_times,

        draftData.preferredTourTimes,

      ),



      minimum_notice_hours: pick(

        row.minimum_notice_hours,

        draftData.minimumNoticeHours,

      ),



      contact_name: pick(

        row.contact_name,

        draftData.contactName,

        primaryContactProfile?.name,

        agentName,

      ),



      // Public contact behavior:

      // - Email is okay if listing chose email/platform contact.

      // - Phone only returns if show_contact_phone is true, unless owner/admin.

      contact_email: pick(

        row.contact_email,

        draftData.contactEmail,

        primaryContactProfile?.email,

        row.user_email,

      ),



      contact_phone:

        canViewPrivateAdminFields ||

        row.show_contact_phone === true ||

        draftData.showContactPhone === true

          ? pick(row.contact_phone, draftData.contactPhone) ||

            primaryContactProfile?.phone

          : null,



      contact_method: pick(row.contact_method, draftData.contactMethod),



      show_contact_phone:

        row.show_contact_phone !== null && row.show_contact_phone !== undefined

          ? row.show_contact_phone

          : toBool(draftData.showContactPhone),



      availability_status: pick(

        row.availability_status,

        draftData.availabilityStatus,

        "available_now",

      ),



      available_from: pick(row.available_from, draftData.availableFrom),



      payment_status: pick(row.payment_status, "unpaid"),



      is_favorited: row.is_favorited === true,
      views_count: analyticsMeta.views_count,
      saves_count: analyticsMeta.saves_count,
      shares_count: analyticsMeta.shares_count,
      contact_count: analyticsMeta.contact_count,
      tour_request_count: analyticsMeta.tour_request_count,
      previous_price: analyticsMeta.previous_price,
      price_drop_amount: analyticsMeta.price_drop_amount,
      price_drop_percent: analyticsMeta.price_drop_percent,

      agent_role: finalRole,
      role: finalRole,



      agent: {

        ...primaryContactProfile,

        company_name: pick(primaryContactProfile?.company_name, companyName),

        brokerage_name: pick(

          primaryContactProfile?.brokerage_name,

          brokerageSummary?.company_name,

          companyName,

        ),

      },

      creator: uploaderAgent,

      submitter: uploaderAgent,

      assigned_agent: assignedAgent,

      brokerage: brokerageSummary,

      contact_profile: primaryContactProfile,

    };



    return res.json(response);

  } catch (err) {

    console.error("[GetListingByProductId] Error:", err);



    return res.status(500).json({

      success: false,

      message: "Failed to fetch listing.",

      code: "GET_LISTING_BY_PRODUCT_ID_FAILED",

      details: err?.message,

    });

  }

};



/* -------------------------------------------------------

   UPDATE LISTING STATUS - ADMIN

------------------------------------------------------- */

export const updateListingStatus = async (req, res) => {

  try {

    const { product_id } = req.params;

    const { status } = req.body;



    if (!["approved", "rejected", "pending"].includes(status)) {

      return res.status(400).json({ message: "Invalid status value" });

    }



    const existing = await pool.query(

      `SELECT * FROM listings WHERE product_id=$1`,

      [product_id],

    );

    const listing = existing.rows[0];



    if (!listing) return res.status(404).json({ message: "Listing not found" });



    let isActiveValue = listing.is_active;

    if (status === "approved") {
      isActiveValue = true;
    } else if (status === "rejected" || status === "pending") {
      isActiveValue = false;
    }


    const updateQuery = `

      UPDATE listings

      SET status=$1,

          is_active=$2,

          updated_at=NOW()

      WHERE product_id=$3

      RETURNING *;

    `;



    const result = await pool.query(updateQuery, [
      status,
      isActiveValue,
      product_id,
    ]);
    const updatedListing = result.rows[0];

    await recordListingHistory({

      listing,

      productId: product_id,

      changedBy: req.user?.unique_id || null,

      oldStatus: listing.status,

      newStatus: updatedListing.status,

      reason: req.body?.reason || null,

    });



    pool.query(

      `

      INSERT INTO user_activity_log (user_id, action, resource_type, resource_id, metadata)

      VALUES ($1, $2, $3, $4, $5)

      `,

      [req.user?.unique_id, 'update_listing_status', 'listing', product_id, JSON.stringify({ old_status: listing.status, new_status: updatedListing.status })],

    ).catch(() => {});



    await notifyListingStatusUpdate({

      listing: updatedListing,

      status,

      io: req.io,

    });



    if (String(listing.status ?? "") !== String(updatedListing.status ?? "")) {

      setImmediate(() => {

        notifyStatusChange(req.io, updatedListing, listing.status, updatedListing.status).catch(() => {});

      });

    }



    if (req.io) {

      const socketRecipient =

        updatedListing.uploaded_by_id ||

        updatedListing.agent_unique_id ||

        updatedListing.created_by;

      if (socketRecipient) {
        req.io.to(String(socketRecipient)).emit("listingStatusUpdated", {
          product_id,
          status,
          is_active: isActiveValue,
        });
      }
    }


    res.json({

      success: true,

      message: "Listing status updated",

      listing: updatedListing,

    });

  } catch (err) {

    console.error("UpdateListingStatus Error:", err);

    res.status(500).json({ message: "Failed to update listing status" });

  }

};



export const activateListing = async (req, res) => {
  try {
    const { product_id } = req.params;
    const userId = req.user?.unique_id;
    const role = String(req.user?.role || "").toLowerCase();

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized.",
        code: "UNAUTHORIZED",
      });
    }

    const existing = await pool.query(
      `SELECT * FROM listings WHERE product_id=$1 LIMIT 1`,
      [product_id],
    );
    const listing = existing.rows[0];

    if (!listing) {
      return res.status(404).json({
        success: false,
        message: "Listing not found.",
        code: "LISTING_NOT_FOUND",
      });
    }

    const allowedIds = [
      listing.uploaded_by_id,
      listing.agent_unique_id,
      listing.created_by,
      listing.assigned_agent_id,
      listing.agency_id,
      listing.brokerage_id,
    ]
      .filter(Boolean)
      .map((value) => String(value));

    const canActivate =
      allowedIds.includes(String(userId)) ||
      role === "admin" ||
      role === "super_admin";

    if (!canActivate) {
      return res.status(403).json({
        success: false,
        message: "You can only activate listings you own or manage.",
        code: "FORBIDDEN",
      });
    }

    const status = String(listing.status || "").toLowerCase();
    if (!["approved", "live", "published"].includes(status)) {
      return res.status(409).json({
        success: false,
        message: "This listing must be approved before it can go live.",
        code: "LISTING_NOT_APPROVED",
      });
    }

    const result = await pool.query(
      `
      UPDATE listings
      SET is_active=true,
          payment_status=CASE
            WHEN payment_status IN ('paid', 'completed') THEN payment_status
            ELSE 'not_required'
          END,
          activated_at=NOW()
      WHERE product_id=$1
      RETURNING *;
      `,

      [product_id],

    );


    res.json({
      success: true,
      message: "Listing activated and ready for buyers.",
      listing: result.rows[0],
    });
  } catch (err) {
    console.error("Activate error:", err);

    res.status(500).json({ message: "Failed to activate listing" });

  }
};

export const pauseListing = async (req, res) => {
  try {
    const { product_id } = req.params;
    const userId = req.user?.unique_id;
    const role = String(req.user?.role || "").toLowerCase();

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized.",
        code: "UNAUTHORIZED",
      });
    }

    const existing = await pool.query(
      `SELECT * FROM listings WHERE product_id=$1 LIMIT 1`,
      [product_id],
    );
    const listing = existing.rows[0];

    if (!listing) {
      return res.status(404).json({
        success: false,
        message: "Listing not found.",
        code: "LISTING_NOT_FOUND",
      });
    }

    const allowedIds = [
      listing.uploaded_by_id,
      listing.agent_unique_id,
      listing.created_by,
      listing.assigned_agent_id,
      listing.agency_id,
      listing.brokerage_id,
    ]
      .filter(Boolean)
      .map((value) => String(value));

    const canPause =
      allowedIds.includes(String(userId)) ||
      role === "admin" ||
      role === "super_admin" ||
      role === "superadmin";

    if (!canPause) {
      return res.status(403).json({
        success: false,
        message: "You can only pause listings you own or manage.",
        code: "FORBIDDEN",
      });
    }

    const result = await pool.query(
      `
      UPDATE listings
      SET is_active=false,
          updated_at=NOW()
      WHERE product_id=$1
      RETURNING *;
      `,
      [product_id],
    );

    res.json({
      success: true,
      message: "Listing paused. It will not show as live until you reactivate it.",
      listing: result.rows[0],
    });
  } catch (err) {
    console.error("Pause listing error:", err);
    res.status(500).json({ message: "Failed to pause listing" });
  }
};

/* -------------------------------------------------------
   GET ALL LISTINGS - ADMIN
   Admin-safe full listing payload:

   - Shows all listings: pending, approved, live, rejected, draft

   - Pulls profile image/name from profiles first, then users

   - Supports solo agents, agency agents, owners, brokerages

   - Does NOT depend on profiles.agency_name

   - Includes optional fields and draft_data fallback

   - Includes legal/title document metadata for admins

   - Returns array directly for current admin UI compatibility

------------------------------------------------------- */

export const getAllListingsAdmin = async (req, res) => {

  try {

    const parseAnyJson = (value, fallback = null) => {

      if (value === undefined || value === null || value === "")

        return fallback;

      if (Array.isArray(value)) return value;

      if (typeof value === "object") return value;



      try {

        return JSON.parse(value);

      } catch {

        return fallback;

      }

    };



    const pick = (...values) => {

      for (const value of values) {

        if (value !== undefined && value !== null && value !== "") {

          return value;

        }

      }



      return null;

    };



    const toBool = (value) => {

      return value === true || value === "true";

    };



    const getRoleLabel = (role, isSoloAgent) => {

      const r = String(role || "").toLowerCase();



      if (r === "agent") {

        return isSoloAgent === false ? "Agency Agent" : "Solo Agent";

      }



      if (r === "agency_agent") return "Agency Agent";

      if (r === "brokerage_agent") return "Brokerage Agent";

      if (r === "brokerage" || r === "brokerage_owner") return "Brokerage";

      if (r === "owner" || r === "landlord") return "Owner / Landlord";

      if (r === "admin" || r === "super_admin") return "Admin";



      return role || "User";

    };



    const result = await pool.query(

      `

      SELECT

        l.*,



        u.unique_id AS uploader_unique_id,

        u.name AS user_name,

        u.username AS user_username,

        u.email AS user_email,

        u.phone AS user_phone,

        u.role AS user_role,

        u.avatar_url AS user_avatar_url,

        u.bio AS user_bio,

        u.country AS user_country,

        u.city AS user_city,

        u.brokerage_name AS user_brokerage_name,

        u.is_solo_agent AS user_is_solo_agent,

        u.verification_status AS user_verification_status,

        u.is_verified AS user_is_verified,

        u.is_verified_agent AS user_is_verified_agent,

        u.subscription_plan AS user_subscription_plan,

        u.subscription_status AS user_subscription_status,



        p.full_name AS profile_full_name,

        p.username AS profile_username,

        p.avatar_url AS profile_avatar_url,

        p.bio AS profile_bio,

        p.email AS profile_email,

        p.phone AS profile_phone,

        p.country AS profile_country,

        p.city AS profile_city,



        ap.experience_years AS agent_experience_years,



        bp.company_name AS brokerage_company_name



      FROM listings l



      LEFT JOIN users u

        ON l.uploaded_by_id::text = u.unique_id::text



      LEFT JOIN profiles p

        ON p.unique_id::text = u.unique_id::text



      LEFT JOIN agent_profiles ap

        ON ap.unique_id::text = u.unique_id::text



      LEFT JOIN brokerage_profiles bp

        ON bp.unique_id::text = u.unique_id::text



      ORDER BY

        CASE

          WHEN l.status = 'pending' THEN 1

          WHEN l.moderation_status = 'pending' THEN 2

          WHEN l.status = 'rejected' THEN 3

          WHEN l.status = 'approved' AND COALESCE(l.is_active, false) = false THEN 4

          WHEN l.status = 'approved' AND COALESCE(l.is_active, false) = true THEN 5

          WHEN l.status = 'draft' THEN 6

          ELSE 7

        END,

        COALESCE(l.updated_at, l.created_at) DESC

      LIMIT $1 OFFSET $2;

      `,

      [Math.min(parseInt(req.query.limit, 10) || 100, 200), Math.max((parseInt(req.query.page, 10) || 1) - 1, 0) * Math.min(parseInt(req.query.limit, 10) || 100, 200)],

    );



    const listings = result.rows.map((row) => {

      const draftData = parseAnyJson(row.draft_data, {}) || {};



      const photos = normalizePhotosForResponse(

        pick(row.photos, draftData.photos, []),

      );



      const floorPlans = parseAnyJson(

        pick(row.floor_plans, draftData.floorPlans, draftData.floor_plans),

        [],

      );



      const stagingPhotos = parseAnyJson(

        pick(

          row.staging_photos,

          draftData.stagingPhotos,

          draftData.staging_photos,

        ),

        [],

      );



      const panoramaPhotos = parseAnyJson(

        pick(

          row.panorama_photos,

          draftData.panoramaPhotos,

          draftData.panorama_photos,

        ),

        [],

      );



      const features = parseAnyJson(

        pick(row.features, draftData.features, draftData.amenities),

        [],

      );



      const amenities = parseAnyJson(

        pick(row.amenities, draftData.amenities, draftData.features),

        [],

      );



      const paymentOptions = parseAnyJson(

        pick(

          row.payment_options,

          draftData.paymentOptions,

          draftData.payment_options,

        ),

        [],

      );



      const preferredTourDays = parseAnyJson(

        pick(

          row.preferred_tour_days,

          draftData.preferredTourDays,

          draftData.preferred_tour_days,

        ),

        [],

      );



      const titleDocumentFile = parseAnyJson(

        pick(

          row.title_document_file,

          draftData.titleDocumentFile,

          draftData.title_document_file,

        ),

        null,

      );



      const virtualTourFile = parseAnyJson(

        pick(

          row.virtual_tour_file,

          draftData.virtualTourFile,

          draftData.virtual_tour_file,

        ),

        null,

      );



      const finalRole = row.user_role;



      const isVerified =

        row.user_is_verified === true ||

        row.user_is_verified_agent === true ||

        ["approved", "verified"].includes(

          String(row.user_verification_status || "").toLowerCase(),

        );



      const agentName = pick(

        row.profile_full_name,

        row.user_name,

        row.contact_name,

        "Keyvia User",

      );



      const agentAvatar = pick(row.profile_avatar_url, row.user_avatar_url);



      const companyName = pick(

        row.brokerage_company_name,

        row.user_brokerage_name,

        draftData.companyName,

        draftData.company_name,

        draftData.agencyName,

        draftData.agency_name,

      );



      const latitude = pick(row.latitude, draftData.latitude);

      const longitude = pick(row.longitude, draftData.longitude);



      return {

        ...row,



        // Parsed payloads

        draft_data: draftData,

        photos,

        floor_plans: Array.isArray(floorPlans) ? floorPlans : [],

        staging_photos: Array.isArray(stagingPhotos) ? stagingPhotos : [],

        panorama_photos: Array.isArray(panoramaPhotos) ? panoramaPhotos : [],

        features,

        amenities,

        payment_options: paymentOptions,

        preferred_tour_days: preferredTourDays,



        // Normalized coordinates

        latitude:

          latitude !== null && latitude !== undefined && latitude !== ""

            ? parseFloat(latitude)

            : null,



        longitude:

          longitude !== null && longitude !== undefined && longitude !== ""

            ? parseFloat(longitude)

            : null,



        // Compatibility / normalized listing fields

        agent_unique_id: pick(row.agent_unique_id, row.uploaded_by_id),

        created_by: pick(row.created_by, row.uploaded_by_id),

        uploaded_by_id: row.uploaded_by_id,



        price_currency: pick(

          row.price_currency,

          row.currency,

          draftData.priceCurrency,

          draftData.price_currency,

          "USD",

        ),



        currency: pick(

          row.currency,

          row.price_currency,

          draftData.priceCurrency,

          draftData.price_currency,

          "USD",

        ),



        price_period: pick(row.price_period, draftData.pricePeriod),



        property_type: pick(row.property_type, draftData.propertyType),

        property_subtype: pick(row.property_subtype, draftData.propertySubtype),

        listing_type: pick(row.listing_type, draftData.listingType),

        category: pick(row.category, row.listing_type, draftData.listingType),



        square_footage: pick(

          row.square_footage,

          row.area_sqft,

          row.building_area_sqft,

          draftData.squareFootage,

          draftData.buildingAreaSqft,

        ),



        area_sqft: pick(

          row.area_sqft,

          row.square_footage,

          row.building_area_sqft,

          draftData.buildingAreaSqft,

        ),



        building_area_sqft: pick(

          row.building_area_sqft,

          row.area_sqft,

          row.square_footage,

          draftData.buildingAreaSqft,

          draftData.building_area_sqft,

        ),



        land_area_sqft: pick(

          row.land_area_sqft,

          row.lot_size,

          draftData.landAreaSqft,

          draftData.land_area_sqft,

        ),



        lot_size: pick(

          row.lot_size,

          row.land_area_sqft,

          draftData.landAreaSqft,

          draftData.lotSize,

        ),



        building_area_unit: pick(

          row.building_area_unit,

          draftData.buildingAreaUnit,

          "sqft",

        ),



        land_area_unit: pick(

          row.land_area_unit,

          draftData.landAreaUnit,

          "sqft",

        ),



        zip_code: pick(row.zip_code, row.postal_code, draftData.zipCode),

        postal_code: pick(row.postal_code, row.zip_code, draftData.zipCode),



        neighborhood: pick(row.neighborhood, draftData.neighborhood),

        estate_name: pick(row.estate_name, draftData.estateName),

        landmark: pick(row.landmark, draftData.landmark),

        road_access: pick(row.road_access, draftData.roadAccess),



        total_rooms: pick(row.total_rooms, draftData.totalRooms),

        floors: pick(row.floors, draftData.floors),

        floor_number: pick(row.floor_number, draftData.floorNumber),

        total_floors: pick(row.total_floors, draftData.totalFloors),

        garage_spaces: pick(row.garage_spaces, draftData.garageSpaces),



        property_condition: pick(

          row.property_condition,

          draftData.propertyCondition,

        ),



        construction_status: pick(

          row.construction_status,

          draftData.constructionStatus,

        ),



        ownership_type: pick(row.ownership_type, draftData.ownershipType),



        power_supply: pick(row.power_supply, draftData.powerSupply),

        water_supply: pick(row.water_supply, draftData.waterSupply),

        internet_available:

          row.internet_available !== null &&

          row.internet_available !== undefined

            ? row.internet_available

            : toBool(draftData.internetAvailable),



        drainage: pick(row.drainage, draftData.drainage),

        security_type: pick(row.security_type, draftData.securityType),



        generator_available:

          row.generator_available !== null &&

          row.generator_available !== undefined

            ? row.generator_available

            : toBool(draftData.generatorAvailable),



        borehole:

          row.borehole !== null && row.borehole !== undefined

            ? row.borehole

            : toBool(draftData.borehole),



        prepaid_meter:

          row.prepaid_meter !== null && row.prepaid_meter !== undefined

            ? row.prepaid_meter

            : toBool(draftData.prepaidMeter),



        waste_disposal: pick(row.waste_disposal, draftData.wasteDisposal),



        service_charge: pick(row.service_charge, draftData.serviceCharge),

        caution_fee: pick(row.caution_fee, draftData.cautionFee),

        agency_fee: pick(row.agency_fee, draftData.agencyFee),

        legal_fee: pick(row.legal_fee, draftData.legalFee),

        refundable_deposit: pick(

          row.refundable_deposit,

          draftData.refundableDeposit,

        ),



        minimum_rent_duration: pick(

          row.minimum_rent_duration,

          draftData.minimumRentDuration,

        ),



        rent_payment_frequency: pick(

          row.rent_payment_frequency,

          draftData.rentPaymentFrequency,

        ),



        pets_policy: pick(row.pets_policy, draftData.petsPolicy),

        smoking_policy: pick(row.smoking_policy, draftData.smokingPolicy),

        guest_policy: pick(row.guest_policy, draftData.guestPolicy),



        mortgage_available:

          row.mortgage_available !== null &&

          row.mortgage_available !== undefined

            ? row.mortgage_available

            : toBool(draftData.mortgageAvailable),



        installment_available:

          row.installment_available !== null &&

          row.installment_available !== undefined

            ? row.installment_available

            : toBool(draftData.installmentAvailable),



        rent_to_own_available:

          row.rent_to_own_available !== null &&

          row.rent_to_own_available !== undefined

            ? row.rent_to_own_available

            : toBool(draftData.rentToOwnAvailable),



        estimated_monthly_payment: pick(

          row.estimated_monthly_payment,

          draftData.estimatedMonthlyPayment,

        ),



        down_payment_percent: pick(

          row.down_payment_percent,

          draftData.downPaymentPercent,

        ),



        interest_rate_estimate: pick(

          row.interest_rate_estimate,

          draftData.interestRateEstimate,

        ),



        hoa_fee: pick(row.hoa_fee, draftData.hoaFee),



        property_tax_estimate: pick(

          row.property_tax_estimate,

          draftData.propertyTaxEstimate,

        ),



        insurance_estimate: pick(

          row.insurance_estimate,

          draftData.insuranceEstimate,

        ),



        price_per_sqft: pick(row.price_per_sqft, draftData.pricePerSqft),



        price_negotiable:

          row.price_negotiable !== null && row.price_negotiable !== undefined

            ? row.price_negotiable

            : toBool(draftData.priceNegotiable),



        closing_cost_estimate: pick(

          row.closing_cost_estimate,

          draftData.closingCostEstimate,

        ),



        title_document_type: pick(

          row.title_document_type,

          draftData.titleDocumentType,

        ),



        title_verified:

          row.title_verified !== null && row.title_verified !== undefined

            ? row.title_verified

            : toBool(draftData.titleVerified),



        survey_available:

          row.survey_available !== null && row.survey_available !== undefined

            ? row.survey_available

            : toBool(draftData.surveyAvailable),



        building_approval_available:

          row.building_approval_available !== null &&

          row.building_approval_available !== undefined

            ? row.building_approval_available

            : toBool(draftData.buildingApprovalAvailable),



        // Admin-only file metadata. This can include public URL if available.

        // For truly private S3 docs, later we should return a signed admin URL here.

        title_document_file: titleDocumentFile,

        virtual_tour_file: virtualTourFile,



        video_url: pick(row.video_url, draftData.video?.url),

        video_public_id: pick(

          row.video_public_id,

          draftData.video?.key,

          draftData.video?.public_id,

        ),



        virtual_tour_url: pick(

          row.virtual_tour_url,

          draftData.virtualTourUrl,

          draftData.virtual_tour_url,

          draftData.virtualTourFile?.url,

          draftData.virtual_tour_file?.url,

        ),



        virtual_tour_public_id: pick(

          row.virtual_tour_public_id,

          draftData.virtualTourFile?.key,

          draftData.virtual_tour_file?.key,

        ),



        three_d_home_url: pick(row.three_d_home_url, draftData.threeDHomeUrl),



        allow_tour_requests:

          row.allow_tour_requests !== null &&

          row.allow_tour_requests !== undefined

            ? row.allow_tour_requests

            : draftData.allowTourRequests !== false,



        allow_video_tour:

          row.allow_video_tour !== null && row.allow_video_tour !== undefined

            ? row.allow_video_tour

            : draftData.allowVideoTour !== false,



        allow_in_person_tour:

          row.allow_in_person_tour !== null &&

          row.allow_in_person_tour !== undefined

            ? row.allow_in_person_tour

            : draftData.allowInPersonTour !== false,



        preferred_tour_times: pick(

          row.preferred_tour_times,

          draftData.preferredTourTimes,

        ),



        minimum_notice_hours: pick(

          row.minimum_notice_hours,

          draftData.minimumNoticeHours,

        ),



        contact_name: pick(row.contact_name, draftData.contactName, agentName),

        contact_email: pick(

          row.contact_email,

          draftData.contactEmail,

          row.user_email,

        ),

        contact_phone: pick(row.contact_phone, draftData.contactPhone),

        contact_method: pick(row.contact_method, draftData.contactMethod),



        show_contact_phone:

          row.show_contact_phone !== null &&

          row.show_contact_phone !== undefined

            ? row.show_contact_phone

            : toBool(draftData.showContactPhone),



        availability_status: pick(

          row.availability_status,

          draftData.availabilityStatus,

          "available_now",

        ),



        available_from: pick(row.available_from, draftData.availableFrom),



        payment_status: pick(row.payment_status, "unpaid"),



        agent_role: finalRole,

        role: finalRole,



        agent: {

          unique_id: pick(row.uploader_unique_id, row.uploaded_by_id),

          name: agentName,

          full_name: agentName,

          username: pick(row.profile_username, row.user_username),

          avatar_url: agentAvatar,

          avatar: agentAvatar,

          email: pick(row.profile_email, row.user_email),

          phone: pick(row.profile_phone, row.user_phone),

          bio: pick(row.profile_bio, row.user_bio),

          country: pick(row.profile_country, row.user_country),

          city: pick(row.profile_city, row.user_city),

          role: finalRole,

          role_label: getRoleLabel(finalRole, row.user_is_solo_agent),

          is_solo_agent: row.user_is_solo_agent,

          company_name: companyName,

          brokerage_name: ["brokerage", "brokerage_owner"].includes(

            String(finalRole || "").toLowerCase(),

          )

            ? companyName

            : null,

          agency_name:

            String(finalRole || "").toLowerCase() === "agent" &&

            row.user_is_solo_agent === false

              ? companyName

              : null,

          experience_years: row.agent_experience_years || null,

          verification_status: row.user_verification_status || null,

          is_verified: isVerified,

          is_verified_agent: row.user_is_verified_agent === true,

          subscription_plan: row.user_subscription_plan || null,

          subscription_status: row.user_subscription_status || null,

        },

      };

    });



    return res.json(listings);

  } catch (err) {

    console.error("[GetAllListingsAdmin] Error:", err);



    return res.status(500).json({

      success: false,

      message: "Failed to fetch admin listings.",

      code: "ADMIN_LISTINGS_FETCH_FAILED",

      details: err?.message,

    });

  }

};



/* -------------------------------------------------------

   GET PUBLIC PROFILE

   Route: GET /api/listings/public/agent/:unique_id

   Safe public profile for agents, owners, brokerages, and buyers.

   Does NOT expose license number, legal docs, team code, linked agency ID,

   registration number, private email, or private phone.

------------------------------------------------------- */

export const getPublicAgentProfile = async (req, res) => {

  try {

    const payload = await resolvePublicProfilePayload({
      identifier: req.params.unique_id,
      viewer: req.user || null,
    });


    return res.json(payload);

  } catch (err) {

    const status = err.statusCode || 500;



    if (status >= 500) {

      console.error("[GetPublicProfile] Error:", err);

    }



    return res.status(status).json({

      success: false,

      message:

        status === 500

          ? "Failed to fetch public profile."

          : err.message || "Profile not found.",

    });

  }

};



/* -------------------------------------------------------

   SINGLE AI ANALYSIS

------------------------------------------------------- */

export const analyzeListing = async (req, res) => {

  try {

    const { product_id } = req.params;

    console.log(`🤖 Admin requested AI Analysis for: ${product_id}...`);



    const report = await performFullAnalysis(product_id);

    res.json(report);

  } catch (err) {

    console.error("Single Analysis Error:", err);

    res.status(500).json({ message: "AI Analysis failed", error: err.message });

  }

};



/* -------------------------------------------------------

   BATCH AI ANALYSIS - LISTINGS

   Route: POST /api/listings/admin/analyze-all



   Scans all pending listings and applies verdicts:

   - Safe to Approve / Auto-Approve / approved => approved + live

   - Rejected / Auto-Reject => rejected

   - Needs Review / warning => stays pending with admin_notes

------------------------------------------------------- */

export const batchAnalyzeListings = async (req, res) => {

  try {

    console.log("🚀 Starting listing batch AI analysis...");



    const pendingQ = await pool.query(

      `

      SELECT

        product_id,

        uploaded_by_id,

        agent_unique_id,

        created_by,

        title,

        status,

        is_active

      FROM listings

      WHERE status = 'pending'

      OR moderation_status = 'pending'

      ORDER BY created_at ASC

      LIMIT 100;

      `,

    );



    const pendingListings = pendingQ.rows;



    if (!pendingListings.length) {

      return res.json({

        success: true,

        message: "No pending listings to analyze.",

        approved: 0,

        rejected: 0,

        remaining: 0,

        failed: 0,

        results: [],

      });

    }



    let approved = 0;

    let rejected = 0;

    let remaining = 0;

    let failed = 0;



    const results = [];



    const aiSettings = await getAiSettings();



    for (const listing of pendingListings) {

      try {

        const report = await performFullAnalysis(listing.product_id);



        const score = Number(report?.score || 0);

        const verdict = String(report?.verdict || "").toLowerCase();

        const flags = Array.isArray(report?.flags) ? report.flags : [];



        const reason =

          flags.length > 0

            ? flags.join(" | ")

            : report?.reason ||

              report?.message ||

              report?.verdict ||

              "AI analysis completed.";



        let newStatus = "pending";

        let moderationStatus = "pending";

        let isActive = false;



        const safeVerdicts = [

          "safe to approve",

          "approved",

          "auto-approve",

          "auto approved",

          "safe",

          "pass",

          "passed",

        ];



        const rejectVerdicts = [

          "rejected",

          "auto-reject",

          "auto rejected",

          "reject",

          "failed",

          "unsafe",

        ];



        const shouldAutoApprove = aiSettings.ai_auto_approve_low_risk !== false;

        const shouldAutoReject = aiSettings.ai_auto_reject_high_risk !== false;

        const requireManualReview = aiSettings.ai_require_manual_review_medium_risk !== false;



        if (

          (safeVerdicts.includes(verdict) || score >= 80) &&

          shouldAutoApprove

        ) {

          newStatus = "approved";

          moderationStatus = "approved";

          isActive = true;

          approved += 1;

        } else if (

          (rejectVerdicts.includes(verdict) || score <= 35) &&

          shouldAutoReject

        ) {

          newStatus = "rejected";

          moderationStatus = "rejected";

          isActive = false;

          rejected += 1;

        } else if (requireManualReview) {

          newStatus = "pending";

          moderationStatus = "pending";

          isActive = false;

          remaining += 1;

        } else if (safeVerdicts.includes(verdict) || score >= 80) {

          newStatus = "approved";

          moderationStatus = "approved";

          isActive = true;

          approved += 1;

        } else {

          newStatus = "pending";

          moderationStatus = "pending";

          isActive = false;

          remaining += 1;

        }



        const updateQ = await pool.query(

          `

          UPDATE listings

          SET

            status = $1,

            moderation_status = $2,

            is_active = $3,

            risk_score = COALESCE($4, risk_score),

            listing_score = COALESCE($5, listing_score),

            risk_level = CASE

              WHEN $4 IS NOT NULL AND $4 >= 60 THEN 'high'

              WHEN $4 IS NOT NULL AND $4 >= 25 THEN 'medium'

              WHEN $4 IS NOT NULL THEN 'low'

              ELSE risk_level

            END,

            risk_flags = COALESCE($10::jsonb, risk_flags),

            moderation_reason = $6,

            admin_notes = $7,

            reviewed_by = $8::uuid,

            reviewed_at = NOW(),

            updated_at = NOW(),

            activated_at = CASE

              WHEN $1 = 'approved' AND $3 = true

              THEN COALESCE(activated_at, NOW())

              ELSE activated_at

            END

          WHERE product_id = $9

          RETURNING *;

          `,

          [

            newStatus,

            moderationStatus,

            isActive,

            Number.isFinite(score) ? Math.max(0, 100 - score) : null,

            Number.isFinite(score) ? score : null,

            reason,

            `AI Listing Review: ${reason}`,

            req.user?.unique_id || null,

            listing.product_id,

            JSON.stringify(flags.length > 0 ? flags : []),

          ],

        );



        const updatedListing = updateQ.rows[0];



        const receiverId =

          listing.uploaded_by_id ||

          listing.agent_unique_id ||

          listing.created_by;



        if (receiverId) {

          let notificationTitle = "Listing Review Update";

          let notificationMsg = `Your listing "${listing.title}" was reviewed.`;



          if (newStatus === "approved") {

            notificationTitle = "Listing Approved";

            notificationMsg = `Your listing "${listing.title}" passed review and is now live.`;

          } else if (newStatus === "rejected") {

            notificationTitle = "Listing Rejected";

            notificationMsg = `Your listing "${listing.title}" was rejected. Reason: ${reason}`;

          } else {

            notificationTitle = "Listing Needs Manual Review";

            notificationMsg = `Your listing "${listing.title}" still needs manual review. Reason: ${reason}`;

          }



          try {

            await pool.query(

              `

              INSERT INTO notifications (

                receiver_id,

                product_id,

                type,

                title,

                message,

                created_at

              )

              VALUES ($1::uuid, $2, 'listing_status', $3, $4, NOW())

              `,

              [

                String(receiverId),

                listing.product_id,

                notificationTitle,

                notificationMsg,

              ],

            );

          } catch (notifyErr) {

            console.warn(

              "[BatchAnalyzeListings] Notification failed:",

              notifyErr?.message,

            );

          }



          if (req.io) {

            req.io.to(String(receiverId)).emit("listingStatusUpdated", {

              product_id: listing.product_id,

              status: newStatus,

              is_active: isActive,

            });

          }

        }



        results.push({

          product_id: listing.product_id,

          title: listing.title,

          status: newStatus,

          moderation_status: moderationStatus,

          is_active: isActive,

          score,

          verdict: report?.verdict || null,

          reason,

          listing: updatedListing,

        });



        console.log(`✅ ${listing.product_id}: ${newStatus}`);

      } catch (itemErr) {

        failed += 1;



        console.error(

          `❌ AI failed for listing ${listing.product_id}:`,

          itemErr?.message,

        );



        results.push({

          product_id: listing.product_id,

          title: listing.title,

          status: "failed",

          error: itemErr?.message,

        });

      }

    }



    return res.json({

      success: true,

      message: `AI scan completed. Approved: ${approved}, Rejected: ${rejected}, Remaining: ${remaining}, Failed: ${failed}.`,

      approved,

      rejected,

      remaining,

      failed,

      total: pendingListings.length,

      results,

    });

  } catch (err) {

    console.error("[BatchAnalyzeListings] Error:", err);



    return res.status(500).json({

      success: false,

      message: "Listing batch AI analysis failed.",

      details: err?.message,

    });

  }

};



export const createListingDraft = async (req, res) => {

  try {

    const userId = req.user?.unique_id;



    if (!userId) {

      return res.status(401).json({

        message: "Unauthorized",

        code: "UNAUTHORIZED",

      });

    }



    const b = req.body;
    if (b.listing_type) b.listing_type = normalizeListingType(b.listing_type);



    if (!b.title || !b.listing_type || !b.property_type || !b.price) {

      return res.status(400).json({

        message: "Complete the listing basics before saving draft.",

        code: "DRAFT_BASICS_REQUIRED",

      });

    }



    const product_id = await generateUniqueProductId();



    const price = toNumberOrNull(b.price);



    if (!price || price <= 0) {

      return res.status(400).json({

        message: "Invalid listing price.",

        code: "INVALID_PRICE",

      });

    }



    const userRes = await pool.query(

      `

      SELECT role, linked_agency_id, is_solo_agent

      FROM users

      WHERE unique_id = $1::uuid

      LIMIT 1

      `,

      [String(userId)],

    );

    const currentUser = userRes.rows[0] || {};

    const role = String(currentUser.role || req.user?.role || "").toLowerCase();

    const isBrokerageCreator = ["brokerage", "brokerage_owner"].includes(role);

    const isAgencyAgentCreator =

      role === "agent" &&

      (currentUser.is_solo_agent === false || currentUser.linked_agency_id);

    const listingAgencyId =

      b.agency_id ||

      b.agencyId ||

      (isBrokerageCreator

        ? String(userId)

        : isAgencyAgentCreator

          ? currentUser.linked_agency_id

          : null);



    const result = await pool.query(

      `

      INSERT INTO listings (

        product_id,

        draft_listing_id,

        uploaded_by_id,

        created_by,

        agent_unique_id,

        agency_id,

        project_id,



        title,

        property_type,

        property_subtype,

        listing_type,

        category,



        price,

        currency,

        price_currency,

        price_period,



        country,

        state,

        city,

        floor_plans,

        nightly_rate,
        min_stay,
        max_stay,
        cleaning_fee,
        lease_deposit,
        lease_term_months,
        lease_type,


        status,

        moderation_status,

        is_active,

        payment_status,

        current_step,

        draft_data,

        autosaved_at,

        last_updated_at,

        created_at,

        updated_at

      )

      VALUES (

        $1,

        $1,

        $2::uuid,

        $2::uuid,

        $2::uuid,

        $15::uuid,

        $17::bigint,



        $3,

        $4,

        $5,

        $6,

        $6,



        $7,

        $8,

        $8,

        $9,



        $10,

        $11,

        $12,

$16::jsonb,

        $18::numeric,

        $19::integer,

        $20::integer,

        $21::numeric,

        $22::numeric,

        $23::integer,

        $24,



        'draft',

        'draft',

        false,

        'unpaid',

        $13,

        $14::jsonb,

        NOW(),

        NOW(),

        NOW(),

        NOW()

      )

      RETURNING *;

      `,

      [

        product_id,

        String(userId),



        b.title,

        b.property_type || b.propertyType,

        b.property_subtype || b.propertySubtype || null,

        b.listing_type || b.listingType,



        price,

        b.currency || b.price_currency || b.priceCurrency || "USD",

        b.price_period || b.pricePeriod || null,



        b.country || null,

        b.state || null,

        b.city || null,



        b.current_step || "location",

        JSON.stringify(b.draft_data || b),

        listingAgencyId,

        JSON.stringify(b.floor_plans || b.floorPlans || []),

        b.project_id ? Number(b.project_id) : null,

      ],

    );



    return res.status(201).json({

      success: true,

      message: "Draft created.",

      listing: result.rows[0],

    });

  } catch (err) {

    console.error("[CreateListingDraft] Error:", err);



    return res.status(500).json({

      message: "Failed to create listing draft.",

      code: "CREATE_DRAFT_FAIL",

      details: err?.message,

    });

  }

};



export const updateListingDraft = async (req, res) => {

  try {

    const userId = req.user?.unique_id;

    const { product_id } = req.params;



    if (!userId) {

      return res.status(401).json({

        message: "Unauthorized",

        code: "UNAUTHORIZED",

      });

    }



    const existing = await pool.query(

      `

      SELECT product_id

      FROM listings

      WHERE product_id = $1

      AND uploaded_by_id = $2::uuid

      AND status = 'draft'

      LIMIT 1;

      `,

      [product_id, String(userId)],

    );



    if (!existing.rows[0]) {

      return res.status(404).json({

        message: "Draft not found.",

        code: "DRAFT_NOT_FOUND",

      });

    }



    const b = req.body;
    if (b.listing_type) b.listing_type = normalizeListingType(b.listing_type);



    const result = await pool.query(

      `

      UPDATE listings

      SET

        title = COALESCE($1, title),

        description = COALESCE($2, description),



        property_type = COALESCE($3, property_type),

        property_subtype = COALESCE($4, property_subtype),

        listing_type = COALESCE($5, listing_type),

        category = COALESCE($5, category),



        price = COALESCE($6, price),

        currency = COALESCE($7, currency),

        price_currency = COALESCE($7, price_currency),

        price_period = COALESCE($8, price_period),



        address = COALESCE($9, address),

        city = COALESCE($10, city),

        state = COALESCE($11, state),

        country = COALESCE($12, country),

        zip_code = COALESCE($13, zip_code),

        postal_code = COALESCE($13, postal_code),

        latitude = COALESCE($14, latitude),

        longitude = COALESCE($15, longitude),



        bedrooms = COALESCE($16, bedrooms),

        bathrooms = COALESCE($17, bathrooms),

        total_rooms = COALESCE($18, total_rooms),

        year_built = COALESCE($19, year_built),

        property_condition = COALESCE($20, property_condition),

        construction_status = COALESCE($21, construction_status),

        ownership_type = COALESCE($22, ownership_type),



        project_id = COALESCE($28::bigint, project_id),



        draft_data = $23::jsonb,

        current_step = COALESCE($24, current_step),

        floor_plans = COALESCE($25::jsonb, floor_plans),

        autosaved_at = NOW(),

        last_updated_at = NOW(),

        updated_at = NOW()

      WHERE product_id = $26

      AND uploaded_by_id = $27::uuid

      AND status = 'draft'

      RETURNING *;

      `,

      [

        b.title || null,

        b.description || null,



        b.property_type || b.propertyType || null,

        b.property_subtype || b.propertySubtype || null,

        b.listing_type || b.listingType || null,



        b.price ? Number(b.price) : null,

        b.currency || b.price_currency || b.priceCurrency || null,

        b.price_period || b.pricePeriod || null,



        b.address || null,

        b.city || null,

        b.state || null,

        b.country || null,

        b.zip_code || b.zipCode || b.postal_code || null,

        b.latitude ? Number(b.latitude) : null,

        b.longitude ? Number(b.longitude) : null,



        b.bedrooms ? Number(b.bedrooms) : null,

        b.bathrooms ? Number(b.bathrooms) : null,

        b.total_rooms ? Number(b.total_rooms) : null,

        b.year_built ? Number(b.year_built) : null,

        b.property_condition || null,

        b.construction_status || null,

        b.ownership_type || null,



        JSON.stringify(b.draft_data || b),

        b.current_step || null,

        b.floor_plans || b.floorPlans

          ? JSON.stringify(b.floor_plans || b.floorPlans)

          : null,



        product_id,

        String(userId),

        b.project_id ? Number(b.project_id) : null,

      ],

    );



    return res.json({

      success: true,

      message: "Draft saved.",

      listing: result.rows[0],

    });

  } catch (err) {

    console.error("[UpdateListingDraft] Error:", err);



    return res.status(500).json({

      message: "Failed to save draft.",

      code: "UPDATE_DRAFT_FAIL",

      details: err?.message,

    });

  }

};



export const getMyListingDrafts = async (req, res) => {

  try {

    const userId = req.user?.unique_id;



    if (!userId) {

      return res.status(401).json({

        message: "Unauthorized",

        code: "UNAUTHORIZED",

      });

    }



    const result = await pool.query(

      `

      SELECT

        product_id,

        title,

        property_type,

        property_subtype,

        listing_type,

        price,

        price_currency,

        city,

        state,

        country,

        current_step,

        draft_data,

        photos,

        floor_plans,

        autosaved_at,

        updated_at,

        created_at

      FROM listings

      WHERE uploaded_by_id = $1::uuid

      AND status = 'draft'

      ORDER BY updated_at DESC;

      `,

      [String(userId)],

    );



    return res.json({

      success: true,

      drafts: result.rows,

    });

  } catch (err) {

    console.error("[GetMyListingDrafts] Error:", err);



    return res.status(500).json({

      message: "Failed to fetch drafts.",

      code: "GET_DRAFTS_FAIL",

      details: err?.message,

    });

  }

};



export const getListingDraftByProductId = async (req, res) => {

  try {

    const userId = req.user?.unique_id;

    const { product_id } = req.params;



    if (!userId) {

      return res.status(401).json({

        message: "Unauthorized",

        code: "UNAUTHORIZED",

      });

    }



    const result = await pool.query(

      `

      SELECT *

      FROM listings

      WHERE product_id = $1

      AND uploaded_by_id = $2::uuid

      AND status = 'draft'

      LIMIT 1;

      `,

      [product_id, String(userId)],

    );



    if (!result.rows[0]) {

      return res.status(404).json({

        message: "Draft not found.",

        code: "DRAFT_NOT_FOUND",

      });

    }



    return res.json({

      success: true,

      draft: result.rows[0],

    });

  } catch (err) {

    console.error("[GetListingDraftByProductId] Error:", err);



    return res.status(500).json({

      message: "Failed to fetch draft.",

      code: "GET_DRAFT_FAIL",

      details: err?.message,

    });

  }

};



/* -------------------------------------------------------

   SUBMIT LISTING DRAFT

   Flow:

   - Save final form/media payload into listing row

   - Evaluate risk

   - Verified + low-risk listing => approved + active immediately

   - Risky listing => pending review

------------------------------------------------------- */

export const submitListingDraft = async (req, res) => {

  try {

    const userId = req.user?.unique_id;

    const { product_id } = req.params;

    const b = req.body || {};
    if (b.listing_type) b.listing_type = normalizeListingType(b.listing_type);



    if (!userId) {

      return res.status(401).json({

        success: false,

        message: "Unauthorized.",

        code: "UNAUTHORIZED",

      });

    }



    if (!product_id) {

      return res.status(400).json({

        success: false,

        message: "Missing listing product ID.",

        code: "MISSING_PRODUCT_ID",

      });

    }



    const userRes = await pool.query(

      `

      SELECT

        unique_id,

        email,

        name,

        role,

        verification_status,

        is_verified,

        is_verified_agent,

        is_banned,

        subscription_plan,

        subscription_status

      FROM users

      WHERE unique_id = $1::uuid

      LIMIT 1;

      `,

      [String(userId)],

    );



    const currentUser = userRes.rows[0];



    if (!currentUser) {

      return res.status(401).json({

        success: false,

        message: "User account not found.",

        code: "USER_NOT_FOUND",

      });

    }



    if (currentUser.is_banned) {

      return res.status(403).json({

        success: false,

        message: "Your account is restricted from submitting listings.",

        code: "ACCOUNT_RESTRICTED",

      });

    }



    const limitCheck = await enforceListingLimit({ userId });

    if (!limitCheck.allowed) {

      return res.status(403).json({

        success: false,

        message: limitCheck.message,

        code: "LISTING_LIMIT_REACHED",

        data: { current_count: limitCheck.current_count, max_listings: limitCheck.max_listings },

      });

    }



    const existingRes = await pool.query(

      `

      SELECT *

      FROM listings

      WHERE product_id = $1

      AND uploaded_by_id = $2::uuid

      LIMIT 1;

      `,

      [product_id, String(userId)],

    );



    const existing = existingRes.rows[0];



    if (!existing) {

      return res.status(404).json({

        success: false,

        message: "Draft listing not found.",

        code: "DRAFT_NOT_FOUND",

      });

    }



    if (existing.status !== "draft") {

      return res.status(400).json({

        success: false,

        message: "This listing has already been submitted.",

        code: "ALREADY_SUBMITTED",

        listing: {

          ...existing,

          photos: normalizePhotosForResponse(existing.photos),

        },

      });

    }



    const verificationStatus = String(

      currentUser.verification_status || "",

    ).toLowerCase();



    const userIsVerified =

      currentUser.is_verified === true ||

      currentUser.is_verified_agent === true ||

      verificationStatus === "approved" ||

      verificationStatus === "verified";



    if (!userIsVerified) {

      return res.status(403).json({

        success: false,

        message: "You must complete verification before submitting listings.",

        code: "VERIFICATION_REQUIRED",

      });

    }



    const blockedVerificationStatuses = new Set([

      "rejected",

      "declined",

      "failed",

    ]);



    if (blockedVerificationStatuses.has(verificationStatus)) {

      return res.status(403).json({

        success: false,

        message:

          "Your verification was not approved. Please resolve verification before submitting listings.",

        code: "VERIFICATION_REJECTED",

      });

    }



    const safePhotos = Array.isArray(b.photos)

      ? b.photos

      : safeJsonParse(b.photos, safeJsonParse(existing.photos, []));



    const safeFloorPlans = Array.isArray(b.floor_plans)

      ? b.floor_plans

      : safeJsonParse(b.floor_plans, safeJsonParse(existing.floor_plans, []));



    const safeStagingPhotos = Array.isArray(b.staging_photos)

      ? b.staging_photos

      : safeJsonParse(

          b.staging_photos,

          safeJsonParse(existing.staging_photos, []),

        );



    const safePanoramaPhotos = Array.isArray(b.panorama_photos)

      ? b.panorama_photos

      : safeJsonParse(

          b.panorama_photos,

          safeJsonParse(existing.panorama_photos, []),

        );



    const finalTitle = b.title ?? existing.title;

    const finalDescription = b.description ?? existing.description;

    const finalAddress = b.address ?? existing.address;

    const finalCity = b.city ?? existing.city;

    const finalState = b.state ?? existing.state;

    const finalCountry = b.country ?? existing.country;

    const finalZipCode =

      b.zip_code ?? b.zipCode ?? b.postal_code ?? existing.zip_code;



    const finalPrice = toNumberOrNull(b.price ?? existing.price);

    let finalLatitude = toNumberOrNull(b.latitude ?? existing.latitude);

    let finalLongitude = toNumberOrNull(b.longitude ?? existing.longitude);



    /*

      If coordinates are missing, try one backend geocode before judging risk.

      This keeps typed addresses from always going to review.

    */

    if (

      (finalLatitude === null || finalLongitude === null) &&

      finalAddress &&

      finalCity &&

      finalCountry

    ) {

      try {

        const geo = await processGeolocation(

          finalAddress,

          finalCity,

          finalState,

          finalCountry,

          finalZipCode,

        );



        if (geo?.lat && geo?.lng) {

          finalLatitude = geo.lat;

          finalLongitude = geo.lng;

        }

      } catch (geoErr) {

        console.warn(

          "[SubmitListingDraft] Backend geocode failed:",

          geoErr?.message,

        );

      }

    }



    const featuresArr = normalizeFeatures(b.features ?? existing.features);

    const amenitiesArr = Array.isArray(b.amenities)

      ? b.amenities

      : normalizeFeatures(b.amenities ?? existing.amenities);



    const paymentOptions = Array.isArray(b.payment_options)

      ? b.payment_options

      : safeJsonParse(

          b.payment_options,

          safeJsonParse(existing.payment_options, []),

        );



    const preferredTourDays = Array.isArray(b.preferred_tour_days)

      ? b.preferred_tour_days

      : safeJsonParse(

          b.preferred_tour_days,

          safeJsonParse(existing.preferred_tour_days, []),

        );



    let userHistory = null;

    try {

      const histRes = await pool.query(

        `SELECT

          (SELECT COUNT(*)::int FROM listings WHERE uploaded_by_id = $1::uuid AND status = 'rejected') AS rejected_count,

          (SELECT COUNT(*)::int FROM listings WHERE uploaded_by_id = $1::uuid AND is_flagged = true) AS flagged_count,

          (SELECT COUNT(*)::int FROM safety_reports WHERE reported_user_id = $1::uuid) AS reports_received

        `,

        [String(userId)],

      );

      userHistory = histRes.rows[0] || { rejected_count: 0, flagged_count: 0, reports_received: 0 };

    } catch (histErr) {

      console.warn("[SubmitListingDraft] User history fetch failed:", histErr.message);

      userHistory = { rejected_count: 0, flagged_count: 0, reports_received: 0 };

    }



    const risk = await evaluateListingRisk({

      listing: {

        title: finalTitle,

        address: finalAddress,

        country: finalCountry,

        city: finalCity,

        latitude: finalLatitude,

        longitude: finalLongitude,

        price: finalPrice,

        photos: safePhotos,

        description: finalDescription,

        square_feet: toNumberOrNull(b.square_feet || b.squareFeet || b.building_area_sqft || b.buildingAreaSqft),

        building_area_sqft: toNumberOrNull(b.building_area_sqft || b.buildingAreaSqft),

        property_type: b.property_type || b.propertyType || existing.property_type,

        title_document_file: b.title_document_file || existing.title_document_file,

        show_contact_phone: b.show_contact_phone !== undefined ? b.show_contact_phone : existing.show_contact_phone,

        contact_phone: b.contact_phone || b.contactPhone || existing.contact_phone,

      },

      user: { ...currentUser, unique_id: userId },

      userHistory,

    });



    /*

      Final publishing rule:

      - verified user

      - low risk

      - valid photos

      - valid coordinates

      => live immediately

    */

    const hasPhotos = Array.isArray(safePhotos) && safePhotos.length > 0;



    const hasValidCoordinates =

      finalLatitude !== null &&

      finalLongitude !== null &&

      finalLatitude >= -90 &&

      finalLatitude <= 90 &&

      finalLongitude >= -180 &&

      finalLongitude <= 180;



    const role = String(currentUser.role || "").toLowerCase();

    const isAgencyAgentCreator =

      role === "agent" &&

      (currentUser.is_solo_agent === false || currentUser.linked_agency_id);



    const requiresBrokerageApproval =

      isAgencyAgentCreator || b.approval_status === "pending_brokerage_approval";



    const shouldAutoPublish =

      !requiresBrokerageApproval &&

      userIsVerified &&

      risk.risk_level === "low" &&

      risk.score < 25 &&

      hasPhotos &&

      hasValidCoordinates;



    const finalStatus = requiresBrokerageApproval ? "pending" : shouldAutoPublish ? "approved" : "pending";

    const finalModerationStatus = shouldAutoPublish ? "approved" : "pending";

    const finalIsActive = shouldAutoPublish;

    const finalBrokerageReviewStatus = requiresBrokerageApproval ? "pending" : "not_required";



    const moderationReason = risk.flags?.length

      ? risk.flags.join(" | ")

      : shouldAutoPublish

        ? "Auto-approved: verified user and low-risk listing."

        : "Submitted for admin review.";



    const updateRes = await pool.query(

      `

      UPDATE listings

      SET

        title = COALESCE($1, title),

        description = COALESCE($2, description),



        listing_type = COALESCE($3, listing_type),

        property_type = COALESCE($4, property_type),

        property_subtype = COALESCE($5, property_subtype),



        price = COALESCE($6, price),

        currency = COALESCE($7, currency),

        price_currency = COALESCE($7, price_currency),

        price_period = COALESCE($8, price_period),



        address = COALESCE($9, address),

        city = COALESCE($10, city),

        state = COALESCE($11, state),

        country = COALESCE($12, country),

        zip_code = COALESCE($13, zip_code),

        postal_code = COALESCE($13, postal_code),

        latitude = COALESCE($14, latitude),

        longitude = COALESCE($15, longitude),



        neighborhood = COALESCE($16, neighborhood),

        estate_name = COALESCE($17, estate_name),

        landmark = COALESCE($18, landmark),

        road_access = COALESCE($19, road_access),



        bedrooms = COALESCE($20, bedrooms),

        bathrooms = COALESCE($21, bathrooms),

        total_rooms = COALESCE($22, total_rooms),

        floors = COALESCE($23, floors),

        floor_number = COALESCE($24, floor_number),

        total_floors = COALESCE($25, total_floors),

        garage_spaces = COALESCE($26, garage_spaces),

        year_built = COALESCE($27, year_built),

        parking = COALESCE($28, parking),



        building_area_sqft = COALESCE($29, building_area_sqft),

        land_area_sqft = COALESCE($30, land_area_sqft),

        building_area_unit = COALESCE($31, building_area_unit),

        land_area_unit = COALESCE($32, land_area_unit),



        furnishing = COALESCE($33, furnishing),

        property_condition = COALESCE($34, property_condition),

        construction_status = COALESCE($35, construction_status),

        ownership_type = COALESCE($36, ownership_type),



        power_supply = COALESCE($37, power_supply),

        water_supply = COALESCE($38, water_supply),

        internet_available = COALESCE($39, internet_available),

        drainage = COALESCE($40, drainage),

        security_type = COALESCE($41, security_type),

        generator_available = COALESCE($42, generator_available),

        borehole = COALESCE($43, borehole),

        prepaid_meter = COALESCE($44, prepaid_meter),

        waste_disposal = COALESCE($45, waste_disposal),



        caution_fee = COALESCE($46, caution_fee),

        agency_fee = COALESCE($47, agency_fee),

        legal_fee = COALESCE($48, legal_fee),

        service_charge = COALESCE($49, service_charge),

        refundable_deposit = COALESCE($50, refundable_deposit),

        minimum_rent_duration = COALESCE($51, minimum_rent_duration),

        rent_payment_frequency = COALESCE($52, rent_payment_frequency),

        pets_policy = COALESCE($53, pets_policy),

        smoking_policy = COALESCE($54, smoking_policy),

        guest_policy = COALESCE($55, guest_policy),



        mortgage_available = COALESCE($56, mortgage_available),

        installment_available = COALESCE($57, installment_available),

        rent_to_own_available = COALESCE($58, rent_to_own_available),

        estimated_monthly_payment = COALESCE($59, estimated_monthly_payment),

        down_payment_percent = COALESCE($60, down_payment_percent),

        interest_rate_estimate = COALESCE($61, interest_rate_estimate),

        hoa_fee = COALESCE($62, hoa_fee),

        property_tax_estimate = COALESCE($63, property_tax_estimate),

        insurance_estimate = COALESCE($64, insurance_estimate),

        price_per_sqft = COALESCE($65, price_per_sqft),

        price_negotiable = COALESCE($66, price_negotiable),

        closing_cost_estimate = COALESCE($67, closing_cost_estimate)

        nightly_rate = COALESCE($68, nightly_rate),
        min_stay = COALESCE($69, min_stay),
        max_stay = COALESCE($70, max_stay),
        cleaning_fee = COALESCE($71, cleaning_fee),
        lease_deposit = COALESCE($72, lease_deposit),
        lease_term_months = COALESCE($73, lease_term_months),
        lease_type = COALESCE($74, lease_type),



        title_document_type = COALESCE($75, title_document_type),

        title_verified = COALESCE($76, title_verified),

        survey_available = COALESCE($77, survey_available),

        building_approval_available = COALESCE($78, building_approval_available),



        photos = $79::jsonb,

        floor_plans = $80::jsonb,

        staging_photos = $81::jsonb,

        panorama_photos = $82::jsonb,



        video_url = COALESCE($76, video_url),

        video_public_id = COALESCE($77, video_public_id),

        virtual_tour_url = COALESCE($78, virtual_tour_url),

        virtual_tour_public_id = COALESCE($79, virtual_tour_public_id),

        virtual_tour_file = COALESCE($80::jsonb, virtual_tour_file),

        three_d_home_url = COALESCE($81, three_d_home_url),

        title_document_file = COALESCE($82::jsonb, title_document_file),



        features = $83::jsonb,

        amenities = $84::jsonb,

        payment_options = $85::jsonb,

        preferred_tour_days = $86::jsonb,



        allow_tour_requests = COALESCE($87, allow_tour_requests),

        allow_video_tour = COALESCE($88, allow_video_tour),

        allow_in_person_tour = COALESCE($89, allow_in_person_tour),

        preferred_tour_times = COALESCE($90, preferred_tour_times),

        minimum_notice_hours = COALESCE($91, minimum_notice_hours),



        contact_name = COALESCE($92, contact_name),

        contact_email = COALESCE($93, contact_email),

        contact_phone = COALESCE($94, contact_phone),

        contact_method = COALESCE($95, contact_method),

        show_contact_phone = COALESCE($96, show_contact_phone),



        availability_status = COALESCE($97, availability_status),

        available_from = COALESCE($98, available_from),



        risk_score = $99,

        listing_score = $100,

        risk_level = $101,

        moderation_status = $102,

        moderation_reason = $103,

        risk_flags = $110::jsonb,

        admin_notes = NULL,

        brokerage_review_status = $109,



        project_id = COALESCE($108::bigint, project_id),



        status = $104,

        is_active = $105,

        listed_at = COALESCE(listed_at, NOW()),

        last_updated_at = NOW(),

        updated_at = NOW()



      WHERE product_id = $106

      AND uploaded_by_id = $107::uuid

      AND status = 'draft'

      RETURNING *;

      `,

      [

        finalTitle || null,

        finalDescription || null,



        b.listing_type || b.listingType || null,

        b.property_type || b.propertyType || null,

        b.property_subtype || b.propertySubtype || null,



        finalPrice,

        b.currency || b.price_currency || b.priceCurrency || null,

        b.price_period || b.pricePeriod || null,



        finalAddress || null,

        finalCity || null,

        finalState || null,

        finalCountry || null,

        finalZipCode || null,

        finalLatitude,

        finalLongitude,



        b.neighborhood || null,

        b.estate_name || b.estateName || null,

        b.landmark || null,

        b.road_access || b.roadAccess || null,



        toNumberOrNull(b.bedrooms),

        toNumberOrNull(b.bathrooms),

        toNumberOrNull(b.total_rooms || b.totalRooms),

        toNumberOrNull(b.floors),

        toNumberOrNull(b.floor_number || b.floorNumber),

        toNumberOrNull(b.total_floors || b.totalFloors),

        toNumberOrNull(b.garage_spaces || b.garageSpaces),

        toNumberOrNull(b.year_built || b.yearBuilt),

        b.parking || null,



        toNumberOrNull(b.building_area_sqft || b.buildingAreaSqft),

        toNumberOrNull(b.land_area_sqft || b.landAreaSqft),

        b.building_area_unit || b.buildingAreaUnit || null,

        b.land_area_unit || b.landAreaUnit || null,



        b.furnishing || null,

        b.property_condition || b.propertyCondition || null,

        b.construction_status || b.constructionStatus || null,

        b.ownership_type || b.ownershipType || null,



        b.power_supply || b.powerSupply || null,

        b.water_supply || b.waterSupply || null,

        typeof b.internet_available === "boolean"

          ? b.internet_available

          : typeof b.internetAvailable === "boolean"

            ? b.internetAvailable

            : null,

        b.drainage || null,

        b.security_type || b.securityType || null,

        typeof b.generator_available === "boolean"

          ? b.generator_available

          : typeof b.generatorAvailable === "boolean"

            ? b.generatorAvailable

            : null,

        typeof b.borehole === "boolean" ? b.borehole : null,

        typeof b.prepaid_meter === "boolean"

          ? b.prepaid_meter

          : typeof b.prepaidMeter === "boolean"

            ? b.prepaidMeter

            : null,

        b.waste_disposal || b.wasteDisposal || null,



        toNumberOrNull(b.caution_fee || b.cautionFee),

        toNumberOrNull(b.agency_fee || b.agencyFee),

        toNumberOrNull(b.legal_fee || b.legalFee),

        toNumberOrNull(b.service_charge || b.serviceCharge),

        toNumberOrNull(b.refundable_deposit || b.refundableDeposit),

        b.minimum_rent_duration || b.minimumRentDuration || null,

        b.rent_payment_frequency || b.rentPaymentFrequency || null,

        b.pets_policy || b.petsPolicy || null,

        b.smoking_policy || b.smokingPolicy || null,

        b.guest_policy || b.guestPolicy || null,



        typeof b.mortgage_available === "boolean"

          ? b.mortgage_available

          : typeof b.mortgageAvailable === "boolean"

            ? b.mortgageAvailable

            : null,

        typeof b.installment_available === "boolean"

          ? b.installment_available

          : typeof b.installmentAvailable === "boolean"

            ? b.installmentAvailable

            : null,

        typeof b.rent_to_own_available === "boolean"

          ? b.rent_to_own_available

          : typeof b.rentToOwnAvailable === "boolean"

            ? b.rentToOwnAvailable

            : null,



        toNumberOrNull(

          b.estimated_monthly_payment || b.estimatedMonthlyPayment,

        ),

        toNumberOrNull(b.down_payment_percent || b.downPaymentPercent),

        toNumberOrNull(b.interest_rate_estimate || b.interestRateEstimate),

        toNumberOrNull(b.hoa_fee || b.hoaFee),

        toNumberOrNull(b.property_tax_estimate || b.propertyTaxEstimate),

        toNumberOrNull(b.insurance_estimate || b.insuranceEstimate),

        toNumberOrNull(b.price_per_sqft || b.pricePerSqft),

        typeof b.price_negotiable === "boolean"

          ? b.price_negotiable

          : typeof b.priceNegotiable === "boolean"

            ? b.priceNegotiable

            : null,

        toNumberOrNull(b.closing_cost_estimate || b.closingCostEstimate),



        b.title_document_type || b.titleDocumentType || null,

        typeof b.title_verified === "boolean"

          ? b.title_verified

          : typeof b.titleVerified === "boolean"

            ? b.titleVerified

            : null,

        typeof b.survey_available === "boolean"

          ? b.survey_available

          : typeof b.surveyAvailable === "boolean"

            ? b.surveyAvailable

            : null,

        typeof b.building_approval_available === "boolean"

          ? b.building_approval_available

          : typeof b.buildingApprovalAvailable === "boolean"

            ? b.buildingApprovalAvailable

            : null,



        JSON.stringify(safePhotos),

        JSON.stringify(safeFloorPlans),

        JSON.stringify(safeStagingPhotos),

        JSON.stringify(safePanoramaPhotos),



        b.video?.url || b.video_url || existing.video_url || null,

        b.video?.key ||

          b.video?.public_id ||

          b.video_public_id ||

          existing.video_public_id ||

          null,



        b.virtual_tour_file?.url ||

          b.virtual_tour_url ||

          b.virtualTourUrl ||

          existing.virtual_tour_url ||

          null,



        b.virtual_tour_file?.key ||

          b.virtual_tour_file?.public_id ||

          b.virtual_tour_public_id ||

          existing.virtual_tour_public_id ||

          null,



        b.virtual_tour_file ? JSON.stringify(b.virtual_tour_file) : null,



        b.three_d_home_url || b.threeDHomeUrl || null,



        b.title_document_file ? JSON.stringify(b.title_document_file) : null,



        JSON.stringify(featuresArr),

        JSON.stringify(amenitiesArr),

        JSON.stringify(paymentOptions),

        JSON.stringify(preferredTourDays),



        typeof b.allow_tour_requests === "boolean"

          ? b.allow_tour_requests

          : typeof b.allowTourRequests === "boolean"

            ? b.allowTourRequests

            : null,

        typeof b.allow_video_tour === "boolean"

          ? b.allow_video_tour

          : typeof b.allowVideoTour === "boolean"

            ? b.allowVideoTour

            : null,

        typeof b.allow_in_person_tour === "boolean"

          ? b.allow_in_person_tour

          : typeof b.allowInPersonTour === "boolean"

            ? b.allowInPersonTour

            : null,

        b.preferred_tour_times || b.preferredTourTimes || null,

        toNumberOrNull(b.minimum_notice_hours || b.minimumNoticeHours),



        b.contact_name || b.contactName || null,

        b.contact_email || b.contactEmail || null,

        b.contact_phone || b.contactPhone || null,

        b.contact_method || b.contactMethod || null,

        typeof b.show_contact_phone === "boolean"

          ? b.show_contact_phone

          : typeof b.showContactPhone === "boolean"

            ? b.showContactPhone

            : null,



        b.availability_status || b.availabilityStatus || null,

        b.available_from || b.availableFrom || null,



        risk.score,

        Math.max(0, 100 - risk.score),

        risk.risk_level,

        finalModerationStatus,

        moderationReason,



        finalStatus,

        finalIsActive,



        product_id,

        String(userId),

        b.project_id ? Number(b.project_id) : null,

        finalBrokerageReviewStatus,

        JSON.stringify(risk.flags),

      ],

    );



    const listing = updateRes.rows[0];



    if (!listing) {

      return res.status(404).json({

        success: false,

        message: "Draft could not be submitted.",

        code: "SUBMIT_DRAFT_NOT_UPDATED",

      });

    }



    if (existing.brokerage_review_status !== listing.brokerage_review_status) {

      pool.query(

        `

        INSERT INTO brokerage_review_history (listing_id, product_id, old_status, new_status, reviewed_by)

        VALUES ($1, $2, $3, $4, $5)

        `,

        [listing.id, product_id, existing.brokerage_review_status, listing.brokerage_review_status, userId],

      ).catch(() => {});

    }



    pool.query(

      `

      INSERT INTO user_activity_log (user_id, action, resource_type, resource_id, metadata)

      VALUES ($1, $2, $3, $4, $5)

      `,

      [userId, 'submit_listing', 'listing', product_id, JSON.stringify({ requires_brokerage_approval: requiresBrokerageApproval, status: finalStatus })],

    ).catch(() => {});



    if (shouldAutoPublish) {

      await notifyListingStatusUpdate({

        listing,

        status: "approved",

        io: req.io,

      });



      setImmediate(() => {

        notifyNewListing(req.io, listing).catch(() => {});

      });

    } else {

      await notifyListingSubmitted(listing, { io: req.io });

    }

    if (listing.assigned_agent_id) {

      await notifyListingAssigned({

        listing,

        agentId: listing.assigned_agent_id,

        brokerageId: listing.agency_id || userId,

        brokerageName: "Your brokerage",

        io: req.io,

      });

    }



    // Background AI auto-scan if enabled

    if (!shouldAutoPublish && !requiresBrokerageApproval) {

      setImmediate(async () => {

        try {

          const aiSettings = await getAiSettings();

          if (aiSettings.ai_auto_scan_listings) {

            const report = await performFullAnalysis(listing.product_id);

            const score = Number(report?.score || 0);
            const verdict = String(report?.verdict || "").toLowerCase();
            const flags = Array.isArray(report?.flags) ? report.flags : [];

            const safeVerdicts = ["safe to approve", "approved", "auto-approve", "auto approved", "safe", "pass", "passed"];
            const rejectVerdicts = ["rejected", "auto-reject", "auto rejected", "reject", "failed", "unsafe"];

            const shouldAutoApprove = aiSettings.ai_auto_approve_low_risk !== false;
            const shouldAutoReject = aiSettings.ai_auto_reject_high_risk !== false;

            let newStatus = "pending";
            let moderationStatus = "pending";
            let isActive = false;
            const reason = flags.length > 0 ? flags.join(" | ") : report?.verdict || "AI analysis completed.";

            if ((safeVerdicts.includes(verdict) || score >= 80) && shouldAutoApprove) {
              newStatus = "approved";
              moderationStatus = "approved";
              isActive = true;
            } else if ((rejectVerdicts.includes(verdict) || score <= 35) && shouldAutoReject) {
              newStatus = "rejected";
              moderationStatus = "rejected";
              isActive = false;
            }

            if (newStatus !== "pending") {
              await pool.query(
                `UPDATE listings SET status = $1, moderation_status = $2, is_active = $3,
                 moderation_reason = $4, reviewed_at = NOW(),
                 activated_at = CASE WHEN $1 = 'approved' AND $3 = true THEN COALESCE(activated_at, NOW()) ELSE activated_at END
                 WHERE product_id = $5`,
                [newStatus, moderationStatus, isActive, reason, listing.product_id]
              );

              const receiverId = listing.uploaded_by_id || listing.agent_unique_id || listing.created_by;
              if (receiverId) {
                const nTitle = newStatus === "approved" ? "Listing Approved" : "Listing Rejected";
                const nMsg = newStatus === "approved"
                  ? `Your listing "${listing.title}" passed review and is now live.`
                  : `Your listing "${listing.title}" was rejected. Reason: ${reason}`;
                await pool.query(
                  `INSERT INTO notifications (receiver_id, product_id, type, title, message, created_at)
                   VALUES ($1::uuid, $2, 'listing_status', $3, $4, NOW())`,
                  [String(receiverId), listing.product_id, nTitle, nMsg]
                ).catch(() => {});

                if (req.io) {
                  req.io.to(String(receiverId)).emit("listingStatusUpdated", {
                    product_id: listing.product_id,
                    status: newStatus,
                    is_active: isActive,
                  });
                }
              }
            }
          }

        } catch {

          // AI scan failure must never block listing submission

        }

      });

    }



    return res.json({
      success: true,

      outcome: requiresBrokerageApproval ? "pending_brokerage_approval" : shouldAutoPublish ? "auto_approved" : "pending_review",

      message: requiresBrokerageApproval

        ? "Your listing has been submitted to your brokerage for approval."

        : shouldAutoPublish

          ? "Your listing passed our checks and is now live."

          : "Your listing has been submitted for admin review.",

      risk,
      listing: {

        ...listing,

        photos: normalizePhotosForResponse(listing.photos),

        floor_plans: safeJsonParse(listing.floor_plans, []),

        staging_photos: safeJsonParse(listing.staging_photos, []),

        panorama_photos: safeJsonParse(listing.panorama_photos, []),

        latitude:

          listing.latitude !== null && listing.latitude !== undefined

            ? parseFloat(listing.latitude)

            : null,

        longitude:

          listing.longitude !== null && listing.longitude !== undefined

            ? parseFloat(listing.longitude)

            : null,

      },

    });

  } catch (err) {

    console.error("[SubmitListingDraft] Error:", err);



    return res.status(500).json({

      success: false,

      message: "Failed to submit listing.",

      code: "SUBMIT_DRAFT_FAILED",

      details: err?.message,

    });

  }

};

