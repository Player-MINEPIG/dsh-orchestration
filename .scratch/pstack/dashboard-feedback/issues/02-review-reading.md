# 02：完成、验收、阅读（反馈4/5）

Blocked by: None。Status: implemented / locally verified。

用户最终选择根交付主列表、子树在详情；旧“父Run合并主列表”候选被取代。只读生产证明三旧子和精确父当次均partial，根卡取另一个latest成功；不伪造验收。旧pending/rejected Run汇总在父详情，即使同子Task新Run成功也不清除；普通失败成功重试不会永久催办。

持久阅读绑定report ID+内容版本；正文可见才写，失败不清除，重开运行时仍保留，其他旧报告未读不被连带清除。主未读计数只面向主列表交付，完整记录仍查询全部。阅读不调用review/approve。成功backend默认不再强制人工review，仅pending显示待验收；已有终态验收不可覆盖。生产数据未改。
