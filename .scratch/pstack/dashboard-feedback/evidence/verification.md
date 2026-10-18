# 最终验证（2026-10-18）

- Node 24：`npm run build -w @dsh-task/task-system` 通过；内联项目/工作流脚本在构建时语法校验。
- `node --test --test-reporter=tap packages/task-system/test/*.test.mjs packages/task-system/test/remote/*.test.mjs`：632 tests，631 pass，0 fail，1 skip。跳过现有 macOS 127.0.0.2 源IP测试（无loopback alias）；verifier tests仍覆盖拒绝逻辑。日志 dashboard-final-suite.log。
- 最近单元补证53/53：project-runtime + workflow-editor，日志 dashboard-final-focus.log。
- `git diff --check` 通过。

关键回归包括：独立分页/过滤；展开项目图→节点详情→快照改变poll→关闭仍展开；451节点末端可达；自动已读仅实际可见正文且固定版本，失败可重试，旧报告状态持久；根交付默认+显式子交付+完整记录+executor树；同子Task旧pending partial不被后来成功消除，普通无review failure重试成功不永久报警；成功不强制验收，已accepted/rejected不覆写；未绑定步骤所有启动入口在副作用前拒绝；真实21次工作流历史首Run可查；workflowView未知ID不泄露、executor拒绝；跨页精确旧Run/report不回退task latest。

视觉由主会话操作浏览器取得，本执行会话逐图查看：final-main/unread/read-detail/mobile/mobile-page2。已读从1→0、未读筛选为空由主会话实际点击验证。mobile为390px iframe，不是实体触摸设备；graph截图是早期同图结构checkpoint。线上仅只读调查，无稳定按钮断连复现，不能用此测试证明线上偶发断连已修复。

2026-10-18用户授权后已部署aliyun-vps。线上283文件与两页面hash匹配，workflowView/历史三个步骤引用和记录保全通过。验收不写报告阅读事实，详情见docs/validation/dashboard-feedback-20261018.json。

## 第二轮修订最终验证

0.2.25构建通过；完整套件644 tests / 643 pass / 0 fail / 1 skip，原因同上。日志dashboard-refinement-release-{build,suite}.log。本轮新增卡片分钟、真实设备、lazy HTML、精确artifact、错版本拒绝及可见读取行为；工作流节点点击/拖动与详情整合有真实Chrome补证。线上只读发布证据见docs/validation/dashboard-refinement-20261018.json。

## 第三轮修订（0.2.26）

整合workflow模块f447709与项目页详情重排。构建通过，完整649项648pass/0fail/1既有平台skip。最终恢复提示与select右间距文案调整后再build+67页/递归测试通过。root真实UI验证Task/Run/项目/390px模块层次、按钮间距与workflow分区；执行会话查看截图。真实Chrome旧页同已读报告失败且全局snapshot也gateway/internal；单次刷新后同报告HTML恢复，读取状态未新增。官方SDK动态取当前connection，故不加入猜测性remount；底层断线触发条件未定位。预览保留安全错误分类及恢复提示，原Run/version重试有回归。

项目结果摘要补正后的最终构建/完整套件：650 tests /649 pass /0 fail /1 skip，日志dashboard-revision3-final-suite.log；68项页/递归用例通过，精确report、最多5、内部过滤和零读副作用覆盖。
