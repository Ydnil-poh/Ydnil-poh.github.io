# Ydnil Strolls

광고 없는 미니멀 포토에세이 스타일의 Astro 개인 블로그입니다.

## 실행

```bash
npm install
npm run dev
```

## 콘텐츠 등록 방법

포스트는 `src/content/posts/*.md`에 Markdown으로 추가합니다.

### 1) 새 파일 만들기

예시: `src/content/posts/2026-05-20-my-walk.md`

### 2) Frontmatter 작성

```yaml
---
title: 포스트 제목
date: 2026-05-20
location: 서울 어딘가
excerpt: 목록에서 보일 짧은 소개
tags:
  - 산책
  - 사진
cover: /images/sample.jpg
coverAlt: 표지 이미지 설명
---
```

### 3) 본문 작성

일반 Markdown으로 본문을 작성하면 `/posts/[slug]` 상세 페이지가 자동 생성됩니다.

## 이미지 추가

이미지는 `public/images/`에 넣고 Markdown/Frontmatter에서 `/images/파일명.jpg`처럼 참조하세요.

## 배포

`main` 브랜치에 푸시하면 GitHub Actions가 빌드 후 GitHub Pages에 자동 배포합니다.
