# 04：任务协作归属与展示（反馈8及4入口）

Blocked by: None。Status: implemented / locally verified。

项目详情移除子任务协作树；任务/执行详情保留精确parentRun递归证据、Attempt、会话。调度主列表默认根交付，workflow内部和其他历史子任务回收至详情。明确子交付可用本地呈现元数据可逆提升，不改执行policy或授权。完整面板保留包括内部step记录；executor既有授权范围不扩大，原树仍可见。循环/缺失引用终止，历史Run不串latest。父卡保留真实未决摘要入口。
