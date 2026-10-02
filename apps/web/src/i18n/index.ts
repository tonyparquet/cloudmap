import { fr, type MessageKey } from './fr.ts';

export type { MessageKey };

/** Dictionnaires disponibles : ajouter une langue = ajouter un fichier de même forme que fr.ts. */
const messages: Record<string, Record<MessageKey, string>> = { fr };
const locale = 'fr';

/** Traduction avec interpolation simple : t('scan.progression', { done: 2, total: 5 }). */
export function t(key: MessageKey, params: Record<string, string | number> = {}): string {
  const text = messages[locale]?.[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (_m, name: string) => String(params[name] ?? `{${name}}`));
}

/** Libellé traduit d'une valeur dynamique (statut, catégorie…), sinon la valeur brute. */
export function tOr(key: string, fallback: string): string {
  const dict = messages[locale] as Record<string, string> | undefined;
  return dict?.[key] ?? fallback;
}
