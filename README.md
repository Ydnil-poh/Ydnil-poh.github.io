# Archive Field

개인 기록을 보관하는 아카이브이자, 기록 사이의 의미적 관계를 탐색하는 필드(Field).

이 프로젝트는 전통적인 블로그처럼 최신 글을 시간순으로 나열하지 않는다. 대신 각 기록을 하나의 유닛(unit)으로 취급하고, 기록 사이의 의미적 유사성을 기반으로 공간 위에 배치한다.

사용자는 필드를 탐색하며 기록의 밀집도, 위치, 질감을 통해 관심 있는 영역을 발견한다.

---

# 핵심 철학

## 기록은 콘텐츠가 아니라 지형이다

대부분의 블로그는 글 목록을 보여준다.

Archive Field는 글 목록 대신 지형을 보여준다.

사용자는 제목을 읽고 선택하기보다 먼저 지형을 관찰하고, 이후 관심이 가는 기록을 탐색한다.

---

## 인기도보다 의미를 우선한다

조회수나 클릭 수는 참고 신호일 뿐이다.

기록의 위치와 관계는 기본적으로 의미적 유사성(Semantic Similarity)에 의해 결정된다.

Human Attention이나 Machine Attention은 지형을 아주 천천히 변화시키는 약한 신호로만 사용한다.

---

## 공간 기억을 보존한다

필드는 매일 재계산될 수 있지만, 사용자가 익숙해진 공간 기억은 유지되어야 한다.

같은 기록은 시간이 지나도 대체로 비슷한 위치에 존재해야 하며, 변화는 서서히 발생한다.

---

# 사용자 탐색 흐름

현재 목표 탐색 흐름은 다음과 같다.

```text
Field
 ↓
Tile 선택
 ↓
Modal Open
 ↓
본문 질감 확인
 ↓
닫기 또는 Full Open
 ↓
Record Page
```

---

# Human Attention Layer

사람이 실제로 어떤 기록에 관심을 보였는지 측정한다.

현재 계획된 이벤트는 다음과 같다.

| 이벤트 | 설명 |
|----------|----------|
| modal_open | 필드에서 타일을 선택해 미리보기 모달을 연 경우 |
| full_open | 모달 또는 타일에서 실제 기록 페이지로 진입한 경우 |

재방문 사용자 추적을 하지 않는다.

로그인 기반 사용자 식별도 도입하지 않는다.

이 프로젝트는 방문자 개개인을 추적하는 것이 목적이 아니라, 기록 자체에 대한 관심의 흐름을 관찰하는 것이 목적이다.

---

# Machine Attention Layer

AI 에이전트와 검색 엔진이 어떤 기록에 관심을 보이는지 측정한다.

향후 도입 예정인 계층이다.

예상 데이터 소스:

- OpenAI crawler
- Google Gemini crawler
- Anthropic crawler
- Perplexity crawler
- Google Search crawler
- Bing crawler
- 기타 AI User-Agent

Machine Attention은 인간 활동과 분리하여 저장한다.

예시:

```text
human_score
machine_score
```

이를 통해 다음과 같은 해석이 가능하다.

- 인간은 많이 읽지 않지만 AI는 자주 참조하는 기록
- 인간과 AI 모두 자주 접근하는 기록
- 둘 다 거의 접근하지 않는 기록

---

# Semantic Layer

Archive Field의 핵심 계층이다.

모든 기록은 임베딩(Embedding)으로 변환된다.

임베딩은 텍스트의 의미를 수치 벡터로 표현한 값이다.

예:

```text
"블로그"
→ [0.13, -0.42, 0.88, ...]
```

```text
"개인 기록"
→ [0.12, -0.39, 0.84, ...]
```

의미가 가까운 문장은 벡터 공간에서도 가깝게 위치한다.

---

# Embedding Model

현재 채택 방향:

```text
Google Gemini Embedding
```

생성 위치:

```text
Semantic Rebuild Workflow
```

사용 API:

```text
Gemini Embedding API
```

임베딩 모델은 향후 교체 가능하다.

필드는 특정 AI 모델에 종속되지 않는다.

---

# archive_embeddings

이 테이블은 실제 임베딩 벡터를 저장한다.

예:

```text
record_slug
embedding
model
content_hash
updated_at
```

예시:

```json
{
  "record_slug": "post1",
  "embedding": [0.12, -0.31, ...],
  "model": "gemini-embedding",
  "content_hash": "abc123"
}
```

중요한 점:

archive-manifest.json에는 임베딩 원본을 저장하지 않는다.

임베딩은 데이터베이스에만 존재한다.

manifest는 위치(Position)와 요약 정보만 보관한다.

---

# archive_relations

기록 간 의미적 관계를 저장한다.

예:

```text
post1 ↔ post7
weight 0.82
```

```text
post1 ↔ post3
weight 0.64
```

필드는 이 관계를 이용해 주변 기록과 의미적 밀도를 구성한다.

---

# archive_records

기록의 핵심 메타데이터를 저장한다.

예:

```text
slug
title
score
position
human_score
machine_score
updated_at
```

이 테이블은 필드 렌더링에 필요한 최소 정보만 가진다.

---

# Semantic Score

Semantic Score는 조회수 점수가 아니다.

현재는 다음 요소를 기반으로 계산된다.

- 기록 간 의미적 유사도
- 관계 밀도(Relation Density)
- 기록 내 키워드 재출현성(Recurrence)

향후에는 다음 요소가 추가될 수 있다.

- 네트워크 중심성
- 클러스터 구조
- 장기적 Attention 신호

즉,

```text
Semantic Score
≠ 인기 점수
```

이다.

---

# Nightly Semantic Rebuild

목표 구조:

매일 자동 실행되는 Semantic Rebuild Workflow.

현재는 build 과정에서 수행되고 있으며,
향후 Site Build와 분리할 예정이다.

역할:

1. 신규 기록 임베딩 생성
2. 관계 재계산
3. Semantic Score 계산
4. Position 계산
5. Cluster 계산
6. Archive Manifest 생성

출력:

```text
archive_embeddings
archive_relations
archive_records
archive-manifest.json
```

---

# Site Build

일반적인 사이트 빌드.

역할:

- Astro Build
- 정적 페이지 생성
- 배포

Site Build는 Semantic 계산을 수행하지 않는다.

Semantic 계산은 Nightly Semantic Rebuild가 담당한다.

---

# 지형 변화 원칙

Archive Field는 인기글 순위를 만드는 시스템이 아니다.

Human Attention과 Machine Attention은 지형을 아주 천천히 움직이는 약한 힘으로만 작동한다.

기록의 본질적인 위치는 의미적 관계가 결정한다.

즉,

```text
Semantic Gravity
>
Human Attention
>
Machine Attention
```

순서로 영향력을 가진다.
