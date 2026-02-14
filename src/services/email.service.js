import nodemailer from "nodemailer";

const createTransporter = () => {
  // Dev-friendly default: logs emails to console when SMTP not configured
  if (!process.env.SMTP_HOST) return null;

  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === "true",
    auth: process.env.SMTP_USER
      ? {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS,
        }
      : undefined,
  });
};

export const sendEmail = async ({ email, subject, template, data }) => {
  const transporter = createTransporter();

  const text =
    template === "password-reset"
      ? `Hi ${data?.name || ""}, reset here: ${data?.resetURL}`
      : template === "email-verification"
        ? `Hi ${data?.name || ""}, verify here: ${data?.verificationUrl}`
        : JSON.stringify(data || {});

  if (!transporter) {
    // eslint-disable-next-line no-console
    console.log("[email simulated]", { to: email, subject, text });
    return;
  }

  try {
    await transporter.sendMail({
      from: process.env.EMAIL_FROM || "no-reply@parakeet-ai.local",
      to: email,
      subject,
      text,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[email failed; simulated instead]",
      String(err?.message || err)
    );
    // eslint-disable-next-line no-console
    console.log("[email simulated]", { to: email, subject, text });
  }
};
