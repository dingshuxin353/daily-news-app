import { compileIssue } from "../../../scripts/lib/compiler.js";
import { buildDailyReadingProjection } from "../../../scripts/lib/domain/daily-reading.js";
import {
  IconArrowNarrowRight,
  IconChevronLeft,
  IconChevronRight,
  IconExternalLink,
} from "@tabler/icons-react";
import type {
  DailyReading,
  PublicationReadingSummary,
  ReadingShell,
} from "../../modules/private-reading/service.js";
import { appPath, PageDocument } from "./ui.js";
import {
  ImageFallbackIsland,
  type ReadingSource,
  SourceDialogIsland,
  SourceList,
  TodoAnchorIsland,
} from "./reading-islands.js";

const sampleIssue = {
  schemaVersion: 1,
  date: "2026-01-01",
  generatedAt: "2026-01-01T08:00:00+08:00",
  coverage: {
    start: "2025-12-31T08:00:00+08:00",
    end: "2026-01-01T08:00:00+08:00",
  },
  revision: 1,
  items: [
    {
      id: "sample-focus",
      title: "先看最重要的一条",
      brief: "先看重点，再按来源继续阅读。",
      summary:
        "这是一份系统示例，不代表今天的新闻。你的 Agent 提交内容后，DailyNews 会根据你的关注方向生成日报，并在这里展示。",
      category: "阅读方式",
      editorial: {
        priority: "lead",
        selectionReason: "展示正式日报的主次层级",
      },
      sources: [{
        name: "DailyNews 使用说明",
        url: "https://github.com/dingshuxin353/daily-news-app",
      }],
    },
    {
      id: "sample-control",
      title: "每个 Agent 使用独立授权",
      brief: "新增或移除一个 Agent，不会影响其他授权。",
      summary:
        "页面只显示服务端确认过的授权和最近请求，不显示 Agent 是否在线。你可以在编辑部设置中分别管理它们。",
      category: "安全",
      editorial: { priority: "important", selectionReason: "解释用户控制边界" },
      sources: [{
        name: "DailyNews Agent 指南",
        url: "https://github.com/dingshuxin353/daily-news-app",
      }],
    },
    {
      id: "sample-todo",
      title: "需要时再开启 Todo",
      brief: "开启后 Agent 才能写入个人待办；关闭后已有任务仍会保留。",
      summary:
        "Personal Todo 属于你的私人空间。页面只显示已经写入的待办，不会为了填满页面生成任务。",
      category: "个人待办",
      editorial: { priority: "normal", selectionReason: "说明按需启用原则" },
      sources: [{
        name: "DailyNews Todo 指南",
        url: "https://github.com/dingshuxin353/daily-news-app",
      }],
    },
  ],
};
const sampleProjection = buildDailyReadingProjection(
  compileIssue(sampleIssue).compiled,
  sampleIssue,
);

type Module = Record<string, any> & { item: Record<string, any> };

function allModules(
  projection: { rows: Array<{ modules: Module[] }> },
): Module[] {
  return projection.rows.flatMap(({ modules }) => modules);
}

function readingHref(
  basePath: string,
  publicationId: string,
  date?: string,
): string {
  return appPath(
    basePath,
    `/p/${encodeURIComponent(publicationId)}/${date ? `?date=${date}` : ""}`,
  );
}

function PublicationIndex(
  { basePath, summaries, primary }: {
    basePath: string;
    summaries: PublicationReadingSummary[];
    primary?: boolean;
  },
) {
  return (
    <ol className="m51-publication-index">
      {summaries.map((summary, index) => (
        <li key={summary.publication.publicationId}>
          <span className="m51-index-number">
            {String(index + 1).padStart(2, "0")}
          </span>
          <div>
            <p className="m51-index-label">
              {summary.publication.isDefault || primary ? "首要日报" : "日报"}
            </p>
            <h2>{summary.publication.displayName}</h2>
            {summary.latest
              ? (
                <>
                  <time dateTime={summary.latest.date}>
                    {summary.latest.date}
                  </time>
                  <p>{summary.latest.title}</p>
                </>
              )
              : <p>还没有第一期日报。</p>}
          </div>
          <a
            href={readingHref(
              basePath,
              summary.publication.publicationId,
              summary.latest?.date,
            )}
          >
            {summary.latest ? "查看最新一期" : "查看日报"}
            <IconArrowNarrowRight size={17} aria-hidden="true" />
          </a>
        </li>
      ))}
    </ol>
  );
}

export function HomePage(
  input: {
    basePath: string;
    shell: ReadingShell;
    daily: DailyReading | null;
    publications: PublicationReadingSummary[];
    todoProjection?: any;
  },
) {
  const projection = input.daily?.projection ?? sampleProjection;
  const modules = allModules(projection);
  const [lead, ...digest] = modules;
  const leadItem = lead?.item ?? {};
  const href = input.daily
    ? readingHref(input.basePath, input.shell.publication.publicationId, input.daily.date)
    : null;
  const todoItems = input.todoProjection?.homeItems ?? [];
  return (
    <PageDocument
      basePath={input.basePath}
      title={input.shell.spaceName}
      page="home"
      shell={input.shell}
      current="home"
      readingTheme
    >
      <main
        className="m51-home"
        id="content"
        data-theme-id={input.shell.theme.id}
        data-theme-revision={input.shell.theme.revision}
      >
        <div className="m51-home-grid">
            <section className="m51-home-lead" aria-labelledby="home-title">
              <p className="m51-reading-meta">
                {input.daily?.date ?? "系统示例 · 不代表今日"}
              </p>
              <div className="m51-edition-name">
                <h2>
                  {input.daily ? input.shell.publication.displayName : "示例日报"}
                </h2>
                <span>{input.daily ? "个性化日报" : "系统示例"}</span>
              </div>
              <p className="m51-kicker">{leadItem.category ?? "阅读方式"}</p>
              <h1 id="home-title">{leadItem.title ?? "还没有日报"}</h1>
              <p>
                {leadItem.summary ?? leadItem.brief ??
                  "你的 Agent 提交第一份日报后，这里会显示个性化内容。"}
              </p>
              {href ? <a className="m51-reading-link" href={href}>阅读完整日报<IconArrowNarrowRight size={18} aria-hidden="true" /></a> : null}
            </section>
            <section className="m51-home-digest" aria-labelledby="digest-title">
              <header>
                <div>
                  <h2 id="digest-title">{input.daily ? "本期总览" : "内容预览"}</h2>
                  <p>
                    {input.daily ? `${input.daily.date} · ${modules.length} 条内容` : `系统示例 · ${modules.length} 条内容`}
                  </p>
                </div>
                {href ? <a href={href}>阅读完整日报</a> : null}
              </header>
              <ol>
                {digest.map((module, index) => (
                  <li key={module.item.id ?? index}>
                    <span>{String(index + 2).padStart(2, "0")}</span>
                    <div>
                      <p className="m51-kicker">
                        {module.item.category ?? "编辑"}
                      </p>
                      <h3>{module.item.title}</h3>
                      <p>{module.item.brief ?? module.item.summary}</p>
                    </div>
                  </li>
                ))}
              </ol>
              <div className="m51-home-primary">
                <div>
                  <p className="m51-kicker">首要日报</p>
                  <h3>{input.shell.publication.displayName}</h3>
                  <p>
                    {input.daily
                      ? `最新一期 · ${input.daily.date} · 共 ${modules.length} 条`
                      : "还没有日报"}
                  </p>
                </div>
                {href ? <a className="m51-reading-link" href={href}>查看首要日报<IconArrowNarrowRight size={17} aria-hidden="true" /></a> : null}
              </div>
            </section>
        </div>
        {input.publications.length > 0
          ? (
            <section
              className="m51-home-index"
              aria-labelledby="other-publications-title"
            >
              <header>
                <div>
                  <p className="m51-kicker">继续阅读</p>
                  <h2 id="other-publications-title">其他日报</h2>
                </div>
              </header>
              <PublicationIndex
                basePath={input.basePath}
                summaries={input.publications}
              />
            </section>
          )
          : null}
        {todoItems.length > 0
          ? (
            <section
              className="m51-home-todo"
              aria-labelledby="home-todo-title"
            >
              <header>
                <div>
                  <p className="m51-kicker">Personal Todo</p>
                  <h2 id="home-todo-title">个人待办</h2>
                </div>
                <a href={appPath(input.basePath, "/todo/")}>查看全部</a>
              </header>
              <ol>
                {todoItems.map((item: any) => (
                  <li key={item.id}>
                    <a href={appPath(input.basePath, `/todo/#${item.id}`)}>
                      {item.title}
                    </a>
                    <span>{item.dueDate ?? "暂无日期"}</span>
                  </li>
                ))}
              </ol>
            </section>
          )
          : null}
      </main>
    </PageDocument>
  );
}

function DateNavigation(
  input: {
    basePath: string;
    publicationId: string;
    date: string;
    dates: string[];
  },
) {
  const index = input.dates.indexOf(input.date);
  const newer = index > 0 ? input.dates[index - 1] : null;
  const older = index >= 0 && index < input.dates.length - 1
    ? input.dates[index + 1]
    : null;
  return (
    <nav className="m51-date-nav" aria-label="日报期次">
      {older
        ? (
          <a
            href={readingHref(input.basePath, input.publicationId, older)}
            aria-label={`更早一期 ${older}`}
          >
            <IconChevronLeft aria-hidden="true" />更早一期
          </a>
        )
        : <span>已是最早一期</span>}
      <time dateTime={input.date}>{input.date}</time>
      {newer
        ? (
          <a
            href={readingHref(input.basePath, input.publicationId, newer)}
            aria-label={`更晚一期 ${newer}`}
          >
            更晚一期<IconChevronRight aria-hidden="true" />
          </a>
        )
        : <span>已是最新一期</span>}
    </nav>
  );
}

function StoryImage(
  { item, index }: { item: Record<string, any>; index: number },
) {
  if (!item.image || typeof item.image !== "object") return null;
  const imageId = `m51-reading-image-${index}`;
  return (
    <figure className="m51-story-media">
      <img
        id={imageId}
        src={item.image.src}
        alt={item.image.alt}
        width={Number(item.image.width)}
        height={Number(item.image.height)}
        decoding="async"
        loading={index === 0 ? "eager" : "lazy"}
        fetchPriority={index === 0 ? "high" : undefined}
        referrerPolicy={String(item.image.src).startsWith("https://")
          ? "no-referrer"
          : undefined}
      />
      <figcaption>
        {item.image.sourceUrl
          ? (
            <a
              href={item.image.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              {item.image.credit}
            </a>
          )
          : item.image.credit}
      </figcaption>
      <p data-image-fallback hidden>图片暂时无法显示，正文仍可阅读。</p>
      <span data-react-island="image-fallback" data-image-id={imageId}>
        <ImageFallbackIsland imageId={imageId} />
      </span>
    </figure>
  );
}

function StoryModule({ module, index }: { module: Module; index: number }) {
  const item = module.item;
  const sources =
    (Array.isArray(item.sources) ? item.sources : []) as ReadingSource[];
  const archiveId = `sources-${item.id}`;
  const copy = module.size === "large" ? item.summary : item.brief;
  return (
    <article
      className={`m51-story m51-story--${module.size} m51-story--span-${
        Number(module.span)
      }`}
      id={item.id}
    >
      <header>
        <span>{item.category ?? "编辑"}</span>
        <span>{String(index + 1).padStart(2, "0")}</span>
      </header>
      <h2>{item.title}</h2>
      <StoryImage item={item} index={index} />
      <p>{copy}</p>
      <footer>
        {sources.length === 1
          ? (
            <a href={sources[0].url} target="_blank" rel="noopener noreferrer">
              {sources[0].name}
              <IconExternalLink size={15} aria-hidden="true" />
            </a>
          )
          : sources.length > 1
          ? (
            <div
              data-react-island="sources"
              data-source-title={item.title}
              data-sources={JSON.stringify(sources)}
              data-archive-id={archiveId}
            >
              <SourceDialogIsland
                title={item.title}
                sources={sources}
                archiveId={archiveId}
              />
            </div>
          )
          : null}
      </footer>
    </article>
  );
}

function SourceArchive({ modules }: { modules: Module[] }) {
  const multiple = modules.filter(({ item }) =>
    Array.isArray(item.sources) && item.sources.length > 1
  );
  if (multiple.length === 0) return null;
  return (
    <aside
      className="m51-source-archive"
      aria-labelledby="source-archive-title"
    >
      <h2 id="source-archive-title">全部来源</h2>
      {multiple.map(({ item }) => (
        <section key={item.id} id={`sources-${item.id}`} tabIndex={-1}>
          <h3>{item.title}</h3>
          <SourceList sources={item.sources as ReadingSource[]} />
        </section>
      ))}
    </aside>
  );
}

export function DailyPage(
  input: {
    basePath: string;
    shell: ReadingShell;
    daily: DailyReading | null;
    dates?: string[];
    requestedDate?: string;
  },
) {
  const dates = input.dates ?? input.daily?.dates ?? [];
  const latest = dates[0];
  const title = input.daily
    ? `${input.shell.publication.displayName} · ${input.daily.date}`
    : input.shell.publication.displayName;
  if (!input.daily) {
    return (
      <PageDocument
        basePath={input.basePath}
        title={title}
        page="daily"
        shell={input.shell}
        current="daily"
        readingTheme
      >
        <main className="m51-reading-empty" id="content">
          <p className="m51-kicker">
            {input.shell.publication.status === "inactive"
              ? "已停用 · 只读归档"
              : "日报"}
          </p>
          <h1>
            {input.requestedDate
              ? "这一天没有日报"
              : "还没有第一期日报"}
          </h1>
          <p>
            {input.requestedDate
              ? `日期 ${input.requestedDate} 没有日报。DailyNews 不会自动改读其他日期。`
              : "第一期日报发布后，会出现在顶部的“日报”切换器中。"}
          </p>
          <a
            className="m51-reading-link"
            href={latest
              ? readingHref(
                input.basePath,
                input.shell.publication.publicationId,
                latest,
              )
              : appPath(input.basePath, "/home")}
          >
            {latest ? `阅读最近一期 · ${latest}` : "返回总览"}
            <IconArrowNarrowRight size={17} aria-hidden="true" />
          </a>
        </main>
      </PageDocument>
    );
  }
  const modules = allModules(input.daily.projection);
  let index = 0;
  return (
    <PageDocument
      basePath={input.basePath}
      title={title}
      page="daily"
      shell={input.shell}
      current="daily"
      readingTheme
    >
      <main
        className="m51-daily"
        id="content"
        data-theme-id={input.shell.theme.id}
        data-theme-revision={input.shell.theme.revision}
      >
        <header className="m51-daily-heading">
          <div>
            <p className="m51-kicker">
              {input.shell.publication.status === "inactive"
                ? "已停用 · 只读归档"
                : "日报"}
            </p>
            <h1>{input.shell.publication.displayName}</h1>
          </div>
          <span>{modules.length} 条内容</span>
        </header>
        <DateNavigation
          basePath={input.basePath}
          publicationId={input.shell.publication.publicationId}
          date={input.daily.date}
          dates={dates}
        />
        <section
          className="m51-daily-edition"
          aria-label={`${input.daily.date} 日报内容`}
        >
          {input.daily.projection.rows.map((row, rowIndex) => (
            <div className="m51-daily-row" key={rowIndex}>
              {row.modules.map((module) => (
                <StoryModule
                  key={String(module.item.id)}
                  module={module as Module}
                  index={index++}
                />
              ))}
            </div>
          ))}
        </section>
        <SourceArchive modules={modules} />
      </main>
    </PageDocument>
  );
}

function todoDate(
  item: any,
  asOfDate: string,
  completed: boolean,
  timeZone: string,
): string {
  if (completed && item.completedAt) {
    return `完成于 ${
      new Date(item.completedAt).toLocaleTimeString("zh-CN", {
        timeZone,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
    }`;
  }
  if (!item.dueDate) return "未设置日期";
  const time = item.dueTime ? ` ${item.dueTime}` : "";
  if (item.dueDate < asOfDate) return `逾期 · ${item.dueDate}${time}`;
  if (item.dueDate === asOfDate) return `今天${time}`;
  return `${item.dueDate}${time}`;
}

export function TodoPage(
  input: { basePath: string; shell: ReadingShell; projection: any },
) {
  const definitions = [
    ["overdue", "已逾期"],
    ["today", "今天"],
    ["upcoming", "接下来"],
    ["undated", "暂无日期"],
    ["completedToday", "今天已完成"],
  ] as const;
  return (
    <PageDocument
      basePath={input.basePath}
      title="个人待办"
      page="todo"
      shell={input.shell}
      current="todo"
      readingTheme
    >
      <main
        className="m51-todo"
        id="content"
        data-theme-id={input.shell.theme.id}
        data-theme-revision={input.shell.theme.revision}
      >
        <header>
          <p className="m51-kicker">
            Personal Todo · {input.projection.asOfDate}
          </p>
          <h1>个人待办</h1>
          <p>
            网页只读。新增、修改或完成任务，请告诉你的 Agent。
          </p>
        </header>
        <p
          className="m51-anchor-status"
          data-anchor-status
          role="status"
          tabIndex={-1}
          hidden
        >
          没有找到这条待办。
        </p>
        <span data-react-island="todo-anchor">
          <TodoAnchorIsland />
        </span>
        {definitions.map(([key, label]) => {
          const items = input.projection.groups[key];
          return (
            <section
              className="m51-todo-group"
              aria-labelledby={`todo-${key}`}
              key={key}
            >
              <header>
                <h2 id={`todo-${key}`}>{label}</h2>
                <span>{items.length} 项</span>
              </header>
              {items.length
                ? (
                  <ol>
                    {items.map((item: any) => (
                      <li key={item.id}>
                        <article id={item.id} tabIndex={-1}>
                          <span>
                            {key === "completedToday"
                              ? "已完成"
                              : key === "overdue"
                              ? "已逾期"
                              : "未完成"}
                          </span>
                          <div>
                            <h3>{item.title}</h3>
                            {item.note ? <p>{item.note}</p> : null}
                          </div>
                          <time>
                            {todoDate(
                              item,
                              input.projection.asOfDate,
                              key === "completedToday",
                              input.shell.timeZone,
                            )}
                          </time>
                        </article>
                      </li>
                    ))}
                  </ol>
                )
                : <p className="m51-todo-empty">这一组暂无待办。</p>}
            </section>
          );
        })}
      </main>
    </PageDocument>
  );
}
