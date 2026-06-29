import crypto from 'node:crypto';
import https from 'node:https';

// ── WAF 3.0 Protocol ───────────────────────────────────────────────────
//
// Authentication:  GET /home/restLogin/  (AES-128-CBC encrypted password)
// API signature:   codeRun = MD5(secret + token + urlPath + paramJson)
// Token rotation:  response prefix = ?[16-char-new-token]?{json}
// Session:         SESSID cookie from login response header
// ───────────────────────────────────────────────────────────────────────

const AES_KEY = Buffer.from("1111111111111111", "utf8");
const AES_IV  = Buffer.from("1111111111111111", "utf8");

// ── helpers ────────────────────────────────────────────────────────────

function aesEncrypt(plaintext) {
  const cipher = crypto.createCipheriv("aes-128-cbc", AES_KEY, AES_IV);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]).toString("base64");
}

function md5(s) { return crypto.createHash("md5").update(s).digest("hex"); }

function httpsGet(urlStr, cookie, tlsVerify = false) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const opts = {
      hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search,
      method: "GET", rejectUnauthorized: tlsVerify, timeout: 30_000,
    };
    if (cookie) opts.headers = { Cookie: `SESSID=${cookie}` };
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks);
        const sc = res.headers["set-cookie"];
        const sid = Array.isArray(sc) ? (sc[0] || "").match(/SESSID=([^;]+)/)?.[1] || "" : "";
        resolve({ status: res.statusCode, body: raw.toString("utf8"), raw, sid });
      });
      res.on("error", reject);
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.on("error", reject);
    req.end();
  });
}

function httpsPost(urlStr, body, cookie, tlsVerify = false) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const opts = {
      hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search,
      method: "POST", rejectUnauthorized: tlsVerify, timeout: 30_000,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    };
    if (cookie) opts.headers.Cookie = `SESSID=${cookie}`;
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function extractSessionId(setCookieHeaders) {
  if (!setCookieHeaders) return "";
  const headers = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
  for (const h of headers) {
    const m = h.match(/SESSID=([^;]+)/);
    if (m) return m[1];
  }
  return "";
}

function wafUrl(baseUrl, path) {
  return `${baseUrl.replace(/\/+$/, "")}${path.startsWith("/") ? path : "/" + path}`;
}

/**
 * Parse WAF response, extract new token from prefix.
 * Format: ?[16-char-hex-token]?{json}
 */
function parseWafResponse(raw, tokens) {
  if (raw.length >= 20) {
    const tok = raw.slice(2, 18);
    if (/^[0-9a-fA-F]{16}$/.test(tok)) {
      tokens.push(tok);
      return JSON.parse(raw.slice(20));
    }
  }
  return JSON.parse(raw);
}

// ── session cache ──────────────────────────────────────────────────────

const sessions = new Map(); // wafBaseUrl → { sid, authId, secret, tokens }

function getSession(wafBaseUrl) {
  const s = sessions.get(wafBaseUrl);
  if (!s || s.tokens.length === 0) return null;
  return s;
}

function setSession(wafBaseUrl, session) {
  sessions.set(wafBaseUrl, session);
}

// ── API caller ─────────────────────────────────────────────────────────

function formatParamWaf(commands) {
  const ret = {};
  commands.forEach((cmd, i) => {
    const [cmdName, cmdArgs] = Object.entries(cmd)[0];
    if (typeof cmdArgs === "object" && cmdArgs !== null) {
      for (const [k, v] of Object.entries(cmdArgs)) {
        ret[`commands[${i}][${cmdName}][${k}]`] = String(v);
      }
    } else {
      ret[`commands[${i}][${cmdName}]`] = String(cmdArgs ?? "");
    }
  });
  return ret;
}

function buildQuery(params) {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

async function callWafApi(method, urlPath, commands, wafBaseUrl) {
  const session = getSession(wafBaseUrl);
  if (!session) {
    return { success: false, message: "not logged in — call Login first" };
  }

  const paramJson = JSON.stringify(commands);
  const token = session.tokens.shift();
  const codeRun = md5(session.secret + token + urlPath + paramJson);

  const flatParams = formatParamWaf(commands);
  flatParams.userMark = session.authId;
  flatParams.token = token;
  flatParams.codeRun = codeRun;
  flatParams.errorMode = "1";

  const qs = buildQuery(flatParams);
  const tlsVerify = session.tlsVerify === true;
  let res;
  try {
    if (method === "GET") {
      res = await httpsGet(`${wafBaseUrl}${urlPath}?${qs}`, session.sid, tlsVerify);
    } else {
      res = await httpsPost(`${wafBaseUrl}${urlPath}?userMark=${session.authId}`, qs, session.sid, tlsVerify);
    }
  } catch (err) {
    // restore token on network failure
    session.tokens.unshift(token);
    return { success: false, message: "WAF request failed" };
  }

  let parsed;
  try {
    parsed = parseWafResponse(res.body, session.tokens);
  } catch {
    session.tokens.unshift(token);
    return { success: false, message: "invalid WAF response" };
  }
  parsed._httpStatus = res.status;
  return parsed;
}

// ── gRPC handlers ──────────────────────────────────────────────────────

async function login(ctx) {
  const req = ctx.request ?? {};
  const config = ctx.config ?? {};
  const secret = ctx.secret ?? {};

  const wafBaseUrl = req.wafBaseUrl || config.waf_base_url || "";
  const username = secret.username || "";
  const password = secret.password || "";

  if (!wafBaseUrl) return { success: false, sessionId: "", authId: "", secret: "", tokens: [], message: "waf_base_url not configured" };
  if (!username || !password) return { success: false, sessionId: "", authId: "", secret: "", tokens: [], message: "credentials not configured" };

  const encPwd = aesEncrypt(password);
  const encLen = aesEncrypt(String(password.length));
  const tlsVerify = config.tls_verify === true;
  const url = wafUrl(wafBaseUrl, `/home/restLogin/?name=${encodeURIComponent(username)}&password=${encodeURIComponent(encPwd)}&ngtosAuth=${encodeURIComponent(encLen)}`);

  try {
    const res = await httpsGet(url, undefined, tlsVerify);
    const sid = res.sid || extractSessionId(res.headers?.["set-cookie"]);
    let data;
    try { data = JSON.parse(res.body); } catch {
      return { success: false, sessionId: "", authId: "", secret: "", tokens: [], message: `WAF login returned non-JSON response (HTTP ${res.status})` };
    }
    if (data.result !== true || !data.data) {
      return { success: false, sessionId: sid, authId: "", secret: "", tokens: [], message: data.msg || data.message || "login failed" };
    }

    const authId = data.data.authid || "";
    const wafSecret = data.secret || "";
    const tokens = Array.isArray(data.tokens) ? [...data.tokens] : [];

    setSession(wafBaseUrl, { sid, authId, secret: wafSecret, tokens, tlsVerify: config.tls_verify === true });

    return { success: true, sessionId: sid, authId, secret: wafSecret, tokens, message: "ok" };
  } catch (err) {
    return { success: false, sessionId: "", authId: "", secret: "", tokens: [], message: "WAF login request failed" };
  }
}

async function showIpGroups(ctx) {
  const req = ctx.request ?? {};
  const config = ctx.config ?? {};
  const wafBaseUrl = config.waf_base_url || "";

  const commands = [{ waf_ip_group_show: req.name ? { name: req.name } : "" }];
  const result = await callWafApi("GET", "/home/default/show/", commands, wafBaseUrl);

  return {
    success: result.result === true,
    total: result.total || 0,
    rows: (result.rows || []).map(r => ({
      name: r.name || "",
      groupValue: r.group_value || "",
      ipGroupMembers: r.ip_group_members || "",
      referCount: String(r.refer_count || ""),
    })),
    message: result.data || result.message || "",
  };
}

async function addBlackIp(ctx) {
  const req = ctx.request ?? {};
  const config = ctx.config ?? {};
  const wafBaseUrl = config.waf_base_url || "";

  const ip   = req.ip || "";
  const mask = req.mask || 32;
  const scope = req.scope || "none";
  const address = `${ip}/${mask},black`;

  // scope 校验
  if (scope !== "global" && scope !== "none") {
    return { success: false, data: "", message: `scope 参数无效："${scope}"，请填写 "global"（全局，对所有站点生效）或 "none"（非全局，需绑定服务器策略）。` };
  }
  if (scope === "none" && !req.serverPolicy) {
    return { success: false, data: "", message: "非全局（scope=none）时必须指定服务器策略（serverPolicy）。请先调用 ShowServerPolicies 查询可用策略，或调用 AddServerPolicy 新建策略。" };
  }

  const commands = [{ waf_ip_group_add: { name: req.name || "", group: scope, address } }];
  const result = await callWafApi("POST", "/home/default/add/", commands, wafBaseUrl);

  let message = result.data || result.message || "";
  if (result.result === true && scope === "none" && req.serverPolicy) {
    const modCmds = [{ waf_server_policy_modify: { name: req.serverPolicy, "ip-group": req.name } }];
    const bindResult = await callWafApi("POST", "/home/default/modify/", modCmds, wafBaseUrl);
    if (bindResult.result === true) {
      message = `黑名单IP组 "${req.name}" 创建成功，已绑定到服务器策略 "${req.serverPolicy}"。`;
    } else {
      // rollback: delete the orphaned ip group
      await callWafApi("POST", "/home/default/delete/",
        [{ waf_ip_group_delete: { name: req.name } }], wafBaseUrl);
      message = `黑名单IP组 "${req.name}" 创建成功，但绑定服务器策略失败，已回滚删除。请检查服务器策略 "${req.serverPolicy}" 是否存在。`;
    }
  } else if (result.result === true && scope === "global") {
    message = `全局黑名单IP组 "${req.name}" 创建成功，对所有站点生效。`;
  } else if (message.includes("已存在")) {
    message = `创建失败：IP组 "${req.name}" 已存在。`;
  }

  return { success: result.result === true, data: result.data || "", message };
}

async function addWhiteIp(ctx) {
  const req = ctx.request ?? {};
  const config = ctx.config ?? {};
  const wafBaseUrl = config.waf_base_url || "";

  const ip   = req.ip || "";
  const mask = req.mask || 32;
  const scope = req.scope || "none";
  const address = `${ip}/${mask},white`;

  if (scope !== "global" && scope !== "none") {
    return { success: false, data: "", message: `scope 参数无效："${scope}"，请填写 "global"（全局，对所有站点生效）或 "none"（非全局，需绑定服务器策略）。` };
  }
  if (scope === "none" && !req.serverPolicy) {
    return { success: false, data: "", message: "非全局（scope=none）时必须指定服务器策略（serverPolicy）。请先调用 ShowServerPolicies 查询可用策略，或调用 AddServerPolicy 新建策略。" };
  }

  const commands = [{ waf_ip_group_add: { name: req.name || "", group: scope, address } }];
  const result = await callWafApi("POST", "/home/default/add/", commands, wafBaseUrl);

  let message = result.data || result.message || "";
  if (result.result === true && scope === "none" && req.serverPolicy) {
    const modCmds = [{ waf_server_policy_modify: { name: req.serverPolicy, "ip-group": req.name } }];
    const bindResult = await callWafApi("POST", "/home/default/modify/", modCmds, wafBaseUrl);
    if (bindResult.result === true) {
      message = `白名单IP组 "${req.name}" 创建成功，已绑定到服务器策略 "${req.serverPolicy}"。`;
    } else {
      // rollback: delete the orphaned ip group
      await callWafApi("POST", "/home/default/delete/",
        [{ waf_ip_group_delete: { name: req.name } }], wafBaseUrl);
      message = `白名单IP组 "${req.name}" 创建成功，但绑定服务器策略失败，已回滚删除。请检查服务器策略 "${req.serverPolicy}" 是否存在。`;
    }
  } else if (result.result === true && scope === "global") {
    message = `全局白名单IP组 "${req.name}" 创建成功，对所有站点生效。`;
  } else if (message.includes("已存在")) {
    message = `创建失败：IP组 "${req.name}" 已存在。`;
  }

  return { success: result.result === true, data: result.data || "", message };
}

async function deleteIpGroup(ctx) {
  const req = ctx.request ?? {};
  const config = ctx.config ?? {};
  const wafBaseUrl = config.waf_base_url || "";

  const commands = [{ waf_ip_group_delete: { name: req.name || "" } }];
  const result = await callWafApi("POST", "/home/default/delete/", commands, wafBaseUrl);

  let message = result.data || result.message || "";
  // 被服务器策略引用时提示去 web 解绑
  if (message.includes("被引用") || message.includes("引用")) {
    message = `删除失败：IP组 "${req.name}" 正被服务器策略引用，无法直接删除。请登录WAF管理界面 → Web防护 → 服务器对象 → 服务器策略，找到引用此IP组的策略，移除ip-group绑定后再删除。`;
  } else if (message.includes("不存在")) {
    message = `删除失败：IP组 "${req.name}" 不存在。`;
  }

  return { success: result.result === true, data: result.data || "", message };
}

// ── Server Policy handlers ─────────────────────────────────────────────-

async function showServerPolicies(ctx) {
  const req = ctx.request ?? {};
  const config = ctx.config ?? {};
  const wafBaseUrl = config.waf_base_url || "";

  const commands = [{ waf_server_policy_show: req.name ? { name: req.name } : "" }];
  const result = await callWafApi("GET", "/home/default/show/", commands, wafBaseUrl);

  return {
    success: result.result === true,
    total: result.total || 0,
    rows: (result.rows || []).map(r => ({
      name: r.name || "",
      enable: r.enable || "",
      mode: r.mode || "",
      securityPolicy: r["security-policy"] || "",
      ipGroup: Array.isArray(r.ipgroup) ? r.ipgroup : (r.ipgroup ? [r.ipgroup] : []),
      serverEnvironment: r["server-environment"] || "",
    })),
    message: result.data || result.message || "",
  };
}

async function addServerPolicy(ctx) {
  const req = ctx.request ?? {};
  const config = ctx.config ?? {};
  const wafBaseUrl = config.waf_base_url || "";

  const cmdArgs = {
    name: req.name || "",
    enable: req.enable || "on",
    "traffic-log": req.trafficLog || "off",
    mode: req.mode || "enable",
    "security-policy": req.securityPolicy || "",
  };
  if (req.ipGroup) cmdArgs["ip-group"] = req.ipGroup;
  if (req.serverEnvironment) cmdArgs["server-environment"] = req.serverEnvironment;

  const commands = [{ waf_server_policy_add: cmdArgs }];
  const result = await callWafApi("POST", "/home/default/add/", commands, wafBaseUrl);

  return { success: result.result === true, data: result.data || "", message: result.data || result.message || "" };
}

async function modifyServerPolicy(ctx) {
  const req = ctx.request ?? {};
  const config = ctx.config ?? {};
  const wafBaseUrl = config.waf_base_url || "";

  const cmdArgs = { name: req.name || "" };
  if (req.enable !== undefined) cmdArgs.enable = req.enable;
  if (req.trafficLog !== undefined) cmdArgs["traffic-log"] = req.trafficLog;
  if (req.mode !== undefined) cmdArgs.mode = req.mode;
  if (req.securityPolicy !== undefined) cmdArgs["security-policy"] = req.securityPolicy;
  if (req.ipGroup !== undefined) cmdArgs["ip-group"] = req.ipGroup;
  if (req.serverEnvironment !== undefined) cmdArgs["server-environment"] = req.serverEnvironment;

  const commands = [{ waf_server_policy_modify: cmdArgs }];
  const result = await callWafApi("POST", "/home/default/modify/", commands, wafBaseUrl);

  return { success: result.result === true, data: result.data || "", message: result.data || result.message || "" };
}

async function deleteServerPolicy(ctx) {
  const req = ctx.request ?? {};
  const config = ctx.config ?? {};
  const wafBaseUrl = config.waf_base_url || "";

  const commands = [{ waf_server_policy_delete: { name: req.name || "" } }];
  const result = await callWafApi("POST", "/home/default/delete/", commands, wafBaseUrl);

  return { success: result.result === true, data: result.data || "", message: result.data || result.message || "" };
}

// ── Custom Policy handlers ────────────────────────────────────────────
//
// Add/Modify use POST /SE/Security/ with flat params (not commands[x][y] format).
// Show uses GET /home/default/show/ with waf_url_rewrite_show_name.
// Delete uses POST /home/default/delete/ with waf_user_policy_delete.
// ───────────────────────────────────────────────────────────────────────

async function callSeSecurityApi(method, urlPath, params, wafBaseUrl) {
  const session = getSession(wafBaseUrl);
  if (!session) {
    return { success: false, message: "not logged in — call Login first" };
  }

  const token = session.tokens.shift();
  const paramJson = JSON.stringify(params);
  const codeRun = md5(session.secret + token + urlPath + paramJson);

  const allParams = { ...params, userMark: session.authId, token, codeRun };
  const qs = Object.entries(allParams)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");

  const tlsVerify = session.tlsVerify === true;
  let res;
  try {
    if (method === "GET") {
      res = await httpsGet(`${wafBaseUrl}${urlPath}?${qs}`, session.sid, tlsVerify);
    } else {
      res = await httpsPost(`${wafBaseUrl}${urlPath}?userMark=${session.authId}`, qs, session.sid, tlsVerify);
    }
  } catch (err) {
    session.tokens.unshift(token);
    return { success: false, message: "WAF request failed" };
  }
  try {
    return parseWafResponse(res.body, session.tokens);
  } catch {
    session.tokens.unshift(token);
    return { success: false, message: "invalid WAF response" };
  }
}

function buildConditionList(conditions) {
  return conditions.map(c => ({
    variables: [{ name: c.variableName || "", input: c.variableInput || "" }],
    operator: c.operator || "strEqual",
    expression: c.expression || "",
    trfns: ["none"],
  }));
}

async function showCustomPolicies(ctx) {
  const req = ctx.request ?? {};
  const config = ctx.config ?? {};
  const wafBaseUrl = config.waf_base_url || "";

  const cmdArgs = { "security-policy": req.securityPolicy || "" };
  if (req.name) cmdArgs.name = req.name;

  const commands = [{ waf_url_rewrite_show_name: cmdArgs }];
  const result = await callWafApi("GET", "/home/default/show/", commands, wafBaseUrl);

  return {
    success: result.result === true,
    total: result.total || 0,
    rows: (result.rows || []).map(r => ({
      name: r.name || "",
      enable: r.enable || "",
      level: r.level || "",
      action: r.action || "",
      phase: r.phase || "",
      logMessage: r.log_message || "",
    })),
    message: result.data || result.message || "",
  };
}

async function addCustomPolicy(ctx) {
  const req = ctx.request ?? {};
  const config = ctx.config ?? {};
  const wafBaseUrl = config.waf_base_url || "";

  const params = {
    security_policy: req.securityPolicy || "",
    name: req.name || "",
    enable: req.enable || "on",
    level: req.level || "medium",
    processPhase: req.processPhase || "request_header",
    action_type: req.actionType || "deny",
    action_data: req.actionData || "",
    logInfo: req.logInfo || "",
  };

  const conditions = buildConditionList(req.conditions || []);
  conditions.forEach((c, i) => {
    if (i < 5) params[`conditionList${i + 1}`] = JSON.stringify(c);
  });

  const result = await callSeSecurityApi("POST", "/SE/Security/userDefinedAdd/", params, wafBaseUrl);

  let message = result.data || result.message || "";
  if (result.result === true) {
    message = `自定义策略 "${req.name}" 创建成功。`;
  } else if (message.includes("已存在") || message.includes("已经存在")) {
    message = `创建失败：自定义策略 "${req.name}" 已存在。`;
  } else if (message.includes("内置变量")) {
    message = `创建失败：${message}。可用变量: CLIENT_IP, REQUEST_METHOD, REQUEST_HEADERS(input=头名), REQUEST_URI_RAW, REQUEST_FILENAME。`;
  }

  return { success: result.result === true, data: result.data || "", message };
}

async function modifyCustomPolicy(ctx) {
  const req = ctx.request ?? {};
  const config = ctx.config ?? {};
  const wafBaseUrl = config.waf_base_url || "";

  const params = {
    security_policy: req.securityPolicy || "",
    name: req.name || "",
  };
  if (req.enable !== undefined) params.enable = req.enable;
  if (req.level !== undefined) params.level = req.level;
  if (req.processPhase !== undefined) params.processPhase = req.processPhase;
  if (req.actionType !== undefined) params.action_type = req.actionType;
  if (req.actionData !== undefined) params.action_data = req.actionData;
  if (req.logInfo !== undefined) params.logInfo = req.logInfo;

  const conditions = buildConditionList(req.conditions || []);
  conditions.forEach((c, i) => {
    if (i < 5) params[`conditionList${i + 1}`] = JSON.stringify(c);
  });

  const result = await callSeSecurityApi("POST", "/SE/Security/userDefinedEdit/", params, wafBaseUrl);

  let message = result.data || result.message || "";
  if (result.result === true) {
    message = `自定义策略 "${req.name}" 修改成功。`;
  }

  return { success: result.result === true, data: result.data || "", message };
}

async function deleteCustomPolicy(ctx) {
  const req = ctx.request ?? {};
  const config = ctx.config ?? {};
  const wafBaseUrl = config.waf_base_url || "";

  const commands = [{ waf_user_policy_delete: { "security-policy": req.securityPolicy || "", name: req.name || "" } }];
  const result = await callWafApi("POST", "/home/default/delete/", commands, wafBaseUrl);

  let message = result.data || result.message || "";
  if (result.result === true) {
    message = `自定义策略 "${req.name}" 删除成功。`;
  } else if (message.includes("不存在")) {
    message = `删除失败：自定义策略 "${req.name}" 不存在。`;
  }

  return { success: result.result === true, data: result.data || "", message };
}

// ── Rule handlers ─────────────────────────────────────────────────────

async function showDefencePolicy(ctx) {
  const req = ctx.request ?? {};
  const config = ctx.config ?? {};
  const wafBaseUrl = config.waf_base_url || "";

  const commands = [{ waf_defence_policy_show: { "security-policy": req.securityPolicy || "" } }];
  const result = await callWafApi("GET", "/home/default/show/", commands, wafBaseUrl);

  return {
    success: result.result === true,
    total: result.total || 0,
    rows: (result.rows || []).map(r => ({
      defenceXss: r.defence_xss || "", defenceScanner: r.defence_scanner || "",
      defenceSqli: r.defence_sqli || "", defenceOsi: r.defence_osi || "",
      defenceRfi: r.defence_rfi || "", defenceDir: r.defence_dir || "",
      defenceLeakage: r.defence_leakage || "", defenceLdap: r.defence_ldap || "",
      defenceXpath: r.defence_xpath || "", defenceSsi: r.defence_ssi || "",
      defenceServer: r.defence_server || "", defenceOther: r.defence_other || "",
      defenceUser: r.defence_user || "", defenceWebshell: r.defence_webshell || "",
      defenceAll: r.defence_all || "",
    })),
    message: result.data || result.message || "",
  };
}

async function showRuleActions(ctx) {
  const req = ctx.request ?? {};
  const config = ctx.config ?? {};
  const wafBaseUrl = config.waf_base_url || "";

  const commands = [{ waf_rule_action_show_ruletype: { "security-policy": req.securityPolicy || "" } }];
  const result = await callWafApi("GET", "/home/default/show/", commands, wafBaseUrl);

  return {
    success: result.result === true,
    total: result.total || 0,
    rows: (result.rows || []).map(r => ({
      actionXss: r.action_xss || "", actionSqli: r.action_sqli || "",
      actionDir: r.action_dir || "", actionScanner: r.action_scanner || "",
      actionWebshell: r.action_webshell || "", actionUser: r.action_user || "",
      actionAll: r.action_all || "",
    })),
    message: result.data || result.message || "",
  };
}

async function showBuiltRules(ctx) {
  const req = ctx.request ?? {};
  const config = ctx.config ?? {};
  const wafBaseUrl = config.waf_base_url || "";

  const urlPath = "/SE/builtRule/showList/";
  const params = {
    security_policy: req.securityPolicy || "",
    rule_type: req.ruleType || "built",
    page: String(req.page || 1),
    rows: String(req.rows || 20),
  };

  const result = await callSeSecurityApi("GET", urlPath, params, wafBaseUrl);

  return {
    success: result.result === true,
    total: result.total || 0,
    rows: (result.rows || []).map(r => ({
      rid: Number(r.rid) || 0, name: r.name || "", action: r.action || "",
      enable: Number(r.enable) || 0, status: r.status || "",
      rDescription: r.r_description || "", atName: r.at_name || "",
      accuAccuracy: r.accu_accuracy || "",
    })),
    message: result.data || result.message || "",
  };
}

async function searchBuiltRules(ctx) {
  const req = ctx.request ?? {};
  const config = ctx.config ?? {};
  const wafBaseUrl = config.waf_base_url || "";

  const urlPath = "/SE/builtRule/searchList/";
  const params = {
    security_policy: req.securityPolicy || "",
    rule_type: req.ruleType || "built",
    attack_type: req.attackType || "all",
    conditionQuery: req.conditionQuery || "",
    page: String(req.page || 1),
    rows: String(req.rows || 20),
  };

  const result = await callSeSecurityApi("GET", urlPath, params, wafBaseUrl);

  return {
    success: result.result === true,
    total: result.total || 0,
    rows: (result.rows || []).map(r => ({
      rid: Number(r.rid) || 0, name: r.name || "", action: r.action || "",
      enable: Number(r.enable) || 0, status: r.status || "",
      rDescription: r.r_description || "", atName: r.at_name || "",
      accuAccuracy: r.accu_accuracy || "",
    })),
    message: result.data || result.message || "",
  };
}


// ── handler exports ────────────────────────────────────────────────────

export const handlers = {
  "waf.v1.WafAuthService/Login": login,
  "waf.v1.WafIpGroupService/ShowIpGroups": showIpGroups,
  "waf.v1.WafIpGroupService/AddBlackIp": addBlackIp,
  "waf.v1.WafIpGroupService/AddWhiteIp": addWhiteIp,
  "waf.v1.WafIpGroupService/DeleteIpGroup": deleteIpGroup,
  "waf.v1.WafServerPolicyService/ShowServerPolicies": showServerPolicies,
  "waf.v1.WafServerPolicyService/AddServerPolicy": addServerPolicy,
  "waf.v1.WafServerPolicyService/ModifyServerPolicy": modifyServerPolicy,
  "waf.v1.WafServerPolicyService/DeleteServerPolicy": deleteServerPolicy,
  "waf.v1.WafCustomPolicyService/ShowCustomPolicies": showCustomPolicies,
  "waf.v1.WafCustomPolicyService/AddCustomPolicy": addCustomPolicy,
  "waf.v1.WafCustomPolicyService/ModifyCustomPolicy": modifyCustomPolicy,
  "waf.v1.WafCustomPolicyService/DeleteCustomPolicy": deleteCustomPolicy,
  "waf.v1.WafRuleService/ShowDefencePolicy": showDefencePolicy,
  "waf.v1.WafRuleService/ShowRuleActions": showRuleActions,
  "waf.v1.WafRuleService/ShowBuiltRules": showBuiltRules,
  "waf.v1.WafRuleService/SearchBuiltRules": searchBuiltRules,
};
