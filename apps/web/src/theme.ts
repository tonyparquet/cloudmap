import type { ContainerKind } from '@carto/core';

/** Jetons de thème (section 9.2), fournis par CONFIG_DIR/theme.yaml via /api/config/theme. */

export interface ContainerToken {
  color: string;
  dash: string;
  width: number;
  radius: number;
}
export interface EdgeToken {
  color: string;
  width?: number;
  dash?: string;
  animated?: boolean;
}

export interface Theme {
  bg: string;
  panel: string;
  panelBorder: string;
  text: string;
  muted: string;
  accent: string;
  font: string;
  /** `org` / `ou` peuvent manquer d'un theme.yaml antérieur à la vue Organisation : voir containerToken(). */
  container: Record<'global' | 'region' | 'vpc' | 'az' | 'subnetPrivate' | 'subnetPublic', ContainerToken> &
    Partial<Record<'org' | 'ou', ContainerToken>>;
  node: {
    tile: { size: number; radius: number; border: number; borderColor: string };
    label: { color: string; size: number; weight: number };
    sublabel: { color: string; size: number };
  };
  category: Record<string, string>;
  status: { actif: string; autre: string; erreur: string };
  edge: {
    network: EdgeToken;
    cicd: EdgeToken;
    data: EdgeToken;
    dependency: EdgeToken;
    blocked: EdgeToken;
    unexplained: EdgeToken;
    label: { color: string; size: number; weight: number; background: string };
  };
}

/** Valeurs par défaut (identiques au thème « sombre » fourni), utilisées avant la connexion. */
export const DEFAULT_THEME: Theme = {
  bg: '#16131f',
  panel: '#1f1b2e',
  panelBorder: '#2e2a40',
  text: '#e4e4e7',
  muted: '#a1a1aa',
  accent: '#8b5cf6',
  font: 'Inter',
  container: {
    global: { color: '#a78bfa', dash: '6 4', width: 1.2, radius: 12 },
    region: { color: '#2dd4bf', dash: '6 4', width: 1.5, radius: 12 },
    vpc: { color: '#8b5cf6', dash: '', width: 1.5, radius: 10 },
    az: { color: '#6b7280', dash: '5 4', width: 1, radius: 8 },
    subnetPrivate: { color: '#14b8a6', dash: '', width: 1, radius: 8 },
    subnetPublic: { color: '#84cc16', dash: '', width: 1, radius: 8 },
    org: { color: '#e7157b', dash: '', width: 1.5, radius: 12 },
    ou: { color: '#f472b6', dash: '5 4', width: 1, radius: 10 },
  },
  node: {
    tile: { size: 44, radius: 8, border: 2, borderColor: '#e4e4e7' },
    label: { color: '#ffffff', size: 13, weight: 700 },
    sublabel: { color: '#a1a1aa', size: 11 },
  },
  category: {
    network: '#8c4fff',
    compute: '#ed7100',
    database: '#c925d1',
    storage: '#7aa116',
    devtools: '#3f8624',
    security: '#dd344c',
    external: '#2a2540',
    integration: '#e7157b',
    analytics: '#8c4fff',
    management: '#e7157b',
    generic: '#4b5563',
  },
  status: { actif: '#22c55e', autre: '#a1a1aa', erreur: '#ef4444' },
  edge: {
    network: { color: '#a78bfa', width: 1.5 },
    cicd: { color: '#e879f9', width: 1.5, dash: '4 4', animated: true },
    data: { color: '#94a3b8', width: 1.2 },
    dependency: { color: '#64748b', width: 1, dash: '2 3' },
    blocked: { color: '#ef4444', dash: '5 4' },
    unexplained: { color: '#f59e0b' },
    label: { color: '#ffffff', size: 11, weight: 700, background: '#16131f' },
  },
};

/** Jeton de conteneur d'un type de conteneur du graphe, avec repli sur les valeurs par défaut. */
export function containerToken(theme: Theme, kind: ContainerKind): ContainerToken {
  if (kind === 'subnet-public') return theme.container.subnetPublic;
  if (kind === 'subnet-private') return theme.container.subnetPrivate;
  if (kind === 'org' || kind === 'ou')
    return theme.container[kind] ?? DEFAULT_THEME.container[kind] ?? theme.container.global;
  return theme.container[kind];
}

/** Variables CSS globales dérivées du thème (le diagramme lit directement l'objet Theme). */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement.style;
  root.setProperty('--bg', theme.bg);
  root.setProperty('--panel', theme.panel);
  root.setProperty('--panel-border', theme.panelBorder);
  root.setProperty('--text', theme.text);
  root.setProperty('--muted', theme.muted);
  root.setProperty('--accent', theme.accent);
  root.setProperty('--ok', theme.status.actif);
  root.setProperty('--danger', theme.status.erreur);
  root.setProperty('--warn', theme.edge.unexplained.color);
  root.setProperty('--edge-label-bg', theme.edge.label.background);
  root.setProperty('--edge-label-color', theme.edge.label.color);
}
