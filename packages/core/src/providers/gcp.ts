import type { NetworkProvider, OrgGraphBuilder } from './types.ts';

/** Google Cloud : types Cloud Asset Inventory (`compute.googleapis.com/Instance`). */
export const gcpNetwork: NetworkProvider = {
  id: 'gcp',
  owns: (type) => /\.googleapis\.com\//.test(type),
  extend: () => undefined,
  flows: () => [],
};

export const buildGcpOrgGraph: OrgGraphBuilder = () => null;
