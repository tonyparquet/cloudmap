/**
 * Lecture d'un bloc d'identifiants collé depuis le portail AWS (IAM Identity Center) ou l'AWS CLI :
 * variables `AWS_*` (bash, PowerShell, cmd), fichier `credentials`, JSON de `sts get-session-token`
 * ou de `aws configure export-credentials`. Analyse locale au navigateur : rien n'est envoyé ni conservé.
 */
export interface ParsedCredentials {
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
}

const PATTERNS: [keyof ParsedCredentials, RegExp][] = [
  ['accessKeyId', /aws_access_key_id["']?\s*[=:]\s*["']?([A-Z0-9]{16,128})/i],
  ['secretAccessKey', /aws_secret_access_key["']?\s*[=:]\s*["']?([A-Za-z0-9/+=]{30,})/i],
  ['sessionToken', /aws_session_token["']?\s*[=:]\s*["']?([A-Za-z0-9/+=]{16,})/i],
];

export function parseCredentialBlock(text: string): ParsedCredentials {
  try {
    const json = JSON.parse(text) as Record<string, unknown>;
    const src = (json.Credentials ?? json) as Record<string, unknown>;
    const pick = (key: string) => (typeof src[key] === 'string' ? (src[key] as string) : undefined);
    const out: ParsedCredentials = {};
    const id = pick('AccessKeyId');
    const secret = pick('SecretAccessKey');
    const token = pick('SessionToken');
    if (id) out.accessKeyId = id;
    if (secret) out.secretAccessKey = secret;
    if (token) out.sessionToken = token;
    if (id || secret) return out;
  } catch {
    // format texte
  }
  const out: ParsedCredentials = {};
  for (const [key, re] of PATTERNS) {
    const m = re.exec(text);
    if (m?.[1]) out[key] = m[1];
  }
  return out;
}
