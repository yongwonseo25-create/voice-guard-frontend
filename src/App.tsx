/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Mic, Check, X, Send, ClipboardList, Loader2, AlertCircle } from 'lucide-react';
import { apiService } from './services/api';

type Screen = 'HOME' | 'RECORDING' | 'REVIEW' | 'COMPLETING';

export default function App() {
  const [screen, setScreen] = useState<Screen>('HOME');
  const [mode, setMode] = useState<'LOG' | 'KAKAO' | null>(null);
  const [recordedText, setRecordedText] = useState('');
  const [progress, setProgress] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);

  // Recording timer
  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (screen === 'RECORDING') {
      setSeconds(0);
      interval = setInterval(() => {
        setSeconds(s => s + 1);
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [screen]);

  const formatTime = (s: number) => {
    const mins = Math.floor(s / 60);
    const secs = s % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const textAreaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll to bottom when recordedText changes
  useEffect(() => {
    if (textAreaRef.current) {
      textAreaRef.current.scrollTop = textAreaRef.current.scrollHeight;
    }
  }, [recordedText]);

  // Mock/SSE completion logic for robust State Management
  useEffect(() => {
    if (screen === 'COMPLETING') {
      // 실제 백엔드 연동: CQRS SSE 리스너 등록
      const sse = apiService.connectDashboardSSE(
        (data) => {
          if (data.status === 'COMPLETED') {
            setProgress(100);
            setTimeout(() => {
              setScreen('HOME');
              setMode(null);
              setRecordedText('');
              setProgress(0);
            }, 2000);
          } else if (data.status === 'ERROR') {
            setError(data.message || '작업 중 오류가 발생했습니다.');
            setScreen('REVIEW');
          }
        },
        (err) => console.log('SSE fallbacks to mock progress logic', err)
      );

      // UI 데모를 위한 Fallback (SSE 응답이 없을 때를 대비)
      let current = 0;
      const interval = setInterval(() => {
        current += 1.5; // Slightly slower for better UX
        if (current >= 100) {
          setProgress(100);
          clearInterval(interval);
          setTimeout(() => {
            setScreen('HOME');
            setMode(null);
            setRecordedText('');
            setProgress(0);
          }, 2000);
        } else {
          setProgress(current);
        }
      }, 30);
      
      return () => {
        clearInterval(interval);
        sse.close();
      };
    }
  }, [screen]);

  const startRecording = (m: 'LOG' | 'KAKAO') => {
    setMode(m);
    setScreen('RECORDING');
    setError(null);
  };

  const stopRecording = async () => {
    setIsProcessing(true);
    try {
      // In a real app, you'd pass the actual audio Blob here
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
    try {
      if (mode === 'LOG') {
        await apiService.saveLog(recordedText);
      } else {
        await apiService.sendKakao(recordedText);
      }
      // The progress animation in useEffect will handle the rest
    } catch (err) {
      setError(err instanceof Error ? err.message : '작업 수행에 실패했습니다.');
      setScreen('REVIEW');
    }
  };

  const handleCancel = () => {
    setScreen('HOME');
    setMode(null);
  };

  return (
    <div className="min-h-screen bg-[#FAF9F6] text-[#2D2D2D] font-sans selection:bg-orange-100 flex flex-col items-center justify-center p-4 sm:p-6 overflow-hidden">
      <div className="w-full max-w-md h-[800px] bg-[#FAF9F6] relative flex flex-col shadow-2xl shadow-stone-200/50 rounded-[48px] border border-stone-100/50 overflow-hidden">
        
        {/* Header */}
        <header className="pt-10 pb-6 text-center">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="inline-flex flex-col items-center"
          >
            <h1 className="text-[40px] font-black tracking-tight leading-none bg-clip-text text-transparent bg-linear-to-br from-[#2D2D2D] to-[#4A4A4A]">
              보이스가드
            </h1>
            <div className="h-1.5 w-12 bg-[#FF7F32] rounded-full mt-2 opacity-80" />
          </motion.div>
        </header>

        <main className="flex-1 flex flex-col px-8 pb-12">
          {/* Error Toast */}
          <AnimatePresence>
            {error && (
              <motion.div
                initial={{ opacity: 0, y: -20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                className="absolute top-4 left-4 right-4 bg-red-50 border border-red-200 p-4 rounded-2xl flex items-center gap-3 z-50 shadow-lg"
              >
                <AlertCircle className="w-6 h-6 text-red-500" />
                <p className="text-lg font-bold text-red-700">{error}</p>
                <button onClick={() => setError(null)} className="ml-auto">
                  <X className="w-5 h-5 text-red-400" />
                </button>
              </motion.div>
            )}
          </AnimatePresence>

          <AnimatePresence mode="wait">
            {screen === 'HOME' && (
              <motion.div
                key="home"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                className="flex-1 flex flex-col gap-6 justify-center"
              >
                <button
                  onClick={() => startRecording('LOG')}
                  className="group w-full h-60 bg-white border-2 border-orange-100 rounded-[48px] flex flex-col items-center justify-center gap-4 shadow-xl shadow-stone-200/30 active:scale-[0.98] transition-all duration-300"
                >
                  <div className="p-6 bg-orange-50 rounded-full group-hover:bg-orange-100 transition-colors">
                    <ClipboardList className="w-14 h-14 text-[#FF7F32]" />
                  </div>
                  <div className="text-center">
                    <p className="text-3xl font-black text-[#2D2D2D]">업무 기록</p>
                    <p className="text-lg font-medium text-stone-400 mt-1">내 업무를 남깁니다</p>
                  </div>
                </button>

                <button
                  onClick={() => startRecording('KAKAO')}
                  className="group w-full h-60 bg-white border-2 border-orange-100 rounded-[48px] flex flex-col items-center justify-center gap-4 shadow-xl shadow-stone-200/30 active:scale-[0.98] transition-all duration-300"
                >
                  <div className="p-6 bg-orange-50 rounded-full group-hover:bg-orange-100 transition-colors">
                    <Send className="w-14 h-14 text-[#FF7F32]" />
                  </div>
                  <div className="text-center">
                    <p className="text-3xl font-black text-[#2D2D2D]">카카오톡 전송</p>
                    <p className="text-lg font-medium text-stone-400 mt-1">원장님께 바로 보냅니다</p>
                  </div>
                </button>
              </motion.div>
            )}

            {screen === 'RECORDING' && (
              <motion.div
                key="recording"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                className="flex-1 flex flex-col items-center justify-between py-10"
              >
                <div className="text-center space-y-3">
                  <h2 className="text-3xl font-black text-[#2D2D2D]">
                    업무를 기록하고 있어요
                  </h2>
                  <p className="text-xl font-medium text-stone-500">
                    말씀하시면 자동으로 적어요
                  </p>
                </div>

                <div className="relative flex items-center justify-center">
                  {/* Layered Luxurious Breathing Glow - 4s cycle */}
                  {/* Outer Layer: Ivory Soft Glow */}
                  <motion.div
                    animate={{
                      scale: [1, 1.5, 1],
                      opacity: [0.2, 0.4, 0.2],
                    }}
                    transition={{
                      duration: 4.0,
                      repeat: Infinity,
                      ease: "easeInOut"
                    }}
                    className="absolute w-[320px] h-[320px] bg-[#FFF9F0] rounded-full blur-[80px]"
                  />
                  
                  {/* Inner Layer: Peach-Orange Warm Glow */}
                  <motion.div
                    animate={{
                      scale: [1, 1.3, 1],
                      opacity: [0.3, 0.6, 0.3],
                    }}
                    transition={{
                      duration: 4.0,
                      repeat: Infinity,
                      ease: "easeInOut",
                      delay: 0.2
                    }}
                    className="absolute w-[240px] h-[240px] bg-[#FFD8B1]/50 rounded-full blur-[50px]"
                  />
                  
                  {/* Large Microphone Button */}
                  <motion.button
                    onClick={stopRecording}
                    disabled={isProcessing}
                    animate={{
                      scale: isProcessing ? 1 : [0.94, 1.06, 0.94],
                    }}
                    transition={{
                      duration: 4.0,
                      repeat: Infinity,
                      ease: "easeInOut"
                    }}
                    className={`relative w-44 h-44 rounded-full flex items-center justify-center shadow-[0_20px_60px_rgba(255,127,50,0.35)] z-10 active:scale-95 transition-all ${
                      isProcessing ? 'bg-orange-300 cursor-not-allowed' : 'bg-[#FF7F32]'
                    }`}
                  >
                    {isProcessing ? (
                      <Loader2 className="w-20 h-20 text-white animate-spin" />
                    ) : (
                      <Mic className="w-20 h-20 text-white" />
                    )}
                  </motion.button>
                </div>

                <div className="w-full flex flex-col items-center gap-8">
                  {/* Larger Waveform */}
                  <div className="flex items-end gap-2 h-20">
                    {[...Array(18)].map((_, i) => (
                      <motion.div
                        key={i}
                        animate={{
                          height: [15, Math.random() * 60 + 15, 15],
                        }}
                        transition={{
                          duration: 0.5 + Math.random() * 0.5,
                          repeat: Infinity,
                          ease: "easeInOut"
                        }}
                        className="w-2.5 bg-orange-300/70 rounded-full"
                      />
                    ))}
                  </div>

                  <div className="text-center space-y-4">
                    <p className="text-2xl font-black text-[#FF7F32] tabular-nums">
                      {formatTime(seconds)}
                    </p>
                    <p className="text-xl font-bold text-[#2D2D2D] opacity-60">
                      마이크를 누르면 녹음이 끝납니다
                    </p>
                  </div>
                </div>
              </motion.div>
            )}

            {screen === 'REVIEW' && (
              <motion.div
                key="review"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
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
                  <button
                    onClick={handleCancel}
                    className="flex-1 bg-white border-2 border-stone-200 rounded-[32px] text-2xl font-black text-stone-400 active:scale-95 transition-all"
                  >
                    취소
                  </button>
                  <button
                    onClick={handleExecute}
                    className="flex-[1.8] bg-[#FF7F32] rounded-[32px] text-2xl font-black text-white shadow-xl shadow-orange-200 active:scale-95 transition-all flex items-center justify-center"
                  >
                    {mode === 'LOG' ? '기록 저장' : '카톡 보내기'}
                  </button>
                </div>
              </motion.div>
            )}

            {screen === 'COMPLETING' && (
              <motion.div
                key="completing"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                className="flex-1 flex flex-col items-center justify-center gap-12"
              >
                {progress < 100 ? (
                  <div className="w-full flex flex-col items-center gap-12">
                    <div className="w-32 h-32 relative">
                      <Loader2 className="w-full h-full text-[#FF7F32] animate-spin opacity-20" />
                      <div className="absolute inset-0 flex items-center justify-center">
                        <div className="w-6 h-6 bg-[#FF7F32] rounded-full animate-pulse" />
                      </div>
                    </div>
                    <div className="w-full max-w-[300px] space-y-6">
                      <div className="w-full bg-stone-100 h-5 rounded-full overflow-hidden p-1 shadow-inner">
                        <motion.div 
                          className="h-full bg-[#FF7F32] rounded-full"
                          initial={{ width: 0 }}
                          animate={{ width: `${progress}%` }}
                        />
                      </div>
                      <p className="text-2xl font-black text-stone-400 text-center leading-tight">
                        {mode === 'LOG' ? '기록을 안전하게\n저장하고 있어요' : '메시지를\n전송하고 있어요'}
                      </p>
                    </div>
                  </div>
                ) : (
                  <motion.div
                    initial={{ scale: 0.8, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    className="flex flex-col items-center gap-10"
                  >
                    <div className="w-40 h-40 bg-green-500 rounded-full flex items-center justify-center shadow-2xl shadow-green-100">
                      <Check className="w-20 h-20 text-white" strokeWidth={3} />
                    </div>
                    <div className="text-center space-y-2">
                      <h2 className="text-4xl font-black text-[#2D2D2D]">
                        {mode === 'LOG' ? '저장 완료!' : '전송 완료!'}
                      </h2>
                      <p className="text-xl font-bold text-stone-400">잠시 후 홈으로 이동합니다</p>
                    </div>
                  </motion.div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </main>
      </div>
    </div>
  );
}
