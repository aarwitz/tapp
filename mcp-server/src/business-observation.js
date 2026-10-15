// Shared passive-navigation policy. GET is not proof that an endpoint is safe:
// avoid recognizable action/signed links and report the resulting coverage gap.
export function passiveUrlRisk(value) {
  let url;
  try { url = new URL(value); } catch { return "invalid-url"; }
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { return "invalid-url"; }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) return "invalid-url";
  if (/(?:^|\/)(?:logout|log-out|signout|sign-out|unsubscribe|delete|remove|cancel|refund|activate|accept|confirm)(?:\/|$)/i.test(pathname)) return "possible-action-link";
  for (const key of url.searchParams.keys()) {
    if (/^(?:token|access_token|id_token|signature|sig|code|action|do|delete|remove|refund|unsubscribe|confirm)$/i.test(key)) return "signed-or-action-link";
  }
  return null;
}

export function resolveObservationUrl(base, pagePath = "") {
  const origin = new URL(base);
  if (typeof pagePath !== "string" || pagePath.length > 2000 || (pagePath && (!pagePath.startsWith("/") || pagePath.startsWith("//") || /[\\\u0000-\u0020\u007f]/.test(pagePath)))) {
    throw new Error("Choose a page path on this website, such as /contact; do not supply another website or an action link");
  }
  const url = new URL(pagePath || origin.href, origin);
  if (url.origin !== origin.origin || passiveUrlRisk(url.href)) throw new Error("Passive checks cannot open signed or potentially state-changing links. Choose an ordinary page on this website");
  url.hash = "";
  return url.href;
}
