# VOXERA Multi-Channel Native Delivery Control Plane 아키텍처 (Make.com 폐기)

## 1. 공용 Delivery Queue 승격 (Schema)
- 기존 Notion 큐를 확장하여 `delivery_jobs` 공용 테이블을 생성한다.
- `provider` Enum: NOTION, SLACK, KAKAO, EMAIL 지원.
- 필수 컬럼: `request_id`, `provider`, `recipient_key`, `idempotency_key`, `status`(PENDING, PROCESSING, COMPLETED, FAILED_RETRYABLE, FAILED_TERMINAL, UNKNOWN), `attempt_count`, `last_error_code`.

## 2. Fan-out 및 단일 트랜잭션 (Zero-Loss)
- Gemini가 정제한 JSON 목적지가 다수(예: Slack, Email)일 경우, 백엔드는 이를 각각의 독립된 `delivery_jobs` row로 쪼개어(Fan-out) **단일 트랜잭션**으로 DB에 Insert 한다.

## 3. Worker 통제 (FOR UPDATE SKIP LOCKED)
- 여러 Worker가 충돌 없이 Job을 가져가기 위해 반드시 `FOR UPDATE SKIP LOCKED`를 사용한다.
- Provider별로 MultiChannelDispatcher가 각 Sender(NotionSender, SlackSender, KakaoSender, EmailSender)로 작업을 분배한다.

## 4. 엄격한 Retry State Machine (모호성 방어)
- 429/Throttle: `FAILED_RETRYABLE` (지수 백오프)
- 5xx/Network: `FAILED_RETRYABLE` (지수 백오프)
- 4xx/Auth: `FAILED_TERMINAL` (영구 실패)
- Timeout 등 모호한 상태: 무지성 재시도 금지. 반드시 `UNKNOWN` 상태로 전환 후 Reconciliation Queue로 이동하여 중복 전송을 막는다.
