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
