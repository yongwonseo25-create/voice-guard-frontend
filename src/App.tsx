/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useRef, useCallback, type MutableRefObject } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Mic, Check, X, Send, ClipboardList, Loader2, AlertCircle,
  ArrowRightLeft, ShieldCheck, AlertTriangle, RefreshCw, ChevronDown,
  Siren, Users,
} from 'lucide-react';
import { apiService, NotifyDeadlineError } from './services/api';
import { triggerHandover, pollReport, ackWithRetry, postHandoverRecord } from './services/handoverApi';
import type { ReportStatus, AckResponse, ReportResponse } from './services/handoverApi';
import { getDeviceId } from './services/deviceId';

// ── localStorage 키 ──────────────────────────────────────────────
const LS_PENDING_ACK  = 'vg_pending_ack_report_id';
const LS_WORKER_ID    = 'vg_worker_id';
const LS_FACILITY_ID  = 'vg_facility_id';

// ── 타입 ─────────────────────────────────────────────────────────
type Screen = 'HOME' | 'RECORDING' | 'REVIEW' | 'COMPLETING' | 'HANDOVER' | 'HANDOVER_VIEW';
type Mode = 'LOG' | 'KAKAO_EMERGENCY' | 'KAKAO_SHIFT' | 'HANDOVER_RECORD';
type KakaoFailureMode = null | 'emergency' | 'shift';

function getShiftDate(): string {
  return new Date().toISOString().slice(0, 10);
}

// ════════════════════════════════════════════════════════════════
export default function App() {
  // ── 기존 상태 ────────────────────────────────────────────────
  const [screen, setScreen]             = useState<Screen>('HOME');
  const [mode, setMode]                 = useState<Mode | null>(null);
  const [logSubMenuOpen, setLogSubMenuOpen] = useState(false);
  const [kakaoSubMenuOpen, setKakaoSubMenuOpen] = useState(false);
  const [kakaoFailureMode, setKakaoFailureMode] = useState<KakaoFailureMode>(null);
  const [handoverReport, setHandoverReport] = useState<ReportResponse | null>(null);
  const [recordedText, setRecordedText] = useState('');
  const [progress, setProgress]         = useState(0);
  const [seconds, setSeconds]           = useState(0);
  const [error, setError]               = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);

  // ── Handover (Phase 6) 상태 ──────────────────────────────────
  /** 퇴근 보호사: 트리거 버튼 중복 클릭 방지 */
  const [isTriggering, setIsTriggering]   = useState(false);
  const [reportId, setReportId]           = useState<string | null>(null);
  const [reportStatus, setReportStatus]   = useState<ReportStatus | ''>('');
  /** 출근 보호사: ACK 대기 report_id */
  const [pendingAckId, setPendingAckId]   = useState<string | null>(
    () => localStorage.getItem(LS_PENDING_ACK),
  );
  const [ackResult, setAckResult]         = useState<AckResponse | null>(null);
  /** ACK 진행 상태: false=대기 / true=호출 중 */
  const [isAcking, setIsAcking]           = useState(false);

  const textAreaRef = useRef<HTMLTextAreaElement | null>(null) as MutableRefObject<HTMLTextAreaElement | null>;

  // ── 녹음 타이머 ──────────────────────────────────────────────
  useEffect(() => {
    let interval: ReturnType<typeof setInterval>;
    if (screen === 'RECORDING') {
      setSeconds(0);
      interval = setInterval(() => setSeconds((s) => s + 1), 1000);
    }
    return () => clearInterval(interval);
  }, [screen]);

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    return `${m}:${(s % 60).toString().padStart(2, '0')}`;
  };

  useEffect(() => {
    if (textAreaRef.current) {
      textAreaRef.current.scrollTop = textAreaRef.current.scrollHeight;
    }
  }, [recordedText]);

  // ── COMPLETING 진행 애니메이션 ────────────────────────────────
  useEffect(() => {
    if (screen !== 'COMPLETING') return;
    // 골든타임 실패 모드일 때는 진행/SSE 타이머 가동 금지 — 적색 경고 유지
    if (kakaoFailureMode) return;

    const sse = apiService.connectDashboardSSE(
      (data) => {
        if (data.status === 'COMPLETED') {
          setProgress(100);
          setTimeout(() => { setScreen('HOME'); setMode(null); setRecordedText(''); setProgress(0); }, 2000);
        } else if (data.status === 'ERROR') {
          setError(data.message || '작업 중 오류가 발생했습니다.');
          setScreen('REVIEW');
        }
      },
      (err) => console.log('SSE fallbacks to mock', err),
    );

    let current = 0;
    const interval = setInterval(() => {
      current += 1.5;
      if (current >= 100) {
        setProgress(100);
        clearInterval(interval);
        setTimeout(() => { setScreen('HOME'); setMode(null); setRecordedText(''); setProgress(0); }, 2000);
      } else {
        setProgress(current);
      }
    }, 30);

    return () => { clearInterval(interval); sse.close(); };
  }, [screen, kakaoFailureMode]);

  // ── HANDOVER_VIEW 진입 시 보고서 1회 로드 ───────────────────────
  useEffect(() => {
    if (screen !== 'HANDOVER_VIEW' || !pendingAckId) return;
    setHandoverReport(null);
    pollReport(pendingAckId)
      .then(setHandoverReport)
      .catch(() => {/* 조용히 실패 — 빈 화면 유지 */});
  }, [screen, pendingAckId]);

  // ── ACK 결과 2초 후 자동 소멸 ───────────────────────────────
  useEffect(() => {
    if (!ackResult) return;
    const timer = setTimeout(() => setAckResult(null), 2000);
    return () => clearTimeout(timer);
  }, [ackResult]);

  // ── HANDOVER 폴링 루프 ────────────────────────────────────────
  // 3초 간격, DONE/FAILED/EXPIRED 도달 시 정지. 최대 100회(5분).
  const pollCountRef = useRef(0);
  useEffect(() => {
    if (screen !== 'HANDOVER' || !reportId) return;
    if (reportStatus === 'DONE' || reportStatus === 'FAILED' || reportStatus === 'EXPIRED') return;

    pollCountRef.current = 0;
    const timer = setInterval(async () => {
      pollCountRef.current += 1;
      if (pollCountRef.current > 100) {
        setReportStatus('EXPIRED');
        clearInterval(timer);
        return;
      }
      try {
        const r = await pollReport(reportId);
        setReportStatus(r.status);
        if (r.status !== 'PENDING') clearInterval(timer);
      } catch {
        // 폴링 실패는 조용히 재시도
      }
    }, 3000);

    return () => clearInterval(timer);
  }, [screen, reportId, reportStatus]);

  // ════════════════════════════════════════════════════════════
  // 핸들러
  // ════════════════════════════════════════════════════════════

  const startRecording = (m: Mode) => {
    setMode(m);
    setScreen('RECORDING');
    setError(null);
    setLogSubMenuOpen(false);
    setKakaoSubMenuOpen(false);
    setKakaoFailureMode(null);
  };

  const stopRecording = async () => {
    setIsProcessing(true);
    try {
      const response = await apiService.transcribeAudio();
      if (response.success) {
        setRecordedText(response.text);
        setScreen('REVIEW');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '음성 인식에 실패했습니다.');
      setScreen('HOME');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleExecute = async () => {
    setScreen('COMPLETING');
    setKakaoFailureMode(null);
    try {
      if (mode === 'LOG') {
        await apiService.saveLog(recordedText);
      } else if (mode === 'HANDOVER_RECORD') {
        await postHandoverRecord({
          text: recordedText,
          worker_id:   localStorage.getItem(LS_WORKER_ID)   ?? 'WORKER_001',
          facility_id: localStorage.getItem(LS_FACILITY_ID) ?? 'FACILITY_001',
        });
      } else if (mode === 'KAKAO_EMERGENCY') {
        try {
          await apiService.notifyEmergency(recordedText);
        } catch (err) {
          // 골든타임 룰: 20초 데드라인 초과 → 즉시 적색 경고 + 전화 유도
          if (err instanceof NotifyDeadlineError) {
            setKakaoFailureMode('emergency');
            return; // COMPLETING 화면 유지하면서 적색 경고 렌더
          }
          throw err;
        }
      } else if (mode === 'KAKAO_SHIFT') {
        try {
          await apiService.notifyShiftGroup(recordedText);
        } catch (err) {
          // 골든타임 룰: 60초 데드라인 초과 → 적색 "전달 실패 통보!"
          if (err instanceof NotifyDeadlineError) {
            setKakaoFailureMode('shift');
            return;
          }
          throw err;
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '작업 수행에 실패했습니다.');
      setScreen('REVIEW');
    }
  };

  const handleCancel = () => {
    setScreen('HOME');
    setMode(null);
    setKakaoFailureMode(null);
  };

  // ── [인수인계 전달] — 클릭 즉시 POST trigger, debounce 보장 ──
  const handleTriggerHandover = async () => {
    if (isTriggering) return;
    setIsTriggering(true);
    setError(null);
    setReportStatus('');
    try {
      const result = await triggerHandover({
        facility_id: localStorage.getItem(LS_FACILITY_ID) ?? 'FACILITY_001',
        worker_id:   localStorage.getItem(LS_WORKER_ID)   ?? 'WORKER_001',
        shift_date:  getShiftDate(),
      });
      setReportId(result.report_id);
      setReportStatus('PENDING');
      localStorage.setItem(LS_PENDING_ACK, result.report_id);
      setPendingAckId(result.report_id);
      setScreen('HANDOVER');
    } catch (err) {
      setError(err instanceof Error ? err.message : '인수인계 전달에 실패했습니다.');
    } finally {
      setIsTriggering(false);
    }
  };

  // ── [확인 완료] — 클릭 즉시 PATCH ack, 재시도 최대 3회 ───────
  // 경고 팝업·대기 시간 없음. 실패 시 버튼 재활성화(상태 원복).
  const handleAck = useCallback(async () => {
    if (!pendingAckId || isAcking) return;
    setIsAcking(true);
    setError(null);
    try {
      const result = await ackWithRetry(pendingAckId, getDeviceId());
      setAckResult(result);
      localStorage.removeItem(LS_PENDING_ACK);
      setPendingAckId(null);
    } catch (err) {
      // 3회 재시도 최종 실패 → 버튼 원복, 에러만 표시
      setError(err instanceof Error ? err.message : '네트워크 오류. 와이파이 연결 후 다시 시도해주세요.');
    } finally {
      setIsAcking(false);
    }
  }, [pendingAckId, isAcking]);

  // ════════════════════════════════════════════════════════════
  // 렌더링
  // ════════════════════════════════════════════════════════════

  return (
    <div className="min-h-screen bg-[#FAF9F6] text-[#2D2D2D] font-sans selection:bg-orange-100 flex flex-col items-center justify-center p-4 sm:p-6 overflow-hidden">
      <div className="w-full max-w-md h-[800px] bg-[#FAF9F6] relative flex flex-col shadow-2xl shadow-stone-200/50 rounded-[48px] border border-stone-100/50 overflow-hidden">

        {/* Header */}
        <header className="pt-10 pb-6 text-center">
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="inline-flex flex-col items-center">
            <h1 className="text-[40px] font-black tracking-tight leading-none bg-clip-text text-transparent bg-linear-to-br from-[#2D2D2D] to-[#4A4A4A]">
              보이스가드
            </h1>
            <div className="h-1.5 w-12 bg-[#FF7F32] rounded-full mt-2 opacity-80" />
          </motion.div>
        </header>

        <main className="flex-1 flex flex-col px-8 pb-12">

          {/* ── 에러 토스트 ──────────────────────────────────────── */}
          <AnimatePresence>
            {error && (
              <motion.div
                initial={{ opacity: 0, y: -20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }}
                className="absolute top-4 left-4 right-4 bg-red-50 border border-red-200 p-4 rounded-2xl flex items-start gap-3 z-50 shadow-lg"
              >
                <AlertCircle className="w-6 h-6 text-red-500 shrink-0 mt-0.5" />
                <p className="text-base font-bold text-red-700 flex-1">{error}</p>
                <button onClick={() => setError(null)} className="shrink-0">
                  <X className="w-5 h-5 text-red-400" />
                </button>
              </motion.div>
            )}
          </AnimatePresence>

          <AnimatePresence mode="wait">

            {/* ══════════════════════════════════════════════════
                HOME
            ══════════════════════════════════════════════════ */}
            {screen === 'HOME' && (
              <motion.div
                key="home"
                initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }}
                className={`flex-1 flex flex-col gap-4 ${logSubMenuOpen ? 'overflow-y-auto py-2' : 'justify-center'}`}
              >
                {/* 업무 기록하기 (서브메뉴 토글) */}
                <div className="flex flex-col">
                  <button
                    onClick={() => setLogSubMenuOpen((prev) => !prev)}
                    className={`group w-full bg-white border-2 rounded-[48px] flex items-center shadow-xl shadow-stone-200/30 active:scale-[0.98] transition-all duration-300 ${
                      logSubMenuOpen
                        ? 'h-20 flex-row px-6 gap-4 border-orange-300'
                        : 'h-52 flex-col justify-start pt-3 gap-2 border-orange-100'
                    }`}
                  >
                    <div className={`bg-orange-50 rounded-full group-hover:bg-orange-100 transition-colors shrink-0 ${logSubMenuOpen ? 'p-3' : 'p-6'}`}>
                      <ClipboardList className={`text-[#FF7F32] ${logSubMenuOpen ? 'w-8 h-8' : 'w-12 h-12'}`} />
                    </div>
                    <div className={`${logSubMenuOpen ? 'flex-1 text-left' : 'text-center'}`}>
                      <p className={`font-black text-[#2D2D2D] ${logSubMenuOpen ? 'text-xl' : 'text-2xl'}`}>업무 기록하기</p>
                      {!logSubMenuOpen && <p className="text-base font-medium text-stone-400 mt-1">탭하여 항목을 선택하세요</p>}
                    </div>
                    <motion.div
                      animate={{ rotate: logSubMenuOpen ? 180 : 0 }}
                      transition={{ duration: 0.3 }}
                      className="shrink-0"
                    >
                      <ChevronDown className="w-5 h-5 text-stone-400" />
                    </motion.div>
                  </button>

                  <AnimatePresence>
                    {logSubMenuOpen && (
                      <motion.div
                        key="log-submenu"
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.35, ease: [0.4, 0, 0.2, 1] }}
                        className="overflow-hidden"
                      >
                        <div className="flex flex-col gap-2 pt-2">
                          {/* 서브메뉴 1: 인수인계 기록하기 */}
                          <button
                            onClick={() => startRecording('HANDOVER_RECORD')}
                            className="w-full h-16 bg-white border-2 border-orange-100 rounded-[24px] flex items-center gap-4 px-5 shadow-md active:scale-[0.98] transition-all"
                          >
                            <span className="text-2xl shrink-0">📝</span>
                            <div className="text-left">
                              <p className="text-base font-black text-[#2D2D2D]">인수인계 기록하기</p>
                              <p className="text-xs text-stone-400">음성으로 인수인계 내용을 남겨요</p>
                            </div>
                          </button>

                          {/* 서브메뉴 2: 인수인계하기 */}
                          <button
                            onClick={() => { setLogSubMenuOpen(false); handleTriggerHandover(); }}
                            disabled={isTriggering}
                            className="w-full h-16 bg-white border-2 border-orange-100 rounded-[24px] flex items-center gap-4 px-5 shadow-md active:scale-[0.98] transition-all disabled:opacity-50"
                          >
                            <span className="text-2xl shrink-0">✅</span>
                            <div className="flex-1 text-left">
                              <p className="text-base font-black text-[#2D2D2D]">인수인계하기</p>
                              <p className="text-xs text-stone-400">교대자에게 인수인계를 전달해요</p>
                            </div>
                            {isTriggering && <Loader2 className="w-5 h-5 text-[#FF7F32] animate-spin shrink-0" />}
                          </button>

                          {/* 서브메뉴 3: 인수인계 확인 */}
                          <button
                            onClick={() => { setLogSubMenuOpen(false); setScreen('HANDOVER_VIEW'); }}
                            className="w-full h-16 bg-white border-2 border-orange-100 rounded-[24px] flex items-center gap-4 px-5 shadow-md active:scale-[0.98] transition-all"
                          >
                            <span className="text-2xl shrink-0">🔍</span>
                            <div className="flex-1 text-left">
                              <p className="text-base font-black text-[#2D2D2D]">인수인계 확인</p>
                              <p className="text-xs text-stone-400">받은 인수인계를 확인하고 서명해요</p>
                            </div>
                            {pendingAckId && (
                              <span className="w-2.5 h-2.5 bg-[#FF7F32] rounded-full animate-pulse shrink-0" />
                            )}
                          </button>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>

                {/* ── 카카오톡 (서브박스 토글) ───────────────────────── */}
                <div className="flex flex-col">
                  <button
                    onClick={() => setKakaoSubMenuOpen((prev) => !prev)}
                    aria-expanded={kakaoSubMenuOpen}
                    aria-controls="kakao-subbox"
                    className={`group w-full bg-white border-2 rounded-[48px] flex items-center shadow-xl shadow-stone-200/30 active:scale-[0.98] transition-all duration-300 ${
                      kakaoSubMenuOpen
                        ? 'h-20 flex-row px-6 gap-4 border-orange-300'
                        : 'h-52 flex-col justify-start pt-3 gap-2 border-orange-100'
                    }`}
                  >
                    <div className={`bg-orange-50 rounded-full group-hover:bg-orange-100 transition-colors shrink-0 ${kakaoSubMenuOpen ? 'p-3' : 'p-6'}`}>
                      <Send className={`text-[#FF7F32] ${kakaoSubMenuOpen ? 'w-8 h-8' : 'w-12 h-12'}`} />
                    </div>
                    <div className={`${kakaoSubMenuOpen ? 'flex-1 text-left' : 'text-center'}`}>
                      <p className={`font-black text-[#2D2D2D] ${kakaoSubMenuOpen ? 'text-xl' : 'text-2xl'}`}>카카오톡</p>
                      {!kakaoSubMenuOpen && <p className="text-base font-medium text-stone-400 mt-1">탭하여 전달 대상을 선택하세요</p>}
                    </div>
                    <motion.div
                      animate={{ rotate: kakaoSubMenuOpen ? 180 : 0 }}
                      transition={{ duration: 0.3 }}
                      className="shrink-0"
                    >
                      <ChevronDown className="w-5 h-5 text-stone-400" />
                    </motion.div>
                  </button>

                  <AnimatePresence>
                    {kakaoSubMenuOpen && (
                      <motion.div
                        id="kakao-subbox"
                        key="kakao-submenu"
                        role="menu"
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                        className="overflow-hidden"
                      >
                        <div className="flex flex-col gap-2 pt-2">
                          {/* 라우팅 1: 🚨 원장님 전달하기 (긴급 재난망) */}
                          <button
                            role="menuitem"
                            onClick={() => startRecording('KAKAO_EMERGENCY')}
                            className="w-full min-h-[64px] bg-white border-l-[4px] border-l-[#C8362D] border-2 border-orange-100 rounded-[24px] flex items-center gap-4 px-5 py-3 shadow-md active:scale-[0.98] transition-all"
                          >
                            <Siren className="w-7 h-7 text-[#C8362D] shrink-0" strokeWidth={1.75} />
                            <div className="flex-1 text-left">
                              <p className="text-base font-black text-[#C8362D]">🚨 원장님 전달하기</p>
                              <p className="text-xs text-stone-500 mt-0.5">긴급 상황 — 골든타임 직통 알림</p>
                            </div>
                          </button>

                          {/* 라우팅 2: 👥 관리자와 동료 전달하기 (내부 컴플라이언스) */}
                          <button
                            role="menuitem"
                            onClick={() => startRecording('KAKAO_SHIFT')}
                            className="w-full min-h-[64px] bg-white border-2 border-orange-100 rounded-[24px] flex items-center gap-4 px-5 py-3 shadow-md active:scale-[0.98] transition-all"
                          >
                            <Users className="w-7 h-7 text-[#2D2D2D] shrink-0" strokeWidth={1.75} />
                            <div className="flex-1 text-left">
                              <p className="text-base font-black text-[#2D2D2D]">👥 관리자와 동료 전달하기</p>
                              <p className="text-xs text-stone-500 mt-0.5">현재 교대조에 자동 단체 발송</p>
                            </div>
                          </button>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>

                {/* 인수인계 섹션 */}
                <div className="flex gap-3 mt-1">
                  {/* [인수인계 전달] */}
                  <button
                    onClick={handleTriggerHandover}
                    disabled={isTriggering}
                    className={`flex-1 h-16 rounded-[24px] flex items-center justify-center gap-2 font-black text-lg transition-all active:scale-95 ${
                      isTriggering
                        ? 'bg-stone-100 text-stone-300 cursor-not-allowed'
                        : 'bg-[#FF7F32] text-white shadow-lg shadow-orange-200'
                    }`}
                  >
                    {isTriggering
                      ? <Loader2 className="w-5 h-5 animate-spin" />
                      : <ArrowRightLeft className="w-5 h-5" />}
                    인수인계 전달
                  </button>

                  {/* [확인 완료] — pendingAckId 있을 때만 표시 */}
                  {pendingAckId && (
                    <button
                      onClick={handleAck}
                      disabled={isAcking}
                      className={`flex-1 h-16 rounded-[24px] flex items-center justify-center gap-2 font-black text-lg border-2 transition-all active:scale-95 ${
                        isAcking
                          ? 'bg-stone-50 border-stone-200 text-stone-300 cursor-not-allowed'
                          : 'bg-white border-[#FF7F32] text-[#FF7F32]'
                      }`}
                    >
                      {isAcking
                        ? <Loader2 className="w-5 h-5 animate-spin" />
                        : <ShieldCheck className="w-5 h-5" />}
                      확인 완료
                    </button>
                  )}
                </div>

                {/* ACK 결과 */}
                <AnimatePresence>
                  {ackResult && (
                    <motion.div
                      initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                      className={`rounded-2xl p-4 flex items-start gap-3 ${
                        ackResult.tamper_detected
                          ? 'bg-amber-50 border border-amber-200'
                          : 'bg-green-50 border border-green-200'
                      }`}
                    >
                      {ackResult.tamper_detected
                        ? <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
                        : <Check className="w-5 h-5 text-green-600 shrink-0 mt-0.5" />}
                      <div>
                        <p className={`font-black text-base ${ackResult.tamper_detected ? 'text-amber-700' : 'text-green-700'}`}>
                          {ackResult.tamper_detected ? '수신 확인 완료 — 노션 위변조 감지됨' : '수신 확인 완료'}
                        </p>
                        {ackResult.tamper_detected && (
                          <p className="text-sm text-amber-600 mt-1">전송 후 문서가 수정되었습니다. 법적 검토 필요.</p>
                        )}
                        <p className="text-xs text-stone-400 mt-1">{new Date(ackResult.ack_at).toLocaleString('ko-KR')}</p>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
            )}

            {/* ══════════════════════════════════════════════════
                RECORDING
            ══════════════════════════════════════════════════ */}
            {screen === 'RECORDING' && (
              <motion.div
                key="recording"
                initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }}
                className="flex-1 flex flex-col items-center justify-between py-10"
              >
                <div className="text-center space-y-3">
                  <h2 className="text-3xl font-black text-[#2D2D2D]">업무를 기록하고 있어요</h2>
                  <p className="text-xl font-medium text-stone-500">말씀하시면 자동으로 적어요</p>
                </div>

                <div className="relative flex items-center justify-center">
                  <motion.div
                    animate={{ scale: [1, 1.5, 1], opacity: [0.2, 0.4, 0.2] }}
                    transition={{ duration: 4.0, repeat: Infinity, ease: 'easeInOut' }}
                    className="absolute w-[320px] h-[320px] bg-[#FFF9F0] rounded-full blur-[80px]"
                  />
                  <motion.div
                    animate={{ scale: [1, 1.3, 1], opacity: [0.3, 0.6, 0.3] }}
                    transition={{ duration: 4.0, repeat: Infinity, ease: 'easeInOut', delay: 0.2 }}
                    className="absolute w-[240px] h-[240px] bg-[#FFD8B1]/50 rounded-full blur-[50px]"
                  />
                  <motion.button
                    onClick={stopRecording}
                    disabled={isProcessing}
                    animate={{ scale: isProcessing ? 1 : [0.94, 1.06, 0.94] }}
                    transition={{ duration: 4.0, repeat: Infinity, ease: 'easeInOut' }}
                    className={`relative w-44 h-44 rounded-full flex items-center justify-center shadow-[0_20px_60px_rgba(255,127,50,0.35)] z-10 active:scale-95 transition-all ${
                      isProcessing ? 'bg-orange-300 cursor-not-allowed' : 'bg-[#FF7F32]'
                    }`}
                  >
                    {isProcessing
                      ? <Loader2 className="w-20 h-20 text-white animate-spin" />
                      : <Mic className="w-20 h-20 text-white" />}
                  </motion.button>
                </div>

                <div className="w-full flex flex-col items-center gap-8">
                  <div className="flex items-end gap-2 h-20">
                    {[...Array(18)].map((_, i) => (
                      <motion.div
                        key={i}
                        animate={{ height: [15, Math.random() * 60 + 15, 15] }}
                        transition={{ duration: 0.5 + Math.random() * 0.5, repeat: Infinity, ease: 'easeInOut' }}
                        className="w-2.5 bg-orange-300/70 rounded-full"
                      />
                    ))}
                  </div>
                  <div className="text-center space-y-4">
                    <p className="text-2xl font-black text-[#FF7F32] tabular-nums">{formatTime(seconds)}</p>
                    <p className="text-xl font-bold text-[#2D2D2D] opacity-60">마이크를 누르면 녹음이 끝납니다</p>
                  </div>
                </div>
              </motion.div>
            )}

            {/* ══════════════════════════════════════════════════
                REVIEW
            ══════════════════════════════════════════════════ */}
            {screen === 'REVIEW' && (
              <motion.div
                key="review"
                initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }}
                className="flex-1 flex flex-col gap-6"
              >
                <div className="flex-1 flex flex-col gap-4">
                  <h2 className="text-3xl font-black text-[#2D2D2D] text-center">내용 확인 및 수정</h2>
                  <div className="flex-1 relative bg-white border-2 border-orange-100 rounded-[40px] overflow-hidden shadow-inner">
                    <textarea
                      ref={textAreaRef}
                      value={recordedText}
                      onChange={(e) => setRecordedText(e.target.value)}
                      className="w-full h-full p-10 text-2xl leading-relaxed font-bold text-[#2D2D2D] focus:outline-none resize-none bg-transparent overflow-y-auto"
                      autoFocus
                    />
                  </div>
                </div>
                <div className="flex gap-4 h-24">
                  <button onClick={handleCancel} className="flex-1 bg-white border-2 border-stone-200 rounded-[32px] text-2xl font-black text-stone-400 active:scale-95 transition-all">
                    취소
                  </button>
                  <button onClick={handleExecute} className="flex-[1.8] bg-[#FF7F32] rounded-[32px] text-2xl font-black text-white shadow-xl shadow-orange-200 active:scale-95 transition-all flex items-center justify-center">
                    {mode === 'HANDOVER_RECORD'
                      ? '인수인계 저장'
                      : mode === 'LOG'
                        ? '기록 저장'
                        : mode === 'KAKAO_EMERGENCY'
                          ? '🚨 원장님께 전달'
                          : '👥 동료에게 전달'}
                  </button>
                </div>
              </motion.div>
            )}

            {/* ══════════════════════════════════════════════════
                COMPLETING
            ══════════════════════════════════════════════════ */}
            {screen === 'COMPLETING' && (
              <motion.div
                key="completing"
                initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }}
                className="flex-1 flex flex-col items-center justify-center gap-12"
              >
                {kakaoFailureMode ? (
                  /* ════════════════════════════════════════════════════
                     🚨 골든타임 데드라인 초과 — 적색 행동 유도 화면
                     ════════════════════════════════════════════════════ */
                  <motion.div
                    initial={{ opacity: 0, scale: 0.96 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ duration: 0.22 }}
                    className="w-full flex flex-col items-center gap-10 px-2"
                    role="alert"
                    aria-live="assertive"
                  >
                    <div className="w-32 h-32 rounded-full flex items-center justify-center border-[3px] border-[#C8362D]">
                      <AlertCircle className="w-16 h-16 text-[#C8362D]" strokeWidth={2.2} />
                    </div>
                    {kakaoFailureMode === 'emergency' ? (
                      <p
                        className="text-[#C8362D] text-3xl font-black text-center leading-snug"
                      >
                        카카오 전송 실패!{'\n'}즉시 원장님께 전화하세요!
                      </p>
                    ) : (
                      <p
                        className="text-[#C8362D] text-4xl font-black text-center leading-tight"
                      >
                        전달 실패 통보!
                      </p>
                    )}
                    <button
                      onClick={() => {
                        setKakaoFailureMode(null);
                        setScreen('HOME');
                        setMode(null);
                        setRecordedText('');
                      }}
                      className="px-8 py-4 bg-white border-2 border-[#C8362D] rounded-[24px] text-lg font-black text-[#C8362D] active:scale-95 transition-all"
                    >
                      확인했습니다
                    </button>
                  </motion.div>
                ) : progress < 100 ? (
                  <div className="w-full flex flex-col items-center gap-12">
                    <div className="w-32 h-32 relative">
                      <Loader2 className="w-full h-full text-[#FF7F32] animate-spin opacity-20" />
                      <div className="absolute inset-0 flex items-center justify-center">
                        <div className="w-6 h-6 bg-[#FF7F32] rounded-full animate-pulse" />
                      </div>
                    </div>
                    <div className="w-full max-w-[300px] space-y-6">
                      <div className="w-full bg-stone-100 h-5 rounded-full overflow-hidden p-1 shadow-inner">
                        <motion.div className="h-full bg-[#FF7F32] rounded-full" initial={{ width: 0 }} animate={{ width: `${progress}%` }} />
                      </div>
                      <p className="text-2xl font-black text-stone-400 text-center leading-tight">
                        {(mode === 'KAKAO_EMERGENCY' || mode === 'KAKAO_SHIFT')
                          ? '메시지를\n전송하고 있어요'
                          : '기록을 안전하게\n저장하고 있어요'}
                      </p>
                    </div>
                  </div>
                ) : (
                  <motion.div initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="flex flex-col items-center gap-10">
                    <div className="w-40 h-40 bg-green-500 rounded-full flex items-center justify-center shadow-2xl shadow-green-100">
                      <Check className="w-20 h-20 text-white" strokeWidth={3} />
                    </div>
                    <div className="text-center space-y-2">
                      <h2 className="text-4xl font-black text-[#2D2D2D]">
                        {(mode === 'KAKAO_EMERGENCY' || mode === 'KAKAO_SHIFT') ? '전송 완료!' : '저장 완료!'}
                      </h2>
                      <p className="text-xl font-bold text-stone-400">잠시 후 홈으로 이동합니다</p>
                    </div>
                  </motion.div>
                )}
              </motion.div>
            )}

            {/* ══════════════════════════════════════════════════
                HANDOVER — 인수인계 트리거 후 PENDING→DONE 폴링
            ══════════════════════════════════════════════════ */}
            {screen === 'HANDOVER' && (
              <motion.div
                key="handover"
                initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }}
                className="flex-1 flex flex-col items-center justify-center gap-10"
              >
                {reportStatus === 'DONE' ? (
                  <motion.div initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="flex flex-col items-center gap-8">
                    <div className="w-36 h-36 bg-green-500 rounded-full flex items-center justify-center shadow-2xl shadow-green-100">
                      <ShieldCheck className="w-16 h-16 text-white" />
                    </div>
                    <div className="text-center space-y-2">
                      <h2 className="text-3xl font-black text-[#2D2D2D]">인수인계 완료!</h2>
                      <p className="text-base font-medium text-stone-400">교대자가 확인할 수 있습니다</p>
                    </div>
                    <button
                      onClick={() => setScreen('HOME')}
                      className="px-8 py-4 bg-[#FF7F32] rounded-[24px] text-xl font-black text-white shadow-lg shadow-orange-200 active:scale-95 transition-all"
                    >
                      홈으로
                    </button>
                  </motion.div>
                ) : reportStatus === 'FAILED' || reportStatus === 'EXPIRED' ? (
                  <div className="flex flex-col items-center gap-8">
                    <div className="w-36 h-36 bg-red-100 rounded-full flex items-center justify-center">
                      <AlertCircle className="w-16 h-16 text-red-500" />
                    </div>
                    <div className="text-center space-y-2">
                      <h2 className="text-2xl font-black text-[#2D2D2D]">
                        {reportStatus === 'EXPIRED' ? '시간 초과' : '처리 실패'}
                      </h2>
                      <p className="text-base text-stone-400">
                        {reportStatus === 'EXPIRED'
                          ? '보고서 처리가 5분을 초과했습니다.'
                          : '인수인계 처리 중 오류가 발생했습니다.'}
                      </p>
                    </div>
                    <div className="flex gap-3">
                      <button
                        onClick={() => setScreen('HOME')}
                        className="px-6 py-4 bg-white border-2 border-stone-200 rounded-[24px] text-lg font-black text-stone-400 active:scale-95 transition-all"
                      >
                        홈으로
                      </button>
                      <button
                        onClick={() => { setReportStatus(''); handleTriggerHandover(); }}
                        className="px-6 py-4 bg-[#FF7F32] rounded-[24px] text-lg font-black text-white shadow-lg shadow-orange-200 active:scale-95 transition-all flex items-center gap-2"
                      >
                        <RefreshCw className="w-5 h-5" />
                        재시도
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col items-center gap-10">
                    <div className="w-32 h-32 relative">
                      <Loader2 className="w-full h-full text-[#FF7F32] animate-spin opacity-20" />
                      <div className="absolute inset-0 flex items-center justify-center">
                        <ArrowRightLeft className="w-10 h-10 text-[#FF7F32]" />
                      </div>
                    </div>
                    <div className="text-center space-y-3">
                      <h2 className="text-2xl font-black text-[#2D2D2D]">인수인계 보고서 생성 중</h2>
                      <p className="text-base text-stone-400">노션에 기록하고 있습니다…</p>
                      <p className="text-sm text-stone-300">최대 5분 소요될 수 있습니다</p>
                    </div>
                    <button
                      onClick={() => setScreen('HOME')}
                      className="px-6 py-3 bg-white border-2 border-stone-200 rounded-[20px] text-base font-black text-stone-400 active:scale-95 transition-all"
                    >
                      백그라운드에서 계속
                    </button>
                  </div>
                )}
              </motion.div>
            )}

            {/* ══════════════════════════════════════════════════
                HANDOVER_VIEW — 인수인계 확인 & ACK
            ══════════════════════════════════════════════════ */}
            {screen === 'HANDOVER_VIEW' && (
              <motion.div
                key="handover-view"
                initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }}
                className="flex-1 flex flex-col gap-5 py-2"
              >
                <h2 className="text-3xl font-black text-[#2D2D2D] text-center">인수인계 확인</h2>

                {/* ── pendingAckId 없음 ── */}
                {!pendingAckId ? (
                  <div className="flex-1 flex flex-col items-center justify-center gap-5">
                    <div className="w-24 h-24 bg-stone-100 rounded-full flex items-center justify-center">
                      <ClipboardList className="w-12 h-12 text-stone-300" />
                    </div>
                    <p className="text-xl font-bold text-stone-400">확인할 인수인계 없음</p>
                    <p className="text-sm text-stone-300 text-center">교대 전 인수인계가 도착하면 여기서 확인해요</p>
                  </div>

                /* ── 로딩 중 ── */
                ) : !handoverReport ? (
                  <div className="flex-1 flex items-center justify-center">
                    <Loader2 className="w-12 h-12 text-[#FF7F32] animate-spin opacity-40" />
                  </div>

                /* ── 보고서 표시 ── */
                ) : (
                  <div className="flex-1 flex flex-col gap-4">
                    <div className={`rounded-3xl p-5 border-2 ${
                      handoverReport.tamper_detected
                        ? 'bg-amber-50 border-amber-200'
                        : 'bg-green-50 border-green-100'
                    }`}>
                      <div className="flex items-center gap-3 mb-4">
                        {handoverReport.tamper_detected
                          ? <AlertTriangle className="w-7 h-7 text-amber-500 shrink-0" />
                          : <ShieldCheck className="w-7 h-7 text-green-500 shrink-0" />}
                        <div>
                          <p className={`text-lg font-black ${handoverReport.tamper_detected ? 'text-amber-700' : 'text-green-700'}`}>
                            {handoverReport.tamper_detected ? '위변조 감지됨 — 법적 검토 필요' : '인수인계 정상 수신'}
                          </p>
                          <p className="text-xs text-stone-400 font-mono mt-0.5">ID: {handoverReport.id.slice(0, 12)}…</p>
                        </div>
                      </div>
                      <div className="space-y-2 text-sm border-t border-stone-200/60 pt-3">
                        <HandoverInfoRow label="처리 상태" value={handoverReport.status} />
                        <HandoverInfoRow label="Gemini 분석"
                          value={handoverReport.has_gemini_json ? '완료' : handoverReport.has_raw_fallback ? '원본 폴백' : '처리 중'} />
                        <HandoverInfoRow label="노션 저장" value={handoverReport.notion_page_id ? '완료' : '대기 중'} />
                      </div>
                    </div>

                    {/* ACK 결과 or ACK 버튼 */}
                    {ackResult ? (
                      <div className={`rounded-2xl p-4 flex items-start gap-3 ${
                        ackResult.tamper_detected ? 'bg-amber-50 border border-amber-200' : 'bg-green-50 border border-green-200'
                      }`}>
                        {ackResult.tamper_detected
                          ? <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
                          : <Check className="w-5 h-5 text-green-600 shrink-0 mt-0.5" />}
                        <div>
                          <p className={`font-black text-base ${ackResult.tamper_detected ? 'text-amber-700' : 'text-green-700'}`}>
                            {ackResult.tamper_detected ? '수신 확인 완료 — 노션 위변조 감지됨' : '수신 확인 완료'}
                          </p>
                          <p className="text-xs text-stone-400 mt-1">{new Date(ackResult.ack_at).toLocaleString('ko-KR')}</p>
                        </div>
                      </div>
                    ) : (
                      <button
                        onClick={handleAck}
                        disabled={isAcking}
                        className={`w-full py-5 rounded-[32px] text-xl font-black flex items-center justify-center gap-3 transition-all active:scale-95 ${
                          isAcking
                            ? 'bg-stone-100 text-stone-300 cursor-not-allowed'
                            : 'bg-[#FF7F32] text-white shadow-xl shadow-orange-200'
                        }`}
                      >
                        {isAcking
                          ? <Loader2 className="w-6 h-6 animate-spin" />
                          : <ShieldCheck className="w-6 h-6" />}
                        {isAcking ? '확인 중…' : '수신 확인 (법적 서명)'}
                      </button>
                    )}
                  </div>
                )}

                <button
                  onClick={() => setScreen('HOME')}
                  className="w-full py-4 bg-white border-2 border-stone-200 rounded-[32px] text-xl font-black text-stone-400 active:scale-95 transition-all shrink-0"
                >
                  홈으로
                </button>
              </motion.div>
            )}

          </AnimatePresence>
        </main>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   HANDOVER_VIEW 내부 InfoRow 헬퍼
   ═══════════════════════════════════════════════════════════════════ */
function HandoverInfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between items-center">
      <span className="text-stone-500">{label}</span>
      <span className="font-bold text-stone-700">{value}</span>
    </div>
  );
}
