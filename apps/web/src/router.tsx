import type { ReactNode } from 'react';
import { create } from 'zustand';

/** Routeur minimal (History API) : chemins à paramètres `:id`. */
const useRouter = create<{ path: string }>(() => ({ path: window.location.pathname }));

window.addEventListener('popstate', () => useRouter.setState({ path: window.location.pathname }));

export function navigate(to: string, replace = false): void {
  if (to === window.location.pathname + window.location.search) return;
  if (replace) window.history.replaceState({}, '', to);
  else window.history.pushState({}, '', to);
  useRouter.setState({ path: window.location.pathname });
}

export const usePath = () => useRouter((s) => s.path);

export function match(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/');
  const q = path.replace(/\/$/, '').split('/');
  if (p.length !== q.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    const seg = p[i] ?? '';
    if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(q[i] ?? '');
    else if (seg !== q[i]) return null;
  }
  return params;
}

export function Link({ to, children, className }: { to: string; children: ReactNode; className?: string }) {
  return (
    <a
      href={to}
      className={className}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}
