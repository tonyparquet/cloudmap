/** Icônes SVG en ligne (trait 2 px, grille 24) : aucune police d'icônes ni ressource externe (CSP). */
const PATHS = {
  alert: ['M12 3 2 21h20L12 3z', 'M12 10v5', 'M12 18h.01'],
  x: ['M6 6l12 12', 'M18 6 6 18'],
  refresh: ['M21 12a9 9 0 1 1-2.6-6.4L21 8', 'M21 3v5h-5'],
  check: ['M5 12l5 5L20 7'],
  back: ['M19 12H5', 'M11 18l-6-6 6-6'],
  search: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'M21 21l-4.3-4.3'],
  plus: ['M12 5v14', 'M5 12h14'],
  trash: ['M4 7h16', 'M9 7V4h6v3', 'M6 7l1 13h10l1-13'],
  logout: ['M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3', 'M10 16l4-4-4-4', 'M14 12H4'],
  arrow: ['M5 12h14', 'M13 6l6 6-6 6'],
  cloud: ['M18 10h-1.3A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z'],
  globe: [
    'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z',
    'M2 12h20',
    'M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z',
  ],
  key: [
    'M21 2l-2 2m-7.6 7.6a5.5 5.5 0 1 1-7.8 7.8 5.5 5.5 0 0 1 7.8-7.8zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4',
  ],
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 14 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

/**
 * Marque CloudMap : cadre ouvert en « C » (le cadre Région / VPC du diagramme), nœud au centre,
 * flux qui sort par l'ouverture. Mêmes formes que public/favicon.svg.
 */
export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="7" fill="#16131f" />
      <path
        d="M22.5 8H11a3 3 0 0 0-3 3v10a3 3 0 0 0 3 3h11.5"
        fill="none"
        stroke="#2dd4bf"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <rect x="12.5" y="12.5" width="7" height="7" rx="1.8" fill="#8b5cf6" />
      <path d="M19.5 16h4" stroke="#e4e4e7" strokeWidth="2" strokeLinecap="round" />
      <circle cx="25.6" cy="16" r="1.9" fill="#e4e4e7" />
    </svg>
  );
}
