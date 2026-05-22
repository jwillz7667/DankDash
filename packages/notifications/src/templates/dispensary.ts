import { formatMilesShort } from './format.js';
import type { Template } from './template.js';

export const dispensaryNewNearbyTemplate: Template<'dispensary.new_nearby'> = (payload) => {
  const distance = formatMilesShort(payload.distanceMiles);
  const body = `${payload.dispensaryName} just opened ${distance} away — tap to explore their menu.`;
  return [
    {
      channel: 'push',
      title: 'New dispensary nearby',
      body,
      data: {
        templateKey: 'dispensary.new_nearby',
        dispensaryId: payload.dispensaryId,
      },
      contentAvailable: false,
      collapseId: `dispensary-${payload.dispensaryId}`,
    },
    {
      channel: 'in_app',
      title: 'New dispensary nearby',
      body,
      data: {
        templateKey: 'dispensary.new_nearby',
        dispensaryId: payload.dispensaryId,
      },
    },
  ];
};
