import {
  Archive,
  Clock,
  Layers,
  Search,
  User,
  UserCheck,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AccountView } from './components/AccountView.tsx';
import { CatalogSearchView } from './components/CatalogSearchView.tsx';
import { ExtractorView } from './components/ExtractorView.tsx';
import { HistoryView } from './components/HistoryView.tsx';
import { OtaHandoffBanner } from './components/OtaHandoffBanner.tsx';
import { PopularListsView } from './components/PopularListsView.tsx';
import { BUILT_IN_APPS_LIST } from './data/builtInAppsList.ts';
import {
  apiCheckOwnershipBatch,
  apiLogout,
  apiLookupBatch,
  apiRestoreBrowserSession,
  apiSyncPopularList,
} from './lib/api.ts';
import { DEFAULT_CUSTOM_LIST_TEMPLATE, parseAppsList } from './shared/parsers.ts';
import type {
  AccountOwnershipStatus,
  AppleSessionSummary,
  CachedAppMetadata,
  CuratedAppEntry,
  ITunesSearchItem,
  SavedIpaRecord,
} from './shared/types.ts';

type ActiveTab = 'lists' | 'extractor' | 'search' | 'history' | 'account';

const LS_POPULAR_RAW = 'ipavault.popular.raw.v1';
const LS_CUSTOM_RAW = 'ipavault.custom.raw.v1';
const LS_META_CACHE = 'ipavault.metadata.cache.v1';
const LS_THEME = 'ipavault.theme.v1';

function readStorageString(key: string, fallback: string): string {
  try {
    return window.localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function readStorageJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('extractor');
  const [darkMode, setDarkMode] = useState<boolean>(() => {
    const saved = readStorageString(LS_THEME, '');
    if (saved === 'dark') return true;
    if (saved === 'light') return false;
    return typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  });

  // Stateless encrypted Bearer token kept strictly in React memory (never persisted to localStorage)
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [session, setSession] = useState<AppleSessionSummary | null>(null);

  // Curated Lists (714 built-in + custom .txt)
  const [popularRaw, setPopularRaw] = useState<string>(() =>
    readStorageString(LS_POPULAR_RAW, BUILT_IN_APPS_LIST)
  );
  const [customRaw, setCustomRaw] = useState<string>(() =>
    readStorageString(LS_CUSTOM_RAW, DEFAULT_CUSTOM_LIST_TEMPLATE)
  );
  const [metadataCache, setMetadataCache] = useState<Record<string, CachedAppMetadata>>(() =>
    readStorageJson(LS_META_CACHE, {})
  );
  const [ownershipCache, setOwnershipCache] = useState<Record<string, AccountOwnershipStatus>>({});

  // Sync & Batch Progress
  const [isSyncingGitHub, setIsSyncingGitHub] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [availabilityProgress, setAvailabilityProgress] = useState({
    active: false,
    done: 0,
    total: 0,
  });
  const [ownershipProgress, setOwnershipProgress] = useState({
    active: false,
    done: 0,
    total: 0,
  });
  const availCancelRef = useRef(false);
  const ownCancelRef = useRef(false);

  // Selected app for Extractor
  const [selectedAppId, setSelectedAppId] = useState('');
  const [selectedVersionId, setSelectedVersionId] = useState('');
  const [selectedTitleHint, setSelectedTitleHint] = useState<string | undefined>(undefined);

  // Fetched IPA session history (in memory because Apple CDN URLs & signed tokens are time-limited)
  const [savedRecords, setSavedRecords] = useState<SavedIpaRecord[]>([]);

  // QR OTA Handoff from URL query params (?ota=<token>&title=<name>)
  const [otaHandoff, setOtaHandoff] = useState<{ token: string; title: string } | null>(() => {
    if (typeof window === 'undefined') return null;
    const params = new URLSearchParams(window.location.search);
    const token = params.get('ota') ?? '';
    const title = (params.get('title') || 'Приложение').slice(0, 80);
    return /^[A-Za-z0-9_-]{16,4096}\.[A-Za-z0-9_-]{32,128}$/.test(token)
      ? { token, title }
      : null;
  });

  // Automatically restore cached 24h / pinned HttpOnly browser session on page load
  useEffect(() => {
    let active = true;
    apiRestoreBrowserSession()
      .then((res) => {
        if (active && res.authenticated && res.session) {
          setAuthToken(res.token ?? null);
          setSession(res.session);
        }
      })
      .catch(() => {
        // Not signed in or offline
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (darkMode) {
      root.classList.add('dark');
      try {
        window.localStorage.setItem(LS_THEME, 'dark');
      } catch {
        // ignore storage quota errors
      }
    } else {
      root.classList.remove('dark');
      try {
        window.localStorage.setItem(LS_THEME, 'light');
      } catch {
        // ignore
      }
    }
  }, [darkMode]);

  const popularEntries = useMemo(() => parseAppsList(popularRaw), [popularRaw]);
  const customEntries = useMemo(() => parseAppsList(customRaw), [customRaw]);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    window.setTimeout(() => {
      setToastMessage((curr) => (curr === msg ? null : curr));
    }, 3500);
  };

  const handleSaveCustomListText = (text: string) => {
    setCustomRaw(text);
    try {
      window.localStorage.setItem(LS_CUSTOM_RAW, text);
    } catch {
      // ignore
    }
    showToast('Пользовательский список .txt сохранён');
  };

  const handleSyncGitHub = async () => {
    setIsSyncingGitHub(true);
    try {
      const content = await apiSyncPopularList();
      setPopularRaw(content);
      try {
        window.localStorage.setItem(LS_POPULAR_RAW, content);
      } catch {
        // ignore
      }
      const count = parseAppsList(content).length;
      showToast(`Список обновлён с GitHub: ${count} приложений`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Не удалось обновить список');
    } finally {
      setIsSyncingGitHub(false);
    }
  };

  const handleCheckAvailability = async (ids: string[]) => {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return;
    availCancelRef.current = false;
    setAvailabilityProgress({ active: true, done: 0, total: unique.length });

    const chunkSize = 60;
    let nextCache = { ...metadataCache };

    try {
      for (let i = 0; i < unique.length; i += chunkSize) {
        if (availCancelRef.current) break;
        const batch = unique.slice(i, i + chunkSize);
        const { metadata } = await apiLookupBatch(batch);
        nextCache = { ...nextCache, ...metadata };
        setMetadataCache(nextCache);
        setAvailabilityProgress({
          active: true,
          done: Math.min(unique.length, i + batch.length),
          total: unique.length,
        });
      }
      try {
        window.localStorage.setItem(LS_META_CACHE, JSON.stringify(nextCache));
      } catch {
        // ignore storage quota limits
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Ошибка проверки доступности');
    } finally {
      setAvailabilityProgress((p) => ({ ...p, active: false }));
    }
  };

  const handleCheckOwnership = async (ids: string[]) => {
    if (!session) {
      setActiveTab('account');
      return;
    }
    const unique = [...new Set(ids)];
    if (unique.length === 0) return;

    ownCancelRef.current = false;
    setOwnershipProgress({ active: true, done: 0, total: unique.length });

    const chunkSize = 8;
    try {
      for (let i = 0; i < unique.length; i += chunkSize) {
        if (ownCancelRef.current) break;
        const batch = unique.slice(i, i + chunkSize);
        const res = await apiCheckOwnershipBatch(batch, authToken);
        setOwnershipCache((prev) => ({ ...prev, ...res.statuses }));

        if (Object.keys(res.icons).length > 0) {
          setMetadataCache((prev) => {
            const updated = { ...prev };
            for (const [id, iconURL] of Object.entries(res.icons)) {
              updated[id] = {
                ...(updated[id] ?? { appID: id, status: 'unknown', updatedAt: Date.now() }),
                iconURL,
              };
            }
            return updated;
          });
        }

        if (res.sessionExpired) {
          handleSignOut();
          showToast('Сессия Apple ID истекла — выполните повторный вход');
          break;
        }

        setOwnershipProgress({
          active: true,
          done: Math.min(unique.length, i + batch.length),
          total: unique.length,
        });
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Ошибка проверки на аккаунте');
    } finally {
      setOwnershipProgress((p) => ({ ...p, active: false }));
    }
  };

  const handleAuthenticated = (token: string, nextSession: AppleSessionSummary) => {
    setAuthToken(token);
    setSession(nextSession);
    setOwnershipCache({});
    showToast(`Выполнен вход: ${nextSession.email}`);
  };

  const handleSignOut = () => {
    setAuthToken(null);
    setSession(null);
    setOwnershipCache({});
    void apiLogout().catch(() => {
      // ignore network error on logout
    });
  };

  const handleSelectCuratedApp = (entry: CuratedAppEntry, externalVersionID?: string) => {
    setSelectedAppId(entry.id);
    setSelectedVersionId(externalVersionID || '');
    setSelectedTitleHint(entry.name);
    setActiveTab('extractor');
  };

  const handleSelectSearchResult = (item: ITunesSearchItem) => {
    setSelectedAppId(String(item.trackId));
    setSelectedVersionId('');
    setSelectedTitleHint(item.trackName);
    setActiveTab('extractor');
  };

  const handleRecordSaved = (record: SavedIpaRecord) => {
    setSavedRecords((prev) => {
      const filtered = prev.filter(
        (r) => !(r.appID === record.appID && r.externalVersionID === record.externalVersionID)
      );
      return [record, ...filtered].slice(0, 30);
    });
  };

  const dismissOtaHandoff = () => {
    setOtaHandoff(null);
    const url = new URL(window.location.href);
    url.searchParams.delete('ota');
    url.searchParams.delete('title');
    window.history.replaceState({}, '', url.pathname + url.search);
  };

  const navItems: { id: ActiveTab; label: string }[] = [
    { id: 'extractor', label: 'По ID' },
    { id: 'lists', label: 'Списки' },
    { id: 'search', label: 'Поиск' },
    { id: 'history', label: `История${savedRecords.length ? ` (${savedRecords.length})` : ''}` },
  ];

  return (
    <div className="min-h-screen flex flex-col bg-[#F6F7F9] dark:bg-[#0B0E14] text-slate-900 dark:text-slate-100">
      {/* Strict 3-Zone Top Bar Contract (Desktop & Compact Mobile) */}
      <header className="sticky top-0 z-30 h-14 sm:h-16 bg-white/90 dark:bg-[#0B0E14]/90 backdrop-blur-md border-b border-slate-200/80 dark:border-slate-800/80">
        <div className="max-w-7xl mx-auto h-full px-4 sm:px-6 flex items-center justify-between gap-8">
          {/* Zone 1: Single-line Brand Wordmark */}
          <button
            type="button"
            onClick={() => setActiveTab('extractor')}
            className="font-display text-lg font-extrabold tracking-tight text-slate-900 dark:text-white whitespace-nowrap shrink-0 cursor-pointer"
          >
            IPA Vault
          </button>

          {/* Zone 2: 4 Single-line Navigation Links (Desktop) */}
          <nav
            aria-label="Основная навигация"
            className="hidden md:flex items-center gap-7 text-sm font-medium"
          >
            {navItems.map((item) => {
              const isActive = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActiveTab(item.id)}
                  className={`py-1 transition-colors whitespace-nowrap shrink-0 cursor-pointer border-b-2 ${
                    isActive
                      ? 'text-slate-900 dark:text-white border-[#0066FF]'
                      : 'text-slate-500 dark:text-slate-400 border-transparent hover:text-slate-900 dark:hover:text-slate-100'
                  }`}
                >
                  {item.label}
                </button>
              );
            })}
          </nav>

          {/* Zone 3: 1 Primary Action Button */}
          <div className="shrink-0">
            <button
              type="button"
              onClick={() => setActiveTab('account')}
              className={`min-h-[40px] px-4 py-2 text-xs sm:text-sm font-semibold rounded-xl transition-colors whitespace-nowrap shrink-0 cursor-pointer max-w-[200px] truncate ${
                session
                  ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 hover:bg-slate-800 dark:hover:bg-white'
                  : 'bg-[#0066FF] hover:bg-[#0052CC] text-white'
              }`}
            >
              {session ? session.email : 'Войти в Apple ID'}
            </button>
          </div>
        </div>
      </header>

      {/* Main Content Canvas */}
      <main className="flex-1 w-full max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-8 pb-24 md:pb-12 space-y-6">
        {otaHandoff && (
          <OtaHandoffBanner
            manifestToken={otaHandoff.token}
            title={otaHandoff.title}
            onDismiss={dismissOtaHandoff}
          />
        )}

        {toastMessage && (
          <div
            role="status"
            className="bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 text-sm font-medium px-4 py-3 rounded-xl flex items-center justify-between"
          >
            <span>{toastMessage}</span>
          </div>
        )}

        {activeTab === 'extractor' && (
          <ExtractorView
            initialAppInput={selectedAppId}
            initialVersionInput={selectedVersionId}
            initialTitleHint={selectedTitleHint}
            authToken={authToken}
            session={session}
            onSessionExpired={handleSignOut}
            onOpenAccount={() => setActiveTab('account')}
            onRecordSaved={handleRecordSaved}
          />
        )}

        {activeTab === 'lists' && (
          <PopularListsView
            popularEntries={popularEntries}
            customEntries={customEntries}
            customListText={customRaw}
            onSaveCustomListText={handleSaveCustomListText}
            metadataCache={metadataCache}
            ownershipCache={ownershipCache}
            isAuthenticated={Boolean(session)}
            isSyncingGitHub={isSyncingGitHub}
            onSyncGitHub={handleSyncGitHub}
            availabilityProgress={availabilityProgress}
            onCheckAvailability={handleCheckAvailability}
            onCancelAvailability={() => {
              availCancelRef.current = true;
            }}
            ownershipProgress={ownershipProgress}
            onCheckOwnership={handleCheckOwnership}
            onCancelOwnership={() => {
              ownCancelRef.current = true;
            }}
            onSelectApp={handleSelectCuratedApp}
            onOpenAccount={() => setActiveTab('account')}
          />
        )}

        {activeTab === 'search' && (
          <CatalogSearchView onSelectResult={handleSelectSearchResult} />
        )}

        {activeTab === 'history' && (
          <HistoryView
            records={savedRecords}
            onDelete={(id) => setSavedRecords((prev) => prev.filter((r) => r.id !== id))}
            onOpenExtractor={(appId, versionId) => {
              setSelectedAppId(appId);
              setSelectedVersionId(versionId);
              setActiveTab('extractor');
            }}
          />
        )}

        {activeTab === 'account' && (
          <AccountView
            authToken={authToken}
            session={session}
            onAuthenticated={handleAuthenticated}
            onSignOut={handleSignOut}
            darkMode={darkMode}
            onToggleDarkMode={() => setDarkMode((d) => !d)}
          />
        )}
      </main>

      {/* Quiet Desktop Footer */}
      <footer className="hidden md:block border-t border-slate-200/80 dark:border-slate-800/80 py-5">
        <div className="max-w-7xl mx-auto px-6 flex items-center justify-between text-xs text-slate-400 dark:text-slate-500">
          <span>IPA Vault Web · Прямая загрузка с серверов Apple и установка OTA</span>
          <span>Готово к деплою на Vercel</span>
        </div>
      </footer>

      {/* Mobile Fixed Thumb-Zone Bottom Navigation Bar (iPhone Safari) */}
      <nav
        aria-label="Мобильная навигация"
        className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-white/95 dark:bg-[#131822]/95 backdrop-blur-md border-t border-slate-200 dark:border-slate-800 pb-safe"
      >
        <div className="grid grid-cols-5 h-16 items-center">
          {(
            [
              { id: 'extractor', label: 'По ID', icon: Archive },
              { id: 'lists', label: 'Списки', icon: Layers },
              { id: 'search', label: 'Поиск', icon: Search },
              { id: 'history', label: 'IPA', icon: Clock },
              { id: 'account', label: 'Вход', icon: session ? UserCheck : User },
            ] as const
          ).map(({ id, label, icon: Icon }) => {
            const isActive = activeTab === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => setActiveTab(id)}
                className={`min-h-[48px] flex flex-col items-center justify-center gap-1 transition-colors cursor-pointer ${
                  isActive
                    ? 'text-[#0066FF] dark:text-blue-400'
                    : 'text-slate-500 dark:text-slate-400'
                }`}
              >
                <Icon className="w-5 h-5" />
                <span className="text-[10px] font-medium leading-none">{label}</span>
              </button>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
