/**
 * background.js - Service Worker
 * 负责滚动截图 + 调度 offscreen 合成
 */

const OFFSCREEN_URL = chrome.runtime.getURL('offscreen.html');

/**
 * Chrome 对 captureVisibleTab 的速率限制约为 2次/秒。
 * 用一个令牌桶 + 时间戳来保证两次调用间隔 >= MIN_CAPTURE_INTERVAL。
 */
const MIN_CAPTURE_INTERVAL = 700; // ms，保守设为 700ms（< 1000/2 = 500ms 的安全边界）
let lastCaptureTime = 0;

// ===== 消息监听 =====
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'START_CAPTURE') {
    handleCapture(msg.tabId, msg.pageInfo, sendResponse);
    return true;
  }
  if (msg.type === 'GENERATE_PDF') {
    handleGeneratePdf(msg.dataUrl, sendResponse);
    return true;
  }
});

/**
 * 主截图流程
 * @param {number} tabId
 * @param {object} pageInfo - 来自 content 分析的页面信息
 * @param {function} sendResponse
 */
async function handleCapture(tabId, pageInfo, sendResponse) {
  try {
    const slices = await captureAllSlices(tabId, pageInfo);

    notifyProgress(90, `合成 ${slices.length} 张截图...`);

    // 在 offscreen document 中合成长图
    const result = await stitchInOffscreen(slices, pageInfo);

    notifyProgress(100, '完成！');

    sendResponse({
      dataUrl: result.dataUrl,
      width: result.width,
      height: result.height
    });
  } catch (err) {
    console.error('[Background] Capture error:', err);
    sendResponse({ error: err.message || '截图失败' });
  }
}

/**
 * 滚动截取所有切片
 * @returns {Array<{dataUrl, scrollY, viewportHeight, fixedHeaderHeight}>}
 */
async function captureAllSlices(tabId, pageInfo) {
  const {
    totalHeight,
    viewportHeight,
    fixedHeaderHeight,
    originalScrollY,
  } = pageInfo;

  const OVERLAP = 80;  // 重叠像素，防止拼接时出现白缝
  const SCROLL_STEP = viewportHeight - fixedHeaderHeight - OVERLAP;
  // 滚动后等待页面渲染（懒加载图片）的时间
  // 注意：此等待与截图限速间隔叠加，总间隔 = RENDER_WAIT + 截图耗时 + 补足限速间隔
  const RENDER_WAIT = 300;

  const slices = [];
  let scrollY = 0;
  let sliceIndex = 0;
  const totalSlices = Math.ceil(Math.max(1, totalHeight - viewportHeight) / SCROLL_STEP) + 1;

  // 滚动到顶部，等待稳定
  await scrollTabTo(tabId, 0);
  await sleep(300);

  while (true) {
    // 确保 scrollY 不超出底部
    const clampedY = Math.min(scrollY, Math.max(0, totalHeight - viewportHeight));

    await scrollTabTo(tabId, clampedY);
    await sleep(RENDER_WAIT); // 等待页面渲染/懒加载

    // 带限速 + 退避重试的截图
    const dataUrl = await captureTabThrottled(tabId);

    slices.push({
      dataUrl,
      scrollY: clampedY,
      viewportHeight,
      fixedHeaderHeight,
    });

    sliceIndex++;
    const pct = Math.round((sliceIndex / totalSlices) * 100);
    notifyProgress(pct * 0.65, `截取第 ${sliceIndex} / ${totalSlices} 张...`);

    // 判断是否已到达页面底部
    if (clampedY + viewportHeight >= totalHeight) break;

    scrollY += SCROLL_STEP;
  }

  // 恢复原始滚动位置
  await scrollTabTo(tabId, originalScrollY);

  return slices;
}

/**
 * 带速率限制的截图：保证两次 captureVisibleTab 调用间隔 >= MIN_CAPTURE_INTERVAL
 * 失败时使用指数退避最多重试 3 次
 */
async function captureTabThrottled(tabId, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // 计算距上次截图的间隔，不足则补齐
    const now = Date.now();
    const elapsed = now - lastCaptureTime;
    if (elapsed < MIN_CAPTURE_INTERVAL) {
      await sleep(MIN_CAPTURE_INTERVAL - elapsed);
    }

    try {
      lastCaptureTime = Date.now();
      return await captureTab(tabId);
    } catch (err) {
      const isRateLimit = err.message && (
        err.message.includes('MAX_CAPTURE_VISIBLE_TAB_CALLS') ||
        err.message.includes('quota') ||
        err.message.includes('rate')
      );

      if (isRateLimit && attempt < maxRetries) {
        // 指数退避：500ms, 1000ms, 2000ms
        const backoff = 500 * Math.pow(2, attempt);
        console.warn(`[Background] captureVisibleTab rate limited, retry ${attempt + 1} in ${backoff}ms`);
        lastCaptureTime = Date.now(); // 重置计时
        await sleep(backoff);
      } else {
        throw err; // 非限速错误或已超过最大重试次数
      }
    }
  }
}

/**
 * 截取当前 tab 可视区（原始调用，不含限速逻辑）
 */
async function captureTab(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.captureVisibleTab(
      null,
      { format: 'png', quality: 100 },
      (dataUrl) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(dataUrl);
        }
      }
    );
  });
}

/**
 * 在 tab 中执行滚动
 */
async function scrollTabTo(tabId, scrollY) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (y) => {
      window.scrollTo({ top: y, behavior: 'instant' });
    },
    args: [scrollY]
  });
  await sleep(50);
}

/**
 * 在 Offscreen Document 中合成图片
 */
async function stitchInOffscreen(slices, pageInfo) {
  // 确保 offscreen document 存在
  await ensureOffscreenDocument();

  return new Promise((resolve, reject) => {
    // 注册一次性响应监听
    const listener = (msg) => {
      if (msg.type === 'STITCH_RESULT') {
        chrome.runtime.onMessage.removeListener(listener);
        if (msg.error) {
          reject(new Error(msg.error));
        } else {
          resolve(msg);
        }
      }
    };
    chrome.runtime.onMessage.addListener(listener);

    // 发送合成请求
    chrome.runtime.sendMessage({
      type: 'STITCH_IMAGES',
      slices,
      pageInfo
    });

    // 超时保护
    setTimeout(() => {
      chrome.runtime.onMessage.removeListener(listener);
      reject(new Error('图片合成超时'));
    }, 60000);
  });
}

/**
 * 确保 Offscreen Document 已创建
 */
async function ensureOffscreenDocument() {
  const existingClients = await clients.matchAll();
  const offscreenExists = existingClients.some(c => c.url === OFFSCREEN_URL);
  if (!offscreenExists) {
    try {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: [chrome.offscreen.Reason.BLOBS],
        justification: '用于合成长截图'
      });
    } catch (e) {
      // 可能已存在，忽略错误
      if (!e.message.includes('already')) throw e;
    }
  }
}

/**
 * 向 popup 发送进度更新
 */
function notifyProgress(percent, text) {
  chrome.runtime.sendMessage({
    type: 'CAPTURE_PROGRESS',
    percent: Math.min(100, Math.round(percent)),
    text
  }).catch(() => {}); // popup 可能已关闭，忽略错误
}

/**
 * sleep helper
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 请求 offscreen 将 PNG dataUrl 转换为 PDF dataUrl
 * @param {string} pngDataUrl - PNG 长图的 dataUrl
 * @param {function} sendResponse
 */
async function handleGeneratePdf(pngDataUrl, sendResponse) {
  try {
    await ensureOffscreenDocument();

    const result = await new Promise((resolve, reject) => {
      const listener = (msg) => {
        if (msg.type === 'PDF_RESULT') {
          chrome.runtime.onMessage.removeListener(listener);
          if (msg.error) reject(new Error(msg.error));
          else resolve(msg);
        }
      };
      chrome.runtime.onMessage.addListener(listener);

      chrome.runtime.sendMessage({ type: 'MAKE_PDF', pngDataUrl });

      setTimeout(() => {
        chrome.runtime.onMessage.removeListener(listener);
        reject(new Error('PDF 生成超时'));
      }, 60000);
    });

    sendResponse({ dataUrl: result.dataUrl });
  } catch (err) {
    console.error('[Background] PDF error:', err);
    sendResponse({ error: err.message });
  }
}
