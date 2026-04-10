/**
 * Voice Guard — Handover API 클라이언트 (Phase 6)
 *
 * 🔧 DEV MOCK MODE 활성화
 * 백엔드(Gemini/Notion) 연결 단절 상태에서 500 에러 원천 차단.
 * VITE_API_BASE_URL 환경변수 설정 시 실제 API 모드로 자동 전환.
 *
 * 엔드포인트 (실서비스 시 사용):
 *   POST  /api/v6/handover/trigger        — 인수인계 보고서 생성 트리거
 *   GET   /api/v6/handover/report/{id}    — 보고서 상태 폴링
 *   PATCH /api/v6/handover/{id}/ack       — 법적 수신 확인
 */

const BASE       = import.meta.env.VITE_API_BASE_URL || '';
// 🔒 Mock 강제 활성화 — 백엔드(Gemini/Notion) 물리적 단절 상태.
// 실서비스 전환 시: const DEV_MOCK = !BASE; 로 복원.
const DEV_MOCK   = true;
const mockDelay  = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── 응답 타입 ────────────────────────────────────────────────────

export interface TriggerResponse {
  accepted: boolean;
  report_id: string;
  idempotency_key: string;
  status: string;
  message: string;
  alreadyExists?: boolean;
}

export type ReportStatus = 'PENDING' | 'DONE' | 'FAILED' | 'EXPIRED';

export interface ReportResponse {
  id: string;
  status: ReportStatus;
  gemini_failed: boolean;
  tamper_detected: boolean;
  notion_page_id: string | null;
  has_gemini_json: boolean;
  has_raw_fallback: boolean;
}

export interface AckResponse {
  ack_id: string;
  report_id: string;
  device_id: string;
  ack_at: string;
  tamper_detected: boolean;
  message: string;
}

// ── 더미 데이터 상수 ─────────────────────────────────────────────

const MOCK_REPORT_ID = 'mock-report-00000000-0000-0000-0000-000000000001';

const MOCK_TRIGGER_RESPONSE: TriggerResponse = {
  accepted:        true,
  report_id:       MOCK_REPORT_ID,
  idempotency_key: 'mock-idem-key-001',
  status:          'PENDING',
  message:         '이것은 더미 테스트용 인수인계 데이터입니다.',
};

const MOCK_REPORT_RESPONSE: ReportResponse = {
  id:              MOCK_REPORT_ID,
  status:          'DONE',
  gemini_failed:   false,
  tamper_detected: false,
  notion_page_id:  'mock-notion-page-abc123',
  has_gemini_json: true,
  has_raw_fallback: false,
};

const MOCK_ACK_RESPONSE: AckResponse = {
  ack_id:          'mock-ack-00000000-0000-0000-0000-000000000002',
  report_id:       MOCK_REPORT_ID,
  device_id:       'mock-device-id',
  ack_at:          new Date().toISOString(),
  tamper_detected: false,
  message:         '이것은 더미 테스트용 인수인계 데이터입니다.',
};

// ── 내부 헬퍼 (실제 API 모드 전용) ──────────────────────────────

function parseReportIdFrom409(detail: string): string | null {
  const m = detail.match(/report_id=([0-9a-f-]{36})/i);
  return m ? m[1] : null;
}

async function throwIfNotOk(res: Response): Promise<void> {
  if (res.ok) return;
  const body = await res.json().catch(() => ({ detail: res.statusText }));
  throw new Error(body.detail ?? `HTTP ${res.status}`);
}

// ── 공개 API ─────────────────────────────────────────────────────

/**
 * POST /api/v6/handover/trigger
 * DEV_MOCK: 1초 딜레이 후 PENDING 상태 더미 보고서 반환.
 */
export async function triggerHandover(params: {
  facility_id: string;
  worker_id: string;
  shift_date: string;
}): Promise<TriggerResponse> {
  if (DEV_MOCK) {
    await mockDelay(1000);
    return { ...MOCK_TRIGGER_RESPONSE };
  }

  const res = await fetch(`${BASE}/api/v6/handover/trigger`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });

  if (res.status === 409) {
    const body = await res.json().catch(() => ({ detail: '' }));
    const existingId = parseReportIdFrom409(body.detail ?? '');
    if (existingId) {
      return {
        accepted: true,
        report_id: existingId,
        idempotency_key: '',
        status: 'PENDING',
        message: '이미 제출된 보고서가 있습니다.',
        alreadyExists: true,
      };
    }
  }

  await throwIfNotOk(res);
  return res.json();
}

/**
 * GET /api/v6/handover/report/{id}
 * DEV_MOCK: 즉시 DONE 상태 더미 보고서 반환.
 */
export async function pollReport(reportId: string): Promise<ReportResponse> {
  if (DEV_MOCK) {
    await mockDelay(300);
    return { ...MOCK_REPORT_RESPONSE, id: reportId };
  }
  const res = await fetch(`${BASE}/api/v6/handover/report/${reportId}`);
  await throwIfNotOk(res);
  return res.json();
}

/**
 * PATCH /api/v6/handover/{id}/ack
 * DEV_MOCK: 800ms 딜레이 후 성공 ACK 반환.
 */
export async function ackHandover(
  reportId: string,
  deviceId: string,
): Promise<AckResponse> {
  if (DEV_MOCK) {
    await mockDelay(800);
    return {
      ...MOCK_ACK_RESPONSE,
      report_id: reportId,
      device_id: deviceId,
      ack_at:    new Date().toISOString(),
    };
  }
  const res = await fetch(`${BASE}/api/v6/handover/${reportId}/ack`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_id: deviceId }),
  });
  await throwIfNotOk(res);
  return res.json();
}

/**
 * POST /api/v2/ingest — 인수인계 기록하기
 * DEV_MOCK: 500ms 딜레이 후 void 반환.
 */
export async function postHandoverRecord(params: {
  text: string;
  worker_id: string;
  facility_id: string;
}): Promise<void> {
  if (DEV_MOCK) {
    await mockDelay(500);
    return;
  }
  const res = await fetch(`${BASE}/api/v2/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      care_type:   'handover_record',
      recorded_at: new Date().toISOString(),
      ...params,
    }),
  });
  if (!res.ok && !BASE) return;
  await throwIfNotOk(res);
}

/**
 * ACK Exponential Backoff 재시도 래퍼.
 */
export async function ackWithRetry(
  reportId: string,
  deviceId: string,
  maxAttempts = 3,
): Promise<AckResponse> {
  let lastError: Error = new Error('알 수 없는 오류');
  for (let i = 0; i < maxAttempts; i++) {
    if (i > 0) {
      await new Promise<void>((r) => setTimeout(r, 1000 * 2 ** (i - 1)));
    }
    try {
      return await ackHandover(reportId, deviceId);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw lastError;
}
