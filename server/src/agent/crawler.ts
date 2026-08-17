export interface CrawlResult {
  url: string;
  title: string;
  text: string;
}

/**
 * Lightweight web crawler (FR-AGENT-1). Fetches a URL and extracts the main
 * textual content without heavy dependencies. Uses the global fetch available
 * in Node 18+.
 */
export async function crawl(url: string): Promise<CrawlResult> {
  const res = await fetch(url, {
    headers: { 'user-agent': 'MnemoBot/0.1 (+https://github.com/aquaxis/mnemo)' }
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  }
  const html = await res.text();
  return {
    url,
    title: extractTitle(html) ?? url,
    text: extractText(html)
  };
}

function extractTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? decodeEntities(match[1].trim()) : null;
}

function extractText(html: string): string {
  const withoutNoise = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  // Keep paragraph and heading boundaries as newlines for readability.
  const blocked = withoutNoise
    .replace(/<\/(p|div|section|article|h[1-6]|li|br)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(blocked)
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}
