import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const privateSourceUrls = {
  runner: new URL("../cloud/runner/runner.js", import.meta.url),
  fleet: new URL("../cloud/browser/fleet.js", import.meta.url),
  productJob: new URL("../cloud/runner/product-job.js", import.meta.url),
};
const privateSourcesAvailable = Object.values(privateSourceUrls).every((url) => fs.existsSync(url));
const readPrivateSource = (url) => privateSourcesAvailable ? fs.readFileSync(url, "utf8") : "";
const runnerSource = readPrivateSource(privateSourceUrls.runner);
const engineSource = fs.readFileSync(new URL("../mcp-server/src/index.js", import.meta.url), "utf8");
const fleetSource = readPrivateSource(privateSourceUrls.fleet);
const productJobSource = readPrivateSource(privateSourceUrls.productJob);

test("managed iOS sessions isolate the harness cache and captures inside the leased job", {
  skip: !privateSourcesAvailable && "private cloud runner is not part of the public source tree",
}, () => {
  assert.match(runnerSource, /const sessionHome = path\.join\(jobDir, "tapp-home"\)/);
  assert.match(
    runnerSource,
    /startIosInteractiveSession\(target\.bundleId, \{ TAPP_HOME: sessionHome \}\)/,
  );
});

test("interactive-session startup retains harness stderr for actionable failures", () => {
  assert.match(
    engineSource,
    /proc\.stderr\.on\("data", \(d\) => consumeSessionStdout\(String\(d\)\)\)/,
  );
});

test("the cloud control picker keeps semantic roles and deduplicates accessibility aliases", {
  skip: !privateSourcesAvailable && "private cloud runner is not part of the public source tree",
}, () => {
  assert.match(runnerSource, /role: element\.role \|\| "other"/);
  assert.match(fleetSource, /const actionableRoles = new Set/);
  assert.match(fleetSource, /seenTargets\.has\(key\)/);
});

test("managed release jobs delegate product semantics to shared operations", {
  skip: !privateSourcesAvailable && "private cloud runner is not part of the public source tree",
}, () => {
  assert.doesNotMatch(runnerSource, /parseSimpleYaml|\.tapp\.yml|buildSimulatorApp/);
  assert.match(runnerSource, /operationEnvelope/);
  assert.match(runnerSource, /PRODUCT_JOB/);
  assert.match(productJobSource, /initializeProductProject/);
  assert.match(productJobSource, /prepareProductTarget/);
  assert.match(productJobSource, /runProductGate/);
  assert.match(runnerSource, /remote", "set-url", "origin"/);
  assert.match(runnerSource, /job\.cloneToken = null/);
  assert.match(runnerSource, /HOME:childHome, TMPDIR:childTmp/);
});
