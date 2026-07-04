# 远程 Service Import 本地资源上传实施计划

输入 spec：`docs/spec/remote-service-import-spec.md`。

本计划实现 `octobus service import` 在远程 daemon、Docker 端口映射、SSH tunnel、kubectl port-forward 等不共享文件系统场景下导入 CLI 客户端本地 package 的能力。计划保留三态 source 语义：

- `auto`：默认值；客户端本地存在受支持 source 时上传，否则保持 daemon-side JSON import。
- `upload`：强制客户端本地上传，source 不存在或类型不支持时 CLI 侧失败。
- `remote`：强制 daemon-side source，保持现有 JSON 请求和远端路径语义。

## 阶段 1：Package Import 支持内部上传源

目标：`internal/packageimport` 能从 daemon 临时上传文件构造 `preparedSource`，同时保持现有 JSON source 行为不变。

依赖：`docs/spec/remote-service-import-spec.md`；现有 `internal/packageimport/importer.go` 的 `Options`、`prepareSource`、`buildSourcePackage`、`Import`、`ImportRecursive`。

实施工作：

1. 在 `internal/packageimport` 中新增内部上传模型，例如：
   - `type UploadKind string`，取值 `directory`、`archive`、`npm-local`。
   - `type UploadedSource struct { Kind UploadKind; Path string; DisplaySource string }`。
   - `Options.Upload *UploadedSource `json:"-"``，只由 admin multipart 入口设置，JSON Admin API 不可设置。
2. 在 `prepareSource` 开头判断 `opts.Upload != nil`，走 `prepareUploadedSource`，否则保持现有 source 分类逻辑。
3. `prepareUploadedSource` 使用 `opts.Source` 解析 `//service-dir` 或 recursive scan root，但只把 `opts.Upload.Path` 当作 daemon 临时文件读取；`opts.Source` 必须是 `client-upload:<basename>` 或带 service root 的 `client-upload:<basename>//<root>`。
4. 上传目录和 `npm-local` 目录使用 CLI 上传的 tar.gz artifact：解包到 `staging/package`，`PackageSource=opts.Source`，`ServiceRoot` 使用解析结果，`BuildAllowed=true`。
5. 上传 `.tgz/.tar.gz/.zip` archive：复制或重命名为 `staging/package.tgz` 或 `staging/package.zip`，解包后 `normalizePackageDir`，`BuildAllowed=false`。
6. 上传 `npm-local` 文件路径按底层文件类型处理；首版仅接受目录和现有 archive 后缀，其他文件类型返回明确错误。
7. 计算上传 artifact sha256；后续 `buildSourcePackage` 对 `BuildAllowed=true` 的来源继续执行现有 npm pack/build 规则，并可能替换最终 artifact。
8. recursive import 中 `recursiveBasePackageSource` 对 `client-upload:<basename>//scan-root` 必须返回 `client-upload:<basename>`，最终每个 service 的 `PackageSource` 为 `client-upload:<basename>//<discovered-root>`。
9. 确保所有上传临时路径不会写入 SQLite、Admin API 响应或 CLI 输出。

测试和验证：

- 在 `internal/packageimport/importer_test.go` 增加上传目录单 service import 测试，验证 service 可导入、`PackageSource` 为 `client-upload:<basename>`、不包含临时路径。
- 增加上传目录带 `//service-dir` 测试，验证 `ServiceRoot`、`PackageSource`、`NodeEntry` 与现有 local source 行为一致。
- 增加上传 archive `.tgz` 和 `.zip` 测试，验证 `BuildAllowed=false` 规则：`--build=always` 返回现有 archive 错误语义。
- 增加上传 recursive import 测试，验证发现多个 service roots，且每个 service 的 `PackageSource` 使用 discovered root。
- 运行 `go test ./internal/packageimport`。

验收标准：

- 未设置 `Options.Upload` 时现有 local/npm/remote archive/Git source 行为和测试不变。
- 设置 `Options.Upload` 时 importer 不读取客户端原始路径，只读取 daemon 临时上传文件。
- `package_source` 不泄露 daemon 临时路径或客户端绝对路径。

适用 harness 约束或命令：

- 遵守 `AGENTS.md` 的 Go 代码 `gofmt`、显式错误上下文和 package 命名要求。
- 本阶段 focused gate：`go test ./internal/packageimport`。

## 阶段 2：Admin API 接受 Multipart Import

目标：`POST /admin/v1/services/import` 同时支持现有 JSON 请求和新的 multipart 上传请求，并保留普通 JSON 响应与 NDJSON streaming 语义。

依赖：阶段 1 的 `Options.Upload` 和 `prepareUploadedSource`。

实施工作：

1. 在 `internal/admin/admin.go` 的 `handleServiceImport` 中按 `Content-Type` 分流：
   - `application/json` 走现有 `readJSON` 路径。
   - `multipart/form-data` 走新 `readMultipartServiceImport`。
   - 其他 content type 返回 `400`，错误提示包含支持的类型。
2. multipart shape：
   - `options` part：JSON `packageimport.Options`，其中 `source` 为 sanitized `client-upload:<basename>` 或带 `//root` 的形式。
   - `upload_kind` form field：`directory`、`archive`、`npm-local`。
   - `package` file part：上传的 tar.gz 或 archive 内容；filename 只用于错误上下文，不作为可信路径。
3. `readMultipartServiceImport` 使用 `r.Context()` 控制读取，保存 `package` 到 `os.MkdirTemp("", "octobus-service-import-*")` 创建的 daemon 临时目录；函数返回 `packageimport.Options` 和 cleanup 函数。
4. 在普通和 streaming import 完成后执行 cleanup；请求解析失败也要清理已创建临时文件。
5. multipart 入口复用现有 recursive 参数校验、`handleStreamingServiceImport`、`handleRecursiveServiceImport` 和 enabled instance restart 逻辑。
6. 日志只记录 service id、recursive/build/offline/reinstall 等现有字段和上传 kind；不记录 multipart body、临时路径、Authorization、token、secret 或客户端绝对路径。
7. fake importer 测试需要能断言收到的 `opts.Upload` 非空、`opts.Source` 为 sanitized source、`opts.Upload.Path` 指向存在的 daemon 临时文件。

测试和验证：

- 在 `internal/admin/admin_test.go` 增加 multipart 单 service import 测试：fake importer 读取 `opts.Upload.Path`，确认文件内容、kind、sanitized source。
- 增加 multipart recursive import 测试：`recursive=true`、无 `service_id/name`，fake importer 走 `ImportRecursive`。
- 增加 multipart NDJSON streaming 测试：`Accept: application/x-ndjson` 时先解析上传，再输出 progress/complete event。
- 增加缺少 `options`、缺少 `package`、非法 `upload_kind`、非法 options JSON、recursive 携带 `service_id` 的错误测试。
- 增加 cleanup 测试：fake importer 返回后临时目录被删除；解析失败后也删除已创建临时目录。
- 运行 `go test ./internal/admin`。

验收标准：

- 现有 JSON Admin API 完全兼容，旧测试不需要改成 multipart。
- multipart 请求在普通响应和 NDJSON 响应下都能到达 importer。
- 请求失败或取消不会留下上传临时文件。

适用 harness 约束或命令：

- `AGENTS.md` 要求 admin/API 行为变更需要测试覆盖，错误要有有用上下文。
- 本阶段 focused gate：`go test ./internal/admin`。

## 阶段 3：CLI 实现 Source Mode 和 Multipart 上传

目标：`internal/cli` 为 `service import` 增加 `--source-mode auto|upload|remote`，并在需要时发起 multipart 上传请求。

依赖：阶段 2 的 multipart Admin API。

实施工作：

1. 在 `serviceImportCommand` 新增 `sourceMode string`，默认 `auto`，help 文案说明：
   - `auto`：客户端本地存在受支持 source 时上传，否则 daemon-side。
   - `upload`：强制上传并本地校验。
   - `remote`：强制 daemon-side。
2. 新增 CLI 本地 source 解析 helper，必须在调用现有 `normalizeImportSource` 前运行：
   - 解析可选 `npm:` 前缀。
   - 对非 URL source 使用现有 `//service-dir` 拆分规则。
   - 对底层 path 执行 `os.Stat`，支持目录、`.tgz`、`.tar.gz`、`.zip`。
   - `auto` 中本地 path 存在且类型受支持则上传；不存在则走现有 JSON/normalize。
   - `upload` 中 path 不存在或类型不支持则返回 CLI 本地错误。
   - `remote` 永远走现有 JSON/normalize。
3. CLI 上传目录时流式生成 tar.gz，内容以 `package/` 为根，跳过 symlink 和其他非 regular file，与 importer 现有 `tarGzDir` 行为一致；不要把整个目录读入内存。
4. CLI 上传 archive 时直接流式读取文件；上传 `npm:` local source 时按底层目录或 archive 上传，但 `upload_kind=npm-local`。
5. multipart `options.source` 使用 sanitized `client-upload:<basename>`，并附加原始 `//service-dir` 或 recursive scan root；不得包含客户端绝对路径。
6. 新增通用 request helper，允许传入任意 `io.Reader`、`Content-Type` 和 headers；`requestServiceImport` 根据传输类型调用 JSON 或 multipart helper，并继续关闭 client timeout、发送 `Accept: application/x-ndjson`、复用 `handleServiceImportStream`。
7. JSON 请求路径保持现有 `normalizeImportSource` 行为，避免破坏 daemon-side local import 和 Git/npm/HTTP source。
8. CLI 自动读取 `.env`、`.octobus.yml` admin token 的逻辑不变，multipart 请求同样设置 `Authorization: Bearer ...`。

测试和验证：

- 在 `internal/cli/cli_test.go` 增加 `--source-mode` 参数校验测试，非法值报错。
- 增加 `auto` 本地目录、archive、`npm:./pkg` 触发 multipart 的测试，断言 `Content-Type`、`Accept`、`options.source`、`upload_kind` 和 package part 存在。
- 增加 `auto` 本地不存在 source 走 JSON 的测试，确认行为支持 daemon-side remote path。
- 增加 `remote` 在本地 source 存在时仍走 JSON 的测试。
- 增加 `upload` 对不存在 source、本地不支持文件类型的 fail-fast 测试。
- 增加 localhost/Docker 映射语义测试：即使 `--addr` 是 `127.0.0.1`，只要本地 source 存在，`auto` 仍上传。
- 保留或调整现有 `TestServiceImportRequestConvertsLocalSourceToAbsolutePath`：该断言只应适用于 `--source-mode remote` 或本地不存在 path 的 JSON 路径；默认 `auto` 的新行为应断言 multipart。
- 运行 `go test ./internal/cli`。

验收标准：

- 默认 `auto` 下 `octobus --addr 127.0.0.1:<mapped_port> service import svc .` 会上传，不依赖 loopback 判断。
- 用户显式 `--source-mode remote` 时，`SOURCE` 字符串按现有 daemon-side JSON 语义提交。
- 上传请求保持原有 service import progress 和 complete 输出。

适用 harness 约束或命令：

- `AGENTS.md` 要求 CLI 行为变更用相邻 tests 覆盖，并保持现有命令风格。
- 本阶段 focused gate：`go test ./internal/cli`。

## 阶段 4：集成、E2E 和文档收尾

目标：用跨组件测试证明远程样式导入不要求 daemon 访问客户端路径，并更新用户可见文档。

依赖：阶段 1-3 完成。

实施工作：

1. 在 `internal/integration/goal_flow_test.go` 或新 integration test 文件中增加真实 `admin.Server` + `cli.CLI` 流程：
   - 客户端工作目录包含 local service package。
   - daemon/importer 使用独立 `dataDir`，不包含客户端 source 路径。
   - CLI 使用 `AdminAddr` 连接 `httptest` server，默认 `auto` 上传并导入成功。
2. 增加 integration 覆盖 `--source-mode remote`：客户端存在同名路径时仍发 JSON，fake/admin 或真实 importer 应表现为 daemon-side source。
3. 增加 recursive 上传 integration：使用现有 `createRecursiveFixturePackage`，验证两个 service 均导入，`PackageSource` 为 `client-upload:<basename>//<root>`。
4. 增加 archive 上传 integration：zip 或 tgz source 上传成功，`--build=always` 对 archive 仍失败。
5. 在 `tests/e2e` 增加 process-level 场景：
   - 使用真实 binary 启动 daemon。
   - CLI 从不同工作目录导入 local fixture。
   - `--addr` 可使用 daemon loopback 地址；重点断言 daemon 工作目录与 CLI source 路径不共享时仍成功。
   - 避免外部网络和固定端口，沿用 `tests/e2e/harness_test.go` helpers。
6. 更新 `README.md`、`docs/design/product/cli.md`、`docs/design/technical/service-package.md`：
   - 说明 `service import` 默认 `auto` 会上传客户端本地 source。
   - 说明 `--source-mode remote` 用于 daemon-side path。
   - 说明 `--source-mode upload` 用于强制本地上传和 fail-fast。
   - 明确 `127.0.0.1` 不代表共享文件系统，Docker/port-forward 场景默认仍上传本地 source。
7. 确认 `docs/spec/remote-service-import-spec.md` 与最终行为一致；若实现中出现必要偏差，先更新 spec 再更新计划或 progress。

测试和验证：

- 运行 focused gates：
  - `go test ./internal/cli ./internal/admin ./internal/packageimport ./internal/integration`
  - `go test ./tests/e2e -count=1`
- 提交前运行 harness gates：
  - `task lint`
  - `task test`
  - `task build`
- 若本地环境缺少 Node.js/npm/protoc 导致 `task test` 或 e2e 无法运行，必须在最终记录中明确未运行命令、失败原因和已运行的替代 focused tests。

验收标准：

- `octobus --addr 10.2.101.197:9000 service import panorama-tenant-api .` 在客户端当前目录是合法 package 时可导入远端 daemon。
- `octobus --addr 127.0.0.1:<mapped_port> service import panorama-tenant-api .` 在 Docker/端口映射样式独立文件系统下仍通过默认 `auto` 上传。
- 现有 Git、npm registry、HTTP(S) archive、daemon-side local import、config/secret/token 文件输入行为不回归。
- 文档中的 CLI 示例和行为描述与实现一致。

适用 harness 约束或命令：

- `AGENTS.md` 要求 CLI/package import 变更后运行 e2e；`Taskfile.yml` 定义 `task lint`、`task test`、`task build` 为主门禁；CI 会运行 `go test ./cmd/... ./internal/...`、`go vet ./...` 和 binary build。

## 风险和停止条件

- 如果 multipart 解析必须在写出 NDJSON header 前完成，用户在大文件上传期间看不到 import progress；这是首版可接受限制，不应临时扩展为上传进度协议。
- 如果实现需要把客户端绝对路径写入 `package_source` 才能通过测试，应停止并调整方案；这是 spec 明确禁止的泄露。
- 如果 `auto` 依赖 admin address loopback/remote 判断，应停止；spec 已确认该判断在 Docker/port-forward 场景失效。
- 如果需要新增 SQLite schema、通用上传 API、daemon 反向拉取 CLI 文件、stdin 上传或服务端配额系统，应停止并另起 spec。
- 如果 archive upload 为支持 `--build=always` 需要改变现有 archive build policy，应停止；archive 仍是已发布 artifact。

## 首版不做的事项

- 不实现通用文件上传管理 API。
- 不支持从 stdin 上传 service package。
- 不新增服务端上传大小限制、配额、断点续传或上传进度事件。
- 不改变 service package contract、runtime sandbox、安全信任模型或 SQLite schema。
- 不引入 SSH/SCP/rsync 或 daemon 反向访问 CLI 机器。
- 不改变 config/secret/token 文件输入语义。
- 不迁移现有 JSON Admin API 客户端到 multipart。
