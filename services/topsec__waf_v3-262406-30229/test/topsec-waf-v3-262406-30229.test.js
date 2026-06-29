// Smoke tests for TopSec WAF v3.262406.30229 service
import { describe, it, before, after } from "node:test";
import assert from "node:assert";

import { server } from "./mock_upstream.js";

const BASE = `http://localhost:${process.env.HTTP_PORT || 28443}`;

describe("TopSec WAF v3.262406.30229", () => {
  before(() => {
    // Mock server started via import side-effect
  });

  after(() => {
    server.close();
  });

  describe("Login", () => {
    it("should login with valid credentials", async () => {
      const res = await fetch(`${BASE}/home/restLogin/?name=admin&password=encrypted&ngtosAuth=encrypted`);
      const body = await res.text();
      const data = JSON.parse(body);
      assert.strictEqual(data.result, true);
      assert.ok(data.data?.authid);
    });

    it("should fail with invalid credentials", async () => {
      const res = await fetch(`${BASE}/home/restLogin/?name=wrong&password=xxx`);
      const body = await res.text();
      const data = JSON.parse(body);
      assert.strictEqual(data.result, false);
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
