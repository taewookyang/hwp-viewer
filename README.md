# hwp-viewer

모바일 브라우저에서 HWP/HWPX 문서를 로컬 처리로 열어보는 정적 웹앱입니다.

## 현재 구성
- `index.html` — 앱 진입점
- `styles.css` — 스타일
- `app.js` — UI/렌더링 제어
- `rhwp.js` / `rhwp_bg.wasm` — 문서 파싱/렌더 엔진
- `manifest.json` / `sw.js` — PWA/캐시
- `notes/` — 변경/배포 메모
- `LICENSE` — 라이선스

## 운영 원칙
- 원본과 문서는 `~/projects/hwp-viewer`에서 관리
- 휴대폰 공유/업로드용 사본만 `/sdcard/Download`에 둠
- 배포 전에는 샘플 문서 테스트와 보안 점검을 다시 수행

## 라이선스 및 고지

이 뷰어는 오픈소스 HWP 엔진 rhwp (@rhwp/core)를 사용합니다.

- rhwp: MIT License  
  Copyright (c) Edward Kim  
  https://github.com/edwardkim/rhwp

본 뷰어는 rhwp 엔진을 사용하며, 해당 엔진은 한글과컴퓨터의
한/글 문서 파일(.hwp) 공개 문서를 참고하여 개발되었습니다.

한글, 한컴, HWP, HWPX는 주식회사 한글과컴퓨터의 등록 상표이며,
본 프로젝트는 한글과컴퓨터와 제휴·후원·승인 관계가 없는 독립 프로젝트입니다.

이 뷰어는 개인이 만든 참고용 도구로, 일부 문서가 완전하거나
정확하게 표시되지 않을 수 있습니다.
