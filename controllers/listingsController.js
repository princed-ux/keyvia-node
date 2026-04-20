import { pool } from "../db.js";
import cloudinary from "../utils/cloudinary.js";
import crypto from "crypto";
import axios from "axios";
import { performFullAnalysis } from "../services/analysisService.js";
import { COUNTRY_ISO_MAP } from "../utils/countryMap.js";

/* ----------------- helpers ----------------- */
function generateProductId() {
  return "PRD-" + crypto.randomUUID().split("-")[0].toUpperCase();
}

function genAssetId(prefix = "asset") {
  return `${prefix}_${crypto.randomUUID().split("-")[0]}`;
}

// ✅ HELPER: Sleep function for rate limiting
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ✅ ROBUST GEOCODING HELPER (With Retry Logic)
const processGeolocation = async (address, city, state, country, zip) => {
  const userAgent = "KeyviaApp/1.0";
  let queryParts = [address, city, state, zip, country].filter(Boolean);
  if (queryParts.length === 0) return null;

  let query = queryParts.join(", ");

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await sleep(1000 * attempt); // Wait 1s, 2s, 3s
      let url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&addressdetails=1&limit=1`;
      let res = await axios.get(url, { headers: { "User-Agent": userAgent } });

      if (res.data && res.data.length > 0) {
        const result = res.data[0];
        console.log("✅ Location found:", result.display_name);
        return { lat: parseFloat(result.lat), lng: parseFloat(result.lon) };
      }
      return null;
    } catch (error) {
      if (error.response && error.response.status === 429) {
        console.warn(`⏳ Geocoding rate limit hit. Retrying in ${attempt}s...`);
      } else {
        console.error("❌ Geocoding API Error:", error.message);
        if (attempt === 3) return null;
      }
    }
  }
  return null;
};

const uploadImageFileToCloudinary = async (file) => {
  try {
    const public_id = genAssetId("img");
    return await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          public_id,
          folder: "listings",
          resource_type: "image",
          overwrite: false,
        },
        (error, result) => {
          if (error) return reject(error);
          resolve({
            url: result.secure_url,
            public_id: result.public_id,
            type: "image",
          });
        },
      );
      stream.end(file.buffer);
    });
  } catch (err) {
    throw err;
  }
};

async function uploadVideoFileToCloudinary(file) {
  try {
    const public_id = genAssetId("vid");
    return await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          public_id,
          folder: "listings",
          resource_type: "video",
          overwrite: false,
        },
        async (error, result) => {
          if (error) return reject(error);
          if (result.duration && result.duration > 90) {
            await cloudinary.uploader.destroy(result.public_id, {
              resource_type: "video",
            });
            return reject(
              new Error("Video too long. Max allowed is 90 seconds."),
            );
          }
          resolve({
            url: result.secure_url,
            public_id: result.public_id,
            type: "video",
          });
        },
      );
      stream.end(file.buffer);
    });
  } catch (err) {
    throw err;
  }
}

async function deleteCloudinaryAsset(public_id, type = "image") {
  if (!public_id) return;
  try {
    await cloudinary.uploader.destroy(public_id, {
      resource_type: type === "video" ? "video" : "image",
    });
  } catch (e) {
    console.warn("⚠ Failed to delete Cloudinary asset:", public_id);
  }
}

function normalizeExistingPhotos(existing = []) {
  if (!existing) return [];
  if (!Array.isArray(existing)) {
    try {
      existing = JSON.parse(existing);
    } catch {
      return [];
    }
  }
  return existing
    .map((p) => {
      if (!p) return null;
      if (typeof p === "string")
        return { url: p, public_id: null, type: "image" };
      return {
        url: p.url || p.secure_url || null,
        public_id: p.public_id || p.publicId || null,
        type: p.type || "image",
      };
    })
    .filter(Boolean);
}

// ✅ BACKGROUND PROCESSOR (Handles Uploads & Geocoding)
const runBackgroundProcessing = async (
  listingId,
  photoFiles,
  addressData,
  videoFile,
  virtualFile,
) => {
  console.log(`⚙️ Background processing started for ${listingId}...`);

  try {
    // 1. Process Photos (Parallel Uploads - 3 at a time)
    const uploadedPhotos = [];
    for (let i = 0; i < photoFiles.length; i += 3) {
      const chunk = photoFiles.slice(i, i + 3);
      const results = await Promise.all(
        chunk.map((file) => uploadImageFileToCloudinary(file)),
      );
      uploadedPhotos.push(...results);
    }

    // 2. Process Video
    let finalVideoUrl = null,
      finalVideoPublicId = null;
    if (videoFile) {
      try {
        const vid = await uploadVideoFileToCloudinary(videoFile);
        finalVideoUrl = vid.url;
        finalVideoPublicId = vid.public_id;
      } catch (e) {
        console.error("Video upload failed", e);
      }
    }

    // 3. Process Virtual Tour
    let finalVirtualUrl = null,
      finalVirtualPublicId = null;
    if (virtualFile) {
      try {
        const tour = await uploadVideoFileToCloudinary(virtualFile);
        finalVirtualUrl = tour.url;
        finalVirtualPublicId = tour.public_id;
      } catch (e) {
        console.error("Virtual tour upload failed", e);
      }
    }

    // 4. Geocoding
    let coords = { lat: addressData.lat, lng: addressData.lng };
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

    // 5. Update DB -> Set Status to 'Pending' (Ready for Admin)
    await pool.query(
      `UPDATE listings 
       SET photos = $1, latitude = $2, longitude = $3, 
           video_url = $4, video_public_id = $5,
           virtual_tour_url = $6, virtual_tour_public_id = $7,
           status = 'pending' 
       WHERE product_id = $8`,
      [
        JSON.stringify(uploadedPhotos),
        coords.lat || 0,
        coords.lng || 0,
        finalVideoUrl,
        finalVideoPublicId,
        finalVirtualUrl,
        finalVirtualPublicId,
        listingId,
      ],
    );

    console.log(
      `✅ Listing ${listingId} processing complete & ready for review.`,
    );
  } catch (error) {
    console.error(`❌ Background processing failed for ${listingId}:`, error);

    // ✅ CRITICAL FIX: Mark listing as failed so it doesn't stay stuck forever
    try {
      await pool.query(
        `UPDATE listings SET status = 'draft', admin_notes = $1 WHERE product_id = $2`,
        [
          `System Error: Upload failed. Please try again. (${error.message})`,
          listingId,
        ],
      );
    } catch (dbErr) {
      console.error("Failed to update listing status to error:", dbErr);
    }
  }
};

/* -------------------------------------------------------
   🚀 CREATE LISTING (Async High Performance)
------------------------------------------------------- */
export const createListing = async (req, res) => {
  try {
    // 🔍 DEBUG: See what files are coming in
    console.log("📂 Incoming Files:", req.files);
    console.log("📝 Incoming Body:", req.body);

    const userId = req.user?.unique_id;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    // Fetch agent email
    const emailRes = await pool.query(
      "SELECT email FROM profiles WHERE unique_id=$1",
      [userId],
    );
    if (!emailRes.rows.length)
      return res.status(400).json({ message: "Agent profile not found" });
    const agentEmail = emailRes.rows[0].email;

    let {
      product_id,
      title,
      description,
      price,
      price_currency,
      price_period,
      category,
      property_type,
      listing_type,
      address,
      city,
      state,
      country,
      zip_code,
      latitude,
      longitude,
      bedrooms,
      bathrooms,
      parking,
      year_built,
      square_footage,
      furnishing,
      lot_size,
      features,
      contact_name,
      contact_email,
      contact_phone,
      contact_method,
    } = req.body;

    // Mapping CamelCase
    price_currency = price_currency || req.body.priceCurrency;
    property_type = property_type || req.body.propertyType;
    listing_type = listing_type || req.body.listingType;
    contact_name = contact_name || req.body.contactName;
    contact_email = contact_email || req.body.contactEmail;
    contact_phone = contact_phone || req.body.contactPhone;
    contact_method = contact_method || req.body.contactMethod;
    bedrooms = bedrooms || req.body.bedrooms;
    bathrooms = bathrooms || req.body.bathrooms;
    year_built = year_built || req.body.yearBuilt;
    square_footage = square_footage || req.body.squareFootage;
    lot_size = lot_size || req.body.lotSize;
    zip_code = zip_code || req.body.zipCode;

    if (!title || !price || !address) {
      return res.status(400).json({ message: "Missing required fields." });
    }

    if (!product_id) product_id = generateProductId();

    let lat = latitude ? Number(latitude) : 0;
    let lng = longitude ? Number(longitude) : 0;

    let featuresArr = [];
    try {
      if (features) {
        featuresArr =
          typeof features === "string" ? JSON.parse(features) : features;
        if (!Array.isArray(featuresArr) && typeof featuresArr === "object") {
          featuresArr = Object.keys(featuresArr).filter((k) => featuresArr[k]);
        }
      }
    } catch {
      featuresArr = [];
    }

    // 🔹 Insert "Shell" Listing (Status: 'processing')
    const query = `
      INSERT INTO listings (
        product_id, agent_unique_id, created_by, email,
        title, description, price, price_currency, price_period,
        category, property_type, listing_type,
        address, city, state, country, zip_code,
        latitude, longitude,
        bedrooms, bathrooms, parking,
        year_built, square_footage, furnishing, lot_size,
        features, photos, video_url, virtual_tour_url,
        contact_name, contact_email, contact_phone, contact_method,
        status, is_active, payment_status, created_at, updated_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
        $13, $14, $15, $16, $17, 
        $18, $19,
        $20, $21, $22, $23, $24, $25, $26, $27, 
        '[]', null, null,
        $28, $29, $30, $31,
        'processing', false, 'unpaid', NOW(), NOW()
      )
      RETURNING *;
    `;

    const params = [
      product_id,
      userId,
      userId,
      agentEmail,
      title || null,
      description || null,
      price ? Number(price) : null,
      price_currency || "USD",
      price_period || null,
      category || null,
      property_type || null,
      listing_type || null,
      address || null,
      city || null,
      state || null,
      country || null,
      zip_code || null,
      lat,
      lng,
      bedrooms ? Number(bedrooms) : null,
      bathrooms ? Number(bathrooms) : null,
      parking || null,
      year_built ? Number(year_built) : null,
      square_footage ? Number(square_footage) : null,
      furnishing || null,
      lot_size ? Number(lot_size) : null,
      JSON.stringify(featuresArr),
      contact_name || null,
      contact_email || null,
      contact_phone || null,
      contact_method || null,
    ];

    const result = await pool.query(query, params);
    const listing = result.rows[0];

    // ⚡ RESPOND IMMEDIATELY
    res.status(201).json({
      success: true,
      message: "Listing created! Media processing in background...",
      listing: { ...listing, status: "processing", photos: [] },
    });

    // ⚙️ TRIGGER BACKGROUND WORK
    const photoFiles = req.files?.photos || [];
    const videoFile = req.files?.video_file?.[0] || null;
    const virtualFile = req.files?.virtual_file?.[0] || null;

    // This runs AFTER response is sent
    runBackgroundProcessing(
      product_id,
      photoFiles,
      { address, city, state, country, zip: zip_code, lat, lng },
      videoFile,
      virtualFile,
    );
  } catch (err) {
    console.error("CreateListing Error:", err);
    if (!res.headersSent) {
      res.status(500).json({
        message: "Server Error",
        code: "CREATE_LISTING_FAIL",
        details: err?.message,
      });
    }
  }
};

/* -------------------------------------------------------
   🚀 HIGH-PERFORMANCE UPDATE LISTING (Async)
   Returns immediately, processes media/geo in background.
------------------------------------------------------- */

// ✅ BACKGROUND WORKER FOR UPDATES
const runUpdateBackgroundProcessing = async (listingId, data) => {
  const {
    photoFiles,
    videoFile,
    virtualFile,
    removeList,
    addressData,
    addressChanged,
  } = data;

  console.log(`⚙️ Background Update started for ${listingId}...`);

  try {
    // 1. Cloudinary Deletions (Parallel & Non-blocking)
    if (removeList.length > 0) {
      Promise.all(
        removeList.map((pid) => deleteCloudinaryAsset(pid, "image")),
      ).catch((e) => console.warn("Del failed", e));
    }

    // 2. Upload New Photos
    const uploadedPhotos = [];
    for (let i = 0; i < photoFiles.length; i += 3) {
      const chunk = photoFiles.slice(i, i + 3);
      const results = await Promise.all(
        chunk.map((file) => uploadImageFileToCloudinary(file)),
      );
      uploadedPhotos.push(...results);
    }

    // 3. Upload Video/Virtual Tour
    let vidUpdates = {};
    if (videoFile) {
      try {
        const up = await uploadVideoFileToCloudinary(videoFile);
        vidUpdates.video_url = up.url;
        vidUpdates.video_public_id = up.public_id;
      } catch (e) {
        console.error("Video update failed", e);
      }
    }
    if (virtualFile) {
      try {
        const up = await uploadVideoFileToCloudinary(virtualFile);
        vidUpdates.virtual_tour_url = up.url;
        vidUpdates.virtual_tour_public_id = up.public_id;
      } catch (e) {
        console.error("Virtual update failed", e);
      }
    }

    // 4. Geocoding (Only if address changed)
    let geoUpdates = {};
    if (addressChanged) {
      console.log("📍 Address changed, recalculating coordinates...");
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

    // 5. Final DB Update
    // Fetch current photos to append new ones
    const currentRes = await pool.query(
      "SELECT photos FROM listings WHERE product_id=$1",
      [listingId],
    );
    let currentPhotos = currentRes.rows[0]?.photos || [];
    if (typeof currentPhotos === "string")
      currentPhotos = JSON.parse(currentPhotos);

    const finalPhotos = [...currentPhotos, ...uploadedPhotos];

    // Dynamic SQL Building
    let fields = ["photos=$1", "updated_at=NOW()"];
    let values = [JSON.stringify(finalPhotos)];
    let idx = 2;

    if (geoUpdates.latitude) {
      fields.push(`latitude=$${idx++}`, `longitude=$${idx++}`);
      values.push(geoUpdates.latitude, geoUpdates.longitude);
    }
    if (vidUpdates.video_url) {
      fields.push(`video_url=$${idx++}`, `video_public_id=$${idx++}`);
      values.push(vidUpdates.video_url, vidUpdates.video_public_id);
    }
    if (vidUpdates.virtual_tour_url) {
      fields.push(
        `virtual_tour_url=$${idx++}`,
        `virtual_tour_public_id=$${idx++}`,
      );
      values.push(
        vidUpdates.virtual_tour_url,
        vidUpdates.virtual_tour_public_id,
      );
    }

    values.push(listingId);

    // We explicitly DO NOT set status='approved' here. It stays 'pending' from the main controller.
    await pool.query(
      `UPDATE listings SET ${fields.join(", ")} WHERE product_id=$${idx}`,
      values,
    );

    console.log(`✅ Listing ${listingId} background update complete.`);
  } catch (err) {
    console.error(`❌ Background update failed for ${listingId}`, err);
  }
};

export const updateListing = async (req, res) => {
  try {
    const product_id =
      req.params.product_id || req.params.id || req.params.productId;
    const userId = req.user?.unique_id;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    // 1. Fetch Existing
    const found = await pool.query(
      "SELECT * FROM listings WHERE product_id=$1",
      [product_id],
    );
    const listing = found.rows[0];
    if (!listing) return res.status(404).json({ message: "Listing not found" });
    if (listing.agent_unique_id !== userId)
      return res.status(403).json({ message: "Forbidden" });

    // 2. Prepare Data (Helpers)
    const b = req.body;
    const toNum = (v, prev) => (v ? Number(v) : prev);

    // 3. Handle Photos (Reordering & Deletion)
    // We handle deletions *immediately* in the DB record to make the UI snappy.
    // The actual Cloudinary deletion happens in background.
    let currentPhotos =
      typeof listing.photos === "string"
        ? JSON.parse(listing.photos || "[]")
        : listing.photos || [];

    // Process removals logic
    let removeList = [];
    try {
      if (req.body.removePhotos)
        removeList =
          typeof req.body.removePhotos === "string"
            ? JSON.parse(req.body.removePhotos)
            : req.body.removePhotos;
    } catch {
      removeList = [];
    }

    // Filter out removed photos from the array we will save immediately
    currentPhotos = currentPhotos.filter(
      (p) => !removeList.includes(p.public_id),
    );

    // Handle reordering (if existingPhotos sent)
    if (req.body.existingPhotos) {
      const orderMap = normalizeExistingPhotos(req.body.existingPhotos);
      // Map public_id to actual photo objects to reconstruct valid array
      const photoMap = new Map(currentPhotos.map((p) => [p.public_id, p]));
      const reordered = [];
      orderMap.forEach((p) => {
        if (photoMap.has(p.public_id))
          reordered.push(photoMap.get(p.public_id));
      });
      // Add any that were missed (edge case safety)
      currentPhotos.forEach((p) => {
        if (!reordered.find((r) => r.public_id === p.public_id))
          reordered.push(p);
      });
      currentPhotos = reordered;
    }

    // 4. Features
    let featuresArr = [];
    try {
      featuresArr = b.features
        ? typeof b.features === "string"
          ? JSON.parse(b.features)
          : b.features
        : JSON.parse(listing.features || "[]");
      if (!Array.isArray(featuresArr))
        featuresArr = Object.keys(featuresArr).filter((k) => featuresArr[k]);
    } catch {
      featuresArr = [];
    }

    // 5. Detect Address Change
    const newAddr = b.address ?? listing.address;
    const newCity = b.city ?? listing.city;
    const newState = b.state ?? listing.state;
    const newCountry = b.country ?? listing.country;
    const newZip = b.zip_code || b.zipCode || listing.zip_code;

    const addressChanged =
      newAddr !== listing.address ||
      newCity !== listing.city ||
      newState !== listing.state ||
      newCountry !== listing.country ||
      newZip !== listing.zip_code;

    // 6. Immediate DB Update (Text & Status Only)
    // We set status='pending' and is_active=false immediately.
    // We KEEP old lat/long/video for now until background worker updates them.
    const query = `
      UPDATE listings SET
        title=$1, description=$2, price=$3, price_currency=$4, price_period=$5,
        category=$6, property_type=$7, listing_type=$8,
        address=$9, city=$10, state=$11, country=$12, zip_code=$13,
        bedrooms=$14, bathrooms=$15, parking=$16,
        year_built=$17, square_footage=$18, furnishing=$19, lot_size=$20,
        features=$21, photos=$22,
        contact_name=$23, contact_email=$24, contact_phone=$25, contact_method=$26,
        status='pending', is_active=false, updated_at=NOW()
      WHERE product_id=$27
      RETURNING *;
    `;

    const params = [
      b.title ?? listing.title,
      b.description ?? listing.description,
      toNum(b.price, listing.price),
      b.price_currency || b.priceCurrency || listing.price_currency,
      b.price_period ?? listing.price_period,
      b.category ?? listing.category,
      b.property_type || b.propertyType || listing.property_type,
      b.listing_type || b.listingType || listing.listing_type,
      newAddr,
      newCity,
      newState,
      newCountry,
      newZip,
      toNum(b.bedrooms, listing.bedrooms),
      toNum(b.bathrooms, listing.bathrooms),
      b.parking ?? listing.parking,
      toNum(b.year_built || b.yearBuilt, listing.year_built),
      toNum(b.square_footage || b.squareFootage, listing.square_footage),
      b.furnishing ?? listing.furnishing,
      toNum(b.lot_size || b.lotSize, listing.lot_size),
      JSON.stringify(featuresArr),
      JSON.stringify(currentPhotos),
      b.contact_name || b.contactName || listing.contact_name,
      b.contact_email || b.contactEmail || listing.contact_email,
      b.contact_phone || b.contactPhone || listing.contact_phone,
      b.contact_method || b.contactMethod || listing.contact_method,
      product_id,
    ];

    const result = await pool.query(query, params);
    const updatedListing = result.rows[0];

    // 7. ⚡ RESPOND IMMEDIATELY
    res.json({
      success: true,
      message: "Update received! Media processing in background...",
      listing: updatedListing,
    });

    // 8. ⚙️ TRIGGER BACKGROUND WORK
    const photoFiles = req.files?.photos || [];
    const videoFile = req.files?.video_file?.[0] || null;
    const virtualFile = req.files?.virtual_file?.[0] || null;

    runUpdateBackgroundProcessing(product_id, {
      photoFiles,
      videoFile,
      virtualFile,
      removeList,
      addressData: {
        address: newAddr,
        city: newCity,
        state: newState,
        country: newCountry,
        zip: newZip,
      },
      addressChanged,
    });
  } catch (err) {
    console.error("UpdateListing Error:", err);
    if (!res.headersSent) {
      res.status(500).json({
        message: "Server Error",
        code: "UPDATE_FAIL",
        details: err?.message,
      });
    }
  }
};

/* -------------------------------------------------------
   DELETE LISTING (High Performance)
   1. Removes from DB immediately.
   2. Cleans up Cloudinary assets in background.
------------------------------------------------------- */

// ✅ BACKGROUND WORKER FOR DELETION
const runDeleteBackgroundCleanup = async (assets) => {
  console.log(`🗑️ Starting background cleanup for ${assets.length} assets...`);

  // We don't want to crash the server if this fails, just log it
  try {
    await Promise.all(
      assets.map(async (asset) => {
        if (!asset.public_id) return;
        await deleteCloudinaryAsset(asset.public_id, asset.type);
      }),
    );
    console.log("✅ Background cleanup complete.");
  } catch (err) {
    console.error("❌ Background cleanup error:", err);
  }
};

export const deleteListing = async (req, res) => {
  try {
    const product_id =
      req.params.product_id || req.params.id || req.params.productId;
    const userId = req.user?.unique_id;

    if (!userId)
      return res
        .status(401)
        .json({ message: "Unauthorized", code: "UNAUTHORIZED" });

    // 1. Fetch listing to verify ownership & get asset IDs BEFORE deleting
    const found = await pool.query(
      "SELECT photos, video_public_id, virtual_tour_public_id, agent_unique_id FROM listings WHERE product_id=$1",
      [product_id],
    );
    const listing = found.rows[0];

    if (!listing)
      return res
        .status(404)
        .json({ message: "Listing not found", code: "LISTING_NOT_FOUND" });

    if (listing.agent_unique_id !== userId) {
      return res
        .status(403)
        .json({ message: "Not authorized", code: "FORBIDDEN" });
    }

    // 2. Collect Assets for Background Deletion
    const assetsToDelete = [];

    // Parse Photos
    let photos = [];
    try {
      photos =
        typeof listing.photos === "string"
          ? JSON.parse(listing.photos || "[]")
          : listing.photos || [];
    } catch {
      photos = [];
    }

    // Add Photos to delete list
    photos.forEach((p) => {
      if (p.public_id)
        assetsToDelete.push({ public_id: p.public_id, type: "image" });
    });

    // Add Video
    if (listing.video_public_id) {
      assetsToDelete.push({
        public_id: listing.video_public_id,
        type: "video",
      });
    }

    // Add Virtual Tour
    if (listing.virtual_tour_public_id) {
      assetsToDelete.push({
        public_id: listing.virtual_tour_public_id,
        type: "video",
      });
    }

    // 3. Delete from DB (Immediate)
    // Clear notifications first (Foreign Key constraint)
    await pool.query("DELETE FROM notifications WHERE product_id=$1", [
      product_id,
    ]);
    // Delete the Listing
    await pool.query("DELETE FROM listings WHERE product_id=$1", [product_id]);

    // 4. Fetch updated agent stats (Optional, useful for UI refresh)
    const profileRes = await pool.query(
      "SELECT unique_id, email, full_name, username, avatar_url, agency_name FROM profiles WHERE unique_id=$1",
      [userId],
    );

    // 5. ⚡ SEND RESPONSE IMMEDIATELY
    res.json({
      success: true,
      message: "Listing deleted successfully",
      agent: profileRes.rows[0] || null,
    });

    // 6. ⚙️ TRIGGER BACKGROUND CLEANUP
    if (assetsToDelete.length > 0) {
      runDeleteBackgroundCleanup(assetsToDelete);
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
   1. GET LISTINGS (Public - /buy, /rent, Homepage)
   UPDATED: Fix for Polygon Search
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

    // Log Incoming Params
    console.log("📥 Query Params:", {
      category,
      type,
      city,
      hasPolygon: !!polygon,
      hasViewport: !!minLat && !!maxLat,
    });

    let currentUserId = null;
    if (req.user && req.user.unique_id) {
      currentUserId = req.user.unique_id;
    }

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

    // --- 1. POLYGON SEARCH (THE FIX) ---
    if (polygon) {
      try {
        console.log("🔹 Parsing Polygon JSON...");
        const geoJson = JSON.parse(polygon);

        // Validate JSON structure
        if (!geoJson.type || !geoJson.coordinates) {
          throw new Error("Invalid GeoJSON structure");
        }

        // ✅ FIX: Construct Point from Lat/Lng columns on the fly
        // This bypasses any issues with the 'location' column being null or stale.
        // ST_MakePoint takes (Longitude, Latitude) -> (X, Y)
        queryText += ` 
                AND l.longitude IS NOT NULL 
                AND l.latitude IS NOT NULL
                AND ST_Intersects(
                    ST_SetSRID(ST_GeomFromGeoJSON($${paramCounter}), 4326), 
                    ST_SetSRID(ST_MakePoint(l.longitude::float, l.latitude::float), 4326)
                )`;

        queryParams.push(JSON.stringify(geoJson));
        paramCounter++;
        console.log("✅ Polygon Filter Added (Using Dynamic ST_MakePoint)");
      } catch (e) {
        console.error("❌ Invalid Polygon JSON received:", e.message);
        // Don't crash, just ignore the polygon filter if it's bad
      }
    }

    // --- 2. STANDARD FILTERS ---
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

    // Viewport Search (Fallback - only if NO polygon)
    if (
      !polygon &&
      minLat &&
      maxLat &&
      minLng &&
      maxLng &&
      !isNaN(Number(minLat))
    ) {
      console.log("🔹 Using Viewport (Bounds) Search");
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

    // --- 3. EXECUTE ---
    // console.log("📝 SQL:", queryText);
    const result = await pool.query(queryText, queryParams);

    console.log(`✅ Database returned ${result.rows.length} rows`);

    // --- 4. FORMAT RESPONSE ---
    const listings = result.rows.map((l) => {
      let photos = [],
        features = [];
      try {
        photos =
          typeof l.photos === "string" ? JSON.parse(l.photos) : l.photos || [];
      } catch (e) {}
      try {
        features =
          typeof l.features === "string"
            ? JSON.parse(l.features)
            : l.features || [];
      } catch (e) {}

      photos = photos.map((p) => ({ url: p.url || p, type: "image" }));

      return {
        ...l,
        photos,
        features,
        latitude: l.latitude ? parseFloat(l.latitude) : null,
        longitude: l.longitude ? parseFloat(l.longitude) : null,
        agent: {
          name: l.agent_name,
          avatar: l.agent_avatar,
          username: l.agent_username,
          role: l.agent_role,
          agency: l.agency_name,
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
    const query = `
      SELECT l.*, 
             p.full_name, p.username, p.avatar_url, p.bio, 
             p.agency_name, p.experience, p.country as agent_country, p.city as agent_city,
             p.role as agent_role  -- 👈 ADDED THIS
      FROM listings l
      LEFT JOIN profiles p ON l.agent_unique_id = p.unique_id
      WHERE l.agent_unique_id=$1
      ORDER BY l.created_at DESC;
    `;
    const result = await pool.query(query, [userId]);

    const rows = result.rows.map((r) => {
      let photos = [];
      try {
        photos =
          typeof r.photos === "string"
            ? JSON.parse(r.photos || "[]")
            : r.photos || [];
        photos = photos.map((p) => ({ url: p.url || p, type: "image" }));
      } catch {}

      return {
        ...r,
        photos,
        latitude: r.latitude ? parseFloat(r.latitude) : null,
        longitude: r.longitude ? parseFloat(r.longitude) : null,
        agent_role: r.agent_role, // 👈 Explicitly pass top-level
        role: r.agent_role, // 👈 Explicitly pass top-level for safety
        agent: {
          unique_id: r.agent_unique_id,
          full_name: r.full_name,
          username: r.username,
          avatar_url: r.avatar_url,
          bio: r.bio,
          agency_name: r.agency_name,
          experience: r.experience,
          country: r.agent_country,
          city: r.agent_city,
          role: r.agent_role, // 👈 Included inside agent object
        },
      };
    });

    res.json(rows);
  } catch (err) {
    console.error("[GetAgentListings] Error:", err);
    res.status(500).json({ message: "Failed", details: err?.message });
  }
};

/* -------------------------------------------------------
   2. GET LISTING BY ID (Public Details Page)
   UPDATED: Now returns 'role'
------------------------------------------------------- */
export const getListingByProductId = async (req, res) => {
  try {
    const { product_id } = req.params;
    const userUniqueId = req.user?.unique_id || null;

    // ✅ ADDED: p.role
    const query = `
      SELECT l.*, 
             p.full_name, p.username, p.avatar_url, p.bio, 
             p.agency_name, p.experience, p.country as agent_country, p.city as agent_city,
             p.email as agent_email, p.phone as agent_phone,
             p.role as agent_role
      FROM listings l
      LEFT JOIN profiles p ON l.agent_unique_id = p.unique_id
      WHERE l.product_id = $1;
    `;

    const result = await pool.query(query, [product_id]);
    const row = result.rows[0];

    if (!row) return res.status(404).json({ message: "Listing not found" });

    const isOwner = row.agent_unique_id === userUniqueId;
    const isPublicReady = row.status === "approved" && row.is_active === true;

    if (!isPublicReady && !isOwner) {
      return res
        .status(403)
        .json({ message: "This listing is not currently active." });
    }

    let photos = [];
    try {
      photos =
        typeof row.photos === "string"
          ? JSON.parse(row.photos || "[]")
          : row.photos || [];
      photos = photos.map((p) => ({ url: p.url || p, type: "image" }));
    } catch {}

    res.json({
      ...row,
      photos,
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
        role: row.agent_role, // ✅ Send role to frontend
      },
    });
  } catch (err) {
    console.error("[GetListingByProductId] Error:", err);
    res.status(500).json({ message: "Failed", details: err?.message });
  }
};

/* -------------------------------------------------------
   UPDATE LISTING STATUS (Admin)
   Fixed: Checks payment_status to avoid double charging
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

    const agentId = listing.agent_unique_id;

    // ✅ FIX: Logic to prevent double-paying
    let isActiveValue = listing.is_active; // Default to current state

    if (status === "approved") {
      // If already paid, Go LIVE immediately. If not paid, stay inactive.
      isActiveValue = listing.payment_status === "paid" ? true : false;
    } else if (status === "rejected" || status === "pending") {
      // If rejected/pending, always turn off visibility
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

    // Notification Logic
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
   GET ALL LISTINGS (ADMIN ONLY)
------------------------------------------------------- */
export const getAllListingsAdmin = async (req, res) => {
  try {
    const query = `
      SELECT 
        l.*,
        p.full_name, p.username, p.email AS agent_email, p.phone, p.avatar_url, p.agency_name,
        p.city AS agent_city, p.country AS agent_country,
        p.role as agent_role -- 👈 ADDED THIS
      FROM listings l
      LEFT JOIN profiles p ON l.agent_unique_id = p.unique_id
      ORDER BY 
        CASE WHEN l.status = 'pending' THEN 1 ELSE 2 END,
        l.created_at DESC;
    `;

    const result = await pool.query(query);

    const rows = result.rows.map((r) => {
      let photos = [];
      try {
        photos =
          typeof r.photos === "string" ? JSON.parse(r.photos) : r.photos || [];
        photos = photos.map((p) => ({ url: p.url || p, type: "image" }));
      } catch {}

      return {
        ...r,
        photos,
        latitude: r.latitude ? parseFloat(r.latitude) : null,
        longitude: r.longitude ? parseFloat(r.longitude) : null,
        role: r.agent_role, // 👈 Explicitly pass top-level
        agent_role: r.agent_role, // 👈 Explicitly pass top-level
        agent: {
          unique_id: r.agent_unique_id,
          full_name: r.full_name,
          username: r.username,
          avatar_url: r.avatar_url,
          email: r.agent_email,
          phone: r.phone,
          agency_name: r.agency_name,
          city: r.agent_city,
          country: r.agent_country,
          role: r.agent_role, // 👈 Included
        },
      };
    });

    res.json(rows);
  } catch (err) {
    console.error("[GetAllListingsAdmin] Error:", err);
    res.status(500).json({ message: "Failed to fetch admin listings" });
  }
};

/* -------------------------------------------------------
   GET PUBLIC PROFILE (Agent, Landlord, or Buyer)
------------------------------------------------------- */
export const getPublicAgentProfile = async (req, res) => {
  try {
    let { unique_id } = req.params;
    let queryCondition = "";
    let queryValue = unique_id;

    // Determine if searching by UUID or Username
    const isUUID =
      /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
        unique_id,
      );

    if (isUUID) {
      queryCondition = "unique_id = $1";
    } else {
      if (queryValue.startsWith("@")) queryValue = queryValue.substring(1);
      queryCondition = "(username ILIKE $1 OR full_name ILIKE $1)";
    }

    // 1. Fetch Profile
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

    if (profileQ.rows.length === 0) {
      return res.status(404).json({ message: "Profile not found" });
    }

    const agent = profileQ.rows[0];

    // ✅ LOGIC FIX: BUYERS ARE ALWAYS "LIVE"
    if (agent.role === "Buyer") {
      agent.status = "verified";
    }

    // ✅ LOGIC FIX: ROBUST COUNTRY CODE MAPPING
    // Uses the imported map. If exact match found, use it.
    // If not, fallback to NULL (Frontend will show Globe 🌍)
    agent.country_code = COUNTRY_ISO_MAP[agent.country] || null;

    // 3. Fetch Listings (ONLY if NOT a buyer)
    let listings = [];

    if (agent.role !== "buyer") {
      const listingsQ = await pool.query(
        `SELECT * FROM listings 
           WHERE agent_unique_id = $1 AND status = 'approved' AND is_active = true
           ORDER BY created_at DESC`,
        [agent.unique_id],
      );

      // Normalize photos
      listings = listingsQ.rows.map((l) => {
        let photos = [];
        try {
          photos =
            typeof l.photos === "string"
              ? JSON.parse(l.photos)
              : l.photos || [];
        } catch {}
        return {
          ...l,
          photos: photos.map((p) => ({ url: p.url || p, type: "image" })),
        };
      });
    }

    // 4. Send Response
    res.json({
      agent,
      listings,
      // Suggest a cover image for Buyers since they don't have listings
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
   SINGLE AI ANALYSIS (Admin triggers manually)
------------------------------------------------------- */
export const analyzeListing = async (req, res) => {
  try {
    const { product_id } = req.params;
    console.log(`🤖 Admin requested AI Analysis for: ${product_id}...`);

    // 1. Run the Python-Powered Analysis
    const report = await performFullAnalysis(product_id);

    // 2. Respond immediately with the report
    res.json(report);
  } catch (err) {
    console.error("Single Analysis Error:", err);
    res.status(500).json({ message: "AI Analysis failed", error: err.message });
  }
};

/* -------------------------------------------------------
   ✅ BATCH AI ANALYSIS (Process All Pending)
   - Fetches all 'pending' listings
   - Sends them to Python AI one by one (chunked)
   - Updates status automatically
------------------------------------------------------- */
export const batchAnalyzeListings = async (req, res) => {
  try {
    console.log("🚀 Starting Batch Analysis...");

    // 1. Fetch Pending Listings
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

    // 2. ⚡ RESPOND IMMEDIATELY (Don't make Admin wait)
    res.json({
      success: true,
      message: `Batch analysis started for ${total} listings. Check admin logs/dashboard for progress.`,
    });

    // 3. ⚙️ BACKGROUND PROCESSING (Fire & Forget)
    (async () => {
      console.log(`🚀 Processing ${total} listings in background...`);
      const allPending = pendingListings.rows;
      const CHUNK_SIZE = 3; // Process 3 at a time (Python is heavy)

      for (let i = 0; i < allPending.length; i += CHUNK_SIZE) {
        const chunk = allPending.slice(i, i + CHUNK_SIZE);

        await Promise.all(
          chunk.map(async (listing) => {
            try {
              // CALL THE NEW SERVICE
              const report = await performFullAnalysis(listing.product_id);

              let newStatus = "pending";
              let notificationTitle = "";
              let notificationMsg = "";
              // Join flags into a readable string
              let adminNote =
                report.flags && report.flags.length > 0
                  ? report.flags.join(". ")
                  : "Verified by AI.";

              // LOGIC: Auto-Approve or Auto-Reject based on Python Score
              if (report.verdict === "Safe to Approve") {
                newStatus = "approved";
                notificationTitle = "Listing Approved";
                notificationMsg = `Your listing "${listing.title}" passed AI verification.`;
              } else if (report.verdict === "Rejected") {
                newStatus = "rejected";
                notificationTitle = "Listing Rejected";
                notificationMsg = `Your listing "${listing.title}" was rejected. Issues: ${adminNote}`;
              } else {
                // "Manual Review Needed" -> Stay Pending, but save notes
                await pool.query(
                  `UPDATE listings SET admin_notes = $1 WHERE product_id = $2`,
                  [`AI Flag: ${adminNote}`, listing.product_id],
                );
                return; // Stop here, don't change status or notify yet
              }

              // UPDATE DB STATUS
              await pool.query(
                `UPDATE listings SET status = $1, admin_notes = $2, updated_at = NOW() WHERE product_id = $3`,
                [newStatus, adminNote, listing.product_id],
              );

              // NOTIFY AGENT
              await pool.query(
                `INSERT INTO notifications (receiver_id, product_id, type, title, message) VALUES ($1, $2, 'listing_status', $3, $4)`,
                [
                  listing.agent_unique_id,
                  listing.product_id,
                  notificationTitle,
                  notificationMsg,
                ],
              );

              // REAL-TIME SOCKET
              if (req.io) {
                req.io.to(listing.agent_unique_id).emit("notification", {
                  title: notificationTitle,
                  message: notificationMsg,
                });
                req.io
                  .to(listing.agent_unique_id)
                  .emit("listingStatusUpdated", {
                    product_id: listing.product_id,
                    status: newStatus,
                  });
              }

              console.log(`✅ Analyzed ${listing.product_id}: ${newStatus}`);
            } catch (e) {
              console.error(`❌ Error processing ${listing.product_id}`, e);
            }
          }),
        );

        // Wait 2 seconds between chunks to let Python breathe
        await new Promise((r) => setTimeout(r, 2000));
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
