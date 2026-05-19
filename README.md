# Ydnil Strolls

작은 모험들을 기록하는 개인 블로그입니다. Astro로 만들어진 정적 블로그입니다.

## 🚀 프로젝트 구조

```
/
├── public/              # 정적 자산 (이미지 등)
├── src/
│   ├── pages/          # 블로그 페이지
│   │   ├── index.astro # 홈페이지
│   │   └── posts/      # 블로그 포스트들
│   ├── layouts/        # 레이아웃 컴포넌트
│   └── styles/         # 스타일 파일
└── package.json
```

## 🎨 설정

- **폰트**: Hahmlet (한글 우아한 폰트)
- **스타일**: 깔끔한 미니멀 디자인
- **반응형**: 모바일 친화적 구조

## 🧞 명령어

```bash
# 개발 서버 실행
npm run dev

# 프로덕션 빌드
npm run build

# 빌드 미리보기
npm run preview
```

개발 서버는 기본적으로 `http://localhost:4321`에서 실행됩니다.

## 📝 포스트 작성

1. `src/posts/` 디렉토리에 새로운 `.md` 파일 생성
2. Front Matter로 메타데이터 추가:
   ```yaml
   ---
   title: 포스트 제목
   date: 2026-05-19
   slug: post-slug
   excerpt: 간단한 설명
   ---
   ```
3. Markdown으로 콘텐츠 작성

## 📖 더 알아보기

- [Astro 공식 문서](https://docs.astro.build)
- [Astro Discord 커뮤니티](https://astro.build/chat)
