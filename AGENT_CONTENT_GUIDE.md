# DailyNews AI Agent 内容使用指南

指南版本：1.0
适用产品版本：0.8.0
更新日期：2026-08-21

这份指南告诉外部 AI Agent 如何为 DailyNews 搜集、整理和写入一期日报。字段的最终机器约束由源码中的 Validator 和 Writer 执行；本指南负责说明正确的使用流程、权限边界和完成条件。

如果任务是新增、修改或切换视觉主题，请改读 [`AGENT_THEME_GUIDE.md`](./AGENT_THEME_GUIDE.md)。内容候选和主题候选不能混在同一个文件或任务中。

## 使用场景

在用户要求生成、补充或更新某一期日报时使用本指南。Agent 负责搜集来源、合并同一事件、撰写候选和表达编辑判断；代码负责正式写入、revision、布局编译和索引更新。

开始前先读取：

- `config/site.json`：当前站点设置与三档优先级数量上限。
- `data/issues/YYYY-MM-DD.json`：目标日期已存在时，只读获取 coverage、稳定 ID 和已有来源。
- 用户指定的内容源、时间窗口和写入模式。

## 1. 完成一次日报写入

按以下顺序完成任务：

1. 与用户要求对齐目标日期、内容源和采集时间窗口。
2. 读取站点配置；目标日报已存在时，只读获取固定 coverage、稳定 ID 和已有来源。
3. 搜集内容、核对来源、合并同一事件，并决定编辑优先级与阅读顺序。
4. 生成一份完整 Candidate，写入 `data/candidates/YYYY-MM-DD.json`。
5. 运行统一处理命令并等待结构化结果。
6. 返回 `created`、`updated` 或 `unchanged` 后核对正式日报和编译产物，再报告完成。
7. 返回 `rejected` 时保留 Candidate，根据 `field` 和 `reason` 修正或向用户报告。

统一处理命令：

```bash
npm run process-candidate -- --candidate data/candidates/YYYY-MM-DD.json --mode update
```

它会校验候选、获取日期锁、执行 `update` 或 `replace`、预编译版面，并在全部步骤成功后提交正式日报、编译产物和日期索引。默认模式是 `update`；只有用户或受信任自动化明确授权时才能使用 `--mode replace`。

## 2. Agent 的唯一数据产物

Agent 只生成一份完整候选：

```text
data/candidates/YYYY-MM-DD.json
```

候选必须放在该目录中，文件名、`date` 和目标日期保持一致。候选是一轮运行的完整提案，不是 JSON Patch，也不是向正式日报直接追加的数组。

Agent 不得直接修改：

- `data/issues/`
- `data/compiled/`
- `data/index.json`
- `config/`
- 源码和构建产物

唯一例外是：调用项目已经提供的写入命令，由代码完成正式写入。Agent 本身不绕过命令写目标文件。

## 3. 候选 JSON

当前候选结构：

```json
{
  "schemaVersion": 1,
  "date": "2026-08-20",
  "generatedAt": "2026-08-20T08:00:00+08:00",
  "coverage": {
    "start": "2026-08-19T08:00:00+08:00",
    "end": "2026-08-20T08:00:00+08:00"
  },
  "items": [
    {
      "id": "example-event",
      "title": "适合日报阅读的标题",
      "brief": "可以独立阅读的一句话短摘要。",
      "summary": "由来源支持的相对完整事实摘要。",
      "category": "industry",
      "editorial": {
        "priority": "important",
        "selectionReason": "说明内容价值及当前优先级的具体依据。"
      },
      "sources": [
        {
          "originalTitle": "Original title",
          "name": "Source Name",
          "url": "https://example.com/article",
          "publishedAt": "2026-08-20T00:17:26.000Z",
          "discoveredAt": "2026-08-20T00:23:57.005Z",
          "via": {
            "name": "Aggregator Name",
            "url": "https://example.com/discovery-page"
          }
        }
      ]
    }
  ]
}
```

`coverage` 是候选必填字段；日期首次创建后由 Writer 固定，后续候选发生变化会被拒绝。

## 4. 顶层字段规则

| 字段 | 必填 | 规则 |
| --- | --- | --- |
| `schemaVersion` | 是 | 固定为整数 `1` |
| `date` | 是 | `YYYY-MM-DD`，按 `Asia/Shanghai` 归属 |
| `generatedAt` | 是 | 本轮内容生成时间，带时区的 ISO 8601 |
| `coverage.start` | 是 | 采集窗口开始时间，带时区的 ISO 8601 |
| `coverage.end` | 是 | 采集窗口结束时间，必须晚于 start |
| `items` | 是 | 非空数组 |

同一日期首次创建后，后续运行必须复用相同 `coverage`。没有可靠内容时，不生成空 `items` 去覆盖已有日报。

## 5. 内容条目规则

| 字段 | 必填 | 规则 |
| --- | --- | --- |
| `id` | 是 | 同一期唯一；只用小写字母、数字和连字符；重复运行时保持稳定 |
| `title` | 是 | 可以改写，但不能改变事实或扩大确定性 |
| `brief` | 是 | 可独立阅读的短摘要，建议不超过 80 个 Unicode 字符 |
| `summary` | 是 | 相对完整的事实摘要，建议 120–400 个 Unicode 字符 |
| `category` | 否 | 自由文本分类 |
| `editorial.priority` | 是 | `lead`、`important` 或 `normal` |
| `editorial.selectionReason` | 是 | 具体说明内容价值和优先级依据 |
| `sources` | 是 | 至少一个来源 |

标题建议上限：

- `lead`：42 个 Unicode 字符。
- `important`：36 个 Unicode 字符。
- `normal`：28 个 Unicode 字符。

不能为了满足长度而删除会改变结论的限定条件。

## 6. 来源规则

- `sources[0]` 是主要来源，必须直接支持标题与摘要的核心事实。
- 每个来源必须包含非空 `name` 和 HTTP(S) `url`。
- 同一条内容内 URL 不重复。
- `originalTitle`、`publishedAt`、`discoveredAt` 和 `via` 未知时省略，不能编造。
- `publishedAt` 是来源发布时间，不能用发现时间替代。
- 聚合、RSS、翻译或发现平台写入 `via`，原始内容链接仍写入 `url`。
- 同一事件的多个来源合并为一条内容，并按可信度和事实贡献排序。

## 7. 选择、去重和顺序

- 分配优先级前读取 `config/site.json.priorityLimits`；非负整数表示上限，`null` 表示不限。
- 如果正式日报已存在，可以只读获取已有 coverage、稳定 ID 和来源；不得直接修改该文件。
- 每条内容必须可追溯到至少一个真实来源。
- 在候选生成阶段完成语义去重；代码只做 ID 和来源 URL 的确定性匹配。
- 当前默认 `lead` 最多一个，可以没有。
- 当前默认 `important` 最多两个，可以没有。
- 当前默认 `normal` 数量不限。
- 以上默认值可由站点配置修改，Agent 应以实际配置为准。
- `items` 顺序就是阅读顺序。
- 不为填满页面虚构内容、提高优先级或改变事实顺序。
- 候选中缺少旧条目不代表删除。

## 8. 禁止字段

候选不得包含：

- `revision`
- `mode`、`writeMode`、写入结果或历史写入权限
- 删除指令、删除列表或删除标记
- `resolvedPriority`
- `large`、`medium`、`small`
- 行号、栏位、模块所占栏数、容量和坐标
- HTML、CSS、组件或动画参数
- 外部平台的 `score`、`selected`
- 图片字段

`revision`、合并、删除和布局都由代码决定，不由 Agent 数据决定。

## 9. 当前处理逻辑

统一命令：

```bash
npm run process-candidate -- --candidate data/candidates/YYYY-MM-DD.json --mode update
```

该命令遵守：

- `update` 是默认模式：目标不存在则创建；存在则安全合并。
- `replace` 必须由用户或受信任自动化显式指定，候选不能自我授权。
- 先按 ID 匹配，再按任一来源 URL 匹配。
- 匹配项复用正式 ID，内容使用候选值，来源按候选顺序并入旧来源。
- 新候选加入；`update` 中未匹配旧条目继续保留。
- 最终顺序为候选处理结果在前，未匹配旧条目按原相对顺序在后。
- 匹配歧义、coverage 变化和未授权历史日期整次拒绝。
- 结果为 `created`、`updated`、`unchanged` 或 `rejected`。

## 10. 执行时机

用户只控制 Agent 的定时任务。Writer 和 Compiler 不需要独立定时器、文件监听器或浏览器触发。

Agent 应在候选完整落盘后同步调用一次统一命令并等待结果。流水线依次完成：

1. 读取和校验候选。
2. 获取目标日期写入锁。
3. 生成正式日报更新计划。
4. 在提交前完成版面预编译和结果校验。
5. 原子写入正式日报与编译产物。
6. 最后更新日期索引。

任一步失败都必须保留候选和已有正式产物。

## 11. Agent 完成条件

只有满足以下条件才能报告任务完成：

1. 候选可以被严格解析，内容和来源字段完整。
2. 已完成同一事件的语义去重。
3. 编辑优先级、选择理由和阅读顺序完整。
4. 实际存在的处理命令已经返回成功。
5. 对应正式日报和编译产物已经生成或确认无需改变。

命令返回 `rejected` 时，应保留候选并报告具体原因，不能绕过统一入口直接覆盖正式产物。
