import type { FlowContext, FlowEdgeRequest } from '../flows.ts';
import type { NetworkModel } from '../network.ts';
import type { Graph, RawSnapshot, Resource } from '../schemas.ts';

export const PROVIDERS = ['aws', 'azure', 'gcp'] as const;
export type CloudProvider = (typeof PROVIDERS)[number];

/**
 * Extension réseau d'un fournisseur de cloud : contribue au modèle commun (réseaux virtuels,
 * sous-réseaux, appairages) et infère ses flux autorisés (pare-feu, NSG…). Fonctions pures.
 */
export interface NetworkProvider {
  id: CloudProvider;
  /** Le type de ressource appartient-il à ce fournisseur ? */
  owns(type: string): boolean;
  /**
   * Ajoute au modèle commun les réseaux (`vpcs`), sous-réseaux (`subnets`, classés public / privé)
   * et appairages du fournisseur ; ses structures propres (règles de pare-feu…) vont dans
   * `model.providerData.set(id, …)`.
   */
  extend(model: NetworkModel, resources: Resource[]): void;
  /** Flux autorisés entre les nœuds du fournisseur (`ctx.nodes` filtrés par `owns(node.type)`). */
  flows(ctx: FlowContext): FlowEdgeRequest[];
}

/** Vue « Organisation » d'un fournisseur ; `null` si le snapshot n'en contient pas. */
export type OrgGraphBuilder = (snapshot: RawSnapshot) => Graph | null;
