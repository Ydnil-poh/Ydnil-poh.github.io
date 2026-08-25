# Archive Field

개인 기록을 의미 기반 지형(Field) 위에 배치하는 정적 아카이브.

기록을 시간순 목록으로 나열하지 않는다. 각 기록은 하나의 타일이 되어 40×25 격자 필드 위에 놓이고, 위치는 태그와 임베딩 유사도가, 질감(텍스처)은 본문 구조가, 선명도는 관찰(열람) 강도가 결정한다.

이 문서는 **현재 구현된 상태 기준의 사양서**다. 계획·비전 문서는 [docs/](docs/)에 있다.

---

## 스택과 실행

| 구성 | 내용 |
|---|---|
| 사이트 | Astro 6 정적 빌드, GitHub Actions 빌드 → Cloudflare Pages 배포 (`https://ydnil-poh.pages.dev`) |
| 백엔드 | Supabase — Postgres(이벤트·점수·히스토리), Storage(갤러리 이미지, 버킷 `img`) |
| 런타임 | Node ≥ 22.12, 외부 빌드 의존성은 `astro`, `@astrojs/sitemap` 뿐 |

```bash
npm run dev        # 개발 서버
npm run build      # prebuild(매니페스트 생성) 후 astro build
npm run manifest   # 매니페스트만 재생성
npm test           # node --test (레이아웃·텍스처·계약·투영 테스트)
npm run upload:image <파일> [저장이름]   # Supabase Storage 업로드 → 마크다운 이미지 구문 출력
```

빌드 환경변수: `SUPABASE_URL`(또는 `PUBLIC_SUPABASE_URL`), `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_STORAGE_BUCKET`(기본 `img`). 클라이언트는 `PUBLIC_SUPABASE_URL`, `PUBLIC_SUPABASE_ANON_KEY`를 사용한다. 자격증명이 없으면 Supabase 연동(attention 조회, 동기화, 갤러리 목록)만 건너뛰고 빌드는 성공한다.

---

## 콘텐츠 모델

기록은 `src/content/records/*.md` 마크다운 파일이다. 프론트매터 스키마([src/content.config.ts](src/content.config.ts)):

| 필드 | 타입 | 비고 |
|---|---|---|
| `title` | string | 필수 |
| `date` | date | 필수 |
| `excerpt` | string | 필수 |
| `tags` | string[] | **정확히 1개 필수** — 태그가 Region을 결정한다 |
| `location` | string | 선택 |
| `type` | `standard` \| `mediaRail` | 기본 `standard` |
| `visibility` | `public` \| `private` | `private`는 빌드·필드·매니페스트에서 제외 |
| `semanticScore` | 0~1 | 선택 — 지정하면 계산된 semantic score를 오버라이드 |
| `galleryFolder` | string | `mediaRail`용 Storage 폴더 경로 |
| `source` | string | 선택 |

본문 확장:

- `!youtube <url>` 단독 문단 → 페이지에서는 iframe 임베드(remark 플러그인), 텍스처에서는 재생 마커가 있는 mediaBlock으로 래스터화
- `mediaRail` 타입은 `galleryFolder`의 Storage 이미지들을 본문 왼쪽 레일에 표시(라이트박스 지원)하고, 텍스처에도 이미지 레일을 그린다

파일명이 slug가 된다 (`post1.md` → `/records/post1/`). `/posts/<slug>/`는 `/records/<slug>/`로 리다이렉트되는 레거시 경로다.

---

## 두 계층 원칙

| 계층 | 담당 | 입력 | 출력 |
|---|---|---|---|
| **Semantic** | "어디에 있는가" | 임베딩, relation, 태그 | Region 기하학, 슬롯 배치, 삽입 밀어내기, 타일 잉크 농도(불투명도) |
| **Runtime** | "누가·얼마나 읽는가" | 인간 열람(runtime score) + AI 대리 열람(machine score) | 텍스처 LOD(선명도) + 타일 색상(관심 출처) |

Runtime 점수가 아무리 높아도 위치는 움직이지 않고, semantic score가 아무리 높아도 텍스처가 선명해지지 않는다.

---

## Semantic Layer

### 임베딩 — `local-feature-hash-ko-en-64`

외부 임베딩 API를 쓰지 않는다. 빌드 시 결정적(deterministic) feature hashing으로 64차원 벡터를 만든다:

1. 토큰화: 라틴 3자 이상 단어 + 한글 2자 이상 단어 + 한글 3-gram
2. 각 토큰의 sha1 해시로 차원 인덱스(`hash[0] % 64`)와 부호(`hash[1]` 짝홀) 결정, 누산
3. L2 정규화

입력 텍스트는 `title + excerpt + location + type + 본문 평문`. 벡터는 매니페스트에 저장하지 않고 Supabase `archive_embeddings`(pgvector `vector(64)`)에만 동기화한다.

### Relation

모든 공개 레코드 쌍에 대해 `weight = 공유태그수 + cosine유사도 × 0.2`를 계산해 레코드당 상위 8개를 유지한다. 매니페스트의 `relationSummary`에 가중치 전체(8개)를 저장한다.

### Semantic Score

`semanticScore` 프론트매터가 있으면 그 값. 없으면 `relation 밀도 × 0.72 + 키워드 재출현성 × 0.28`을 코퍼스 내 min-max 정규화한 값. **텍스처 LOD·색상과 무관**하며 타일의 잉크 농도(표시 불투명도)에만 쓰인다.

### 투영 축은 상태다

2D 투영(variance 상위 2개 차원)은 코퍼스가 작을 때 순위가 불안정하므로, 한 번 선택된 축을 매니페스트 `embeddingProjection`에 영속하고 매 빌드 그대로 재사용한다. 재산출은 임베딩 모델/차원이 바뀌었거나 `--recalculate-projection`(또는 `ARCHIVE_RECALCULATE_PROJECTION=1`)을 명시했을 때만 일어난다. 투영은 Region 최초 bootstrap과 reseed에만 쓰인다.

---

## Region Layout

태그 1개 = Region 1개(`tag:<태그>`). Region은 `seedSlot`과 `footprint`(rect 또는 cells)를 가지며 매니페스트에 영속된다. 모든 레이아웃 로직은 footprint 추상화 API를 통한다.

**배치 규칙** ([src/lib/archive/regionLayout.mjs](src/lib/archive/regionLayout.mjs)):

1. **겹침 복구 불변식** — 이월된 Region들의 footprint 겹침을 매 rebuild 시작 시 해소한다. 겹친 셀은 seed(+2)나 점유 레코드(+1/셀)가 있는 쪽이 유지하고 동점이면 오래된 Region이 이긴다. 양보하는 쪽은 rect를 유지하는 한 변 크롭을 우선하고, 불가능하면 cells로 전환한다. seed 셀은 절대 양보하지 않는다.
2. **기존 레코드는 슬롯을 보존**한다. footprint 밖으로 밀려나거나 밀어내기의 대상이 된 경우에만 이동한다.
3. **삽입 밀어내기 (drift)** — 신규 레코드는 seed에서 바깥쪽으로 걸으며, 비어 있거나 **자신보다 덜 중심적인**(Region centroid와의 임베딩 유사도가 낮은) 레코드가 점유한 첫 셀을 차지한다. 밀려난 레코드는 footprint 안에서 seed 반대 방향의 최근접 빈 셀로 1칸 이동하며, 연쇄 밀어내기는 없다. 지형 변화의 원인은 열람이 아니라 아카이브 자체의 성장이고, seed와의 거리는 의미적 중심성으로 읽힌다.
4. **신규 태그**는 centroid가 가장 유사한 기존 Region의 seed 근처에, 기존 footprint와 교차하지 않는 footprint로 생성된다. 인접은 허용된다 — 인접은 의미적 유사성의 표현이다.
5. **Footprint 유지보수** (sleep rebuild 한정) — density가 0.82를 넘으면 확장, 0.48 미만이면 축소(목표 0.72). 확장은 `minCol/maxCol/minRow/maxRow` 방향별로 검사해 **다른 Region과 교차하는 방향만 포기**한다.
6. **비상 확장** — 빈 슬롯이 없는 footprint에 레코드를 넣어야 하면 빌드를 실패시키는 대신 그 자리에서 방향 가드가 적용된 확장을 수행한다 (`region.footprint_emergency_expanded`).

모든 배치 결정은 레이아웃 이벤트(`layout.slot_preserved`, `layout.moved_within_region`, `layout.placed`, `layout.displaced`, `layout.anchor_record`, `record.first_seen`, `record.removed`, `region.footprint_overlap_repaired` 등)로 기록되어 디버그 파일과 Supabase 히스토리에 남는다.

**Ghost trace** — 레코드가 떠난 셀에는 그 시점의 텍스처 스냅샷이 흐린 잔상(`traces`)으로 남는다. 잔상은 **영구적**이다: 풍화되지 않고, 새 타일이 올라오면 가려질 뿐 데이터로 유지되며, 타일이 다시 떠나면 겹겹이 쌓인 자국이 드러난다 — "썼다 지우고 다시 쓴" 층위. 이동·밀어내기·삭제가 모두 자국을 남기고, 삭제된 글은 마지막 모습의 텍스처를 자국으로 남긴다. Region reseed만이 잔상을 초기화한다.

---

## Runtime Layer

### 이벤트 수집

| 이벤트 | 발생 | runtime 가중치 | human 가중치 |
|---|---|---|---|
| `tile_click` | 필드에서 타일 선택(모달 열림) | +0.15 | +0.15 |
| `record_open` | 모달에서 기록 페이지로 진입 | +0.35 | +0.35 |
| `page_view` | 기록 페이지 조회 | +0.25 | — |

클라이언트가 anon key로 `record_archive_event` RPC를 호출한다. RPC는 **존재하는 slug만** 갱신하고(모르는 slug는 `ignored` 응답, 행 생성 없음) 개별 이벤트를 `archive_events`에 적재한다. 세션 식별은 `sessionStorage`의 무작위 id뿐, 재방문·사용자 추적은 하지 않는다. `machine_score`/`machine_access`는 Machine Attention(아래)이 갱신한다.

human 점수도 machine과 대칭으로 정본화된다: 낮의 가산은 잠정값이고, 밤의 sleep rebuild가 `recompute_human_scores()`로 `archive_events` 원본에서 **(session, record, event_type)당 1회**로 재계산한다 — 한 방문에서 같은 타일을 네 번 클릭해도 관심은 1회다(도입 전 실측: 방문 내 반복 가산이 전체 점수의 13.5%). 세션은 탭과 함께 소멸하는 임시 id라 행위자이자 시간 단위를 겸하므로, machine과 달리 일(day) 축이 필요 없다. 원시 카운터(views, tile_clicks 등)는 실측 누적 그대로 둔다.

### Machine Attention

Cloudflare Pages Functions 미들웨어([functions/_middleware.js](functions/_middleware.js))가 모든 요청의 User-Agent를 분류해 `record_machine_event` RPC로 기록한다. 기록은 `waitUntil` 비동기라 응답을 막지 않으며, 정적 자산 요청은 제외한다.

| category | 의미 | 예시 | score 가중치 |
|---|---|---|---|
| `search` | 검색 색인 (전통·AI 검색) | Googlebot, Bingbot, Yeti(네이버), OAI-SearchBot, PerplexityBot | 0 — 관측만 |
| `crawler` | 학습·수집 크롤러 | GPTBot, ClaudeBot, CCBot | 0 — 관측만 |
| `ai` | 사용자 질문에 의한 실시간 참조 | ChatGPT-User, Claude-User, Perplexity-User, Gemini-Deep-Research | +0.30 |
| `preview` | 링크 미리보기 언퍼러 (사람이 링크를 붙여넣음) | Twitterbot, kakaotalk-scrap, Slackbot, Discordbot | 0 — 관측만 |
| `unknown` | 봇 추정, 식별 불가 | 일반 봇 패턴 | 0 |

**점수는 두 종류의 증거만 받는다.** ① 직접 열람 — `ai` 카테고리, confidence 곱(Cloudflare가 발신 IP 대역으로 봇을 검증하면 1.0, UA 문자열만 일치하면 0.6), 200 응답만(리다이렉트 제외). ② **AI 레퍼럴 유입** — referrer나 `utm_source`가 AI 서비스(chatgpt.com, perplexity.ai, gemini.google.com 등)인 인간의 `page_view`. AI가 그 글을 인용했고 사람이 따라왔다는 이중 증거로, 경로 ②(색인 기반 응답)의 수요가 서버에서 관측 가능해지는 유일한 순간이다. (session, record)당 1회 +0.30, 정본화 시 `archive_events`의 관찰에서 유도되므로 소급 적용된다. 조작이 어렵다 — AI가 먼저 인용해야 하니까. search·crawler가 0인 이유: 색인·수집 크롤링은 작업이지 관심이 아니고, 벌크 크롤 한 번이 전체 레코드를 훑으므로 가중하면 진짜 열람 신호를 압도한다 (실측: Meta-ExternalAgent가 1분에 아카이브 전체를 완주). preview가 0인 이유: 미리보기 봇은 기계의 관심이 아니라 사람의 공유 행위의 기계적 메아리다 — machine이 아닌 human-adjacent 신호이므로, 외부 공유가 충분히 관측된 뒤 해석(점수화 여부와 방향)을 결정한다.

데이터는 세 층으로 나뉜다:

| 층 | 의미 | 갱신 |
|---|---|---|
| `machine_events` | 관찰 원본 — 모든 fetch 보존 (append-only) | 요청 즉시 |
| `machine_access` | 실측 fetch 횟수 | 요청 즉시 누적 |
| `machine_score` | AI attention **해석** — (agent, record, UTC일) 중복 제거, 그룹 최고 confidence × 0.30 | 낮에는 잠정 누적, **밤 sleep rebuild가 원본에서 재계산해 정본화** |

한 대화에서 같은 글을 4번 fetch하면 access는 +4, score는 +0.30 — "가져간 횟수"와 "독립적인 관심"을 분리해 보존한다. 가중치 정책이 바뀌어도 `recompute_machine_scores()`(service role 전용, PUBLIC EXECUTE revoke됨)가 관측에서 점수를 전면 재계산한다 — 누적 델타를 패치하지 않는다.

UA 목록에 없는 봇이라도 Cloudflare가 발신 IP 대역으로 봇임을 검증한 요청(`verifiedBotCategory`)은 unknown으로 기록된다 — 새로 등장한 AI fetcher가 분류기 갱신을 기다리지 않고 관측에 잡히는 안전망이다. 두 필터를 모두 통과하는 범용 HTTP 라이브러리 UA(python-httpx, curl 등 — 실측: 네이버 AI의 fetcher가 이 형태였다)는 Record 경로에 한해 도구 이름 그대로 unknown으로 관측한다. 도구는 운영자가 아니므로 점수화하지 않고, 운영자 귀속의 증거(`asOrganization`, `x-caller`)는 metadata에 남겨 해석은 분석 시점에 내린다.

**이 층은 성과 지표가 아니다.** 로그가 증명하는 것은 "이 URL에 HTTP 요청이 있었다"까지이고, AI가 직접 fetch하지 않고 색인·캐시·제3자 중간층으로 답하거나 **같은 콘텐츠의 다른 공개 표면(GitHub 저장소)을 읽는** 경로가 존재하므로 — 로그 없음은 미참조의 증거가 아니고, 로그 있음은 답변 사용의 증거가 아니다. `machine_score`는 AI 참조 전체가 아니라 **직접 fetch로 도달한 좁은 표본**(하한)이며 서비스 간 비교에 쓸 수 없다. 측정 범위와 대안적 평가 방법(출처 등장 테스트)은 [docs/MACHINE_ATTENTION_SEMANTICS.md](docs/MACHINE_ATTENTION_SEMANTICS.md)에 정리했다.

알려진 한계 둘: (1) 일반 브라우저 UA로 요청하는 agentic browsing은 식별할 수 없다 — 누락(undercount)이지 오분류가 아니므로 데이터 순도는 유지된다. (2) 색인 기반으로 답하는 AI는 요청 자체가 도달하지 않는다 — 관측 장치의 결함이 아니라 그 경로가 원래 로그에 안 남는 것이다.

### Attention → 텍스처 LOD

빌드 시 각 레코드의 `runtimeScore + machineScore`(인간 열람 + AI 대리 열람)를 `log1p(score) / max(log1p(전체))`로 rebuild-국소 정규화하고, 임계 0.38/0.72로 LOD를 고른다:

| LOD | 필드 해상도 | 톤 팔레트 | 인상 |
|---|---|---|---|
| 0 | 12×9 | `[2]` 단일 중간톤 | 흐릿하고 평평한 덩어리 |
| 1 | 24×18 | `[1, 3]` 연함/진함 | 또렷한 스트라이프 |
| 2 | 40×30 | `[1, 2, 3]` 전체 | 조밀하고 결이 풍부 |

관찰이 쌓일수록 타일이 선명해진다. 위치는 변하지 않는다.

### Attention → 타일 색상과 AI 마커

인간과 기계는 **분리된 시각 채널**로 렌더된다. 두 채널의 스케일이 호환 불가능하기 때문이다 — 인간 이벤트는 방문자마다 누적(실측 레코드당 2~25점)되고 기계 열람은 agent-일당 0.30이라, 비율 기반 hue는 실제 로그 시뮬레이션에서 전 레코드가 'human'으로 렌더됐다(기계 신호 영구 도달 불가). 희소 신호는 크기가 아니라 **존재**로 렌더한다:

| 채널 | 표현 | 조건 |
|---|---|---|
| 타일 색상(hue) | 인간 관심 존재 — 테라코타(읽힘) / 중립(안 읽힘) | `runtimeScore > 0` |
| **AI 마커** | 타일 우하단 올리브 점 — "AI가 읽었거나, 인용해서 사람을 보낸 기록" | `machineScore ≥ 0.3` (정본 AI-일 1회 또는 AI 레퍼럴 유입 1회; 미검증 UA 단독 매치 0.18은 미달) |

시각 채널 정리: **색상 = 인간이 읽는가**, **마커 = AI가 읽었는가**, **잉크 농도 = 의미 밀도**(semantic), **선명도 = 얼마나 읽히는가**(runtime LOD). "인간은 안 읽지만 AI가 참조하는 기록"은 중립색 타일에 올리브 점으로 나타난다.

---

## Texture Pipeline

본문 구조를 타일 질감으로 바꾼다 ([src/lib/archive/texturePipeline.mjs](src/lib/archive/texturePipeline.mjs)):

```
semantic blocks (문단 / !youtube)
  → layout graph  (64×48 셀 캔버스; mediaRail이면 이미지 레일 포함)
  → 래스터        (4단계 톤: 0 종이, 1..3 잉크 농도)
  → LOD 렌더      (coverage threshold 다운샘플 + morphology + 톤 팔레트 제한)
  → rle4 페이로드  (계약 schemaVersion 2, 검증 후 매니페스트 저장)
  → SVG           (수평 런 병합 rect, 톤→불투명도 [0, .35, .65, 1] × 역할 계수)
```

- **field** 렌더: LOD 정책 적용 (위 표)
- **modal** 렌더: 항상 64×48 소스 마스크 그대로 (미리보기는 최대 fidelity)
- 페이로드는 [textureRenderContract.mjs](src/lib/archive/textureRenderContract.mjs)의 런타임 assert를 통과해야 매니페스트에 실린다

---

## Archive Manifest

`public/archive-manifest.json` (schemaVersion 10) — 필드 렌더에 필요한 전부이자, 다음 rebuild가 읽는 공간 기억.

- `records[]`: 메타데이터, `score`, `position`, `layoutSlot`, `regionId`, `related`/`relationSummary`, attention 스냅샷(rebuild 시점 동결값), 텍스처 렌더 페이로드, `contentHash`, 임베딩 참조(값 아님)
- `archiveView.field`: 40×25 격자, Region(seed/footprint/stats), 레코드 슬롯, ghost traces(영구 누적 — 각 자국은 자기 텍스처 스냅샷을 갖는다)
- `embeddingProjection`: 영속된 투영 축 상태
- `rebuild`: id, 모드, 변경 레코드 수

**이전 매니페스트 해석 순서**: `ARCHIVE_PREVIOUS_MANIFEST_URL` → (GitHub Actions에서는) 배포본 `https://ydnil-poh.pages.dev/archive-manifest.json` → 로컬 파일. CI가 배포본에서 이어가므로 공간 기억은 배포를 넘어 지속되고, repo에 커밋된 매니페스트는 로컬 dev/테스트용 fixture다.

`public/archive-layout-debug.json`에는 레코드별 semantic block/layout graph와 이번 rebuild의 레이아웃 이벤트가 담긴다.

---

## Supabase

스키마: [supabase/archive-schema.sql](supabase/archive-schema.sql) (idempotent, SQL Editor에서 직접 적용)

| 테이블 | 역할 |
|---|---|
| `archive_records` | 레코드 메타 + 누적 attention 점수 (live source of truth); 삭제된 글은 `removed_at` tombstone |
| `archive_events` | 개별 이벤트 로그 (append-only) |
| `machine_events` | 기계 활동 관측 로그 (append-only, 원본 UA 포함) |
| `archive_embeddings` | 임베딩 벡터 `vector(64)` + content hash |
| `archive_relations` | 레코드 쌍 relation (cosine distance, weight) |
| `archive_rebuilds` | rebuild 실행 기록 |
| `archive_record_snapshots` | rebuild별 레코드 상태 스냅샷 |
| `archive_region_snapshots` | rebuild별 Region 상태(seed/footprint/density) 스냅샷 |
| `archive_layout_events` | rebuild별 레이아웃 이벤트 |

- RLS: `archive_records`·`archive_relations` 공개 읽기, `archive_events` 공개 insert. `machine_events`는 security definer RPC(`record_machine_event`)로만 쓰고 service role로만 읽는다. 나머지는 service role 전용
- 히스토리 레이어 원칙: **관찰을 저장하고 해석을 저장하지 않는다.** growth role, 색, 중심성 같은 해석값은 저장하지 않고 나중에 관찰로부터 유도한다

---

## 빌드와 배포

[.github/workflows/deploy.yml](.github/workflows/deploy.yml):

| 트리거 | 모드 | 역할 |
|---|---|---|
| `main` push / dispatch | `general` | **콘텐츠 반영** — 신규 배치·삽입 밀어내기·비상 확장. 위치는 콘텐츠가 바꾼다 |
| cron `10 18 * * *` (03:10 KST) | `sleep` (`ARCHIVE_REBUILD_MODE=sleep`) | **관찰 반영 + 정비** — attention score 정본화(human·machine 양 채널 중복 제거 재계산) 후 하루치 attention을 LOD에 반영, footprint 확장/축소, 삭제 tombstone. 선명도는 밤이 바꾼다 |

수동 플래그: `--region-reseed`/`ARCHIVE_REGION_RESEED=1`(전체 Region 재배치 — 공간 기억·잔상 리셋, 일회성 마이그레이션용), `--recalculate-projection`(투영 축 재산출).

배포는 `wrangler pages deploy`로 Cloudflare Pages(`ydnil-poh.pages.dev`)에 올리며, `functions/`의 Machine Attention 미들웨어가 함께 배포된다. 미들웨어 런타임 환경변수(`SUPABASE_URL`, `SUPABASE_ANON_KEY`)는 Pages 프로젝트 설정에 있다.

빌드 후 Supabase 동기화: records/embeddings/relations upsert + rebuild·레코드/Region 스냅샷·레이아웃 이벤트 기록. sleep 빌드는 추가로 repo에서 사라진 레코드를 tombstone 처리한다(`removed_at` 마킹, 관련 relation 행 삭제; 히스토리·이벤트는 보존). 같은 slug가 돌아오면 upsert가 tombstone을 해제한다.

---

## 진단

```bash
node scripts/analyze-embedding.mjs [--seed N]
```

임베딩 품질 리포트: 차원 사용률/분산, 벡터 충돌, cosine 유사도 분포와 최유사 쌍, 투영 축 부트스트랩 안정성. 빌드 파이프라인과 동일한 해싱 로직을 미러링해 읽기 전용으로 동작한다.
