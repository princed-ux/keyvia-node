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
