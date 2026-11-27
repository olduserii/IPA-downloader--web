import { Smartphone, X } from 'lucide-react';
import { buildItmsServicesUrl } from '../lib/api.ts';

interface OtaHandoffBannerProps {
  manifestToken: string;
  title: string;
  onDismiss: () => void;
}

export function OtaHandoffBanner({
  manifestToken,
  title,
  onDismiss,
}: OtaHandoffBannerProps) {
  const manifestPath = `/api/manifest.plist?token=${encodeURIComponent(manifestToken)}`;
  const itmsUrl = buildItmsServicesUrl(manifestPath);

  return (
    <div className="bg-white dark:bg-[#131822] border border-[#0066FF]/40 rounded-2xl p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
      <div className="space-y-1">
        <div className="text-xs font-semibold text-[#0066FF] dark:text-blue-400">
          Прямая установка на iPhone (OTA)
        </div>
        <h2 className="text-base font-bold text-slate-900 dark:text-slate-50">
          Установить «{title || 'Приложение'}» с серверов Apple
        </h2>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Нажмите кнопку ниже в Safari на iPhone и подтвердите системный запрос iOS.
        </p>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        <a
          href={itmsUrl}
          className="min-h-[46px] px-5 py-2.5 text-sm font-semibold rounded-xl bg-[#0066FF] hover:bg-[#0052CC] text-white transition-colors inline-flex items-center gap-2 whitespace-nowrap"
        >
          <Smartphone className="w-4 h-4" />
          <span>Установить сейчас</span>
        </a>
        <button
          type="button"
          aria-label="Закрыть баннер установки"
          onClick={onDismiss}
          className="min-h-[46px] min-w-[46px] rounded-xl border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-slate-900 dark:hover:text-white flex items-center justify-center cursor-pointer"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
