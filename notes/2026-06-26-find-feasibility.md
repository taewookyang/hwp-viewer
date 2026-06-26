# 찾기 기능 가능성 메모

## 결론
찾기 기능은 **가능**하다.

## 근거
`rhwp.js`에서 아래 API를 확인했다.
- `getPageTextLayout(page_num)`
  - 페이지별 텍스트 레이아웃 JSON 반환
  - 텍스트와 위치 정보 포함
- `getTextRange(section_idx, para_idx, char_offset, count)`
  - 본문 문단 텍스트 일부 추출 가능
- `getTextInCell(...)`
  - 표 셀 텍스트 추출 가능
- `getControlTextPositions(section_idx, para_idx)`
  - 문단 내 컨트롤 텍스트 위치 확인 가능

## 이번 1차 구현 방향
- 페이지 단위 검색
- 검색어 입력
- 결과 있는 페이지 목록 계산
- 이전/다음 결과 페이지 이동
- 상태 표시 (`1/3 · 2페이지`)

## 아직 안 하는 것
- 정확한 글자 단위 하이라이트
- 검색 결과 노란 표시 박스
- 문단 단위/좌표 단위 정밀 탐색

## 다음 확장 방향
2차에서는 `getPageTextLayout`의 좌표 정보를 이용해
- 검색어 하이라이트
- 현재 페이지 내 다음 결과 이동
- 검색 결과 개수 정밀 표시
까지 확장 가능
