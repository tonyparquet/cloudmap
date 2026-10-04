import { describe, expect, it } from 'vitest';
import { AZURE_SERVICES, scanAzure, type AzureToken } from '../src/index.ts';
import type { ScanEvent } from '../src/scan.ts';

const SUB = '00000000-0000-4000-8000-000000000001';
const token: AzureToken = { provider: 'azure', accessToken: 'jeton-de-test' };
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// Identifiants ARM tels que renvoyés par Azure (casse mixte) : le scanner les met en minuscules.
const NIC = `/subscriptions/${SUB}/resourceGroups/RG-Demo/providers/Microsoft.Network/networkInterfaces/nic-vm`;
const VM = `/subscriptions/${SUB}/resourceGroups/RG-Demo/providers/Microsoft.Compute/virtualMachines/vm-web`;
const SUBNET = `/subscriptions/${SUB}/resourceGroups/RG-Demo/providers/Microsoft.Network/virtualNetworks/vnet/subnets/web`;

function azureMock() {
  const calls: {
    method: string;
    url: string;
    body?: { query: string; subscriptions?: string[]; options?: Record<string, unknown> };
  }[] = [];
  const fetchImpl = (async (url: URL | string, init?: RequestInit) => {
    const u = new URL(String(url));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init?.method ?? 'GET', url: u.pathname, body });
    if (init?.method !== 'POST')
      return json(200, { subscriptionId: SUB, displayName: 'abonnement', tenantId: 't', state: 'Enabled' });
    const q: string = body.query;
    if (q.includes("'microsoft.network/virtualnetworks'")) {
      // Deux pages : la seconde n'est demandée qu'avec le $skipToken de la première.
      if (!body.options?.$skipToken)
        return json(200, {
          data: [
            {
              id: NIC,
              name: 'nic-vm',
              type: 'Microsoft.Network/networkInterfaces',
              location: 'francecentral',
              properties: {
                virtualMachine: { id: VM },
                ipConfigurations: [{ properties: { subnet: { id: SUBNET }, privateIPAddress: '10.0.0.4' } }],
              },
            },
          ],
          $skipToken: 'page-2',
        });
      return json(200, {
        data: [
          {
            id: `${SUBNET.split('/subnets/')[0]}`,
            name: 'vnet',
            type: 'microsoft.network/virtualnetworks',
            location: 'francecentral',
            properties: {},
          },
        ],
      });
    }
    if (q.includes("'microsoft.compute/virtualmachines'"))
      return json(200, {
        data: [
          {
            id: VM,
            name: 'vm-web',
            type: 'Microsoft.Compute/virtualMachines',
            location: 'FranceCentral',
            properties: {},
          },
        ],
      });
    if (q.includes("'microsoft.web/sites'"))
      return json(200, {
        data: [
          {
            id: `/subscriptions/${SUB}/resourceGroups/rg/providers/Microsoft.Web/sites/app`,
            name: 'app',
            type: 'microsoft.web/sites',
            location: 'francecentral',
            properties: {
              state: 'Running',
              siteConfig: {
                appSettings: [{ name: 'MOT_DE_PASSE', value: 'secret-a-ne-jamais-lire' }],
                connectionStrings: [{ connectionString: 'Server=x;Password=y' }],
              },
            },
          },
        ],
      });
    if (q.startsWith('resourcecontainers'))
      return json(200, {
        data: [
          {
            id: `/subscriptions/${SUB}`,
            name: 'abonnement',
            type: 'microsoft.resources/subscriptions',
            properties: { state: 'Enabled' },
          },
        ],
      });
    if (q.startsWith('authorizationresources'))
      return json(403, { error: { code: 'AuthorizationFailed', message: 'refusé' } });
    return json(200, { data: [] });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe('scanner Azure (Resource Graph, lecture seule)', () => {
  it('inventaire paginé, identifiants en minuscules, cartes réseau rattachées, aucun secret, accès refusé consigné', async () => {
    const { calls, fetchImpl } = azureMock();
    const events: ScanEvent[] = [];
    const snap = await scanAzure({
      profileId: 'p',
      accountId: SUB,
      regions: ['francecentral'],
      credentials: token,
      fetchImpl,
      onProgress: (e) => events.push(e),
    });

    // Lecture seule : GET de l'abonnement, puis uniquement des requêtes Resource Graph.
    for (const c of calls)
      expect(c.method === 'GET' ? c.url : `${c.method} ${c.url}`).toMatch(
        /^(\/subscriptions\/[^/]+|POST \/providers\/Microsoft\.ResourceGraph\/resources)$/,
      );
    const network = calls.filter((c) => c.body?.query.includes("'microsoft.network/virtualnetworks'"));
    expect(network.map((c) => c.body?.options?.$skipToken)).toEqual([undefined, 'page-2']);
    expect(network[0]?.body?.subscriptions).toEqual([SUB]);
    expect(network[0]?.body?.query).toContain("location in~ ('francecentral')");
    // Organisation : portée du locataire (pas de restriction d'abonnement).
    expect(
      calls.find((c) => c.body?.query.startsWith('resourcecontainers'))?.body?.subscriptions,
    ).toBeUndefined();

    const vm = snap.resources.find((r) => r.type === 'microsoft.compute/virtualmachines');
    expect(vm?.id).toBe(VM.toLowerCase());
    expect(vm?.arn).toBe(VM.toLowerCase());
    expect(vm?.region).toBe('francecentral');
    expect((vm?.raw as { _nics: unknown[] })._nics).toEqual([
      { id: NIC.toLowerCase(), subnetId: SUBNET.toLowerCase(), privateIp: '10.0.0.4', asgIds: [] },
    ]);
    expect(snap.resources.some((r) => r.type === 'microsoft.network/virtualnetworks')).toBe(true);
    expect(JSON.stringify(snap)).not.toMatch(
      /secret-a-ne-jamais-lire|Password=y|appSettings|connectionStrings/,
    );
    expect(snap.resources.some((r) => r.type === 'microsoft.resources/subscriptions')).toBe(true);

    expect(snap.errors).toEqual([
      {
        service: 'organisation',
        region: 'global',
        code: 'AuthorizationFailed',
        message: 'Permission manquante : Microsoft.ResourceGraph/resources/read',
      },
    ]);
    expect(snap.meta).toMatchObject({ provider: 'azure', accountId: SUB });
    expect(events[0]).toMatchObject({ type: 'start', total: AZURE_SERVICES.length });
    expect(events.filter((e) => e.type === 'progress')).toHaveLength(AZURE_SERVICES.length);
    expect(events.at(-1)).toMatchObject({ type: 'done' });
  });

  it('services choisis seulement', async () => {
    const { calls, fetchImpl } = azureMock();
    await scanAzure({
      profileId: 'p',
      accountId: SUB,
      regions: [],
      services: ['security'],
      credentials: token,
      fetchImpl,
    });
    const queries = calls.filter((c) => c.body).map((c) => c.body?.query ?? '');
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("'microsoft.keyvault/vaults'");
  });
});
