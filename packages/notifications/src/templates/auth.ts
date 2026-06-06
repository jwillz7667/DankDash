import type { Template } from './template.js';

export const authWelcomeTemplate: Template<'auth.welcome'> = (payload) => {
  const subject = 'Welcome to DankDash';
  const text = `Hi ${payload.firstName},\n\nWelcome to DankDash. Your account is set up and you can start browsing dispensaries near you.\n\nA few quick reminders:\n  • You must be 21+ and a Minnesota resident to order.\n  • Have a valid government ID ready at delivery — we verify on every drop.\n  • Per Minnesota law, each order is capped at 56.7g flower / 8g concentrate / 800mg total edible THC.\n\nIf you ever have a question or run into trouble, just reply to this email.\n\n— The DankDash team`;
  return [
    {
      channel: 'email',
      subject,
      text,
    },
    {
      channel: 'in_app',
      title: 'Welcome to DankDash',
      body: `Hi ${payload.firstName}! Tap any dispensary to start browsing.`,
      data: { templateKey: 'auth.welcome' },
    },
  ];
};

export const authPasswordResetTemplate: Template<'auth.password_reset'> = (payload) => {
  const subject = 'Your DankDash password reset code';
  const text = `Hi,\n\nWe received a request to reset your DankDash password. Enter this code in the app to choose a new password:\n\n  ${payload.code}\n\nThis code expires in ${String(payload.expiresInMinutes)} minutes and can only be used once.\n\nIf you didn't ask to reset your password, you can safely ignore this email — your password won't change and no one can use this code without it. For your security, we never ask for this code by phone or text.\n\n— The DankDash team`;
  return [
    {
      channel: 'email',
      subject,
      text,
    },
  ];
};

export const authIdVerificationRequiredTemplate: Template<'auth.id_verification_required'> = (
  payload,
) => {
  const body = `We need to re-verify your ID before your next order. ${payload.reason}`;
  const emailText = `Hi,\n\nBefore your next DankDash order, we need to re-verify your government ID.\n\nReason: ${payload.reason}\n\nOpen the app and tap "Verify ID" on your profile to start a short Veriff session. The check takes about 90 seconds.\n\n— The DankDash team`;
  return [
    {
      channel: 'push',
      title: 'ID verification required',
      body,
      data: { templateKey: 'auth.id_verification_required' },
      contentAvailable: false,
    },
    {
      channel: 'email',
      subject: 'Re-verify your ID before your next DankDash order',
      text: emailText,
    },
  ];
};
