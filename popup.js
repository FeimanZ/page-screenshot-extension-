/**
 * popup.js - 弹窗UI交互逻辑 (v2.0)
 */

let currentMode = 'content';
let capturedDataUrl = null;
let capturedPageTitle = '';   // 存储网页标题，用于 PDF 文件名

// ===== 初始化 =====
document.addEventListener('DOMContentLoaded', () => {
  initModeButtons();
  document.getElementById('captureBtn').addEventListener('click', startCapture);
  document.getElementById('downloadPngBtn').addEventListener('click', downloadPng);
  document.getElementById('downloadPdfBtn').addEventListener('click', downloadPdf);
});

/**
 * 初始化宽度模式按钮
 */
function initModeButtons() {
  const btns = document.querySelectorAll('.mode-btn');
  btns.forEach(btn => {
    btn.addEventListener('click', () => {
      btns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentMode = btn.dataset.mode;
      const customRow = document.getElementById('customWidthRow');
      customRow.style.display = currentMode === 'custom' ? 'flex' : 'none';
    });
  });
}

/**
 * 开始截图
 */
async function startCapture() {
  const captureBtn = document.getElementById('captureBtn');
  const progressArea = document.getElementById('progressArea');
  const resultArea = document.getElementById('resultArea');
  const errorArea = document.getElementById('errorArea');

  // Reset UI
  resultArea.style.display = 'none';
  errorArea.style.display = 'none';
  capturedDataUrl = null;
  capturedPageTitle = '';
  captureBtn.disabled = true;
  captureBtn.textContent = '⏳ 截图中...';
  progressArea.style.display = 'block';

  setProgress(0, '正在分析页面...');

  try {
    let customWidth = null;
    if (currentMode === 'custom') {
      customWidth = parseInt(document.getElementById('customWidth').value) || 800;
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error('无法获取当前标签页');

    // 同时获取页面信息 + 页面标题
    setProgress(10, '正在注入分析脚本...');
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: analyzePageContent,
      args: [currentMode, customWidth]
    });

    const pageInfo = results[0].result;
    if (!pageInfo) throw new Error('无法分析页面内容');

    // 保存页面标题（用于 PDF 文件名）
    capturedPageTitle = pageInfo.pageTitle || tab.title || 'screenshot';

    setProgress(20, `检测到内容区域: ${pageInfo.contentWidth}px 宽`);

    const response = await sendMessageWithProgress(tab.id, pageInfo);
    if (response.error) throw new Error(response.error);

    capturedDataUrl = response.dataUrl;
    showResult(response);

  } catch (err) {
    showError(err.message || '截图失败，请重试');
    console.error('Capture error:', err);
  } finally {
    captureBtn.disabled = false;
    captureBtn.textContent = '📸 开始截图';
    progressArea.style.display = 'none';
  }
}

/**
 * 发送消息到 background，并监听进度
 */
function sendMessageWithProgress(tabId, pageInfo) {
  return new Promise((resolve, reject) => {
    const progressListener = (msg) => {
      if (msg.type === 'CAPTURE_PROGRESS') {
        setProgress(20 + Math.floor(msg.percent * 0.7), msg.text);
      }
    };
    chrome.runtime.onMessage.addListener(progressListener);

    chrome.runtime.sendMessage(
      { type: 'START_CAPTURE', tabId, pageInfo },
      (response) => {
        chrome.runtime.onMessage.removeListener(progressListener);
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(response || { error: '未收到响应' });
        }
      }
    );

    setTimeout(() => {
      chrome.runtime.onMessage.removeListener(progressListener);
      reject(new Error('截图超时，页面可能过长或过于复杂'));
    }, 120000);
  });
}

/**
 * 设置进度条
 */
function setProgress(percent, text) {
  document.getElementById('progressFill').style.width = percent + '%';
  document.getElementById('progressText').textContent = text;
}

/**
 * 显示截图结果
 */
function showResult(response) {
  const resultArea = document.getElementById('resultArea');
  const previewImg = document.getElementById('previewImg');
  const resultDims = document.getElementById('resultDims');
  const resultSize = document.getElementById('resultSize');

  previewImg.src = response.dataUrl;
  resultDims.textContent = `尺寸：${response.width} × ${response.height}px`;

  const base64Len = response.dataUrl.length - response.dataUrl.indexOf(',') - 1;
  const sizeKB = Math.round(base64Len * 0.75 / 1024);
  const sizeText = sizeKB > 1024 ? (sizeKB / 1024).toFixed(1) + ' MB' : sizeKB + ' KB';
  resultSize.textContent = `大小：${sizeText}`;

  resultArea.style.display = 'block';
}

/**
 * 显示错误信息
 */
function showError(msg) {
  const errorArea = document.getElementById('errorArea');
  errorArea.textContent = '❌ ' + msg;
  errorArea.style.display = 'block';
}

/**
 * 生成带时间戳的文件名（过滤非法字符）
 * @param {string} title - 网页标题
 * @param {string} ext   - 扩展名，如 'png' 或 'pdf'
 */
function buildFilename(title, ext) {
  const now = new Date();
  const ts = now.getFullYear() +
    String(now.getMonth() + 1).padStart(2, '0') +
    String(now.getDate()).padStart(2, '0') + '-' +
    String(now.getHours()).padStart(2, '0') +
    String(now.getMinutes()).padStart(2, '0') +
    String(now.getSeconds()).padStart(2, '0');

  // 清理标题：去掉文件系统非法字符，截断至 60 字符
  const safeTitle = (title || 'screenshot')
    .replace(/[\\/:*?"<>|]/g, '')   // 非法字符
    .replace(/\s+/g, '-')           // 空白转连字符
    .replace(/-+/g, '-')            // 合并连续连字符
    .trim()
    .slice(0, 60);

  return `${safeTitle}-${ts}.${ext}`;
}

/**
 * 下载 PNG
 */
function downloadPng() {
  if (!capturedDataUrl) return;
  const filename = buildFilename(capturedPageTitle, 'png');
  chrome.downloads.download({ url: capturedDataUrl, filename });
}

/**
 * 下载 PDF
 * 将长图 PNG 转换为 PDF，在 offscreen document 中完成
 */
async function downloadPdf() {
  if (!capturedDataUrl) return;

  const btn = document.getElementById('downloadPdfBtn');
  const spinner = document.getElementById('pdfSpinner');
  const btnText = document.getElementById('pdfBtnText');

  // Loading 状态
  btn.disabled = true;
  spinner.style.display = 'inline-block';
  btnText.textContent = '生成中...';

  try {
    // 请求 background 生成 PDF
    const response = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { type: 'GENERATE_PDF', dataUrl: capturedDataUrl },
        (res) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(res || { error: 'PDF 生成无响应' });
          }
        }
      );
      setTimeout(() => reject(new Error('PDF 生成超时')), 60000);
    });

    if (response.error) throw new Error(response.error);

    const filename = buildFilename(capturedPageTitle, 'pdf');
    chrome.downloads.download({ url: response.dataUrl, filename });

  } catch (err) {
    showError('PDF 生成失败：' + err.message);
  } finally {
    btn.disabled = false;
    spinner.style.display = 'none';
    btnText.textContent = '📄 下载 PDF';
  }
}

// ===================================================================
// 以下函数在页面中执行（通过 scripting.executeScript 注入）
// ===================================================================

/**
 * 分析页面主体内容（在页面中执行）
 * @param {string} mode - 'content' | 'full' | 'custom'
 * @param {number|null} customWidth
 */
function analyzePageContent(mode, customWidth) {
  function detectContentElement() {
    const selectors = [
      'main', 'article', '[role="main"]',
      '.article-content', '.post-content', '.entry-content',
      '.markdown-body', '.content-body', '#content-main',
      '.main-content', '#article', '.article',
      '#content', '#main', '.content', '.post', '.container'
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 200) return el;
      }
    }
    return document.body;
  }

  function getFixedHeaderHeight() {
    let maxHeight = 0;
    const elements = document.querySelectorAll('*');
    for (const el of elements) {
      const style = window.getComputedStyle(el);
      if (style.position === 'fixed' || style.position === 'sticky') {
        const rect = el.getBoundingClientRect();
        if (rect.top < 10 && rect.width > window.innerWidth * 0.5) {
          maxHeight = Math.max(maxHeight, rect.height);
        }
      }
    }
    return maxHeight;
  }

  /**
   * 获取页面正文标题（优先级：og:title > h1 > document.title）
   */
  function getPageTitle() {
    // Open Graph 标题
    const ogTitle = document.querySelector('meta[property="og:title"]');
    if (ogTitle && ogTitle.content) return ogTitle.content.trim();
    // 第一个 h1
    const h1 = document.querySelector('h1');
    if (h1 && h1.textContent.trim()) return h1.textContent.trim();
    // fallback
    return document.title || '';
  }

  const docScrollHeight = Math.max(
    document.body.scrollHeight, document.documentElement.scrollHeight
  );
  const docScrollWidth = Math.max(
    document.body.scrollWidth, document.documentElement.scrollWidth
  );

  let contentLeft = 0;
  let contentWidth = window.innerWidth;

  if (mode === 'content') {
    const el = detectContentElement();
    const rect = el.getBoundingClientRect();
    const scrollX = window.pageXOffset || document.documentElement.scrollLeft;
    contentLeft = Math.max(0, Math.round(rect.left + scrollX) - 32);
    contentWidth = Math.min(Math.round(rect.width) + 64, docScrollWidth);
    if (contentWidth >= docScrollWidth * 0.9) {
      contentLeft = 0;
      contentWidth = docScrollWidth;
    }
  } else if (mode === 'full') {
    contentLeft = 0;
    contentWidth = docScrollWidth;
  } else if (mode === 'custom') {
    const cw = customWidth || 800;
    contentLeft = Math.max(0, Math.floor((window.innerWidth - cw) / 2));
    contentWidth = Math.min(cw, docScrollWidth);
  }

  return {
    totalHeight: docScrollHeight,
    totalWidth: docScrollWidth,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    contentLeft,
    contentWidth,
    fixedHeaderHeight: getFixedHeaderHeight(),
    devicePixelRatio: window.devicePixelRatio || 1,
    originalScrollX: window.pageXOffset || 0,
    originalScrollY: window.pageYOffset || 0,
    pageTitle: getPageTitle(),         // ← v2.0 新增：正文标题
  };
}
