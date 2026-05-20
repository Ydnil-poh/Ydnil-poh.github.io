# Ydnil Strolls

광고 없는 미니멀 포토에세이 스타일의 Astro 개인 블로그입니다.

## 실행

```bash
npm install
npm run dev
```

## 콘텐츠 등록 방법

포스트는 `src/content/posts/*.md`에 Markdown으로 추가합니다.

### Frontmatter 필드

```yaml
---
title: 포스트 제목
date: 2026-05-20
location: 서울 어딘가
excerpt: 목록에서 보일 짧은 소개
tags: [산책, 사진]
cover: /images/sample.jpg
coverAlt: 표지 이미지 설명
views: 0
trackbacks: 0
---
```

## 인터랙티브 그리드 규칙

- 포스트 1개 = 그리드 셀 1개
- `본문 글자 수`와 `본문 이미지 개수`로 셀의 그리드 내 배치 우선순위(score) 조정
- `views` + `trackbacks` 값을 이용해 셀 농도(색면 강도) 조정
- 포스트 수가 늘어나면 정방형 그리드가 1x1 → 2x2 → 3x3으로 증가 (각 셀은 텍스트/썸네일 없이 동일한 위계의 색면)

## 이미지 추가

이미지는 `public/images/`에 넣고 Markdown에서 `/images/파일명.jpg`로 참조하세요.

## 배포

`main` 브랜치에 푸시하면 GitHub Actions가 빌드 후 GitHub Pages에 자동 배포합니다.


## 활동 지표(중요)

- `views`, `trackbacks`는 현재 자동 집계가 아니라 **Markdown frontmatter 수동 입력값**입니다.
- 즉, 샘플 포스트의 수치도 하드코딩 예시이며 새 포스트도 기본은 `0`으로 시작합니다.
- 실제 자동 집계 연동(예: 분석 API/DB)은 별도 구현이 필요합니다.
