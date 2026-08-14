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

const TOKEN = "abcdef0123456789";
const wafResponse = (payload) => `?[${TOKEN}]?${JSON.stringify(payload)}`;
const loginResponse = (authId = "auth-coverage") => ({
  statusCode: 200,
  headers: { "set-cookie": ["SESSID=test-sid; Path=/"] },
  body: JSON.stringify({
    result: true,
    data: { authid: authId, url: "home" },
    secret: "testsecret1234",
    tokens: [TOKEN],
  }),
});

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

  describe("RPC handler coverage", { concurrency: false }, () => {
    it("implements and exercises every RPC advertised by the proto", async () => {
      const ctx = {
        config: { waf_base_url: "https://handler-coverage.example:8443" },
        secret: { username: "admin", password: "test123" },
      };
      const api = (payload) => ({ statusCode: 200, body: wafResponse(payload) });
      const fullRow = {
        name: "policy-1", enable: "on", mode: "enable", "security-policy": "security-1",
        ipgroup: "group-1", "server-environment": "default_env", level: "high", action: "deny",
        phase: "request_header", log_message: "blocked", defence_xss: "on", defence_scanner: "on",
        defence_sqli: "on", defence_osi: "on", defence_rfi: "off", defence_dir: "off",
        defence_leakage: "off", defence_ldap: "off", defence_xpath: "off", defence_ssi: "off",
        defence_server: "off", defence_other: "off", defence_user: "off", defence_webshell: "off",
        defence_all: "off", action_xss: "deny", action_sqli: "alert", action_dir: "deny",
        action_scanner: "alert", action_webshell: "deny", action_user: "alert", action_all: "deny",
        rid: "42", status: "on", r_description: "description", at_name: "XSS", accu_accuracy: "high",
      };
      const calls = [
        ["waf.v1.WafIpGroupService/ShowIpGroups", { name: "group-1" }, { result: true, total: 1, rows: [{ ...fullRow, group_value: "global", ip_group_members: "192.0.2.1/32,black", refer_count: 2 }] }],
        ["waf.v1.WafIpGroupService/AddBlackIp", { name: "black-1", ip: "192.0.2.1", mask: 24, scope: "global" }, { result: true, data: "success" }],
        ["waf.v1.WafIpGroupService/AddWhiteIp", { name: "white-1", ip: "192.0.2.2", mask: 32, scope: "global" }, { result: true, data: "success" }],
        ["waf.v1.WafIpGroupService/DeleteIpGroup", { name: "group-1" }, { result: true, data: "success" }],
        ["waf.v1.WafServerPolicyService/ShowServerPolicies", { name: "policy-1" }, { result: true, total: 1, rows: [fullRow] }],
        ["waf.v1.WafServerPolicyService/AddServerPolicy", { name: "policy-2", enable: "off", trafficLog: "on", mode: "detection", securityPolicy: "security-1", ipGroup: "group-1", serverEnvironment: "env-1" }, { result: true, data: "success" }],
        ["waf.v1.WafServerPolicyService/ModifyServerPolicy", { name: "policy-2", enable: "on", trafficLog: "off", mode: "enable", securityPolicy: "security-2", ipGroup: "", serverEnvironment: "env-2" }, { result: true, data: "success" }],
        ["waf.v1.WafServerPolicyService/DeleteServerPolicy", { name: "policy-2" }, { result: true, data: "success" }],
        ["waf.v1.WafCustomPolicyService/ShowCustomPolicies", { securityPolicy: "security-1", name: "rule-1" }, { result: true, total: 1, rows: [fullRow] }],
        ["waf.v1.WafCustomPolicyService/AddCustomPolicy", { securityPolicy: "security-1", name: "rule-1", enable: "on", level: "high", processPhase: "request_header", actionType: "deny", actionData: "", logInfo: "blocked", conditions: [{ variableName: "CLIENT_IP", variableInput: "", operator: "strEqual", expression: "192.0.2.1" }] }, { result: true, data: "success" }],
        ["waf.v1.WafCustomPolicyService/ModifyCustomPolicy", { securityPolicy: "security-1", name: "rule-1", enable: "off", level: "low", processPhase: "response_body", actionType: "alert", actionData: "", logInfo: "updated", conditions: [{ variableName: "REQUEST_URI_RAW", operator: "contains", expression: "/admin" }] }, { result: true, data: "success" }],
        ["waf.v1.WafCustomPolicyService/DeleteCustomPolicy", { securityPolicy: "security-1", name: "rule-1" }, { result: true, data: "success" }],
        ["waf.v1.WafRuleService/ShowDefencePolicy", { securityPolicy: "security-1" }, { result: true, total: 1, rows: [fullRow] }],
        ["waf.v1.WafRuleService/ShowRuleActions", { securityPolicy: "security-1" }, { result: true, total: 1, rows: [fullRow] }],
        ["waf.v1.WafRuleService/ShowBuiltRules", { securityPolicy: "security-1", ruleType: "core", page: 2, rows: 10 }, { result: true, total: 1, rows: [fullRow] }],
        ["waf.v1.WafRuleService/SearchBuiltRules", { securityPolicy: "security-1", ruleType: "app", attackType: "XSS", conditionQuery: "needle", page: 2, rows: 10 }, { result: true, total: 1, rows: [fullRow] }],
      ];

      assert.deepStrictEqual(Object.keys(handlers).sort(), ["waf.v1.WafAuthService/Login", ...calls.map(([method]) => method)].sort());
      await withMockedHttps([loginResponse(), ...calls.map(([, , payload]) => api(payload))], async () => {
        assert.strictEqual((await handlers["waf.v1.WafAuthService/Login"](ctx)).success, true);
        for (const [method, request] of calls) {
          const result = await handlers[method]({ config: ctx.config, request });
          assert.strictEqual(result.success, true, method);
        }
      });
    });

    it("returns structured validation and unauthenticated errors", async () => {
      const config = { waf_base_url: "https://validation.example:8443" };
      assert.match((await handlers["waf.v1.WafIpGroupService/AddBlackIp"]({ config, request: { scope: "site" } })).message, /scope/);
      assert.match((await handlers["waf.v1.WafIpGroupService/AddBlackIp"]({ config, request: { scope: "none" } })).message, /serverPolicy/);
      assert.match((await handlers["waf.v1.WafIpGroupService/AddWhiteIp"]({ config, request: { scope: "none" } })).message, /serverPolicy/);
      assert.strictEqual((await handlers["waf.v1.WafIpGroupService/ShowIpGroups"]({ config, request: {} })).success, false);
      assert.strictEqual((await handlers["waf.v1.WafAuthService/Login"]({ secret: { username: "admin", password: "test123" } })).success, false);
      assert.strictEqual((await handlers["waf.v1.WafAuthService/Login"]({ config, secret: { username: "", password: "" } })).success, false);
    });

    it("uses documented defaults and maps sparse WAF responses", async () => {
      const ctx = {
        config: { waf_base_url: "https://defaults.example:8443" },
        secret: { username: "admin", password: "test123" },
      };
      const calls = [
        ["waf.v1.WafIpGroupService/ShowIpGroups", {}],
        ["waf.v1.WafIpGroupService/AddBlackIp", { scope: "global" }],
        ["waf.v1.WafIpGroupService/AddWhiteIp", { scope: "global" }],
        ["waf.v1.WafIpGroupService/DeleteIpGroup", {}],
        ["waf.v1.WafServerPolicyService/ShowServerPolicies", {}],
        ["waf.v1.WafServerPolicyService/AddServerPolicy", {}],
        ["waf.v1.WafServerPolicyService/ModifyServerPolicy", {}],
        ["waf.v1.WafServerPolicyService/DeleteServerPolicy", {}],
        ["waf.v1.WafCustomPolicyService/ShowCustomPolicies", {}],
        ["waf.v1.WafCustomPolicyService/AddCustomPolicy", {}],
        ["waf.v1.WafCustomPolicyService/ModifyCustomPolicy", {}],
        ["waf.v1.WafCustomPolicyService/DeleteCustomPolicy", {}],
        ["waf.v1.WafRuleService/ShowDefencePolicy", {}],
        ["waf.v1.WafRuleService/ShowRuleActions", {}],
        ["waf.v1.WafRuleService/ShowBuiltRules", {}],
        ["waf.v1.WafRuleService/SearchBuiltRules", {}],
      ];
      await withMockedHttps([loginResponse("auth-defaults"), ...calls.map(() => ({ statusCode: 200, body: wafResponse({ result: true, total: 0, rows: [{}] }) }))], async () => {
        assert.strictEqual((await handlers["waf.v1.WafAuthService/Login"](ctx)).success, true);
        for (const [method, request] of calls) {
          assert.strictEqual((await handlers[method]({ config: ctx.config, request })).success, true, method);
        }
      });
    });

    it("binds non-global IP groups and rolls them back when binding fails", async () => {
      const ctx = {
        config: { waf_base_url: "https://rollback.example:8443" },
        secret: { username: "admin", password: "test123" },
      };
      await withMockedHttps([
        loginResponse("auth-bind"),
        { statusCode: 200, body: wafResponse({ result: true, data: "created" }) },
        { statusCode: 200, body: wafResponse({ result: true, data: "bound" }) },
        { statusCode: 200, body: wafResponse({ result: true, data: "created" }) },
        { statusCode: 200, body: wafResponse({ result: false, data: "missing policy" }) },
        { statusCode: 200, body: wafResponse({ result: true, data: "deleted" }) },
        { statusCode: 200, body: wafResponse({ result: true, data: "created" }) },
        { statusCode: 200, body: wafResponse({ result: false, data: "missing policy" }) },
        { statusCode: 200, body: wafResponse({ result: true, data: "deleted" }) },
        { statusCode: 200, body: wafResponse({ result: true, data: "created" }) },
        { statusCode: 200, body: wafResponse({ result: true, data: "bound" }) },
      ], async () => {
        await handlers["waf.v1.WafAuthService/Login"](ctx);
        const bound = await handlers["waf.v1.WafIpGroupService/AddBlackIp"]({ config: ctx.config, request: { name: "bound", ip: "192.0.2.1", scope: "none", serverPolicy: "policy" } });
        assert.match(bound.message, /已绑定/);
        const rolledBack = await handlers["waf.v1.WafIpGroupService/AddWhiteIp"]({ config: ctx.config, request: { name: "rollback", ip: "192.0.2.2", scope: "none", serverPolicy: "missing" } });
        assert.match(rolledBack.message, /已回滚删除/);
        const blackRolledBack = await handlers["waf.v1.WafIpGroupService/AddBlackIp"]({ config: ctx.config, request: { name: "black-rollback", ip: "192.0.2.3", scope: "none", serverPolicy: "missing" } });
        assert.match(blackRolledBack.message, /已回滚删除/);
        const whiteBound = await handlers["waf.v1.WafIpGroupService/AddWhiteIp"]({ config: ctx.config, request: { name: "white-bound", ip: "192.0.2.4", scope: "none", serverPolicy: "policy" } });
        assert.match(whiteBound.message, /已绑定/);
      });
    });

    it("uses HTTP for local WAFs and keeps TLS verification secure by default", async () => {
      const local = await handlers["waf.v1.WafAuthService/Login"]({
        config: { waf_base_url: BASE },
        secret: { username: "admin", password: "test123" },
      });
      assert.strictEqual(local.success, true);

      await withMockedHttps([{ error: new Error("boom") }, { error: new Error("boom") }], async (seenOpts) => {
        await handlers["waf.v1.WafAuthService/Login"]({ config: { waf_base_url: "https://tls-default.example" }, secret: { username: "admin", password: "test123" } });
        await handlers["waf.v1.WafAuthService/Login"]({ config: { waf_base_url: "https://tls-disabled.example", tls_verify: false }, secret: { username: "admin", password: "test123" } });
        assert.strictEqual(seenOpts[0].rejectUnauthorized, true);
        assert.strictEqual(seenOpts[1].rejectUnauthorized, false);
      });

      await withMockedHttps([{
        statusCode: 200,
        headers: { "set-cookie": "SESSID=fallback-sid; Path=/" },
        body: JSON.stringify({ result: true, data: { authid: "fallback-auth" }, secret: "secret", tokens: [TOKEN] }),
      }], async () => {
        const fallback = await handlers["waf.v1.WafAuthService/Login"]({ config: { waf_base_url: "https://cookie-fallback.example" }, secret: { username: "admin", password: "test123" } });
        assert.strictEqual(fallback.sessionId, "fallback-sid");
      });
    });

    it("handles upstream transport, login, and business failures without losing the session", async () => {
      const noSession = { config: { waf_base_url: "https://no-session.example" }, request: {} };
      assert.strictEqual((await handlers["waf.v1.WafRuleService/ShowBuiltRules"](noSession)).success, false);
      const ctx = {
        config: { waf_base_url: "https://failure-coverage.example:8443" },
        secret: { username: "admin", password: "test123" },
      };
      await withMockedHttps([
        loginResponse("auth-failures"),
        { error: new Error("network down") },
        { error: new Error("network down") },
        { statusCode: 200, body: wafResponse({ result: false, data: "已存在" }) },
        { statusCode: 200, body: wafResponse({ result: false, data: "已存在" }) },
        { statusCode: 200, body: wafResponse({ result: false, data: "被引用" }) },
        { statusCode: 200, body: wafResponse({ result: false, data: "不存在" }) },
        { statusCode: 200, body: wafResponse({ result: false, data: "已经存在" }) },
        { statusCode: 200, body: wafResponse({ result: false, data: "内置变量错误" }) },
        { statusCode: 200, body: wafResponse({ result: false, data: "不存在" }) },
      ], async () => {
        await handlers["waf.v1.WafAuthService/Login"](ctx);
        assert.strictEqual((await handlers["waf.v1.WafIpGroupService/ShowIpGroups"]({ config: ctx.config, request: {} })).success, false);
        assert.strictEqual((await handlers["waf.v1.WafRuleService/ShowBuiltRules"]({ config: ctx.config, request: {} })).success, false);
        assert.match((await handlers["waf.v1.WafIpGroupService/AddBlackIp"]({ config: ctx.config, request: { scope: "global", name: "existing" } })).message, /已存在/);
        assert.match((await handlers["waf.v1.WafIpGroupService/AddWhiteIp"]({ config: ctx.config, request: { scope: "global", name: "existing" } })).message, /已存在/);
        assert.match((await handlers["waf.v1.WafIpGroupService/DeleteIpGroup"]({ config: ctx.config, request: { name: "referenced" } })).message, /引用/);
        assert.match((await handlers["waf.v1.WafIpGroupService/DeleteIpGroup"]({ config: ctx.config, request: { name: "missing" } })).message, /不存在/);
        assert.match((await handlers["waf.v1.WafCustomPolicyService/AddCustomPolicy"]({ config: ctx.config, request: {} })).message, /已存在/);
        assert.match((await handlers["waf.v1.WafCustomPolicyService/AddCustomPolicy"]({ config: ctx.config, request: {} })).message, /内置变量/);
        assert.match((await handlers["waf.v1.WafCustomPolicyService/DeleteCustomPolicy"]({ config: ctx.config, request: {} })).message, /不存在/);
      });

      await withMockedHttps([
        { statusCode: 502, body: "<html>bad gateway</html>" },
        { statusCode: 200, body: JSON.stringify({ result: false, msg: "denied" }) },
      ], async () => {
        assert.match((await handlers["waf.v1.WafAuthService/Login"](ctx)).message, /non-JSON/);
        assert.strictEqual((await handlers["waf.v1.WafAuthService/Login"](ctx)).message, "denied");
      });
      assert.match((await handlers["waf.v1.WafIpGroupService/AddWhiteIp"]({ config: ctx.config, request: { scope: "invalid" } })).message, /scope/);
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
