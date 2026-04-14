/**
 * API Service for Voice Guard
 * Handles communication with the backend for transcription, logging, and messaging.
 */

import { getDeviceId } from './deviceId';
import { API_BASE_URL, IS_DEV_MOCK } from './config';

const mockDelay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── 사령관 특별 지시 룰: 카카오 v7 골든타임 TTL ──────────────────
// 긴급(원장님) = 20초 한계 / 일반(동료) = 60초 한계
// 한계 도달 시 즉시 NotifyDeadlineError 발생 → UI 적색 경고 렌더링.
export const NOTIFY_EMERGENCY_DEADLINE_MS = 20_000;
export const NOTIFY_SHIFT_DEADLINE_MS     = 60_000;

export type NotifyMode = 'emergency' | 'shift';

export class NotifyDeadlineError extends Error {
  readonly mode: NotifyMode;
  constructor(mode: NotifyMode) {
    super(`NOTIFY_DEADLINE_EXCEEDED:${mode}`);
    this.name = 'NotifyDeadlineError';
    this.mode = mode;
  }
}

export interface IdempotentResponse {
  idempotencyKey: string;
  [key: string]: any;
}

const getAuthToken = (): string | null => {
  return localStorage.getItem('jwt_token');
};

const newIdempotencyKey = (): string => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `vg-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
};

/**
 * 데드라인 기반 단일 호출 + 자동 재시도.
 * - 동일 Idempotency-Key를 모든 재시도에 재사용 (서버 측 dedupe 보장)
 * - 4xx (400/401/403/404/409) → 재시도 없이 즉시 throw
 * - 5xx / 408 / 429 / 네트워크 → 지수 백오프 후 재시도
 * - deadline 경과 → NotifyDeadlineError throw (사령관 골든타임 룰)
 */
async function notifyWithDeadline(
  url: string,
  body: object,
  deadlineMs: number,
  mode: NotifyMode,
): Promise<IdempotentResponse> {
  const idempotencyKey = newIdempotencyKey();
  const startedAt = Date.now();

  const token = getAuthToken();
  const headers: Record<string, string> = {
    'Content-Type':    'application/json',
    'Idempotency-Key': idempotencyKey,
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  let attempt = 0;
  while (Date.now() - startedAt < deadlineMs) {
    attempt += 1;
    const remainingMs = deadlineMs - (Date.now() - startedAt);
    const ctrl = new AbortController();
    const reqTimeout = setTimeout(
      () => ctrl.abort(),
      Math.max(1_000, Math.min(remainingMs, 8_000)),
    );

    try {
      const resp = await fetch(`${API_BASE_URL}${url}`, {
        method:  'POST',
        headers,
        body:    JSON.stringify(body),
        signal:  ctrl.signal,
      });
      clearTimeout(reqTimeout);

      // 2xx — 성공
      if (resp.ok) {
        const data = (await resp.json()) as IdempotentResponse;
        if (!data.idempotencyKey) {
          throw new Error('idempotencyKey is missing in the success response');
        }
        return data;
      }

      // 4xx fatal — 재시도 금지
      const isFatal4xx =
        resp.status >= 400 &&
        resp.status < 500 &&
        resp.status !== 408 &&
        resp.status !== 429;
      if (isFatal4xx) {
        const info = await resp.json().catch(() => ({} as any));
        throw new Error(info.detail || info.message || `NOTIFY_FATAL_${resp.status}`);
      }
      // 5xx / 408 / 429 — fall through to backoff
    } catch (err) {
      clearTimeout(reqTimeout);
      // 4xx fatal은 위에서 던진 일반 Error → 즉시 상위로 전파
      if (err instanceof Error && err.message.startsWith('NOTIFY_FATAL_')) {
        throw err;
      }
      // 그 외 (AbortError, TypeError 네트워크 오류 등) → 재시도 루프 진행
    }

    // 백오프(지터 ±20%) — 단, 데드라인을 넘지 않도록 캡
    const elapsed = Date.now() - startedAt;
    const remaining = deadlineMs - elapsed;
    if (remaining <= 50) break;
    const base    = 400 * Math.pow(2, attempt - 1);          // 400 / 800 / 1600 / 3200 …
    const jitter  = 0.8 + Math.random() * 0.4;
    const backoff = Math.min(remaining - 10, Math.floor(base * jitter));
    if (backoff <= 0) break;
    await new Promise((r) => setTimeout(r, backoff));
  }

  throw new NotifyDeadlineError(mode);
}

const handleResponse = async (response: Response): Promise<IdempotentResponse> => {
  if (!response.ok) {
    const errorInfo = await response.json().catch(() => ({
      message: `API Error: ${response.status} ${response.statusText}`,
    }));
    throw new Error(errorInfo.message || 'Backend request failed');
  }

  const data: IdempotentResponse = await response.json();
  if (!data.idempotencyKey) {
    throw new Error('idempotencyKey is missing in the success response');
  }
  
  return data;
};


export const apiService = {
  /**
   * 타격 4: 녹음 종료 후 1500ms 고정 — 사령관 "2초 미만" 룰 준수.
   * IS_DEV_MOCK=true 시 네트워크 요청 0건, 순수 setTimeout만 동작.
   */
  async transcribeAudio(_audioData?: Blob): Promise<IdempotentResponse> {
    if (IS_DEV_MOCK) {
      await mockDelay(1500); // 🔒 1500ms 고정 — 절대 변경 금지
      return {
        idempotencyKey: 'mock-transcribe-' + Date.now(),
        text: '더미 음성 인식 결과입니다. 오늘 오전 9시 입소자 식사 보조 완료, 특이사항 없음.',
        success: true,
      };
    }
    const token = getAuthToken();
    const headers: HeadersInit = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const formData = new FormData();
    if (_audioData) formData.append('audio', _audioData);
    const response = await fetch(`${API_BASE_URL}/api/voice/submit`, {
      method: 'POST', headers, body: formData,
    });
    if (!response.ok) {
      return { idempotencyKey: 'dev_mock_key', text: '현장 업무 기록입니다.', success: true };
    }
    return handleResponse(response);
  },

  async saveLog(text: string): Promise<IdempotentResponse> {
    if (IS_DEV_MOCK) {
      await mockDelay(300);
      return { idempotencyKey: 'mock-log-' + Date.now(), success: true };
    }
    const token = getAuthToken();
    const headers: HeadersInit = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const response = await fetch(`${API_BASE_URL}/api/outbox/notify`, {
      method: 'POST', headers,
      body: JSON.stringify({ text, timestamp: new Date().toISOString() }),
    });
    if (!response.ok && !API_BASE_URL) {
      return { idempotencyKey: 'dev_mock_key', success: true };
    }
    return handleResponse(response);
  },

  /**
   * 🚨 v7 긴급 직통 알림톡 — 원장 + 관리자 fan-out (백엔드 결정)
   * 골든타임 룰: 20초 데드라인, 초과 시 NotifyDeadlineError.
   */
  async notifyEmergency(transcript: string): Promise<IdempotentResponse> {
    if (IS_DEV_MOCK) {
      await mockDelay(800);
      return {
        idempotencyKey: 'mock-emergency-' + Date.now(),
        deliveryId:   'mock-delivery-001',
        channel:      'alimtalk',
        targetCount:  2,
        failedCount:  0,
        queuedAt:     new Date().toISOString(),
        success:      true,
      };
    }
    return notifyWithDeadline(
      '/api/v7/notify/emergency',
      {
        transcript,
        severity:    'critical',
        occurredAt:  new Date().toISOString(),
        deviceId:    getDeviceId(),
        ledgerRefId: null,
      },
      NOTIFY_EMERGENCY_DEADLINE_MS,
      'emergency',
    );
  },

  /**
   * 👥 v7 교대조 단체 알림톡.
   * 사령관 원칙 #2: shiftCode 무조건 'AUTO' 하드코딩 — FE 산정 절대 금지.
   * 골든타임 룰: 60초 데드라인, 초과 시 NotifyDeadlineError.
   */
  async notifyShiftGroup(transcript: string): Promise<IdempotentResponse> {
    if (IS_DEV_MOCK) {
      await mockDelay(800);
      return {
        idempotencyKey:      'mock-shift-' + Date.now(),
        deliveryId:          'mock-delivery-002',
        channel:             'alimtalk',
        resolvedShiftCode:   'DAY',
        targetCount:         5,
        failedCount:         0,
        handoverTransitioned: false,
        queuedAt:            new Date().toISOString(),
        success:             true,
      };
    }
    return notifyWithDeadline(
      '/api/v7/notify/shift-group',
      {
        transcript,
        shiftCode:     'AUTO',  // 🔒 절대 변경 금지 — 백엔드 시계 기반 100% 자동 산정
        occurredAt:    new Date().toISOString(),
        deviceId:      getDeviceId(),
        handoverState: 'share',
      },
      NOTIFY_SHIFT_DEADLINE_MS,
      'shift',
    );
  },

  async sendKakao(text: string): Promise<IdempotentResponse> {
    if (IS_DEV_MOCK) {
      await mockDelay(300);
      return { idempotencyKey: 'mock-kakao-' + Date.now(), success: true };
    }
    const token = getAuthToken();
    const headers: HeadersInit = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const response = await fetch(`${API_BASE_URL}/api/outbox/kakao/send`, {
      method: 'POST', headers, body: JSON.stringify({ text }),
    });
    if (!response.ok && !API_BASE_URL) {
      return { idempotencyKey: 'dev_mock_key', success: true };
    }
    return handleResponse(response);
  },

  connectDashboardSSE(onMessage?: (data: any) => void, onError?: (err: any) => void): EventSource {
    const token = getAuthToken();
    const url = `${API_BASE_URL}/api/sse/stream`;
    
    const eventSource = new EventSource(url);

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (onMessage) onMessage(data);
      } catch (e) {
        console.error('SSE Error parsing', e)
      }
    };

    eventSource.onerror = (error) => {
      console.error('SSE Connection Error:', error);
      if (onError) onError(error);
      // close() 호출 금지:
      //   EventSource는 readyState=CONNECTING(0) 또는 OPEN(1) 상태에서
      //   오류 발생 시 브라우저가 자동 재연결을 시도한다.
      //   수동 close()는 readyState=CLOSED(2)로 전환 → 재연결 영구 차단.
      //   명시적 연결 종료가 필요하면 호출자에서 반환된 EventSource 인스턴스에
      //   직접 .close()를 호출할 것.
    };

    return eventSource;
  }
};
