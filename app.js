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
let errorTimer = null;
let lastRenderedPage = null;
let pageSlots = [];
let pageAspectRatio = Math.sqrt(2);
let pageSlotHeight = 0;
let scrollSyncRaf = null;
let slotObserver = null;
const renderedSlotAccess = new Map();
const MAX_RENDERED_SLOTS = 5;
const MAX_LAYOUT_CACHE = 8;
const SLOT_PRERENDER_RADIUS = 1;
const pageTextLayoutCache = new Map();
let debugState = {
  query: '',
  rawSearch: null,
  normalizedResults: [],
  currentMatch: null,
  selectedText: null,
  rawRects: null,
  rects: [],
  rectSource: null,
  layoutPageIndex: null,
  layoutRunCount: 0,
  layoutRawSample: null,
  layoutCandidateRuns: [],
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
    selectedText: debugState.selectedText,
    rectCount: debugState.rects?.length ?? 0,
    rectSource: debugState.rectSource,
    rects: debugState.rects,
    rawSearch: debugState.rawSearch,
    rawRects: debugState.rawRects,
    layoutPageIndex: debugState.layoutPageIndex,
    layoutRunCount: debugState.layoutRunCount,
    layoutRawSample: debugState.layoutRawSample,
    layoutCandidateRuns: debugState.layoutCandidateRuns,
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
  lastRenderedPage = null;
  pageSlots = [];
  pageSlotHeight = 0;
  scrollSyncRaf = null;
  slotObserver?.disconnect();
  slotObserver = null;
  renderedSlotAccess.clear();
  els.pageContainer.replaceChildren();
  pageTextLayoutCache.clear();
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
  requestAnimationFrame(() => {
    updatePageSlotHeights();
    syncCurrentPageFromViewport();
  });
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
    selectedText: null,
    rawRects: null,
    rects: [],
    rectSource: null,
    layoutPageIndex: null,
    layoutRunCount: 0,
    layoutRawSample: null,
    layoutCandidateRuns: [],
  };
  pageTextLayoutCache.clear();
  if (!keepInput) els.searchInput.value = '';
  renderSearchHighlights({ match: null, skipEnsureRendered: true });
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

function normalizeZeroBasedPageIndex(value) {
  const num = toInt(value);
  if (num == null) return null;
  return num >= 0 && num < pageCount ? num : null;
}

function normalizeOneBasedPageNumber(value) {
  const num = toInt(value);
  if (num == null) return null;
  return num >= 1 && num <= pageCount ? num - 1 : null;
}

function normalizePageIndex(value) {
  return normalizeZeroBasedPageIndex(value) ?? normalizeOneBasedPageNumber(value);
}

function extractNormalizedPageIndex(source) {
  if (!source || typeof source !== 'object') return null;
  return normalizeZeroBasedPageIndex(
    pickValueDeep(source, ['pageIndex', 'globalPage', 'global_page']),
  ) ?? normalizeOneBasedPageNumber(
    pickValueDeep(source, ['page', 'page_num', 'pageNum']),
  );
}

function resolvePageIndexFromPosition(sectionIndex, paragraphIndex) {
  if (!doc || sectionIndex == null || paragraphIndex == null) return null;
  try {
    const raw = doc.getPageOfPosition(sectionIndex, paragraphIndex);
    const parsed = tryParseJson(raw);
    if (typeof parsed === 'number' || typeof parsed === 'string') {
      return normalizePageIndex(parsed);
    }
    return extractNormalizedPageIndex(parsed);
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
  const pageIndex = extractNormalizedPageIndex(match) ?? resolvePageIndexFromPosition(sectionIndex, paragraphIndex);
  const cellContext = pickValueDeep(match, ['cellContext', 'cell_context', 'cell']);
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
    cellContext,
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
    renderSearchHighlights({ match: null, skipEnsureRendered: true });
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
      goToPage(first.pageIndex + 1, { behavior: 'auto' });
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
    goToPage(current.pageIndex + 1, { behavior: 'auto' });
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
    pageIndex: extractNormalizedPageIndex(rect),
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

function parseNumericArray(value) {
  if (!Array.isArray(value)) return null;
  const nums = value.map(Number);
  return nums.every(Number.isFinite) ? nums : null;
}

function findNumericArrayDeep(source, minLength = 2, seen = new Set()) {
  if (!source || typeof source !== 'object' || seen.has(source)) return null;
  seen.add(source);
  if (Array.isArray(source)) {
    const parsed = parseNumericArray(source);
    if (parsed && parsed.length >= minLength) return parsed;
    for (const item of source) {
      const nested = findNumericArrayDeep(item, minLength, seen);
      if (nested) return nested;
    }
    return null;
  }
  for (const value of Object.values(source)) {
    const parsed = parseNumericArray(value);
    if (parsed && parsed.length >= minLength) return parsed;
  }
  for (const value of Object.values(source)) {
    if (value && typeof value === 'object') {
      const nested = findNumericArrayDeep(value, minLength, seen);
      if (nested) return nested;
    }
  }
  return null;
}

function getStringField(source, keys) {
  if (!source || typeof source !== 'object') return null;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.length) return value;
  }
  return null;
}

function normalizeTextRunCandidate(run) {
  if (!run || typeof run !== 'object') return null;
  const text = getStringField(run, ['text', 'content', 'string', 'str', 'value', 'chars', 'label']);
  if (!text) return null;
  const boundaries = parseNumericArray(
    run.charXBoundaries ?? run.charBoundaries ?? run.xBoundaries ?? run.x_bounds ?? run.charXPositions ?? run.xPositions ?? run.x_positions,
  ) ?? findNumericArrayDeep(run, Math.max(2, text.length + 1));
  if (!boundaries || boundaries.length < text.length + 1) return null;
  const x = Number(run.x ?? run.left ?? run.x0 ?? boundaries[0]);
  const y = Number(run.y ?? run.top ?? run.y0 ?? run.baselineY ?? run.originY);
  const height = Number(run.height ?? run.h ?? run.lineHeight ?? run.bboxHeight ?? run.fontSize);
  const width = boundaries[boundaries.length - 1] - boundaries[0];
  const pageIndex = extractNormalizedPageIndex(run);
  const sectionIndex = pickIntDeep(run, ['sectionIndex', 'section', 'section_idx', 'sec']);
  const paragraphIndex = pickIntDeep(run, ['paragraphIndex', 'paraIdx', 'para_idx', 'para']);
  const charStart = pickIntDeep(run, ['startCharOffset', 'start_char_offset', 'charStart', 'char_start', 'runStartCharOffset', 'run_start_char_offset']);
  if (![x, y, height].every(Number.isFinite) || height <= 0 || width <= 0) return null;
  return { text, boundaries, x, y, width, height, pageIndex, sectionIndex, paragraphIndex, charStart, raw: run };
}

function collectTextRuns(value, out = [], seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return out;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectTextRuns(item, out, seen);
    return out;
  }
  const run = normalizeTextRunCandidate(value);
  if (run) out.push(run);
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') collectTextRuns(child, out, seen);
  }
  return out;
}

function touchPageTextLayoutCache(pageIndex, data) {
  if (pageTextLayoutCache.has(pageIndex)) pageTextLayoutCache.delete(pageIndex);
  pageTextLayoutCache.set(pageIndex, data);
  while (pageTextLayoutCache.size > MAX_LAYOUT_CACHE) {
    const oldest = pageTextLayoutCache.keys().next().value;
    pageTextLayoutCache.delete(oldest);
  }
  return data;
}

function getPageTextLayoutData(pageIndex) {
  if (!doc || !Number.isFinite(pageIndex)) return null;
  if (pageTextLayoutCache.has(pageIndex)) {
    return touchPageTextLayoutCache(pageIndex, pageTextLayoutCache.get(pageIndex));
  }
  try {
    const raw = doc.getPageTextLayout(pageIndex);
    const parsed = tryParseJson(raw);
    const data = { raw: parsed, runs: collectTextRuns(parsed) };
    return touchPageTextLayoutCache(pageIndex, data);
  } catch (error) {
    console.warn('페이지 텍스트 레이아웃 조회 실패', error);
    const data = { raw: { error: String(error) }, runs: [] };
    return touchPageTextLayoutCache(pageIndex, data);
  }
}

function findOccurrenceIndexes(text, query) {
  if (!text || !query) return [];
  const out = [];
  let from = 0;
  while (from <= text.length - query.length) {
    const idx = text.indexOf(query, from);
    if (idx === -1) break;
    out.push(idx);
    from = idx + 1;
  }
  return out;
}

function pickRunCharStart(run) {
  if (Number.isFinite(run?.charStart)) return run.charStart;
  return 0;
}

function getRunCharLength(run) {
  if (!run) return 0;
  return Math.min(run.text?.length ?? 0, Math.max(0, (run.boundaries?.length ?? 0) - 1));
}

function findLayoutRunForMatch(match, layout, pageIndex, matchText) {
  if (!match || !layout?.runs?.length || !matchText) return null;
  if (match.cellContext) return null;
  const matchLength = match.length ?? match.count ?? matchText.length;
  const matchStart = match.charOffset;
  const matchEnd = Number.isFinite(matchStart) && Number.isFinite(matchLength) ? matchStart + matchLength : null;
  if (!Number.isFinite(matchStart) || !Number.isFinite(matchEnd)) return null;

  const exactCandidates = layout.runs.filter((run) => {
    if (run.pageIndex != null && run.pageIndex !== pageIndex) return false;
    if (match.sectionIndex != null && run.sectionIndex != null && run.sectionIndex !== match.sectionIndex) return false;
    if (match.paragraphIndex != null && run.paragraphIndex != null && run.paragraphIndex !== match.paragraphIndex) return false;
    if (!run.text?.includes(matchText)) return false;
    const charStart = pickRunCharStart(run);
    const charEnd = charStart + getRunCharLength(run);
    return matchStart >= charStart && matchEnd <= charEnd;
  });

  if (exactCandidates.length) {
    return exactCandidates.sort((a, b) => pickRunCharStart(a) - pickRunCharStart(b))[0];
  }

  return null;
}

function refineRectWithTextRun(run, match, rect, matchText) {
  if (!run || !matchText) return null;
  const charStart = pickRunCharStart(run);
  const relativeStart = (match.charOffset ?? 0) - charStart;
  const matchLength = match.length ?? match.count ?? matchText.length;
  const relativeEnd = relativeStart + matchLength;
  if (!Number.isFinite(relativeStart) || !Number.isFinite(relativeEnd)) return null;
  const x0 = run.boundaries?.[relativeStart];
  const x1 = run.boundaries?.[relativeEnd];
  if (![x0, x1].every(Number.isFinite) || x1 <= x0) return null;
  return {
    x: run.x + x0,
    y: run.y,
    width: x1 - x0,
    height: run.height,
    pageIndex: rect.pageIndex,
  };
}

function refineRectsWithTextLayout(match, rects, pageIndex, matchText) {
  if (!rects.length || !matchText || !Number.isFinite(pageIndex)) {
    debugState.layoutPageIndex = pageIndex ?? null;
    debugState.layoutRunCount = 0;
    debugState.layoutRawSample = null;
    debugState.layoutCandidateRuns = [];
    return null;
  }
  const layout = getPageTextLayoutData(pageIndex);
  debugState.layoutPageIndex = pageIndex;
  debugState.layoutRunCount = layout?.runs?.length ?? 0;
  debugState.layoutRawSample = layout?.raw ?? null;
  if (!layout?.runs?.length) {
    debugState.layoutCandidateRuns = [];
    return null;
  }
  if (match.cellContext) {
    debugState.layoutCandidateRuns = [{ fallback: 'cell-context' }];
    return null;
  }
  const refined = [];
  const chosenRuns = [];
  for (const rect of rects) {
    const chosen = findLayoutRunForMatch(match, layout, pageIndex, matchText);
    chosenRuns.push(chosen ? {
      pageIndex: chosen.pageIndex,
      sectionIndex: chosen.sectionIndex,
      paragraphIndex: chosen.paragraphIndex,
      charStart: chosen.charStart,
      text: chosen.text,
      x: chosen.x,
      y: chosen.y,
      width: chosen.width,
      height: chosen.height,
      boundariesPreview: chosen.boundaries.slice(0, Math.min(chosen.boundaries.length, 12)),
      boundaryCount: chosen.boundaries.length,
    } : { fallback: 'no-run-match' });
    const improved = chosen ? refineRectWithTextRun(chosen, match, rect, matchText) : null;
    refined.push(improved ?? rect);
  }
  debugState.layoutCandidateRuns = chosenRuns;
  return refined.some((rect, index) => rect !== rects[index]) ? refined : null;
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

function getSelectionRectsForMatch(match, range) {
  if (!doc || !match || !range) return null;
  const cell = match.cellContext;
  if (cell && typeof cell === 'object') {
    const parentPara = pickIntDeep(cell, ['parentPara', 'parent_para', 'parentParagraphIndex', 'parentParaIndex']);
    const ctrlIdx = pickIntDeep(cell, ['ctrlIdx', 'ctrl_idx', 'controlIdx', 'control_idx']);
    const cellIdx = pickIntDeep(cell, ['cellIdx', 'cell_idx']);
    const cellPara = pickIntDeep(cell, ['cellPara', 'cell_para', 'cellParagraphIndex', 'cellParaIndex']);
    if ([range.sectionIndex, parentPara, ctrlIdx, cellIdx, cellPara, range.startCharOffset, range.endCharOffset].every(Number.isFinite)) {
      return {
        raw: doc.getSelectionRectsInCell(
          range.sectionIndex,
          parentPara,
          ctrlIdx,
          cellIdx,
          cellPara,
          range.startCharOffset,
          cellPara,
          range.endCharOffset,
        ),
        source: 'engine-selection-rects-in-cell',
      };
    }
  }
  return {
    raw: doc.getSelectionRects(
      range.sectionIndex,
      range.startParaIndex,
      range.startCharOffset,
      range.endParaIndex,
      range.endCharOffset,
    ),
    source: 'engine-selection-rects',
  };
}

function computeSearchHighlightData(match = getCurrentSearchMatch()) {
  if (!doc || !match) return { rects: [], pageIndex: match?.pageIndex ?? null, raw: null };
  const range = resolveMatchEnd(match);
  if (!range || range.sectionIndex == null) return { rects: [], pageIndex: match.pageIndex ?? null, raw: null };
  try {
    const selection = getSelectionRectsForMatch(match, range);
    const parsed = tryParseJson(selection?.raw);
    const rects = collectRects(parsed);
    const rectPageIndex = rects.find((rect) => Number.isFinite(rect.pageIndex))?.pageIndex ?? null;
    const pageIndex = rectPageIndex ?? match.pageIndex ?? null;
    const refinedRects = refineRectsWithTextLayout(match, rects, pageIndex, lastSearchQuery);
    debugState.rawRects = parsed;
    debugState.selectedText = null;
    debugState.rects = refinedRects ?? rects;
    debugState.rectSource = refinedRects ? 'layout-refined' : (selection?.source ?? 'engine-selection-rects');
    return { rects: refinedRects ?? rects, pageIndex, raw: parsed };
  } catch (error) {
    console.warn('검색 하이라이트 좌표 계산 실패', error);
    debugState.rawRects = { error: String(error) };
    debugState.selectedText = null;
    debugState.rects = [];
    debugState.rectSource = 'error';
    debugState.layoutPageIndex = null;
    debugState.layoutRunCount = 0;
    debugState.layoutRawSample = null;
    debugState.layoutCandidateRuns = [];
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

function removeSearchHighlightLayers(scope = els.pageContainer) {
  scope.querySelectorAll('.search-highlight-layer').forEach((node) => node.remove());
}

function buildSearchHighlightLayer(svg, rects) {
  const viewBox = getSvgViewBox(svg);
  if (!viewBox || !rects.length) return null;
  const [minX, minY, width, height] = viewBox;
  const layer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  layer.setAttribute('class', 'search-highlight-layer');
  layer.setAttribute('viewBox', `${minX} ${minY} ${width} ${height}`);
  layer.setAttribute('preserveAspectRatio', svg.getAttribute('preserveAspectRatio') || 'xMidYMid meet');
  layer.setAttribute('aria-hidden', 'true');
  for (const rect of rects) {
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
  return layer;
}

function renderSearchHighlightsForPage(pageIndex, pageRects) {
  const slot = getPageSlot(pageIndex);
  if (!slot) return;
  removeSearchHighlightLayers(slot);
  if (!pageRects?.length) return;
  const svg = slot.querySelector('svg');
  const inner = slot.firstElementChild ?? slot;
  if (!svg || !inner) return;
  const layer = buildSearchHighlightLayer(svg, pageRects);
  if (!layer) return;
  inner.appendChild(layer);
}

function renderSearchHighlights(options = {}) {
  removeSearchHighlightLayers();
  const match = Object.prototype.hasOwnProperty.call(options, 'match') ? options.match : syncCurrentSearchMatch();
  updateDebugPanel();
  if (!match) return;
  const fallbackPageIndex = Number.isFinite(match.pageIndex) ? match.pageIndex : currentPage;
  const pageRectsByPage = new Map();
  for (const rect of searchHighlightRects) {
    const rectPageIndex = Number.isFinite(rect.pageIndex) ? rect.pageIndex : fallbackPageIndex;
    if (!Number.isFinite(rectPageIndex)) continue;
    if (!pageRectsByPage.has(rectPageIndex)) pageRectsByPage.set(rectPageIndex, []);
    pageRectsByPage.get(rectPageIndex).push(rect);
  }
  if (!options.skipEnsureRendered) {
    for (const pageIndex of pageRectsByPage.keys()) {
      const slot = getPageSlot(pageIndex);
      if (slot?.dataset.rendered !== '1') {
        renderPageIntoSlot(pageIndex, { skipHighlight: true });
      }
    }
  }
  for (const [pageIndex, rects] of pageRectsByPage.entries()) {
    const slot = getPageSlot(pageIndex);
    if (slot?.dataset.rendered === '1') {
      renderSearchHighlightsForPage(pageIndex, rects);
    }
  }
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

function getApproxPageWidth() {
  const wrapWidth = els.viewerWrap.clientWidth || els.pageContainer.clientWidth || 360;
  return Math.max(240, Math.min(1200, wrapWidth * currentZoom));
}

function updatePageAspectRatioFromSvg(svg) {
  const viewBox = getSvgViewBox(svg);
  if (!viewBox) return;
  const width = viewBox[2];
  const height = viewBox[3];
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    pageAspectRatio = height / width;
  }
}

function computePageSlotHeight() {
  const width = getApproxPageWidth();
  return Math.max(320, Math.round(width * pageAspectRatio));
}

function updatePageSlotHeights() {
  const nextHeight = computePageSlotHeight();
  pageSlotHeight = nextHeight;
  for (const slot of pageSlots) {
    slot.style.minHeight = `${nextHeight}px`;
  }
}

function createPageSlot(pageIndex) {
  const slot = document.createElement('div');
  slot.className = 'page-slot';
  slot.dataset.pageIndex = String(pageIndex);
  const inner = document.createElement('div');
  inner.className = 'page-slot-inner';
  slot.appendChild(inner);
  return slot;
}

function buildPageStack() {
  pageSlots = [];
  els.pageContainer.replaceChildren();
  for (let i = 0; i < pageCount; i += 1) {
    const slot = createPageSlot(i);
    pageSlots.push(slot);
    els.pageContainer.appendChild(slot);
  }
  updatePageSlotHeights();
}

function getPageSlot(pageIndex) {
  return Number.isFinite(pageIndex) ? pageSlots[pageIndex] ?? null : null;
}

function touchRenderedSlot(pageIndex) {
  if (renderedSlotAccess.has(pageIndex)) renderedSlotAccess.delete(pageIndex);
  renderedSlotAccess.set(pageIndex, Date.now());
}

function getPreservedPageIndexes(centerPage) {
  const keep = new Set();
  for (let i = centerPage - SLOT_PRERENDER_RADIUS; i <= centerPage + SLOT_PRERENDER_RADIUS; i += 1) {
    if (i >= 0 && i < pageCount) keep.add(i);
  }
  return keep;
}

function clearPageSlot(pageIndex) {
  const slot = getPageSlot(pageIndex);
  if (!slot) return;
  const inner = slot.firstElementChild ?? slot;
  removeSearchHighlightLayers(slot);
  inner.replaceChildren();
  slot.dataset.rendered = '0';
  renderedSlotAccess.delete(pageIndex);
}

function trimRenderedSlots(preserve = getPreservedPageIndexes(currentPage)) {
  if (renderedSlotAccess.size <= MAX_RENDERED_SLOTS) return;
  const candidates = [...renderedSlotAccess.entries()]
    .filter(([pageIndex]) => !preserve.has(pageIndex))
    .sort((a, b) => {
      const distanceDiff = Math.abs(b[0] - currentPage) - Math.abs(a[0] - currentPage);
      if (distanceDiff !== 0) return distanceDiff;
      return a[1] - b[1];
    });
  for (const [pageIndex] of candidates) {
    if (renderedSlotAccess.size <= MAX_RENDERED_SLOTS) break;
    clearPageSlot(pageIndex);
  }
}

function renderPageIntoSlot(pageIndex, options = {}) {
  if (!doc || pageIndex < 0 || pageIndex >= pageCount) return false;
  const slot = getPageSlot(pageIndex);
  if (!slot) return false;
  if (slot.dataset.rendered === '1') {
    touchRenderedSlot(pageIndex);
    if (!options.skipHighlight) renderSearchHighlights({ skipEnsureRendered: true });
    return true;
  }
  try {
    const svgText = doc.renderPageSvg(pageIndex);
    const safeSvg = sanitizeSvg(svgText);
    updatePageAspectRatioFromSvg(safeSvg);
    const inner = slot.firstElementChild ?? slot;
    inner.replaceChildren(safeSvg);
    slot.dataset.rendered = '1';
    touchRenderedSlot(pageIndex);
    updatePageSlotHeights();
    lastRenderedPage = pageIndex;
    if (!options.skipHighlight) renderSearchHighlights({ skipEnsureRendered: true });
    return true;
  } catch (error) {
    console.error(error);
    showError('페이지를 안전하게 표시하지 못했습니다.');
    return false;
  }
}

function ensurePagesAround(pageIndex, radius = SLOT_PRERENDER_RADIUS) {
  const preserve = new Set();
  for (let i = pageIndex - radius; i <= pageIndex + radius; i += 1) {
    if (i < 0 || i >= pageCount) continue;
    preserve.add(i);
    renderPageIntoSlot(i);
  }
  trimRenderedSlots(preserve);
}

function refreshSlotObserver() {
  slotObserver?.disconnect();
  slotObserver = null;
  if (!pageSlots.length || typeof IntersectionObserver !== 'function') return;
  const rootMargin = `${Math.max(pageSlotHeight, 320)}px 0px ${Math.max(pageSlotHeight, 320)}px 0px`;
  slotObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const pageIndex = Number(entry.target.dataset.pageIndex);
      if (!Number.isFinite(pageIndex)) continue;
      ensurePagesAround(pageIndex);
    }
  }, { root: els.viewerWrap, rootMargin, threshold: 0.01 });
  for (const slot of pageSlots) {
    slotObserver.observe(slot);
  }
}

function findPageClosestToViewportCenter() {
  if (!pageSlots.length) return null;
  const wrapRect = els.viewerWrap.getBoundingClientRect();
  const centerY = wrapRect.top + (wrapRect.height / 2);
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < pageSlots.length; i += 1) {
    const rect = pageSlots[i].getBoundingClientRect();
    const slotCenter = rect.top + (rect.height / 2);
    const distance = Math.abs(slotCenter - centerY);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = i;
    }
  }
  return bestIndex;
}

function syncCurrentPageFromViewport() {
  const nextIndex = findPageClosestToViewportCenter();
  if (!Number.isFinite(nextIndex)) return;
  if (nextIndex !== currentPage) {
    currentPage = nextIndex;
  }
  updatePager();
  ensurePagesAround(currentPage);
  trimRenderedSlots(getPreservedPageIndexes(currentPage));
}

function queueViewportSync() {
  if (scrollSyncRaf != null) return;
  scrollSyncRaf = requestAnimationFrame(() => {
    scrollSyncRaf = null;
    syncCurrentPageFromViewport();
  });
}

function goToPage(pageNumber, options = {}) {
  if (!pageCount) return false;
  const requestedPage = Number(pageNumber);
  if (!Number.isFinite(requestedPage)) return false;
  const nextPage = Math.max(1, Math.min(pageCount, Math.trunc(requestedPage)));
  const nextIndex = nextPage - 1;
  const slot = getPageSlot(nextIndex);
  if (!slot) return false;
  const behavior = options.behavior ?? 'smooth';
  ensurePagesAround(nextIndex);
  currentPage = nextIndex;
  updatePager();
  slot.scrollIntoView({ block: 'start', behavior });
  trimRenderedSlots(getPreservedPageIndexes(nextIndex));
  return true;
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
    buildPageStack();
    ensurePagesAround(0, SLOT_PRERENDER_RADIUS + 1);
    refreshSlotObserver();
    goToPage(1, { behavior: 'auto' });
    syncCurrentPageFromViewport();
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

function openFilePicker() {
  const picker = els.fileInput;
  if (!picker) return;
  try {
    if (typeof picker.showPicker === 'function') {
      picker.showPicker();
      return;
    }
  } catch (error) {
    console.warn('showPicker 실패, click fallback 사용', error);
  }
  picker.click();
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
  els.openBtn.addEventListener('click', openFilePicker);
  els.openBtn2.addEventListener('click', openFilePicker);
  els.themeBtn.addEventListener('click', toggleTheme);

  els.fileInput.addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    openFile(file);
    event.target.value = '';
  });

  els.prevBtn.addEventListener('click', () => goToPage(currentPage, { behavior: 'smooth' }));
  els.nextBtn.addEventListener('click', () => goToPage(currentPage + 2, { behavior: 'smooth' }));

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

  els.viewerWrap.addEventListener('scroll', queueViewportSync, { passive: true });
  window.addEventListener('resize', () => {
    updatePageSlotHeights();
    refreshSlotObserver();
    ensurePagesAround(currentPage);
    queueViewportSync();
  });
  window.addEventListener('beforeunload', cleanupDocument);
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js');
  });
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
  registerServiceWorker();
}

boot();
