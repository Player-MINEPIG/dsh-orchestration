# 多项目任务系统与个人网站：概念与数据关系评审草案

本轮更新依据用户截至 2026-10-04 的讨论。当前审查的是**概念实体、关系与字段**。主图只画业务实体及基数，多对多直接画关系，不展开关联表。第 7 节提供可逐表审阅的完整字段提案；标为“新增建议/待确认”的推荐值仍需审阅，尚未成为实施 schema。

代码基线为 `ece68974a5c1632bc2c3f7427fe8743ce8aa6fe8`。产品 WIP 保留并继续暂停；本轮只更新这份原文档，没有代码合表/更名、真实数据导入、数据库迁移或部署。

## 1. 当前方向

- **领域 → Project → Backlog → Task**：领域组织项目，Project 下的每个 Backlog 表示一项由需求产生的待办事项，Task 表示为推进或满足该需求而做的具体工作。领域是展示分组概念，本轮不要求另建领域业务表。
- **成果就是实际材料及其版本**：文件、文本、网页/部署、源码、图解等沿用 Artifact 概念；本轮不要求独立 Output 作为必需表。
- **成果必须有完整背景**：保留最初产生、后续修改、目标与尝试、反馈与反思，以及后续版本和经验沉淀；不能只绑定单一最近任务。
- **网站完整页与未来精选页共用关系**：完整页面不是精选页面；未来精选只是对同一套资料的展示选择，不复制成果或截断来源链。
- **Milestone 可选并关联 Backlog**：针对选定需求待办项或指定成果的完成与验收条件，不要求项目中所有 Backlog 都完成。
- **Sprint 暂不加入（用户已确认）**：当前实体、主图、字段及物理方案均不纳入 Sprint；Milestone 继续保持可选。
- **Skill 表示个人能力展示与沉淀**：沿用个人网站模块名 skill，引用 Project、Artifact 和 Report 作为实践证据，可包含可复用方法，但不限于事后方法。与 agent 可执行 SKILL.md、执行节点 capability 区分；不虚构熟练度评级。

## 2. 概念 ER 图

~~~mermaid
erDiagram
    Domain }o--o{ Project : "展示分组"
    Project ||--o{ Backlog : "需求待办"
    Backlog }o--o{ Task : "推进需求"
    Task ||--o{ Run : "发起执行"
    Template |o--o{ Run : "固定所用模板版本"
    Run ||--o{ Attempt : "执行所有权尝试"
    Task ||--o{ Report : "记录经历"
    Run |o--o{ Report : "执行来源"
    Attempt |o--o{ Report : "尝试来源"
    Task }o--o{ Artifact : "产生或修改材料"
    Report }o--o{ Artifact : "材料过程与反思证据"
    Project }o--o{ Artifact : "项目成果背景"
    Artifact }o--o{ Artifact : "版本承接与来源链"
    Project }o--o{ Skill : "能力实践证据"
    Artifact }o--o{ Skill : "成果与讲解证据"
    Report }o--o{ Skill : "经历与反思证据"
    Project ||--o{ Milestone : "可选检查点"
    Backlog }o--o{ Milestone : "检查范围"
    Task }o--o{ Milestone : "选定事项"
    Artifact }o--o{ Milestone : "指定成果条件"
    Milestone }o--o{ Milestone : "完成条件或前置依赖"
~~~

图例：一个端为 ||，零或一个为 |o，零或多个为 o{ / }o；两端均“零或多个”表示多对多。主图画的是业务含义与允许的关联，不画 BacklogTask 等 junction。省略关联实体不等于取消多对多，也不强制所有场景下 Task 单归属。

Domain 是展示分组，推荐允许跨领域展示；Project→Backlog 为一对多，但不强制每个 Project 初始已有 Backlog。Task、Artifact 与 Project 的多处展示和引用不复制其身份。Artifact 自关联在版本级落实，保留分支、合并和派生材料的前后关系。Report 的执行来源可为空，但填写 Run、Attempt 时必须与其 Task 一致。

Milestone 自关联为本轮待审建议：允许一个检查点要求多个检查点达成，也允许同一个检查点被多个检查点引用。每条关系有明确依赖方向，拒绝同一身份依赖自己及依赖环；主图不展开关联表。

用户已确认 Sprint 暂不加入，因此主图及当前字段方案均不纳入。Workspace 属于执行设施，Project 的绑定方案在第 7 节，不能用展示关联代替授权。

## 3. 各概念承担什么

| 概念 | 作用 | 当前边界 |
|---|---|---|
| 领域 | 在网站中组织 Project，例如不同实践领域 | 展示分组；暂不增加必需业务实体 |
| Project | 有持续目标与边界的项目背景，组织 Backlog、成果和过程展示 | 与实际 workspace 保留明确绑定；工作区权限由执行系统负责 |
| Backlog | 项目中由需求产生的一项待办事项，表达要解决什么、期望达到什么 | 用户已明确采用需求侧含义；完成依据是自身 acceptanceCriteria，不另建平行验收流程 |
| Task | 一项可持续推进的小步工作，保留目标、验收意图及多次执行历史 | 不因页面切换或执行重试复制任务身份 |
| Run | 对同一 Task 发起的一次执行过程 | 一个 Task 可有多次 Run；固定本次模板版本、输入与轻量意图快照；Session 不是 Task 身份 |
| Template | 可复用、按版本保存的输入参数、输出 schema 与实际校验规则 | 沿用已有模板设施；不同执行可复用，不是不可变 Task 定义版本 |
| Attempt | Run 内部一次执行所有权/租约尝试 | 既有协议用它维护 fencing、结算和取消回执；未获批准删除 |
| Report | 具体进展、执行结果、反馈与阶段复盘/反思的记录 | 是经历与证据；存在报告不等于提供了用户讲解 |
| Artifact | 有管理价值的实际材料目录及可确认版本，字节正文与数据库分开 | 登记交付、精选阶段成果、复用源文件和必要理解或验证证据；可靠来源优先引用，不自动收录全部中间文件或复制大文件 |
| Skill | 个人能力展示与持续沉淀，关联项目、材料、经历及反思作为证据 | 网站模块名 skill；可以包含方法，但不只事后方法，不等同 agent SKILL.md 或节点 capability；不要求每 Task 生成 |
| Milestone | 与 Backlog 关联的可选完成检查点，也可要求其他 Milestone 达成 | 多对多自关联区分完成条件与前置依赖，均无环；不要求所有需求待办项完成；条件满足与用户确认分开 |
| Workspace | 某设备上的真实执行目录与宿主授权范围 | 已有执行设施；登记/创建不由网站展示关系自动触发 |

## 4. 工作组织与执行层次

### Project、Backlog、Task

用户已明确 Backlog 倾向于需求侧，即根据需求产生的待办事项。Project→Backlog→Task 分别表达项目背景、需求待办与具体执行工作，不再将 Backlog 解释为工作容器。主图保留 Backlog 与 Task 的多对多：一项需求可由多个 Task 推进，同一个 Task 也可支持多项需求；Task 仍保留同一目标和执行历史，需求关系不能复制任务或各自改写执行状态。

常见关系是一项需求待办对应多个 Task，一个 Task 通常关联一项需求；保留少见的多对多关联。常用创建流程可默认关联一项需求待办，但不是数据库单归属限制。关系只说明 Task 推进哪项需求，实际需要的背景或参与事实在关系字段提案中审阅，物理关联后置。跨项目工作台按 taskId 去重；跨项目引用本身不扩大执行权限。Project 可有多项 Backlog，按实际需求登记；本轮不增加收纳容器或嵌套层级。

### 持续工作、模板与结构化日报（已批准）

Task 表示持续要做的工作；Template 定义复用的输入参数、输出 schema 与实际校验规则；Run 固定这一次使用的模板版本、实际输入和轻量 intentSnapshot；Report 保存这次结构化结果，供授权前端呈现。结构化日报不是把整份要求塞进一个自由 JSON 后让前端自行猜格式。

同一持续目标的小调整沿用 Task。例如日报增加趋势说明后，已创建的 Run 仍按启动时的要求与模板版本执行，新 Run 使用调整后的要求。只有目标或交付范围实质改变时才建立新 Task，并明确关联继承或后续背景；已有 parentTaskId 的执行委派含义不能自动改成通用后续关系。本轮不新增完整的不可变 Task 定义版本系统。

### Task、Run、Attempt

三者解释不同层次：Task 是持续工作目标；Run 是一次执行；Attempt 是这次执行中某节点实际取得的执行所有权。它们在现有系统中已存在，不是为了当前网站概念额外增加的三类用户任务。

Run、Attempt 的状态由 claim、执行、结算、取消与回执协议维护。内容表单不得任意写 running/completed 或恢复旧租约。是否删除 Attempt 没有得到批准，本轮保留其语义。

### Milestone（可选）

Milestone 可选。例如 Project 有“提供可演示版本”“提供使用说明”“优化后续体验”三项 Backlog 需求待办，检查点可以只要求前两项满足约定标准，第三项仍保持待办。

系统判断条件已有证据，与用户确认认可，是两个不同事实；不得将自动检查结果伪装为用户同意。第 7 节给出检查和人工确认的状态字段推荐，供本轮审阅；不新增规则引擎，物理关联后置。

用户已确认 Sprint 暂不加入。当前只保留这一状态说明，不定义其字段、参与关系或物理存储；以后确有需要再另行讨论。

项目进度应说明具体检查点或成果证据，不简单按完成任务数量计算。没有可确认标准时，不虚构百分比。权重与数值公式仍是未确认候选，当前不作为必需设计。

## 5. 成果、材料、经历和能力

### 不要求独立 Output 包装

用户明确：网站 demo 是完整页面；未来精选页也不构成独立 Output。实际成果材料本身可以被展示、使用和判断，展示不能成为孤立的包装条目。

因此前版 Output 及各类 Output 前缀实现关联名称不作为当前必需表清单。项目背景、证据引用、材料用途与能力实践来源职责仍保留，通过实际材料及共享关系表达。仅有“展示页面”或“用于精选”不产生新业务身份。

以后若有多材料整体验收/发布的真实需要，可以再讨论组织方式；本轮不因此新增 Deliverable 或交付集合实体，也不保留一个没有实际成果的必需 Output 包装。

### 同一材料的多种用途

Artifact 登记有管理价值的材料，不将所有文件入库。稳定来源引用与文件字节存储分开；完整过程展示引用必要证据，不要求复制所有构建产物、缓存、重复截图或日志。具体目录与存储原则见 7.9。

Artifact 可承担可用产物、可编辑 source、解释材料、验证证据或主要修改入口。一份 README/源码可以同时有多种用途；网站、任务面板与精选页引用同一材料和相应版本，无需复制文件身份。

Artifact 直接关联 Project 的例子包括：没有 Task 记录的旧原型/仓库/设计稿，由多个 Task 长期维护的项目说明/架构图/设计系统，以及被多个项目复用的组件库或研究材料。此关系说明材料在项目中的背景或用途；Task、Run 关系独立记录产生和修改来源，项目展示直接选用材料仍保留已有版本、Report、Skill 关联及过程反思链，旧材料没有 Task 时不虚构执行来源。

解释材料对应真实对象与版本，并帮助用户理解**怎么用、为何这样设计、怎么改、已知限制**。正文保存在实际文本、图解、交互示例或视频里；不要求四份文件或完整文档包，也不把执行流水当作已经讲解清楚。

这沿用用户指定的本机 [project-collaboration SKILL.md](/Users/pmp/AI/Codex/Skill/project-collaboration/SKILL.md:8) 与 [delivery.md](/Users/pmp/AI/Codex/Skill/project-collaboration/references/delivery.md:5)：交付支持判断、使用、继续修改，按用途提供必要材料；[第 20 行](/Users/pmp/AI/Codex/Skill/project-collaboration/references/delivery.md:20) 不要求每次生成完整文档包。

### 完整来源、版本、过程与反思链

| 逻辑关系 | 需要保留什么 |
|---|---|
| 初始产生 | 最初目标与实际产生材料的 Task、Run、Attempt、Report；未知项不补造 |
| 修改与后续版本 | 每次修改作用于哪一版材料，前后版本怎样承接；不能覆盖成单一 latestTaskId 或最新路径 |
| 尝试与反馈 | 采取过什么方案、遇到什么问题、如何反馈和调整；可跨多次 Task、Run、Report |
| 反思与阶段复盘 | 对具体经历和成果的判断、为什么改变，以及相关证据/讲解材料 |
| 验收依据 | 该版本需要满足的目标/标准，接受或待调整的判断与反馈；执行成功不自动等于用户验收 |
| Project 展示 | 成果在什么项目背景中展示、贡献说明、摘要及关联的完整过程 |
| 能力展示与沉淀 | Skill 由哪些项目、实际材料、经历与反思支持；可含可复用理解，但不要求每项成果都形成 Skill |

这些关系是需要保留的含义，**不意味着每行都建一张物理表**。既有 Artifact.taskId/reportId 可以保留原登记来源，但不能被解释成完整来源只允许一个 Task，也不能让新修改覆盖旧历史。纯手工内容按实际来源登记，不虚构执行。

### Report 与 Skill 分工

Report 回答某次经历发生了什么、如何尝试、结果、反馈与反思是什么。Skill 说明个人能够做什么、怎样实践、有哪些可验证材料和适用边界；可以记录方法和经验，但不能缩成只在 Task 完成后自动提炼的“事后方法”。同一 Skill 可持续累积多个项目和多次经历的证据。

网站模块统一使用 skill，概念实体名为 Skill。它不指 agent 加载执行的 SKILL.md，也不代表执行节点的 capability 或权限。字段设计不预设分级、评分或自动判定熟练度；能力说明由本人确认，项目/材料/Report 提供证据。

展示摘要、Report 正文和 Skill 内容不复制同一份完整说明：摘要负责入口，报告保留具体经历，能力条目给出能力主张及实践依据；详细讲解引用同一材料。

## 6. 共享展示、Project 与 workspace 与权限边界

完整网站页是按领域和 Project 组织的完整内容视图。未来精选页是从同一资料中做展示选择；两者及任务面板共用成果身份、版本与关联，保留回到完整过程和反思的路径。

完整保存来源链不等于公开所有私有执行正文。公开网站读取明确允许公开的 Project、材料/版本及过程反思展示；私有 Report 原文/data、Run configuration、workspace 路径和凭据不直接公开。展示视图不是新的实体或一份单独成果副本。

所有修改经业务 API 校验，插件属于适配层；不建立网站直接随意写库的第二条路径。数据库产品与 Notion 同步方式仍未选择，Notion 当前是需求素材。

Project 保留与实际 Workspace 的明确绑定，候选项目记录方向但不自动创建目录。字段提案推荐同一 Project 允许绑定多设备 workspace，每设备至多一个默认绑定；绑定仍须执行服务校验，同目录共享规则未定；展示/Backlog 关系不扩大 Task.policy 的节点、工作区、工具和资源权限。WorkspaceManager 继续负责真实路径与授权 provisioning。

## 7. 字段审阅提案

本节现在提供可审字段，不再只列候选标题。**现有**指基线代码已有的协议字段；**新增建议**指本轮推荐方案，均待用户审阅。表中的关联集合表示逻辑关系，不要求把数组塞进实体行，也不宣称已经存在对应物理表。

逐表入口：[字段阅读约定](#fields-common) · [Domain](#fields-domain) · [Project](#fields-project) · [Backlog](#fields-backlog) · [Task](#fields-task) · [Run](#fields-run) · [Attempt](#fields-attempt) · [Report](#fields-report) · [Artifact](#fields-artifact) · [Skill](#fields-skill) · [Milestone](#fields-milestone) · [条件](#fields-criterion) · [Sprint 暂不加入说明](#fields-sprint) · [Workspace](#fields-workspace) · [多对多关系](#fields-relations) · [验收与公开投影](#fields-review-publication) · [历史、来源与导入](#fields-history) · [物理方案](#fields-physical)。

<a id="fields-common"></a>
### 7.1 阅读约定：类型、权威与字段适用范围

本节只解释术语和读取规则，**不定义任何“所有表继承”的基础字段集合**。独立字段各占一行；同一字段的值范围用“枚举（单选）”表示，集合可多选时明写“可多选”；真实互斥方案才写“二选一”。类型后的 ? 表示该字段可空或未提供，不表示与隔壁字段二选一。逐表列出的字段才是相应对象的待审提案；没有列出的 slug、来源、修订号、时间、状态、排序或发布字段，不因在其他对象中常见就自动加入。来源归因讨论移到 7.17，按具体用途保留。

逻辑类型：ID 为非空字符串，保留 UUID/历史 namespaced ID，不改号；Text 为字符串；Int 为整数；Bool 为布尔；Timestamp 为新数据的 RFC3339 UTC 时间；JSON 为受大小限制的结构化值。未知值不以 0、当前时间或“已通过”补造；旧时间的原值、单位和依据单独保留。

revision 是相应内容/记录的修订序号，不等于保存了历史快照。可编辑管理内容的 revision 用于并发校验；Report.revision 是既有不可变报告修订序号；Artifact 用 artifactId 区分不可变内容版本，不另加 revision。发布说明自身的修订与材料版本分开。

写入权威分为管理 API（已授权管理入口）、执行协议 API（planner 或有效 LeaseRef 的 executor）、材料 API（实际资源登记/校验）、导入 API（未来获授权后保留历史事实）。所有写入仍经业务 API，插件适配 API；管理内容并发保存使用该对象明确列出的 revision/expectedRevision，已有执行协议沿用自身校验，不强加统一 CRUD 字段。

表中“只读视图/派生”不是独立保存列：关系 API 写唯一关系事实，正反向集合由查询产生；验收、条件观察等从对应证据/决定投影。确需协议兼容或固定执行上下文的已有冗余/快照逐项说明理由，不给两份事实开放各自修改入口。

版本引用为 {type, id, revision?}：可变管理内容引用相应 revision。Task 的 intentRevision 仅标识当时要求；执行所见正文由该 Run.intentSnapshot 保存，不据此建设不可变 Task 定义版本表。Report、Artifact 的不可变版本 ID 已足够。实体 ID 是稳定关联标识；可读网址段仅在 7.16 的 publicSlug 中讨论，不作为每个实体的地址字段。

修改命令沿用 commandId 幂等；只有相应可变内容/安排字段才使用修订冲突检查。归档、撤回展示与保留历史依对象语义处理，不能给不可变事件/材料随意增加“更新”动作。

<a id="fields-domain"></a>
### 7.2 Domain：展示领域（新增建议）

Domain 表达网站组织概念；字段审阅中推荐用一个轻量持久对象承载名称、顺序及公开说明，不把领域当执行权限。是否最终独立表仍属于物理方案。

| 字段 | 类型 | 含义及关系 | 必填与推荐默认 | 权威与可改性 |
|---|---|---|---|---|
| domainId | ID | 稳定展示分组身份 | 必填，API 生成 | 管理 API 创建，immutable |
| revision | Int ≥ 1 | 领域名称/介绍/排序保存的并发修订号，不是业务进度或发布版本 | 必填，1；待审建议 | 管理 API 保存时校验 expectedRevision 并递增 |
| title | Text | 领域名称 | 必填，无默认 | 管理 API 可改 |
| summary | Text | 领域介绍 | 可选，空字符串 | 管理 API 可改 |
| state | 枚举（单选）：active、archived | 可用展示分组/归档 | 必填，active | 管理 API 可改；归档不删除 Project |
| position | Int | 领域在网站中的相对排序 | 必填，0，重复值用 ID 稳定排序 | 管理 API 可改 |
| projects | 只读Project 引用集合 | Domain 0..N ↔ Project 0..N；每处展示可有上下文 | 视图可为 []；不作为实体保存列 | 关系 API 校验并写唯一关系事实，本集合从该事实查询派生；保留上述归属/版本约束 |

<a id="fields-project"></a>
### 7.3 Project：持续项目（新增建议）

| 字段 | 类型 | 含义及关系 | 必填与推荐默认 | 权威与可改性 |
|---|---|---|---|---|
| projectId | ID | 稳定项目身份 | 必填，API 生成 | 管理 API 创建，immutable |
| revision | Int ≥ 1 | 项目内容修订，供并发保存、验收与公开内容定位 | 必填，1；待审建议 | 管理 API 维护，旧内容保留 |
| createdAt | Timestamp | 本系统中的项目登记时间，与更新信息分开 | 新项目必填，服务时间；旧原始时间未知不补造 | 创建时确定，immutable，不被后续修改覆盖 |
| updatedAt | Timestamp | 项目最近内容/管理状态变化时间，不是全部子 Task 的更新时间 | 新项目初始等于 createdAt；之后按实际修改更新 | 对应管理操作只更新这个最近值；创建时间不变 |
| publication | PublicProjection?（只读引用） | 该项目的明确公开投影，见 7.16；不复制其发布状态/网址字段 | 没有发布记录为空，不自动公开 | 从唯一公开投影读取，发布 API 维护该投影 |
| createdBy | 操作来源值?（待审） | 可选追踪项目内容的初始创建来源 | 默认不加；优先沿初始来源记录读取；旧未知不由最近修改者补造 | 初始来源固定，不被 updatedBy 覆盖；不声称识别人 |
| updatedBy | 操作来源值?（待审） | 可选记录项目最近一次内容修改来源，与创建来源分开 | 默认不加；已有可靠来源可复用；未修改/未知可空 | API 按本次实际修改来源更新最近值；不覆盖 createdBy，不要求记录中间修改序列 |
| title | Text | 项目名称 | 必填，无默认 | 管理 API 可改 |
| goal | Text | 持续目标与完成方向 | 草稿可空；进入 active 前必填 | 管理 API 可改，保留目标修订 |
| description | Text | 背景、边界和项目介绍 | 可选，空字符串 | 管理 API 可改 |
| state | 枚举（单选）：draft、active、paused、completed、archived | 项目管理状态，不等于 Task 状态聚合 | 必填，draft | 管理 API 可改；completed 由本人确认 |
| nextStep | Text? | 当前明确下一步，可引用 Task、Backlog 的上下文 | 可选，空 | 管理 API 可改；不自动发起 Run |
| acceptanceCriteria | Criterion[] | 项目完成依据，见 7.12；可采用成果/检查点证据 | 必填，[]；完成前至少有明确依据或书面确认说明 | 管理 API 可改，已作出的验收绑定对应 revision |
| acceptance | AcceptanceView（只读） | 当前项目内容版本的人工判断，见 7.16 | 无判断时投影 not_requested，不作为独立可写列 | 从对应版本的判断记录读取，不能单独改 accepted |
| startedAt | Timestamp? | 项目实际开始时间，与 createdAt 登记时间和某次 Run 的执行时间分开 | 可选，默认空；旧未知不推断 | 管理 API 按实际事实填写/纠正，不从登记或首个 Run 时间自动猜出 |
| targetAt | Timestamp? | 项目期望完成时间，是计划目标而非实际完成时间 | 可选，默认空 | 管理 API 可调整；不自动调度、完成项目或修改实际执行时间 |
| completedAt | Timestamp?（只读） | 取对应项目完成确认记录的时间，缺依据为空 | 默认空，不补造 | 从当前完成判断/事件读取，重新打开保留旧记录；不再独立编辑此时间 |
| domains | 只读Domain 引用集合 | Project 0..N ↔ Domain 0..N | 视图可为 []；不作为实体保存列 | 关系 API 校验并写唯一关系事实，本集合从该事实查询派生；保留上述归属/版本约束 |
| backlogs | 只读Backlog 引用集合 | Project 1 ↔ Backlog 0..N；每个 Backlog 归一个 Project | 视图可为 []；不作为实体保存列 | 从 Backlog.projectId 查询，不再保存一份 Project.backlogs 数组 |
| artifacts | 只读 Artifact 引用集合 | Project 0..N ↔ Artifact 0..N，项目使用或展示的材料 | 独立集合，无关系时 []；不要求 skills 非空；不是二选一 | 从项目与材料的唯一关系事实查询，不保存第二份实体数组 |
| skills | 只读 Skill 引用集合 | Project 0..N ↔ Skill 0..N，项目关联的能力证据 | 独立集合，无关系时 []；不要求 artifacts 非空；不是二选一 | 从项目与能力的唯一关系事实查询，不保存第二份实体数组 |
| workspaceBindings | 只读绑定集合 | Project 0..N ↔ Workspace 0..N；推荐每节点最多一个默认绑定 | 视图可为 []；不作为实体保存列 | 关系 API 校验并写唯一关系事实，本集合从该事实查询派生；保留上述归属/版本约束 |

artifacts 与 skills 是两个独立关系视图，两者都保留；可同时非空、分别为空或都为空，不是二选一。

项目 completed 是管理判断，不能单靠 Run succeeded、全部需求待办关闭或任务计数自动得出。修改已完成项目的目标/验收标准时，推荐显式重开，并为新内容保留待审状态，不把旧确认无条件延续。进度展示引用选定条件与证据；本轮不增加未经定义的完成百分比或权重评分。

<a id="fields-backlog"></a>
### 7.4 Backlog：需求待办项（含义、优先级与完成依据已明确）

| 字段 | 类型 | 含义及关系 | 必填与推荐默认 | 权威与可改性 |
|---|---|---|---|---|
| backlogId | ID | 稳定需求待办项身份 | 必填，API 生成 | 管理 API 创建，immutable |
| revision | Int ≥ 1 | 需求标题、目标、标准与处理状态保存的并发版本；Task 关联有自己的关系事实 | 必填，1；待审建议 | 管理 API 校验 expectedRevision；不复制 Task 执行状态 |
| projectId | ID | 每个 Backlog 归一个 Project，Project 可有多个 | 必填，无默认 | 推荐创建后 immutable；迁移需显式命令与审计 |
| title | Text | 需求待办事项的标题 | 必填，无默认 | 管理 API 可改 |
| goal | Text | 此项需求要解决的问题或期望达到的结果 | 可选，空字符串 | 管理 API 可改 |
| state | 需求处理状态（单选，完成依据已明确） | 此需求是否完成按自身当前 acceptanceCriteria 及对应 Criterion 检查事实判断，不因所有 Task 完成直接推断 | 未满足或尚无完成依据时不记完成；其他管理状态的具体字面命名在实现中收口 | 完成判断沿已有标准与检查结果；管理动作不绕过明确标准，也不增独立验收状态维度 |
| acceptanceCriteria | Criterion[] | 已明确：本需求待办项的完成依据，复用 7.12 的标准及检查事实 | 早期可 []；缺少标准不能因空集合自动记完成，实际推进时明确要达到什么 | 管理 API 维护当前需求标准；机器可判条件和人工条件沿已有 Criterion 处理，不新增验收引擎 |
| priority | 枚举（单选）：低、普通、高、紧急 | 已批准的新设计：此项需求在项目中的取舍优先级，与目标日期分开 | 必填，默认普通；没有数字评分 | 管理 API 可改；不自动执行、完成或验收需求 |
| targetAt | Timestamp? | 已批准将日期与优先级分开：此项需求期望达到的目标日期 | 可选，默认空；不是紧急档的自动推导值 | 管理 API 可调整；不自动调度或确认需求完成 |
| taskMemberships | 只读关系集合 | Backlog 0..N ↔ Task 0..N，实际推进或满足此需求的工作；字段名暂沿用，不表示容器成员 | 视图可为 []；不作为实体保存列 | 关系 API 校验并写唯一关系事实，本集合从该事实查询派生；保留上述归属/版本约束 |

此前按容器设计的 stage 建议撤回。Backlog 完成依据已确定为自身 acceptanceCriteria：能机器判断的条件读取既有类型对应的真实证据与检查结果；manual_check 等人工条件由明确检查动作提供结果，不把执行者自报成功当成人工确认。按实际列明标准判断是否满足，pending、unmet 或 unknown 不自动算完成，修改标准也不静默继承旧标准的已满足结论。这里复用 Criterion，不为 Backlog 新建 AcceptanceView 或第二套验收流程。其他管理状态的字面命名属于实现收口；“需求级验收是否采用”不再是开工阻塞。

Backlog 不保存 position，不要求数据库持久保存列表顺序。列表可通过查询或 UI 按已定义的业务字段排序；筛选决定显示哪些记录，排序决定这些记录的显示次序。只有以后明确需要保存手动拖动顺序时，再讨论列表顺序字段；本轮不新增替代表。Backlog.priority 已明确使用业务枚举，列表可以据此排序；实际日期独立，不靠紧急档隐式生成日期。

<a id="fields-task"></a>
### 7.5 Task：目标与实际工作身份

| 字段 | 类型 | 含义及关系 | 必填与默认 | 权威与可改性 |
|---|---|---|---|---|
| taskId | ID | 现有稳定任务身份 | 必填，现有 API 生成或合法指定 | 创建后 immutable；旧 followup Task 保留各自 ID |
| title | Text | 持续工作标题；同一目标的小调整不产生新 Task 身份 | 必填，无默认 | 新设计通过 planner API 修改当前要求，既有 Run 的启动快照不被覆盖；现有 runtime 的修改限制另保留兼容事实 |
| description | Text | 当前工作的详细要求；可随同一持续目标作小调整 | 必填，空字符串 | planner API 修改当前要求；新 Run 用新要求，执行前确认继续按实际意图与权限校验 |
| goal | Text? | 新增建议：独立表述本步目标 | 可选，空；旧数据不由 title 猜出 | 管理入口中的 planner API 可改，递增 intentRevision |
| acceptanceCriteria | Criterion[] | 新增建议：本步验收意图，不是执行权限确认 | 必填，[]；开始新工作时建议明确 | 管理入口中的 planner API 可改，旧验收仍绑定旧意图版本 |
| revision | Int | 当前任务内容与安排元数据的并发修订计数，不表示完整 Task 定义版本历史 | 新记录必填，1；旧首次登记版本不冒充原历史 | 管理 API 保存带 expectedRevision；本轮不因此保存每次修改的不可变 Task 定义；执行状态与 confirmation 沿用既有校验 |
| intentRevision | Int | 当前 title、description、goal、criteria 的轻量要求修订标识，不建立独立定义版本实体 | 新记录从 1 开始；旧未知不补造历史修订 | 意图变化时递增；仅在创建 Run 时将该次实际要求写入 intentSnapshot，不为每次编辑建设完整版本系统 |
| state | TaskState（单选，目标补充 candidate） | 目标值：candidate、inbox、ready、running、waiting、completed、failed、cancelled、archived；candidate 按需表达尚待明确纳入工作的候选，其余为既有状态 | 新 ad_hoc 默认 ready；需确认或 observed 默认 waiting；不把所有观察/导入记录默认改为 candidate | 执行状态仍由协议投影，管理变化走明确业务命令；candidate 的具体入口以后实现时说明，不增加独立 admission 状态维度 |
| kind | 枚举（单选）：ad_hoc、scheduled、observed | 现有来源/执行类别 | 必填，ad_hoc；历史导入 observed | 创建确定；observed 不直接成为可分发工作 |
| parentTaskId | ID? | 现有每 Task 0..1 父 Task；父 Task 0..N 子项 | 可选，空 | 创建时校验无环/预算，immutable；历史树不按新默认深度截断 |
| parentRunId | ID? | 现有产生委派的 0..1 Run | 可选，空 | 执行协议创建/校验，不能跨错父任务 |
| workspaceId | ID? | 现有执行工作区提示/绑定，0..1 | 可选，空 | planner 在授权范围设置；最终 route 与 policy 仍必须一致 |
| tags | Text[] | 现有人工/来源标记 | 必填，[] | planner API 可改；历史 ID 不靠可变 tag 作为唯一身份 |
| policy | TaskPolicy? | 现有节点/工作区/工具/资源及预算限制，见下表 | 可选，空表示仍受宿主权限和上级约束，非无限权限 | 授权 planner 经策略校验；展示关系不得扩权 |
| priority | 枚举（单选）：低、普通、高、紧急 | Task 实际呈现和使用的有效业务优先级：显式覆盖优先，否则继承当前关联 Backlog 的最高档 | 无关联且无显式覆盖时普通；有多个关联时按 low < normal < high < urgent 取最高档 | planner 经业务 API 管理显式覆盖；未覆盖时按关系及 Backlog.priority 派生有效值，具体存储表达是实现事项 |
| targetAt | Timestamp? | 已批准将目标日期与优先级分开：此 Task 期望达到的目标日期 | 可选，默认空；不由 priority 自动推导 | planner 经业务 API 调整；不等同 Run 的调度时间 |
| confirmation | ExecutionConfirmation | 现有执行前权限/意图确认，见下表 | 新建按宿主/父任务/请求决定 required，revision=1 | 授权确认 API；内容/执行上下文变化可使它失效 |
| acceptance | AcceptanceView（只读） | 新增建议：当前 intentRevision 的人工验收 | 无判断时投影 not_requested，不作为独立可写列 | 判断 API 写具体记录；读时投影，Task.state 不自动产生 accepted |
| createdAt | Timestamp | 现有 Task 创建记录时间 | 必填，API 服务时间；导入原值另存 | 创建后 immutable |
| updatedAt | Timestamp | 现有 Task 最近记录变化时间，与创建时间分开 | 初始等于 createdAt，实际变化时更新 | Task API 与既有协议维护；不是完整变化历史 |
| source | JSON? | 现有 observedAt、importedAt、originalCreatedAt、label；补充源身份、时间证据 | 可选，空；导入必须带来源限定 | 导入事实 immutable；不把 importedAt 当原始产生时间 |
| backlogMemberships | 只读关系集合 | 新增建议：Task 0..N ↔ Backlog 0..N | 视图可为 []；不作为实体保存列 | 关系 API 校验并写唯一关系事实，本集合从该事实查询派生；保留上述归属/版本约束 |

Task.state=completed 是现有执行投影，**不表示人工验收 accepted**。初始目标缺失的旧 Task 保持未知；不为了分类、展示或调整需求关联创建新 Task 身份。

**已批准目标与现有实现分开**：新设计移除长期保存的 userImmediacy、importance、urgency 三评分，改用上述 priority 枚举，默认普通。“立即执行”属于本次指令，不作为长期用户即时关注评分保存；现有执行前权限与确认检查仍保留。基线代码目前仍保存三个 0..100 分数，创建时继承父 Task，缺父值默认 50、50、40；pendingRuns 仍先按 userImmediacy、再按 urgency、最后按创建时间排序，importance 未参与这段排序。本轮只更新设计，不声称代码已替换。

**已批准的 Task 优先级继承规则**：档位顺序为低（low）< 普通（normal）< 高（high）< 紧急（urgent）。若 Task 有手动显式覆盖，effectivePriority 使用覆盖值；否则，当前关联一个或多个 Backlog 时，effectivePriority 取其中最高的 priority；没有关联且没有覆盖时为普通。effectivePriority 只是此规则所得的有效值说明，不要求新增第二个可写字段，不作加权合成，也不隐式指定主需求。

常见情况是一项 Backlog 需求对应多个 Task，而一个 Task 通常只关联一项需求；仍保留少见的多对多关联，不强制数据库单归属。覆盖可高于或低于继承值；有覆盖时不因其他需求优先级变化而失去该显式选择，未覆盖时读取当前关联的最高档。冲突业务规则已经确定，跟随及覆盖的具体持久表达留给实现，不再列为开工阻塞。

**旧评分兼容留到迁移时**：旧三个分数仅作为历史兼容与迁移输入，未来可计算加权平均再映射到对应 priority 档位。权重、档位阈值、缺失值与边界处理届时具体确定；本轮不写公式、不计算映射，不修改旧数据，也不把当前排队算法描述成已批准的新优先级规则。

**已批准删除目标 admission 字段**：新 Task 设计不保留 admissionState、admissionRevision。确有候选需要时用 state=candidate 表达；日常列表的显示与隐藏由视图筛选处理，正式归档使用已有 archived，不新增独立候选对象或另一组准入状态。

**旧 admission 兼容事实**：当前代码仍有 admitted/dismissed 与独立修订校验；它过滤日常查询、决策候选列表，并抑制自动报告与生命周期通知，但不阻止已存在 Run 的 claim、结算或继续保留报告。真正的观察候选 capture/admit 是另一个现有流程，不能把 Task.admissionState 描述为该流程的准入字段。本轮不修改旧 runtime；未来映射必须结合 Task 执行状态及原值实际用途，不把所有 dismissed 机械映射为 candidate 或 archived，也不因隐藏动作自动取消执行或抹去历史。

| 子结构字段 | 类型 | 含义 | 必填与默认 | 写入权威与约束 |
|---|---|---|---|---|
| policy.allowedNodeIds | ID[]? | 允许执行节点集合，每项引用一个节点 | 可选，默认未设置；与其它 policy 字段可同时设置 | 执行服务校验，仍受父级及宿主权限限制；未设置不等于空数组 |
| policy.allowedWorkspaceIds | ID[]? | 允许工作区集合，每项引用一个 Workspace | 可选，默认未设置 | 执行服务校验，不由项目展示关系扩权 |
| policy.allowedTools | Text[]? | 允许工具集合 | 可选，默认未设置 | 沿用现有工具与宿主权限校验，不把空集合当未配置 |
| policy.requiredResources | Text[]? | 所需资源集合 | 可选，默认未设置 | 沿用现有资源声明与占用协议 |
| policy.maxRuntimeMs | Int? | 执行时长上限，单位毫秒 | 可选，默认未设置，沿现有字段范围与宿主默认 | 授权 planner 设置，执行协议校验 |
| policy.maxDepth | Int? | 委派深度限制 | 可选，默认未设置，沿现有校验 | 执行时检查；历史深度不按新默认截断 |
| policy.maxChildren | Int? | 子任务数量预算 | 可选，默认未设置，执行沿既有预算逻辑 | planner 授权设置，委派时校验 |
| policy.maxDescendants | Int? | 后代任务数量预算 | 可选，默认未设置，执行沿既有预算逻辑 | planner 授权设置，委派时校验 |
| policy.settlementQuietMs | Int? | 后代结算后的安静窗口，单位毫秒 | 可选；现有未设置时结算默认 1000ms | 执行协议校验，不是重试次数 |
| policy.maxSafeRetries | Int? | 安全重试次数上限 | 可选，默认未设置，仍受宿主 retryPolicy 限制 | 剩余次数不替代合格安全证据 |
| confirmation.required | Bool | 现有本次执行是否需要确认 | confirmation 存在时必填；由宿主、父级或明确请求决定 | 可信确认入口维护 |
| confirmation.state | 枚举（单选）：not_required、pending、approved、rejected | 现有执行确认状态，不是成果验收 | 必填，按 required 初始化 | 明确确认或失效操作维护 |
| confirmation.revision | Int ≥ 1 | 确认内容的修订号 | 必填，新建 1 | 批准针对该修订，API 维护 |
| confirmation.actor | Text? | 现有受信入口记录的渠道 actor 字符串，不是人员目录 ID | 未决定可空；旧未知不补造 | 保留原证明范围，模型不能自称用户批准 |
| confirmation.reason | Text? | 现有确认或拒绝的说明 | 未决定可空；决定操作按已有协议提供 | 可信确认入口写入 |
| confirmation.decidedAt | Timestamp? | 现有确认动作时间 | 未决定为空，发生决定后由 API 记录 | 与 actor、reason 分开，不能由用户名猜时间 |
| source.observedAt | Timestamp | 现有来源被观察到的时间 | source 存在时必填，按真实观察记录 | 来源适配写入，不等于任务创建时间 |
| source.importedAt | Timestamp | 现有登记导入时间 | source 存在时必填，实际导入时记录 | 导入 API 写入，不冒充原始时间 |
| source.originalCreatedAt | Text? | 现有源任务创建时间原值 | 可选，未知为空，不猜单位或时区 | 保留来源事实，归一化依据见 7.17 |
| source.label | Text | 现有来源说明 | source 存在时必填，无默认猜值 | 来源适配或导入 API 写入 |

<a id="fields-run"></a>
### 7.6 Run：一次执行

| 字段 | 类型 | 含义及关系 | 必填与默认 | 权威与可改性 |
|---|---|---|---|---|
| runId | ID | 现有一次执行身份 | 必填，API 生成/合法指定 | immutable |
| taskId | ID | 现有 Run 归一个 Task；Task 0..N Run | 必填，无默认 | 创建后 immutable |
| parentRunId | ID? | 现有执行委派来源，0..1；父 Run 可有多个子 Run | 可选，空 | 执行 API 校验预算/父任务后确定 |
| state | RunState（目标，单选） | 已批准目标值：queued、running、blocked、succeeded、partial、failed、cancelled、uncertain；partial 表示本次执行仅部分达成，独立于人工复核或验收 | 新建 queued；不再另存 Run.outcome | 仅执行、取消、结算或对账协议更新；succeeded、partial 均不等于用户验收 accepted |
| reviewStatus | 枚举（单选、可空）：pending_user、accepted、rejected | 现有 partial 结果的用户复核标志 | partial 结算设 pending_user；其余可为空 | 现有 reviewRun；不扩解为所有成果已验收 |
| route | ExecutionRoute? | 本 Run 的分配配置：节点、提供方、模型、推理配置、工作区及能力要求，见下表；实际所有权证据在 Attempt | 可选；开始执行前需有效路由 | planner 选择、执行服务校验；同一 Run 的重试不更换 node，运行中不任意改路由 |
| configuration | RunConfiguration，可为 null | 已批准结构：固定 templateRef、实际 input 及确有需要的执行设置，见下文；不作为任意重复任务定义的大 JSON | 无配置普通执行可为 null；使用模板时引用及实际输入必填 | 创建 Run 时固化；引用固定版本，后续要求只影响新 Run；私有，不直接公开 |
| intentSnapshot | TaskIntentSnapshot? | 已批准：本次启动所见的 title、description、goal、acceptanceCriteria 与 intentRevision，见下文 | 新 Run 保存轻量快照；旧记录原本未保存时可空，不回填最新 Task 冒充历史 | 创建 Run 时固定；不复制模板规则、实际输入、完整 Task 或权限；仍校验当前有效 policy |
| currentAttemptId | ID? | 现有当前取得所有权的 Attempt，0..1 | 初始空 | claim/执行协议更新，不由表单替换 |
| sessionIds | 只读内部 sessionId 集合（派生） | 本 Run 各 Attempt 的会话，以及明确继承的上下文会话关联；不等于设备 ID，不重复设备或 profile | 无关联时 []；按内部 ID 去重，未知外部编号不填入该集合 | 从 Attempt.sessionId 与明确上下文关联查询；不是第二写入权威，不直接追加或编辑此数组 |
| occurrenceId | ID?（只读派生） | 本 Run 对应的调度触发 occurrence，0..1；实际触发、跳过与关联执行事实继续保留 | 无实际调度触发为空，普通 Run 不补造 | 从既有 occurrence 事实及其 Run 关联查询，不是第二可写关联字段 |
| cancellationRequested | Bool? | 已提出取消请求；与执行已确认停止是两个事实 | 新建视为 false | 取消 API 设置；只有实际停止回执或结算依据才更新执行状态，不能仅凭请求写已停止 |
| historyOnly | Bool?（目标改名） | 仅作历史记录：可查阅，但此 Run 不可重新派发；与 succeeded、partial、failed 等执行状态正交 | 新实际执行 false；仅历史记录 true，未知不补造 | 来源适配与执行 API 按事实确定；历史 true 不改成 false 来复活旧执行，旧兼容名见下文 |
| contextNotes | ID[]（不可变 Report 版本引用，目标） | 为本 Run 明确选定的附加上下文报告；只保存版本 ID，不复制 body 或 actor | 无上下文时 []；沿用最多 128 条约束 | 排队进入 queued 时选定并固定，执行按该 Report 版本读取；不随后续新报告自动改变 |
| executionStartedAt | Timestamp? | 现有首次实际执行开始时间 | 初始空 | 执行协议首次写入，immutable |
| retryPolicy | RetryPolicy? | 现有本次安全重试上限与延迟规则 | 有宿主安全重试配置才固化，否则空 | 排队时快照，受 Task 更紧限制约束 |
| retry | RetryState? | 现有安全重试计数、notBefore 和证据引用 | 初始空 | 执行协议更新，不能任意重置 |
| createdAt | Timestamp | 现有 Run 创建时间 | 必填，服务时间 | 创建后 immutable |
| updatedAt | Timestamp | 现有 Run 最近协议记录变化时间，与创建时间分开 | 初始等于 createdAt，实际变化时更新 | 执行 API 更新；本值不代替 Run 的实际执行证据 |

**Template 与固定执行配置（已批准，沿用已有设施）**

Template 已有 templateId 与 version，既有版本不可覆盖。输出 schema 沿用 resultContract；不另存一份同义 outputSchema。它可以约束结构化 report.data 的字段；基线校验的是整份结果提交包装，而不是默认每个 JSON 都有相同结构。

| Template 字段 | 类型 | 含义 | 必填与默认 | 约束 |
|---|---|---|---|---|
| templateId | ID | 可复用模板身份 | 必填，无默认 | 沿用已登记模板 ID |
| version | Int ≥ 1 | 本模板的固定版本 | 必填，无隐式 latest | 修改规则创建新版本，不覆盖旧版本 |
| name | Text | 模板名称 | 必填，无默认 | 版本内容 |
| description | Text | 用途及参数说明 | 字段存在，可为空字符串 | 版本内容，不复制完整 Task 要求 |
| inputSchema | JSON Schema | 输入参数类型、必需项与允许范围 | 必填，按模板实际定义 | 创建 Run 时校验本次实际输入 |
| defaults | JSON | 已定义的输入默认值 | 沿模板现有记录；没有业务默认时不补造 | 实际使用后的完整输入在 Run 固定，不靠以后模板的默认重建 |
| resultContract | JSON Schema | 固定的结果输出结构，含结构化 report.data 的实际规则 | 必填，沿实际模板配置 | 只承诺真实配置的规则；空契约不等于严格验证了报告正文 |
| resultValidator | Text? | 可选的已登记语义校验器标识 | 可空，无默认 | 与模板版本固定；沿用受信宿主登记，不执行任意 JSON 内脚本 |

| RunConfiguration 字段 | 类型 | 含义 | 必填与默认 | 固定与兼容 |
|---|---|---|---|---|
| templateRef | {templateId, version}? | 本次使用的精确模板版本 | 使用模板时必填；不使用可空 | 固定版本可查，不用执行时 latest |
| input | JSON | 本次实际采用的参数，结构由该模板 inputSchema 定义 | 使用模板时必填，按实际值保存 | 不复制任务要求、模板 schema 或输出结果 |
| reporting | Text? | 既有按需报告设置 | 未设置时沿宿主既有行为，不新造默认 | 与模板、任务要求各有含义，私有 |
| notifyUserOnTerminal | Bool? | 既有执行结束通知设置 | 可空，沿宿主既有语义 | 不充当人工验收 |
| trigger | JSON? | 既有调度触发时间等实际元数据 | 只有调度等实际需要时保存 | 不复制 Schedule 全文，不新增任意配置袋 |

configuration 仅保存上述有具体用途的值；route、retryPolicy、contextNotes 与 intentSnapshot 各沿自己的字段保存，不再向 configuration 重复塞完整 Task、模板规则或报告。基线目前使用 configuration.template 内嵌完整 Template 快照及 configuration.input；旧快照继续保留，不删掉后改读当前模板。新设计用固定 templateRef 复用可可靠取得的不可变模板版本；只有兼容旧记录确需时读取其原 template 快照，不强制新 Run 同时保存两份规则。现有代码尚未完成这一结构调整。

| TaskIntentSnapshot 字段 | 类型 | 含义 | 必填与默认 | 约束 |
|---|---|---|---|---|
| title | Text | 本次启动所见标题 | 新 Run 保存实际值 | 固定，不随当前 Task 改写 |
| description | Text | 本次启动所见要求说明 | 新 Run 保存实际值，可为空字符串 | 不复制执行配置 |
| goal | Text? | 本次明确目标 | 未明确时可空，不从标题猜出 | 固定实际可得内容 |
| acceptanceCriteria | Criterion[] | 本次启动所见的验收意图 | 没有具体标准时 []，不补造 | 保存轻量标准，不另复制检查结果或材料正文 |
| intentRevision | Int? | 若当前要求有修订标识则固定该值 | 实际可得时保存；旧未知可空 | 计数不代表已有完整任务定义历史 |

现有 runtime 的 Task 内容修改还限制运行中或 uncertain 情形；本轮明确的是新设计中的 Task 身份与 Run 启动要求边界，不声称旧 API 已支持这些调整。更改当前 Task 不覆盖已创建 Run 的配置或 intentSnapshot；新执行仍受当前有效权限、确认、取消与未解决副作用约束。

| 子结构字段 | 类型 | 含义及基数 | 必填与默认 | 写入约束 |
|---|---|---|---|---|
| route.nodeId | ID | 本 Run 分配的一个节点；实际持有者由 Attempt.nodeId 记录 | route 存在时必填，无默认 | planner 选择、执行服务验证权限；claim 必须与本节点一致 |
| route.provider | Text | 模型提供方 | route 存在时必填，无默认；与 model 同时存在 | 执行服务验证节点支持 |
| route.model | Text | 模型名称 | route 存在时必填，无默认；不是 provider 的替代项 | 执行服务验证提供方与模型组合 |
| route.reasoningEffort | Text? | 已有模型推理配置 | 可选，默认未设置 | 只用节点支持的配置 |
| route.workspaceId | ID? | 本次实际路由的 0..1 工作区 | 可选，默认空；执行按既有路由条件校验 | 不替代 Task.policy 与宿主授权 |
| route.requiredCapabilities | Text[] | 本次需要的能力集合 | route 存在时必填，可为 [] | 校验真实节点能力，不是个人 Skill |
| retryPolicy.maxRetries | Int | 固定本次安全重试上限 | retryPolicy 存在时必填，沿宿主配置，不新增默认次数 | 仍受 Task 更紧限制约束 |
| retryPolicy.baseDelayMs | Int | 基础重试延迟，毫秒 | retryPolicy 存在时必填，沿已有配置 | 执行协议使用 |
| retryPolicy.maxDelayMs | Int | 最大重试延迟，毫秒 | retryPolicy 存在时必填，沿已有配置 | 执行协议使用，与 baseDelayMs 并存 |
| retryPolicy.resumableTools | Text[]? | 已配置可安全恢复的工具集合 | 可选，默认未设置 | 不因名单存在而免除安全证据 |
| retry.count | Int | 本次已记录的安全重试计数 | retry 存在时必填，由协议维护 | 不任意重置 |
| retry.notBefore | Timestamp | 下一次重试不得早于此时间 | retry 存在时必填 | 由可信重试协议确定 |
| retry.sessionId | ID（目标） | 本次重试关联的内部会话 ID；与 Attempt 使用同一内部身份语义 | retry 存在时必填，有可靠对应关系才填写 | 不替代 previousAttemptId；现有安全证据的原协议值保留，由来源 adapter 可靠关联，不凭映射猜测改写证据 |
| retry.previousAttemptId | ID | 前一个 Attempt 的引用，恰为一个 | retry 存在时必填 | 由安全证据绑定 |
| retry.reasonCode | Text | 重试原因代码 | retry 存在时必填，沿已有协议代码 | 不把普通失败都当安全重试 |
| retry.completedTools | ToolFingerprint[]? | 可信证据中已完成工具的指纹集合 | 可选，按实际 witness 提供 | 防止重复副作用，不保存原敏感参数 |
| ToolFingerprint.name | Text | 工具名称 | 每条指纹必填 | 可信生命周期生成 |
| ToolFingerprint.argumentsDigest | SHA256 Text | 工具名及经验证参数的 canonical 摘要 | 每条指纹必填 | 不是原始参数公开副本 |

**已批准的内部会话引用与 adapter 边界**：核心 Task、Run、Attempt 使用同一内部 sessionId 身份语义；它标识 Agent 对话或执行会话，不是设备 ID。Task 沿其 Run 查询会话关系，不另存一份可编辑会话数组；Attempt.sessionId 记录实际会话，Run.sessionIds 仅从这些记录及明确继承的上下文关联派生。不会自动把父任务或父 Run 的全部会话都认作本次上下文，也不开放第二份 Run 会话写入权威。

核心不再定义 SessionRef 实体或字段组。Codex、DSH、Hermes 等外部来源由 adapter 维护稳定来源实例及外部 ID 到内部 ID 的映射、同步去重与返回原会话的定位，具体存储归适配层，见 7.17；本节不硬定映射表或新增 Session 产品表、设备体系。设备与执行环境沿现有节点关系查询，不在 Run 复制 profile、设备详情或外部身份字段。

route 保留 node、provider、model、reasoningEffort、workspace 与 requiredCapabilities 的分配配置；Attempt 保留实际 nodeId、sessionId、fence、租约与 executionId 等所有权证据。当前同一 Run 的重试不能换 node，claim 必须匹配 route.nodeId；改变分配需要新的明确授权执行，未解决副作用仍须先对账。本轮不加入同一 Run 跨节点重试需求。

基线现有 Run.sessionIds 仍是会追加写入的原字符串集合；将其改为派生视图属于已批准目标，尚未改 runtime。旧字符串及安全证据原值继续保留，不据此声称已完成统一 ID、映射或迁移。

intentSnapshot 固定本次启动要求；contextNotes 在 queued 时固定不可变 Report 版本引用，读取该报告的原内容与实际来源，不复制 body、actor，也不改读最新报告。两者保留本次所见上下文，不能因当前 Task 或后来报告更新而静默改变。

**已批准的历史、取消、调度与上下文边界**：historyOnly 中文为“仅作历史记录”，避免与原 observation 自动上报系统混用名字；它不表示执行成功失败、候选纳入或采集状态。此改名只针对目标 Run 字段，不删除自动发现、观察上报或其他含 observation 的既有功能。自动发现及自动纳入若以后采用可选、默认关闭方案，仍属于未实施的配置讨论，不能据此删除现功能。

提出取消请求与确认执行已停继续分开；actual occurrence 的触发时间、跳过、去重及 Run 关联事实继续保留，Run.occurrenceId 只是反向读取视图。contextNotes 固定选中的 Report 版本，来源沿该报告及已有真实来源记录读取，不新增审计体系。

**旧字段兼容事实**：基线代码仍叫 observationOnly，目标仅改名为 historyOnly，不改旧字段或真实记录。基线 Run.occurrenceId 仍存储写入，contextNotes 仍有 reportId、body、actor 的快照；目标改为派生 occurrence 引用及固定 Report 版本引用尚未落地。旧快照与来源证据保留，不直接删去后假称已能由现有报告完整还原。本轮仅改文档，不迁移或重写 runtime。

**已批准删除 Run.validation**：目标 Run 不保留 validation，不新增 submitStatus 等同义替身，也不另建校验状态表。Template 的 inputSchema、resultContract 与按需 resultValidator 继续执行实际输入和输出规则；不符合已配置规则的提交按原业务校验拒绝。是否通过格式或语义规则不等于人工验收，也不能因删除状态字段而取消校验。

**旧 validation 兼容事实**：基线仍记录 valid、not-submitted；普通结算写 valid，unknown 且未提交报告时可写 not-submitted。valid 只能说明当次提交通过了真正配置并执行的检查，不能宣称一定有严格报告 schema、业务目标已满足或用户已接受。旧值作为历史兼容保留，本轮不转换数据或改 runtime。

**已批准合并 Run 状态与结果**：目标 Run 只保留 state，增加 partial，删除 Run.outcome。部分达成用 state=partial 表达，不再保存 state=succeeded 与 outcome=partial 的两字段组合。人工复核与业务验收仍是独立事实；succeeded 或 partial 本身都不能显示成“用户验收完成”。uncertain 需要对账，不能直接创建重试执行绕过未解决副作用。

**现有代码与旧数据兼容事实**：基线仍有 Run.outcome；submit 的旧正常结算映射如下。此表说明已有映射及目标表达，不代表已执行字段删除或数据转换。

| 旧提交 outcome | 旧 submit 写入的 Run.state | 对应目标 state（普通结算场景） |
|---|---|---|
| success | succeeded | succeeded |
| partial | succeeded，同时 reviewStatus=pending_user | partial；复核仍独立 |
| failure | failed | failed |
| blocked | blocked | blocked |
| unknown | uncertain | uncertain；已对账情况见下文 |

旧 resolveUncertain 可将 state 从 uncertain 改成 failed 或 cancelled，却仍保留 outcome=unknown。因此迁移必须读取实际 Run.state 及对账事实，不能凭旧 outcome=unknown 把已经 failed/cancelled 的执行重新改成 uncertain，也不能用 outcome 覆盖已对账状态。本轮只修改文档，不改 runtime、旧数据或结算协议。删除范围仅为目标 Run.outcome，不机械删除 Task、Report 或其他结构中含义不同的同名字段及历史结果证据。

<a id="fields-attempt"></a>
### 7.7 Attempt：实际执行所有权

| 字段 | 类型 | 含义及关系 | 必填与默认 | 权威与可改性 |
|---|---|---|---|---|
| attemptId | ID | 现有一次租约尝试身份 | 必填，claim 时生成 | immutable，保留；未批准删除此层 |
| runId | ID | 每个 Attempt 必须属于一个 Run；Run 0..N Attempt | 必填，无默认；与 taskId 同时存在 | claim 确定，immutable |
| taskId | ID | 每个 Attempt 对应一个 Task，必须等于所属 Run.taskId | 必填，无默认；不是与 runId 二选一 | claim 确定，immutable；保留既有归属核对语义 |
| nodeId | ID | 持有此 Attempt 的节点 | 必填，无默认 | claim 确定，immutable |
| fence | Int | 现有单调 fencing 令牌 | 必填，服务分配 | immutable；旧节点不能凭过期 fence 写结果 |
| leaseExpiresAt | Timestamp | 当前有效租约期限 | 必填，claim 决定 | 所有权协议续租更新，表单不可写 |
| state | 枚举（单选）：leased、running、settled、cancelled、expired、uncertain | 现有租约/执行阶段 | 必填，leased | 执行服务、结算、取消回执或超时对账更新 |
| sessionId | ID?（内部会话） | 此 Attempt 实际使用的内部 sessionId；实际节点由本 Attempt.nodeId 查询，不重复设备或 profile | 无会话或未知时为空，不补造 | 有效所有权下绑定，是 Run 会话视图的来源事实；不随内容编辑改会话，旧字符串保留兼容证据 |
| executionId | ID? | 现有第一执行实例的原子绑定 | 开始前可空，实际开始后必填 | 一次绑定后 immutable；后续写入须相同 |
| retryEvidence | SafeRetryWitness? | 现有 DSH 权威安全重试证据 | 初始空；只有满足证据协议才写 | 宿主可信生命周期生成，普通模型/远端不能伪造 |
| createdAt | Timestamp | 现有 Attempt 创建/取得租约时间 | 必填，服务时间 | 创建后 immutable |
| updatedAt | Timestamp | 现有 Attempt 最近状态/租约记录修改时间 | 初始等于 createdAt，实际协议写入时更新 | 所有权协议维护；与初始取得租约及 leaseExpiresAt 分开 |

SafeRetryWitness 的结构由实际可信生命周期证据确定，两个 kind 互斥，二选一：dsh-owned-zero-tools-v1 或 dsh-owned-completed-tools-v1。保留完整协议字段：kind、sessionId、fromSeq、toSeq、terminalSeq、turn、code（RATE_LIMIT/SERVER/TRANSPORT/TIMEOUT），以及 complete/quiescent/persisted/disposed=true。零工具型要求 toolCallCount=toolDispatchCount=0；已完成工具型保留 toolCallCount/toolDispatchCount/toolResultCount 和 completedTools 指纹。它是可信宿主生命周期证据，不用普通 JSON 内容“声明安全”。

Attempt.taskId 与 Run.taskId 的冗余是现有协议归属核对的一部分，保留并校验一致，不据此给其它关系复制相同字段。

LeaseRef 保留 runId、attemptId、nodeId、fence；开始执行及绑定后所有写入还必须携带 executionId。租约过期、取消请求、取消回执和已结算是不同事实；旧历史 lease/status 永不恢复为当前有效所有权。

<a id="fields-report"></a>
### 7.8 Report：具体经历、反馈与反思

| 字段 | 类型 | 含义及关系 | 必填与默认 | 权威与可改性 |
|---|---|---|---|---|
| reportId | ID | 现有不可变报告版本身份 | 必填，API 生成/合法指定 | immutable |
| taskId | ID | 现有归属一个 Task；Task 0..N Report | 必填，无默认 | 创建确定，immutable；每份报告保留这一实际归属 Task |
| runId | ID? | 现有 0..1 执行来源，必须属于同 Task | 可选，空 | 执行/报告 API 校验，immutable |
| attemptId | ID? | 现有 0..1 尝试来源，须匹配 Task 及填入的 Run | 可选，空 | 同上；新增建议填写 attemptId 时同时记录其 runId |
| sessionId | ID?（内部会话） | 此 Report 的真实会话来源，使用同一内部 sessionId；不是设备身份 | 无会话来源可空；旧未解析编号不造系统引用 | 记录可确认引用；环境沿 Run、Attempt 节点关系读取，旧外部原值由 adapter 兼容层保留 |
| revision | Int | 现有报告修订序号 | 必填，1 或前版+1 | API 生成，immutable |
| previousReportId | ID? | 现有同 Task 前一版本，0..1；修订链不覆盖正文 | 可选，空 | 创建时校验，immutable |
| title | Text | 现有报告标题 | 必填，无默认 | 创建时写入，修改通过新 Report |
| body | Text | 现有进展、结果、反馈或反思正文 | 必填，无默认 | 创建时写入，immutable；默认私有 |
| data | JSON? | 结构化执行结果，例如日报条目；模板使用时按固定输出规则提供，历史导入源数据保留原含义 | 普通文本报告可空；结构化报告所需字段由实际模板 schema 决定 | 结算前按实际配置校验，写入后 immutable；授权前端读取所需字段，不原样公开 |
| schemaId | Text? | 标识本份结构化报告内容协议，供前端选择对应呈现；所用模板版本沿 Run 查得 | 结构化呈现需要时填写；旧未知可空，不伪造 | 创建时固化；不复制模板全文或把旧 schemaVersion 猜成新结构 |
| kind | 枚举（单选）：progress、result、review、observation、note | 现有内容用途 | 必填，progress | 创建时确定；result 不自动是人工验收 |
| artifactIds | ID[] | 现有最终材料版本列表；跨 Report 可重复引用 | 必填，[] | 当前协议要求 finalized、同 Task、可核文件字节；不可假装已支持跨任务材料 |
| createdAt | Timestamp | 现有报告发生/产生时间 | 新数据默认服务时间；可接受经校验来源时间 | immutable；源时间原值/单位另存 |
| recordedAt | Timestamp | 现有写入本系统时间 | 必填，服务时间 | API 生成，immutable |

结构化日报通过 Report.data 保存实际结果，前端结合 schemaId 与该 Run 固定的模板规则选择呈现；不从当前 Task 或最新 Template 重新解释旧报告，也不把原执行 configuration 复制成报告正文。私有管理前端与公开网站的权限不同；公开只输出明确选择的 Report 内容投影，原始输入、执行配置、workspace 路径与凭据仍不公开。

artifactIds 是保留的报告材料关联，读取实际材料版本，不再增加第二组材料引用或替代字段。既有 finalized、同 Task 归属及文件校验约束继续保留；材料自身的来源与项目展示关系不改变报告的实际归属。

Report 只归属一个 taskId，实际执行来源沿 runId、attemptId 保留；复盘正文可以说明相关经历，但本轮不增加其他 Task 关联字段，也不把同一报告复制给每项任务。来源沿既有归属与执行记录读取，无法确认的来源保持未知，不增加单独作者字段。纯手工网站文章或能力讲解可登记 Artifact，不能为凑 Report 所有权虚构一次执行。

<a id="fields-artifact"></a>
### 7.9 Artifact：有管理价值的材料目录与版本

**已批准登记与存储原则**：Artifact 是材料目录，不把所有文件或正文写进数据库。登记最终交付、精选阶段成果、值得复用的源文件及必要理解或验证证据；临时 build、缓存、重复截图及全部日志不自动登记。完整过程关联继续通过 Project、Task、Run、Attempt、Report 和实际材料版本保留，不等于为所有中间文件保存副本。

已有可靠来源时优先引用稳定 file ID 与可确认原生修订，或 repo、commit、path 的版本定位；短期 download URL 和执行机绝对路径不是材料永久身份。唯一交付或无法由来源可靠版本化但必须锁定的证据，才明确复制到选定的文件存储；数据库只保存小型元数据与引用。VPS 总容量 30GB，大视频、模型、设计源文件不默认复制到 VPS，也不因登记目录就下载所有材料。

**字段精简提案（待审，不宣称已改产品）**：保留 artifactId 的稳定登记版本身份；内容确有变化时登记新版本，同一内容只是移动位置不产生新内容版本。materialId 仅在确需同材料的版本承接时用于分组，旧 ID 不改号，不按路径猜同一材料。内容版本固定不要求物理位置永久固定；来源 adapter 或文件存储负责解析当前真实位置。

| 字段 | 类型 | 含义及关系 | 必填与推荐默认 | 权威与可改性 |
|---|---|---|---|---|
| artifactId | ID | 稳定材料登记版本身份；原生来源与归档副本可指向同一内容版本 | 必填，材料 API 生成或合法指定；旧 ID 保留 | ID 不变，不能用新正文覆盖成另一内容版本；仅移动位置不换版本 ID |
| materialId | ID?（分组建议） | 同一有管理价值材料的版本分组；一个材料可有多个 artifactId | 确有版本承接需要且能确认同一材料时填写；旧未知可空 | 管理 API 明确关联，不按同名、相同路径或重复截图自动归并 |
| name | Text | 材料登记名称 | 必填，无默认 | 保留登记信息；公开展示标题沿独立发布投影处理 |
| mediaType | Text? | 有可靠依据的 MIME 类型，帮助打开或呈现材料 | 可空，未知不统一猜成 application/json | 来源 adapter 或实际文件识别提供；旧声明保留原依据 |
| taskId | ID? | 原始登记或产生来源 Task；手工材料可无 Task | 当前执行协议仍要求归属 Task；目标手工登记可空，不虚构执行 | 原来源保留；后续参与通过 provenance 读取，不反复改成最近 Task |
| reportId | ID? | 可确认的原始登记或产生来源 Report | 可空，无真实报告不补造 | 保留原来源，不代替完整反馈与反思链；Report 的材料关联仍沿 artifactIds |
| contentRef | 稳定来源版本或存档对象引用（具体结构待审） | 唯一版本定位依据：来源 adapter 的稳定 file ID 与原生修订、repo 与 commit 与 path，或明确归档的稳定对象 ID；不保存正文 | 登记实际材料需有可解释来源；需锁定证据时必须能固定版本，无依据不得冒充已锁定 | 固定已确认内容依据；当前可用地址由 adapter 或文件存储解析，不把短期 URL、临时路径当永久标识 |
| availability | 只读可用性说明（具体枚举待审） | 按当前实际访问范围说明可取得、仅指定本机或节点、不可取得或未知；不是归档成功标志 | 无核实依据则未知；仅本机存储必须明确标示，不默认可由 VPS 取得 | 从来源 adapter、节点与实际存储定位读取，不因已登记、已有 hash 或 finalized 就宣称可访问或已归档 |
| sha256 | SHA256 Text? | 按明确要求及对应规则取得的内容摘要；单文件字节摘要与目录 manifest 摘要不能混称 | 已批准为可选：只有用户或明确任务合同要求时才计算；未要求留空，不因登记或归档自动计算 | 与实际内容版本及约定规则对应；不默认扫描、下载或 hash，旧声明及 normalized-json 摘要仅保留原作用对象的兼容事实 |
| bytes | Int ≥ 0? | 已知文件字节大小，供实际访问、传输及存储判断；是数字，不是正文 blob | 按可信元数据或实际文件取得；未知为空，不写 0；纯原生引用不为填大小强制下载 | 只描述其实际文件对象；旧 payload 大小声明不冒充当前文件大小，不用此字段建配额系统 |
| createdAt | Timestamp | 材料目录登记时间，不等于源文件最初创建时间 | 新登记用服务时间；旧原始来源时间按证据保留 | 原登记事实固定，不因移动位置重写 |
| predecessorArtifacts | 只读版本关系集合 | Artifact 0..N ↔ Artifact 0..N，表达延续、派生或合并 | 无关系时 []；校验无因果环，不作为重复数组保存 | 查询唯一版本关系；移动位置不是派生内容版本 |
| provenance | 只读来源关系集合 | 实际 Task、Run、Attempt、Report 的产生、修改、反馈与反思过程，指向明确 artifactId；Project 背景沿 projectReferences | 无补充关系时 []；沿已有 taskId、reportId 可回答的来源不重复登记 | 读取真实来源事实，完整过程链保留，不以单一最近 Task 或单一路径替代 |
| projectReferences | 只读 Project 引用集合 | Artifact 0..N ↔ Project 0..N，材料的项目背景与用途 | 无引用时 []；与 skillReferences 独立 | 查询唯一项目关系，不复制材料文件 |
| skillReferences | 只读 Skill 引用集合 | Artifact 0..N ↔ Skill 0..N，实际版本的能力证据 | 无引用时 []；与 projectReferences 可同时存在或分别为空 | 查询唯一能力证据关系，保留版本与权限约束 |
| publication | PublicProjection?（只读引用） | 可选的明确公开投影，与物理文件位置及用户验收分开 | 没有公开投影时为空，不自动公开来源或本机路径 | 发布 API 维护投影，不因材料登记、校验或归档自动发布 |

**已批准的按需 hash 与内容校验**：要求算时才算，没有要求就不算。登记、建立来源引用、复制归档或展示材料本身都不构成默认计算要求；未要求时 sha256 留空，不默认扫描目录、下载来源材料或执行内容 hash。已有可靠原生修订或 commit 可直接作版本依据，不为补字段额外读取正文。

若以后明确要求目录校验，须先说明实际 manifest 规则，例如收录范围、相对路径及排序、链接处理等，再按约定计算；不能把目录 manifest 的摘要冒充单文件字节 hash。规则沿明确任务合同或实际来源证据说明，本轮不建立目录 hash 系统、额外校验表或自动扫描流程，也不执行扫描或 hash。

最小定位只保存 contentRef 的稳定版本依据；原 uri 与 contentRef 的双定位提案、重复 versionLabel 及整套 IntegrityEvidence 不再列为目标字段。版本标签可从实际版本引用或展示说明读取；sha256、bytes 按用途可空，不再另存一组可独立修改的 digest、size、unit、核验状态、核验时间与核验者字段。必要旧声明与不同作用对象的证据继续保留在已有来源记录或 adapter 兼容层，不删事实，也不因此建设校验账本。

原生引用与明确归档副本不是两份业务材料：保留原来源溯源，副本作为该内容版本的可用位置，由实际文件存储登记和解析。位置解析结果可以是授权的临时下载地址或指定节点上的当前路径，位置变化不改内容版本；本节不硬定厂商、存储产品、对象桶或全量资产管理表。临时缓存只帮助访问，不算持久归档，也不要求成为 Artifact 的第二身份。

可变 URL 只表示 live reference，不等于已锁定内容。若用于指定版本验收或公开证据，需要可靠原生修订、commit 或明确归档；暂时没有时说明未锁定，不伪造 hash，不把以后变化的网页称为同一不可变内容版本。仅本机存在的文件必须说明所在节点及可用范围，不能写成服务器已有归档副本。

**已核基线与兼容限制**：现有 Artifact 数据库存元数据，uri、sha256、bytes 中的 bytes 是大小数字，不含文件正文。registerArtifact 只登记元数据及检查 ID、摘要格式、大小范围，不读取或复制文件；finalized 由输入提供，不能把登记本身描述成材料服务已经核验文件。显式 ArtifactStore.put 收到 Uint8Array 才把字节写到指定目录，以内容 hash 命名并核验后登记 finalized=true，默认单文件上限 16MiB。

旧 Hermes 导入保留 artifact_path、sha256、byte_length 等声明并设 finalized=false，不搬运文件；importSnapshot 同样只存元数据。现有 Report 附件路径在协调端调用 statSync、readFileSync，要求 finalized、同 Task、实际大小匹配、单文件不超过 16MiB、SHA256 匹配；远端 native 附件需要 authority-owned transfer。任意 URL 或另一执行机绝对路径不能直接替代这条旧本地文件协议；这是尚未改变的基线限制，不是目标材料目录只能登记本地文件。

目标不把 finalized 当通用材料目录状态或自动归档证明，旧 finalized、uri、sha256、bytes 继续按原协议和原作用对象保留兼容事实；上述 ArtifactStore.put 与 Report 附件的强制 hash 是现有实现限制，不搬成新目录的默认计算规则。删除目标预设不等于现在删旧字段或放宽附件校验。没有已实现的 Artifact 自动归档、总容量配额或清理策略，16MiB 限制也不是 30GB VPS 的容量预算。本轮只修订文档，不安装存储、不上传材料、不改配置、产品或旧数据。

<a id="fields-skill"></a>
### 7.10 Skill：个人能力展示与沉淀（新增建议）

| 字段 | 类型 | 含义及关系 | 必填与推荐默认 | 权威与可改性 |
|---|---|---|---|---|
| skillId | ID | 稳定能力条目身份；网站模块名 skill | 必填，API 生成 | 管理 API 创建，immutable |
| revision | Int ≥ 1 | 能力条目内容修订，供并发保存与固定公开内容 | 必填，1；待审建议 | 管理 API 维护，旧内容保留 |
| createdAt | Timestamp | 能力条目登记时间 | 新条目必填，服务时间；历史未知不补造 | 创建时确定，immutable |
| updatedAt | Timestamp | 能力条目最近人工内容变化时间，不是证据材料的更新时间 | 新条目初始等于 createdAt，实际内容修改时更新 | 内容 API 只更新最近修改时间，createdAt 保持不变 |
| publication | PublicProjection?（只读引用） | 此能力条目的明确公开投影，见 7.16 | 没有发布记录为空 | 从唯一公开投影读取，不在 Skill 再维护一份 publicSlug/发布状态 |
| createdBy | 操作来源值?（待审） | 可选说明能力条目的初始创建渠道 | 默认不加；优先读初始内容来源，旧未知不补造 | 来源事实固定；不把 agent/节点当本人 |
| updatedBy | 操作来源值?（待审） | 可选记录能力条目最近内容修改渠道，与创建渠道分开 | 默认不加；已有可靠来源可复用，未知可空 | 管理 API 按本次实际来源更新最近值；createdBy 保持不变 |
| title | Text | 能力名称 | 必填，无默认 | 本人/授权管理 API 可改 |
| summary | Text | 能力概述，说明能做什么 | 草稿可空；发布前必填 | 同上，保留内容版本 |
| abilityStatement | Text | 对个人实践能力的具体说明 | 可选，空字符串；重要主张应有证据引用 | 本人确认后 API 保存，不由执行成功自动生成认可 |
| practiceNotes | Text | 如何实践、做过什么、怎样改进，可引用材料而不复制正文 | 可选，空字符串 | 管理 API 可改 |
| methodNotes | Text | 可复用方法或经验，只是 Skill 的可选一部分 | 可选，空字符串 | 管理 API 可改，不限于 Task 结束后提炼 |
| limitations | Text | 当前边界、适用条件与不足 | 可选，空字符串 | 本人/授权管理 API 可改 |
| state | 枚举（单选）：draft、active、archived | 草稿/维护中的能力条目/归档 | 必填，draft；与公开状态独立 | 管理 API 可改；active 不是熟练度等级 |
| projectEvidence | 只读关系集合 | Skill 0..N ↔ Project 0..N，说明在什么项目实践 | 视图可为 []；不作为实体保存列 | 关系 API 校验并写唯一关系事实，本集合从该事实查询派生；保留上述归属/版本约束 |
| artifactEvidence | 只读关系集合 | Skill 0..N ↔ Artifact 0..N，固定材料版本及用途 | 视图可为 []；不作为实体保存列 | 关系 API 校验并写唯一关系事实，本集合从该事实查询派生；保留上述归属/版本约束 |
| reportEvidence | 只读关系集合 | Skill 0..N ↔ Report 0..N，具体过程、反馈与反思依据 | 视图可为 []；不作为实体保存列 | 关系 API 校验并写唯一关系事实，本集合从该事实查询派生；保留上述归属/版本约束 |

推荐发布 Skill 时至少有一项明确实践证据，并允许附书面背景说明；旧无证据保持草稿。这里不添加 proficiency、等级评分、掌握度推断或强制练习评价体系。Skill 与 agent SKILL.md 没有自动安装/执行关系，也不授予工具或工作区权限。

<a id="fields-milestone"></a>
### 7.11 Milestone：可选检查点（新增建议）

| 字段 | 类型 | 含义及关系 | 必填与推荐默认 | 权威与可改性 |
|---|---|---|---|---|
| milestoneId | ID | 稳定检查点身份 | 必填，API 生成 | 管理 API 创建，immutable |
| revision | Int ≥ 1 | 检查点目标/选定标准的内容修订，用于并发保存与固定验收依据 | 必填，1；待审建议 | 管理 API 维护；一次条件检查不递增标准版本 |
| projectId | ID | 归一个 Project；Project 0..N Milestone | 必填，无默认 | 创建确定；改属须显式迁移审计 |
| title | Text | 检查点名称 | 必填，无默认 | 管理 API 可改 |
| goal | Text | 达到此检查点意味着什么 | 可选，空字符串 | 管理 API 可改，保留内容修订 |
| state | 枚举（单选）：planned、active、awaiting_review、accepted、cancelled、archived | 检查点显示状态：管理选择与条件/确认结果须区分 | 新建 planned；待审建议 | 规划/取消/归档由管理操作维护；awaiting_review/accepted 从实际证据与判断投影，不独立写一份 accepted |
| backlogScope | 只读Backlog 关系集合 | Milestone 0..N ↔ Backlog 0..N；推荐均属于此 Project | 视图可为 []；不作为实体保存列 | 关系 API 校验并写唯一关系事实，本集合从该事实查询派生；保留上述归属/版本约束 |
| selectedTasks | 只读Task 关系集合 | Milestone 0..N ↔ Task 0..N，选定工作，不等于全部成员 | 视图可为 []；不作为实体保存列 | 关系 API 校验并写唯一关系事实，本集合从该事实查询派生；保留上述归属/版本约束 |
| artifactConditions | 只读Artifact 版本关系集合 | Milestone 0..N ↔ Artifact 0..N，验收指定版本 | 从本检查点的 artifact_acceptance 条件/对应固定版本引用查询 | 条件及其目标引用只保存一份；此集合不独立增删另一套标准 |
| milestoneRelations | 只读Milestone 自关联集合 | 新增待审：Milestone 0..N ↔ Milestone 0..N，区分完成条件与前置依赖 | 视图可为 []；不作为实体保存列 | 关系 API 校验并写唯一关系事实，本集合从该事实查询派生；保留上述归属/版本约束 |
| conditions | Criterion[] | 具体完成/验收依据，见 7.12；可引用下述同一 Milestone 关系 | 必填，[]；active 前至少一条 | 管理 API 可修订；旧判断仍绑定旧条件版本 |
| completionMode | 枚举（单选）：all、any | 如何汇总本次选定完成条件；不豁免明确前置依赖 | 必填，推荐 all | 管理 API 选择；不引入规则引擎或权重公式 |
| conditionStatus | 枚举（单选、只读）：pending、met、unmet、unknown | 当前条件证据判断；不是用户确认 | 无检查时 pending，无法判断 unknown；不作为独立可写列 | 从固定标准的检查证据汇总，不让表单另写 met |
| acceptance | AcceptanceView（只读） | 当前 Milestone revision 的人工判断 | 无判断时投影 not_requested，不作为独立可写列 | 从明确确认动作及其来源记录投影，沿用 7.17 的证明范围 |
| targetAt | Timestamp? | 期望时间 | 可选，空 | 管理 API 可改；不自动调度执行 |

条件满足可以建议进入 awaiting_review，不能自动写 accepted。人工例外接受应记录理由与尚未满足项，不把原条件证据改成 met；修改条件、目标或所验材料版本后旧确认继续保留，但不自动覆盖新版本。

**Milestone 自关联：本轮新增待审建议。** 用同一种有方向的关系表达两种业务含义，不新增“子 Milestone”或“依赖 Milestone”实体，也暂不增加只用于展示的 parentMilestoneId。

- 完成条件：总体验收 A 要求接口交付 B、说明交付 C 达成，记为 A→B、A→C；可和选定 Task、Backlog 范围及材料条件一起汇总。
- 前置依赖：B 必须在 A 达成后才能达成，记为 B→A；这是 B 的达成前提，不表示 B 包含或拥有 A，也不自动禁止 B 提前开展工作。

在完成判断层，两种关系复用同一谓词：“所要求的检查点指定版本已满足约定达成依据”。语义类型说明为什么依赖它；完成条件参加本检查点的 all/any 汇总，明确前置依赖须先满足，不能被 any 中另一个条件绕过。共用一套关系结构和检查事实，不为两种说法制造两份完成事实。

| 自关联字段（值/关系结构，非新核心实体） | 类型 | 含义及关系 | 必填与推荐默认 | 权威与可改性 |
|---|---|---|---|---|
| fromRef | Milestone 版本引用 | 待达成的检查点；A→B 中为 A | 创建关联时必填，无默认 | 管理 API 固定该版标准的依赖，修改产生新修订 |
| toRef | Milestone 版本引用 | 要求先/同时满足的检查点；A→B 中为 B | 创建关联时必填，固定被要求版本 | API 校验访问权限；不悄悄追随目标 latest |
| semanticTypes | 枚举集合（可多选，至少一项）：completion_requirement、prerequisite | 完成条件、前置依赖或两种用途；底层仍为同一有向关系 | 必填，显式选择，不猜类型 | 管理 API 修改并保留旧关系；同端点/版本/依据不重复登记完成事实 |
| targetCompletionBasis | 枚举（单选）：human_accepted、conditions_met | “另一 Milestone 达成”具体指人工确认还是条件证据满足 | 推荐 human_accepted；改为 conditions_met 必须明确选择 | API 检查指定目标版本；conditions_met 不冒充对方已被人工认可 |
| observedStatus | 枚举（单选，只读）：pending、met、unmet、unknown | 对目标指定达成依据的观察，不是当前检查点的人工验收 | 初始 pending；证据不足 unknown | 从目标的实际检查或验收记录投影，不存第二套完成事实 |
| evidenceRefs | 只读版本引用集合 | 支持上述 observedStatus 的实际证据，0..N | 无证据时 []；与 observedStatus 同时提供，不是二选一 | 沿目标记录读取，不由表单伪造证据 |

其余 relationId、revision、登记时间与关系撤回历史沿用 7.15，不自动附加 createdBy 与 updatedBy。合并两种语义检查整个有效依赖图是否无环，包括跨 Project 关系；跨项目引用只在双方访问权限允许时登记，不转移归属或授予执行权限。没有目标原始版本/达成事实时保留未知，不从旧状态补造关联。

目标满足只会提供当前检查点的条件证据；不会自动把当前或目标 Milestone 写成 accepted，也不自动创建 Run。若未来需要自动完成策略，须另行定义其权威与适用范围；本轮不新增这种策略、状态机或规则表。改变目标版本/达成依据后保留旧检查与人工确认，不把旧确认静默延续到新标准。


<a id="fields-criterion"></a>
### 7.12 Criterion：目标/完成依据的值结构（新增建议）

Criterion 用于 Project、Backlog、Task、Milestone 的标准。Backlog 已明确按自身标准判断完成，机器可判与人工条件都使用此结构。它属于值结构，不必新建一张独立核心实体表。criterionId/description/kind/targetRef/requiredEvidence 是标准定义；evidenceRefs/observedStatus/checkedAt/checkedBy 是对应检查事实的只读视图，不在标准里再维护一份可独立修改的结果。Milestone 型直接引用同一自关联，不重复登记目标标准。

| 字段 | 类型 | 含义及关系 | 必填与推荐默认 | 权威与可改性 |
|---|---|---|---|---|
| criterionId | ID | 同一对象内稳定条件标识 | 必填，API 生成 | 内容修订保留标识；删除条件留历史 |
| description | Text | 用自然语言说明需要达到什么 | 必填，无默认 | 管理 API 可修订，跟随所属内容版本 |
| kind | 枚举（单选）：task_completion、task_acceptance、artifact_acceptance、milestone_completion、manual_check | 需要的证据类型；Milestone 型复用 7.11 的同一自关联，完成与验收分开 | 必填，默认 manual_check | 管理 API 设置；不任意增加可执行表达式 |
| targetRef | {type, id, revision?}? | Task 意图版本、Artifact 版本、Milestone 指定版本或需检查对象 | 自动关联型必填；纯人工检查可空 | API 校验存在与访问权限，禁止跨版本误用 |
| requiredEvidence | Text | 应提供什么材料/观察/说明 | 可选，空字符串 | 管理 API 可改，不虚构完整测试包要求 |
| evidenceRefs | 只读版本引用集合 | 对应 Report、Artifact/人工判断记录，0..N | 视图可为 []；不作为实体保存列 | 关系 API 校验并写唯一关系事实，本集合从该事实查询派生；保留上述归属/版本约束 |
| observedStatus | 枚举（单选）：pending、met、unmet、unknown | 本条件的证据判断，属于只读观察投影 | 默认 pending；无法判断为 unknown | 检查 API 追加检查事实后投影；不因一次检查重写标准版本，与 acceptance 分开 |
| checkedAt | Timestamp?（只读） | 这次实际检查发生的时间 | 未检查为空；有实际时间依据才填 | 从对应检查事实读取 |
| checkedBy | 操作来源值?（只读、待审） | 可确认的检查来源，不预设自然人 | 未检查或来源 ID 不可确认时为空；与 checkedAt 独立 | 从同一检查事实读取，时间已知不代表人员已知 |

<a id="fields-sprint"></a>
### 7.13 Sprint：暂不加入（用户已确认）

本轮不将 Sprint 纳入实体、主图、字段表或物理存储方案；撤下原完整候选字段表，只保留这一决定说明，也不补建周计划实体。若以后明确需要，再另行讨论，不把本节当实施要求。Milestone 继续保持可选。

<a id="fields-workspace"></a>
### 7.14 Workspace：真实执行设施（现有）

| 字段 | 类型 | 含义及关系 | 必填与现有默认 | 权威与可改性 |
|---|---|---|---|---|
| workspaceId | ID | 真实已登记工作区身份 | 必填，无默认 | WorkspaceManager 登记，immutable |
| nodeId | ID | 属于一个执行节点；同节点可多个 Workspace | 必填，无默认 | 登记确定，禁止身份改绑 |
| path | Text | 节点上的真实目录 | 必填，无默认 | 宿主授权 provisioning 校验；不可公开，不能随 Project 编辑改路径 |
| name | Text | 现有可读名称 | 必填，无默认 | 执行设施 API 管理 |
| state | 枚举（单选）：ready、planned、failed | 实际创建/复用结果 | 管理器先 planned，校验后 ready 或 failed | WorkspaceManager 更新，不由网站宣告 ready |
| createdAt | Timestamp | 登记时间 | 必填，服务时间 | immutable |
| projectBindings | 只读关系集合 | 新增建议：Workspace 0..N ↔ Project 0..N | 视图可为 []；不作为实体保存列 | 关系 API 校验并写唯一关系事实，本集合从该事实查询派生；保留上述归属/版本约束 |

创建 Project 只写业务记录，不自动 mkdir；Workspace.state=ready 也不意味着任何 Task 已获权限，仍由 Task.policy、node 与宿主范围决定。


<a id="fields-relations"></a>
### 7.15 多对多关系、来源与展示引用字段

这些是不同关系用途的字段说明，不是所有 junction 的继承模板。主图仍只画业务实体与基数；Domain.projects/Project.domains、Backlog.taskMemberships/Task.backlogMemberships、Project.workspaceBindings/Workspace.projectBindings，以及材料/能力正反向引用均读取同一套关系事实，不能分别保存独立实体数组。下面逐行明确适用关系，普通成员关联不自动带材料用途、解释、证据、顺序或时间字段。

| 字段 | 类型 | 含义及关系 | 必填与推荐默认 | 权威与可改性 |
|---|---|---|---|---|
| relationId | ID | 一段明确关联事实的身份 | 需要历史/额外属性的关系必填，API 生成 | API 创建，immutable |
| relationKind | Text enum | 所表达的既定关系种类 | 共用引用存储时必填；若类型由具体关联结构已确定，不重复保存类型字段 | API 校验允许端点类型，不接受任意类型扩权 |
| fromRef | {type, id, revision?} | 关系起点；每条关系恰有一个起点 | 必填，无默认；与 toRef 同时存在 | API 校验端点类型与归属，固定事实后不随意改号 |
| toRef | {type, id, revision?} | 关系终点；每条关系恰有一个终点，证据指明确版本 | 必填，无默认；Artifact 用 artifactId，Task 验收用 intentRevision | API 校验访问权限与版本；换目标保留原事实 |
| roles | Text[]? | 仅材料/能力证据引用的 用途集合（可多选）：usable、editable_source、explanation、validation_evidence、edit_entry、practice_evidence | 该类引用需要时填写；一般成员/分类关联不加；多用途不复制材料 | 管理/材料 API 可修订；角色不授予权限 |
| action | 枚举（单选、可空）：produced、modified、derived、referenced、explained、validated、reflected | 材料来源/过程边的含义 | 来源边必填；普通分类关系可空 | 产生/修改由真实执行或手工来源登记；人工补录注明来源 |
| executionRef | {taskId, runId?, attemptId?}? | 精确来源执行，所有已填 ID 必须一致 | 执行来源按实际可得填写，未知不补造 | 执行/导入 API 创建，immutable 来源事实 |
| evidenceReportRefs | Report 版本引用[]? | 来源/反思/验收关联需要的报告证据 | 仅该类关联需要；普通分类/排序关联不加 | API 追加实际证据，保留报告真实 Task 所有权 |
| context | Text? | 项目/能力展示引用的贡献或背景，或实际需要的关系说明 | 有说明需要才保存；普通关联可省略 | 管理 API 可修订，不复制报告全文 |
| explanationTopics | Text[] | 内容主题集合（可多选）：how_to_use、design_reason、how_to_modify、limitations | 解释关系可用，默认 [] | 管理 API 定位真实内容；不要求四份材料 |
| explainedObjectRef | 版本引用? | 解释材料讲解的实际对象及版本 | 解释关系推荐必填；一般关系空 | API 校验，改版本不静默沿用旧讲解适用性 |
| locator | JSON? | 真实材料中的章节/页码/锚点/视频时间段 | 可选，空 | 管理 API 设置，不能只有标题却没有材料内容 |
| position | Int? | 仅明确需要持久手动排列的展示关系；本轮不为 Backlog 或其 Task 关联新增此字段 | 以后确有需求再审；当前需求待办列表按业务字段查询排序 | 若采用才由管理 API 按所属排列修改，不为每条关系造排序 |
| isDefault | Bool? | 仅 Project-Workspace：此节点默认使用的绑定 | 默认 false；同 Project 与 nodeId 至多一个 true | 管理 API + 执行服务校验；默认不绕过路由权限 |
| activeFrom | Timestamp? | 仅需要参与或展示变动记录的关系生效时间 | 普通静态关联可省略；有生效事实时填写 | API 按实际参与或引用记录，不给全部关系加此字段 |
| activeUntil | Timestamp? | 上述关系的撤回时间，与 activeFrom 分开 | 未撤回为空；永久生产事实不套截止期限 | 撤回展示不删除材料生产事实 |
| revision | Int? | 仅可修改的安排/引用元数据并发版本 | 该类修改需要时从 1 起；不可变来源边不加更新计数 | API 保存校验并保留实际需要的旧安排，不给全部关系统一 revision |
| recordedAt | Timestamp? | 需要来源/参与历史的实际登记时间 | 有此需要时记录；可沿已有事件/回执可靠读取则不重复存，普通关联可省略 | API 按事实登记；不另加一套通用 createdAt、updatedAt 及 by |

关联本身默认不加 by；执行来源沿 executionRef/报告证据读取，人工关联变更有必要追踪时优先复用同次管理操作已有的来源/修订记录，不另建审计日志，也不把材料原生产来源改成这次引用者。

材料版本前后关系不以一次“当前 Task 更新”代替：同一 materialId 可有多条版本支线；派生材料可有多个来源 materialId；每条产生/修改/反馈关系绑定实际 artifactId，并能追溯真实执行、报告与反思。移除网站引用只能撤回展示关系，不能删除来源历史。

<a id="fields-review-publication"></a>
### 7.16 人工验收与公开投影的值/记录结构（新增建议）

验收与公开是独立事实：执行前 confirmation、command 回执 acceptedAt、实际配置校验通过、旧附件协议的 finalized、明确材料归档、人工 acceptance、网站 published 不能混成一个“完成”字段。

| AcceptanceRecord 字段 | 类型 | 含义及关系 | 必填与推荐默认 | 权威与可改性 |
|---|---|---|---|---|
| acceptanceId | ID | 一次人工判断记录 | 作判断时必填，API 生成 | immutable，后续改变追加新记录 |
| subjectRef | {type, id, revision?} | Project、Milestone 内容 revision、Task intentRevision 或 Artifact artifactId；Backlog 完成使用自身 Criterion 检查，不新增平行判断记录 | 必填；可变对象 revision 必填，Artifact 的不可变 artifactId 本身即版本 | API 校验，immutable；旧确认不自动覆盖新版本 |
| decision | 枚举（单选）：accepted、needs_changes、rejected、withdrawn | 明确确认动作所提交的业务判断，记录其渠道依据；不宣称已核验登录人 | 作判断时必填，无自动默认 | 既有允许的确认入口提交，API 保留证明范围；模型不能自称用户同意 |
| criterionRefs | {criterionId, ownerRevision}[] | 此次判断所依据条件 | 必填，[]；无条件时需明确书面依据 | API 记录版本，不重写旧标准 |
| evidenceRefs | 版本引用[] | 对应材料、报告或实际观察 | 必填，[]；接受应有证据或书面说明 | API 校验权限和对应版本 |
| reason | Text | 依据、反馈/不足、例外接受理由 | needs_changes/rejected/withdrawn 必填；接受无证据时必填 | 主体写入，immutable |
| decidedBy | 操作来源值（待审） | 判断的实际操作来源，不预设自然人 | 有判断时记录渠道类别；不可确认的 ID 可空 | API 按实际入口记录，未验证面板不填已认证人 |
| decidedAt | Timestamp | 这次判断实际发生时间，与决定来源分开 | 新判断必填，服务时间；旧未知不伪造时间 | API 按该动作记录，不从决定来源推测时间 |
| previousAcceptanceId | ID? | 前一次相关判断 | 可选，空 | API 校验同 subject 身份，immutable |
| recordedAt | Timestamp | 本系统登记时间 | 必填，服务时间 | API 生成，immutable |

AcceptanceView 为读模型：status（not_requested/pending/accepted/needs_changes/rejected/withdrawn）、subjectRef、latestAcceptanceId?、evidenceRefs。新内容初始 not_requested；pending 是提出审阅的事实；已有旧版确认另列历史，不悄悄给新 revision 继承 accepted。保留现有 Run.reviewStatus 的协议含义，不用它替代这套版本化业务验收。

| PublicProjection 字段 | 类型 | 含义及关系 | 必填与推荐默认 | 权威与可改性 |
|---|---|---|---|---|
| subjectRef | 版本引用 | 实际要公开的 Project、Skill/材料或允许的过程内容版本 | 申请公开时必填，固定已审版本 | 发布 API 校验访问权限，不自动追随 latest |
| state | 枚举（单选）：draft、published、withdrawn | 当前发布状态 | 初始 draft；未有投影也不公开 | 本人/授权发布主体经 API 修改 |
| publicSlug | Text? | 独立公开页面的可读 URL 段，仅此处维护；不是实体 ID、文件 uri 或所有公开内容必需字段 | 只有给 Project、Skill/材料等单独网址时才需要；嵌入展示/直接引用材料可为空 | 发布 API 管理已使用的网址；同公开路由范围内唯一，改已发布入口保留旧链接记录 |
| displayTitle | Text? | 只有公开标题需不同于所引用内容版本时才覆盖 | 默认不保存覆盖值，读取允许公开的源版本标题 | 发布 API 维护必要覆盖，不复制每个实体的 title |
| publicBody | Text | 经选择的公开介绍/过程与反思文字 | 默认空；只公开明确选择的正文 | 发布 API 保存，不从 Report.data/configuration 自动整段复制 |
| publicResourceRef | JSON? | 公开可访问材料版本/原生发布资源 | 材料展示需要时必填，其他可空 | 材料/发布 API 核可公开 locator，禁止泄露本机路径 |
| allowedEvidenceRefs | 版本引用[] | 允许公众沿链阅读的材料/过程片段 | 必填，[] | 发布主体明确选择；私有节点可仅给公开摘要 |
| publishedBy | 操作来源值?（待审） | 发布此投影的实际渠道来源 | published 时记录类别；来源 ID 不可确认可空；尚未发布为空 | API 按实际来源填写，不预设人员登录 |
| publishedAt | Timestamp? | 此投影版本的实际发布时间，与发布来源分开 | published 时有实际时间记录；尚未发布为空 | 发布 API 按动作填写，不从 publishedBy 猜出时间 |
| revision | Int | 投影内容自身版本 | 必填，1，修改递增 | 发布 API 管理；与源版本分别保存 |
| curated | Bool? | 未来精选视图是否选用这一公开内容 | 本轮可省略；未来启用时未选视为 false | 只是同数据视图选择，不创建独立 Output |

完整来源历史保存在私有业务数据中；公众只能遍历允许公开的节点/摘要，不能因为要求“完整页面”就泄露原始配置、session 正文、工作区路径、凭据或私有 Report.data。Skill 的公开证据也使用这一投影边界。

<a id="fields-history"></a>
### 7.17 必要版本、回执与按需来源追踪

需要固定历史证据的内容须保留实际证据，单独递增 revision 不等于保存过程。以下按实际用途保留必要版本、回执与来源，优先复用既有 ledger 记录。Task 当前仅采用每次 Run 的轻量 intentSnapshot，不要求保存每次任务编辑的不可变定义，不建设完整 Task 定义版本系统；也不新增通用审计日志或给每份快照强加 actorRef、updatedBy。存储方式放在 7.18。

| 结构 | 字段及类型 | 必填与默认、权威与不可变性 |
|---|---|---|
| ContentRevision | entityType: Text；entityId: ID；revision: Int；content: JSON；previousRevision?: Int；actorRef: 操作来源值?（待审）；recordedAt: Timestamp；reason?: Text | 仅实际需要固定历史的管理内容采用，不用于建立本轮已排除的完整 Task 定义版本系统；actorRef 仅无法沿既有关联可靠追溯且确有来源需要时使用，默认可省略；导入保留未知与原证明范围 |
| MutationCommand | commandId: ID；expectedRevision?: Int；operation: Text；validatedInput: JSON | commandId 必填；改现有管理内容 expectedRevision 必填。按现有渠道/执行授权与输入校验后才执行，不假定人员登录；同命令同内容返回原回执，同命令不同内容拒绝 |
| MutationReceipt | commandId: ID；acceptedAt: Timestamp；value: JSON；requestDigest: Text（内部已有命令摘要语义） | 成功事务生成、immutable；acceptedAt 表示 API 已接受操作，不表示用户验收或实际执行已完成 |
| SourceRef.namespace | Text? | 来源命名范围；可选，未知为空；API 按真实来源填写 |
| SourceRef.originDevice | Text? | 来源设备或节点标识；可选，未知为空；与 profile 独立，不推断人员 |
| SourceRef.profile | Text? | 来源 profile 范围；可选，未知为空 |
| SourceRef.sourceTable | Text? | 原来源表或数据集合名称；可选，未知为空 |
| SourceRef.sourceId | Text? | 在该来源范围内的原始记录 ID；可选，未知为空；与来源范围同时解释，不直接全局合并 |
| SourceRef.idType | Text? | 原 ID 所属类型；可选，未知为空 |
| SourceRef.observedAt | Timestamp | 实际观察时间；有 SourceRef 时必填，记录观察事实 |
| SourceRef.recordedAt | Timestamp | 实际登记时间；有 SourceRef 时必填，与 observedAt 是两个不同时间 |
| SourceRef.rawRecordRef | 私有定位? | 私有原始证据位置；可选，未知为空；不自动公开 |
| SourceTime.field | Text | 原时间字段名；有该时间证据时必填，无默认猜值 |
| SourceTime.rawValue | JSON | 原始时间值；有该时间证据时保留，不被归一化结果覆盖 |
| SourceTime.rawType | Text | 原始 SQL 或 payload 类型；按来源保留，不猜单位 |
| SourceTime.unit | Text? | 原时间单位；可选，未知为空，与时区独立 |
| SourceTime.timeZone | Text? | 原时间时区；可选，未知为空，不从单位或本机时区推断 |
| SourceTime.normalizedAt | Timestamp? | 有依据的归一化结果；可选，未能归一化为空 |
| SourceTime.normalizationBasis | Text? | 归一化依据；只有作出归一化结论时提供，不能用导入时间冒充原时间 |
| ImportCheckpoint | importId: ID；sourceRef: JSON；batchId: ID；cursor?: JSON；acceptedIds: ID[]；unresolvedRefs: JSON[]；receiptRefs: ID[] | 仅未来授权真实导入才使用；稳定批次幂等、依赖顺序、可续传。不是本轮已建导入机制 |

**外部来源 adapter：稳定映射、同步去重与回原会话（已批准边界）**

数据库保留长期接纳 Codex、DSH、Hermes 等外部数据的能力，不限于一次性 Hermes 导入。核心只使用内部 sessionId，不再定义 SessionRef 核心实体、字段组或 Run 的外部身份副本；来源 adapter 负责外部语义。

| adapter 职责 | 与核心的边界 |
|---|---|
| 稳定身份映射 | 在 adapter 的真实来源实例范围内，将 external session ID 稳定关联到 internal sessionId；不同来源或实例不因同字符串合并。实例范围含 adapter 来源类型，详情沿配置及已有节点目录查询，不复制到 Run |
| 同步与去重 | 同一来源实例、外部 ID 及实际来源版本按已知身份重复接入时复用关联，避免重复登记；真实更新继续保留对应内容版本，不为去重覆盖历史 |
| 返回原会话 | adapter 保留或解析原来源的真实定位，内部引用经 adapter 找回对应外部会话；可访问程度沿来源实际权限，不因有内部 ID 就假定能打开私有正文 |
| 未解析与未知 | 必要来源范围或对应关系不明时明确保持未知，保存外部原值；不新造内部 ID 冒充已解析，不用同名、同设备或相似正文猜匹配 |
| 存储归属 | 映射、来源定位与同步去重的持久表达属于 adapter；具体使用值对象或独立存储由适配器实现评审决定，本核心字段文档不硬定表，不扩账号、设备或同步状态体系 |

旧 Hermes 混有 runtime、stored、conversation 等编号空间，确有需要时由该 adapter 使用已有来源设备、profile、编号类型和时间证据解释原值；这些不是所有来源都必须有的字段，更不是正常 Run 的信息副本。465 条 stored-session 引用精确匹配为 0 仍表示未解析，不表示会话丢失。现有 Run.sessionIds、Report.sessionId、Attempt.sessionId 与可信重试证据原值继续保留为兼容事实，不伪造解析结果。本轮只更新设计，不实施 Codex 数据接入、不读取其私有会话，不做映射迁移或运行时变更。

Event 与内容/执行快照保持实际发生/生成时间及已有生产来源，不加 updatedAt 与 updatedBy、网站发布或排列字段；缓存与心跳沿现有 generatedAt/observedAt/expiresAt 等具体含义使用，不套内容修订字段。

旧源正文/配置可保留私有不可变证据，公开仅通过允许投影；不创建或变更凭据。现有 commandId、LeaseRef、Delivery 回执、权限确认、取消与安全重试协议继续保留；此处没有重做基础设施实体。Template/Schedule/Event/NodeCapability/ApprovalRequest/Delivery/Alert 等继续按既有版本化 contracts.ts 使用，不为了网站字段设计另拆一套执行协议。

**按需来源追踪，不给所有表加 by（本轮待审）**：只有确实需要知道某段人工长期编辑内容从哪个操作渠道产生/修改，且不能从既有关系可靠追溯时，才考虑保存来源字段。可追溯时沿原关系读取，不重复存一份，也不因去掉冗余字段删除真实执行、确认或发布证据。

| 可选来源字段 | 类型 | 用途 | 默认与权威 |
|---|---|---|---|
| createdBy | 操作来源值?（待审） | 必要时说明长期编辑内容的初始创建来源，与更新来源分开；类型 + 可确认来源 ID | 默认不加；优先沿最初来源记录读取，初始事实不被 updatedBy 覆盖，未知明确 |
| updatedBy | 操作来源值?（待审） | 必要时展示最近一次内容修订来自哪个渠道，不是完整修改历史 | 默认不加；优先读取最新可靠内容修订来源；不可变对象不用此字段 |

本次只将创建与最近更新信息分开：createdAt 与 createdBy 表达初始创建事实，后续 update 不覆盖；updatedAt 与 updatedBy 只表达最近一次更新（latest）。这一字段调整不要求记录中间修改序列、完整历史、事件溯源或新增修订表；已有执行记录、不可变报告和材料版本/来源仍按原有需求保留。

| 对象 | 本轮逐表建议 |
|---|---|
| Project、Skill | 人工长期编辑内容可选来源追踪，用于解释初始撰写/最近修改渠道；已有修订来源能可靠回答时直接读取，不再加列 |
| Domain、Backlog、Milestone | 删除通用 createdBy 与 updatedBy 继承建议，默认不加；Milestone 的条件证据及具体确认记录继续保留 |
| Task、Run、Attempt、Workspace | 不新增通用 by；沿已有 Task 来源/父执行、route、Attempt、node、工作区及实际命令证据追溯，无法证明的发起者保留未知 |
| Report、不可变 Artifact、Event、内容/执行快照 | 保留真实生产/登记来源及不可变历史，通常没有 updatedBy；Report 来源沿既有 Task、Run、Attempt 读取，不新增作者字段或以未知来源冒充身份 |
| 关联、缓存、NodeStatus/heartbeat | 默认不加 createdBy 与 updatedBy；生产/执行关联已有必要来源继续保留，派生缓存/心跳不复制人员归因 |
| 确认、校验、发布、取消与回执 | 保留对应具体动作的必要来源/权威证据；这不要求给每个被操作实体再存一组 by |

这里是来源说明及适用对象索引，不是可复制到所有表的字段组；不新增通用审计日志系统；来源归因含义及是否实际保存仍待用户审阅。

**by 的来源归因解释（本轮纠正，仍待审）**：当前系统没有已建立的人员登录身份。此前“跨设备统一 actorId、API 自动认出认证人”的说明预设了尚不存在的能力，本轮撤回这一预设。只在需要时讨论 createdBy 与 updatedBy，其含义暂为“创建来源/最近修改来源”：只记录可观察且有依据的来源类型与可确认来源 ID，ID 不可确认时明确未知。类型与 ID 的最终名称/结构仍待审，不因此新增统一人员目录、账号/登录系统或认证字段集合。

- **authenticated node**：现有签名或受信网络验证能证明请求来自配置中的 nodeId，不能证明电脑前是谁，也不能仅凭 node 上报的 agent 名字证明独立 agent 身份。
- **claimed actor**：payload 中的姓名、账号、agentId 或“我是本人”若只是自报，只能保留为未验证声明，不能作为可信 by 或人工身份认证依据。
- **human identity**：没有可用的人员身份核验就不能确定实际自然人；同一电脑前换人、机器代人操作、agent 代账号操作，现有系统均不能靠来源字段识别。渠道账号验证也只确认该账号来源，不自动证明当时是哪位自然人使用。

无认证面板的操作可归因于“身份未验证的人工操作渠道”，不能写成某位已认证用户；受信渠道消息可记录提供方已验证的账号来源及作用范围；agent 只有在受信宿主将实际 agent/会话与来源连接绑定时才记录可确认 agent 来源，普通自报名称不够；内部自动流程记录实际 system/服务来源，不冒充人。来源 ID 复用已有可靠 ID，不按请求造出一个“用户 ID”；不能因同名、同设备或同消息内容把不同来源合成同一个人。

文中的“本人/人工确认”表示业务上需要明确确认动作，**不承诺系统已核实自然人身份**；判断记录必须说明来自哪个渠道及能证明到什么程度。已认证 node、agent 输出或执行成功本身都不是人工确认；无登录面板能记录通过该渠道提交的明确确认动作，但不能宣称是已登录本人，也不能检测电脑前换人。

执行设施继续复用互联模块的 nodeId、NodeCapability 与 NodeStatus：注册身份/能力由执行与互联服务管理，在线状态由已认证 heartbeat 及过期判断产生；Run.route.nodeId、Attempt.nodeId、Workspace.nodeId 已可关联逻辑节点。节点不是人员，也未等同物理 Device。by 记录来源不允许客户端注册设备、宣告在线或扩大执行权限。

**现有实现与讨论中方案的边界**：基线没有 createdBy 与 updatedBy，也没有人员登录/Actor 实体。远程网关用已验证的 peer.nodeId 写执行归属，拒绝 actor 覆盖；飞书适配从受信消息元数据记录 feishu:open_id:… 渠道账号。TaskLedger 的确认/整理 actor 仍是受信调用方传入的字符串，queueScopedNote 使用 nodeId，应按原证明范围保留，不能回填为已认证人。暂停中的管理 API WIP 只有可选 authorize/会话过期适配入口，实际未建立人员登录，也未把来源上下文传给 mutate 或保存这两个字段；来源归因是当前待审解释，不是已经实现或已获批准的新模型。

<a id="fields-physical"></a>
### 7.18 后置物理实现方案与少量关键默认

主图只表示实体与基数。推荐物理存储保留业务实体、必要 typed 关联和不可变历史，避免把所有关系都变成用户需要理解的新业务对象；也不因主图没画 junction 就把多对多降为单字段外键。

| 逻辑关系 | 推荐物理表达（待确认，不是已建表） |
|---|---|
| Domain ↔ Project、Backlog ↔ Task | 分类关联与推进需求的工作关联按实际用途校验；需要时保留背景或参与事实。可分别使用 typed 关联结构；BacklogTask 是实现名，不是额外业务实体，不为需求关联强加手动顺序或容器阶段 |
| Project ↔ Artifact、Skill ↔ Project、Artifact、Report | 保留端点版本、用途、背景和撤回历史的引用；物理组织二选一、仍待审：分开的 typed 关联结构，或共用受校验引用存储；不重复正文 |
| Artifact 的版本与产生/修改/反馈/反思 | artifactId 不可变版本记录 + materialId 分组 + 明确前后版本/来源关系；版本因果与执行归属约束不能只靠一个 latestTaskId |
| Milestone 的 Backlog、Task/材料选择与自关联 | 选定范围与版本化条件；自关联共用带 semanticTypes/达成依据的有向关系，不另建业务实体；保留无环与固定版本约束；标准和值结构可先按受校验 JSON 保存 |
| Project ↔ Workspace | 登记绑定与每节点默认标志；真实 provisioning/授权仍在执行设施 |

实体 ID/版本引用必须可核对；关联去重在相应端点/用途/有效版本范围内进行；旧关系撤回留历史。跨任务材料共享要在新 API 中分别校验“引用权限”和“原执行所有权”，不放宽现有结算的 LeaseRef/fence 检查。新增管理写入不能绕过已有 ledger 的幂等事务与回执，也不能靠物理 FK 推断执行许可。

本轮几个值得优先审阅的推荐默认：

1. Backlog–Task 支持多对多，常用创建流程可默认关联一项需求待办；不强制数据库单归属。
2. 保留 artifactId 作为不可变版本，新增 materialId 表示同一材料；来源与反思链可以跨任务、跨版本。
3. Project 可绑定多个设备 workspace，每节点最多一个默认绑定；业务绑定不创建目录或授予权限。
4. 新内容默认私有，公开固定已审版本；Skill 沿用个人能力含义，不设置熟练度评分。

其余表中推荐默认均已明确标注，供逐表修订，不要求用户对每个实现细节单独选择。数据库产品、Notion 同步与最终 SQL/JSON 组织本轮未实施；这份字段提案通过审阅后才能转成 schema/API 变更。

## 8. 旧 Hermes 只读事实与兼容结论

依据部署 owner 2026-10-04 的元数据研究；没有旧库正文、真实导入或旧库写入：

- [old-schema.json](/Users/pmp/Documents/Codex/2026-10-02/task/hermes-compatibility-20261004/old-schema.json)：结构、类型、行数，sampleContentsRead=false。
- [old-data-stats.json](/Users/pmp/Documents/Codex/2026-10-02/task/hermes-compatibility-20261004/old-data-stats.json)、[old-relations.json](/Users/pmp/Documents/Codex/2026-10-02/task/hermes-compatibility-20261004/old-relations.json)：统计与关联，bodyValuesIncluded=false。

| 领域 | 事实 | 兼容处理要求 |
|---|---|---|
| 项目 | projects=0，发现仓库 10；任务 metadata 无明确 project/workspace 归属键 | 先未归属；仓库发现不自动变成确认项目，不自动生成 Backlog |
| 任务与执行 | Task 614（273 root、341 child），树无环、深度 11；Run 605，每 Task 最多 1 Run、attempt 均 1；14 retry 中 9 个 followup Task | 保留稳定身份和完整树，不用新委派默认深度截断；followup 是真实旧 Task，不凭 attempt=1 推断没重试，也不擅自合并 |
| Session | VPS Session 487；465 stored-session 引用精确匹配 0（owner 结论） | 通过通用外部映射接入；旧来源兼容需要时限定设备、profile 与 ID 类型，正常 Run 不重复这些信息，未解析保持未知；不匹配不证明历史丢失 |
| 结果与材料 | 提交 208、协议 accepted 207；其中权威结果有 failed；附件 57 条/56 路径，文件均存在但记录 size 与文件体积匹配 0 | accepted 不等人工验收；保留结果/来源事实，区分标准化 payload 与文件字节校验；不据 size 差异判文件损坏 |
| 能力与调度 | 无明确个人能力展示语义（旧提案曾称 Method，现称 Skill）；旧 lease/status，2 个 active schedule | 不自动生成 Skill 或能力评价；租约/权限不生效；未来若获授权导入调度，默认禁用 |
| 时间与规模 | 时间 TEXT/INTEGER/REAL 混合；快照 tasks_json 合计 32,129,774 字符、单行最大 32,704 | 保留时间来源与单位依据；完整历史无法放入单个现有命令，未来分批导入 |

Session 精确匹配为 0、附件 56 个路径及 digest 作用对象区分沿用 owner 只读结论；以上 JSON 覆盖其余列出的结构/计数。

**兼容程度**：Task、Run、Report、Artifact 主体可复用，但需要补来源限定 Session、跟进任务关系、时间/校验语义和分批导入。Project、Backlog 归属要补录；材料的展示背景、完整过程反思以及 Skill 能力证据需要整理与复核，不能无损自动猜出。

没有执行历史导入、Task 合并、调度恢复或公开内容发布。当前只保留其约束，不给没有依据的迁移工时。

## 9. 当前实现状态与文档边界

- 原文档继续使用 `docs/DATA-MODEL-REVIEW.zh-CN.md`，未另建一份平行设计。
- 分支 `feature/multi-project-workbench` 的 HEAD 仍为基线 ece68974；main 未改。
- 9 个代码文件的未提交 WIP 已保留并备份，含早期 ProjectTaskLink/ProjectOutcome/Capability 等临时类型；它们不能反向规定当前概念。
- 仅第一轮后端 build 曾通过；后续 API/前端 WIP 未整体验证，没有可验收产品预览。
- 本轮在概念文档中将 Method 改为 Skill，并补字段审阅提案；未修改产品代码、合物理表、删除 Attempt、导入真实数据、迁移数据库或部署。

Sprint 保持用户已确认的暂不加入状态；其他未定项继续随用户讨论完善。物理关联表方案及独立 Output 包装不作为恢复产品的既定前提；字段表中的推荐值供审阅，不等于恢复实施的授权。

代码依据：基线 `packages/task-system/src/contracts.ts`、`ledger.ts`、`workspaces.ts`、`legacy-import.ts`，以及现有 `dashboard/server.mjs`、`dashboard/public/model.js`。
