/**
 * Voice Guard — 서비스 환경 설정 단일 진실원
 *
 * 판단 기준:
 *   VITE_API_BASE_URL 이 설정된 경우  → 실서버 모드 (IS_DEV_MOCK = false)
 *   VITE_API_BASE_URL 미설정          → 개발 목업 모드 (IS_DEV_MOCK = true)
 *
 * .env.production 에 VITE_API_BASE_URL 이 이미 설정되어 있으므로
 * 프로덕션 빌드 시 자동으로 실서버 모드 활성화.
 */
export const API_BASE_URL: string = import.meta.env.VITE_API_BASE_URL ?? '';
export const IS_DEV_MOCK: boolean = !API_BASE_URL;
