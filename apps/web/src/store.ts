import { create } from 'zustand';
import { DEFAULT_THEME, type Theme } from './theme.ts';

export type Role = 'admin' | 'editor' | 'viewer';

export interface AuthUser {
  id: string;
  username: string;
  role: Role;
  groups: string[];
}

export interface AuthState {
  authMode: 'local' | 'oidc';
  setupRequired: boolean;
  stage: 'anon' | 'mfa' | 'enroll' | 'full';
  demoMode: boolean;
  user?: AuthUser;
}

interface AppState {
  auth?: AuthState;
  setAuth(auth: AuthState | undefined): void;
  theme: Theme;
  themeName: string;
  themes: Record<string, Theme>;
  setThemes(themes: Record<string, Theme>, preferred: string): void;
  setThemeName(name: string): void;
  reauth?: { resolve: () => void; reject: (err: Error) => void };
  requestReauth(): Promise<void>;
  settleReauth(ok: boolean): void;
  toast?: string;
  showToast(message: string): void;
}

const THEME_KEY = 'carto.theme';
const readPref = () => {
  try {
    return localStorage.getItem(THEME_KEY) ?? undefined;
  } catch {
    return undefined;
  }
};

export const useApp = create<AppState>((set, get) => ({
  setAuth: (auth) => set({ auth }),
  theme: DEFAULT_THEME,
  themeName: 'sombre',
  themes: { sombre: DEFAULT_THEME },
  setThemes: (themes, preferred) => {
    const name = [readPref(), preferred].find((n) => n && themes[n]) ?? Object.keys(themes)[0] ?? 'sombre';
    set({ themes, themeName: name, theme: themes[name] ?? DEFAULT_THEME });
  },
  setThemeName: (name) => {
    try {
      localStorage.setItem(THEME_KEY, name);
    } catch {
      /* préférence non conservée */
    }
    set({ themeName: name, theme: get().themes[name] ?? DEFAULT_THEME });
  },
  requestReauth: () =>
    new Promise<void>((resolve, reject) => {
      set({ reauth: { resolve, reject } });
    }),
  settleReauth: (ok) => {
    const pending = get().reauth;
    set({ reauth: undefined });
    if (ok) pending?.resolve();
    else pending?.reject(new Error('Ré-authentification annulée'));
  },
  showToast: (message) => {
    set({ toast: message });
    setTimeout(() => {
      if (get().toast === message) set({ toast: undefined });
    }, 3500);
  },
}));
