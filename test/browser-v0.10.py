import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright


base_url = sys.argv[1].rstrip("/")
output_dir = Path(sys.argv[2] if len(sys.argv) > 2 else "/tmp/daily-news-v0.10-browser")
output_dir.mkdir(parents=True, exist_ok=True)

results = {}
with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    desktop = browser.new_context(viewport={"width": 1440, "height": 1000})
    page = desktop.new_page()
    console_errors = []
    page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)

    page.goto(f"{base_url}/")
    page.wait_for_load_state("networkidle")
    assert page.url == f"{base_url}/p/ai-daily/"
    assert page.locator(".brand__name").inner_text() == "AI 日报"
    assert page.locator("#publication-select option").count() == 2
    assert page.locator("html").get_attribute("data-theme") == "newspaper-default"
    assert page.locator("#content h1").count() == 1
    page.screenshot(path=output_dir / "ai-daily-desktop.png", full_page=True)

    page.keyboard.press("Tab")
    page.keyboard.press("Tab")
    assert page.evaluate("document.activeElement.id") == "publication-select"
    with page.expect_navigation():
        page.locator("#publication-select").select_option("/p/finance-daily/")
    page.wait_for_load_state("networkidle")
    assert page.url == f"{base_url}/p/finance-daily/"
    assert page.locator(".brand__name").inner_text() == "财经日报"
    assert page.locator("html").get_attribute("data-theme") == "midnight-tech"
    page.screenshot(path=output_dir / "finance-daily-desktop.png", full_page=True)
    assert console_errors == [], console_errors
    results["desktop_switch_and_theme"] = "passed"

    page.goto(f"{base_url}/p/finance-daily/?date=2026-08-17")
    page.wait_for_load_state("networkidle")
    assert page.get_by_text("这期日报不存在", exact=True).count() == 1
    response = page.goto(f"{base_url}/p/unknown-publication/")
    assert response is not None and response.status == 404
    results["unknown_and_missing_routes"] = "passed"

    mobile = browser.new_context(viewport={"width": 390, "height": 844})
    mobile_page = mobile.new_page()
    mobile_page.goto(f"{base_url}/p/ai-daily/")
    mobile_page.wait_for_load_state("networkidle")
    assert mobile_page.locator("#publication-select").is_visible()
    assert mobile_page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
    mobile_page.screenshot(path=output_dir / "ai-daily-mobile.png", full_page=True)
    results["mobile_layout"] = "passed"

    no_script = browser.new_context(java_script_enabled=False, viewport={"width": 1200, "height": 900})
    no_script_page = no_script.new_page()
    no_script_page.goto(f"{base_url}/p/finance-daily/")
    assert no_script_page.locator(".noscript-fallback").is_visible()
    assert no_script_page.locator(".noscript-fallback__item").count() > 0
    assert no_script_page.locator(".noscript-fallback__item a").first.get_attribute("href").startswith("https://")
    results["no_javascript_fallback"] = "passed"

    results["console_errors"] = 0
    no_script.close()
    mobile.close()
    desktop.close()
    browser.close()

print(json.dumps({"results": results, "screenshots": str(output_dir)}, ensure_ascii=False))
