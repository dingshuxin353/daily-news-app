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

function createVisual(item) {
  const visual = element("div", "issue__visual reveal");
  const placeholder = element("div", "issue__placeholder");
  placeholder.setAttribute("aria-hidden", "true");

  if (!item.image) {
    visual.append(placeholder);
    return visual;
  }

  const image = element("img", "issue__image");
  image.src = item.image;
  image.alt = item.title;
  image.loading = "lazy";
  image.decoding = "async";
  placeholder.hidden = true;
  image.addEventListener("error", () => {
    image.remove();
    placeholder.hidden = false;
  }, { once: true });
  visual.append(image, placeholder);
  return visual;
}

function createArticle(item) {
  const article = element("article", "issue");
  article.id = item.id;

  const heading = element("header", "issue__heading reveal");
  if (item.category) {
    heading.append(element("p", "issue__category", item.category));
  }
  heading.append(element("h1", "issue__title", item.title));

  const details = element("div", "issue__details reveal");
  details.append(element("p", "issue__summary", item.summary));

  const source = element("div", "issue__source");
  source.append(element("span", "issue__source-name", item.source.name));
  if (item.source.publishedAt) {
    const published = element("time", "issue__published", formatPublishedAt(item.source.publishedAt));
    published.dateTime = item.source.publishedAt;
    source.append(published);
  }

  const link = element("a", "issue__link");
  link.href = item.source.url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.append(document.createTextNode("查看原文"), element("span", "", "→"));
  details.append(source, link);

  article.append(heading, createVisual(item), details);
  return article;
}

function renderIssue(issue) {
  const content = document.querySelector("#content");
  content.replaceChildren(...issue.items.map(createArticle));
  setupMotion();
}

function renderStatus(message) {
  const content = document.querySelector("#content");
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
  if (!("IntersectionObserver" in window) || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    return;
  }

  const targets = [...document.querySelectorAll(".reveal")];
  const visibleTargets = targets.filter((target) => {
    const bounds = target.getBoundingClientRect();
    return bounds.top < window.innerHeight && bounds.bottom > 0;
  });
  visibleTargets.forEach((target) => target.classList.add("is-visible"));

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add("is-visible");
      observer.unobserve(entry.target);
    }
  }, { threshold: 0.12 });

  document.documentElement.classList.add("motion-ready");
  targets
    .filter((target) => !target.classList.contains("is-visible"))
    .forEach((target) => observer.observe(target));
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
