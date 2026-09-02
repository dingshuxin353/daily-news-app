import type { ReactNode } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Theme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import { IconArrowNarrowRight, IconChevronDown, IconCircleHalf2 } from "@tabler/icons-react";
import type { ReadingShell } from "../../modules/private-reading/service.js";

export type ReactPageName = "public" | "login" | "onboarding" | "home" | "daily" | "todo" | "settings" | "agent-settings";

export function appPath(basePath: string, pathname: string): string {
  return `${basePath}${pathname}`;
}

function Wordmark({ basePath, privatePage = false }: { basePath: string; privatePage?: boolean }) {
  return <a className="m51-wordmark" href={appPath(basePath, privatePage ? "/home" : "/")} aria-label="DailyNews">
    <IconCircleHalf2 className="m51-wordmark-mark" size={privatePage ? 27 : 21} stroke={2.4} aria-hidden="true" />
    <span>DailyNews</span>
  </a>;
}

function PublicHeader({ basePath, action }: { basePath: string; action?: { href: string; label: string } }) {
  return <header className="m51-public-header">
    <div className="m51-header-inner">
      <Wordmark basePath={basePath} />
      {action ? <a className="m51-public-action" href={action.href}>{action.label}</a> : <p>每天一份 · 私人编写</p>}
    </div>
  </header>;
}

function ProductHeader(input: { basePath: string; shell: ReadingShell; current: string }) {
  const publications = input.shell.readablePublications;
  const nickname = input.shell.nickname?.trim() || "你";
  return <header className="m51-product-header">
    <div className="m51-header-inner m51-header-inner--product">
      <div className="m51-brand-group">
        <Wordmark basePath={input.basePath} privatePage />
        <span>你的私人编辑部</span>
      </div>
      <nav className="m51-primary-nav" aria-label="私人空间">
        <a href={appPath(input.basePath, "/home")} aria-current={input.current === "home" ? "page" : undefined}>总览</a>
        {publications.length === 1
          ? <a href={appPath(input.basePath, `/p/${encodeURIComponent(publications[0].publication.publicationId)}/`)} aria-current={input.current === "daily" ? "page" : undefined}>
            {input.current === "daily" ? input.shell.publication.displayName : "日报"}
          </a>
          : publications.length > 1
            ? <details className="m51-publication-switcher" data-current={input.current === "daily" ? "true" : undefined}>
              <summary><span>{input.current === "daily" ? input.shell.publication.displayName : "日报"}</span><IconChevronDown size={16} aria-hidden="true" /></summary>
              <ul>
                {publications.map(({ publication, latest }) => <li key={publication.publicationId}><a
                  href={appPath(input.basePath, `/p/${encodeURIComponent(publication.publicationId)}/?date=${encodeURIComponent(latest!.date)}`)}
                  aria-current={input.current === "daily" && input.shell.publication.publicationId === publication.publicationId ? "page" : undefined}
                >{publication.displayName}</a></li>)}
              </ul>
            </details>
            : null}
        {input.shell.todoEnabled && input.shell.todoHasFormalData
          ? <a href={appPath(input.basePath, "/todo/")} aria-current={input.current === "todo" ? "page" : undefined}>Todo</a>
          : null}
        <a href={appPath(input.basePath, "/settings")} aria-current={input.current === "settings" ? "page" : undefined}>编辑部设置</a>
      </nav>
      <a className="m51-account" href={appPath(input.basePath, "/settings/account")} aria-label={`账户：${nickname}`}>
        <span aria-hidden="true">{[...nickname][0] ?? "你"}</span>
        <strong>{nickname}</strong>
      </a>
    </div>
  </header>;
}

export function PageDocument(input: {
  basePath: string;
  title: string;
  page: ReactPageName;
  children: ReactNode;
  shell?: ReadingShell;
  current?: string;
  readingTheme?: boolean;
  publicAction?: { href: string; label: string };
}) {
  const privatePage = Boolean(input.shell);
  const colorScheme = input.readingTheme ? input.shell?.theme.colorScheme ?? "light" : "light";
  return <html lang="zh-CN" data-theme={colorScheme} data-color-scheme={colorScheme}>
    <head>
      <meta charSet="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
      <meta name="color-scheme" content={colorScheme} />
      <meta name="robots" content="noindex, nofollow" />
      <link rel="icon" href="data:," />
      <title>{`${input.title} · DailyNews`}</title>
      <link rel="stylesheet" href={appPath(input.basePath, "/assets/m5/m5.css")} />
      {input.readingTheme && input.shell ? <link
        rel="stylesheet"
        href={appPath(input.basePath, `/assets/themes/${encodeURIComponent(input.shell.theme.id)}/${input.shell.theme.revision}.css`)}
      /> : null}
    </head>
    <body data-page={input.page} data-base-path={input.basePath}>
      <a className="m51-skip-link" href="#content">跳到正文</a>
      <Theme theme={neutralTheme} mode={colorScheme}>
        {input.shell
          ? <ProductHeader basePath={input.basePath} shell={input.shell} current={input.current ?? ""} />
          : <PublicHeader basePath={input.basePath} action={input.publicAction} />}
        {input.children}
        {input.page !== "public" && input.page !== "login" ? <footer className="m51-footer">
          <p>DailyNews · 内容属于你，控制权也属于你。</p>
        </footer> : null}
      </Theme>
      <script type="module" src={appPath(input.basePath, "/assets/m5/m5-client.js")} />
    </body>
  </html>;
}

export function PrimaryLink({ href, label }: { href: string; label: string }) {
  return <Button
    className="m51-button"
    label={label}
    variant="primary"
    size="lg"
    href={href}
    endContent={<IconArrowNarrowRight size={18} stroke={1.8} aria-hidden="true" />}
  />;
}

export function FieldShell(input: {
  id: string;
  label: string;
  helper: string;
  error?: string;
  children: ReactNode;
}) {
  return <div className="m51-field">
    <label htmlFor={input.id}>{input.label}</label>
    {input.children}
    <p id={`${input.id}-message`} className={input.error ? "m51-field-message is-error" : "m51-field-message"} role={input.error ? "alert" : undefined}>
      {input.error ?? input.helper}
    </p>
  </div>;
}

export type SettingsSection = "sites" | "themes" | "agent" | "account" | "advanced";

const settingsLinks: Array<{ number: string; key: SettingsSection; href: string; label: string }> = [
  { number: "01", key: "sites", href: "/settings/sites", label: "日报站点" },
  { number: "02", key: "themes", href: "/settings/themes", label: "主题库" },
  { number: "03", key: "agent", href: "/settings/agent", label: "Agent 授权" },
  { number: "04", key: "account", href: "/settings/account", label: "账户与安全" },
  { number: "05", key: "advanced", href: "/settings/advanced", label: "高级接入" },
];

export function SettingsLayout(input: {
  basePath: string;
  shell: ReadingShell;
  current: SettingsSection;
  title: string;
  kicker: string;
  summary: string;
  children: ReactNode;
}) {
  return <PageDocument basePath={input.basePath} title={input.title} page={input.current === "agent" ? "agent-settings" : "settings"} shell={input.shell} current="settings">
    <main className="m51-settings" id="content">
      <aside className="m51-settings-index" aria-label="设置分类">
        <p>设置</p>
        <nav>
          {settingsLinks.map((link) => <a key={link.key} href={appPath(input.basePath, link.href)} aria-current={input.current === link.key ? "page" : undefined}>
            <span>{link.number}</span><strong>{link.label}</strong>
          </a>)}
        </nav>
      </aside>
      <div className="m51-settings-workspace">
        <header className="m51-page-heading m51-page-heading--settings">
          <p className="m51-kicker">{input.kicker}</p>
          <h1>{input.title}</h1>
          <p>{input.summary}</p>
        </header>
        {input.children}
      </div>
    </main>
  </PageDocument>;
}
