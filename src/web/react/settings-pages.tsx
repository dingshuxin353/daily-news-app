import type { CSSProperties, ReactNode } from "react";
import { Button } from "@astryxdesign/core/Button";
import {
  IconArrowDown,
  IconArrowNarrowRight,
  IconArrowUp,
  IconExternalLink,
  IconPlus,
} from "@tabler/icons-react";
import type { UserProfile } from "../../modules/identity/profile-service.js";
import type { ReadingShell } from "../../modules/private-reading/service.js";
import type {
  ManagedPublication,
  SiteManagementSnapshot,
} from "../../modules/site-management/service.js";
import type { BrowserTheme } from "../../modules/site-management/theme-catalog.js";
import { CopyInstructionIsland, LogoutIsland } from "./islands.js";
import { appPath, FieldShell, PageDocument, SettingsLayout } from "./ui.js";

type ThemeSelection = { mode: "inherit" } | { mode: "override"; themeId: string };

type ThemePreviewStyle = CSSProperties & {
  "--m51-preview-background": string;
  "--m51-preview-text": string;
  "--m51-preview-muted": string;
  "--m51-preview-accent": string;
  "--m51-preview-rule": string;
};

function ThemePreview({ theme, compact = false }: { theme: BrowserTheme; compact?: boolean }) {
  const style: ThemePreviewStyle = {
    "--m51-preview-background": theme.preview.background,
    "--m51-preview-text": theme.preview.text,
    "--m51-preview-muted": theme.preview.muted,
    "--m51-preview-accent": theme.preview.accent,
    "--m51-preview-rule": theme.preview.rule,
  };
  return <figure className={compact ? "m51-theme-preview is-compact" : "m51-theme-preview"} style={style} aria-label={`${theme.name} 固定内容预览`}>
    <div className="m51-theme-preview__masthead"><strong>DailyNews</strong><time>08 / 31</time></div>
    <div className="m51-theme-preview__story">
      <small>今日简报</small>
      <h3>把重要信息排在前面</h3>
      <p>三条与你有关的更新，按阅读顺序整理。</p>
    </div>
    <figcaption>私人日报 · 正式内容</figcaption>
  </figure>;
}

function ThemeChoices(input: {
  themes: BrowserTheme[];
  selected: ThemeSelection;
  allowInherit: boolean;
  homeThemeName?: string;
}) {
  return <fieldset className="m51-theme-choices">
    <legend>主题</legend>
    <p>选择只影响这个站点的正式阅读页面。</p>
    {input.allowInherit ? <label className="m51-theme-choice">
      <input type="radio" name="themeMode" value="inherit" defaultChecked={input.selected.mode === "inherit"} required />
      <span className="m51-theme-choice__inherit" aria-hidden="true">Home</span>
      <span><strong>跟随 Home</strong><small>{input.homeThemeName ?? "随 Home 主题更新"}</small></span>
    </label> : null}
    {input.themes.map((theme, index) => <label className="m51-theme-choice" key={theme.themeId}>
      <input
        type="radio"
        name="themeMode"
        value={`override:${theme.themeId}`}
        defaultChecked={input.selected.mode === "override" && input.selected.themeId === theme.themeId}
        required={!input.allowInherit && index === 0}
      />
      <ThemePreview theme={theme} compact />
      <span><strong>{theme.name}</strong><small>{theme.source === "official" ? "DailyNews 官方" : "你的自定义主题"}</small></span>
    </label>)}
  </fieldset>;
}

function Status({ children }: { children?: ReactNode }) {
  return children ? <p className="m51-form-status" role="status">{children}</p> : null;
}

function PublicationCard(input: {
  basePath: string;
  publication: ManagedPublication;
  csrfToken: string;
  index: number;
  total: number;
  themes: BrowserTheme[];
  homeThemeId: string;
}) {
  const publication = input.publication;
  const active = publication.status === "active";
  const effectiveThemeId = publication.theme.mode === "inherit" ? input.homeThemeId : publication.theme.themeId;
  const theme = input.themes.find((item) => item.themeId === effectiveThemeId);
  if (!theme) throw new Error("effective browser theme is unavailable");
  const routeId = encodeURIComponent(publication.publicationId);
  return <article className={active ? "m51-site-card" : "m51-site-card is-inactive"} id={`site-${routeId}`} tabIndex={-1}>
    <header>
      <div><p className="m51-kicker">{publication.isPrimary ? "首要日报" : active ? "启用中" : "已停用"}</p><h3>{publication.name}</h3></div>
      <code>{`/p/${publication.publicationId}/`}</code>
    </header>
    <ThemePreview theme={theme} compact />
    <p>{publication.theme.mode === "inherit" ? `跟随 Home · ${theme.name}` : `独立主题 · ${theme.name}`}</p>
    <div className="m51-site-actions">
      <Button className="m51-button" label="配置" variant="secondary" size="md" href={appPath(input.basePath, `/settings/sites/${routeId}`)} />
      <a className="m51-text-link" href={appPath(input.basePath, `/p/${routeId}/`)}>打开 <IconExternalLink size={16} aria-hidden="true" /></a>
      {active ? <>
        <form method="post" action={appPath(input.basePath, `/settings/sites/${routeId}/move`)}>
          <input type="hidden" name="_csrf" value={input.csrfToken} /><input type="hidden" name="direction" value="up" />
          <button className="m51-icon-button" type="submit" aria-label={`上移 ${publication.name}`} disabled={input.index === 0}><IconArrowUp size={18} aria-hidden="true" /></button>
        </form>
        <form method="post" action={appPath(input.basePath, `/settings/sites/${routeId}/move`)}>
          <input type="hidden" name="_csrf" value={input.csrfToken} /><input type="hidden" name="direction" value="down" />
          <button className="m51-icon-button" type="submit" aria-label={`下移 ${publication.name}`} disabled={input.index === input.total - 1}><IconArrowDown size={18} aria-hidden="true" /></button>
        </form>
      </> : null}
    </div>
  </article>;
}

export function SitesPage(input: {
  basePath: string;
  shell: ReadingShell;
  snapshot: SiteManagementSnapshot;
  csrfToken: string;
  publicationLimit: number;
  themes: BrowserTheme[];
  reason?: string;
  updated?: string;
  created?: ManagedPublication;
}) {
  const active = input.snapshot.publications.filter((item) => item.status === "active");
  const inactive = input.snapshot.publications.filter((item) => item.status === "inactive");
  const atLimit = input.snapshot.publications.length >= input.publicationLimit;
  const homeTheme = input.themes.find((item) => item.themeId === input.snapshot.home.themeId);
  if (!homeTheme) throw new Error("Home browser theme is unavailable");
  const updates: Record<string, string> = {
    moved: "日报顺序已更新；首要日报会随第一项同步变化。",
    disabled: "日报站点已停用；已有正式内容仍可阅读。",
    restored: "日报站点已恢复，并排在启用列表末尾。",
    "todo-disabled": "Personal Todo 已关闭；已有正式数据仍会保留。",
  };
  const instruction = input.created
    ? `请继续使用已有的 DailyNews 连接，为“${input.created.name}”（私有地址 /p/${input.created.publicationId}/）设置长期关注内容与更新时间，并立即生成第一份日报让我确认。`
    : null;
  return <SettingsLayout basePath={input.basePath} shell={input.shell} current="sites" title="日报站点" kicker="Site index" summary="Home 固定在最前；启用中的日报按这里的顺序排列，第一项就是 Agent 默认写入目标。">
    <Status>{input.reason === "todo-disabled" ? "Personal Todo 尚未启用。请在本页末尾确认启用。" : input.updated ? updates[input.updated] : undefined}</Status>
    {instruction ? <section className="m51-created-instruction" aria-labelledby="created-title">
      <p className="m51-kicker">站点已创建</p><h2 id="created-title">把下一步交给已有 Agent</h2>
      <div data-react-island="copy-instruction" data-copy-text={instruction}><CopyInstructionIsland text={instruction} /></div>
    </section> : null}
    <section className="m51-settings-section m51-home-setting">
      <div><p className="m51-kicker">固定入口</p><h2>{input.snapshot.home.name}</h2><code>/home</code></div>
      <div className="m51-site-theme"><ThemePreview theme={homeTheme} compact /><p>{homeTheme.name}</p></div>
      <div className="m51-site-actions"><Button className="m51-button" label="配置 Home" variant="secondary" size="md" href={appPath(input.basePath, "/settings/sites/home")} /><a className="m51-text-link" href={appPath(input.basePath, "/home")}>打开 <IconExternalLink size={16} aria-hidden="true" /></a></div>
    </section>
    <section className="m51-settings-section">
      <div className="m51-section-heading"><div><p className="m51-kicker">启用中</p><h2>日报列表</h2></div><span>{input.snapshot.publications.length} / {input.publicationLimit}</span></div>
      <div className="m51-site-list">{active.map((publication, index) => <PublicationCard key={publication.publicationId} basePath={input.basePath} publication={publication} csrfToken={input.csrfToken} index={index} total={active.length} themes={input.themes} homeThemeId={input.snapshot.home.themeId} />)}</div>
      {atLimit ? <p className="m51-field-message">数量已达上限；停用项也会计入上限。</p> : <Button className="m51-button" label="新建日报站点" variant="primary" size="lg" href={appPath(input.basePath, "/settings/sites/new")} icon={<IconPlus size={17} aria-hidden="true" />} />}
    </section>
    {inactive.length ? <section className="m51-settings-section">
      <p className="m51-kicker">保留内容</p><h2>已停用</h2><p className="m51-section-copy">停用项不能接收新写入，但已有正式日报仍可阅读。</p>
      <div className="m51-site-list">{inactive.map((publication) => <PublicationCard key={publication.publicationId} basePath={input.basePath} publication={publication} csrfToken={input.csrfToken} index={0} total={0} themes={input.themes} homeThemeId={input.snapshot.home.themeId} />)}</div>
    </section> : null}
    <section className="m51-settings-section m51-todo-setting" id="personal-todo" tabIndex={-1}>
      <div><p className="m51-kicker">固定能力</p><h2>Personal Todo</h2><p>{input.snapshot.todo.enabled ? "Agent 可以读取和提交个人任务。关闭后已有正式内容会保留。" : "默认关闭；启用后 Agent 才能保存个人任务。"}</p><p>{input.snapshot.todo.hasFormalData ? "已保留正式 Todo 数据，本页不读取任务正文。" : "尚无正式 Todo 数据。"}</p></div>
      <div className="m51-site-actions">{input.snapshot.todo.enabled ? <><Button className="m51-button" label="关闭" variant="destructive" size="md" href={appPath(input.basePath, "/settings/sites/todo/disable")} /><a className="m51-text-link" href={appPath(input.basePath, "/todo/")}>打开 <IconExternalLink size={16} aria-hidden="true" /></a></> : <form method="post" action={appPath(input.basePath, "/settings/sites/todo/enable")}><input type="hidden" name="_csrf" value={input.csrfToken} /><Button className="m51-button" label="启用" variant="primary" size="md" type="submit" /></form>}</div>
    </section>
  </SettingsLayout>;
}

export function HomeSettingsPage(input: { basePath: string; shell: ReadingShell; snapshot: SiteManagementSnapshot; themes: BrowserTheme[]; csrfToken: string; name?: string; themeId?: string; error?: string; saved?: boolean }) {
  const selectedThemeId = input.themeId ?? input.snapshot.home.themeId;
  return <SettingsLayout basePath={input.basePath} shell={input.shell} current="sites" title="配置 Home" kicker="Home" summary="Home 是私人编辑部的固定首页，名称和主题会影响所有跟随 Home 的日报站点。">
    <Status>{input.saved ? "Home 设置已保存。" : undefined}</Status>
    <form className="m51-settings-form m51-settings-section" method="post" action={appPath(input.basePath, "/settings/sites/home")}>
      <input type="hidden" name="_csrf" value={input.csrfToken} />
      <FieldShell id="home-name" label="Home 名称" helper="1–40 个可见字符。" error={input.error}>
        <input className="m51-input" id="home-name" name="name" defaultValue={input.name ?? input.snapshot.home.name} maxLength={40} aria-describedby="home-name-message" aria-invalid={Boolean(input.error)} required />
      </FieldShell>
      <FieldShell id="home-path" label="固定路径" helper="这个地址不会随名称变化。"><input className="m51-input" id="home-path" value="/home" readOnly /></FieldShell>
      <ThemeChoices themes={input.themes} selected={{ mode: "override", themeId: selectedThemeId }} allowInherit={false} />
      <Button className="m51-button" label="保存 Home" variant="primary" size="lg" type="submit" />
    </form>
  </SettingsLayout>;
}

export function PublicationFormPage(input: { basePath: string; shell: ReadingShell; themes: BrowserTheme[]; csrfToken: string; mode: "new" | "edit"; publication?: ManagedPublication; name?: string; publicationId?: string; theme?: ThemeSelection; error?: string; saved?: boolean }) {
  const edit = input.mode === "edit";
  const name = input.name ?? input.publication?.name ?? "";
  const publicationId = input.publicationId ?? input.publication?.publicationId ?? "";
  const theme = input.theme ?? input.publication?.theme ?? { mode: "inherit" as const };
  const title = edit ? `配置 ${input.publication?.name ?? "日报站点"}` : "新建日报站点";
  return <SettingsLayout basePath={input.basePath} shell={input.shell} current="sites" title={title} kicker={edit ? "Publication" : "New publication"} summary={edit ? "地址创建后保持不变；名称与主题可以一起安全保存。" : "先建立一个空站点，再把清晰的设置话术交给已有 Agent。"}>
    <Status>{input.saved ? "站点设置已保存。" : undefined}</Status>
    <form className="m51-settings-form m51-settings-section" method="post" action={appPath(input.basePath, edit ? `/settings/sites/${encodeURIComponent(publicationId)}` : "/settings/sites/new")}>
      <input type="hidden" name="_csrf" value={input.csrfToken} />
      <FieldShell id="publication-name" label="站点名称" helper="1–40 个可见字符。" error={input.error}><input className="m51-input" id="publication-name" name="name" defaultValue={name} maxLength={40} aria-describedby="publication-name-message" aria-invalid={Boolean(input.error)} required /></FieldShell>
      <FieldShell id="publication-id" label="私有地址" helper="只使用小写字母、数字和单个连字符；创建后不可修改。" error={input.error}>
        <div className="m51-path-input"><span>/p/</span><input className="m51-input" id="publication-id" name="publicationId" defaultValue={publicationId} pattern="[a-z0-9]+(?:-[a-z0-9]+)*" aria-describedby="publication-id-message" aria-invalid={Boolean(input.error)} readOnly={edit} required /><span>/</span></div>
      </FieldShell>
      <ThemeChoices themes={input.themes} selected={theme} allowInherit homeThemeName="跟随当前 Home 主题" />
      <Button className="m51-button" label={edit ? "保存站点" : "创建站点"} variant="primary" size="lg" type="submit" />
    </form>
    {edit ? <section className="m51-settings-section m51-danger-zone"><h2>{input.publication?.status === "active" ? "停用站点" : "恢复站点"}</h2><p>{input.publication?.status === "active" ? "停用会拒绝 Agent 新写入；已有正式日报仍可阅读。" : "恢复后会排在启用列表末尾，并重新允许 Agent 写入。"}</p>{input.publication?.status === "active" ? <Button className="m51-button" label="停用这个站点" variant="destructive" size="md" href={appPath(input.basePath, `/settings/sites/${encodeURIComponent(publicationId)}/status/disable`)} /> : <form method="post" action={appPath(input.basePath, `/settings/sites/${encodeURIComponent(publicationId)}/status/restore`)}><input type="hidden" name="_csrf" value={input.csrfToken} /><Button className="m51-button" label="恢复站点" variant="primary" size="md" type="submit" /></form>}</section> : null}
  </SettingsLayout>;
}

export function PublicationLimitPage(input: { basePath: string; shell: ReadingShell; publicationLimit: number }) {
  return <SettingsLayout basePath={input.basePath} shell={input.shell} current="sites" title="无法新建日报站点" kicker="Publication limit" summary={`当前 Space 已有 ${input.publicationLimit} 份日报站点；停用项也计入上限。`}>
    <section className="m51-settings-section"><h2>先整理现有站点</h2><p>停用不会释放名额，因为既有正式内容仍需保留。DailyNews 当前不提供物理删除；请返回日报站点查看现有配置。</p><Button className="m51-button" label="返回日报站点" variant="secondary" size="md" href={appPath(input.basePath, "/settings/sites")} /></section>
  </SettingsLayout>;
}

export function ThemeCatalogPage(input: { basePath: string; shell: ReadingShell; themes: BrowserTheme[] }) {
  return <SettingsLayout basePath={input.basePath} shell={input.shell} current="themes" title="主题库" kicker="Theme catalog" summary="这里是只读目录。选择主题请回到 Home 或具体日报站点的配置页。">
    <section className="m51-theme-catalog" aria-label="可用主题">{input.themes.map((theme) => <article className="m51-theme-card" key={theme.themeId}><ThemePreview theme={theme} /><div><p className="m51-kicker">{theme.source === "official" ? "DailyNews 官方" : "你的自定义主题"}</p><h2>{theme.name}</h2></div></article>)}</section>
  </SettingsLayout>;
}

export function AccountSettingsPage(input: { basePath: string; shell: ReadingShell; csrfToken: string; profile: UserProfile; nickname?: string; error?: string; saved?: boolean }) {
  const nickname = input.nickname ?? input.profile.nickname ?? "";
  return <SettingsLayout basePath={input.basePath} shell={input.shell} current="account" title="账户与安全" kicker="Account" summary="管理浏览器账户的称呼与当前登录会话。Agent 授权在单独的栏目中管理。">
    <Status>{input.saved ? "昵称已保存。" : undefined}</Status>
    <section className="m51-settings-section"><h2>个人资料</h2><form className="m51-settings-form" method="post" action={appPath(input.basePath, "/settings/account/nickname")}><input type="hidden" name="_csrf" value={input.csrfToken} /><FieldShell id="account-nickname" label="昵称" helper="1–24 个可见字符。" error={input.error}><input className="m51-input" id="account-nickname" name="nickname" defaultValue={nickname} maxLength={24} aria-describedby="account-nickname-message" aria-invalid={Boolean(input.error)} required /></FieldShell><Button className="m51-button" label="保存昵称" variant="primary" size="md" type="submit" /></form></section>
    <section className="m51-settings-section"><h2>登录身份</h2><dl className="m51-fact-list"><div><dt>邮箱</dt><dd>{input.profile.email}</dd></div><div><dt>认证方式</dt><dd>邮箱验证码</dd></div></dl></section>
    <section className="m51-settings-section"><h2>当前会话</h2><p>退出只结束当前浏览器会话，不会撤销 Agent 的独立授权。</p><div data-react-island="logout" data-base-path={input.basePath}><LogoutIsland basePath={input.basePath} /></div></section>
  </SettingsLayout>;
}

export function AdvancedAccessPage(input: { basePath: string; shell: ReadingShell; apiBaseUrl: string; mcpUrl: string }) {
  return <SettingsLayout basePath={input.basePath} shell={input.shell} current="advanced" title="高级接入" kicker="Advanced access" summary="为自己的脚本或高级客户端提供协议地址与机器可读契约。Token 统一在 Agent 授权中管理。">
    <section className="m51-settings-section"><h2>接口地址</h2><dl className="m51-fact-list"><div><dt>JSON API</dt><dd><code>{input.apiBaseUrl}</code></dd></div><div><dt>MCP</dt><dd><code>{input.mcpUrl}</code></dd></div></dl><a className="m51-text-link" href={appPath(input.basePath, "/settings/advanced/openapi.yaml")}>下载 OpenAPI 契约 <IconArrowNarrowRight size={17} aria-hidden="true" /></a></section>
    <section className="m51-settings-section m51-settings-section--advanced"><div><h2>Agent Token</h2><p>MCP 与 JSON API 使用同一套 Agent Token。创建、一次性查看、轮换和撤销都在 Agent 授权页面完成。</p></div><Button className="m51-button" label="前往 Agent 授权" variant="secondary" size="md" href={appPath(input.basePath, "/settings/agent")} /></section>
    <section className="m51-settings-section"><h2>高级说明</h2><p>JSON API 使用 Bearer 鉴权和 Idempotency-Key；MCP 使用远程 Streamable HTTP。具体字段以 OpenAPI 与 MCP 工具 Schema 为准。</p></section>
  </SettingsLayout>;
}

export function SettingsConfirmPage(input: { basePath: string; shell: ReadingShell; title: string; description: string; action: string; csrfToken: string; submitLabel: string; hidden?: Record<string, string>; cancelPath: string; cancelLabel?: string }) {
  return <PageDocument basePath={input.basePath} title={input.title} page="settings" shell={input.shell} current="settings"><main className="m51-confirm-page" id="content"><p className="m51-kicker">确认影响</p><h1>{input.title}</h1><p>{input.description}</p><form method="post" action={input.action}><input type="hidden" name="_csrf" value={input.csrfToken} />{Object.entries(input.hidden ?? {}).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)}<Button className="m51-button" label={input.submitLabel} variant="destructive" size="lg" type="submit" /></form><a className="m51-text-link" href={appPath(input.basePath, input.cancelPath)}>{input.cancelLabel ?? "取消并返回"}</a></main></PageDocument>;
}
