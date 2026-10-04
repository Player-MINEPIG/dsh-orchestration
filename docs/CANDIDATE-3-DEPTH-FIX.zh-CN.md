# Candidate 3：真实 Template Claim 深度修复

## 原故障与范围

Candidate2 的真实二游 Template `resultContract` 本身深度17；包入 executionContext、Claim、持久回执后，现场回执为13,231 bytes、深度21。旧协议对所有层统一限制16，在 authority 已提交 Attempt 后拒绝回执；MBP 因此没有 dispatch、模型请求或结果 Report。原失败 Run 保留 uncertain，原数据和证据不动。

本修复不修改 schema 内容、数据契约语义、签名编码排序、byte limits、认证或执行权限。

## 同一有界合同

- 普通业务内容：input、trigger、Report.data、providerStatus 的 JSON 内容深度16
- Template input/result schema：内容深度24；结构化 schema 的 properties/items/allOf 层与业务数据分开计数
- 完整 envelope/receipt/client 与 worker SQLite 包装：共同 canonical encoder 的硬上限32，给 schema 留最多8层包装余量
- 数组256项、对象64键、非法键/非有限数字、已配置请求/响应字节上限及16 MiB总硬上限继续生效
- Template 创建、已持久化 Template 的 executionContext、接收端上下文与结果路径使用同一内容边界；Claim 在事务提交前校验实际三层回执/存储包装，超界回滚，不留下新 Attempt

两个 DSH 端点必须同时安装本次产物。旧 candidate2 consumer 仍按16层拒绝合法新上下文，不能混用版本。

## 验证与真实复测

新增 `tests/management/schema-claim.test.mjs`：通过外部私有源导出走 signed HTTP 与 trusted-network HTTP、回执重读、幂等重试、client/server/worker 数据库重开，最终进入真实 native NO_ADAPTER 系统阻塞路径。模型调用/Agent报告仍为0，不冒充游戏执行成功。现场脱敏回执只作只读编码样本，不能 seed/replay；它与原源导出均不加入本源码/发行包。

可复用原测试环境的已核实节点、工作区和网络绑定，但用新的独立验收数据库/Run；不要重新派发旧 uncertain Run、删除 journal 或手工补造 settle。原 candidate2 库、唯一 Attempt 与失败证据保持原样。授权现场执行线已确认 candidate3 的实际 VPS→MBP 单次 dispatch、最终 ACK、blocked/settled/acknowledged 持久结果，原因是 Agent 启动前的原生 NO_ADAPTER；没有模型调用或执行结果 Report。VPS 面板恢复与准确入口仍由该执行线交付，详见 TASK-MANAGEMENT-DELIVERY.zh-CN.md。
