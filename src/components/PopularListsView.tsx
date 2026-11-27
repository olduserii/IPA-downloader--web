import {
  CheckCircle2,
  ChevronRight,
  Download,
  FileText,
  Globe,
  RefreshCw,
  Search,
  ShieldCheck,
  Upload,
  X,
  XCircle,
} from 'lucide-react';
import { type ChangeEvent, useDeferredValue, useMemo, useRef, useState } from 'react';
import { downloadTextFile } from '../lib/api.ts';
import { DEFAULT_CUSTOM_LIST_TEMPLATE } from '../shared/parsers.ts';
import type {
  AccountOwnershipStatus,
  AppAvailabilityStatus,
  CachedAppMetadata,
  CuratedAppEntry,
  CuratedListSource,
} from '../shared/types.ts';
import { AppIcon } from './AppIcon.tsx';

type AvailabilityFilter = 'all' | 'deleted' | 'us' | 'ru' | 'ios' | 'owned';

interface PopularListsViewProps {
  popularEntries: CuratedAppEntry[];
  customEntries: CuratedAppEntry[];
  customListText: string;
  onSaveCustomListText: (text: string) => void;
  metadataCache: Record<string, CachedAppMetadata>;
  ownershipCache: Record<string, AccountOwnershipStatus>;
  isAuthenticated: boolean;
  isSyncingGitHub: boolean;
  onSyncGitHub: () => void;
  availabilityProgress: { active: boolean; done: number; total: number };
  onCheckAvailability: (ids: string[]) => void;
  onCancelAvailability: () => void;
  ownershipProgress: { active: boolean; done: number; total: number };
  onCheckOwnership: (ids: string[]) => void;
  onCancelOwnership: () => void;
  onSelectApp: (entry: CuratedAppEntry, externalVersionID?: string) => void;
  onOpenAccount: () => void;
}

const PAGE_SIZE = 60;

function renderAvailabilityLabel(status: AppAvailabilityStatus | undefined) {
  switch (status) {
    case 'availableRU':
      return (
        <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
          <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
          <span>App Store (RU)</span>
        </span>
      );
    case 'deletedInRUAvailableUS':
      return (
        <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400">
          <Globe className="w-3.5 h-3.5 shrink-0" />
          <span>Удалено в RU · есть в US</span>
        </span>
      );
    case 'deletedGlobally':
      return (
        <span className="inline-flex items-center gap-1 text-rose-700 dark:text-rose-400">
          <XCircle className="w-3.5 h-3.5 shrink-0" />
          <span>Удалено из App Store</span>
        </span>
      );
    default:
      return <span className="text-slate-400 dark:text-slate-500">Не проверено</span>;
  }
}

export function PopularListsView({
  popularEntries,
  customEntries,
  customListText,
  onSaveCustomListText,
  metadataCache,
  ownershipCache,
  isAuthenticated,
  isSyncingGitHub,
  onSyncGitHub,
  availabilityProgress,
  onCheckAvailability,
  onCancelAvailability,
  ownershipProgress,
  onCheckOwnership,
  onCancelOwnership,
  onSelectApp,
  onOpenAccount,
}: PopularListsViewProps) {
  const [source, setSource] = useState<CuratedListSource>('popular');
  const [filter, setFilter] = useState<AvailabilityFilter>('all');
  const [iosFilter, setIosFilter] = useState<number>(17);
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [showCustomEditor, setShowCustomEditor] = useState(false);
  const [draftCustomText, setDraftCustomText] = useState(customListText);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const activeEntries = source === 'popular' ? popularEntries : customEntries;

  const availableIosVersions = useMemo(() => {
    const set = new Set<number>();
    for (const entry of activeEntries) {
      for (const iosKey of Object.keys(entry.iosVersionMap)) {
        set.add(Number(iosKey));
      }
    }
    return [...set].sort((a, b) => b - a);
  }, [activeEntries]);

  const filteredEntries = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    return activeEntries.filter((entry) => {
      const meta = metadataCache[entry.id];
      const own = ownershipCache[entry.id];

      if (filter === 'deleted' && meta?.status !== 'deletedGlobally') return false;
      if (filter === 'us' && meta?.status !== 'deletedInRUAvailableUS') return false;
      if (filter === 'ru' && meta?.status !== 'availableRU') return false;
      if (filter === 'ios' && !entry.iosVersionMap[iosFilter]) return false;
      if (filter === 'owned' && own !== 'owned') return false;

      if (!q) return true;
      return (
        entry.name.toLowerCase().includes(q) ||
        entry.id.includes(q) ||
        (meta?.bundleID?.toLowerCase().includes(q) ?? false) ||
        (meta?.artistName?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [activeEntries, deferredQuery, filter, iosFilter, metadataCache, ownershipCache]);

  const stats = useMemo(() => {
    let ru = 0;
    let us = 0;
    let deleted = 0;
    let owned = 0;
    for (const entry of activeEntries) {
      const status = metadataCache[entry.id]?.status;
      if (status === 'availableRU') ru += 1;
      else if (status === 'deletedInRUAvailableUS') us += 1;
      else if (status === 'deletedGlobally') deleted += 1;
      if (ownershipCache[entry.id] === 'owned') owned += 1;
    }
    return { total: activeEntries.length, ru, us, deleted, owned };
  }, [activeEntries, metadataCache, ownershipCache]);

  const displayedEntries = filteredEntries.slice(0, visibleCount);

  const handleImportFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const content = typeof reader.result === 'string' ? reader.result : '';
      if (content.trim()) {
        setDraftCustomText(content);
        onSaveCustomListText(content);
        setSource('custom');
        setShowCustomEditor(false);
      }
    };
    reader.readAsText(file, 'utf-8');
    e.target.value = '';
  };

  return (
    <div className="space-y-6">
      {/* Section Heading & Controls */}
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
        <div className="space-y-1.5">
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-50 text-balance">
            Каталог приложений и списки .txt
          </h1>
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs sm:text-sm text-slate-500 dark:text-slate-400 tabular-nums">
            <span>Всего: {stats.total}</span>
            <span aria-hidden="true">·</span>
            <span>RU: {stats.ru}</span>
            <span aria-hidden="true">·</span>
            <span>US: {stats.us}</span>
            <span aria-hidden="true">·</span>
            <span>Удалены: {stats.deleted}</span>
            {isAuthenticated && (
              <>
                <span aria-hidden="true">·</span>
                <span>На аккаунте: {stats.owned}</span>
              </>
            )}
          </div>
        </div>

        {/* Source Segmented Control */}
        <div className="inline-flex items-center p-1 bg-slate-200/70 dark:bg-slate-800/80 rounded-xl self-start lg:self-auto">
          <button
            type="button"
            onClick={() => {
              setSource('popular');
              setVisibleCount(PAGE_SIZE);
              setShowCustomEditor(false);
            }}
            className={`min-h-[40px] px-4 py-2 text-sm font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              source === 'popular'
                ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
            }`}
          >
            Популярные ({popularEntries.length})
          </button>
          <button
            type="button"
            onClick={() => {
              setSource('custom');
              setVisibleCount(PAGE_SIZE);
            }}
            className={`min-h-[40px] px-4 py-2 text-sm font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              source === 'custom'
                ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
            }`}
          >
            Свой .txt ({customEntries.length})
          </button>
        </div>
      </div>

      {/* Main Toolbar Container */}
      <div className="bg-white dark:bg-[#131822] border border-slate-200 dark:border-slate-800 rounded-2xl p-4 sm:p-5 space-y-4">
        <div className="flex flex-col md:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setVisibleCount(PAGE_SIZE);
              }}
              placeholder="Поиск по названию, App ID или Bundle ID…"
              className="w-full min-h-[44px] pl-10 pr-10 py-2.5 text-sm bg-slate-50 dark:bg-slate-900/70 border border-slate-200 dark:border-slate-700/80 rounded-xl text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#0066FF]/30 focus:border-[#0066FF]"
            />
            {query && (
              <button
                type="button"
                aria-label="Очистить поиск"
                onClick={() => setQuery('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 flex items-center justify-center text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {availabilityProgress.active ? (
              <button
                type="button"
                onClick={onCancelAvailability}
                className="min-h-[44px] px-4 py-2 text-sm font-medium rounded-xl border border-rose-200 dark:border-rose-900/60 bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 hover:bg-rose-100 dark:hover:bg-rose-900/50 transition-colors whitespace-nowrap shrink-0 cursor-pointer tabular-nums"
              >
                Остановить ({availabilityProgress.done}/{availabilityProgress.total})
              </button>
            ) : (
              <button
                type="button"
                onClick={() =>
                  onCheckAvailability(filteredEntries.slice(0, 240).map((e) => e.id))
                }
                className="min-h-[44px] px-4 py-2 text-sm font-medium rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors inline-flex items-center gap-2 whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Globe className="w-4 h-4 text-[#0066FF]" />
                <span>Проверить App Store</span>
              </button>
            )}

            {source === 'popular' ? (
              <button
                type="button"
                disabled={isSyncingGitHub}
                onClick={onSyncGitHub}
                className="min-h-[44px] px-4 py-2 text-sm font-medium rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50 transition-colors inline-flex items-center gap-2 whitespace-nowrap shrink-0 cursor-pointer"
              >
                <RefreshCw className={`w-4 h-4 ${isSyncingGitHub ? 'animate-spin' : ''}`} />
                <span>Обновить с GitHub</span>
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => {
                    setDraftCustomText(customListText);
                    setShowCustomEditor((v) => !v);
                  }}
                  className="min-h-[44px] px-4 py-2 text-sm font-medium rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors inline-flex items-center gap-2 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <FileText className="w-4 h-4" />
                  <span>{showCustomEditor ? 'Скрыть редактор' : 'Редактировать .txt'}</span>
                </button>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="min-h-[44px] px-4 py-2 text-sm font-medium rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors inline-flex items-center gap-2 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Upload className="w-4 h-4" />
                  <span>Импорт .txt</span>
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".txt,text/plain"
                  onChange={handleImportFile}
                  className="hidden"
                />
              </>
            )}

            {isAuthenticated ? (
              ownershipProgress.active ? (
                <button
                  type="button"
                  onClick={onCancelOwnership}
                  className="min-h-[44px] px-4 py-2 text-sm font-medium rounded-xl border border-amber-200 dark:border-amber-900/60 bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300 whitespace-nowrap shrink-0 cursor-pointer tabular-nums"
                >
                  Стоп ({ownershipProgress.done}/{ownershipProgress.total})
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() =>
                    onCheckOwnership(filteredEntries.slice(0, 36).map((e) => e.id))
                  }
                  className="min-h-[44px] px-4 py-2 text-sm font-medium rounded-xl bg-[#0066FF] hover:bg-[#0052CC] text-white transition-colors inline-flex items-center gap-2 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <ShieldCheck className="w-4 h-4" />
                  <span>Проверить на аккаунте</span>
                </button>
              )
            ) : (
              <button
                type="button"
                onClick={onOpenAccount}
                className="min-h-[44px] px-4 py-2 text-sm font-medium rounded-xl bg-slate-900 dark:bg-white text-white dark:text-slate-900 hover:bg-slate-800 dark:hover:bg-slate-200 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                Войти в Apple ID
              </button>
            )}
          </div>
        </div>

        {/* Filter Bar */}
        <div className="flex flex-wrap items-center justify-between gap-3 pt-1 border-t border-slate-100 dark:border-slate-800/80">
          <div className="flex flex-wrap items-center gap-1.5">
            {(
              [
                ['all', 'Все'],
                ['deleted', 'Удалённые'],
                ['us', 'Только US'],
                ['ru', 'В RU'],
                ['owned', 'На аккаунте'],
                ...(availableIosVersions.length > 0 ? [['ios', 'По iOS']] : []),
              ] as [AvailabilityFilter, string][]
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => {
                  setFilter(key);
                  setVisibleCount(PAGE_SIZE);
                }}
                className={`min-h-[36px] px-3 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  filter === key
                    ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900'
                    : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {filter === 'ios' && availableIosVersions.length > 0 && (
            <div className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-400">
              <span>Версия iOS:</span>
              <select
                value={iosFilter}
                onChange={(e) => setIosFilter(Number(e.target.value))}
                className="min-h-[36px] px-2.5 py-1 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 font-mono"
              >
                {availableIosVersions.map((v) => (
                  <option key={v} value={v}>
                    iOS {v}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        {/* Custom .txt Inline Editor */}
        {source === 'custom' && showCustomEditor && (
          <div className="pt-3 border-t border-slate-100 dark:border-slate-800 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Формат: <span className="font-mono">Название: AppID</span> или{' '}
                <span className="font-mono">Название: AppID | 15-16=ExtVerID | 17=ExtVerID</span>
              </p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setDraftCustomText(DEFAULT_CUSTOM_LIST_TEMPLATE)}
                  className="text-xs font-medium text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white underline cursor-pointer"
                >
                  Сбросить шаблон
                </button>
                <button
                  type="button"
                  onClick={() => downloadTextFile('AppsListCustom.txt', draftCustomText, 'text/plain')}
                  className="inline-flex items-center gap-1 text-xs font-medium text-[#0066FF] hover:underline cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5" />
                  Экспорт .txt
                </button>
              </div>
            </div>
            <textarea
              value={draftCustomText}
              onChange={(e) => setDraftCustomText(e.target.value)}
              rows={8}
              spellCheck={false}
              className="w-full p-3.5 text-xs font-mono leading-relaxed rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-[#0066FF]/30"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowCustomEditor(false)}
                className="min-h-[40px] px-4 py-2 text-sm font-medium rounded-xl border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 cursor-pointer"
              >
                Отмена
              </button>
              <button
                type="button"
                onClick={() => {
                  onSaveCustomListText(draftCustomText);
                  setShowCustomEditor(false);
                }}
                className="min-h-[40px] px-4 py-2 text-sm font-medium rounded-xl bg-[#0066FF] hover:bg-[#0052CC] text-white cursor-pointer"
              >
                Сохранить список
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Results List */}
      <div className="bg-white dark:bg-[#131822] border border-slate-200 dark:border-slate-800 rounded-2xl overflow-hidden">
        {displayedEntries.length === 0 ? (
          <div className="px-6 py-14 text-center space-y-3">
            <p className="text-base font-semibold text-slate-900 dark:text-slate-100">
              Приложения по заданному фильтру не найдены
            </p>
            <p className="text-sm text-slate-500 dark:text-slate-400 max-w-md mx-auto">
              Попробуйте изменить поисковый запрос, сбросить фильтр или запустить пакетную проверку App Store.
            </p>
            {filter !== 'all' && (
              <button
                type="button"
                onClick={() => {
                  setFilter('all');
                  setQuery('');
                }}
                className="min-h-[44px] px-4 py-2 text-sm font-medium rounded-xl bg-slate-900 dark:bg-white text-white dark:text-slate-900 cursor-pointer"
              >
                Показать все приложения
              </button>
            )}
          </div>
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800/80">
            {displayedEntries.map((entry) => {
              const meta = metadataCache[entry.id];
              const own = ownershipCache[entry.id];
              const mappedExtVer = filter === 'ios' ? entry.iosVersionMap[iosFilter] : undefined;

              return (
                <li key={entry.id}>
                  <button
                    type="button"
                    onClick={() => onSelectApp(entry, mappedExtVer)}
                    className="w-full min-h-[68px] px-4 sm:px-5 py-3.5 flex items-center gap-3.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors cursor-pointer group"
                  >
                    <AppIcon
                      src={meta?.iconURL}
                      name={entry.name}
                      seed={entry.id}
                      size="md"
                    />
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="font-semibold text-sm sm:text-[15px] text-slate-900 dark:text-slate-100 truncate">
                          {entry.name}
                        </span>
                        <span className="font-mono text-xs text-slate-400 dark:text-slate-500 tabular-nums shrink-0">
                          ID {entry.id}
                        </span>
                      </div>
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-500 dark:text-slate-400">
                        {renderAvailabilityLabel(meta?.status)}
                        {meta?.storeVersion && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="font-mono">v{meta.storeVersion}</span>
                          </>
                        )}
                        {mappedExtVer && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="font-mono text-[#0066FF] dark:text-blue-400">
                              iOS {iosFilter} → {mappedExtVer}
                            </span>
                          </>
                        )}
                        {own === 'owned' && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="text-emerald-700 dark:text-emerald-400 font-medium">
                              Куплено на аккаунте
                            </span>
                          </>
                        )}
                        {own === 'notOwned' && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="text-slate-500 dark:text-slate-400">
                              Нет на аккаунте
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                    <ChevronRight className="w-4 h-4 text-slate-400 group-hover:text-slate-700 dark:group-hover:text-slate-200 transition-colors shrink-0" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {filteredEntries.length > visibleCount && (
          <div className="p-4 border-t border-slate-100 dark:border-slate-800 text-center">
            <button
              type="button"
              onClick={() => setVisibleCount((prev) => prev + PAGE_SIZE)}
              className="min-h-[44px] px-5 py-2.5 text-sm font-medium rounded-xl border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors cursor-pointer tabular-nums"
            >
              Показать ещё ({filteredEntries.length - visibleCount} осталось)
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
