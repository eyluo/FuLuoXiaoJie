import { useCallback, useEffect, useRef } from "react";
import { notifyUnauthorized } from "../api/client.js";

const MAX_AUDIO_CACHE_ENTRIES = 128;

/**
 * Bounded LRU cache for syllable audio Blob URLs with automatic URL.revokeObjectURL on eviction
 * and in-flight fetch deduplication to prevent Blob URL leaks.
 */
export class AudioBlobCache {
  private readonly cache = new Map<string, string>();
  private readonly inflight = new Map<string, Promise<string>>();
  private readonly maxEntries: number;

  constructor(maxEntries = MAX_AUDIO_CACHE_ENTRIES) {
    this.maxEntries = maxEntries;
  }

  get size(): number {
    return this.cache.size;
  }

  get(key: string): string | undefined {
    const existing = this.cache.get(key);
    if (existing !== undefined) {
      // Refresh LRU recency
      this.cache.delete(key);
      this.cache.set(key, existing);
    }
    return existing;
  }

  async getOrFetch(key: string, fetcher: () => Promise<Blob>): Promise<string> {
    const cached = this.get(key);
    if (cached) return cached;

    const pending = this.inflight.get(key);
    if (pending) return pending;

    const promise = fetcher()
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        this.put(key, url);
        return url;
      })
      .finally(() => {
        this.inflight.delete(key);
      });

    this.inflight.set(key, promise);
    return promise;
  }

  private put(key: string, url: string): void {
    const prev = this.cache.get(key);
    if (prev && prev !== url) {
      URL.revokeObjectURL(prev);
      this.cache.delete(key);
    }
    this.cache.set(key, url);
    while (this.cache.size > this.maxEntries) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey === undefined) break;
      const oldestUrl = this.cache.get(oldestKey);
      this.cache.delete(oldestKey);
      if (oldestUrl) URL.revokeObjectURL(oldestUrl);
    }
  }

  clear(): void {
    for (const url of this.cache.values()) {
      URL.revokeObjectURL(url);
    }
    this.cache.clear();
    this.inflight.clear();
  }
}

export const sharedAudioCache = new AudioBlobCache();

export function clearMandarinAudioCache(): void {
  sharedAudioCache.clear();
}

/**
 * Self-hosted offline Mandarin syllable MP3 player with bounded LRU Blob URL cache,
 * race-safe playback sequencing, 401 session propagation, and Web Speech zh-CN fallback.
 */
export function useMandarinAudio() {
  const activeAudioRef = useRef<HTMLAudioElement | null>(null);
  const playSeqRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      playSeqRef.current++;
      if (activeAudioRef.current) {
        activeAudioRef.current.pause();
        activeAudioRef.current = null;
      }
    };
  }, []);

  const stopActive = useCallback(() => {
    if (activeAudioRef.current) {
      activeAudioRef.current.pause();
      activeAudioRef.current.currentTime = 0;
      activeAudioRef.current = null;
    }
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
  }, []);

  const playSyllable = useCallback(
    async (audioFile: string | null | undefined, fallbackText?: string) => {
      const seq = ++playSeqRef.current;
      stopActive();

      if (audioFile) {
        try {
          const objectUrl = await sharedAudioCache.getOrFetch(audioFile, async () => {
            const res = await fetch(`/api/data/audio/${encodeURIComponent(audioFile)}`, {
              credentials: "same-origin",
            });
            if (res.status === 401) {
              notifyUnauthorized();
              throw new Error("Unauthorized");
            }
            if (!res.ok) throw new Error(`Audio fetch failed: ${res.status}`);
            return res.blob();
          });

          // Abort if a newer playback started or component unmounted while fetching
          if (!mountedRef.current || seq !== playSeqRef.current) return;

          const audio = new Audio(objectUrl);
          activeAudioRef.current = audio;
          await audio.play();
          return;
        } catch (err) {
          if (err instanceof Error && err.message === "Unauthorized") return;
          if (!mountedRef.current || seq !== playSeqRef.current) return;
        }
      }

      if (
        mountedRef.current &&
        seq === playSeqRef.current &&
        fallbackText &&
        typeof window !== "undefined" &&
        "speechSynthesis" in window
      ) {
        window.speechSynthesis.cancel();
        const utter = new SpeechSynthesisUtterance(fallbackText);
        utter.lang = "zh-CN";
        utter.rate = 0.88;
        window.speechSynthesis.speak(utter);
      }
    },
    [stopActive]
  );

  const speakWord = useCallback(
    (word: string, audioFile?: string | null) => {
      if (audioFile) {
        void playSyllable(audioFile, word);
        return;
      }
      playSeqRef.current++;
      stopActive();
      if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
      const utter = new SpeechSynthesisUtterance(word);
      utter.lang = "zh-CN";
      utter.rate = 0.9;
      const voices = window.speechSynthesis.getVoices();
      const zhVoice =
        voices.find((v) => v.lang.toLowerCase() === "zh-cn") ??
        voices.find((v) => v.lang.toLowerCase().startsWith("zh"));
      if (zhVoice) utter.voice = zhVoice;
      window.speechSynthesis.speak(utter);
    },
    [playSyllable, stopActive]
  );

  return { playSyllable, speakWord, stopActive };
}
