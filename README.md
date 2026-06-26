# hwp-viewer

모바일 브라우저에서 HWP/HWPX 문서를 로컬 처리로 열어보는 정적 웹앱입니다.

## 현재 구성
- `index.html` — 앱 진입점
- `styles.css` — 스타일
- `app.js` — UI/렌더링 제어
- `rhwp.js` / `rhwp_bg.wasm` — 문서 파싱/렌더 엔진
- `manifest.json` / `sw.js` — PWA/캐시
- `archive/` — 날짜 붙은 배포 ZIP 보관
- `notes/` — 변경/배포 메모

## 운영 원칙
- 원본과 문서는 `~/projects/hwp-viewer`에서 관리
- 휴대폰 공유/업로드용 사본만 `/sdcard/Download`에 둠
- 배포 전에는 샘플 문서 테스트와 보안 점검을 다시 수행

## 현재 보관본
- `archive/2026-06-26-hwp-viewer-original.zip`
- `archive/2026-06-26-hwp-viewer-v2.zip`
