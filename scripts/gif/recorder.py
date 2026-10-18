#!/usr/bin/env python3
"""XARB terminal GIF recorder — long, detailed demos of the live UI at :81.

Scenes:
  tour      — full terminal walk (universe → cards → charts → triggers/CLOB → feeds)
  universe  — market focus switching + live series enable/disable
  clob      — CLOB book ladder + charts deep dive (crosshair hover)
  settings  — every knob live: sliders actually re-drive the engine
  fire      — relaxed-threshold live capture (probe subprocess fires a real paper trade)
"""
import asyncio, os, re, sys, time
from playwright.async_api import async_playwright

BASE = "http://localhost:81"
OUT = "/tmp/xarb-gif"   # tmpfs — the project disk write speed bottlenecks capture
FPS = 10
VP = (1440, 900)
FLAGS = ["--hide-scrollbars", "--force-color-profile=srgb", "--disable-lcd-text",
         "--font-render-hinting=none", "--disable-smooth-scrolling", "--blink-settings=imageAnimation=false"]


# ───────────────────────────── recorder core ─────────────────────────────
class Rec:
    def __init__(self, page, scene):
        self.page = page
        self.dir = os.path.join(OUT, f"frames-{scene}")
        os.makedirs(self.dir, exist_ok=True)
        for f in os.listdir(self.dir):
            if f.endswith(".jpg"):
                os.remove(os.path.join(self.dir, f))
        self.running = False
        self.count = 0
        self.task = None

    async def start(self):
        self.running = True
        self.task = asyncio.create_task(self._loop())

    async def _loop(self):
        interval = 1.0 / FPS
        i = 0
        while self.running:
            t0 = time.monotonic()
            try:
                await self.page.screenshot(path=os.path.join(self.dir, f"f_{i:05d}.jpg"), quality=88, type="jpeg")
                i += 1
                self.count = i
            except Exception as e:
                print("  [rec] screenshot failed:", e)
                await asyncio.sleep(0.1)
            dt = time.monotonic() - t0
            if dt < interval:
                await asyncio.sleep(interval - dt)

    async def stop(self):
        self.running = False
        if self.task:
            try:
                await asyncio.wait_for(self.task, timeout=15)
            except Exception:
                pass
        print(f"  [rec] {self.count} frames → {self.dir}")

    async def tick(self, label):
        now = time.monotonic()
        if not hasattr(self, "_t0"):
            self._t0, self._f0 = now, 0
        dt = now - getattr(self, "_t0", now)
        df = self.count - getattr(self, "_f0", 0)
        print(f"  [tick] {label:34s} +{dt:5.1f}s  {df:3d}f  ({df/max(dt,0.01):.1f} fps)")
        self._t0, self._f0 = now, self.count


# ───────────────────────────── interaction helpers ─────────────────────────────
async def smooth_scroll(page, y, dur_ms):
    await page.evaluate(
        """async ([y, dur]) => {
            const y0 = window.scrollY, t0 = performance.now();
            await new Promise(res => {
                function step(t) {
                    const p = Math.min((t - t0) / dur, 1);
                    const e = p < 0.5 ? 4*p*p*p : 1 - Math.pow(-2*p + 2, 3) / 2;
                    window.scrollTo(0, y0 + (y - y0) * e);
                    if (p < 1) requestAnimationFrame(step); else res();
                }
                requestAnimationFrame(step);
            });
        }""",
        [int(max(0, y)), int(dur_ms)],
    )


async def text_y(page, t):
    return await page.evaluate(
        """(t) => {
            const els = [...document.querySelectorAll('span, section, div, h2, button')];
            for (const el of els) {
                if (el.childElementCount === 0) {
                    const txt = el.textContent.trim();
                    if (txt === t || txt.startsWith(t)) return Math.round(el.getBoundingClientRect().top + window.scrollY);
                }
            }
            return -1;
        }""",
        t,
    )


async def canvas_y(page, aria):
    box = await page.locator(f'canvas[aria-label="{aria}"]').first.bounding_box()
    return None if box is None else int(box["y"] + await page.evaluate("() => window.scrollY"))


async def scroll_to_text(page, t, pad=70, dur=2200):
    y = await text_y(page, t)
    if y < 0:
        print(f"  [warn] anchor not found: {t}")
        return
    await smooth_scroll(page, y - pad, dur)


async def ready(page):
    await page.goto(BASE, wait_until="domcontentloaded", timeout=60000)
    await page.wait_for_selector("table tbody tr", timeout=30000)
    await page.wait_for_function("() => document.body.innerText.includes('LIVE')", timeout=15000)
    await asyncio.sleep(5)


async def slider_index_for(page, label):
    return await page.evaluate(
        """(label) => {
            const sliders = [...document.querySelectorAll('[data-slot=slider]')];
            for (let i = 0; i < sliders.length; i++) {
                let el = sliders[i];
                for (let d = 0; d < 4; d++) {
                    if (!el.parentElement) break;
                    el = el.parentElement;
                    const t = el.textContent || '';
                    if (t.includes(label) && t.length < 160) return i;
                }
            }
            return -1;
        }""",
        label,
    )


async def drag_slider(page, label, frac, steps=10, step_ms=80):
    """frac: 0..1 position along the track to drag the thumb to."""
    idx = await slider_index_for(page, label)
    if idx < 0:
        print(f"  [warn] slider not found: {label}")
        return
    root = page.locator("[data-slot=slider]").nth(idx)
    track = root.locator("[data-slot=slider-track]").first
    thumb = root.locator("[data-slot=slider-thumb]").first
    tb = await track.bounding_box()
    hb = await thumb.bounding_box()
    if not tb or not hb:
        print(f"  [warn] no bbox for slider {label}")
        return
    x0, y0 = hb["x"] + hb["width"] / 2, hb["y"] + hb["height"] / 2
    x1 = tb["x"] + min(max(frac, 0.02), 0.98) * tb["width"]
    await page.mouse.move(x0, y0)
    await page.mouse.down()
    for s in range(1, steps + 1):
        await page.mouse.move(x0 + (x1 - x0) * s / steps, y0, steps=1)
        await asyncio.sleep(step_ms / 1000)
    await page.mouse.up()


async def read_hint(page, label):
    txt = await page.evaluate(
        """(label) => {
            const sliders = [...document.querySelectorAll('[data-slot=slider]')];
            for (let i = 0; i < sliders.length; i++) {
                let el = sliders[i];
                for (let d = 0; d < 4; d++) {
                    if (!el.parentElement) break;
                    el = el.parentElement;
                    const t = el.textContent || '';
                    if (t.includes(label) && t.length < 160) return t;
                }
            }
            return '';
        }""",
        label,
    )
    m = re.search(r"(\d+(?:\.\d+)?)\s*[\u00a2c]", txt)
    return float(m.group(1)) if m else None


async def slide_keyboard(page, label, target, max_steps=60, press_ms=95):
    """Step a shadcn/Radix slider to an exact value with arrow keys (each press
    commits through onValueCommit → engine → snapshot → UI)."""
    idx = await slider_index_for(page, label)
    if idx < 0:
        print(f"  [warn] slider not found: {label}")
        return
    thumb = page.locator("[data-slot=slider]").nth(idx).locator("[data-slot=slider-thumb]").first
    await thumb.scroll_into_view_if_needed()
    await thumb.click()
    await asyncio.sleep(0.3)
    for _ in range(max_steps):
        cur = await read_hint(page, label)
        if cur is None or abs(cur - target) <= 0.51:
            break
        key = "ArrowLeft" if cur > target else "ArrowRight"
        await page.keyboard.press(key)
        await asyncio.sleep(press_ms / 1000)
    final = await read_hint(page, label)
    print(f"  [slider] {label} -> {final}")


async def sheet_scroll(page, y, dur_ms):
    """Smooth-scroll the settings sheet's inner scroll container."""
    await page.evaluate(
        """async ([y, dur]) => {
            const sc = [...document.querySelectorAll('[data-slot=sheet-content] div, [data-slot=sheet-content]')]
              .find(e => (e.className || '').toString().includes('overflow-y-auto'));
            if (!sc) return;
            const y0 = sc.scrollTop, t0 = performance.now();
            await new Promise(res => {
                function step(t) {
                    const p = Math.min((t - t0) / dur, 1);
                    const e = p < 0.5 ? 4*p*p*p : 1 - Math.pow(-2*p + 2, 3) / 2;
                    sc.scrollTop = y0 + (y - y0) * e;
                    if (p < 1) requestAnimationFrame(step); else res();
                }
                requestAnimationFrame(step);
            });
        }""",
        [int(y), int(dur_ms)],
    )


async def hover_path(page, aria, n=24, span_ms=160, dy=0.0):
    box = await page.locator(f'canvas[aria-label="{aria}"]').first.bounding_box()
    if box is None:
        return
    cx, w, h = box["x"] + box["width"] / 2, box["width"], box["height"]
    for i in range(n):
        x = box["x"] + w * (0.75 - 0.55 * (i / max(1, n - 1)))
        y = box["y"] + h / 2 + (dy * h) if dy else box["y"] + h / 2
        await page.mouse.move(x, y)
        await asyncio.sleep(span_ms / 1000)
    _ = cx


# ───────────────────────────── scenes ─────────────────────────────
async def scene_tour():
    async with async_playwright() as p:
        browser = await p.chromium.launch(args=FLAGS)
        ctx = await browser.new_context(viewport={"width": VP[0], "height": VP[1]}, device_scale_factor=1)
        page = await ctx.new_page()
        await ready(page)
        rec = Rec(page, "tour")
        await rec.start()
        try:
            await asyncio.sleep(6); await rec.tick("hold top")
            await smooth_scroll(page, 380, 2600)
            await asyncio.sleep(4); await rec.tick("universe rows")
            await scroll_to_text(page, "σ auto-calibration", 130, 2400)
            await asyncio.sleep(5); await rec.tick("stat+v04 cards")
            cy = await canvas_y(page, "Focus market price chart")
            if cy: await smooth_scroll(page, cy - 150, 2400)
            await asyncio.sleep(9); await rec.tick("charts")
            await scroll_to_text(page, "Trigger conditions", 90, 2400)
            await asyncio.sleep(9); await rec.tick("triggers+clob+latency")
            await scroll_to_text(page, "Signal feed", 90, 2400)
            await asyncio.sleep(8); await rec.tick("feeds+blotter")
            await smooth_scroll(page, await page.evaluate("() => document.body.scrollHeight - 900"), 2200)
            await asyncio.sleep(6); await rec.tick("footer")
        finally:
            await rec.stop()
        await browser.close()


async def scene_universe():
    async with async_playwright() as p:
        browser = await p.chromium.launch(args=FLAGS)
        ctx = await browser.new_context(viewport={"width": VP[0], "height": VP[1]}, device_scale_factor=1)
        page = await ctx.new_page()
        await ready(page)
        rec = Rec(page, "universe")
        await rec.start()
        try:
            await asyncio.sleep(4)
            await page.get_by_role("row").filter(has_text="ETH 5m").first.click()      # focus → ETH
            await asyncio.sleep(3)
            await scroll_to_text(page, "σ auto-calibration", 130, 2400); await asyncio.sleep(6)  # panels re-bound to ETH
            cy = await canvas_y(page, "Focus market price chart")
            if cy: await smooth_scroll(page, cy - 150, 2000); await asyncio.sleep(4)
            await smooth_scroll(page, 0, 2000); await asyncio.sleep(2)                 # back to universe
            await page.get_by_role("row").filter(has_text="XRP 15m").first.click()     # focus → XRP 15m
            await asyncio.sleep(3)
            await scroll_to_text(page, "σ auto-calibration", 130, 2200); await asyncio.sleep(5)
            await smooth_scroll(page, 0, 2200); await asyncio.sleep(2)
            await page.get_by_role("button", name="Disable DOGE 5m").click()           # 11 → 10 live
            await asyncio.sleep(4)
            await page.get_by_role("button", name="Enable DOGE 5m").click()            # back to 11
            await asyncio.sleep(4)
        finally:
            await rec.stop()
        await browser.close()


async def scene_clob():
    async with async_playwright() as p:
        browser = await p.chromium.launch(args=FLAGS)
        ctx = await browser.new_context(viewport={"width": VP[0], "height": VP[1]}, device_scale_factor=1)
        page = await ctx.new_page()
        await ready(page)
        rec = Rec(page, "clob")
        await rec.start()
        try:
            cy = await canvas_y(page, "Focus market price chart")
            if cy: await smooth_scroll(page, cy - 150, 2200)
            await asyncio.sleep(2)
            await hover_path(page, "Focus market price chart", n=22, span_ms=170)      # crosshair sweep
            await asyncio.sleep(3)
            await hover_path(page, "Fair value versus Polymarket ask chart", n=18, span_ms=170, dy=0.0)
            await asyncio.sleep(3)
            await scroll_to_text(page, "Polymarket CLOB", 120, 2200)
            await asyncio.sleep(13)                                                    # live ladder flashing
            await scroll_to_text(page, "Latency · measured live", 110, 1800)
            await asyncio.sleep(8)
        finally:
            await rec.stop()
        await browser.close()


async def scene_settings():
    async with async_playwright() as p:
        browser = await p.chromium.launch(args=FLAGS)
        ctx = await browser.new_context(viewport={"width": VP[0], "height": VP[1]}, device_scale_factor=1)
        page = await ctx.new_page()
        await ready(page)
        rec = Rec(page, "settings")
        await rec.start()
        try:
            await asyncio.sleep(3)
            await page.get_by_role("button", name="Settings").click()
            await asyncio.sleep(1.8)
            await asyncio.sleep(2.5)                                    # sheet top: universe section
            await sheet_scroll(page, 1500, 1800); await asyncio.sleep(1.2)
            await slide_keyboard(page, "① 5s FV jump trigger", 6)
            await asyncio.sleep(1.2)
            await slide_keyboard(page, "③ Minimum edge vs ask", 5)
            await asyncio.sleep(1.2)
            await slide_keyboard(page, "② FV floor", 52)
            await asyncio.sleep(1.8)
            await page.keyboard.press("Escape")
            await asyncio.sleep(1.5)
            await scroll_to_text(page, "Trigger conditions", 90, 2300)  # LEDs now relaxed
            await asyncio.sleep(7)
            await smooth_scroll(page, 0, 1900)
            await asyncio.sleep(1.5)
            await page.get_by_role("button", name="Settings").click()
            await asyncio.sleep(1.4)
            btn = page.get_by_role("button", name="Restore default settings")
            await btn.scroll_into_view_if_needed(); await asyncio.sleep(0.8)
            await btn.click(); await asyncio.sleep(1.8)
            await page.keyboard.press("Escape")
            await asyncio.sleep(2.5)
        finally:
            await rec.stop()
        await browser.close()


async def scene_fire():
    """Directed capture: cycle sections pre-fire; on FIRE-FLAG switch to the
    post-fire story (feed → blotter → universe Δ → capture card). Long recording
    trimmed later around the fire frame."""
    FLAG = "/tmp/xarb-gif/FIRE-FLAG"
    async with async_playwright() as p:
        browser = await p.chromium.launch(args=FLAGS)
        ctx = await browser.new_context(viewport={"width": VP[0], "height": VP[1]}, device_scale_factor=1)
        page = await ctx.new_page()
        await ready(page)
        rec = Rec(page, "fire")
        probe_log = open("/tmp/xarb-gif/probe.log", "w")
        probe = await asyncio.create_subprocess_exec(
            "bun", "scripts/gif/watch-fire.ts",
            cwd="/home/z/my-project",
            stdout=probe_log, stderr=asyncio.subprocess.STDOUT,
        )
        await rec.start()
        fire_frame = None
        try:
            # pre-fire cycle: relaxed thresholds land ~2s after probe start
            await asyncio.sleep(6)
            anchors = ["universe_top", "charts", "triggers", "feeds"]
            ys = {}
            ys["universe_top"] = 0
            ys["charts"] = (await canvas_y(page, "Focus market price chart") or 1250) - 150
            ys["triggers"] = max(0, (await text_y(page, "Trigger conditions") or 1600) - 90)
            ys["feeds"] = max(0, (await text_y(page, "Signal feed") or 2050) - 90)
            order = ["universe_top", "universe_top", "charts", "triggers", "feeds", "feeds"]
            i = 0
            t_cycle = time.monotonic()
            while time.monotonic() - t_cycle < 540:            # up to 9 minutes
                if os.path.exists(FLAG):
                    fire_frame = rec.count
                    print(f"  [fire] FIRE detected at frame {fire_frame}")
                    break
                if probe.returncode is not None and fires_probe_done(probe):
                    break
                tgt = order[i % len(order)]
                await smooth_scroll(page, ys[tgt], 1800)
                hold = 7 if tgt != "feeds" else 9
                for _ in range(hold * 10):
                    if os.path.exists(FLAG):
                        break
                    await asyncio.sleep(0.1)
                i += 1
            # post-fire choreography
            if fire_frame is not None:
                await smooth_scroll(page, ys["feeds"], 1600)
                await asyncio.sleep(18)                       # EXECUTED + HEDGE rows stream in
                await smooth_scroll(page, ys["feeds"] + 380, 1500)  # blotter row
                await asyncio.sleep(10)
                await smooth_scroll(page, 0, 1900)
                await asyncio.sleep(9)                         # universe: Δ chip + pos + capture strip
                await scroll_to_text(page, "Value capture", 130, 1800)
                await asyncio.sleep(8)                         # capture accounting card
            else:
                print("  [fire] NO FIRE during window — fallback hold on feeds")
                await smooth_scroll(page, ys["feeds"], 1800)
                await asyncio.sleep(12)
        finally:
            await rec.stop()
            print(f"  [fire] fire_frame={fire_frame} total={rec.count}")
        try:
            await asyncio.wait_for(probe.wait(), timeout=50)
        except Exception:
            probe.kill()
            print("  [warn] probe killed (still running)")
        probe_log.close()
        try:
            with open("/tmp/xarb-gif/probe.log") as f:
                print("---- probe output ----")
                print("".join(f.readlines()[-18:]))
        except Exception:
            pass
        await browser.close()


def fires_probe_done(probe):
    return True


SCENES = {"tour": scene_tour, "universe": scene_universe, "clob": scene_clob,
          "settings": scene_settings, "fire": scene_fire}

if __name__ == "__main__":
    names = sys.argv[1:] or ["tour"]
    for n in names:
        print(f"=== scene: {n} ===")
        asyncio.run(SCENES[n]())
