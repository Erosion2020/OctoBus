// Smoke tests for TopSec WAF v3.262406.30229 service
import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import https from "node:https";

import { server } from "./mock_upstream.js";
import { handlers } from "../src/topsec-waf-v3-262406-30229.js";

const BASE = `http://localhost:${process.env.HTTP_PORT || 28443}`;
const AES_KEY = Buffer.from("1111111111111111", "utf8");
const AES_IV = Buffer.from("1111111111111111", "utf8");

function aesEncrypt(plaintext) {
  const cipher = crypto.createCipheriv("aes-128-cbc", AES_KEY, AES_IV);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]).toString("base64");
}

async function withMockedHttps(responses, fn) {
  const originalRequest = https.request;
  const seenOpts = [];
  let index = 0;

  https.request = (opts, callback) => {
    seenOpts.push(opts);
    const req = new EventEmitter();
    req.write = () => {};
    req.destroy = () => {};
    req.end = () => {
      const step = responses[index++];
      if (!step) throw new Error("Unexpected https.request call");
      if (step.error) {
        queueMicrotask(() => req.emit("error", step.error));
        return;
      }

      const res = new EventEmitter();
      res.statusCode = step.statusCode ?? 200;
      res.headers = step.headers ?? {};
      callback(res);
      queueMicrotask(() => {
        if (step.body !== undefined) res.emit("data", Buffer.from(step.body));
        res.emit("end");
      });
    };
    return req;
  };

  try {
    return await fn(seenOpts);
  } finally {
    https.request = originalRequest;
  }
}

describe("TopSec WAF v3.262406.30229", () => {
  before(() => {
    // Mock server started via import side-effect
  });

  after(() => {
    server.close();
  });

  describe("Login", () => {
    it("should login with valid credentials", async () => {
      const password = aesEncrypt("test123");
      const ngtosAuth = aesEncrypt("7");
      const res = await fetch(`${BASE}/home/restLogin/?name=admin&password=${encodeURIComponent(password)}&ngtosAuth=${encodeURIComponent(ngtosAuth)}`);
      const body = await res.text();
      const data = JSON.parse(body);
      assert.strictEqual(data.result, true);
      assert.ok(data.data?.authid);
    });

    it("should fail with invalid credentials", async () => {
      const password = aesEncrypt("wrongpass");
      const ngtosAuth = aesEncrypt("7");
      const res = await fetch(`${BASE}/home/restLogin/?name=admin&password=${encodeURIComponent(password)}&ngtosAuth=${encodeURIComponent(ngtosAuth)}`);
      const body = await res.text();
      const data = JSON.parse(body);
      assert.strictEqual(data.result, false);
      assert.strictEqual(data.msg, "invalid credentials");
    });
  });

  describe("Regression coverage", { concurrency: false }, () => {
    it("should pass tls_verify to login HTTPS requests", async () => {
      await withMockedHttps([
        { error: new Error("boom") },
      ], async (seenOpts) => {
        const result = await handlers["waf.v1.WafAuthService/Login"]({
          config: { waf_base_url: "https://login-tls-check.example:8443", tls_verify: true },
          secret: { username: "admin", password: "test123" },
        });

        assert.strictEqual(result.success, false);
        assert.strictEqual(result.message, "WAF login request failed");
        assert.strictEqual(seenOpts.length, 1);
        assert.strictEqual(seenOpts[0].rejectUnauthorized, true);
      });
    });

    it("should restore token after callWafApi parse failure", async () => {
      await withMockedHttps([
        {
          statusCode: 200,
          headers: { "set-cookie": ["SESSID=test-sid; Path=/"] },
          body: JSON.stringify({
            result: true,
            data: { authid: "auth-1", url: "home" },
            secret: "testsecret1234",
            tokens: ["1234567890abcdef"],
          }),
        },
        { statusCode: 200, body: "not-json" },
        { statusCode: 200, body: JSON.stringify({ result: true, total: 0, rows: [] }) },
      ], async () => {
        const ctx = {
          config: { waf_base_url: "https://callwaf-parse.example:8443" },
          secret: { username: "admin", password: "test123" },
        };

        const loginResult = await handlers["waf.v1.WafAuthService/Login"](ctx);
        assert.strictEqual(loginResult.success, true);

        const first = await handlers["waf.v1.WafIpGroupService/ShowIpGroups"]({
          config: { waf_base_url: ctx.config.waf_base_url },
          request: {},
        });
        assert.strictEqual(first.success, false);
        assert.strictEqual(first.message, "invalid WAF response");

        const second = await handlers["waf.v1.WafIpGroupService/ShowIpGroups"]({
          config: { waf_base_url: ctx.config.waf_base_url },
          request: {},
        });
        assert.strictEqual(second.success, true);
        assert.strictEqual(second.total, 0);
      });
    });

    it("should restore token after callSeSecurityApi parse failure", async () => {
      await withMockedHttps([
        {
          statusCode: 200,
          headers: { "set-cookie": ["SESSID=test-sid; Path=/"] },
          body: JSON.stringify({
            result: true,
            data: { authid: "auth-2", url: "home" },
            secret: "testsecret1234",
            tokens: ["fedcba0987654321"],
          }),
        },
        { statusCode: 200, body: "not-json" },
        { statusCode: 200, body: JSON.stringify({ result: true, total: 0, rows: [] }) },
      ], async () => {
        const ctx = {
          config: { waf_base_url: "https://callse-parse.example:8443" },
          secret: { username: "admin", password: "test123" },
        };

        const loginResult = await handlers["waf.v1.WafAuthService/Login"](ctx);
        assert.strictEqual(loginResult.success, true);

        const first = await handlers["waf.v1.WafRuleService/ShowBuiltRules"]({
          config: { waf_base_url: ctx.config.waf_base_url },
          request: { securityPolicy: "test" },
        });
        assert.strictEqual(first.success, false);
        assert.strictEqual(first.message, "invalid WAF response");

        const second = await handlers["waf.v1.WafRuleService/ShowBuiltRules"]({
          config: { waf_base_url: ctx.config.waf_base_url },
          request: { securityPolicy: "test" },
        });
        assert.strictEqual(second.success, true);
        assert.strictEqual(second.total, 0);
      });
    });
  });

  describe("IP Group", () => {
    it("should add and list IP groups", async () => {
      // Add
      const addRes = await fetch(`${BASE}/home/default/add/?userMark=test`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "commands[0][waf_ip_group_add][name]=test-group&commands[0][waf_ip_group_add][group]=none&commands[0][waf_ip_group_add][address]=1.2.3.4/32,black",
      });
      const addBody = await addRes.text();
      assert.ok(addBody.includes("success"));

      // List
      const listRes = await fetch(`${BASE}/home/default/show/?commands%5B0%5D%5Bwaf_ip_group_show%5D=`);
      const listBody = await listRes.text();
      assert.ok(listBody.includes("test-group"));
    });
  });

  describe("Built-in Rules", () => {
    it("should list rules", async () => {
      const res = await fetch(`${BASE}/SE/builtRule/showList/?security_policy=test&rule_type=built&page=1&rows=10`);
      const body = await res.text();
      assert.ok(body.includes("rows"));
    });
  });
});
