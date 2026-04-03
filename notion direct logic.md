```txt
너는 시니어 TypeScript 백엔드 엔지니어다. 설명 위주로 끝내지 말고, 반드시 실행 가능한 파일 단위 코드까지 완성해서 출력해라. Mock, TODO, pseudo code를 금지한다.






전제는 **Node.js + TypeScript + Express(or Nest-compatible service layer) + PostgreSQL + Prisma + `@notionhq/client`** 기준이며, **기존 `encryption-service`를 반드시 재사용**하는 설계다.  
핵심 원칙은 **OAuth 공개 통합**, **토큰 암호화 저장**, **Markdown-first Notion write**, **DB 기반 경량 큐**, **SDK 기본 retry + 앱 레벨 rate control**이다. Notion은 공개 OAuth에서 `access_token`, `refresh_token`, `bot_id` 등 메타데이터 저장을 권장하고, rate limit은 통합당 평균 초당 3req 수준이며 429 시 `Retry-After`를 따라야 한다. 공식 JS SDK는 429/일부 서버 오류에 대한 자동 재시도와 timeout 설정도 제공한다. [Notion Docs](https://developers.notion.com/docs/authorization) [Notion Docs](https://developers.notion.com/reference/request-limits) [Notion SDK JS](https://github.com/makenotion/notion-sdk-js)

---

# 🚀 GLM 5.1 입력용: VOXERA Notion Direct-Write 백엔드 구현 지시서

## 1) 목표

VOXERA의 기존 Mock Notion writer를 제거하고, 실제로 사용자의 Notion 워크스페이스에 페이지/데이터소스 항목을 생성하는 MVP 백엔드를 구현하라.

이번 구현의 목표는 “완전한 범용 Notion CMS”가 아니라, **1일 내 안정적으로 런칭 가능한 최소 기능**이다.

반드시 다음 원칙을 따른다:

1. **공개형 Notion OAuth 2.0**을 사용한다.
2. `access_token`, `refresh_token` 등 민감 정보는 **기존 `encryption-service`로 암호화**하여 DB 저장한다.
3. Notion API 호출은 **`@notionhq/client`**를 사용한다.
4. 본문 쓰기는 **Markdown-first**로 구현한다.
5. 페이지 생성/수정은 **즉시 API 호출하지 않고 DB Job Queue로 비동기 처리**한다.
6. Notion rate limit 대응은 **SDK 기본 retry + 애플리케이션 레벨 큐/스로틀링**으로 구현한다.
7. 실패 시 **재시도 가능 오류**와 **즉시 실패 오류**를 명확히 분리한다.
8. 구현 결과는 **실제 실행 가능한 코드 구조**로 작성한다.

Notion의 페이지 생성 API는 `children`뿐 아니라 `markdown` 입력을 지원하며, 부모는 page 또는 data source로 지정할 수 있다. 또한 page 생성 시 템플릿 적용도 가능하나, 이번 MVP에서는 템플릿은 선택적 기능으로 둔다. [Notion Docs](https://developers.notion.com/reference/post-page)

---

## 2) 기술 스택 고정

아래 스택으로 구현하라. 다른 대안을 제안하지 말고 이 기준으로 코드 작성하라.

- Runtime: Node.js 20+
- Language: TypeScript
- HTTP Server: Express
- ORM: Prisma
- DB: PostgreSQL
- Queue: 별도 Redis/BullMQ 사용 금지, **PostgreSQL jobs 테이블 기반 경량 큐**
- Notion Client: `@notionhq/client`
- Validation: Zod
- Logging: pino
- UUID: `crypto.randomUUID()` 또는 `uuid`
- Crypto: 기존 `encryption-service` 사용
- Env loading: `dotenv`

Redis를 붙이는 것은 하루 MVP 기준 과하다. PostgreSQL jobs 테이블과 polling worker로 충분하다. 큐는 **안정성 > 화려함** 기준으로 설계하라.

---

## 3) 구현해야 할 최종 디렉터리 구조

```txt
src/
  app.ts
  server.ts

  config/
    env.ts

  routes/
    notion-auth.routes.ts
    notion-write.routes.ts

  controllers/
    notion-auth.controller.ts
    notion-write.controller.ts

  services/
    encryption.service.ts        // 기존 서비스 import 가정
    notion-oauth.service.ts
    notion-token.service.ts
    notion-client.factory.ts
    notion-markdown.service.ts
    notion-write.service.ts
    notion-error-policy.service.ts
    queue.service.ts
    idempotency.service.ts

  workers/
    notion-write.worker.ts

  repositories/
    notion-integration.repository.ts
    notion-job.repository.ts

  lib/
    logger.ts
    sleep.ts
    backoff.ts
    state-token.ts

  schemas/
    notion-auth.schema.ts
    notion-write.schema.ts

  types/
    notion.ts
    queue.ts

prisma/
  schema.prisma
```

---

## 4) 환경변수 명세

```env
APP_BASE_URL=https://api.voxera.app
NOTION_CLIENT_ID=xxx
NOTION_CLIENT_SECRET=xxx
NOTION_REDIRECT_URI=https://api.voxera.app/auth/notion/callback
NOTION_API_VERSION=2026-03-11

DATABASE_URL=postgresql://...

QUEUE_POLL_INTERVAL_MS=1500
QUEUE_BATCH_SIZE=5
NOTION_GLOBAL_RPS=2
NOTION_JOB_MAX_ATTEMPTS=8

ENCRYPTION_KEY=...
```

주의:
- `NOTION_CLIENT_SECRET`는 절대 로그에 노출하지 않는다.
- `NOTION_API_VERSION` 헤더를 반드시 매 요청에 넣는다. Notion은 버전 헤더 누락 시 오류를 반환한다. [Notion Docs](https://developers.notion.com/reference/status-codes)

---

## 5) DB 스키마 설계

### 5-1. Notion Integration 테이블

공개 OAuth 통합에서는 토큰뿐 아니라 `bot_id`, `workspace_id`, `workspace_name`, owner 정보 등도 함께 저장해야 한다. [Notion Docs](https://developers.notion.com/docs/authorization)

Prisma schema:

```prisma
model NotionIntegration {
  id                    String   @id @default(uuid())
  userId                String
  botId                 String   @unique
  workspaceId           String?
  workspaceName         String?
  workspaceIcon         String?
  ownerType             String?
  ownerUserId           String?
  duplicatedTemplateId  String?

  accessTokenEnc        String
  refreshTokenEnc       String

  scopeJson             Json?
  rawAuthPayloadJson    Json?

  connectedAt           DateTime @default(now())
  lastRefreshedAt       DateTime?
  revokedAt             DateTime?
  createdAt             DateTime @default(now())
  updatedAt             DateTime @updatedAt

  @@index([userId])
  @@index([workspaceId])
}
```

### 5-2. OAuth State 테이블

CSRF 방지용 state를 저장한다. state는 단회성, TTL 10분.

```prisma
model OAuthState {
  id          String   @id @default(uuid())
  userId      String
  provider    String
  state       String   @unique
  redirectUri String?
  expiresAt   DateTime
  usedAt      DateTime?
  createdAt   DateTime @default(now())

  @@index([userId, provider])
  @@index([expiresAt])
}
```

### 5-3. Notion Write Job 테이블

```prisma
model NotionWriteJob {
  id                    String   @id @default(uuid())
  userId                String
  notionIntegrationId   String
  targetType            String   // "page" | "data_source"
  targetId              String
  title                 String?
  bodyMarkdown          String?
  bodyJson              Json?
  templateMode          String?  // "none" | "default" | "template_id"
  templateId            String?
  intent                String?
  idempotencyKey        String   @unique

  status                String   // "queued" | "processing" | "retrying" | "succeeded" | "failed"
  attemptCount          Int      @default(0)
  maxAttempts           Int      @default(8)
  nextRunAt             DateTime @default(now())
  lockedAt              DateTime?
  lockOwner             String?
  lastErrorCode         String?
  lastErrorMessage      String?
  lastResponseJson      Json?

  resultPageId          String?
  resultPageUrl         String?

  createdAt             DateTime @default(now())
  updatedAt             DateTime @updatedAt

  @@index([status, nextRunAt])
  @@index([notionIntegrationId])
  @@index([userId])
}
```

### 5-4. 선택: 실행 로그 테이블

운영 편의용. MVP에서 있으면 좋다.

```prisma
model NotionWriteAttemptLog {
  id          String   @id @default(uuid())
  jobId       String
  attempt     Int
  phase       String   // "create_page" | "append_blocks" | "refresh_token"
  status      String   // "ok" | "error"
  errorCode   String?
  message     String?
  metaJson    Json?
  createdAt   DateTime @default(now())

  @@index([jobId])
}
```

---

## 6) OAuth 플로우 구현

## 6-1. 시작 엔드포인트

`GET /auth/notion/start`

역할:
- 로그인된 사용자 기준으로 state 생성
- OAuth authorize URL 생성
- 프론트에 redirect URL 반환

응답 예시:

```json
{
  "authorizeUrl": "https://api.notion.com/v1/oauth/authorize?...",
  "state": "opaque-random"
}
```

구현 규칙:
- `state`는 32바이트 이상 랜덤값
- DB 저장
- TTL 10분
- provider=`notion`
- authorize URL에는 `client_id`, `redirect_uri`, `response_type=code`, `owner=user`, `state` 포함

## 6-2. 콜백 엔드포인트

`GET /auth/notion/callback?code=...&state=...`

역할:
1. state 조회
2. 만료/사용 여부 검증
3. code를 Notion token endpoint로 교환
4. 응답의 `access_token`, `refresh_token`, `bot_id`, `workspace_id`, `workspace_name`, `owner` 메타데이터 저장
5. 토큰은 반드시 `encryption-service.encrypt()` 후 저장
6. state를 used 처리
7. 프론트 앱으로 리다이렉트 또는 성공 HTML 반환

Notion 공개 OAuth는 code 교환 후 access token과 refresh token, bot_id 등 메타데이터를 반환한다. 저장 시 bot_id를 주요 식별자로 쓰는 것이 권장된다. [Notion Docs](https://developers.notion.com/docs/authorization)

### 6-3. 콜백 구현 상세 규칙

- state 불일치/만료/재사용이면 `400`
- token exchange는 HTTP Basic Auth(`client_id:client_secret`)
- 기존 같은 `bot_id`가 있으면 upsert
- `rawAuthPayloadJson`에는 민감정보를 제외한 원본 응답 일부만 저장하거나, 전체 저장이 필요하면 토큰 필드 제거 후 저장
- `accessTokenEnc`, `refreshTokenEnc`는 절대 로그에 남기지 않는다
- 성공 후 프론트로 리다이렉트:
  - `https://app.voxera.app/integrations/notion/success`
  - 실패 시 `.../error?code=...`

### 6-4. 콜백 컨트롤러 예시 코드

```ts
export async function notionCallbackController(req: Request, res: Response) {
  const { code, state } = notionCallbackQuerySchema.parse(req.query);

  const oauthState = await oauthStateRepo.findValidUnusedState("notion", state);
  if (!oauthState) {
    return res.status(400).json({ error: "invalid_or_expired_state" });
  }

  const tokenPayload = await notionOAuthService.exchangeCodeForToken(code);

  await notionTokenService.upsertIntegration({
    userId: oauthState.userId,
    tokenPayload
  });

  await oauthStateRepo.markUsed(oauthState.id);

  return res.redirect(`${env.FRONTEND_BASE_URL}/integrations/notion/success`);
}
```

---

## 7) 토큰 저장 및 갱신 정책

### 7-1. 저장 규칙

`NotionTokenService.upsertIntegration()`에서 다음을 수행:

- `access_token` → `encrypt()`
- `refresh_token` → `encrypt()`
- `bot_id` 기준 upsert
- `workspace_id`, `workspace_name`, `owner.type`, `owner.user.id` 저장
- `revokedAt`는 정상 연결이면 null 유지

### 7-2. 토큰 복호화 사용 규칙

Notion API 호출 직전에만 복호화한다.

```ts
const accessToken = encryptionService.decrypt(row.accessTokenEnc);
```

복호화된 토큰은:
- 함수 스코프 밖에 보관 금지
- 로그 금지
- 예외 객체에 포함 금지

### 7-3. refresh token 사용

401 혹은 `unauthorized`, `invalid_grant` 성격의 토큰 문제 발생 시:
- refresh 가능하면 refresh 시도
- refresh 성공 시 DB 갱신 후 1회 재실행
- refresh 실패 시 integration을 `revokedAt=now()` 처리
- job은 영구 실패 처리하고 사용자에게 재연결 요구

`invalid_grant`는 OAuth code 또는 refresh token 자체 문제를 의미할 수 있으므로 무한 재시도 금지. [Notion Docs](https://developers.notion.com/reference/status-codes)

---

## 8) Notion 클라이언트 팩토리

### 요구사항

- `@notionhq/client` 사용
- auth는 복호화된 access token
- Notion-Version 헤더 고정
- SDK retry는 활성화
- timeout 설정
- 커스텀 logger hook 있으면 연결

예시:

```ts
import { Client } from "@notionhq/client";

export function createNotionClient(accessToken: string) {
  return new Client({
    auth: accessToken,
    notionVersion: process.env.NOTION_API_VERSION || "2026-03-11",
    timeoutMs: 60_000,
    retry: {
      maxRetries: 2,
      initialRetryDelayMs: 800,
      maxRetryDelayMs: 15_000
    }
  });
}
```

공식 SDK는 429 및 일부 transient server error에 대해 자동 재시도와 exponential backoff를 제공한다. [Notion SDK JS](https://github.com/makenotion/notion-sdk-js)

---

## 9) Write API 설계

## 9-1. 엔드포인트

`POST /v1/notion/write`

역할:
- Gemini strict JSON 결과를 받아 검증
- Markdown으로 변환
- idempotency key 생성
- DB job enqueue
- 즉시 `202 Accepted` 반환

### 요청 Body 스키마

```json
{
  "userId": "usr_123",
  "notionIntegrationId": "nti_123",
  "destination": {
    "type": "page",
    "id": "parent_page_id"
  },
  "content": {
    "intent": "meeting_note",
    "title": "2026-04-02 데일리 스탠드업",
    "body": "오늘 논의 내용...",
    "sections": [
      {
        "type": "heading",
        "text": "결정사항"
      },
      {
        "type": "bullet_list",
        "items": ["로그인 버그 수정", "배포 일정 확정"]
      }
    ]
  },
  "template": {
    "mode": "none"
  }
}
```

### Zod 검증 후 내부 표준 모델

```ts
type VoiceExecutionPayload = {
  userId: string;
  notionIntegrationId: string;
  destination: {
    type: "page" | "data_source";
    id: string;
  };
  content: {
    intent?: string;
    title?: string;
    body?: string;
    sections?: Array<
      | { type: "heading"; text: string; level?: 1 | 2 | 3 }
      | { type: "paragraph"; text: string }
      | { type: "bullet_list"; items: string[] }
      | { type: "todo_list"; items: Array<{ text: string; checked?: boolean }> }
      | { type: "quote"; text: string }
    >;
  };
  template?: {
    mode: "none" | "default" | "template_id";
    templateId?: string;
  };
};
```

### 응답 예시

```json
{
  "jobId": "job_123",
  "status": "queued"
}
```

---

## 10) Markdown 변환기 설계

MVP에서는 **범용 JSON→Block Mapper를 만들지 말고**, 먼저 **JSON→Markdown 변환기**를 구현하라.  
그 후 Notion page create 시 `markdown` 필드로 전달한다. 이는 블록 매퍼보다 훨씬 빠르고 안정적이다. 최신 page 생성 문서에는 `markdown` 입력이 명시되어 있다. [Notion Docs](https://developers.notion.com/reference/post-page)

## 10-1. 변환 규칙

입력 JSON을 아래 우선순위로 Markdown 문자열로 변환:

1. `title`은 페이지 title property로 별도 처리
2. `body`가 있으면 첫 paragraph로 사용
3. `sections`를 순회하여 Markdown 생성
4. 지원 타입:
   - heading → `#`, `##`, `###`
   - paragraph → plain text
   - bullet_list → `- item`
   - todo_list → `- [ ] item`, `- [x] item`
   - quote → `> text`

### 예시 변환

입력:

```json
{
  "title": "주간 운영 회의",
  "body": "이번 주 핵심 이슈를 정리합니다.",
  "sections": [
    { "type": "heading", "text": "결정사항", "level": 2 },
    { "type": "bullet_list", "items": ["A안 채택", "배포는 금요일"] },
    { "type": "heading", "text": "액션 아이템", "level": 2 },
    {
      "type": "todo_list",
      "items": [
        { "text": "배너 문구 수정", "checked": false },
        { "text": "QA 완료", "checked": true }
      ]
    }
  ]
}
```

출력:

```md
이번 주 핵심 이슈를 정리합니다.

## 결정사항
- A안 채택
- 배포는 금요일

## 액션 아이템
- [ ] 배너 문구 수정
- [x] QA 완료
```

## 10-2. 길이 보호 정책

- Markdown 전체가 너무 길어도 우선 그대로 보낸다
- Notion validation error 발생 시 fallback으로 block append 모드 사용
- fallback block append 시:
  - 문단은 1800자 단위로 chunk
  - 요청당 children 50개 이하
  - 여러 요청으로 나눠 append

Notion은 rich text와 children 수, payload 크기에 제한이 있으므로 chunking 정책이 필요하다. [Notion Docs](https://developers.notion.com/reference/request-limits)

### Markdown 서비스 예시 코드

```ts
export class NotionMarkdownService {
  toMarkdown(content: VoiceExecutionPayload["content"]): string {
    const parts: string[] = [];

    if (content.body?.trim()) {
      parts.push(content.body.trim());
    }

    for (const section of content.sections ?? []) {
      if (section.type === "heading") {
        const level = section.level ?? 2;
        const prefix = level === 1 ? "#" : level === 2 ? "##" : "###";
        parts.push(`${prefix} ${section.text}`);
      }

      if (section.type === "paragraph") {
        parts.push(section.text);
      }

      if (section.type === "bullet_list") {
        parts.push(...section.items.map((x) => `- ${x}`));
      }

      if (section.type === "todo_list") {
        parts.push(
          ...section.items.map((x) => `- [${x.checked ? "x" : " "}] ${x.text}`)
        );
      }

      if (section.type === "quote") {
        parts.push(`> ${section.text}`);
      }

      parts.push("");
    }

    return parts.join("\n").trim();
  }
}
```

---

## 11) Notion 쓰기 서비스 설계

## 11-1. 기본 동작

Worker가 job을 집으면 다음 순서로 처리:

1. integration 조회
2. access token 복호화
3. Notion client 생성
4. `destination.type`에 따라 page 생성
5. 생성 성공 시 `resultPageId`, `resultPageUrl` 저장
6. 성공 상태로 종료

## 11-2. 생성 규칙

### A. destination.type = `page`

부모 page 아래 새 child page 생성:

```ts
await notion.pages.create({
  parent: { page_id: targetId },
  properties: {
    title: {
      title: [{ text: { content: safeTitle } }]
    }
  },
  markdown: markdownBody
});
```

문서상 parent가 page인 경우 유효 property는 title 중심으로 제한된다. [Notion Docs](https://developers.notion.com/reference/post-page)

### B. destination.type = `data_source`

부모 data source 아래 새 row/page 생성:

```ts
await notion.pages.create({
  parent: { data_source: targetId },
  properties: {
    Name: {
      title: [{ text: { content: safeTitle } }]
    }
  },
  markdown: markdownBody
});
```

주의:
- 실제 data source의 title property 이름이 `Name`이 아닐 수 있으므로,
- MVP에서는 설정 화면에서 **targetId와 titlePropertyName을 함께 저장**하거나,
- 첫 호출 시 data source schema 조회 후 title 타입 property를 찾아 사용하라.

부모가 data source일 경우 properties key는 그 데이터소스 속성과 맞아야 한다. [Notion Docs](https://developers.notion.com/reference/post-page)

## 11-3. 템플릿 모드

MVP 구현:
- `template.mode === "none"`만 우선 지원
- `default`, `template_id`는 DTO에 남겨두되, 1차 구현에서는 기능 플래그 behind 처리
- 나중에 쉽게 확장 가능하도록 service 인터페이스만 남겨라

---

## 12) Fallback: 최소 블록 Append Writer

Markdown create가 validation error로 실패할 경우에만 fallback 실행.

지원 블록 타입:
- paragraph
- heading_1
- heading_2
- heading_3
- bulleted_list_item
- to_do
- quote

절대 구현하지 말 것:
- table
- column_list
- synced_block
- file/media upload
- toggle nesting
- complex rich annotations

이유:
- 하루 MVP에서 위험하다
- block 제약이 많다
- append children은 한 번에 100개 제한이 있다. [Notion Docs](https://developers.notion.com/reference/patch-block-children)

### fallback 알고리즘

1. page를 제목만으로 먼저 생성
2. markdown을 단순 라인 파싱하여 최소 block 배열로 변환
3. block을 50개 단위로 잘라 append
4. 각 paragraph는 1800자 이하 chunk
5. 각 chunk 전송 후 짧은 sleep(150~300ms jitter)

---

## 13) 큐 설계

## 13-1. enqueue

`POST /v1/notion/write`에서 job insert:

- `status = queued`
- `attemptCount = 0`
- `nextRunAt = now()`
- `maxAttempts = env.NOTION_JOB_MAX_ATTEMPTS`
- `idempotencyKey` 생성

## 13-2. idempotency 규칙

중복 생성 방지용으로 아래 조합을 SHA-256:

```txt
userId + notionIntegrationId + destination.type + destination.id + normalizedTitle + normalizedMarkdown
```

동일 idempotencyKey가 이미 성공한 job이면:
- 새로 생성하지 않고 기존 `jobId`, `resultPageId`, `resultPageUrl` 반환 가능

동일 key가 queued/processing/retrying이면:
- 기존 job 반환

## 13-3. worker polling

워커는 1.5초마다 다음 쿼리:

- `status in ('queued','retrying')`
- `nextRunAt <= now()`
- `lockedAt is null or lockedAt < now() - interval '5 min'`
- `limit = QUEUE_BATCH_SIZE`

가져온 row를 트랜잭션으로 lock:

- `status = processing`
- `lockedAt = now()`
- `lockOwner = hostname:pid:uuid`

## 13-4. 글로벌 rate control

Notion은 integration 기준 평균 3rps 제한을 문서화한다. MVP는 보수적으로 **2rps**로 제한하라. [Notion Docs](https://developers.notion.com/reference/request-limits)

구현 방식:
- worker process 내부에 간단한 token bucket 또는 간격 제한 사용
- 최소 요청 간격 = `500ms`
- append chunk도 동일 제한을 따름

예시:

```ts
class SimpleRateLimiter {
  private lastRun = 0;
  constructor(private minIntervalMs: number) {}

  async waitTurn() {
    const now = Date.now();
    const diff = now - this.lastRun;
    if (diff < this.minIntervalMs) {
      await sleep(this.minIntervalMs - diff);
    }
    this.lastRun = Date.now();
  }
}
```

---

## 14) 실패 재시도 정책

## 14-1. 분류 원칙

### 즉시 재시도 가능
- 429 `rate_limited`
- 409 `conflict_error`
- 500 `internal_server_error`
- 502 `bad_gateway`
- 503 `service_unavailable`
- 504 `gateway_timeout`

### 조건부 재시도
- 401 `unauthorized`
  - refresh token 갱신 성공 시 1회 재실행
  - refresh 실패 시 영구 실패

### 재시도 금지(영구 실패)
- 400 `validation_error`
- 400 `invalid_json`
- 400 `invalid_request`
- 400 `missing_version`
- 403 `restricted_resource`
- 404 `object_not_found`
- 400 `invalid_grant` (refresh/code 자체 문제)

Notion의 상태 코드 문서는 위 에러 의미를 명확히 설명한다. 429는 속도 제한, 503은 60초 timeout 등 서비스 불가 상황일 수 있다. [Notion Docs](https://developers.notion.com/reference/status-codes)

## 14-2. backoff 규칙

앱 레벨 backoff는 아래와 같이 한다.

- 429:
  - 응답 헤더 `Retry-After`가 있으면 그것을 최우선
  - 없으면 `2^attempt + jitter(0~1000ms)` 초
- 409/500/502/503/504:
  - `min(2^attempt, 60)` 초 + jitter
- 최대 시도 횟수: 8회
- 8회 초과 시 failed

### 예시 구현

```ts
export function computeNextRunAt(err: NotionApiErrorLike, attempt: number): Date {
  const now = Date.now();

  if (err.code === "rate_limited" && err.retryAfterSeconds) {
    return new Date(now + err.retryAfterSeconds * 1000 + randomJitter(250, 1250));
  }

  if (["conflict_error", "internal_server_error", "bad_gateway", "service_unavailable", "gateway_timeout"].includes(err.code)) {
    const delaySec = Math.min(2 ** attempt, 60);
    return new Date(now + delaySec * 1000 + randomJitter(250, 1250));
  }

  return new Date(now);
}
```

## 14-3. fallback 순서

실패 시 아래 순서를 지킨다:

1. SDK 자동 retry가 먼저 동작
2. 그래도 실패하면 worker catch
3. error code 분류
4. refresh 가능하면 refresh 후 1회 재실행
5. 재시도 가능 오류면 job을 `retrying`으로 변경하고 `nextRunAt` 설정
6. 영구 실패면 `failed`

---

## 15) Worker 처리 흐름 의사코드

```ts
while (true) {
  const jobs = await queueService.fetchRunnableJobs(batchSize);

  for (const job of jobs) {
    await rateLimiter.waitTurn();

    try {
      await queueService.markProcessing(job.id, workerId);

      const integration = await notionIntegrationRepo.findById(job.notionIntegrationId);
      const accessToken = decrypt(integration.accessTokenEnc);
      const notion = createNotionClient(accessToken);

      const markdown = job.bodyMarkdown ?? notionMarkdownService.toMarkdown(job.bodyJson);

      const result = await notionWriteService.createPage({
        notion,
        integration,
        targetType: job.targetType,
        targetId: job.targetId,
        title: job.title,
        markdown,
        templateMode: job.templateMode,
        templateId: job.templateId
      });

      await queueService.markSucceeded(job.id, {
        pageId: result.id,
        pageUrl: result.url,
        responseJson: result
      });

    } catch (err) {
      const policy = notionErrorPolicyService.classify(err);

      if (policy.action === "refresh_and_retry_once") {
        try {
          await notionTokenService.refresh(job.notionIntegrationId);
          await queueService.requeueSoon(job.id, "token_refreshed_retry");
        } catch (refreshErr) {
          await queueService.markFailed(job.id, refreshErr);
        }
        continue;
      }

      if (policy.action === "retry") {
        await queueService.scheduleRetry(job.id, err, policy.nextRunAt);
        continue;
      }

      await queueService.markFailed(job.id, err);
    }
  }

  await sleep(env.QUEUE_POLL_INTERVAL_MS);
}
```

---

## 16) Notion Error Policy Service 구현 규칙

입력:
- SDK error
- HTTP status
- Notion error code
- headers의 `retry-after`

출력:
```ts
type ErrorPolicy =
  | { action: "retry"; nextRunAt: Date; reason: string }
  | { action: "refresh_and_retry_once"; reason: string }
  | { action: "fail"; reason: string };
```

분류 기준:
- `rate_limited` → retry
- `conflict_error`, `internal_server_error`, `bad_gateway`, `service_unavailable`, `gateway_timeout` → retry
- `unauthorized` → refresh_and_retry_once
- `validation_error`, `restricted_resource`, `object_not_found`, `invalid_grant` → fail

---

## 17) 보안 요구사항

1. 토큰 평문 로그 금지
2. OAuth state 필수
3. state 단회 사용
4. state TTL 10분
5. DB에는 암호화된 토큰만 저장
6. 에러 응답에 Notion 원문 메시지를 그대로 노출하지 말고 내부 로깅과 사용자 응답 분리
7. 내부 로그에는 `jobId`, `notionIntegrationId`, `botId`, `workspaceId`, `attemptCount`는 남기되 토큰은 남기지 않음
8. redirect URI는 env로만 관리
9. client secret은 env 외 저장 금지

---

## 18) API 응답 규격

## 18-1. enqueue 성공

```json
{
  "jobId": "uuid",
  "status": "queued"
}
```

## 18-2. job 조회 엔드포인트 추가

`GET /v1/notion/jobs/:jobId`

응답:

```json
{
  "jobId": "uuid",
  "status": "succeeded",
  "attemptCount": 2,
  "result": {
    "pageId": "xxxx",
    "pageUrl": "https://www.notion.so/..."
  },
  "error": null
}
```

실패 시:

```json
{
  "jobId": "uuid",
  "status": "failed",
  "attemptCount": 3,
  "result": null,
  "error": {
    "code": "restricted_resource",
    "message": "The selected Notion page or data source is not shared with the integration."
  }
}
```

404/object_not_found는 리소스가 없을 수도 있지만, 통합에 해당 페이지/DB가 공유되지 않았을 때도 발생할 수 있다. 사용자 메시지는 이 점을 반영해야 한다. [Notion Docs](https://developers.notion.com/reference/status-codes)

---

## 19) 개발 우선순위

아래 순서로 구현하라.

### Phase 1 — 오늘 반드시 끝낼 것
- Prisma schema
- `/auth/notion/start`
- `/auth/notion/callback`
- token upsert + encrypt
- `/v1/notion/write`
- JSON→Markdown 변환기
- Postgres jobs queue
- worker
- pages.create with markdown
- retry/fail 정책
- `/v1/notion/jobs/:jobId`

### Phase 2 — 시간 남으면
- refresh token 자동 갱신
- data source title property 자동 탐지
- markdown 실패 시 최소 block append fallback
- dead letter/attempt log

### Phase 3 — 오늘 하지 말 것
- complex rich text annotation
- media/file upload
- table/column layouts
- sync block
- template deep merge
- multi-destination fan-out

---

## 20) 최소 테스트 케이스

### OAuth
- 정상 code/state로 integration 저장 성공
- 만료 state 차단
- 재사용 state 차단

### Write enqueue
- 동일 payload 재호출 시 idempotency 동작
- queued job 생성 확인

### Worker success
- parent page 아래 child page 생성 성공
- data source 아래 row/page 생성 성공

### Error handling
- 429 발생 시 retrying으로 이동
- 404 발생 시 failed
- 401 발생 시 refresh 성공하면 재시도
- validation_error 발생 시 즉시 failed

### Markdown
- heading/bullet/todo/quote 변환 검증
- 긴 paragraph chunking 검증

---

## 21) 서비스 인터페이스 예시

```ts
export interface NotionOAuthService {
  getAuthorizeUrl(userId: string): Promise<{ url: string; state: string }>;
  exchangeCodeForToken(code: string): Promise<NotionOAuthTokenResponse>;
}

export interface NotionTokenService {
  upsertIntegration(input: {
    userId: string;
    tokenPayload: NotionOAuthTokenResponse;
  }): Promise<void>;

  refresh(notionIntegrationId: string): Promise<void>;
}

export interface NotionWriteService {
  createPage(input: {
    notion: Client;
    integration: NotionIntegration;
    targetType: "page" | "data_source";
    targetId: string;
    title?: string;
    markdown?: string;
    templateMode?: "none" | "default" | "template_id";
    templateId?: string;
  }): Promise<{ id: string; url: string }>;
}
```

---

## 22) 실제 구현 시 주의할 점

1. `destination.type = data_source`인 경우 Notion title property 이름이 워크스페이스마다 다를 수 있다.  
   가장 빠른 방법은 대상 연결 시 해당 title property 이름을 함께 저장하는 것이다.

2. `title`이 비어 있으면 기본값 사용:
   - `"Voice Capture - YYYY-MM-DD HH:mm"`
   - 단, 길이 120자 이내로 자르기

3. Markdown 본문이 비어 있으면 최소 placeholder:
   - `"Captured by VOXERA"`

4. worker는 프로세스 1개로 시작한다.  
   MVP에서는 수평 확장보다 안정성이 우선이다.

5. Notion API 호출 전후 로그는 남기되, payload 전체 raw dump는 금지한다.

---

## 23) GLM이 출력해야 할 결과물

이 지시를 수행한 뒤, 다음 산출물을 모두 생성하라.

1. `prisma/schema.prisma`
2. Express route/controller/service/repository 전체 TypeScript 코드
3. worker 실행 코드
4. Zod schema
5. `.env.example`
6. 마이그레이션 실행 방법
7. 로컬 실행 방법
8. 최소 integration test 샘플

출력은 설명만 하지 말고, **파일 단위 코드 블록**으로 제공하라.  
모든 코드는 **복붙 후 바로 프로젝트에 넣을 수 있는 수준**으로 작성하라.

---
 
 
```

---

 