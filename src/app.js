const paths = {
  site: "/config/site.json",
  index: "/data/index.json",
  issue: (date) => `/data/issues/${date}.json`,
};

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

export function partitionItems(items) {
  return {
    lead: items[0],
    secondary: items.slice(1, 3),
    remaining: items.slice(3),
  };
}

async function fetchJson(path) {
  const response = await fetch(path, { cache: "no-cache" });
  if (!response.ok) {
    throw new Error(`Failed to load ${path}: ${response.status}`);
  }
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

function createVisual(item, role) {
  const visual = element("div", `story__visual story__visual--${role}`);
  const placeholder = element("div", "story__placeholder");
  placeholder.setAttribute("aria-hidden", "true");

  if (!item.image) {
    if (role !== "lead") return null;
    visual.append(placeholder);
    return visual;
  }

  const image = element("img", "story__image");
  image.src = item.image;
  image.alt = item.title;
  image.loading = role === "lead" ? "eager" : "lazy";
  image.decoding = "async";

  if (role === "lead") {
    placeholder.hidden = true;
    visual.append(image, placeholder);
  } else {
    visual.append(image);
  }

  image.addEventListener("error", () => {
    if (role === "lead") {
      image.remove();
      placeholder.hidden = false;
    } else {
      visual.remove();
    }
  }, { once: true });

  return visual;
}

function createArticle(item, role) {
  const article = element("article", `story story--${role}${role === "standard" ? " reveal" : ""}`);
  article.id = item.id;

  const heading = element("header", "story__header");
  if (item.category) {
    heading.append(element("p", "story__category", item.category));
  }
  heading.append(element(role === "lead" ? "h1" : "h2", "story__title", item.title));

  const visual = createVisual(item, role);
  const summary = element("p", "story__summary", item.summary);

  const source = element("div", "story__source");
  const sourceDetails = element("div", "story__source-details");
  sourceDetails.append(element("span", "story__source-name", item.source.name));
  if (item.source.publishedAt) {
    const published = element("time", "story__published", formatPublishedAt(item.source.publishedAt));
    published.dateTime = item.source.publishedAt;
    sourceDetails.append(published);
  }

  const link = element("a", "story__link", "查看原文 ↗");
  link.href = item.source.url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  source.append(sourceDetails, link);

  article.append(heading);
  if (visual) article.append(visual);
  article.append(summary, source);
  return article;
}

function renderIssue(issue) {
  const { lead, secondary, remaining } = partitionItems(issue.items);
  const content = document.querySelector("#content");
  content.className = "news-page";

  const leadLayout = element("section", "lead-layout");
  leadLayout.setAttribute("aria-label", "主要新闻");
  leadLayout.append(createArticle(lead, "lead"));

  if (secondary.length > 0) {
    const secondaryColumn = element("div", "secondary-column");
    secondaryColumn.append(...secondary.map((item) => createArticle(item, "secondary")));
    leadLayout.append(secondaryColumn);
  } else {
    leadLayout.classList.add("lead-layout--solo");
  }

  const sections = [leadLayout];
  if (remaining.length > 0) {
    const grid = element("section", "news-grid");
    grid.setAttribute("aria-label", "更多新闻");
    grid.append(...remaining.map((item) => createArticle(item, "standard")));
    sections.push(grid);
  }

  content.replaceChildren(...sections);
  setupMotion();
}

function renderStatus(message) {
  const content = document.querySelector("#content");
  content.className = "";
  const status = element("p", "status", message);
  status.setAttribute("role", "status");
  content.replaceChildren(status);
}

function setupSite(site) {
  document.documentElement.style.setProperty("--color-accent", site.accentColor);
  document.title = site.name;

  const name = document.querySelector(".brand__name");
  const logo = document.querySelector(".brand__logo");
  name.textContent = site.name;
  if (site.logo) {
    logo.src = site.logo;
    logo.alt = site.name;
    logo.hidden = false;
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
  updateNavigation(date, dates);
  if (updateUrl) {
    history.pushState({ date }, "", `/?date=${date}`);
  }
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
  const date = selectDate(location.search, index);
  const requested = new URLSearchParams(location.search).get("date");
  if (requested && requested !== date) {
    history.replaceState({ date }, "", "/");
  }

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

if (typeof document !== "undefined") {
  start();
}
