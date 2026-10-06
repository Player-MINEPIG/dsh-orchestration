# VPS WebUI 手机入口与插件布局验收（2026-10-06）

已在现有 VPS planner profile 启用官方 DSH WebUI，使用已有任务账本、模型配置和凭据引用。入口通过现有 Tailscale 网络的专用 HTTPS 端口反向代理到 loopback，并配置精确 trustedHosts；保留其他代理入口。systemd 服务已启用，最终检查 active、重启次数 0。手机须登录同一获授权的 Tailscale 网络；完整首次登录链接单独交付，不进入仓库。

## 实际问题与修复

- 非 loopback 浏览器的官方共享 configForms 使用内存作用域，原任务页因此不显示。客户端专用作用域使用现有公开 Settings API，只读写 task-system 六个运行字段；精确 revision、范围和字段校验仍由宿主执行。
- 窄屏设置对话框的固定左导航挤压正文。任务页改为横向换行导航、可换行详情和按钮、限宽输入及 44px 触摸控件。桌面保持原布局。
- 部署过程中 YAML 1.1 解析将字符串 off 转成布尔值，导致插件加载失败。保存为 JSON（兼容 YAML 1.2），恢复思考强度字符串，最终任务页和真实聊天均复核通过。
- Web orchestration persona 使用组合模式，保留任务插件原生的优先派发指令；最终会话日志验证 task_nodes、task_plan 声明和优先调度执行端的系统提示均存在。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| 设置、启动、决策与远程作用域回归 | 50 tests，通过 |
| 官方 Loader / Settings / Gateway 宿主 fixture | 13 checks，通过；无模型网络调用 |
| 官方 SettingsFormModel 草稿 fixture | 6 checks，通过 |
| VPS HTTPS 首次登录 | 成功交换 cookie，并跳转到无 token 的根路径 |
| 真实远程 GUI 保存 | 并发上限 1→2，保存后读取为 2；清空并保存恢复有效值 1 |
| 真实布局 | 320 / 390 / 430 / 768 / 1280px，页面无横向溢出；正文宽度分别 235 / 305 / 345 / 479 / 559px |
| 决策模型表单 | 320 / 390px 下选项、输入和操作按钮可见且无越界 |
| 最终真实模型调用 | 新会话使用 DeepSeek Flash / Off，成功回复“VPS调度界面已就绪。”；未调用工具或创建任务 |

布局检查使用真实 Chrome 页面和视口模拟，未声称已在物理手机或 Safari 上测试。原部署故障期间创建的旧测试会话在后续添加工具时触发官方宿主的全延迟工具声明错误；最终完整配置的新会话正常。新请求应从新会话开始。

本次保持 schedulerEnabled=false、autoExecute=false，远程操作 paused=true；没有为了手机访问开启任务领取。前一轮双端真实派发验收独立记录于 AD-HOC-DISPATCH-20261006.zh-CN.md。

截图、几何数据、测试日志与打包文件保存在本地忽略目录 `.runtime/mobile-webui-20261006/`。登录链接和部署绝对路径只保存在私有交接材料中。
