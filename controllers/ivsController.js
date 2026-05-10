// keyvia-node/controllers/ivsController.js
// ============================================================================
// AWS INTERACTIVE VIDEO SERVICE (IVS) - Live Property Tours
// Handles: Channel creation, stream credentials, safe viewer access, reporting
// ============================================================================

import { IvsClient, CreateChannelCommand } from "@aws-sdk/client-ivs";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { pool } from "../db.js";
import { v4 as uuidv4 } from "uuid";

const ivsClient = new IvsClient({
  region: process.env.AWS_IVS_REGION || process.env.AWS_REGION || "eu-west-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const sesClient = new SESClient({
  region: process.env.AWS_SES_REGION || process.env.AWS_IVS_REGION || "eu-west-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const SAFETY_DISCLAIMER =
  "Before making any transaction, verify the property, confirm ownership/title documents, meet safely, and avoid sending money outside trusted or verified processes.";

const PLATFORM_LIMITATION =
  "Keyvia does not currently act as a broker, escrow provider, legal representative, or transaction guarantor.";

const LIVE_TOUR_REPORT_REASONS = new Set([
  "scam_fraud_suspicion",
  "fake_listing",
  "wrong_location",
  "misleading_price",
  "impersonation",
  "illegal_suspicious_stream",
  "unsafe_payment_request",
  "harassment_abuse",
]);

const getViewerCounts = (tour = {}) => ({
  current_viewers: Number(tour.current_viewers || 0),
  total_viewers: Number(tour.total_viewers || 0),
  peak_viewers: Number(tour.peak_viewers || 0),
});

const buildTourPayload = (
  tour,
  { includeCredentials = true, includePlayback = true } = {},
) => {
  const ingestEndpoint = tour.ivs_ingest_endpoint || tour.ingest_endpoint || "";
  const streamKey = tour.ivs_stream_key || tour.stream_key || "";

  const payload = {
    id: tour.id,
    property_id: tour.property_id,
    host_id: tour.host_id,
    agency_id: tour.agency_id,
    playback_url: includePlayback
      ? tour.ivs_playback_url || tour.playback_url || ""
      : "",
    price_in_coins: Number(tour.price_in_coins || 0),
    is_live: tour.is_live,
    started_at: tour.started_at,
    ended_at: tour.ended_at,
    ...getViewerCounts(tour),
    safety_disclaimer: SAFETY_DISCLAIMER,
    platform_limitation: PLATFORM_LIMITATION,
    instructions:
      "Open camera and start broadcast in Keyvia Studio, or use the RTMPS server and stream key in OBS.",
  };

  if (includeCredentials) {
    payload.stream_key = streamKey;
    payload.ingest_endpoint = ingestEndpoint;
    payload.channel_arn = tour.ivs_channel_arn || tour.channel_arn;
    payload.rtmp_url = ingestEndpoint ? `rtmps://${ingestEndpoint}:443/app/` : "";
    payload.stream_url =
      ingestEndpoint && streamKey
        ? `rtmps://${ingestEndpoint}:443/app/${streamKey}`
        : "";
  }

  return payload;
};

const normalizeId = (value) => (value ? String(value) : "");

const getHostId = (req) => {
  return req.user?.unique_id || req.user?.id || null;
};

const getListingIdentifier = (body = {}) => {
  return body.listing_id || body.product_id || body.id || null;
};

const parseCoins = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
};

// ============================================================================
// 1. GO LIVE - Create or Resume IVS Channel for a Property Listing
// ============================================================================
/**
 * POST /api/ivs/go-live
 *
 * Body:
 * {
 *   listing_id?: string,
 *   product_id?: string,
 *   price_in_coins?: number
 * }
 *
 * Returns:
 * {
 *   success,
 *   message,
 *   tour
 * }
 */
export const goLive = async (req, res) => {
  try {
    const hostId = getHostId(req);
    const listingIdentifier = getListingIdentifier(req.body);
    const priceInCoins = 0;

    if (!hostId) {
      return res.status(401).json({
        success: false,
        message: "Please log in again before starting a live tour.",
        code: "AUTH_REQUIRED",
      });
    }

    if (!listingIdentifier) {
      return res.status(400).json({
        success: false,
        message: "Choose a listing before starting a live tour.",
        code: "LISTING_REQUIRED",
      });
    }

    console.log(
      `📡 Host ${hostId} attempting to go live for listing ${listingIdentifier}`,
    );

    // ------------------------------------------------------------------------
    // Find listing by database id or public product_id
    // ------------------------------------------------------------------------
    const listingCheck = await pool.query(
      `
      SELECT *
      FROM listings
      WHERE id::text = $1::text
         OR product_id::text = $1::text
      LIMIT 1
      `,
      [String(listingIdentifier)],
    );

    if (listingCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Listing not found.",
        code: "LISTING_NOT_FOUND",
      });
    }

    const listing = listingCheck.rows[0];
    const listingUuid = listing.id;
    const agencyId = listing.agency_id || listing.brokerage_id || null;

    // ------------------------------------------------------------------------
    // Permission check
    // Adjust this list if your listings table uses different owner columns.
    // ------------------------------------------------------------------------
    const allowedHostIds = [
      listing.uploaded_by_id,
      listing.uploaded_by,
      listing.agent_unique_id,
      listing.created_by,
      listing.created_by_id,
      listing.owner_id,
      listing.user_id,
      listing.assigned_agent_id,
      listing.agency_id,
      listing.brokerage_id,
    ]
      .filter(Boolean)
      .map((value) => String(value));

    if (!allowedHostIds.includes(String(hostId))) {
      return res.status(403).json({
        success: false,
        message:
          "You can only go live for listings you own or have been assigned.",
        code: "LIVE_TOUR_NOT_ALLOWED",
      });
    }

    // ------------------------------------------------------------------------
    // Listing status check
    // ------------------------------------------------------------------------
    const listingStatus = String(
      listing.status || listing.display_status || "",
    ).toLowerCase();

    const listingApproved = ["approved", "live", "published"].includes(
      listingStatus,
    );

    if (!listingApproved) {
      return res.status(409).json({
        success: false,
        message: "This listing needs admin approval before you can go live.",
        code: "LISTING_NOT_APPROVED",
      });
    }

    if (listing.is_active === false) {
      return res.status(409).json({
        success: false,
        message:
          "This listing is approved but not live yet. Activate it before starting a live tour.",
        code: "LISTING_NOT_ACTIVE",
      });
    }

    // ------------------------------------------------------------------------
    // Resume existing active tour instead of creating another channel.
    // IMPORTANT: This must stay INSIDE goLive.
    // ------------------------------------------------------------------------
    const activeTourCheck = await pool.query(
      `
      SELECT *
      FROM live_tours
      WHERE property_id = $1
        AND host_id = $2
        AND is_live = TRUE
      ORDER BY started_at DESC
      LIMIT 1
      `,
      [listingUuid, hostId],
    );

    if (activeTourCheck.rows.length > 0) {
      const existingTour = activeTourCheck.rows[0];

      return res.status(200).json({
        success: true,
        message: "This listing already has an active live room. Resuming it now.",
        tour: buildTourPayload(existingTour),
      });
    }

    // ------------------------------------------------------------------------
    // Create AWS IVS Channel.
    //
    // CreateChannelCommand already returns channel + streamKey.
    // Do NOT call CreateStreamKeyCommand again.
    // AWS IVS allows only one stream key per channel.
    // ------------------------------------------------------------------------
    const safeListingName =
      listing.product_id || listingUuid || String(listingIdentifier);

    const channelName = `keyvia-live-${safeListingName}-${Date.now()}`;

    const channelResponse = await ivsClient.send(
      new CreateChannelCommand({
        name: channelName,
        type: process.env.AWS_IVS_CHANNEL_TYPE || "STANDARD",
        latencyMode: "LOW",
        authorized: false,
        recordingConfigurationArn:
          process.env.AWS_IVS_RECORDING_CONFIG_ARN || undefined,
        tags: {
          app: "keyvia",
          listingId: String(listingUuid),
          hostId: String(hostId),
          environment: process.env.NODE_ENV || "development",
        },
      }),
    );

    const channel = channelResponse.channel;
    const streamKeyData = channelResponse.streamKey;

    if (!channel || !streamKeyData) {
      return res.status(500).json({
        success: false,
        message:
          "IVS channel was created, but AWS did not return the required stream details.",
        code: "IVS_STREAM_DETAILS_MISSING",
      });
    }

    const channelArn = channel.arn;
    const playbackUrl = channel.playbackUrl;
    const ingestEndpoint = channel.ingestEndpoint;
    const streamKey = streamKeyData.value;

    if (!channelArn || !playbackUrl || !ingestEndpoint || !streamKey) {
      return res.status(500).json({
        success: false,
        message:
          "AWS IVS returned incomplete stream credentials. Please check your IVS configuration.",
        code: "IVS_INCOMPLETE_CREDENTIALS",
      });
    }

    console.log(`✅ IVS Channel created: ${channelArn}`);
    console.log(`✅ IVS ingest endpoint: ${ingestEndpoint}`);

    // ------------------------------------------------------------------------
    // Save live tour
    // ------------------------------------------------------------------------
    const tourId = uuidv4();

    const createTourQuery = `
      INSERT INTO live_tours (
        id,
        property_id,
        host_id,
        agency_id,
        ivs_channel_arn,
        ivs_stream_key,
        ivs_playback_url,
        ivs_ingest_endpoint,
        price_in_coins,
        is_live,
        started_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE, NOW())
      RETURNING *
    `;

    const tourResult = await pool.query(createTourQuery, [
      tourId,
      listingUuid,
      hostId,
      agencyId,
      channelArn,
      streamKey,
      playbackUrl,
      ingestEndpoint,
      priceInCoins,
    ]);

    const tour = tourResult.rows[0];

    // ------------------------------------------------------------------------
    // Notifications should not break live creation.
    // ------------------------------------------------------------------------
    const propertyTitle = listing.title || listing.address || "A Property";

    let agentName = "A Keyvia host";

    try {
      const agentQuery = `
        SELECT COALESCE(full_name, name, email, 'A Keyvia host') AS host_name
        FROM users
        WHERE unique_id = $1
        LIMIT 1
      `;

      const agentResult = await pool.query(agentQuery, [hostId]);
      agentName = agentResult.rows[0]?.host_name || "A Keyvia host";
    } catch (agentError) {
      console.warn("⚠️ Could not fetch host display name:", agentError.message);
    }

    try {
      await notifyPropertyFollowers(listingUuid, propertyTitle, tourId);
    } catch (notifyError) {
      console.error("❌ Live tour notification failed:", notifyError);
    }

    // ------------------------------------------------------------------------
    // Socket broadcast to connected clients
    // ------------------------------------------------------------------------
    if (req.io) {
      req.io.emit("agent_went_live", {
        agentId: hostId,
        agentName,
        propertyTitle,
        listingId: listingUuid,
        productId: listing.product_id,
        tourId,
        playbackUrl,
        timestamp: new Date().toISOString(),
        message: `🔴 ${agentName} created a live room for ${propertyTitle}.`,
      });
    }

    console.log(`✅ Live tour created: ${tourId}`);

    return res.status(201).json({
      success: true,
      message:
        "Live room created. Open camera, preview the tour, then start broadcast when ready.",
      tour: buildTourPayload(tour),
    });
  } catch (error) {
    console.error("❌ Go Live Error:", error);

    return res.status(500).json({
      success: false,
      error: "Failed to start live tour",
      code: error?.name || error?.Code || "IVS_GO_LIVE_FAILED",
      message:
        error?.message ||
        "Could not start the live tour right now. Please check your AWS IVS configuration, then try again.",
    });
  }
};

// ============================================================================
// 2. GET ACTIVE TOURS FOR CURRENT HOST
// ============================================================================
/**
 * GET /api/ivs/my-active
 *
 * Optional endpoint. Add route if you want the frontend to restore active rooms
 * after refresh.
 */
export const getMyActiveTours = async (req, res) => {
  try {
    const hostId = getHostId(req);

    if (!hostId) {
      return res.status(401).json({
        success: false,
        message: "Please log in again.",
        code: "AUTH_REQUIRED",
      });
    }

    const result = await pool.query(
      `
      SELECT
        lt.*,
        l.title AS property_title,
        l.product_id,
        l.address,
        l.city,
        l.state,
        l.country
      FROM live_tours lt
      JOIN listings l ON lt.property_id = l.id
      WHERE lt.host_id = $1
        AND lt.is_live = TRUE
      ORDER BY lt.started_at DESC
      `,
      [hostId],
    );

    return res.json({
      success: true,
      tours: result.rows.map((row) => ({
        ...buildTourPayload(row),
        property_title: row.property_title,
        product_id: row.product_id,
        address: row.address,
        city: row.city,
        state: row.state,
        country: row.country,
      })),
    });
  } catch (error) {
    console.error("❌ Get My Active Tours Error:", error);

    return res.status(500).json({
      success: false,
      message: "Could not fetch active live tours.",
      code: "ACTIVE_TOURS_FETCH_FAILED",
    });
  }
};

// ============================================================================
// 3. LIVE NOW DISCOVERY - Safe public/role discovery payload
// ============================================================================
/**
 * GET /api/ivs/live-now
 */
export const getLiveNowTours = async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        lt.*,
        l.title AS property_title,
        l.product_id,
        l.address,
        l.city,
        l.state,
        l.country,
        COALESCE(u.full_name, u.name, u.email, 'A Keyvia host') AS host_name,
        u.role AS host_role,
        b.name AS brokerage_name
      FROM live_tours lt
      JOIN listings l ON lt.property_id = l.id
      LEFT JOIN users u ON lt.host_id = u.unique_id
      LEFT JOIN brokerages b ON lt.agency_id = b.id
      WHERE lt.is_live = TRUE
      ORDER BY lt.started_at DESC
      LIMIT 48
      `,
    );

    return res.json({
      success: true,
      safety_disclaimer: SAFETY_DISCLAIMER,
      platform_limitation: PLATFORM_LIMITATION,
      tours: result.rows.map((row) => ({
        ...buildTourPayload(row, {
          includeCredentials: false,
          includePlayback: false,
        }),
        property_title: row.property_title,
        product_id: row.product_id,
        address: row.address,
        city: row.city,
        state: row.state,
        country: row.country,
        host_name: row.host_name,
        host_role: row.host_role,
        brokerage_name: row.brokerage_name,
      })),
    });
  } catch (error) {
    console.error("Get Live Now Tours Error:", error);

    return res.status(500).json({
      success: false,
      message: "Could not load active live tours.",
      code: "LIVE_NOW_FETCH_FAILED",
    });
  }
};

// ============================================================================
// 4. END LIVE - Finish streaming and mark tour ended
// ============================================================================
/**
 * POST /api/ivs/end-live/:tour_id
 */
export const endLive = async (req, res) => {
  try {
    const hostId = getHostId(req);
    const { tour_id } = req.params;

    if (!hostId) {
      return res.status(401).json({
        success: false,
        message: "Please log in again.",
        code: "AUTH_REQUIRED",
      });
    }

    if (!tour_id) {
      return res.status(400).json({
        success: false,
        message: "Tour id is required.",
        code: "TOUR_ID_REQUIRED",
      });
    }

    const tourCheck = await pool.query(
      `
      SELECT *
      FROM live_tours
      WHERE id = $1
      LIMIT 1
      `,
      [tour_id],
    );

    if (tourCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Tour not found.",
        code: "TOUR_NOT_FOUND",
      });
    }

    const tour = tourCheck.rows[0];

    if (normalizeId(tour.host_id) !== normalizeId(hostId)) {
      return res.status(403).json({
        success: false,
        message: "You are not authorized to end this tour.",
        code: "END_LIVE_NOT_ALLOWED",
      });
    }

    if (tour.is_live === false) {
      return res.status(200).json({
        success: true,
        message: "This tour has already ended.",
        tour: buildTourPayload(tour),
      });
    }

    const endQuery = `
      UPDATE live_tours
      SET is_live = FALSE,
          ended_at = NOW()
      WHERE id = $1
      RETURNING *
    `;

    const result = await pool.query(endQuery, [tour_id]);
    const endedTour = result.rows[0];

    if (req.io) {
      req.io.emit("agent_ended_live", {
        agentId: hostId,
        tourId: tour_id,
        propertyId: endedTour.property_id,
        timestamp: new Date().toISOString(),
        message: "This live property tour has ended.",
      });
    }

    console.log(`✅ Tour ${tour_id} ended.`);

    return res.json({
      success: true,
      message: "Tour ended successfully.",
      tour: {
        ...buildTourPayload(endedTour),
        total_viewers: endedTour.total_viewers,
        peak_viewers: endedTour.peak_viewers,
      },
    });
  } catch (error) {
    console.error("❌ End Live Error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to end live tour.",
      code: "END_LIVE_FAILED",
    });
  }
};

// ============================================================================
// 5. GET LIVE TOUR - Fetch tour details and check viewer access
// ============================================================================
/**
 * GET /api/ivs/tour/:tour_id
 */
export const getLiveTour = async (req, res) => {
  try {
    const viewerId = getHostId(req);
    const { tour_id } = req.params;

    if (!tour_id) {
      return res.status(400).json({
        success: false,
        message: "Tour id is required.",
        code: "TOUR_ID_REQUIRED",
      });
    }

    const tourQuery = `
      SELECT
        lt.*,
        COALESCE(u.full_name, u.name, u.email, 'A Keyvia host') AS host_name,
        u.avatar_url,
        l.title AS property_title,
        l.address AS property_address,
        l.product_id,
        l.city,
        l.state,
        l.country
      FROM live_tours lt
      JOIN users u ON lt.host_id = u.unique_id
      JOIN listings l ON lt.property_id = l.id
      WHERE lt.id = $1
      LIMIT 1
    `;

    const tourResult = await pool.query(tourQuery, [tour_id]);

    if (tourResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Tour not found.",
        code: "TOUR_NOT_FOUND",
      });
    }

    const tour = tourResult.rows[0];

    let hasAccess = false;
    let userWalletBalance = 0;
    const isHost = viewerId && normalizeId(viewerId) === normalizeId(tour.host_id);

    if (viewerId) {
      if (isHost) {
        hasAccess = true;
      } else if (Number(tour.price_in_coins || 0) <= 0) {
        hasAccess = true;
      } else {
        const accessCheck = await pool.query(
          `
          SELECT id
          FROM live_tour_access
          WHERE tour_id = $1
            AND viewer_id = $2
            AND (access_expires_at IS NULL OR access_expires_at > NOW())
          LIMIT 1
          `,
          [tour_id, viewerId],
        );

        hasAccess = accessCheck.rows.length > 0;
      }

      try {
        const walletQuery = `
          SELECT COALESCE(wallet_balance, 0) AS wallet_balance
          FROM users
          WHERE unique_id = $1
          LIMIT 1
        `;

        const walletResult = await pool.query(walletQuery, [viewerId]);
        userWalletBalance = Number(walletResult.rows[0]?.wallet_balance || 0);
      } catch {
        userWalletBalance = 0;
      }
    } else if (Number(tour.price_in_coins || 0) <= 0) {
      hasAccess = true;
    }

    return res.json({
      success: true,
      tour: {
        ...buildTourPayload(tour, {
          includeCredentials: false,
          includePlayback: hasAccess,
        }),
        property_title: tour.property_title,
        property_address: tour.property_address,
        product_id: tour.product_id,
        city: tour.city,
        state: tour.state,
        country: tour.country,
        host_name: tour.host_name,
        host_avatar: tour.avatar_url,
        total_viewers: tour.total_viewers,
        peak_viewers: tour.peak_viewers,
      },
      access: {
        has_access: hasAccess,
        is_host: Boolean(isHost),
        user_wallet_balance: userWalletBalance,
        price_to_watch: Number(tour.price_in_coins || 0),
      },
    });
  } catch (error) {
    console.error("❌ Get Tour Error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch tour.",
      code: "GET_TOUR_FAILED",
    });
  }
};

// ============================================================================
// 6. REPORT LIVE TOUR - Safety/moderation foundation
// ============================================================================
/**
 * POST /api/ivs/tour/:tour_id/report
 */
export const reportLiveTour = async (req, res) => {
  try {
    const reporterId = getHostId(req);
    const { tour_id } = req.params;
    const { reason, details = "" } = req.body || {};
    const normalizedReason = String(reason || "").trim();

    if (!tour_id) {
      return res.status(400).json({
        success: false,
        message: "Tour id is required.",
        code: "TOUR_ID_REQUIRED",
      });
    }

    if (!LIVE_TOUR_REPORT_REASONS.has(normalizedReason)) {
      return res.status(400).json({
        success: false,
        message: "Choose a valid live-tour report reason.",
        code: "REPORT_REASON_REQUIRED",
      });
    }

    const tourResult = await pool.query(
      `
      SELECT
        lt.id,
        lt.property_id,
        lt.host_id,
        l.product_id,
        l.title AS property_title
      FROM live_tours lt
      LEFT JOIN listings l ON lt.property_id = l.id
      WHERE lt.id = $1
      LIMIT 1
      `,
      [tour_id],
    );

    if (tourResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Live tour not found.",
        code: "TOUR_NOT_FOUND",
      });
    }

    const tour = tourResult.rows[0];

    await pool.query(
      `
      INSERT INTO live_tour_reports (
        tour_id,
        listing_id,
        product_id,
        reporter_id,
        host_id,
        reason,
        details,
        status,
        created_at
      )
      VALUES ($1, $2, $3, $4::uuid, $5, $6, $7, 'pending', NOW())
      `,
      [
        tour_id,
        tour.property_id,
        tour.product_id,
        reporterId ? String(reporterId) : null,
        tour.host_id,
        normalizedReason,
        String(details || "").trim(),
      ],
    );

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
            pool.query(
              `
              INSERT INTO notifications
                (id, recipient_id, title, message, type, resource_type, resource_id)
              VALUES
                (gen_random_uuid(), $1, $2, $3, 'live_tour_reported', 'live_tour', $4)
              `,
              [
                admin.unique_id,
                "Live Tour Report Submitted",
                `A live-tour report was submitted for "${tour.property_title || tour_id}".`,
                tour_id,
              ],
            ),
          ),
        );
      })
      .catch((notifyErr) => {
        console.warn("Live-tour report admin notification failed:", notifyErr?.message);
      });

    return res.status(201).json({
      success: true,
      message: "Live tour report submitted for review.",
    });
  } catch (error) {
    console.error("Report Live Tour Error:", error);

    return res.status(500).json({
      success: false,
      message:
        error?.code === "42P01"
          ? "Live-tour report storage is not configured yet. Run the live-tour safety migration, then try again."
          : "Failed to submit live-tour report.",
      code: error?.code === "42P01" ? "REPORTS_TABLE_MISSING" : "REPORT_LIVE_TOUR_FAILED",
    });
  }
};

// ============================================================================
// 7. PURCHASE ACCESS - Disabled until live-tour payments pass compliance review
// ============================================================================
/**
 * POST /api/ivs/purchase-access/:tour_id
 */
export const purchaseAccess = async (req, res) => {
  return res.status(410).json({
    success: false,
    message:
      "Paid live-tour access is disabled. Keyvia does not currently collect live-tour viewer payments.",
    code: "LIVE_TOUR_PAYMENTS_DISABLED",
  });

  /*
  const client = await pool.connect();

  try {
    const viewerId = getHostId(req);
    const { tour_id } = req.params;

    if (!viewerId) {
      return res.status(401).json({
        success: false,
        message: "Please log in to purchase access.",
        code: "AUTH_REQUIRED",
      });
    }

    if (!tour_id) {
      return res.status(400).json({
        success: false,
        message: "Tour id is required.",
        code: "TOUR_ID_REQUIRED",
      });
    }

    await client.query("BEGIN");

    const tourQuery = `
      SELECT price_in_coins, host_id, is_live
      FROM live_tours
      WHERE id = $1
      FOR UPDATE
    `;

    const tourResult = await client.query(tourQuery, [tour_id]);

    if (tourResult.rows.length === 0) {
      throw Object.assign(new Error("Tour not found."), {
        statusCode: 404,
        code: "TOUR_NOT_FOUND",
      });
    }

    const tour = tourResult.rows[0];
    const priceInCoins = Number(tour.price_in_coins || 0);
    const hostId = tour.host_id;

    if (normalizeId(hostId) === normalizeId(viewerId)) {
      throw Object.assign(
        new Error("You cannot purchase access to your own tour."),
        {
          statusCode: 400,
          code: "CANNOT_BUY_OWN_TOUR",
        },
      );
    }

    if (tour.is_live === false) {
      throw Object.assign(new Error("This live tour has already ended."), {
        statusCode: 409,
        code: "TOUR_ENDED",
      });
    }

    const existingAccess = await client.query(
      `
      SELECT id
      FROM live_tour_access
      WHERE tour_id = $1
        AND viewer_id = $2
        AND (access_expires_at IS NULL OR access_expires_at > NOW())
      LIMIT 1
      `,
      [tour_id, viewerId],
    );

    if (existingAccess.rows.length > 0) {
      await client.query("COMMIT");

      return res.json({
        success: true,
        message: "You already have access to this live tour.",
        access: {
          tour_id,
          viewer_id: viewerId,
          coins_paid: 0,
          already_had_access: true,
        },
      });
    }

    if (priceInCoins <= 0) {
      await client.query(
        `
        INSERT INTO live_tour_access
          (id, tour_id, viewer_id, coin_amount_paid, access_expires_at)
        VALUES (gen_random_uuid(), $1, $2, 0, NOW() + INTERVAL '30 days')
        ON CONFLICT (tour_id, viewer_id) DO NOTHING
        `,
        [tour_id, viewerId],
      );

      await client.query("COMMIT");

      return res.json({
        success: true,
        message: "Access granted.",
        access: {
          tour_id,
          viewer_id: viewerId,
          coins_paid: 0,
        },
      });
    }

    const walletQuery = `
      SELECT COALESCE(wallet_balance, 0) AS wallet_balance
      FROM users
      WHERE unique_id = $1
      FOR UPDATE
    `;

    const walletResult = await client.query(walletQuery, [viewerId]);

    if (walletResult.rows.length === 0) {
      throw Object.assign(new Error("User not found."), {
        statusCode: 404,
        code: "USER_NOT_FOUND",
      });
    }

    const walletBalance = Number(walletResult.rows[0].wallet_balance || 0);

    if (walletBalance < priceInCoins) {
      throw Object.assign(new Error("Insufficient Keyvia Coins."), {
        statusCode: 402,
        code: "INSUFFICIENT_COINS",
      });
    }

    await client.query(
      `
      UPDATE users
      SET wallet_balance = wallet_balance - $1
      WHERE unique_id = $2
      `,
      [priceInCoins, viewerId],
    );

    await client.query(
      `
      INSERT INTO coin_transactions
        (id, user_id, amount, type, description, related_tour_id)
      VALUES
        (gen_random_uuid(), $1, $2, 'debit', 'Paid for live tour access', $3)
      `,
      [viewerId, priceInCoins, tour_id],
    );

    await client.query(
      `
      UPDATE users
      SET wallet_balance = wallet_balance + $1
      WHERE unique_id = $2
      `,
      [priceInCoins, hostId],
    );

    await client.query(
      `
      INSERT INTO coin_transactions
        (id, user_id, amount, type, description, related_tour_id)
      VALUES
        (gen_random_uuid(), $1, $2, 'credit', 'Earned from live tour viewers', $3)
      `,
      [hostId, priceInCoins, tour_id],
    );

    await client.query(
      `
      INSERT INTO live_tour_access
        (id, tour_id, viewer_id, coin_amount_paid, access_expires_at)
      VALUES
        (gen_random_uuid(), $1, $2, $3, NOW() + INTERVAL '30 days')
      ON CONFLICT (tour_id, viewer_id) DO NOTHING
      `,
      [tour_id, viewerId, priceInCoins],
    );

    await client.query("COMMIT");

    console.log(
      `✅ Viewer ${viewerId} paid ${priceInCoins} coins for tour ${tour_id}`,
    );

    return res.json({
      success: true,
      message: `Access granted. You paid ${priceInCoins} Keyvia Coins.`,
      access: {
        tour_id,
        viewer_id: viewerId,
        coins_paid: priceInCoins,
        expires_at: new Date(
          Date.now() + 30 * 24 * 60 * 60 * 1000,
        ).toISOString(),
      },
    });
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore rollback error
    }

    console.error("❌ Purchase Access Error:", error);

    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Failed to purchase live tour access.",
      code: error.code || "PURCHASE_ACCESS_FAILED",
    });
  } finally {
    client.release();
  }
  */
};

// ============================================================================
// HELPER: Notify users who saved the property
// ============================================================================
async function notifyPropertyFollowers(propertyId, propertyTitle, tourId) {
  try {
    const savedQuery = `
      SELECT DISTINCT sp.user_id, u.email, COALESCE(u.full_name, u.name, u.email) AS name
      FROM saved_properties sp
      JOIN users u ON sp.user_id = u.unique_id
      WHERE sp.property_id = $1
    `;

    const savedResult = await pool.query(savedQuery, [propertyId]);

    if (savedResult.rows.length === 0) {
      console.log("No users saved this property.");
      return;
    }

    console.log(
      `📬 Notifying ${savedResult.rows.length} users about live tour...`,
    );

    for (const user of savedResult.rows) {
      try {
        await pool.query(
          `
          INSERT INTO notifications
            (id, recipient_id, title, message, type, resource_type, resource_id)
          VALUES
            (gen_random_uuid(), $1, $2, $3, 'live_tour', 'tour', $4)
          `,
          [
            user.user_id,
            `${propertyTitle} has a live tour`,
            "A property you saved has a live tour room. Join while it is available.",
            tourId,
          ],
        );
      } catch (notificationError) {
        console.warn(
          "⚠️ Could not create live tour notification:",
          notificationError.message,
        );
      }
    }

    const emailAddresses = savedResult.rows.map((u) => u.email).filter(Boolean);

    if (emailAddresses.length > 0) {
      await sendBroadcastEmail(emailAddresses, propertyTitle, tourId);
    }
  } catch (error) {
    console.error("❌ Error notifying followers:", error);
  }
}

// ============================================================================
// HELPER: Send SES Email Broadcast
// ============================================================================
async function sendBroadcastEmail(emailAddresses, propertyTitle, tourId) {
  try {
    if (!process.env.AWS_SES_FROM_EMAIL) {
      console.warn("⚠️ AWS_SES_FROM_EMAIL is not set. Skipping SES email.");
      return;
    }

    const clientUrl = process.env.CLIENT_URL || "http://localhost:5173";
    const safeEmails = emailAddresses.filter(Boolean).slice(0, 50);

    if (safeEmails.length === 0) return;

    const emailParams = {
      Source: process.env.AWS_SES_FROM_EMAIL,
      Destination: {
        ToAddresses: safeEmails,
      },
      Message: {
        Subject: {
          Data: `LIVE NOW: ${propertyTitle} Virtual Tour`,
          Charset: "UTF-8",
        },
        Body: {
          Html: {
            Data: `
              <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #101828;">
                <h2 style="margin: 0 0 12px;">Live Property Tour</h2>
                <p>The property you saved has a live tour room available.</p>
                <p><strong>${propertyTitle}</strong></p>
                <p>
                  <a href="${clientUrl}/live-tour/${tourId}"
                     style="background: #09707D; color: white; padding: 12px 18px;
                            text-decoration: none; border-radius: 8px; display: inline-block;">
                    Join Live Tour
                  </a>
                </p>
                <p style="font-size: 13px; color: #667085;">
                  This tour may be monitored for safety, fraud prevention, and policy enforcement.
                </p>
              </div>
            `,
            Charset: "UTF-8",
          },
          Text: {
            Data: `A property you saved has a live tour: ${propertyTitle}. Join here: ${clientUrl}/live-tour/${tourId}`,
            Charset: "UTF-8",
          },
        },
      },
    };

    await sesClient.send(new SendEmailCommand(emailParams));

    console.log(`✅ SES broadcast sent to ${safeEmails.length} users.`);
  } catch (error) {
    console.error("❌ SES Email Error:", error);
  }
}

export default {
  goLive,
  getMyActiveTours,
  getLiveNowTours,
  endLive,
  getLiveTour,
  reportLiveTour,
  purchaseAccess,
};
