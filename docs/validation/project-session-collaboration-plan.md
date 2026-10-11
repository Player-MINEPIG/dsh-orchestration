# 当前任务约定

路由：project-collaboration / writing-for-agents。

目标：`/project` 激活当前 DSH 会话的协作模式，由随插件发布的 skill 指导后续 agent 查询、派发、同步、提交；同一会话恢复后继续有效。保留协议历史补录和原任务面板。

基线：codex/project-runtime @ ab2bf26。独立分支 codex/project-session-collaboration，独立同名 worktree。

关键决定：中央现有任务数据库保存协作项目与节点/会话绑定；执行端仅保存本会话绑定和重试信息。官方动态 systemPrompt 接口加载 skill，插件工具注入会话身份并验证范围；模型不能自报任意项目权限。中央专用 authenticated operation 显式授权。完成上报仍待中央复核。

验收：官方命令激活不调用模型；随后自然语言请求触发真实 DSH agent 协作工具；VPS Tailscale 中央派发到 MBP，Codex gpt-6-luna/low；独立进程恢复同一会话后 prompt/binding/操作有效且不重复派发；未激活会话不受影响；历史补录回归；原面板显示项目/任务/来源会话/提交状态；通过后合并并更新 HTML 报告，检查其 body 实际内容。

隔离：默认 ~/.dsh、PV 原始目录只读；不访问 Hermes 生产数据库；新测试状态位于本 worktree .runtime 和 VPS /root/dsh-orchestration-tests 下。无 SSH 转发，SSH 仅部署隔离测试文件。

分工：runtime_adapter 中央服务/remote协议；registration_commands 本地会话/命令/skill；management_ui 原面板状态；root 接线、真实联调、审查与合并。各文件修改范围互斥。

当前进度：实现和完整本地check通过（825项：820通过，5跳过，0失败）；distribution与official settings通过。初次真实激活及agent同步成功，但测试客户端序号库分离、心跳缺字段导致派发失败，已修测试配置。随后VPS同时出现Tailscale/SSH超时，尚无成功Codex执行或恢复验收，禁止合并。原面板真实离线命令误导sync文案已修复并实拍验收。

最终本地审查：两项P2均已修复并经独立复核；authority 8/8，最终session/原面板/feedback目标回归15/15。实际会话在独立进程inspect恢复skill成功，modelCalled=false。VPS Tailscale ping、43971 HTTP、公网与Tailscale SSH均多次超时；最后一次检查仍未恢复。在线真实执行与双端面板验收未完成，未合并，不能宣称整体交付完成。

接续：先检查VPS恢复；只检查本轮run1的coordinator/UI进程，不重启整机或生产服务。重新打包最新dist，更新隔离run1并启动；所有MBP进程共享conversation-remote.sqlite。测试session默认session-collaboration-real-v2尚未开始，旧失败证据保存在evidence/failed-initial-attempt。先确认worker心跳成功再运行conversation start；两Codex Run结束后conversation resume。完成原面板在线验收，更新报告并最终合并codex/project-runtime。
