# 看板第二轮修订部署回执

2026-10-18 已先push、再部署 `b63fadd49dd4151b2aec133c6105076e1392ceec` 到 aliyun-vps。远程为 `origin/codex/dashboard-feedback`，包为 `@dsh-task/task-system@0.2.25`。HTTPS返回200，线上283个安装文件全部匹配构建清单。完整字段见[机器回执](dashboard-refinement-20261018.json)；[上一轮回执](dashboard-feedback-20261018.md)保留为历史。

## 本次变化与验证

卡片项目名放在任务名上，类型简写，实际单设备显示名字、多设备显示“多个”，没有实际记录显示“未记录”。卡片时长只显示非零天、小时、分钟，不足一分钟明确提示；详情保留秒。工作流当前定义修正点击与拖动判定，阶段与内部步骤可以切换详情；重复表单移到选中节点详情，编辑能力保留。执行快照提示只读节点选择、平移和缩放。

VPS任务、项目产物与工作流采用相同的HTML沙箱策略。项目与任务按指定报告ID和内容版本懒加载，产物节点固定Task/Run/Report，错误或旧版本不回退latest。读取接口不记录已读；报告真正可见后才记录对应版本。执行端原Markdown协议不扩展。

构建及完整套件通过：644 tests，643 pass，0 fail，1 skip。跳过现有macOS 127.0.0.2别名测试；拒绝行为仍有verifier覆盖。实际300KB HTML合成样本的UTF8未压缩JSON：默认投影由3514B变3541B，只新增标记；HTML正文按需返回300307B。此为同一样本大小，不是网络时延或全RPC性能测量。合成桌面深色与390px iframe、任务与项目HTML入口及工作流节点交互已验证；390px不是实体触摸测试。

## 发布过程

首次沿用0.2.24的独立候选安装出现同名同版本缓存：9个文件仍为旧内容，安装文件哈希拦截阻止切换，生产未改。随后采用0.2.25独立发行身份，源码/lock/build/包/远端一致且已push，再安装候选，283文件全部通过。

UTC09:25:34完成备份。09:26:06.065停止原服务，09:26:07.534激活候选profile，09:26:07.554请求启动；墨尔本时间20:26。上述时间不代表直到页面就绪的耗时。09:27:00只读RPC验收成功。PID1419804，active/running，自动重启0。启动日志7行、0 error；两条warning匹配行来自同一Node SQLite实验特性提示及trace说明，没有任务插件错误。只替换任务插件，DSH runtime仍0.2.1-rc.2；代理、模型、设备容量、执行目录、其他插件和原配置保留。

切换前19个会话无运行，本机队列及活跃Run/Attempt为空，项目轮次、remote dispatch/outbound为空，13个program dispatch已acknowledged。Codex未启用，无其数据库或进程。没有对真实任务发起执行。

62个Task、99个Run、91个Attempt、92份Report及4个Schedule保持；七类业务实体、十二张计划/项目/目录/阅读/呈现表逐行哈希一致，38个原会话文件不变。验收没有代用户阅读、验收或改变展示，阅读/呈现表仍为0行。

实际服务返回项目页及工作流页哈希匹配新包。workflowView摘要不带output，选中非latest历史的三个步骤保持精确Task/Run/Report与完整output。按需HTML接口返回精确报告的10093字符HTML，默认报告投影不带HTML正文，读取本身未写阅读事实。生产浏览器卡片显示项目名在标题上方、周期任务/PC_AU、多个、6小时33分钟，无秒。工作流历史快照只读提示正确；切换编辑定义后，点击VPS阶段，详情由MBP切至VPS，图下重复表单消失。仅查看，没有编辑、保存、执行或打开真实报告；截图与逐项结果记录在机器回执。

初始插件加载慢在部署前已出现，偶发连接丢失仍未定位，不宣称已修复。

## 备份与回滚

备份在 `/opt/dsh-production/releases/dashboard-feedback-b63fadd/backup`，含profile、38个会话文件、四个SQLite一致备份与quick_check、停服数据库副本、systemd定义。旧profile保存在 `/root/.dsh/profiles/web.dashboard-b63fadd-before`。

确认会话、任务及Codex空闲后，可运行：

```sh
python3 /opt/dsh-production/releases/dashboard-feedback-b63fadd/rollback.py --confirmed-idle
```

脚本恢复旧profile并重启原服务，保留当前数据库。不要用旧数据库覆盖上线后产生的新业务数据。此次只部署aliyun-vps，没有更新MBP或PC_AU。
