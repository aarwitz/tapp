import test from "node:test";
import assert from "node:assert/strict";

import { SURFACE_KINDS, SURFACE_CHECKERS, classifySurface, discoverSurfaces, pageTitle, checkSurface, mapBrand } from "../mcp-server/src/surfaces.js";

test("a link is read as the surface it points at, and share links, logins and strangers are not surfaces", () => {
  const kind = (href) => classifySurface(href)?.kind ?? null;
  const handle = (href) => classifySurface(href)?.handle ?? null;
  assert.equal(kind("https://www.youtube.com/@acmebakery"), "youtube");
  assert.equal(handle("https://youtube.com/@acmebakery/videos"), "@acmebakery");
  assert.equal(kind("https://www.youtube.com/channel/UCabc123"), "youtube");
  assert.equal(kind("https://www.youtube.com/watch?v=xyz"), null, "a video is not the brand's surface");
  assert.deepEqual([kind("https://x.com/acmebakery"), handle("https://twitter.com/AcmeBakery")], ["x", "@AcmeBakery"]);
  assert.equal(kind("https://twitter.com/intent/tweet?text=hi"), null, "a share intent is not a profile");
  assert.equal(kind("https://x.com/acmebakery/status/123"), null, "a post is not the profile");
  assert.equal(handle("https://www.tiktok.com/@acme.bakery"), "@acme.bakery");
  assert.equal(kind("https://www.tiktok.com/tag/baking"), null);
  assert.equal(handle("https://instagram.com/acmebakery/"), "@acmebakery");
  assert.equal(kind("https://www.instagram.com/p/C1x2y3/"), null, "a post is not the profile");
  assert.equal(handle("https://www.facebook.com/AcmeBakery"), "AcmeBakery");
  assert.equal(kind("https://www.facebook.com/sharer/sharer.php?u=x"), null);
  assert.equal(handle("https://www.linkedin.com/company/acme-bakery/"), "acme-bakery");
  assert.equal(handle("https://www.threads.net/@acmebakery"), "@acmebakery");
  assert.deepEqual([kind("https://apps.apple.com/us/app/acme-bakery/id123456789"), classifySurface("https://apps.apple.com/us/app/acme-bakery/id123456789").appId], ["app-store", "123456789"]);
  assert.deepEqual([kind("https://play.google.com/store/apps/details?id=com.acme.bakery&hl=en"), classifySurface("https://play.google.com/store/apps/details?id=com.acme.bakery").appId], ["play-store", "com.acme.bakery"]);
  assert.equal(kind("https://g.page/acme-bakery"), "google-business");
  assert.equal(kind("https://example.com/about"), null, "an unrelated site is not a surface");
  assert.equal(kind("mailto:hi@acme.test"), null);
  assert.equal(classifySurface("/contact", { baseUrl: "https://acme.test/" }), null, "a relative link on the site itself is not a surface");
  for (const entry of Object.values(SURFACE_KINDS)) assert.ok(entry.label && entry.icon);
});

const HOME = `<!doctype html><html><head><title>Acme Bakery — Fresh bread daily</title>
<meta property="og:site_name" content="Acme Bakery">
<link rel="me" href="https://mastodon.example/@acme">
<link rel="me" href="https://x.com/acmebakery">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Bakery","name":"Acme Bakery","sameAs":["https://www.instagram.com/acmebakery/","https://www.youtube.com/@acmebakery","https://www.facebook.com/AcmeBakery"]}</script>
</head><body>
<a href="/menu">Menu</a>
<a href="https://apps.apple.com/us/app/acme-bakery/id123456789">iOS app</a>
<a href="https://play.google.com/store/apps/details?id=com.acme.bakery">Android app</a>
<footer><a href="https://www.tiktok.com/@acmebakery">TikTok</a> <a href="https://twitter.com/acmebakery">Twitter</a> <a href="https://www.youtube.com/@acmebakery/videos">YouTube</a>
<a href="https://twitter.com/intent/tweet?text=Acme">Share</a> <a href="https://g.page/acme-bakery">Find us</a></footer>
</body></html>`;

test("a website's surfaces are found from its links, rel=me and sameAs, once each, in a stable order", () => {
  const { website, surfaces } = discoverSurfaces({ baseUrl: "https://www.acme.test/", html: HOME });
  assert.deepEqual(website, { kind: "website", label: "Website", url: "https://www.acme.test", handle: "www.acme.test", title: "Acme Bakery", source: "prompt" });
  assert.deepEqual(surfaces.map((s) => `${s.kind}:${s.handle}`), [
    "app-store:id123456789", "play-store:com.acme.bakery", "youtube:@acmebakery", "x:@acmebakery", "tiktok:@acmebakery", "instagram:@acmebakery", "facebook:AcmeBakery", "google-business:acme-bakery",
  ]);
  assert.equal(surfaces.find((s) => s.kind === "x").source, "rel-me", "the first mention names the source");
  assert.equal(surfaces.find((s) => s.kind === "instagram").source, "sameAs");
  assert.equal(surfaces.find((s) => s.kind === "youtube").source, "sameAs", "sameAs and the footer agree; one entry");
  assert.equal(pageTitle("<title>Acme Bakery | Home</title>"), "Acme Bakery");
  assert.equal(pageTitle("<html></html>", { host: "acme.test" }), "acme.test");
});

test("each surface is checked the way it allows, and a profile shown only to signed-in users is said, not guessed", async () => {
  const pages = {
    "https://www.acme.test": { status: 200, text: HOME },
    "https://itunes.apple.com/lookup?id=123456789&country=us": { status: 200, text: JSON.stringify({ results: [{ trackName: "Acme Bakery", sellerName: "Acme Ltd", sellerUrl: "https://www.acme.test", averageUserRating: 4.62, userRatingCount: 311, currentVersionReleaseDate: "2026-10-30T00:00:00Z" }] }) },
    "https://play.google.com/store/apps/details?id=com.acme.bakery": { status: 200, text: '<meta property="og:title" content="Acme Bakery - Apps on Google Play"> ... acme.test ...' },
    "https://www.youtube.com/@acmebakery": { status: 200, text: '<meta property="og:title" content="Acme Bakery">' },
    "https://www.tiktok.com/@acmebakery": { status: 200, text: "<title>Log in | TikTok</title>" },
    "https://www.instagram.com/acmebakery/": { status: 200, text: '<meta property="og:title" content="Acme Bakery (@acmebakery) • Instagram">' },
    "https://www.facebook.com/AcmeBakery": { status: 404, text: "" },
  };
  const fetched = [];
  const fetchPage = async (url) => { fetched.push(url); const page = pages[url]; if (!page) throw new Error(`no fixture for ${url}`); return { ...page, url }; };
  const check = (surface) => checkSurface(surface, { fetchPage, siteHost: "acme.test" });
  const site = await check({ kind: "website", url: "https://www.acme.test", handle: "www.acme.test" });
  assert.equal(site.status, "ok"); assert.match(site.note, /Reachable: Acme Bakery/);
  const store = await check({ kind: "app-store", appId: "123456789" });
  assert.equal(store.status, "ok"); assert.equal(store.note, "Acme Bakery by Acme Ltd · 4.6★ (311) · last updated 2026-10-30 · links back to the site");
  const play = await check({ kind: "play-store", url: "https://play.google.com/store/apps/details?id=com.acme.bakery" });
  assert.equal(play.status, "ok"); assert.match(play.note, /Acme Bakery - Apps on Google Play · links back to the site/);
  const yt = await check({ kind: "youtube", url: "https://www.youtube.com/@acmebakery" });
  assert.equal(yt.status, "ok"); assert.equal(yt.note, "Channel: Acme Bakery");
  const x = await check({ kind: "x", url: "https://x.com/acmebakery", label: "X" });
  assert.equal(x.status, "not-checked"); assert.match(x.note, /only to signed-in users/); assert.match(x.note, /does not sign in/);
  assert.equal(fetched.includes("https://x.com/acmebakery"), false, "X is not even fetched: the answer is known");
  const tt = await check({ kind: "tiktok", url: "https://www.tiktok.com/@acmebakery", label: "TikTok" });
  assert.equal(tt.status, "not-checked"); assert.match(tt.note, /TikTok did not show the page to a visitor/);
  const ig = await check({ kind: "instagram", url: "https://www.instagram.com/acmebakery/", label: "Instagram" });
  assert.equal(ig.status, "ok"); assert.match(ig.note, /Found: Acme Bakery/);
  const fb = await check({ kind: "facebook", url: "https://www.facebook.com/AcmeBakery", label: "Facebook" });
  assert.equal(fb.status, "warning"); assert.match(fb.note, /no page at that address/);
  const gb = await check({ kind: "google-business", url: "https://g.page/acme-bakery" });
  assert.equal(gb.status, "not-checked");
  const down = await check({ kind: "website", url: "https://gone.test", handle: "gone.test" });
  assert.equal(down.status, "unreachable"); assert.match(down.note, /Could not reach it/);
});

test("a brand map finds the surfaces, checks them a few at a time, and narrates each one", async () => {
  const lines = [];
  const fetchPage = async (url) => ({ status: url.includes("lookup") ? 200 : 404, url, text: url.includes("lookup") ? JSON.stringify({ results: [{ trackName: "Acme Bakery", sellerName: "Acme Ltd" }] }) : "" });
  const brand = await mapBrand({ baseUrl: "https://www.acme.test/", html: HOME, fetchPage, concurrency: 3, onProgress: (line) => lines.push(line) });
  assert.equal(brand.name, "Acme Bakery");
  assert.equal(brand.website.check.status, "unreachable", "the fixture site answers 404 to its own homepage check");
  assert.equal(brand.surfaces.length, 8);
  assert.equal(brand.surfaces.find((s) => s.kind === "app-store").check.status, "ok");
  assert.equal(brand.surfaces.find((s) => s.kind === "x").check.status, "not-checked");
  assert.match(lines[0], /Found 8 surfaces linked from acme\.test/);
  assert.ok(lines.some((l) => /^App Store id123456789: Acme Bakery by Acme Ltd/.test(l)));
  assert.ok(brand.mappedAt);
});

test("with a key, YouTube is read through its official API — subscribers, videos, last upload — and the key never leaks into a sentence", async () => {
  assert.deepEqual(Object.keys(SURFACE_CHECKERS).sort(), Object.keys(SURFACE_KINDS).sort(), "one adapter per kind of surface, no more and no fewer");
  const KEY = "AIzaSyTESTKEY000000000000000000000000000";
  const seen = [];
  const fixtures = {
    channels: { status: 200, text: JSON.stringify({ items: [{ snippet: { title: "Acme Bakery", description: "Fresh bread daily — https://www.acme.test" }, statistics: { subscriberCount: "12345", videoCount: "48", hiddenSubscriberCount: false }, contentDetails: { relatedPlaylists: { uploads: "UUacme" } } }] }) },
    playlistItems: { status: 200, text: JSON.stringify({ items: [{ snippet: { publishedAt: "2026-11-01T09:00:00Z" } }] }) },
  };
  const fetchPage = async (url) => {
    seen.push(url);
    if (url.includes("/youtube/v3/channels?")) return { url, ...fixtures.channels };
    if (url.includes("/youtube/v3/playlistItems?")) return { url, ...fixtures.playlistItems };
    throw new Error(`no fixture for ${url}`);
  };
  const check = await checkSurface({ kind: "youtube", handle: "@acmebakery", url: "https://www.youtube.com/@acmebakery", label: "YouTube" }, { fetchPage, siteHost: "acme.test", youtubeKey: KEY });
  assert.equal(check.status, "ok");
  assert.equal(check.note, "Channel: Acme Bakery · 12.3K subscribers · 48 videos · last upload 2026-11-01 · links back to the site");
  assert.equal(check.via, "youtube-data-api");
  assert.ok(seen[0].includes("forHandle=acmebakery"), "a handle is looked up as a handle");
  assert.ok(seen[0].includes(`key=${KEY}`), "the key goes to Google and nowhere else");

  // A channel id is looked up by id; a hidden subscriber count is left out, not shown as zero.
  seen.length = 0;
  fixtures.channels.text = JSON.stringify({ items: [{ snippet: { title: "Acme" }, statistics: { subscriberCount: "0", videoCount: "3", hiddenSubscriberCount: true } }] });
  const byId = await checkSurface({ kind: "youtube", handle: "UCabcdefghijklmnopqrstuv", url: "https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv", label: "YouTube" }, { fetchPage, youtubeKey: KEY });
  assert.ok(seen[0].includes("id=UCabcdefghijklmnopqrstuv"));
  assert.equal(byId.note, "Channel: Acme · 3 videos");

  // No channel for the handle is a warning; an API that refuses falls back to the page and says
  // so — without ever repeating the key.
  fixtures.channels.text = JSON.stringify({ items: [] });
  assert.equal((await checkSurface({ kind: "youtube", handle: "@nobody", url: "https://www.youtube.com/@nobody", label: "YouTube" }, { fetchPage, youtubeKey: KEY })).status, "warning");
  const refusing = async (url) => url.includes("/youtube/v3/") ? { url, status: 403, text: JSON.stringify({ error: { message: `API key not valid: ${KEY}` } }) } : { url, status: 200, text: '<meta property="og:title" content="Acme Bakery">' };
  const fell = await checkSurface({ kind: "youtube", handle: "@acmebakery", url: "https://www.youtube.com/@acmebakery", label: "YouTube" }, { fetchPage: refusing, youtubeKey: KEY });
  assert.equal(fell.status, "ok");
  assert.match(fell.note, /^Channel: Acme Bakery \(YouTube's API: API key not valid: …\)$/);
  assert.equal(fell.note.includes(KEY), false);
  // Without a key the public page is all there is.
  const plain = await checkSurface({ kind: "youtube", handle: "@acmebakery", url: "https://www.youtube.com/@acmebakery", label: "YouTube" }, { fetchPage: refusing });
  assert.equal(plain.note, "Channel: Acme Bakery");
});
