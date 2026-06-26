import init, { HwpDocument } from './rhwp.js';

const THEME_KEY = 'hwp-viewer-theme';
const ALLOWED_EXT = new Set(['hwp', 'hwpx']);
const SAFE_SVG_TAGS = new Set([
  'svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'defs', 'clipPath', 'mask', 'pattern', 'linearGradient',
  'radialGradient', 'stop', 'symbol', 'use', 'image', 'style', 'filter',
  'feColorMatrix', 'feComponentTransfer', 'feFuncA', 'feFuncR', 'feFuncG',
  'feFuncB', 'feBlend', 'feComposite', 'feGaussianBlur', 'feOffset',
  'feFlood', 'feMerge', 'feMergeNode'
]);
const URL_ATTRS = new Set(['href', 'xlink:href']);
const BAD_TAGS = new Set(['script', 'foreignObject', 'iframe', 'object', 'embed', 'audio', 'video', 'canvas']);

const els = {
  openBtn: document.getElementById('openBtn'),
  openBtn2: document.getElementById('openBtn2'),
  themeBtn: document.getElementById('themeBtn'),
  fileInput: document.getElementById('fileInput'),
  title: document.getElementById('title'),
  empty: document.getElementById('empty'),
  viewerWrap: document.getElementById('viewer-wrap'),
  pageContainer: document.getElementById('page-container'),
  bottombar: document.getElementById('bottombar'),
  pageInfo: document.getElementById('pageInfo'),
  pageInput: document.getElementById('pageInput'),
  prevBtn: document.getElementById('prevBtn'),
  nextBtn: document.getElementById('nextBtn'),
  loading: document.getElementById('loading'),
  loadingText: document.getElementById('loadingText'),
  errorBox: document.getElementById('errorBox'),
};

let doc = null;
let currentPage = 0;
let pageCount = 0;
let wasmReady = false;
let touchStartX = null;
let touchStartY = null;
let errorTimer = null;

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(THEME_KEY, theme);
}

function initTheme() {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === 'dark' || stored === 'light') {
    setTheme(stored);
    return;
  }
  const prefersDark = globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches;
  setTheme(prefersDark ? 'dark' : 'light');
}

function toggleTheme() {
  const current = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  setTheme(current === 'light' ? 'dark' : 'light');
}

function showError(message) {
  if (errorTimer) clearTimeout(errorTimer);
  els.errorBox.textContent = message;
  els.errorBox.classList.add('show');
  errorTimer = setTimeout(() => els.errorBox.classList.remove('show'), 4500);
}

function setLoading(on, message = '문서를 여는 중…') {
  els.loading.hidden = !on;
  els.loadingText.textContent = message;
}

function nextPaint() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => setTimeout(resolve, 0));
  });
}

async function ensureWasm() {
  if (wasmReady) return;
  setLoading(true, '뷰어 엔진을 준비하는 중…');
  await init();
  wasmReady = true;
}

function cleanupDocument() {
  if (doc && typeof doc.free === 'function') {
    try {
      doc.free();
    } catch {
      // no-op
    }
  }
  doc = null;
}

function isSafeUrl(value) {
  if (!value) return true;
  const trimmed = value.trim().toLowerCase();
  if (trimmed.startsWith('javascript:')) return false;
  if (trimmed.startsWith('http:') || trimmed.startsWith('https:') || trimmed.startsWith('//')) return false;
  return true;
}

function sanitizeSvg(svgText) {
  const parser = new DOMParser();
  const parsed = parser.parseFromString(svgText, 'image/svg+xml');
  const root = parsed.documentElement;
  if (!root || root.nodeName === 'parsererror') {
    throw new Error('SVG 파싱 실패');
  }

  const walk = (node) => {
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const tag = node.tagName;
    if (BAD_TAGS.has(tag) || !SAFE_SVG_TAGS.has(tag)) {
      node.remove();
      return;
    }

    if (tag === 'style') {
      const css = node.textContent || '';
      if (/@import|url\s*\(|expression\s*\(/i.test(css)) {
        node.remove();
        return;
      }
    }

    for (const attr of [...node.attributes]) {
      const name = attr.name;
      const value = attr.value;
      const lower = name.toLowerCase();

      if (lower.startsWith('on')) {
        node.removeAttribute(name);
        continue;
      }
      if (URL_ATTRS.has(name) || URL_ATTRS.has(lower)) {
        if (!isSafeUrl(value)) {
          node.removeAttribute(name);
        }
        continue;
      }
      if (lower === 'style' && /url\s*\(/i.test(value)) {
        node.removeAttribute(name);
      }
    }

    for (const child of [...node.children]) walk(child);
  };

  walk(root);
  return root;
}

function updatePager() {
  els.pageInfo.textContent = `/ ${pageCount || '-'}`;
  els.pageInput.value = pageCount ? String(currentPage + 1) : '';
  els.pageInput.disabled = !pageCount;
  els.prevBtn.disabled = currentPage <= 0;
  els.nextBtn.disabled = !pageCount || currentPage >= pageCount - 1;
}

function renderCurrentPage() {
  if (!doc || pageCount < 1) return;
  try {
    const svgText = doc.renderPageSvg(currentPage);
    const safeSvg = sanitizeSvg(svgText);
    els.pageContainer.replaceChildren(safeSvg);
    updatePager();
    els.viewerWrap.scrollTop = 0;
  } catch (error) {
    console.error(error);
    showError('페이지를 안전하게 표시하지 못했습니다.');
  }
}

function validateFile(file) {
  if (!file) return '파일이 선택되지 않았습니다.';
  const ext = file.name.split('.').pop()?.toLowerCase();
  if (!ext || !ALLOWED_EXT.has(ext)) {
    return 'HWP 또는 HWPX 파일만 열 수 있습니다.';
  }
  if (file.size > 100 * 1024 * 1024) {
    return '파일이 너무 큽니다. 100MB 이하 파일을 권장합니다.';
  }
  return null;
}

async function openFile(file) {
  const problem = validateFile(file);
  if (problem) {
    showError(problem);
    return;
  }

  setLoading(true, '문서를 읽는 중…');
  await nextPaint();
  try {
    await ensureWasm();
    setLoading(true, '문서를 분석하는 중…');
    await nextPaint();
    cleanupDocument();

    const buf = new Uint8Array(await file.arrayBuffer());
    const nextDoc = new HwpDocument(buf);
    const nextPageCount = Number(nextDoc.pageCount?.() ?? 0);
    if (!Number.isFinite(nextPageCount) || nextPageCount < 1) {
      if (typeof nextDoc.free === 'function') nextDoc.free();
      throw new Error('페이지 정보를 읽지 못했습니다.');
    }

    doc = nextDoc;
    pageCount = nextPageCount;
    currentPage = 0;

    els.title.textContent = file.name;
    els.title.classList.remove('placeholder');
    els.empty.hidden = true;
    els.viewerWrap.hidden = false;
    els.bottombar.hidden = false;

    setLoading(true, '첫 페이지를 그리는 중…');
    await nextPaint();
    renderCurrentPage();
  } catch (error) {
    console.error(error);
    cleanupDocument();
    pageCount = 0;
    currentPage = 0;
    updatePager();
    showError('문서를 열 수 없습니다. 손상되었거나 아직 지원되지 않는 형식일 수 있습니다.');
  } finally {
    setLoading(false);
  }
}

function goToPage(pageNumber) {
  if (!pageCount) return;
  const nextPage = Math.max(1, Math.min(pageCount, pageNumber));
  currentPage = nextPage - 1;
  renderCurrentPage();
}

function handlePageInputCommit() {
  const raw = els.pageInput.value.trim();
  if (!raw) {
    updatePager();
    return;
  }
  const num = Number(raw);
  if (!Number.isInteger(num)) {
    showError('페이지 번호를 숫자로 입력하세요.');
    updatePager();
    return;
  }
  goToPage(num);
}

function registerEvents() {
  els.openBtn.addEventListener('click', () => els.fileInput.click());
  els.openBtn2.addEventListener('click', () => els.fileInput.click());
  els.themeBtn.addEventListener('click', toggleTheme);

  els.fileInput.addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    openFile(file);
    event.target.value = '';
  });

  els.prevBtn.addEventListener('click', () => {
    if (currentPage > 0) {
      currentPage -= 1;
      renderCurrentPage();
    }
  });

  els.nextBtn.addEventListener('click', () => {
    if (currentPage < pageCount - 1) {
      currentPage += 1;
      renderCurrentPage();
    }
  });

  els.pageInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      handlePageInputCommit();
      els.pageInput.blur();
    }
  });
  els.pageInput.addEventListener('blur', handlePageInputCommit);

  els.viewerWrap.addEventListener('touchstart', (event) => {
    touchStartX = event.touches[0]?.clientX ?? null;
    touchStartY = event.touches[0]?.clientY ?? null;
  }, { passive: true });

  els.viewerWrap.addEventListener('touchend', (event) => {
    if (touchStartX == null || touchStartY == null || !pageCount) return;
    const endX = event.changedTouches[0]?.clientX;
    const endY = event.changedTouches[0]?.clientY;
    if (typeof endX !== 'number' || typeof endY !== 'number') return;
    const dx = endX - touchStartX;
    const dy = endY - touchStartY;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.2) {
      if (dx < 0 && currentPage < pageCount - 1) {
        currentPage += 1;
        renderCurrentPage();
      } else if (dx > 0 && currentPage > 0) {
        currentPage -= 1;
        renderCurrentPage();
      }
    }
    touchStartX = null;
    touchStartY = null;
  }, { passive: true });

  window.addEventListener('beforeunload', cleanupDocument);
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('./sw.js').catch((error) => {
    console.warn('서비스워커 등록 실패', error);
  });
}

function boot() {
  initTheme();
  updatePager();
  registerEvents();
  registerServiceWorker();
}

boot();
