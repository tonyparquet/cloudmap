import { useApp, type LocaleKey } from '../store.ts';
import { de } from './de.ts';
import { enGB } from './en-GB.ts';
import { enUS } from './en-US.ts';
import { es } from './es.ts';
import { fr, type MessageKey } from './fr.ts';

export type { MessageKey };

/** Dictionnaires disponibles. Ajouter une langue = un fichier de même forme + une entrée ici. */
const messages: Record<LocaleKey, Record<MessageKey, string>> = {
  fr,
  'en-GB': enGB,
  'en-US': enUS,
  es,
  de,
};

/** Dictionnaire de la langue active (repli français). */
function dict(): Record<MessageKey, string> {
  return messages[useApp.getState().locale] ?? fr;
}

/** Traduction avec interpolation simple : t('scan.progression', { done: 2, total: 5 }). */
export function t(key: MessageKey, params: Record<string, string | number> = {}): string {
  const text = dict()[key] ?? fr[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (_m, name: string) => String(params[name] ?? `{${name}}`));
}

/** Libellé traduit d'une valeur dynamique (statut, catégorie…), sinon la valeur brute. */
export function tOr(key: string, fallback: string): string {
  return (dict() as Record<string, string>)[key] ?? fallback;
}

/** Message d'erreur serveur traduit par son code (err.<CODE>), sinon le message brut renvoyé. */
export function tError(code: string | undefined, serverMessage: string): string {
  return (dict() as Record<string, string>)[`err.${code ?? 'ERREUR'}`] ?? serverMessage;
}
