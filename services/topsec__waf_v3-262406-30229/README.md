# TopSec WAF v3.262406.30229 OctoBus Service

TopSec (天融信) WAF v3.262406.30229 management — authentication, IP black/white list, server policy, custom security rules, and rule status query.

Import it into OctoBus with:

```bash
octobus service import topsec-waf-v3-262406-30229 ./topsec__waf_v3-262406-30229
```

## Package Files

- `service.json`: OctoBus service manifest.
- `proto/topsec_waf.proto`: gRPC API definition with 5 services and 17 RPCs.
- `config.schema.json`: WAF management base URL.
- `secret.schema.json`: WAF admin account credentials.
- `src/topsec-waf-v3-262406-30229.js`: REST proxy implementation (login, token rotation, API signing).
- `src/service.js`: OctoBus SDK `defineService` wrapper.
- `bin/topsec-waf-v3-262406-30229.js`: service executable entrypoint.

## Configuration

```json
{
  "waf_base_url": "https://<waf-management-ip>:8443"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `waf_base_url` | string | yes | WAF management interface base URL |

```json
{
  "username": "<waf-admin-user>",
  "password": "<waf-admin-password>"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `username` | string | yes | WAF admin username |
| `password` | string | yes | WAF admin password |

## RPC Methods

- `waf.v1.WafAuthService/Login`
- `waf.v1.WafIpGroupService/ShowIpGroups`
- `waf.v1.WafIpGroupService/AddBlackIp`
- `waf.v1.WafIpGroupService/AddWhiteIp`
- `waf.v1.WafIpGroupService/DeleteIpGroup`
- `waf.v1.WafServerPolicyService/ShowServerPolicies`
- `waf.v1.WafServerPolicyService/AddServerPolicy`
- `waf.v1.WafServerPolicyService/ModifyServerPolicy`
- `waf.v1.WafServerPolicyService/DeleteServerPolicy`
- `waf.v1.WafCustomPolicyService/ShowCustomPolicies`
- `waf.v1.WafCustomPolicyService/AddCustomPolicy`
- `waf.v1.WafCustomPolicyService/ModifyCustomPolicy`
- `waf.v1.WafCustomPolicyService/DeleteCustomPolicy`
- `waf.v1.WafRuleService/ShowDefencePolicy`
- `waf.v1.WafRuleService/ShowRuleActions`
- `waf.v1.WafRuleService/ShowBuiltRules`
- `waf.v1.WafRuleService/SearchBuiltRules`

## Behavior Notes

### Authentication

Login uses AES-128-CBC with key and iv `1111111111111111` (PKCS7 padding) to encrypt the password. The WAF responds with `authId`, `secret`, a rotating token pool, and a `SESSID` session cookie cached in memory by instance and WAF base URL.

### Token Rotation

Each API call consumes the first token from the pool. The WAF response is prefixed with `?[16-char-token]?{json}`; the new token is pushed back to the pool. Token pools persist across gRPC calls within the same long-running instance.

### API Signing

Most endpoints compute `codeRun = MD5(secret + token + urlPath + paramJson)`. Two signing formats are used:

| Endpoint | Format |
|----------|--------|
| `/home/default/*` | `commands[x][y]` query params, `errorMode=1` |
| `/SE/Security/*`, `/SE/builtRule/*` | flat params, `errorMode=true` |

### IP Group Scope

- `global` — applies to all virtual servers automatically.
- `none` — must be bound to a server policy via `AddServerPolicy` or web UI. Deleting a referenced IP group fails with a Chinese error message directing the operator to the web interface.

### Custom Policy Variables

| Variable | Input | Supported Operators |
|----------|-------|---------------------|
| `CLIENT_IP` | — | strEqual, contains, match |
| `REQUEST_METHOD` | — | strEqual, match |
| `REQUEST_HEADERS` | header name | strEqual, match |
| `REQUEST_URI_RAW` | — | contains |
| `REQUEST_FILENAME` | — | contains |

### Error Messages

Chinese-language messages are returned for common error scenarios:
- Invalid scope parameter
- Missing server policy for non-global IP groups
- Referenced IP group deletion blocked
- Unknown built-in variable in custom policy conditions

## Verified On

- **Device**: Topsec WAF 3.0 v3.262406.30229
- **Firmware**: NGTOS (ngtos)
- **All 17 RPC methods** tested and verified against live device.

## Write Operations

| Method | Default Parameters | Idempotency | Rollback | Audit |
|--------|-------------------|-------------|----------|-------|
| `AddBlackIp` | mask=32, scope=none | name 唯一，重复创建 WAF 返回错误 | 调用 DeleteIpGroup | WAF 操作日志记录 |
| `AddWhiteIp` | mask=32, scope=none | 同上 | 调用 DeleteIpGroup | 同上 |
| `DeleteIpGroup` | — | 幂等（不存在时返回错误） | 重新 Add 恢复 | 同上 |
| `AddServerPolicy` | enable=on, trafficLog=off, mode=enable | name 唯一 | 调用 DeleteServerPolicy | 同上 |
| `ModifyServerPolicy` | — | 非幂等（基于当前状态修改） | 重新 Modify 恢复原值 | 同上 |
| `DeleteServerPolicy` | — | 幂等（不存在时返回错误） | 重新 Add 恢复 | 同上 |
| `AddCustomPolicy` | enable=on, level=medium, processPhase=request_header, actionType=deny | name + securityPolicy 唯一 | 调用 DeleteCustomPolicy | 同上 |
| `ModifyCustomPolicy` | — | 非幂等 | 重新 Modify 恢复原值 | 同上 |
| `DeleteCustomPolicy` | — | 幂等（不存在时返回错误） | 重新 Add 恢复（需记原参数） | 同上 |

> 所有写操作均在 WAF 操作日志中留有审计记录（操作时间、操作员、操作内容）。IP 组删除受引用保护（ref>0 时拒绝删除），需先解绑服务器策略。

## Risk & Limitations

- **TLS 证书**：`rejectUnauthorized=false` 允许自签证书，生产环境建议部署外围 TLS 代理。
- **Token 传输**：auth token 作为 URL 查询参数传输，依赖 HTTPS 保护传输层安全。
- **Session 缓存**：authId、secret、token pool 以明文缓存在 Node.js 进程内存中，实例重启后需重新 Login。
- **单实例限制**：token pool 不跨实例共享，同一 WAF 不应被多个 OctoBus 实例同时操作（会导致 token 竞争）。
- **API 兼容性**：基于 WAF v3.262406.30229 验证，其他固件版本可能需要调整 API 签名格式。
- **服务器策略 Modify**：此 WAF 版本的 `waf_server_policy_modify` 不支持修改 ip-group 字段，仅 Add 时可设置。
- **内置规则搜索**：`attack_type` 参数依赖 WAF 固件枚举值，不同版本可能有差异。

## Suggested Capset

```bash
octobus service import topsec-waf-v3-262406-30229 ./topsec__waf_v3-262406-30229

octobus instance create waf3-prod \
  --service topsec-waf-v3-262406-30229 \
  --config-json '{"waf_base_url":"https://<waf-ip>:8443"}' \
  --secret-json '{"username":"<user>","password":"<pass>"}'

octobus capset create waf-readonly --name "WAF Read-Only"
octobus capset add-instance waf-readonly waf3-prod --no-all-methods
octobus capset select-method waf-readonly waf3-prod waf.v1.WafIpGroupService/ShowIpGroups
octobus capset select-method waf-readonly waf3-prod waf.v1.WafServerPolicyService/ShowServerPolicies
octobus capset select-method waf-readonly waf3-prod waf.v1.WafRuleService/ShowDefencePolicy
octobus capset select-method waf-readonly waf3-prod waf.v1.WafRuleService/ShowBuiltRules

octobus capset create waf-operator --name "WAF Operator"
octobus capset add-instance waf-operator waf3-prod
```

> 建议按最小权限原则拆分为只读 capset 和操作 capset。

## Local Checks

```bash
cd services

# 验证 package 结构
npm run validate -- --service-dir topsec__waf_v3-262406-30229

# 运行测试
npm test -- --service-dir topsec__waf_v3-262406-30229

# 打包检查
npm run pack:check
```
