// routes/notificationsSystem.js
// ============================================================================
// NOTIFICATIONS SYSTEM - Database-backed, WebSocket-enabled
// Triggers: Account approval, agent joins, listing published, etc.
// ============================================================================

import express from 'express';
import { pool } from '../db.js';
import { v4 as uuidv4 } from 'uuid';

const router = express.Router();

/**
 * ============================================================================
 * 1. GET ALL NOTIFICATIONS FOR USER
 * ============================================================================
 * GET /api/notifications
 * Returns: Array of notifications for authenticated user (unread first)
 */
router.get('/', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'] || req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { rows } = await pool.query(
      `SELECT id, type, title, message, related_resource_type, related_resource_id,
              data, is_read, action_url, action_label, created_at
       FROM notifications
       WHERE recipient_id = $1
       ORDER BY is_read ASC, created_at DESC
       LIMIT 50`,
      [userId]
    );

    res.json({ notifications: rows });
  } catch (error) {
    console.error('❌ Get Notifications Error:', error);
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

/**
 * ============================================================================
 * 2. GET UNREAD COUNT
 * ============================================================================
 * GET /api/notifications/unread-count
 */
router.get('/unread-count', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'] || req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { rows } = await pool.query(
      `SELECT COUNT(*) as count FROM notifications 
       WHERE recipient_id = $1 AND is_read = false`,
      [userId]
    );

    res.json({ unread_count: parseInt(rows[0].count) });
  } catch (error) {
    console.error('❌ Unread Count Error:', error);
    res.status(500).json({ error: 'Failed to fetch unread count' });
  }
});

/**
 * ============================================================================
 * 3. MARK NOTIFICATION AS READ
 * ============================================================================
 * PATCH /api/notifications/:id/read
 */
router.patch('/:id/read', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.headers['x-user-id'] || req.user?.id;

    // Verify ownership
    const check = await pool.query(
      `SELECT recipient_id FROM notifications WHERE id = $1`,
      [id]
    );

    if (check.rows.length === 0 || check.rows[0].recipient_id !== userId) {
      return res.status(404).json({ error: 'Notification not found' });
    }

    // Mark as read
    const { rows } = await pool.query(
      `UPDATE notifications SET is_read = true, read_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id]
    );

    res.json({ notification: rows[0] });
  } catch (error) {
    console.error('❌ Mark Read Error:', error);
    res.status(500).json({ error: 'Failed to mark notification as read' });
  }
});

/**
 * ============================================================================
 * 4. MARK ALL AS READ
 * ============================================================================
 * PATCH /api/notifications/mark-all-read
 */
router.patch('/mark-all/read', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'] || req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    await pool.query(
      `UPDATE notifications SET is_read = true, read_at = NOW()
       WHERE recipient_id = $1 AND is_read = false`,
      [userId]
    );

    res.json({ success: true, message: 'All notifications marked as read' });
  } catch (error) {
    console.error('❌ Mark All Read Error:', error);
    res.status(500).json({ error: 'Failed to mark all as read' });
  }
});

/**
 * ============================================================================
 * 5. DELETE NOTIFICATION
 * ============================================================================
 * DELETE /api/notifications/:id
 */
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.headers['x-user-id'] || req.user?.id;

    // Verify ownership
    const check = await pool.query(
      `SELECT recipient_id FROM notifications WHERE id = $1`,
      [id]
    );

    if (check.rows.length === 0 || check.rows[0].recipient_id !== userId) {
      return res.status(404).json({ error: 'Notification not found' });
    }

    await pool.query(`DELETE FROM notifications WHERE id = $1`, [id]);

    res.json({ success: true, message: 'Notification deleted' });
  } catch (error) {
    console.error('❌ Delete Notification Error:', error);
    res.status(500).json({ error: 'Failed to delete notification' });
  }
});

/**
 * ============================================================================
 * NOTIFICATION CREATION HELPERS (Called from other routes)
 * ============================================================================
 */

/**
 * Helper: Create notification
 */
export async function createNotification(
  recipientId,
  type,
  title,
  message,
  data = {},
  actionUrl = null,
  actionLabel = null,
  relatedResourceType = null,
  relatedResourceId = null
) {
  try {
    const id = uuidv4();

    await pool.query(
      `INSERT INTO notifications 
       (id, recipient_id, type, title, message, data, action_url, action_label,
        related_resource_type, related_resource_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        id,
        recipientId,
        type,
        title,
        message,
        JSON.stringify(data),
        actionUrl,
        actionLabel,
        relatedResourceType,
        relatedResourceId,
      ]
    );

    console.log(`✅ Notification created: ${type} for user ${recipientId}`);
    return id;
  } catch (error) {
    console.error('❌ Create Notification Error:', error);
    throw error;
  }
}

/**
 * Helper: Notify BrokerageOwner of agent join request
 */
export async function notifyAgentJoinRequest(
  brokerageOwnerId,
  agentId,
  agentName,
  agentEmail
) {
  try {
    const message = `${agentName} has requested to join your brokerage. Review their profile and approve or decline.`;

    await createNotification(
      brokerageOwnerId,
      'agent_join_request',
      'New Agent Join Request',
      message,
      { agent_id: agentId, agent_email: agentEmail },
      `/brokerage/agents`, // Action URL
      'View Requests',
      'user',
      agentId
    );
  } catch (error) {
    console.error('❌ Notify Agent Join Request Error:', error);
  }
}

/**
 * Helper: Notify Agent of brokerage approval
 */
export async function notifyBrokerageApproval(
  agentId,
  brokerageName,
  brokerageId
) {
  try {
    const message = `Congratulations! You've been approved to join ${brokerageName}. Start exploring available properties.`;

    await createNotification(
      agentId,
      'brokerage_approval_confirmed',
      'Brokerage Approval Confirmed',
      message,
      { brokerage_id: brokerageId, brokerage_name: brokerageName },
      `/dashboard`,
      'View Dashboard',
      'brokerage',
      brokerageId
    );
  } catch (error) {
    console.error('❌ Notify Brokerage Approval Error:', error);
  }
}

/**
 * Helper: Notify User of account approval/rejection
 */
export async function notifyAccountStatus(
  userId,
  isApproved,
  reason = null
) {
  try {
    const type = isApproved ? 'account_approval' : 'account_rejection';
    const title = isApproved ? 'Account Approved! 🎉' : 'Account Approval Pending';
    const message = isApproved
      ? 'Your account has been approved. Welcome to Keyvia! Start listing properties or browsing available options.'
      : reason ||
        'Your account is under review. We'll notify you once the review is complete.';

    await createNotification(
      userId,
      type,
      title,
      message,
      { approved: isApproved },
      `/dashboard`,
      'Get Started',
      'user',
      userId
    );
  } catch (error) {
    console.error('❌ Notify Account Status Error:', error);
  }
}

/**
 * Helper: Notify users when listing published
 */
export async function notifyListingPublished(
  listingId,
  listingTitle,
  brokerageId
) {
  try {
    // Notify all agents in brokerage
    const { rows: agents } = await pool.query(
      `SELECT id FROM users WHERE brokerage_id = $1 AND role = 'AgencyAgent'`,
      [brokerageId]
    );

    for (const agent of agents) {
      await createNotification(
        agent.id,
        'listing_published',
        'New Listing Published',
        `A new property "${listingTitle}" has been published by your brokerage.`,
        { listing_title: listingTitle },
        `/listings/${listingId}`,
        'View Listing',
        'listing',
        listingId
      );
    }

    console.log(`✅ Published notification sent to ${agents.length} agents`);
  } catch (error) {
    console.error('❌ Notify Listing Published Error:', error);
  }
}

/**
 * Helper: Notify admin of flagged listing
 */
export async function notifyListingFlagged(
  listingId,
  listingTitle,
  flagReason
) {
  try {
    // Find all admins
    const { rows: admins } = await pool.query(
      `SELECT id FROM users WHERE role = 'Admin'`
    );

    for (const admin of admins) {
      await createNotification(
        admin.id,
        'listing_flagged',
        'Listing Flagged for Review',
        `Listing "${listingTitle}" has been flagged for review: ${flagReason}`,
        { listing_title: listingTitle, flag_reason: flagReason },
        `/admin/listings/flagged`,
        'Review Listing',
        'listing',
        listingId
      );
    }

    console.log(`✅ Flag notification sent to ${admins.length} admins`);
  } catch (error) {
    console.error('❌ Notify Listing Flagged Error:', error);
  }
}

export default router;
