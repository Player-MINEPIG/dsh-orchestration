# 05：工作流与断连（反馈9/11）

Blocked by: None（本地增量）；线上偶发断连根因仍未定位。Status: model/navigation implemented, disconnect unresolved。

复用阶段模型，独立stage occurrence支持VPS→MBP→VPS；起止派生，不加入执行节点。抽象步骤允许未绑定保存；直接/任务/定时入口在root等副作用前拒绝，运行时缺失预检fail closed。Agent自然语言仍可用；真实循环本轮不做。

计划步骤带workflowRun/step/task/run/report精确引用；跨页consumer按指定旧Run报告显示，不能fallback latest；超过快照20条仍getRunView读取，missing明确不可用。workflowView沿用planner/both权限，未选历史省略正文，选中保留完整证据，未知ID NOT_FOUND。

只读线上观察过connection lost/gateway错误但按钮后来打开，服务未循环重启，无可归因后端堆栈。有限摘要投影仅减载：同9条历史UTF8 JSON完整5,955,333B、默认69,192B、选中最新714,830B；不是全RPC或时延测试，不称断连修复。
