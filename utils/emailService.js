import nodemailer from "nodemailer";
import dotenv from "dotenv";

dotenv.config();

const { EMAIL_USER, EMAIL_PASS, CLIENT_URL } = process.env;

// Branding Assets (Same as Auth)
const LOGO_URL = "https://res.cloudinary.com/dcwpytcpc/image/upload/v1767102929/mainLogo_zfcxjf.png";
const BRAND_COLOR = "#09707D";

/* ======================================================
   📨 SMTP TRANSPORTER
   (Exact same config as your Auth file for reliability)
====================================================== */
const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587,
  secure: false,
  auth: {
    user: EMAIL_USER,
    pass: EMAIL_PASS,
  },
  family: 4, // Prevent IPv6 timeouts
  pool: true,
  maxConnections: 2,
  tls: {
    rejectUnauthorized: false,
  },
});

/* ======================================================
   🎨 HTML TEMPLATE WRAPPER
====================================================== */
const emailWrapper = (title, content) => `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { margin: 0; padding: 0; background-color: #f4f7f6; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; }
    .container { width: 100%; max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 10px rgba(0,0,0,0.05); }
    .header { background-color: #ffffff; padding: 30px 0; text-align: center; border-bottom: 1px solid #edf2f7; }
    .logo { width: 150px; height: auto; display: block; margin: 0 auto; }
    .content { padding: 40px 30px; text-align: center; color: #333333; }
    .title { color: #1a202c; font-size: 24px; font-weight: 700; margin-bottom: 20px; }
    .text { font-size: 16px; line-height: 1.6; color: #4a5568; margin-bottom: 30px; }
    .btn { background-color: ${BRAND_COLOR}; color: #ffffff !important; padding: 14px 30px; font-size: 16px; font-weight: 600; text-decoration: none; border-radius: 6px; display: inline-block; margin-top: 20px; }
    .footer { background-color: #f8fafc; padding: 20px; text-align: center; font-size: 12px; color: #94a3b8; border-top: 1px solid #edf2f7; }
    .footer a { color: ${BRAND_COLOR}; text-decoration: none; }
  </style>
</head>
<body>
  <div style="padding: 40px 0;">
    <div class="container">
      <div class="header">
        <img src="${LOGO_URL}" alt="Keyvia" class="logo" />
      </div>
      <div class="content">
        <h1 class="title">${title}</h1>
        ${content}
      </div>
      <div class="footer">
        <p>Notification from Keyvia</p>
        <p>
          Need help? <a href="${CLIENT_URL}/contact">Contact Support</a><br>
          &copy; ${new Date().getFullYear()} Keyvia. All rights reserved.
        </p>
      </div>
    </div>
  </div>
</body>
</html>
`;

/* ======================================================
   📢 PUBLIC SEND FUNCTION
   Used by applicationController.js
====================================================== */
export const sendEmailNotification = async (email, subject, message) => {
  try {
    console.log(`📧 Sending Application Email to: ${email}`);

    // Wrap the plain text message in our beautiful HTML
    const htmlContent = emailWrapper(
      "Update on your Application", // Default Header
      `<p class="text">${message}</p>
       <a href="${CLIENT_URL}/dashboard/applications" class="btn">View Application</a>`
    );

    const info = await transporter.sendMail({
      from: `"Keyvia Notifications" <${EMAIL_USER}>`,
      to: email,
      subject: subject,
      html: htmlContent,
    });

    console.log(`✅ Email sent successfully: ${info.messageId}`);
    return true;

  } catch (error) {
    console.error("❌ Email failed to send:", error.message);
    // Return false instead of throwing error so the controller continues
    return false;
  }
};

const getNotificationFromAddress = (displayName = "Keyvia Notifications") => {
  const fromAddress =
    process.env.NOTIFICATION_EMAIL_FROM ||
    process.env.NOTIFY_EMAIL_FROM ||
    process.env.ALERTS_EMAIL_FROM ||
    EMAIL_USER;

  return `"${displayName}" <${fromAddress}>`;
};

export const sendNotificationEmail = async ({
  to,
  subject,
  title,
  message,
  actionUrl = null,
  actionLabel = "Open Keyvia",
  fromName = "Keyvia Notifications",
} = {}) => {
  if (!to || !subject || !message) return false;

  try {
    const safeActionUrl = actionUrl || CLIENT_URL || "https://getkeyvia.com";
    const htmlContent = emailWrapper(
      title || subject,
      `<p class="text">${message}</p>
       <a href="${safeActionUrl}" class="btn">${actionLabel}</a>`,
    );

    const info = await transporter.sendMail({
      from: getNotificationFromAddress(fromName),
      to,
      subject,
      text: message,
      html: htmlContent,
    });

    console.log(`Keyvia notification email sent: ${info.messageId}`);
    return true;
  } catch (error) {
    console.error("Keyvia notification email failed:", error.message);
    return false;
  }
};

export const sendWelcomeRoleEmail = async ({
  email,
  name,
  role = "member",
} = {}) => {
  const displayName = name || "there";
  const normalizedRole = String(role || "member")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());

  return sendNotificationEmail({
    to: email,
    subject: "Welcome to Keyvia",
    title: `Welcome to Keyvia, ${displayName}`,
    fromName: "Keyvia",
    message: `Your ${normalizedRole} workspace is ready. You can continue your setup, manage your profile, and start using the Keyvia tools built for your role.`,
    actionUrl: `${CLIENT_URL || "https://getkeyvia.com"}/login`,
    actionLabel: "Open Keyvia",
  });
};

export const sendVerificationSubmittedEmail = async ({
  email,
  name,
  role = "account",
} = {}) => {
  const displayName = name || "there";
  const normalizedRole = String(role || "account")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());

  return sendNotificationEmail({
    to: email,
    subject: "Your Keyvia verification is under review",
    title: "Verification submitted",
    fromName: "Keyvia",
    message: `Hi ${displayName}, your ${normalizedRole} verification has been submitted. We are reviewing your account details and documents now. This can take a few minutes, and we will notify you once it is approved or if anything needs attention.`,
    actionUrl: `${CLIENT_URL || "https://getkeyvia.com"}/login`,
    actionLabel: "Open Keyvia",
  });
};

export const sendVerificationStatusEmail = async ({
  email,
  name,
  status,
  reason = null,
  role = "account",
} = {}) => {
  const normalizedStatus = String(status || "").toLowerCase();
  const approved = normalizedStatus === "verified" || normalizedStatus === "approved";
  const displayName = name || "there";
  const subject = approved
    ? "Your Keyvia verification was approved"
    : "Your Keyvia verification needs attention";
  const message = approved
    ? `Hi ${displayName}, your ${role} verification has been approved. You can now access the approved account features available to your role.`
    : `Hi ${displayName}, your ${role} verification was not approved yet.${reason ? ` Reason: ${reason}` : " Please review the reason in your dashboard and submit corrected details."}`;

  return sendNotificationEmail({
    to: email,
    subject,
    title: approved ? "Verification approved" : "Verification needs attention",
    fromName: "Keyvia",
    message,
    actionUrl: `${CLIENT_URL || "https://getkeyvia.com"}/login`,
    actionLabel: "Open Keyvia",
  });
};

/* ======================================================
   🏠 LISTING LIFECYCLE EMAILS
   (submitted / approved / rejected / brokerage review ready)
====================================================== */
const listingActionUrl = (productId) =>
  `${CLIENT_URL || "https://getkeyvia.com"}/listing/${productId}`;

export const sendListingSubmittedEmail = async ({
  email,
  name,
  listingTitle,
  productId,
} = {}) => {
  if (!email) return false;

  const displayName = name || "there";
  const title = listingTitle || "Your listing";

  return sendNotificationEmail({
    to: email,
    subject: "Your listing was submitted for review",
    title: "Listing submitted",
    fromName: "Keyvia",
    message: `Hi ${displayName}, "${title}" has been submitted and is now in review. We'll let you know as soon as it's approved or if anything needs your attention.`,
    actionUrl: productId ? listingActionUrl(productId) : null,
    actionLabel: "View listing",
  });
};

export const sendListingStatusEmail = async ({
  email,
  name,
  listingTitle,
  productId,
  status,
  reason = null,
} = {}) => {
  if (!email) return false;

  const normalizedStatus = String(status || "").toLowerCase();
  const approved =
    normalizedStatus === "approved" ||
    normalizedStatus === "published" ||
    normalizedStatus === "live";
  const rejected = normalizedStatus === "rejected";
  const displayName = name || "there";
  const title = listingTitle || "Your listing";

  let subject;
  let heading;
  let message;

  if (approved) {
    subject = "Your listing was approved";
    heading = "Listing approved";
    message = `Hi ${displayName}, great news — "${title}" has been approved and is now live on Keyvia.`;
  } else if (rejected) {
    subject = "Your listing needs attention";
    heading = "Listing not approved";
    message = `Hi ${displayName}, "${title}" was not approved.${reason ? ` Reason: ${reason}` : " Please review the details in your dashboard and resubmit."}`;
  } else {
    subject = "Update on your listing";
    heading = "Listing update";
    message = `Hi ${displayName}, the status of "${title}" changed to ${normalizedStatus || "pending"}.`;
  }

  return sendNotificationEmail({
    to: email,
    subject,
    title: heading,
    fromName: "Keyvia",
    message,
    actionUrl: productId ? listingActionUrl(productId) : null,
    actionLabel: "View listing",
  });
};

export const sendBrokerageReviewReadyEmail = async ({
  email,
  brokerageName,
  listingTitle,
  productId,
} = {}) => {
  if (!email) return false;

  const title = listingTitle || "A listing";

  return sendNotificationEmail({
    to: email,
    subject: "A listing is ready for your brokerage review",
    title: "Listing ready for review",
    fromName: "Keyvia",
    message: `${brokerageName ? `${brokerageName},` : "Hello,"} "${title}" has passed Keyvia review and is awaiting your brokerage approval.`,
    actionUrl: productId
      ? `${CLIENT_URL || "https://getkeyvia.com"}/brokerage/dashboard`
      : `${CLIENT_URL || "https://getkeyvia.com"}/brokerage/dashboard`,
    actionLabel: "Review listing",
  });
};

/* ======================================================
   💳 SUBSCRIPTION BILLING EMAILS (receipt + refund)
====================================================== */
const formatMoney = (amount, currency) => {
  const value = Number(amount || 0);
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: String(currency || "USD").toUpperCase(),
      maximumFractionDigits: 0,
    }).format(value);
  } catch {
    return `${String(currency || "").toUpperCase()} ${value.toLocaleString()}`;
  }
};

const formatLongDate = (value) => {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
};

const receiptTable = (rows) => `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:12px 0 24px;">
    ${rows
      .filter(Boolean)
      .map(
        ([label, value]) => `
      <tr>
        <td style="padding:10px 0;border-bottom:1px solid #edf2f7;color:#64748b;font-size:14px;text-align:left;">${label}</td>
        <td style="padding:10px 0;border-bottom:1px solid #edf2f7;color:#1a202c;font-size:14px;font-weight:600;text-align:right;">${value}</td>
      </tr>`,
      )
      .join("")}
  </table>`;

export const sendSubscriptionReceiptEmail = async ({
  email,
  name,
  planName,
  amount,
  currency,
  reference,
  periodEnd,
  billingPath = "/dashboard/subscription",
} = {}) => {
  if (!email) return false;

  try {
    const displayName = name || "there";
    const link = `${CLIENT_URL || "https://getkeyvia.com"}${billingPath}`;
    const content = `
      <p class="text" style="text-align:left;">Hi ${displayName}, your payment was received and your <strong>${planName || "Keyvia"}</strong> plan is now active. Here is your receipt:</p>
      ${receiptTable([
        ["Plan", planName || "—"],
        ["Amount paid", formatMoney(amount, currency)],
        ["Billing reference", reference || "—"],
        ["Date", formatLongDate()],
        ["Renews / expires", periodEnd ? formatLongDate(periodEnd) : "—"],
        ["Status", "Active"],
      ])}
      <p class="text" style="text-align:left;font-size:13px;color:#94a3b8;">Keep this reference for your records. You can view and print this receipt anytime from your billing page.</p>
      <a href="${link}" class="btn">View billing &amp; receipt</a>`;

    const info = await transporter.sendMail({
      from: `"Keyvia Billing" <${EMAIL_USER}>`,
      to: email,
      subject: `Payment received — ${planName || "Keyvia"} (${reference || "receipt"})`,
      html: emailWrapper("Payment receipt", content),
    });

    console.log(`Keyvia subscription receipt email sent: ${info.messageId}`);
    return true;
  } catch (error) {
    console.error("Subscription receipt email failed:", error.message);
    return false;
  }
};

/* ======================================================
   🏠 NEW OFFER RECEIVED (agent / owner)
====================================================== */
export const sendNewOfferEmail = async ({
  email, name, propertyTitle, offerAmount, currency = "NGN",
  buyerName, offerType = "purchase", actionUrl = null,
} = {}) => {
  if (!email) return false;
  const displayName = name || "there";
  const sym = currency === "NGN" ? "₦" : currency === "GBP" ? "£" : currency === "EUR" ? "€" : "$";
  const formatted = `${sym}${Number(offerAmount || 0).toLocaleString()}`;
  const link = actionUrl || `${CLIENT_URL || "https://getkeyvia.com"}/dashboard/applications`;

  return sendNotificationEmail({
    to: email,
    subject: `New ${offerType} offer on "${propertyTitle || "your listing"}"`,
    title: "You received a new offer",
    fromName: "Keyvia Marketplace",
    message: `Hi ${displayName}, ${buyerName || "A buyer"} has submitted a ${offerType} offer of <strong>${formatted}</strong> on <strong>"${propertyTitle || "your listing"}"</strong>. Review the offer and respond in your dashboard.`,
    actionUrl: link,
    actionLabel: "Review Offer",
  });
};

/* ======================================================
   💬 OFFER RESPONSE (buyer receives accept/reject/counter)
====================================================== */
export const sendOfferResponseEmail = async ({
  email, name, propertyTitle, offerAmount, currency = "NGN",
  responseType = "accepted", counterAmount = null, actionUrl = null,
} = {}) => {
  if (!email) return false;
  const displayName = name || "there";
  const sym = currency === "NGN" ? "₦" : currency === "GBP" ? "£" : currency === "EUR" ? "€" : "$";
  const formatted = `${sym}${Number(offerAmount || 0).toLocaleString()}`;
  const link = actionUrl || `${CLIENT_URL || "https://getkeyvia.com"}/buyer/offers`;

  const responseMessages = {
    accepted: `Great news, ${displayName}! Your offer of <strong>${formatted}</strong> on <strong>"${propertyTitle || "the property"}"</strong> has been <strong>accepted</strong>. Log in to proceed with next steps.`,
    rejected: `Hi ${displayName}, your offer of <strong>${formatted}</strong> on <strong>"${propertyTitle || "the property"}"</strong> was not accepted this time. You can submit a new offer or continue browsing.`,
    countered: `Hi ${displayName}, the seller has countered your offer on <strong>"${propertyTitle || "the property"}"</strong>${counterAmount ? ` with a new price of <strong>${sym}${Number(counterAmount).toLocaleString()}</strong>` : ""}. Review and respond in your dashboard.`,
    withdrawn: `Hi ${displayName}, an offer on <strong>"${propertyTitle || "the property"}"</strong> has been withdrawn.`,
  };

  const subjectMap = {
    accepted: `Your offer was accepted — "${propertyTitle || "property"}"`,
    rejected: `Offer update on "${propertyTitle || "property"}"`,
    countered: `Counter-offer received on "${propertyTitle || "property"}"`,
    withdrawn: `Offer withdrawn on "${propertyTitle || "property"}"`,
  };

  return sendNotificationEmail({
    to: email,
    subject: subjectMap[responseType] || `Offer update on "${propertyTitle || "property"}"`,
    title: responseType === "accepted" ? "Offer accepted!" : responseType === "countered" ? "Counter-offer received" : "Offer update",
    fromName: "Keyvia Marketplace",
    message: responseMessages[responseType] || `Your offer status has changed to: ${responseType}.`,
    actionUrl: link,
    actionLabel: "View Offer",
  });
};

/* ======================================================
   📅 TOUR REQUEST RECEIVED (agent / owner)
====================================================== */
export const sendTourRequestEmail = async ({
  email, name, propertyTitle, buyerName, tourType = "in-person",
  preferredDate = null, preferredTime = null, actionUrl = null,
} = {}) => {
  if (!email) return false;
  const displayName = name || "there";
  const link = actionUrl || `${CLIENT_URL || "https://getkeyvia.com"}/dashboard`;
  const dateInfo = [preferredDate, preferredTime].filter(Boolean).join(" at ");

  return sendNotificationEmail({
    to: email,
    subject: `Tour request for "${propertyTitle || "your listing"}"`,
    title: "New tour request",
    fromName: "Keyvia Marketplace",
    message: `Hi ${displayName}, <strong>${buyerName || "A buyer"}</strong> has requested a <strong>${tourType}</strong> tour of <strong>"${propertyTitle || "your listing"}"</strong>${dateInfo ? ` on <strong>${dateInfo}</strong>` : ""}. Log in to confirm or reschedule.`,
    actionUrl: link,
    actionLabel: "View Request",
  });
};

/* ======================================================
   ✉️ NEW MESSAGE RECEIVED
====================================================== */
export const sendNewMessageEmail = async ({
  email, name, senderName, messagePreview = null, actionUrl = null,
} = {}) => {
  if (!email) return false;
  const displayName = name || "there";
  const link = actionUrl || `${CLIENT_URL || "https://getkeyvia.com"}/dashboard/messages`;
  const preview = messagePreview
    ? `<blockquote style="border-left:3px solid #09707d;margin:16px 0;padding:8px 16px;color:#64748b;font-style:italic;">${String(messagePreview).slice(0, 120)}${messagePreview.length > 120 ? "…" : ""}</blockquote>`
    : "";

  return sendNotificationEmail({
    to: email,
    subject: `New message from ${senderName || "a Keyvia member"}`,
    title: "You have a new message",
    fromName: "Keyvia",
    message: `Hi ${displayName}, <strong>${senderName || "Someone"}</strong> sent you a message on Keyvia.${preview ? " Here's a preview:" : ""}${preview}`,
    actionUrl: link,
    actionLabel: "Open Message",
  });
};

/* ======================================================
   📋 APPLICATION RECEIVED (rich version — agent / owner)
====================================================== */
export const sendApplicationReceivedEmail = async ({
  email, name, applicantName, propertyTitle, moveInDate = null, actionUrl = null,
} = {}) => {
  if (!email) return false;
  const displayName = name || "there";
  const link = actionUrl || `${CLIENT_URL || "https://getkeyvia.com"}/dashboard/applications`;

  return sendNotificationEmail({
    to: email,
    subject: `New application for "${propertyTitle || "your listing"}"`,
    title: "New application received",
    fromName: "Keyvia Marketplace",
    message: `Hi ${displayName}, <strong>${applicantName || "A prospective tenant"}</strong> has submitted an application for <strong>"${propertyTitle || "your listing"}"</strong>${moveInDate ? ` with a preferred move-in date of <strong>${moveInDate}</strong>` : ""}. Review their details and respond.`,
    actionUrl: link,
    actionLabel: "Review Application",
  });
};

/* ======================================================
   📋 APPLICATION STATUS UPDATE (rich version — buyer)
====================================================== */
export const sendApplicationStatusEmail = async ({
  email, name, propertyTitle, status, actionUrl = null,
} = {}) => {
  if (!email) return false;
  const displayName = name || "there";
  const link = actionUrl || `${CLIENT_URL || "https://getkeyvia.com"}/buyer/applications`;
  const statusDisplay = String(status || "updated").replaceAll("_", " ");

  const isGood = ["approved", "accepted", "viewing_scheduled"].includes(status);
  const message = isGood
    ? `Hi ${displayName}, your application for <strong>"${propertyTitle || "the property"}"</strong> has been <strong>${statusDisplay}</strong>. Log in to see the next steps.`
    : `Hi ${displayName}, there's an update on your application for <strong>"${propertyTitle || "the property"}"</strong>. Status: <strong>${statusDisplay}</strong>. Log in to review.`;

  return sendNotificationEmail({
    to: email,
    subject: `Application update: ${statusDisplay} — "${propertyTitle || "property"}"`,
    title: isGood ? `Application ${statusDisplay}!` : "Application update",
    fromName: "Keyvia Marketplace",
    message,
    actionUrl: link,
    actionLabel: "View Application",
  });
};

export const sendSubscriptionRefundEmail = async ({
  email,
  name,
  planName,
  amount,
  currency,
  reference,
  reason = null,
  billingPath = "/dashboard/subscription",
} = {}) => {
  if (!email) return false;

  try {
    const displayName = name || "there";
    const link = `${CLIENT_URL || "https://getkeyvia.com"}${billingPath}`;
    const content = `
      <p class="text" style="text-align:left;">Hi ${displayName}, we could not confirm your <strong>${planName || "Keyvia"}</strong> subscription payment, so we have <strong>automatically refunded</strong> you. No plan was activated.</p>
      ${receiptTable([
        ["Plan attempted", planName || "—"],
        ["Amount refunded", formatMoney(amount, currency)],
        ["Billing reference", reference || "—"],
        ["Date", formatLongDate()],
        reason ? ["Reason", reason] : null,
      ])}
      <p class="text" style="text-align:left;font-size:13px;color:#94a3b8;">Refunds can take a few business days to reflect, depending on your bank. You can try again anytime.</p>
      <a href="${link}" class="btn">Back to billing</a>`;

    const info = await transporter.sendMail({
      from: `"Keyvia Billing" <${EMAIL_USER}>`,
      to: email,
      subject: `Refund issued — ${planName || "Keyvia"} (${reference || ""})`,
      html: emailWrapper("Refund issued", content),
    });

    console.log(`Keyvia subscription refund email sent: ${info.messageId}`);
    return true;
  } catch (error) {
    console.error("Subscription refund email failed:", error.message);
    return false;
  }
};
