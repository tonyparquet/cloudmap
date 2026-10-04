import { afterAll, describe, expect, it } from 'vitest';
import { setupAdmin, startApp } from './helpers.ts';

describe('mode démo', () => {
  let close: (() => Promise<unknown>) | undefined;
  afterAll(() => close?.());

  it('profils démo AWS, Azure et Google Cloud : diagramme et vue Organisation calculés', async () => {
    const { app } = await startApp({ DEMO_MODE: 'true' });
    close = () => app.close();
    const { client } = await setupAdmin(app);
    const { profiles } = (await client.req('GET', '/api/profiles')).json() as {
      profiles: { id: string; provider?: string }[];
    };
    expect(new Set(profiles.map((p) => p.provider ?? 'aws'))).toEqual(new Set(['aws', 'azure', 'gcp']));
    for (const p of profiles) {
      const [snap] = (await client.req('GET', `/api/profiles/${p.id}/snapshots`)).json().snapshots as {
        id: string;
      }[];
      expect(snap, p.id).toBeDefined();
      const graph = await client.req('GET', `/api/snapshots/${snap?.id ?? ''}/graph`);
      expect(graph.status, p.id).toBe(200);
      expect(graph.json().graph.nodes.length, p.id).toBeGreaterThan(0);
      expect((await client.req('GET', `/api/snapshots/${snap?.id ?? ''}/org-graph`)).status, p.id).toBe(200);
    }
  });
});
