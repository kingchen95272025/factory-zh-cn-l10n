# Factory 简体中文术语与翻译规范

本文件是翻译与审校的唯一术语基准。所有译文必须遵循这里的约定。

## 1. 绝不翻译（原样保留）

| 类别 | 示例 |
|---|---|
| 产品名 | `Factory`、`Droid`（句首也保留大写 D）、`droid`（CLI 命令时保留小写） |
| 技术标识 | 命令、文件路径、URL、环境变量、API 名、模型名、仓库名 |
| 快捷键 | `⌘K`、`Shift+Tab`、`Esc`、`Ctrl+N` 等 |
| 占位符 | `{{count}}`、`{{name}}`、`{{version}}`、`$t(key)`、`<settingsLink>…</settingsLink>` |
| 代码片段 | 反引号包裹的内容、`spec`、`PR`、`MCP`、`API`、`CLI`、`JSON` |

## 2. 核心术语表

| 英文 | 中文 | 说明 |
|---|---|---|
| Session | 会话 | 一次与 Droid 的对话/任务 |
| Mission | 任务 | 旧一代多步骤自主任务 |
| Workstream | 工作流 | 新一代多智能体协作项目；与“任务”区分 |
| Automation | 自动化 | 定时/触发型任务 |
| Agent | 智能体 | 不译为“代理” |
| Orchestrator | 编排器 | 工作流中负责任务拆分的智能体 |
| Droid Computer | Droid 计算机 | 运行 Droid 的机器 |
| Remote Control | 远程控制 | 产品功能名 |
| Fleet | 设备集群 | 多台机器的集合 |
| Workspace | 工作区 | |
| Worktree | 工作树 | Git worktree |
| Repository / Repo | 仓库 | |
| Project | 项目 | |
| Inbox | 收件箱 | |
| Pinned | 已固定 | |
| Snoozed | 已延后 | |
| Settled | 已结束 | 会话状态 |
| Archive | 归档 | |
| Spec | 规格 | `spec mode` → 规格模式 |
| Reasoning level | 推理级别 | |
| Autonomy level | 自主级别 | |
| Context panel | 上下文面板 | |
| Command palette | 命令面板 | |
| Pull Request / PR | 拉取请求 / PR | 优先用“PR”保持简洁；完整句可用“拉取请求” |
| Core Development Partner | 核心开发伙伴 | |
| Beta | Beta | 保留 |
| Unpin | 取消固定 | |

## 3. 格式规则

1. **占位符、`$t()` 引用、XML 标签必须与英文源逐一对应**，不得增删或改写。
2. **复数**：中文只输出 `_other` 键；英文的 `_one`、`_few`、`_many` 等一律合并为 `_other`。
3. **标点**：使用中文全角标点（，。！？：；），但保留英文原有的 `…`、`·`、`—`、括号内英文格式。
4. **省略号**：源文使用 `...` 时，中文可用 `…`；但 `$t()`、占位符内部不得改动。
5. **按钮/菜单**：尽量简短，避免超过英文源长度过多；使用动词或名词短语。
6. **句子语气**：界面文案使用简洁、专业、克制的表达；不使用口语化感叹。
7. **大小写**：中文句首不强制大写；英文产品名保持原有大小写。
8. **空格**：中文与英文/数字之间保留一个半角空格（如「打开 Factory」「3 个会话」），但 `{{count}}个` 这类占位符紧邻时遵循源文。
9. **不译内容**：品牌口号、法律条款中的公司名、隐私政策链接文字中的产品名保持英文。

## 4. 常见句式对照

| 英文 | 中文 |
|---|---|
| New Session | 新建会话 |
| All Sessions | 全部会话 |
| No sessions | 暂无会话 |
| No sessions match your filters | 没有符合筛选条件的会话 |
| Release to unpin | 松开以取消固定 |
| Search or jump to | 搜索或跳转 |
| Switch organization | 切换组织 |
| Copy Session Link | 复制会话链接 |
| Settings | 设置 |
| More | 更多 |
| Done | 完成 |
| Cancel | 取消 |
| Retry | 重试 |
| Learn more | 了解更多 |

## 5. 审校红线

- 不允许出现机器翻译腔（如「请点击这里以进行…」）。
- 不允许中英混排时漏译整句。
- 不允许改动 JSON 键名、层级、类型。
- 不允许把 `Factory`、`Droid` 译成中文。
- 不允许翻译占位符内部或 `$t()` 的 key。