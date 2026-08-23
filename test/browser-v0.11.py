import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright


base_url = sys.argv[1].rstrip("/")
output_dir = Path(sys.argv[2])
output_dir.mkdir(parents=True, exist_ok=True)
results = {}

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    desktop = browser.new_context(viewport={"width": 1440, "height": 1000})
    page = desktop.new_page()
    console_errors = []
    page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
    page.route("https://cdn.example.com/failure.jpg", lambda route: route.abort())

    page.goto(f"{base_url}/")
    page.wait_for_load_state("networkidle")
    assert page.locator("h1").inner_text() == "我的日报"
    assert page.locator(".home-directory").is_visible()
    assert not page.locator("#publication-select").is_visible()
    assert page.locator(".home-directory__nav a").all_inner_texts() == ["总览", "AI 日报", "财经日报", "本地日报"]
    assert page.locator(".home-publication").count() == 3
    assert page.locator(".home-publication__status").all_inner_texts() == ["今日更新", "最近更新 2026-08-22", "暂无日报"]
    assert page.locator(".home-highlight .story__image").count() == 2
    home_image_box = page.locator(".home-highlight .story__image").first.bounding_box()
    assert abs(home_image_box["width"] / home_image_box["height"] - 1.5) < 0.03, home_image_box
    page.screenshot(path=output_dir / "home-desktop.png", full_page=True)
    results["home_desktop"] = "passed"

    failed_home = desktop.new_page()
    failed_home.route(
        "**/*",
        lambda route: route.abort() if route.request.resource_type == "image" else route.continue_(),
    )
    failed_home.goto(f"{base_url}/")
    failed_home.wait_for_load_state("networkidle")
    assert failed_home.locator(".home-highlight img").count() == 0
    assert failed_home.locator(".home-highlight .story__media").count() == 0
    results["home_all_images_failed_fallback"] = "passed"
    failed_home.close()

    with page.expect_navigation():
        page.locator('.home-highlight h3 a[href*="#test-item-1"]').first.click()
    page.wait_for_load_state("networkidle")
    assert page.url.endswith("/p/ai-daily/?date=2026-08-23#test-item-1")
    assert page.evaluate("document.activeElement.id") == "test-item-1"
    assert page.locator(".publication-menu").is_visible()
    assert page.locator('.publication-menu a[aria-current="page"]').inner_text() == "AI 日报"
    assert page.locator('.story--large[data-media-variant="lead-split"] img').count() == 1
    assert page.locator('.story--large img').get_attribute("loading") == "eager"
    publication_image_box = page.locator(".story--large img").bounding_box()
    assert abs(publication_image_box["width"] / publication_image_box["height"] - 1.5) < 0.03, publication_image_box
    assert page.locator("#test-item-1").bounding_box()["y"] >= 60
    assert page.locator('.story--medium[data-media-variant="none"] .story__title').count() >= 1
    assert page.locator('.story--small img').count() == 0
    assert page.get_by_text("测试标题 2", exact=True).is_visible()
    page.screenshot(path=output_dir / "publication-desktop.png", full_page=True)
    results["publication_deep_link_and_image_fallback"] = "passed"

    page.goto(f"{base_url}/p/ai-daily/?date=2026-08-23#unknown-item")
    page.wait_for_load_state("networkidle")
    assert page.url.endswith("/p/ai-daily/?date=2026-08-23#unknown-item")
    anchor_status = page.locator("#edition-status").text_content()
    assert anchor_status == "未找到指定内容", anchor_status
    results["unknown_anchor"] = "passed"

    mobile = browser.new_context(viewport={"width": 390, "height": 844})
    mobile_page = mobile.new_page()
    mobile_page.route("https://cdn.example.com/failure.jpg", lambda route: route.abort())
    mobile_page.goto(f"{base_url}/")
    mobile_page.wait_for_load_state("networkidle")
    assert not mobile_page.locator(".home-directory").is_visible()
    assert mobile_page.locator("#publication-select").is_visible()
    assert mobile_page.locator(".publication-select-label").is_visible()
    assert mobile_page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
    mobile_page.screenshot(path=output_dir / "home-mobile.png", full_page=True)
    with mobile_page.expect_navigation():
        mobile_page.locator("#publication-select").select_option("/p/finance-daily/")
    mobile_page.wait_for_load_state("networkidle")
    assert mobile_page.locator("html").get_attribute("data-theme") == "midnight-tech"
    assert mobile_page.locator("#publication-select").input_value() == "/p/finance-daily/"
    assert mobile_page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
    mobile_page.screenshot(path=output_dir / "publication-mobile.png", full_page=True)
    results["mobile_navigation_and_theme"] = "passed"

    no_script = browser.new_context(java_script_enabled=False, viewport={"width": 1200, "height": 900})
    no_script_page = no_script.new_page()
    no_script_page.goto(f"{base_url}/")
    assert no_script_page.locator(".home-directory__nav a").count() == 4
    assert no_script_page.locator(".home-highlight h3 a").count() == 2
    no_script_page.goto(f"{base_url}/p/ai-daily/")
    assert no_script_page.locator(".noscript-fallback").is_visible()
    assert no_script_page.locator(".noscript-fallback .story__credit").count() == 2
    results["no_javascript"] = "passed"

    unexpected_errors = [message for message in console_errors if "net::ERR_FAILED" not in message]
    assert unexpected_errors == [], unexpected_errors
    results["expected_image_failures"] = len(console_errors)
    no_script.close()
    mobile.close()
    desktop.close()
    browser.close()

print(json.dumps({"results": results, "screenshots": str(output_dir)}, ensure_ascii=False))
