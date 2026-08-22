export function createProbeCandidate() {
  return {
    schemaVersion: 1,
    date: "2026-08-22",
    generatedAt: "2026-08-22T08:00:00+08:00",
    coverage: {
      start: "2026-08-21T08:00:00+08:00",
      end: "2026-08-22T08:00:00+08:00",
    },
    items: [
      {
        id: "mcp-probe-ai-news",
        title: "DailyNews 远程 MCP 中文写入验证",
        brief: "验证 Agent 能否通过远程 MCP 原样提交结构化中文日报内容。",
        summary:
          "这是一条不对应真实事件的测试内容，包含中文、English、数字 1.0、符号与 emoji 🚀，用于检查嵌套 JSON、Unicode、多来源和定时调用是否稳定。",
        category: "兼容性测试",
        editorial: {
          priority: "important",
          selectionReason:
            "用于验证结构化内容和编辑字段能否完整传输，不代表真实编辑判断。",
        },
        sources: [
          {
            originalTitle: "DailyNews MCP Probe Fixture",
            name: "Primary Example",
            url: "https://example.com/news?id=42&utm_source=mcp#result",
            publishedAt: "2026-08-22T00:10:00.000Z",
            discoveredAt: "2026-08-22T00:20:00.000Z",
            via: {
              name: "Probe Aggregator",
              url: "https://example.org/feed?lang=zh-CN",
            },
          },
          {
            name: "补充示例来源",
            url: "https://example.net/reference?section=two&value=%E4%B8%AD%E6%96%87",
          },
        ],
      },
    ],
  };
}
