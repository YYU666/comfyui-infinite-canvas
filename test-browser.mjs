import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { chromium as playwrightChromium } from 'playwright-core';

// Compare paths by canonical filesystem identity. Windows may expose the same
// temporary directory through long and 8.3 short names, including paths whose
// final directories have not been created yet.
const canonicalPath = (target) => {
  let ancestor = resolve(target);
  const missing = [];
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) return resolve(target);
    missing.unshift(basename(ancestor));
    ancestor = parent;
  }
  return resolve(realpathSync.native(ancestor), ...missing);
};
export const samePath = (left, right) => canonicalPath(left) === canonicalPath(right);

// Tests use Playwright's managed Chromium by default. CHROME_PATH is an
// explicit escape hatch for a locally installed browser; no machine-specific
// executable path is required by the test suite.
export const chromium = {
  launch(options = {}) {
    const { executablePath: _ignored, ...launchOptions } = options;
    const executablePath = process.env.CHROME_PATH?.trim() || undefined;
    return playwrightChromium.launch({
      ...launchOptions,
      ...(executablePath ? { executablePath } : {}),
    });
  },
};
