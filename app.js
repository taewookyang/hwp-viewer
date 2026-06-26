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
const DEBUG_SEARCH = new URLSearchParams(location.search).get('debug') === '1';

const els = {
  openBtn: document.getElementById('openBtn'),
  openBtn2: document.getElementById('openBtn2'),
  themeBtn: document.getElementById('themeBtn'),
  fileInput: document.getElementById('fileInput'),
  title: document.getElementById('title'),
  docMeta: document.getElementById('docMeta'),
  docType: document.getElementById('docType'),
  docSize: document.getElementById('docSize'),
  docPages: document.getElementById('docPages'),
  toolbar: document.getElementById('toolbar'),
  zoomOutBtn: document.getElementById('zoomOutBtn'),
  zoomResetBtn: document.getElementById('zoomResetBtn'),
  zoomInBtn: document.getElementById('zoomInBtn'),
  zoomLabel: document.getElementById('zoomLabel'),
  searchInput: document.getElementById('searchInput'),
  searchPrevBtn: document.getElementById('searchPrevBtn'),
  searchNextBtn: document.getElementById('searchNextBtn'),
  searchStatus: document.getElementById('searchStatus'),
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
  debugWrap: document.getElementById('debugWrap'),
  debugPanel: document.getElementById('debugPanel'),
  debugCopyBtn: document.getElementById('debugCopyBtn'),
};

let doc = null;
let currentPage = 0;
let pageCount = 0;
let wasmReady = false;
let currentZoom = 1;
const MIN_ZOOM = 0.75;
const MAX_ZOOM = 2.5;
const ZOOM_STEP = 0.25;
let currentFile = null;
let searchResults = [];
let searchResultIndex = -1;
let lastSearchQuery = '';
let searchHighlightRects = [];
let searchDebounceTimer = null;
let touchStartX = null;
let touchStartY = null;
let errorTimer = null;
let debugState = {
  query: '',
  rawSearch: null,
  normalizedResults: [],
  currentMatch: null,
  rawRects: null,
  rects: [],
};

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

function updateDebugPanel() {
  if (!els.debugPanel || !els.debugWrap) return;
  const hasDebugPayload = Boolean(currentFile) && (
    Boolean(debugState.query) ||
    debugState.rawSearch != null ||
    debugState.rawRects != null ||
    searchResults.length > 0
  );
  if (!DEBUG_SEARCH || !hasDebugPayload) {
    els.debugWrap.hidden = true;
    els.debugPanel.hidden = true;
    return;
  }
  els.debugWrap.hidden = false;
  els.debugPanel.hidden = false;
  const payload = {
    page: currentPage + 1,
    pageCount,
    query: debugState.query,
    resultCount: searchResults.length,
    resultIndex: searchResultIndex,
    currentMatch: debugState.currentMatch,
    rectCount: debugState.rects?.length ?? 0,
    rects: debugState.rects,
    rawSearch: debugState.rawSearch,
    rawRects: debugState.rawRects,
  };
  els.debugPanel.textContent = JSON.stringify(payload, null, 2);
}

async function copyDebugPayload() {
  if (!els.debugPanel?.textContent) {
    showError('복사할 진단 정보가 아직 없습니다.');
    return;
  }
  try {
    await navigator.clipboard.writeText(els.debugPanel.textContent);
    showError('진단 정보를 복사했습니다.');
  } catch {
    showError('복사에 실패했습니다. 스크린샷으로 보내주세요.');
  }
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
  currentFile = null;
}

function formatFileSize(size) {
  if (!Number.isFinite(size) || size < 0) return '-';
  if (size < 1024) return `${size}B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)}KB`;
  return `${(size / (1024 * 1024)).toFixed(size < 10 * 1024 * 1024 ? 1 : 0)}MB`;
}

function updateDocMeta() {
  if (!currentFile) {
    els.docMeta.hidden = true;
    els.docType.textContent = '-';
    els.docSize.textContent = '-';
    els.docPages.textContent = '-';
    return;
  }
  const ext = currentFile.name.split('.').pop()?.toUpperCase() || '-';
  els.docType.textContent = ext;
  els.docSize.textContent = formatFileSize(currentFile.size);
  els.docPages.textContent = pageCount ? `${pageCount}페이지` : '페이지 미확인';
  els.docMeta.hidden = false;
}

function updateZoomUi() {
  const zoomText = `${Math.round(currentZoom * 100)}%`;
  els.zoomLabel.textContent = zoomText;
  els.zoomResetBtn.textContent = zoomText;
  els.zoomOutBtn.disabled = currentZoom <= MIN_ZOOM;
  els.zoomInBtn.disabled = currentZoom >= MAX_ZOOM;
}

function applyZoom() {
  els.pageContainer.style.width = `${Math.round(currentZoom * 100)}%`;
  updateZoomUi();
}

function setZoom(nextZoom) {
  const clamped = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Number(nextZoom) || 1));
  currentZoom = Math.round(clamped * 100) / 100;
  applyZoom();
}

function resetZoom() {
  setZoom(1);
}

function resetSearchState({ keepInput = false } = {}) {
  searchResults = [];
  searchResultIndex = -1;
  lastSearchQuery = '';
  searchHighlightRects = [];
  debugState = {
    query: '',
    rawSearch: null,
    normalizedResults: [],
    currentMatch: null,
    rawRects: null,
    rects: [],
  };
  if (!keepInput) els.searchInput.value = '';
  updateSearchUi();
  updateDebugPanel();
}

function updateSearchUi() {
  const hasDoc = !!doc && pageCount > 0;
  const hasQuery = !!lastSearchQuery;
  els.searchInput.disabled = !hasDoc;
  els.searchPrevBtn.disabled = !hasQuery || searchResults.length < 1;
  els.searchNextBtn.disabled = !hasQuery || searchResults.length < 1;
  if (!hasDoc) {
    els.searchStatus.textContent = '문서 열기 후 검색';
    return;
  }
  if (!hasQuery) {
    els.searchStatus.textContent = '검색 전';
    return;
  }
  if (!searchResults.length) {
    els.searchStatus.textContent = '결과 없음';
    return;
  }
  const current = searchResults[searchResultIndex] ?? searchResults[0];
  const pageLabel = Number.isFinite(current.pageIndex) ? `${current.pageIndex + 1}페이지` : '페이지 미상';
  els.searchStatus.textContent = `${searchResultIndex + 1}/${searchResults.length} · ${pageLabel}`;
}

function tryParseJson(value) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function toInt(value) {
  const num = Number(value);
  return Number.isFinite(num) ? Math.trunc(num) : null;
}

function pickInt(source, keys) {
  if (!source || typeof source !== 'object') return null;
  for (const key of keys) {
    const value = toInt(source[key]);
    if (value != null) return value;
  }
  return null;
}

function pickIntDeep(source, keys, seen = new Set()) {
  if (!source || typeof source !== 'object' || seen.has(source)) return null;
  seen.add(source);
  const direct = pickInt(source, keys);
  if (direct != null) return direct;
  for (const child of Object.values(source)) {
    if (child && typeof child === 'object') {
      const nested = pickIntDeep(child, keys, seen);
      if (nested != null) return nested;
    }
  }
  return null;
}

function pickValueDeep(source, keys, seen = new Set()) {
  if (!source || typeof source !== 'object' || seen.has(source)) return null;
  seen.add(source);
  for (const key of keys) {
    if (source[key] != null) return source[key];
  }
  for (const child of Object.values(source)) {
    if (child && typeof child === 'object') {
      const nested = pickValueDeep(child, keys, seen);
      if (nested != null) return nested;
    }
  }
  return null;
}

function normalizePageIndex(value) {
  const num = toInt(value);
  if (num == null) return null;
  if (num >= 1 && num <= pageCount) return num - 1;
  if (num >= 0 && num < pageCount) return num;
  return null;
}

function resolvePageIndexFromPosition(sectionIndex, paragraphIndex) {
  if (!doc || sectionIndex == null || paragraphIndex == null) return null;
  try {
    const raw = doc.getPageOfPosition(sectionIndex, paragraphIndex);
    const parsed = tryParseJson(raw);
    if (typeof parsed === 'number' || typeof parsed === 'string') {
      return normalizePageIndex(parsed);
    }
    return normalizePageIndex(
      pickValueDeep(parsed, ['pageIndex', 'page', 'pageNum', 'globalPage', 'global_page']),
    );
  } catch (error) {
    console.warn('검색 결과 페이지 매핑 실패', error);
    return null;
  }
}

function normalizeSearchMatch(match, fallbackIndex = 0) {
  if (!match || typeof match !== 'object') return null;
  const sectionIndex = pickIntDeep(match, ['sectionIndex', 'section', 'section_idx', 'sec', 'from_sec']);
  const paragraphIndex = pickIntDeep(match, ['paragraphIndex', 'paragraph', 'paraIndex', 'para_idx', 'para', 'from_para']);
  const charOffset = pickIntDeep(match, ['charOffset', 'char_offset', 'char', 'from_char', 'startCharOffset', 'start_char_offset']);
  const endParagraphIndex = pickIntDeep(match, ['endParagraphIndex', 'end_para', 'to_para', 'end_para_idx', 'toParaIndex']);
  const endCharOffset = pickIntDeep(match, ['endCharOffset', 'end_char_offset', 'to_char', 'matchEnd', 'match_end']);
  const length = pickIntDeep(match, ['length', 'len', 'matchLength', 'match_length']);
  const count = pickIntDeep(match, ['count', 'matchCount', 'match_count']) ?? length ?? 1;
  const pageIndex = normalizePageIndex(
    pickValueDeep(match, ['pageIndex', 'page', 'page_num', 'pageNum', 'globalPage', 'global_page']),
  ) ?? resolvePageIndexFromPosition(sectionIndex, paragraphIndex);
  return {
    key: String(match.id ?? match.key ?? `${sectionIndex ?? 'x'}-${paragraphIndex ?? 'x'}-${charOffset ?? fallbackIndex}`),
    pageIndex,
    sectionIndex,
    paragraphIndex,
    charOffset,
    endParagraphIndex,
    endCharOffset,
    length,
    count,
    raw: match,
  };
}

function searchViaEngine(rawQuery) {
  const raw = doc.searchAllText(rawQuery, false, true);
  const parsed = tryParseJson(raw);
  const matches = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.matches)
      ? parsed.matches
      : Array.isArray(parsed?.results)
        ? parsed.results
        : Array.isArray(parsed?.items)
          ? parsed.items
          : null;
  if (!matches) {
    throw new Error('searchAllText returned unsupported payload');
  }
  const normalized = matches
    .map((match, index) => normalizeSearchMatch(match, index))
    .filter(Boolean);
  debugState.rawSearch = parsed;
  debugState.normalizedResults = normalized;
  return normalized;
}

function runSearch(rawQuery) {
  const query = rawQuery.trim();
  lastSearchQuery = query;
  debugState.query = query;
  if (!query) {
    searchResults = [];
    searchResultIndex = -1;
    updateSearchUi();
    updateDebugPanel();
    return;
  }

  try {
    searchResults = searchViaEngine(query);
  } catch (error) {
    console.warn('엔진 검색 실패', error);
    searchResults = [];
    showError('문서 검색 엔진 응답을 읽지 못했습니다.');
  }

  searchResultIndex = searchResults.length ? 0 : -1;
  syncCurrentSearchMatch();
  updateSearchUi();
  updateDebugPanel();
  if (searchResults.length) {
    const first = getCurrentSearchMatch();
    if (Number.isFinite(first?.pageIndex)) {
      goToPage(first.pageIndex + 1);
    }
  }
}

function queueSearch(rawQuery, delay = 250) {
  if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    runSearch(rawQuery);
    searchDebounceTimer = null;
  }, delay);
}

function moveSearch(delta) {
  if (!searchResults.length) return;
  searchResultIndex = (searchResultIndex + delta + searchResults.length) % searchResults.length;
  const current = syncCurrentSearchMatch();
  updateSearchUi();
  updateDebugPanel();
  if (Number.isFinite(current?.pageIndex)) {
    goToPage(current.pageIndex + 1);
  } else {
    renderCurrentPage();
  }
}

function normalizeRectCandidate(rect) {
  if (!rect || typeof rect !== 'object') return null;
  const x = Number(rect.x ?? rect.left ?? rect.x0 ?? rect.l ?? rect.cx);
  const y = Number(rect.y ?? rect.top ?? rect.y0 ?? rect.t ?? rect.cy);
  const width = Number(rect.width ?? rect.w ?? ((rect.right ?? rect.x1) - (rect.left ?? rect.x0)));
  const height = Number(rect.height ?? rect.h ?? ((rect.bottom ?? rect.y1) - (rect.top ?? rect.y0)));
  if (![x, y, width, height].every(Number.isFinite)) return null;
  if (width <= 0 || height <= 0) return null;
  return {
    x,
    y,
    width,
    height,
    pageIndex: normalizePageIndex(
      pickValueDeep(rect, ['pageIndex', 'page', 'page_num', 'pageNum', 'globalPage', 'global_page']),
    ),
  };
}

function collectRects(value, out = []) {
  if (value == null) return out;
  if (Array.isArray(value)) {
    for (const item of value) collectRects(item, out);
    return out;
  }
  if (typeof value !== 'object') return out;
  const rect = normalizeRectCandidate(value);
  if (rect) out.push(rect);
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') collectRects(child, out);
  }
  return out;
}

function getCurrentSearchMatch() {
  if (searchResultIndex < 0 || searchResultIndex >= searchResults.length) return null;
  return searchResults[searchResultIndex] ?? null;
}

function resolveMatchEnd(match) {
  const startPara = match.paragraphIndex;
  const startChar = match.charOffset;
  const endPara = match.endParagraphIndex ?? match.paragraphIndex;
  let endChar = match.endCharOffset;
  if (endChar == null && startChar != null) {
    const span = match.length ?? match.count ?? lastSearchQuery.length;
    if (Number.isFinite(span) && span > 0) {
      endChar = startChar + span;
    }
  }
  if (startPara == null || startChar == null || endPara == null || endChar == null) return null;
  return {
    sectionIndex: match.sectionIndex,
    startParaIndex: startPara,
    startCharOffset: startChar,
    endParaIndex: endPara,
    endCharOffset: endChar,
  };
}

function computeSearchHighlightData(match = getCurrentSearchMatch()) {
  if (!doc || !match) return { rects: [], pageIndex: match?.pageIndex ?? null, raw: null };
  const range = resolveMatchEnd(match);
  if (!range || range.sectionIndex == null) return { rects: [], pageIndex: match.pageIndex ?? null, raw: null };
  try {
    const raw = doc.getSelectionRects(
      range.sectionIndex,
      range.startParaIndex,
      range.startCharOffset,
      range.endParaIndex,
      range.endCharOffset,
    );
    const parsed = tryParseJson(raw);
    const rects = collectRects(parsed);
    const rectPageIndex = rects.find((rect) => Number.isFinite(rect.pageIndex))?.pageIndex ?? null;
    debugState.rawRects = parsed;
    debugState.rects = rects;
    return { rects, pageIndex: rectPageIndex ?? match.pageIndex ?? null, raw: parsed };
  } catch (error) {
    console.warn('검색 하이라이트 좌표 계산 실패', error);
    debugState.rawRects = { error: String(error) };
    debugState.rects = [];
    return { rects: [], pageIndex: match.pageIndex ?? null, raw: { error: String(error) } };
  }
}

function syncCurrentSearchMatch() {
  const match = getCurrentSearchMatch();
  if (!match) return null;
  const info = computeSearchHighlightData(match);
  searchHighlightRects = info.rects;
  if (Number.isFinite(info.pageIndex)) {
    match.pageIndex = info.pageIndex;
  }
  debugState.currentMatch = match;
  return match;
}

function getSvgViewBox(svg) {
  const viewBox = svg.getAttribute('viewBox');
  if (viewBox) {
    const nums = viewBox.split(/[\s,]+/).map(Number).filter(Number.isFinite);
    if (nums.length === 4) return nums;
  }
  const width = Number(svg.getAttribute('width'));
  const height = Number(svg.getAttribute('height'));
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    return [0, 0, width, height];
  }
  return null;
}

function renderSearchHighlights() {
  const svg = els.pageContainer.querySelector('svg');
  if (!svg) return;

  els.pageContainer.querySelector('#search-highlight-layer')?.remove();

  const match = syncCurrentSearchMatch();
  if (!match || match.pageIndex !== currentPage) return;

  const pageRects = searchHighlightRects.filter((rect) => rect.pageIndex == null || rect.pageIndex === currentPage);
  updateDebugPanel();
  if (!pageRects.length) return;

  const viewBox = getSvgViewBox(svg);
  if (!viewBox) return;

  const [minX, minY, width, height] = viewBox;
  const layer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  layer.setAttribute('id', 'search-highlight-layer');
  layer.setAttribute('class', 'search-highlight-layer');
  layer.setAttribute('viewBox', `${minX} ${minY} ${width} ${height}`);
  layer.setAttribute('preserveAspectRatio', svg.getAttribute('preserveAspectRatio') || 'xMidYMid meet');
  layer.setAttribute('aria-hidden', 'true');

  for (const rect of pageRects) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    node.setAttribute('x', String(rect.x));
    node.setAttribute('y', String(rect.y));
    node.setAttribute('width', String(rect.width));
    node.setAttribute('height', String(rect.height));
    node.setAttribute('rx', '2');
    node.setAttribute('ry', '2');
    node.setAttribute('class', 'search-highlight-rect');
    layer.appendChild(node);
  }

  els.pageContainer.appendChild(layer);
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
    renderSearchHighlights();
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

    currentFile = file;
    doc = nextDoc;
    pageCount = nextPageCount;
    currentPage = 0;

    els.title.textContent = file.name;
    els.title.classList.remove('placeholder');
    updateDocMeta();
    resetZoom();
    resetSearchState();
    els.empty.hidden = true;
    els.viewerWrap.hidden = false;
    els.bottombar.hidden = false;
    els.toolbar.hidden = false;

    setLoading(true, '첫 페이지를 그리는 중…');
    await nextPaint();
    renderCurrentPage();
  } catch (error) {
    console.error(error);
    cleanupDocument();
    pageCount = 0;
    currentPage = 0;
    els.toolbar.hidden = true;
    updateDocMeta();
    resetSearchState();
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

  els.zoomOutBtn.addEventListener('click', () => setZoom(currentZoom - ZOOM_STEP));
  els.zoomResetBtn.addEventListener('click', resetZoom);
  els.zoomInBtn.addEventListener('click', () => setZoom(currentZoom + ZOOM_STEP));

  els.searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      runSearch(els.searchInput.value);
    }
  });
  els.searchInput.addEventListener('input', () => queueSearch(els.searchInput.value));
  els.searchInput.addEventListener('compositionend', () => queueSearch(els.searchInput.value, 0));
  els.searchInput.addEventListener('search', () => runSearch(els.searchInput.value));
  els.searchPrevBtn.addEventListener('click', () => moveSearch(-1));
  els.searchNextBtn.addEventListener('click', () => moveSearch(1));
  els.debugCopyBtn?.addEventListener('click', () => {
    copyDebugPayload();
  });

  els.prevBtn.addEventListener('click', () => goToPage(currentPage));
  els.nextBtn.addEventListener('click', () => goToPage(currentPage + 2));

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

async function clearServiceWorkers() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((reg) => reg.unregister()));
  } catch (error) {
    console.warn('서비스워커 해제 실패', error);
  }
}

async function boot() {
  setLoading(false);
  initTheme();
  updatePager();
  updateDocMeta();
  updateZoomUi();
  updateSearchUi();
  updateDebugPanel();
  registerEvents();
  await clearServiceWorkers();
}

boot();
