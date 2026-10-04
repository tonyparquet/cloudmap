import { generateSecret, generateURI, verify } from 'otplib';
import QRCode from 'qrcode';

export const TOTP_ISSUER = 'CloudMap';

export const newTotpSecret = () => generateSecret();

export async function enrollmentData(username: string, secret: string) {
  const uri = generateURI({ issuer: TOTP_ISSUER, label: username, secret });
  return { secret, otpauthUrl: uri, qrDataUrl: await QRCode.toDataURL(uri, { margin: 1, width: 220 }) };
}

/**
 * Vérifie un code TOTP (± 30 s). `afterTimeStep` rejette tout code d'un pas de temps déjà utilisé
 * (protection contre le rejeu). Renvoie le pas de temps accepté, sinon undefined.
 */
export async function checkTotp(
  secret: string,
  token: string,
  lastStep: number,
): Promise<number | undefined> {
  if (!/^\d{6}$/.test(token)) return undefined;
  try {
    const result = await verify({
      secret,
      token,
      epochTolerance: 30,
      ...(lastStep > 0 ? { afterTimeStep: lastStep } : {}),
    });
    return result.valid && 'timeStep' in result ? result.timeStep : undefined;
  } catch {
    return undefined;
  }
}
