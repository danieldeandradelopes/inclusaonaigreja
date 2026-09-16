const { spawn } = require("child_process");
const fs = require("fs");

const PORT = 9333;
const URL = process.argv[2] || "http://127.0.0.1:5500/apresentacao-criancas.html";
const OUT = process.argv[3] || "/tmp/slides-check";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(url, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch {}
    await sleep(150);
  }
  throw new Error("Chrome debug port not ready");
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener("open", () => resolve(ws));
    ws.addEventListener("error", reject);
  });
}

function makeCdp(ws) {
  let id = 0;
  const pending = new Map();
  const events = new Map();
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    } else if (msg.method && events.has(msg.method)) {
      events.get(msg.method).forEach((fn) => fn(msg.params));
    }
  });
  return {
    send(method, params = {}) {
      const reqId = ++id;
      return new Promise((resolve, reject) => {
        pending.set(reqId, { resolve, reject });
        ws.send(JSON.stringify({ id: reqId, method, params }));
      });
    },
    once(method) {
      return new Promise((resolve) => {
        const fn = (params) => {
          const list = events.get(method) || [];
          events.set(
            method,
            list.filter((x) => x !== fn)
          );
          resolve(params);
        };
        const list = events.get(method) || [];
        list.push(fn);
        events.set(method, list);
      });
    },
  };
}

(async () => {
  pkillPort();
  const chrome = spawn(
    "/usr/bin/google-chrome",
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=/tmp/chrome-qa-${Date.now()}`,
      "--window-size=1400,900",
      "about:blank",
    ],
    { stdio: "ignore" }
  );

  try {
    await waitFor(`http://127.0.0.1:${PORT}/json/version`);
    const tabs = await waitFor(`http://127.0.0.1:${PORT}/json/list`);
    const page = tabs.find((t) => t.type === "page") || tabs[0];
    if (!page?.webSocketDebuggerUrl) throw new Error("No page target: " + JSON.stringify(tabs));
    const ws = await connect(page.webSocketDebuggerUrl);
    const cdp = makeCdp(ws);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    const loaded = cdp.once("Page.loadEventFired");
    await cdp.send("Page.navigate", { url: URL });
    await Promise.race([loaded, sleep(4000)]);
    await sleep(500);

    async function evalExpr(expression) {
      const res = await cdp.send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (res.exceptionDetails) {
        throw new Error(JSON.stringify(res.exceptionDetails));
      }
      return res.result.value;
    }

    const initial = await evalExpr(`({
      total: document.querySelectorAll('.slide').length,
      active: document.querySelector('.slide.active')?.dataset.slide || null,
      display: getComputedStyle(document.querySelector('.slide.active')).display,
      opacity: getComputedStyle(document.querySelector('.slide.active')).opacity,
    })`);

    await evalExpr(`document.getElementById('next').click()`);
    await sleep(180);
    const mid = await evalExpr(`(() => {
      const slides = [...document.querySelectorAll('.slide')];
      const active = document.querySelector('.slide.active');
      const leaving = slides.find(s => s.classList.contains('leave-left') || s.classList.contains('leave-right'));
      const a = active ? getComputedStyle(active) : null;
      const l = leaving ? getComputedStyle(leaving) : null;
      return {
        active: active?.dataset.slide || null,
        activeOpacity: a ? Number(a.opacity) : null,
        activeTransform: a?.transform || null,
        leaving: leaving?.dataset.slide || null,
        leavingOpacity: l ? Number(l.opacity) : null,
        leavingTransform: l?.transform || null,
      };
    })()`);

    await sleep(700);
    const after = await evalExpr(`({
      active: document.querySelector('.slide.active')?.dataset.slide || null,
      opacity: Number(getComputedStyle(document.querySelector('.slide.active')).opacity),
      transform: getComputedStyle(document.querySelector('.slide.active')).transform,
    })`);

    await evalExpr(`document.getElementById('prev').click()`);
    await sleep(180);
    const backMid = await evalExpr(`(() => {
      const leaving = [...document.querySelectorAll('.slide')].find(s => s.classList.contains('leave-left') || s.classList.contains('leave-right'));
      return {
        active: document.querySelector('.slide.active')?.dataset.slide || null,
        leaving: leaving?.dataset.slide || null,
        leavingClass: leaving?.className || null,
        leavingOpacity: leaving ? Number(getComputedStyle(leaving).opacity) : null,
      };
    })()`);

    await sleep(700);
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(`${OUT}/anim-after.png`, Buffer.from(shot.data, "base64"));

    const result = { url: URL, initial, mid, after, backMid };
    fs.writeFileSync(`${OUT}/anim-qa.json`, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    ws.close();
  } finally {
    chrome.kill("SIGKILL");
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

function pkillPort() {}
