import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { MASK, redact, redactString } from '@cloudmap/security';
import pino, { type Logger } from 'pino';

/**
 * Journal applicatif : redaction systématique (clés, secrets, jetons, Authorization, cookies) sur les
 * objets et les messages, sortie standard + DATA_DIR/logs/app.log.
 */
export function createLogger(level: string, dataDir?: string, opts: { stdout?: boolean } = {}): Logger {
  const lvl = level as pino.Level;
  const streams: pino.StreamEntry[] = opts.stdout === false ? [] : [{ level: lvl, stream: process.stdout }];
  if (dataDir) {
    const dir = join(dataDir, 'logs');
    mkdirSync(dir, { recursive: true });
    streams.push({
      level: lvl,
      stream: pino.destination({ dest: join(dir, 'app.log'), mkdir: true, sync: opts.stdout === false }),
    });
  }
  return pino(
    {
      level,
      base: undefined,
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["x-csrf-token"]',
          'res.headers["set-cookie"]',
          '*.secretAccessKey',
          '*.sessionToken',
          '*.password',
        ],
        censor: MASK,
      },
      formatters: { log: (obj) => redact(obj) },
      hooks: {
        logMethod(args, method) {
          method.apply(
            this,
            args.map((a) => (typeof a === 'string' ? redactString(a) : a)) as Parameters<typeof method>,
          );
        },
      },
      serializers: {
        req: (req: { method?: string; url?: string; ip?: string }) => ({
          method: req.method,
          url: redactString((req.url ?? '').split('?')[0] ?? ''),
          ip: req.ip,
        }),
        res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
        err: (err: Error) => redact(err),
      },
    },
    pino.multistream(streams),
  );
}
