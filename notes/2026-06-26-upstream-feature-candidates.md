# upstream / rhwp.js 기능 후보 메모

## 결론
원본 앱 UI 자체는 최소 데모 수준이라 바로 가져올 UI 기능은 거의 없다.
반면 `rhwp.js` 엔진 API에는 현재 뷰어에 바로 연결할 수 있는 기능 후보가 많다.

## 이미 확인한 핵심 후보
### 1순위
- `searchAllText(query, case_sensitive, include_cells)`
  - 문서 전체 검색 (모든 매치 반환)
  - `rhwp.js:6323`
- `searchText(query, from_sec, from_para, from_char, forward, case_sensitive)`
  - 다음/이전 검색에 적합
  - `rhwp.js:6350`

### 2순위
- `getSelectionRects(...)`
  - 선택/검색 결과 하이라이트 박스 좌표용
  - `rhwp.js:3591`
- `getPageTextLayout(page_num)`
  - 페이지 텍스트 레이아웃 JSON
  - `rhwp.js:3372` 부근

## 추가로 바로 유용한 후보
### A. 탭한 위치 기반 정밀 이동 / 선택 준비
- `hitTest(page_num, x, y)`
  - 페이지 좌표 -> section/paragraph/charOffset
  - `rhwp.js:4218`
- `getCursorRect(section_idx, para_idx, char_offset)`
  - 문서 위치 -> 픽셀 좌표
  - `rhwp.js:2246`
- 의미
  - 검색 결과 정확 점프
  - 이후 텍스트 선택/복사 기반

### B. 복사 기능 기반
- `copySelection(...)`
  - `rhwp.js:500`
- `copySelectionInCell(...)`
  - `rhwp.js:530`
- `getClipboardText()`
  - 내부 클립보드 플레인 텍스트
  - `rhwp.js:2133`
- 의미
  - 장기적으로 '문단/영역 복사' 가능

### C. 책갈피 / 목차 비슷한 탐색
- `getBookmarks()`
  - 문서 내 책갈피 목록
  - `rhwp.js:1698`
- 의미
  - 문서에 책갈피가 있으면 간단 탐색 패널 가능

### D. 양식 문서 대응
- `getFieldList()`
  - `[{fieldId, fieldType, name, guide, command, value, location}]`
  - `rhwp.js:2680`
- `getFormObjectAt(page_num, x, y)`
  - 좌표의 양식 개체 반환
  - `rhwp.js:2805`
- `getFormObjectInfo(sec, para, ci)`
  - 양식 상세 정보
  - `rhwp.js:2832`
- 의미
  - 누름틀/폼 문서 인식, 안내 UI 가능

### E. 페이지/개체 정보
- `getPageInfo(page_num)`
  - 페이지 정보 JSON
  - `rhwp.js:3256`
- `getPageControlLayout(page_num)`
  - 표/이미지/개체 레이아웃 JSON
  - `rhwp.js:3166`
- `getPageOfPosition(section_idx, para_idx)`
  - 문서 위치 -> 페이지
  - `rhwp.js:3307`
- `getPositionOfPage(global_page)`
  - 페이지 -> 문서 위치
  - `rhwp.js:3531`
- 의미
  - 검색 결과 페이지 매핑, 개체 개요 표시

### F. 디버그/고급 보기
- `getShowControlCodes()` / `setShowControlCodes(enabled)`
  - 조판부호/개체 마커 토글
  - `rhwp.js:3756`, `7256`
- `getShowParagraphMarks()` / `setShowParagraphMarks(enabled)`
  - 문단부호 토글
  - `rhwp.js:3764`, `7263`
- 의미
  - 일반 사용자용은 아니지만 고급 보기/문서 진단용으로 유용

### G. 내보내기 / 변환
- `exportHwp()`
  - `rhwp.js:1470`
- `exportHwpVerify()`
  - 검증 메타데이터
  - `rhwp.js:1496`
- `exportHwpx()`
  - `rhwp.js:1518`
- `renderPageHtml(page_num)`
  - 페이지 HTML 렌더
  - 기존 탐색에서 확인
- 의미
  - 장기적으로 '다른 형식으로 저장' 가능

## 현재 판단
1. 1순위와 2순위는 반드시 해야 함
2. 하지만 그 둘만으로 끝내기엔 아쉬움
3. 최소한 3순위로 `hitTest/getCursorRect` 기반 정밀 위치 기능까지 가면 검색/하이라이트 완성도가 확 올라감

## 추천 구현 묶음
- 묶음 A: 내장 검색 교체 + 하이라이트
- 묶음 B: 검색 결과 탭/정밀 점프 + 복사 기반
- 묶음 C: 책갈피/양식/고급 보기 토글
