/**
 * device_id 유틸 — 최초 실행 시 UUID v4 생성 후 localStorage 영속화.
 * 재설치 시 신규 ID 생성 (의도적 — 법적 기록에 기기 교체 반영).
 */
const KEY = 'vg_device_id';

export function getDeviceId(): string {
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(KEY, id);
  }
  return id;
}
