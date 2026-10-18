#!/usr/bin/env python3
"""QA screenshot: verify the terminal renders live data before recording GIFs."""
import asyncio
from playwright.async_api import async_playwright

URL = "http://localhost:3000"

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(args=["--force-color-profile=srgb", "--disable-lcd-text", "--hide-scrollbars"])
        ctx = await browser.new_context(viewport={"width": 1440, "height": 900}, device_scale_factor=1)
        page = await ctx.new_page()
        errors = []
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(str(e)))
        await page.goto(URL, wait_until="networkidle", timeout=45000)
        # wait for universe rows with live data
        await page.wait_for_selector("table tbody tr", timeout=20000)
        await page.wait_for_timeout(6000)  # let data flow
        await page.screenshot(path="/home/z/my-project/scripts/gif/qa-top.png")
        await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
        await page.wait_for_timeout(1200)
        await page.screenshot(path="/home/z/my-project/scripts/gif/qa-bottom.png")
        # collect structural info for choreography
        info = await page.evaluate("""() => {
          const rows = [...document.querySelectorAll('table tbody tr')].length;
          const badges = [...document.querySelectorAll('header *')].filter(e=>e.children.length===0 && e.textContent.trim().length>0 && e.textContent.trim().length<30).map(e=>e.textContent.trim()).slice(0,20);
          const h = document.body.scrollHeight;
          return {rows, badges, height: h};
        }""")
        print("ROWS:", info["rows"], "| PAGE-HEIGHT:", info["height"])
        print("HEADER-BADGES:", " | ".join(info["badges"]))
        print("CONSOLE-ERRORS:", len(errors), errors[:3])
        await browser.close()

asyncio.run(main())
