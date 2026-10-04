import type { NetworkProvider, OrgGraphBuilder } from './types.ts';

/** Azure : types ARM (Resource Graph, en minuscules : `microsoft.network/virtualnetworks`). */
export const azureNetwork: NetworkProvider = {
  id: 'azure',
  owns: (type) => type.toLowerCase().startsWith('microsoft.'),
  extend: () => undefined,
  flows: () => [],
};

export const buildAzureOrgGraph: OrgGraphBuilder = () => null;
