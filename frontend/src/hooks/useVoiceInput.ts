import { useEffect, useMemo, useRef, useState } from "react";

type VoiceOptions = {
  onFinalText: (text: string) => void;
  onSilence?: () => void;
  silenceMs?: number;
};

export function useVoiceInput(options: VoiceOptions) {
  const { onFinalText, onSilence, silenceMs = 1800 } = options;
  const [isListening, setIsListening] = useState(false);
  const recognitionRef = useRef<any>(null);
  const silenceTimerRef = useRef<number | null>(null);
  const silenceTriggeredRef = useRef(false);

  const isSupported = useMemo(() => {
    return Boolean((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);
  }, []);

  const clearSilenceTimer = () => {
    if (silenceTimerRef.current !== null) {
      window.clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
  };

  const armSilenceTimer = () => {
    clearSilenceTimer();
    silenceTimerRef.current = window.setTimeout(() => {
      if (!isListening || silenceTriggeredRef.current) return;
      silenceTriggeredRef.current = true;
      onSilence?.();
      try {
        recognitionRef.current?.stop();
      } catch {
        // ignore
      }
    }, silenceMs);
  };

  const start = () => {
    if (!isSupported) return;
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    const rec = new SR();
    rec.lang = navigator.language || "en-US";
    rec.continuous = true;
    rec.interimResults = true;
    silenceTriggeredRef.current = false;
    rec.onresult = (event: any) => {
      let finalText = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const t = event.results[i][0].transcript as string;
        if (event.results[i].isFinal) finalText += t;
      }
      if (finalText.trim()) onFinalText(finalText.trim());
      armSilenceTimer();
    };
    rec.onerror = () => {
      clearSilenceTimer();
      setIsListening(false);
    };
    rec.onend = () => {
      clearSilenceTimer();
      setIsListening(false);
    };
    rec.start();
    recognitionRef.current = rec;
    setIsListening(true);
    armSilenceTimer();
  };

  const stop = () => {
    try {
      recognitionRef.current?.stop();
    } catch {
      // ignore
    }
    clearSilenceTimer();
    setIsListening(false);
  };

  useEffect(() => {
    return () => clearSilenceTimer();
  }, []);

  return { isSupported, isListening, start, stop };
}
