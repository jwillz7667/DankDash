import { formatMilesShort, formatMinutes, formatOrderShort } from './format.js';
import type { Template } from './template.js';

export const dispatchOfferTemplate: Template<'dispatch.offer'> = (payload) => {
  const distance = formatMilesShort(payload.distanceMiles);
  const expiresIn = formatMinutes(Math.ceil(payload.expiresInSeconds / 60));
  const body = `${payload.dispensaryName} • ${distance} • respond in ${expiresIn}`;
  return [
    {
      channel: 'push',
      title: 'New delivery offer',
      body,
      data: {
        templateKey: 'dispatch.offer',
        offerId: payload.offerId,
        orderId: payload.orderId,
      },
      // Driver app needs the alert sound + lock-screen banner — this is
      // a primary attention event, not a background hint.
      contentAvailable: false,
      // One offer per order, but offers can supersede each other if a
      // driver declines and the round-robin moves on; collapsing on
      // orderId keeps a single lock-screen entry per order.
      collapseId: `offer-${payload.orderId}`,
    },
  ];
};

export const dispatchOfferExpiredTemplate: Template<'dispatch.offer_expired'> = (payload) => {
  const short = formatOrderShort(payload.orderId);
  // Silent push — the driver app re-fetches the queue, no banner.
  return [
    {
      channel: 'push',
      title: 'Offer expired',
      body: `The offer for ${short} expired.`,
      data: {
        templateKey: 'dispatch.offer_expired',
        offerId: payload.offerId,
        orderId: payload.orderId,
      },
      contentAvailable: true,
      collapseId: `offer-${payload.orderId}`,
    },
  ];
};

export const dispatchCanceledTemplate: Template<'dispatch.canceled'> = (payload) => {
  const short = formatOrderShort(payload.orderId);
  const body = `Order ${short} was canceled. Reason: ${payload.reason}`;
  return [
    {
      channel: 'push',
      title: 'Delivery canceled',
      body,
      data: {
        templateKey: 'dispatch.canceled',
        orderId: payload.orderId,
      },
      contentAvailable: false,
      collapseId: `order-${payload.orderId}`,
    },
  ];
};
