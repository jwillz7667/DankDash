import { formatMinutes, formatOrderShort, formatUsdCents } from './format.js';
import type { RenderedNotification } from '../types.js';
import type { Template } from './template.js';

export const orderAcceptedTemplate: Template<'order.accepted'> = (payload) => {
  const short = formatOrderShort(payload.orderId);
  const etaSuffix =
    payload.etaMinutes !== undefined
      ? ` Estimated ready in ${formatMinutes(payload.etaMinutes)}.`
      : '';
  const body = `${payload.dispensaryName} accepted your order ${short}.${etaSuffix}`;
  const rendered: ReadonlyArray<RenderedNotification> = [
    {
      channel: 'push',
      title: 'Order accepted',
      body,
      data: { templateKey: 'order.accepted', orderId: payload.orderId },
      contentAvailable: false,
      collapseId: `order-${payload.orderId}`,
    },
    {
      channel: 'in_app',
      title: 'Order accepted',
      body,
      data: { templateKey: 'order.accepted', orderId: payload.orderId },
    },
  ];
  return rendered;
};

export const orderPreppingTemplate: Template<'order.prepping'> = (payload) => {
  const short = formatOrderShort(payload.orderId);
  const body = `${payload.dispensaryName} is preparing your order ${short}.`;
  return [
    {
      channel: 'push',
      title: 'Order being prepared',
      body,
      data: { templateKey: 'order.prepping', orderId: payload.orderId },
      contentAvailable: false,
      collapseId: `order-${payload.orderId}`,
    },
    {
      channel: 'in_app',
      title: 'Order being prepared',
      body,
      data: { templateKey: 'order.prepping', orderId: payload.orderId },
    },
  ];
};

export const orderReadyTemplate: Template<'order.ready'> = (payload) => {
  const short = formatOrderShort(payload.orderId);
  const body = `Your order ${short} from ${payload.dispensaryName} is ready and waiting for a driver.`;
  return [
    {
      channel: 'push',
      title: 'Order ready',
      body,
      data: { templateKey: 'order.ready', orderId: payload.orderId },
      contentAvailable: false,
      collapseId: `order-${payload.orderId}`,
    },
    {
      channel: 'in_app',
      title: 'Order ready',
      body,
      data: { templateKey: 'order.ready', orderId: payload.orderId },
    },
  ];
};

export const orderPickedUpTemplate: Template<'order.picked_up'> = (payload) => {
  const short = formatOrderShort(payload.orderId);
  const body = `${payload.driverFirstName} picked up your order ${short} and is heading your way.`;
  return [
    {
      channel: 'push',
      title: 'Driver on the way',
      body,
      data: {
        templateKey: 'order.picked_up',
        orderId: payload.orderId,
        driverFirstName: payload.driverFirstName,
      },
      contentAvailable: false,
      collapseId: `order-${payload.orderId}`,
    },
    {
      channel: 'sms',
      body: `DankDash: ${payload.driverFirstName} picked up order ${short} and is heading your way. Reply STOP to opt out.`,
    },
  ];
};

export const orderArrivingTemplate: Template<'order.arriving'> = (payload) => {
  const short = formatOrderShort(payload.orderId);
  const eta = formatMinutes(payload.etaMinutes);
  const body = `${payload.driverFirstName} is ${eta} away with your order ${short}.`;
  return [
    {
      channel: 'push',
      title: 'Almost there',
      body,
      data: {
        templateKey: 'order.arriving',
        orderId: payload.orderId,
        etaMinutes: String(payload.etaMinutes),
      },
      contentAvailable: false,
      // Collapse so progressive ETAs replace each other on the lock
      // screen instead of stacking — the only one that matters is the
      // most recent ETA.
      collapseId: `order-${payload.orderId}`,
    },
    {
      channel: 'sms',
      body: `DankDash: ${payload.driverFirstName} is ${eta} away with order ${short}. Reply STOP to opt out.`,
    },
  ];
};

export const orderArrivedTemplate: Template<'order.arrived'> = (payload) => {
  const short = formatOrderShort(payload.orderId);
  const body = `${payload.driverFirstName} has arrived with your order ${short}. Have your ID ready.`;
  return [
    {
      channel: 'push',
      title: 'Driver has arrived',
      body,
      data: { templateKey: 'order.arrived', orderId: payload.orderId },
      contentAvailable: false,
      collapseId: `order-${payload.orderId}`,
    },
    {
      channel: 'sms',
      body: `DankDash: ${payload.driverFirstName} has arrived with order ${short}. Please have your ID ready. Reply STOP to opt out.`,
    },
  ];
};

export const orderCompletedTemplate: Template<'order.completed'> = (payload) => {
  const short = formatOrderShort(payload.orderId);
  const total = formatUsdCents(payload.totalCents);
  const body = `Order ${short} for ${total} delivered. Thanks for ordering with DankDash!`;
  const emailBody = `Thanks for your order!\n\nYour order ${short} totaling ${total} was delivered successfully.\n\nYour receipt is attached to your account; tap the Orders tab in the app for full details.\n\n— The DankDash team`;
  return [
    {
      channel: 'push',
      title: 'Delivered',
      body,
      data: { templateKey: 'order.completed', orderId: payload.orderId },
      contentAvailable: false,
      collapseId: `order-${payload.orderId}`,
    },
    {
      channel: 'in_app',
      title: 'Delivered',
      body,
      data: { templateKey: 'order.completed', orderId: payload.orderId },
    },
    {
      channel: 'email',
      subject: `Your DankDash order ${short} was delivered`,
      text: emailBody,
    },
  ];
};

export const paymentFailedTemplate: Template<'payment.failed'> = (payload) => {
  const short = formatOrderShort(payload.orderId);
  const amount = formatUsdCents(payload.amountCents);
  const body = `Payment failed for order ${short} (${amount}). Open the app to retry.`;
  const emailText = `Payment of ${amount} for order ${short} could not be charged.\n\nReason: ${payload.reason}\n\nOpen the DankDash app to update your payment method and try again — your order is held until the charge succeeds.`;
  return [
    {
      channel: 'push',
      title: 'Payment failed',
      body,
      data: { templateKey: 'payment.failed', orderId: payload.orderId },
      contentAvailable: false,
      collapseId: `payment-${payload.orderId}`,
    },
    {
      channel: 'email',
      subject: `Action needed: payment failed for order ${short}`,
      text: emailText,
    },
  ];
};

export const refundIssuedTemplate: Template<'refund.issued'> = (payload) => {
  const short = formatOrderShort(payload.orderId);
  const amount = formatUsdCents(payload.amountCents);
  const body = `A ${amount} refund for order ${short} was issued and will appear on your statement in 3–5 business days.`;
  const emailText = `We've issued a ${amount} refund for order ${short}.\n\nReason: ${payload.reason}\n\nIt should appear on your original payment method within 3–5 business days.`;
  return [
    {
      channel: 'push',
      title: 'Refund issued',
      body,
      data: { templateKey: 'refund.issued', orderId: payload.orderId },
      contentAvailable: false,
      collapseId: `refund-${payload.orderId}`,
    },
    {
      channel: 'email',
      subject: `Refund issued for order ${short}`,
      text: emailText,
    },
  ];
};
