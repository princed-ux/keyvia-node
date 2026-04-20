// services/liveNotificationService.js
// ============================================================================
// LIVE TOUR NOTIFICATION SERVICE
// Sends notifications when agents go live
// ============================================================================

import { pool } from "../db.js";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import nodemailer from "nodemailer";

const sesClient = new SESClient({
  region: process.env.AWS_SES_REGION || "eu-west-3",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// ============================================================================
// 1. SEND LIVE NOTIFICATION VIA EMAIL
// ============================================================================
export const sendLiveNotificationEmail = async (
  agentName,
  listingTitle,
  liveUrl,
  recipientEmail,
) => {
  try {
    const params = {
      Source: process.env.SES_FROM_EMAIL || "noreply@keyvia.com",
      Destination: {
        ToAddresses: [recipientEmail],
      },
      Message: {
        Subject: {
          Data: `🔴 LIVE NOW: ${agentName} is showing ${listingTitle}`,
          Charset: "UTF-8",
        },
        Body: {
          Html: {
            Data: `
              <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: #f8f9fa; border-radius: 10px;">
                <h1 style="color: #d32f2f; margin-bottom: 20px;">🔴 Live Property Tour</h1>
                
                <p style="font-size: 16px; color: #333;">
                  <strong>${agentName}</strong> is now live showing <strong>${listingTitle}</strong>
                </p>
                
                <p style="color: #666; margin: 20px 0;">
                  Join the live tour to see the property in real-time, ask questions, and get exclusive insights!
                </p>
                
                <a href="${liveUrl}" style="display: inline-block; padding: 12px 30px; background: #d32f2f; color: white; text-decoration: none; border-radius: 5px; font-weight: bold; margin: 20px 0;">
                  Watch Live Now →
                </a>
                
                <p style="color: #999; margin-top: 30px; font-size: 12px;">
                  This is a real-time live tour. Join now to see the property and chat with the agent!
                </p>
              </div>
            `,
            Charset: "UTF-8",
          },
        },
      },
    };

    await sesClient.send(new SendEmailCommand(params));
    console.log(`✅ Live notification sent to ${recipientEmail}`);
  } catch (err) {
    console.error(`❌ Failed to send live notification email:`, err);
    // Don't throw - don't fail the main operation if email fails
  }
};

// ============================================================================
// 2. SEND PUSH NOTIFICATION VIA SOCKET.IO
// ============================================================================
export const sendLivePushNotification = (
  io,
  agentId,
  agentName,
  listingTitle,
  tourId,
) => {
  try {
    // Broadcast to all connected users
    io.emit("agent_went_live", {
      agentId,
      agentName,
      listingTitle,
      tourId,
      timestamp: new Date().toISOString(),
      message: `${agentName} is now live showing ${listingTitle}! Join the tour.`,
    });

    console.log(`✅ Live push notification sent for ${agentName}`);
  } catch (err) {
    console.error(`❌ Failed to send push notification:`, err);
  }
};

// ============================================================================
// 3. SAVE NOTIFICATION TO DATABASE
// ============================================================================
export const saveLiveNotificationToDb = async (
  agentId,
  tourId,
  recipientId,
) => {
  try {
    await pool.query(
      `INSERT INTO notifications (receiver_id, sender_id, type, title, message, related_id)
       VALUES ($1, $2, 'live_tour_started', $3, $4, $5)`,
      [
        recipientId,
        agentId,
        `Agent went live`,
        `An agent is showing a property live`,
        tourId,
      ],
    );
    console.log(`✅ Live notification saved to database`);
  } catch (err) {
    console.error(`❌ Failed to save notification:`, err);
  }
};

// ============================================================================
// 4. NOTIFY ALL FOLLOWERS WHEN AGENT GOES LIVE
// ============================================================================
export const notifyFollowersOfLive = async (
  io,
  agentId,
  agentName,
  listingTitle,
  tourId,
) => {
  try {
    // 1. Get all followers of this agent
    const followersResult = await pool.query(
      `SELECT follower_id FROM followers WHERE following_id = $1`,
      [agentId],
    );

    const followers = followersResult.rows;

    // 2. Get agent details
    const agentResult = await pool.query(
      `SELECT email, avatar_url FROM profiles WHERE unique_id = $1`,
      [agentId],
    );
    const agent = agentResult.rows[0];

    // 3. For each follower:
    for (const follower of followers) {
      // a. Get follower email
      const followerResult = await pool.query(
        `SELECT email FROM profiles WHERE unique_id = $1`,
        [follower.follower_id],
      );

      if (followerResult.rows[0]) {
        const followerEmail = followerResult.rows[0].email;

        // b. Send email notification
        const liveUrl = `${process.env.FRONTEND_URL || "http://localhost:5173"}/live/${tourId}`;
        await sendLiveNotificationEmail(
          agentName,
          listingTitle,
          liveUrl,
          followerEmail,
        );

        // c. Save to database
        await saveLiveNotificationToDb(agentId, tourId, follower.follower_id);
      }
    }

    // 4. Send real-time push notification
    sendLivePushNotification(io, agentId, agentName, listingTitle, tourId);

    console.log(`✅ Notified ${followers.length} followers about live tour`);
  } catch (err) {
    console.error(`❌ Error notifying followers:`, err);
  }
};
