import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

interface ToastValue {
  show: (message: string) => void;
}
const ToastContext = createContext<ToastValue>({ show: () => undefined });

/** One polite toast at a time, dismissed after 4 s (Design System "Toast"). */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState<{ text: string; id: number } | null>(null);
  const show = useCallback((text: string) => setMessage({ text, id: Date.now() }), []);
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => setMessage(null), 4000);
    return () => clearTimeout(t);
  }, [message]);
  return (
    <ToastContext.Provider value={{ show }}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-[88px] z-40 flex justify-center px-4 rail:bottom-6"
      >
        {message && (
          <div
            key={message.id}
            role="status"
            className="rounded-md bg-toast px-4 py-3 text-[14px] font-semibold text-toast-fg shadow-e2"
          >
            {message.text}
          </div>
        )}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastValue {
  return useContext(ToastContext);
}
