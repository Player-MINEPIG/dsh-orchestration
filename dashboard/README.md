# DSH 任务 WebUI

同一套 `TaskLedger.snapshot()` 查询的可移植、只读界面。前端无框架依赖，可在 DSH、普通 Node 宿主或私有静态托管使用；不建立第二个任务数据库。

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

操作员可调用核心导入接口；WebUI 没有写入口：

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
