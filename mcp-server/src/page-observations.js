// Things a person would notice and not like.
//
// Separate from defects on purpose. A broken image or a 404 is a *defect*: the page does not do
// what it says. Text nobody can read, a button too small to hit on a phone, a label that says
// "Click here", "Lorem ipsum" left in a paragraph — none of those are broken, and all of them are
// the first thing a real visitor reacts to. tapp reports them as **observations**, counted and
// listed apart from issues, so "3 issues" never quietly means "3 issues and 14 opinions".
//
// Every check here is deterministic and reads the rendered page — no model, no API key, no
// judgement call that cannot be re-derived from the DOM. Each is capped so one bad page cannot
// produce a thousand lines, and each carries the selector it came from so the report can point.
const CAPS = { contrast: 8, tap: 8, clipped: 6, overlap: 4, placeholder: 5, unlabelled: 6, nameless: 6, tiny: 5, alt: 6 };

/**
 * Run the in-page pass. Returns raw observations; `observationFindings` turns them into findings.
 *
 * Two passes: the page as rendered, then the same page at phone width. Size-and-space questions —
 * is this big enough to tap, does the text fit, does the page scroll sideways — have no honest
 * answer at desktop width, where a 20px-tall nav link is simply a nav link. They are asked on a
 * phone, which is where most people meet the page and where the answer is interesting.
 */
export async function collectPageObservations(page, { caps = CAPS, phone = { width: 390, height: 844 } } = {}) {
  const pass = async (mode) => page.evaluate(({ limits, mode: m }) => {
      const out = [];
      let n = 0;
      const tag = (el) => { n += 1; el.setAttribute("data-tapp-observation", String(n)); return `[data-tapp-observation="${n}"]`; };
      const rect = (el) => el.getBoundingClientRect();
      const visible = (el) => {
        if (!el || !el.getClientRects || el.getClientRects().length === 0) return false;
        const style = getComputedStyle(el);
        if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) return false;
        const box = rect(el);
        return box.width > 0 && box.height > 0 && box.bottom > 0 && box.right > 0;
      };
      const textOf = (el) => (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
      const count = (kind) => out.filter((o) => o.kind === kind).length;

      // ── colour contrast ────────────────────────────────────────────────────────────────────
      const parseColor = (value) => {
        const m = String(value).match(/rgba?\(([^)]+)\)/);
        if (!m) return null;
        const parts = m[1].split(",").map((p) => parseFloat(p.trim()));
        return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
      };
      const luminance = ({ r, g, b }) => {
        const channel = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
        return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
      };
      const backgroundOf = (el) => {
        let node = el;
        while (node && node !== document.documentElement) {
          const bg = parseColor(getComputedStyle(node).backgroundColor);
          if (bg && bg.a > 0.75) return bg;
          node = node.parentElement;
        }
        return { r: 255, g: 255, b: 255, a: 1 };
      };
      const ratio = (fg, bg) => {
        const a = luminance(fg) + 0.05;
        const b = luminance(bg) + 0.05;
        return a > b ? a / b : b / a;
      };
      const textNodes = [...document.querySelectorAll("p,span,a,li,h1,h2,h3,h4,h5,h6,button,label,td,th,small,strong,em,div")].slice(0, 1200);
      for (const el of textNodes) {
        if (count("low_contrast") >= limits.contrast) break;
        // Only elements whose own text is the thing being read.
        const own = [...el.childNodes].filter((node) => node.nodeType === 3).map((node) => node.textContent).join("").replace(/\s+/g, " ").trim();
        if (own.length < 8 || !visible(el)) continue;
        const style = getComputedStyle(el);
        const fg = parseColor(style.color);
        if (!fg || fg.a < 0.75) continue;
        // A background image can carry any colour; the computed ratio would be fiction.
        if (getComputedStyle(el).backgroundImage !== "none") continue;
        const bg = backgroundOf(el);
        const size = parseFloat(style.fontSize) || 16;
        const bold = Number(style.fontWeight) >= 700;
        const large = size >= 24 || (size >= 18.66 && bold);
        const need = large ? 3 : 4.5;
        const got = ratio(fg, bg);
        if (got + 0.05 < need) out.push({ kind: "low_contrast", selector: tag(el), text: own.slice(0, 60), ratio: Math.round(got * 10) / 10, need, size: Math.round(size) });
      }

      // ── controls too small to hit, and controls sitting on top of each other ───────────────
      const interactive = [...document.querySelectorAll('a[href],button,[role="button"],input[type="submit"],input[type="button"],select,summary')].filter(visible).slice(0, 200);
      for (const el of (m === "phone" ? interactive : [])) {
        if (count("tiny_tap_target") >= limits.tap) break;
        const box = rect(el);
        // Inline links inside a sentence are read, not tapped at their own size; judge standalone
        // controls only (a link that is its own block, or any button).
        const inlineLink = el.tagName === "A" && getComputedStyle(el).display.startsWith("inline") && box.height < 30 && textOf(el).length > 0 && el.parentElement && textOf(el.parentElement).length > textOf(el).length + 10;
        if (inlineLink) continue;
        // Footer link lists are dense everywhere and nobody is surprised by them; reporting six
        // of them buries the button someone actually needs to hit.
        if (el.tagName === "A" && el.closest("footer,[role=contentinfo]")) continue;
        if (box.width < 32 || box.height < 32) out.push({ kind: "tiny_tap_target", selector: tag(el), label: textOf(el).slice(0, 40) || el.getAttribute("aria-label") || el.tagName.toLowerCase(), width: Math.round(box.width), height: Math.round(box.height) });
      }
      for (let i = 0; m === "phone" && i < interactive.length && count("overlapping_controls") < limits.overlap; i += 1) {
        for (let j = i + 1; j < interactive.length; j += 1) {
          const a = rect(interactive[i]);
          const b = rect(interactive[j]);
          if (interactive[i].contains(interactive[j]) || interactive[j].contains(interactive[i])) continue;
          const overlap = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
          const smaller = Math.min(a.width * a.height, b.width * b.height);
          if (smaller > 0 && overlap / smaller > 0.6) {
            out.push({ kind: "overlapping_controls", selector: tag(interactive[i]), other: textOf(interactive[j]).slice(0, 30), label: textOf(interactive[i]).slice(0, 30) });
            break;
          }
        }
      }

      // ── text cut off by its own box (and, on a phone, a page that scrolls sideways) ────────
      if (m === "phone") {
        const doc = document.documentElement;
        const wide = Math.max(doc.scrollWidth, document.body ? document.body.scrollWidth : 0) - window.innerWidth;
        if (wide > 2) out.push({ kind: "phone_overflow", overflow: Math.round(wide), viewport: window.innerWidth });
      }
      for (const el of textNodes) {
        if (count("clipped_text") >= limits.clipped) break;
        if (!visible(el)) continue;
        const style = getComputedStyle(el);
        if (!/hidden|clip/.test(style.overflow + style.overflowX)) continue;
        if (style.textOverflow === "ellipsis") continue; // deliberate truncation, and it shows
        const text = textOf(el);
        if (text.length < 10) continue;
        if (el.scrollWidth > el.clientWidth + 4) out.push({ kind: "clipped_text", selector: tag(el), text: text.slice(0, 60), cut: el.scrollWidth - el.clientWidth });
      }

      // ── copy nobody meant to ship (asked once, at the page's own width) ────────────────────
      const body = m === "phone" ? "" : (document.body?.innerText || "").replace(/\s+/g, " ");
      for (const pattern of [/lorem ipsum[^.]{0,80}/i, /dolor sit amet[^.]{0,60}/i, /\bTODO\b[^.]{0,60}/, /\bFIXME\b[^.]{0,60}/, /coming soon[^.]{0,40}/i, /placeholder[^.]{0,40}/i, /\btest test\b[^.]{0,30}/i, /\bundefined\b|\bNaN\b|\[object Object\]/]) {
        if (count("placeholder_copy") >= limits.placeholder) break;
        const found = body.match(pattern);
        if (found) out.push({ kind: "placeholder_copy", text: found[0].trim().slice(0, 80) });
      }

      // ── things a person cannot identify ────────────────────────────────────────────────────
      for (const el of (m === "phone" ? [] : [...document.querySelectorAll("input,select,textarea")].filter(visible).slice(0, 80))) {
        if (count("unlabelled_field") >= limits.unlabelled) break;
        const type = (el.getAttribute("type") || "").toLowerCase();
        if (["hidden", "submit", "button", "image", "reset"].includes(type)) continue;
        const labelled = (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) || el.closest("label")
          || el.getAttribute("aria-label") || el.getAttribute("aria-labelledby") || el.getAttribute("placeholder") || el.getAttribute("title");
        if (!labelled) out.push({ kind: "unlabelled_field", selector: tag(el), name: el.getAttribute("name") || type || el.tagName.toLowerCase() });
      }
      for (const el of (m === "phone" ? [] : interactive)) {
        if (count("nameless_control") >= limits.nameless) break;
        const name = textOf(el) || el.getAttribute("aria-label") || el.getAttribute("title") || el.querySelector("img[alt]")?.getAttribute("alt") || "";
        if (!name.trim()) out.push({ kind: "nameless_control", selector: tag(el), tagName: el.tagName.toLowerCase() });
      }
      const vague = new Set(["click here", "here", "read more", "learn more", "more", "link", "this"]);
      const vagueLinks = m === "phone" ? [] : [...document.querySelectorAll("a[href]")].filter(visible).map(textOf).filter((t) => vague.has(t.toLowerCase()));
      if (vagueLinks.length) out.push({ kind: "vague_link_text", total: vagueLinks.length, sample: [...new Set(vagueLinks)].slice(0, 3) });

      // ── text too small to read comfortably ─────────────────────────────────────────────────
      for (const el of (m === "phone" ? [] : textNodes)) {
        if (count("tiny_text") >= limits.tiny) break;
        if (!visible(el)) continue;
        const own = [...el.childNodes].filter((node) => node.nodeType === 3).map((node) => node.textContent).join("").trim();
        if (own.length < 25) continue;
        const size = parseFloat(getComputedStyle(el).fontSize) || 16;
        if (size < 12) out.push({ kind: "tiny_text", selector: tag(el), size: Math.round(size * 10) / 10, text: own.replace(/\s+/g, " ").slice(0, 50) });
      }

      // ── pictures with nothing to say, and a page with no headline ──────────────────────────
      for (const img of (m === "phone" ? [] : [...document.images].filter(visible).slice(0, 120))) {
        if (count("image_without_alt") >= limits.alt) break;
        const box = rect(img);
        if (box.width < 48 || box.height < 48) continue;
        if (!img.hasAttribute("alt")) out.push({ kind: "image_without_alt", selector: tag(img), src: (img.getAttribute("src") || "").slice(0, 100) });
      }
      if (m !== "phone") {
        const h1s = [...document.querySelectorAll("h1")].filter(visible);
        if (h1s.length === 0) out.push({ kind: "no_headline" });
        else if (h1s.length > 2) out.push({ kind: "many_headlines", total: h1s.length });

        const title = (document.title || "").trim();
        if (!title || /^(document|untitled|index|home page|react app|vite app)$/i.test(title)) out.push({ kind: "weak_page_title", title: title.slice(0, 60) });

        const nav = performance.getEntriesByType?.("navigation")?.[0];
        const loaded = nav?.loadEventEnd && nav.startTime !== undefined ? nav.loadEventEnd - nav.startTime : 0;
        if (loaded > 4000) out.push({ kind: "slow_page", ms: Math.round(loaded) });
      }

      return out.map((o) => (m === "phone" ? { ...o, phone: true } : o));
    }, { limits: caps, mode });

  try {
    const desktop = await pass("desktop");
    const was = page.viewportSize?.();
    // Only worth asking when the page is not already at phone width — and never mid-exploration,
    // where resizing the window would disturb the run that is clicking through the app.
    if (!phone || !was || was.width <= 600) return desktop;
    let mobile = [];
    try {
      await page.setViewportSize(phone);
      await page.waitForTimeout(350);
      mobile = await pass("phone");
    } finally {
      await page.setViewportSize(was).catch(() => {});
      await page.waitForTimeout(150);
    }
    return [...desktop, ...mobile];
  } catch {
    // An observation pass must never be the reason a run fails.
    return [];
  }
}

/** Turn raw observations into the finding shape the report and the Studio already render. */
export function observationFindings(raw = []) {
  const out = [];
  for (const o of raw) {
    const base = { category: "polish", severity: "low", selector: o.selector || null };
    switch (o.kind) {
      case "low_contrast":
        out.push({ ...base, type: "low_contrast", title: `Hard to read: “${o.text}” is ${o.ratio}:1 against its background (needs ${o.need}:1 at ${o.size}px)`, target: o.selector || o.text });
        break;
      case "tiny_tap_target":
        out.push({ ...base, type: "tiny_tap_target", title: `On a phone, “${o.label}” is ${o.width}×${o.height}px — smaller than a fingertip (about 44px)`, target: o.label });
        break;
      case "phone_overflow":
        out.push({ ...base, severity: "medium", type: "phone_overflow", title: `On a phone the page is ${o.overflow}px wider than the ${o.viewport}px screen — it scrolls sideways`, target: `overflow:${o.overflow}` });
        break;
      case "overlapping_controls":
        out.push({ ...base, type: "overlapping_controls", title: `Overlapping controls: “${o.label}” sits on top of “${o.other}” — one of them takes the tap`, target: o.label });
        break;
      case "clipped_text":
        out.push({ ...base, type: "clipped_text", title: `${o.phone ? "On a phone, text" : "Text"} is cut off: “${o.text}” overflows its box by ${o.cut}px with nothing to show it was trimmed`, target: o.text });
        break;
      case "placeholder_copy":
        out.push({ ...base, severity: "medium", type: "placeholder_copy", title: `Unfinished copy on the page: “${o.text}”`, target: o.text });
        break;
      case "unlabelled_field":
        out.push({ ...base, type: "unlabelled_field", title: `Form field “${o.name}” has no label, placeholder or title — nothing says what to type`, target: o.name });
        break;
      case "nameless_control":
        out.push({ ...base, type: "nameless_control", title: `A <${o.tagName}> with no text or label — neither a person nor a screen reader can tell what it does`, target: o.selector });
        break;
      case "vague_link_text":
        out.push({ ...base, type: "vague_link_text", title: `${o.total} link(s) say only ${o.sample.map((s) => `“${s}”`).join(", ")} — the text alone does not say where they go`, target: o.sample[0] });
        break;
      case "tiny_text":
        out.push({ ...base, type: "tiny_text", title: `Very small text (${o.size}px): “${o.text}”`, target: o.text });
        break;
      case "image_without_alt":
        out.push({ ...base, type: "image_without_alt", title: `Image has no alt text: ${o.src}`, target: o.src });
        break;
      case "no_headline":
        out.push({ ...base, type: "no_headline", title: "The page has no visible <h1> — nothing states what this page is", target: "h1" });
        break;
      case "many_headlines":
        out.push({ ...base, type: "many_headlines", title: `${o.total} <h1> headlines on one page — the page claims several subjects`, target: "h1" });
        break;
      case "weak_page_title":
        out.push({ ...base, type: "weak_page_title", title: `The browser tab says “${o.title || "(nothing)"}” — a bookmark or a tab cannot be told apart`, target: "title" });
        break;
      case "slow_page":
        out.push({ ...base, severity: "medium", type: "slow_page", title: `The page took ${(o.ms / 1000).toFixed(1)}s to finish loading`, target: `${o.ms}ms` });
        break;
      default:
        break;
    }
  }
  return out;
}

/** What this pass looked for, in the words the report uses. */
export const OBSERVATION_SCOPE = [
  "text too faint to read, or too small",
  "controls too small to tap, or overlapping, at phone width",
  "text cut off by its own box, and pages that scroll sideways on a phone",
  "unfinished copy (lorem ipsum, TODO, “coming soon”, undefined)",
  "fields with no label and controls with no name",
  "links that say only “click here”",
  "images with no alt text, pages with no headline, weak tab titles",
  "pages that take more than four seconds to load",
];
