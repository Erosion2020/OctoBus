# 远程 Service Import 本地资源上传 Progress

本文档把远程 `service import` 本地资源上传能力拆成可独立执行、独立验收的任务清单。任务按依赖顺序排列；标记为“可并行”的子任务可以在同一父任务内并行推进，但 subagent 并发度最高不超过 5。

## 文档索引

- 技术方案：[docs/spec/remote-service-import-spec.md](docs/spec/remote-service-import-spec.md)
- 实施计划：[docs/plan/remote-service-import-implementation-plan.md](docs/plan/remote-service-import-implementation-plan.md)
- Harness：[AGENTS.md](AGENTS.md)
- Task 工作流：[Taskfile.yml](Taskfile.yml)
- CI 配置：[.github/workflows/ci.yml](.github/workflows/ci.yml)
- E2E 约定：[tests/e2e/README.md](tests/e2e/README.md)
- CLI 设计：[docs/design/product/cli.md](docs/design/product/cli.md)
- Service package 设计：[docs/design/technical/service-package.md](docs/design/technical/service-package.md)
- 运行与安全约束：[docs/design/product/operations.md](docs/design/product/operations.md)、[docs/design/product/security.md](docs/design/product/security.md)

## 执行规则

- [ ] 每个任务完成时必须同时完成对应测试方案和验收标准。
- [ ] 按阶段依赖顺序推进，不跨阶段合并依赖未满足的功能。
- [ ] 行为变更必须优先使用相邻 unit tests；跨组件行为进入 `internal/integration`；真实 binary/daemon/CLI 行为进入 `tests/e2e`。
- [ ] `auto` 不允许基于 `--addr` 是否 loopback 判断是否上传；只根据客户端本地 source 是否存在且类型受支持判断。
- [ ] 不把客户端绝对路径、daemon 上传临时路径、Authorization、token、secret、完整 config 或 multipart 内容写入 SQLite、Admin API 响应、CLI 输出或 daemon 日志。
- [ ] 每个任务合并前至少运行该任务要求的最小测试；阶段性收口运行 `task lint`、`task test`、`task build`，或记录无法运行原因。
- [ ] 每个任务完成后必须按 `状态`、`变更`、`验证`、`审计与例外`、`下一目标` 记录完成总结。

## 1. Package Import 支持内部上传源

参考文档：[实施计划阶段 1](docs/plan/remote-service-import-implementation-plan.md#阶段-1package-import-支持内部上传源)。

- [x] 1.1 定义上传源内部模型
  - 依赖：无。
  - 工作内容：在 `internal/packageimport` 增加 `UploadKind`、`UploadedSource` 和 `Options.Upload *UploadedSource`，确保 `json:"-"`，只供 Admin multipart 入口内部设置；保持现有 JSON `packageimport.Options` wire shape 不变。
  - 可并行子任务：
    - [x] 可并行：审阅 `internal/packageimport/importer.go` 中 `Options`、`preparedSource`、`prepareSource`、`Import`、`ImportRecursive` 的调用链，确认新增字段不会影响 JSON API。
    - [x] 可并行：在 `internal/packageimport/importer_test.go` 添加字段不可由 JSON 设置或 JSON marshal 不暴露的 focused 断言。
  - 测试方案：`go test ./internal/packageimport`。
  - 验收标准：现有 importer JSON source 测试不回归；新增 `Options.Upload` 不出现在 JSON 编码中。
  - 完成总结：
    - 状态：已完成。
    - 变更：
      - 在 `internal/packageimport/importer.go` 增加 `UploadKind`、`UploadedSource` 和 `Options.Upload *UploadedSource`。
      - `Options.Upload` 使用 `json:"-"`，与现有 `Progress` 一样只作为进程内字段，不进入 Admin JSON wire shape。
      - 在 `internal/packageimport/importer_test.go` 增加 `TestOptionsUploadIsInternalOnly`，覆盖 marshal 不暴露内部字段、unmarshal 不能从 JSON 设置上传源。
    - 验证：
      - `go test ./internal/packageimport` 通过。
    - 审计与例外：
      - 已审阅 `Options`、`Import`、`ImportRecursive`、`prepareSource` 和 `preparedSource` 调用链；本任务只添加内部模型，未改变 source preparation 分支。
      - 未实现 `prepareUploadedSource`，按计划留给 1.2。
    - 下一目标：1.2 上传源 prepare 流程。

- [x] 1.2 实现 `prepareUploadedSource`
  - 依赖：1.1。
  - 工作内容：在 `prepareSource` 开头分支 `opts.Upload != nil`，实现 daemon 临时上传文件到 `preparedSource` 的转换；上传目录和 `npm-local` 目录解包为 package root 且 `BuildAllowed=true`，上传 archive 解包并 `BuildAllowed=false`，`PackageSource` 使用 `client-upload:<basename>` 及 `//service-root`。
  - 可并行子任务：
    - [x] 可并行：实现上传目录 tar.gz 解包、sha256、`PackageDir` 和 `PackageSource` 处理。
    - [x] 可并行：实现上传 archive `.tgz/.tar.gz/.zip` 解包、`normalizePackageDir` 和 `BuildAllowed=false` 处理。
    - [x] 可并行：实现 `npm-local` 上传类型校验，首版只接受目录和现有 archive 后缀。
  - 测试方案：`go test ./internal/packageimport`。
  - 验收标准：上传目录、上传 archive、上传 `npm-local` 均可生成正确 `preparedSource`；错误信息包含有用上下文；不读取客户端原始路径。
  - 完成总结：
    - 状态：已完成。
    - 变更：
      - 在 `internal/packageimport/importer.go` 中让 `prepareSource` 优先处理 `Options.Upload`。
      - 新增 `prepareUploadedSource`、上传目录/上传 archive 准备 helper、上传 archive 后缀识别和文件 hash helper。
      - 上传 source 要求使用 `client-upload:` 展示源；目录和 `npm-local` 目录解包为 staging `package/` 根并 `BuildAllowed=true`；`.tgz/.tar.gz/.zip` archive 解包后 `BuildAllowed=false`。
      - 错误路径不回显非 `client-upload:` 原始 source，避免后续 Admin 错误响应泄露客户端路径。
      - 在 `internal/packageimport/importer_test.go` 增加上传目录、上传 archive、`npm-local` 目录/zip 和内部校验错误测试。
    - 验证：
      - `go test ./internal/packageimport` 通过。
    - 审计与例外：
      - 已复用现有 `untarGz`、`unzip`、`normalizePackageDir`、`sourceWithServiceRoot` 和 archive 安全路径校验。
      - recursive import 的 `client-upload:<basename>//<discovered-root>` 持久化语义尚未调整，按计划留给 1.3。
    - 下一目标：1.3 上传 source 持久化和 recursive 行为。

- [x] 1.3 固定上传 source 持久化和 recursive 语义
  - 依赖：1.2。
  - 工作内容：调整 `recursiveBasePackageSource` 或相关 helper，让 `client-upload:<basename>//scan-root` 在 recursive import 中为每个 discovered service 记录 `client-upload:<basename>//<discovered-root>`；确保单 service `//service-dir` 仍记录为 `client-upload:<basename>//<service-root>`。
  - 可并行子任务：
    - [x] 可并行：补充 single service 上传目录带 `//service-dir` 的测试。
    - [x] 可并行：补充 recursive 上传目录发现多个 service root 的测试。
    - [x] 可并行：审计 `PackageSource`、Admin 响应和 CLI 输出是否可能泄露临时路径。
  - 测试方案：`go test ./internal/packageimport`。
  - 验收标准：上传 recursive import 的每个 service `PackageSource` 稳定、可读、无临时路径；现有 Git/npm/local recursive 行为不回归。
  - 完成总结：
    - 状态：已完成。
    - 变更：
      - 在 `internal/packageimport/importer_test.go` 增加上传目录单 service `//service-dir` 导入测试，断言 `PackageSource`、`ServiceRoot`、`NodeEntry` 和 store 持久化值。
      - 增加上传目录 recursive scan root 测试，断言 `client-upload:<basename>//nested` 最终持久化为 `client-upload:<basename>//nested/vendor__gamma`。
      - 审阅 `ImportRecursive` 中 `splitSourceServiceRoot`、`recursiveBasePackageSource` 和 `sourceWithServiceRootForPackage` 组合；现有非 Git fallback 已能去除 scan root 并重组 discovered service root，无需改生产代码。
    - 验证：
      - `go test ./internal/packageimport` 通过。
    - 审计与例外：
      - 新增断言确认上传临时文件路径没有进入 `PackageSource`。
      - 本阶段只覆盖 `internal/packageimport` 的持久化语义；Admin 响应和 CLI 输出泄露审计将在阶段 2/3 接入 multipart 后继续覆盖。
    - 下一目标：1.4 packageimport 阶段收口。

- [x] 1.4 Package Import 阶段收口
  - 依赖：1.1、1.2、1.3。
  - 工作内容：运行本阶段 focused tests，修复 packageimport 内部 regressions，确认 `--build=always` 对上传 archive 保持现有 archive 错误语义。
  - 可并行子任务：
    - [x] 可并行：审阅 `internal/packageimport/importer_test.go` 是否覆盖 upload directory、archive、npm-local、recursive、source root。
    - [x] 可并行：运行并记录 focused test 结果。
  - 测试方案：`go test ./internal/packageimport`。
  - 验收标准：本阶段所有 packageimport 上传源测试通过；未设置 `Options.Upload` 的现有 source 行为不变。
  - 完成总结：
    - 状态：已完成。
    - 变更：
      - 审阅 `internal/packageimport/importer_test.go` 中上传目录、上传 archive、`npm-local`、single service source root、recursive scan root 和错误路径覆盖。
      - 新增 `TestImporterRejectsBuildAlwaysForUploadedArchive`，用真实 `Import` 路径确认上传 archive 在 `--build=always` 下保持现有非 buildable archive 错误语义，且失败后不提交 service。
    - 验证：
      - `go test ./internal/packageimport` 通过。
    - 审计与例外：
      - 阶段 1 的 `Options.Upload`、`prepareUploadedSource`、`PackageSource` 持久化和 archive build policy 均已有 focused coverage。
      - 未设置 `Options.Upload` 的现有 local/npm/remote archive/Git 路径继续由原有 packageimport 测试覆盖，本阶段 focused gate 已整体通过。
    - 下一目标：2.1 Admin multipart 解析。

## 2. Admin API 接受 Multipart Import

参考文档：[实施计划阶段 2](docs/plan/remote-service-import-implementation-plan.md#阶段-2admin-api-接受-multipart-import)。

- [x] 2.1 实现 import 请求 Content-Type 分流
  - 依赖：1.4。
  - 工作内容：在 `internal/admin/admin.go` 的 `handleServiceImport` 中按 `Content-Type` 分流 JSON 和 `multipart/form-data`；JSON 路径保持现有 `readJSON` 和 streaming 行为，未知类型返回明确 `400`。
  - 可并行子任务：
    - [x] 可并行：补充 JSON import 兼容测试，确认旧请求仍调用 fake importer。
    - [x] 可并行：补充未知 Content-Type 错误测试。
  - 测试方案：`go test ./internal/admin`。
  - 验收标准：现有 Admin JSON import 测试不需要改成 multipart；错误响应清晰。
  - 完成总结：
    - 状态：已完成。
    - 变更：
      - 在 `internal/admin/admin.go` 增加 `readServiceImportRequest`，按 `Content-Type` 分流 service import 请求。
      - 空 Content-Type 和 `application/json` 保持现有 `readJSON` 兼容路径；`multipart/form-data` 进入 2.2 待实现的 `readMultipartServiceImport` 占位入口；未知类型返回明确 `400`。
      - 在 `internal/admin/admin_test.go` 增加 JSON Content-Type 兼容测试和未知 Content-Type 错误测试，确认 unsupported type 不调用 importer。
    - 验证：
      - `go test ./internal/admin` 通过。
    - 审计与例外：
      - 本任务不解析 multipart body、不创建临时文件，也不改变 streaming、recursive、restart 处理函数；这些保持现有调用链。
      - `multipart/form-data` 当前只完成分流占位，实际 options/package 解析和 cleanup 留给 2.2。
    - 下一目标：2.2 multipart 解析与临时文件。

- [x] 2.2 解析 multipart 并设置 `Options.Upload`
  - 依赖：2.1。
  - 工作内容：实现 `readMultipartServiceImport`，读取 `options` JSON、`upload_kind` 和 `package` part，把上传内容流式保存到 daemon 临时目录，返回带 `Options.Upload` 的 `packageimport.Options` 和 cleanup 函数。
  - 可并行子任务：
    - [x] 可并行：实现 multipart happy path 解析和 fake importer 断言。
    - [x] 可并行：实现缺少 `options`、缺少 `package`、非法 `upload_kind`、非法 JSON 的错误处理。
    - [x] 可并行：实现临时目录 cleanup，并覆盖成功和失败路径。
  - 测试方案：`go test ./internal/admin`。
  - 验收标准：fake importer 能读取 `opts.Upload.Path`；请求结束后临时目录清理；错误路径不泄露临时路径或请求体。
  - 完成总结：
    - 状态：已完成。
    - 变更：
      - 在 `internal/admin/admin.go` 实现 `readMultipartServiceImport`，读取 `options`、`upload_kind` 和 `package` part。
      - multipart `options` 复用 strict JSON 解码规则；`upload_kind` 映射到 `packageimport.UploadKindDirectory`、`UploadKindArchive` 或 `UploadKindNPMLocal`。
      - `package` part 通过 `io.Copy` 流式保存到 `os.MkdirTemp("", "octobus-service-import-*")` 创建的 daemon 临时目录，并设置 `Options.Upload` 的 kind、path 和 display source。
      - 解析失败立即清理临时目录；成功路径通过 handler defer 在 importer 返回后清理。
      - 在 `internal/admin/admin_test.go` 增加 multipart happy path fake importer 断言，以及缺少 `options`、缺少 `package`、非法 `upload_kind`、非法 options JSON 的错误测试和 TMPDIR cleanup 断言。
    - 验证：
      - `go test ./internal/admin` 通过。
    - 审计与例外：
      - 错误响应不包含 daemon 临时路径或 multipart body；测试通过 fake importer 读取上传文件并在响应后确认文件已删除。
      - NDJSON streaming、recursive aggregate 和 token middleware 复用语义留给 2.3/2.4 覆盖。
    - 下一目标：2.3 multipart streaming 和 recursive。

- [x] 2.3 复用 streaming、recursive 和 restart 语义
  - 依赖：2.2。
  - 工作内容：确保 multipart 请求在 `Accept: application/x-ndjson` 下进入现有 streaming import；`recursive=true` 时走 `ImportRecursive` 并复用现有 recursive validation；普通响应和 degraded restart 语义不变。
  - 可并行子任务：
    - [x] 可并行：补充 multipart NDJSON streaming complete/error 测试。
    - [x] 可并行：补充 multipart recursive import validation 和 aggregate response 测试。
    - [x] 可并行：审计 admin logger 字段，避免记录 multipart body、token、secret、临时路径。
  - 测试方案：`go test ./internal/admin`。
  - 验收标准：multipart 单 service、recursive、NDJSON 三条路径均到达 importer；现有 JSON streaming 测试不回归。
  - 完成总结：
    - 状态：已完成。
    - 变更：
      - 在 `internal/admin/admin.go` 增加 `serviceImportErrorMessage`，对带 `Options.Upload` 的 import 错误响应、NDJSON error event 和 admin 日志隐藏上传临时文件路径及其临时目录。
      - 普通、recursive、streaming 和 streaming recursive 四条 import 错误路径均使用同一 sanitizer；非上传 JSON import 保持原错误文本。
      - 在 `internal/admin/admin_test.go` 增加 multipart NDJSON complete/error 测试、recursive aggregate 测试和 recursive validation 测试。
      - 测试覆盖 multipart upload 在 streaming/recursive 路径到达 fake importer、请求结束后 cleanup，并断言错误响应和日志不包含上传临时路径。
    - 验证：
      - `go test ./internal/admin` 通过。
    - 审计与例外：
      - Admin logger 当前只记录 service id、offline/reinstall/build、runtime mode、descriptor hash、method count 等字段；未新增 multipart body、Authorization、token、secret 或临时路径字段。
      - Admin token middleware 对 multipart 请求的覆盖留给 2.4 阶段收口。
    - 下一目标：2.4 Admin 阶段收口。

- [x] 2.4 Admin 阶段收口
  - 依赖：2.1、2.2、2.3。
  - 工作内容：运行 admin focused tests，修复兼容性和 cleanup 问题；确认 admin token middleware 对 multipart 请求仍生效。
  - 可并行子任务：
    - [x] 可并行：运行并记录 `go test ./internal/admin`。
    - [x] 可并行：审阅 `internal/admin/admin_test.go` 新增覆盖是否包含错误路径和 cleanup。
  - 测试方案：`go test ./internal/admin`。
  - 验收标准：Admin multipart 能力可用且 JSON import 兼容；无临时文件残留测试失败。
  - 完成总结：
    - 状态：已完成。
    - 变更：
      - 在 `internal/admin/admin_test.go` 增加 multipart admin token middleware 测试，使用真实 `srv.Handler()` 验证无 token 返回 `401` 且 importer 不执行，有效 token 才到达 fake importer。
      - 审阅 Admin multipart 测试覆盖：JSON 兼容、未知 Content-Type、happy path、缺少 part、非法 kind、非法 options JSON、成功/失败 cleanup、NDJSON complete/error、recursive aggregate/validation、临时路径 redaction 和 token middleware。
    - 验证：
      - `go test ./internal/admin` 通过。
    - 审计与例外：
      - Admin 阶段 multipart 能力已可把上传临时文件传入 `Options.Upload`，并在请求结束后清理。
      - 本阶段未接入 CLI multipart builder；客户端实际上传入口从 3.1/3.2 开始实现。
    - 下一目标：3.1 CLI source-mode。

## 3. CLI Source Mode 和 Multipart 上传

参考文档：[实施计划阶段 3](docs/plan/remote-service-import-implementation-plan.md#阶段-3cli-实现-source-mode-和-multipart-上传)。

- [x] 3.1 增加 `--source-mode` 并实现本地 source 判定
  - 依赖：2.4。
  - 工作内容：在 `service import` 增加 `--source-mode auto|upload|remote`；实现本地 source 解析 helper，支持目录、`.tgz/.tar.gz/.zip` 和 `npm:` local path；`auto` 不使用 `--addr` 判断。
  - 可并行子任务：
    - [x] 可并行：实现 flag、参数校验和 help 文案。
    - [x] 可并行：实现 local source classification，包括 `npm:`、`//service-dir` 和 recursive scan root。
    - [x] 可并行：补充 `auto`、`upload`、`remote` source mode 单元测试。
  - 测试方案：`go test ./internal/cli`。
  - 验收标准：本地 source 存在且类型受支持时 `auto` 判定为上传；`remote` 永远走 JSON；`upload` 对不存在或不支持 source fail-fast。
  - 完成总结：
    - 状态：已完成。
    - 变更：
      - 在 `internal/cli/cli.go` 为 `service import` 增加 `--source-mode auto|upload|remote`，默认 `auto`。
      - 新增 source transfer mode 解析、本地 source 分类和 sanitized `client-upload:<basename>` source 生成逻辑。
      - 本地分类支持目录、`.tgz/.tar.gz/.zip`、`npm:` 本地路径和 `//service-dir`/recursive scan root；`auto` 不读取或依赖 admin address。
      - `remote` 保持现有 JSON normalize 行为；`upload` 对不存在或不支持的本地 source fail-fast。
      - 在 `internal/cli/cli_test.go` 增加 source-mode helper 测试和非法 flag 测试，并将旧本地路径转绝对路径测试显式切到 `--source-mode remote`。
    - 验证：
      - `go test ./internal/cli` 通过。
    - 审计与例外：
      - 真实 multipart request builder 尚未实现；`requestServiceImportUpload` 当前是 3.2 待替换占位。
      - 默认 `auto` 已能判定本地 source 应上传，但实际上传行为需 3.2 接通请求体后完整可用。
    - 下一目标：3.2 CLI multipart 请求。

- [x] 3.2 实现 CLI multipart 请求和目录打包
  - 依赖：3.1。
  - 工作内容：实现 service import multipart request helper；上传目录时流式生成 `package/` 根 tar.gz，上传 archive 时流式读取文件；设置 `options`、`upload_kind`、`package` part 和 `Accept: application/x-ndjson`。
  - 可并行子任务：
    - [x] 可并行：实现 multipart request builder 和 admin token header 复用。
    - [x] 可并行：实现目录 tar.gz 流式打包，跳过 symlink 和非 regular file。
    - [x] 可并行：实现 archive 文件流式上传。
    - [x] 可并行：补充 multipart 请求体解析测试，断言 `options.source` 不含客户端绝对路径。
  - 测试方案：`go test ./internal/cli`。
  - 验收标准：CLI multipart 请求可被测试 server 解析；`options.source` 为 `client-upload:<basename>` 或带 service root；上传请求仍复用 progress stream handler。
  - 完成总结：
    - 状态：已完成。
    - 变更：
      - 在 `internal/cli/cli.go` 实现 `requestServiceImportUpload`，用 `io.Pipe` 和 `multipart.Writer` 发送 `options`、`upload_kind` 和 `package` part。
      - 抽出 `doRequestWithClientReaderAndHeaders`，让 JSON 和 multipart 请求复用 admin base URL、Authorization、HTTP client timeout 和错误处理。
      - 新增 `writeImportDirectoryTarGz`，目录上传以 `package/` 为 tar.gz 根，跳过 symlink 和非 regular file；archive 上传直接流式复制本地文件。
      - 在 `internal/cli/cli_test.go` 增加 multipart 请求解析测试，覆盖默认 `auto` 上传目录、`--source-mode upload` 上传 archive 和 `npm:` 本地目录上传。
    - 验证：
      - `go test ./internal/cli` 通过。
    - 审计与例外：
      - 测试断言 multipart `options.source` 为 `client-upload:<basename>`，不包含客户端绝对路径。
      - localhost/Docker 映射语义和 Git/npm registry/HTTP JSON 回归测试按计划留给 3.3。
    - 下一目标：3.3 CLI 兼容性和回归。

- [x] 3.3 调整 CLI JSON 路径兼容测试
  - 依赖：3.2。
  - 工作内容：保留现有 JSON request 路径用于 `--source-mode remote` 和本地不存在 source；调整 `TestServiceImportRequestConvertsLocalSourceToAbsolutePath` 等旧断言，使默认 `auto` 的新行为断言 multipart。
  - 可并行子任务：
    - [x] 可并行：更新 local path absolute normalize 相关测试。
    - [x] 可并行：补充 localhost/Docker 映射语义测试，`--addr 127.0.0.1` 且本地 source 存在时仍上传。
    - [x] 可并行：补充 Git/npm registry/HTTP source 保持 JSON 的回归测试。
  - 测试方案：`go test ./internal/cli`。
  - 验收标准：默认 `auto` 行为与 spec 一致；现有 remote/Git/npm/HTTP source 不回归；CLI 输出和错误语义清晰。
  - 完成总结：
    - 状态：已完成。
    - 变更：
      - 将本地 archive、本地 `npm:` 和 recursive 本地 `npm:` 的旧 JSON 绝对路径测试显式改为 `--source-mode remote`，保留 daemon-side 兼容语义。
      - 将默认 auto 本地目录 multipart 测试明确为 loopback admin address 场景，证明 `127.0.0.1` 下本地 source 存在仍上传，不依赖地址判断。
      - 新增 HTTP archive source 默认 auto 保持 JSON 的回归测试；既有 Git source 和 npm registry source 测试继续覆盖 daemon-side JSON 路径。
    - 验证：
      - `go test ./internal/cli` 通过。
    - 审计与例外：
      - CLI 输出和 stream handler 仍走现有 `handleServiceImportStream`；本阶段未发现 stream progress/complete 输出回归。
      - 更完整的 CLI 阶段测试覆盖审阅留给 3.4 收口。
    - 下一目标：3.4 CLI 阶段收口。

- [x] 3.4 CLI 阶段收口
  - 依赖：3.1、3.2、3.3。
  - 工作内容：运行 CLI focused tests，修复 request helper、timeout、Authorization、stream output 和 redaction 回归。
  - 可并行子任务：
    - [x] 可并行：运行并记录 `go test ./internal/cli`。
    - [x] 可并行：审阅 `internal/cli/cli_test.go` 是否覆盖 source mode、multipart、JSON 回退、localhost 场景。
  - 测试方案：`go test ./internal/cli`。
  - 验收标准：CLI 上传和 JSON 两类请求测试通过；service import stream progress/complete 输出不回归。
  - 完成总结：
    - 状态：已完成。
    - 变更：
      - 审阅 `internal/cli/cli_test.go` 中 source-mode、multipart 上传、JSON 回退、loopback auto、stream progress/complete 和 redaction 相关覆盖。
      - 未新增生产代码；本任务为 CLI 阶段 focused gate 和覆盖审计收口。
    - 验证：
      - `go test ./internal/cli` 通过。
      - `go test ./internal/cli -count=1` 通过。
    - 审计与例外：
      - CLI 上传和 JSON 两类请求均有单元测试覆盖；service import stream handler 继续由既有 progress/complete/degraded/redaction 测试覆盖。
      - 尚未进行跨组件真实 Admin + CLI 流程验证，按计划留给 4.1 integration。
    - 下一目标：4.1 integration 测试。

## 4. 集成、E2E 和文档收尾

参考文档：[实施计划阶段 4](docs/plan/remote-service-import-implementation-plan.md#阶段-4集成e2e-和文档收尾)。

- [x] 4.1 增加 integration 覆盖
  - 依赖：3.4。
  - 工作内容：在 `internal/integration` 增加真实 `admin.Server` + `cli.CLI` 流程，验证默认 `auto` 上传本地目录、`--source-mode remote` 保持 JSON、recursive 上传、archive 上传和 archive `--build=always` 失败规则。
  - 可并行子任务：
    - [x] 可并行：实现单 service 上传目录 integration。
    - [x] 可并行：实现 recursive 上传目录 integration。
    - [x] 可并行：实现 archive 上传与 `--build=always` 规则 integration。
    - [x] 可并行：实现 `--source-mode remote` 兼容 integration。
  - 测试方案：`go test ./internal/integration`。
  - 验收标准：daemon/importer 使用独立 data dir 时不需要访问客户端 source 路径；`PackageSource` 为 `client-upload:<basename>` 形式；兼容路径可验证。
  - 完成总结：
    - 状态：已完成。
    - 变更：
      - 在 `internal/integration/goal_flow_test.go` 增强 `TestCLIAdminGatewayAndStoreIntegrationCRUD`，默认 `auto` 通过 CLI 上传客户端本地目录，并断言 store 中 `PackageSource=client-upload:fixture`。
      - 增强 `TestCLIRecursiveServiceImportListsServices`，断言 recursive 上传目录后的每个服务持久化为 `client-upload:recursive-fixture//<service-root>`。
      - 新增 `TestCLIServiceImportUploadArchiveAndRemoteModeIntegration`，覆盖 CLI 上传 zip archive、上传 archive 下 `--build=always` 失败不提交 service，以及 `--source-mode remote` 保留 daemon-side 本地路径语义。
    - 验证：
      - `go test ./internal/integration -run 'TestCLI(AdminGatewayAndStoreIntegrationCRUD|RecursiveServiceImportListsServices|ServiceImportUploadArchiveAndRemoteModeIntegration)$' -count=1` 通过。
      - `go test ./internal/integration` 通过。
    - 审计与例外：
      - integration 使用真实 `admin.Server`、`packageimport.Importer`、SQLite store、`httptest` Admin server 和 `cli.CLI`，未依赖固定端口、用户 home 或外部网络。
      - E2E 真实 binary/daemon/CLI 覆盖仍未执行，按计划留给 4.2。
    - 下一目标：4.2 e2e 覆盖。

- [x] 4.2 增加真实 binary E2E 覆盖
  - 依赖：4.1。
  - 工作内容：在 `tests/e2e` 增加真实 daemon + CLI 场景，使用 loopback daemon 地址但不同工作目录，验证默认 `auto` 上传本地 fixture 并导入成功。
  - 可并行子任务：
    - [x] 可并行：复用 `tests/e2e/harness_test.go` fixture 和 CLI helper 设计测试。
    - [x] 可并行：补充持久化断言，确认 service row `package_source` 不含客户端绝对路径。
    - [x] 可并行：运行 e2e focused case 或完整 `go test ./tests/e2e -count=1`。
  - 测试方案：`go test ./tests/e2e -count=1`。
  - 验收标准：真实 binary/daemon/CLI 流程通过；测试不依赖固定端口、用户 home、外部网络或 npm registry。
  - 完成总结：
    - 状态：已完成。
    - 变更：
      - 在 `tests/e2e/harness_test.go` 增加 `runCLIInDir` 和 `mustCLIInDir`，允许黑盒 CLI 场景指定客户端工作目录。
      - 新增 `tests/e2e/service_import_upload_test.go`，使用真实 binary 启动 daemon，并在客户端 fixture 目录中执行 `octobus service import echo --offline .`。
      - 测试断言 service row 的 `package_source` 为 `client-upload:<fixture-basename>`，且不包含客户端 fixture 绝对路径或客户端根目录；同时确认 package 和 descriptor hash 已持久化。
    - 验证：
      - `go test ./tests/e2e -run TestServiceImportAutoUploadsClientLocalDirectory -count=1` 通过。
      - `go test ./tests/e2e -count=1` 通过。
    - 审计与例外：
      - 新增测试复用真实 e2e harness，不依赖固定端口、用户 home、外部网络或 npm registry；仅通过 SQLite 读做持久化断言。
      - daemon 和 CLI 在同一测试主机上运行，无法物理隔离文件系统；测试通过 `SOURCE="."` 和不同 CLI 工作目录证明默认 `auto` 选择上传路径，并以 `client-upload:` 持久化作为黑盒证据。
    - 下一目标：4.3 文档更新。

- [ ] 4.3 更新用户文档和设计文档
  - 依赖：4.1。
  - 工作内容：更新 `README.md`、`docs/design/product/cli.md`、`docs/design/technical/service-package.md`，说明默认 `auto` 上传客户端本地 source、`--source-mode remote`、`--source-mode upload`、localhost/Docker/port-forward 文件系统边界。
  - 可并行子任务：
    - [ ] 可并行：更新 README 用户工作流和 additional notes。
    - [ ] 可并行：更新 CLI 产品设计中命令形态和 source mode。
    - [ ] 可并行：更新 service package 技术设计中 source 获取和 artifact 规则。
  - 测试方案：文档审阅；如文档引用命令示例，配合 4.1/4.2 测试结果校验示例可行。
  - 验收标准：文档描述与实现一致；没有把 `127.0.0.1` 描述为共享文件系统依据；未引入未实现能力。
  - 完成总结：
    - 状态：待完成。
    - 变更：待完成。
    - 验证：待完成。
    - 审计与例外：待完成。
    - 下一目标：4.4 全量质量门禁。

- [ ] 4.4 全量质量门禁和收口审计
  - 依赖：4.2、4.3。
  - 工作内容：运行 focused tests 和 harness gates，审计 spec/plan/progress 与实现一致性，记录无法运行的门禁和残余风险。
  - 可并行子任务：
    - [ ] 可并行：运行 `go test ./internal/cli ./internal/admin ./internal/packageimport ./internal/integration`。
    - [ ] 可并行：运行 `go test ./tests/e2e -count=1`。
    - [ ] 可并行：运行 `task lint`。
    - [ ] 可并行：运行 `task test`。
    - [ ] 可并行：运行 `task build`。
  - 测试方案：上述 focused tests 和 harness gates；若环境缺少 Node.js/npm/protoc，记录失败原因和已运行替代测试。
  - 验收标准：全部可运行门禁通过；无法运行项有明确环境原因；spec、plan、progress、README 和设计文档一致。
  - 完成总结：
    - 状态：待完成。
    - 变更：待完成。
    - 验证：待完成。
    - 审计与例外：待完成。
    - 下一目标：无。

## 首版不做事项

- 不实现通用文件上传管理 API。
- 不支持从 stdin 上传 service package。
- 不新增服务端上传大小限制、配额、断点续传或上传进度事件。
- 不改变 service package contract、runtime sandbox、安全信任模型或 SQLite schema。
- 不引入 SSH/SCP/rsync 或 daemon 反向访问 CLI 机器。
- 不改变 config/secret/token 文件输入语义。
- 不迁移现有 JSON Admin API 客户端到 multipart。

## 完成总结要求

每个任务完成后将占位内容替换为以下结构：

- 状态：一句话说明完成状态。
- 变更：列出文件、模块、行为变化和关键决策。
- 验证：列出实际运行的命令、结果和关键产物。
- 审计与例外：列出已审阅但未修改的命中、保留兼容面、无法运行的门禁、残余风险和原因；没有则写“无”。
- 下一目标：写下一个父任务或明确“无”。
