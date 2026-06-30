# Aliyun WAF 3.0 — OctoBus 联调证据 / Integration Evidence

> 所有敏感信息（服务器地址、实例 ID、规则 ID、ECS 实例 ID、模板 ID）已替换为占位符。请求路径、HTTP 状态码、响应结构和业务字段完整保留。
> All sensitive data (server addresses, instance IDs, rule IDs, ECS instance IDs, template IDs) replaced with placeholders. Request paths, HTTP status codes, response structure and business fields preserved.

## 测试环境 / Test Environment

| 项目 / Item | 值 / Value |
|-------------|------------|
| WAF 产品 / Product | Alibaba Cloud WAF 3.0 (API `2021-10-01`) |
| 接入模式 / Access Mode | 云产品接入（ECS）/ Cloud Product Access |
| OctoBus 版本 / Version | `@chaitin-ai/octobus-sdk` ^0.5.0 |
| 测试方法数 / Methods Tested | 10 |
| 测试结果 / Result | 全部通过 / All passed ✅ |

---

## 1. BlockIP — 封禁 IP

### BlockIP 跑通

# Request

```http
POST http://<octobus-addr>/capsets/dev/connect/<instance>/Aliyun_Waf3.Waf3/BlockIP
Content-Type: application/json

{"ips":["203.0.113.1"],"ruleName":"final-test","action":"monitor"}
```

# Response

```http
HTTP/1.1 200 OK
Content-Type: application/json

{"ruleId":"<rule-id>"}
```

**底层 API / Underlying**: `CreateDefenseRule` (POST, DefenseScene=`ip_blacklist`)

---

## 2. UnblockIP — 解封 IP

### UnblockIP 跑通

# Request

```http
POST http://<octobus-addr>/capsets/dev/connect/<instance>/Aliyun_Waf3.Waf3/UnblockIP
Content-Type: application/json

{"ruleId":"<rule-id>","ips":["198.18.0.5"]}
```

# Response

```http
HTTP/1.1 200 OK
Content-Type: application/json

{"success":true}
```

> 注：当移除所有 IP 后规则为空，自动调用 `DeleteDefenseRule` 删除规则。
> Note: auto-deletes rule via `DeleteDefenseRule` when all IPs removed.

**底层 API / Underlying**: `DescribeDefenseRule` + `ModifyDefenseRule` (or `DeleteDefenseRule`)

---

## 3. DescribeIPBlacklist — 查询 IP 黑名单

### DescribeIPBlacklist 跑通

# Request

```http
POST http://<octobus-addr>/capsets/dev/connect/<instance>/Aliyun_Waf3.Waf3/DescribeIPBlacklist
Content-Type: application/json

{}
```

# Response

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "rules": [
    {"ruleId":"<rule-id>","name":"cycle-test","ips":["198.18.0.1"],"action":"monitor","status":1},
    {"ruleId":"<rule-id>","name":"final-test","ips":["203.0.113.1"],"action":"monitor","status":1}
  ],
  "total":"8"
}
```

**底层 API / Underlying**: `DescribeDefenseRules` (Query=`{"templateId":<template-id>,"scene":"ip_blacklist"}`)

---

## 4. AddIPWhitelist — IP 加白

### AddIPWhitelist 跑通

# Request

```http
POST http://<octobus-addr>/capsets/dev/connect/<instance>/Aliyun_Waf3.Waf3/AddIPWhitelist
Content-Type: application/json

{"ips":["10.0.0.1"],"ruleName":"whitelist-test"}
```

# Response

```http
HTTP/1.1 200 OK
Content-Type: application/json

{"ruleId":"<rule-id>"}
```

**底层 API / Underlying**: `CreateDefenseRule` (POST, DefenseScene=`whitelist`)

---

## 5. CreateACLRule — 创建自定义 ACL 规则

### CreateACLRule 跑通

# Request

```http
POST http://<octobus-addr>/capsets/dev/connect/<instance>/Aliyun_Waf3.Waf3/CreateACLRule
Content-Type: application/json

{"ruleName":"acl-test","conditions":[{"key":"URL","opValue":"contain","values":"/admin"}],"action":"monitor"}
```

# Response

```http
HTTP/1.1 200 OK
Content-Type: application/json

{"ruleId":"<rule-id>"}
```

**Conditions 支持字段 / Supported condition keys**:

| `key` | 说明 / Description | `opValue` |
|-------|-------------------|-----------|
| `URL` | URL 路径 / URL path | contain, not-contain, eq, ne, prefix-match, suffix-match, regex |
| `IP` | 来源 IP / Source IP | eq, ne |
| `Referer` | Referer header | contain, not-contain, eq, ne |
| `User-Agent` | UA header | contain, not-contain, eq, ne |
| `Header` | 自定义 Header / Custom header | contain, not-contain, eq, ne（需 `subKey`）|
| `Cookie` | Cookie | contain, not-contain, eq, ne（需 `subKey`）|
| `Http-Method` | 请求方法 / HTTP method | eq, ne |

**底层 API / Underlying**: `CreateDefenseRule` (POST, DefenseScene=`custom_acl`)

---

## 6. DeleteRule — 删除规则

### DeleteRule 跑通

# Request

```http
POST http://<octobus-addr>/capsets/dev/connect/<instance>/Aliyun_Waf3.Waf3/DeleteRule
Content-Type: application/json

{"ruleId":"<rule-id>"}
```

# Response

```http
HTTP/1.1 200 OK
Content-Type: application/json

{"success":true}
```

**底层 API / Underlying**: `DeleteDefenseRule` (POST)

---

## 7. DescribeRule — 查询单条规则

### DescribeRule 跑通

# Request

```http
POST http://<octobus-addr>/capsets/dev/connect/<instance>/Aliyun_Waf3.Waf3/DescribeRule
Content-Type: application/json

{"ruleId":"<rule-id>"}
```

# Response

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "ruleId":"<rule-id>",
  "name":"cycle-test",
  "defenseScene":"ip_blacklist",
  "action":"monitor",
  "rulesJson":"[{\"action\":\"monitor\",\"name\":\"cycle-test\",\"remoteAddr\":[\"198.18.0.1\"]}]"
}
```

**底层 API / Underlying**: `DescribeDefenseRule`

---

## 8. DescribeRules — 按场景查询规则列表

### DescribeRules 跑通

# Request

```http
POST http://<octobus-addr>/capsets/dev/connect/<instance>/Aliyun_Waf3.Waf3/DescribeRules
Content-Type: application/json

{"defenseScene":"ip_blacklist"}
```

# Response

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "rules": [
    {"ruleId":"<rule-id>","name":"cycle-test","ips":["198.18.0.1"],"action":"monitor","status":1},
    {"ruleId":"<rule-id>","name":"final-test","ips":["203.0.113.1"],"action":"monitor","status":1}
  ],
  "total":"8"
}
```

**底层 API / Underlying**: `DescribeDefenseRules`

---

## 9. DescribeSecurityTopNMetric — 攻击 Top N 统计

### DescribeSecurityTopNMetric 跑通

# Request

```http
POST http://<octobus-addr>/capsets/dev/connect/<instance>/Aliyun_Waf3.Waf3/DescribeSecurityTopNMetric
Content-Type: application/json

{"startTime":1782748800,"endTime":1782835200,"metric":"real_client_ip","limit":5}
```

# Response

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "items": [
    {"name":"<attacker-ip-1>","value":"23"},
    {"name":"<attacker-ip-2>","value":"17"},
    {"name":"<attacker-ip-3>","value":"3"},
    {"name":"<attacker-ip-4>","value":"2"},
    {"name":"<attacker-ip-5>","value":"1"}
  ]
}
```

**支持的 metric 维度 / Supported metrics**:

| `metric` | 说明 / Description |
|----------|-------------------|
| `real_client_ip` | 攻击来源 IP / Attacker IP |
| `http_user_agent` | User-Agent |
| `request_path` | 请求路径 / Request path |
| `matched_host` | 命中域名 / Matched host |
| `defense_scene` | 防护场景 / Defense scene |
| `block_defense_scene` | 拦截场景 / Block scene |

**底层 API / Underlying**: `DescribeSecurityEventTopNMetric`

---

## 10. DescribeResources — 查询防护资源

### DescribeResources 跑通

# Request

```http
POST http://<octobus-addr>/capsets/dev/connect/<instance>/Aliyun_Waf3.Waf3/DescribeResources
Content-Type: application/json

{}
```

# Response

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "resources": [
    {
      "resource":"<ecs-instance-id>-8080-ecs",
      "pattern":"instance_port",
      "product":"ecs",
      "status":"active",
      "instanceId":"<ecs-instance-id>",
      "port":8080,
      "protocol":"http"
    }
  ],
  "total":"1"
}
```

**底层 API / Underlying**: `DescribeDefenseResources`

---

## 总结 / Summary

| 类型 / Type | 方法 / Method | 数量 / Count |
|-------------|--------------|--------------|
| ✍️ 写操作 / Write | BlockIP, UnblockIP, AddIPWhitelist, CreateACLRule, DeleteRule | 5 |
| 👁️ 读操作 / Read | DescribeIPBlacklist, DescribeRule, DescribeRules, DescribeSecurityTopNMetric, DescribeResources | 5 |

**底层阿里云 API / Underlying Alibaba Cloud APIs**（7 total）:

| API | 用途 / Usage |
|-----|-------------|
| `CreateDefenseRule` | 创建黑名单/白名单/ACL 规则 |
| `ModifyDefenseRule` | 修改规则（IP 增删） |
| `DeleteDefenseRule` | 删除规则 |
| `DescribeDefenseRule` | 查询单条规则详情 |
| `DescribeDefenseRules` | 查询规则列表 |
| `DescribeSecurityEventTopNMetric` | 攻击 Top N 统计 |
| `DescribeDefenseResources` | 查询防护资源列表 |

**验证时间 / Verified**: 2026-07-01 — 全部 10 个方法通过真实 WAF 3.0 实例（云产品接入模式）验证 ✅
