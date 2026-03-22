/**
 * offscreen.js - 在 Offscreen Document 中合成长截图 + 生成 PDF
 * v2.0: 新增 MAKE_PDF 消息处理，纯 JS 实现 PDF 生成（无外部依赖）
 */

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'STITCH_IMAGES') {
    stitchImages(msg.slices, msg.pageInfo)
      .then(result => {
        chrome.runtime.sendMessage({
          type: 'STITCH_RESULT',
          dataUrl: result.dataUrl,
          width: result.width,
          height: result.height
        });
      })
      .catch(err => {
        chrome.runtime.sendMessage({
          type: 'STITCH_RESULT',
          error: err.message || '合成失败'
        });
      });
  }

  if (msg.type === 'MAKE_PDF') {
    makePdfFromPng(msg.pngDataUrl)
      .then(dataUrl => {
        chrome.runtime.sendMessage({ type: 'PDF_RESULT', dataUrl });
      })
      .catch(err => {
        chrome.runtime.sendMessage({ type: 'PDF_RESULT', error: err.message || 'PDF 生成失败' });
      });
  }
});

// =====================================================================
//  图片拼接（原有逻辑不变）
// =====================================================================

async function stitchImages(slices, pageInfo) {
  const {
    totalHeight, contentLeft, contentWidth,
    viewportWidth, viewportHeight, fixedHeaderHeight,
  } = pageInfo;

  const images = await Promise.all(slices.map(s => loadImage(s.dataUrl)));

  const imgW = images[0].width;
  const imgH = images[0].height;
  const scaleX = imgW / viewportWidth;
  const scaleY = imgH / viewportHeight;

  const outWidth  = Math.round(contentWidth * scaleX);
  const outHeight = Math.round(totalHeight  * scaleY);
  const srcX      = Math.round(contentLeft  * scaleX);

  const canvas = new OffscreenCanvas(outWidth, outHeight);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, outWidth, outHeight);

  for (let i = 0; i < slices.length; i++) {
    const slice = slices[i];
    const img   = images[i];
    const srcY  = Math.round(fixedHeaderHeight * scaleY);
    const srcH  = imgH - srcY;
    const dstY  = Math.round(slice.scrollY * scaleY) + srcY;
    const drawH = Math.min(srcH, outHeight - dstY);
    if (drawH <= 0) continue;
    ctx.drawImage(img, srcX, srcY, outWidth, drawH, 0, dstY, outWidth, drawH);
  }

  const blob = await canvas.convertToBlob({ type: 'image/png' });
  const dataUrl = await blobToDataUrl(blob);
  return { dataUrl, width: outWidth, height: outHeight };
}

// =====================================================================
//  PDF 生成器（纯 JS，无外部依赖）
//
//  实现思路：
//  1. 把 PNG dataUrl 画到 canvas，导出为 JPEG（比 PNG 体积小很多）
//  2. 手写最小 PDF 结构：把 JPEG 二进制嵌入为 /DCTDecode 图片流
//  3. PDF 页面尺寸按图片实际像素设定（1px = 1/96 inch → pt = px * 72/96）
//  4. 整个文件用 Latin-1 + base64 decode 拼装，输出 blob: URL
// =====================================================================

/**
 * 将 PNG dataUrl 的长图转换为 PDF dataUrl
 * @param {string} pngDataUrl
 * @returns {Promise<string>} PDF 的 dataUrl (application/pdf)
 */
async function makePdfFromPng(pngDataUrl) {
  // ── 1. 加载图片，获取真实像素尺寸 ──
  const img = await loadImage(pngDataUrl);
  const imgW = img.width;
  const imgH = img.height;

  // ── 2. 将图片重绘到 OffscreenCanvas，导出为 JPEG bytes ──
  //    JPEG 体积比 PNG 小 3-5 倍，适合嵌入 PDF
  const canvas = new OffscreenCanvas(imgW, imgH);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, imgW, imgH);
  ctx.drawImage(img, 0, 0);

  const jpegBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
  const jpegBytes = new Uint8Array(await jpegBlob.arrayBuffer());

  // ── 3. PDF 页面尺寸（pt）：1pt = 1/72 inch，屏幕 96dpi ──
  //    px → pt = px * 72 / 96 = px * 0.75
  const PX_TO_PT = 0.75;
  const pageW = Math.round(imgW * PX_TO_PT);
  const pageH = Math.round(imgH * PX_TO_PT);

  // ── 4. 手写 PDF 结构 ──
  //
  //  PDF 是基于字节流的格式，最小结构：
  //  %PDF-1.4
  //  1 0 obj  << /Type /Catalog /Pages 2 0 R >>
  //  2 0 obj  << /Type /Pages /Kids [3 0 R] /Count 1 >>
  //  3 0 obj  << /Type /Page /MediaBox [0 0 W H] /Contents 4 0 R /Resources << /XObject << /Img 5 0 R >> >> /Parent 2 0 R >>
  //  4 0 obj  << /Length N >> stream ... endstream   (绘图指令：将图片铺满页面)
  //  5 0 obj  << /Type /XObject /Subtype /Image /Width W /Height H /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length N >>
  //            stream <JPEG bytes> endstream
  //  xref + trailer

  // 绘图流：将 XObject /Img 拉伸填满整个页面
  const drawStream = `q ${pageW} 0 0 ${pageH} 0 0 cm /Img Do Q`;
  const drawStreamBytes = strToBytes(drawStream);

  // PDF 对象收集（用数组便于后续计算 xref 偏移）
  const objs = [];

  // obj 1: Catalog
  objs.push(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`);
  // obj 2: Pages
  objs.push(`2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n`);
  // obj 3: Page
  objs.push(
    `3 0 obj\n<< /Type /Page /Parent 2 0 R\n` +
    `   /MediaBox [0 0 ${pageW} ${pageH}]\n` +
    `   /Contents 4 0 R\n` +
    `   /Resources << /XObject << /Img 5 0 R >> >>\n` +
    `>>\nendobj\n`
  );
  // obj 4: draw stream
  objs.push(
    `4 0 obj\n<< /Length ${drawStreamBytes.length} >>\nstream\n` +
    drawStream + `\nendstream\nendobj\n`
  );
  // obj 5: image XObject（JPEG 流，需要二进制拼接，先用占位符）
  const imgHeader =
    `5 0 obj\n` +
    `<< /Type /XObject /Subtype /Image\n` +
    `   /Width ${imgW} /Height ${imgH}\n` +
    `   /ColorSpace /DeviceRGB /BitsPerComponent 8\n` +
    `   /Filter /DCTDecode /Length ${jpegBytes.length}\n` +
    `>>\nstream\n`;
  const imgFooter = `\nendstream\nendobj\n`;

  // ── 5. 拼装完整 PDF 字节流（Uint8Array）──
  const header = strToBytes('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n'); // 首行 + 二进制标记

  // 先转换前 4 个纯文本对象
  const obj1to4Bytes = strToBytes(objs[0] + objs[1] + objs[2] + objs[3]);

  // obj 5 需要混合文本 + 二进制
  const imgHeaderBytes = strToBytes(imgHeader);
  const imgFooterBytes = strToBytes(imgFooter);

  // 计算各对象起始偏移（用于 xref）
  let offset = header.length;
  const offsets = [];

  // obj 1 开始
  offsets.push(offset);
  const o1 = strToBytes(objs[0]);
  offset += o1.length;

  offsets.push(offset);
  const o2 = strToBytes(objs[1]);
  offset += o2.length;

  offsets.push(offset);
  const o3 = strToBytes(objs[2]);
  offset += o3.length;

  offsets.push(offset);
  const o4 = strToBytes(objs[3]);
  offset += o4.length;

  offsets.push(offset); // obj 5
  const xrefOffset = offset + imgHeaderBytes.length + jpegBytes.length + imgFooterBytes.length;

  // xref 表 + trailer
  const xref = buildXref(offsets, xrefOffset);
  const xrefBytes = strToBytes(xref);

  // 合并所有 Uint8Array
  const parts = [header, o1, o2, o3, o4, imgHeaderBytes, jpegBytes, imgFooterBytes, xrefBytes];
  const totalLen = parts.reduce((s, p) => s + p.length, 0);
  const pdfBytes = new Uint8Array(totalLen);
  let pos = 0;
  for (const p of parts) {
    pdfBytes.set(p, pos);
    pos += p.length;
  }

  // ── 6. 输出为 dataUrl ──
  const pdfBlob = new Blob([pdfBytes], { type: 'application/pdf' });
  const dataUrl = await blobToDataUrl(pdfBlob);
  return dataUrl;
}

/**
 * 构建 PDF xref 表 + trailer
 * @param {number[]} offsets - 每个对象的字节偏移数组（index 0 = obj 1）
 * @param {number} xrefOffset - xref 表本身的起始偏移
 */
function buildXref(offsets, xrefOffset) {
  const count = offsets.length + 1; // +1 for obj 0
  let xref = `xref\n0 ${count}\n`;
  xref += `0000000000 65535 f \n`; // obj 0: free
  for (const off of offsets) {
    xref += String(off).padStart(10, '0') + ` 00000 n \n`;
  }
  xref +=
    `trailer\n<< /Size ${count} /Root 1 0 R >>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`;
  return xref;
}

/**
 * 将 Latin-1 字符串转为 Uint8Array
 * （PDF 文本结构部分全是 ASCII/Latin-1，安全使用）
 */
function strToBytes(str) {
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    bytes[i] = str.charCodeAt(i) & 0xff;
  }
  return bytes;
}

// =====================================================================
//  公共工具函数
// =====================================================================

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片加载失败'));
    img.src = dataUrl;
  });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Blob 转 DataURL 失败'));
    reader.readAsDataURL(blob);
  });
}
