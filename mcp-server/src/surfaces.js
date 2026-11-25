// Surfaces, not platforms (ADR-0013).
//
// A business has surfaces: a website, an app in two stores, a YouTube channel, an X profile, a
// TikTok, a Google Business listing. A "platform" is only how tapp reaches one of them. This
// module finds a brand's surfaces from its website — footer links, `rel="me"`, schema.org
// `sameAs` — and checks each one the way that surface allows: a store listing through its
// public catalog, a channel page by reading it, a profile that is only shown to signed-in users
// by saying so. tapp never signs in to a social account: acting on a brand's social presence by
// automation is against every one of those platforms' terms and gets the brand banned, which is
// the opposite of help. Read-only, public, and "could not check — here is why" everywhere else.
import { readFileSync } from "node:fs";

/** What a surface is, how it is shown, and the honest limit of what tapp can see of it. */
export const SURFACE_KINDS = Object.freeze({
  website: { label: "Website", icon: "🌐" },
  "app-store": { label: "App Store", icon: "🍎" },
  "play-store": { label: "Google Play", icon: "🤖" },
  youtube: { label: "YouTube", icon: "▶️" },
  x: { label: "X", icon: "✕" },
  tiktok: { label: "TikTok", icon: "🎵" },
  instagram: { label: "Instagram", icon: "📷" },
  facebook: { label: "Facebook", icon: "📘" },
  threads: { label: "Threads", icon: "🧵" },
  linkedin: { label: "LinkedIn", icon: "💼" },
  "google-business": { label: "Google Business", icon: "📍" },
});

const RESERVED = {
  x: /^(?:i|intent|share|home|explore|search|login|signup|settings|hashtag|about|privacy|tos|download)$/i,
  instagram: /^(?:p|reel|reels|explore|accounts|stories|direct|about|legal|privacy|developer)$/i,
  facebook: /^(?:sharer|share\.php|dialog|login|plugins|privacy|policies|help|groups|events|marketplace|watch|gaming|pages)$/i,
  tiktok: /^(?:tag|discover|upload|login|about|legal|foryou|following|explore)$/i,
  threads: /^(?:login|search|explore|about)$/i,
};

/**
 * Which surface a link points at, by host and path shape, with the handle it names. Returns
 * null for anything that is not a surface (a share link, a login page, an unrelated site).
 */
export function classifySurface(raw, { baseUrl = "" } = {}) {
  let url;
  try { url = new URL(String(raw || "").trim(), baseUrl || undefined); } catch { return null; }
  if (!/^https?:$/.test(url.protocol)) return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "").replace(/^mobile\./, "");
  const parts = url.pathname.split("/").filter(Boolean).map((p) => { try { return decodeURIComponent(p); } catch { return p; } });
  const first = parts[0] || "";
  const clean = (kind, handle, canonical) => ({ kind, handle, url: canonical, label: SURFACE_KINDS[kind].label });

  if (host === "youtube.com" || host === "youtu.be") {
    if (/^@[\w.-]{2,}$/.test(first)) return clean("youtube", first, `https://www.youtube.com/${first}`);
    if (["channel", "c", "user"].includes(first) && parts[1]) return clean("youtube", parts[1], `https://www.youtube.com/${first}/${parts[1]}`);
    return null;
  }
  if (host === "x.com" || host === "twitter.com") {
    if (!first || parts.length > 1 || RESERVED.x.test(first) || !/^[A-Za-z0-9_]{1,15}$/.test(first)) return null;
    return clean("x", `@${first}`, `https://x.com/${first}`);
  }
  if (host === "tiktok.com") {
    if (/^@[\w.-]{2,}$/.test(first) && !RESERVED.tiktok.test(first.slice(1))) return clean("tiktok", first, `https://www.tiktok.com/${first}`);
    return null;
  }
  if (host === "instagram.com") {
    if (!first || parts.length > 1 || RESERVED.instagram.test(first) || !/^[\w.]{1,30}$/.test(first)) return null;
    return clean("instagram", `@${first}`, `https://www.instagram.com/${first}/`);
  }
  if (host === "facebook.com" || host === "fb.com") {
    if (!first || RESERVED.facebook.test(first)) return null;
    if (first === "profile.php") return null;
    return clean("facebook", first, `https://www.facebook.com/${first}`);
  }
  if (host === "threads.net" || host === "threads.com") {
    if (/^@[\w.]{1,30}$/.test(first) && !RESERVED.threads.test(first.slice(1))) return clean("threads", first, `https://www.threads.net/${first}`);
    return null;
  }
  if (host === "linkedin.com") {
    if (["company", "in", "school", "showcase"].includes(first) && parts[1]) return clean("linkedin", parts[1], `https://www.linkedin.com/${first}/${parts[1]}/`);
    return null;
  }
  if (host === "apps.apple.com" || host === "itunes.apple.com") {
    const id = url.pathname.match(/\/id(\d{6,})/)?.[1];
    return id ? { ...clean("app-store", `id${id}`, `https://apps.apple.com/app/id${id}`), appId: id } : null;
  }
  if (host === "play.google.com") {
    const id = url.searchParams.get("id");
    return id && /^[\w.]+$/.test(id) ? { ...clean("play-store", id, `https://play.google.com/store/apps/details?id=${id}`), appId: id } : null;
  }
  if (host === "g.page" || host === "maps.app.goo.gl" || (host === "google.com" && /^\/maps\/place\//.test(url.pathname))) {
    return clean("google-business", first || url.pathname, url.href);
  }
  return null;
}

const decode = (text) => String(text || "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").trim();

/** The page's own name for itself: og:site_name, then <title>, then the host. */
export function pageTitle(html, { host = "" } = {}) {
  const site = html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i)?.[1] || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:site_name["']/i)?.[1];
  if (site) return decode(site).slice(0, 80);
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  if (title) return decode(title.replace(/\s+/g, " ")).split(/\s[|–—-]\s/)[0].slice(0, 80);
  return host;
}

function ogContent(html, property) {
  return decode(html.match(new RegExp(`<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']*)["']`, "i"))?.[1]
    || html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+property=["']${property}["']`, "i"))?.[1] || "");
}

/**
 * Every surface a website points at: anchors, `rel="me"` links, and schema.org `sameAs`. One
 * entry per surface, the first mention's source kept, in a stable order. Pure: HTML in, list out.
 */
export function discoverSurfaces({ baseUrl, html }) {
  const origin = new URL(baseUrl).origin;
  const found = new Map();
  const add = (href, source) => {
    const surface = classifySurface(href, { baseUrl });
    if (!surface) return;
    const key = `${surface.kind}:${surface.handle.toLowerCase()}`;
    if (!found.has(key)) found.set(key, { ...surface, source });
  };
  // The site's explicit claims first — rel="me" and schema.org sameAs say "this is us" — then
  // whatever the page merely links to, so the recorded source is the strongest one.
  for (const match of String(html).matchAll(/<link\b[^>]*rel=["'][^"']*\bme\b[^"']*["'][^>]*href=["']([^"']+)["']/gi)) add(match[1], "rel-me");
  for (const match of String(html).matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let data;
    try { data = JSON.parse(match[1]); } catch { continue; }
    const walk = (node) => {
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (!node || typeof node !== "object") return;
      const same = node.sameAs;
      for (const href of Array.isArray(same) ? same : same ? [same] : []) if (typeof href === "string") add(href, "sameAs");
      for (const value of Object.values(node)) if (value && typeof value === "object") walk(value);
    };
    walk(data);
  }
  for (const match of String(html).matchAll(/<a\b[^>]*href=["']([^"'#]+)["']/gi)) add(match[1], "link");
  const order = Object.keys(SURFACE_KINDS);
  const surfaces = [...found.values()].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.handle.localeCompare(b.handle));
  return { website: { kind: "website", label: "Website", url: origin, handle: new URL(origin).host, title: pageTitle(html, { host: new URL(origin).host }), source: "prompt" }, surfaces };
}

/** A read-only GET that looks like a browser, never follows into a login, and caps what it reads. */
export async function fetchPublicPage(url, { timeoutMs = 10_000, maxBytes = 512 * 1024 } = {}) {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 tapp/1", accept: "text/html,application/json;q=0.9,*/*;q=0.8", "accept-language": "en-US,en;q=0.8" },
  });
  const reader = response.body?.getReader();
  const chunks = [];
  let size = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      chunks.push(value);
      if (size >= maxBytes) { try { await reader.cancel(); } catch { /* enough */ } break; }
    }
  }
  return { status: response.status, url: response.url, text: Buffer.concat(chunks).toString("utf8") };
}

const NO_SIGN_IN = "tapp does not sign in to social accounts: doing that by automation is against the platform's terms and gets a brand banned.";

// One small adapter per kind of surface. Each sees exactly what that platform lets a visitor —
// or an official, read-only API — see, and says so. Adding a surface is adding an entry here.
const result = (status, note, extra = {}) => ({ status, note, checkedAt: new Date().toISOString(), ...extra });
const linksBack = (text, siteHost) => !!siteHost && String(text || "").toLowerCase().includes(siteHost.toLowerCase());
const compact = (n) => { const value = Number(n); if (!Number.isFinite(value)) return ""; return value >= 1e6 ? `${(value / 1e6).toFixed(1).replace(/\.0$/, "")}M` : value >= 1e3 ? `${(value / 1e3).toFixed(1).replace(/\.0$/, "")}K` : String(value); };

// YouTube through its Data API (official, read-only, free for public data) when tapp has a key;
// otherwise through the public channel page, which YouTube often does not show to a visitor.
async function youtubeByApi(surface, { fetchPage, siteHost, youtubeKey }) {
  const handle = surface.handle.startsWith("@") ? surface.handle.slice(1) : "";
  const id = /^UC[\w-]{20,}$/.test(surface.handle) ? surface.handle : "";
  const selector = handle ? `forHandle=${encodeURIComponent(handle)}` : id ? `id=${encodeURIComponent(id)}` : `forUsername=${encodeURIComponent(surface.handle)}`;
  const hide = (text) => String(text || "").split(youtubeKey).join("…");
  const api = async (pathAndQuery) => {
    const page = await fetchPage(`https://www.googleapis.com/youtube/v3/${pathAndQuery}&key=${encodeURIComponent(youtubeKey)}`);
    let data = null;
    try { data = JSON.parse(page.text); } catch { /* not JSON */ }
    if (page.status !== 200 || !data) throw new Error(hide(data?.error?.message || `YouTube's API answered ${page.status}`));
    return data;
  };
  const channels = await api(`channels?part=snippet,statistics,contentDetails&${selector}`);
  const channel = channels.items?.[0];
  if (!channel) return result("warning", "No channel for that handle in YouTube's catalog.");
  const stats = channel.statistics || {};
  const parts = [`Channel: ${channel.snippet?.title || surface.handle}`];
  if (!stats.hiddenSubscriberCount && stats.subscriberCount) parts.push(`${compact(stats.subscriberCount)} subscribers`);
  if (stats.videoCount) parts.push(`${compact(stats.videoCount)} videos`);
  const uploads = channel.contentDetails?.relatedPlaylists?.uploads;
  if (uploads) {
    try {
      const latest = (await api(`playlistItems?part=snippet&maxResults=1&playlistId=${encodeURIComponent(uploads)}`)).items?.[0]?.snippet?.publishedAt;
      if (latest) parts.push(`last upload ${String(latest).slice(0, 10)}`);
    } catch { /* the channel is still real; the upload date is extra */ }
  }
  if (linksBack(channel.snippet?.description, siteHost)) parts.push("links back to the site");
  return result("ok", parts.join(" · "), { title: channel.snippet?.title || "", via: "youtube-data-api" });
}

async function youtubeByPage(surface, { fetchPage, siteHost }) {
  const page = await fetchPage(surface.url);
  if (page.status === 404) return result("warning", "No channel at that address.");
  if (page.status !== 200) return result("not-checked", `YouTube answered ${page.status}.`);
  const title = ogContent(page.text, "og:title");
  if (!title) return result("not-checked", "YouTube did not show the channel page to a visitor.");
  return result("ok", `Channel: ${title}${linksBack(page.text, siteHost) ? " · links back to the site" : ""}`, { title });
}

async function visitorPage(surface, { fetchPage, siteHost }) {
  const page = await fetchPage(surface.url);
  const title = ogContent(page.text, "og:title");
  if (page.status === 404) return result("warning", `${surface.label} has no page at that address.`);
  if (page.status === 200 && title && !/log ?in|sign ?up/i.test(title)) return result("ok", `Found: ${title}${linksBack(page.text, siteHost) ? " · links back to the site" : ""}`, { title });
  return result("not-checked", `${surface.label} did not show the page to a visitor${page.status !== 200 ? ` (answered ${page.status})` : ""}. ${NO_SIGN_IN}`);
}

export const SURFACE_CHECKERS = Object.freeze({
  website: async (surface, { fetchPage }) => {
    const page = await fetchPage(surface.url);
    if (page.status >= 200 && page.status < 400) return result("ok", `Reachable: ${pageTitle(page.text, { host: surface.handle })}`);
    return result("unreachable", `Answered ${page.status}.`);
  },
  "app-store": async (surface, { fetchPage, siteHost }) => {
    const page = await fetchPage(`https://itunes.apple.com/lookup?id=${encodeURIComponent(surface.appId)}&country=us`);
    let data = null;
    try { data = JSON.parse(page.text); } catch { /* not JSON */ }
    const app = data?.results?.[0];
    if (!app) return result("warning", "No listing with that id in Apple's catalog.");
    const when = app.currentVersionReleaseDate ? ` · last updated ${String(app.currentVersionReleaseDate).slice(0, 10)}` : "";
    const rating = app.averageUserRating ? ` · ${Number(app.averageUserRating).toFixed(1)}★ (${app.userRatingCount || 0})` : "";
    return result("ok", `${app.trackName} by ${app.sellerName || "?"}${rating}${when}${linksBack(app.sellerUrl, siteHost) ? " · links back to the site" : ""}`, { title: app.trackName });
  },
  "play-store": async (surface, { fetchPage, siteHost }) => {
    const page = await fetchPage(surface.url);
    if (page.status === 404) return result("warning", "No listing with that id on Google Play.");
    if (page.status !== 200) return result("not-checked", `Google Play answered ${page.status}.`);
    const title = ogContent(page.text, "og:title") || pageTitle(page.text);
    return result("ok", `${title}${linksBack(page.text, siteHost) ? " · links back to the site" : ""}`, { title });
  },
  youtube: async (surface, options) => {
    if (options.youtubeKey) {
      try { return await youtubeByApi(surface, options); }
      catch (error) { const fallback = await youtubeByPage(surface, options); return { ...fallback, note: `${fallback.note} (YouTube's API: ${error.message})` }; }
    }
    return youtubeByPage(surface, options);
  },
  x: async () => result("not-checked", `X shows profiles only to signed-in users. ${NO_SIGN_IN}`),
  "google-business": async () => result("not-checked", "Google Business listings are not checked yet."),
  tiktok: visitorPage, instagram: visitorPage, facebook: visitorPage, threads: visitorPage, linkedin: visitorPage,
});

/**
 * Check one surface the way it allows. Never more than a GET; never a sign-in. Each answer says
 * what was seen or exactly why nothing could be.
 */
export async function checkSurface(surface, { fetchPage = fetchPublicPage, siteHost = "", youtubeKey = "" } = {}) {
  const checker = SURFACE_CHECKERS[surface.kind];
  if (!checker) return result("not-checked", "tapp does not know how to check this kind of surface yet.");
  try { return await checker(surface, { fetchPage, siteHost, youtubeKey }); }
  catch (error) { return result("unreachable", `Could not reach it: ${youtubeKey ? String(error.message).split(youtubeKey).join("…") : error.message}`); }
}

/** Find a brand's surfaces from its website and check each, a few at a time. */
export async function mapBrand({ baseUrl, html, fetchPage = fetchPublicPage, concurrency = 4, onProgress = () => {}, youtubeKey = "" }) {
  const { website, surfaces } = discoverSurfaces({ baseUrl, html });
  const siteHost = new URL(website.url).host.replace(/^www\./, "");
  const all = [website, ...surfaces];
  onProgress(`Found ${surfaces.length} surface${surfaces.length === 1 ? "" : "s"} linked from ${siteHost}.`);
  const checked = new Array(all.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= all.length) return;
      const surface = all[index];
      const check = await checkSurface(surface, { fetchPage, siteHost, youtubeKey });
      checked[index] = { ...surface, check };
      onProgress(`${surface.label}${surface.handle && surface.kind !== "website" ? ` ${surface.handle}` : ""}: ${check.note}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, all.length) }, worker));
  return { name: website.title, website: checked[0], surfaces: checked.slice(1), mappedAt: new Date().toISOString() };
}

/** For tests and the CLI: a brand map from a saved HTML file, without the network. */
export function discoverFromFile(file, baseUrl) {
  return discoverSurfaces({ baseUrl, html: readFileSync(file, "utf8") });
}
