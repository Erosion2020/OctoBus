// Mock upstream for TopSec WAF v3.262406.30229 REST API
import http from "node:http";
import crypto from "node:crypto";

const PORT = Number(process.env.HTTP_PORT || 28443);
const log = (...args) => console.log("[mock-topsec-waf]", ...args);

const AES_KEY = Buffer.from("1111111111111111", "utf8");
const AES_IV = Buffer.from("1111111111111111", "utf8");

const TEST_USER = "admin";
const TEST_PASS = "test123";
const TEST_SECRET = "testsecret1234";

// in-memory stores
const sessions = new Map(); // sid → { authId, secret, tokens }
const ipGroups = new Map(); // name → { group, members }
const serverPolicies = new Map(); // name → { ... }
const customPolicies = new Map(); // securityPolicy → Map(name → policy)

let tokenCounter = 0;
function newToken() {
  tokenCounter++;
  return crypto.randomBytes(8).toString("hex").slice(0, 16);
}

function wrapResponse(data) {
  const token = newToken();
  const json = JSON.stringify(data);
  return `?[${token}]?${json}`;
}

function parseBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);
  const cookie = (req.headers.cookie || "").match(/SESSID=([^;]+)/)?.[1] || "";

  // ── Login ──
  if (url.pathname === "/home/restLogin/" && req.method === "GET") {
    const name = url.searchParams.get("name");
    const password = url.searchParams.get("password");
    const ngtosAuth = url.searchParams.get("ngtosAuth");
    if (!name || !password || !ngtosAuth) {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ result: false, msg: "missing required parameters" }));
      return;
    }
    // Validate password + ngtosAuth: decrypt AES-128-CBC values and compare with expected plaintext
    let valid = false;
    try {
      const decipherPwd = crypto.createDecipheriv("aes-128-cbc", AES_KEY, AES_IV);
      decipherPwd.setAutoPadding(true);
      const decryptedPwd = Buffer.concat([decipherPwd.update(Buffer.from(password, "base64")), decipherPwd.final()]).toString("utf8");
      const decipherAuth = crypto.createDecipheriv("aes-128-cbc", AES_KEY, AES_IV);
      decipherAuth.setAutoPadding(true);
      const decryptedAuth = Buffer.concat([decipherAuth.update(Buffer.from(ngtosAuth, "base64")), decipherAuth.final()]).toString("utf8");
      valid = (name === TEST_USER && decryptedPwd === TEST_PASS && decryptedAuth === String(TEST_PASS.length));
    } catch { valid = false; }
    if (valid) {
      const sid = crypto.randomBytes(13).toString("hex");
      const authId = crypto.randomBytes(4).toString("hex");
      const tokens = Array.from({ length: 50 }, () => newToken());
      sessions.set(sid, { authId, secret: TEST_SECRET, tokens });
      res.writeHead(200, {
        "set-cookie": `SESSID=${sid}; Path=/`,
        "content-type": "application/json; charset=utf-8",
      });
      res.end(JSON.stringify({ result: true, data: { authid: authId, url: "home" }, secret: TEST_SECRET, tokens }));
    } else {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ result: false, msg: "invalid credentials" }));
    }
    return;
  }

  // ── IP Group Show ──
  if (url.pathname === "/home/default/show/" && req.method === "GET" && url.searchParams.get("commands[0][waf_ip_group_show]") !== undefined) {
    const rows = Array.from(ipGroups.values());
    res.writeHead(200);
    res.end(wrapResponse({ result: true, total: rows.length, rows }));
    return;
  }

  // ── IP Group Add ──
  if (url.pathname === "/home/default/add/" && req.method === "POST") {
    const body = await parseBody(req);
    const nameMatch = body.match(/commands\[0\]\[waf_ip_group_add\]\[name\]=([^&]+)/);
    const groupMatch = body.match(/commands\[0\]\[waf_ip_group_add\]\[group\]=([^&]+)/);
    const addrMatch = body.match(/commands\[0\]\[waf_ip_group_add\]\[address\]=([^&]+)/);
    if (nameMatch) {
      ipGroups.set(decodeURIComponent(nameMatch[1]), {
        name: decodeURIComponent(nameMatch[1]),
        group_value: decodeURIComponent(groupMatch?.[1] || "none"),
        ip_group_members: decodeURIComponent(addrMatch?.[1] || ""),
        refer_count: "0",
      });
      res.writeHead(200);
      res.end(wrapResponse({ result: true, data: "success" }));
      return;
    }
  }

  // ── IP Group Delete ──
  if (url.pathname === "/home/default/delete/" && req.method === "POST") {
    const body = await parseBody(req);
    const nameMatch = body.match(/commands\[0\]\[waf_ip_group_delete\]\[name\]=([^&]+)/);
    if (nameMatch && ipGroups.has(decodeURIComponent(nameMatch[1]))) {
      ipGroups.delete(decodeURIComponent(nameMatch[1]));
      res.writeHead(200);
      res.end(wrapResponse({ result: true, data: "success" }));
      return;
    }
  }

  // ── Built-in Rules ──
  if (url.pathname === "/SE/builtRule/showList/" && req.method === "GET") {
    res.writeHead(200);
    res.end(wrapResponse({
      result: true,
      total: 0,
      rows: [],
    }));
    return;
  }

  // ── Custom Policy Show ──
  if (url.pathname === "/home/default/show/" && req.method === "GET" && url.searchParams.get("commands[0][waf_url_rewrite_show_name]")) {
    const sp = new URLSearchParams(url.search);
    const spVal = sp.get("commands[0][waf_url_rewrite_show_name][security-policy]") || "";
    const policies = customPolicies.get(spVal);
    res.writeHead(200);
    res.end(wrapResponse({ result: true, total: policies ? policies.size : 0, rows: policies ? Array.from(policies.values()) : [] }));
    return;
  }

  // ── Custom Policy Add ──
  if (url.pathname === "/SE/Security/userDefinedAdd/" && req.method === "POST") {
    const body = await parseBody(req);
    const params = new URLSearchParams(body);
    const sp = params.get("security_policy");
    const name = params.get("name");
    if (!customPolicies.has(sp)) customPolicies.set(sp, new Map());
    customPolicies.get(sp).set(name, {
      name, enable: params.get("enable") || "on",
      action: params.get("action_type") || "deny",
      phase: params.get("processPhase") || "request_header",
      log_message: params.get("logInfo") || "",
    });
    res.writeHead(200);
    res.end(wrapResponse({ result: true, data: "success" }));
    return;
  }

  // ── Fallback ──
  res.writeHead(200);
  res.end(wrapResponse({ result: true, data: "ok" }));
});

server.listen(PORT, () => {
  log(`TopSec WAF mock listening on port ${PORT}`);
});

export { server, TEST_USER, TEST_PASS, TEST_SECRET, newToken };
