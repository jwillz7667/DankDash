export type {
  NotificationChannel,
  NotificationTemplateKey,
  ProviderSendResult,
  Recipient,
  RenderedEmailNotification,
  RenderedInAppNotification,
  RenderedNotification,
  RenderedPushNotification,
  RenderedSmsNotification,
} from './types.js';
export {
  ApnsProvider,
  type ApnsProviderConfig,
  type ApnsProviderHandle,
  type NotificationProvider,
  ResendEmailProvider,
  type ResendEmailsApi,
  type ResendErrorBody,
  type ResendProviderConfig,
  type ResendSendPayload,
  type ResendSendResponse,
  TwilioSmsProvider,
  type TwilioSmsProviderConfig,
  type TwilioMessageCreateParams,
  type TwilioMessageInstance,
  type TwilioMessagesApi,
} from './providers/index.js';
export {
  TEMPLATES,
  renderTemplate,
  type Template,
  type TemplatePayloads,
  type TemplateRegistry,
} from './templates/index.js';
export {
  NOTIFICATION_CATEGORY_BY_TEMPLATE,
  SUPPRESSIBLE_CATEGORIES,
  categoryForTemplate,
  isCategorySuppressible,
  isNotificationDeliverable,
  type NotificationCategory,
  type NotificationPreferenceState,
} from './preferences.js';
