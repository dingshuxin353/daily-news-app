function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function shell(options: { basePath: string; title: string; body: string; page: "login" | "space" }): string {
  const basePath = escapeHtml(options.basePath);
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <meta name="color-scheme" content="light">
    <meta name="robots" content="noindex, nofollow">
    <link rel="icon" href="data:,">
    <title>${escapeHtml(options.title)} · DailyNews</title>
    <link rel="stylesheet" href="${basePath}/assets/cloud.css">
  </head>
  <body data-base-path="${basePath}" data-page="${options.page}">
    <header class="cloud-masthead">
      <p class="cloud-masthead__line">私有测试环境 · 邮箱验证登录</p>
      <p class="cloud-masthead__name">DailyNews</p>
      <hr class="cloud-masthead__rule" aria-hidden="true">
    </header>
    ${options.body}
    <footer class="cloud-footer"><p>DailyNews · 私有空间</p></footer>
    <script type="module" src="${basePath}/assets/cloud-auth.js"></script>
  </body>
</html>`;
}

export function renderLoginPage(basePath: string): string {
  return shell({
    basePath,
    title: "登录",
    page: "login",
    body: `<main class="cloud-main">
      <section class="cloud-intro" aria-labelledby="login-title">
        <p class="cloud-intro__kicker">邮箱验证</p>
        <h1 id="login-title">进入你的日报空间</h1>
        <p class="cloud-intro__summary">输入邮箱获取 6 位验证码。新邮箱验证成功后会自动建立唯一的私有 Space。</p>
      </section>
      <section class="auth-workbench" aria-label="登录步骤">
        <form class="auth-form" data-email-form data-state="idle" novalidate>
          <div class="auth-form__field">
            <label class="auth-form__label" for="email">邮箱地址</label>
            <input class="auth-form__input" id="email" name="email" type="email" autocomplete="email" inputmode="email" aria-describedby="email-helper" aria-required="true" required>
            <p class="auth-form__helper" id="email-helper" data-helper aria-live="polite">验证码有效期为 5 分钟。</p>
          </div>
          <button class="button" type="submit">发送验证码</button>
        </form>
        <form class="auth-form" data-otp-form data-state="idle" novalidate hidden>
          <input name="email" type="hidden">
          <div class="auth-form__field">
            <label class="auth-form__label" for="otp">6 位验证码</label>
            <input class="auth-form__input" id="otp" name="otp" type="text" autocomplete="one-time-code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" aria-describedby="otp-helper" aria-required="true" required>
            <p class="auth-form__helper" id="otp-helper" data-helper aria-live="polite">输入邮件中的验证码。</p>
          </div>
          <button class="button" type="submit">验证并进入</button>
        </form>
      </section>
    </main>`,
  });
}

export function renderSpacePage(input: {
  basePath: string;
  spaceName: string;
  publicationName: string;
  publicationId: string;
  todoEnabled: boolean;
  themeName: string;
}): string {
  return shell({
    basePath: input.basePath,
    title: input.spaceName,
    page: "space",
    body: `<main class="cloud-main">
      <section class="cloud-intro" aria-labelledby="space-title">
        <p class="cloud-intro__kicker">私有 Space</p>
        <h1 id="space-title">${escapeHtml(input.spaceName)}</h1>
        <p class="cloud-intro__summary">当前只显示 M2 云端身份与默认对象的最小摘要。</p>
      </section>
      <section class="space-workbench" aria-label="Space 摘要">
        <dl class="space-facts">
          <div class="space-facts__row"><dt>默认 Publication</dt><dd>${escapeHtml(input.publicationName)} · ${escapeHtml(input.publicationId)}</dd></div>
          <div class="space-facts__row"><dt>Personal Todo</dt><dd>${input.todoEnabled ? "已启用" : "已关闭"}</dd></div>
          <div class="space-facts__row"><dt>当前主题</dt><dd>${escapeHtml(input.themeName)}</dd></div>
        </dl>
        <form class="space-actions" data-logout-form>
          <button class="button button--quiet" type="submit">退出登录</button>
        </form>
      </section>
    </main>`,
  });
}
