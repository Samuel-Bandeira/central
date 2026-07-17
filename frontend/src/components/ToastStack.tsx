export interface ToastItem {
  id: string;
  message: string;
}

interface Props {
  toasts: ToastItem[];
}

export function ToastStack({ toasts }: Props) {
  if (toasts.length === 0) return null;
  return (
    <div className="toast-stack">
      {toasts.map((toast) => (
        <div key={toast.id} className="toast">
          {toast.message}
        </div>
      ))}
    </div>
  );
}
