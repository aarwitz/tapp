// Plain-node smoke test of the bridge (no VS Code): open DemoApp, read screen, tap, screenshot.
const { TappBridge } = require("./bridge");

(async () => {
  const b = new TappBridge({ cwd: process.cwd() });
  const t0 = Date.now();
  const mark = (l) => console.log(`\n===== ${l} [t+${((Date.now() - t0) / 1000).toFixed(0)}s] =====`);

  mark("OPEN (bundle id rung)");
  const open = await b.openTarget("io.github.aarwitz.tapp.demoapp", process.cwd());
  console.log(open.error ? `ERROR: ${open.error}` : open.text.slice(0, 300));

  mark("READ SCREEN");
  const read = await b.readScreen();
  console.log(read.error ? `ERROR: ${read.error}` : read.text.slice(0, 250));

  mark("TAP 'Continue'");
  const tap = await b.act({ action: "tap", id: "Continue" });
  console.log(tap.error ? `ERROR: ${tap.error}` : tap.text.slice(0, 250));

  mark("SCREENSHOT");
  const shot = await b.screenshot();
  console.log(shot.error ? `ERROR: ${shot.error}` : `${shot.text} | image: ${shot.image ? shot.image.data.length + " bytes " + shot.image.mimeType : "none"}`);

  mark("DISPOSE");
  await b.dispose();
  console.log("ok");
  process.exit(0);
})();
