# 看板反馈第二轮修订

基线da5cd12，执行GPT-6.1-Sol High。已完成整合与主会话复核。代码6ce7e07、cd5b626，整合构建与644项完整套件通过，643pass/1平台skip/0fail。随后收紧候选设备不作实际设备兜底，并按先push后部署继续。原dirty cwd源文件继续保留。

- 卡片时长按天、小时、分钟显示，省略零单位，不足1分钟明示；详情仍有秒。项目在任务标题上，未读独立，左下类型简写与真实执行记录的设备集合，右下时长。单个设备显示记录名，多个显示“多个”，无数据“未记录”。
- 工作流执行快照提示只读，可选节点、平移和缩放。当前定义点击节点与拖动分开，图及内部步骤可选。重复阶段表单与调用列表移到选中节点详情，保留修改阶段、执行设备、步骤、调用与输入映射能力。workflow_execution独占workflow-ui/page/editor tests。
- 工作流本已读取精确Report.data.presentation；项目报告投影此前仅body，因此HTML丢失。新接口getProjectReportPresentation按report ID及内容版本取HTML，默认快照只带hasHtmlPresentation，不带全文。任务入口和项目产物入口统一采用空sandbox、no-referrer及原工作流CSP，转义srcdoc。iframe加载且可见后才自动已读；读接口自身不写状态。Markdown报告版本算法不变，HTML版本包含presentation。
- 项目产物旧artifact别名曾回到task latest。现在节点保存taskId/runId/reportId，Task latest漂移仍显示原报告；补交note显示为执行材料，不误作最终报告。多最终输出按确切来源报告折叠预览，不预取所有历史。
- 本轮仅VPS调度端HTML入口。executor原Markdown能力和scope不变，未扩跨设备读协议。

验证checkpoint：98项局部测试通过，包含55页面、33runtime及递归用例。新版数据相同的单份300KB HTML样本，旧默认JSON投影3514B，新默认3541B，仅新增27B标记；按需返回300307B。均UTF8未压缩JSON，不是时延测试。错ID/版本拒绝，不回退latest；只获取内容不读，iframe可见前不读；HTML变化即使正文不变也产生新版本。

主会话操作合成预览4342，本执行会话view_image验收：evidence/dashboard-revision-cards.png、card-mobile.png、html-task.png、html-project.png。卡片深色和390px iframe无重叠，任务与项目两个入口的蓝底HTML可见。工作流三张workflow-node截图证明选中详情/步骤及只读提示，真实Chrome节点点击与拖动验证由workflow_execution执行。390px不等同实体触摸测试。

工作流模块b347003已整合为cd5b626，真实Chrome验证已由执行会话复核截图。后续部署状态见本轮上线回执。

## 发行身份修正

首次0.2.24候选安装被283文件哈希验证拦截，9个变更文件仍是上一版本。包与manifest自身一致，候选为独立普通目录，pnpm hoisted同名同版本报告Already up to date/added0。未进入备份或切换，生产未改。改用task-system 0.2.25区分发行，npm生成对应lock；核对所有依赖version/resolved/integrity及依赖关系未变，只有本插件版本变，其他差异为npm生成的依赖分类元数据。重新build与644测试643pass/1skip/0fail通过。
