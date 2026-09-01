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
      title: "把一天的信息，先整理成一条清晰主线",
      brief: "私人日报先给出最重要的判断，再保留继续阅读的来源入口。",
      summary:
        "这是一份不依赖实时事实的系统示例。正式使用后，你的 Agent 会根据长期关注方向整理内容，DailyNews 再把经过校验的正式结果稳定呈现在同一个阅读位置。",
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
      title: "每个 Agent 都有独立授权",
      brief: "新增或移除某个 Agent，不会覆盖其他连接。",
      summary:
        "DailyNews 只显示服务端能够确认的授权事实，不会把客户端在线状态或本地定时任务猜成产品状态。你可以在编辑部设置中单独管理每一条连接。",
      category: "安全",
      editorial: { priority: "important", selectionReason: "解释用户控制边界" },
      sources: [{
        name: "DailyNews Agent 指南",
        url: "https://github.com/dingshuxin353/daily-news-app",
      }],
    },
    {
      id: "sample-todo",
      title: "Todo 只在需要时开启",
      brief: "启用后 Agent 才能写入个人待办，关闭时保留已有内容。",
      summary:
        "Personal Todo 属于整个私人空间。它默认关闭，不会为了展示功能而制造虚假任务；启用后页面只读取正式 Todo State，并沿用固定的五组排序。",
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
              : <p>第一份正式日报还没有到达。</p>}
          </div>
          <a
            href={readingHref(
              basePath,
              summary.publication.publicationId,
              summary.latest?.date,
            )}
          >
            {summary.latest ? "打开最新一期" : "打开日报"}
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
    ? readingHref(
      input.basePath,
      input.shell.publication.publicationId,
      input.daily.date,
    )
    : appPath(input.basePath, "/onboarding");
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
              {input.daily?.date ?? "系统内置 · 不代表今日"}
            </p>
            <div className="m51-edition-name">
              <h2>
                {input.daily ? input.shell.publication.displayName : "示例日报"}
              </h2>
              <span>{input.daily ? "个性化正式日报" : "阅读预览"}</span>
            </div>
            <p className="m51-kicker">{leadItem.category ?? "阅读方式"}</p>
            <h1 id="home-title">{leadItem.title ?? "日报尚未准备好"}</h1>
            <p>
              {leadItem.summary ?? leadItem.brief ??
                "连接 Agent 后，这里会显示第一份个性化正式日报。"}
            </p>
            <a className="m51-reading-link" href={href}>
              {input.daily ? "阅读完整日报" : "设置自动日报"}
              <IconArrowNarrowRight size={18} aria-hidden="true" />
            </a>
          </section>
          <section className="m51-home-digest" aria-labelledby="digest-title">
            <header>
              <div>
                <h2 id="digest-title">今日总览</h2>
                <p>
                  {input.daily?.date ?? "系统示例"} · {modules.length} 条内容
                </p>
              </div>
              <a href={href}>阅读完整日报</a>
            </header>
            <ol>
              {digest.map((module, index) => (
                <li key={module.item.id ?? index}>
                  <span>{String(index + 2).padStart(2, "0")}</span>
                  <div>
                    <p className="m51-kicker">
                      {module.item.category ?? "今日编辑"}
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
                    : "等待第一份正式日报"}
                </p>
              </div>
              <a
                className="m51-reading-link"
                href={appPath(input.basePath, "/publications/")}
              >
                查看我的日报<IconArrowNarrowRight
                  size={17}
                  aria-hidden="true"
                />
              </a>
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
        {!input.daily
          ? (
            <a
              className="m51-secondary-journey"
              href={appPath(input.basePath, "/onboarding")}
            >
              把自动日报真正用起来<IconArrowNarrowRight
                size={17}
                aria-hidden="true"
              />
            </a>
          )
          : null}
      </main>
    </PageDocument>
  );
}

export function PublicationsPage(
  input: {
    basePath: string;
    shell: ReadingShell;
    publications: PublicationReadingSummary[];
  },
) {
  return (
    <PageDocument
      basePath={input.basePath}
      title="我的日报"
      page="publications"
      shell={input.shell}
      current="publications"
      readingTheme
    >
      <main
        className="m51-directory"
        id="content"
        data-theme-id={input.shell.theme.id}
        data-theme-revision={input.shell.theme.revision}
      >
        <header>
          <p className="m51-kicker">私人阅读目录</p>
          <h1>我的日报</h1>
          <p>按编辑顺序查看正在使用的日报。这里没有创建、排序或停用操作。</p>
        </header>
        <PublicationIndex
          basePath={input.basePath}
          summaries={input.publications}
        />
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
    <nav className="m51-date-nav" aria-label="正式日报期次">
      {older
        ? (
          <a
            href={readingHref(input.basePath, input.publicationId, older)}
            aria-label={`更早一期 ${older}`}
          >
            <IconChevronLeft aria-hidden="true" />更早一期
          </a>
        )
        : <span>已经是最早一期</span>}
      <time dateTime={input.date}>{input.date}</time>
      {newer
        ? (
          <a
            href={readingHref(input.basePath, input.publicationId, newer)}
            aria-label={`更新一期 ${newer}`}
          >
            更新一期<IconChevronRight aria-hidden="true" />
          </a>
        )
        : <span>已经是最新一期</span>}
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
      <p data-image-fallback hidden>配图暂不可用，不影响正文阅读。</p>
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
        <span>{item.category ?? "今日编辑"}</span>
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
        current="publications"
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
              ? "这一天没有正式日报"
              : "第一份正式日报还没有到达"}
          </h1>
          <p>
            {input.requestedDate
              ? `日期 ${input.requestedDate} 没有正式内容，DailyNews 没有替你回退到其他日期。`
              : "这份日报会在第一份正式内容到达后出现在阅读目录中。"}
          </p>
          <a
            className="m51-reading-link"
            href={latest
              ? readingHref(
                input.basePath,
                input.shell.publication.publicationId,
                latest,
              )
              : appPath(input.basePath, "/publications/")}
          >
            {latest ? `阅读最近一期 · ${latest}` : "返回我的日报"}
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
      current="publications"
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
                : "正式日报"}
            </p>
            <h1>{input.shell.publication.displayName}</h1>
          </div>
          <span>{modules.length} 则内容</span>
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
  if (!item.dueDate) return "未设日期";
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
            网页只读取正式结果。要新增、修改或完成任务，请继续告诉你的 Agent。
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
                : <p className="m51-todo-empty">这一组暂时没有事项。</p>}
            </section>
          );
        })}
      </main>
    </PageDocument>
  );
}
