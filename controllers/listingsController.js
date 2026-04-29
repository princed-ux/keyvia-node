import { pool } from "../db.js";
import { uploadToS3, s3 } from "../middleware/upload.js";
import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import crypto from "crypto";
import axios from "axios";
import { performFullAnalysis } from "../services/analysisService.js";
import { COUNTRY_ISO_MAP } from "../utils/countryMap.js";
import { evaluateListingRisk } from "../services/listingRiskService.js";
import { enforceListingLimit } from "../services/subscriptionService.js";

/* ----------------- helpers ----------------- */
function generateProductId() {
  return "PRD-" + crypto.randomUUID().split("-")[0].toUpperCase();
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
      featuresArr = typeof features === "string" ? JSON.parse(features) : features;

      if (!Array.isArray(featuresArr) && typeof featuresArr === "object") {
        featuresArr = Object.keys(featuresArr).filter((key) => featuresArr[key]);
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
        public_id: photo.public_id || photo.publicId || photo.key || photo.s3_key || null,
        type: photo.type || "image",
        provider: photo.provider || (photo.key || photo.s3_key ? "s3" : "legacy"),
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

/* ----------------- AWS S3 MEDIA HELPERS ----------------- */

const AWS_S3_BUCKET = process.env.AWS_S3_BUCKET;
const LISTING_UPLOAD_CONCURRENCY = Number(process.env.LISTING_UPLOAD_CONCURRENCY || 3);
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
    user.subscription_plan ||
      user.plan ||
      user.account_plan ||
      "free",
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

const uploadPhotosWithLimit = async (photoFiles = [], listingId, photoLimit = 25) => {
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
        console.error("❌ Photo upload failed:", result.reason?.message || result.reason);
      }
    }
  }

  return uploadedPhotos;
};

/* ----------------- geocoding ----------------- */

const processGeolocation = async (address, city, state, country, zip) => {
  const userAgent = "KeyviaApp/1.0";
  const queryParts = [address, city, state, zip, country].filter(Boolean);
  if (!queryParts.length) return null;

  const query = queryParts.join(", ");

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await sleep(1000 * attempt);

      const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(
        query,
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
        console.warn(`⏳ Geocoding rate limit hit. Retrying attempt ${attempt}/3...`);
      } else {
        console.error("❌ Geocoding API Error:", error.message);
        if (attempt === 3) return null;
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
    const uploadedPhotos = await uploadPhotosWithLimit(photoFiles, listingId, 25);

    let finalVideoUrl = null;
    let finalVideoKey = null;

    if (videoFile) {
      try {
        const uploadedVideo = await uploadListingVideoToS3(videoFile, listingId, "video");
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
    console.error(`❌ AWS background processing failed for ${listingId}:`, error);

    try {
      await pool.query(
        `
        UPDATE listings
        SET status = 'draft',
            admin_notes = $1,
            updated_at = NOW()
        WHERE product_id = $2
        `,
        [`System Error: Upload failed. Please try again. (${error.message})`, listingId],
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
      Promise.allSettled(removeList.map((asset) => deleteListingAsset(asset))).catch((err) =>
        console.warn("⚠️ Background S3 delete failed:", err.message),
      );
    }

    const uploadedPhotos = await uploadPhotosWithLimit(photoFiles, listingId, 25);

    const currentRes = await pool.query("SELECT photos FROM listings WHERE product_id = $1", [
      listingId,
    ]);

    let currentPhotos = normalizeExistingPhotos(currentRes.rows[0]?.photos || []);

    if (removeList.length > 0) {
      const removeSet = new Set(
        removeList.map((item) =>
          typeof item === "string" ? item : item?.key || item?.s3_key || item?.public_id,
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
        const uploadedVideo = await uploadListingVideoToS3(videoFile, listingId, "video");
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
    const results = await Promise.allSettled(assets.map((asset) => deleteListingAsset(asset)));
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

    const product_id = generateProductId();

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

    const result = await pool.query(
      `
      INSERT INTO listings (
        product_id,
        draft_listing_id,
        uploaded_by_id,
        created_by,
        agent_unique_id,
        agency_id,

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
        updated_at
      )
      VALUES (
        $1,$2,$3::uuid,$3::uuid,$3::uuid,$4,

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
        NOW()
      )
      RETURNING *;
      `,
      [
        product_id,
        b.draft_listing_id || b.draftListingId || product_id,
        String(userId),
        b.agency_id || null,

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
        JSON.stringify(Array.isArray(b.panorama_photos) ? b.panorama_photos : []),
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
      ],
    );

    const listing = result.rows[0];

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

    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const found = await pool.query(
      "SELECT * FROM listings WHERE product_id=$1",
      [product_id]
    );

    const listing = found.rows[0];

    if (!listing) {
      return res.status(404).json({ message: "Listing not found" });
    }

    const listingOwnerId = listing.uploaded_by_id || listing.agent_unique_id || listing.created_by;

if (String(listingOwnerId) !== String(userId)) {
  return res.status(403).json({ message: "Forbidden" });
}

    const b = req.body;

    const toNum = (value, previous) => {
      if (value === undefined || value === null || value === "") return previous;
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
            : item?.key || item?.s3_key || item?.public_id
        )
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
        ])
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
      b.features || b.amenities || listing.features
    );

    const newAddr = b.address ?? listing.address;
    const newCity = b.city ?? listing.city;
    const newState = b.state ?? listing.state;
    const newCountry = b.country ?? listing.country;
    const newZip =
      b.zip_code || b.zipCode || b.postal_code || listing.zip_code;

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
        status='pending',
        is_active=false,
        updated_at=NOW()
      WHERE product_id=$33
      RETURNING *;
    `;

    const params = [
      b.title ?? listing.title,
      b.description ?? listing.description,
      toNum(b.price, listing.price),
      b.price_currency || b.priceCurrency || b.currency || listing.price_currency,
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
        listing.square_footage
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
      product_id,
    ];

    const result = await pool.query(query, params);

    return res.json({
      success: true,
      message: "Listing updated successfully and sent for review.",
      listing: result.rows[0],
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

    if (!userId) {
      return res.status(401).json({
        message: "Unauthorized",
        code: "UNAUTHORIZED",
      });
    }

    const found = await pool.query(
      "SELECT photos, video_public_id, virtual_tour_public_id, uploaded_by_id, agent_unique_id, created_by FROM listings WHERE product_id=$1",
      [product_id]
    );

    const listing = found.rows[0];

    if (!listing) {
      return res.status(404).json({
        message: "Listing not found",
        code: "LISTING_NOT_FOUND",
      });
    }

    const listingOwnerId = listing.uploaded_by_id || listing.agent_unique_id || listing.created_by;

if (String(listingOwnerId) !== String(userId)) {
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
    await pool.query("DELETE FROM notifications WHERE product_id=$1", [product_id]);
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
                })
              )
            )
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
      minPrice,
      maxPrice,
      city,
      polygon,
    } = req.query;

    let currentUserId = null;
    if (req.user && req.user.unique_id) currentUserId = req.user.unique_id;

    let queryText = `
      SELECT
        l.*,
        u.name as agent_name,
        u.avatar_url as agent_avatar,
        u.username as agent_username,
        u.role as agent_role,
        u.phone as agent_phone,
        CASE WHEN f.product_id IS NOT NULL THEN true ELSE false END as is_favorited
      FROM listings l
      JOIN users u ON l.uploaded_by_id = u.unique_id
      LEFT JOIN favorites f ON l.product_id = f.product_id AND f.user_id = $1
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

    if (category && category !== "undefined") {
      queryText += ` AND (category ILIKE $${paramCounter} OR listing_type ILIKE $${paramCounter})`;
      queryParams.push(category);
      paramCounter++;
    }

    if (type) {
      queryText += ` AND l.listing_type = $${paramCounter}`;
      queryParams.push(type.toLowerCase());
      paramCounter++;
    }

    if (city) {
      queryText += ` AND l.city ILIKE $${paramCounter}`;
      queryParams.push(`%${city}%`);
      paramCounter++;
    }

    if (minPrice) {
      queryText += ` AND l.price >= $${paramCounter}`;
      queryParams.push(minPrice);
      paramCounter++;
    }

    if (maxPrice) {
      queryText += ` AND l.price <= $${paramCounter}`;
      queryParams.push(maxPrice);
      paramCounter++;
    }

    if (search) {
      queryText += ` AND (
        l.city ILIKE $${paramCounter} OR
        l.address ILIKE $${paramCounter} OR
        l.state ILIKE $${paramCounter} OR
        l.country ILIKE $${paramCounter} OR
        l.zip_code ILIKE $${paramCounter}
      )`;
      queryParams.push(`%${search}%`);
      paramCounter++;
    }

    if (!polygon && minLat && maxLat && minLng && maxLng && !isNaN(Number(minLat))) {
      queryText += `
        AND l.latitude::numeric >= $${paramCounter}
        AND l.latitude::numeric <= $${paramCounter + 1}
        AND l.longitude::numeric >= $${paramCounter + 2}
        AND l.longitude::numeric <= $${paramCounter + 3}
      `;
      queryParams.push(minLat, maxLat, minLng, maxLng);
      paramCounter += 4;
    }

    queryText += " ORDER BY l.activated_at DESC NULLS LAST LIMIT 500";

    const result = await pool.query(queryText, queryParams);

    const listings = result.rows.map((listing) => {
      const photos = normalizePhotosForResponse(listing.photos);
      const features = safeJsonParse(listing.features, []);

      return {
        ...listing,
        photos,
        features,
        latitude: listing.latitude ? parseFloat(listing.latitude) : null,
        longitude: listing.longitude ? parseFloat(listing.longitude) : null,
        agent: {
          name: listing.agent_name,
          avatar: listing.agent_avatar,
          username: listing.agent_username,
          role: listing.agent_role,
          agency: listing.agency_name,
        },
      };
    });

    res.json(listings);
  } catch (err) {
    console.error("❌ CRITICAL ERROR in getListings:", err);
    res.status(500).json({ error: "Server error" });
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

      ORDER BY l.created_at DESC;
    `;

    const result = await pool.query(query, [String(userId)]);

    const rows = result.rows.map((row) => ({
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
    }));

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
------------------------------------------------------- */
export const getListingByProductId = async (req, res) => {
  try {
    const { product_id } = req.params;
    const userUniqueId = req.user?.unique_id || null;

    const query = `
      SELECT l.*,
             p.full_name, p.username, p.avatar_url, p.bio,
             p.agency_name, p.experience, p.country as agent_country, p.city as agent_city,
             p.email as agent_email, p.phone as agent_phone,
             p.role as agent_role
      FROM listings l
      LEFT JOIN profiles p ON l.created_by = p.unique_id
      WHERE l.product_id = $1;
    `;

    const result = await pool.query(query, [product_id]);
    const row = result.rows[0];

    if (!row) return res.status(404).json({ message: "Listing not found" });

    const isOwner = row.agent_unique_id === userUniqueId;
    const isPublicReady = row.status === "approved" && row.is_active === true;

    if (!isPublicReady && !isOwner) {
      return res.status(403).json({ message: "This listing is not currently active." });
    }

    res.json({
      ...row,
      photos: normalizePhotosForResponse(row.photos),
      latitude: row.latitude ? parseFloat(row.latitude) : null,
      longitude: row.longitude ? parseFloat(row.longitude) : null,
      agent: {
        unique_id: row.agent_unique_id,
        full_name: row.full_name,
        username: row.username,
        avatar_url: row.avatar_url,
        bio: row.bio,
        agency_name: row.agency_name,
        experience: row.experience,
        country: row.agent_country,
        city: row.agent_city,
        email: row.agent_email,
        phone: row.agent_phone,
        role: row.agent_role,
      },
    });
  } catch (err) {
    console.error("[GetListingByProductId] Error:", err);
    res.status(500).json({ message: "Failed", details: err?.message });
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

    const existing = await pool.query(`SELECT * FROM listings WHERE product_id=$1`, [product_id]);
    const listing = existing.rows[0];

    if (!listing) return res.status(404).json({ message: "Listing not found" });

    const agentId = listing.agent_unique_id;
    let isActiveValue = listing.is_active;

    if (status === "approved") {
      isActiveValue = listing.payment_status === "paid" ? true : false;
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

    const result = await pool.query(updateQuery, [status, isActiveValue, product_id]);
    const updatedListing = result.rows[0];

    let notifyMsg = `Your listing was ${status}.`;
    if (status === "approved") {
      notifyMsg += updatedListing.is_active
        ? " It is now LIVE on the platform."
        : " Please proceed to payment to activate it.";
    }

    await pool.query(
      `INSERT INTO notifications (receiver_id, product_id, type, title, message)
       VALUES ($1, $2, 'listing_status', 'Listing Status Update', $3)`,
      [agentId, product_id, notifyMsg],
    );

    if (req.io) {
      req.io.to(agentId).emit("listingStatusUpdated", {
        product_id,
        status,
        is_active: isActiveValue,
      });
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

    const result = await pool.query(
      `
      UPDATE listings
      SET is_active=true,
          payment_status='paid',
          activated_at=NOW()
      WHERE product_id=$1
      RETURNING *;
      `,
      [product_id],
    );

    res.json({
      message: "Listing activated",
      listing: result.rows[0],
    });
  } catch (err) {
    console.error("Activate error:", err);
    res.status(500).json({ message: "Failed to activate listing" });
  }
};

/* -------------------------------------------------------
   GET ALL LISTINGS - ADMIN
------------------------------------------------------- */
export const getAllListingsAdmin = async (req, res) => {
  try {
    const query = `
      SELECT
        l.*,
        p.full_name, p.username, p.email AS agent_email, p.phone, p.avatar_url, p.agency_name,
        p.city AS agent_city, p.country AS agent_country,
        p.role as agent_role
      FROM listings l
      LEFT JOIN profiles p ON l.created_by = p.unique_id
      ORDER BY
        CASE WHEN l.status = 'pending' THEN 1 ELSE 2 END,
        l.created_at DESC;
    `;

    const result = await pool.query(query);

    const rows = result.rows.map((row) => ({
      ...row,
      photos: normalizePhotosForResponse(row.photos),
      latitude: row.latitude ? parseFloat(row.latitude) : null,
      longitude: row.longitude ? parseFloat(row.longitude) : null,
      role: row.agent_role,
      agent_role: row.agent_role,
      agent: {
        unique_id: row.agent_unique_id,
        full_name: row.full_name,
        username: row.username,
        avatar_url: row.avatar_url,
        email: row.agent_email,
        phone: row.phone,
        agency_name: row.agency_name,
        city: row.agent_city,
        country: row.agent_country,
        role: row.agent_role,
      },
    }));

    res.json(rows);
  } catch (err) {
    console.error("[GetAllListingsAdmin] Error:", err);
    res.status(500).json({ message: "Failed to fetch admin listings" });
  }
};

/* -------------------------------------------------------
   GET PUBLIC PROFILE
------------------------------------------------------- */
export const getPublicAgentProfile = async (req, res) => {
  try {
    let { unique_id } = req.params;
    let queryCondition = "";
    let queryValue = unique_id;

    const isUUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
      unique_id,
    );

    if (isUUID) {
      queryCondition = "unique_id = $1";
    } else {
      if (queryValue.startsWith("@")) queryValue = queryValue.substring(1);
      queryCondition = "(username ILIKE $1 OR full_name ILIKE $1)";
    }

    const profileQ = await pool.query(
      `SELECT unique_id, full_name, username, avatar_url, bio,
              agency_name, experience, country, city,
              email, phone, social_instagram, social_twitter, social_linkedin,
              role,
              verification_status AS status,
              created_at
       FROM profiles
       WHERE ${queryCondition}`,
      [queryValue],
    );

    if (!profileQ.rows.length) {
      return res.status(404).json({ message: "Profile not found" });
    }

    const agent = profileQ.rows[0];

    if (agent.role === "Buyer") {
      agent.status = "verified";
    }

    agent.country_code = COUNTRY_ISO_MAP[agent.country] || null;

    let listings = [];

    if (agent.role !== "buyer") {
      const listingsQ = await pool.query(
        `SELECT * FROM listings
         WHERE agent_unique_id = $1 AND status = 'approved' AND is_active = true
         ORDER BY created_at DESC`,
        [agent.unique_id],
      );

      listings = listingsQ.rows.map((listing) => ({
        ...listing,
        photos: normalizePhotosForResponse(listing.photos),
      }));
    }

    res.json({
      agent,
      listings,
      default_cover:
        agent.role === "Buyer"
          ? "https://images.unsplash.com/photo-1560518883-ce09059eeffa?q=80&w=1973&auto=format&fit=crop"
          : null,
    });
  } catch (err) {
    console.error("[GetPublicProfile] Error:", err);
    res.status(500).json({ message: "Server Error" });
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
   BATCH AI ANALYSIS
------------------------------------------------------- */
export const batchAnalyzeListings = async (req, res) => {
  try {
    console.log("🚀 Starting Batch Analysis...");

    const pendingListings = await pool.query(
      `SELECT product_id, agent_unique_id, title FROM listings WHERE status = 'pending'`,
    );

    const total = pendingListings.rows.length;

    if (total === 0) {
      return res.json({
        success: true,
        message: "No pending listings to analyze.",
        stats: { approved: 0, rejected: 0, failed: 0 },
      });
    }

    res.json({
      success: true,
      message: `Batch analysis started for ${total} listings. Check admin logs/dashboard for progress.`,
    });

    (async () => {
      console.log(`🚀 Processing ${total} listings in background...`);

      const allPending = pendingListings.rows;
      const CHUNK_SIZE = 3;

      for (let i = 0; i < allPending.length; i += CHUNK_SIZE) {
        const chunk = allPending.slice(i, i + CHUNK_SIZE);

        await Promise.all(
          chunk.map(async (listing) => {
            try {
              const report = await performFullAnalysis(listing.product_id);

              let newStatus = "pending";
              let notificationTitle = "";
              let notificationMsg = "";
              const adminNote =
                report.flags && report.flags.length > 0
                  ? report.flags.join(". ")
                  : "Verified by AI.";

              if (report.verdict === "Safe to Approve") {
                newStatus = "approved";
                notificationTitle = "Listing Approved";
                notificationMsg = `Your listing "${listing.title}" passed AI verification.`;
              } else if (report.verdict === "Rejected") {
                newStatus = "rejected";
                notificationTitle = "Listing Rejected";
                notificationMsg = `Your listing "${listing.title}" was rejected. Issues: ${adminNote}`;
              } else {
                await pool.query(
                  `UPDATE listings SET admin_notes = $1 WHERE product_id = $2`,
                  [`AI Flag: ${adminNote}`, listing.product_id],
                );
                return;
              }

              await pool.query(
                `UPDATE listings SET status = $1, admin_notes = $2, updated_at = NOW() WHERE product_id = $3`,
                [newStatus, adminNote, listing.product_id],
              );

              await pool.query(
                `INSERT INTO notifications (receiver_id, product_id, type, title, message)
                 VALUES ($1, $2, 'listing_status', $3, $4)`,
                [listing.agent_unique_id, listing.product_id, notificationTitle, notificationMsg],
              );

              if (req.io) {
                req.io.to(listing.agent_unique_id).emit("notification", {
                  title: notificationTitle,
                  message: notificationMsg,
                });

                req.io.to(listing.agent_unique_id).emit("listingStatusUpdated", {
                  product_id: listing.product_id,
                  status: newStatus,
                });
              }

              console.log(`✅ Analyzed ${listing.product_id}: ${newStatus}`);
            } catch (err) {
              console.error(`❌ Error processing ${listing.product_id}`, err);
            }
          }),
        );

        await sleep(2000);
      }

      console.log("✅ Batch Analysis Complete.");
    })();
  } catch (err) {
    console.error("Batch Error:", err);

    if (!res.headersSent) {
      res.status(500).json({ message: "Server Error", error: err.message });
    }
  }
};
