# DailyNews AI Agent 内容使用指南

指南版本：1.3
适用产品版本：0.12.1
更新日期：2026-08-24

这份指南告诉外部 AI Agent 如何为 DailyNews 搜集、整理和生成一期日报候选。它只规定 Agent 需要读取的信息、需要生成的文件和内容边界，不要求 Agent 运行项目命令或操作浏览器。

如果任务是新增、修改或切换视觉主题，请改读 [`AGENT_THEME_GUIDE.md`](./AGENT_THEME_GUIDE.md)。内容候选和主题候选不能混在同一个文件或任务中。

## 使用场景

在用户要求生成、补充或更新某一期日报时使用本指南。Agent 负责搜集来源、合并同一事件、撰写候选和表达编辑判断；正式写入、revision、布局编译和索引更新由宿主环境中的代码负责。

开始前先读取：

- 用户或宿主明确给出的唯一目标 Publication ID。
- `publications/<publication-id>/config/site.json`：目标日报的站点设置与三档优先级数量上限。
- `publications/<publication-id>/data/issues/YYYY-MM-DD.json`：目标日期已存在时，只读获取 coverage、稳定 ID 和已有来源。
- 用户指定的内容源、时间窗口和写入模式。

不能因为注册表存在默认 Publication，就替一个目标不明确的写入任务自行选择目标。

站点配置字段见 [`docs/CONFIGURATION.md`](./docs/CONFIGURATION.md)。

### 首次生成日报时的最少信息

如果任务来自 [`AGENT_USER_GUIDE.md`](./AGENT_USER_GUIDE.md) 的首次使用流程，先由用户语言确认：

- 要为哪一份人类可读名称的日报生成内容；Agent 再从 Registry 解析唯一目标 ID。
- 关注方向、用户指定的内容源或允许 Agent 搜集的来源范围。
- 目标日期和采集时间窗口；用户未另行指定时可以推荐今天和一个明确窗口。
- 本次采用重点新闻配图、尽量配图、纯文字，还是只给指定新闻配图。

能从站点配置、已有正式日报或当前日期读取的信息不要重复询问。用户没有要求 Logo、颜色、主题或版面参数时，内容任务不处理这些设置。

## 1. 完成一次日报候选

按以下顺序完成任务：

1. 与用户要求对齐唯一目标 Publication、目标日期、内容源和采集时间窗口。
2. 读取站点配置；目标日报已存在时，只读获取固定 coverage、稳定 ID 和已有来源。
3. 搜集内容、核对来源、合并同一事件，并决定编辑优先级与阅读顺序。
4. 生成一份完整 Candidate，写入 `publications/<publication-id>/data/candidates/YYYY-MM-DD.json`。
5. 向用户或宿主环境报告候选路径、日期、coverage 和内容数量。

## 2. Agent 的唯一数据产物

Agent 只生成一份完整候选：

```text
publications/<publication-id>/data/candidates/YYYY-MM-DD.json
```

候选必须放在该目录中，文件名、`date` 和目标日期保持一致。候选是一轮运行的完整提案，不是 JSON Patch，也不是向正式日报直接追加的数组。

Agent 不得直接修改：

- `publications/*/data/issues/`
- `publications/*/data/compiled/`
- `publications/*/data/submissions/`
- `publications/*/data/index.json`
- `publications/*/config/`
- `config/publications.json`
- 源码和构建产物

候选保存完成后，Agent 的文件写入任务即结束。Agent 应报告 `candidate_ready` 或等价的“候选已准备”，不能称为日报已发布或页面已可查看。后续何时消费 Candidate 由宿主环境决定。

## 3. 候选 JSON

当前候选结构：

```json
{
  "schemaVersion": 2,
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
      "image": {
        "src": "https://cdn.example.com/example.jpg",
        "alt": "研究人员在多屏工作站前检查任务结果",
        "width": 1600,
        "height": 1067,
        "credit": "Example News",
        "sourceUrl": "https://example.com/original-image"
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
| `schemaVersion` | 是 | 新候选固定为整数 `2`；历史 Schema `1` 只用于无图兼容读取 |
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
| `image` | 否 | 最多一张严格图片对象；没有可靠图片时省略 |

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

### 可选图片

- `src` 只能是合法 `https://` 地址，或项目 `public/` 内真实存在且以 `/` 开头的本地资源。
- `alt` 必须非空并描述图片内容，最多 160 个 Unicode 字符，不能重复堆砌新闻标题。
- `width`、`height` 必须是图片固有尺寸，均为 `1–10000` 的整数。
- `credit` 必须是非空署名或来源说明，最多 120 个 Unicode 字符。
- `sourceUrl` 可选；提供时必须是图片原始出处的 HTTP(S) 地址。
- Agent 不下载、缓存或探测远程图片，不把可访问 URL 当成版权授权。无法确认图片、尺寸、署名或使用权时省略 `image`。
- `image` 不参与内容匹配、优先级、顺序和版面尺寸决定。

用户的配图表达只映射为本次 Candidate 的编辑要求：

| 用户表达 | Candidate 行为 |
| --- | --- |
| 重点新闻配图 | 优先为 `lead` 和 `important` 中图片信息可靠的内容添加 `image` |
| 尽量配图 | 每条适合且图片信息完整的内容都可以添加 `image` |
| 纯文字 | 所有 Item 省略 `image`，不写 `null`、空对象或占位图 |
| 只给指定新闻配图 | 只处理用户指定内容，其余 Item 省略 `image` |

该选择不写入站点配置，也不会自动作用于以后日报。用户要求长期保持时，说明 DailyNews `v0.12.1` 没有产品级 `imagePolicy`；只有其 Agent 软件支持固定任务模板且用户明确要求时，才在该 Agent 的工作流中保存偏好，不能在本仓库发明字段或配置文件。

## 7. 选择、去重和顺序

- 分配优先级前读取目标 Publication 的 `config/site.json.priorityLimits`；非负整数表示上限，`null` 表示不限。
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
- `publicationId`、Publication 路径或目标选择字段
- `mode`、`writeMode`、写入结果或历史写入权限
- 删除指令、删除列表或删除标记
- `resolvedPriority`
- `large`、`medium`、`small`
- 行号、栏位、模块所占栏数、容量和坐标
- HTML、CSS、组件或动画参数
- 外部平台的 `score`、`selected`
- 第二张图片、相册、裁切坐标、焦点、滤镜、叠字、水印和图片布局字段

`revision`、合并、删除和布局都由代码决定，不由 Agent 数据决定。

## 9. 正式写入边界

宿主环境消费 Candidate 时遵守：

- `update` 是默认模式：目标不存在则创建；存在则安全合并。
- `replace` 必须由用户或受信任自动化显式指定，候选不能自我授权。
- 先按 ID 匹配，再按任一来源 URL 匹配。
- 匹配项复用正式 ID，内容使用候选值，来源按候选顺序并入旧来源。
- Schema `2` 匹配项提供 `image` 时替换旧图片，省略时移除旧图片；未匹配而保留的旧条目保留自己的图片。
- Schema `1` Candidate 不能更新 Schema `2` Issue；Schema `2` 可以在有效更新时升级历史 Schema `1` Issue。
- 新候选加入；`update` 中未匹配旧条目继续保留。
- 最终顺序为候选处理结果在前，未匹配旧条目按原相对顺序在后。
- 匹配歧义、coverage 变化和未授权历史日期整次拒绝。
- Candidate 不能自行指定写入结果或授予 `replace` 权限。
- 目标 Publication 由宿主上下文和受控 Candidate 路径共同确定，Candidate 不能通过自身字段改变目标。

## 10. Agent 与宿主环境的分工

Agent 只负责生成完整 Candidate。Writer 和 Compiler 的执行时机由宿主应用、本地脚本、服务端任务或用户自己的工作流决定，不属于本指南的必做步骤。

这种分工不依赖 Agent 是否具备终端、浏览器、文件监听或定时任务能力。

## 11. Agent 完成条件

满足以下条件即可报告 Agent 任务完成：

1. Candidate 是完整 JSON，日期、coverage、内容和来源字段齐全。
2. 已完成同一事件的语义去重。
3. 编辑优先级、选择理由和阅读顺序完整。
4. Candidate 已保存到目标 Publication 的正确路径。
5. 已向用户或宿主环境报告候选路径和本次产出摘要。

完成报告必须明确使用 `candidate_ready` 语义。只有宿主完成 Validator、Writer、Compiler 和正式提交后，才能报告 `published`。
