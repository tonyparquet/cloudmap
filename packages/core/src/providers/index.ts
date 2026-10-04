import { buildAzureOrgGraph, azureNetwork } from './azure.ts';
import { buildGcpOrgGraph, gcpNetwork } from './gcp.ts';
import type { CloudProvider, NetworkProvider, OrgGraphBuilder } from './types.ts';

export * from './types.ts';

/** Fournisseurs hors AWS (AWS : modèle réseau, groupes de sécurité et Organizations historiques). */
export const NETWORK_PROVIDERS: NetworkProvider[] = [azureNetwork, gcpNetwork];
export const ORG_GRAPH_BUILDERS: OrgGraphBuilder[] = [buildAzureOrgGraph, buildGcpOrgGraph];

/** Fournisseur d'un type de ressource (AWS par défaut, y compris les nœuds externes). */
export function providerOfType(type: string): CloudProvider {
  return NETWORK_PROVIDERS.find((p) => p.owns(type))?.id ?? 'aws';
}

const ACCOUNT_ID: Record<CloudProvider, [RegExp, string]> = {
  aws: [/^\d{12}$/, 'ID de compte AWS : 12 chiffres'],
  azure: [
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    "ID d'abonnement Azure : GUID (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)",
  ],
  gcp: [/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/, 'ID de projet Google Cloud : 6 à 30 caractères (a-z, 0-9, -)'],
};
const REGION: Record<CloudProvider, [RegExp, string]> = {
  aws: [/^[a-z]{2}(-[a-z]+)+-\d{1,2}$/, 'Région AWS invalide (ex. eu-west-3)'],
  azure: [/^[a-z][a-z0-9]{2,40}$/, 'Région Azure invalide (ex. francecentral)'],
  gcp: [/^[a-z]+-[a-z]+\d{1,2}$/, 'Région Google Cloud invalide (ex. europe-west9)'],
};

/** Contrôles propres au fournisseur (ID de compte, régions) : liste des problèmes, vide si valide. */
export function providerIdProblems(p: {
  provider?: CloudProvider;
  accountId: string;
  regions: string[];
}): string[] {
  const provider = p.provider ?? 'aws';
  const [idRe, idMsg] = ACCOUNT_ID[provider];
  const [regionRe, regionMsg] = REGION[provider];
  const problems = idRe.test(p.accountId) ? [] : [idMsg];
  for (const r of p.regions) if (!regionRe.test(r)) problems.push(`${regionMsg} : ${r}`);
  return problems;
}
