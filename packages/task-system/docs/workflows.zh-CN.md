# 设备工作流

侧栏“工作流”提供设备连接图和设备内部步骤。定义保存为版本；每次运行固定当时的定义与输入，编辑不会改变已开始的运行。

## 创建与运行

1. 新建工作流，加入需要的设备。只有一台设备时，整个流程在该设备内执行。
2. 在设备内部加入程序、脚本或 Agent 步骤，选择已登记的工作区。
3. 为步骤指定依赖，并把输入绑定到固定值、此次工作流输入，或上游步骤的结构化输出字段。
4. 保存后手动运行；验证通过再开启定时触发。

设备间箭头由步骤依赖生成。`VPS → MBP → VPS` 是有效路径，只要具体步骤没有循环依赖。离线或状态未知的设备变灰，相关路径显示虚线；尚未派发的步骤等待设备恢复。设备掉线不代表已经领取的程序停止，系统保留不确定状态，避免重复执行有副作用的工作。

## 程序与 Agent

程序由已安装插件注册固定 ID 和版本，由执行器直接调用。程序步骤只引用已登记的入口与版本。插件可在注册函数中调用自己的采集器、解释器或模板渲染程序，安装与更新仍使用原有插件分发方式。

```js
ctx.effect(() => ctx.taskSystem.programs.register({
  programId: 'example.transform',
  version: '1',
  title: '转换结构化数据',
  inputSchema: {type: 'object', properties: {text: {type: 'string'}}, required: ['text']},
  execute: async ({input, signal, workspacePath}) => ({
    summary: '转换完成',
    data: {text: input.text.toUpperCase()},
  }),
}));
```

Agent 步骤使用已授权模型、工具及真实 Task 会话。小输入可直接提供；大量来源应选择“通过工具读取”，由 `workflow_input_read` 或业务插件提供分页工具。输入仍完整保存在运行记录中，不把整份来源塞入初始提示。业务插件通过当前所属执行的 `configuration.input` 访问固定输入。

## 直接执行脚本

在步骤执行方式中选择“脚本”，填写可执行文件和 JSON 字符串数组参数。可执行文件使用设备 PATH 中的名称或绝对路径。脚本文件可作为参数使用所选工作区下的相对路径。命令固定在该次运行的定义中，上游输出和工作流输入不能改变命令。参数不经过 shell 展开。

设备操作者需在任务系统插件配置中设置 `scriptExecutionWorkspaces`，其含义是“允许执行脚本的工作区”。默认空清单不允许任何脚本执行。这项授权独立于默认工作区、会话注册和 Agent 工具清单。设备还必须启用执行能力、提供宿主 `subprocess` 服务，并保留原有工作区根目录及远端访问授权。没有脚本授权的工作区仍可按原有授权运行其他程序。

下面的步骤在 `aws-vps` 的 `daily-reports` 工作区执行 `scripts/render.py`。

```json
{
  "stepId": "render",
  "title": "生成报告",
  "nodeId": "aws-vps",
  "workspaceId": "daily-reports",
  "dependsOn": ["collect"],
  "inputs": {
    "source": {"kind": "step-output", "stepId": "collect", "path": []}
  },
  "execution": {
    "kind": "script",
    "executable": "python3",
    "args": ["scripts/render.py"]
  },
  "maxRetries": 0
}
```

stdin 收到一份 JSON，写入后关闭。`input` 只包含该步骤显式绑定的字段。上例通过 `input.source` 读取上游输出。其余字段是 `nodeId`、`workspacePath`、`taskId`、`runId` 和 `executionId`。执行目录始终来自该步骤的工作区，与发起会话所在目录无关。

stdout 必须只写一份结构化结果，日志写入 stderr。

```json
{
  "summary": "报告已生成",
  "data": {"items": []},
  "title": "日报",
  "body": "报告正文",
  "outcome": "success"
}
```

`summary` 与 `data` 必填。`title`、`body` 和 `outcome` 可省略。`outcome` 支持 `success` 或 `partial`。HTML 预览放入 `data.presentation`，格式与程序结果一致。stdout 超过 2 MB 时终止脚本。非零退出、无效 JSON 和结果契约错误均显示为步骤失败，退出失败保留 stderr 尾部诊断。取消通过宿主进程管理器终止脚本并等待清理，然后沿用任务取消结算。脚本没有额外的总运行时限，失败后只能按现有程序步骤规则手动重试。

脚本必须已存在于执行设备，工作流编辑器不上传脚本。脚本需要访问的外部来源、凭证和产物保存方式由操作者配置，不从上游数据自动获得权限。

## 结果与恢复

每一步复用任务系统的领取、租约、回执和恢复机制。程序不调用模型；Agent 失败重试复用该步骤的 Task 会话，并收到上次失败原因。只重试已确认停止的失败执行，不重做已完成的上游步骤。自动重试最多 5 次，可按步骤设置；人工重试独立于自动预算。不确定状态需要核实原执行，不能直接重放。

部分交付可向后续步骤传递有效数据，整个流程仍保留部分交付状态。上游失败或不确定时，下游显示阻塞。输出通过 `report.data` 传递，缺少结构化输出会明确失败。

HTML 报告可放入输出的 `presentation` 字段：`{mediaType:'text/html',templateVersion:'...',body:'...'}`。界面在禁用脚本的 sandbox iframe 内预览，另保留结构化数据供核对。

当前执行历史面板展示最近 20 次运行；账本保留之前的记录。本版不提供任意循环、条件分支和脚本在线上传。
