// Search Apple's public US software catalog. A listing identifies a possible app.
// The visitor chooses a publisher's website before the existing audit starts.
const cache = new Map();
let searches = [];

function website(value) {
  try {
    const url = new URL(value);
    if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password) return url.href;
  } catch { /* Some publishers omit their website. */ }
  return "";
}

export async function discoverApps(input) {
  const term = String(input).normalize("NFKC").trim();
  if (!term || term.length > 80) return { matches: [], message: "Enter a shorter business name, or enter its website." };
  const key = term.toLowerCase();
  const now = Date.now();
  const cached = cache.get(key);
  if (cached?.until > now) return cached.result;
  searches = searches.filter(time => now - time < 60_000);
  if (searches.length >= 18) return { matches: [], message: "App Store search is busy. Enter the website or try again in a minute." };
  searches.push(now);
  try {
    const url = new URL("https://itunes.apple.com/search");
    url.search = new URLSearchParams({ country: "us", entity: "software", limit: "12", term });
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(6000) });
    if (!response.ok) throw new Error("Catalog unavailable");
    const { results } = await response.json();
    const matches = results.filter(app => Number.isSafeInteger(app.trackId) && app.trackName &&
      (app.trackName + " " + (app.sellerName || "")).toLowerCase().includes(key)).slice(0, 5).map(app => ({
      name: String(app.trackName), publisher: String(app.sellerName || ""),
      listing: "https://apps.apple.com/us/app/id" + app.trackId, website: website(app.sellerUrl),
    }));
    const result = { matches, message: matches.length ? "Which business did you mean?" : "No matching US App Store listing. Enter the business’s website to continue." };
    if (cache.size >= 200) cache.delete(cache.keys().next().value);
    cache.set(key, { until: now + 600_000, result });
    return result;
  } catch {
    return { matches: [], message: "The App Store search is unavailable. You can still enter the business’s website." };
  }
}
