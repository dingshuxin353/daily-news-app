const paths = {
  site: "/config/site.json",
  index: "/data/index.json",
  issue: (date) => `/data/compiled/${date}.json`,
};

let currentItemsById = new Map();
let sourcePanelTrigger = null;

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

function createArticle(item, module, isFirst) {
  const article = element("article", `story story--${module.size}`);
  article.id = item.id;
  article.dataset.size = module.size;
  article.dataset.span = String(module.span);
  article.style.gridColumn = `span ${module.span}`;

  const heading = element("header", "story__header");
  if (item.category && module.size !== "small") {
    heading.append(element("p", "story__category", item.category));
  }
  heading.append(element(isFirst ? "h1" : "h2", "story__title", item.title));

  const summary = element("p", "story__summary", module.size === "large" ? item.summary : item.brief);
  const source = element("div", "story__source");
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
    const rowElement = element("section", `layout-row${rowIndex === 0 ? " layout-row--first" : " reveal"}`);
    rowElement.dataset.usedCapacity = String(row.usedCapacity);
    rowElement.setAttribute("aria-label", `版面第 ${rowIndex + 1} 行`);

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
  setupMotion();
}

function renderStatus(message) {
  const content = document.querySelector("#content");
  content.className = "";
  const status = element("p", "status", message);
  status.setAttribute("role", "status");
  content.replaceChildren(status);
  currentItemsById = new Map();
}

function setupSite(site) {
  document.documentElement.style.setProperty("--color-accent", site.accentColor);
  document.title = site.name;

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

function setupMotion() {
  document.documentElement.classList.remove("motion-ready");
  const targets = [...document.querySelectorAll(".reveal")];
  if (!("IntersectionObserver" in window) || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    targets.forEach((target) => target.classList.add("is-visible"));
    return;
  }

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add("is-visible");
      observer.unobserve(entry.target);
    }
  }, { threshold: 0.08 });

  document.documentElement.classList.add("motion-ready");
  targets.forEach((target) => observer.observe(target));
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

async function loadIssue(date, dates, updateUrl = false) {
  closeSourcePanel();
  updateNavigation(date, dates);
  if (updateUrl) history.pushState({ date }, "", `/?date=${date}`);
  window.scrollTo({ top: 0, behavior: "auto" });
  renderStatus("正在加载日报…");

  try {
    renderIssue(await fetchJson(paths.issue(date)));
  } catch (error) {
    console.error(error);
    renderStatus("这期日报暂时无法加载");
  }
}

async function start() {
  let site;
  let index;
  try {
    [site, index] = await Promise.all([fetchJson(paths.site), fetchJson(paths.index)]);
  } catch (error) {
    console.error(error);
    renderStatus("页面暂时无法加载");
    return;
  }

  setupSite(site);
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
  const date = selectDate(location.search, index);
  const requested = new URLSearchParams(location.search).get("date");
  if (requested && requested !== date) history.replaceState({ date }, "", "/");

  document.querySelector(".date-nav").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-direction]");
    if (!button || button.disabled) return;
    loadIssue(button.dataset.date, index.dates, true);
  });

  window.addEventListener("popstate", () => {
    loadIssue(selectDate(location.search, index), index.dates);
  });

  await loadIssue(date, index.dates);
}

if (typeof document !== "undefined") start();
