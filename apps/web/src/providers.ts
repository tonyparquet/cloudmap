import { tOr, type MessageKey } from './i18n/index.ts';

/** Fournisseurs de cloud pris en charge (régions publiques : données génériques, pas des données client). */
export type Provider = 'aws' | 'azure' | 'gcp';
export const PROVIDER_IDS: Provider[] = ['aws', 'azure', 'gcp'];
export const providerOf = (p: { provider?: Provider }): Provider => p.provider ?? 'aws';

/** Libellé du mode d'accès : « clés » et « rôle » n'ont de sens que sur AWS. */
export const authLabel = (provider: Provider, kind: string): string =>
  tOr(`auth.${provider === 'aws' ? kind : `cloud.${kind}`}`, tOr(`auth.${kind}`, kind));

const AWS = [
  [
    'regions.europe',
    [
      'eu-west-1',
      'eu-west-2',
      'eu-west-3',
      'eu-central-1',
      'eu-central-2',
      'eu-north-1',
      'eu-south-1',
      'eu-south-2',
    ],
  ],
  [
    'regions.ameriques',
    [
      'us-east-1',
      'us-east-2',
      'us-west-1',
      'us-west-2',
      'ca-central-1',
      'ca-west-1',
      'sa-east-1',
      'mx-central-1',
    ],
  ],
  [
    'regions.asie',
    [
      'ap-south-1',
      'ap-south-2',
      'ap-east-1',
      'ap-southeast-1',
      'ap-southeast-2',
      'ap-southeast-3',
      'ap-southeast-4',
      'ap-southeast-5',
      'ap-southeast-7',
      'ap-northeast-1',
      'ap-northeast-2',
      'ap-northeast-3',
    ],
  ],
  ['regions.autres', ['af-south-1', 'me-south-1', 'me-central-1', 'il-central-1']],
] as const;
const AZURE = [
  [
    'regions.europe',
    [
      'francecentral',
      'francesouth',
      'westeurope',
      'northeurope',
      'germanywestcentral',
      'germanynorth',
      'italynorth',
      'norwayeast',
      'polandcentral',
      'spaincentral',
      'swedencentral',
      'switzerlandnorth',
      'uksouth',
      'ukwest',
    ],
  ],
  [
    'regions.ameriques',
    [
      'eastus',
      'eastus2',
      'centralus',
      'northcentralus',
      'southcentralus',
      'westcentralus',
      'westus',
      'westus2',
      'westus3',
      'canadacentral',
      'canadaeast',
      'brazilsouth',
      'mexicocentral',
    ],
  ],
  [
    'regions.asie',
    [
      'eastasia',
      'southeastasia',
      'japaneast',
      'japanwest',
      'koreacentral',
      'koreasouth',
      'centralindia',
      'southindia',
      'westindia',
      'australiaeast',
      'australiasoutheast',
      'australiacentral',
      'newzealandnorth',
      'indonesiacentral',
      'malaysiawest',
    ],
  ],
  ['regions.autres', ['uaenorth', 'qatarcentral', 'israelcentral', 'southafricanorth']],
] as const;
const GCP = [
  [
    'regions.europe',
    [
      'europe-west1',
      'europe-west2',
      'europe-west3',
      'europe-west4',
      'europe-west6',
      'europe-west8',
      'europe-west9',
      'europe-west10',
      'europe-west12',
      'europe-north1',
      'europe-north2',
      'europe-central2',
      'europe-southwest1',
    ],
  ],
  [
    'regions.ameriques',
    [
      'us-central1',
      'us-east1',
      'us-east4',
      'us-east5',
      'us-south1',
      'us-west1',
      'us-west2',
      'us-west3',
      'us-west4',
      'northamerica-northeast1',
      'northamerica-northeast2',
      'northamerica-south1',
      'southamerica-east1',
      'southamerica-west1',
    ],
  ],
  [
    'regions.asie',
    [
      'asia-east1',
      'asia-east2',
      'asia-northeast1',
      'asia-northeast2',
      'asia-northeast3',
      'asia-south1',
      'asia-south2',
      'asia-southeast1',
      'asia-southeast2',
      'australia-southeast1',
      'australia-southeast2',
    ],
  ],
  ['regions.autres', ['me-west1', 'me-central1', 'me-central2', 'africa-south1']],
] as const;

/** Régions par continent, dans l'ordre d'affichage. */
export const REGION_GROUPS: Record<Provider, readonly (readonly [MessageKey, readonly string[]])[]> = {
  aws: AWS,
  azure: AZURE,
  gcp: GCP,
};

/** Saisie de l'identifiant de compte : chiffres (AWS), GUID (Azure), identifiant de projet (Google Cloud). */
export function normalizeAccountId(provider: Provider, value: string): string {
  if (provider === 'aws') return value.replace(/\D/g, '').slice(0, 12);
  if (provider === 'azure')
    return value
      .trim()
      .toLowerCase()
      .replace(/[^0-9a-f-]/g, '')
      .slice(0, 36);
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 30);
}

export const ACCOUNT_PLACEHOLDER: Record<Provider, string> = {
  aws: '123456789012',
  azure: '00000000-0000-0000-0000-000000000000',
  gcp: 'mon-projet-123',
};
export const ACCOUNT_PATTERN: Record<Provider, string> = {
  aws: '\\d{12}',
  azure: '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}',
  gcp: '[a-z][a-z0-9\\-]{4,28}[a-z0-9]',
};
