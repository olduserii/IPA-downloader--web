import { ChevronRight, Loader2, Search, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { apiSearchCatalog } from '../lib/api.ts';
import { formatBytes } from '../shared/parsers.ts';
import { COUNTRY_STOREFRONTS, type ITunesSearchItem } from '../shared/types.ts';
import { AppIcon } from './AppIcon.tsx';

interface CatalogSearchViewProps {
  onSelectResult: (item: ITunesSearchItem) => void;
}

export function CatalogSearchView({ onSelectResult }: CatalogSearchViewProps) {
  const [term, setTerm] = useState('');
  const [country, setCountry] = useState('ru');
  const [results, setResults] = useState<ITunesSearchItem[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [errorText, setErrorText] = useState('');

  useEffect(() => {
    const clean = term.trim();
    if (!clean) {
      setResults([]);
      setErrorText('');
      return;
    }

    const timer = window.setTimeout(async () => {
      setIsSearching(true);
      setErrorText('');
      try {
        const items = await apiSearchCatalog(clean, country, 30);
        setResults(items);
      } catch (err) {
        setErrorText(err instanceof Error ? err.message : 'Ошибка поиска App Store');
      } finally {
        setIsSearching(false);
      }
    }, 280);

    return () => window.clearTimeout(timer);
  }, [term, country]);

  return (
    <div className="space-y-6">
      <div className="space-y-1.5">
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-50 text-balance">
          Поиск в App Store
        </h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Ищите приложения по любому региону App Store и сразу открывайте их в загрузчике IPA.
        </p>
      </div>

      <div className="bg-white dark:bg-[#131822] border border-slate-200 dark:border-slate-800 rounded-2xl p-4 sm:p-5 flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder="Например: Telegram, WhatsApp, ChatGPT, 2ГИС…"
            className="w-full min-h-[44px] pl-10 pr-10 py-2.5 text-sm bg-slate-50 dark:bg-slate-900/70 border border-slate-200 dark:border-slate-700/80 rounded-xl text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#0066FF]/30 focus:border-[#0066FF]"
          />
          {term && (
            <button
              type="button"
              aria-label="Очистить"
              onClick={() => setTerm('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 flex items-center justify-center text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        <select
          aria-label="Регион App Store"
          value={country}
          onChange={(e) => setCountry(e.target.value)}
          className="min-h-[44px] px-3.5 py-2 text-sm font-medium rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-[#0066FF]/30"
        >
          {COUNTRY_STOREFRONTS.map((sf) => (
            <option key={sf.code} value={sf.code}>
              {sf.label}
            </option>
          ))}
        </select>
      </div>

      {errorText && (
        <div className="bg-rose-50 dark:bg-rose-950/35 border border-rose-200 dark:border-rose-900/60 rounded-2xl p-4 text-sm text-rose-800 dark:text-rose-200">
          {errorText}
        </div>
      )}

      <div className="bg-white dark:bg-[#131822] border border-slate-200 dark:border-slate-800 rounded-2xl overflow-hidden">
        {isSearching ? (
          <div className="py-14 flex flex-col items-center justify-center gap-3 text-sm text-slate-500 dark:text-slate-400">
            <Loader2 className="w-5 h-5 animate-spin text-[#0066FF]" />
            <span>Поиск в App Store…</span>
          </div>
        ) : !term.trim() ? (
          <div className="px-6 py-14 text-center space-y-2">
            <p className="text-base font-semibold text-slate-900 dark:text-slate-100">
              Введите название приложения
            </p>
            <p className="text-sm text-slate-500 dark:text-slate-400 max-w-md mx-auto">
              Если приложение удалено из российского App Store, переключите регион на «США (US)» или введите его App ID напрямую на вкладке «По ID».
            </p>
          </div>
        ) : results.length === 0 ? (
          <div className="px-6 py-14 text-center text-sm text-slate-500 dark:text-slate-400">
            По запросу «{term}» в выбранном регионе ничего не найдено.
          </div>
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800/80">
            {results.map((item) => (
              <li key={item.trackId}>
                <button
                  type="button"
                  onClick={() => onSelectResult(item)}
                  className="w-full min-h-[72px] px-4 sm:px-5 py-3.5 flex items-center gap-3.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors cursor-pointer group"
                >
                  <AppIcon
                    src={item.artworkUrl512 || item.artworkUrl100}
                    name={item.trackName}
                    seed={String(item.trackId)}
                    size="md"
                  />
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="font-semibold text-sm sm:text-[15px] text-slate-900 dark:text-slate-100 truncate">
                        {item.trackName}
                      </span>
                      <span className="text-xs font-semibold text-slate-700 dark:text-slate-300 shrink-0 tabular-nums">
                        {item.formattedPrice || 'Бесплатно'}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-500 dark:text-slate-400">
                      <span className="truncate max-w-[180px]">{item.artistName}</span>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono">v{item.version}</span>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono tabular-nums">
                        {formatBytes(item.fileSizeBytes)}
                      </span>
                      {item.minimumOsVersion && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono">iOS {item.minimumOsVersion}+</span>
                        </>
                      )}
                    </div>
                  </div>
                  <ChevronRight className="w-4 h-4 text-slate-400 group-hover:text-slate-700 dark:group-hover:text-slate-200 transition-colors shrink-0" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
