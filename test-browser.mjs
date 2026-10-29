import { chromium as playwrightChromium } from 'playwright-core';

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
