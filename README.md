# Ydnil Strolls

## 왜 `post1`이 안 보일 수 있나

현재 구조는 **`src/content/posts/*.md` 경로의 Markdown만 수집**합니다. `post1.md`를 다른 경로(예: 루트, public, src/posts)에 올리면 목록에 안 뜹니다.

또한 프론트매터 필수값(`title`, `date`, `location`, `excerpt`)이 누락되면 컬렉션 검증에서 제외될 수 있습니다.

## 올바른 등록 규칙

1. 파일 위치: `src/content/posts/post1.md`  
2. 확장자: `.md`  
3. 프론트매터 필수 필드 포함

```yaml
---
title: post1
date: 2026-05-21
location: Seoul
excerpt: short summary
tags: [archive]
cover: /images/sample.jpg
coverAlt: sample
views: 0
trackbacks: 0
---
```

## 인터랙티브 나선형 매트릭스 스펙

- 11열 × 9행(99칸) 고정판
- 중앙([6열,5행])부터 시계방향 달팽이 배치
- 마크다운 자동 파싱:
  - `text_count`: 공백 제외 글자 수
  - `image_count`: `![]()` + `<img>` 개수
  - `has_embed`: iframe/video/embed 존재 여부
- 점수식:  
  `totalScore = (text_count * 0.1) + (image_count * 15) + (has_embed * 20) + (views * 2.5)`
- 색상 단계:
  - 상위 15%: `#E65A28`
  - 15~40%: `#3D4A3E`
  - 그 외: `#607261`
- 빈 칸 placeholder: `#DFE2D9`
- 배경: `#EAECE6`
- 모바일(<=768px): 보드 90도 회전 + 가로 스크롤

## Supabase 연동

클라이언트에서 아래 Public env를 사용합니다.

- `PUBLIC_SUPABASE_URL`
- `PUBLIC_SUPABASE_ANON_KEY`

조회수 증가 RPC는 `increment_post_view(post_id text)`를 호출하도록 구현되어 있습니다.

## 실행

```bash
npm install
npm run dev
npm run build
```
