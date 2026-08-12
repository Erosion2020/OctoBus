import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readCached } from "./service-l2-batch.mjs";

test("dry-run never reuses or accepts the formal result cache", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "octobus-l2-cache-"));
  const options = { stateDir, dryRun: false, force: false };
  const pr = { number: 1, headRefOid: "head" };
  const resultDir = path.join(stateDir, "results");
  fs.mkdirSync(resultDir, { recursive: true });
  fs.writeFileSync(path.join(resultDir, "1.json"), JSON.stringify({ headSHA: "head", gateSHA: "gate", executed: false }));
  assert.deepEqual(readCached(options, pr, "gate"), { headSHA: "head", gateSHA: "gate", executed: false });
  assert.equal(readCached({ ...options, dryRun: true }, pr, "gate"), null);
});
