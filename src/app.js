const paths = {
  site: "/config/site.json",
  index: "/data/index.json",
  issue: (date) => `/data/compiled/${date}.json`,
  activeTheme: "/themes/active.json",
  themePreview: (id) => `/themes/previews/${id}.json`,
};

let currentItemsById = new Map();
let sourcePanelTrigger = null;
let currentSiteName = "DailyNews";

export function selectDate(search, index) {
  const requested = new URLSearchParams(search).get("date");
  return index.dates.includes(requested) ? requested : index.latest;
}

export function getAdjacentDates(date, dates) {
  const currentIndex = dates.indexOf(date);
  return {
    previous: currentIndex < dates.length - 1 ? dates[currentIndex + 1] : null,
    next: currentIndex > 0 ? dates[currentIndex - 1] : null,
  };
}

async function fetchJson(path) {
  const response = await fetch(path, { cache: "no-cache" });
  if (!response.ok) throw new Error(`Failed to load ${path}: ${response.status}`);
  return response.json();
}

async function fetchOptionalJson(path) {
  const response = await fetch(path, { cache: "no-cache" });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Failed to load ${path}: ${response.status}`);
  return response.json();
}

export function selectThemeRequest(search) {
  const id = new URLSearchParams(search).get("themePreview");
  return id && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) ? id : null;
}

async function loadThemeManifest(search) {
  const previewId = selectThemeRequest(search);
  if (previewId) return { manifest: await fetchJson(paths.themePreview(previewId)), preview: true };
  if (document.querySelector("#active-theme")) return { manifest: null, preview: false };
  return { manifest: await fetchOptionalJson(paths.activeTheme), preview: false };
}

function relativeLuminance(color) {
  const channels = [1, 3, 5].map((start) => Number.parseInt(color.slice(start, start + 2), 16) / 255);
  const [red, green, blue] = channels.map((value) => (
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  ));
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function manifestColorScheme(manifest) {
  return manifest.colorScheme
    ?? (relativeLuminance(manifest.colors.background) < 0.36 ? "dark" : "light");
}

async function applyTheme(manifest, preview = false) {
  if (!manifest) return false;
  const stylesheet = document.createElement("link");
  stylesheet.id = preview ? "theme-preview" : "active-theme";
  stylesheet.rel = "stylesheet";
  stylesheet.href = manifest.cssPath;
  const loaded = new Promise((resolve, reject) => {
    stylesheet.addEventListener("load", resolve, { once: true });
    stylesheet.addEventListener("error", () => reject(new Error(`Failed to load ${manifest.cssPath}`)), { once: true });
  });
  document.head.append(stylesheet);
  try {
    await loaded;
  } catch (error) {
    stylesheet.remove();
    throw error;
  }
  const root = document.documentElement;
  for (const [name, value] of Object.entries(manifest.attributes)) root.dataset[name] = value;
  const colorScheme = manifestColorScheme(manifest);
  root.style.colorScheme = colorScheme;
  document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", colorScheme);
  return true;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatPublishedAt(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function classifyTitleLength(title) {
  const length = [...title.trim()].length;
  if (length <= 28) return "standard";
  if (length <= 40) return "long";
  return "extra-long";
}

function createArticle(item, module, isFirst) {
  const article = element("article", `story story--${module.size}`);
  article.id = item.id;
  article.dataset.size = module.size;
  article.dataset.span = String(module.span);
  if (module.size === "large") article.dataset.titleLength = classifyTitleLength(item.title);
  article.style.gridColumn = `span ${module.span}`;

  const heading = element("header", "story__header");
  if (item.category && module.size !== "small") {
    heading.append(element("p", "story__category", item.category));
  }
  heading.append(element(isFirst ? "h1" : "h2", "story__title", item.title));

  const summary = element("p", "story__summary", module.size === "large" ? item.summary : item.brief);
  const source = element("footer", "story__source");
  const primarySource = item.sources[0];
  const link = element("a", "story__primary-source", `${primarySource.name} ↗`);
  link.href = primarySource.url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  source.append(link);
  if (item.sources.length > 1) {
    const sourceCount = element("button", "story__source-count", `查看全部 ${item.sources.length} 个来源`);
    sourceCount.type = "button";
    sourceCount.dataset.itemId = item.id;
    source.append(sourceCount);
  }
  article.append(heading, summary, source);
  return article;
}

function createSourceEntry(source, index) {
  const entry = element("li", "source-panel__item");
  entry.append(element("p", "source-panel__role", index === 0 ? "主要来源" : "补充来源"));
  entry.append(element("h3", "source-panel__name", source.name));
  if (source.originalTitle) {
    entry.append(element("p", "source-panel__original-title", source.originalTitle));
  }
  if (source.publishedAt) {
    const published = element("time", "source-panel__published", formatPublishedAt(source.publishedAt));
    published.dateTime = source.publishedAt;
    entry.append(published);
  }
  const originalLink = element("a", "source-panel__link", "打开原文 ↗");
  originalLink.href = source.url;
  originalLink.target = "_blank";
  originalLink.rel = "noopener noreferrer";
  entry.append(originalLink);
  if (source.via) {
    const via = element("p", "source-panel__via", "经由 ");
    const viaLink = element("a", "", source.via.name);
    viaLink.href = source.via.url;
    viaLink.target = "_blank";
    viaLink.rel = "noopener noreferrer";
    via.append(viaLink);
    entry.append(via);
  }
  return entry;
}

function openSourcePanel(item, trigger) {
  const panel = document.querySelector("#source-panel");
  sourcePanelTrigger = trigger;
  panel.querySelector(".source-panel__title").textContent = item.title;
  panel.querySelector(".source-panel__list").replaceChildren(
    ...item.sources.map(createSourceEntry),
  );
  panel.showModal();
  panel.querySelector(".source-panel__close").focus();
}

function closeSourcePanel() {
  const panel = document.querySelector("#source-panel");
  if (panel.open) panel.close();
}

function renderIssue(issue) {
  const content = document.querySelector("#content");
  currentItemsById = new Map(issue.items.map((item) => [item.id, item]));
  let articleIndex = 0;

  const rows = issue.layout.rows.map((row, rowIndex) => {
    const rowElement = element("div", `layout-row${rowIndex === 0 ? " layout-row--first" : ""}`);
    rowElement.dataset.usedCapacity = String(row.usedCapacity);
    rowElement.dataset.row = String(rowIndex + 1);

    for (const module of row.modules) {
      const item = currentItemsById.get(module.itemId);
      if (!item) throw new Error(`Compiled layout references missing item: ${module.itemId}`);
      rowElement.append(createArticle(item, module, articleIndex === 0));
      articleIndex += 1;
    }
    return rowElement;
  });

  content.className = "news-page";
  content.replaceChildren(...rows);
}

function renderStatus(message) {
  const content = document.querySelector("#content");
  content.className = "";
  const status = element("p", "status", message);
  status.setAttribute("role", "status");
  content.replaceChildren(status);
  currentItemsById = new Map();
}

function setupSite(site, hasTheme) {
  currentSiteName = site.name;
  document.documentElement.style.setProperty("--site-accent", site.accentColor);
  if (!hasTheme) document.documentElement.style.setProperty("--color-accent", site.accentColor);

  const name = document.querySelector(".brand__name");
  name.textContent = site.name;
  if (site.logo) {
    const logo = element("img", "brand__logo");
    logo.src = site.logo;
    logo.alt = site.name;
    name.before(logo);
    name.hidden = true;
  }
}

function updateNavigation(date, dates) {
  const adjacent = getAdjacentDates(date, dates);
  const current = document.querySelector(".date-nav__current");
  current.dateTime = date;
  current.textContent = date.replaceAll("-", ".");

  for (const direction of ["previous", "next"]) {
    const button = document.querySelector(`[data-direction="${direction}"]`);
    button.disabled = !adjacent[direction];
    button.dataset.date = adjacent[direction] ?? "";
  }
}

function updateDateUrl(date, method) {
  const url = new URL(location.href);
  url.searchParams.set("date", date);
  history[method]({ date }, "", `${url.pathname}${url.search}${url.hash}`);
}

function focusLoadedIssue() {
  const target = document.querySelector("#content h1") ?? document.querySelector("#content");
  target.tabIndex = -1;
  target.dataset.focusOrigin = "programmatic";
  target.addEventListener("blur", () => delete target.dataset.focusOrigin, { once: true });
  target.focus({ preventScroll: true });
}

async function loadIssue(date, dates, options = {}) {
  const { historyMethod = null, focusAfterLoad = false } = options;
  closeSourcePanel();
  window.scrollTo({ top: 0, behavior: "auto" });
  renderStatus("正在加载日报…");

  try {
    const issue = await fetchJson(paths.issue(date));
    renderIssue(issue);
    updateNavigation(date, dates);
    if (historyMethod) updateDateUrl(date, historyMethod);
    document.title = `${date} · ${currentSiteName}`;
    document.querySelector("#edition-status").textContent = `${date} 内容已加载`;
    if (focusAfterLoad) focusLoadedIssue();
  } catch (error) {
    console.error(error);
    renderStatus("这期日报暂时无法加载");
  }
}

async function start() {
  let site;
  let index;
  let themeRequest;
  const previewId = selectThemeRequest(location.search);
  try {
    [site, index, themeRequest] = await Promise.all([
      fetchJson(paths.site),
      fetchJson(paths.index),
      loadThemeManifest(location.search),
    ]);
    await applyTheme(themeRequest.manifest, themeRequest.preview);
  } catch (error) {
    console.error(error);
    renderStatus(previewId ? `主题预览 ${previewId} 加载失败` : "页面暂时无法加载");
    return;
  }

  setupSite(site, Boolean(themeRequest.manifest || document.querySelector("#active-theme")));
  const sourcePanel = document.querySelector("#source-panel");
  sourcePanel.querySelector(".source-panel__close").addEventListener("click", closeSourcePanel);
  sourcePanel.addEventListener("close", () => {
    sourcePanelTrigger?.focus();
    sourcePanelTrigger = null;
  });
  document.querySelector("#content").addEventListener("click", (event) => {
    const button = event.target.closest(".story__source-count");
    if (!button) return;
    const item = currentItemsById.get(button.dataset.itemId);
    if (item) openSourcePanel(item, button);
  });
  if (index.dates.length === 0) {
    renderStatus("暂无日报");
    document.title = currentSiteName;
    for (const button of document.querySelectorAll(".date-nav__button")) button.disabled = true;
    return;
  }

  const date = selectDate(location.search, index);
  const requested = new URLSearchParams(location.search).get("date");
  if (requested && requested !== date) {
    const url = new URL(location.href);
    url.searchParams.delete("date");
    history.replaceState({ date }, "", `${url.pathname}${url.search}${url.hash}`);
  }

  document.querySelector(".date-nav").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-direction]");
    if (!button || button.disabled) return;
    loadIssue(button.dataset.date, index.dates, { historyMethod: "pushState", focusAfterLoad: true });
  });

  window.addEventListener("popstate", () => {
    loadIssue(selectDate(location.search, index), index.dates, { focusAfterLoad: true });
  });

  await loadIssue(date, index.dates);
}

if (typeof document !== "undefined") start();
