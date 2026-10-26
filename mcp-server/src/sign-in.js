// Pressing the button that signs you in.
//
// This used to be a word list — `sign in|log in|login|continue|submit` — in three separate
// places, and a CSS selector that looked for `button[type=submit]` or a button inside a `<form>`.
// Measured against a real customer's sign-in page, every one of those assumptions was wrong:
//
//   • the page has no <form> at all (a React component with an onClick handler);
//   • the buttons carry no `type` ATTRIBUTE, so `button[type=submit]` never matches, even though
//     the DOM *property* reads "submit" — which is what made this look fine when probed by hand;
//   • the button is called "Open My Profile", because products name their buttons after what the
//     product does, not after the verb a test author had in mind.
//
// So the page offered a perfectly ordinary sign-in form and tapp could not press it. It said so
// honestly — a high-severity "the sign-in attempt did not leave the login form" — but honest and
// useless is still useless: the whole promise is that tapp gets *inside* the application.
//
// What is actually reliable is not the button's name but its position: the control that signs you
// in comes after the password field, and the controls that must never be pressed (forgot password,
// create an account, continue with Google) say so in their own words. So: rule out the dangerous
// ones by name, then prefer by name, then fall back to position.

/** Names that mean "this is the sign-in button". Deliberately short — structure does the rest. */
export const SIGN_IN_NAME = /\b(sign ?in|log ?in|login|submit|continue)\b/i;

/**
 * Names that mean "never press this to sign in". Some are merely wrong (forgot password); some
 * are actively harmful — "Continue with Google" would hand a third-party identity provider a
 * session, which a machine must never do on someone's behalf.
 */
export const NOT_SIGN_IN = /forgot|reset|recover|remember|show password|hide password|cancel|go back|back to|sign ?up|create (an |your |a )?account|register|get started free|privacy|terms|need help|help\?|continue with|with google|with apple|with facebook|with github|with microsoft|single sign|\bsso\b|close|dismiss|skip/i;

/** Every control that can plausibly be clicked, in document order. */
export const SUBMIT_CANDIDATE_SELECTOR = "button, input[type=submit], input[type=button], input[type=image], [role=button]";

/**
 * Pick the sign-in control out of the page's clickable controls. Pure, so the ordering rules are
 * testable without a browser.
 *
 * @param {Array<{index:number,name:string,visible:boolean,disabled:boolean,after:boolean}>} candidates
 *   `after` means the control follows the visible password field in document order.
 */
export function chooseSignInSubmit(candidates = []) {
  const usable = candidates.filter((c) => c && c.visible && !c.disabled && String(c.name || "").trim() && !NOT_SIGN_IN.test(c.name));
  const pick = usable.find((c) => c.after && SIGN_IN_NAME.test(c.name))
    || usable.find((c) => SIGN_IN_NAME.test(c.name))
    // Named for what the product does, not for the verb: position is what is left to go on.
    || usable.find((c) => c.after)
    || usable[0]
    || null;
  if (!pick) return null;
  return { ...pick, reason: SIGN_IN_NAME.test(pick.name) ? "name" : "position" };
}

/** Read the page's clickable controls and say which one signs you in. */
export async function findSignInSubmit(page) {
  let candidates;
  try {
    candidates = await page.evaluate((selector) => {
      const visible = (el) => {
        if (!el.getClientRects().length) return false;
        const style = getComputedStyle(el);
        return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity ?? 1) > 0.05;
      };
      const password = Array.from(document.querySelectorAll("input[type=password]")).find(visible) || null;
      return Array.from(document.querySelectorAll(selector)).map((el, index) => ({
        index,
        name: (el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("title") || "").replace(/\s+/g, " ").trim().slice(0, 80),
        visible: visible(el),
        disabled: el.disabled === true || el.getAttribute("aria-disabled") === "true",
        // DOCUMENT_POSITION_FOLLOWING (4): the control comes after the password field.
        after: password ? Boolean(password.compareDocumentPosition(el) & 4) : false,
      }));
    }, SUBMIT_CANDIDATE_SELECTOR);
  } catch { return null; }
  const pick = chooseSignInSubmit(candidates);
  if (!pick) return null;
  // querySelectorAll and Playwright's locator both resolve in document order, so the index carries.
  return { locator: page.locator(SUBMIT_CANDIDATE_SELECTOR).nth(pick.index), name: pick.name, reason: pick.reason };
}

/**
 * Fill nothing, press once. Returns what was pressed so a caller can say so in a report, or null
 * when the page offers no sign-in control at all.
 */
export async function submitSignIn(page, beforeClick = null) {
  const found = await findSignInSubmit(page);
  if (!found) return null;
  if (beforeClick) await beforeClick(found.locator);
  await found.locator.click({ timeout: 3000 });
  return { name: found.name, reason: found.reason };
}
