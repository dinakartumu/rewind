/**
 * Browser-mimicking HTTP headers for outbound fetches of HTML pages.
 *
 * Sites with anti-bot protection (NYT, Bloomberg, WSJ, Axios, etc.)
 * reject requests that look like bots -- i.e. minimal `User-Agent`
 * without the Sec-Fetch-* client hints a real browser sends.
 *
 * Approach ported from claudenotes. Chrome's User-Agent Reduction
 * (fully shipped 2023) freezes everything except the major version
 * number, so we only need to derive the current major from the date.
 *
 * Use BROWSER_HEADERS_NAVIGATE for OG metadata scraping and any
 * top-level HTML page fetch. Do NOT use for image downloads (wrong
 * Sec-Fetch-Dest).
 */

/**
 * Approximate Chrome major version derived from today's date.
 * Chrome 132 shipped 2025-01-14 (anchor). Stable ships every ~4 weeks.
 * +/- 1 off is fine for UA strings.
 */
function chromeVersion(): number {
  const anchorVersion = 132;
  const anchorDate = new Date('2025-01-14').getTime();
  const releaseCycleDays = 28;
  const daysSince = (Date.now() - anchorDate) / 86_400_000;
  return anchorVersion + Math.floor(daysSince / releaseCycleDays);
}

const cv = chromeVersion();

/** Full Chrome User-Agent string (macOS). */
export const BROWSER_UA = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${cv}.0.0.0 Safari/537.36`;

/**
 * Headers for top-level HTML page navigation (what Chrome sends
 * when you type a URL into the address bar). Missing Sec-Fetch-*
 * is a major bot signal for Bloomberg, NYT, WSJ, Axios, etc.
 *
 * `Referer: google.com` is a mild additional signal that the
 * request came from a search result, which some anti-bot layers
 * use to whitelist crawlers.
 */
export const BROWSER_HEADERS_NAVIGATE: Record<string, string> = {
  'User-Agent': BROWSER_UA,
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Sec-CH-UA': `"Not:A-Brand";v="99", "Google Chrome";v="${cv}", "Chromium";v="${cv}"`,
  'Sec-CH-UA-Mobile': '?0',
  'Sec-CH-UA-Platform': '"macOS"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
  Referer: 'https://www.google.com/',
};
