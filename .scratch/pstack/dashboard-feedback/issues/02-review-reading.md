# 02：完成、验收、阅读（反馈4/5）

Blocked by: None。Status: implemented / locally verified。

用户最终选择根交付主列表、子树在详情；旧“父Run合并主列表”候选被取代。只读生产证明三旧子和精确父当次均partial，根卡取另一个latest成功；不伪造验收。旧pending/rejected Run汇总在父详情，即使同子Task新Run成功也不清除；普通失败成功重试不会永久催办。

持久阅读绑定report ID+内容版本；正文可见才写，失败不清除，重开运行时仍保留，其他旧报告未读不被连带清除。主未读计数只面向主列表交付，完整记录仍查询全部。阅读不调用review/approve。成功backend默认不再强制人工review，仅pending显示待验收；已有终态验收不可覆盖。生产数据未改。

## 2026-10-18 HTML报告修订

报告data.presentation此前只在工作流页读取；项目投影未含HTML。现在快照只含可预览标记/固定内容版本，指定report ID+版本按需取HTML，空sandbox+既有CSP。任务详情及项目产物节点均精确定位Run/report；HTML iframe加载并可见才自动读，读取接口本身不写已读。多最终输出按来源报告折叠加载，不拉全量历史。执行端保持原Markdown能力，本轮不扩大远程读协议。
