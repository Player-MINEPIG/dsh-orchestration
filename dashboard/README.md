# DSH 任务 WebUI

同一套 `TaskLedger.snapshot()` 查询的可移植界面；原看板默认只读，新增可选私有管理页。前端无框架依赖，可在 DSH、普通 Node 宿主或私有静态托管使用；不建立第二个任务数据库。

## 本地实时查询模式

Node 24+；从 monorepo 根目录先执行 `npm run build`。已有核心 ledger 后：

```sh
node dashboard/server.mjs --ledger .runtime/tasks.sqlite --port 4317
```

DSH 插件当前默认 `databasePath` 为 `.dsh-task/tasks.sqlite`。正式挂载时，必须把它显式配置为与 WebUI `--ledger` 相同的绝对路径；本次真实记录位于 `project/.runtime/tasks.sqlite`。这两个入口不能各自误用不同默认库。

服务只绑定 `127.0.0.1`，只接受 GET / HEAD，数据库以 read-only 模式打开。查询路径是 `/api/snapshot`。每 15 秒读取 ledger；这只是轮询记录，**并不代表上游执行器重新确认了进度**。活跃任务超过来源定义的阈值会显示“待刷新”。

当前云环境的 remote CDP 浏览器不能打开 shell 的回环服务：尝试返回 `ERR_BLOCKED_BY_CLIENT`。不能据此承诺云桌面入口或手机直连已可用，也不要禁用安全限制或开放端口解决。`launch-dashboard.sh` 保留给正常本地主机使用，不依赖 Sites。

## DSH / 已认证宿主挂载

`server.mjs` 导出 `createDashboardHandler({snapshot, basePath, authorize})` 与 `createDashboardServer()`。宿主在生命周期中挂载/卸载 handler，并调用自己已有的 Task Service 查询：

```js
const handler = createDashboardHandler({
  basePath: '/tasks/',
  snapshot: () => taskService.snapshot(),
  authorize: async (request) => Boolean(await existingHostSession(request)),
  accessLabel: 'DSH 任务视图',
  accessDescription: '已认证宿主 · 只读'
});
```

`authorize` 不是自带认证功能；它必须验证宿主现有、已授权的会话。缺省仅允许回环连接与回环 Host。不要把恒为 true 的示例挂到公网，不生成新凭据，不在前端放 token。前端默认同源请求；宿主可用 `config.js` 改 `apiBase`、只读标签、刷新间隔，或用同源反向代理适配其他后端。

支持非根 base path，如 `/dsh/tasks/`，所有资源与 hash deep link 保持相对路径。页面无需 CORS。

## 私有静态快照模式

在保持同一 ledger 的前提下导出前端和读取投影：

```sh
node dashboard/export.mjs --ledger .runtime/tasks.sqlite --out /path/to/private-site/dist
```

这不是实时服务：顶部与每个详情页显著显示“只读快照”和来源截至时间，禁用自动轮询，不因打开/刷新页面而更新证据时间。后续更新需要从**同一 ledger**再次导出并更新同一个私有站。静态文件包含私人业务任务，必须使用经过验证的 owner-private 托管；不能把 `dist/` 公开发布。

Sites 是可选交付适配器，不是框架依赖。私有站源码位于 monorepo 外的专用站点目录，`.runtime/` 内的 SQLite 和原始导入文件不进代码包。

## 显式接入现有任务

操作员可调用核心导入接口；原只读看板没有导入写入口：

```sh
node dashboard/import.mjs --source path/to/explicit-import.json \
  --command unique-stable-import-id --ledger .runtime/tasks.sqlite
```

导入使用核心 `TaskLedger.importSnapshot()`，每批稳定 command ID 保证相同重放幂等；报告、产物和修订继续保留。不从隐私笔记、系统提示或原始会话自动抓取任务。不知道的 Run / Session / 模型不补造。导入记录的创建时间与原任务未知创建时间须区分；`updatedAt` 保留实际观察时间。工作区登记仅描述已观察到的路径，**不授予执行或路径访问权限**。

## 当前界面

- 任务搜索、状态筛选、单任务概况与事件历史
- 默认排除 `admissionState=dismissed` 的任务及其全局执行/报告/调度列表；“显示已排除任务”开关可查看保留历史，计数随查看范围变化
- 收录状态与生命周期分别显示；取消查看筛选、追加新报告或打开详情都不会恢复任务。旧快照缺少收录字段时保持默认纳入兼容
- 同一任务多次 Run、多 Session 的多份 Report 与显式修订关联
- 产物版本/文件校验信息；不把未知或私有下载地址伪造成公开链接
- 核心已注册模板和调度的只读查看；暂无配置时诚实显示空态
- 断线保留最后成功读取的内存数据，明确报错；不在浏览器持久保存私人记录
- 空态、未知来源、深链接、键盘焦点、窄屏自适应和减少动态效果

## 后续更新

见 [UPDATE.md](UPDATE.md)：用 `record-status.mjs` 对同一 observed 任务追加真实状态报告，再从同一 ledger 导出并更新同一个私有 Site。

## 验证

```sh
npm test --workspace @dsh-orchestration/dashboard
```

测试覆盖共享模型、报告跨 Session 保留、过期证据不被轮询刷新、过滤、XSS/URL处理、只读 HTTP、静态文件白名单、DNS rebinding 防护、宿主鉴权、非根路径、敏感运行配置剔除和数据源故障。浏览器/移动视觉测试的结果另记，不把接口通过当作视觉通过。

可选 DOM 交互检查（不等于视觉验收）：设置 `DSH_DOM_TEST_MODULE` 为已安装的 `linkedom` 模块路径，运行 `node dashboard/qa/curation-dom-smoke.mjs`。该检查只使用合成测试数据。
# Private VPS live deployment

For a prepared Cloudflare Access origin, see [deployment handoff](deploy/README.md) and the [real browser acceptance checklist](qa/live-browser-checklist.md). `live-server.mjs` adds signed owner authentication while staying loopback-only. It reads the same existing TaskLedger and does not create a new data store. `server.mjs` remains the local preview entrypoint.


## 私有任务管理页（独立验收库）

新页面是 `manage.html`，原 `index.html`、静态导出和 live-server 默认继续只读。管理页面读取 `/api/workbench`，使用同一个 TaskLedger SQLite 与 Workbench 的管理表，不创建第二套执行账本。隔离验收启动方式见根目录的验收脚本说明；浏览器顶部必须能看到 **databaseId、label、数据库绝对路径**，不能把 VPS 8443 原看板当作此库的执行证据。

管理能力：

- 新建和按 revision 编辑 Domain、Project、需求侧 Backlog、Task
- Domain–Project、Backlog–Task 多对多关联和解除关联；跨项目任务按 taskId 去重
- 明确 Task override / 关联需求最高优先级 / normal 的来源，不保存派生优先级
- 按 Task 查看 Run、实际 Attempt 节点 / executionId / sessionId / fence、结果报告、失败事件和材料引用
- Run.route 显示计划归属；实际归属仅来自 Attempt；Session 列使用 ledger 从 Attempt 和显式上下文关系派生的结果
- 显示 partial、固定模板引用、轻量意图快照、报告结构化 data/schemaId；不在新视图暴露 admissionState / admissionRevision、Run.outcome / validation
- 完成条件可用 JSON 数组编辑，例如 `[{"description":"核实真实运行结果","kind":"manual_check"}]`；条件观察只读，空条件不会完成，内容保存不表示人工验收

管理页不提供执行路由、Run 状态、租约、权限、凭据、调度开关或人工确认伪造入口。真实派活仍由既有 DSH 执行协议处理。

### 同源宿主接入

```js
import {TaskLedger, Workbench} from '../packages/task-system/dist/index.js';
import {createDashboardServer} from './server.mjs';
import {managementAdapter} from './management.mjs';

const ledger = TaskLedger.open(explicitIsolatedDatabasePath);
const server = createDashboardServer({
  snapshot: () => ledger.snapshot(),
  management: managementAdapter(ledger, new Workbench(ledger)),
  databaseIdentity: {
    databaseId: existingAcceptanceIdentity.databaseId,
    label: existingAcceptanceIdentity.label,
    path: explicitIsolatedDatabasePath
  },
  localRole: 'manager', // Explicit loopback operator capability, not a verified human identity
  accessLabel: '隔离验收库',
  accessDescription: '仅本机 · 私有任务管理'
});
server.listen(4317, '127.0.0.1');
```

需要挂到已有认证宿主时，`authorize(req)` 必须验证现有会话后由**服务端**返回 `{role:'manager', expiresAt}`；未授予 manager 的有效会话只能读。必须同时设置固定的 `managementOrigin`（如既有私人宿主的 HTTPS origin），并沿用 `requireSessionExpiry:true`。原 Cloudflare Access 适配器只返回期限，默认不会因此获得管理能力；不要从请求头、payload actor/role 或同名节点推断管理权限。此工作没有创建账号、登录系统或凭据，也没有改原 live-server 部署。

`POST /api/manage` 的 body 为 `{commandId,operation,data}`。服务检查 manager role、精确 Origin、同源 Fetch Metadata、`X-DSH-Management:1`、JSON Content-Type 和 256 KiB 上限；没有 CORS 放行。管理操作只在明确 allowlist 内，Task 表单不能写 policy、路由和执行状态。命令沿用持久幂等回执；更新用 expectedRevision，过期修订返回 409。客户端重复点击禁用保存，连接中断保留原 commandId 供同一表单重试；取消后不会隐式写入。

### 验证边界与本机 UI 验收

自动测试：`node --test dashboard/tests/*.test.mjs`（需先 build 核心）。管理 HTTP 测试创建独立临时文件 SQLite，验证 CRUD、关联、重启读取、幂等、并发冲突、角色/CSRF、真实 ledger 失败结算与 Attempt/Report 投影。它们是合成自动回归，不能代替 VPS → MBP 的真实执行验收。

云浏览器无法访问当前 shell 的 loopback，未进行渲染/真实交互验收。交给已授权本机执行线检查：

1. 启动指定独立验收库，打开 `/manage.html`，核对顶部 DB 身份；宽屏与手机宽度下查看内容和表单
2. 新建领域 → 项目 → 一项需求 → Task；建立多对多关联，编辑并刷新，关闭/重启服务后核对仍存在
3. 明确 override、清除 override、多个需求最高优先级；同一 Task 跨项目不重复成新任务
4. 两标签页编辑同一修订，后提交者收到冲突；保存期间重复点击、网络中断后重试不产生重复记录
5. Close / Cancel / Escape 不写入；前进/后退不重新提交；刷新/自动轮询不覆盖打开表单；会话到期隐藏记录
6. 从真实 VPS → MBP 运行找到对应 Task，核对 Run.route 与 Attempt.nodeId / executionId / sessionId、失败报告和数据来源；缺脚本必须显示真实失败
7. viewer 没有写按钮，直接调用 POST 也被拒绝；现有只读看板仍能访问

原生适配器的启动前失败：仅在持久事件 `run.pre_dispatch_failed` 明确记录 `origin=native-adapter`、`phase=before-agent-start`、`code=NO_ADAPTER`，且与该 Run 的实际 Attempt、节点和计划 provider/model 对应时，管理页显示“模型调用与工作尚未开始”，采用事件 summary 说明原因。该路径允许 Run=blocked 且没有模型结果 Report；预先保留的内部 sessionId 只显示为预留引用，不证明 native session 已创建。开始后的未知失败、MISSING_CREDENTIAL 或缺少报告本身都不能推出“尚未开始”。
