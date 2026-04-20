// keyvia-node/controllers/ivsController.js
// ============================================================================
// AWS INTERACTIVE VIDEO SERVICE (IVS) - Live Property Tours
// Handles: Channel creation, stream keys, viewer access, paywall logic
// ============================================================================

import {
  IvsClient,
  CreateChannelCommand,
  CreateStreamKeyCommand,
} from "@aws-sdk/client-ivs";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { pool } from "../db.js";
import { v4 as uuidv4 } from "uuid";

const ivsClient = new IvsClient({
  region: process.env.AWS_IVS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const sesClient = new SESClient({
  region: process.env.AWS_IVS_REGION, // Assuming your SES is also verified here
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// ============================================================================
// 1. GO LIVE - Create IVS Channel for a Property Listing
// ============================================================================
/**
 * POST /api/ivs/go-live
 * Host creates a live tour for a property
 *
 * Body: { listing_id, price_in_coins }
 * Returns: { stream_key, ingest_endpoint, channel_arn }
 */
export const goLive = async (req, res) => {
  try {
    const hostId = req.user?.id;
    const { listing_id, price_in_coins = 0 } = req.body;

    if (!hostId || !listing_id) {
      return res.status(400).json({
        error: "Missing required fields: listing_id",
      });
    }

    console.log(
      `📡 Host ${hostId} attempting to go live for property ${listing_id}`,
    );

    // Verify user owns the listing
    const listingCheck = await pool.query(
      `SELECT uploaded_by_id, agency_id FROM listings WHERE id = $1`,
      [listing_id],
    );

    if (listingCheck.rows.length === 0) {
      return res.status(404).json({ error: "Listing not found" });
    }

    const { uploaded_by_id, agency_id } = listingCheck.rows[0];
    if (uploaded_by_id !== hostId) {
      return res.status(403).json({
        error: "You can only go live on your own properties",
      });
    }

    // Create AWS IVS Channel
    const channelName = `keyvia-live-${listing_id}-${Date.now()}`;
    const channelResponse = await ivsClient.send(
      new CreateChannelCommand({
        name: channelName,
        type: "STANDARD",
        authorized: false, // Public access (paywall controlled by us)
        recordingConfigurationArn:
          process.env.AWS_IVS_RECORDING_CONFIG_ARN || undefined,
      }),
    );

    const channelArn = channelResponse.channel.arn;
    const playbackUrl = channelResponse.channel.playbackUrl;

    console.log(`✅ IVS Channel created: ${channelArn}`);

    // Create Stream Key
    const streamKeyResponse = await ivsClient.send(
      new CreateStreamKeyCommand({
        channelArn: channelArn,
      }),
    );

    const streamKey = streamKeyResponse.streamKey.value;
    const ingestEndpoint = streamKeyResponse.streamKey.ingestEndpoint;

    console.log(`✅ Stream key generated for ${ingestEndpoint}`);

    // Save to live_tours table
    const tourId = uuidv4();
    const createTourQuery = `
      INSERT INTO live_tours (
        id, property_id, host_id, agency_id,
        ivs_channel_arn, ivs_stream_key, ivs_playback_url,
        ivs_ingest_endpoint, price_in_coins, is_live,
        started_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE, NOW())
      RETURNING *
    `;

    const tourResult = await pool.query(createTourQuery, [
      tourId,
      listing_id,
      hostId,
      agency_id,
      channelArn,
      streamKey,
      playbackUrl,
      ingestEndpoint,
      price_in_coins,
    ]);

    const tour = tourResult.rows[0];

    // Get the property title for notifications
    const propertyQuery = `SELECT title FROM listings WHERE id = $1`;
    const propertyResult = await pool.query(propertyQuery, [listing_id]);
    const propertyTitle = propertyResult.rows[0]?.title || "A Property";

    // Get agent name
    const agentQuery = `SELECT full_name FROM users WHERE id = $1`;
    const agentResult = await pool.query(agentQuery, [hostId]);
    const agentName = agentResult.rows[0]?.full_name || "An Agent";

    // Broadcast notifications to users who saved this property
    await notifyPropertyFollowers(listing_id, propertyTitle, tourId);

    // 🔴 SOCKET.IO: Broadcast LIVE event to ALL connected users
    if (req.io) {
      req.io.emit("agent_went_live", {
        agentId: hostId,
        agentName: agentName,
        propertyTitle: propertyTitle,
        tourId: tourId,
        timestamp: new Date().toISOString(),
        message: `🔴 ${agentName} is now live showing ${propertyTitle}! Join to watch.`,
      });
    }

    console.log(`✅ Live tour created: ${tourId}`);

    res.status(201).json({
      success: true,
      message: "You are now live!",
      tour: {
        id: tour.id,
        stream_key: streamKey,
        ingest_endpoint: ingestEndpoint,
        channel_arn: channelArn,
        playback_url: playbackUrl,
        instructions:
          "Share these credentials with OBS or your streaming software",
      },
    });
  } catch (error) {
    console.error("❌ Go Live Error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to start live tour",
      message: error.message,
    });
  }
};

// ============================================================================
// 2. END LIVE - Finish streaming and save recording
// ============================================================================
/**
 * POST /api/ivs/end-live/:tour_id
 * Host ends the live tour
 */
export const endLive = async (req, res) => {
  try {
    const hostId = req.user?.id;
    const { tour_id } = req.params;

    // Verify ownership
    const tourCheck = await pool.query(
      `SELECT host_id FROM live_tours WHERE id = $1`,
      [tour_id],
    );

    if (tourCheck.rows.length === 0) {
      return res.status(404).json({ error: "Tour not found" });
    }

    if (tourCheck.rows[0].host_id !== hostId) {
      return res.status(403).json({ error: "Not authorized to end this tour" });
    }

    // Mark as not live
    const endQuery = `
      UPDATE live_tours
      SET is_live = FALSE, ended_at = NOW()
      WHERE id = $1
      RETURNING *
    `;

    const result = await pool.query(endQuery, [tour_id]);
    const tour = result.rows[0];

    console.log(`✅ Tour ${tour_id} ended. Peak viewers: ${tour.peak_viewers}`);

    res.json({
      success: true,
      message: "Tour ended successfully",
      tour: {
        id: tour.id,
        total_viewers: tour.total_viewers,
        peak_viewers: tour.peak_viewers,
      },
    });
  } catch (error) {
    console.error("❌ End Live Error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to end live tour",
    });
  }
};

// ============================================================================
// 3. GET LIVE TOUR - Fetch tour details and check paywall
// ============================================================================
/**
 * GET /api/ivs/tour/:tour_id
 * Returns tour details and checks if viewer needs to pay
 */
export const getLiveTour = async (req, res) => {
  try {
    const viewerId = req.user?.id;
    const { tour_id } = req.params;

    // Get tour details
    const tourQuery = `
      SELECT 
        lt.*, 
        u.name as host_name, 
        u.avatar_url,
        l.title as property_title,
        l.address as property_address
      FROM live_tours lt
      JOIN users u ON lt.host_id = u.unique_id
      JOIN listings l ON lt.property_id = l.id
      WHERE lt.id = $1
    `;

    const tourResult = await pool.query(tourQuery, [tour_id]);

    if (tourResult.rows.length === 0) {
      return res.status(404).json({ error: "Tour not found" });
    }

    const tour = tourResult.rows[0];
    let hasAccess = false;
    let userWalletBalance = 0;

    // Check if viewer has access (if they're the host or have paid)
    if (viewerId) {
      if (tour.host_id === viewerId) {
        hasAccess = true;
      } else {
        const accessCheck = await pool.query(
          `SELECT id FROM live_tour_access 
           WHERE tour_id = $1 AND viewer_id = $2`,
          [tour_id, viewerId],
        );
        hasAccess = accessCheck.rows.length > 0;

        // Get user's wallet balance
        const walletQuery = `SELECT wallet_balance FROM users WHERE unique_id = $1`;
        const walletResult = await pool.query(walletQuery, [viewerId]);
        userWalletBalance = walletResult.rows[0]?.wallet_balance || 0;
      }
    }

    res.json({
      success: true,
      tour: {
        id: tour.id,
        property_title: tour.property_title,
        property_address: tour.property_address,
        host_name: tour.host_name,
        host_avatar: tour.avatar_url,
        is_live: tour.is_live,
        price_in_coins: tour.price_in_coins,
        playback_url: tour.ivs_playback_url,
        total_viewers: tour.total_viewers,
        peak_viewers: tour.peak_viewers,
      },
      access: {
        has_access: hasAccess,
        is_host: viewerId === tour.host_id,
        user_wallet_balance: userWalletBalance,
        price_to_watch: tour.price_in_coins,
      },
    });
  } catch (error) {
    console.error("❌ Get Tour Error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch tour",
    });
  }
};

// ============================================================================
// 4. PURCHASE ACCESS - Buyer pays coins to watch tour
// ============================================================================
/**
 * POST /api/ivs/purchase-access/:tour_id
 * Deduct coins from wallet and grant access to tour
 */
export const purchaseAccess = async (req, res) => {
  try {
    const viewerId = req.user?.id;
    const { tour_id } = req.params;

    if (!viewerId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    // Start transaction
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      // Get tour price
      const tourQuery = `SELECT price_in_coins, host_id FROM live_tours WHERE id = $1`;
      const tourResult = await client.query(tourQuery, [tour_id]);

      if (tourResult.rows.length === 0) {
        throw new Error("Tour not found");
      }

      const { price_in_coins, host_id } = tourResult.rows[0];

      // Can't pay to watch your own tour
      if (host_id === viewerId) {
        throw new Error("You cannot purchase access to your own tour");
      }

      // Check viewer's wallet balance
      const walletQuery = `SELECT wallet_balance FROM users WHERE unique_id = $1 FOR UPDATE`;
      const walletResult = await client.query(walletQuery, [viewerId]);

      if (walletResult.rows.length === 0) {
        throw new Error("User not found");
      }

      const { wallet_balance } = walletResult.rows[0];

      if (wallet_balance < price_in_coins) {
        throw new Error("Insufficient Keyvia Coins");
      }

      // Deduct coins from viewer
      const deductQuery = `
        UPDATE users 
        SET wallet_balance = wallet_balance - $1 
        WHERE unique_id = $2
      `;
      await client.query(deductQuery, [price_in_coins, viewerId]);

      // Record debit transaction
      await client.query(
        `INSERT INTO coin_transactions 
         (id, user_id, amount, type, description, related_tour_id)
         VALUES (gen_random_uuid(), $1, $2, 'debit', 'Paid for live tour access', $3)`,
        [viewerId, price_in_coins, tour_id],
      );

      // Add coins to host
      const creditQuery = `
        UPDATE users 
        SET wallet_balance = wallet_balance + $1 
        WHERE unique_id = $2
      `;
      await client.query(creditQuery, [price_in_coins, host_id]);

      // Record credit transaction
      await client.query(
        `INSERT INTO coin_transactions 
         (id, user_id, amount, type, description, related_tour_id)
         VALUES (gen_random_uuid(), $1, $2, 'credit', 'Earned from live tour viewers', $3)`,
        [host_id, price_in_coins, tour_id],
      );

      // Grant access
      const accessQuery = `
        INSERT INTO live_tour_access 
        (id, tour_id, viewer_id, coin_amount_paid, access_expires_at)
        VALUES (gen_random_uuid(), $1, $2, $3, NOW() + INTERVAL '30 days')
        ON CONFLICT (tour_id, viewer_id) DO NOTHING
      `;
      await client.query(accessQuery, [tour_id, viewerId, price_in_coins]);

      await client.query("COMMIT");

      console.log(
        `✅ Viewer ${viewerId} paid ${price_in_coins} coins for tour ${tour_id}`,
      );

      res.json({
        success: true,
        message: `Access granted! You paid ${price_in_coins} Keyvia Coins.`,
        access: {
          tour_id: tour_id,
          viewer_id: viewerId,
          coins_paid: price_in_coins,
          expires_at: new Date(
            Date.now() + 30 * 24 * 60 * 60 * 1000,
          ).toISOString(),
        },
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error("❌ Purchase Access Error:", error);

    const statusCode =
      error.message === "Insufficient Keyvia Coins" ? 402 : 500;
    res.status(statusCode).json({
      success: false,
      error: error.message,
    });
  }
};

// ============================================================================
// HELPER: Notify users who saved the property
// ============================================================================
async function notifyPropertyFollowers(propertyId, propertyTitle, tourId) {
  try {
    // Find all users who saved this property
    const savedQuery = `
      SELECT DISTINCT sp.user_id, u.email, u.name
      FROM saved_properties sp
      JOIN users u ON sp.user_id = u.unique_id
      WHERE sp.property_id = $1
    `;

    const savedResult = await pool.query(savedQuery, [propertyId]);

    if (savedResult.rows.length === 0) {
      console.log("No users saved this property");
      return;
    }

    console.log(
      `📬 Notifying ${savedResult.rows.length} users about live tour...`,
    );

    // Create in-app notifications
    for (const user of savedResult.rows) {
      await pool.query(
        `INSERT INTO notifications 
         (id, recipient_id, title, message, type, resource_type, resource_id)
         VALUES (gen_random_uuid(), $1, $2, $3, 'live_tour', 'tour', $4)`,
        [
          user.user_id,
          `${propertyTitle} is Live!`,
          `The property you saved is now being shown live. Click to join the tour.`,
          tourId,
        ],
      );
    }

    // Send SES emails
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
    const emailParams = {
      Source: process.env.AWS_SES_FROM_EMAIL || "noreply@keyvia.app",
      Destination: {
        ToAddresses: emailAddresses.slice(0, 50), // AWS SES batch limit
      },
      Message: {
        Subject: {
          Data: `🔴 LIVE NOW: ${propertyTitle} Virtual Tour!`,
          Charset: "UTF-8",
        },
        Body: {
          Html: {
            Data: `
              <h2>🔴 Live Property Tour Starting Now!</h2>
              <p>The property you saved is now being shown live.</p>
              <p><strong>${propertyTitle}</strong></p>
              <p>
                <a href="${process.env.CLIENT_URL}/live-tour/${tourId}" 
                   style="background: #FF6B35; color: white; padding: 12px 24px; 
                          text-decoration: none; border-radius: 6px; display: inline-block;">
                  Join Live Tour
                </a>
              </p>
              <p>This offer is only available while the tour is live.</p>
            `,
            Charset: "UTF-8",
          },
        },
      },
    };

    await sesClient.send(new SendEmailCommand(emailParams));
    console.log(`✅ SES broadcast sent to ${emailAddresses.length} users`);
  } catch (error) {
    console.error("❌ SES Email Error:", error);
  }
}

export default {
  goLive,
  endLive,
  getLiveTour,
  purchaseAccess,
};
