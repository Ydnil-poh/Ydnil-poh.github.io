# Ydnil Strolls

## 콘텐츠 등록 규칙

- 포스트는 `src/content/posts/*.md`만 자동 수집됩니다.
- 현재 저장소 기본 포스트는 `src/content/posts/post1.md` 1개만 유지됩니다.
- 필수 frontmatter: `title`, `date`, `location`, `excerpt`.

## Supabase 설정 (필수)

### 1) 프로젝트 생성
1. https://supabase.com 에서 프로젝트 생성
2. 프로젝트 대시보드에서 **Project URL**과 **anon public key** 확인

### 2) 테이블 생성
SQL Editor에서 아래 실행:

```sql
create table if not exists public.posts (
  id text primary key,
  views integer not null default 0,
  trackbacks integer not null default 0
);
```

`id` 값은 마크다운 파일명(slug)과 동일해야 합니다.  
예: `src/content/posts/post1.md` → `id = 'post1'`

### 3) 조회/업데이트 정책(RLS)

```sql
alter table public.posts enable row level security;

create policy "public read posts"
on public.posts
for select
using (true);

create policy "public update views"
on public.posts
for update
using (true)
with check (true);
```

### 4) 조회수 증가 RPC 함수 생성

```sql
create or replace function public.increment_post_view(post_id text)
returns void
language plpgsql
security definer
as $$
begin
  insert into public.posts (id, views, trackbacks)
  values (post_id, 1, 0)
  on conflict (id)
  do update set views = public.posts.views + 1;
end;
$$;
```

## 코드에 키 입력 위치/방법

이 프로젝트는 **클라이언트에서 `import.meta.env.PUBLIC_*`** 값을 읽습니다. (`src/pages/index.astro`)

### 로컬 개발
프로젝트 루트에 `.env` 파일 생성:

```bash
PUBLIC_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
PUBLIC_SUPABASE_ANON_KEY=YOUR_SUPABASE_ANON_KEY
```

### GitHub Pages 배포 (GitHub Actions)
1. GitHub 저장소 → **Settings → Secrets and variables → Actions**
2. Repository secrets 추가
   - `PUBLIC_SUPABASE_URL`
   - `PUBLIC_SUPABASE_ANON_KEY`
3. 워크플로우에서 빌드 step에 env 주입(아래 예시):

```yaml
- name: Build with Astro
  run: npm run build
  env:
    PUBLIC_SUPABASE_URL: ${{ secrets.PUBLIC_SUPABASE_URL }}
    PUBLIC_SUPABASE_ANON_KEY: ${{ secrets.PUBLIC_SUPABASE_ANON_KEY }}
```

## 실행

```bash
npm install
npm run dev
npm run build
```
