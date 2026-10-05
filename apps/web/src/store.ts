import { create } from 'zustand';
import { DEFAULT_THEME, type Theme } from './theme.ts';

export type Role = 'admin' | 'editor' | 'viewer';

/** Langues de l'interface. Ajouter une langue = une entrée ici + un fichier i18n/<clé>.ts + un drapeau. */
export type LocaleKey = 'fr' | 'en-GB' | 'en-US' | 'es' | 'de';
export const LOCALES: LocaleKey[] = ['fr', 'en-GB', 'en-US', 'es', 'de'];

export interface AuthUser {
  id: string;
  username: string;
  role: Role;
  groups: string[];
  /** Session invitée : rien n'est enregistré. */
  guest?: boolean;
}

export interface AuthState {
  authMode: 'local' | 'oidc';
  setupRequired: boolean;
  registrationOpen: boolean;
  guestsAllowed: boolean;
  guest: boolean;
  stage: 'anon' | 'mfa' | 'enroll' | 'full';
  demoMode: boolean;
  mfaEnabled?: boolean;
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
  locale: LocaleKey;
  setLocale(locale: LocaleKey): void;
  reauth?: { resolve: () => void; reject: (err: Error) => void };
  requestReauth(): Promise<void>;
  settleReauth(ok: boolean): void;
  toast?: string;
  showToast(message: string): void;
}

const THEME_KEY = 'cloudmap.theme';
const readPref = () => {
  try {
    return localStorage.getItem(THEME_KEY) ?? undefined;
  } catch {
    return undefined;
  }
};

const LOCALE_KEY = 'cloudmap.locale';
/** Langue choisie par la détection automatique (navigateur/système), repli français. */
function detectLocale(): LocaleKey {
  try {
    const nav = globalThis.navigator;
    const langs = nav?.languages?.length ? nav.languages : nav?.language ? [nav.language] : [];
    for (const raw of langs) {
      const l = raw.toLowerCase();
      if (l.startsWith('fr')) return 'fr';
      if (['en-gb', 'en-au', 'en-nz', 'en-ie', 'en-za', 'en-in'].includes(l)) return 'en-GB';
      if (l.startsWith('en')) return 'en-US';
      if (l.startsWith('es')) return 'es';
      if (l.startsWith('de')) return 'de';
    }
  } catch {
    /* repli */
  }
  return 'fr';
}
/** Préférence mémorisée si valide, sinon détection automatique. */
function initialLocale(): LocaleKey {
  try {
    const saved = localStorage.getItem(LOCALE_KEY);
    if (saved && (LOCALES as string[]).includes(saved)) return saved as LocaleKey;
  } catch {
    /* repli */
  }
  return detectLocale();
}

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
  locale: initialLocale(),
  setLocale: (locale) => {
    try {
      localStorage.setItem(LOCALE_KEY, locale);
    } catch {
      /* préférence non conservée */
    }
    set({ locale });
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
