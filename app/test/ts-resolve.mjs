/**
 * Resolver hook so Node can run the app's TypeScript sources directly.
 *
 * Vite resolves extensionless relative imports; Node does not. Rather than
 * litter the application code with `.ts` suffixes, the tests register this
 * loader and let Node do the same lookup Vite does.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function resolve(specifier, context, next) {
  if (specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier)) {
    const base = new URL(specifier, context.parentURL);
    for (const ext of ['.ts', '.js', '/index.ts']) {
      const cand = new URL(base.href + ext);
      if (existsSync(fileURLToPath(cand))) {
        return next(pathToFileURL(fileURLToPath(cand)).href, context);
      }
    }
  }
  return next(specifier, context);
}
