import { Button } from "@astryxdesign/core/Button";
import { IconArrowNarrowRight, IconCircleFilled, IconExternalLink, IconKey, IconShieldLock } from "@tabler/icons-react";
import type { CredentialRecord } from "../../modules/agent-access/credential-service.js";
import type { ReadingShell } from "../../modules/private-reading/service.js";
import { CopyInstructionIsland, CopySecretIsland, LoginIsland } from "./islands.js";
import { appPath, FieldShell, PageDocument, PrimaryLink, SettingsLayout } from "./ui.js";

export function PublicPage({ basePath, signedIn }: { basePath: string; signedIn: boolean }) {
  const destination = appPath(basePath, signedIn ? "/home" : "/login");
  const action = signedIn ? "进入私人日报" : "登录 / 注册";
  return <PageDocument basePath={basePath} title="你的私人日报" page="public" publicAction={{ href: destination, label: action }}>
    <main className="m51-public-main" id="content">
      <section className="m51-public-hero" aria-labelledby="public-title">
        <div className="m51-public-copy">
          <p className="m51-kicker">Your private newsroom</p>
          <h1 id="public-title">每天一份，<br />只为你而编的<br />私人日报。</h1>
          <p>把每天关心的事交给 Agent。DailyNews 负责把结果整理成稳定、可追溯、只属于你的正式日报。</p>
          <PrimaryLink href={destination} label={action} />
        </div>
        <img src={appPath(basePath, "/assets/private-newsroom.png")} alt="几位 Agent 在编辑桌前协作整理私人日报" width="1400" height="466" fetchPriority="high" />
      </section>
      <section className="m51-public-steps" aria-labelledby="public-steps-title">
        <div className="m51-public-section-heading">
          <p className="m51-kicker">How it works</p>
          <h2 id="public-steps-title">把编辑部交给 Agent，三步开始。</h2>
        </div>
        <ol>
          <li><span>01</span><h3>发送公开说明</h3><p>把 DailyNews 的接入说明发给你信任的 Agent。</p></li>
          <li><span>02</span><h3>交付一次 Token</h3><p>Agent 主动索取时，回到 DailyNews 创建并交付授权。</p></li>
          <li><span>03</span><h3>阅读正式结果</h3><p>Agent 完成工作后，回到私人日报阅读并核对来源。</p></li>
        </ol>
      </section>
      <section className="m51-public-control" aria-labelledby="public-control-title">
        <p className="m51-kicker">Your newsroom, your control</p>
        <h2 id="public-control-title">控制权始终属于你。</h2>
        <p>日报、主题和 Agent 授权都由你管理。你可以随时轮换或撤销 Token；私人内容不会成为公开页面的一部分。</p>
      </section>
    </main>
  </PageDocument>;
}

export function LoginPage(input: { basePath: string; returnTo?: string; returnLabel?: string }) {
  return <PageDocument basePath={input.basePath} title="邮箱登录" page="login">
    <main className="m51-login-page" id="content">
      <section className="m51-login-story" aria-labelledby="login-story-title">
        <div>
          <p className="m51-kicker">One quiet doorway</p>
          <h1 id="login-story-title">进入你的<br />私人编辑部。</h1>
          <p>没有密码，也不需要先判断自己是在登录还是注册。</p>
          {input.returnLabel ? <p className="m51-return-note">登录后返回：{input.returnLabel}</p> : null}
        </div>
        <IconCircleFilled className="m51-login-sun" size={112} aria-hidden="true" />
        <img src={appPath(input.basePath, "/assets/private-newsroom.png")} alt="几位 Agent 在编辑桌前协作整理私人日报" width="1400" height="466" fetchPriority="high" />
      </section>
      <section className="m51-login-panel" aria-label="邮箱验证码登录">
        <div data-react-island="login" data-base-path={input.basePath} data-return-to={input.returnTo ?? ""}>
          <LoginIsland basePath={input.basePath} returnTo={input.returnTo} />
        </div>
      </section>
    </main>
  </PageDocument>;
}

function setupInstruction(setupUrl: string): string {
  return `请帮我把 DailyNews 用起来。\n请先完整阅读 ${setupUrl}，并按说明完成配置。`;
}

export function OnboardingPage(input: { basePath: string; shell: ReadingShell; csrfToken: string; operationId: string; setupUrl: string }) {
  const instruction = setupInstruction(input.setupUrl);
  return <PageDocument basePath={input.basePath} title="首次使用" page="onboarding" shell={input.shell}>
    <main className="m51-onboarding" id="content">
      <header className="m51-page-heading">
        <p className="m51-kicker">第一次使用</p>
        <h1>把 DailyNews 交给你的 Agent。</h1>
        <p>设置话术不包含 Token。Agent 读完说明并确认能够发送认证 HTTPS 请求后，会主动向你索取。</p>
      </header>
      <ol className="m51-onboarding-steps">
        <li>
          <span className="m51-step-number">01</span>
          <div>
            <h2>复制设置话术</h2>
            <p>先把下面两行发给你的 Agent，不要提前创建 Token。</p>
            <div data-react-island="copy-instruction" data-copy-text={instruction}>
              <CopyInstructionIsland text={instruction} />
            </div>
          </div>
        </li>
        <li>
          <span className="m51-step-number">02</span>
          <div>
            <h2>等 Agent 向你索取 Token</h2>
            <p>收到请求后再创建。完整值只显示一次，每个 Agent 使用独立名称。</p>
            <form className="m51-native-form" id="onboarding-token-form" method="post" action={appPath(input.basePath, "/onboarding/token")}>
              <input type="hidden" name="_csrf" value={input.csrfToken} />
              <input type="hidden" name="operationId" value={input.operationId} />
              <FieldShell id="onboarding-token-name" label="Token 名称" helper="1–80 个可见字符，用来区分不同 Agent。">
                <input className="m51-input" id="onboarding-token-name" name="name" defaultValue="我的 Agent" maxLength={80} aria-describedby="onboarding-token-name-message" aria-required="true" required />
              </FieldShell>
              <Button className="m51-button" label="创建 Token" variant="primary" size="lg" type="submit" icon={<IconKey size={17} aria-hidden="true" />} />
            </form>
          </div>
        </li>
      </ol>
      <section className="m51-onboarding-finish">
        <IconShieldLock size={28} stroke={1.6} aria-hidden="true" />
        <div>
          <h2>创建后继续留在 Agent 对话里</h2>
          <p>把一次性显示的完整 Token 交给刚才主动索取的受信任 Agent。Agent 会按官方说明使用 HTTPS JSON API 完成只读检查，再提交第一份日报。</p>
        </div>
        <Button className="m51-button" label="先看示例日报" variant="secondary" size="lg" href={appPath(input.basePath, "/home")} endContent={<IconArrowNarrowRight size={17} aria-hidden="true" />} />
      </section>
    </main>
  </PageDocument>;
}

export function NicknameOnboardingPage(input: {
  basePath: string;
  shell: ReadingShell;
  csrfToken: string;
  nickname?: string;
  error?: string;
}) {
  return <PageDocument basePath={input.basePath} title="先写下你的称呼" page="onboarding" shell={input.shell}>
    <main className="m51-profile-onboarding" id="content">
      <header className="m51-page-heading">
        <p className="m51-kicker">第一步</p>
        <h1>先写下你的称呼。</h1>
        <p>之后的私人编辑部会用这个昵称称呼你。它不会从邮箱地址猜测。</p>
      </header>
      <form className="m51-native-form m51-native-form--profile" method="post" action={appPath(input.basePath, "/onboarding/nickname")}>
        <input type="hidden" name="_csrf" value={input.csrfToken} />
        <FieldShell id="nickname" label="昵称" helper="1–24 个可见字符，保存后仍可在账户设置中修改。" error={input.error}>
          <input className="m51-input" id="nickname" name="nickname" defaultValue={input.nickname ?? ""} maxLength={24} aria-describedby="nickname-message" aria-invalid={Boolean(input.error)} aria-required="true" required autoFocus />
        </FieldShell>
        <Button className="m51-button" label="保存并连接 Agent" variant="primary" size="lg" type="submit" endContent={<IconArrowNarrowRight size={17} aria-hidden="true" />} />
      </form>
    </main>
  </PageDocument>;
}

function displayTime(value: Date, timeZone: string): string {
  return value.toLocaleString("zh-CN", { timeZone, hour12: false });
}

export function AgentSettingsPage(input: {
  basePath: string;
  shell: ReadingShell;
  credentials: CredentialRecord[];
  csrfToken: string;
  operationId: string;
  activeLimit: number;
}) {
  const active = input.credentials.filter((item) => item.status === "active");
  return <SettingsLayout basePath={input.basePath} shell={input.shell} current="agent" title="Agent 授权" kicker="Agent access" summary="这里只显示服务端能够确认的授权与最近请求，不判断 Agent 是否在线。">
        <section className="m51-settings-section">
          <div className="m51-section-heading">
            <div><h2>创建 Agent Token</h2><p>完整值只在创建成功后显示一次。</p></div>
            <span>{active.length} / {input.activeLimit}</span>
          </div>
          {active.length >= input.activeLimit
            ? <p className="m51-status-note">活动 Token 数量已达上限。请先撤销不再使用的 Token。</p>
            : <form className="m51-native-form" method="post" action={appPath(input.basePath, "/settings/agent/tokens")}>
                <input type="hidden" name="_csrf" value={input.csrfToken} />
                <input type="hidden" name="operationId" value={input.operationId} />
                <FieldShell id="token-name" label="Token 名称" helper="1–80 个可见字符；建议每个 Agent 使用独立名称。">
                  <input className="m51-input" id="token-name" name="name" defaultValue="我的 Agent" maxLength={80} aria-describedby="token-name-message" aria-required="true" required />
                </FieldShell>
                <Button className="m51-button" label="创建 Token" variant="primary" size="lg" type="submit" icon={<IconKey size={17} aria-hidden="true" />} />
              </form>}
        </section>
        <section className="m51-settings-section">
          <div className="m51-section-heading"><div><h2>Token 记录</h2><p>轮换或撤销只影响对应的一枚 Token。</p></div></div>
          {input.credentials.length ? <div className="m51-token-list">{input.credentials.map((item) => <article key={item.id}>
            <div>
              <p className="m51-token-state">{item.status === "active" ? "使用中" : item.status === "rotated" ? "已轮换" : "已撤销"}</p>
              <h3>{item.name}</h3>
              <p>{item.tokenHint} · 创建于 {displayTime(item.createdAt, input.shell.timeZone)}</p>
            </div>
            <dl><dt>最近一次请求</dt><dd>{item.lastUsedAt ? displayTime(item.lastUsedAt, input.shell.timeZone) : "尚无请求"}</dd></dl>
            {item.status === "active" ? <div className="m51-record-actions">
              <a href={appPath(input.basePath, `/settings/agent/tokens/${item.id}/rotate`)}>轮换</a>
              <a className="is-danger" href={appPath(input.basePath, `/settings/agent/tokens/${item.id}/revoke`)}>撤销</a>
            </div> : null}
          </article>)}</div> : <div className="m51-empty-state"><IconKey size={24} stroke={1.6} aria-hidden="true" /><div><h3>还没有 Agent Token</h3><p>当 Agent 读完接入说明并主动索取后，再在上方创建。</p></div></div>}
        </section>
        <section className="m51-settings-section m51-settings-section--advanced">
          <div><h2>高级接入</h2><p>MCP、JSON API 与 OpenAPI 的协议地址继续放在单独页面。</p></div>
          <a className="m51-text-link" href={appPath(input.basePath, "/settings/advanced")}>查看高级接入 <IconExternalLink size={16} aria-hidden="true" /></a>
        </section>
  </SettingsLayout>;
}

export function CredentialSecretPage(input: { basePath: string; shell: ReadingShell; token: string | null; title: string; returnPath?: string }) {
  const returnPath = appPath(input.basePath, input.returnPath ?? "/settings/agent");
  return <PageDocument basePath={input.basePath} title={input.title} page="agent-settings" shell={input.shell} current="settings">
    <main className="m51-secret-page" id="content">
      <p className="m51-kicker">一次性凭证</p>
      <h1>{input.title}</h1>
      {input.token ? <>
        <p>这是唯一一次显示完整 Token。请把它发给刚才主动索取的受信任 Agent；不要公开或发送给其他人。</p>
        <code className="m51-secret-value" id="agent-token-secret">{input.token}</code>
        <div data-react-island="copy-secret" data-source-id="agent-token-secret" data-return-path={returnPath}>
          <CopySecretIsland sourceId="agent-token-secret" returnPath={returnPath} />
        </div>
      </> : <p>这个操作已经处理过。为避免重放明文，DailyNews 不会再次显示之前的 Token；如未保存，请重新创建或轮换。</p>}
      <a className="m51-text-link" href={returnPath}>我已处理，返回 Agent 授权 <IconArrowNarrowRight size={17} aria-hidden="true" /></a>
    </main>
  </PageDocument>;
}

export function AgentConfirmPage(input: { basePath: string; shell: ReadingShell; title: string; description: string; action: string; csrfToken: string; submitLabel: string; hidden?: Record<string, string> }) {
  return <PageDocument basePath={input.basePath} title={input.title} page="agent-settings" shell={input.shell} current="settings">
    <main className="m51-confirm-page" id="content">
      <p className="m51-kicker">确认影响</p>
      <h1>{input.title}</h1>
      <p>{input.description}</p>
      <form method="post" action={input.action}>
        <input type="hidden" name="_csrf" value={input.csrfToken} />
        {Object.entries(input.hidden ?? {}).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)}
        <Button className="m51-button" label={input.submitLabel} variant="destructive" size="lg" type="submit" />
      </form>
      <a className="m51-text-link" href={appPath(input.basePath, "/settings/agent")}>取消并返回</a>
    </main>
  </PageDocument>;
}
