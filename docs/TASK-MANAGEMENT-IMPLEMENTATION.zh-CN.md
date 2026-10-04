# 任务互联实施交接

基线为私有仓库 `ece68974a5c1632bc2c3f7427fe8743ce8aa6fe8` 的源码导出。本补丁不包含原仓库 Git 历史，不自动 push、迁移 Hermes 或替换任何生产数据库。实施以 `DATA-MODEL-REVIEW.zh-CN.md` 中已批准目标为准。

## Candidate 2 的精确补充

- 修复优先级表单将未填写 goal 变为空串而误改意图的问题；运行中与已完成 Task 的优先级编辑不会改变 intentRevision/执行状态
- Task 创建/编辑校验 description 和 tags 类型及大小，拒绝会破坏持久视图的非法值
- 原生宿主在新 Agent 创建前确认 provider 未注册时，以受信、fenced 的具体 NO_ADAPTER 证据记为 blocked；无模型调用、工作负载、虚构 Report 或本地原生 session。重试、已有 session 和流内 MISSING_CREDENTIAL 等未知调用保留 uncertain 与已知安全错误码
- 原 VPS 来源中原计划 active/enabled=true 的历史事实保留；只有导出的测试计划禁用。模板 v1 明确是导出修订，JSON Schema 是适配结构；原 Python 语义校验尚未注册时，结构合法的游戏输出不能作为语义验证成功验收

## 已实现

| 对象 / 路径 | 当前行为 |
|---|---|
| Domain → Project → Backlog | 文件 SQLite 中真实关系表；Domain/Project 多对多，需求 Backlog 单属 Project；创建/编辑含并发修订和 commandId 幂等 |
| Backlog ↔ Task | 同一 Task 可推进多个需求，跨 Project 按 taskId 去重；不复制执行状态或扩大执行权限 |
| Task | goal、criteria、revision、intentRevision、targetAt；有效 priority 为显式覆盖 > 已关联 Backlog 最高档 > normal；candidate 只用 state；新 Task 不自动写旧准入/三评分 |
| Run / Attempt | 复用原租约、fence、executionId、取消、重试及回执；新增 partial 终态；新 Run 不写 outcome/validation；内部 sessionIds 由 Attempt/明确上下文关联派生 |
| 固定执行上下文 | templateRef 固定不可变模板版本与实际 input；intentSnapshot 只记本次意图；contextNotes 存不可变 Report ID；执行时由权威端解析，作为受认证 Claim 上下文传输，不存第二份正文 |
| Report | 保留不可变修订、结构化 data/schemaId 与真实 Task/Run/Attempt 来源；实际输入、输出和语义校验继续执行 |
| Artifact | 轻量材料目录支持 native/git/object 固定引用与 live URL，稳定 artifactId；项目/能力/来源/版本关系；不下载、复制、自动 hash 或声明可访问 |
| Criterion | 空条件不自动完成；Task 完成条件检查对应意图修订；人工检查只允许受信交互管理宿主显式启用；标准改动不继承旧检查结果 |
| Skill / Milestone / workspace 关系 | 有持久 API、关系约束和测试；Skill 不等于节点能力；Milestone 满足条件后仅 awaiting_review；每 Project/节点最多一个默认 workspace；不创建目录或授权 |
| WebUI | `/manage.html` 管理 Domain/Project/Backlog/Task 创建、编辑、关联；查看 Run、实际 Attempt、失败、报告、材料；显示明确 DB 标识与路径；受信 manager、同源 JSON/CSRF、修订冲突保护 |

## 有意保留的边界

- Project 人工完成确认、通用个人验收/发布投影尚无新入口；Project 当前状态为 draft/active/paused/archived。Task/artifact acceptance 和 milestone completion 没有真实个人决定时显示 unknown，不以执行成功代替本人确认
- Skill、Milestone、Artifact 登记及 Criterion 检查已可用业务 API，但尚无完整专用编辑表单；现阶段 UI 管理重点是 Domain→Project→需求→任务→执行/报告
- 旧 observation 自动上报保留；historyOnly 只阻止历史 Run 再派发。旧字段仅在历史/兼容记录中保留；新管理页不显示旧 admission/outcome/validation 模型
- 原附件 finalized/大小/哈希校验仍用于原执行附件协议；新材料目录不冒充远端附件上传。远端正文传输和现有配置字节上限仍生效
- 没有自然人账号、凭据、权限扩张、决策/飞书插件整合、Sprint、Output、加权完成百分比或生产 Postgres 部署

## 数据库与迁移边界

继续使用 Node 24 的 `node:sqlite` 和文件 SQLite，WAL、完整事务与持久命令回执。执行层沿用基线的 SQLite entities/events/commands/resources 存储，管理层新增 `wb_*` 关系表、外键及唯一约束，明确会话关系用 `run_context_sessions`。不是 JSON 文件或内存 DB。数据库产品的生产选型不在本次测试中决定。

新验收通过脚本独占创建明确命名的测试 DB，MBP executor journal 与 VPS authority DB 分开。旧库不重写、不全量迁移；后续生产切换应先备份并显式批准 DB 路径/部署，不将测试路径当作默认生产配置。

## 验证与继续

执行 `npm ci`、`npm run check`。新增工作台、核心模型、HTTP 管理和原生上下文测试覆盖文件库重开、外键、并发冲突、正确失败以及原协议回归。发行测试为 `npm run test:distribution`，使用独立 DSH profile。

真实设备流程、原 VPS 源导出格式及 init/seed/serve/verify 命令见 `TASK-MANAGEMENT-ACCEPTANCE.zh-CN.md`。只有 VPS DSH 真派发、MBP DSH 真接收/尝试、权威库与 journal 对应、WebUI 绑定新库四项证据齐备后，才称设备验收完成。缺脚本、日志或真实 API 导致的失败必须保留原原因；不能用合成报告补齐。

Candidate3 的真实 VPS→MBP 闭环已由现场执行线确认：一次 dispatch 与最终 ACK，Run blocked、Attempt settled、executor journal acknowledged，原生 NO_ADAPTER 在 Agent 启动前形成系统结果；模型调用与执行结果 Report 均为 0。这验证真实传输、持久化与明确阻塞，不代表游戏日报执行成功。最新范围、证据来源及入口见 [交付说明](TASK-MANAGEMENT-DELIVERY.zh-CN.md)；VPS 8443 面板的新库绑定与可访问状态由 VPS 执行线确认。
