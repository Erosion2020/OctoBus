# 远程 Service Import 本地资源上传技术方案

## 背景与目标

OctoBus CLI 支持通过全局 `--addr` 或 `OCTOBUS_ADDR` 连接非本机 daemon。当前 `octobus --addr <remote_addr> service import panorama-tenant-api .` 会失败，因为 CLI 只把 `SOURCE` 字符串发给远端 daemon，远端按自己的文件系统解析 `.` 或本地绝对路径。

目标是在不破坏现有 Admin API JSON import 的前提下，让远程 daemon 能导入 CLI 客户端本地的 service package：

- `service import SERVICE SOURCE` 和 `service import --recursive SOURCE` 在远程 `--addr` 下支持客户端本地目录、本地 `.tgz/.tar.gz/.zip` 和本地 `npm:` path spec。
- Git、npm registry、HTTP(S) archive 等 daemon 可自行获取的 source 保持现有行为。
- `instance --config/--secret`、`*-token --token-file` 等命令不纳入本方案；这些路径已经由 CLI 本地读取内容后提交，不存在 daemon 访问客户端路径的问题。

## 现状和 harness 约束

`AGENTS.md` 要求 OctoBus 作为 Go module 构建单个 `octobus` binary；CLI 入口在 `cmd/octobus`，核心实现按 `internal/cli`、`internal/admin`、`internal/packageimport` 等 concern 拆分。测试应按风险放在相邻 unit test、`internal/integration` 或 `tests/e2e`，变更 daemon 启动、CLI、package import、routing protocols 或 supervision 后应运行 e2e。

`Taskfile.yml` 定义主工作流：

- `task lint` 检查 `gofmt` 和 `go vet ./...`。
- `task test` 会构建 SDK、准备示例依赖、运行覆盖率脚本和 minimum smoke。
- `task build` 构建 `bin/octobus` 并检查静态链接。
- `task` 仅列出任务；完整门禁是 `task all` 或分别运行 lint/test/build。

`.github/workflows/ci.yml` 的默认 validate job 会检查 public traces、Go formatting、`go vet ./...`、`go test ./cmd/... ./internal/...`、构建 binary、检查 npm binary package、校验 services、测试并构建 SDK。`tests/e2e/README.md` 要求 e2e 使用真实 binary、真实 daemon 和真实 CLI，避免固定端口、用户 home 目录、npm registry 或外部网络。

相关设计文档约束：

- `docs/design/product/cli.md`：CLI 通过 Admin API 管理 daemon，不直接写 SQLite；地址支持 `host:port`、`http://host:port`、`https://host:port`；`service import` 是创建和更新 service 版本的入口。
- `docs/design/technical/service-package.md`：service package source 支持 npm、local directory、local archive、HTTPS Git；`//service-dir` 选择 distribution package 内 service root；local directory 和 HTTPS Git 可按 `--build=auto|always|never` 构建，archive 视为已发布 artifact。
- `docs/design/product/operations.md` 和 `docs/design/product/security.md`：远程暴露由部署方负责网络访问控制；日志不得记录请求体、Authorization、token、secret、完整 config 或带凭据 Git source；service package 是 trusted code，OctoBus 不做运行时沙箱。

当前实现边界：

- `internal/cli/cli.go` 中 `serviceImportCommand` 调用 `normalizeImportSource`，会把存在的本地相对路径转成绝对路径，然后通过 JSON `POST /admin/v1/services/import` 发送 `packageimport.Options`。
- `requestServiceImport` 使用 `Accept: application/x-ndjson` 并关闭 HTTP client timeout，以接收 import 进度流。
- `internal/admin/admin.go` 的 `handleServiceImport` 当前只读取 JSON body，再根据 `Accept` 分支到普通或 NDJSON streaming import。
- `internal/packageimport/importer.go` 的 `prepareSource` 在 daemon 进程内分类并解析 source：`npm:`、remote archive、HTTPS Git 或 daemon 本地文件系统路径。
- `instance create/update-config/update-secret`、`capset add-token`、`admin-token add` 的路径输入由 CLI 调用 `os.ReadFile` 或 stdin 本地读取后提交 JSON 内容，不属于本方案问题边界。

## 核心概念或领域模型

- 客户端本地 source：CLI 进程所在机器可访问的 service package 目录、archive 文件或本地 `npm:` path spec。
- daemon-side source：daemon 进程所在机器可访问的文件系统路径，或 daemon 能自行获取的 npm registry、HTTP(S) archive、HTTPS Git source。
- 上传 source：CLI 把客户端本地 source 转换为 HTTP multipart payload，由 daemon 存入 import staging 后再走现有 package import pipeline。
- source transfer mode：CLI 对 `SOURCE` 的解析策略，取值为 `auto`、`upload`、`remote`。
- import staging：daemon `DataDir/artifacts/services/.staging-*` 下的临时工作区，上传文件、解包目录、build、runtime dependency preparation、descriptor compile 都必须限制在 staging 和最终 service artifact 目录内。

## 架构和组件边界

`internal/cli` 负责判断 source 是否需要上传、构造 multipart 请求、保留现有 NDJSON import 输出体验，并继续本地读取 config/secret/token 文件。CLI 不执行 package build、runtime dependency install、descriptor compile 或 service manifest 校验。

`internal/admin` 负责让 `/admin/v1/services/import` 同时接受现有 JSON 请求和新的 `multipart/form-data` 请求。JSON 请求保持 daemon-side source 语义；multipart 请求先把上传内容落到 daemon staging，再把转换后的 `packageimport.Options` 交给 importer。Admin token middleware、普通 JSON 响应和 NDJSON streaming 响应语义不变。

`internal/packageimport` 继续拥有 package source 准备、build policy、runtime dependency preparation、descriptor compile、recursive discovery、artifact commit 和 SQLite service metadata 构造。新增能力应复用现有 `preparedSource` 流程，避免在 admin 层复制 import 规则。

`internal/store` 数据模型不新增字段。`package_source` 继续记录可展示的规范化 source 字符串；上传来源记录为不泄露客户端绝对路径的稳定值。

## API、CLI、配置、数据模型或协议变化

CLI 新增 `service import --source-mode auto|upload|remote`，默认 `auto`：

- `auto`：当 `SOURCE` 是客户端存在的本地目录、客户端存在的本地 `.tgz/.tar.gz/.zip`，或 `npm:` 后跟客户端存在的本地路径时，CLI 上传 source；否则保持现有 JSON 请求。
- `upload`：强制按客户端本地 source 上传。若 source 不存在或不是支持的本地 source，CLI 在发请求前返回明确错误。
- `remote`：强制保留现有 daemon-side source 语义，CLI 只发送 JSON 请求。该模式用于远端 daemon 文件系统路径，或客户端与 daemon 通过共享路径约定导入。

`auto` 不使用 admin address 是否 loopback 来推断文件系统边界。`127.0.0.1`、`localhost`、SSH tunnel、Docker 端口映射、kubectl port-forward 或反向代理都只能说明网络入口位置，不能说明 CLI 与 daemon 共享同一个文件系统。用户可用 `--source-mode remote` 覆盖客户端也存在同名路径但希望远端解析的场景。

Admin API 兼容现有 JSON：

```http
POST /admin/v1/services/import
Content-Type: application/json
Accept: application/x-ndjson

{
  "service_id": "panorama-tenant-api",
  "source": "/daemon/path/or/npm/git/http/source",
  "build": "auto",
  "offline": false,
  "reinstall": false,
  "recursive": false
}
```

新增 multipart 请求：

```http
POST /admin/v1/services/import
Content-Type: multipart/form-data; boundary=...
Accept: application/x-ndjson

part "options": application/json packageimport.Options 的 JSON，不包含客户端绝对路径作为 source
part "package": application/octet-stream 上传的目录 tar.gz 或 archive 文件
```

multipart `options.source` 使用 daemon 可理解的临时 staging source，不使用客户端原始绝对路径。为便于持久化和展示，新增内部字段或等价包装信息表达上传元数据：

- 原始展示名：客户端 source 的 basename 或用户输入中的最后路径段。
- 上传种类：directory、archive、npm-local。
- service root：保留 `//service-dir` 或 recursive scan root，继续使用现有 `splitSourceServiceRoot` 和 `cleanServiceRoot` 边界校验。

上传目录时，CLI 以 tar.gz 流上传完整目录内容，daemon 将其解包为 staging package root，并标记 `BuildAllowed=true`。上传本地 archive 时，daemon 将文件保存为 staging artifact，按 `.tgz/.tar.gz/.zip` 解包并标记 `BuildAllowed=false`。上传本地 `npm:` path spec 时，daemon 在 staging package root 上执行与 local directory 相同的 npm pack/build 语义，并持久化为 `client-upload:<basename>` 形式。

`package_source` 持久化规则：

- 上传目录：`client-upload:<basename>` 或 `client-upload:<basename>//<service-root>`。
- 上传 archive：`client-upload:<basename>` 或 `client-upload:<basename>//<service-root>`。
- 上传 recursive import 中每个 service：`client-upload:<basename>//<discovered-service-root>`。
- 不保存客户端绝对路径，不保存 multipart 临时路径。

输出 JSON、NDJSON event shape、HTTP status 和 `status=degraded` 语义保持兼容。已有 JSON API 客户端无需迁移。

## 工作流和失败语义

单 service 上传导入：

1. CLI 根据 `--source-mode` 和客户端本地 source 是否存在、类型是否受支持判断是否上传。
2. CLI 解析并保留 `//service-dir`，确认本地 source 存在且类型受支持。
3. CLI 构造 multipart 请求，继续发送 `Accept: application/x-ndjson`。
4. daemon 认证 admin token 后读取 multipart，把上传内容写入 import staging。
5. daemon 复用 importer 执行 source preparation、build policy、manifest/schema/bin 校验、runtime dependency preparation、descriptor compile、artifact commit 和 enabled instance restart。
6. CLI 按现有方式展示 progress 和 complete event。

recursive 上传导入与单 service 相同，但 `options.recursive=true`，禁止 `service_id` 和 `name`，daemon 从上传后的 package root 中发现 service roots。

失败语义：

- CLI 在上传前发现 source 不存在、不是目录或支持的 archive、`npm:` local path 不存在时，返回本地错误，不发 Admin API。
- multipart 缺少 `options` 或 `package`、options JSON 无效、recursive 参数非法、service root 非法时，Admin API 返回 `400` 或 NDJSON `error` event。
- 上传内容解包失败、archive path unsafe、build 失败、dependency install 失败、descriptor compile 失败时，保持现有 import 失败语义：service 当前版本不变，staging 清理。
- service 当前版本提交后重启 enabled instances 失败时，保持现有 degraded 响应和 NDJSON complete event。
- 请求取消时，daemon 应尽快停止读取上传或 import，并清理 staging；CLI 返回 context/request 错误。

安全和日志语义：

- daemon 主日志可以记录 service id、runtime mode、descriptor hash、method count、source kind 和上传 basename，不记录客户端绝对路径、请求体、token、secret、Authorization 或 multipart 内容。
- 上传 package 仍按 trusted package assumption 处理；导入和运行第三方 package 等价于在 daemon 机器执行第三方代码。
- 不新增持久化 secret 或 credential 字段。

## 测试、质量门禁和验收标准

Unit tests：

- `internal/cli` 覆盖 `--source-mode` 参数校验、本地 source 存在性和类型判断、本地目录/archive/`npm:` path spec 的 multipart 选择、`--source-mode remote` 保持 JSON、`--source-mode upload` 对不存在 source 的本地错误。
- `internal/admin` 覆盖 JSON import 兼容、multipart 单 service、multipart recursive、NDJSON streaming、缺少 part、非法 options、取消请求清理。
- `internal/packageimport` 覆盖上传目录和上传 archive 转换出的 `preparedSource` 与现有 local source 行为一致，`package_source` 不泄露客户端绝对路径，recursive source root 记录正确。

Integration tests：

- 在 `internal/integration` 使用 `httptest` admin server 和独立客户端临时目录，验证远程样式 `--addr <server>` 下上传本地目录能 import 成功，即使 daemon 侧不存在同一路径。
- 覆盖 Docker/端口映射类场景：admin address 是 `127.0.0.1` 或 `localhost`，但 daemon 工作目录和客户端 source 路径不共享时，`auto` 仍因客户端 source 存在而上传。
- 覆盖 `service import --recursive` 上传目录并发现多个 service root。
- 覆盖本地 archive 上传和 `--build=always` 对 archive 仍失败的既有规则。

E2E tests：

- 在 `tests/e2e` 增加真实 binary + daemon + CLI 的远程导入场景：daemon 工作目录与 CLI source 路径不共享，`octobus --addr <daemon_addr> service import echo <client-local-dir>` 成功。
- 若 e2e 成本过高，至少保留 integration 覆盖真实 admin handler + CLI，并在 PR 中说明未跑 e2e 的原因；涉及 CLI/package import 的最终合并前应按 `AGENTS.md` 跑 `go test ./tests/e2e -count=1` 或 `task test`。

门禁：

- 聚焦开发期运行 `go test ./internal/cli ./internal/admin ./internal/packageimport ./internal/integration`。
- 提交前运行 `task lint` 和相关测试；变更稳定后运行 `task test`。CI 至少会运行 `go test ./cmd/... ./internal/...`、`go vet ./...` 和 binary build。

验收标准：

- `octobus --addr 10.2.101.197:9000 service import panorama-tenant-api .` 在客户端当前目录是合法 service package 时成功导入远端 daemon。
- `octobus --addr 127.0.0.1:<mapped_port> service import panorama-tenant-api .` 在 daemon 位于 Docker 容器或端口转发后的独立文件系统时同样成功。
- 远端 daemon 不需要存在客户端传入的路径。
- `--source-mode remote` 能继续让远端 daemon 按自己的文件系统解析同一个 `SOURCE` 字符串。
- 现有 Git、npm registry、HTTP(S) archive、localhost local import、config/secret/token 文件输入行为不回归。
- CLI 输出和 daemon 日志不泄露客户端绝对路径中的敏感目录结构或 import-time credentials。

## 首版不做事项

- 不实现通用文件上传管理 API；上传能力只服务 `POST /admin/v1/services/import`。
- 不支持从 stdin 上传 service package。
- 不新增服务端上传大小限制、配额、断点续传或上传进度事件；首版只保证流式传输避免整体读入内存。
- 不改变 service package contract、runtime sandbox、安全信任模型或 SQLite schema。
- 不让 daemon 反向访问 CLI 机器，也不引入 SSH/SCP/rsync。
- 不改变 config/secret/token 文件输入语义。
- 不迁移现有 JSON Admin API 客户端到 multipart。

## 关键假设和已确认决策

- 本方案名称为 `remote-service-import`，输出路径为 `docs/spec/remote-service-import-spec.md`。
- 默认策略采用 `--source-mode auto`，本地存在受支持 source 时自动上传；显式 `remote` 和 `upload` 解决误判。
- daemon 仍负责所有 package import 权威逻辑；CLI 只负责读取/打包/上传客户端本地资源。
- `package_source` 不保存客户端绝对路径，使用 `client-upload:<basename>` 表达上传来源。
- 其他子命令不存在同类 daemon 访问客户端路径问题，首版不做改造。
