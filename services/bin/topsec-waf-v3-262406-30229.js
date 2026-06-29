#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { runServiceMain } from "@chaitin-ai/octobus-sdk";

import { service } from "../topsec__waf_v3-262406-30229/src/service.js";

runServiceMain(service, {
  entryFile: fileURLToPath(new URL("../topsec__waf_v3-262406-30229/bin/topsec-waf-v3-262406-30229.js", import.meta.url)),
});
